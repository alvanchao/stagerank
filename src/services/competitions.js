import { one, many } from '../db/index.js';
import config from '../config.js';

export function slugify(name) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return base || `c-${Date.now().toString(36)}`;
}

export async function createCompetition({ name, slug, currency, feeCents, status = 'draft', closesAt = null }) {
  const wanted = slug || slugify(name);
  let candidate = wanted;
  // slug 撞名時自動加尾碼，主辦不用自己想。
  // If the slug is taken, add a suffix so the organiser does not have to think of one.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const clash = await one('SELECT 1 FROM competitions WHERE slug = $1', [candidate]);
    if (!clash) break;
    candidate = `${wanted}-${attempt + 2}`;
  }

  return one(
    `INSERT INTO competitions (slug, name, status, currency, fee_cents, closes_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [candidate, name, status, (currency || config.currency).toUpperCase(), feeCents ?? 0, closesAt],
  );
}

export function listCompetitions({ status } = {}) {
  if (status) {
    return many('SELECT * FROM competitions WHERE status = $1 ORDER BY created_at DESC', [status]);
  }
  return many('SELECT * FROM competitions ORDER BY created_at DESC');
}

export function getCompetition(id) {
  return one('SELECT * FROM competitions WHERE id = $1', [id]);
}

export function getCompetitionBySlug(slug) {
  return one('SELECT * FROM competitions WHERE slug = $1', [slug]);
}

// 年齡怎麼算由主辦決定；比賽日期是算年齡的基準日。
// The organiser decides how age is counted; the competition date is what it is counted against.
export function setAgeRule(id, { ageBasis, eventDate }) {
  return one(
    `UPDATE competitions SET age_basis = $2, event_date = $3, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, ageBasis === 'event_day' ? 'event_day' : 'year_end', String(eventDate || '').trim() || null],
  );
}

export function setStatus(id, status) {
  return one('UPDATE competitions SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, status]);
}

export function markScoringStarted(id) {
  return one(
    `UPDATE competitions SET scoring_started_at = COALESCE(scoring_started_at, now()), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id],
  );
}

// 年齡上下限留空就是不限，所以空字串要變成 null，不能變成 0。
// A blank age bound means no limit, so an empty string becomes null and never 0.
function ageBound(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// 沒填就是 null，不要變成 0：0 是一個有效的編號，null 才是「沒選」。
// Blank means null, never 0: zero is a valid id and null is what "not chosen" looks like.
function idOrNull(value) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const FEE_MODES = ['per_entry', 'per_person', 'tiered'];
function normaliseFeeMode(value) {
  return FEE_MODES.includes(value) ? value : 'per_entry';
}

// 組別：名稱、費用、人數上下限、收費方式、跨組別加收、年齡限制、計價群組。
// A division: its name, fee, member range, fee mode and cross-division surcharge.
export function addDivision({
  competitionId,
  name,
  feeCents = null,
  sortOrder = 0,
  memberMin = 1,
  memberMax = null,
  feeMode = 'per_entry',
  extraDivisionFeeCents = 0,
  ageMin = null,
  ageMax = null,
  feeGroupId = null,
}) {
  const min = Math.max(1, Number.parseInt(memberMin, 10) || 1);
  const max = Math.min(24, Math.max(min, Number.parseInt(memberMax ?? min, 10) || min));
  return one(
    `INSERT INTO divisions
       (competition_id, name, fee_cents, sort_order, member_min, member_max, fee_mode,
        extra_division_fee_cents, age_min, age_max, fee_group_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [competitionId, name, feeCents, sortOrder, min, max, normaliseFeeMode(feeMode),
     Number.parseInt(extraDivisionFeeCents, 10) || 0, ageBound(ageMin), ageBound(ageMax),
     idOrNull(feeGroupId)],
  );
}

export function updateDivision(id, {
  name, feeCents, memberMin, memberMax, feeMode, extraDivisionFeeCents, sortOrder,
  ageMin = null, ageMax = null, feeGroupId = null,
}) {
  const min = Math.max(1, Number.parseInt(memberMin, 10) || 1);
  const max = Math.min(24, Math.max(min, Number.parseInt(memberMax ?? min, 10) || min));
  return one(
    `UPDATE divisions SET
       name = COALESCE($2, name),
       fee_cents = $3,
       sort_order = COALESCE($4, sort_order),
       member_min = $5,
       member_max = $6,
       fee_mode = $7,
       extra_division_fee_cents = $8,
       age_min = $9,
       age_max = $10,
       fee_group_id = $11
     WHERE id = $1 RETURNING *`,
    [id, name || null, feeCents ?? null, sortOrder ?? null, min, max,
     normaliseFeeMode(feeMode), Number.parseInt(extraDivisionFeeCents, 10) || 0,
     ageBound(ageMin), ageBound(ageMax), idOrNull(feeGroupId)],
  );
}

// 已經有人報名的組別不可以刪，不然名單會對不上。
// A division somebody has entered cannot be deleted, or the roster stops adding up.
export async function deleteDivision(id) {
  const used = await one('SELECT 1 FROM registrations WHERE division_id = $1 LIMIT 1', [id]);
  if (used) return { deleted: false, reason: 'has_registrations' };
  await one('DELETE FROM divisions WHERE id = $1 RETURNING id', [id]);
  return { deleted: true };
}

export function listDivisions(competitionId) {
  return many('SELECT * FROM divisions WHERE competition_id = $1 ORDER BY sort_order, id', [competitionId]);
}

export function getDivision(id) {
  return one('SELECT * FROM divisions WHERE id = $1', [id]);
}

// 組別可以有自己的費用；沒有就沿用比賽的費用。
// A division may set its own fee; otherwise the competition fee applies.
export function feeForDivision(competition, division) {
  if (division && division.fee_cents !== null && division.fee_cents !== undefined) {
    return division.fee_cents;
  }
  return competition.fee_cents;
}

export async function countsFor(competitionId) {
  const row = await one(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
       COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid'), 0)::bigint AS paid_cents
     FROM registrations WHERE competition_id = $1`,
    [competitionId],
  );
  return row || { total: 0, paid: 0, paid_cents: 0 };
}

export default {
  slugify,
  createCompetition,
  listCompetitions,
  getCompetition,
  getCompetitionBySlug,
  setStatus,
  setAgeRule,
  markScoringStarted,
  addDivision,
  updateDivision,
  deleteDivision,
  listDivisions,
  getDivision,
  feeForDivision,
  countsFor,
};
