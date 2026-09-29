// 參賽單位（單人／雙人／多人）、三種收費、主持人的輪次處置。
// Entry units (solo / couple / team), the three fee modes, and the host's decision for a round.
import { resetDatabase } from './helpers.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const units = await import('../src/services/entryUnits.js');
const voucher = await import('../src/services/voucher.js');
const schedule = await import('../src/services/schedule.js');
const floor = await import('../src/services/floor.js');
const decisions = await import('../src/services/roundDecisions.js');
const { closePool, one, many, query } = await import('../src/db/index.js');

before(async () => { await resetDatabase(); });
after(async () => { await closePool(); });
beforeEach(async () => { await resetDatabase(); });

async function makeDivision({ memberMin = 1, memberMax = 1, feeMode = 'per_entry', fee = 1200, extra = 0 } = {}) {
  const competition = await comps.createCompetition({ name: 'Unit Cup', feeCents: fee, status: 'open' });
  const division = await one(
    `INSERT INTO divisions (competition_id, name, sort_order, member_min, member_max, fee_mode, extra_division_fee_cents)
     VALUES ($1, 'U15 Latin', 1, $2, $3, $4, $5) RETURNING *`,
    [competition.id, memberMin, memberMax, feeMode, extra],
  );
  return { competition, division };
}

// ------------------------------------------------------------ 參賽單位 / entry units

test('組別的形狀由人數上下限決定 / the member range decides the shape of a division', () => {
  assert.equal(units.entryKind({ member_min: 1, member_max: 1 }), 'solo');
  assert.equal(units.entryKind({ member_min: 2, member_max: 2 }), 'couple');
  assert.equal(units.entryKind({ member_min: 3, member_max: 24 }), 'team');
  // 也有可能只能三人 / a team can also be fixed at exactly three
  assert.equal(units.entryKind({ member_min: 3, member_max: 3 }), 'team');
});

test('人數不足或超過都會被擋 / too few and too many members are both refused', () => {
  const couple = { member_min: 2, member_max: 2 };
  assert.throws(() => units.parseMembers([{ athleteName: 'Solo' }], couple), (e) => e.key === 'register.errors.tooFewMembers');
  assert.throws(
    () => units.parseMembers([{ athleteName: 'A' }, { athleteName: 'B' }, { athleteName: 'C' }], couple),
    (e) => e.key === 'register.errors.tooManyMembers',
  );

  const team = { member_min: 3, member_max: 24 };
  const many25 = Array.from({ length: 25 }, (_, i) => ({ athleteName: `M${i}` }));
  assert.throws(() => units.parseMembers(many25, team), (e) => e.key === 'register.errors.tooManyMembers');
  assert.equal(units.parseMembers(many25.slice(0, 24), team).length, 24, '24 is the ceiling and it is allowed');
});

test('同一個單位裡不能有重複的人 / the same person cannot appear twice in one unit', () => {
  const couple = { member_min: 2, member_max: 2 };
  assert.throws(
    () => units.parseMembers(
      [{ athleteName: 'A', personEmail: 'x@example.com' }, { athleteName: 'B', personEmail: 'X@Example.com' }],
      couple,
    ),
    (e) => e.key === 'register.errors.duplicateMember',
  );
});

test('雙人報名：一個背號、兩個名字、成員都存起來 / a couple is one bib, two names, both stored', async () => {
  const { competition, division } = await makeDivision({ memberMin: 2, memberMax: 2, fee: 0 });
  const result = await regs.register({
    competitionId: competition.id,
    divisionId: division.id,
    members: [
      { athleteName: '王小明', personEmail: 'ming@example.com' },
      { athleteName: '李小美', personEmail: 'mei@example.com' },
    ],
  });

  assert.equal(result.registration.member_count, 2);
  assert.equal(result.registration.athlete_name, '王小明 / 李小美');

  const members = await regs.membersOf(result.registration.id);
  assert.deepEqual(members.map((m) => m.athlete_name), ['王小明', '李小美']);
  assert.deepEqual(members.map((m) => m.person_email), ['ming@example.com', 'mei@example.com']);

  // 背號給整個參賽單位，不是給個人。
  // The bib belongs to the unit, not to a person.
  const settled = await voucher.settle(competition.id);
  await schedule.assignBibs(settled.voucher.code);
  const roster = await schedule.rosterWithBibs(settled.voucher.code);
  assert.equal(roster.length, 1, 'two people, one entry, one bib');
  assert.equal(roster[0].athlete_name, '王小明 / 李小美');
});

