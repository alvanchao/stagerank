import { resetDatabase } from './helpers.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const voucher = await import('../src/services/voucher.js');
const schedule = await import('../src/services/schedule.js');
const judgeService = await import('../src/services/judges.js');
const floor = await import('../src/services/floor.js');
const scoring = await import('../src/services/scoring.js');
const realtime = await import('../src/services/realtime.js');
const { closePool, one, query } = await import('../src/db/index.js');

before(async () => {
  await resetDatabase();
});
after(async () => {
  await closePool();
});
beforeEach(async () => {
  await resetDatabase();
});

// 一場小比賽：一個組別、6 人、兩支舞、每批 3 人、3 位裁判。
// A small competition: one division, six dancers, two dances, heats of three, three judges.
async function setup({ dancers = 6, heatSize = 3, judgeCount = 3, scoringMode = 'mark', advanceCount = 3, extra = {} } = {}) {
  const competition = await comps.createCompetition({ name: 'Floor Cup', feeCents: 0, status: 'open' });
  const division = await comps.addDivision({ competitionId: competition.id, name: 'U15 拉丁', sortOrder: 1 });
  const cha = await schedule.addDance({ competitionId: competition.id, name: 'Cha Cha', sortOrder: 1 });
  const samba = await schedule.addDance({ competitionId: competition.id, name: 'Samba', sortOrder: 2 });
  await schedule.setDivisionDances(division.id, [cha.id, samba.id]);

  for (let i = 1; i <= dancers; i += 1) {
    await regs.register({ competitionId: competition.id, divisionId: division.id, athleteName: `選手 ${i}` });
  }
  const settled = await voucher.settle(competition.id);
  await schedule.assignBibs(settled.voucher.code);

  const round = await schedule.createRound({
    divisionId: division.id,
    name: '初賽',
    heatSize,
    scoringMode,
    advanceCount,
    ...extra,
  });
  await schedule.seedFirstRound(settled.voucher.code, round.id);

  const judges = [];
  for (let i = 1; i <= judgeCount; i += 1) {
    const judge = await judgeService.addJudge({ competitionId: competition.id, name: `裁判 ${i}` });
    await judgeService.assignToDivision(judge.id, division.id);
    judges.push(judge);
  }

  const chaHeats = await schedule.buildHeats(round.id, cha.id);
  const sambaHeats = await schedule.buildHeats(round.id, samba.id);
  await schedule.rebuildRunningOrder(competition.id);

  return { competition, division, round, judges, dances: { cha, samba }, chaHeats, sambaHeats, voucher: settled.voucher };
}

async function checkInEveryone(heatId) {
  const { entries } = await schedule.heatWithEntries(heatId);
  for (const entry of entries) await floor.checkIn(entry.id);
  return entries;
}

test('沒報到的選手在檢錄畫面上反灰 / a competitor who never reported in shows as greyed out', async () => {
  const { competition, chaHeats } = await setup();
  const board = await floor.checkInBoard(competition.id);

  assert.ok(board.heats.length >= 1);
  const first = board.heats[0];
  assert.equal(first.entries.every((e) => e.reported_at === null), true, 'nobody has reported in yet');
  assert.equal(first.ready, false);

  await floor.reportIn(first.entries[0].registration_id);
  const after = await floor.checkInBoard(competition.id);
  assert.notEqual(after.heats[0].entries[0].reported_at, null);
});

test('檢錄可以修正漏按的報到 / check-in fixes a missed report-in in one tap', async () => {
  const { competition, chaHeats } = await setup();
  const { entries } = await schedule.heatWithEntries(chaHeats[0].id);
  const target = entries[0];

  const registration = await one(
    'SELECT r.* FROM registrations r JOIN round_entries re ON re.registration_id = r.id WHERE re.id = $1',
    [target.round_entry_id],
  );
  assert.equal(registration.reported_at, null);

  await floor.checkIn(target.id, { by: 'checkin' });

  const after = await one('SELECT * FROM registrations WHERE id = $1', [registration.id]);
  assert.notEqual(after.reported_at, null, 'checking in also reports them in');
  const entry = await one('SELECT * FROM heat_entries WHERE id = $1', [target.id]);
  assert.notEqual(entry.checked_in_at, null);
});

test('裁判只看得到已檢錄的選手 / a judge only sees competitors who have checked in', async () => {
  const { chaHeats, judges } = await setup();
  const heatId = chaHeats[0].id;

  assert.equal((await judgeService.heatEntriesForJudge(heatId, judges[0].id)).length, 0);

  const { entries } = await schedule.heatWithEntries(heatId);
  await floor.checkIn(entries[0].id);
  const visible = await judgeService.heatEntriesForJudge(heatId, judges[0].id);
  assert.equal(visible.length, 1);
  assert.equal(String(visible[0].round_entry_id), String(entries[0].round_entry_id));
});

