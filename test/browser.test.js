// 真的開一顆瀏覽器測裁判畫面。
// 這裡釘住的是一個會毀掉整場比賽的狀況：即時同步讓裁判畫面自己重整，
// 而重整被誤判成「裁判跳出畫面」，於是全部裁判被作廢。
// A real browser drives the judge screen here. What this pins down is the failure that would
// wreck a whole competition: live sync refreshes the judge screen, the refresh is mistaken for
// the judge walking away, and every judge gets voided.
import { resetDatabase, startServer } from './helpers.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 沒裝瀏覽器的人（例如只是要改翻譯）不該被這組測試擋住，所以找不到就整組跳過。
// Someone who only came to fix a translation should not be blocked by these, so they skip
// when no browser is installed.
const CHROME = process.env.STAGERANK_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let chromium = null;
try {
  ({ chromium } = await import('playwright'));
} catch {
  chromium = null;
}
const SKIP = !chromium || !fs.existsSync(CHROME);
const browserTest = (name, fn) => test(name, { skip: SKIP ? 'no browser installed' : false }, fn);

const { createApp } = await import('../src/app.js');
const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const voucher = await import('../src/services/voucher.js');
const schedule = await import('../src/services/schedule.js');
const judgeService = await import('../src/services/judges.js');
const floor = await import('../src/services/floor.js');
const entrants = await import('../src/services/entrants.js');
const roster = await import('../src/services/athletes.js');
const fees = await import('../src/services/feeGroups.js');
const setup = await import('../src/services/setup.js');
const { closePool, one } = await import('../src/db/index.js');

let http;
let browser;

before(async () => {
  if (SKIP) return;
  await resetDatabase();
  http = await startServer(createApp());
  browser = await chromium.launch({ executablePath: CHROME });
});

after(async () => {
  if (browser) await browser.close();
  if (http) await http.close();
  await closePool();
});

// 一場能評分的比賽：一個組別、一支舞、四位選手、兩位裁判，已經在評分中。
// A scorable competition already under way: one division, one dance, four dancers, two judges.
async function setUpHeat() {
  const competition = await comps.createCompetition({ name: 'Browser Cup', feeCents: 0, status: 'open' });
  const division = await comps.addDivision({ competitionId: competition.id, name: 'U15 Latin', sortOrder: 1 });
  const cha = await schedule.addDance({ competitionId: competition.id, name: 'Cha Cha', sortOrder: 1 });
  await schedule.setDivisionDances(division.id, [cha.id]);

  for (const name of ['A One', 'B Two', 'C Three', 'D Four']) {
    await regs.register({ competitionId: competition.id, divisionId: division.id, athleteName: name });
  }
  const settled = await voucher.settle(competition.id);
  await schedule.assignBibs(settled.voucher.code, { start: 101 });

  const round = await schedule.createRound({
    divisionId: division.id,
    name: 'Final',
    heatSize: 10,
    scoringMode: 'mark',
    advanceCount: 2,
  });
  await schedule.seedFirstRound(settled.voucher.code, round.id);

  const judges = [];
  for (const name of ['Judge A', 'Judge B']) {
    const judge = await judgeService.addJudge({ competitionId: competition.id, name });
    await judgeService.assignToDivision(judge.id, division.id);
    judges.push(judge);
  }

  const heats = await schedule.buildHeats(round.id, cha.id);
  await schedule.rebuildRunningOrder(competition.id);
  const heat = heats[0];

  const { entries } = await schedule.heatWithEntries(heat.id);
  for (const entry of entries) await floor.checkIn(entry.id);
  await floor.nextHeat(competition.id, { heatId: heat.id });
  await floor.startHeat(heat.id);

  return { competition, division, judges, heat, entries };
}

