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

// ---- 第四輪審查補上的測試 / tests added after the fourth review round

const withConfig = async (patch, fn) => {
  const saved = {
    baseUrl: config.baseUrl,
    enabled: config.telemetry.enabled,
    override: config.telemetry.endpointOverride,
    hosts: config.telemetry.allowedHosts,
  };
  Object.assign(config, { baseUrl: patch.baseUrl ?? config.baseUrl });
  config.telemetry.enabled = patch.enabled ?? true;
  config.telemetry.endpointOverride = patch.override ?? '';
  config.telemetry.allowedHosts = patch.hosts ?? [];
  try { await fn(); } finally {
    config.baseUrl = saved.baseUrl;
    config.telemetry.enabled = saved.enabled;
    config.telemetry.endpointOverride = saved.override;
    config.telemetry.allowedHosts = saved.hosts;
  }
};
const configFetch = (endpoint) => async () => ({ ok: true, status: 200, json: async () => ({ endpoint }) });

test('並行第一次產生也拿到同一把金鑰 / two concurrent first calls end up with the same key', async () => {
  await query("DELETE FROM app_settings WHERE key = 'usage.site_key'");
  const keys = await Promise.all([stats.getSiteKey(), stats.getSiteKey(), stats.getSiteKey()]);
  assert.equal(new Set(keys).size, 1);
  assert.equal(keys[0], await stats.getSiteKey());
});

test('抓不到回報網址時，失敗原因有記下來 / when the endpoint cannot be read, the reason is recorded', async () => {
  await withConfig({ baseUrl: 'https://stage.dance-club.org' }, async () => {
    await query('DELETE FROM usage_reports');
    await stats.queueReport(payloadOf('abcdef21'));
    const result = await stats.flushReports({ fetchImpl: async () => ({ ok: false, status: 500 }) });
    assert.equal(result.failed, 1);
    const row = await one('SELECT attempts, last_error FROM usage_reports');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /endpoint: telemetry config 500/);
  });
});

test('設定檔只能指到寫死的 https 收集端 / the config file may only point at a hard-coded https collector', async () => {
  await withConfig({ hosts: ['collector.example'] }, async () => {
    assert.equal(await stats.resolveEndpoint({ fetchImpl: configFetch('https://collector.example/usage') }), 'https://collector.example/usage');
    await assert.rejects(stats.resolveEndpoint({ fetchImpl: configFetch('http://collector.example/usage') }), /not an allowed collector/);
    await assert.rejects(stats.resolveEndpoint({ fetchImpl: configFetch('https://evil.example/usage') }), /not an allowed collector/);
    await assert.rejects(stats.resolveEndpoint({ fetchImpl: configFetch('not a url') }), /not a URL/);
  });
  await withConfig({ hosts: [] }, async () => {
    await assert.rejects(stats.resolveEndpoint({ fetchImpl: configFetch('https://collector.example/usage') }), /not an allowed collector/);
  });
});

test('被拒的收集端網址不會收到任何金鑰 / a refused endpoint never receives the key', async () => {
  await withConfig({ baseUrl: 'https://stage.dance-club.org', hosts: ['collector.example'] }, async () => {
    await query('DELETE FROM usage_reports');
    await stats.queueReport(payloadOf('abcdef22'));
    let posted = 0;
    const fetchImpl = async (url) => {
      if (String(url).endsWith('telemetry.json')) return configFetch('https://evil.example/usage')();
      posted += 1;
      return { ok: true, status: 200 };
    };
    const result = await stats.flushReports({ fetchImpl });
    assert.equal(posted, 0);
    assert.equal(result.sent, 0);
  });
});

test('送出時不跟隨轉址 / the POST never follows redirects', async () => {
  await withConfig({ override: 'https://collector.invalid/usage', baseUrl: 'https://stage.dance-club.org' }, async () => {
    await query('DELETE FROM usage_reports');
    await stats.queueReport(payloadOf('abcdef23'));
    let init = null;
    await stats.flushReports({ fetchImpl: async (url, i) => { init = i; return { ok: true, status: 200 }; } });
    assert.equal(init.redirect, 'error');
  });
});