test('音樂放了才衝進場：主持人補點，選手立刻出現在裁判手機 / the host can add a late arrival mid-heat', async () => {
  const { competition, chaHeats, judges } = await setup();
  const heatId = chaHeats[0].id;
  const { entries } = await schedule.heatWithEntries(heatId);

  await floor.checkIn(entries[0].id);
  await floor.checkIn(entries[1].id);
  await floor.nextHeat(competition.id, { heatId });
  await floor.startHeat(heatId);

  assert.equal((await judgeService.heatEntriesForJudge(heatId, judges[0].id)).length, 2);

  // 評分進行中也可以補點。
  // Adding someone works even while scoring is under way.
  await floor.checkIn(entries[2].id, { by: 'host' });
  const after = await judgeService.heatEntriesForJudge(heatId, judges[0].id);
  assert.equal(after.length, 3, 'the late arrival appears for the judges immediately');
});

test('這一場結束之後就不能再補點 / once the heat is closed nobody can be added', async () => {
  const { competition, chaHeats } = await setup();
  const heatId = chaHeats[0].id;
  const { entries } = await schedule.heatWithEntries(heatId);
  await floor.checkIn(entries[0].id);

  await floor.nextHeat(competition.id, { heatId });
  await floor.startHeat(heatId);
  await floor.nextHeat(competition.id); // 換到下一場，這一場關閉 / change over, closing this heat

  await assert.rejects(() => floor.checkIn(entries[1].id), (err) => err.key === 'floor.errors.heatClosed');
});

test('換場：上一場自動收件並關閉，下一場進入預備 / change-over auto-collects, closes, and puts the next on standby', async () => {
  const { competition, chaHeats, judges, round, dances } = await setup();
  const first = chaHeats[0].id;
  await checkInEveryone(first);

  await floor.nextHeat(competition.id, { heatId: first });
  await floor.startHeat(first);

  // 裁判 1 送出，裁判 2、3 什麼都沒按。
  // Judge 1 submits; judges 2 and 3 never press anything.
  const visible = await judgeService.heatEntriesForJudge(first, judges[0].id);
  await scoring.submitScores(first, judges[0].id, { marks: visible.slice(0, 1).map((v) => String(v.round_entry_id)) });

  const result = await floor.nextHeat(competition.id);
  assert.equal(String(result.closed.id), String(first));

  const closed = await one('SELECT * FROM heats WHERE id = $1', [first]);
  assert.equal(closed.status, 'closed');

  // 自動收件：三位裁判都留下紀錄，沒填的視為沒給。
  // Auto-collect: all three judges are recorded; blanks simply count as nothing given.
  const collected = await one('SELECT COUNT(*)::int AS n FROM heat_judges WHERE heat_id = $1 AND submitted_at IS NOT NULL', [first]);
  assert.equal(collected.n, 3);

  const marks = await one(
    'SELECT COUNT(*)::int AS n FROM scores WHERE heat_id = $1 AND marked = TRUE',
    [first],
  );
  assert.equal(marks.n, 1, 'only the mark that was actually ticked counts');

  assert.notEqual(result.next, null);
  assert.equal(result.next.heat.status, 'standby');
});

test('主持人按開始之前，跳出畫面不算作弊 / leaving the screen during standby is not cheating', async () => {
  const { competition, chaHeats, judges } = await setup();
  const heatId = chaHeats[0].id;
  await checkInEveryone(heatId);
  await floor.nextHeat(competition.id, { heatId });

  const standby = await floor.judgeLeftScreen(heatId, judges[0].id);
  assert.equal(standby.voided, false);
  assert.equal(standby.reason, 'not-scoring');

  await floor.startHeat(heatId);
  const scoringPhase = await floor.judgeLeftScreen(heatId, judges[0].id);
  assert.equal(scoringPhase.voided, true, 'once scoring has started it counts');
});

