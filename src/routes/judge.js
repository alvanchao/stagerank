// 裁判畫面。用登入碼進入，只看得到現在這一場、已檢錄、而且屬於他負責的組別的選手。
// The judge screen. A login code gets them in; they see only the current heat, checked in, in their divisions.

import express from 'express';
import { one, many } from '../db/index.js';
import * as judgeService from '../services/judges.js';
import * as floor from '../services/floor.js';
import * as scoring from '../services/scoring.js';
import * as schedule from '../services/schedule.js';
import { JUDGE_COOKIE, readCookie } from '../middleware/auth.js';

const router = express.Router();

async function currentJudge(req) {
  const code = readCookie(req.headers.cookie, JUDGE_COOKIE);
  if (!code) return null;
  return judgeService.judgeByLoginCode(code);
}

router.get('/judge', async (req, res, next) => {
  try {
    const judge = await currentJudge(req);
    if (!judge) return res.renderPage('judge_login', { title: res.locals.t('judges.title'), error: null });
    return res.redirect(303, `/judge/${judge.competition_id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/judge/login', async (req, res, next) => {
  try {
    const judge = await judgeService.judgeByLoginCode(req.body.code);
    if (!judge) {
      res.status(401);
      return res.renderPage('judge_login', { title: res.locals.t('judges.title'), error: 'judges.loginInvalid' });
    }
    res.setHeader(
      'Set-Cookie',
      `${JUDGE_COOKIE}=${encodeURIComponent(judge.login_code)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
    );
    return res.redirect(303, `/judge/${judge.competition_id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/judge/:competitionId', async (req, res, next) => {
  try {
    const judge = await currentJudge(req);
    if (!judge) return res.renderPage('judge_login', { title: res.locals.t('judges.title'), error: null });

    const competitionId = Number.parseInt(req.params.competitionId, 10);
    const competition = await one('SELECT * FROM competitions WHERE id = $1', [competitionId]);
    if (!competition) return res.status(404).renderPage('error', { messageKey: 'errors.notFound' });

    // 現在場上的那一場。
    // Whatever is on the floor right now.
    const currentHeat = await one(
      `SELECT h.*, da.name AS dance_name FROM heats h JOIN dances da ON da.id = h.dance_id
       WHERE h.competition_id = $1 AND h.status IN ('standby', 'scoring') ORDER BY h.sort_key LIMIT 1`,
      [competitionId],
    );

    let entries = [];
    let mine = false;
    let state = null;
    let quota = null;
    let rounds = [];

    if (currentHeat) {
      entries = await judgeService.heatEntriesForJudge(currentHeat.id, judge.id);
      mine = entries.length > 0
        || Boolean(await one(
          `SELECT 1 FROM heat_entries he JOIN judge_assignments ja ON ja.division_id = he.division_id
           WHERE he.heat_id = $1 AND ja.judge_id = $2 LIMIT 1`,
          [currentHeat.id, judge.id],
        ));
      state = await one('SELECT * FROM heat_judges WHERE heat_id = $1 AND judge_id = $2', [currentHeat.id, judge.id]);

      const roundIds = [...new Set(entries.map((e) => String(e.round_id)))];
      rounds = roundIds.length
        ? await many('SELECT * FROM rounds WHERE id = ANY($1::bigint[])', [roundIds])
        : [];

      const markRound = rounds.find((r) => r.scoring_mode === 'mark');
      if (markRound) {
        quota = await scoring.markQuota({
          round: markRound,
          danceId: currentHeat.dance_id,
          judgeId: judge.id,
          heatId: currentHeat.id,
        });
      }

      // 已經送出的內容要回填，裁判才看得到自己剛才填了什麼。
      // Anything already submitted is shown back so the judge can see what they entered.
      const existing = await many(
        'SELECT * FROM scores WHERE heat_id = $1 AND judge_id = $2',
        [currentHeat.id, judge.id],
      );
      const byEntry = new Map(existing.map((s) => [String(s.round_entry_id), s]));
      entries = entries.map((e) => ({ ...e, existing: byEntry.get(String(e.round_entry_id)) || null }));
    }

    const waiting = await floor.judgeWaitingInfo(competitionId, judge.id);

    await res.renderPage('judge', {
      title: judge.name,
      judge,
      competition,
      heat: currentHeat,
      entries,
      rounds,
      mine,
      state,
      quota,
      waiting,
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/judge/:competitionId/ready', async (req, res, next) => {
  try {
    const judge = await currentJudge(req);
    if (!judge) return res.redirect(303, '/judge');
    await floor.judgeReady(Number.parseInt(req.body.heatId, 10), judge.id);
    res.redirect(303, `/judge/${req.params.competitionId}`);
  } catch (err) {
    next(err);
  }
});

// 評分中離開畫面就作廢。瀏覽器偵測到畫面被藏起來時打這支。
// The browser calls this when the page is hidden while scoring, which voids the heat.
router.post('/judge/:competitionId/left', express.json(), async (req, res, next) => {
  try {
    const judge = await currentJudge(req);
    if (!judge) return res.status(401).json({ ok: false });
    const result = await floor.judgeLeftScreen(Number.parseInt(req.body.heatId, 10), judge.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post('/judge/:competitionId/submit', async (req, res, next) => {
  try {
    const judge = await currentJudge(req);
    if (!judge) return res.redirect(303, '/judge');

    const heatId = Number.parseInt(req.body.heatId, 10);
    const marks = [].concat(req.body.mark || []).filter(Boolean);
    const points = {};
    const ranks = {};
    for (const [key, value] of Object.entries(req.body)) {
      if (key.startsWith('points_')) points[key.slice(7)] = value;
      if (key.startsWith('rank_')) ranks[key.slice(5)] = value;
    }

    await scoring.submitScores(heatId, judge.id, { marks, points, ranks });
    res.redirect(303, `/judge/${req.params.competitionId}`);
  } catch (err) {
    if (err instanceof scoring.ScoringError) {
      const query = new URLSearchParams({ error: err.key, ...(err.params || {}) }).toString();
      return res.redirect(303, `/judge/${req.params.competitionId}?${query}`);
    }
    next(err);
  }
});

router.post('/judge/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${JUDGE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.redirect(303, '/judge');
});

export default router;
