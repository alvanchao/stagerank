// 評分與成績計算：mark 勾選、打分數、排名次（名次加總／過半數制）。
// Scoring and results: mark selection, points, and placings (rank sum or the skating system).

import { one, many, query, withTransaction } from '../db/index.js';
import { publish } from './realtime.js';

export class ScoringError extends Error {
  constructor(key, params) {
    super(key);
    this.key = key;
    this.params = params;
    this.name = 'ScoringError';
  }
}

// ---------------------------------------------------------------- 名額 / quotas

// mark 的勾選名額，預設「每支舞總名額」：30 人取 15，裁判在這支舞的 3 個 heat 裡總共勾 15 個。
// Mark quota. The default is one quota for the whole dance: 30 dancers, 15 places, 15 marks across all heats.
export async function markQuota({ round, danceId, judgeId, heatId }) {
  if (!round.advance_count) return { limit: null, used: 0, scope: round.mark_quota_mode };

  if (round.mark_quota_mode === 'per_heat') {
    const totals = await one(
      `SELECT
         (SELECT COUNT(*)::int FROM round_entries WHERE round_id = $1 AND status = 'active') AS total,
         (SELECT COUNT(*)::int FROM heat_entries he JOIN round_entries re ON re.id = he.round_entry_id
          WHERE he.heat_id = $2 AND re.status = 'active') AS in_heat`,
      [round.id, heatId],
    );
    const limit = totals.total > 0
      ? Math.max(1, Math.round((round.advance_count * totals.in_heat) / totals.total))
      : 0;
    const used = await one(
      `SELECT COUNT(*)::int AS n FROM scores
       WHERE heat_id = $1 AND judge_id = $2 AND dance_id = $3 AND marked = TRUE`,
      [heatId, judgeId, danceId],
    );
    return { limit, used: used.n, scope: 'per_heat' };
  }

  const used = await one(
    `SELECT COUNT(*)::int AS n FROM scores
     WHERE round_id = $1 AND dance_id = $2 AND judge_id = $3 AND marked = TRUE`,
    [round.id, danceId, judgeId],
  );
  return { limit: round.advance_count, used: used.n, scope: 'per_dance' };
}

// ---------------------------------------------------------------- 送出 / submitting

