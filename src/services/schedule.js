// 賽前準備：背號、舞科、輪次、秩序表、分 heat、併場。
// Pre-competition setup: bibs, dances, rounds, running order, heat splitting, merging.

import { one, many, query, withTransaction } from '../db/index.js';
import { requireVoucher, entriesFor } from './voucher.js';

export class ScheduleError extends Error {
  constructor(key) {
    super(key);
    this.key = key;
    this.name = 'ScheduleError';
  }
}

// ---------------------------------------------------------------- 舞科 / dances

export function addDance({ competitionId, name, sortOrder = 0 }) {
  return one(
    `INSERT INTO dances (competition_id, name, sort_order) VALUES ($1, $2, $3)
     ON CONFLICT (competition_id, name) DO UPDATE SET sort_order = EXCLUDED.sort_order
     RETURNING *`,
    [competitionId, name, sortOrder],
  );
}

export function listDances(competitionId) {
  return many('SELECT * FROM dances WHERE competition_id = $1 ORDER BY sort_order, id', [competitionId]);
}

export async function setDivisionDances(divisionId, danceIds) {
  return withTransaction(async (client) => {
    await client.query('DELETE FROM division_dances WHERE division_id = $1', [divisionId]);
    for (const [index, danceId] of danceIds.entries()) {
      await client.query(
        'INSERT INTO division_dances (division_id, dance_id, sort_order) VALUES ($1, $2, $3)',
        [divisionId, danceId, index],
      );
    }
  });
}

export function dancesForDivision(divisionId) {
  return many(
    `SELECT d.* FROM division_dances dd JOIN dances d ON d.id = dd.dance_id
     WHERE dd.division_id = $1 ORDER BY dd.sort_order, d.id`,
    [divisionId],
  );
}

// ---------------------------------------------------------------- 輪次 / rounds

