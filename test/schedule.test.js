import { resetDatabase } from './helpers.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const voucher = await import('../src/services/voucher.js');
const schedule = await import('../src/services/schedule.js');
const judges = await import('../src/services/judges.js');
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

// U15 拉丁 30 人、場上站 10 到 12 人就很難跳，所以分 3 個 heat。
// The worked example: 30 dancers, a floor that holds 10-12, so three heats.
async function buildCompetition({ names = 30, divisionNames = ['U15 拉丁'], danceNames = ['Cha Cha', 'Samba'] } = {}) {
  const competition = await comps.createCompetition({ name: 'Heat Test Cup', feeCents: 0, status: 'open' });
  const dances = [];
  for (const [i, name] of danceNames.entries()) {
    dances.push(await schedule.addDance({ competitionId: competition.id, name, sortOrder: i }));
  }

  const divisions = [];
  for (const [di, dname] of divisionNames.entries()) {
    const division = await comps.addDivision({ competitionId: competition.id, name: dname, sortOrder: di });
    await schedule.setDivisionDances(division.id, dances.map((d) => d.id));
    const count = Array.isArray(names) ? names[di] : names;
    for (let i = 1; i <= count; i += 1) {
      await regs.register({
        competitionId: competition.id,
        divisionId: division.id,
        athleteName: `${dname} 選手 ${i}`,
        unitName: `Club ${((i - 1) % 4) + 1}`,
      });
    }
    divisions.push(division);
  }

  const settled = await voucher.settle(competition.id);
  await schedule.assignBibs(settled.voucher.code);
  return { competition, divisions, dances, voucher: settled.voucher };
}

test('背號只給結算名單裡的人，依組別分區段 / bibs go to the settled roster, one block per division', async () => {
  const { voucher: v } = await buildCompetition({ names: [3, 2], divisionNames: ['U12', 'U15'] });
  const roster = await schedule.rosterWithBibs(v.code);

  assert.equal(roster.length, 5);
  const u12 = roster.filter((r) => r.division_name === 'U12').map((r) => r.bib_number);
  const u15 = roster.filter((r) => r.division_name === 'U15').map((r) => r.bib_number);
  assert.deepEqual(u12, [101, 102, 103]);
  assert.deepEqual(u15, [201, 202]);
  assert.equal(new Set(roster.map((r) => r.bib_number)).size, 5, 'bibs are unique');
});

test('平均分批：30 人分 10/10/10、31 人分 11/10/10 / heats split evenly, no tiny heat', () => {
  assert.deepEqual(schedule.planHeatSizes(30, 10), [10, 10, 10]);
  assert.deepEqual(schedule.planHeatSizes(31, 10), [11, 10, 10]);
  assert.deepEqual(schedule.planHeatSizes(10, 10), [10]);
  assert.deepEqual(schedule.planHeatSizes(11, 10), [11]);
  assert.deepEqual(schedule.planHeatSizes(12, 10), [6, 6]);
  assert.deepEqual(schedule.planHeatSizes(0, 10), []);
  assert.deepEqual(schedule.planHeatSizes(1, 10), [1]);

  // 不管幾個人，都不會出現只有一兩個人的一批。
  // Whatever the number, no heat is left with one or two dancers.
  for (let n = 3; n <= 200; n += 1) {
    for (const size of [6, 8, 10, 12]) {
      const sizes = schedule.planHeatSizes(n, size);
      assert.equal(sizes.reduce((a, b) => a + b, 0), n, `sizes sum to ${n}`);
      if (sizes.length > 1) {
        assert.ok(Math.min(...sizes) >= 3, `n=${n} size=${size} left a tiny heat: ${sizes}`);
        assert.ok(Math.max(...sizes) <= size + 1, `n=${n} size=${size} overfilled: ${sizes}`);
        assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `n=${n} size=${size} uneven: ${sizes}`);
      }
    }
  }
});

test('U15 拉丁 30 人分成 3 批，每批 10 人 / the worked example produces three heats of ten', async () => {
  const { competition, divisions, dances, voucher: v } = await buildCompetition({ names: 30 });
  const round = await schedule.createRound({ divisionId: divisions[0].id, name: '初賽', heatSize: 10, advanceCount: 15 });
  await schedule.seedFirstRound(v.code, round.id);

  const heats = await schedule.buildHeats(round.id, dances[0].id);
  assert.equal(heats.length, 3);
  assert.deepEqual(heats.map((h) => h.size), [10, 10, 10]);
  assert.match(heats[0].label, /U15 拉丁 · Cha Cha · 1\/3/);

  await schedule.buildHeats(round.id, dances[1].id);
  await schedule.rebuildRunningOrder(competition.id);
  const order = await schedule.runningOrder(competition.id);

  assert.equal(order.length, 6);
  // 預設順序：Cha Cha 1、2、3，再 Samba 1、2、3。
  // Default order: Cha Cha 1, 2, 3, then Samba 1, 2, 3.
  assert.deepEqual(order.map((h) => h.dance_name), ['Cha Cha', 'Cha Cha', 'Cha Cha', 'Samba', 'Samba', 'Samba']);
});

