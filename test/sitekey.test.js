import { resetDatabase, startServer } from './helpers.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// 網站金鑰：產生一次、只放雜湊給外面看；回報送出時才帶上；403 會提示主辦；重試有上限。
// Site key: generated once, only its hash is public; attached at send time; 403 warns the organiser; retries are capped.

const { default: config } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
const { one, query, closePool } = await import('../src/db/index.js');
const stats = await import('../src/services/stats.js');
let http;
before(async () => { await resetDatabase(); http = await startServer(createApp()); });
after(async () => { await http.close(); await closePool(); });

const sha = (t) => createHash('sha256').update(t).digest('hex');
const payloadOf = (hash = 'abcdef12') => ({
  schema: 'stagerank.usage.v1', app: { version: '1' }, site: { url: 'https://a.example' },
  competition: { id_hash: hash, entry_count: 1, total_cents: 100, currency: 'TWD' }, payments: [],
});

test('金鑰只產生一次、夠長、是隨機的 / the key is made once, long enough, and random-looking', async () => {
  const a = await stats.getSiteKey();
  const b = await stats.getSiteKey();
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{22,64}$/);
});

test('驗證檔只放雜湊、不轉址、不快取 / the proof file holds only the hash, never redirects, never cached', async () => {
  const key = await stats.getSiteKey();
  const res = await fetch(`${http.base}/.well-known/stagerank-usage.json`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { key_hash: sha(key) });
  assert.ok(!text.includes(key), 'the key itself is never published');
});

test('送出時才帶金鑰，待送的紀錄不存金鑰 / the key is attached only when sending; queued rows never hold it', async () => {
  config.telemetry.enabled = true;
  config.telemetry.endpointOverride = 'https://collector.invalid/usage';
  try {
    await stats.queueReport(payloadOf());
    const stored = await one('SELECT payload FROM usage_reports ORDER BY id DESC LIMIT 1');
    assert.equal(stored.payload.site.key, undefined);
    let sentBody = null;
    const fetchImpl = async (url, init) => { sentBody = JSON.parse(init.body); return { ok: true, status: 200 }; };
    const result = await stats.flushReports({ fetchImpl });
    assert.equal(result.sent, 1);
    assert.equal(sentBody.site.key, await stats.getSiteKey());
    assert.equal(sentBody.site.url, 'https://a.example');
  } finally {
    config.telemetry.enabled = false;
  }
});

test('重試有上限，超過 14 天就不再送 / retries stop after 14 days', async () => {
  config.telemetry.enabled = true;
  config.telemetry.endpointOverride = 'https://collector.invalid/usage';
  try {
    await query('DELETE FROM usage_reports');
    await stats.queueReport(payloadOf('abcdef13'));
    await query("UPDATE usage_reports SET created_at = now() - interval '15 days'");
    let calls = 0;
    const result = await stats.flushReports({ fetchImpl: async () => { calls += 1; return { ok: true, status: 200 }; } });
    assert.equal(calls, 0);
    assert.equal(result.sent, 0);
    await stats.queueReport(payloadOf('abcdef14'));
    const again = await stats.flushReports({ fetchImpl: async () => { calls += 1; return { ok: true, status: 200 }; } });
    assert.equal(again.sent, 1, 'a fresh report is still sent');
  } finally {
    config.telemetry.enabled = false;
  }
});

test('被收集端拒絕（403）時主辦後台會提示 / a 403 from the collector shows a notice to the organiser', async () => {
  config.telemetry.enabled = true;
  config.telemetry.endpointOverride = 'https://collector.invalid/usage';
  try {
    await query('DELETE FROM usage_reports');
    assert.equal(await stats.recentlyRefused(), false);
    await stats.queueReport(payloadOf('abcdef15'));
    await stats.flushReports({ fetchImpl: async () => ({ ok: false, status: 403 }) });
    assert.equal(await stats.recentlyRefused(), true);
    const page = await fetch(`${http.base}/admin`, { headers: { Cookie: 'stagerank_admin=test-admin-token' } });
    const html = await page.text();
    assert.match(html, /stagerank-usage\.json/);
    assert.match(html, /role="alert"/);
  } finally {
    config.telemetry.enabled = false;
  }
});