// 裁判送出。只有「已檢錄、未缺席、而且屬於這位裁判負責的組別」的選手才收得進來。
// A judge submits. Only checked-in, present competitors from divisions this judge covers are accepted.
export async function submitScores(heatId, judgeId, payload, { auto = false } = {}) {
  return withTransaction(async (client) => {
    const { rows: heatRows } = await client.query(
      'SELECT h.*, da.name AS dance_name FROM heats h JOIN dances da ON da.id = h.dance_id WHERE h.id = $1',
      [heatId],
    );
    const heat = heatRows[0];
    if (!heat) throw new ScoringError('errors.notFound');
    if (heat.status === 'closed' && !auto) throw new ScoringError('floor.errors.heatClosed');

    const { rows: voided } = await client.query(
      'SELECT * FROM heat_judges WHERE heat_id = $1 AND judge_id = $2 AND voided_at IS NOT NULL',
      [heatId, judgeId],
    );
    // 跳出作廢之後不能補評。
    // Once voided for walking away, this judge cannot score this heat.
    if (voided.length > 0) throw new ScoringError('scoring.errors.voided');

    const { rows: eligible } = await client.query(
      `SELECT he.round_entry_id, he.round_id, he.division_id, re.bib_number
       FROM heat_entries he
       JOIN round_entries re ON re.id = he.round_entry_id
       WHERE he.heat_id = $1
         AND he.checked_in_at IS NOT NULL
         AND re.status = 'active'
         AND EXISTS (SELECT 1 FROM judge_assignments ja WHERE ja.judge_id = $2 AND ja.division_id = he.division_id)`,
      [heatId, judgeId],
    );
    const byEntry = new Map(eligible.map((e) => [String(e.round_entry_id), e]));
    if (byEntry.size === 0) return { accepted: 0, skipped: 0 };

    const roundIds = [...new Set(eligible.map((e) => String(e.round_id)))];
    const { rows: roundRows } = await client.query('SELECT * FROM rounds WHERE id = ANY($1::bigint[])', [roundIds]);
    const rounds = new Map(roundRows.map((r) => [String(r.id), r]));

    let accepted = 0;
    let skipped = 0;

    const marks = new Set((payload.marks || []).map(String));
    const points = payload.points || {};
    const ranks = payload.ranks || {};

    // 排名次：同一位裁判在同一個組別裡不能給兩位選手相同名次。
    // Placings: within one division a judge cannot give two competitors the same place.
    const seenRanks = new Map();
    for (const [entryId, rank] of Object.entries(ranks)) {
      const entry = byEntry.get(String(entryId));
      if (!entry) continue;
      const key = `${entry.division_id}`;
      if (!seenRanks.has(key)) seenRanks.set(key, new Set());
      const set = seenRanks.get(key);
      if (set.has(Number(rank))) throw new ScoringError('scoring.errors.duplicateRank', { rank });
      set.add(Number(rank));
    }

    for (const [entryIdRaw, entry] of byEntry.entries()) {
      const round = rounds.get(String(entry.round_id));
      if (!round) continue;

      let marked = null;
      let pointValue = null;
      let rankValue = null;

      if (round.scoring_mode === 'mark') {
        marked = marks.has(entryIdRaw);
        if (!marked) {
          // 沒勾就是沒給，不必存一筆，但自動收件時要留紀錄以便對帳。
          // Not ticked means nothing given; only the auto-collect pass records it for the audit trail.
          if (!auto) {
            await client.query(
              'DELETE FROM scores WHERE round_id=$1 AND dance_id=$2 AND judge_id=$3 AND round_entry_id=$4',
              [round.id, heat.dance_id, judgeId, entry.round_entry_id],
            );
            skipped += 1;
            continue;
          }
        }
      } else if (round.scoring_mode === 'score') {
        const raw = points[entryIdRaw];
        if (raw === undefined || raw === null || raw === '') {
          skipped += 1;
          continue;
        }
        pointValue = Number(raw);
        if (!Number.isFinite(pointValue) || pointValue < 0) throw new ScoringError('scoring.errors.badPoints');
      } else {
        const raw = ranks[entryIdRaw];
        if (raw === undefined || raw === null || raw === '') {
          skipped += 1;
          continue;
        }
        rankValue = Number.parseInt(raw, 10);
        if (!Number.isFinite(rankValue) || rankValue < 1) throw new ScoringError('scoring.errors.badRank');
      }

      await client.query(
        `INSERT INTO scores (round_id, dance_id, heat_id, judge_id, round_entry_id, marked, points, rank_position, auto_collected)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (round_id, dance_id, judge_id, round_entry_id) DO UPDATE
           SET marked = EXCLUDED.marked, points = EXCLUDED.points, rank_position = EXCLUDED.rank_position,
               heat_id = EXCLUDED.heat_id, auto_collected = EXCLUDED.auto_collected, submitted_at = now()`,
        [round.id, heat.dance_id, heatId, judgeId, entry.round_entry_id, marked, pointValue, rankValue, auto],
      );
      accepted += 1;
    }

    // 名額檢查放在最後，因為要看這一次送出後的總數。
    // The quota check runs last because it counts the totals after this submission.
    for (const round of rounds.values()) {
      if (round.scoring_mode !== 'mark' || !round.advance_count) continue;
      const quota = round.mark_quota_mode === 'per_heat'
        ? await client.query(
            `SELECT COUNT(*)::int AS n FROM scores WHERE heat_id=$1 AND judge_id=$2 AND dance_id=$3 AND marked = TRUE`,
            [heatId, judgeId, heat.dance_id],
          )
        : await client.query(
            `SELECT COUNT(*)::int AS n FROM scores WHERE round_id=$1 AND dance_id=$2 AND judge_id=$3 AND marked = TRUE`,
            [round.id, heat.dance_id, judgeId],
          );

      const limit = round.mark_quota_mode === 'per_heat'
        ? (await markQuota({ round, danceId: heat.dance_id, judgeId, heatId })).limit
        : round.advance_count;

      if (limit !== null && quota.rows[0].n > limit) {
        throw new ScoringError('scoring.errors.overQuota', { limit, used: quota.rows[0].n });
      }
    }

    await client.query(
      `INSERT INTO heat_judges (heat_id, judge_id, submitted_at) VALUES ($1, $2, now())
       ON CONFLICT (heat_id, judge_id) DO UPDATE SET submitted_at = now()`,
      [heatId, judgeId],
    );

    publish(heat.competition_id, {
      type: 'judge-submitted',
      heatId: Number(heatId),
      judgeId: Number(judgeId),
      auto,
    });

    return { accepted, skipped };
  });
}

