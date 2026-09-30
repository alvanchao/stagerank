// 報名人自己的畫面：註冊、登入、名冊、報名紀錄。
// The entrant's own screens: sign up, sign in, the roster, and what they have entered.
import { clearSessions } from '../middleware/identity.js';
import express from 'express';
import * as entrants from '../services/entrants.js';
import * as roster from '../services/athletes.js';
import * as regs from '../services/registrations.js';
import * as loginLinks from '../services/loginLinks.js';
import config from '../config.js';
import { requireEntrant } from '../middleware/auth.js';

const router = express.Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 1000 * 60 * 60 * 24 * 30,
};

function errorKeyOf(err) {
  if (err instanceof entrants.EntrantError || err instanceof roster.AthleteError) return err;
  return null;
}

router.get('/entrant/signup', (req, res) => {
  if (req.entrant) return res.redirect(303, '/entrant');
  return res.renderPage('entrant_signup', {
    title: res.locals.t('entrant.signUp'),
    error: null,
    errorParams: null,
    form: { next: loginLinks.safeNext(req.query.next) || '' },
    mailMode: config.mail.enabled,
  });
});

// 寄信模式：註冊只要信箱，連結寄到信箱；畫面對「新註冊」和「本來就有」一模一樣。
// Mail mode: signing up takes only an email address and the link goes to the mailbox; the screen is
// identical for "new" and "already registered".
async function sendLinkAndAnswer(req, res, entrant) {
  try {
    await loginLinks.requestLink({ entrant, t: res.locals.t, next: req.body.next });
  } catch (err) {
    // 寄不出去也不告訴使用者，免得從錯誤猜出帳號存不存在；只記在伺服器。
    // A failed send is not shown either, so an error cannot reveal whether the account exists.
    console.error('[stagerank] login link mail failed:', err.message);
  }
  return res.renderPage('entrant_link_sent', { title: res.locals.t('entrant.signIn') });
}

router.post('/entrant/signup', async (req, res, next) => {
  try {
    if (config.mail.enabled) {
      const { entrant } = await entrants.signUpByEmail({
        email: req.body.email,
        unitName: req.body.unitName,
        contactName: req.body.contactName,
        phone: req.body.phone,
      });
      return await sendLinkAndAnswer(req, res, entrant);
    }
    const entrant = await entrants.signUp({
      email: req.body.email,
      password: req.body.password,
      unitName: req.body.unitName,
      contactName: req.body.contactName,
      phone: req.body.phone,
    });
    res.cookie(entrants.ENTRANT_COOKIE, entrants.makeToken(entrant.id), COOKIE_OPTIONS);
    clearSessions(res, 'entrant');
    return res.redirect(303, loginLinks.safeNext(req.body.next) || '/entrant');
  } catch (err) {
    const known = errorKeyOf(err);
    if (!known) return next(err);
    res.status(400);
    return res.renderPage('entrant_signup', {
      title: res.locals.t('entrant.signUp'),
      error: known.key,
      errorParams: known.params,
      form: req.body,
      mailMode: config.mail.enabled,
    });
  }
});

router.get('/entrant/login', (req, res) => {
  if (req.entrant) return res.redirect(303, '/entrant');
  return res.renderPage('entrant_login', {
    title: res.locals.t('entrant.signIn'),
    error: null,
    errorParams: null,
    form: { next: loginLinks.safeNext(req.query.next) || '' },
    mailMode: config.mail.enabled,
  });
});

router.post('/entrant/login', async (req, res, next) => {
  try {
    // 寄信模式：只問信箱，永遠回同一句話；帳號存在才真的寄。
    // Mail mode: ask only for the email, always answer with the same words; mail only if the account exists.
    if (config.mail.enabled) {
      const entrant = await entrants.findByEmail(req.body.email);
      return await sendLinkAndAnswer(req, res, entrant);
    }
    const entrant = await entrants.signIn({ email: req.body.email, password: req.body.password });
    res.cookie(entrants.ENTRANT_COOKIE, entrants.makeToken(entrant.id), COOKIE_OPTIONS);
    clearSessions(res, 'entrant');
    if (entrant.must_change_password) return res.redirect(303, '/entrant/password');
    return res.redirect(303, loginLinks.safeNext(req.body.next) || '/entrant');
  } catch (err) {
    const known = errorKeyOf(err);
    if (!known) return next(err);
    res.status(400);
    return res.renderPage('entrant_login', {
      title: res.locals.t('entrant.signIn'),
      error: known.key,
      errorParams: known.params,
      form: req.body,
      mailMode: config.mail.enabled,
    });
  }
});

