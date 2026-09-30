// 報到、檢錄、主持人控場。各角色用自己的專屬碼登入，主辦通行碼可以進所有畫面。
// Registration desk, check-in and floor control. Each role signs in with a personal code; the
// organiser passcode opens all of them.

import express from 'express';
import config from '../config.js';
import * as comps from '../services/competitions.js';
import * as schedule from '../services/schedule.js';
import * as floor from '../services/floor.js';
import * as scoring from '../services/scoring.js';
import * as judgeService from '../services/judges.js';
import * as roundDecisions from '../services/roundDecisions.js';
import { sseHandler } from '../services/realtime.js';
import { clearSessions } from '../middleware/identity.js';
import { requireRole, readCookie, STAFF_SESSION_COOKIE } from '../middleware/auth.js';
import * as staffCodes from '../services/staffCodes.js';

const asHost = requireRole('host');
const asCheckin = requireRole('checkin');
// 報到：報到人員負責；點錄與主持人可以補救漏掉的報到。
// Registration desk: run by the desk staff; check-in and the host may rescue a missed report-in.
const asDesk = requireRole('desk', 'checkin', 'host');
const asFloor = requireRole('checkin', 'host'); // 補點重新分批：點錄與主持人都可

const router = express.Router();

// 即時同步：所有角色的畫面都掛在這條連線上。
// The live feed every staff and judge screen listens to.
// 工作人員 App：掃 QR 或輸入自己的專屬碼登入。碼只能用一次。
// The staff app: sign in by scanning a QR or typing your personal code. A code works once.
const HOME = { desk: 'desk', checkin: 'checkin', host: 'host' };
const homeFor = (member) => `/${HOME[member.role]}/${member.competition_id}`;

function renderStaffApp(res, { code = '', error = null, status = 200 } = {}) {
  res.status(status);
  return res.renderPage('staff_app', { title: res.locals.t('staffApp.title'), code, error });
}

router.get('/staff/app', async (req, res, next) => {
  try {
    const member = await staffCodes.fromCookie(readCookie(req.headers.cookie, STAFF_SESSION_COOKIE));
    if (member) return res.redirect(303, homeFor(member));
    return renderStaffApp(res, { code: staffCodes.extractCode(req.query.code || '') });
  } catch (err) {
    return next(err);
  }
});

router.post('/staff/login', async (req, res, next) => {
  const code = staffCodes.extractCode(req.body.code);
  try {
    const { member, cookieValue } = await staffCodes.redeem(code, { standalone: req.body.standalone === '1' });
    res.append(
      'Set-Cookie',
      `${STAFF_SESSION_COOKIE}=${encodeURIComponent(cookieValue)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${staffCodes.SESSION_MAX_AGE_SECONDS}`,
    );
    clearSessions(res, 'staff');
    return res.redirect(303, homeFor(member));
  } catch (err) {
    if (err instanceof staffCodes.StaffError) // 只是還沒安裝成 App 時碼沒被用掉，保留在輸入欄，安裝後不用重打。
    // A refusal for "install first" leaves the code unused, so keep it in the field.
    return renderStaffApp(res, { code: err.key === 'staffApp.errors.installFirst' ? code : '', error: err.key, status: 400 });
    return next(err);
  }
});

router.post('/staff/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${STAFF_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res.redirect(303, '/staff/app');
});

router.get('/events/:competitionId', (req, res) => {
  sseHandler(req, res, Number.parseInt(req.params.competitionId, 10));
});

// 短網址。比賽當天工作人員會直接打 /host、/desk、/checkin，
// 只有一場比賽時直接進去，有好幾場就讓他選。
// Short URLs. On the day staff simply type /host, /desk or /checkin. With one competition we go
// straight in; with several, they pick.
function shortcut(kind) {
  return async (req, res, next) => {
    try {
      const all = await comps.listCompetitions();
      const live = all.filter((c) => c.status !== 'draft');
      if (live.length === 1) return res.redirect(303, `/${kind}/${live[0].id}`);
      return res.renderPage('pick_competition', {
        title: res.locals.t(`staff.${kind}`),
        kind,
        competitions: live,
      });
    } catch (err) {
      return next(err);
    }
  };
}

router.get('/desk', shortcut('desk'));
router.get('/checkin', shortcut('checkin'));
router.get('/host', shortcut('host'));

