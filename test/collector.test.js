import { resetDatabase, startServer } from './helpers.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

// 收集端：預設關閉；打開後接收匿名統計、重複回報不重複計算、只有主辦看得到合計。
// Collector: off by default; when on it takes anonymous reports, counts repeats once, and only the organiser sees totals.

const { default: config } = await import('../src/config.js');
config.collector.enabled = true;
const { createApp } = await import('../src/app.js');
const { closePool } = await import('../src/db/index.js');
let http;
before(async () => { await resetDatabase(); http = await startServer(createApp()); });
after(async () => { await http.close(); await closePool(); });

const report = (hash, count) => ({
  schema: 'stagerank.usage.v1', app: { version: '1' }, site: { url: 'https://a.example' },
  competition: { id_hash: hash, entry_count: count, total_cents: 100000, currency: 'TWD' },
  payments: [
    { provider: 'ecpay', sandbox: false, count: 3, total_cents: 90000, with_partner_id: 2 },
    { provider: 'ecpay', sandbox: true, count: 5, total_cents: 5000, with_partner_id: 0 },
  ],
});
const post = (body) => fetch(`${http.base}/usage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('收集端收報告、重複不灌高、壞資料擋掉、合計只給主辦 / accepts, dedupes, rejects junk, totals organiser-only', async () => {
  assert.equal((await post(report('h1', 10))).status, 200);
  assert.equal((await post(report('h1', 12))).status, 200);
  assert.equal((await post(report('h2', 5))).status, 200);
  assert.equal((await post({ schema: 'nope' })).status, 400);
  assert.equal((await post({ ...report('h3', 1), site: { url: 'javascript:x' } })).status, 400);

  const anon = await fetch(`${http.base}/admin/usage`);
  const anonHtml = await anon.text();
  assert.ok(!anonHtml.includes('<strong>17</strong>'), 'anonymous visitors do not see the totals');

  const page = await fetch(`${http.base}/admin/usage`, { headers: { Cookie: 'stagerank_admin=test-admin-token' } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<strong>2<\/strong>/, 'two competitions with live payments, the repeat replaced');
  assert.match(html, /<strong>17<\/strong>/, '12 + 5 entries');
  assert.match(html, /<td>ecpay<\/td><td>TWD<\/td><td>6<\/td>/, 'live: two reports of 3 payments');
  assert.match(html, /<td>ecpay<\/td><td>TWD<\/td><td>10<\/td>/, 'test payments listed apart (5 per report)');
  assert.ok(!/<td>6<\/td><td>[^<]*<\/td><td>[^<]*<\/td><td>6<\/td>/.test(html));
});

test('付款成功即送：最新匯總送到收集端、同一場覆蓋不重複 / a successful payment sends the latest summary; same competition replaces', async () => {
  const { default: cfg } = await import('../src/config.js');
  const comps = await import('../src/services/competitions.js');
  const regs = await import('../src/services/registrations.js');
  const { one, many } = await import('../src/db/index.js');
  const { makeEntrant } = await import('./helpers.js');
  cfg.telemetry.enabled = true;
  cfg.telemetry.endpointOverride = `${http.base}/usage`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const competition = await comps.createCompetition({ name: 'Pay Cup', feeCents: 1200, status: 'open', currency: 'TWD' });
    const division = await comps.addDivision({ competitionId: competition.id, name: 'Solo', sortOrder: 1, memberMin: 1, memberMax: 1 });
    let n = 0;
    const pay = async () => {
      n += 1;
      const me = await makeEntrant({ email: `t${n}@example.com` });
      await regs.register({ competitionId: competition.id, divisionId: division.id, athleteIds: [me.athletes[0].id], entrantId: me.entrant.id, provider: 'ecpay' });
      const p = await one("SELECT * FROM payments WHERE status = 'created' ORDER BY id DESC LIMIT 1");
      const res = await regs.applyPaymentResult({ provider: p.provider, providerOrderId: p.provider_order_id, providerTxnId: `T${p.id}`, paid: true, amountCents: p.amount_cents, raw: {} });
      assert.equal(res.paid, true);
    };
    await pay();
    await sleep(400);
    let rows = await many("SELECT payload FROM usage_received WHERE site_url = $1", [cfg.baseUrl]);
    assert.equal(rows.length, 1, 'first payment reaches the collector');
    assert.equal(rows[0].payload.competition.entry_count, 1);
    await pay();
    await sleep(400);
    rows = await many("SELECT payload FROM usage_received WHERE site_url = $1", [cfg.baseUrl]);
    assert.equal(rows.length, 1, 'second payment replaces, not adds');
    assert.equal(rows[0].payload.competition.entry_count, 2);
    assert.equal(rows[0].payload.payments[0].count, 2);
    assert.equal(rows[0].payload.payments[0].sandbox, true, 'sandbox payments are marked as test');
  } finally {
    cfg.telemetry.enabled = false;
    cfg.telemetry.endpointOverride = '';
  }
});