test('跳出作廢：當下這一場不能補評，下一場自動恢復 / a walk-away voids this heat only', async () => {
  const { competition, chaHeats, judges } = await setup();
  const first = chaHeats[0].id;
  const second = chaHeats[1].id;

  await checkInEveryone(first);
  await floor.nextHeat(competition.id, { heatId: first });
  await floor.startHeat(first);

  // 還沒送出就離開畫面：這一場作廢。
  // Leaving before submitting: this heat is void for that judge.
  const visible = await judgeService.heatEntriesForJudge(first, judges[0].id);
  const walked = await floor.judgeLeftScreen(first, judges[0].id);
  assert.equal(walked.voided, true);

  const left = await one('SELECT COUNT(*)::int AS n FROM scores WHERE heat_id = $1 AND judge_id = $2', [first, judges[0].id]);
  assert.equal(left.n, 0, 'nothing of theirs counts for this heat');

  await assert.rejects(
    () => scoring.submitScores(first, judges[0].id, { marks: [String(visible[0].round_entry_id)] }),
    (err) => err.key === 'scoring.errors.voided',
  );

  // 下一場自動恢復。
  // The next heat restores them automatically.
  await checkInEveryone(second);
  await floor.nextHeat(competition.id, { heatId: second });
  await floor.startHeat(second);
  const nextVisible = await judgeService.heatEntriesForJudge(second, judges[0].id);
  const ok = await scoring.submitScores(second, judges[0].id, { marks: [String(nextVisible[0].round_entry_id)] });
  assert.equal(ok.accepted > 0, true);
});

test('主持人燈號看得出檢錄與裁判狀態 / the host board shows check-in and judge lights', async () => {
  const { competition, chaHeats, judges } = await setup();
  const heatId = chaHeats[0].id;
  await checkInEveryone(heatId);
  await floor.nextHeat(competition.id, { heatId });

  let board = await floor.hostBoard(competition.id);
  assert.equal(board.current.heat.status, 'standby');
  assert.deepEqual(board.current.judges.map((j) => j.light), ['waiting', 'waiting', 'waiting']);

  await floor.judgeReady(heatId, judges[0].id);
  board = await floor.hostBoard(competition.id);
  assert.equal(board.current.judges.find((j) => String(j.id) === String(judges[0].id)).light, 'ready');

  await floor.startHeat(heatId);
  const visible = await judgeService.heatEntriesForJudge(heatId, judges[1].id);
  await scoring.submitScores(heatId, judges[1].id, { marks: [String(visible[0].round_entry_id)] });
  board = await floor.hostBoard(competition.id);
  assert.equal(board.current.judges.find((j) => String(j.id) === String(judges[1].id)).light, 'submitted');

  await floor.judgeLeftScreen(heatId, judges[2].id);
  board = await floor.hostBoard(competition.id);
  assert.equal(board.current.judges.find((j) => String(j.id) === String(judges[2].id)).light, 'voided');
});

test('燈號只是提醒，主持人還是可以開始 / the lights never block the host', async () => {
  const { competition, chaHeats } = await setup();
  const heatId = chaHeats[0].id;
  // 沒有人檢錄、沒有裁判按準備好，主持人照樣可以開始。
  // Nobody checked in, no judge confirmed, and the host can still start.
  await floor.nextHeat(competition.id, { heatId });
  const started = await floor.startHeat(heatId);
  assert.equal(started.heat.status, 'scoring');
});

test('裁判候場提示：還有幾場是精確的 / the judge waiting notice counts heats exactly', async () => {
  const competition = await comps.createCompetition({ name: 'Wait Cup', feeCents: 0, status: 'open' });
  const a = await comps.addDivision({ competitionId: competition.id, name: 'A', sortOrder: 1 });
  const b = await comps.addDivision({ competitionId: competition.id, name: 'B', sortOrder: 2 });
  const cha = await schedule.addDance({ competitionId: competition.id, name: 'Cha Cha', sortOrder: 1 });
  await schedule.setDivisionDances(a.id, [cha.id]);
  await schedule.setDivisionDances(b.id, [cha.id]);

  for (const division of [a, b]) {
    for (let i = 1; i <= 6; i += 1) {
      await regs.register({ competitionId: competition.id, divisionId: division.id, athleteName: `${division.name}${i}` });
    }
  }
  const settled = await voucher.settle(competition.id);
  await schedule.assignBibs(settled.voucher.code);

  for (const division of [a, b]) {
    const round = await schedule.createRound({ divisionId: division.id, name: '初賽', heatSize: 3 });
    await schedule.seedFirstRound(settled.voucher.code, round.id);
    await schedule.buildHeats(round.id, cha.id);
  }
  await schedule.rebuildRunningOrder(competition.id);

  const judgeB = await judgeService.addJudge({ competitionId: competition.id, name: '只評 B' });
  await judgeService.assignToDivision(judgeB.id, b.id);

  const info = await floor.judgeWaitingInfo(competition.id, judgeB.id);
  assert.equal(info.hasNext, true);
  assert.equal(info.heatsAway, 2, 'A has two heats first');
  assert.equal(info.next.divisions, 'B');
  assert.equal(info.next.danceName, 'Cha Cha');
  assert.ok(info.secondsAway > 0);
  // 只顯示組別、舞科和場數，不顯示選手名單。
  // Only the division, the dance and the count; never the competitor list.
  assert.equal(Object.prototype.hasOwnProperty.call(info.next, 'entries'), false);
});

