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
const { closePool, one } = await import('../src/db/index.js');

before(async () => {
  await resetDatabase();
});
after(async () => {
  await closePool();
});
beforeEach(async () => {
  await resetDatabase();
});

async function setup({
  dancers = 6,
  heatSize = 6,
  judgeCount = 3,
  danceNames = ['Cha Cha', 'Samba'],
  round: roundOptions = {},
} = {}) {
  const competition = await comps.createCompetition({ name: 'Score Cup', feeCents: 0, status: 'open' });
  const division = await comps.addDivision({ competitionId: competition.id, name: 'U15 拉丁', sortOrder: 1 });

  const dances = [];
  for (const [i, name] of danceNames.entries()) {
    dances.push(await schedule.addDance({ competitionId: competition.id, name, sortOrder: i }));
  }
  await schedule.setDivisionDances(division.id, dances.map((d) => d.id));

  for (let i = 1; i <= dancers; i += 1) {
    await regs.register({ competitionId: competition.id, divisionId: division.id, athleteName: `選手 ${i}` });
  }
  const settled = await voucher.settle(competition.id);
  await schedule.assignBibs(settled.voucher.code);

  const round = await schedule.createRound({ divisionId: division.id, name: '初賽', heatSize, ...roundOptions });
  const entries = await schedule.seedFirstRound(settled.voucher.code, round.id);

  const judges = [];
  for (let i = 1; i <= judgeCount; i += 1) {
    const judge = await judgeService.addJudge({ competitionId: competition.id, name: `裁判 ${i}` });
    await judgeService.assignToDivision(judge.id, division.id);
    judges.push(judge);
  }

  const heatsByDance = {};
  for (const dance of dances) {
    heatsByDance[dance.name] = await schedule.buildHeats(round.id, dance.id);
  }
  await schedule.rebuildRunningOrder(competition.id);

  return { competition, division, round, entries, judges, dances, heatsByDance, voucher: settled.voucher };
}

async function runHeat(competition, heatId) {
  const { entries } = await schedule.heatWithEntries(heatId);
  for (const entry of entries) await floor.checkIn(entry.id);
  await floor.nextHeat(competition.id, { heatId });
  await floor.startHeat(heatId);
  return entries;
}

// ---------------------------------------------------------------- 過半數制 / skating system

test('過半數制：多數決，不是平均 / the skating system decides by majority, not by average', () => {
  // 三位裁判。A 拿 1,1,3；B 拿 2,2,2。平均 A=1.67 比 B=2 好，
  // 但兩人都在第 2 名就拿到多數，A 有 3 票、B 有 3 票，比第 1 名的票數 A 贏。
  // Three judges. A has 1,1,3 and B has 2,2,2. Both reach a majority at place 2;
  // A wins because more of A's marks are at or better than first place.
  const placed = scoring.skatingPlace(
    [
      { id: 'A', ranks: [1, 1, 3] },
      { id: 'B', ranks: [2, 2, 2] },
    ],
    3,
  );
  const byId = Object.fromEntries(placed.map((p) => [p.id, p.place]));
  assert.equal(byId.A, 1);
  assert.equal(byId.B, 2);
});

test('過半數制：先看誰先拿到過半 / the lowest place reaching a majority wins', () => {
  // A 在第 1 名就有 2 票（過半），B 要到第 2 名才過半。
  // A already has a majority at first place; B needs second place to get there.
  const placed = scoring.skatingPlace(
    [
      { id: 'A', ranks: [1, 1, 4] },
      { id: 'B', ranks: [2, 2, 1] },
    ],
    3,
  );
  const byId = Object.fromEntries(placed.map((p) => [p.id, p.place]));
  assert.equal(byId.A, 1);
  assert.equal(byId.B, 2);
});

test('過半數制：票數一樣時比名次總和 / equal counts are broken by the smaller sum', () => {
  // 兩人都在第 3 名拿到 3 票，但 A 的名次總和 1+3+3=7 小於 B 的 2+3+3=8。
  // Both reach three marks at place 3, but A's marks sum to 7 against B's 8.
  const placed = scoring.skatingPlace(
    [
      { id: 'A', ranks: [1, 3, 3] },
      { id: 'B', ranks: [2, 3, 3] },
    ],
    3,
  );
  const byId = Object.fromEntries(placed.map((p) => [p.id, p.place]));
  assert.equal(byId.A, 1);
  assert.equal(byId.B, 2);
});