// ---------------------------------------------------------------- 報到 / registration desk

router.get('/desk/:competitionId', asDesk, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.competitionId, 10);
    const competition = await comps.getCompetition(competitionId);
    if (!competition) return res.status(404).renderPage('error', { title: res.locals.t('errors.notFound'), messageKey: 'errors.notFound' });

    const voucher = await (await import('../services/voucher.js')).activeVoucher(competitionId);
    const roster = voucher ? await schedule.rosterWithBibs(voucher.code) : [];
    const search = String(req.query.q || '').trim();
    const filtered = search
      ? roster.filter(
          (r) =>
            String(r.bib_number || '').includes(search) ||
            r.athlete_name.includes(search) ||
            (r.unit_name || '').includes(search),
        )
      : roster;

    await res.renderPage('desk', {
      title: res.locals.t('floor.reportTitle'),
      competition,
      voucher,
      roster: filtered,
      search,
      total: roster.length,
      reported: roster.filter((r) => r.reported_at).length,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/desk/:competitionId/report/:registrationId', asDesk, async (req, res, next) => {
  try {
    if (req.body.undo === '1') await floor.undoReportIn(Number.parseInt(req.params.registrationId, 10));
    else await floor.reportIn(Number.parseInt(req.params.registrationId, 10), { by: 'desk' });
    res.redirect(303, `/desk/${req.params.competitionId}${req.body.q ? `?q=${encodeURIComponent(req.body.q)}` : ''}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- 檢錄 / check-in

router.get('/checkin/:competitionId', asCheckin, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.competitionId, 10);
    const board = await floor.checkInBoard(competitionId);
    await res.renderPage('checkin', { title: res.locals.t('floor.checkinTitle'), ...board });
  } catch (err) {
    next(err);
  }
});

router.post('/checkin/:competitionId/entry/:heatEntryId', asCheckin, async (req, res, next) => {
  try {
    if (req.body.undo === '1') await floor.undoCheckIn(Number.parseInt(req.params.heatEntryId, 10));
    else await floor.checkIn(Number.parseInt(req.params.heatEntryId, 10), { by: req.body.by || 'checkin' });
    res.redirect(303, `/checkin/${req.params.competitionId}`);
  } catch (err) {
    if (err instanceof floor.FloorError) {
      const board = await floor.checkInBoard(Number.parseInt(req.params.competitionId, 10));
      res.status(400);
      return res.renderPage('checkin', { title: res.locals.t('floor.checkinTitle'), ...board, error: err.key });
    }
    next(err);
  }
});

// 有人缺席後，重新平均分批。
// Re-split the heats evenly after somebody drops out.
router.post('/checkin/:competitionId/resplit/:roundId/:danceId', asFloor, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.competitionId, 10);
    const competition = await comps.getCompetition(competitionId);
    if (!competition.checkin_can_resplit && !['host', 'admin'].includes(req.staffRole)) {
      return res.redirect(303, `/checkin/${competitionId}`);
    }
    await schedule.buildHeats(Number.parseInt(req.params.roundId, 10), Number.parseInt(req.params.danceId, 10));
    await schedule.rebuildRunningOrder(competitionId);
    res.redirect(303, `/checkin/${competitionId}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- 主持人 / floor control

// 輪次處置：照舊、免賽晉級、直接決賽。只有主持人能按。
// The round decision: run it, free pass, or straight to the final. The host alone has these.
async function decide(req, res, next, action) {
  const competitionId = Number.parseInt(req.params.competitionId, 10);
  const roundId = Number.parseInt(req.params.roundId, 10);
  try {
    if (action === 'advance_count') {
      await roundDecisions.setAdvanceCount(roundId, req.body.advanceCount, { decidedBy: 'host' });
    } else if (action === 'free_pass') {
      await roundDecisions.freePass(roundId, { decidedBy: 'host' });
    } else {
      await roundDecisions.skipToFinal(roundId, { decidedBy: 'host' });
    }
    return res.redirect(303, `/host/${competitionId}`);
  } catch (err) {
    if (err instanceof roundDecisions.RoundDecisionError) {
      return res.redirect(303, `/host/${competitionId}?error=${encodeURIComponent(err.key)}`);
    }
    return next(err);
  }
}

router.post('/host/:competitionId/round/:roundId/advance-count', asHost, (req, res, next) =>
  decide(req, res, next, 'advance_count'));
router.post('/host/:competitionId/round/:roundId/free-pass', asHost, (req, res, next) =>
  decide(req, res, next, 'free_pass'));
router.post('/host/:competitionId/round/:roundId/skip-to-final', asHost, (req, res, next) =>
  decide(req, res, next, 'skipped'));


router.get('/host/:competitionId', asHost, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.competitionId, 10);
    const board = await floor.hostBoard(competitionId);
    const order = await schedule.runningOrder(competitionId);
    const pending = order.filter((h) => h.status === 'pending');

    // 只問「現在這一場」所屬的那一輪。比賽當天畫面上只該有一個決定要按，
    // 不然主持人得先滑過一疊卡片才看得到場上的人。併場時最多兩輪。
    // Only the round the current heat belongs to. On the day there must be a single
    // decision on screen, or the host scrolls past a stack of cards to reach the floor.
    // A merged heat can legitimately carry two rounds.
    const currentId = board.current?.heat?.id;
    const decisionHeat = (currentId ? order.find((h) => String(h.id) === String(currentId)) : null)
      || pending[0] || null;
    const seen = new Set();
    const upcoming = [];
    for (const roundId of decisionHeat ? (decisionHeat.round_ids || [decisionHeat.round_id]) : []) {
      if (!roundId || seen.has(String(roundId))) continue;
      seen.add(String(roundId));
      try {
        const info = await roundDecisions.advice(roundId);
        if (info.round.outcome === 'normal' && info.round.status !== 'closed') upcoming.push(info);
      } catch {
        // 讀不到就跳過，控場畫面不能因為這個壞掉。
        // If it cannot be read we skip it; the floor board must never break over this.
      }
    }

    await res.renderPage('host', {
      title: res.locals.t('floor.title'),
      ...board,
      order: pending.slice(0, 10),
      upcomingRounds: upcoming,
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/host/:competitionId/next', asHost, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.competitionId, 10);
    await floor.nextHeat(competitionId, { heatId: req.body.heatId ? Number.parseInt(req.body.heatId, 10) : null });
    res.redirect(303, `/host/${competitionId}`);
  } catch (err) {
    next(err);
  }
});

router.post('/host/:competitionId/start', asHost, async (req, res, next) => {
  try {
    await floor.startHeat(Number.parseInt(req.body.heatId, 10));
    res.redirect(303, `/host/${req.params.competitionId}`);
  } catch (err) {
    next(err);
  }
});

// 音樂放了才衝進場：主持人點一下就能幫他補上檢錄。
// The late arrival: one tap from the host puts them in front of the judges.
router.post('/host/:competitionId/add/:heatEntryId', asHost, async (req, res, next) => {
  try {
    await floor.checkIn(Number.parseInt(req.params.heatEntryId, 10), { by: 'host' });
    res.redirect(303, `/host/${req.params.competitionId}`);
  } catch (err) {
    if (err instanceof floor.FloorError) {
      return res.redirect(303, `/host/${req.params.competitionId}?error=${encodeURIComponent(err.key)}`);
    }
    next(err);
  }
});

router.post('/host/:competitionId/absent/:roundEntryId', asHost, async (req, res, next) => {
  try {
    if (req.body.undo === '1') await floor.undoAbsent(Number.parseInt(req.params.roundEntryId, 10));
    else await floor.markAbsent(Number.parseInt(req.params.roundEntryId, 10));
    res.redirect(303, `/host/${req.params.competitionId}`);
  } catch (err) {
    next(err);
  }
});

// 臨時調整順序：只能動還沒上場的。
// Re-ordering on the day; only pending heats may move.
router.post('/host/:competitionId/move/:heatId', asHost, async (req, res, next) => {
  try {
    const target = req.body.beforeHeatId
      ? { beforeHeatId: Number.parseInt(req.body.beforeHeatId, 10) }
      : { afterHeatId: Number.parseInt(req.body.afterHeatId, 10) };
    await schedule.moveHeat(Number.parseInt(req.params.heatId, 10), target);
    res.redirect(303, `/host/${req.params.competitionId}`);
  } catch (err) {
    if (err instanceof schedule.ScheduleError) {
      return res.redirect(303, `/host/${req.params.competitionId}?error=${encodeURIComponent(err.key)}`);
    }
    next(err);
  }
});

export default router;
