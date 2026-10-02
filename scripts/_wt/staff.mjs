import { resetDatabase, startServer } from '../../test/helpers.js';
import { chromium } from 'playwright';
const { createApp } = await import('../../src/app.js');
const comps = await import('../../src/services/competitions.js');
const regs = await import('../../src/services/registrations.js');
const voucher = await import('../../src/services/voucher.js');
const schedule = await import('../../src/services/schedule.js');
const floor = await import('../../src/services/floor.js');
const { closePool } = await import('../../src/db/index.js');
await resetDatabase();
const http = await startServer(createApp());
const c = await comps.createCompetition({ name: '示範盃', feeCents: 0, status: 'open' });
const dv = await comps.addDivision({ competitionId: c.id, name: '成人拉丁', sortOrder: 1 });
const cha = await schedule.addDance({ competitionId: c.id, name: 'Cha Cha', sortOrder: 1 });
await schedule.setDivisionDances(dv.id, [cha.id]);
for (let i = 1; i <= 4; i += 1) await regs.register({ competitionId: c.id, divisionId: dv.id, athleteName: `選手${i}` });
const s = await voucher.settle(c.id); await schedule.assignBibs(s.voucher.code);
const r = await schedule.createRound({ divisionId: dv.id, name: '決賽', heatSize: 10, scoringMode: 'mark', advanceCount: 2 });
await schedule.seedFirstRound(s.voucher.code, r.id);
const heats = await schedule.buildHeats(r.id, cha.id); await schedule.rebuildRunningOrder(c.id);
const { entries } = await schedule.heatWithEntries(heats[0].id);
for (const e of entries.slice(1)) await floor.checkIn(e.id);

const OUT = '/mnt/user-data/outputs/walkthrough';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const phone = { width: 390, height: 800 };
const admin = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
await admin.goto(`${http.base}/admin`); await admin.fill('input[name=token]', 'test-admin-token'); await admin.click('button[type=submit]');
await admin.goto(`${http.base}/admin/c/${c.id}/staff`);
await admin.selectOption('select[name=role]', 'host');
await admin.fill('textarea[name=names]', '主持人小明\n主持人小華');
await admin.click('button[type=submit]');
await admin.waitForLoadState('networkidle');
await admin.screenshot({ path: `${OUT}/22-主辦-一次產生兩位主持人的碼與QR.png`, fullPage: true });
const codes = await admin.locator('code.voucher').allInnerTexts();

// 1 普通瀏覽器：要求先安裝
const web = await (await browser.newContext({ viewport: phone })).newPage();
await web.goto(`${http.base}/staff/app`);
await web.screenshot({ path: `${OUT}/23-工作人員App-普通瀏覽器要求先安裝.png`, fullPage: true });
await web.fill('#code', codes[0]); await web.click('#login button[type=submit]');
await web.screenshot({ path: `${OUT}/24-普通瀏覽器登入被擋.png`, fullPage: true });

// 2 已安裝(模擬)：登入成功，進主持人畫面
const ctx = await browser.newContext({ viewport: phone });
await ctx.addInitScript(() => { const o = window.matchMedia.bind(window); window.matchMedia = (q) => q.includes('standalone') ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : o(q); });
const app = await ctx.newPage();
await app.goto(`${http.base}/staff/app?code=${codes[0]}`);
await app.screenshot({ path: `${OUT}/25-已安裝App-掃描後帶入通行碼.png`, fullPage: true });
await app.click('#login button[type=submit]'); await app.waitForLoadState('networkidle');
await app.screenshot({ path: `${OUT}/26-登入後直接進主持人畫面.png`, fullPage: true });

// 3 同一組碼第二次
const again = await (await browser.newContext({ viewport: phone })).newPage();
await again.addInitScript(() => { window.matchMedia = (q) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }); });
await again.goto(`${http.base}/staff/app`); await again.fill('#code', codes[0]); await again.click('#login button[type=submit]');
await again.screenshot({ path: `${OUT}/27-同一組碼第二次用-已作廢.png`, fullPage: true });

// 4 主持人做一件事，主辦看紀錄；再停用他
await app.locator('form[action$="/next"] button, form[action$="/start"] button').first().click().catch(() => {});
await app.waitForLoadState('networkidle');
await admin.goto(`${http.base}/admin/c/${c.id}/staff`);
await admin.screenshot({ path: `${OUT}/28-主辦-狀態與操作紀錄.png`, fullPage: true });
await admin.locator('form[action$="/revoke"] button').first().click();
await app.goto(`${http.base}/host/${c.id}`);
await app.screenshot({ path: `${OUT}/29-被停用後立刻被登出.png`, fullPage: true });
await browser.close(); await http.close(); await closePool();