test('過半數制：完全一樣就並列 / identical marks share a place', () => {
  const placed = scoring.skatingPlace(
    [
      { id: 'A', ranks: [1, 2, 2] },
      { id: 'B', ranks: [1, 2, 2] },
    ],
    3,
  );
  assert.equal(placed[0].place, 1);
  assert.equal(placed[1].place, 1, 'a genuine tie shares first place');
});

test('過半數制：五位裁判的標準例子 / a five-judge worked example', () => {
  const placed = scoring.skatingPlace(
    [
      { id: 'A', ranks: [1, 1, 2, 2, 3] },
      { id: 'B', ranks: [2, 2, 1, 1, 1] },
      { id: 'C', ranks: [3, 3, 3, 3, 2] },
    ],
    5,
  );
  const byId = Object.fromEntries(placed.map((p) => [p.id, p.place]));
  // B 在第 1 名就有 3 票（過半），A 要到第 2 名才有 4 票。
  // B has three firsts, a majority straight away; A needs place 2 to reach four.
  assert.equal(byId.B, 1);
  assert.equal(byId.A, 2);
  assert.equal(byId.C, 3);
});

// ---------------------------------------------------------------- mark 模式

test('mark：所有舞科、所有裁判的 mark 全部加總 / marks add up across every dance and judge', async () => {
  const { competition, round, entries, judges, dances, heatsByDance } = await setup({
    dancers: 6,
    heatSize: 6,
    round: { scoringMode: 'mark', advanceCount: 3 },
  });

  // 名額是 3，所以每位裁判每支舞只能勾 3 個。
  // 裁判 1 在 Cha Cha 換掉 103、改勾 104，其他人一律勾 101、102、103。
  // The quota is three, so each judge ticks three per dance.
  // In Cha Cha judge 1 swaps 103 for 104; everyone else ticks 101, 102, 103.
  for (const dance of dances) {
    const heatId = heatsByDance[dance.name][0].id;
    await runHeat(competition, heatId);
    const visible = await judgeService.heatEntriesForJudge(heatId, judges[0].id);
    const byBib = new Map(visible.map((v) => [v.bib_number, String(v.round_entry_id)]));

    for (const [index, judge] of judges.entries()) {
      const swap = index === 0 && dance.name === 'Cha Cha';
      const marks = [byBib.get(101), byBib.get(102), byBib.get(swap ? 104 : 103)];
      await scoring.submitScores(heatId, judge.id, { marks });
    }
    await floor.nextHeat(competition.id);
  }

  const result = await scoring.computeRound(round.id);
  const byBib = Object.fromEntries(result.ranked.map((r) => [r.bib, r]));

  // 3 位裁判 × 2 支舞 = 6 個 mark。
  // Three judges times two dances is six marks.
  assert.equal(byBib[101].totalMarks, 6);
  assert.equal(byBib[103].totalMarks, 5, 'one judge left 103 out of Cha Cha');
  assert.equal(byBib[104].totalMarks, 1);
  assert.equal(byBib[105].totalMarks, 0);

  const advanced = result.ranked.filter((r) => r.advanced).map((r) => r.bib);
  assert.deepEqual(advanced.sort(), [101, 102, 103]);
});

test('mark 名額：每支舞總名額，勾超過會被擋 / the whole-dance quota is enforced', async () => {
  const { competition, round, judges, dances, heatsByDance } = await setup({
    dancers: 9,
    heatSize: 3,
    round: { scoringMode: 'mark', advanceCount: 4, markQuotaMode: 'per_dance' },
  });

  const heats = heatsByDance['Cha Cha'];
  assert.equal(heats.length, 3);

  // 第一批勾 3 個、第二批勾 1 個，總共 4 個，剛好用完名額。
  // Three in the first heat and one in the second uses the whole quota of four.
  let used = 0;
  for (const [index, heat] of heats.entries()) {
    await runHeat(competition, heat.id);
    const visible = await judgeService.heatEntriesForJudge(heat.id, judges[0].id);
    const want = index === 0 ? 3 : index === 1 ? 1 : 1;
    const marks = visible.slice(0, want).map((v) => String(v.round_entry_id));

    if (used + want > 4) {
      await assert.rejects(
        () => scoring.submitScores(heat.id, judges[0].id, { marks }),
        (err) => err.key === 'scoring.errors.overQuota',
      );
    } else {
      await scoring.submitScores(heat.id, judges[0].id, { marks });
      used += want;
    }
    await floor.nextHeat(competition.id);
  }

  const total = await one(
    'SELECT COUNT(*)::int AS n FROM scores WHERE round_id = $1 AND judge_id = $2 AND marked = TRUE',
    [round.id, judges[0].id],
  );
  assert.equal(total.n, 4, 'the judge never exceeds the quota');
});