export function createRound({
  divisionId,
  name,
  sortOrder = 0,
  scoringMode = 'mark',
  advanceCount = null,
  markQuotaMode = 'per_dance',
  scoreMethod = 'average',
  rankMethod = 'sum',
  tiePolicy = 'advance_all',
  heatSize = 10,
  reshufflePerDance = false,
}) {
  return one(
    `INSERT INTO rounds
       (division_id, name, sort_order, scoring_mode, advance_count, mark_quota_mode,
        score_method, rank_method, tie_policy, heat_size, reshuffle_per_dance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [divisionId, name, sortOrder, scoringMode, advanceCount, markQuotaMode,
      scoreMethod, rankMethod, tiePolicy, heatSize, reshufflePerDance],
  );
}

export function listRounds(divisionId) {
  return many('SELECT * FROM rounds WHERE division_id = $1 ORDER BY sort_order, id', [divisionId]);
}

export function getRound(id) {
  return one('SELECT * FROM rounds WHERE id = $1', [id]);
}

export function roundEntries(roundId, { includeAbsent = true } = {}) {
  return many(
    `SELECT * FROM round_entries WHERE round_id = $1 ${includeAbsent ? '' : "AND status = 'active'"}
     ORDER BY bib_number NULLS LAST, id`,
    [roundId],
  );
}

// ---------------------------------------------------------------- 背號 / bibs

// 背號只給結算名單裡的人。
// 預設（sequential）：每個參賽單位整場一個號碼，從起始號碼連續往下編；
// 順序是組別順序、同組內照報名先後；同一組人報第二個組別，沿用原本的背號。
// 選 blocks 的話，每個組別各自一個號碼區段（101、102…；201、202…）。
// Bibs go only to the settled roster.
// Default (sequential): one number per entry unit for the whole competition, counting up from the
// start number, in division order and then registration order; the same people entered in a second
// division keep their bib. With blocks, each division gets its own number range instead.
export async function assignBibs(voucherCode, { start = 1, mode = 'sequential', perDivisionBlock = 100 } = {}) {
  const voucher = await requireVoucher(voucherCode);
  const entries = await entriesFor(voucher.id);

  // 「同一組人」用成員認：名冊編號優先，其次 email，最後才是姓名。
  // The same people are recognised by member: roster id first, then email, and name only as a last resort.
  const members = await many(
    `SELECT rm.registration_id, rm.athlete_id, rm.person_email, rm.athlete_name
     FROM registration_members rm
     JOIN voucher_entries ve ON ve.registration_id = rm.registration_id
     WHERE ve.voucher_id = $1`,
    [voucher.id],
  );
  const keysByRegistration = new Map();
  for (const m of members) {
    const key = m.athlete_id ? `a:${m.athlete_id}` : (m.person_email ? `e:${String(m.person_email).toLowerCase()}` : `n:${String(m.athlete_name).trim().toLowerCase()}`);
    const list = keysByRegistration.get(String(m.registration_id)) || [];
    list.push(key);
    keysByRegistration.set(String(m.registration_id), list);
  }
  const unitKey = (entry) => {
    const list = keysByRegistration.get(String(entry.registration_id));
    return list && list.length > 0 ? [...list].sort().join('|') : `r:${entry.registration_id}`;
  };

  // 同一組人在同一個組別報了兩次（重複付款），不能默默給兩個背號，要請主辦先處理。
  // The same people entered twice in one division (a double payment) must not quietly get two bibs.
  const seenInDivision = new Set();
  for (const entry of entries) {
    const marker = `${entry.division_id}:${unitKey(entry)}`;
    if (seenInDivision.has(marker)) throw new ScheduleError('schedule.errors.duplicateEntry');
    seenInDivision.add(marker);
  }

  return withTransaction(async (client) => {
    await client.query('UPDATE voucher_entries SET bib_number = NULL WHERE voucher_id = $1', [voucher.id]);

    if (mode === 'blocks') {
      let divisionIndex = -1;
      let lastDivision = null;
      let next = start;
      for (const entry of entries) {
        if (String(entry.division_id) !== String(lastDivision)) {
          divisionIndex += 1;
          lastDivision = entry.division_id;
          next = start + divisionIndex * perDivisionBlock;
        }
        await client.query('UPDATE voucher_entries SET bib_number = $2 WHERE id = $1', [entry.id, next]);
        next += 1;
      }
    } else {
      const bibByUnit = new Map();
      let next = start;
      for (const entry of entries) {
        const key = unitKey(entry);
        if (!bibByUnit.has(key)) {
          bibByUnit.set(key, next);
          next += 1;
        }
        await client.query('UPDATE voucher_entries SET bib_number = $2 WHERE id = $1', [entry.id, bibByUnit.get(key)]);
      }
    }

    const { rows } = await client.query(
      `SELECT ve.*, d.name AS division_name FROM voucher_entries ve
       JOIN divisions d ON d.id = ve.division_id
       WHERE ve.voucher_id = $1 ORDER BY ve.bib_number, d.sort_order, d.id`,
      [voucher.id],
    );
    return rows;
  });
}

export async function rosterWithBibs(voucherCode) {
  const voucher = await requireVoucher(voucherCode);
  return many(
    `SELECT ve.*, d.name AS division_name, r.reported_at
     FROM voucher_entries ve
     JOIN divisions d ON d.id = ve.division_id
     JOIN registrations r ON r.id = ve.registration_id
     WHERE ve.voucher_id = $1
     ORDER BY d.sort_order, d.id, ve.bib_number NULLS LAST, ve.id`,
    [voucher.id],
  );
}

// 第一輪的名單直接從憑證碼綁的那份名單來。沒有憑證碼就不能開始。
// The first round is seeded from the roster the voucher is bound to. No voucher, no start.
export async function seedFirstRound(voucherCode, roundId) {
  const voucher = await requireVoucher(voucherCode);
  const round = await getRound(roundId);
  if (!round) throw new ScheduleError('errors.notFound');

  const entries = await many(
    'SELECT * FROM voucher_entries WHERE voucher_id = $1 AND division_id = $2 ORDER BY bib_number NULLS LAST, id',
    [voucher.id, round.division_id],
  );

  return withTransaction(async (client) => {
    for (const entry of entries) {
      await client.query(
        `INSERT INTO round_entries (round_id, registration_id, division_id, bib_number, athlete_name, unit_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (round_id, registration_id) DO UPDATE SET bib_number = EXCLUDED.bib_number`,
        [roundId, entry.registration_id, entry.division_id, entry.bib_number, entry.athlete_name, entry.unit_name],
      );
    }
    const { rows } = await client.query('SELECT * FROM round_entries WHERE round_id = $1 ORDER BY bib_number', [roundId]);
    return rows;
  });
}

// ---------------------------------------------------------------- 分 heat / heat splitting

// 平均分配，不會出現一批只有一兩個人。
// 為了不多開一批，允許超出設定人數最多 1 人：30 人分 10/10/10，31 人分 11/10/10。
// Split evenly, never leaving a heat with one or two people in it.
// To avoid an extra heat, one person over the limit is allowed: 30 -> 10/10/10, 31 -> 11/10/10.
export function planHeatSizes(total, heatSize, { overfillTolerance = 1 } = {}) {
  if (total <= 0) return [];
  if (total <= heatSize + overfillTolerance) return [total];

  let heats = Math.ceil(total / heatSize);
  // 少開一批而每批只多 1 人的話，就少開一批。
  // If dropping one heat only costs one extra dancer per heat, drop it.
  if (heats > 1 && Math.ceil(total / (heats - 1)) <= heatSize + overfillTolerance) heats -= 1;

  const base = Math.floor(total / heats);
  const remainder = total % heats;
  return Array.from({ length: heats }, (_, i) => base + (i < remainder ? 1 : 0));
}

// 洗牌：固定種子，同一輪同一支舞重算會得到同一個結果，主辦不會覺得系統在亂跳。
// Deterministic shuffle: recomputing the same round and dance gives the same split.
function seededShuffle(items, seed) {
  const out = [...items];
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 產生某一輪、某一支舞的 heats。已經上場過的 heat 不動。
// Build the heats for one round and dance. Heats that already ran are left alone.
export async function buildHeats(roundId, danceId, { includeAbsent = false } = {}) {
  const round = await getRound(roundId);
  if (!round) throw new ScheduleError('errors.notFound');

  const dance = await one('SELECT * FROM dances WHERE id = $1', [danceId]);
  if (!dance) throw new ScheduleError('errors.notFound');

  const division = await one('SELECT * FROM divisions WHERE id = $1', [round.division_id]);
  const entries = await roundEntries(roundId, { includeAbsent });

  return withTransaction(async (client) => {
    // 已經開始或結束的 heat 不能重分，否則成績會亂。
    // Heats that started or finished must not be re-split or the scores would move.
    const { rows: existing } = await client.query(
      `SELECT h.* FROM heats h
       WHERE h.dance_id = $1 AND h.id IN (SELECT heat_id FROM heat_entries WHERE round_id = $2)`,
      [danceId, roundId],
    );
    const locked = existing.filter((h) => h.status !== 'pending');
    if (locked.length > 0) throw new ScheduleError('schedule.errors.heatLocked');

    for (const heat of existing) {
      await client.query('DELETE FROM heat_entries WHERE heat_id = $1 AND round_id = $2', [heat.id, roundId]);
      const { rows: left } = await client.query('SELECT 1 FROM heat_entries WHERE heat_id = $1 LIMIT 1', [heat.id]);
      if (left.length === 0) await client.query('DELETE FROM heats WHERE id = $1', [heat.id]);
    }

    const active = entries.filter((e) => e.status === 'active' || includeAbsent);
    const ordered = round.reshuffle_per_dance
      ? seededShuffle(active, Number(roundId) * 1000 + Number(danceId))
      : active;

    const sizes = planHeatSizes(ordered.length, round.heat_size);
    const created = [];
    let cursor = 0;

    for (const [index, size] of sizes.entries()) {
      const slice = ordered.slice(cursor, cursor + size);
      cursor += size;

      const label = sizes.length === 1
        ? `${division.name} · ${dance.name}`
        : `${division.name} · ${dance.name} · ${index + 1}/${sizes.length}`;

      const { rows: heatRows } = await client.query(
        `INSERT INTO heats (competition_id, dance_id, label, sort_key)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [division.competition_id, danceId, label, 0],
      );
      const heat = heatRows[0];

      for (const entry of slice) {
        await client.query(
          `INSERT INTO heat_entries (heat_id, round_entry_id, round_id, division_id)
           VALUES ($1, $2, $3, $4)`,
          [heat.id, entry.id, roundId, entry.division_id],
        );
      }
      created.push({ ...heat, size: slice.length });
    }

    return created;
  });
}