async function openJudge(judge, competitionId) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${http.base}/judge`);
  await page.fill('#code', judge.login_code);
  await page.click('button[type=submit]');
  await page.waitForLoadState('networkidle');
  return { context, page };
}

async function isVoided(heatId, judgeId) {
  const row = await one(
    'SELECT voided_at FROM heat_judges WHERE heat_id = $1 AND judge_id = $2',
    [heatId, judgeId],
  );
  return Boolean(row && row.voided_at);
}

browserTest('即時同步造成的重整，不可以被當成跳出作廢 / a live-driven refresh must not void a judge', async () => {
  const { competition, judges, heat } = await setUpHeat();
  const { context, page } = await openJudge(judges[0], competition.id);

  try {
    await page.waitForSelector('#scoring');
    assert.equal(await isVoided(heat.id, judges[0].id), false, 'not voided before anything happens');

    // 這正是會場會發生的事：主持人補點一位選手，即時同步把每支手機叫起來重整。
    // Exactly what happens in a venue: the host adds a latecomer and live sync refreshes every phone.
    await page.evaluate(() => {
      window.__stagerankInternalNav = true;
      window.location.reload();
    });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);

    assert.equal(
      await isVoided(heat.id, judges[0].id),
      false,
      'the judge must still be able to score after the system refreshed their screen',
    );
    await page.waitForSelector('#scoring');
  } finally {
    await context.close();
  }
});

browserTest('裁判勾到一半，系統重整之後還在 / ticks survive a refresh the system caused', async () => {
  const { competition, judges, heat } = await setUpHeat();
  const { context, page } = await openJudge(judges[0], competition.id);

  try {
    await page.waitForSelector('.markbox');
    const first = page.locator('.markbox').first();
    const value = await first.getAttribute('value');
    await first.check();

    await page.evaluate(() => {
      window.__stagerankInternalNav = true;
      window.location.reload();
    });
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.markbox');

    const stillChecked = await page.locator(`.markbox[value="${value}"]`).isChecked();
    assert.equal(stillChecked, true, 'what the judge already ticked must survive the refresh');
    assert.equal(await isVoided(heat.id, judges[0].id), false);
  } finally {
    await context.close();
  }
});

browserTest('真的切到別的 app 才算跳出 / genuinely switching away is what voids the heat', async () => {
  const { competition, judges, heat } = await setUpHeat();
  const { context, page } = await openJudge(judges[0], competition.id);

  try {
    await page.waitForSelector('#scoring');

    // 沒有舉旗，就是裁判自己離開畫面。
    // No internal-navigation flag: this is the judge leaving the screen.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(600);

    assert.equal(await isVoided(heat.id, judges[0].id), true, 'walking away must void this heat');
  } finally {
    await context.close();
  }
});

browserTest('按送出不算跳出 / pressing submit is not walking away', async () => {
  const { competition, judges, heat } = await setUpHeat();
  const { context, page } = await openJudge(judges[0], competition.id);

  try {
    await page.waitForSelector('.markbox');
    await page.locator('.markbox').first().check();
    await page.locator('form[action$="/submit"] button[type=submit]').click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);

    assert.equal(await isVoided(heat.id, judges[0].id), false, 'submitting must never void the judge');
    const submitted = await one(
      'SELECT submitted_at FROM heat_judges WHERE heat_id = $1 AND judge_id = $2',
      [heat.id, judges[0].id],
    );
    assert.ok(submitted && submitted.submitted_at, 'and the score is recorded');
  } finally {
    await context.close();
  }
});

browserTest('另一位裁判被作廢，不影響其他人 / voiding one judge leaves the others alone', async () => {
  const { competition, judges, heat } = await setUpHeat();
  const a = await openJudge(judges[0], competition.id);
  const b = await openJudge(judges[1], competition.id);

  try {
    await a.page.waitForSelector('#scoring');
    await b.page.waitForSelector('#scoring');

    await a.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await a.page.waitForTimeout(600);

    assert.equal(await isVoided(heat.id, judges[0].id), true);
    assert.equal(await isVoided(heat.id, judges[1].id), false, 'the other judge carries on');
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

// 組別表格曾經把 <form> 直接放在 <tr> 裡。HTML 不允許，瀏覽器會把表單搬出表格，
// 欄位留在原地不送出，按「儲存」等於把一個雙人組別清成單人、整組收、加收歸零。
// 伺服器端的測試抓不到這種事，只有真的開瀏覽器按下去才看得見。
// The divisions table once put a <form> straight inside a <tr>. HTML forbids it: the browser
// lifts the form out, the fields stay behind unsubmitted, and pressing save quietly turned a
// couple division into a solo one at a flat fee. Only a real browser click catches this.
async function openAdmin(competitionId) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${http.base}/admin`);
  await page.fill('#token', 'test-admin-token');
  await page.click('button[type=submit]');
  await page.waitForLoadState('networkidle');
  await page.goto(`${http.base}/admin/c/${competitionId}`);
  await page.waitForLoadState('networkidle');
  return { context, page };
}