test('mark 名額可以改成每批固定 / the per-heat quota is the alternative', async () => {
  const { round, judges, dances } = await setup({
    dancers: 9,
    heatSize: 3,
    round: { scoringMode: 'mark', advanceCount: 3, markQuotaMode: 'per_heat' },
  });
  const freshRound = await schedule.getRound(round.id);
  const heatRow = await one(
    `SELECT h.id FROM heats h JOIN heat_entries he ON he.heat_id = h.id WHERE he.round_id = $1 LIMIT 1`,
    [round.id],
  );
  const quota = await scoring.markQuota({
    round: freshRound,
    danceId: dances[0].id,
    judgeId: judges[0].id,
    heatId: heatRow.id,
  });
  // 9 人取 3，每批 3 人 → 每批 1 個。
  // Nine dancers, three places, heats of three: one mark per heat.
  assert.equal(quota.scope, 'per_heat');
  assert.equal(quota.limit, 1);
});

// ---------------------------------------------------------------- 打分數 / points

test('打分數：各支舞加總，可去頭去尾 / points add across dances, with an optional trim', async () => {
  const { competition, round, judges, dances, heatsByDance } = await setup({
    dancers: 3,
    heatSize: 3,
    judgeCount: 5,
    danceNames: ['Cha Cha'],
    round: { scoringMode: 'score', scoreMethod: 'trimmed' },
  });

  const heatId = heatsByDance['Cha Cha'][0].id;
  await runHeat(competition, heatId);
  const visible = await judgeService.heatEntriesForJudge(heatId, judges[0].id);
  const byBib = new Map(visible.map((v) => [v.bib_number, String(v.round_entry_id)]));

  // 選手 101 拿到 9, 9, 9, 9, 1：去掉最高最低之後是 9。
  // Dancer 101 gets 9,9,9,9,1. Dropping the top and bottom leaves 9.
  const sheets = [
    { 101: 9, 102: 5, 103: 7 },
    { 101: 9, 102: 5, 103: 7 },
    { 101: 9, 102: 5, 103: 7 },
    { 101: 9, 102: 5, 103: 7 },
    { 101: 1, 102: 5, 103: 7 },
  ];
  for (const [index, judge] of judges.entries()) {
    const points = {};
    for (const [bib, value] of Object.entries(sheets[index])) points[byBib.get(Number(bib))] = value;
    await scoring.submitScores(heatId, judge.id, { points });
  }

  const result = await scoring.computeRound(round.id);
  const byBibResult = Object.fromEntries(result.ranked.map((r) => [r.bib, r]));
  assert.equal(byBibResult[101].totalPoints, 9, 'the outlier 1 is trimmed away');
  assert.equal(byBibResult[101].finalRank, 1);
  assert.equal(byBibResult[103].totalPoints, 7);
  assert.equal(byBibResult[102].totalPoints, 5);
});

// ---------------------------------------------------------------- 排名次 / placings

test('排名次：名次加總，數字小者勝 / rank sum puts the lowest total first', async () => {
  const { competition, round, judges, dances, heatsByDance } = await setup({
    dancers: 3,
    heatSize: 3,
    judgeCount: 3,
    danceNames: ['Cha Cha', 'Samba'],
    round: { scoringMode: 'rank', rankMethod: 'sum' },
  });

  for (const dance of dances) {
    const heatId = heatsByDance[dance.name][0].id;
    await runHeat(competition, heatId);
    const visible = await judgeService.heatEntriesForJudge(heatId, judges[0].id);
    const byBib = new Map(visible.map((v) => [v.bib_number, String(v.round_entry_id)]));
    for (const judge of judges) {
      await scoring.submitScores(heatId, judge.id, {
        ranks: { [byBib.get(101)]: 1, [byBib.get(102)]: 2, [byBib.get(103)]: 3 },
      });
    }
    await floor.nextHeat(competition.id);
  }

  const result = await scoring.computeRound(round.id);
  const byBib = Object.fromEntries(result.ranked.map((r) => [r.bib, r]));
  assert.equal(byBib[101].finalRank, 1);
  assert.equal(byBib[101].totalPoints, 6, '3 judges x 2 dances x first place');
  assert.equal(byBib[103].finalRank, 3);
});

