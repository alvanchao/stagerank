// 建立項目：套範本、複製上一場、整批清掉重來。
// Building the divisions: apply a template, copy a past event, clear and start over.
import { resetDatabase } from './helpers.js';
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const comps = await import('../src/services/competitions.js');
const setup = await import('../src/services/setup.js');
const fees = await import('../src/services/feeGroups.js');
const schedule = await import('../src/services/schedule.js');
const entrants = await import('../src/services/entrants.js');
const roster = await import('../src/services/athletes.js');
const regs = await import('../src/services/registrations.js');
const { closePool } = await import('../src/db/index.js');

before(resetDatabase);
beforeEach(resetDatabase);
after(closePool);

const t = (key, params) => {
  const leaf = key.split('.').pop();
  if (!params) return leaf;
  return `${leaf}:${Object.values(params).join('/')}`;
};

test('範本攤出來的項目每一個都帶著舞科 / every row the template offers carries its dances', () => {
  const plan = setup.planFor({ templateKey: 'ballroom', t });
  assert.ok(plan.length > 50, `a useful number of rows, got ${plan.length}`);
  for (const row of plan) {
    assert.ok(row.dances.length > 0, `${row.key} has dances`);
    assert.ok(row.name, `${row.key} has a name`);
  }
  // 五項就是五支舞，單項就是一支。
  // A five-dance row has five dances, a single-dance row has one.
  assert.equal(plan.find((r) => r.key === 'u12-latin-five').dances.length, 5);
  assert.equal(plan.find((r) => r.key === 'u12-latin-chaCha').dances.length, 1);
});

test('少年組只設上限，成人組只設下限 / youth rows cap the age, adult rows floor it', () => {
  const plan = setup.planFor({ templateKey: 'ballroom', t });
  const u13ish = plan.find((r) => r.key === 'u14-latin-five');
  // 上限 14、下限留空，所以 13 歲的孩子報得了 U14、U16、U18，報不了 U12。
  // 這正是實務上的規則，靠兩個可留空的欄位就成立，不必寫特別邏輯。
  // Capped at 14 with no floor, so a 13-year-old can enter U14, U16 and U18 but not U12.
  // That is the real rule, and two optional bounds are all it takes.
  assert.equal(u13ish.ageMax, 14);
  assert.equal(u13ish.ageMin, null);

  const adult = plan.find((r) => r.key === 'adult-latin-five');
  assert.equal(adult.ageMin, 19);
  assert.equal(adult.ageMax, null);

  // 師生組兩邊都留空：老師的年紀不是重點。
  // Pro-am leaves both blank: the teacher's age is not the point.
  const proAm = plan.find((r) => r.key.startsWith('proam-'));
  assert.equal(proAm.ageMin, null);
  assert.equal(proAm.ageMax, null);
});

test('套範本生出來的組別就能跑 / what the template creates is ready to run', async () => {
  const competition = await comps.createCompetition({ name: 'Template Cup', feeCents: 0, status: 'draft' });
  const plan = setup.planFor({ templateKey: 'ballroom', t });
  const keys = [
    'u12-latin-five',
    'u12-latin-chaCha',
    'proam-latin-rumba',
  ];

  const result = await setup.applyTemplate({
    competitionId: competition.id,
    keys,
    t,
    generalPlan: { baseFeeCents: 1800, baseIncludes: 2, extraItemFeeCents: 600 },
    proAmPlan: { baseFeeCents: 2500, baseIncludes: 1, extraItemFeeCents: 1200 },
  });
  assert.equal(result.created, 3);

  const divisions = await comps.listDivisions(competition.id);
  assert.equal(divisions.length, 3);

  // 舞科要掛好，不然主辦還是得一個一個掛，等於沒省到。
  // The dances must be attached, or the organiser is back to wiring them one by one.
  const five = divisions.find((d) => d.name.includes('fiveDance'));
  assert.equal((await schedule.dancesForDivision(five.id)).length, 5);

  // 只建被用到的舞科：拉丁五支加倫巴已經在裡面了，標準的不建。
  // Only the dances in use are created: the five Latin ones, and no Standard at all.
  const dances = await schedule.listDances(competition.id);
  assert.equal(dances.length, 5);
  assert.ok(!dances.some((d) => d.name === 'waltz'), 'no Standard dance is created');

  // 兩個收費方案，而且師生組的組別掛在師生組那一個。
  // Two fee plans, and the pro-am division is on the pro-am one.
  const groups = await fees.listGroups(competition.id);
  assert.equal(groups.length, 2);
  const proAmDivision = divisions.find((d) => d.name.includes('proAm'));
  const proAmGroup = groups.find((g) => String(g.id) === String(proAmDivision.fee_group_id));
  assert.equal(Number(proAmGroup.base_fee_cents), 2500, 'pro-am is on its own plan');
  assert.equal(proAmDivision.fee_mode, 'tiered');
});

test('沒勾任何項目就不動手 / choosing nothing creates nothing', async () => {
  const competition = await comps.createCompetition({ name: 'Empty', feeCents: 0, status: 'draft' });
  await assert.rejects(
    () => setup.applyTemplate({ competitionId: competition.id, keys: ['nope'], t }),
    (err) => err.key === 'setup.errors.nothingChosen',
  );
  assert.equal((await comps.listDivisions(competition.id)).length, 0);
});

test('已經有組別就不給再套一次 / a competition that already has divisions is not overwritten', async () => {
  const competition = await comps.createCompetition({ name: 'Busy', feeCents: 0, status: 'draft' });
  await comps.addDivision({ competitionId: competition.id, name: 'Hand made', sortOrder: 1 });
  await assert.rejects(
    () => setup.applyTemplate({ competitionId: competition.id, keys: ['u12-latin-five'], t }),
    (err) => err.key === 'setup.errors.alreadyHasDivisions',
  );
});

