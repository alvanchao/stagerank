import express from 'express';
import * as comps from '../services/competitions.js';
import * as regs from '../services/registrations.js';
import * as roster from '../services/athletes.js';
import * as feeGroups from '../services/feeGroups.js';
import * as payments from '../payments/index.js';
import * as onlinePay from '../services/onlinePay.js';
import { adminFromCookie } from '../middleware/auth.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const competitions = await comps.listCompetitions();
    const visible = competitions.filter((c) => c.status !== 'draft');
    // 登入的報名人在首頁看到自己的報名；比賽列表還是公開的，只有名稱、狀態、報名費。
    // A signed-in entrant sees their own entries on the home page; the competition list stays
    // public and shows only name, status and fee.
    const entries = req.entrant ? await regs.listForEntrant(req.entrant.id) : [];
    await res.renderPage('home', { title: res.locals.t('home.title'), competitions: visible, entries });
  } catch (err) {
    next(err);
  }
});

async function renderCompetition(req, res, { error = null, errorParams = null, form = {} } = {}) {
  const competition = await comps.getCompetitionBySlug(req.params.slug);
  if (!competition) {
    res.status(404);
    return res.renderPage('error', { title: res.locals.t('errors.notFound'), messageKey: 'errors.notFound' });
  }

  const divisions = await comps.listDivisions(competition.id);
  const providers = payments.availableProviders();
  const mine = req.entrant ? await roster.listRoster(req.entrant.id) : [];
  const groups = await feeGroups.listGroups(competition.id);
  // 每位選手在每一群已經報了幾項，畫面靠它算出「這是第幾項」。
  // How many items each competitor already has in each group; the screen prices from this.
  const taken = req.entrant
    ? await feeGroups.takenCounts({ competitionId: competition.id, athleteIds: mine.map((a) => a.id) })
    : {};

  // 兩種年齡都先算好交給畫面：主辦選哪一種，畫面就用哪一種。
  // Both ages are worked out up front; the screen uses whichever basis the organiser chose.
  const reference = roster.referenceDateFor(competition);
  res.locals.ageYearEnd = (a) => roster.ageOf(a.birth_date, { basis: 'year_end', referenceDate: reference });
  res.locals.ageEventDay = (a) => roster.ageOf(a.birth_date, { basis: 'event_day', referenceDate: reference });
  // 只有真的要收錢時才需要選付款方式。收費方案也算錢——漏掉這個，
  // 用階梯計價的比賽會整場變成「免費」，而且沒有付款方式可選。
  // A payment method is only needed when there is actually something to pay. Fee plans count as
  // money too: without them a tiered competition would show as free and offer no way to pay.
  const chargesViaPlan = groups.some(
    (g) => Number(g.base_fee_cents) > 0 || Number(g.extra_item_fee_cents) > 0,
  );
  const needsPayment = competition.fee_cents > 0
    || divisions.some((d) => d.fee_cents > 0)
    || chargesViaPlan;

  return res.renderPage('competition', {
    title: competition.name,
    competition,
    divisions,
    providers,
    roster: mine,
    feeGroups: groups,
    takenCounts: taken,
    needsPayment,
    anySandbox: providers.some((p) => payments.settingsFor(p)?.sandbox !== false),
    error,
    errorParams,
    form,
  });
}

router.get('/c/:slug', (req, res, next) => {
  renderCompetition(req, res).catch(next);
});

router.post('/c/:slug/register', async (req, res, next) => {
  try {
    const competition = await comps.getCompetitionBySlug(req.params.slug);
    if (!competition) {
      res.status(404);
      return res.renderPage('error', { title: res.locals.t('errors.notFound'), messageKey: 'errors.notFound' });
    }

    const form = {
      unitName: req.body.unitName,
      divisionId: req.body.divisionId,
      provider: req.body.provider,
    };
    const divisionId = form.divisionId ? Number.parseInt(form.divisionId, 10) : null;

    // 名冊勾選：一個或多個 athleteIds。勾一個時 Express 給字串，勾多個才給陣列。
    // Ticked off the roster: one or many athleteIds. Express hands over a string for one tick
    // and an array for several.
    const picked = req.body.athleteIds;
    const athleteIds = picked === undefined ? [] : (Array.isArray(picked) ? picked : [picked]);

    const result = await regs.register({
      competitionId: competition.id,
      divisionId,
      athleteIds,
      entrantId: req.entrant?.id || null,
      unitName: form.unitName,
      provider: form.provider,
    });

    if (result.free) return res.redirect(303, `/r/${result.registration.id}`);

    // 表單型金流（綠界、藍新）直接送使用者過去；API 型的在 pay 路由處理。
    // Form-post providers (ECPay, NewebPay) send the user straight on; API providers go via /pay.
    if (result.checkout.kind === 'form') {
      return res.renderPage('redirect', {
        title: res.locals.t('payment.redirecting'),
        checkout: result.checkout,
        provider: form.provider,
        sandbox: payments.settingsFor(form.provider)?.sandbox !== false,
      });
    }

    // API 型金流（PayPal、Stripe）：先向對方建立訂單，再把使用者送過去。
    // API-style providers: create the order with them first, then send the payer over.
    try {
      const redirectUrl = await onlinePay.startApi({ provider: form.provider, checkout: result.checkout });
      return res.redirect(303, redirectUrl);
    } catch (err) {
      if (err instanceof onlinePay.PaymentStartError) {
        res.status(502);
        return res.renderPage('error', { title: res.locals.t('errors.paymentStart'), messageKey: 'errors.paymentStart' });
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof regs.RegistrationError) {
      res.status(400);
      return renderCompetition(req, res, {
        error: err.key,
        errorParams: err.params || null,
        form: req.body,
      }).catch(next);
    }
    return next(err);
  }
});

// 報名結果頁含選手姓名與金額，所以不能靠流水號被人猜到：只有主辦，或這筆報名的所有人
// （登入的報名人）看得到。其他人一律回一般的 404，不是 403，這樣連「這個編號存在」都確認不了。
// The registration page carries a competitor's name and amount, so a sequential id must not be
// enough. Only the organiser, or the signed-in entrant who owns the entry, can see it. Everyone
// else gets the ordinary 404 (not 403), so not even the existence of an id can be confirmed.
router.get('/r/:id', async (req, res, next) => {
  try {
    const notFound = () => {
      res.status(404);
      return res.renderPage('error', { title: res.locals.t('errors.notFound'), messageKey: 'errors.notFound' });
    };
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return notFound();
    const registration = await regs.getRegistration(id);
    if (!registration) return notFound();

    const isOrganiser = Boolean(adminFromCookie(req.headers.cookie));
    const isOwner = Boolean(req.entrant && registration.entrant_id
      && String(registration.entrant_id) === String(req.entrant.id));
    if (!isOrganiser && !isOwner) return notFound();

    const division = await comps.getDivision(registration.division_id);
    return res.renderPage('registration', {
      title: res.locals.t('register.success'),
      registration,
      divisionName: division?.name || '',
    });
  } catch (err) {
    next(err);
  }
});

// 健康檢查：Docker 與部署平台會打這支。
// Health check for Docker and hosting platforms.
router.get('/healthz', (req, res) => {
  res.json({ ok: true, app: 'StageRank', version: '0.1.0' });
});

export default router;
