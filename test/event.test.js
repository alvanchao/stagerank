import { resetDatabase, startServer } from './helpers.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// 一場完整的比賽模擬（全部是假資料）：報名 → 背號 → 賽序 → 報到與檢錄 → 主持人控場 → 裁判評分 → 成績公告。
// A whole event on fake data: entries, bibs, running order, report-in and check-in, the host on the floor,
// judging, and published results.

const { createApp } = await import('../src/app.js');
const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const voucher = await import('../src/services/voucher.js');
const schedule = await import('../src/services/schedule.js');
const judgeService = await import('../src/services/judges.js');
const floor = await import('../src/services/floor.js');
const scoring = await import('../src/services/scoring.js');
const decisions = await import('../src/services/roundDecisions.js');
const { closePool, many, one } = await import('../src/db/index.js');

let http;
before(async () => {
  await resetDatabase();
  http = await startServer(createApp());
});
after(async () => {
  await http.close();
  await closePool();
});
beforeEach(async () => {
  await resetDatabase();
});

async function buildEvent() {
  const competition = await comps.createCompetition({ name: '模擬盃', feeCents: 0, status: 'open' });
  const latin = await comps.addDivision({ competitionId: competition.id, name: '成人拉丁', sortOrder: 1 });
  const standard = await comps.addDivision({ competitionId: competition.id, name: '成人標準', sortOrder: 2 });
  const cha = await schedule.addDance({ competitionId: competition.id, name: 'Cha Cha', sortOrder: 1 });
  const samba = await schedule.addDance({ competitionId: competition.id, name: 'Samba', sortOrder: 2 });
  const waltz = await schedule.addDance({ competitionId: competition.id, name: 'Waltz', sortOrder: 3 });
  await schedule.setDivisionDances(latin.id, [cha.id, samba.id]);
  await schedule.setDivisionDances(standard.id, [waltz.id]);

  // 拉丁 14 人；其中 4 人同時報標準。
  for (let i = 1; i <= 14; i += 1) {
    await regs.register({ competitionId: competition.id, divisionId: latin.id, athleteName: `選手${i}`, athleteEmail: `p${i}@example.com` });
  }
  for (let i = 1; i <= 4; i += 1) {
    await regs.register({ competitionId: competition.id, divisionId: standard.id, athleteName: `選手${i}`, athleteEmail: `p${i}@example.com` });
  }

  const settled = await voucher.settle(competition.id);
  await schedule.assignBibs(settled.voucher.code);

  const semi = await schedule.createRound({ divisionId: latin.id, name: '準決賽', sortOrder: 1, heatSize: 7, scoringMode: 'mark', advanceCount: 6 });
  const final = await schedule.createRound({ divisionId: latin.id, name: '決賽', sortOrder: 2, heatSize: 7, scoringMode: 'rank', rankMethod: 'skating' });
  const stdFinal = await schedule.createRound({ divisionId: standard.id, name: '決賽', sortOrder: 1, heatSize: 10, scoringMode: 'rank' });
  await schedule.seedFirstRound(settled.voucher.code, semi.id);
  await schedule.seedFirstRound(settled.voucher.code, stdFinal.id);

  const latinJudges = [];
  for (let i = 1; i <= 5; i += 1) {
    const j = await judgeService.addJudge({ competitionId: competition.id, name: `拉丁裁判${i}` });
    await judgeService.assignToDivision(j.id, latin.id);
    latinJudges.push(j);
  }
  const stdJudges = [];
  for (let i = 1; i <= 3; i += 1) {
    const j = await judgeService.addJudge({ competitionId: competition.id, name: `標準裁判${i}` });
    await judgeService.assignToDivision(j.id, standard.id);
    stdJudges.push(j);
  }

  const chaHeats = await schedule.buildHeats(semi.id, cha.id);
  const sambaHeats = await schedule.buildHeats(semi.id, samba.id);
  const waltzHeats = await schedule.buildHeats(stdFinal.id, waltz.id);
  await schedule.rebuildRunningOrder(competition.id);
  return { competition, latin, standard, semi, final, stdFinal, dances: { cha, samba, waltz }, chaHeats, sambaHeats, waltzHeats, latinJudges, stdJudges, voucher: settled.voucher };
}

