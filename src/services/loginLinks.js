// 免密碼登入連結：寄一封信，信裡有一條只能用一次、15 分鐘內有效的連結。
// 資料庫只存 token 的 sha256，所以資料庫外洩也拿不到可用的連結。
// Passwordless login links: one mail carrying a single-use link that is good for 15 minutes.
// Only the sha256 of the token is stored, so a leaked database yields no usable link.
import { randomBytes, createHash } from 'node:crypto';
import { one } from '../db/index.js';
import config from '../config.js';
import * as mailer from './mailer.js';

export const LINK_TTL_MINUTES = 15;
export const RESEND_SECONDS = 60;

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

// 登入後只可以回到本站的路徑；//evil.example 或 http://… 一律丟掉。
// After signing in only a path on this site is allowed; //evil.example or http://... is dropped.
export function safeNext(value) {
  const next = String(value || '');
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || /[\r\n]/.test(next)) return null;
  return next;
}

// 寄連結給這個信箱。回傳 { sent }；帳號不存在或一分鐘內才寄過就不寄，但呼叫的人
// 不可以把這個差別露給使用者（避免猜哪些信箱註冊過）。
// Mail a link to this address. Returns { sent }; an unknown account, or one mailed within the last
// minute, is not mailed, and the caller must not let that difference show (no enumeration).
export async function requestLink({ entrant, t, next = null }) {
  if (!entrant) return { sent: false, reason: 'unknown' };

  const recent = await one(
    `SELECT 1 FROM login_links
     WHERE entrant_id = $1 AND created_at > now() - make_interval(secs => $2)
     LIMIT 1`,
    [entrant.id, RESEND_SECONDS],
  );
  if (recent) return { sent: false, reason: 'rateLimited' };

  const token = randomBytes(32).toString('base64url');
  await one(
    `INSERT INTO login_links (entrant_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING id`,
    [entrant.id, sha256(token), LINK_TTL_MINUTES],
  );

  const safe = safeNext(next);
  const link = `${config.baseUrl}/entrant/link?token=${encodeURIComponent(token)}${safe ? `&next=${encodeURIComponent(safe)}` : ''}`;
  await mailer.sendMail({
    to: entrant.email,
    subject: t('mail.loginLink.subject', { site: config.siteName }),
    text: t('mail.loginLink.body', { site: config.siteName, link, minutes: LINK_TTL_MINUTES }),
  });
  return { sent: true };
}

// 連結還能用嗎（只看，不消耗）：GET 頁面用它，信箱的連結預覽機器人打開網址也不會燒掉連結。
// Is the link still usable (look, do not consume)? The GET page uses it, so an email link-preview
// bot opening the URL cannot burn the link.
export async function isUsable(token) {
  if (!token) return false;
  const row = await one(
    'SELECT 1 FROM login_links WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()',
    [sha256(token)],
  );
  return Boolean(row);
}

// 使用連結：一個 UPDATE 同時檢查「沒用過、沒過期」並標記已用，兩個人同時按也只有一個成功。
// 用連結登入等於證明了信箱，所以順便解除「必須改密碼」。
// Consume the link: one UPDATE checks "unused and unexpired" and marks it used, so of two
// simultaneous clicks only one wins. Signing in by link proves the mailbox, so a pending forced
// password change is lifted.
export async function consume(token) {
  if (!token) return null;
  const used = await one(
    `UPDATE login_links SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING entrant_id`,
    [sha256(token)],
  );
  if (!used) return null;
  return one(
    'UPDATE entrants SET must_change_password = FALSE, updated_at = now() WHERE id = $1 RETURNING *',
    [used.entrant_id],
  );
}

export default { requestLink, isUsable, consume, safeNext, LINK_TTL_MINUTES, RESEND_SECONDS };
