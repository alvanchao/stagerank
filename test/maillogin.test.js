// 免密碼登入連結（寄信模式，用記憶體信箱）。
// Passwordless email login links (mail mode, in-memory outbox).
import { resetDatabase, startServer, makeEntrant } from './helpers.js';
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/app.js');
const { default: config } = await import('../src/config.js');
const mailer = await import('../src/services/mailer.js');
const entrants = await import('../src/services/entrants.js');
const { closePool, one, query } = await import('../src/db/index.js');
const { translate } = await import('../src/i18n/index.js');

let http;
before(async () => {
  await resetDatabase();
  http = await startServer(createApp());
});
after(async () => {
  config.mail.setMode('off');
  await http.close();
  await closePool();
});
beforeEach(async () => {
  await resetDatabase();
  mailer.outbox.clear();
  config.mail.setMode('memory');
});

const SENT = translate('zh-TW', 'entrant.linkSentIfExists');
const linkOf = (mail) => mail.text.match(/https?:\/\/\S+\/entrant\/link\?\S+/)[0];
const pathOf = (link) => link.replace(/^https?:\/\/[^/]+/, '');
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('設定：NODE_ENV=test 本身不開寄信，memory 要明確設定 / mail is off under NODE_ENV=test until memory is chosen', () => {
  config.mail.setMode('off');
  assert.equal(config.mail.enabled, false);
  assert.equal(config.mail.mode, 'off');
  config.mail.setMode('memory');
  assert.equal(config.mail.enabled, true);
  // 沒有 SMTP_URL 與 MAIL_FROM 就要求 smtp，等於關閉。
  // Asking for smtp without SMTP_URL and MAIL_FROM means off.
  config.mail.setMode('smtp');
  assert.equal(config.mail.enabled, false);
});

test('記憶體信箱與關閉時的行為 / the outbox works and a disabled mailer refuses', async () => {
  await mailer.sendMail({ to: 'x@example.com', subject: 'Hi', text: 'Body' });
  assert.equal(mailer.outbox.length, 1);
  assert.equal(mailer.outbox[0].to, 'x@example.com');
  mailer.outbox.clear();
  assert.equal(mailer.outbox.length, 0);
  await assert.rejects(() => mailer.sendMail({ to: 'x@example.com', subject: '', text: 'b' }));
  config.mail.setMode('off');
  await assert.rejects(() => mailer.sendMail({ to: 'x@example.com', subject: 'a', text: 'b' }), /disabled/);
});

test('寄信模式的畫面：註冊只問信箱，沒有密碼欄 / in mail mode the forms ask for an email and no password', async () => {
  const signup = await (await http.get('/entrant/signup')).text();
  assert.ok(!signup.includes('type="password"'));
  assert.match(signup, /name="email"/);
  assert.match(signup, /name="unitName"/);
  const login = await (await http.get('/entrant/login')).text();
  assert.ok(!login.includes('type="password"'));

  config.mail.setMode('off');
  assert.match(await (await http.get('/entrant/signup')).text(), /type="password"/, 'password mode is unchanged');
  assert.match(await (await http.get('/entrant/login')).text(), /type="password"/);
});

test('完整流程：註冊 → 信箱有連結 → GET 只確認 → POST 登入 → 不能再用 / full flow, single use', async () => {
  const res = await http.postForm('/entrant/signup', {
    email: 'Teacher@Example.com', unitName: 'Sunrise Dance', contactName: 'Contact', phone: '0900',
  });
  assert.equal(res.status, 200);
  assert.ok(!res.headers.get('set-cookie'), 'signing up does not sign in');
  assert.match(await res.text(), new RegExp(SENT));

  const entrant = await entrants.findByEmail('teacher@example.com');
  assert.equal(entrant.unit_name, 'Sunrise Dance');
  assert.ok(!entrants.verifyPassword('', entrant.password_hash), 'the password hash is unusable');

  assert.equal(mailer.outbox.length, 1);
  const mail = mailer.outbox[0];
  assert.equal(mail.to, 'teacher@example.com');
  assert.match(mail.subject, /Test Cup/);
  assert.match(mail.text, /15/);
  const link = linkOf(mail);
  assert.ok(link.startsWith(`${config.baseUrl}/entrant/link?token=`));

  // 只存雜湊：資料庫裡找不到明文 token。
  // Only the hash is stored: the plain token is nowhere in the database.
  const token = new URL(link).searchParams.get('token');
  const rows = (await query('SELECT * FROM login_links')).rows;
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(token));
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);

  // GET（信箱預覽機器人做的事）只顯示按鈕，不登入、不消耗。
  // GET, which is all a link-preview bot does, only shows the button: no sign-in, nothing consumed.
  for (let i = 0; i < 2; i += 1) {
    const page = await http.get(pathOf(link));
    assert.equal(page.status, 200);
    assert.ok(!page.headers.get('set-cookie'));
    const html = await page.text();
    assert.match(html, /method="post" action="\/entrant\/link"/);
    assert.match(html, /<button type="submit">登入<\/button>/);
  }
  assert.equal((await one('SELECT used_at FROM login_links')).used_at, null);

  const login = await http.postForm('/entrant/link', { token, next: '' });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/entrant');
  const cookie = cookieOf(login);
  assert.match(cookie, /^stagerank_entrant=/);
  assert.equal((await http.get('/entrant', { headers: { cookie } })).status, 200, 'the cookie signs in');

  // 用過的連結：GET 顯示失效，POST 拒絕。
  // A used link: GET says it is dead, POST refuses.
  const again = await http.get(pathOf(link));
  assert.equal(again.status, 400);
  assert.match(await again.text(), /已經用過或已過期/);
  const replay = await http.postForm('/entrant/link', { token });
  assert.equal(replay.status, 400);
  assert.ok(!replay.headers.get('set-cookie'));
});