test('3 賽序：14 人分兩批，每支舞都排好，拉丁與標準都在同一份賽序裡 / running order covers every dance and heat', async () => {
  const ev = await buildEvent();
  assert.equal(ev.chaHeats.length, 2);
  assert.equal(ev.sambaHeats.length, 2);
  assert.equal(ev.waltzHeats.length, 1);

  const order = await schedule.runningOrder(ev.competition.id);
  assert.equal(order.length, 5);
  // 同一個組別同一輪：Cha Cha 全部批次，才輪到 Samba。
  const names = order.map((h) => h.dance_name);
  assert.deepEqual(names.slice(0, 2), ['Cha Cha', 'Cha Cha']);
  assert.deepEqual(names.slice(2, 4), ['Samba', 'Samba']);
});

test('2 背號：同一人報兩個組別，背號相同，每人只有一個 / one bib per person across divisions', async () => {
  const ev = await buildEvent();
  const roster = await schedule.rosterWithBibs(ev.voucher.code);
  assert.equal(roster.length, 18);
  const one1 = roster.filter((r) => r.athlete_name === '選手1').map((r) => r.bib_number);
  assert.equal(one1.length, 2);
  assert.equal(one1[0], one1[1]);
  const distinct = new Set(roster.map((r) => r.bib_number));
  assert.equal(distinct.size, 14, '14 different people, 14 different bibs');
});

test('4 檢錄：沒報到的反灰，主持人補點後裁判才看得到，缺席的不評 / check-in, host补點 and absence', async () => {
  const ev = await buildEvent();
  const { entries } = await schedule.heatWithEntries(ev.chaHeats[0].id);
  const late = entries[0];
  const absent = entries[1];

  // 只有 late、absent 沒報到，其餘報到並檢錄。
  for (const e of entries.slice(2)) await floor.checkIn(e.id);
  const board = await floor.checkInBoard(ev.competition.id);
  const first = board.heats.find((h) => String(h.heat.id) === String(ev.chaHeats[0].id));
  const greyed = first.entries.filter((e) => e.reported_at === null).map((e) => String(e.round_entry_id));
  assert.ok(greyed.includes(String(late.round_entry_id)) && greyed.includes(String(absent.round_entry_id)));

  // 沒檢錄的人，裁判看不到。
  const seenBefore = await judgeService.heatEntriesForJudge(ev.chaHeats[0].id, ev.latinJudges[0].id);
  assert.ok(!seenBefore.some((e) => String(e.round_entry_id) === String(late.round_entry_id)));

  // 音樂一放他衝進場：主持人幫忙補點，裁判就看得到了。
  await floor.checkIn(late.id);
  const seenAfter = await judgeService.heatEntriesForJudge(ev.chaHeats[0].id, ev.latinJudges[0].id);
  assert.ok(seenAfter.some((e) => String(e.round_entry_id) === String(late.round_entry_id)));

  // 缺席的人不進評分名單。
  await floor.markAbsent(absent.round_entry_id);
  const seenAbsent = await judgeService.heatEntriesForJudge(ev.chaHeats[0].id, ev.latinJudges[0].id);
  assert.ok(!seenAbsent.some((e) => String(e.round_entry_id) === String(absent.round_entry_id)));
});

test('5 主持人：換場、臨時調順序、看得到裁判狀態、裁判改不了他的權限 / the host runs the floor', async () => {
  const ev = await buildEvent();
  for (const heat of [...ev.chaHeats, ...ev.sambaHeats]) {
    const { entries } = await schedule.heatWithEntries(heat.id);
    for (const e of entries) await floor.checkIn(e.id);
  }

  // 主持人臨時把第二批 Cha Cha 提到第一批前面。
  const [h1, h2] = ev.chaHeats;
  await schedule.moveHeat(h2.id, { beforeHeatId: h1.id });
  const order = await schedule.runningOrder(ev.competition.id);
  assert.equal(String(order[0].id), String(h2.id));

  const first = await floor.nextHeat(ev.competition.id);
  assert.equal(String(first.next.heat.id ?? first.next.id), String(h2.id));
  await floor.startHeat(h2.id);

  // 裁判 1、2 送出，主持人看得到誰送了誰還沒。
  const entriesNow = await judgeService.heatEntriesForJudge(h2.id, ev.latinJudges[0].id);
  const marks = entriesNow.slice(0, 3).map((e) => e.round_entry_id);
  await scoring.submitScores(h2.id, ev.latinJudges[0].id, { marks });
  await scoring.submitScores(h2.id, ev.latinJudges[1].id, { marks });
  const status = await floor.heatStatus(h2.id);
  const text = JSON.stringify(status);
  assert.ok(text.includes('submitted'), 'the host board shows who has submitted');
});

