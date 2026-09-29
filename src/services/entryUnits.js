// 參賽單位與收費。
// Entry units and what they cost.
//
// 一筆報名 ＝ 一個參賽單位 ＝ 一個背號。單人底下 1 人，雙人 2 人，多人由主辦設上下限。
// 評分本來就是對「一個參賽單位」評，所以這裡完全不影響任何計算。
// One registration is one entry unit and one bib: one person for a solo, two for a couple, and
// whatever the organiser allows for a team. Scoring already works on the unit, so nothing here
// touches a single calculation.

import { many } from '../db/index.js';
import * as feeGroups from './feeGroups.js';

export const MAX_MEMBERS = 24;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class MemberError extends Error {
  constructor(key, params) {
    super(key);
    this.key = key;
    this.params = params;
    this.name = 'MemberError';
  }
}

export function memberRange(division) {
  const min = Math.max(1, division?.member_min ?? 1);
  const max = Math.min(MAX_MEMBERS, Math.max(min, division?.member_max ?? min));
  return { min, max };
}

// 組別的形狀：1 人是單人，剛好 2 人是雙人，其他是多人。
// The shape of a division: one is a solo, exactly two is a couple, anything else is a team.
export function entryKind(division) {
  const { min, max } = memberRange(division);
  if (min === 1 && max === 1) return 'solo';
  if (min === 2 && max === 2) return 'couple';
  return 'team';
}

// 認人一律用電子郵件，不用姓名：各國同名的機會太高。
// People are matched by email, never by name: the same name turns up far too often worldwide.
export function normaliseEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email || null;
}

export function parseMembers(input, division) {
  const { min, max } = memberRange(division);
  const rows = (Array.isArray(input) ? input : [input])
    .filter(Boolean)
    .map((member) => ({
      athleteId: member.athleteId ? Number.parseInt(member.athleteId, 10) : null,
      athleteName: String(member.athleteName || '').trim(),
      personEmail: normaliseEmail(member.personEmail),
    }))
    .filter((member) => member.athleteId || member.athleteName || member.personEmail);

  if (rows.length < min) throw new MemberError('register.errors.tooFewMembers', { min });
  if (rows.length > max) throw new MemberError('register.errors.tooManyMembers', { max });

  for (const member of rows) {
    if (!member.athleteName) throw new MemberError('register.errors.nameRequired');
    if (member.personEmail && !EMAIL_RE.test(member.personEmail)) {
      throw new MemberError('register.errors.emailInvalid');
    }
  }

  // 同一個參賽單位裡不能出現同一個人兩次。名冊來的看編號，其餘看 email。
  // The same person must not appear twice in one unit: by roster id where there is one,
  // by email otherwise.
  const seen = new Set();
  for (const member of rows) {
    const key = member.athleteId ? `a:${member.athleteId}` : (member.personEmail ? `e:${member.personEmail}` : null);
    if (!key) continue;
    if (seen.has(key)) throw new MemberError('register.errors.duplicateMember');
    seen.add(key);
  }

  return rows;
}

// 顯示名稱：雙人和多人在背號旁邊要看得到所有成員。
// The display label: a couple or team must show every member beside the bib.
export function displayName(members) {
  return members.map((m) => m.athleteName).join(' / ');
}

// 這些 email 之中，有誰已經在這場比賽報過別的組別？
// Which of these emails has already entered a different division of this competition?
export async function alreadyEnteredElsewhere({ competitionId, divisionId, emails }) {
  const list = emails.filter(Boolean);
  if (list.length === 0) return [];
  return many(
    `SELECT DISTINCT lower(rm.person_email) AS person_email
     FROM registration_members rm
     JOIN registrations r ON r.id = rm.registration_id
     WHERE r.competition_id = $1
       AND r.division_id <> $2
       AND r.status IN ('pending', 'paid')
       AND lower(rm.person_email) = ANY($3::text[])`,
    [competitionId, divisionId, list],
  ).then((rows) => rows.map((row) => row.person_email));
}

