import config from '../config.js';
import {
  STAFF_COOKIE, STAFF_SESSION_COOKIE, JUDGE_COOKIE, readCookie, safeEqual,
} from './auth.js';
import * as entrants from '../services/entrants.js';

// 一台瀏覽器同時只有一個身分：登入新身分前，先把其他身分登出。
// One identity per browser: signing in as someone new signs the previous identity out first.
const EXPIRE = 'Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

export function clearSessions(res, except = null) {
  if (except !== 'admin') res.append('Set-Cookie', `${STAFF_COOKIE}=; ${EXPIRE}`);
  if (except !== 'staff') res.append('Set-Cookie', `${STAFF_SESSION_COOKIE}=; ${EXPIRE}`);
  if (except !== 'judge') res.append('Set-Cookie', `${JUDGE_COOKIE}=; ${EXPIRE}`);
  if (except !== 'entrant') res.append('Set-Cookie', `${entrants.ENTRANT_COOKIE}=; ${EXPIRE}`);
}

// 現在是誰？畫面的選單和登出按鈕都看這裡。優先順序：主辦 > 工作人員 > 評審 > 報名者。
// Who is signed in? The menu and the sign-out button read this.
export async function attachIdentity(req, res, next) {
  res.locals.identity = null;
  try {
    const cookies = req.headers.cookie;
    const token = readCookie(cookies, STAFF_COOKIE);
    if (config.adminToken && token && safeEqual(token, config.adminToken)) {
      res.locals.identity = { kind: 'admin', home: '/admin' };
      return next();
    }
    const { fromCookie } = await import('../services/staffCodes.js');
    const member = await fromCookie(readCookie(cookies, STAFF_SESSION_COOKIE));
    if (member) {
      res.locals.identity = {
        kind: 'staff', role: member.role, name: member.name, home: `/${member.role}/${member.competition_id}`,
      };
      return next();
    }
    const judgeCode = readCookie(cookies, JUDGE_COOKIE);
    if (judgeCode) {
      const { judgeByLoginCode } = await import('../services/judges.js');
      const judge = await judgeByLoginCode(judgeCode);
      if (judge) {
        res.locals.identity = { kind: 'judge', name: judge.name, home: `/judge/${judge.competition_id}` };
        return next();
      }
    }
    if (req.entrant) {
      res.locals.identity = {
        kind: 'entrant', name: req.entrant.unit_name || req.entrant.contact_name || req.entrant.email, home: '/entrant',
      };
    }
  } catch {
    res.locals.identity = null;
  }
  return next();
}

export default { attachIdentity, clearSessions };