test('舊的單人呼叫方式還是能用 / the old one-name call still works', async () => {
  const { competition, division } = await makeDivision({ fee: 0 });
  const result = await regs.register({
    competitionId: competition.id,
    divisionId: division.id,
    athleteName: 'Solo Dancer',
    athleteEmail: 'solo@example.com',
  });
  assert.equal(result.registration.member_count, 1);
  assert.equal(result.registration.athlete_name, 'Solo Dancer');
});

// ------------------------------------------------------------ 收費 / fees

test('整組收：一對收一份 / per-entry charges the unit once', async () => {
  const { competition, division } = await makeDivision({ memberMin: 2, memberMax: 2, feeMode: 'per_entry', fee: 1200 });
  const quote = await units.quote({
    competition,
    division,
    members: [{ athleteName: 'A', personEmail: 'a@example.com' }, { athleteName: 'B', personEmail: 'b@example.com' }],
  });
  assert.equal(quote.totalCents, 1200);
});

test('每人收：一對收兩份 / per-person charges every member', async () => {
  const { competition, division } = await makeDivision({ memberMin: 2, memberMax: 2, feeMode: 'per_person', fee: 1200 });
  const quote = await units.quote({
    competition,
    division,
    members: [{ athleteName: 'A', personEmail: 'a@example.com' }, { athleteName: 'B', personEmail: 'b@example.com' }],
  });
  assert.equal(quote.totalCents, 2400);
  assert.equal(quote.memberCount, 2);
});

test('跨組別加收：認電子郵件，不認姓名 / the cross-division surcharge matches on email, never on name', async () => {
  const competition = await comps.createCompetition({ name: 'Cross Cup', feeCents: 1000, status: 'open' });
  const first = await one(
    `INSERT INTO divisions (competition_id, name, sort_order, member_min, member_max)
     VALUES ($1, 'Latin', 1, 1, 1) RETURNING *`,
    [competition.id],
  );
  const second = await one(
    `INSERT INTO divisions (competition_id, name, sort_order, member_min, member_max, extra_division_fee_cents)
     VALUES ($1, 'Standard', 2, 1, 1, 300) RETURNING *`,
    [competition.id],
  );

  const one1 = await regs.register({
    competitionId: competition.id,
    divisionId: first.id,
    members: [{ athleteName: '王小明', personEmail: 'ming@example.com' }],
    provider: 'ecpay',
  });
  assert.equal(one1.registration.amount_cents, 1000, 'the first division is the plain fee');

  // 同名但不同信箱的另一個人，不算是同一個人。
  // A different person with the very same name is not the same person.
  const sameName = await regs.register({
    competitionId: competition.id,
    divisionId: second.id,
    members: [{ athleteName: '王小明', personEmail: 'another-ming@example.com' }],
    provider: 'ecpay',
  });
  assert.equal(sameName.registration.amount_cents, 1000, 'same name, different email: no surcharge');
  assert.equal(sameName.registration.extra_fee_cents, 0);

  // 同一個信箱報第二個組別，就要加收。
  // The same email entering a second division pays the surcharge.
  const crossed = await regs.register({
    competitionId: competition.id,
    divisionId: second.id,
    members: [{ athleteName: '王小明', personEmail: 'MING@example.com' }],
    provider: 'ecpay',
  });
  assert.equal(crossed.registration.amount_cents, 1300);
  assert.equal(crossed.registration.extra_fee_cents, 300);
});

test('跨組別可以設成減免，但不會變成負數 / the surcharge may be a discount, never below zero', async () => {
  const competition = await comps.createCompetition({ name: 'Discount Cup', feeCents: 500, status: 'open' });
  const first = await one(
    `INSERT INTO divisions (competition_id, name, sort_order) VALUES ($1, 'A', 1) RETURNING *`,
    [competition.id],
  );
  const second = await one(
    `INSERT INTO divisions (competition_id, name, sort_order, extra_division_fee_cents)
     VALUES ($1, 'B', 2, -800) RETURNING *`,
    [competition.id],
  );

  await regs.register({
    competitionId: competition.id,
    divisionId: first.id,
    members: [{ athleteName: 'X', personEmail: 'x@example.com' }],
    provider: 'ecpay',
  });
  const second2 = await regs.register({
    competitionId: competition.id,
    divisionId: second.id,
    members: [{ athleteName: 'X', personEmail: 'x@example.com' }],
  });
  assert.equal(second2.registration.amount_cents, 0, 'a discount cannot make the total negative');
});

// ------------------------------------------------------------ 輪次處置 / round decisions

