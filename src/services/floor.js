// 比賽當天的控場：報到、檢錄、換場、裁判就緒、候場提示、跳出作廢。
// Competition day: reporting in, check-in, change-over, judge ready, waiting notice, walk-away voiding.

import { one, many, query, withTransaction } from '../db/index.js';
import { publish } from './realtime.js';
import { autoCollect } from './scoring.js';

export class FloorError extends Error {
  constructor(key) {
    super(key);
    this.key = key;
    this.name = 'FloorError';
  }
}

// ---------------------------------------------------------------- 報到 / reporting in

// 比賽當天選手先到報到處報到，通常就是領背號的時候。
// On the day the competitor reports in at the desk, usually when collecting their bib.
export async function reportIn(registrationId, { by = 'desk' } = {}) {
  const row = await one(
    `UPDATE registrations SET reported_at = COALESCE(reported_at, now()), reported_by = $2, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [registrationId, by],
  );
  if (!row) throw new FloorError('errors.notFound');
  publish(row.competition_id, { type: 'reported', registrationId: Number(registrationId) });
  return row;
}

export async function undoReportIn(registrationId) {
  const row = await one(
    'UPDATE registrations SET reported_at = NULL, reported_by = NULL, updated_at = now() WHERE id = $1 RETURNING *',
    [registrationId],
  );
  if (!row) throw new FloorError('errors.notFound');
  publish(row.competition_id, { type: 'reported', registrationId: Number(registrationId) });
  return row;
}

// ---------------------------------------------------------------- 檢錄 / check-in

// 檢錄人員的畫面：接下來幾場的選手。沒報到的會反灰，一看就知道今天沒來。
// The check-in screen: competitors in the next few heats. Anyone who never reported in is greyed out.
export async function checkInBoard(competitionId, { limit } = {}) {
  const competition = await one('SELECT * FROM competitions WHERE id = $1', [competitionId]);
  if (!competition) throw new FloorError('errors.notFound');
  const take = limit || competition.lookahead_heats || 3;

  const heats = await many(
    `SELECT h.*, da.name AS dance_name
     FROM heats h JOIN dances da ON da.id = h.dance_id
     WHERE h.competition_id = $1 AND h.status IN ('pending', 'standby', 'scoring')
     ORDER BY h.sort_key, h.id LIMIT $2`,
    [competitionId, take],
  );

  const result = [];
  for (const heat of heats) {
    const entries = await many(
      `SELECT he.id AS heat_entry_id, he.checked_in_at, he.checked_in_by,
              re.id AS round_entry_id, re.athlete_name, re.unit_name, re.bib_number, re.status AS entry_status,
              d.name AS division_name, r.reported_at, r.id AS registration_id
       FROM heat_entries he
       JOIN round_entries re ON re.id = he.round_entry_id
       JOIN divisions d ON d.id = he.division_id
       JOIN registrations r ON r.id = re.registration_id
       WHERE he.heat_id = $1
       ORDER BY d.sort_order, d.id, re.bib_number NULLS LAST, re.id`,
      [heat.id],
    );
    result.push({
      heat,
      entries,
      ready: entries.length > 0 && entries.every((e) => e.checked_in_at || e.entry_status === 'absent'),
    });
  }
  return { competition, heats: result };
}

// 檢錄人員可以修正：反灰的選手如果人其實在現場，直接點他就補上報到並完成檢錄。
// Check-in staff can fix a miss: tapping a greyed-out competitor reports them in and checks them in at once.
export async function checkIn(heatEntryId, { by = 'checkin', alsoReport = true } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT he.*, h.competition_id, h.status AS heat_status, re.registration_id
       FROM heat_entries he
       JOIN heats h ON h.id = he.heat_id
       JOIN round_entries re ON re.id = he.round_entry_id
       WHERE he.id = $1`,
      [heatEntryId],
    );
    const entry = rows[0];
    if (!entry) throw new FloorError('errors.notFound');
    // 這一場結束之後就不能再補點，因為裁判已經看不到這一場了。
    // Once the heat is closed nobody can be added: the judges no longer see it.
    if (entry.heat_status === 'closed') throw new FloorError('floor.errors.heatClosed');

    if (alsoReport) {
      await client.query(
        `UPDATE registrations SET reported_at = COALESCE(reported_at, now()), reported_by = COALESCE(reported_by, $2)
         WHERE id = $1`,
        [entry.registration_id, by],
      );
    }
    const { rows: updated } = await client.query(
      `UPDATE heat_entries SET checked_in_at = COALESCE(checked_in_at, now()), checked_in_by = $2
       WHERE id = $1 RETURNING *`,
      [heatEntryId, by],
    );

    publish(entry.competition_id, {
      type: 'checkin',
      heatId: Number(entry.heat_id),
      heatEntryId: Number(heatEntryId),
      by,
    });
    return updated[0];
  });
}