test('預設每支舞的 heat 成員相同 / by default every dance keeps the same heat members', async () => {
  const { divisions, dances, voucher: v } = await buildCompetition({ names: 30 });
  const round = await schedule.createRound({ divisionId: divisions[0].id, name: '初賽', heatSize: 10, reshufflePerDance: false });
  await schedule.seedFirstRound(v.code, round.id);

  const cha = await schedule.buildHeats(round.id, dances[0].id);
  const samba = await schedule.buildHeats(round.id, dances[1].id);

  const membersOf = async (heatId) => {
    const { entries } = await schedule.heatWithEntries(heatId);
    return entries.map((e) => e.bib_number).sort((a, b) => a - b);
  };
  assert.deepEqual(await membersOf(cha[0].id), await membersOf(samba[0].id));
  assert.deepEqual(await membersOf(cha[2].id), await membersOf(samba[2].id));
});

test('選了重新分批，每支舞就換人 / reshuffling gives each dance different heat members', async () => {
  const { divisions, dances, voucher: v } = await buildCompetition({ names: 30 });
  const round = await schedule.createRound({ divisionId: divisions[0].id, name: '初賽', heatSize: 10, reshufflePerDance: true });
  await schedule.seedFirstRound(v.code, round.id);

  const cha = await schedule.buildHeats(round.id, dances[0].id);
  const samba = await schedule.buildHeats(round.id, dances[1].id);

  const membersOf = async (heatId) => {
    const { entries } = await schedule.heatWithEntries(heatId);
    return entries.map((e) => e.bib_number).sort((a, b) => a - b);
  };
  const chaFirst = await membersOf(cha[0].id);
  const sambaFirst = await membersOf(samba[0].id);
  assert.notDeepEqual(chaFirst, sambaFirst, 'the reshuffle must actually change who is in heat 1');
  assert.equal(chaFirst.length, sambaFirst.length);

  // 重跑一次要得到同一個結果，主辦才不會覺得系統在亂跳。
  // Rebuilding must be deterministic, or the organiser would see the split jump around.
  const again = await schedule.buildHeats(round.id, dances[1].id);
  assert.deepEqual(await membersOf(again[0].id), sambaFirst);
});

test('併場：兩個小組別合成一場，成績還是分開 / merging puts two small divisions on the floor together', async () => {
  const { competition, divisions, dances, voucher: v } = await buildCompetition({
    names: [3, 4],
    divisionNames: ['U10 拉丁', 'U12 拉丁'],
  });

  const heatIds = [];
  for (const division of divisions) {
    const round = await schedule.createRound({ divisionId: division.id, name: '決賽', heatSize: 10, scoringMode: 'rank' });
    await schedule.seedFirstRound(v.code, round.id);
    const heats = await schedule.buildHeats(round.id, dances[0].id);
    assert.equal(heats.length, 1);
    heatIds.push(heats[0].id);
  }

  const merged = await schedule.mergeHeats(heatIds);
  const { entries } = await schedule.heatWithEntries(merged.id);
  assert.equal(entries.length, 7);
  assert.equal(new Set(entries.map((e) => e.division_name)).size, 2, 'both divisions are on the floor');
  assert.match(merged.label, /U10 拉丁 \+ U12 拉丁/);

  // 併場後也可以再拆開。
  // And it can be split apart again.
  await schedule.unmergeHeat(merged.id);
  const order = await schedule.runningOrder(competition.id);
  assert.equal(order.length, 2);
  for (const heat of order) assert.equal(heat.division_names.length, 1);
});

test('不同舞科不能併場 / heats for different dances cannot be merged', async () => {
  const { divisions, dances, voucher: v } = await buildCompetition({ names: [3, 3], divisionNames: ['A', 'B'] });
  const ids = [];
  for (const [index, division] of divisions.entries()) {
    const round = await schedule.createRound({ divisionId: division.id, name: '決賽', heatSize: 10 });
    await schedule.seedFirstRound(v.code, round.id);
    const heats = await schedule.buildHeats(round.id, dances[index].id);
    ids.push(heats[0].id);
  }
  await assert.rejects(() => schedule.mergeHeats(ids), (err) => err.key === 'schedule.errors.mergeSameDance');
});

