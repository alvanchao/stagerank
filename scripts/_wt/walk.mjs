import '../../test/helpers.js';
import { resetDatabase, startServer } from '../../test/helpers.js';
import { chromium } from 'playwright';
const { createApp } = await import('../../src/app.js');
const comps = await import('../../src/services/competitions.js');
const regs = await import('../../src/services/registrations.js');
const voucher = await import('../../src/services/voucher.js');
const schedule = await import('../../src/services/schedule.js');
const judgeService = await import('../../src/services/judges.js');
const floor = await import('../../src/services/floor.js');
const scoring = await import('../../src/services/scoring.js');
const staffCodes = await import('../../src/services/staffCodes.js');
const { closePool, many } = await import('../../src/db/index.js');

const OUT = '/mnt/user-data/outputs/walkthrough';
await resetDatabase();
const http = await startServer(createApp());
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function build(name, n, withStd) {
  const c = await comps.createCompetition({ name, feeCents: 0, status: 'open' });
  const latin = await comps.addDivision({ competitionId: c.id, name: '成人拉丁', sortOrder: 1 });
  const cha = await schedule.addDance({ competitionId: c.id, name: 'Cha Cha', sortOrder: 1 });
  const samba = await schedule.addDance({ competitionId: c.id, name: 'Samba', sortOrder: 2 });
  await schedule.setDivisionDances(latin.id, [cha.id, samba.id]);
  let std = null;
  if (withStd) {
    std = await comps.addDivision({ competitionId: c.id, name: '成人標準', sortOrder: 2 });
    const waltz = await schedule.addDance({ competitionId: c.id, name: 'Waltz', sortOrder: 3 });
    await schedule.setDivisionDances(std.id, [waltz.id]);
  }
  for (let i = 1; i <= n; i += 1) await regs.register({ competitionId: c.id, divisionId: latin.id, athleteName: `選手${i}`, athleteEmail: `p${i}@example.com` });
  if (std) for (let i = 1; i <= 4; i += 1) await regs.register({ competitionId: c.id, divisionId: std.id, athleteName: `選手${i}`, athleteEmail: `p${i}@example.com` });
  const settled = await voucher.settle(c.id);
  await schedule.assignBibs(settled.voucher.code);
  return { c, latin, std, cha, samba, voucher: settled.voucher };
}

const A = await build('模擬盃 A（14人）', 14, true);
const B = await build('模擬盃 B（6人，同一批人名）', 6, false);

const semi = await schedule.createRound({ divisionId: A.latin.id, name: '準決賽', sortOrder: 1, heatSize: 7, scoringMode: 'mark', advanceCount: 6 });
const fin = await schedule.createRound({ divisionId: A.latin.id, name: '決賽', sortOrder: 2, heatSize: 7, scoringMode: 'rank', rankMethod: 'skating' });
await schedule.seedFirstRound(A.voucher.code, semi.id);
const judges = [];
for (let i = 1; i <= 5; i += 1) {
  const j = await judgeService.addJudge({ competitionId: A.c.id, name: `裁判${i}` });
  await judgeService.assignToDivision(j.id, A.latin.id);
  judges.push(j);
}
const chaHeats = await schedule.buildHeats(semi.id, A.cha.id);
const sambaHeats = await schedule.buildHeats(semi.id, A.samba.id);
await schedule.rebuildRunningOrder(A.c.id);
const codes = await staffCodes.issueAll(A.c.id);