export async function undoCheckIn(heatEntryId) {
  const entry = await one(
    `SELECT he.*, h.competition_id, h.status AS heat_status FROM heat_entries he
     JOIN heats h ON h.id = he.heat_id WHERE he.id = $1`,
    [heatEntryId],
  );
  if (!entry) throw new FloorError('errors.notFound');
  if (entry.heat_status !== 'pending' && entry.heat_status !== 'standby') {
    throw new FloorError('floor.errors.heatStarted');
  }
  const row = await one(
    'UPDATE heat_entries SET checked_in_at = NULL, checked_in_by = NULL WHERE id = $1 RETURNING *',
    [heatEntryId],
  );
  publish(entry.competition_id, { type: 'checkin', heatId: Number(entry.heat_id), heatEntryId: Number(heatEntryId) });
  return row;
}

// 整組到齊後按「這一場已就緒」。
// "This heat is ready" once everyone has arrived.
export async function markHeatReady(heatId, { by = 'checkin' } = {}) {
  const board = await heatStatus(heatId);
  publish(board.heat.competition_id, { type: 'heat-ready', heatId: Number(heatId), by });
  return board;
}

// ---------------------------------------------------------------- 主持人控場 / floor control

export async function heatStatus(heatId) {
  const heat = await one(
    `SELECT h.*, da.name AS dance_name FROM heats h JOIN dances da ON da.id = h.dance_id WHERE h.id = $1`,
    [heatId],
  );
  if (!heat) throw new FloorError('errors.notFound');

  const entries = await many(
    `SELECT he.id AS heat_entry_id, he.checked_in_at, re.id AS round_entry_id, re.athlete_name,
            re.bib_number, re.unit_name, re.status AS entry_status, d.name AS division_name, r.reported_at
     FROM heat_entries he
     JOIN round_entries re ON re.id = he.round_entry_id
     JOIN divisions d ON d.id = he.division_id
     JOIN registrations r ON r.id = re.registration_id
     WHERE he.heat_id = $1
     ORDER BY d.sort_order, d.id, re.bib_number NULLS LAST, re.id`,
    [heatId],
  );

  // 裁判燈號：未確認、已準備好、已送出、已跳出（作廢）。
  // Judge lights: not confirmed, ready, submitted, walked away (voided).
  const judges = await many(
    `SELECT j.id, j.name,
            hj.ready_at, hj.submitted_at, hj.voided_at
     FROM judges j
     JOIN judge_assignments ja ON ja.judge_id = j.id
     JOIN (SELECT DISTINCT division_id FROM heat_entries WHERE heat_id = $1) hd ON hd.division_id = ja.division_id
     LEFT JOIN heat_judges hj ON hj.heat_id = $1 AND hj.judge_id = j.id
     WHERE j.active = TRUE
     GROUP BY j.id, j.name, hj.ready_at, hj.submitted_at, hj.voided_at
     ORDER BY j.id`,
    [heatId],
  );

  return {
    heat,
    entries,
    judges: judges.map((j) => ({
      ...j,
      light: j.voided_at ? 'voided' : j.submitted_at ? 'submitted' : j.ready_at ? 'ready' : 'waiting',
    })),
    checkedIn: entries.filter((e) => e.checked_in_at).length,
    missing: entries.filter((e) => !e.checked_in_at && e.entry_status === 'active'),
  };
}

// 主持人畫面：現在這一場、下一場、以及接下來的順序。
// The host's board: the current heat, the next one, and what follows.
export async function hostBoard(competitionId) {
  const competition = await one('SELECT * FROM competitions WHERE id = $1', [competitionId]);
  if (!competition) throw new FloorError('errors.notFound');

  const current = await one(
    `SELECT h.*, da.name AS dance_name FROM heats h JOIN dances da ON da.id = h.dance_id
     WHERE h.competition_id = $1 AND h.status IN ('standby', 'scoring')
     ORDER BY h.sort_key, h.id LIMIT 1`,
    [competitionId],
  );

  const upcoming = await many(
    `SELECT h.*, da.name AS dance_name,
            COUNT(he.id)::int AS entry_count,
            COUNT(he.checked_in_at)::int AS checked_in_count
     FROM heats h
     JOIN dances da ON da.id = h.dance_id
     LEFT JOIN heat_entries he ON he.heat_id = h.id
     WHERE h.competition_id = $1 AND h.status = 'pending'
     GROUP BY h.id, da.name
     ORDER BY h.sort_key, h.id LIMIT 8`,
    [competitionId],
  );

  return {
    competition,
    current: current ? await heatStatus(current.id) : null,
    upcoming,
  };
}

