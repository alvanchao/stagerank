// 一場完整的比賽：報名 → 憑證碼 → 背號 → 分批 → 報到 → 檢錄 → 控場 → 評分 → 成績。
// A whole competition end to end, driven through a real browser with screenshots at every step.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgres://postgres:devpass@127.0.0.1:5432/stagerank_demo';
process.env.SITE_NAME = '陽光盃國標舞錦標賽';
process.env.BASE_URL = 'http://127.0.0.1:4180';
process.env.PORT = '4180';
process.env.ADMIN_TOKEN = 'demo-token';
process.env.ECPAY_ENABLED = 'true';
process.env.ECPAY_SANDBOX = 'true';
process.env.ECPAY_MERCHANT_ID = '3002607';
process.env.ECPAY_HASH_KEY = 'pwFHCqoQZGmho4w6';
process.env.ECPAY_HASH_IV = 'EkRm7iFT261dpevs';

const { migrate, truncateAll } = await import('../src/db/migrate.js');
const { createApp } = await import('../src/app.js');
const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const voucherService = await import('../src/services/voucher.js');
const schedule = await import('../src/services/schedule.js');
const judgeService = await import('../src/services/judges.js');
const floor = await import('../src/services/floor.js');
const scoring = await import('../src/services/scoring.js');
const { closePool } = await import('../src/db/index.js');

const shots = path.resolve('docs/shots');
fs.mkdirSync(shots, { recursive: true });

await migrate({ log: () => {} });
await truncateAll();

// ---- 建立比賽：U15 拉丁 12 人、U12 拉丁 4 人、成人拉丁 3 人 ----
const competition = await comps.createCompetition({
  name: '2026 陽光盃國標舞錦標賽',
  slug: 'sunshine-2026',
  currency: 'TWD',
  feeCents: 1200,
  status: 'open',
});

const cha = await schedule.addDance({ competitionId: competition.id, name: 'Cha Cha', sortOrder: 1 });
const samba = await schedule.addDance({ competitionId: competition.id, name: 'Samba', sortOrder: 2 });

const plan = [
  { name: 'U15 拉丁', count: 12 },
  { name: 'U12 拉丁', count: 4 },
  { name: '成人拉丁', count: 3 },
];
const surnames = ['王', '林', '陳', '黃', '張', '李', '吳', '劉', '蔡', '楊', '許', '鄭'];
const givens = ['小明', '佳穎', '柏宇', '詩涵', '孟哲', '雅雯', '冠廷', '宜庭', '承翰', '子芸', '俊傑', '思妤'];
const clubs = ['晨光舞蹈教室', '星光舞蹈', '飛揚舞蹈', '躍動國標'];

const divisions = [];
for (const [index, spec] of plan.entries()) {
  const division = await comps.addDivision({ competitionId: competition.id, name: spec.name, sortOrder: index + 1 });
  await schedule.setDivisionDances(division.id, [cha.id, samba.id]);
  for (let i = 0; i < spec.count; i += 1) {
    await regs.register({
      competitionId: competition.id,
      divisionId: division.id,
      athleteName: `${surnames[(index * 5 + i) % surnames.length]}${givens[(index * 3 + i) % givens.length]}`,
      unitName: clubs[i % clubs.length],
      provider: 'ecpay',
    });
  }
  divisions.push(division);
}

// 全部標記已收款（示範用），再結算出憑證碼。
const all = await regs.listRegistrations(competition.id);
for (const registration of all) await regs.markPaidManually(registration.id);
const settled = await voucherService.settle(competition.id);
await schedule.assignBibs(settled.voucher.code);
console.log(`  [voucher] ${settled.voucher.code} · ${settled.voucher.entry_count} 人`);

// ---- 輪次與裁判 ----
const rounds = {};
for (const division of divisions) {
  rounds[division.name] = await schedule.createRound({
    divisionId: division.id,
    name: division.name === 'U15 拉丁' ? '初賽' : '決賽',
    heatSize: 6,
    scoringMode: division.name === 'U15 拉丁' ? 'mark' : 'rank',
    advanceCount: division.name === 'U15 拉丁' ? 6 : null,
    rankMethod: 'skating',
  });
  await schedule.seedFirstRound(settled.voucher.code, rounds[division.name].id);
}

const judges = [];
for (const [i, name] of ['周老師', '謝老師', '洪老師'].entries()) {
  const judge = await judgeService.addJudge({ competitionId: competition.id, name });
  for (const division of divisions) await judgeService.assignToDivision(judge.id, division.id);
  judges.push(judge);
}

for (const division of divisions) {
  for (const dance of [cha, samba]) await schedule.buildHeats(rounds[division.name].id, dance.id);
}
await schedule.rebuildRunningOrder(competition.id);

// 併場：U12 拉丁 4 人和成人拉丁 3 人人太少，Cha Cha 併成同一場。
const order = await schedule.runningOrder(competition.id);
const smallCha = order.filter(
  (h) => h.dance_name === 'Cha Cha' && (h.division_names.includes('U12 拉丁') || h.division_names.includes('成人拉丁')),
);
if (smallCha.length === 2) {
  await schedule.mergeHeats(smallCha.map((h) => h.id));
  console.log('  [merge] U12 拉丁 + 成人拉丁 的 Cha Cha 併成同一場');
}

