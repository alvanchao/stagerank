import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { readLimited, normalizeSite, MAX_BYTES, WELL_KNOWN } from '../src/index.js';

// 用 node:sqlite 假裝 D1 的介面。 / node:sqlite standing in for D1's interface.
function fakeD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind: (...a) => { args = a; return stmt; },
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      run: async () => { sqlite.prepare(sql).run(...args); return {}; },
      _run: () => sqlite.prepare(sql).run(...args),
    };
    return stmt;
  };
  return {
    sqlite,
    prepare,
    batch: async (stmts) => {
      sqlite.exec('BEGIN');
      try { for (const s of stmts) s._run(); sqlite.exec('COMMIT'); } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
      return [];
    },
  };
}

const KEY = 'k'.repeat(24);
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');

// 假的「網站」：每個網址登記它真正放出來的金鑰雜湊（模擬 /.well-known/stagerank-usage.json）。
// Fake "sites": each URL maps to the key hash it really publishes (simulating the .well-known file).
function fakeWeb(map) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const origin = new URL(url).origin;
    if (!map[origin] || !url.endsWith(WELL_KNOWN)) return new Response('no', { status: 404 });
    return new Response(JSON.stringify({ key_hash: await sha(map[origin]) }), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

const report = (over = {}, key = KEY, site = 'https://a.example') => ({
  schema: 'stagerank.usage.v1',
  app: { version: '1' },
  site: { url: site, key },
  competition: { id_hash: 'abcdef12', entry_count: 10, total_cents: 1000, currency: 'TWD' },
  payments: [{ provider: 'ecpay', sandbox: false, count: 10, total_cents: 1000, with_partner_id: 10 }],
  ...over,
});
const post = (env, body, headers = {}) =>
  worker.fetch(new Request('https://x/', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'cf-connecting-ip': '1.1.1.1', ...headers } }), env);
const envOf = (db, extra = {}) => ({ DB: db, VERIFY_FETCH: fakeWeb({ 'https://a.example': KEY, 'https://b.example': KEY }), ...extra });

test('收下合法回報並存歷史 / accepts a valid report and keeps history', async () => {
  const db = fakeD1();
  assert.equal((await post(envOf(db), report())).status, 200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM usage_received').get().c, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM usage_history').get().c, 1);
});

test('只收 POST / only POST', async () => {
  const res = await worker.fetch(new Request('https://x/', { method: 'GET' }), envOf(fakeD1()));
  assert.equal(res.status, 405);
});

test('格式錯誤與缺金鑰被拒 / bad format and missing key are refused', async () => {
  const db = fakeD1();
  assert.equal((await post(envOf(db), 'not json')).status, 400);
  assert.equal((await post(envOf(db), report({ schema: 'x' }))).status, 400);
  assert.equal((await post(envOf(db), report({}, 'short'))).status, 400);
  assert.equal((await post(envOf(db), report({}, 'k'.repeat(21)))).status, 400); // 少於 22 字元 / under 22 chars
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM site_keys').get().c, 0); // 沒碰資料庫 / no database work
});

test('缺比賽代號或格式不對就拒收 / a missing or malformed competition id is refused', async () => {
  const db = fakeD1();
  const noHash = report();
  delete noHash.competition.id_hash;
  assert.equal((await post(envOf(db), noHash)).status, 400);
  assert.equal((await post(envOf(db), report({ competition: { id_hash: 'ZZZ', entry_count: 1 } }))).status, 400);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM usage_received').get().c, 0);
});

test('兩場不同比賽不會互相蓋掉 / two competitions never overwrite each other', async () => {
  const db = fakeD1();
  const env = envOf(db);
  assert.equal((await post(env, report())).status, 200);
  assert.equal((await post(env, report({ competition: { id_hash: 'abcdef13', entry_count: 5, total_cents: 5, currency: 'TWD' } }))).status, 200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM usage_received').get().c, 2);
});

test('網址整理成同一種寫法 / site URLs are normalised', async () => {
  assert.equal(normalizeSite('https://A.Example/'), 'https://a.example');
  assert.equal(normalizeSite('https://a.example/x/y?z=1#f'), 'https://a.example');
  assert.equal(normalizeSite('https://a.example:443/'), 'https://a.example');
  assert.equal(normalizeSite('https://user:pass@a.example'), null);
  assert.equal(normalizeSite('ftp://a.example'), null);
  assert.equal(normalizeSite('http://localhost:3000'), null);
  assert.equal(normalizeSite('https://127.0.0.1'), null);
  assert.equal(normalizeSite('https://[::1]/'), null);
  assert.equal(normalizeSite(`https://${'a'.repeat(210)}.example`), null); // 太長就拒收，不截斷 / too long: refused, not cut
  const db = fakeD1();
  const env = envOf(db);
  assert.equal((await post(env, report({}, KEY, 'https://A.example/'))).status, 200);
  assert.equal((await post(env, report({}, KEY, 'https://a.example/path?x=1'))).status, 200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM site_keys').get().c, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM usage_received').get().c, 1);
});

