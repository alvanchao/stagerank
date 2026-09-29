import crypto from 'node:crypto';
import config from '../config.js';

export const STAFF_COOKIE = 'stagerank_admin';
export const JUDGE_COOKIE = 'stagerank_judge';

export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function readCookie(header, name) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

// 主辦、主持人、檢錄、報到都用同一組通行碼。
// The organiser, host, check-in and registration desk all share one passcode.
export function requireStaff(req, res, next) {
  if (!config.adminToken) {
    return res.renderPage('admin_login', { title: res.locals.t('admin.title'), hasToken: false, error: null });
  }
  const token = readCookie(req.headers.cookie, STAFF_COOKIE);
  if (token && safeEqual(token, config.adminToken)) return next();
  return res.renderPage('admin_login', { title: res.locals.t('admin.title'), hasToken: true, error: null });
}

// 報名人的登入狀態：每個畫面都想知道「現在是誰」，所以在這裡讀一次就好。
// Who is signed in as an entrant. Every screen wants to know, so it is read once here.
export async function attachEntrant(req, res, next) {
  try {
    const { readToken, getEntrant, ENTRANT_COOKIE } = await import('../services/entrants.js');
    const id = readToken(readCookie(req.headers.cookie, ENTRANT_COOKIE));
    req.entrant = id ? await getEntrant(id) : null;
  } catch {
    req.entrant = null;
  }
  res.locals.entrant = req.entrant || null;
  return next();
}

export function requireEntrant(req, res, next) {
  if (req.entrant) {
    // 主辦幫忙重設過密碼的人，先改密碼再做別的事。
    // Anyone whose password the organiser reset changes it before doing anything else.
    if (req.entrant.must_change_password && !req.path.startsWith('/entrant/password')) {
      return res.redirect(303, '/entrant/password');
    }
    return next();
  }
  const next_ = encodeURIComponent(req.originalUrl || '/entrant');
  return res.redirect(303, `/entrant/login?next=${next_}`);
}

export default {
  requireStaff,
  attachEntrant,
  requireEntrant,
  safeEqual,
  readCookie,
  STAFF_COOKIE,
  JUDGE_COOKIE,
};