browserTest('改組別按「儲存」要真的存下去 / editing a division actually saves', async () => {
  const competition = await comps.createCompetition({ name: 'Admin Cup', feeCents: 1200, status: 'draft' });
  const division = await comps.addDivision({
    competitionId: competition.id,
    name: 'U15 Latin Couple',
    feeCents: 1000,
    memberMin: 2,
    memberMax: 2,
    feeMode: 'per_person',
    extraDivisionFeeCents: 500,
    sortOrder: 1,
  });

  const { context, page } = await openAdmin(competition.id);
  try {
    const form = page.locator(`form[action$="/divisions/${division.id}"]`);
    await form.locator('input[name=feeCents]').fill('1500');
    await form.locator('button[type=submit]').click();
    await page.waitForLoadState('networkidle');

    const after = await comps.getDivision(division.id);
    assert.equal(Number(after.fee_cents), 1500, 'the new fee was saved');
    assert.equal(after.member_min, 2, 'a couple division stays a couple division');
    assert.equal(after.member_max, 2);
    assert.equal(after.fee_mode, 'per_person', 'the fee mode is not silently reset');
    assert.equal(Number(after.extra_division_fee_cents), 500, 'the surcharge survives an edit');
    assert.equal(after.name, 'U15 Latin Couple');
  } finally {
    await context.close();
  }
});

