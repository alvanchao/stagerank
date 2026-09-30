import { resetDatabase, makeEntrant } from './helpers.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const voucher = await import('../src/services/voucher.js');
const schedule = await import('../src/services/schedule.js');
const { closePool, many } = await import('../src/db/index.js');

before(async () => {
  await resetDatabase();
});
after(async () => {
  await closePool();
});
beforeEach(async () => {
  await resetDatabase();
});

async function makeCup(name) {
  const competition = await comps.createCompetition({ name, currency: 'TWD', feeCents: 0, status: 'open' });
  const solo = await comps.addDivision({ competitionId: competition.id, name: '單人拉丁', sortOrder: 1 });
  const solo2 = await comps.addDivision({ competitionId: competition.id, name: '單人標準', sortOrder: 2 });
  const couple = await comps.addDivision({
    competitionId: competition.id, name: '雙人拉丁', sortOrder: 3, memberMin: 2, memberMax: 2,
  });
  return { competition, solo, solo2, couple };
}

async function twoTeachers() {
  const t1 = await makeEntrant({
    email: 't1@example.com', unitName: '甲舞蹈',
    people: [
      { name: '選手一', birthDate: '1995-01-01' },
      { name: '選手二', birthDate: '1996-02-02' },
      { name: '選手三', birthDate: '1997-03-03' },
    ],
  });
  const t2 = await makeEntrant({
    email: 't2@example.com', unitName: '乙舞蹈',
    people: [
      { name: '選手四', birthDate: '1990-01-01' },
      { name: '選手五', birthDate: '1991-02-02' },
    ],
  });
  return { t1, t2 };
}

test('同一人報兩個組別，整場沿用同一個背號，而且從 1 連續編 / one bib per entry across divisions, counting from 1', async () => {
  const { t1 } = await twoTeachers();
  const cup = await makeCup('A盃');
  const [a1, a2, a3] = t1.athletes;

  await regs.register({ competitionId: cup.competition.id, divisionId: cup.solo.id, entrantId: t1.entrant.id, athleteIds: [a1.id] });
  await regs.register({ competitionId: cup.competition.id, divisionId: cup.solo.id, entrantId: t1.entrant.id, athleteIds: [a2.id] });
  await regs.register({ competitionId: cup.competition.id, divisionId: cup.solo2.id, entrantId: t1.entrant.id, athleteIds: [a1.id] });
  await regs.register({ competitionId: cup.competition.id, divisionId: cup.couple.id, entrantId: t1.entrant.id, athleteIds: [a2.id, a3.id] });
  await regs.register({ competitionId: cup.competition.id, divisionId: cup.couple.id, entrantId: t1.entrant.id, athleteIds: [a1.id, a3.id] });

  const settled = await voucher.settle(cup.competition.id);
  await schedule.assignBibs(settled.voucher.code);
  const roster = await schedule.rosterWithBibs(settled.voucher.code);
  const bib = (division, name) => roster.find((r) => r.division_name === division && r.athlete_name === name).bib_number;

  assert.equal(bib('單人拉丁', '選手一'), 1);
  assert.equal(bib('單人拉丁', '選手二'), 2);
  assert.equal(bib('單人標準', '選手一'), 1, 'the same person keeps the same bib in a second division');
  assert.equal(bib('雙人拉丁', '選手二 / 選手三'), 3, 'a couple is a different entry from the solo, so a different bib');
  assert.equal(bib('雙人拉丁', '選手一 / 選手三'), 4);

  const numbers = [...new Set(roster.map((r) => r.bib_number))].sort((x, y) => x - y);
  assert.deepEqual(numbers, [1, 2, 3, 4], 'no gaps');
});

test('雙人的順序照勾選的順序，不被資料庫重排 / a couple keeps the order it was ticked in', async () => {
  const { t2 } = await twoTeachers();
  const cup = await makeCup('C盃');
  const [a4, a5] = t2.athletes;
  const first = await regs.register({ competitionId: cup.competition.id, divisionId: cup.couple.id, entrantId: t2.entrant.id, athleteIds: [a5.id, a4.id] });
  assert.equal(first.registration.athlete_name, '選手五 / 選手四');
});

