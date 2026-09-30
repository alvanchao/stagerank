// 報名人自己的畫面：註冊、登入、名冊、報名紀錄。
// The entrant's own screens: sign up, sign in, the roster, and what they have entered.
import express from 'express';
import * as entrants from '../services/entrants.js';
import * as roster from '../services/athletes.js';
import * as regs from '../services/registrations.js';
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
    form: {},
  });
});

router.post('/entrant/signup', async (req, res, next) => {
  try {
    const entrant = await entrants.signUp({
      email: req.body.email,
      password: req.body.password,
      unitName: req.body.unitName,
      contactName: req.body.contactName,
      phone: req.body.phone,
    });
    res.cookie(entrants.ENTRANT_COOKIE, entrants.makeToken(entrant.id), COOKIE_OPTIONS);
    return res.redirect(303, req.body.next || '/entrant');
  } catch (err) {
    const known = errorKeyOf(err);
    if (!known) return next(err);
    res.status(400);
    return res.renderPage('entrant_signup', {
      title: res.locals.t('entrant.signUp'),
      error: known.key,
      errorParams: known.params,
      form: req.body,
    });
  }
});

router.get('/entrant/login', (req, res) => {
  if (req.entrant) return res.redirect(303, '/entrant');
  return res.renderPage('entrant_login', {
    title: res.locals.t('entrant.signIn'),
    error: null,
    errorParams: null,
    form: { next: req.query.next || '' },
  });
});

router.post('/entrant/login', async (req, res, next) => {
  try {
    const entrant = await entrants.signIn({ email: req.body.email, password: req.body.password });
    res.cookie(entrants.ENTRANT_COOKIE, entrants.makeToken(entrant.id), COOKIE_OPTIONS);
    if (entrant.must_change_password) return res.redirect(303, '/entrant/password');
    return res.redirect(303, req.body.next || '/entrant');
  } catch (err) {
    const known = errorKeyOf(err);
    if (!known) return next(err);
    res.status(400);
    return res.renderPage('entrant_login', {
      title: res.locals.t('entrant.signIn'),
      error: known.key,
      errorParams: known.params,
      form: req.body,
    });
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