// 預設上場順序：同一個組別比完才換下一個組別；組別內一支舞一支舞來。
// Default running order: finish one division before the next; inside it, dance by dance.
export async function rebuildRunningOrder(competitionId) {
  const heats = await many(
    `SELECT h.id, h.dance_id,
            MIN(d.sort_order) AS division_sort, MIN(d.id) AS division_id,
            MIN(r.sort_order) AS round_sort,
            MIN(dd.sort_order) AS dance_sort,
            MIN(h.label) AS label
     FROM heats h
     JOIN heat_entries he ON he.heat_id = h.id
     JOIN divisions d ON d.id = he.division_id
     JOIN rounds r ON r.id = he.round_id
     LEFT JOIN division_dances dd ON dd.division_id = d.id AND dd.dance_id = h.dance_id
     WHERE h.competition_id = $1 AND h.status = 'pending'
     GROUP BY h.id
     ORDER BY division_sort, division_id, round_sort, dance_sort, h.id`,
    [competitionId],
  );

  // 已經跑過的 heat 保留原本的位置，新排的接在後面。
  // Heats that already ran keep their place; newly ordered ones follow them.
  const startRow = await one(
    `SELECT COALESCE(MAX(sort_key), 0) AS max_key FROM heats WHERE competition_id = $1 AND status <> 'pending'`,
    [competitionId],
  );
  let key = Number(startRow?.max_key || 0);

  for (const heat of heats) {
    key += 10;
    await query('UPDATE heats SET sort_key = $2 WHERE id = $1', [heat.id, key]);
  }
  return heats.length;
}