test('主持人調整順序後候場提示立即更新 / re-ordering updates the waiting notice at once', async () => {
  const { competition, chaHeats, judges } = await setup();
  const before = await floor.judgeWaitingInfo(competition.id, judges[0].id);
  assert.equal(before.heatsAway, 0);

  const order = await schedule.runningOrder(competition.id);
  await schedule.moveHeat(order[0].id, { afterHeatId: order[order.length - 1].id });
  const after = await floor.judgeWaitingInfo(competition.id, judges[0].id);
  assert.equal(after.heatsAway, 0, 'the judge still has a heat coming, now a different one');
  assert.notEqual(order[0].id, (await schedule.runningOrder(competition.id))[0].id);
});

test('標記缺席的選手不會出現在裁判畫面 / a competitor marked absent disappears from the judges screens', async () => {
  const { chaHeats, judges } = await setup();
  const heatId = chaHeats[0].id;
  const entries = await checkInEveryone(heatId);

  assert.equal((await judgeService.heatEntriesForJudge(heatId, judges[0].id)).length, entries.length);
  await floor.markAbsent(entries[0].round_entry_id);
  const after = await judgeService.heatEntriesForJudge(heatId, judges[0].id);
  assert.equal(after.length, entries.length - 1);
});

test('即時推播：換場時每個人都收得到 / a change-over is pushed live to everyone', async () => {
  const { competition, chaHeats } = await setup();
  const received = [];
  const stop = realtime.subscribe(competition.id, (event) => received.push(event.type));

  await checkInEveryone(chaHeats[0].id);
  await floor.nextHeat(competition.id, { heatId: chaHeats[0].id });
  await floor.startHeat(chaHeats[0].id);
  stop();

  assert.ok(received.includes('checkin'));
  assert.ok(received.includes('heat-standby'));
  assert.ok(received.includes('heat-start'));
});

test('比賽一開始評分就不能重新結算 / once a heat starts the roster is frozen', async () => {
  const { competition, chaHeats, voucher: v } = await setup();
  await floor.nextHeat(competition.id, { heatId: chaHeats[0].id });

  await assert.rejects(
    () => voucher.settle(competition.id, { resettle: true }),
    (err) => err.key === 'admin.cannotResettle',
  );
});

test('同一輪開始後不能換裁判 / judges cannot be swapped once the round is running', async () => {
  const { competition, division, chaHeats, judges } = await setup();
  const spare = await judgeService.addJudge({ competitionId: competition.id, name: '備用' });

  await floor.nextHeat(competition.id, { heatId: chaHeats[0].id });

  await assert.rejects(
    () => judgeService.assignToDivision(spare.id, division.id),
    (err) => err.key === 'judges.errors.roundStarted',
  );
  await assert.rejects(
    () => judgeService.replaceJudge(division.id, judges[0].id, spare.id),
    (err) => err.key === 'judges.errors.roundStarted',
  );
});

test('送出之後才離開畫面不算作弊 / leaving after submitting is not cheating', async () => {
  const { competition, chaHeats, judges } = await setup();
  const heatId = chaHeats[0].id;
  await checkInEveryone(heatId);
  await floor.nextHeat(competition.id, { heatId });
  await floor.startHeat(heatId);

  const visible = await judgeService.heatEntriesForJudge(heatId, judges[0].id);
  await scoring.submitScores(heatId, judges[0].id, { marks: [String(visible[0].round_entry_id)] });

  // 已經送出就沒有作弊的空間了，這時候離開畫面是正常的。
  // Once the marks are in there is nothing left to gain, so walking away is fine.
  const result = await floor.judgeLeftScreen(heatId, judges[0].id);
  assert.equal(result.voided, false);
  assert.equal(result.reason, 'already-submitted');

  const kept = await one('SELECT COUNT(*)::int AS n FROM scores WHERE heat_id = $1 AND judge_id = $2 AND marked = TRUE', [
    heatId,
    judges[0].id,
  ]);
  assert.equal(kept.n, 1, 'their submitted mark still counts');
});
