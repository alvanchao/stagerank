// 裁判：產生賽序時指定，當天可以改，但同一輪一旦開始就不能換。
// Judges: assigned when the running order is built, changeable on the day, frozen once a round starts.

import crypto from 'node:crypto';
import { one, many, withTransaction } from '../db/index.js';

export class JudgeError extends Error {
  constructor(key) {
    super(key);
    this.key = key;
    this.name = 'JudgeError';
  }
}

// 登入碼刻意不含容易看錯的字母，主持人要唸給代班裁判聽。
// The login code avoids look-alike characters because the host reads it out loud.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateLoginCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

export async function addJudge({ competitionId, name }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await one(
        'INSERT INTO judges (competition_id, name, login_code) VALUES ($1, $2, $3) RETURNING *',
        [competitionId, name, generateLoginCode()],
      );
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }
  throw new JudgeError('errors.serverError');
}

export function listJudges(competitionId) {
  return many(
    `SELECT j.*,
            COALESCE(ARRAY_AGG(d.name ORDER BY d.sort_order, d.id)
                     FILTER (WHERE d.id IS NOT NULL), '{}') AS division_names,
            COALESCE(ARRAY_AGG(d.id ORDER BY d.sort_order, d.id)
                     FILTER (WHERE d.id IS NOT NULL), '{}') AS division_ids
     FROM judges j
     LEFT JOIN judge_assignments ja ON ja.judge_id = j.id
     LEFT JOIN divisions d ON d.id = ja.division_id
     WHERE j.competition_id = $1
     GROUP BY j.id ORDER BY j.id`,
    [competitionId],
  );
}

export function judgeByLoginCode(code) {
  return one('SELECT * FROM judges WHERE login_code = $1 AND active = TRUE', [String(code || '').trim().toUpperCase()]);
}

// 同一位裁判可以被指定到多個組別。
// One judge may cover several divisions.
export async function assignToDivision(judgeId, divisionId) {
  const division = await one('SELECT * FROM divisions WHERE id = $1', [divisionId]);
  if (!division) throw new JudgeError('errors.notFound');

  // 同一個組別的同一輪一旦開始，就不能更換或新增裁判。
  // Once any round of a division has started, its judging panel is frozen.
  const running = await one(
    `SELECT 1 FROM rounds WHERE division_id = $1 AND status IN ('running', 'closed') LIMIT 1`,
    [divisionId],
  );
  if (running) throw new JudgeError('judges.errors.roundStarted');

  return one(
    `INSERT INTO judge_assignments (judge_id, division_id) VALUES ($1, $2)
     ON CONFLICT (judge_id, division_id) DO NOTHING RETURNING *`,
    [judgeId, divisionId],
  );
}

export async function unassignFromDivision(judgeId, divisionId) {
  const running = await one(
    `SELECT 1 FROM rounds WHERE division_id = $1 AND status IN ('running', 'closed') LIMIT 1`,
    [divisionId],
  );
  if (running) throw new JudgeError('judges.errors.roundStarted');
  await one('DELETE FROM judge_assignments WHERE judge_id = $1 AND division_id = $2 RETURNING id', [judgeId, divisionId]);
  return true;
}

// 換裁判：把某位換成另一位，只能在該組別這一輪開始之前。
// Swap one judge for another; only before that division's round has started.
export async function replaceJudge(divisionId, outgoingJudgeId, incomingJudgeId) {
  return withTransaction(async (client) => {
    const { rows: running } = await client.query(
      `SELECT 1 FROM rounds WHERE division_id = $1 AND status IN ('running', 'closed') LIMIT 1`,
      [divisionId],
    );
    if (running.length > 0) throw new JudgeError('judges.errors.roundStarted');

    await client.query('DELETE FROM judge_assignments WHERE judge_id = $1 AND division_id = $2', [
      outgoingJudgeId,
      divisionId,
    ]);
    if (incomingJudgeId) {
      await client.query(
        `INSERT INTO judge_assignments (judge_id, division_id) VALUES ($1, $2)
         ON CONFLICT (judge_id, division_id) DO NOTHING`,
        [incomingJudgeId, divisionId],
      );
    }
    return true;
  });
}

