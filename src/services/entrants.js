// 報名人帳號：教室老師或家長，一個電子郵件一個帳號。
// 選手本人不需要帳號，也不需要電子郵件。
// The entrant account: a teacher or a parent, one account per email address.
// The competitors themselves need neither an account nor an email address.
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { one, many } from '../db/index.js';
import config from '../config.js';

export const ENTRANT_COOKIE = 'stagerank_entrant';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export class EntrantError extends Error {
  constructor(key, params = null) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

// scrypt 而不是 bcrypt：Node 內建，自架的人不必多裝一個要編譯的套件。
// scrypt rather than bcrypt: it ships with Node, so self-hosters compile nothing extra.
export function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(plain), salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash}`;
}

export function verifyPassword(plain, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'hex');
  let actual;
  try {
    actual = scryptSync(String(plain), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// 密碼規則刻意只有一條長度下限。逼人加符號只會換來寫在便利貼上的密碼。
// Deliberately only a length rule. Demanding symbols just moves the password onto a sticky note.
export const MIN_PASSWORD_LENGTH = 8;

export async function signUp({ email, password, unitName = null, contactName = null, phone = null }) {
  const address = normaliseEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new EntrantError('entrant.errors.emailInvalid');
  if (String(password || '').length < MIN_PASSWORD_LENGTH) {
    throw new EntrantError('entrant.errors.passwordTooShort', { min: MIN_PASSWORD_LENGTH });
  }

  const taken = await one('SELECT 1 FROM entrants WHERE lower(email) = $1', [address]);
  if (taken) throw new EntrantError('entrant.errors.emailTaken');

  return one(
    `INSERT INTO entrants (email, password_hash, unit_name, contact_name, phone)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [address, hashPassword(password), unitName || null, contactName || null, phone || null],
  );
}

export async function signIn({ email, password }) {
  const entrant = await one('SELECT * FROM entrants WHERE lower(email) = $1', [normaliseEmail(email)]);
  // 帳號不存在和密碼錯誤回同一個訊息，免得有人拿登入頁去試哪些信箱註冊過。
  // An unknown account and a wrong password give the same message, so the login page cannot be
  // used to find out which addresses are registered.
  if (!entrant || !verifyPassword(password, entrant.password_hash)) {
    throw new EntrantError('entrant.errors.badCredentials');
  }
  return entrant;
}

export async function changePassword(entrantId, { current = null, next, requireCurrent = true }) {
  const entrant = await one('SELECT * FROM entrants WHERE id = $1', [entrantId]);
  if (!entrant) throw new EntrantError('errors.notFound');
  if (requireCurrent && !verifyPassword(current, entrant.password_hash)) {
    throw new EntrantError('entrant.errors.badCredentials');
  }
  if (String(next || '').length < MIN_PASSWORD_LENGTH) {
    throw new EntrantError('entrant.errors.passwordTooShort', { min: MIN_PASSWORD_LENGTH });
  }
  return one(
    `UPDATE entrants SET password_hash = $2, must_change_password = FALSE, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [entrantId, hashPassword(next)],
  );
}

// 自架的環境不一定有寄信服務，所以「忘記密碼」是主辦按一下產生臨時密碼，
// 當面或用電話給老師，老師下次登入一定要自己改掉。
// A self-hosted site may have no mail service, so a forgotten password is handled by the organiser
// issuing a temporary one. The entrant must choose their own at the next sign-in.
export async function resetPassword(entrantId) {
  const temporary = randomBytes(6).toString('base64url');
  const updated = await one(
    `UPDATE entrants SET password_hash = $2, must_change_password = TRUE, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [entrantId, hashPassword(temporary)],
  );
  if (!updated) throw new EntrantError('errors.notFound');
  return { entrant: updated, temporaryPassword: temporary };
}

export function getEntrant(id) {
  return one('SELECT * FROM entrants WHERE id = $1', [id]);
}

export function findByEmail(email) {
  return one('SELECT * FROM entrants WHERE lower(email) = $1', [normaliseEmail(email)]);
}

export function listEntrants() {
  return many('SELECT * FROM entrants ORDER BY created_at DESC');
}

export function updateProfile(id, { unitName, contactName, phone }) {
  return one(
    `UPDATE entrants SET unit_name = $2, contact_name = $3, phone = $4, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, unitName || null, contactName || null, phone || null],
  );
}

// ------------------------------------------------------------------ 登入狀態 / the session

// 簽章的 cookie，不存 session 表：重開機最多就是重新登入一次，不值得為它加一張表。
// A signed cookie rather than a session table: the worst a restart costs is signing in again.
export function makeToken(entrantId) {
  const issued = Date.now().toString(36);
  const payload = `${entrantId}.${issued}`;
  const signature = createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function readToken(token, { maxAgeMs = 1000 * 60 * 60 * 24 * 30 } = {}) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [id, issued, signature] = parts;
  const expected = createHmac('sha256', config.sessionSecret).update(`${id}.${issued}`).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const when = Number.parseInt(issued, 36);
  if (!Number.isFinite(when) || Date.now() - when > maxAgeMs) return null;
  const entrantId = Number.parseInt(id, 10);
  return Number.isFinite(entrantId) ? entrantId : null;
}

export default {
  ENTRANT_COOKIE,
  EntrantError,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
  normaliseEmail,
  signUp,
  signIn,
  changePassword,
  resetPassword,
  getEntrant,
  findByEmail,
  listEntrants,
  updateProfile,
  makeToken,
  readToken,
};