browserTest('從名冊勾人：金額即時算，年齡不符的勾不動 / ticking the roster prices live and greys out the ineligible', async () => {
  const competition = await comps.createCompetition({ name: 'Team Cup', feeCents: 0, status: 'open' });
  await comps.setAgeRule(competition.id, { ageBasis: 'year_end', eventDate: '2026-06-01' });
  await comps.addDivision({
    competitionId: competition.id,
    name: 'Adult Team',
    feeCents: 800,
    memberMin: 3,
    memberMax: 8,
    feeMode: 'per_person',
    ageMin: 18,
    sortOrder: 1,
  });

  const account = await entrants.signUp({ email: 'teacher@example.com', password: 'passw0rd!' });
  for (const person of [
    { name: 'Adult One', birthDate: '2000-01-01' },
    { name: 'Adult Two', birthDate: '2001-01-01' },
    { name: 'Adult Three', birthDate: '2002-01-01' },
    { name: 'Adult Four', birthDate: '2003-01-01' },
    { name: 'Child Five', birthDate: '2016-01-01' },
  ]) {
    await roster.addAthlete({ entrantId: account.id, ...person });
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addCookies([{
    name: entrants.ENTRANT_COOKIE,
    value: entrants.makeToken(account.id),
    url: http.base,
  }]);
  const page = await context.newPage();
  try {
    await page.goto(`${http.base}/c/${encodeURIComponent(competition.slug)}`);
    const value = await page.$eval('#divisionId', (sel) => sel.options[1].value);
    await page.selectOption('#divisionId', value);

    // 年齡不符的那一位勾不動，而且畫面上說得出原因。
    // The under-age one cannot be ticked, and the screen says why.
    const child = page.locator('.roster-pick', { hasText: 'Child Five' });
    assert.equal(await child.locator('input').isDisabled(), true);
    assert.ok((await child.locator('.reason').textContent()).length > 0);

    const picks = page.locator('.roster-pick input:not(:disabled)');
    assert.equal(await picks.count(), 4, 'the four adults can be ticked');

    // 還沒勾滿下限就不給送出，免得送出去才被退。
    // Below the minimum the button stays disabled rather than failing on submit.
    await picks.nth(0).check();
    await picks.nth(1).check();
    assert.equal(await page.locator('#submitButton').isDisabled(), true, 'two of three is not enough');

    await picks.nth(2).check();
    assert.equal(await page.locator('#submitButton').isDisabled(), false);
    const preview = await page.locator('#feePreview').textContent();
    assert.ok(/2,?400/.test(preview), `800 per person times three, got: ${preview}`);

    await picks.nth(3).check();
    const after = await page.locator('#feePreview').textContent();
    assert.ok(/3,?200/.test(after), `the total follows the ticks, got: ${after}`);
  } finally {
    await context.close();
  }
});

// 階梯計價的重點是老師在勾的當下就看得到「這是第幾項、多少錢」。
// 這只有真的在瀏覽器裡勾才驗得出來：伺服器端算得對，畫面上寫錯照樣會吵架。
// What matters about tiered pricing is that the teacher sees "item 3, 600" as they tick.
// Only a real browser proves it: the server can be right while the screen says otherwise,
// and it is the screen that starts the argument.
browserTest('階梯計價在畫面上逐項顯示 / tiered pricing shows each item as it is ticked', async () => {
  const competition = await comps.createCompetition({ name: 'Tier Cup', feeCents: 0, status: 'open' });
  const plan = await fees.createGroup({
    competitionId: competition.id, name: 'General', baseFeeCents: 1800, baseIncludes: 2, extraItemFeeCents: 600,
  });
  const solo = async (name) => comps.addDivision({
    competitionId: competition.id, name, sortOrder: 1, feeMode: 'tiered', feeGroupId: plan.id,
  });
  const cha = await solo('Cha Cha');
  const rumba = await solo('Rumba');
  const jive = await solo('Jive');

  const account = await entrants.signUp({ email: 'tier@example.com', password: 'passw0rd!' });
  const athlete = await roster.addAthlete({ entrantId: account.id, name: 'Ming', birthDate: '2012-05-04' });

  // 先報掉兩項，把基本盤用完。
  // Two items already entered, so the base is used up.
  for (const division of [cha, rumba]) {
    await regs.register({
      competitionId: competition.id, divisionId: division.id, athleteIds: [athlete.id],
      entrantId: account.id, provider: 'ecpay',
    });
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addCookies([{
    name: entrants.ENTRANT_COOKIE,
    value: entrants.makeToken(account.id),
    url: http.base,
  }]);
  const page = await context.newPage();
  try {
    await page.goto(`${http.base}/c/${encodeURIComponent(competition.slug)}`);
    const value = await page.$eval('#divisionId', (sel, id) => {
      const option = Array.from(sel.options).find((o) => o.value === String(id));
      return option ? option.value : '';
    }, jive.id);
    await page.selectOption('#divisionId', value);
    await page.locator('.roster-pick input').first().check();

    // 第三項，600 元，寫在那位選手自己那一行。
    // Item three at 600, on that competitor's own line.
    const line = await page.locator('.roster-pick .item').first().textContent();
    assert.match(line, /3/, `the item number is shown, got: ${line}`);
    assert.match(line, /600/, `the price is shown, got: ${line}`);

    const preview = await page.locator('#feePreview').textContent();
    assert.match(preview, /600/, `the total matches the item, got: ${preview}`);
    assert.ok(!/1,?800/.test(preview), 'the base fee is not charged again');

    // 用收費方案的比賽，比賽層級的報名費是 0，但那不是免費：
    // 少了這一條，整場會顯示「免費」而且沒有付款方式可以選。
    // A competition priced by a plan has a zero competition-level fee, which is not free.
    // Without this the whole page says free and offers no way to pay.
    assert.equal(await page.locator('#provider').count(), 1, 'a payment method is offered');
    const header = await page.locator('h1 + p').textContent();
    assert.ok(!header.includes('Free') && !header.includes('免費'), `not free, got: ${header}`);
  } finally {
    await context.close();
  }
});

// 建立項目這一頁的重點是「產生出來的組別真的能跑」：名字、年齡、收費方案、舞科都要對。
// 服務層測得到資料，但主辦按的是這個畫面，所以按一次給它看。
// What matters about the setup page is that what it creates can actually run: names, ages, fee
// plans and dances all correct. The service layer proves the data; this proves the button.
browserTest('套範本：關掉不辦的，剩下的一次生出來 / the template builds only what was left on', async () => {
  const competition = await comps.createCompetition({ name: 'Setup Cup', feeCents: 0, status: 'draft' });

  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${http.base}/admin`);
    await page.fill('#token', 'test-admin-token');
    await page.click('button[type=submit]');
    await page.waitForLoadState('networkidle');
    await page.goto(`${http.base}/admin/c/${competition.id}/setup`);

    // 預設選中的是資料目錄的範本；這個測試走「通用國標舞（自動組合）」那條。
    // The preselected template is the catalogue one; this test takes the generic auto-combined road.
    await page.selectOption('#templateKey', 'ballroom');
    const boxes = page.locator('.plan-panel:not([hidden]) input[type=checkbox]');
    const total = await boxes.count();
    assert.ok(total > 50, `the template offers a useful list, got ${total}`);

    // 預設全部打開：用關掉的方式篩，比從空白勾出來輕鬆。
    // Everything starts on: removing is easier than ticking out of an empty grid.
    assert.equal(await boxes.first().isChecked(), true);

    await page.click('#allOff');
    for (const key of ['u12-latin-five', 'u12-latin-chaCha', 'proam-latin-rumba']) {
      await page.locator(`input[name=keys][value="${key}"]`).check();
    }
    await page.locator('form[action$="/setup/template"] button[type=submit]').click();
    await page.waitForLoadState('networkidle');

    const divisions = await comps.listDivisions(competition.id);
    assert.equal(divisions.length, 3, 'only what was left on');

    // 舞科掛好了，五項就是五支、單項就是一支。沒掛的話主辦還是得一個一個掛，等於沒省到。
    // The dances are attached: five for a five-dance event, one for a single. Without that the
    // organiser is back to wiring them by hand and nothing was saved.
    const counts = [];
    for (const division of divisions) {
      counts.push((await schedule.dancesForDivision(division.id)).length);
    }
    counts.sort();
    assert.deepEqual(counts, [1, 1, 5], `one five-dance and two singles, got ${counts.join(',')}`);

    // 師生組掛在自己的收費方案上，不跟一般組合起來算。
    // The pro-am division sits on its own fee plan, not counted with the general ones.
    const plans = await fees.listGroups(competition.id);
    assert.equal(plans.length, 2);

    // 只建被用到的舞科：標準舞一支都沒有。
    // Only the dances in use exist: not one Standard dance.
    const dances = await schedule.listDances(competition.id);
    assert.equal(dances.length, 5, `latin only, got ${dances.map((d) => d.name).join(',')}`);
  } finally {
    await context.close();
  }
});

browserTest('複製上一場：一按就整套過來 / copying a past event brings the setup across in one press', async () => {
  const last = await comps.createCompetition({ name: 'Last Year', feeCents: 0, status: 'closed' });
  await setup.applyTemplate({
    competitionId: last.id,
    keys: ['u12-latin-five', 'u12-latin-chaCha'],
    t: (key) => key.split('.').pop(),
    generalPlan: { baseFeeCents: 1800, baseIncludes: 2, extraItemFeeCents: 600 },
  });
  const next = await comps.createCompetition({ name: 'This Year', feeCents: 0, status: 'draft' });

  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${http.base}/admin`);
    await page.fill('#token', 'test-admin-token');
    await page.click('button[type=submit]');
    await page.waitForLoadState('networkidle');
    await page.goto(`${http.base}/admin/c/${next.id}/setup`);

    await page.locator('form[action$="/setup/copy"] button[type=submit]').click();
    await page.waitForLoadState('networkidle');

    const copied = await comps.listDivisions(next.id);
    assert.equal(copied.length, 2);
    // 舞科清單也要跟著，不然複製過來的是一堆跑不了的空殼。
    // The dance lists come too, or what arrives is a set of divisions that cannot run.
    assert.equal((await schedule.dancesForDivision(copied[0].id)).length, 5);
  } finally {
    await context.close();
  }
});
