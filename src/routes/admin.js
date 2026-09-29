import express from 'express';
import config from '../config.js';
import * as comps from '../services/competitions.js';
import * as regs from '../services/registrations.js';
import * as voucherService from '../services/voucher.js';
import * as stats from '../services/stats.js';
import * as entrants from '../services/entrants.js';
import * as feeGroups from '../services/feeGroups.js';
import * as setup from '../services/setup.js';
import { providerStatus } from '../payments/index.js';
import { requireStaff as requireAdmin, safeEqual, STAFF_COOKIE as COOKIE } from '../middleware/auth.js';

const router = express.Router();

// 通行碼的檢查集中在 middleware/auth.js，主辦、主持人、檢錄、報到共用同一組。
// The passcode check lives in middleware/auth.js and is shared by every staff screen.
router.post('/login', (req, res) => {
  if (!config.adminToken) {
    return res.renderPage('admin_login', { title: res.locals.t('admin.title'), hasToken: false, error: null });
  }
  if (!safeEqual(req.body.token || '', config.adminToken)) {
    res.status(401);
    return res.renderPage('admin_login', {
      title: res.locals.t('admin.title'),
      hasToken: true,
      error: 'admin.tokenInvalid',
    });
  }
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(config.adminToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`,
  );
  return res.redirect(303, '/admin');
});

// 建立比賽。主辦裝好程式之後的第一步，以前只能靠程式建。
// Create a competition: the organiser's first step, which until now needed code.
router.post('/new', requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.redirect(303, '/admin?error=errors.badRequest');

    const competition = await comps.createCompetition({
      name,
      currency: String(req.body.currency || '').trim() || undefined,
      feeCents: Number.parseInt(req.body.feeCents, 10) || 0,
      status: req.body.status === 'open' ? 'open' : 'draft',
    });
    return res.redirect(303, `/admin/c/${competition.id}`);
  } catch (err) {
    return next(err);
  }
});

// 開放或關閉報名。
// Open or close registration.
router.post('/c/:id/status', requireAdmin, async (req, res, next) => {
  try {
    const wanted = ['draft', 'open', 'closed'].includes(req.body.status) ? req.body.status : 'draft';
    await comps.setStatus(Number.parseInt(req.params.id, 10), wanted);
    return res.redirect(303, `/admin/c/${req.params.id}`);
  } catch (err) {
    return next(err);
  }
});

// 年齡怎麼算：各國規則不同，所以讓主辦自己選，程式不預設立場。
// How age is counted differs by country, so the organiser chooses and the code takes no side.
router.post('/c/:id/age-rule', requireAdmin, async (req, res, next) => {
  try {
    await comps.setAgeRule(Number.parseInt(req.params.id, 10), {
      ageBasis: req.body.ageBasis,
      eventDate: req.body.eventDate,
    });
    return res.redirect(303, `/admin/c/${req.params.id}`);
  } catch (err) {
    return next(err);
  }
});

// 報名人忘記密碼：主辦產生一組臨時密碼，當面或用電話給對方。
// A forgotten password: the organiser issues a temporary one to hand over in person.
router.post('/entrants/:id/reset-password', requireAdmin, async (req, res, next) => {
  try {
    const { temporaryPassword } = await entrants.resetPassword(Number.parseInt(req.params.id, 10));
    return res.redirect(303, `/admin/entrants?password=${encodeURIComponent(temporaryPassword)}&id=${req.params.id}`);
  } catch (err) {
    return next(err);
  }
});

router.get('/entrants', requireAdmin, async (req, res, next) => {
  try {
    return await res.renderPage('admin_entrants', {
      title: res.locals.t('admin.entrants'),
      entrants: await entrants.listEntrants(),
      shownPassword: req.query.password || null,
      shownFor: req.query.id || null,
    });
  } catch (err) {
    return next(err);
  }
});

// 建立項目：跟以前一樣就整套複製，第一次辦就套範本。
// Building the divisions: copy an event that has run before, or start from a template.
async function renderSetup(req, res, { error = null, errorParams = null, message = null, messageParams = null } = {}) {
  const competitionId = Number.parseInt(req.params.id, 10);
  const competition = await comps.getCompetition(competitionId);
  if (!competition) {
    res.status(404);
    return res.renderPage('error', { title: res.locals.t('errors.notFound'), messageKey: 'errors.notFound' });
  }
  const divisions = await comps.listDivisions(competitionId);
  return res.renderPage('admin_setup', {
    title: res.locals.t('setup.title'),
    competition,
    divisions,
    feeGroups: await feeGroups.listGroups(competitionId),
    sources: await setup.copyableCompetitions(competitionId),
    plan: setup.planFor({ templateKey: 'ballroom', t: res.locals.t }),
    canClear: await setup.canClear(competitionId),
    error,
    errorParams,
    message,
    messageParams,
  });
}

function setupError(err, req, res, next) {
  if (err instanceof setup.SetupError) {
    res.status(400);
    return renderSetup(req, res, { error: err.key, errorParams: err.params }).catch(next);
  }
  return next(err);
}

router.get('/c/:id/setup', requireAdmin, (req, res, next) => {
  renderSetup(req, res, {
    message: req.query.done ? `setup.${req.query.done}` : null,
    messageParams: req.query.count ? { count: req.query.count } : null,
  }).catch(next);
});

router.post('/c/:id/setup/copy', requireAdmin, async (req, res, next) => {
  try {
    const result = await setup.copyFrom(
      Number.parseInt(req.body.sourceId, 10),
      Number.parseInt(req.params.id, 10),
    );
    return res.redirect(303, `/admin/c/${req.params.id}/setup?done=copied&count=${result.divisions}`);
  } catch (err) {
    return setupError(err, req, res, next);
  }
});

router.post('/c/:id/setup/template', requireAdmin, async (req, res, next) => {
  try {
    const picked = req.body.keys;
    const keys = picked === undefined ? [] : (Array.isArray(picked) ? picked : [picked]);
    const result = await setup.applyTemplate({
      competitionId: Number.parseInt(req.params.id, 10),
      templateKey: req.body.templateKey || 'ballroom',
      keys,
      t: res.locals.t,
      generalPlan: {
        baseFeeCents: Number.parseInt(req.body.generalBase, 10) || 0,
        baseIncludes: Number.parseInt(req.body.generalIncludes, 10) || 1,
        extraItemFeeCents: Number.parseInt(req.body.generalExtra, 10) || 0,
      },
      proAmPlan: {
        baseFeeCents: Number.parseInt(req.body.proAmBase, 10) || 0,
        baseIncludes: Number.parseInt(req.body.proAmIncludes, 10) || 1,
        extraItemFeeCents: Number.parseInt(req.body.proAmExtra, 10) || 0,
      },
    });
    return res.redirect(303, `/admin/c/${req.params.id}/setup?done=applied&count=${result.created}`);
  } catch (err) {
    return setupError(err, req, res, next);
  }
});

router.post('/c/:id/setup/clear', requireAdmin, async (req, res, next) => {
  try {
    const result = await setup.clearSetup(Number.parseInt(req.params.id, 10));
    return res.redirect(303, `/admin/c/${req.params.id}/setup?done=cleared&count=${result.removed}`);
  } catch (err) {
    return setupError(err, req, res, next);
  }
});

// 計價群組：基本盤含幾項、之後每項多少。師生組自己一群，項數分開數。
// A fee group: a base covering N items, then a price per extra. Pro-am gets its own group so
// its items are counted separately.
router.post('/c/:id/fee-groups', requireAdmin, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.id, 10);
    const name = String(req.body.name || '').trim();
    if (!name) return res.redirect(303, `/admin/c/${competitionId}?error=errors.badRequest`);
    const existing = await feeGroups.listGroups(competitionId);
    await feeGroups.createGroup({
      competitionId,
      name,
      baseFeeCents: req.body.baseFeeCents,
      baseIncludes: req.body.baseIncludes,
      extraItemFeeCents: req.body.extraItemFeeCents,
      sortOrder: existing.length + 1,
    });
    return res.redirect(303, `/admin/c/${competitionId}`);
  } catch (err) {
    return next(err);
  }
});

router.post('/c/:id/fee-groups/:groupId', requireAdmin, async (req, res, next) => {
  try {
    await feeGroups.updateGroup(Number.parseInt(req.params.groupId, 10), {
      name: String(req.body.name || '').trim() || null,
      baseFeeCents: req.body.baseFeeCents,
      baseIncludes: req.body.baseIncludes,
      extraItemFeeCents: req.body.extraItemFeeCents,
    });
    return res.redirect(303, `/admin/c/${req.params.id}`);
  } catch (err) {
    return next(err);
  }
});

router.post('/c/:id/fee-groups/:groupId/delete', requireAdmin, async (req, res, next) => {
  try {
    const result = await feeGroups.deleteGroup(Number.parseInt(req.params.groupId, 10));
    const suffix = result.deleted ? '' : '?error=admin.feeGroupInUse';
    return res.redirect(303, `/admin/c/${req.params.id}${suffix}`);
  } catch (err) {
    return next(err);
  }
});

// 建立組別。人數上下限決定這一組是單人、雙人還是多人。
// Create a division. The member range is what makes it a solo, a couple or a team.
router.post('/c/:id/divisions', requireAdmin, async (req, res, next) => {
  try {
    const competitionId = Number.parseInt(req.params.id, 10);
    const name = String(req.body.name || '').trim();
    if (!name) return res.redirect(303, `/admin/c/${competitionId}?error=errors.badRequest`);

    const existing = await comps.listDivisions(competitionId);
    const rawFee = String(req.body.feeCents ?? '').trim();

    await comps.addDivision({
      competitionId,
      name,
      // 空白＝沿用比賽的預設費用 / blank means "use the competition fee"
      feeCents: rawFee === '' ? null : Number.parseInt(rawFee, 10) || 0,
      sortOrder: existing.length + 1,
      memberMin: req.body.memberMin,
      memberMax: req.body.memberMax,
      feeMode: req.body.feeMode,
      extraDivisionFeeCents: req.body.extraDivisionFeeCents,
      ageMin: req.body.ageMin,
      ageMax: req.body.ageMax,
      feeGroupId: req.body.feeGroupId,
    });
    return res.redirect(303, `/admin/c/${competitionId}`);
  } catch (err) {
    if (err.code === '23505') return res.redirect(303, `/admin/c/${req.params.id}?error=admin.divisionExists`);
    return next(err);
  }
});

router.post('/c/:id/divisions/:divisionId', requireAdmin, async (req, res, next) => {
  try {
    await comps.updateDivision(Number.parseInt(req.params.divisionId, 10), {
      name: String(req.body.name || '').trim() || null,
      feeCents: String(req.body.feeCents ?? '').trim() === '' ? null : Number.parseInt(req.body.feeCents, 10) || 0,
      memberMin: req.body.memberMin,
      memberMax: req.body.memberMax,
      feeMode: req.body.feeMode,
      extraDivisionFeeCents: req.body.extraDivisionFeeCents,
      ageMin: req.body.ageMin,
      ageMax: req.body.ageMax,
      feeGroupId: req.body.feeGroupId,
    });
    return res.redirect(303, `/admin/c/${req.params.id}`);
  } catch (err) {
    return next(err);
  }
});

router.post('/c/:id/divisions/:divisionId/delete', requireAdmin, async (req, res, next) => {
  try {
    const result = await comps.deleteDivision(Number.parseInt(req.params.divisionId, 10));
    const suffix = result.deleted ? '' : '?error=admin.divisionInUse';
    return res.redirect(303, `/admin/c/${req.params.id}${suffix}`);
  } catch (err) {
    return next(err);
  }
});

router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const list = await comps.listCompetitions();
    const competitions = [];
    for (const competition of list) {
      competitions.push({ ...competition, counts: await comps.countsFor(competition.id) });
    }
    await res.renderPage('admin_index', {
      title: res.locals.t('admin.title'),
      competitions,
      providers: providerStatus(),
    });
  } catch (err) {
    next(err);
  }
});

async function renderAdminCompetition(req, res, extra = {}) {
  const competition = await comps.getCompetition(Number.parseInt(req.params.id, 10));
  if (!competition) {
    res.status(404);
    return res.renderPage('error', { title: res.locals.t('errors.notFound'), messageKey: 'errors.notFound' });
  }
  return res.renderPage('admin_competition', {
    title: competition.name,
    competition,
    counts: await comps.countsFor(competition.id),
    divisions: await comps.listDivisions(competition.id),
    feeGroups: await feeGroups.listGroups(competition.id),
    registrations: await regs.listRegistrations(competition.id),
    voucher: await voucherService.activeVoucher(competition.id),
    message: null,
    error: req.query.error || null,
    ...extra,
  });
}

router.get('/c/:id', requireAdmin, (req, res, next) => {
  renderAdminCompetition(req, res).catch(next);
});

// 結束報名並產生憑證碼；重新結算走同一段程式。
// Close registration and issue the voucher; re-settling uses the same code path.
async function settleHandler(req, res, next, { resettle }) {
  try {
    const competitionId = Number.parseInt(req.params.id, 10);
    const { voucher, byProvider } = await voucherService.settle(competitionId, { resettle });
    const competition = await comps.getCompetition(competitionId);

    // 統計回報排進佇列，送不出去完全不影響比賽。
    // The usage report is queued; a failure to send never affects the competition.
    try {
      await stats.queueReport(stats.buildPayload({ competition, byProvider, voucher }));
    } catch (err) {
      console.warn('[stats] could not queue report:', err.message);
    }

    return renderAdminCompetition(req, res, { message: 'admin.settled' }).catch(next);
  } catch (err) {
    if (err instanceof voucherService.VoucherError) {
      res.status(400);
      return renderAdminCompetition(req, res, { error: err.key }).catch(next);
    }
    return next(err);
  }
}

router.post('/c/:id/settle', requireAdmin, (req, res, next) => settleHandler(req, res, next, { resettle: false }));
router.post('/c/:id/resettle', requireAdmin, (req, res, next) => settleHandler(req, res, next, { resettle: true }));

router.post('/r/:id/mark-paid', requireAdmin, async (req, res, next) => {
  try {
    await regs.markPaidManually(Number.parseInt(req.params.id, 10));
    return res.redirect(303, `/admin/c/${Number.parseInt(req.body.competitionId, 10)}`);
  } catch (err) {
    next(err);
  }
});

export default router;
