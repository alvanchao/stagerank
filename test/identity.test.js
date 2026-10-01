// 統一登出、依身分顯示選單、首頁不顯示金額。
// One sign-out, a menu per identity, no fee on the home page.
import { resetDatabase, startServer, makeEntrant } from './helpers.js';
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/app.js');
const comps = await import('../src/services/competitions.js');
const { closePool } = await import('../src/db/index.js');

let http;
before(async () => { await resetDatabase(); http = await startServer(createApp()); });
after(async () => { await http.close(); await closePool(); });
beforeEach(resetDatabase);

const nav = async (cookie) => {
  const html = await (await http.get('/', { headers: cookie ? { cookie } : {} })).text();
  return {
    admin: html.includes('href="/admin"'),
    entrant: html.includes('href="/entrant"'),
    logout: html.includes('action="/logout"'),
  };
};

test('選單依身分：訪客、報名者、主辦各看各的 / menu differs per identity', async () => {
  assert.deepEqual(await nav(), { admin: false, entrant: true, logout: false });
  const who = await makeEntrant({ email: 'n@example.com', people: [{ name: 'N', birthDate: '2000-01-01' }] });
  assert.deepEqual(await nav(who.cookie), { admin: false, entrant: true, logout: true });
  const login = await http.postForm('/admin/login', { token: 'test-admin-token' });
  const admin = login.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await nav(admin), { admin: true, entrant: false, logout: true });
});

test('統一登出清掉所有身分 / /logout clears every identity', async () => {
  const res = await http.postForm('/logout', {});
  assert.equal(res.status, 303);
  const cookies = res.headers.getSetCookie().join('\n');
  for (const name of ['stagerank_admin', 'stagerank_staff', 'stagerank_judge', 'stagerank_entrant']) {
    assert.match(cookies, new RegExp(`${name}=;`), `${name} cleared`);
  }
});

test('登入新身分會先登出舊身分 / signing in as someone new clears the old identity', async () => {
  const res = await http.postForm('/admin/login', { token: 'test-admin-token' });
  const cookies = res.headers.getSetCookie().join('\n');
  assert.match(cookies, /stagerank_admin=test-admin-token/);
  assert.ok(res.headers.get('set-cookie').startsWith('stagerank_admin=test-admin-token'), 'session cookie first');
  assert.match(cookies, /stagerank_entrant=;/);
  assert.match(cookies, /stagerank_judge=;/);
});

test('首頁與比賽頁不顯示金額 / no fee on home or competition header', async () => {
  const c = await comps.createCompetition({ name: 'Fee Cup', feeCents: 10000, status: 'open' });
  await comps.addDivision({ competitionId: c.id, name: 'D1', sortOrder: 1 });
  const home = await (await http.get('/')).text();
  assert.doesNotMatch(home.replace(/<style[\s\S]*?<\/style>/g, ''), /\$\s?100|NT\$|100\.00/);
  const page = await (await http.get(`/c/${c.slug}`)).text();
  assert.doesNotMatch(page, /competition-fee|報名費: /);
});

test('假 Google 登入：名單內才進得去 / pretend Google: only listed emails get in', async () => {
  const { config } = await import('../src/config.js');
  const before = { mock: config.google.mock, emails: config.adminEmails };
  config.google.mock = true;
  config.adminEmails = ['boss@example.com'];
  try {
    const page = await (await http.get('/admin')).text();
    assert.match(page, /href="\/admin\/google"/);
    assert.equal((await http.get('/admin/google')).status, 200);

    const bad = await http.postForm('/admin/google/mock', { email: 'stranger@example.com' });
    assert.equal(bad.status, 403);
    assert.doesNotMatch(bad.headers.get('set-cookie') || '', /stagerank_admin=g\./);

    const ok = await http.postForm('/admin/google/mock', { email: 'Boss@Example.com' });
    assert.equal(ok.status, 303);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^stagerank_admin=g\./);
    const inside = await http.get('/admin', { headers: { cookie } });
    assert.doesNotMatch(await inside.text(), /name="token"/);

    // 偽造或改信箱都不行 / a forged or altered cookie is refused
    const forged = cookie.replace(/=g\.[^.]+/, `=g.${Buffer.from('stranger@example.com').toString('base64url')}`);
    assert.match(await (await http.get('/admin', { headers: { cookie: forged } })).text(), /name="token"/);

    // 名單拿掉信箱，登入立刻失效 / removing the email from the list ends the session
    config.adminEmails = [];
    assert.match(await (await http.get('/admin', { headers: { cookie } })).text(), /name="token"/);
  } finally {
    config.google.mock = before.mock;
    config.adminEmails = before.emails;
  }
});

test('正式模式不啟用假 Google / mock is refused in production', async () => {
  const { config } = await import('../src/config.js');
  const before = config.google.mock;
  config.google.mock = false;
  try {
    const res = await http.postForm('/admin/google/mock', { email: 'boss@example.com' });
    assert.equal(res.status, 303);
    assert.doesNotMatch(res.headers.get('set-cookie') || '', /stagerank_admin=g\./);
  } finally {
    config.google.mock = before;
  }
});

test('config：production 下假 Google 要明確開關 / mock under production needs the explicit switch', async () => {
  const run = (env) => new Promise((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => execFile(
      process.execPath,
      ['--input-type=module', '-e', "const { default: c } = await import('./src/config.js'); console.log(c.google.mock);"],
      { env: { ...process.env, ...env }, cwd: process.cwd() },
      (err, out) => (err ? reject(err) : resolve(out.trim())),
    ));
  });
  assert.equal(await run({ GOOGLE_LOGIN_MOCK: 'true', NODE_ENV: 'production', ALLOW_MOCK_IN_PRODUCTION: '' }), 'false');
  assert.equal(await run({ GOOGLE_LOGIN_MOCK: 'true', NODE_ENV: 'production', ALLOW_MOCK_IN_PRODUCTION: 'true' }), 'true');
  assert.equal(await run({ GOOGLE_LOGIN_MOCK: 'true', NODE_ENV: 'development', ALLOW_MOCK_IN_PRODUCTION: '' }), 'true');
  assert.equal(await run({ GOOGLE_LOGIN_MOCK: '', NODE_ENV: 'development', ALLOW_MOCK_IN_PRODUCTION: 'true' }), 'false');
});
