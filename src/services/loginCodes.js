// 信箱驗證碼登入：寄一組 6 位數字（10 分鐘內有效、只能用一次、錯 5 次作廢）。
// 資料庫只存雜湊（加了站台密鑰與帳號），所以資料庫外洩也拿不到可用的碼。
// Email code sign-in: mail a 6-digit number (good for 10 minutes, single use, void after 5 wrong tries).
// Only a hash is stored (salted with the site secret and the account), so a leaked database yields no usable code.
import { randomInt, createHmac, timingSafeEqual } from 'node:crypto';
import { one } from '../db/index.js';
import config from '../config.js';
import * as mailer from './mailer.js';

export const CODE_TTL_MINUTES = 10;
export const RESEND_SECONDS = 60;
export const MAX_ATTEMPTS = 5;

const hashOf = (entrantId, code) => createHmac('sha256', config.sessionSecret)
  .update(`${entrantId}:${String(code).trim()}`).digest('hex');

// 寄碼。回傳 { sent, code }；帳號不存在或一分鐘內才寄過就不寄。呼叫的人不可以把這個差別露給使用者。
// code 只有在「假裝寄信」模式才會被畫面用到。
// Mail a code. Returns { sent, code }; an unknown account, or one mailed within the last minute, is not
// mailed, and the caller must not let that difference show. The code is only used by the screen in pretend mode.
export async function requestCode({ entrant, t }) {
  if (!entrant) return { sent: false, reason: 'unknown' };
  const recent = await one(
    `SELECT 1 FROM login_codes WHERE entrant_id = $1 AND created_at > now() - make_interval(secs => $2) LIMIT 1`,
    [entrant.id, RESEND_SECONDS],
  );
  if (recent) return { sent: false, reason: 'rateLimited' };

  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  await one(
    `INSERT INTO login_codes (entrant_id, code_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING id`,
    [entrant.id, hashOf(entrant.id, code), CODE_TTL_MINUTES],
  );
  await mailer.sendMail({
    to: entrant.email,
    subject: t('mail.loginCode.subject', { site: config.siteName }),
    text: t('mail.loginCode.body', { site: config.siteName, code, minutes: CODE_TTL_MINUTES }),
  });
  return { sent: true, code };
}

// 驗證碼。成功回傳報名者並標記已用；失敗回 null（不說是哪裡錯）。
// 一個 UPDATE 同時檢查「沒用過、沒過期、次數沒超過」，兩個人同時送也只有一個成功。
// Check a code. Success returns the entrant and marks it used; failure returns null, never saying why.
// One UPDATE checks "unused, unexpired, attempts left", so of two simultaneous tries only one can win.
export async function verifyCode({ entrant, code }) {
  if (!entrant || !/^\d{6}$/.test(String(code || '').trim())) return null;
  const row = await one(
    `SELECT id, code_hash FROM login_codes
     WHERE entrant_id = $1 AND used_at IS NULL AND expires_at > now() AND attempts < $2
     ORDER BY created_at DESC LIMIT 1`,
    [entrant.id, MAX_ATTEMPTS],
  );
  if (!row) return null;
  const a = Buffer.from(row.code_hash);
  const b = Buffer.from(hashOf(entrant.id, code));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await one('UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING id', [row.id]);
    return null;
  }
  const used = await one(
    `UPDATE login_codes SET used_at = now()
     WHERE id = $1 AND used_at IS NULL AND expires_at > now() AND attempts < $2 RETURNING id`,
    [row.id, MAX_ATTEMPTS],
  );
  if (!used) return null;
  // 用碼登入等於證明了信箱，所以順便解除「必須改密碼」。
  // Signing in by code proves the mailbox, so a pending forced password change is lifted.
  return one(
    'UPDATE entrants SET must_change_password = FALSE, updated_at = now() WHERE id = $1 RETURNING *',
    [entrant.id],
  );
}

export default { requestCode, verifyCode, CODE_TTL_MINUTES, RESEND_SECONDS, MAX_ATTEMPTS };
