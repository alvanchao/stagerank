// 重拍說明文件用的截圖（全部是假資料）：首頁、報名、英文版、主辦登入與後台、範本。
// Re-takes the README screenshots on fake data: home, registration, English, organiser sign-in and back office, template page.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgres://postgres:devpass@127.0.0.1:5432/stagerank_demo';
process.env.SITE_NAME = '陽光盃國標舞錦標賽';
process.env.BASE_URL = 'http://127.0.0.1:4174';
process.env.ADMIN_TOKEN = 'demo-token';
process.env.STAGERANK_REPORT_USAGE = 'false';
process.env.ECPAY_ENABLED = 'true';
process.env.ECPAY_SANDBOX = 'true';
process.env.ECPAY_MERCHANT_ID = '3002607';
process.env.ECPAY_HASH_KEY = 'pwFHCqoQZGmho4w6';
process.env.ECPAY_HASH_IV = 'EkRm7iFT261dpevs';
process.env.MAIL_MODE = 'pretend';

const { migrate, truncateAll } = await import('../src/db/migrate.js');
const { createApp } = await import('../src/app.js');
const comps = await import('../src/services/competitions.js');
const entrants = await import('../src/services/entrants.js');
const roster = await import('../src/services/athletes.js');
const setup = await import('../src/services/setup.js');
const { closePool } = await import('../src/db/index.js');

const out = path.resolve('docs/shots');
fs.mkdirSync(out, { recursive: true });
await migrate({ log: () => {} });
await truncateAll();

const competition = await comps.createCompetition({ name: '2026 陽光盃國標舞錦標賽', slug: 'sunshine-2026', currency: 'TWD', feeCents: 1200, status: 'open' });
for (const [i, name] of ['U12 拉丁', 'U15 拉丁', 'U15 摩登', '成人拉丁'].entries()) {
  await comps.addDivision({ competitionId: competition.id, name, sortOrder: i + 1 });
}
const demo = (await entrants.signUpByEmail({ email: 'teacher@example.com', unitName: '晨光舞蹈教室' })).entrant;
await roster.addAthlete({ entrantId: demo.id, name: '王小明', birthDate: '2011-05-04' }).catch(() => {});

const server = await new Promise((resolve) => { const s = createApp().listen(4174, '127.0.0.1', () => resolve(s)); });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const B = 'http://127.0.0.1:4174';
const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true }); console.log('shot', name); };

try {
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
  const zh = await browser.newContext({ ...phone, locale: 'zh-TW', extraHTTPHeaders: { 'Accept-Language': 'zh-TW,zh;q=0.9' } });
  let p = await zh.newPage();
  await p.goto(`${B}/`); await shot(p, '01-home-zh');

  await zh.addCookies([{ name: entrants.ENTRANT_COOKIE, value: entrants.makeToken(demo.id), url: B }]);
  await p.goto(`${B}/c/sunshine-2026`); await shot(p, '02-register-zh');

  const en = await browser.newContext({ ...phone, locale: 'en-GB', extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' } });
  await en.addCookies([{ name: entrants.ENTRANT_COOKIE, value: entrants.makeToken(demo.id), url: B }]);
  p = await en.newPage(); await p.goto(`${B}/c/sunshine-2026`); await shot(p, '03-register-en');

  const desk = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: 'zh-TW' });
  p = await desk.newPage();
  await p.goto(`${B}/admin`); await shot(p, '05-admin-login');
  await desk.addCookies([{ name: 'stagerank_admin', value: 'demo-token', url: B }]);
  await p.goto(`${B}/admin`); await shot(p, '06-admin-index');
  await p.goto(`${B}/admin/c/${competition.id}/setup`); await shot(p, '26-setup-template');
} finally {
  await browser.close(); server.close(); await closePool();
}