test('主持人可以把還沒上場的一場往前或往後移 / a pending heat can be moved in the running order', async () => {
  const { competition, divisions, dances, voucher: v } = await buildCompetition({ names: 30 });
  const round = await schedule.createRound({ divisionId: divisions[0].id, name: '初賽', heatSize: 10 });
  await schedule.seedFirstRound(v.code, round.id);
  await schedule.buildHeats(round.id, dances[0].id);
  await schedule.buildHeats(round.id, dances[1].id);
  await schedule.rebuildRunningOrder(competition.id);

  const before = await schedule.runningOrder(competition.id);
  const last = before[before.length - 1];
  await schedule.moveHeat(last.id, { beforeHeatId: before[0].id });

  const after = await schedule.runningOrder(competition.id);
  assert.equal(String(after[0].id), String(last.id), 'the moved heat is now first');
  assert.equal(after.length, before.length, 'nothing was lost');
});

test('每個組別指定裁判，同一位可以帶多組 / judges are assigned per division and may cover several', async () => {
  const { competition, divisions } = await buildCompetition({ names: [3, 3], divisionNames: ['U10', 'U12'] });

  const a = await judges.addJudge({ competitionId: competition.id, name: '裁判 A' });
  const b = await judges.addJudge({ competitionId: competition.id, name: '裁判 B' });
  const d = await judges.addJudge({ competitionId: competition.id, name: '裁判 D' });

  await judges.assignToDivision(a.id, divisions[0].id);
  await judges.assignToDivision(b.id, divisions[0].id);
  await judges.assignToDivision(b.id, divisions[1].id);
  await judges.assignToDivision(d.id, divisions[1].id);

  const u10 = await judges.judgesForDivision(divisions[0].id);
  const u12 = await judges.judgesForDivision(divisions[1].id);
  assert.deepEqual(u10.map((j) => j.name), ['裁判 A', '裁判 B']);
  assert.deepEqual(u12.map((j) => j.name), ['裁判 B', '裁判 D']);

  assert.match(a.login_code, /^[23456789A-Z]{4}-[23456789A-Z]{4}$/);
  const found = await judges.judgeByLoginCode(a.login_code);
  assert.equal(String(found.id), String(a.id));
});

test('併場時裁判只看得到他負責的組別 / in a merged heat a judge only sees their own divisions', async () => {
  const { competition, divisions, dances, voucher: v } = await buildCompetition({
    names: [3, 4],
    divisionNames: ['U10 拉丁', 'U12 拉丁'],
  });

  const judgeA = await judges.addJudge({ competitionId: competition.id, name: '只評 U10' });
  await judges.assignToDivision(judgeA.id, divisions[0].id);

  const heatIds = [];
  for (const division of divisions) {
    const round = await schedule.createRound({ divisionId: division.id, name: '決賽', heatSize: 10 });
    await schedule.seedFirstRound(v.code, round.id);
    const heats = await schedule.buildHeats(round.id, dances[0].id);
    heatIds.push(heats[0].id);
  }
  const merged = await schedule.mergeHeats(heatIds);

  // 還沒檢錄，所以裁判畫面應該是空的。
  // Nobody has checked in yet, so the judge's screen is empty.
  assert.equal((await judges.heatEntriesForJudge(merged.id, judgeA.id)).length, 0);

  const { entries } = await schedule.heatWithEntries(merged.id);
  for (const entry of entries) {
    await one('UPDATE heat_entries SET checked_in_at = now() WHERE id = $1 RETURNING id', [entry.id]);
  }

  const visible = await judges.heatEntriesForJudge(merged.id, judgeA.id);
  assert.equal(visible.length, 3, 'only the three U10 dancers');
  assert.equal(new Set(visible.map((v2) => v2.division_name)).size, 1);
  assert.equal(visible[0].division_name, 'U10 拉丁');
});

test('沒指定裁判、過半數制人數是雙數會提醒 / the organiser is warned about gaps and even panels', async () => {
  const { competition, divisions } = await buildCompetition({ names: [3, 3], divisionNames: ['U10', 'U12'] });
  await schedule.createRound({
    divisionId: divisions[0].id,
    name: '決賽',
    scoringMode: 'rank',
    rankMethod: 'skating',
  });

  const a = await judges.addJudge({ competitionId: competition.id, name: 'A' });
  const b = await judges.addJudge({ competitionId: competition.id, name: 'B' });
  await judges.assignToDivision(a.id, divisions[0].id);
  await judges.assignToDivision(b.id, divisions[0].id);

  const warnings = await judges.assignmentWarnings(competition.id);
  const keys = warnings.map((w) => w.key);
  assert.ok(keys.includes('judges.warnings.noJudges'), 'U12 has no judges');
  assert.ok(keys.includes('judges.warnings.evenPanel'), 'an even skating panel is flagged');
});