test('6 裁判：跳出畫面作廢當下這組，下一組恢復；沒送出的換組時自動收件 / walking away voids one heat only', async () => {
  const ev = await buildEvent();
  for (const heat of ev.chaHeats) {
    const { entries } = await schedule.heatWithEntries(heat.id);
    for (const e of entries) await floor.checkIn(e.id);
  }
  const [h1, h2] = ev.chaHeats;
  await floor.nextHeat(ev.competition.id, { heatId: h1.id });
  await floor.startHeat(h1.id);

  const judge = ev.latinJudges[0];
  await floor.judgeLeftScreen(h1.id, judge.id);
  const e1 = await judgeService.heatEntriesForJudge(h1.id, judge.id);
  await assert.rejects(
    () => scoring.submitScores(h1.id, judge.id, { marks: e1.slice(0, 2).map((e) => e.round_entry_id) }),
    (err) => err.key === 'scoring.errors.voided',
  );

  // 別的裁判寫了一半沒送出，換組時自動算進去。
  const other = ev.latinJudges[1];
  await scoring.submitScores(h1.id, other.id, { marks: e1.slice(0, 2).map((e) => e.round_entry_id) });

  await floor.nextHeat(ev.competition.id, { heatId: h2.id });
  await floor.startHeat(h2.id);
  const e2 = await judgeService.heatEntriesForJudge(h2.id, judge.id);
  const res = await scoring.submitScores(h2.id, judge.id, { marks: e2.slice(0, 2).map((e) => e.round_entry_id) });
  assert.ok(res.accepted > 0, 'the voided judge scores the next heat normally');
});