test('連結過期就不能用 / an expired link is refused', async () => {
  await makeEntrant({ email: 'late@example.com' });
  await http.postForm('/entrant/login', { email: 'late@example.com' });
  const link = linkOf(mailer.outbox[0]);
  const token = new URL(link).searchParams.get('token');
  await query("UPDATE login_links SET expires_at = now() - interval '1 minute'");

  assert.equal((await http.get(pathOf(link))).status, 400);
  const res = await http.postForm('/entrant/link', { token });
  assert.equal(res.status, 400);
  assert.ok(!res.headers.get('set-cookie'));

  // 亂寫的 token 一樣。
  // A made-up token too.
  assert.equal((await http.postForm('/entrant/link', { token: 'nope' })).status, 400);
  assert.equal((await http.postForm('/entrant/link', {})).status, 400);
  assert.equal((await http.get('/entrant/link')).status, 400);
});

test('登入頁只問信箱，永遠同一句話，不洩漏誰註冊過 / login answers identically for known and unknown addresses', async () => {
  await makeEntrant({ email: 'known@example.com' });
  const known = await http.postForm('/entrant/login', { email: 'known@example.com' });
  const unknown = await http.postForm('/entrant/login', { email: 'stranger@example.com' });
  const junk = await http.postForm('/entrant/login', { email: 'not-an-email' });

  for (const res of [known, unknown, junk]) {
    assert.equal(res.status, 200);
    assert.match(await res.clone().text(), new RegExp(SENT));
  }
  assert.equal(await known.text(), await unknown.text(), 'byte-identical pages');
  assert.equal(mailer.outbox.length, 1, 'only the real account got a mail');
  assert.equal(mailer.outbox[0].to, 'known@example.com');
  assert.equal(await entrants.findByEmail('stranger@example.com'), null, 'login never creates an account');
});

