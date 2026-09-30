// 主辦後台的賽前準備與成績：舞科、輪次、背號、分批、併場、裁判、計算與公告。
// Organiser back office for preparation and results.

import express from 'express';
import * as comps from '../services/competitions.js';
import * as schedule from '../services/schedule.js';
import * as judgeService from '../services/judges.js';
import * as scoring from '../services/scoring.js';
import * as voucherService from '../services/voucher.js';
import * as xlsx from '../services/exportXlsx.js';
import { requireStaff } from '../middleware/auth.js';

const router = express.Router();

function backToSchedule(res, competitionId, error) {
  const suffix = error ? `?error=${encodeURIComponent(error)}` : '';
  return res.redirect(303, `/admin/c/${competitionId}/schedule${suffix}`);
}

// 檔名可能含中文，所以同時給一個純英數的備用名稱與 UTF-8 名稱。
// The name may hold non-ASCII, so give an ASCII fallback plus the UTF-8 one.
function attachment(slug, kind) {
  const ascii = String(slug).replace(/[^A-Za-z0-9_-]+/g, '') || 'stagerank';
  return `attachment; filename="${ascii}-${kind}.xlsx"; filename*=UTF-8''${encodeURIComponent(`${slug}-${kind}.xlsx`)}`;
}

// Excel 匯出：只有主辦能下載。
// Excel export, organiser only.
router.get('/c/:id/export/bibs.xlsx', requireStaff, async (req, res, next) => {
  try {
    const competition = await comps.getCompetition(Number.parseInt(req.params.id, 10));
    if (!competition) return res.status(404).renderPage('error', { title: res.locals.t('errors.notFound'), messageKey: 'errors.notFound' });
    const voucher = await voucherService.activeVoucher(competition.id);
    if (!voucher) return backToSchedule(res, competition.id, 'export.noVoucher');
    const buffer = await xlsx.bibsWorkbook({ voucherCode: voucher.code, t: res.locals.t });
    res.setHeader('Content-Type', xlsx.XLSX_TYPE);
    res.setHeader('Content-Disposition', attachment(competition.slug, 'bibs'));
    return res.send(buffer);
  } catch (err) {
    return next(err);
  }
});

router.get('/c/:id/export/lists.xlsx', requireStaff, async (req, res, next) => {
  try {
    const competition = await comps.getCompetition(Number.parseInt(req.params.id, 10));
    if (!competition) return res.status(404).renderPage('error', { title: res.locals.t('errors.notFound'), messageKey: 'errors.notFound' });
    const voucher = await voucherService.activeVoucher(competition.id);
    if (!voucher) return backToSchedule(res, competition.id, 'export.noVoucher');
    const buffer = await xlsx.listsWorkbook({ competitionId: competition.id, t: res.locals.t });
    res.setHeader('Content-Type', xlsx.XLSX_TYPE);
    res.setHeader('Content-Disposition', attachment(competition.slug, 'lists'));
    return res.send(buffer);
  } catch (err) {
    return next(err);
  }
});

router.get('/c/:id/export/order.xlsx', requireStaff, async (req, res, next) => {
  try {
    const competition = await comps.getCompetition(Number.parseInt(req.params.id, 10));
    if (!competition) return res.status(404).renderPage('error', { title: res.locals.t('errors.notFound'), messageKey: 'errors.notFound' });
    const buffer = await xlsx.orderWorkbook({ competitionId: competition.id, t: res.locals.t });
    res.setHeader('Content-Type', xlsx.XLSX_TYPE);
    res.setHeader('Content-Disposition', attachment(competition.slug, 'order'));
    return res.send(buffer);
  } catch (err) {
    return next(err);
  }
});