// 換場。上一場自動收件並關閉，下一場進入預備。
// Change over: auto-collect and close the running heat, put the next one on standby.
export async function nextHeat(competitionId, { heatId = null } = {}) {
  const competition = await one('SELECT * FROM competitions WHERE id = $1', [competitionId]);
  if (!competition) throw new FloorError('errors.notFound');

  const running = await one(
    `SELECT * FROM heats WHERE competition_id = $1 AND status IN ('standby', 'scoring') ORDER BY sort_key LIMIT 1`,
    [competitionId],
  );

  if (running) {
    // 倒數結束時自動收件：裁判當下已填的直接當作送出，沒填的視為沒給。
    // Auto-collect at the end of the countdown: whatever is on screen counts, blanks count as nothing given.
    if (running.status === 'scoring') await autoCollect(running.id);
    await query(`UPDATE heats SET status = 'closed', closed_at = now() WHERE id = $1`, [running.id]);
    publish(competitionId, { type: 'heat-closed', heatId: Number(running.id) });
  }

  const target = heatId
    ? await one('SELECT * FROM heats WHERE id = $1 AND competition_id = $2', [heatId, competitionId])
    : await one(
        `SELECT * FROM heats WHERE competition_id = $1 AND status = 'pending' ORDER BY sort_key, id LIMIT 1`,
        [competitionId],
      );

  if (!target) {
    publish(competitionId, { type: 'no-more-heats' });
    return { closed: running || null, next: null };
  }

  await query(`UPDATE heats SET status = 'standby', standby_at = now() WHERE id = $1`, [target.id]);
  // 這一輪開始了，之後就不能換裁判、也不能重新結算。
  // The round is under way: no more judge swaps and no more re-settling.
  await query(
    `UPDATE rounds SET status = 'running'
     WHERE id IN (SELECT DISTINCT round_id FROM heat_entries WHERE heat_id = $1) AND status = 'pending'`,
    [target.id],
  );
  await query(
    `UPDATE competitions SET scoring_started_at = COALESCE(scoring_started_at, now()) WHERE id = $1`,
    [competitionId],
  );

  publish(competitionId, {
    type: 'heat-standby',
    heatId: Number(target.id),
    countdownSeconds: competition.changeover_seconds,
  });

  return { closed: running || null, next: await heatStatus(target.id) };
}

// 主持人按「開始」才進入評分。跳出作廢的規則從這一刻起算。
// Scoring only begins when the host presses start. The walk-away rule applies from that moment.
export async function startHeat(heatId) {
  const heat = await one('SELECT * FROM heats WHERE id = $1', [heatId]);
  if (!heat) throw new FloorError('errors.notFound');
  if (heat.status === 'closed') throw new FloorError('floor.errors.heatClosed');

  await query(`UPDATE heats SET status = 'scoring', started_at = COALESCE(started_at, now()) WHERE id = $1`, [heatId]);
  publish(heat.competition_id, { type: 'heat-start', heatId: Number(heatId) });
  return heatStatus(heatId);
}

// 選手未到：整場往後挪，或標記缺席。不提供把單一選手移到別的 heat。
// A no-show: move the whole heat back, or mark them absent. Single competitors are never moved.
export async function markAbsent(roundEntryId) {
  const entry = await one(
    `SELECT re.*, d.competition_id FROM round_entries re JOIN divisions d ON d.id = re.division_id WHERE re.id = $1`,
    [roundEntryId],
  );
  if (!entry) throw new FloorError('errors.notFound');

  const row = await one(`UPDATE round_entries SET status = 'absent' WHERE id = $1 RETURNING *`, [roundEntryId]);
  publish(entry.competition_id, { type: 'absent', roundEntryId: Number(roundEntryId) });
  return row;
}

export async function undoAbsent(roundEntryId) {
  const entry = await one(
    `SELECT re.*, d.competition_id FROM round_entries re JOIN divisions d ON d.id = re.division_id WHERE re.id = $1`,
    [roundEntryId],
  );
  if (!entry) throw new FloorError('errors.notFound');
  const row = await one(`UPDATE round_entries SET status = 'active' WHERE id = $1 RETURNING *`, [roundEntryId]);
  publish(entry.competition_id, { type: 'absent', roundEntryId: Number(roundEntryId) });
  return row;
}

// ---------------------------------------------------------------- 裁判 / judges

// 裁判就緒確認。主持人一眼看出「選手到齊、裁判就緒」。
// The judge's ready confirmation, so the host can see at a glance that everyone is set.
export async function judgeReady(heatId, judgeId) {
  const heat = await one('SELECT * FROM heats WHERE id = $1', [heatId]);
  if (!heat) throw new FloorError('errors.notFound');

  const row = await one(
    `INSERT INTO heat_judges (heat_id, judge_id, ready_at) VALUES ($1, $2, now())
     ON CONFLICT (heat_id, judge_id) DO UPDATE SET ready_at = COALESCE(heat_judges.ready_at, now())
     RETURNING *`,
    [heatId, judgeId],
  );
  publish(heat.competition_id, { type: 'judge-ready', heatId: Number(heatId), judgeId: Number(judgeId) });
  return row;
}