// 12 人的組別，初賽取 6、決賽。回傳兩輪。
// A division of twelve: qualifying takes six, then a final.
async function twoRoundDivision({ dancers = 12, advanceCount = 6 } = {}) {
  const competition = await comps.createCompetition({ name: 'Round Cup', feeCents: 0, status: 'open' });
  const division = await comps.addDivision({ competitionId: competition.id, name: 'U15 拉丁', sortOrder: 1 });
  const cha = await schedule.addDance({ competitionId: competition.id, name: 'Cha Cha', sortOrder: 1 });
  await schedule.setDivisionDances(division.id, [cha.id]);

  for (let i = 1; i <= dancers; i += 1) {
    await regs.register({
      competitionId: competition.id,
      divisionId: division.id,
      members: [{ athleteName: `選手 ${i}`, personEmail: `d${i}@example.com` }],
    });
  }
  const settled = await voucher.settle(competition.id);
  await schedule.assignBibs(settled.voucher.code);

  const prelim = await schedule.createRound({
    divisionId: division.id, name: '初賽', heatSize: 6, scoringMode: 'mark', advanceCount, sortOrder: 1,
  });
  const final = await schedule.createRound({
    divisionId: division.id, name: '決賽', heatSize: 10, scoringMode: 'rank', advanceCount: 3, sortOrder: 2,
  });
  await schedule.seedFirstRound(settled.voucher.code, prelim.id);
  await schedule.buildHeats(prelim.id, cha.id);
  await schedule.rebuildRunningOrder(competition.id);

  return { competition, division, prelim, final, cha };
}

async function reportIn(roundId, howMany) {
  const entries = await many(
    'SELECT * FROM round_entries WHERE round_id = $1 ORDER BY bib_number NULLS LAST, id',
    [roundId],
  );
  for (const entry of entries.slice(0, howMany)) await floor.reportIn(entry.registration_id);
  return entries;
}

test('主持人看得到應到、實到、要取幾人 / the host sees expected, present and places available', async () => {
  const { prelim } = await twoRoundDivision();
  await reportIn(prelim.id, 7);

  const info = await decisions.advice(prelim.id);
  assert.equal(info.expected, 12);
  assert.equal(info.present, 7);
  assert.equal(info.advanceCount, 6);
  assert.equal(info.isLastRound, false);
  assert.equal(info.suggestion, 'normal', 'seven for six places is still worth dancing');
});

test('實到不比要取的多，就建議免賽晉級 / when nobody would be eliminated, free pass is suggested', async () => {
  const { prelim } = await twoRoundDivision({ advanceCount: 8 });
  await reportIn(prelim.id, 7);

  const info = await decisions.advice(prelim.id);
  assert.equal(info.suggestion, 'free_pass', 'seven present for eight places eliminates nobody');
});

test('免賽晉級：不比，在場的人全部進下一輪 / free pass sends everyone present through undanced', async () => {
  const { prelim, final } = await twoRoundDivision();
  await reportIn(prelim.id, 5);

  const result = await decisions.freePass(prelim.id);
  assert.equal(result.advanced.length, 5);
  assert.equal(String(result.into.id), String(final.id));

  const after = await decisions.getRound(prelim.id);
  assert.equal(after.outcome, 'free_pass');
  assert.equal(after.status, 'closed');

  const seeded = await many('SELECT * FROM round_entries WHERE round_id = $1', [final.id]);
  assert.equal(seeded.length, 5, 'only the five who turned up are in the final');

  // 沒到的 7 位記為缺席，不是憑空消失。
  // The seven who never came are recorded as absent, not silently dropped.
  const absent = await many('SELECT * FROM results WHERE round_id = $1 AND absent = TRUE', [prelim.id]);
  assert.equal(absent.length, 7);

  // 成績上看得出來這一輪是免賽晉級，不是比出來的。
  // The results say plainly that this round was not danced.
  const advanced = await one('SELECT * FROM results WHERE round_id = $1 AND advanced = TRUE LIMIT 1', [prelim.id]);
  assert.equal(advanced.detail.outcome, 'free_pass');
});

test('免賽晉級之後，這一輪的場次不會留在秩序表上 / a free-passed round leaves the running order', async () => {
  const { competition, prelim } = await twoRoundDivision();
  await reportIn(prelim.id, 5);

  const before = await schedule.runningOrder(competition.id);
  assert.ok(before.length > 0);

  await decisions.freePass(prelim.id);
  const after = await schedule.runningOrder(competition.id);
  assert.equal(after.length, 0, 'nothing of that round is left to announce');
});