export function runningOrder(competitionId) {
  return many(
    `SELECT h.*, da.name AS dance_name,
            COUNT(he.id)::int AS entry_count,
            COUNT(he.checked_in_at)::int AS checked_in_count,
            ARRAY_AGG(DISTINCT d.name ORDER BY d.name) AS division_names,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT he.round_id), NULL) AS round_ids
     FROM heats h
     JOIN dances da ON da.id = h.dance_id
     LEFT JOIN heat_entries he ON he.heat_id = h.id
     LEFT JOIN divisions d ON d.id = he.division_id
     WHERE h.competition_id = $1
     GROUP BY h.id, da.name
     ORDER BY h.sort_key, h.id`,
    [competitionId],
  );
}

export function heatWithEntries(heatId) {
  return Promise.all([
    one(
      `SELECT h.*, da.name AS dance_name FROM heats h JOIN dances da ON da.id = h.dance_id WHERE h.id = $1`,
      [heatId],
    ),
    many(
      `SELECT he.*, re.athlete_name, re.unit_name, re.bib_number, re.status AS entry_status,
              d.name AS division_name, r.name AS round_name
       FROM heat_entries he
       JOIN round_entries re ON re.id = he.round_entry_id
       JOIN divisions d ON d.id = he.division_id
       JOIN rounds r ON r.id = he.round_id
       WHERE he.heat_id = $1
       ORDER BY d.sort_order, d.id, re.bib_number NULLS LAST, re.id`,
      [heatId],
    ),
  ]).then(([heat, entries]) => ({ heat, entries }));
}

// ---------------------------------------------------------------- 併場 / merging

// 人太少時把幾個組別併成同一場。條件是跳同一支舞，而且都還沒上場。
// Merge small divisions into one heat. They must share a dance and none may have run yet.
export async function mergeHeats(heatIds) {
  if (!Array.isArray(heatIds) || heatIds.length < 2) throw new ScheduleError('schedule.errors.mergeNeedsTwo');

  return withTransaction(async (client) => {
    const { rows: heats } = await client.query(
      'SELECT * FROM heats WHERE id = ANY($1::bigint[]) ORDER BY sort_key, id',
      [heatIds],
    );
    if (heats.length !== heatIds.length) throw new ScheduleError('errors.notFound');
    if (heats.some((h) => h.status !== 'pending')) throw new ScheduleError('schedule.errors.heatLocked');

    const danceIds = new Set(heats.map((h) => String(h.dance_id)));
    if (danceIds.size !== 1) throw new ScheduleError('schedule.errors.mergeSameDance');

    const [target, ...rest] = heats;
    const mergedFrom = [...(target.merged_from || [])];

    for (const source of rest) {
      const { rows: sourceEntries } = await client.query('SELECT * FROM heat_entries WHERE heat_id = $1', [source.id]);
      mergedFrom.push({
        label: source.label,
        entry_ids: sourceEntries.map((e) => Number(e.round_entry_id)),
      });
      await client.query('UPDATE heat_entries SET heat_id = $2 WHERE heat_id = $1', [source.id, target.id]);
      await client.query('DELETE FROM heats WHERE id = $1', [source.id]);
    }

    const { rows: divisionRows } = await client.query(
      `SELECT DISTINCT d.name FROM heat_entries he JOIN divisions d ON d.id = he.division_id
       WHERE he.heat_id = $1 ORDER BY d.name`,
      [target.id],
    );
    const danceRow = await client.query('SELECT name FROM dances WHERE id = $1', [target.dance_id]);
    const label = `${divisionRows.map((r) => r.name).join(' + ')} · ${danceRow.rows[0].name}`;

    const { rows } = await client.query(
      'UPDATE heats SET label = $2, merged_from = $3 WHERE id = $1 RETURNING *',
      [target.id, label, JSON.stringify(mergedFrom)],
    );
    return rows[0];
  });
}