// 換場倒數結束時自動收件：把每位裁判當下已填的內容直接當作送出。
// Auto-collect at the change-over: whatever each judge has on screen counts as submitted.
export async function autoCollect(heatId) {
  const pending = await many(
    `SELECT DISTINCT j.id FROM judges j
     JOIN judge_assignments ja ON ja.judge_id = j.id
     JOIN heat_entries he ON he.division_id = ja.division_id AND he.heat_id = $1
     LEFT JOIN heat_judges hj ON hj.heat_id = $1 AND hj.judge_id = j.id
     WHERE j.active = TRUE AND hj.submitted_at IS NULL AND hj.voided_at IS NULL`,
    [heatId],
  );

  for (const judge of pending) {
    await one(
      `INSERT INTO heat_judges (heat_id, judge_id, submitted_at) VALUES ($1, $2, now())
       ON CONFLICT (heat_id, judge_id) DO UPDATE SET submitted_at = COALESCE(heat_judges.submitted_at, now())
       RETURNING id`,
      [heatId, judge.id],
    );
    // 已經存進資料庫的就是「已填」，什麼都沒存的就是沒給。
    // Anything already stored counts as filled in; anything absent counts as nothing given.
    await query('UPDATE scores SET auto_collected = TRUE WHERE heat_id = $1 AND judge_id = $2', [heatId, judge.id]);
  }
  return pending.length;
}

// ---------------------------------------------------------------- 過半數制 / skating system

// 國標舞的正式算法：看多數決，不是看平均。
// The ballroom standard: placings are decided by majority, not by averaging.
export function skatingPlace(rankLists, judgeCount) {
  const majority = Math.floor(judgeCount / 2) + 1;
  const maxPlace = Math.max(1, ...rankLists.flatMap((r) => r.ranks));

  const summaries = rankLists.map((entry) => {
    const cumulative = [];
    const sums = [];
    for (let place = 1; place <= maxPlace; place += 1) {
      const atOrBetter = entry.ranks.filter((r) => r <= place);
      cumulative[place] = atOrBetter.length;
      sums[place] = atOrBetter.reduce((a, b) => a + b, 0);
    }
    let decidingPlace = maxPlace;
    for (let place = 1; place <= maxPlace; place += 1) {
      if (cumulative[place] >= majority) {
        decidingPlace = place;
        break;
      }
    }
    return { ...entry, cumulative, sums, decidingPlace, maxPlace };
  });

  const compare = (a, b) => {
    if (a.decidingPlace !== b.decidingPlace) return a.decidingPlace - b.decidingPlace;
    // 同一個關鍵名次上，拿到的票數多的贏。
    // At the deciding place, more marks wins.
    for (let place = a.decidingPlace; place <= a.maxPlace; place += 1) {
      if (a.cumulative[place] !== b.cumulative[place]) return b.cumulative[place] - a.cumulative[place];
      // 票數也一樣，名次數字總和小的贏。
      // Same count: the smaller sum of those marks wins.
      if (a.sums[place] !== b.sums[place]) return a.sums[place] - b.sums[place];
    }
    return 0;
  };

  const sorted = [...summaries].sort(compare);
  const placed = [];
  let currentPlace = 0;
  for (const [index, entry] of sorted.entries()) {
    if (index === 0 || compare(sorted[index - 1], entry) !== 0) currentPlace = index + 1;
    placed.push({ ...entry, place: currentPlace });
  }
  return placed;
}