test('排名次：同一位裁判不能給兩人相同名次 / a judge cannot repeat a place', async () => {
  const { competition, judges, heatsByDance } = await setup({
    dancers: 3,
    heatSize: 3,
    danceNames: ['Cha Cha'],
    round: { scoringMode: 'rank' },
  });
  const heatId = heatsByDance['Cha Cha'][0].id;
  await runHeat(competition, heatId);
  const visible = await judgeService.heatEntriesForJudge(heatId, judges[0].id);

  await assert.rejects(
    () =>
      scoring.submitScores(heatId, judges[0].id, {
        ranks: {
          [String(visible[0].round_entry_id)]: 1,
          [String(visible[1].round_entry_id)]: 1,
          [String(visible[2].round_entry_id)]: 3,
        },
      }),
    (err) => err.key === 'scoring.errors.duplicateRank',
  );
});

test('排名次：過半數制跑完整場 / the skating system runs end to end', async () => {
  const { competition, round, judges, dances, heatsByDance } = await setup({
    dancers: 3,
    heatSize: 3,
    judgeCount: 3,
    danceNames: ['Cha Cha'],
    round: { scoringMode: 'rank', rankMethod: 'skating' },
  });

  const heatId = heatsByDance['Cha Cha'][0].id;
  await runHeat(competition, heatId);
  const visible = await judgeService.heatEntriesForJudge(heatId, judges[0].id);
  const byBib = new Map(visible.map((v) => [v.bib_number, String(v.round_entry_id)]));

  // 101 拿 1,1,3；102 拿 2,2,2；103 拿 3,3,1。
  // 平均的話 102 贏，但過半數制是 101 贏。
  // On averages 102 would win; under the skating system 101 does.
  const sheets = [
    { 101: 1, 102: 2, 103: 3 },
    { 101: 1, 102: 2, 103: 3 },
    { 101: 3, 102: 2, 103: 1 },
  ];
  for (const [index, judge] of judges.entries()) {
    const ranks = {};
    for (const [bib, place] of Object.entries(sheets[index])) ranks[byBib.get(Number(bib))] = place;
    await scoring.submitScores(heatId, judge.id, { ranks });
  }

  const result = await scoring.computeRound(round.id);
  const byBibResult = Object.fromEntries(result.ranked.map((r) => [r.bib, r]));
  assert.equal(byBibResult[101].finalRank, 1);
  assert.equal(byBibResult[102].finalRank, 2);
  assert.equal(byBibResult[103].finalRank, 3);
});

// ---------------------------------------------------------------- 缺席、作廢、晉級

test('缺席的人記為缺席，不影響其他人 / an absent competitor is recorded, not ranked', async () => {
  const { competition, round, judges, heatsByDance } = await setup({
    dancers: 3,
    heatSize: 3,
    danceNames: ['Cha Cha'],
    round: { scoringMode: 'mark', advanceCount: 2 },
  });

  const heatId = heatsByDance['Cha Cha'][0].id;
  const entries = await runHeat(competition, heatId);
  await floor.markAbsent(entries[2].round_entry_id);

  const visible = await judgeService.heatEntriesForJudge(heatId, judges[0].id);
  assert.equal(visible.length, 2);
  for (const judge of judges) {
    await scoring.submitScores(heatId, judge.id, { marks: [String(visible[0].round_entry_id)] });
  }

  const result = await scoring.computeRound(round.id);
  assert.equal(result.ranked.length, 2);
  assert.equal(result.absent.length, 1);

  const stored = await scoring.resultsFor(round.id);
  assert.equal(stored.filter((r) => r.absent).length, 1);
});