export function judgesForDivision(divisionId) {
  return many(
    `SELECT j.* FROM judge_assignments ja JOIN judges j ON j.id = ja.judge_id
     WHERE ja.division_id = $1 AND j.active = TRUE ORDER BY j.id`,
    [divisionId],
  );
}

// 這一場要哪些裁判評：場上有哪些組別，就找負責那些組別的裁判。
// Who judges this heat: whoever covers the divisions that are on the floor.
export function judgesForHeat(heatId) {
  return many(
    `SELECT DISTINCT j.* FROM heat_entries he
     JOIN judge_assignments ja ON ja.division_id = he.division_id
     JOIN judges j ON j.id = ja.judge_id
     WHERE he.heat_id = $1 AND j.active = TRUE
     ORDER BY j.id`,
    [heatId],
  );
}

// 併場時，裁判的手機只顯示他負責的組別的選手。
// In a merged heat a judge's phone only lists competitors from the divisions they cover.
export function heatEntriesForJudge(heatId, judgeId) {
  return many(
    `SELECT he.*, re.athlete_name, re.unit_name, re.bib_number, re.status AS entry_status,
            d.name AS division_name, d.id AS division_id, r.id AS round_id, r.name AS round_name
     FROM heat_entries he
     JOIN round_entries re ON re.id = he.round_entry_id
     JOIN divisions d ON d.id = he.division_id
     JOIN rounds r ON r.id = he.round_id
     WHERE he.heat_id = $1
       AND he.checked_in_at IS NOT NULL
       AND re.status = 'active'
       AND EXISTS (SELECT 1 FROM judge_assignments ja
                   WHERE ja.judge_id = $2 AND ja.division_id = he.division_id)
     ORDER BY d.sort_order, d.id, re.bib_number NULLS LAST, re.id`,
    [heatId, judgeId],
  );
}

// 主辦排賽序時的提醒。只是提醒，不擋住主辦。
// Warnings shown to the organiser while scheduling. Advisory only; nothing is blocked.
export async function assignmentWarnings(competitionId) {
  const warnings = [];

  const unassigned = await many(
    `SELECT d.id, d.name FROM divisions d
     WHERE d.competition_id = $1
       AND NOT EXISTS (SELECT 1 FROM judge_assignments ja WHERE ja.division_id = d.id)
     ORDER BY d.sort_order, d.id`,
    [competitionId],
  );
  for (const division of unassigned) {
    warnings.push({ key: 'judges.warnings.noJudges', params: { division: division.name } });
  }

  // 過半數制要靠多數決，裁判人數是雙數容易打平。
  // The skating system decides by majority, so an even panel invites ties.
  const evenPanels = await many(
    `SELECT d.name, COUNT(ja.id)::int AS n
     FROM divisions d
     JOIN rounds r ON r.division_id = d.id AND r.scoring_mode = 'rank' AND r.rank_method = 'skating'
     JOIN judge_assignments ja ON ja.division_id = d.id
     WHERE d.competition_id = $1
     GROUP BY d.id, d.name
     HAVING COUNT(ja.id) % 2 = 0 AND COUNT(ja.id) > 0`,
    [competitionId],
  );
  for (const row of evenPanels) {
    warnings.push({ key: 'judges.warnings.evenPanel', params: { division: row.name, count: row.n } });
  }

  // 連續評太多場沒有休息。
  // A judge with too many heats back to back and no break.
  const busy = await many(
    `SELECT j.name, COUNT(DISTINCT h.id)::int AS n
     FROM judges j
     JOIN judge_assignments ja ON ja.judge_id = j.id
     JOIN heat_entries he ON he.division_id = ja.division_id
     JOIN heats h ON h.id = he.heat_id AND h.status = 'pending'
     WHERE j.competition_id = $1
     GROUP BY j.id, j.name HAVING COUNT(DISTINCT h.id) > 20`,
    [competitionId],
  );
  for (const row of busy) {
    warnings.push({ key: 'judges.warnings.busyJudge', params: { judge: row.name, count: row.n } });
  }

  return warnings;
}

export default {
  JudgeError,
  generateLoginCode,
  addJudge,
  listJudges,
  judgeByLoginCode,
  assignToDivision,
  unassignFromDivision,
  replaceJudge,
  judgesForDivision,
  judgesForHeat,
  heatEntriesForJudge,
  assignmentWarnings,
};