test('複製上一場：設定整套過來，報名和成績留在原地 / a copy brings the setup, not the event', async () => {
  const last = await comps.createCompetition({ name: '2025 Cup', feeCents: 0, status: 'closed' });
  await setup.applyTemplate({
    competitionId: last.id,
    keys: ['u12-latin-five', 'u12-latin-chaCha', 'proam-latin-rumba'],
    t,
    generalPlan: { baseFeeCents: 1800, baseIncludes: 2, extraItemFeeCents: 600 },
    proAmPlan: { baseFeeCents: 2500, baseIncludes: 1, extraItemFeeCents: 1200 },
  });
  await comps.setStatus(last.id, 'open');
  await comps.setAgeRule(last.id, { ageBasis: 'event_day', eventDate: '2025-11-01' });

  // 去年有人報名，這些不可以跟著過來。
  // Last year had entries, and those must not come across.
  const account = await entrants.signUp({ email: 'teacher@example.com', password: 'passw0rd!' });
  const athlete = await roster.addAthlete({ entrantId: account.id, name: '王小明', birthDate: '2014-05-04' });
  const partner = await roster.addAthlete({ entrantId: account.id, name: '李小美', birthDate: '2014-08-08' });
  const lastDivisions = await comps.listDivisions(last.id);
  await regs.register({
    competitionId: last.id, divisionId: lastDivisions[0].id, athleteIds: [athlete.id, partner.id],
    entrantId: account.id, provider: 'ecpay',
  });

  const next = await comps.createCompetition({ name: '2026 Cup', feeCents: 0, status: 'draft' });
  const result = await setup.copyFrom(last.id, next.id);
  assert.equal(result.divisions, 3);

  const copied = await comps.listDivisions(next.id);
  assert.equal(copied.length, 3);
  assert.equal((await regs.listRegistrations(next.id)).length, 0, 'last year’s entries stay behind');

  // 舞科清單也要跟著，而且指到新比賽自己的舞科，不是去年那幾筆。
  // The dance lists come too, pointing at this competition's own dances, not last year's.
  const five = copied.find((d) => d.name.includes('fiveDance'));
  const dances = await schedule.dancesForDivision(five.id);
  assert.equal(dances.length, 5);
  const ourDances = await schedule.listDances(next.id);
  for (const dance of dances) {
    assert.ok(ourDances.some((d) => String(d.id) === String(dance.id)), 'the dance belongs to this competition');
  }

  // 收費方案跟著過來，組別掛的是新方案。
  // The fee plans come across and the divisions point at the new ones.
  const groups = await fees.listGroups(next.id);
  assert.equal(groups.length, 2);
  for (const division of copied) {
    if (!division.fee_group_id) continue;
    assert.ok(groups.some((g) => String(g.id) === String(division.fee_group_id)));
  }

  // 年齡算法跟著複製；比賽日期不跟，日期一定是新的。
  // The age rule carries over; the date does not, because the date is always new.
  const fresh = await comps.getCompetition(next.id);
  assert.equal(fresh.age_basis, 'event_day');
  assert.equal(fresh.event_date, null);
});

test('沒人報名可以整批清掉，有人報名就鎖住 / clearing works until the first entry arrives', async () => {
  const competition = await comps.createCompetition({ name: 'Clearable', feeCents: 0, status: 'open' });
  await setup.applyTemplate({ competitionId: competition.id, keys: ['u12-latin-five', 'u12-latin-chaCha'], t });

  assert.equal(await setup.canClear(competition.id), true);
  const cleared = await setup.clearSetup(competition.id);
  assert.equal(cleared.removed, 2);
  assert.equal((await comps.listDivisions(competition.id)).length, 0);
  assert.equal((await fees.listGroups(competition.id)).length, 0);
  assert.equal((await schedule.listDances(competition.id)).length, 0);

  // 清掉之後可以重新產生，這正是「隨時可以反悔」的意思。
  // Rebuilding after a clear is the whole point of being able to change your mind.
  await setup.applyTemplate({ competitionId: competition.id, keys: ['u14-standard-five'], t });
  assert.equal((await comps.listDivisions(competition.id)).length, 1);

  const account = await entrants.signUp({ email: 'teacher@example.com', password: 'passw0rd!' });
  const athlete = await roster.addAthlete({ entrantId: account.id, name: '王小明', birthDate: '2013-05-04' });
  const partner = await roster.addAthlete({ entrantId: account.id, name: '李小美', birthDate: '2013-08-08' });
  const divisions = await comps.listDivisions(competition.id);
  await regs.register({
    competitionId: competition.id, divisionId: divisions[0].id, athleteIds: [athlete.id, partner.id],
    entrantId: account.id,
  });

  assert.equal(await setup.canClear(competition.id), false);
  await assert.rejects(
    () => setup.clearSetup(competition.id),
    (err) => err.key === 'setup.errors.alreadyEntered',
  );
  assert.equal((await comps.listDivisions(competition.id)).length, 1, 'nothing was removed');
});

test('不能複製自己 / a competition cannot be copied onto itself', async () => {
  const competition = await comps.createCompetition({ name: 'Solo', feeCents: 0, status: 'draft' });
  await comps.addDivision({ competitionId: competition.id, name: 'X', sortOrder: 1 });
  await assert.rejects(
    () => setup.copyFrom(competition.id, competition.id),
    (err) => err.key === 'setup.errors.sameCompetition',
  );
});