// 併場後也可以再拆開。
// A merged heat can be split apart again.
export async function unmergeHeat(heatId) {
  return withTransaction(async (client) => {
    const { rows: heatRows } = await client.query('SELECT * FROM heats WHERE id = $1', [heatId]);
    const heat = heatRows[0];
    if (!heat) throw new ScheduleError('errors.notFound');
    if (heat.status !== 'pending') throw new ScheduleError('schedule.errors.heatLocked');
    const mergedFrom = heat.merged_from || [];
    if (mergedFrom.length === 0) throw new ScheduleError('schedule.errors.notMerged');

    let offset = 1;
    for (const source of mergedFrom) {
      const { rows: newHeat } = await client.query(
        `INSERT INTO heats (competition_id, dance_id, label, sort_key)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [heat.competition_id, heat.dance_id, source.label, heat.sort_key + offset],
      );
      await client.query(
        'UPDATE heat_entries SET heat_id = $2 WHERE heat_id = $1 AND round_entry_id = ANY($3::bigint[])',
        [heat.id, newHeat[0].id, source.entry_ids],
      );
      offset += 1;
    }

    const { rows: divisionRows } = await client.query(
      `SELECT DISTINCT d.name FROM heat_entries he JOIN divisions d ON d.id = he.division_id
       WHERE he.heat_id = $1 ORDER BY d.name`,
      [heat.id],
    );
    const danceRow = await client.query('SELECT name FROM dances WHERE id = $1', [heat.dance_id]);
    await client.query('UPDATE heats SET merged_from = $2, label = $3 WHERE id = $1', [
      heat.id,
      '[]',
      `${divisionRows.map((r) => r.name).join(' + ')} · ${danceRow.rows[0].name}`,
    ]);

    const { rows } = await client.query(
      'SELECT * FROM heats WHERE competition_id = $1 AND status = $2 ORDER BY sort_key',
      [heat.competition_id, 'pending'],
    );
    return rows;
  });
}

// 主持人臨時調整順序：把某一場移到另一場的前面或後面。只能動還沒上場的。
// The host re-orders on the day: move a pending heat before or after another one.
export async function moveHeat(heatId, { beforeHeatId = null, afterHeatId = null } = {}) {
  const heat = await one('SELECT * FROM heats WHERE id = $1', [heatId]);
  if (!heat) throw new ScheduleError('errors.notFound');
  if (heat.status !== 'pending') throw new ScheduleError('schedule.errors.heatLocked');

  const anchorId = beforeHeatId || afterHeatId;
  const anchor = anchorId ? await one('SELECT * FROM heats WHERE id = $1', [anchorId]) : null;
  if (anchorId && !anchor) throw new ScheduleError('errors.notFound');

  let newKey;
  if (!anchor) {
    const row = await one('SELECT COALESCE(MAX(sort_key), 0) + 10 AS k FROM heats WHERE competition_id = $1', [
      heat.competition_id,
    ]);
    newKey = Number(row.k);
  } else if (beforeHeatId) {
    const prev = await one(
      'SELECT COALESCE(MAX(sort_key), $2 - 20) AS k FROM heats WHERE competition_id = $1 AND sort_key < $2',
      [heat.competition_id, anchor.sort_key],
    );
    newKey = (Number(prev.k) + Number(anchor.sort_key)) / 2;
  } else {
    const nextRow = await one(
      'SELECT COALESCE(MIN(sort_key), $2 + 20) AS k FROM heats WHERE competition_id = $1 AND sort_key > $2',
      [heat.competition_id, anchor.sort_key],
    );
    newKey = (Number(anchor.sort_key) + Number(nextRow.k)) / 2;
  }

  return one('UPDATE heats SET sort_key = $2 WHERE id = $1 RETURNING *', [heatId, newKey]);
}

export default {
  ScheduleError,
  addDance,
  listDances,
  setDivisionDances,
  dancesForDivision,
  createRound,
  listRounds,
  getRound,
  roundEntries,
  assignBibs,
  rosterWithBibs,
  seedFirstRound,
  planHeatSizes,
  buildHeats,
  rebuildRunningOrder,
  runningOrder,
  heatWithEntries,
  mergeHeats,
  unmergeHeat,
  moveHeat,
};