test('謊報 Content-Length 也擋得住 / a lying Content-Length does not get past the size check', async () => {
  const big = JSON.stringify(report({ pad: 'x'.repeat(MAX_BYTES + 100) }));
  const res = await post(envOf(fakeD1()), big, { 'content-length': '10' });
  assert.equal(res.status, 413);
});

test('分段傳送超過上限也擋 / chunked bodies over the cap are refused', async () => {
  const chunk = new TextEncoder().encode('x'.repeat(8 * 1024));
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 4; i += 1) c.enqueue(chunk); c.close(); } });
  const request = new Request('https://x/', { method: 'POST', body: stream, duplex: 'half' });
  assert.equal((await readLimited(request)).tooLarge, true);
});

test('搶先登記別人的網址會失敗，真網站照常 / squatting someone else\'s URL fails and the real site still works', async () => {
  const db = fakeD1();
  const env = envOf(db); // a.example 真正放的是 KEY / a.example really publishes KEY
  const attackerKey = 'z'.repeat(24);
  assert.equal((await post(env, report({}, attackerKey))).status, 403); // 驗證不過 / verification fails
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM site_keys').get().c, 0);
  assert.equal((await post(env, report({}, KEY))).status, 200); // 真網站不受影響 / the real site is unaffected
});

test('網站沒放驗證檔就不認領 / no verification file, no claim', async () => {
  const db = fakeD1();
  const env = envOf(db, { VERIFY_FETCH: fakeWeb({}) });
  assert.equal((await post(env, report())).status, 403);
});

test('驗證只在第一次抓，之後不再抓 / verification runs once; later reports do not refetch', async () => {
  const db = fakeD1();
  const env = envOf(db);
  await post(env, report());
  await post(env, report());
  assert.equal(env.VERIFY_FETCH.calls.length, 1);
  assert.ok(env.VERIFY_FETCH.calls[0].endsWith(WELL_KNOWN));
});

test('別人拿不同金鑰蓋不掉 / another key cannot overwrite', async () => {
  const db = fakeD1();
  const env = envOf(db);
  await post(env, report());
  const fake = report({ payments: [{ provider: 'ecpay', sandbox: true, count: 1, total_cents: 1, with_partner_id: 0 }] }, 'z'.repeat(24));
  assert.equal((await post(env, fake)).status, 403);
  const stored = JSON.parse(db.sqlite.prepare('SELECT payload FROM usage_received').get().payload);
  assert.equal(stored.payments[0].sandbox, false);
  assert.equal(stored.payments[0].count, 10);
});

test('金鑰只存雜湊 / only the key hash is stored', async () => {
  const db = fakeD1();
  await post(envOf(db), report());
  const row = db.sqlite.prepare('SELECT key_hash FROM site_keys').get();
  assert.notEqual(row.key_hash, KEY);
  assert.match(row.key_hash, /^[0-9a-f]{64}$/);
});

test('數字變少、夥伴代號變少或正式變測試被拒 / lower numbers, fewer partner ids and live-to-test are refused', async () => {
  const db = fakeD1();
  const env = envOf(db);
  await post(env, report());
  const lower = report({ payments: [{ provider: 'ecpay', sandbox: false, count: 3, total_cents: 300, with_partner_id: 3 }] });
  assert.equal((await post(env, lower)).status, 409);
  const fewerPartner = report({ payments: [{ provider: 'ecpay', sandbox: false, count: 10, total_cents: 1000, with_partner_id: 2 }] });
  assert.equal((await post(env, fewerPartner)).status, 409);
  const test2 = report({ payments: [{ provider: 'ecpay', sandbox: true, count: 99, total_cents: 9900, with_partner_id: 0 }] });
  assert.equal((await post(env, test2)).status, 409);
  const more = report({ payments: [{ provider: 'ecpay', sandbox: false, count: 12, total_cents: 1200, with_partner_id: 12 }] });
  assert.equal((await post(env, more)).status, 200);
});

