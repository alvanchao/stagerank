// 計價群組：基本盤含幾項，之後每項多少。
// Fee groups: a base fee covering N items, then a price per extra item.
import { one, many } from '../db/index.js';

export const DEFAULT_GROUP_NAME_KEY = 'fees.defaultGroup';

export function createGroup({
  competitionId, name, baseFeeCents = 0, baseIncludes = 1, extraItemFeeCents = 0, sortOrder = 0,
}) {
  const includes = Math.min(50, Math.max(1, Number.parseInt(baseIncludes, 10) || 1));
  return one(
    `INSERT INTO fee_groups (competition_id, name, base_fee_cents, base_includes, extra_item_fee_cents, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [competitionId, String(name || '').trim(), Number.parseInt(baseFeeCents, 10) || 0, includes,
     Number.parseInt(extraItemFeeCents, 10) || 0, sortOrder],
  );
}

export function updateGroup(id, { name, baseFeeCents, baseIncludes, extraItemFeeCents }) {
  const includes = Math.min(50, Math.max(1, Number.parseInt(baseIncludes, 10) || 1));
  return one(
    `UPDATE fee_groups SET name = COALESCE($2, name), base_fee_cents = $3, base_includes = $4,
            extra_item_fee_cents = $5, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, String(name || '').trim() || null, Number.parseInt(baseFeeCents, 10) || 0, includes,
     Number.parseInt(extraItemFeeCents, 10) || 0],
  );
}

// 已經有組別掛在上面的群組不刪，不然那些組別會突然沒有價格。
// A group with divisions on it is not deleted, or those divisions suddenly have no price.
export async function deleteGroup(id) {
  const used = await one('SELECT 1 FROM divisions WHERE fee_group_id = $1 LIMIT 1', [id]);
  if (used) return { deleted: false, reason: 'has_divisions' };
  await one('DELETE FROM fee_groups WHERE id = $1 RETURNING id', [id]);
  return { deleted: true };
}

export function listGroups(competitionId) {
  return many('SELECT * FROM fee_groups WHERE competition_id = $1 ORDER BY sort_order, id', [competitionId]);
}

export function getGroup(id) {
  if (!id) return Promise.resolve(null);
  return one('SELECT * FROM fee_groups WHERE id = $1', [id]);
}

// 這位選手在這一群裡已經報了幾項。一個組別算一項，主辦怎麼切組別就怎麼收錢。
// 取消掉的報名不算，不然退掉再報會變貴。
// How many items this competitor already has in this group. One division is one item, so the
// organiser's own division split is what the money follows. Cancelled entries do not count,
// or cancelling and re-entering would cost more.
export async function itemsAlreadyTaken({ competitionId, feeGroupId, athleteId, excludeDivisionId = null }) {
  if (!feeGroupId || !athleteId) return 0;
  const row = await one(
    `SELECT COUNT(DISTINCT r.division_id)::int AS taken
     FROM registration_members rm
     JOIN registrations r ON r.id = rm.registration_id
     JOIN divisions d ON d.id = r.division_id
     WHERE r.competition_id = $1
       AND d.fee_group_id = $2
       AND rm.athlete_id = $3
       AND r.status IN ('pending', 'paid')
       AND ($4::bigint IS NULL OR r.division_id <> $4)`,
    [competitionId, feeGroupId, athleteId, excludeDivisionId],
  );
  return row ? Number(row.taken) : 0;
}

// 報名畫面要在勾選的當下就說「這是第幾項、多少錢」，所以一次把整份名冊
// 在每一群已經報幾項撈出來，交給畫面自己算。
// The entry screen says "item number n, this much" the moment a name is ticked, so the whole
// roster's item counts in every group are fetched once and handed to the screen.
export async function takenCounts({ competitionId, athleteIds }) {
  const list = (athleteIds || []).map((id) => Number.parseInt(id, 10)).filter(Number.isFinite);
  if (list.length === 0) return {};
  const rows = await many(
    `SELECT d.fee_group_id, rm.athlete_id, COUNT(DISTINCT r.division_id)::int AS taken
     FROM registration_members rm
     JOIN registrations r ON r.id = rm.registration_id
     JOIN divisions d ON d.id = r.division_id
     WHERE r.competition_id = $1
       AND d.fee_group_id IS NOT NULL
       AND rm.athlete_id = ANY($2::bigint[])
       AND r.status IN ('pending', 'paid')
     GROUP BY d.fee_group_id, rm.athlete_id`,
    [competitionId, list],
  );
  const out = {};
  for (const row of rows) {
    const group = String(row.fee_group_id);
    out[group] = out[group] || {};
    out[group][String(row.athlete_id)] = Number(row.taken);
  }
  return out;
}

// 第 n 項要多少錢（n 從 1 起算）。
// 基本費含 2 項就是：第 1 項收基本費、第 2 項 0 元、第 3 項起收加項費。
// What the nth item costs, counting from 1. With a base covering two items, the first costs the
// base fee, the second is free, and the third onwards costs the extra-item fee.
export function priceOfItem(group, n) {
  if (!group) return 0;
  const includes = Math.max(1, Number(group.base_includes) || 1);
  if (n <= includes) return n === 1 ? Number(group.base_fee_cents) || 0 : 0;
  return Number(group.extra_item_fee_cents) || 0;
}

// 這一筆報名要收多少：每位成員各自看自己已經報到第幾項。
// 雙人組兩個人都是第一次報，就是兩份基本費；其中一位已經報過兩項，那一位就只收加項費。
// What this entry costs: every member is priced by how many items they personally already have.
// In a couple where both are entering for the first time that is two base fees; if one of them
// already has two items, that one pays the extra-item price instead.
export async function quoteTiered({ competition, division, group, members }) {
  const lines = [];
  let total = 0;
  for (const member of members) {
    const taken = await itemsAlreadyTaken({
      competitionId: competition.id,
      feeGroupId: group.id,
      athleteId: member.athleteId,
      excludeDivisionId: division.id,
    });
    const index = taken + 1;
    const cents = priceOfItem(group, index);
    total += cents;
    lines.push({
      athleteId: member.athleteId,
      athleteName: member.athleteName,
      itemIndex: index,
      itemFeeCents: cents,
    });
  }
  return { totalCents: Math.max(0, total), lines };
}

export default {
  createGroup,
  updateGroup,
  deleteGroup,
  listGroups,
  getGroup,
  itemsAlreadyTaken,
  takenCounts,
  priceOfItem,
  quoteTiered,
};