// ---------------------------------------------------------------- 計算 / computing a round

function trimmedAverage(values) {
  if (values.length === 0) return 0;
  // 去掉最高最低要有至少 3 位裁判，否則就退回平均。
  // Dropping the top and bottom needs at least three judges; otherwise fall back to a plain average.
  if (values.length < 3) return values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const kept = sorted.slice(1, -1);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

export async function computeRound(roundId) {
  const round = await one('SELECT * FROM rounds WHERE id = $1', [roundId]);
  if (!round) throw new ScoringError('errors.notFound');

  const entries = await many('SELECT * FROM round_entries WHERE round_id = $1 ORDER BY bib_number NULLS LAST, id', [
    roundId,
  ]);
  const dances = await many(
    `SELECT d.* FROM division_dances dd JOIN dances d ON d.id = dd.dance_id
     WHERE dd.division_id = $1 ORDER BY dd.sort_order, d.id`,
    [round.division_id],
  );
  const scores = await many('SELECT * FROM scores WHERE round_id = $1', [roundId]);

  const active = entries.filter((e) => e.status === 'active');
  const absent = entries.filter((e) => e.status !== 'active');

  const byEntry = new Map(active.map((e) => [String(e.id), { entry: e, perDance: {}, detail: {} }]));
  for (const score of scores) {
    const bucket = byEntry.get(String(score.round_entry_id));
    if (!bucket) continue;
    const key = String(score.dance_id);
    bucket.perDance[key] = bucket.perDance[key] || { marks: 0, points: [], ranks: [] };
    if (score.marked) bucket.perDance[key].marks += 1;
    if (score.points !== null) bucket.perDance[key].points.push(Number(score.points));
    if (score.rank_position !== null) bucket.perDance[key].ranks.push(Number(score.rank_position));
  }

  let ordered;

  if (round.scoring_mode === 'mark') {
    // 選手在這一輪所有舞科、所有裁判拿到的 mark 全部加總，由高到低。
    // Every mark from every judge in every dance is added up; highest total first.
    ordered = [...byEntry.values()]
      .map((bucket) => {
        const total = Object.values(bucket.perDance).reduce((sum, d) => sum + d.marks, 0);
        bucket.detail = { perDance: Object.fromEntries(Object.entries(bucket.perDance).map(([k, v]) => [k, v.marks])) };
        return { ...bucket, sortValue: total, totalMarks: total };
      })
      .sort((a, b) => b.sortValue - a.sortValue);
  } else if (round.scoring_mode === 'score') {
    ordered = [...byEntry.values()]
      .map((bucket) => {
        const perDance = {};
        let total = 0;
        for (const dance of dances) {
          const data = bucket.perDance[String(dance.id)];
          const value = data
            ? round.score_method === 'trimmed'
              ? trimmedAverage(data.points)
              : data.points.reduce((a, b) => a + b, 0) / (data.points.length || 1)
            : 0;
          perDance[dance.id] = Number(value.toFixed(2));
          total += value;
        }
        bucket.detail = { perDance, method: round.score_method };
        return { ...bucket, sortValue: total, totalPoints: Number(total.toFixed(2)) };
      })
      .sort((a, b) => b.sortValue - a.sortValue);
  } else if (round.rank_method === 'skating') {
    // 每支舞各排一次名次，再把各支舞的名次合起來算總名次。
    // Each dance is placed on its own, then the per-dance placings decide the overall result.
    const judgeCount = await one(
      'SELECT COUNT(*)::int AS n FROM judge_assignments WHERE division_id = $1',
      [round.division_id],
    );
    const perDancePlaces = new Map();

    for (const dance of dances) {
      const lists = [...byEntry.values()]
        .map((bucket) => ({ id: String(bucket.entry.id), ranks: bucket.perDance[String(dance.id)]?.ranks || [] }))
        .filter((l) => l.ranks.length > 0);
      if (lists.length === 0) continue;
      const placed = skatingPlace(lists, Math.max(judgeCount.n, lists[0].ranks.length));
      for (const item of placed) {
        if (!perDancePlaces.has(item.id)) perDancePlaces.set(item.id, {});
        perDancePlaces.get(item.id)[dance.id] = item.place;
      }
    }

    // 總名次也用同一套多數決，把「各支舞的名次」當成「各裁判給的名次」來看。
    // The overall placing runs the same majority rule, treating each dance's place like a judge's mark.
    const lists = [...byEntry.values()].map((bucket) => ({
      id: String(bucket.entry.id),
      ranks: Object.values(perDancePlaces.get(String(bucket.entry.id)) || {}),
    }));
    const usable = lists.filter((l) => l.ranks.length > 0);
    const placed = usable.length > 0 ? skatingPlace(usable, usable[0].ranks.length) : [];
    const placeById = new Map(placed.map((p) => [p.id, p.place]));

    ordered = [...byEntry.values()]
      .map((bucket) => {
        const id = String(bucket.entry.id);
        bucket.detail = { perDance: perDancePlaces.get(id) || {}, method: 'skating' };
        return { ...bucket, sortValue: placeById.get(id) ?? 9999, skatingPlace: placeById.get(id) ?? null };
      })
      .sort((a, b) => a.sortValue - b.sortValue);
  } else {
    // 名次加總，數字小者勝。
    // Rank sum: the lowest total wins.
    ordered = [...byEntry.values()]
      .map((bucket) => {
        const perDance = {};
        let total = 0;
        for (const dance of dances) {
          const ranks = bucket.perDance[String(dance.id)]?.ranks || [];
          const sum = ranks.reduce((a, b) => a + b, 0);
          perDance[dance.id] = sum;
          total += sum;
        }
        bucket.detail = { perDance, method: 'sum' };
        return { ...bucket, sortValue: total || Number.MAX_SAFE_INTEGER, totalPoints: total };
      })
      .sort((a, b) => a.sortValue - b.sortValue);
  }

  // 同分的人名次相同。
  // Equal results share a place.
  let lastValue = null;
  let lastRank = 0;
  const ranked = ordered.map((item, index) => {
    const rank = item.sortValue === lastValue ? lastRank : index + 1;
    lastValue = item.sortValue;
    lastRank = rank;
    return { ...item, finalRank: rank };
  });

  // 晉級：取名額。同分卡在晉級線上時，主辦選「全部晉級」或「加賽」。
  // Advancement: take the quota. On a tie at the cut-off the organiser chose to advance all, or to dance off.
  let advancedIds = new Set();
  let tieAtCut = false;
  if (round.advance_count && ranked.length > 0) {
    const cutoffRank = ranked[Math.min(round.advance_count, ranked.length) - 1]?.finalRank;
    const withinQuota = ranked.filter((r) => r.finalRank < cutoffRank);
    const atCut = ranked.filter((r) => r.finalRank === cutoffRank);
    tieAtCut = withinQuota.length + atCut.length > round.advance_count;

    if (!tieAtCut || round.tie_policy === 'advance_all') {
      advancedIds = new Set([...withinQuota, ...atCut].map((r) => String(r.entry.id)));
    } else {
      // 加賽：卡在線上的人先不晉級，等主辦辦完加賽再手動決定。
      // Dance-off: those tied at the line do not advance yet; the organiser decides after the extra round.
      advancedIds = new Set(withinQuota.map((r) => String(r.entry.id)));
    }
  }

  await withTransaction(async (client) => {
    await client.query('DELETE FROM results WHERE round_id = $1', [roundId]);
    for (const item of ranked) {
      await client.query(
        `INSERT INTO results (round_id, round_entry_id, total_marks, total_points, final_rank, advanced, absent, detail)
         VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7)`,
        [
          roundId,
          item.entry.id,
          item.totalMarks ?? null,
          item.totalPoints ?? null,
          item.finalRank,
          advancedIds.has(String(item.entry.id)),
          JSON.stringify(item.detail || {}),
        ],
      );
    }
    for (const entry of absent) {
      await client.query(
        `INSERT INTO results (round_id, round_entry_id, final_rank, advanced, absent, detail)
         VALUES ($1,$2,NULL,FALSE,TRUE,'{}'::jsonb)`,
        [roundId, entry.id],
      );
    }
    await client.query(`UPDATE rounds SET status = 'closed', closed_at = now() WHERE id = $1`, [roundId]);
  });

  return {
    round,
    ranked: ranked.map((r) => ({
      roundEntryId: Number(r.entry.id),
      bib: r.entry.bib_number,
      name: r.entry.athlete_name,
      finalRank: r.finalRank,
      totalMarks: r.totalMarks ?? null,
      totalPoints: r.totalPoints ?? null,
      advanced: advancedIds.has(String(r.entry.id)),
      detail: r.detail,
    })),
    absent: absent.map((e) => ({ roundEntryId: Number(e.id), bib: e.bib_number, name: e.athlete_name })),
    tieAtCut,
    advanced: advancedIds.size,
  };
}

// 下一輪的名單依晉級名單自動產生。
// The next round is seeded from whoever advanced.
export async function seedNextRound(fromRoundId, toRoundId) {
  const advanced = await many(
    `SELECT re.* FROM results r JOIN round_entries re ON re.id = r.round_entry_id
     WHERE r.round_id = $1 AND r.advanced = TRUE ORDER BY r.final_rank, re.bib_number`,
    [fromRoundId],
  );

  return withTransaction(async (client) => {
    for (const entry of advanced) {
      await client.query(
        `INSERT INTO round_entries (round_id, registration_id, division_id, bib_number, athlete_name, unit_name)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (round_id, registration_id) DO NOTHING`,
        [toRoundId, entry.registration_id, entry.division_id, entry.bib_number, entry.athlete_name, entry.unit_name],
      );
    }
    const { rows } = await client.query('SELECT * FROM round_entries WHERE round_id = $1 ORDER BY bib_number', [
      toRoundId,
    ]);
    return rows;
  });
}

export function resultsFor(roundId) {
  return many(
    `SELECT r.*, re.athlete_name, re.unit_name, re.bib_number, d.name AS division_name
     FROM results r
     JOIN round_entries re ON re.id = r.round_entry_id
     JOIN divisions d ON d.id = re.division_id
     WHERE r.round_id = $1
     ORDER BY r.absent, r.final_rank NULLS LAST, re.bib_number`,
    [roundId],
  );
}

// 每輪截止收分後，主辦按「公告」才對外顯示，不會自動外流。
// Results only go public when the organiser presses publish; nothing leaks on its own.
export function publishRound(roundId) {
  return one('UPDATE rounds SET published_at = now() WHERE id = $1 RETURNING *', [roundId]);
}

export function unpublishRound(roundId) {
  return one('UPDATE rounds SET published_at = NULL WHERE id = $1 RETURNING *', [roundId]);
}

export default {
  ScoringError,
  markQuota,
  submitScores,
  autoCollect,
  skatingPlace,
  computeRound,
  seedNextRound,
  resultsFor,
  publishRound,
  unpublishRound,
};
