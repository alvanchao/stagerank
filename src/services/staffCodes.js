// 工作人員：每人一組專屬通行碼。碼只能用一次；登入後伺服器記住這個人，直到比賽結束或被停用。
// Staff: one personal passcode each, single use. After sign-in the server remembers the person
// until the competition ends or the organiser revokes them.

import crypto from 'node:crypto';
import { one, many, query } from '../db/index.js';

export const ROLES = ['desk', 'checkin', 'host'];
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 沒有容易看錯的 0/O/1/I

export class StaffError extends Error {
  constructor(key) {
    super(key);
    this.key = key;
  }
}

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const normalise = (code) => String(code || '').trim().toUpperCase().replace(/\s+/g, '');

function randomCode() {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

// 掃到的可能是整段網址，也可能只是碼本身。
// A scan may be a whole URL or just the code itself.
export function extractCode(text) {
  const raw = String(text || '').trim();
  try {
    const url = new URL(raw);
    const fromQuery = url.searchParams.get('code');
    if (fromQuery) return normalise(fromQuery);
  } catch {
    // 不是網址，當成碼本身。
  }
  return normalise(raw);
}

// 一次新增一批：一行一個姓名。回傳含明文碼的清單（只此一次）。
// Add a batch, one name per line. Returns the plain codes once.
export async function issueBatch(competitionId, { role, names, allowBrowser = false }) {
  if (!ROLES.includes(role)) throw new StaffError('staffApp.errors.badRole');
  const list = [...new Set(String(Array.isArray(names) ? names.join('\n') : names || '')
    .split(/[\n,，、]/).map((n) => n.trim()).filter(Boolean))];
  if (list.length === 0) throw new StaffError('staffApp.errors.noNames');
  const issued = [];
  for (const name of list) {
    const code = randomCode();
    const row = await one(
      `INSERT INTO staff_members (competition_id, name, role, code_hash, allow_browser)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [competitionId, name, role, sha(code), Boolean(allowBrowser)],
    );
    issued.push({ member: row, code });
  }
  return issued;
}

// 重新產生：換一組新碼，原本的登入狀態立刻失效。
// Reissue: a new code, and any earlier sign-in stops working at once.
export async function reissue(memberId, competitionId) {
  const code = randomCode();
  const row = await one(
    `UPDATE staff_members
     SET code_hash = $3, session_hash = NULL, redeemed_at = NULL, revoked_at = NULL
     WHERE id = $1 AND competition_id = $2 RETURNING *`,
    [memberId, competitionId, sha(code)],
  );
  if (!row) throw new StaffError('errors.notFound');
  return { member: row, code };
}

export async function revoke(memberId, competitionId) {
  const row = await one(
    `UPDATE staff_members SET revoked_at = now(), session_hash = NULL
     WHERE id = $1 AND competition_id = $2 RETURNING *`,
    [memberId, competitionId],
  );
  if (!row) throw new StaffError('errors.notFound');
  return row;
}

// 兌換：碼只能用一次。回傳 cookie 用的值。
// Redeem: single use. Returns the value for the session cookie.
export async function redeem(rawCode, { standalone = false } = {}) {
  const code = normalise(rawCode);
  if (!code) throw new StaffError('staffApp.errors.invalid');
  const member = await one(
    `SELECT sm.*, c.ended_at FROM staff_members sm JOIN competitions c ON c.id = sm.competition_id
     WHERE sm.code_hash = $1`,
    [sha(code)],
  );
  if (!member || member.revoked_at) throw new StaffError('staffApp.errors.invalid');
  if (member.ended_at) throw new StaffError('staffApp.errors.ended');
  if (member.redeemed_at) throw new StaffError('staffApp.errors.used');
  if (!standalone && !member.allow_browser) throw new StaffError('staffApp.errors.installFirst');

  const token = crypto.randomBytes(24).toString('hex');
  // 只有還沒被用過的碼才換得到登入狀態：同時兩個人掃同一張，只有一個成功。
  // Only an unused code converts; if two scan the same one at once, only one wins.
  const updated = await one(
    `UPDATE staff_members SET redeemed_at = now(), session_hash = $2
     WHERE id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL RETURNING *`,
    [member.id, sha(token)],
  );
  if (!updated) throw new StaffError('staffApp.errors.used');
  return { member: updated, cookieValue: `${updated.id}.${token}` };
}

// cookie 對應的工作人員；失效、停用、比賽結束都回 null。
// The member behind a cookie; null when revoked, ended or wrong.
export async function fromCookie(value) {
  const [idText, token] = String(value || '').split('.');
  const id = Number.parseInt(idText, 10);
  if (!Number.isFinite(id) || !token) return null;
  const member = await one(
    `SELECT sm.*, c.ended_at FROM staff_members sm JOIN competitions c ON c.id = sm.competition_id
     WHERE sm.id = $1`,
    [id],
  );
  if (!member || member.revoked_at || member.ended_at || !member.session_hash) return null;
  const a = Buffer.from(member.session_hash);
  const b = Buffer.from(sha(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? member : null;
}

export function listMembers(competitionId) {
  return many('SELECT * FROM staff_members WHERE competition_id = $1 ORDER BY role, id', [competitionId]);
}

export async function endCompetition(competitionId) {
  await query('UPDATE competitions SET ended_at = COALESCE(ended_at, now()) WHERE id = $1', [competitionId]);
}

export async function reopenCompetition(competitionId) {
  await query('UPDATE competitions SET ended_at = NULL WHERE id = $1', [competitionId]);
}

export function logAction({ competitionId, member, action }) {
  return query(
    'INSERT INTO staff_log (competition_id, staff_id, staff_name, role, action) VALUES ($1, $2, $3, $4, $5)',
    [competitionId, member.id, member.name, member.role, action],
  ).catch(() => {});
}

export function recentLog(competitionId, limit = 40) {
  return many('SELECT * FROM staff_log WHERE competition_id = $1 ORDER BY id DESC LIMIT $2', [competitionId, limit]);
}