test('註冊已存在的信箱：看不出差別，只寄連結，不動原帳號 / signing up an existing address looks the same and changes nothing', async () => {
  const before = await makeEntrant({ email: 'dupe@example.com', unitName: 'Original Unit' });
  const res = await http.postForm('/entrant/signup', { email: 'dupe@example.com', unitName: 'Hijack Attempt' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), new RegExp(SENT));
  assert.equal((await entrants.findByEmail('dupe@example.com')).unit_name, 'Original Unit');
  assert.equal(mailer.outbox.length, 1);
  assert.equal(before.entrant.email, 'dupe@example.com');

  const bad = await http.postForm('/entrant/signup', { email: 'nope' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /電子郵件格式不對/);
});

test('頻率限制：同一個信箱 60 秒內最多一封 / at most one mail per address per 60 seconds', async () => {
  await makeEntrant({ email: 'busy@example.com' });
  for (let i = 0; i < 4; i += 1) {
    const res = await http.postForm('/entrant/login', { email: 'busy@example.com' });
    assert.equal(res.status, 200);
    assert.match(await res.text(), new RegExp(SENT), 'the answer never changes');
  }
  assert.equal(mailer.outbox.length, 1);

  // 別的信箱不受影響；一分鐘過後可以再寄。
  // Another address is unaffected; after a minute it can be mailed again.
  await makeEntrant({ email: 'other@example.com' });
  await http.postForm('/entrant/login', { email: 'other@example.com' });
  assert.equal(mailer.outbox.length, 2);
  await query("UPDATE login_links SET created_at = now() - interval '61 seconds'");
  await http.postForm('/entrant/login', { email: 'busy@example.com' });
  assert.equal(mailer.outbox.length, 3);
  assert.equal(mailer.outbox[2].to, 'busy@example.com');
});

test('next：登入後回到原本要去的頁面，但只限本站路徑 / next is honoured for local paths only', async () => {
  await makeEntrant({ email: 'next@example.com' });
  await http.postForm('/entrant/login', { email: 'next@example.com', next: '/c/some-cup' });
  const link = linkOf(mailer.outbox[0]);
  assert.match(link, /next=%2Fc%2Fsome-cup/);
  const page = await (await http.get(pathOf(link))).text();
  assert.match(page, /name="next" value="\/c\/some-cup"/);
  const token = new URL(link).searchParams.get('token');
  const res = await http.postForm('/entrant/link', { token, next: '/c/some-cup' });
  assert.equal(res.headers.get('location'), '/c/some-cup');

  mailer.outbox.clear();
  await query('DELETE FROM login_links');
  await http.postForm('/entrant/login', { email: 'next@example.com', next: 'https://evil.example/' });
  assert.ok(!linkOf(mailer.outbox[0]).includes('next='), 'an off-site next never enters the link');
  const t2 = new URL(linkOf(mailer.outbox[0])).searchParams.get('token');
  const evil = await http.postForm('/entrant/link', { token: t2, next: '//evil.example' });
  assert.equal(evil.headers.get('location'), '/entrant');
});

test('信件語言跟著請求語言 / the mail follows the request locale', async () => {
  await makeEntrant({ email: 'lang@example.com' });
  await http.postForm('/entrant/login?lang=en', { email: 'lang@example.com' }, { headers: { 'accept-language': 'en' } });
  const mail = mailer.outbox[0];
  assert.match(mail.subject, /sign-in link/);
  assert.match(mail.text, /Hello/);
  assert.ok(!/[一-鿿]/.test(mail.text));

  mailer.outbox.clear();
  await query('DELETE FROM login_links');
  await http.postForm('/entrant/login', { email: 'lang@example.com' }, { headers: { 'accept-language': 'zh-TW' } });
  assert.match(mailer.outbox[0].text, /請點下面的連結/);
});

test('連結登入會解除「必須改密碼」 / signing in by link lifts a forced password change', async () => {
  const who = await makeEntrant({ email: 'reset@example.com' });
  await entrants.resetPassword(who.entrant.id);
  await http.postForm('/entrant/login', { email: 'reset@example.com' });
  const token = new URL(linkOf(mailer.outbox[0])).searchParams.get('token');
  const login = await http.postForm('/entrant/link', { token });
  assert.equal((await entrants.getEntrant(who.entrant.id)).must_change_password, false);
  assert.equal((await http.get('/entrant', { headers: { cookie: cookieOf(login) } })).status, 200);
});

test('密碼模式不受影響 / password mode is untouched when mail is off', async () => {
  config.mail.setMode('off');
  const signup = await http.postForm('/entrant/signup', { email: 'pw@example.com', password: 'passw0rd!' });
  assert.equal(signup.status, 303);
  assert.match(cookieOf(signup), /^stagerank_entrant=/);
  const bad = await http.postForm('/entrant/login', { email: 'pw@example.com', password: 'wrong-password' });
  assert.equal(bad.status, 400);
  const good = await http.postForm('/entrant/login', { email: 'pw@example.com', password: 'passw0rd!' });
  assert.equal(good.status, 303);
  assert.equal(mailer.outbox.length, 0);
});

test('SMTP 模式：真的用 nodemailer 送到 SMTP 伺服器 / smtp mode really delivers through nodemailer', async () => {
  const net = await import('node:net');
  let received = '';
  const smtp = net.createServer((socket) => {
    let inData = false;
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString();
      if (inData) {
        received += text;
        if (received.includes('\r\n.\r\n')) {
          inData = false;
          socket.write('250 queued\r\n');
        }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        if (/^EHLO|^HELO/i.test(line)) socket.write('250 fake\r\n');
        else if (/^DATA/i.test(line)) { inData = true; socket.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  const { port } = smtp.address();
  const original = { smtpUrl: config.mail.smtpUrl, from: config.mail.from };
  try {
    config.mail.smtpUrl = `smtp://127.0.0.1:${port}`;
    config.mail.from = 'noreply@example.org';
    config.mail.setMode('smtp');
    assert.equal(config.mail.enabled, true);
    const info = await mailer.sendMail({ to: 'someone@example.com', subject: 'Real subject', text: 'Real body line' });
    assert.equal(info.mode, 'smtp');
    assert.match(received, /Real subject/);
    assert.match(received, /Real body line/);
    assert.equal(mailer.outbox.length, 0, 'not the memory outbox');
  } finally {
    Object.assign(config.mail, original);
    config.mail.setMode('off');
    await new Promise((resolve) => smtp.close(resolve));
  }
});