router.get('/c/:id/schedule', requireStaff, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.id, 10);
    const competition = await comps.getCompetition(competitionId);
    if (!competition) return res.status(404).renderPage('error', { title: res.locals.t('errors.notFound'), messageKey: 'errors.notFound' });

    const divisions = await comps.listDivisions(competitionId);
    const dances = await schedule.listDances(competitionId);
    const voucher = await voucherService.activeVoucher(competitionId);

    const detail = [];
    for (const division of divisions) {
      detail.push({
        division,
        dances: await schedule.dancesForDivision(division.id),
        rounds: await schedule.listRounds(division.id),
        judges: await judgeService.judgesForDivision(division.id),
      });
    }

    await res.renderPage('admin_schedule', {
      title: res.locals.t('schedule.title'),
      competition,
      voucher,
      dances,
      detail,
      judges: await judgeService.listJudges(competitionId),
      order: await schedule.runningOrder(competitionId),
      warnings: await judgeService.assignmentWarnings(competitionId),
      roster: voucher ? await schedule.rosterWithBibs(voucher.code) : [],
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/c/:id/dances', requireStaff, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.id, 10);
    const names = String(req.body.names || '')
      .split(/[,\n]/)
      .map((n) => n.trim())
      .filter(Boolean);
    for (const [index, name] of names.entries()) {
      await schedule.addDance({ competitionId, name, sortOrder: index });
    }
    backToSchedule(res, competitionId);
  } catch (err) {
    next(err);
  }
});

router.post('/c/:id/division/:divisionId/dances', requireStaff, async (req, res, next) => {
  try {
    const danceIds = [].concat(req.body.danceId || []).map((v) => Number.parseInt(v, 10));
    await schedule.setDivisionDances(Number.parseInt(req.params.divisionId, 10), danceIds);
    backToSchedule(res, Number.parseInt(req.params.id, 10));
  } catch (err) {
    next(err);
  }
});

router.post('/c/:id/division/:divisionId/round', requireStaff, async (req, res, next) => {
  try {
    const divisionId = Number.parseInt(req.params.divisionId, 10);
    // 順序沒填就接在最後一輪後面，這樣「準決賽、決賽」不用主辦自己排順序。
    // No order given: append after the last round, so semi-final then final need no manual ordering.
    const given = Number.parseInt(req.body.sortOrder, 10);
    const existing = await schedule.listRounds(divisionId);
    const sortOrder = Number.isFinite(given) ? given : Math.max(0, ...existing.map((r) => r.sort_order)) + (existing.length ? 1 : 0);
    await schedule.createRound({
      divisionId,
      name: req.body.name,
      sortOrder,
      scoringMode: req.body.scoringMode,
      advanceCount: req.body.advanceCount ? Number.parseInt(req.body.advanceCount, 10) : null,
      markQuotaMode: req.body.markQuotaMode,
      scoreMethod: req.body.scoreMethod,
      rankMethod: req.body.rankMethod,
      tiePolicy: req.body.tiePolicy,
      heatSize: Number.parseInt(req.body.heatSize || '10', 10),
      reshufflePerDance: req.body.reshufflePerDance === '1',
    });
    backToSchedule(res, Number.parseInt(req.params.id, 10));
  } catch (err) {
    next(err);
  }
});

router.post('/c/:id/bibs', requireStaff, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.id, 10);
    const voucher = await voucherService.activeVoucher(competitionId);
    if (!voucher) return backToSchedule(res, competitionId, 'admin.voucherNone');
    await schedule.assignBibs(voucher.code, {
      start: Number.parseInt(req.body.start || '1', 10) || 1,
      mode: req.body.mode === 'blocks' ? 'blocks' : 'sequential',
    });
    backToSchedule(res, competitionId);
  } catch (err) {
    next(err);
  }
});

// 帶入選手：第一輪從憑證碼的名單來，後面幾輪從晉級名單來。
// Load competitors: the first round from the voucher roster, later rounds from who advanced.
router.post('/c/:id/round/:roundId/seed', requireStaff, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.id, 10);
    const roundId = Number.parseInt(req.params.roundId, 10);
    if (req.body.fromRoundId) {
      await scoring.seedNextRound(Number.parseInt(req.body.fromRoundId, 10), roundId);
    } else {
      const voucher = await voucherService.activeVoucher(competitionId);
      if (!voucher) return backToSchedule(res, competitionId, 'admin.voucherNone');
      await schedule.seedFirstRound(voucher.code, roundId);
    }
    backToSchedule(res, competitionId);
  } catch (err) {
    if (err instanceof voucherService.VoucherError || err instanceof schedule.ScheduleError) {
      return backToSchedule(res, Number.parseInt(req.params.id, 10), err.key);
    }
    next(err);
  }
});

