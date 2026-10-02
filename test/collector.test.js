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
  payments: [{ provider: 'ecpay', count: 3, total_cents: 90000, with_partner_id: 0 }],
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
  assert.match(html, /<strong>2<\/strong>/, 'two competitions counted, the repeat replaced');
  assert.match(html, /<strong>17<\/strong>/, '12 + 5 entries');
});
