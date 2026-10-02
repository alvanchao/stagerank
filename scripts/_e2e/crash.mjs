import { resetDatabase, startServer } from '../../test/helpers.js';
const { createApp } = await import('../../src/app.js');
const { closePool } = await import('../../src/db/index.js');
await resetDatabase();
const http = await startServer(createApp());
const hits = [];
let current = '';
process.on('unhandledRejection', (e) => { hits.push({ url: current, err: String(e.message).split('\n')[0] }); });
const H = { Cookie: 'stagerank_admin=test-admin-token' };
const urls = ['/results/nope', '/results/nope/bib?bib=1', '/c/nope', '/r/999', '/admin/c/99999', '/admin/c/99999/schedule', '/admin/c/99999/results', '/admin/c/99999/export/bibs.xlsx', '/admin/c/99999/export/order.xlsx', '/admin/c/99999/export/lists.xlsx', '/admin/c/99999/staff', '/admin/c/99999/setup', '/desk/99999', '/checkin/99999', '/host/99999', '/judge/99999'];
for (const u of urls) {
  current = u;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  let st;
  try { const r = await fetch(http.base + u, { headers: H, signal: ctl.signal }); st = r.status; await r.text(); } catch (e) { st = 'HANG/ERR ' + e.name; }
  clearTimeout(t);
  await new Promise((r) => setTimeout(r, 300));
  console.log(u, st);
}
console.log('UNHANDLED', JSON.stringify(hits, null, 1));
await http.close(); await closePool(); process.exit(0);