test('直接決賽：中間的輪次一起記為未舉行 / skipping to the final marks the rounds in between', async () => {
  const competition = await comps.createCompetition({ name: 'Three Round Cup', feeCents: 0, status: 'open' });
  const division = await comps.addDivision({ competitionId: competition.id, name: 'U15', sortOrder: 1 });
  const cha = await schedule.addDance({ competitionId: competition.id, name: 'Cha Cha', sortOrder: 1 });
  await schedule.setDivisionDances(division.id, [cha.id]);
  for (let i = 1; i <= 8; i += 1) {
    await regs.register({
      competitionId: competition.id,
      divisionId: division.id,
      members: [{ athleteName: `S${i}`, personEmail: `s${i}@example.com` }],
    });
  }
  const settled = await voucher.settle(competition.id);
  await schedule.assignBibs(settled.voucher.code);

  const prelim = await schedule.createRound({ divisionId: division.id, name: '初賽', advanceCount: 6, sortOrder: 1 });
  const semi = await schedule.createRound({ divisionId: division.id, name: '複賽', advanceCount: 4, sortOrder: 2 });
  const final = await schedule.createRound({ divisionId: division.id, name: '決賽', advanceCount: 3, sortOrder: 3 });
  await schedule.seedFirstRound(settled.voucher.code, prelim.id);

  await reportIn(prelim.id, 4);
  const result = await decisions.skipToFinal(prelim.id);

  assert.equal(String(result.into.id), String(final.id));
  assert.equal(result.advanced.length, 4);
  assert.equal((await decisions.getRound(prelim.id)).outcome, 'skipped');
  assert.equal((await decisions.getRound(semi.id)).outcome, 'skipped', 'the round in between is skipped too');
  assert.equal((await decisions.getRound(final.id)).outcome, 'normal', 'the final still has to be danced');

  const seeded = await many('SELECT * FROM round_entries WHERE round_id = $1', [final.id]);
  assert.equal(seeded.length, 4);
});

test('開始評分之後就不能再處置 / no decision once the round has started scoring', async () => {
  const { competition, prelim } = await twoRoundDivision();
  await reportIn(prelim.id, 12);

  const heats = await schedule.runningOrder(competition.id);
  const first = heats[0];
  const { entries } = await schedule.heatWithEntries(first.id);
  for (const entry of entries) await floor.checkIn(entry.id);
  await floor.nextHeat(competition.id, { heatId: first.id });
  await floor.startHeat(first.id);

  await assert.rejects(() => decisions.freePass(prelim.id), (e) => e.key === 'rounds.errors.alreadyStarted');
  await assert.rejects(() => decisions.skipToFinal(prelim.id), (e) => e.key === 'rounds.errors.alreadyStarted');
  await assert.rejects(() => decisions.setAdvanceCount(prelim.id, 4), (e) => e.key === 'rounds.errors.alreadyStarted');
});

test('最後一輪沒有下一輪可以免賽 / the last round has nowhere to free pass to', async () => {
  const { prelim, final } = await twoRoundDivision();
  await reportIn(prelim.id, 3);
  await decisions.freePass(prelim.id);

  await assert.rejects(() => decisions.freePass(final.id), (e) => e.key === 'rounds.errors.noNextRound');
  assert.equal((await decisions.advice(final.id)).isLastRound, true);
});

test('晉級名額當天可以改，而且留紀錄 / the places available can change on the day, and it is recorded', async () => {
  const { prelim } = await twoRoundDivision();
  await reportIn(prelim.id, 9);

  await decisions.setAdvanceCount(prelim.id, 4, { decidedBy: 'host' });
  assert.equal((await decisions.getRound(prelim.id)).advance_count, 4);

  const log = await decisions.decisionsFor(prelim.id);
  assert.equal(log[0].decision, 'advance_count');
  assert.equal(log[0].advance_count, 4);
  assert.equal(log[0].present_count, 9);
  assert.equal(log[0].expected_count, 12);
  assert.equal(log[0].decided_by, 'host');
});

test('每一次處置都留得下誰按的、什麼時候 / every decision records who and when', async () => {
  const { prelim } = await twoRoundDivision();
  await reportIn(prelim.id, 5);
  await decisions.freePass(prelim.id, { decidedBy: 'host' });

  const log = await decisions.decisionsFor(prelim.id);
  assert.equal(log[0].decision, 'free_pass');
  assert.equal(log[0].present_count, 5);
  assert.equal(log[0].expected_count, 12);
  assert.ok(log[0].decided_at);
});