// 信裡的連結：GET 只顯示「登入」按鈕，按下去（POST）才真的用掉。
// 信箱的連結預覽機器人只會 GET，這樣它們燒不掉連結。
// The link in the mail: GET only shows a "sign in" button and the POST is what consumes it. Mail
// link-preview bots only GET, so they cannot burn the link.
router.get('/entrant/link', async (req, res, next) => {
  try {
    const token = String(req.query.token || '');
    if (!(await loginLinks.isUsable(token))) {
      res.status(400);
      return res.renderPage('entrant_link', {
        title: res.locals.t('entrant.signIn'), valid: false, token: '', next: '',
      });
    }
    return res.renderPage('entrant_link', {
      title: res.locals.t('entrant.signIn'),
      valid: true,
      token,
      next: loginLinks.safeNext(req.query.next) || '',
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/entrant/link', async (req, res, next) => {
  try {
    const entrant = await loginLinks.consume(String(req.body.token || ''));
    if (!entrant) {
      res.status(400);
      return res.renderPage('entrant_link', {
        title: res.locals.t('entrant.signIn'), valid: false, token: '', next: '',
      });
    }
    res.cookie(entrants.ENTRANT_COOKIE, entrants.makeToken(entrant.id), COOKIE_OPTIONS);
    clearSessions(res, 'entrant');
    return res.redirect(303, loginLinks.safeNext(req.body.next) || '/entrant');
  } catch (err) {
    return next(err);
  }
});

router.post('/entrant/logout', (req, res) => {
  res.clearCookie(entrants.ENTRANT_COOKIE);
  res.redirect(303, '/');
});

router.get('/entrant/password', requireEntrant, (req, res) => {
  res.renderPage('entrant_password', {
    title: res.locals.t('entrant.changePassword'),
    error: null,
    errorParams: null,
    forced: Boolean(req.entrant.must_change_password),
  });
});

router.post('/entrant/password', requireEntrant, async (req, res, next) => {
  try {
    await entrants.changePassword(req.entrant.id, {
      current: req.body.current,
      next: req.body.next,
      // 主辦剛重設過的人手上只有臨時密碼，還是要輸入它，但不必記得舊的那一組。
      // Someone the organiser just reset still types the temporary password they were given.
      requireCurrent: true,
    });
    return res.redirect(303, '/entrant');
  } catch (err) {
    const known = errorKeyOf(err);
    if (!known) return next(err);
    res.status(400);
    return res.renderPage('entrant_password', {
      title: res.locals.t('entrant.changePassword'),
      error: known.key,
      errorParams: known.params,
      forced: Boolean(req.entrant.must_change_password),
    });
  }
});

async function renderHome(req, res, { error = null, errorParams = null, editId = null } = {}) {
  const [list, entries] = await Promise.all([
    roster.listRoster(req.entrant.id),
    regs.listForEntrant(req.entrant.id),
  ]);
  return res.renderPage('entrant_home', {
    title: res.locals.t('entrant.title'),
    roster: list,
    entries,
    error,
    errorParams,
    editId: editId ? String(editId) : null,
  });
}

router.get('/entrant', requireEntrant, (req, res, next) => {
  renderHome(req, res, { editId: req.query.edit || null }).catch(next);
});

router.post('/entrant/roster', requireEntrant, async (req, res, next) => {
  try {
    await roster.addAthlete({
      entrantId: req.entrant.id,
      name: req.body.name,
      birthDate: req.body.birthDate,
      email: req.body.email,
      note: req.body.note,
      region: req.body.region,
      unitName: req.body.athleteUnit,
    });
    return res.redirect(303, '/entrant#add');
  } catch (err) {
    const known = errorKeyOf(err);
    if (!known) return next(err);
    res.status(400);
    return renderHome(req, res, { error: known.key, errorParams: known.params }).catch(next);
  }
});

router.post('/entrant/roster/:id', requireEntrant, async (req, res, next) => {
  try {
    await roster.updateAthlete(Number.parseInt(req.params.id, 10), req.entrant.id, {
      name: req.body.name,
      birthDate: req.body.birthDate,
      email: req.body.email,
      note: req.body.note,
      region: req.body.region,
      unitName: req.body.athleteUnit,
    });
    return res.redirect(303, '/entrant');
  } catch (err) {
    const known = errorKeyOf(err);
    if (!known) return next(err);
    res.status(400);
    return renderHome(req, res, { error: known.key, errorParams: known.params }).catch(next);
  }
});

router.post('/entrant/roster/:id/delete', requireEntrant, async (req, res, next) => {
  try {
    await roster.removeAthlete(Number.parseInt(req.params.id, 10), req.entrant.id);
    return res.redirect(303, '/entrant');
  } catch (err) {
    const known = errorKeyOf(err);
    if (!known) return next(err);
    res.status(400);
    return renderHome(req, res, { error: known.key, errorParams: known.params }).catch(next);
  }
});

export default router;