test('可以選起始號碼，也可以選回每組一個區段 / the start number and the per-division blocks are still available', async () => {
  const { t1 } = await twoTeachers();
  const cup = await makeCup('D盃');
  const [a1, a2] = t1.athletes;
  await regs.register({ competitionId: cup.competition.id, divisionId: cup.solo.id, entrantId: t1.entrant.id, athleteIds: [a1.id] });
  await regs.register({ competitionId: cup.competition.id, divisionId: cup.solo2.id, entrantId: t1.entrant.id, athleteIds: [a2.id] });
  const settled = await voucher.settle(cup.competition.id);

  let roster = await schedule.assignBibs(settled.voucher.code, { start: 50 });
  assert.deepEqual(roster.map((r) => r.bib_number), [50, 51]);

  roster = await schedule.assignBibs(settled.voucher.code, { start: 101, mode: 'blocks' });
  assert.deepEqual(roster.map((r) => r.bib_number), [101, 201]);
});

test('重複付款（同一組人同一組別兩筆已付款）要擋下來，不能悄悄給兩個背號 / a double payment is refused, not given two bibs', async () => {
  const { t1 } = await twoTeachers();
  const cup = await makeCup('E盃');
  const [a1] = t1.athletes;
  await regs.register({ competitionId: cup.competition.id, divisionId: cup.solo.id, entrantId: t1.entrant.id, athleteIds: [a1.id] });
  await regs.register({ competitionId: cup.competition.id, divisionId: cup.solo.id, entrantId: t1.entrant.id, athleteIds: [a1.id] });
  const settled = await voucher.settle(cup.competition.id);
  await assert.rejects(() => schedule.assignBibs(settled.voucher.code), (err) => err.key === 'schedule.errors.duplicateEntry');
});

test('兩場比賽同時報名，同一批選手互不混淆 / two competitions taking entries at the same time never mix', async () => {
  const { t1, t2 } = await twoTeachers();
  const A = await makeCup('A盃');
  const B = await makeCup('B盃');
  const [a1, a2, a3] = t1.athletes;
  const [a4, a5] = t2.athletes;

  const jobs = [];
  for (const cup of [A, B]) {
    const c = cup.competition.id;
    jobs.push(regs.register({ competitionId: c, divisionId: cup.solo.id, entrantId: t1.entrant.id, athleteIds: [a1.id] }));
    jobs.push(regs.register({ competitionId: c, divisionId: cup.solo2.id, entrantId: t1.entrant.id, athleteIds: [a1.id] }));
    jobs.push(regs.register({ competitionId: c, divisionId: cup.solo.id, entrantId: t2.entrant.id, athleteIds: [a4.id] }));
    jobs.push(regs.register({ competitionId: c, divisionId: cup.couple.id, entrantId: t2.entrant.id, athleteIds: [a4.id, a5.id] }));
    jobs.push(regs.register({ competitionId: c, divisionId: cup.couple.id, entrantId: t1.entrant.id, athleteIds: [a2.id, a3.id] }));
  }
  const results = await Promise.allSettled(jobs);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 0);

  const leaks = await many(
    'SELECT r.id FROM registrations r JOIN divisions d ON d.id = r.division_id WHERE d.competition_id <> r.competition_id',
  );
  assert.equal(leaks.length, 0, 'every registration sits in a division of its own competition');

  const vouchers = {};
  for (const cup of [A, B]) {
    const settled = await voucher.settle(cup.competition.id);
    await schedule.assignBibs(settled.voucher.code);
    vouchers[cup.competition.id] = await schedule.rosterWithBibs(settled.voucher.code);
  }
  for (const cup of [A, B]) {
    const roster = vouchers[cup.competition.id];
    assert.equal(roster.length, 5, 'each competition only settles its own entries');
    const ids = roster.map((r) => String(r.registration_id));
    const own = await many('SELECT id FROM registrations WHERE competition_id = $1', [cup.competition.id]);
    assert.deepEqual(ids.sort(), own.map((r) => String(r.id)).sort());
    assert.deepEqual([...new Set(roster.map((r) => r.bib_number))].sort((x, y) => x - y), [1, 2, 3, 4], 'bibs restart in each competition');
  }
});