test('沒有正式網址就不回報 / nothing is reported until BASE_URL is a real https address', async () => {
  const cases = [
    ['http://localhost:3000', false], ['https://localhost', false], ['https://127.0.0.1', false],
    ['http://stage.dance-club.org', false], ['https://[::1]', false], ['https://stage.dance-club.org', true], ['https://a.b.dance-club.org', true],
  ];
  for (const [baseUrl, expected] of cases) {
    await withConfig({ baseUrl }, async () => assert.equal(stats.reportable(), expected, baseUrl));
  }
  await withConfig({ baseUrl: 'http://localhost:3000' }, async () => {
    await query('DELETE FROM usage_reports');
    assert.equal(await stats.queueReport(payloadOf('abcdef24')), null);
    assert.equal((await one('SELECT COUNT(*)::int AS n FROM usage_reports')).n, 0);
  });
  await withConfig({ baseUrl: 'http://localhost:3000', override: 'https://collector.invalid/usage' }, async () => {
    assert.equal(stats.reportable(), true, 'a maintainer test collector is exempt');
  });
});

test('沒設正式網址時後台有提示 / the dashboard says so while BASE_URL is not a real address', async () => {
  await withConfig({ baseUrl: 'http://localhost:3000' }, async () => {
    const page = await fetch(`${http.base}/admin`, { headers: { Cookie: 'stagerank_admin=test-admin-token' } });
    assert.match(await page.text(), /BASE_URL/);
  });
  await withConfig({ baseUrl: 'https://stage.dance-club.org' }, async () => {
    const page = await fetch(`${http.base}/admin`, { headers: { Cookie: 'stagerank_admin=test-admin-token' } });
    assert.ok(!(await page.text()).includes('BASE_URL 必須'));
  });
});

test('保留網域與帶埠號的網址不回報 / reserved domains and URLs with a port are not reported', async () => {
  for (const baseUrl of ['https://stagerank.local', 'https://x.localhost', 'https://x.test', 'https://x.internal',
    'https://x.example', 'https://x.invalid', 'https://stage.dance-club.org:8443', 'https://printer.lan']) {
    await withConfig({ baseUrl }, async () => assert.equal(stats.reportable(), false, baseUrl));
  }
});

test('收集端名單可用 *.帳號.workers.dev 結尾比對，且比對要精確 / suffix entries match precisely', async () => {
  await withConfig({ hosts: ['*.acct.workers.dev', 'collector.example.org'] }, async () => {
    for (const ok of ['stagerank-usage.acct.workers.dev', 'a.b.acct.workers.dev', 'collector.example.org']) {
      assert.equal(stats.hostAllowed(ok), true, ok);
    }
    for (const bad of ['acct.workers.dev', 'x.evilacct.workers.dev', 'acct.workers.dev.evil.com', 'evil.org', 'x.collector.example.org']) {
      assert.equal(stats.hostAllowed(bad), false, bad);
    }
    assert.equal(await stats.resolveEndpoint({ fetchImpl: configFetch('https://stagerank-usage.acct.workers.dev/usage') }), 'https://stagerank-usage.acct.workers.dev/usage');
    await assert.rejects(stats.resolveEndpoint({ fetchImpl: configFetch('https://stagerank-usage.acct.workers.dev:8443/usage') }), /not an allowed collector/);
    await assert.rejects(stats.resolveEndpoint({ fetchImpl: configFetch('https://collector.example.org@evil.com/usage') }), /not an allowed collector/);
    await assert.rejects(stats.resolveEndpoint({ fetchImpl: configFetch('https://evil.com/#@collector.example.org') }), /not an allowed collector/);
  });
});

test('測試收集端也必須是 https（本機例外）/ a test collector must be https unless it is loopback', async () => {
  await withConfig({ override: 'http://collector.example.org/usage' }, async () => {
    assert.equal(stats.reportable(), false);
    await assert.rejects(stats.resolveEndpoint({}), /must be https/);
  });
  for (const ok of ['https://collector.invalid/usage', 'http://127.0.0.1:4000/usage', 'http://localhost:4000/usage']) {
    await withConfig({ override: ok }, async () => {
      assert.equal(stats.reportable(), true, ok);
      assert.equal(await stats.resolveEndpoint({}), ok);
    });
  }
});
