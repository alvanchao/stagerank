// 寄信的抽象層：其他程式只呼叫 sendMail({ to, subject, text })，不必知道信怎麼出去。
// 三種模式由 config.mail 決定：smtp（真的寄，nodemailer）、memory（放進 outbox，測試與開發用）、
// off（關閉，呼叫會丟錯，網站改用密碼登入）。
// The mail abstraction: the rest of the code only calls sendMail({ to, subject, text }) and never
// needs to know how it leaves. config.mail picks one of three modes: smtp (really sent, via
// nodemailer), memory (kept in the outbox, for tests and development) and off (calling it throws,
// and the site falls back to password sign-in).
import config from '../config.js';

// 記憶體信箱：每封信 { to, subject, text, at }。clear() 清空。
// The in-memory outbox: each mail is { to, subject, text, at }. clear() empties it.
export const outbox = [];
outbox.clear = () => {
  outbox.length = 0;
};

let transport = null;
let transportUrl = null;

async function smtpTransport() {
  // nodemailer 只有真的要寄時才載入，不寄信的站台不必付這個成本。
  // nodemailer is only loaded when mail is really sent, so a site without mail pays nothing for it.
  if (!transport || transportUrl !== config.mail.smtpUrl) {
    const { default: nodemailer } = await import('nodemailer');
    transport = nodemailer.createTransport(config.mail.smtpUrl);
    transportUrl = config.mail.smtpUrl;
  }
  return transport;
}

export function isEnabled() {
  return config.mail.enabled;
}

export async function sendMail({ to, subject, text }) {
  const mode = config.mail.mode;
  if (!to || !subject || !text) throw new Error('sendMail needs to, subject and text');
  if (mode === 'memory' || mode === 'pretend') {
    outbox.push({ to, subject, text, at: new Date() });
    return { mode, queued: true };
  }
  if (mode === 'smtp') {
    const info = await (await smtpTransport()).sendMail({ from: config.mail.from, to, subject, text });
    return { mode, messageId: info.messageId };
  }
  throw new Error('mail is disabled');
}

export default { sendMail, outbox, isEnabled };