// 名冊上的選手有編號，用編號比對比用電子郵件準得多，選手也不必有信箱。
// 只在同一個帳號內比對：同一個人被兩間教室各自建過，系統看成兩個人，不去猜。
// Roster athletes have an id, which matches far better than an email and needs none. The match is
// within one account only: the same person entered by two studios is two people here, and the
// system does not guess otherwise.
export async function athletesEnteredElsewhere({ competitionId, divisionId, athleteIds }) {
  const list = (athleteIds || []).map((id) => Number.parseInt(id, 10)).filter(Number.isFinite);
  if (list.length === 0) return [];
  return many(
    `SELECT DISTINCT rm.athlete_id
     FROM registration_members rm
     JOIN registrations r ON r.id = rm.registration_id
     WHERE r.competition_id = $1
       AND r.division_id <> $2
       AND r.status IN ('pending', 'paid')
       AND rm.athlete_id = ANY($3::bigint[])`,
    [competitionId, divisionId, list],
  ).then((rows) => rows.map((row) => Number(row.athlete_id)));
}

// 算這一筆報名要收多少。
//   per_entry   整組收一次
//   per_person  每個成員都收
//   跨組別加收：這個單位裡只要有人已經報過別的組別，就加收一次（負數＝減免）
// What this entry costs.
//   per_entry   the unit pays once
//   per_person  every member pays
//   cross-division surcharge: charged once if anyone in this unit already entered another division
export async function quote({ competition, division, members }) {
  // 階梯：吃所屬群組的「基本盤含幾項、之後每項多少」，每位成員各自數自己的項數。
  // Tiered: it follows its group's base-plus-extras rule, each member counting their own items.
  if (division.fee_mode === 'tiered') {
    const group = await feeGroups.getGroup(division.fee_group_id);
    if (group) {
      const tiered = await feeGroups.quoteTiered({ competition, division, group, members });
      return {
        baseCents: Number(group.base_fee_cents) || 0,
        memberCount: members.length,
        feeMode: 'tiered',
        baseTotalCents: tiered.totalCents,
        extraCents: 0,
        totalCents: tiered.totalCents,
        crossDivisionEmails: [],
        crossDivisionAthleteIds: [],
        group,
        lines: tiered.lines,
      };
    }
    // 掛了階梯卻沒有群組，是主辦設定漏了。這裡不猜價格，往下走一般規則，
    // 後台會看到這個組別沒有群組。
    // Tiered with no group is a setup the organiser left half-done. Rather than invent a price
    // it falls through to the ordinary rules, and the admin screen flags the missing group.
  }

  const base = division.fee_cents !== null && division.fee_cents !== undefined
    ? Number(division.fee_cents)
    : Number(competition.fee_cents || 0);

  const count = members.length;
  const baseTotal = division.fee_mode === 'per_person' ? base * count : base;

  // 名冊來的成員有 athleteId，用它比對；沒有帳號的舊式報名才退回用電子郵件。
  // Roster members carry an athleteId and are matched by it; only account-less entries of the
  // older kind fall back to the email.
  const athleteIds = members.map((m) => m.athleteId).filter(Boolean);
  const returningAthletes = athleteIds.length > 0
    ? await athletesEnteredElsewhere({
      competitionId: competition.id,
      divisionId: division.id,
      athleteIds,
    })
    : [];

  const returning = athleteIds.length > 0
    ? []
    : await alreadyEnteredElsewhere({
      competitionId: competition.id,
      divisionId: division.id,
      emails: members.map((m) => m.personEmail),
    });

  const repeats = returningAthletes.length + returning.length;
  const extra = repeats > 0 ? Number(division.extra_division_fee_cents || 0) : 0;
  // 減免不可以把金額變成負數。
  // A discount can never take the total below zero.
  const total = Math.max(0, baseTotal + extra);

  return {
    baseCents: base,
    memberCount: count,
    feeMode: division.fee_mode,
    baseTotalCents: baseTotal,
    extraCents: extra,
    totalCents: total,
    crossDivisionEmails: returning,
    crossDivisionAthleteIds: returningAthletes,
  };
}

export default {
  MAX_MEMBERS,
  MemberError,
  memberRange,
  entryKind,
  normaliseEmail,
  parseMembers,
  displayName,
  alreadyEnteredElsewhere,
  athletesEnteredElsewhere,
  quote,
};
