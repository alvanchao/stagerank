// 主持人在一輪開始前的處置。
// What the host decides before a round starts.
//
// 排賽序時就設好取幾人，但比賽當天有人沒到，這一輪可能根本不該比。
// 例如初賽要取 6 人，結果只到 7 個人，比了也只是刷掉一個人。
// The places available are fixed when the schedule is built, but on the day people do not turn up
// and the round may not be worth running: a qualifying round taking six out of seven only removes
// one couple.
//
// 三個選擇，只有主持人能按（董事長：不然當天會很亂）：
//   normal     照舊，正常比
//   free_pass  這一輪不比，在場的人全部晉級
//   skipped    跳過這一輪（連同中間的輪次），在場的人直接進最後一輪
// Three choices, and only the host has them:
//   normal     run it as planned
//   free_pass  do not dance it; everyone present goes through
//   skipped    skip this round (and any in between) and go straight to the final
//
// 三種都留紀錄，公告的成績會誠實標示，不會讓人以為是比出來的。
// All three are recorded, and the published results say so plainly rather than pretending the
// round was danced.

import { one, many, withTransaction } from '../db/index.js';
import { publish } from './realtime.js';

export class RoundDecisionError extends Error {
  constructor(key, params) {
    super(key);
    this.key = key;
    this.params = params;
    this.name = 'RoundDecisionError';
  }
}

export function getRound(roundId) {
  return one(
    `SELECT r.*, d.competition_id, d.name AS division_name
     FROM rounds r JOIN divisions d ON d.id = r.division_id
     WHERE r.id = $1`,
    [roundId],
  );
}

function roundsOfDivision(divisionId) {
  return many('SELECT * FROM rounds WHERE division_id = $1 ORDER BY sort_order, id', [divisionId]);
}

// 這一輪已經開始評分了就不能再處置，否則名單會在比賽中途變動。
// Once scoring has begun the roster must not move, so no decision is allowed.
async function assertNotStarted(round) {
  const started = await one(
    `SELECT 1 FROM heats h
     JOIN heat_entries he ON he.heat_id = h.id
     WHERE he.round_id = $1 AND h.status IN ('scoring', 'closed') LIMIT 1`,
    [round.id],
  );
  if (started) throw new RoundDecisionError('rounds.errors.alreadyStarted');
}

// 應到多少、實到多少。實到＝報到了而且沒被標記缺席的人。
// Expected versus present: present means reported in and not marked absent.
export async function attendance(roundId) {
  // 報到記在報名那一筆上（一個參賽單位報到一次），所以要接回 registrations。
  // Reporting in is recorded on the registration, one per entry unit, so we join back to it.
  const row = await one(
    `SELECT
       COUNT(*)::int AS expected,
       COUNT(*) FILTER (WHERE re.status = 'active' AND reg.reported_at IS NOT NULL)::int AS present
     FROM round_entries re
     JOIN registrations reg ON reg.id = re.registration_id
     WHERE re.round_id = $1`,
    [roundId],
  );
  return row || { expected: 0, present: 0 };
}

// 給主持人看的一句話：應到幾人、實到幾人、要取幾人，以及系統的建議。
// One line for the host: expected, present, places available, and what the system suggests.
export async function advice(roundId) {
  const round = await getRound(roundId);
  if (!round) throw new RoundDecisionError('errors.notFound');

  const { expected, present } = await attendance(roundId);
  const takes = round.advance_count;
  const siblings = await roundsOfDivision(round.division_id);
  const later = siblings.filter((r) => r.sort_order > round.sort_order);
  const isLast = later.length === 0;

  let suggestion = 'normal';
  // 在場的人不比要取的人多，比了也刷不掉誰，建議免賽晉級。
  // If no more are present than the round would take, dancing it eliminates nobody.
  if (!isLast && takes && present > 0 && present <= takes) suggestion = 'free_pass';

  return {
    round,
    expected,
    present,
    advanceCount: takes,
    isLastRound: isLast,
    canSkipToFinal: later.length > 0,
    finalRound: later.length > 0 ? later[later.length - 1] : null,
    suggestion,
  };
}