router.post('/c/:id/round/:roundId/heats', requireStaff, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.id, 10);
    const roundId = Number.parseInt(req.params.roundId, 10);
    const round = await schedule.getRound(roundId);
    const dances = await schedule.dancesForDivision(round.division_id);
    for (const dance of dances) await schedule.buildHeats(roundId, dance.id);
    await schedule.rebuildRunningOrder(competitionId);
    backToSchedule(res, competitionId);
  } catch (err) {
    if (err instanceof schedule.ScheduleError) return backToSchedule(res, Number.parseInt(req.params.id, 10), err.key);
    next(err);
  }
});

router.post('/c/:id/order/rebuild', requireStaff, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.id, 10);
    await schedule.rebuildRunningOrder(competitionId);
    backToSchedule(res, competitionId);
  } catch (err) {
    next(err);
  }
});

router.post('/c/:id/merge', requireStaff, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.id, 10);
    const heatIds = [].concat(req.body.heatId || []).map((v) => Number.parseInt(v, 10));
    await schedule.mergeHeats(heatIds);
    backToSchedule(res, competitionId);
  } catch (err) {
    if (err instanceof schedule.ScheduleError) return backToSchedule(res, Number.parseInt(req.params.id, 10), err.key);
    next(err);
  }
});

router.post('/c/:id/unmerge/:heatId', requireStaff, async (req, res, next) => {
  try {
    await schedule.unmergeHeat(Number.parseInt(req.params.heatId, 10));
    backToSchedule(res, Number.parseInt(req.params.id, 10));
  } catch (err) {
    if (err instanceof schedule.ScheduleError) return backToSchedule(res, Number.parseInt(req.params.id, 10), err.key);
    next(err);
  }
});

router.post('/c/:id/judges', requireStaff, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.id, 10);
    if (req.body.name) await judgeService.addJudge({ competitionId, name: req.body.name });
    backToSchedule(res, competitionId);
  } catch (err) {
    next(err);
  }
});

router.post('/c/:id/judges/:judgeId/assign', requireStaff, async (req, res, next) => {
  try {
    const divisionId = Number.parseInt(req.body.divisionId, 10);
    const judgeId = Number.parseInt(req.params.judgeId, 10);
    if (req.body.remove === '1') await judgeService.unassignFromDivision(judgeId, divisionId);
    else await judgeService.assignToDivision(judgeId, divisionId);
    backToSchedule(res, Number.parseInt(req.params.id, 10));
  } catch (err) {
    if (err instanceof judgeService.JudgeError) return backToSchedule(res, Number.parseInt(req.params.id, 10), err.key);
    next(err);
  }
});

// ---------------------------------------------------------------- 成績 / results

router.get('/c/:id/results', requireStaff, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.id, 10);
    const competition = await comps.getCompetition(competitionId);
    if (!competition) return res.status(404).renderPage('error', { title: res.locals.t('errors.notFound'), messageKey: 'errors.notFound' });

    const divisions = await comps.listDivisions(competitionId);
    const blocks = [];
    for (const division of divisions) {
      const rounds = await schedule.listRounds(division.id);
      const withResults = [];
      for (const round of rounds) {
        withResults.push({ round, results: await scoring.resultsFor(round.id) });
      }
      blocks.push({ division, rounds: withResults });
    }

    await res.renderPage('admin_results', {
      title: res.locals.t('results.title'),
      competition,
      blocks,
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/c/:id/round/:roundId/compute', requireStaff, async (req, res, next) => {
  try {
    await scoring.computeRound(Number.parseInt(req.params.roundId, 10));
    res.redirect(303, `/admin/c/${req.params.id}/results`);
  } catch (err) {
    if (err instanceof scoring.ScoringError) {
      return res.redirect(303, `/admin/c/${req.params.id}/results?error=${encodeURIComponent(err.key)}`);
    }
    next(err);
  }
});

router.post('/c/:id/round/:roundId/publish', requireStaff, async (req, res, next) => {
  try {
    if (req.body.undo === '1') await scoring.unpublishRound(Number.parseInt(req.params.roundId, 10));
    else await scoring.publishRound(Number.parseInt(req.params.roundId, 10));
    res.redirect(303, `/admin/c/${req.params.id}/results`);
  } catch (err) {
    next(err);
  }
});

export default router;