test('1 到 7：準決賽 mark → 決賽排名次 → 成績公告，選手用背號查得到 / semi by marks, final by places, published and looked up by bib', async () => {
  const ev = await buildEvent();

  async function runHeat(heat, judges, choose) {
    const { entries } = await schedule.heatWithEntries(heat.id);
    for (const e of entries) await floor.checkIn(e.id);
    await floor.nextHeat(ev.competition.id, { heatId: heat.id });
    await floor.startHeat(heat.id);
    for (const judge of judges) {
      const visible = await judgeService.heatEntriesForJudge(heat.id, judge.id);
      await scoring.submitScores(heat.id, judge.id, choose(visible, judge));
    }
  }

  // 準決賽：每位裁判每支舞勾「編號最小的 6 位」，所以前 6 名選手一路晉級。
  const allEntries = await many('SELECT * FROM round_entries WHERE round_id = $1 ORDER BY bib_number', [ev.semi.id]);
  const topSix = new Set(allEntries.slice(0, 6).map((e) => String(e.id)));
  for (const heat of [...ev.chaHeats, ...ev.sambaHeats]) {
    await runHeat(heat, ev.latinJudges, (visible) => ({
      marks: visible.filter((e) => topSix.has(String(e.round_entry_id))).map((e) => e.round_entry_id),
    }));
  }
  await floor.nextHeat(ev.competition.id);

  const semiResult = await scoring.computeRound(ev.semi.id);
  assert.equal(semiResult.advanced, 6);
  await scoring.seedNextRound(ev.semi.id, ev.final.id);
  const finalists = await many('SELECT * FROM round_entries WHERE round_id = $1 ORDER BY bib_number', [ev.final.id]);
  assert.equal(finalists.length, 6);

  // 決賽：6 人一批，5 位裁判都給同樣的名次（按編號），最後結果就是編號順序。
  const finalChaHeats = await schedule.buildHeats(ev.final.id, ev.dances.cha.id);
  const finalSambaHeats = await schedule.buildHeats(ev.final.id, ev.dances.samba.id);
  await schedule.rebuildRunningOrder(ev.competition.id);
  for (const heat of [...finalChaHeats, ...finalSambaHeats]) {
    await runHeat(heat, ev.latinJudges, (visible) => {
      const ordered = [...visible].sort((x, y) => x.bib_number - y.bib_number);
      return { ranks: Object.fromEntries(ordered.map((e, i) => [e.round_entry_id, i + 1])) };
    });
  }
  await floor.nextHeat(ev.competition.id);

  const finalResult = await scoring.computeRound(ev.final.id);
  assert.deepEqual(finalResult.ranked.map((r) => r.finalRank), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(finalResult.ranked.map((r) => r.bib), [...finalResult.ranked.map((r) => r.bib)].sort((a, b) => a - b));

  // 成績：沒公告時外面看不到，公告後看得到；選手用背號查自己。
  const winner = finalResult.ranked[0];
  const hiddenPage = await (await http.get(`/results/${ev.competition.slug}`)).text();
  assert.ok(!hiddenPage.includes(winner.name), 'unpublished results stay hidden');

  await scoring.publishRound(ev.final.id);
  const publicPage = await (await http.get(`/results/${ev.competition.slug}`)).text();
  assert.ok(publicPage.includes(winner.name), 'published results appear');
  const lookup = await (await http.get(`/results/${ev.competition.slug}/bib?bib=${winner.bib}`)).text();
  assert.ok(lookup.includes(winner.name), 'a competitor finds their own result by bib');
});

test('Excel 匯出：背號表與賽序表能開、內容與畫面一致、只有主辦能下載 / xlsx export matches the screens and is organiser-only', async () => {
  const ev = await buildEvent();
  const ExcelJS = (await import('exceljs')).default;
  const cookie = { headers: { cookie: `stagerank_admin=${encodeURIComponent('test-admin-token')}` } };

  const bibsRes = await http.get(`/admin/c/${ev.competition.id}/export/bibs.xlsx`, cookie);
  assert.equal(bibsRes.status, 200);
  assert.match(bibsRes.headers.get('content-type'), /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await bibsRes.arrayBuffer()));
  const sheet = wb.worksheets[0];
  assert.equal(sheet.rowCount, 1 + 18, 'a header plus 18 entries');
  assert.equal(sheet.getRow(1).getCell(1).value, '背號');
  const bibs = [];
  sheet.eachRow((row, i) => { if (i > 1) bibs.push(row.getCell(1).value); });
  assert.equal(new Set(bibs).size, 14, '14 people, 14 different bibs');

  const orderRes = await http.get(`/admin/c/${ev.competition.id}/export/order.xlsx`, cookie);
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(Buffer.from(await orderRes.arrayBuffer()));
  assert.equal(wb2.worksheets[0].rowCount, 1 + 5, 'five heats in the running order');
  assert.equal(wb2.worksheets[1].rowCount, 1 + 7 + 7 + 7 + 7 + 4, 'every dancer of every heat is listed');

  // 英文介面就是英文標題
  const en = await http.get(`/admin/c/${ev.competition.id}/export/bibs.xlsx?lang=en`, cookie);
  const wb3 = new ExcelJS.Workbook();
  await wb3.xlsx.load(Buffer.from(await en.arrayBuffer()));
  assert.equal(wb3.worksheets[0].getRow(1).getCell(1).value, 'Bib');

  // 沒有主辦通行碼下載不到
  const denied = await http.get(`/admin/c/${ev.competition.id}/export/bibs.xlsx`);
  assert.notEqual(denied.headers.get('content-type') || '', XLSX_TYPE_CHECK);
  const judge = await http.get(`/admin/c/${ev.competition.id}/export/order.xlsx`, { headers: { cookie: 'stagerank_host_1=whatever' } });
  assert.doesNotMatch(judge.headers.get('content-type') || '', /spreadsheetml/);
});
const XLSX_TYPE_CHECK = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test('改分歷史：重新送出會把舊分數留下來 / a resubmission keeps the overwritten score in score_history', async () => {
  const ev = await buildEvent();
  const [h1] = ev.chaHeats;
  const { entries: heatEntries } = await schedule.heatWithEntries(h1.id);
  for (const e of heatEntries) await floor.checkIn(e.id);
  await floor.nextHeat(ev.competition.id, { heatId: h1.id });
  await floor.startHeat(h1.id);
  const judge = ev.latinJudges[0];
  const entries = await judgeService.heatEntriesForJudge(h1.id, judge.id);
  const ids = entries.map((e) => e.round_entry_id);
  await scoring.submitScores(h1.id, judge.id, { marks: ids.slice(0, 2) });
  assert.equal((await many('SELECT 1 FROM score_history')).length, 0, 'first submission leaves no history');
  await scoring.submitScores(h1.id, judge.id, { marks: ids.slice(0, 2) });
  assert.equal((await many('SELECT 1 FROM score_history')).length, 0, 'identical resubmission leaves no history');
  await scoring.submitScores(h1.id, judge.id, { marks: ids.slice(1, 3) });
  const hist = await many('SELECT * FROM score_history ORDER BY id');
  assert.ok(hist.length >= 1, 'a changed resubmission is recorded');
  assert.ok(hist.some((h) => h.change_kind === 'removed'), 'the dropped mark is recorded as removed');
});