let n = 0;
async function shot(page, name) {
  n += 1;
  const f = `${OUT}/${String(n).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: f, fullPage: true });
  console.log('shot', f);
}
const desk = { width: 1000, height: 700 };
const phone = { width: 390, height: 800 };

// 主辦
const admin = await (await browser.newContext({ viewport: desk })).newPage();
await admin.goto(`${http.base}/admin`);
await admin.fill('input[name=token]', 'test-admin-token');
await admin.click('button[type=submit]');
await admin.waitForLoadState('networkidle');
await shot(admin, '主辦後台-兩場比賽');
await admin.goto(`${http.base}/admin/c/${A.c.id}`);
await shot(admin, 'A場-報名名單與通行碼區塊');
for (const role of ['desk', 'checkin', 'host']) {
  await admin.goto(`${http.base}/admin/c/${A.c.id}`);
  await admin.locator(`form[action$="/staff-code"]:has(input[value="${role}"]) button`).click();
  await admin.waitForLoadState('networkidle');
  const shown = await admin.locator('.notice code.voucher').first().innerText();
  codes[role] = shown;
}
await shot(admin, '重新產生通行碼-只顯示一次(最後一組)');
await admin.goto(`${http.base}/admin/c/${A.c.id}/schedule`);
await shot(admin, 'A場-賽程與背號');
await admin.goto(`${http.base}/admin/c/${B.c.id}`);
await shot(admin, 'B場-同一批人名，各自獨立');

// 報到（換一組新密碼後登入）
const deskP = await (await browser.newContext({ viewport: phone })).newPage();
await deskP.goto(`${http.base}/desk/${A.c.id}`);
await shot(deskP, '報到-沒登入時的畫面');
await deskP.selectOption('select[name=role]', 'desk');
await deskP.fill('input[name=token]', codes.desk);
await deskP.click('button[type=submit]');
await deskP.waitForLoadState('networkidle');
await shot(deskP, '報到-登入後');
const wrong = await (await browser.newContext({ viewport: phone })).newPage();
await wrong.goto(`${http.base}/desk/${A.c.id}`);
await wrong.selectOption('select[name=role]', 'desk');
await wrong.fill('input[name=token]', codes.host);
await wrong.click('button[type=submit]');
await shot(wrong, '報到-用主持人密碼被擋');

// 點錄：第一批有人沒報到
const { entries } = await schedule.heatWithEntries(chaHeats[0].id);
for (const e of entries.slice(2)) await floor.checkIn(e.id);
const ck = await (await browser.newContext({ viewport: phone })).newPage();
await ck.goto(`${http.base}/checkin/${A.c.id}`);
await ck.selectOption('select[name=role]', 'checkin');
await ck.fill('input[name=token]', codes.checkin);
await ck.click('button[type=submit]');
await ck.waitForLoadState('networkidle');
await shot(ck, '點錄-兩人沒報到(反灰)');
// 點錄密碼進不了主持人頁
await ck.goto(`${http.base}/host/${A.c.id}`);
await shot(ck, '點錄密碼進主持人頁-被擋');

// 主持人
const host = await (await browser.newContext({ viewport: phone })).newPage();
await host.goto(`${http.base}/host/${A.c.id}`);
await host.selectOption('select[name=role]', 'host');
await host.fill('input[name=token]', codes.host);
await host.click('button[type=submit]');
await host.waitForLoadState('networkidle');
await shot(host, '主持人-開賽前');
await floor.checkIn(entries[0].id); // 晚到的人補點
await floor.markAbsent(entries[1].round_entry_id);
await floor.nextHeat(A.c.id, { heatId: chaHeats[0].id });
await floor.startHeat(chaHeats[0].id);
await host.goto(`${http.base}/host/${A.c.id}`);
await shot(host, '主持人-第一批進行中(補點與缺席後)');
await host.goto(`${http.base}/admin/c/${A.c.id}`);
await shot(host, '主持人密碼進主辦後台-被擋');

// 裁判
const jp = await (await browser.newContext({ viewport: phone })).newPage();
await jp.goto(`${http.base}/judge`);
await jp.fill('#code', judges[0].login_code);
await jp.click('button[type=submit]');
await jp.waitForLoadState('networkidle');
await shot(jp, '裁判-評分畫面(只看得到已檢錄的人)');
for (const j of judges) {
  const vis = await judgeService.heatEntriesForJudge(chaHeats[0].id, j.id);
  await scoring.submitScores(chaHeats[0].id, j.id, { marks: vis.slice(0, 6).map((e) => e.round_entry_id) });
}
await host.goto(`${http.base}/host/${A.c.id}`);
await shot(host, '主持人-五位裁判都送出後');

// 跑完其餘的批次並算成績
async function runHeat(heat, choose) {
  const { entries: es } = await schedule.heatWithEntries(heat.id);
  for (const e of es) await floor.checkIn(e.id);
  await floor.nextHeat(A.c.id, { heatId: heat.id });
  await floor.startHeat(heat.id);
  for (const j of judges) {
    const vis = await judgeService.heatEntriesForJudge(heat.id, j.id);
    await scoring.submitScores(heat.id, j.id, choose(vis));
  }
}
const all = await many('SELECT * FROM round_entries WHERE round_id = $1 ORDER BY bib_number', [semi.id]);
const top6 = new Set(all.slice(0, 6).map((e) => String(e.id)));
const pick = (vis) => ({ marks: vis.filter((e) => top6.has(String(e.round_entry_id))).map((e) => e.round_entry_id) });
for (const h of [chaHeats[1], ...sambaHeats]) await runHeat(h, pick);
await floor.nextHeat(A.c.id);
await scoring.computeRound(semi.id);
await scoring.seedNextRound(semi.id, fin.id);
const fc = await schedule.buildHeats(fin.id, A.cha.id);
const fs = await schedule.buildHeats(fin.id, A.samba.id);
await schedule.rebuildRunningOrder(A.c.id);
const byBib = (vis) => {
  const o = [...vis].sort((x, y) => x.bib_number - y.bib_number);
  return { ranks: Object.fromEntries(o.map((e, i) => [e.round_entry_id, i + 1])) };
};
for (const h of [...fc, ...fs]) await runHeat(h, byBib);
await floor.nextHeat(A.c.id);
const result = await scoring.computeRound(fin.id);

const pub = await (await browser.newContext({ viewport: phone })).newPage();
await pub.goto(`${http.base}/results/${A.c.slug}`);
await shot(pub, '成績-公告前(選手看不到)');
await admin.goto(`${http.base}/admin/c/${A.c.id}/results`);
await shot(admin, '主辦-成績與公告按鈕');
await scoring.publishRound(fin.id);
await pub.goto(`${http.base}/results/${A.c.slug}`);
await shot(pub, '成績-公告後');
await pub.goto(`${http.base}/results/${A.c.slug}/bib?bib=${result.ranked[0].bib}`);
await shot(pub, '選手用背號查自己(冠軍)');

for (const [kind, lang] of [['bibs','zh-TW'],['order','zh-TW'],['bibs','en']]) {
  const r = await admin.request.get(`${http.base}/admin/c/${A.c.id}/export/${kind}.xlsx?lang=${lang}`);
  const fs = await import('node:fs');
  fs.writeFileSync(`/mnt/user-data/outputs/${kind}-${lang}.xlsx`, await r.body());
}
await admin.goto(`${http.base}/admin/c/${A.c.id}/schedule`);
await shot(admin, '賽程頁-匯出按鈕');
await browser.close();
await http.close();
await closePool();