// 評分中離開畫面就作廢，不能補評。預備狀態和候場期間不算。
// Leaving the screen while scoring voids this heat for that judge. Standby and waiting do not count.
export async function judgeLeftScreen(heatId, judgeId, { reason = 'left-screen' } = {}) {
  const heat = await one('SELECT * FROM heats WHERE id = $1', [heatId]);
  if (!heat) throw new FloorError('errors.notFound');
  if (heat.status !== 'scoring') return { voided: false, reason: 'not-scoring' };

  const existing = await one('SELECT * FROM heat_judges WHERE heat_id = $1 AND judge_id = $2', [heatId, judgeId]);
  if (existing?.submitted_at) return { voided: false, reason: 'already-submitted' };

  const row = await one(
    `INSERT INTO heat_judges (heat_id, judge_id, voided_at, void_reason) VALUES ($1, $2, now(), $3)
     ON CONFLICT (heat_id, judge_id) DO UPDATE
       SET voided_at = COALESCE(heat_judges.voided_at, now()), void_reason = EXCLUDED.void_reason
     RETURNING *`,
    [heatId, judgeId, reason],
  );

  // 已經送出的分數要一併作廢，否則等於半套成績。
  // Anything already submitted for this heat is voided too, otherwise the score would be half-counted.
  await query('DELETE FROM scores WHERE heat_id = $1 AND judge_id = $2', [heatId, judgeId]);

  publish(heat.competition_id, { type: 'judge-voided', heatId: Number(heatId), judgeId: Number(judgeId), reason });
  return { voided: true, record: row };
}

// 裁判沒有檢錄人員通知，所以由系統告訴他還有多久輪到他。
// Judges have nobody calling them, so the system tells them how long until their turn.
export async function judgeWaitingInfo(competitionId, judgeId) {
  const competition = await one('SELECT * FROM competitions WHERE id = $1', [competitionId]);
  if (!competition) throw new FloorError('errors.notFound');

  const queue = await many(
    `SELECT h.id, h.sort_key, h.status, h.label, da.name AS dance_name,
            EXISTS (SELECT 1 FROM heat_entries he
                    JOIN judge_assignments ja ON ja.division_id = he.division_id
                    WHERE he.heat_id = h.id AND ja.judge_id = $2) AS mine,
            (SELECT STRING_AGG(DISTINCT d.name, ' + ' ORDER BY d.name)
             FROM heat_entries he JOIN divisions d ON d.id = he.division_id
             WHERE he.heat_id = h.id) AS divisions
     FROM heats h JOIN dances da ON da.id = h.dance_id
     WHERE h.competition_id = $1 AND h.status IN ('pending', 'standby', 'scoring')
     ORDER BY h.sort_key, h.id`,
    [competitionId, judgeId],
  );

  const index = queue.findIndex((h) => h.mine);
  if (index === -1) return { hasNext: false, heatsAway: null, secondsAway: null, next: null };

  // 「還有幾場」是精確的；「約幾分鐘」是估算，用當天已比完場次的平均時間推算。
  // The number of heats is exact; the minutes are an estimate from today's completed heats.
  const timing = await one(
    `SELECT AVG(EXTRACT(EPOCH FROM (closed_at - started_at)))::int AS avg_seconds, COUNT(*)::int AS n
     FROM heats WHERE competition_id = $1 AND status = 'closed' AND started_at IS NOT NULL AND closed_at IS NOT NULL`,
    [competitionId],
  );
  const perHeat = timing?.n >= 3 && timing.avg_seconds ? timing.avg_seconds : competition.estimated_heat_seconds;

  return {
    hasNext: true,
    heatsAway: index,
    secondsAway: index * perHeat,
    estimateIsMeasured: timing?.n >= 3,
    // 只顯示組別、舞科和場數，不顯示選手名單。
    // Only the division, the dance and the count; never the competitor list.
    next: { divisions: queue[index].divisions, danceName: queue[index].dance_name, status: queue[index].status },
  };
}

export default {
  FloorError,
  reportIn,
  undoReportIn,
  checkInBoard,
  checkIn,
  undoCheckIn,
  markHeatReady,
  heatStatus,
  hostBoard,
  nextHeat,
  startHeat,
  markAbsent,
  undoAbsent,
  judgeReady,
  judgeLeftScreen,
  judgeWaitingInfo,
};