test('作廢的裁判不算，其餘裁判照算 / a voided judge drops out and the rest still count', async () => {
  const { competition, round, judges, heatsByDance } = await setup({
    dancers: 3,
    heatSize: 3,
    danceNames: ['Cha Cha'],
    round: { scoringMode: 'mark', advanceCount: 2 },
  });

  const heatId = heatsByDance['Cha Cha'][0].id;
  await runHeat(competition, heatId);
  const visible = await judgeService.heatEntriesForJudge(heatId, judges[0].id);

  await scoring.submitScores(heatId, judges[0].id, { marks: [String(visible[0].round_entry_id)] });
  await scoring.submitScores(heatId, judges[1].id, { marks: [String(visible[0].round_entry_id)] });
  await floor.judgeLeftScreen(heatId, judges[2].id);

  const result = await scoring.computeRound(round.id);
  const top = result.ranked[0];
  assert.equal(top.totalMarks, 2, 'only the two judges who stayed count');
});

test('同分卡在晉級線：可以全部晉級，也可以加賽 / a tie at the cut-off follows the organiser choice', async () => {
  for (const policy of ['advance_all', 'dance_off']) {
    await resetDatabase();
    const { competition, round, judges, heatsByDance } = await setup({
      dancers: 4,
      heatSize: 4,
      danceNames: ['Cha Cha'],
      round: { scoringMode: 'mark', advanceCount: 2, tiePolicy: policy },
    });

    const heatId = heatsByDance['Cha Cha'][0].id;
    await runHeat(competition, heatId);
    const visible = await judgeService.heatEntriesForJudge(heatId, judges[0].id);
    const ids = visible.map((v) => String(v.round_entry_id));

    // 第 1 名一個，第 2 名三個人同分。
    // One clear leader, then three dancers tied for second.
    for (const judge of judges) {
      await scoring.submitScores(heatId, judge.id, { marks: [ids[0]] });
    }
    await scoring.submitScores(heatId, judges[0].id, { marks: [ids[0], ids[1]] });
    await scoring.submitScores(heatId, judges[1].id, { marks: [ids[0], ids[2]] });
    await scoring.submitScores(heatId, judges[2].id, { marks: [ids[0], ids[3]] });

    const result = await scoring.computeRound(round.id);
    assert.equal(result.tieAtCut, true, `${policy}: the tie is detected`);
    if (policy === 'advance_all') {
      assert.equal(result.advanced, 4, 'everyone tied at the line goes through');
    } else {
      assert.equal(result.advanced, 1, 'only the clear qualifier goes through; the rest dance off');
    }
  }
});

test('下一輪的名單依晉級名單自動產生 / the next round is seeded from whoever advanced', async () => {
  const { competition, division, round, judges, heatsByDance } = await setup({
    dancers: 6,
    heatSize: 6,
    danceNames: ['Cha Cha'],
    round: { scoringMode: 'mark', advanceCount: 3 },
  });

  const heatId = heatsByDance['Cha Cha'][0].id;
  await runHeat(competition, heatId);
  const visible = await judgeService.heatEntriesForJudge(heatId, judges[0].id);
  const ids = visible.map((v) => String(v.round_entry_id));
  for (const judge of judges) {
    await scoring.submitScores(heatId, judge.id, { marks: ids.slice(0, 3) });
  }
  await scoring.computeRound(round.id);

  const final = await schedule.createRound({
    divisionId: division.id,
    name: '決賽',
    sortOrder: 2,
    scoringMode: 'rank',
    rankMethod: 'skating',
  });
  const seeded = await scoring.seedNextRound(round.id, final.id);
  assert.equal(seeded.length, 3);
  assert.deepEqual(seeded.map((s) => s.bib_number).sort(), [101, 102, 103]);
});

test('成績要按公告才對外顯示 / results stay private until the organiser publishes', async () => {
  const { round } = await setup({ dancers: 3, heatSize: 3, danceNames: ['Cha Cha'] });
  const before = await schedule.getRound(round.id);
  assert.equal(before.published_at, null);

  await scoring.publishRound(round.id);
  assert.notEqual((await schedule.getRound(round.id)).published_at, null);

  await scoring.unpublishRound(round.id);
  assert.equal((await schedule.getRound(round.id)).published_at, null);
});