const app = createApp();
const server = await new Promise((resolve) => {
  const s = app.listen(4180, '127.0.0.1', () => resolve(s));
});

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const steps = [];

// 等即時同步把畫面帶到最新。裁判頁絕對不用 page.reload()：
// 那在系統眼中等同裁判自己離開畫面，會被作廢。
// Wait for live sync to catch the screens up. A judge page is never reloaded by hand:
// to the system that looks exactly like the judge walking away, and it voids them.
async function waitForLive(pages, ms = 1400) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  for (const page of pages) await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function shot(page, name, note) {
  await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
  steps.push({ name, note });
  console.log(`  [shot] ${name} — ${note}`);
}

const zh = { locale: 'zh-TW', extraHTTPHeaders: { 'Accept-Language': 'zh-TW,zh;q=0.9' } };
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ...zh };
const desktop = { viewport: { width: 1100, height: 1000 }, ...zh };

async function staffPage(context) {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4180/admin');
  await page.fill('#token', 'demo-token');
  await page.click('button[type=submit]');
  await page.waitForLoadState('networkidle');
  return page;
}

try {
  // ---- 10 賽前準備 ----
  const adminCtx = await browser.newContext(desktop);
  const admin = await staffPage(adminCtx);
  await admin.goto(`http://127.0.0.1:4180/admin/c/${competition.id}/schedule`);
  await shot(admin, '10-schedule', '賽前準備：舞科、輪次、背號、裁判、秩序表（含併場）');

  // ---- 11 報到 ----
  const deskCtx = await browser.newContext(phone);
  const desk = await staffPage(deskCtx);
  await desk.goto(`http://127.0.0.1:4180/desk/${competition.id}`);
  await shot(desk, '11-desk-before', '報到處：還沒有人報到');

  const roster = await schedule.rosterWithBibs(settled.voucher.code);
  // 除了背號 106 之外全部報到，留一個人示範反灰。
  for (const entry of roster) {
    if (entry.bib_number !== 106) await floor.reportIn(entry.registration_id, { by: 'desk' });
  }
  await desk.reload();
  await shot(desk, '12-desk-after', '報到後：只有 106 沒來，其他都報到了');

  // ---- 13 檢錄 ----
  const checkinCtx = await browser.newContext(phone);
  const checkin = await staffPage(checkinCtx);
  await checkin.goto(`http://127.0.0.1:4180/checkin/${competition.id}`);
  await shot(checkin, '13-checkin', '檢錄：沒報到的 106 反灰，檢錄人員一看就知道今天沒來');

  // 第一場除了 106 之外全部檢錄
  const running = await schedule.runningOrder(competition.id);
  const firstHeat = running[0];
  const { entries: firstEntries } = await schedule.heatWithEntries(firstHeat.id);
  for (const entry of firstEntries) {
    if (entry.bib_number !== 106 && entry.bib_number !== 105) await floor.checkIn(entry.id);
  }
  await checkin.reload();
  await shot(checkin, '14-checkin-done', '檢錄完成：105 還沒到、106 沒報到');

  // ---- 15 主持人控場 ----
  const hostCtx = await browser.newContext(phone);
  const host = await staffPage(hostCtx);
  await host.goto(`http://127.0.0.1:4180/host/${competition.id}`);
  await host.click('form[action$="/next"] button');
  await host.waitForLoadState('networkidle');
  await shot(host, '15-host-standby', '主持人按下一場：進入預備，裁判燈號全部是未確認');

  // ---- 16 裁判預備 ----
  const judgeCtxs = [];
  const judgePages = [];
  for (const judge of judges) {
    const ctx = await browser.newContext(phone);
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:4180/judge');
    await page.fill('#code', judge.login_code);
    await page.click('button[type=submit]');
    await page.waitForLoadState('networkidle');
    judgeCtxs.push(ctx);
    judgePages.push(page);
  }
  await shot(judgePages[0], '16-judge-standby', '裁判預備畫面：勿擾模式提醒，按「準備好了」');

  for (const page of judgePages) {
    await page.waitForLoadState('domcontentloaded');
    const ready = page.locator('form[action$="/ready"] button').first();
    if ((await ready.count()) > 0) {
      await ready.click();
      await page.waitForLoadState('networkidle').catch(() => {});
    }
  }
  await host.reload();
  await shot(host, '17-host-ready', '三位裁判都按了準備好，主持人看到燈號變綠');

  // ---- 18 開始評分 ----
  await host.click('form[action$="/start"] button');
  await host.waitForLoadState('networkidle');
  // 裁判頁不手動重整：live.js 收到 SSE 會自己跟上，這才是現場的真實情況。
  // The judge pages are never refreshed by hand: live.js follows the SSE feed, as it does in a venue.
  await waitForLive(judgePages);
  await shot(judgePages[0], '18-judge-scoring', '評分中：mark 勾選，畫面顯示已勾幾／幾');

  // 音樂放了，105 才衝進場：主持人補點
  const lateEntry = firstEntries.find((e) => e.bib_number === 105);
  if (lateEntry) {
    await host.reload();
    await host.waitForLoadState('domcontentloaded');
    const addButton = host.locator('form[action*="/add/"] button').first();
    if ((await addButton.count()) > 0) {
      await addButton.click();
      await host.waitForLoadState('networkidle').catch(() => {});
    }
    await shot(host, '19-host-late', '105 音樂放了才衝進場，主持人按「補點」');
    await waitForLive(judgePages);
    await shot(judgePages[0], '20-judge-late', '補點之後，105 立刻出現在裁判手機上');
  }

  // 三位裁判各自勾選
  for (const [index, judge] of judges.entries()) {
    const visible = await judgeService.heatEntriesForJudge(firstHeat.id, judge.id);
    const pick = visible.slice(index % 2, (index % 2) + 3).map((v) => String(v.round_entry_id));
    await scoring.submitScores(firstHeat.id, judge.id, { marks: pick });
  }
  await host.reload();
  await shot(host, '21-host-submitted', '三位裁判都送出，燈號全部變成已送出');

  // ---- 22 跑完剩下的場次 ----
  let guard = 0;
  while (guard < 40) {
    guard += 1;
    const board = await floor.hostBoard(competition.id);
    if (!board.current && board.upcoming.length === 0) break;

    const result = await floor.nextHeat(competition.id);
    if (!result.next) break;
    const heatId = result.next.heat.id;

    const { entries } = await schedule.heatWithEntries(heatId);
    for (const entry of entries) {
      if (entry.bib_number !== 106) await floor.checkIn(entry.id);
    }
    await floor.startHeat(heatId);

    const { heat: heatRow } = await schedule.heatWithEntries(heatId);
    for (const judge of judges) {
      const visible = await judgeService.heatEntriesForJudge(heatId, judge.id);
      if (visible.length === 0) continue;
      const roundIds = [...new Set(visible.map((v) => String(v.round_id)))];
      const payload = { marks: [], ranks: {} };
      for (const roundId of roundIds) {
        const round = await schedule.getRound(roundId);
        const mine = visible.filter((v) => String(v.round_id) === roundId);
        if (round.scoring_mode === 'mark') {
          // 名額是「整支舞的總名額」，所以第二批要看還剩幾個可以勾。
          // The quota covers the whole dance, so a later heat only gets what is left of it.
          const quota = await scoring.markQuota({
            round,
            danceId: heatRow.dance_id,
            judgeId: judge.id,
            heatId,
          });
          const remaining = quota.limit === null ? mine.length : Math.max(0, quota.limit - quota.used);
          payload.marks.push(...mine.slice(0, Math.min(remaining, mine.length)).map((v) => String(v.round_entry_id)));
        } else {
          mine.forEach((v, i) => {
            payload.ranks[String(v.round_entry_id)] = ((i + judges.indexOf(judge)) % mine.length) + 1;
          });
        }
      }
      await scoring.submitScores(heatId, judge.id, payload);
    }
  }
  await floor.nextHeat(competition.id);

  // ---- 23 成績 ----
  for (const division of divisions) {
    await scoring.computeRound(rounds[division.name].id);
    await scoring.publishRound(rounds[division.name].id);
  }

  await admin.goto(`http://127.0.0.1:4180/admin/c/${competition.id}/results`);
  await shot(admin, '22-admin-results', '主辦後台的成績：計算完成，已公告');

  const publicCtx = await browser.newContext(phone);
  const publicPage = await publicCtx.newPage();
  await publicPage.goto(`http://127.0.0.1:4180/results/sunshine-2026`);
  await shot(publicPage, '23-results-public', '公開成績頁：選手用手機看得到名次與晉級');

  await publicPage.goto(`http://127.0.0.1:4180/results/sunshine-2026/bib?bib=101`);
  await shot(publicPage, '24-results-bib', '選手用背號查自己：每支舞在第幾場、名次、有沒有晉級');

  const enCtx = await browser.newContext({ ...phone, locale: 'en-GB', extraHTTPHeaders: { 'Accept-Language': 'en-GB,en' } });
  const enPage = await enCtx.newPage();
  await enPage.goto('http://127.0.0.1:4180/results/sunshine-2026');
  await shot(enPage, '25-results-en', '同一頁，瀏覽器是英文就自動變英文');

  fs.writeFileSync(path.join(shots, 'index.json'), JSON.stringify(steps, null, 2));

  // 印出最終成績，方便核對。
  for (const division of divisions) {
    const results = await scoring.resultsFor(rounds[division.name].id);
    console.log(`\n  [results] ${division.name}`);
    for (const row of results.slice(0, 6)) {
      console.log(
        `            ${row.absent ? '缺席' : String(row.final_rank).padStart(2)} · ${row.bib_number} ${row.athlete_name}` +
          `${row.total_marks !== null ? ` · marks ${row.total_marks}` : ''}${row.advanced ? ' · 晉級' : ''}`,
      );
    }
  }
  console.log(`\n共 ${steps.length} 張截圖`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await closePool();
}
