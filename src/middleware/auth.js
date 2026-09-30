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

export const STAFF_SESSION_COOKIE = 'stagerank_staff';

// 主辦通行碼（全站唯一，放環境變數）可以進所有工作人員畫面；
// 其他工作人員各自有一組專屬、只能用一次的碼，登入後由伺服器記住，只對那一場有效。
// The organiser passcode (one per site, in the environment) opens every staff screen.
// Everyone else has a personal single-use code; after sign-in the server remembers them, for that
// one competition only.
export function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      const cookies = req.headers.cookie;
      const token = readCookie(cookies, STAFF_COOKIE);
      if (config.adminToken && token && safeEqual(token, config.adminToken)) {
        req.staffRole = 'admin';
        return next();
      }
      const competitionId = Number.parseInt(req.params.competitionId, 10);
      const { fromCookie, logAction } = await import('../services/staffCodes.js');
      const member = await fromCookie(readCookie(cookies, STAFF_SESSION_COOKIE));
      if (member && Number.isFinite(competitionId) && String(member.competition_id) === String(competitionId)
        && roles.includes(member.role)) {
        req.staffRole = member.role;
        req.staffMember = member;
        if (req.method !== 'GET') {
          const action = `${req.method} ${req.baseUrl || ''}${req.route?.path || req.path}`;
          res.on('finish', () => {
            if (res.statusCode < 400) logAction({ competitionId, member, action });
          });
        }
        return next();
      }
      return res.status(401).renderPage('admin_login', {
        title: res.locals.t('admin.title'),
        hasToken: true,
        error: null,
        staffLogin: { competitionId: Number.isFinite(competitionId) ? competitionId : null },
      });
    } catch (err) {
      return next(err);
    }
  };
}

// 只限主辦。
// Organiser only.
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
  requireRole,
  attachEntrant,
  requireEntrant,
  safeEqual,
  readCookie,
  STAFF_COOKIE,
  STAFF_SESSION_COOKIE,
  JUDGE_COOKIE,
};