test('每個 IP 限流 / per-IP limit', async () => {
  const db = fakeD1();
  const env = envOf(db, { LIMIT_IP_PER_MIN: '2', LIMIT_SITE_PER_HOUR: '99' });
  assert.equal((await post(env, report())).status, 200);
  assert.equal((await post(env, report())).status, 200);
  assert.equal((await post(env, report())).status, 429);
});

test('每個網站限流 / per-site limit', async () => {
  const db = fakeD1();
  const env = envOf(db, { LIMIT_SITE_PER_HOUR: '1' });
  assert.equal((await post(env, report(), { 'cf-connecting-ip': '1.1.1.1' })).status, 200);
  assert.equal((await post(env, report(), { 'cf-connecting-ip': '2.2.2.2' })).status, 429);
});

test('全域每日上限，超過後只讀不寫 / global daily cap, reads only once reached', async () => {
  const db = fakeD1();
  const env = envOf(db, { LIMIT_GLOBAL_PER_DAY: '1' });
  assert.equal((await post(env, report())).status, 200);
  const before = db.sqlite.prepare('SELECT SUM(count) c FROM rate_limit').get().c;
  assert.equal((await post(env, report({}, KEY, 'https://b.example'), { 'cf-connecting-ip': '3.3.3.3' })).status, 429);
  assert.equal(db.sqlite.prepare('SELECT SUM(count) c FROM rate_limit').get().c, before);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM site_keys').get().c, 1);
});

test('被拒絕的嘗試也計入 IP 次數 / refused attempts count against the IP', async () => {
  const db = fakeD1();
  const env = envOf(db, { LIMIT_IP_PER_MIN: '3', LIMIT_SITE_PER_HOUR: '99' });
  await post(env, report());
  assert.equal((await post(env, report({}, 'z'.repeat(24)))).status, 403);
  assert.equal((await post(env, report({}, 'y'.repeat(24)))).status, 403);
  assert.equal((await post(env, report({}, 'x'.repeat(24)))).status, 429);
});

test('限流表不存 IP 原文 / the rate-limit table never holds a raw IP', async () => {
  const db = fakeD1();
  await post(envOf(db), report(), { 'cf-connecting-ip': '203.0.113.7' });
  const buckets = db.sqlite.prepare('SELECT bucket FROM rate_limit').all().map((r) => r.bucket).join(' ');
  assert.ok(!buckets.includes('203.0.113.7'));
  assert.match(buckets, /ip:[0-9a-f]{16}/);
});

test('過期的限流列會被順手清掉 / expired rate-limit rows are swept', async () => {
  const db = fakeD1();
  db.sqlite.prepare("INSERT INTO rate_limit (bucket, window_start, count) VALUES ('ip:old', 1000, 5)").run();
  await post(envOf(db), report());
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) c FROM rate_limit WHERE bucket = 'ip:old'").get().c, 0);
});

test('資料庫出錯回 503，不洩漏內部訊息 / a database failure gives 503 with no internals', async () => {
  const broken = { prepare() { throw new Error('D1 down: secret detail'); }, batch: async () => { throw new Error('down'); } };
  const res = await post({ DB: broken, VERIFY_FETCH: fakeWeb({}) }, report());
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.ok(!text.includes('secret'));
  assert.deepEqual(JSON.parse(text), { ok: false });
});

test('第一次認領只接受 https / a first claim over plain http is refused', async () => {
  const db = fakeD1();
  const env = envOf(db, { VERIFY_FETCH: fakeWeb({ 'http://a.example': KEY }) });
  assert.equal((await post(env, report({}, KEY, 'http://a.example'))).status, 403);
  assert.equal(env.VERIFY_FETCH.calls.length, 0); // 連驗證都不抓 / not even fetched
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM site_keys').get().c, 0);
});

test('認領失敗不會耗掉該網站與全站的額度 / failed claims never burn the site or global quota', async () => {
  const db = fakeD1();
  const env = envOf(db, { LIMIT_SITE_PER_HOUR: '2', LIMIT_IP_PER_MIN: '99' });
  for (let i = 0; i < 5; i += 1) await post(env, report({}, String.fromCharCode(97 + i).repeat(24)));
  const rows = db.sqlite.prepare("SELECT bucket FROM rate_limit WHERE bucket = 'global' OR bucket LIKE 'site:%'").all();
  assert.equal(rows.length, 0);
  assert.equal((await post(env, report())).status, 200); // 真網站照常 / the real site is unaffected
});