async function record(client, roundId, decision, extra = {}) {
  await client.query(
    `INSERT INTO round_decisions
       (round_id, decision, present_count, expected_count, advance_count, decided_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      roundId,
      decision,
      extra.present ?? null,
      extra.expected ?? null,
      extra.advanceCount ?? null,
      extra.decidedBy || 'host',
      extra.note || null,
    ],
  );
}

// 當天臨時改晉級名額。照舊比，只是取的人數變了。
// Change the places available on the day. The round still runs; only the number changes.
export async function setAdvanceCount(roundId, advanceCount, { decidedBy = 'host' } = {}) {
  const round = await getRound(roundId);
  if (!round) throw new RoundDecisionError('errors.notFound');
  await assertNotStarted(round);

  const count = Number.parseInt(advanceCount, 10);
  if (!Number.isFinite(count) || count < 1) throw new RoundDecisionError('rounds.errors.badAdvanceCount');

  const { expected, present } = await attendance(roundId);

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'UPDATE rounds SET advance_count = $2 WHERE id = $1 RETURNING *',
      [roundId, count],
    );
    await record(client, roundId, 'advance_count', { present, expected, advanceCount: count, decidedBy });
    publish(round.competition_id, { type: 'round-decision', roundId: Number(roundId), decision: 'advance_count', advanceCount: count });
    return rows[0];
  });
}

// 把一輪的人原封不動送進下一輪。免賽晉級和跳過都用這一段。
// Carry a round's people straight into another round; both free pass and skip use this.
async function carryInto(client, fromRoundId, toRoundId) {
  const { rows: present } = await client.query(
    `SELECT re.* FROM round_entries re
     JOIN registrations reg ON reg.id = re.registration_id
     WHERE re.round_id = $1 AND re.status = 'active' AND reg.reported_at IS NOT NULL
     ORDER BY re.bib_number NULLS LAST, re.id`,
    [fromRoundId],
  );

  for (const entry of present) {
    await client.query(
      `INSERT INTO round_entries (round_id, registration_id, division_id, bib_number, athlete_name, unit_name)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (round_id, registration_id) DO NOTHING`,
      [toRoundId, entry.registration_id, entry.division_id, entry.bib_number, entry.athlete_name, entry.unit_name],
    );
  }
  return present;
}

// 沒到的人也要有成績紀錄，成績單上顯示缺席，不是憑空消失。
// People who never arrived still get a row, shown as absent rather than silently vanishing.
async function recordOutcomeResults(client, roundId, presentIds, kind) {
  const { rows: all } = await client.query('SELECT * FROM round_entries WHERE round_id = $1', [roundId]);
  const present = new Set(presentIds.map((e) => String(e.id)));

  for (const entry of all) {
    const advanced = present.has(String(entry.id));
    await client.query(
      `INSERT INTO results (round_id, round_entry_id, advanced, absent, detail)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (round_id, round_entry_id)
       DO UPDATE SET advanced = EXCLUDED.advanced, absent = EXCLUDED.absent, detail = EXCLUDED.detail`,
      [roundId, entry.id, advanced, !advanced, JSON.stringify({ outcome: kind })],
    );
  }
}

// 免賽晉級：這一輪不比，在場的人全部進下一輪。
// Free pass: the round is not danced and everyone present goes into the next round.
export async function freePass(roundId, { decidedBy = 'host' } = {}) {
  const round = await getRound(roundId);
  if (!round) throw new RoundDecisionError('errors.notFound');
  await assertNotStarted(round);

  const siblings = await roundsOfDivision(round.division_id);
  const next = siblings.find((r) => r.sort_order > round.sort_order);
  if (!next) throw new RoundDecisionError('rounds.errors.noNextRound');

  const { expected, present } = await attendance(roundId);

  return withTransaction(async (client) => {
    const carried = await carryInto(client, roundId, next.id);
    await recordOutcomeResults(client, roundId, carried, 'free_pass');
    await client.query(
      `UPDATE rounds SET outcome = 'free_pass', outcome_at = now(), outcome_by = $2,
                         status = 'closed', closed_at = now()
       WHERE id = $1`,
      [roundId, decidedBy],
    );
    // 這一輪不比了，已經排好的場次就不該再出現在秩序表上。
    // The round is not being danced, so its heats must leave the running order.
    await client.query(
      `DELETE FROM heats WHERE id IN (
         SELECT DISTINCT h.id FROM heats h JOIN heat_entries he ON he.heat_id = h.id
         WHERE he.round_id = $1 AND h.status = 'pending')`,
      [roundId],
    );
    await record(client, roundId, 'free_pass', { present, expected, advanceCount: carried.length, decidedBy });
    publish(round.competition_id, { type: 'round-decision', roundId: Number(roundId), decision: 'free_pass' });

    return { round: await getRound(roundId), advanced: carried, into: next };
  });
}

// 直接決賽：跳過這一輪和中間所有輪次，在場的人直接進最後一輪。
// Straight to the final: this round and every one in between are skipped, and whoever is present
// goes into the last round.
export async function skipToFinal(roundId, { decidedBy = 'host' } = {}) {
  const round = await getRound(roundId);
  if (!round) throw new RoundDecisionError('errors.notFound');
  await assertNotStarted(round);

  const siblings = await roundsOfDivision(round.division_id);
  const later = siblings.filter((r) => r.sort_order > round.sort_order);
  if (later.length === 0) throw new RoundDecisionError('rounds.errors.noNextRound');

  const finalRound = later[later.length - 1];
  const between = later.slice(0, -1);
  const { expected, present } = await attendance(roundId);

  return withTransaction(async (client) => {
    const carried = await carryInto(client, roundId, finalRound.id);
    await recordOutcomeResults(client, roundId, carried, 'skipped');

    for (const skipped of [round, ...between]) {
      await client.query(
        `UPDATE rounds SET outcome = 'skipped', outcome_at = now(), outcome_by = $2,
                           status = 'closed', closed_at = now()
         WHERE id = $1`,
        [skipped.id, decidedBy],
      );
      await client.query(
        `DELETE FROM heats WHERE id IN (
           SELECT DISTINCT h.id FROM heats h JOIN heat_entries he ON he.heat_id = h.id
           WHERE he.round_id = $1 AND h.status = 'pending')`,
        [skipped.id],
      );
      await record(client, skipped.id, 'skipped', { present, expected, advanceCount: carried.length, decidedBy });
    }

    publish(round.competition_id, { type: 'round-decision', roundId: Number(roundId), decision: 'skipped' });
    return { round: await getRound(roundId), advanced: carried, into: finalRound, skipped: between };
  });
}

export function decisionsFor(roundId) {
  return many('SELECT * FROM round_decisions WHERE round_id = $1 ORDER BY decided_at DESC', [roundId]);
}

export default {
  RoundDecisionError,
  attendance,
  advice,
  setAdvanceCount,
  freePass,
  skipToFinal,
  decisionsFor,
};
