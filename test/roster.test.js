// 報名人帳號、選手名冊、年齡驗證。
// Entrant accounts, the athlete roster, and the age check.
import { resetDatabase } from './helpers.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const entrants = await import('../src/services/entrants.js');
const roster = await import('../src/services/athletes.js');
const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const { closePool } = await import('../src/db/index.js');

before(resetDatabase);
beforeEach(resetDatabase);
after(closePool);

async function teacher(email = 'teacher@example.com') {
  return entrants.signUp({ email, password: 'passw0rd!', unitName: 'Sunrise Dance' });
}

// ------------------------------------------------------------------ 帳號 / accounts

test('密碼存的是雜湊，不是明文 / the password is stored hashed, never in the clear', async () => {
  const account = await teacher();
  assert.ok(!account.password_hash.includes('passw0rd!'));
  assert.ok(account.password_hash.startsWith('scrypt$'));
  assert.equal(entrants.verifyPassword('passw0rd!', account.password_hash), true);
  assert.equal(entrants.verifyPassword('passw0rd', account.password_hash), false);
});

test('同一個電子郵件不能註冊兩次，大小寫也算同一個 / one account per address, case ignored', async () => {
  await teacher('Teacher@Example.com');
  await assert.rejects(() => teacher('teacher@example.com'), (err) => err.key === 'entrant.errors.emailTaken');
});

test('帳號不存在和密碼錯誤回一樣的訊息 / an unknown account and a wrong password look alike', async () => {
  await teacher();
  const wrongPassword = await entrants.signIn({ email: 'teacher@example.com', password: 'nope' })
    .then(() => null, (err) => err.key);
  const noSuchAccount = await entrants.signIn({ email: 'nobody@example.com', password: 'passw0rd!' })
    .then(() => null, (err) => err.key);
  assert.equal(wrongPassword, 'entrant.errors.badCredentials');
  assert.equal(noSuchAccount, wrongPassword, 'the login page must not reveal which addresses exist');
});

test('主辦重設密碼後，舊密碼失效並強制改密碼 / a reset invalidates the old password and forces a change', async () => {
  const account = await teacher();
  const { temporaryPassword } = await entrants.resetPassword(account.id);

  await assert.rejects(() => entrants.signIn({ email: 'teacher@example.com', password: 'passw0rd!' }));
  const signedIn = await entrants.signIn({ email: 'teacher@example.com', password: temporaryPassword });
  assert.equal(signedIn.must_change_password, true);

  const changed = await entrants.changePassword(account.id, { current: temporaryPassword, next: 'brand-new-one' });
  assert.equal(changed.must_change_password, false);
  await entrants.signIn({ email: 'teacher@example.com', password: 'brand-new-one' });
});

test('登入 cookie 被改過就不算數 / a tampered login cookie is rejected', async () => {
  const account = await teacher();
  const token = entrants.makeToken(account.id);
  assert.equal(entrants.readToken(token), account.id);
  assert.equal(entrants.readToken(`${account.id + 1}.${token.split('.').slice(1).join('.')}`), null);
  assert.equal(entrants.readToken('rubbish'), null);
  assert.equal(entrants.readToken(token, { maxAgeMs: -1 }), null, 'an expired cookie stops working');
});

// ------------------------------------------------------------------ 名冊 / the roster

test('名冊建一次，跨比賽重複用 / the roster is built once and reused', async () => {
  const account = await teacher();
  await roster.addAthlete({ entrantId: account.id, name: '王小明', birthDate: '2012-05-04' });
  await roster.addAthlete({ entrantId: account.id, name: '李小美', birthDate: '2013-11-20' });

  const list = await roster.listRoster(account.id);
  assert.equal(list.length, 2);
  // 選手不必有電子郵件，這正是改成名冊的理由。
  // Competitors need no email address at all, which is the whole point of the roster.
  assert.equal(list[0].email, null);
});

test('同名同生日擋下來，當成手滑按兩次 / the same name and birthday is treated as a double-tap', async () => {
  const account = await teacher();
  await roster.addAthlete({ entrantId: account.id, name: '王小明', birthDate: '2012-05-04' });
  await assert.rejects(
    () => roster.addAthlete({ entrantId: account.id, name: '王小明', birthDate: '2012-05-04' }),
    (err) => err.key === 'roster.errors.duplicate',
  );
  // 同名但生日不同是兩個人，要能建。
  // The same name with a different birthday is a different person and must go in.
  await roster.addAthlete({ entrantId: account.id, name: '王小明', birthDate: '2010-01-01' });
  assert.equal((await roster.listRoster(account.id)).length, 2);
});

test('生日格式不對或是未來日期都不收 / a malformed or future date of birth is refused', async () => {
  const account = await teacher();
  for (const bad of ['2012/5/4', '民國101年', '', '2012-13-40']) {
    await assert.rejects(
      () => roster.addAthlete({ entrantId: account.id, name: 'X', birthDate: bad }),
      (err) => err.key === 'roster.errors.birthDateInvalid',
      `refused: ${bad}`,
    );
  }
  await assert.rejects(
    () => roster.addAthlete({ entrantId: account.id, name: 'X', birthDate: '2999-01-01' }),
    (err) => err.key === 'roster.errors.birthDateFuture',
  );
});

test('報過名的選手不刪掉，只收起來 / a competitor who has entered is archived, not deleted', async () => {
  const account = await teacher();
  const competition = await comps.createCompetition({ name: 'Cup', feeCents: 0, status: 'open' });
  const division = await comps.addDivision({ competitionId: competition.id, name: 'Solo', sortOrder: 1 });
  const athlete = await roster.addAthlete({ entrantId: account.id, name: '王小明', birthDate: '2012-05-04' });

  await regs.register({
    competitionId: competition.id,
    divisionId: division.id,
    athleteIds: [athlete.id],
    entrantId: account.id,
  });

  const result = await roster.removeAthlete(athlete.id, account.id);
  assert.equal(result.removed, false);
  assert.equal(result.archived, true);
  assert.equal((await roster.listRoster(account.id)).length, 0, 'gone from the picker');
  assert.equal((await roster.listRoster(account.id, { includeArchived: true })).length, 1, 'but the record stays');
});

// ------------------------------------------------------------------ 年齡 / age

test('年齡算法兩種都對 / both age rules work', () => {
  const born = '2012-12-31';
  // 12 月 31 日算法：同年出生的一律同組，所以 2026 年是 14 歲。
  // The 31 December rule puts everyone born in the same year together: 14 in 2026.
  assert.equal(roster.ageOf(born, { basis: 'year_end', referenceDate: '2026-03-01' }), 14);
  // 比賽當天算法：三月比賽時還沒過生日，所以是 13 歲。
  // On the day: the birthday has not come round yet in March, so 13.
  assert.equal(roster.ageOf(born, { basis: 'event_day', referenceDate: '2026-03-01' }), 13);
  assert.equal(roster.ageOf(born, { basis: 'event_day', referenceDate: '2026-12-31' }), 14);
});

test('年齡不符擋下來，而且說得出是哪一位 / an age failure names the person', async () => {
  const account = await teacher();
  const competition = await comps.createCompetition({ name: 'Cup', feeCents: 0, status: 'open' });
  await comps.setAgeRule(competition.id, { ageBasis: 'year_end', eventDate: '2026-06-01' });
  const fresh = await comps.getCompetition(competition.id);

  const u12 = await comps.addDivision({
    competitionId: competition.id, name: 'U12', sortOrder: 1, ageMin: 0, ageMax: 12,
  });

  const young = await roster.addAthlete({ entrantId: account.id, name: '小明', birthDate: '2016-01-01' });
  const old = await roster.addAthlete({ entrantId: account.id, name: '大明', birthDate: '2008-01-01' });

  assert.deepEqual(roster.ageProblems({ athletes: [young], division: u12, competition: fresh }), []);

  const problems = roster.ageProblems({ athletes: [young, old], division: u12, competition: fresh });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].name, '大明');
  assert.equal(problems[0].age, 18);
  assert.equal(problems[0].max, 12);
});

test('年齡不符的報名會被退，訊息帶著姓名和歲數 / an over-age entry is refused with the name and age', async () => {
  const account = await teacher();
  const competition = await comps.createCompetition({ name: 'Cup', feeCents: 0, status: 'open' });
  await comps.setAgeRule(competition.id, { ageBasis: 'year_end', eventDate: '2026-06-01' });
  const u12 = await comps.addDivision({
    competitionId: competition.id, name: 'U12', sortOrder: 1, ageMin: 0, ageMax: 12,
  });
  const old = await roster.addAthlete({ entrantId: account.id, name: '大明', birthDate: '2008-01-01' });

  await assert.rejects(
    () => regs.register({
      competitionId: competition.id,
      divisionId: u12.id,
      athleteIds: [old.id],
      entrantId: account.id,
    }),
    (err) => err.key === 'register.errors.ageOutOfRange' && err.params.name === '大明' && err.params.age === 18,
  );
  assert.equal((await regs.listRegistrations(competition.id)).length, 0);
});

test('沒設年齡限制的組別誰都能報 / a division without limits takes anyone', async () => {
  const account = await teacher();
  const competition = await comps.createCompetition({ name: 'Cup', feeCents: 0, status: 'open' });
  const open = await comps.addDivision({ competitionId: competition.id, name: 'Open', sortOrder: 1 });
  const old = await roster.addAthlete({ entrantId: account.id, name: '大明', birthDate: '1950-01-01' });

  const result = await regs.register({
    competitionId: competition.id,
    divisionId: open.id,
    athleteIds: [old.id],
    entrantId: account.id,
  });
  assert.equal(result.registration.status, 'paid');
});

// ------------------------------------------------------------------ 報名 / entering

test('別人名冊裡的選手報不了名 / somebody else’s roster cannot be entered', async () => {
  const mine = await teacher();
  const theirs = await teacher('other@example.com');
  const competition = await comps.createCompetition({ name: 'Cup', feeCents: 0, status: 'open' });
  const division = await comps.addDivision({ competitionId: competition.id, name: 'Solo', sortOrder: 1 });
  const notMine = await roster.addAthlete({ entrantId: theirs.id, name: 'Not Mine', birthDate: '2012-01-01' });

  await assert.rejects(
    () => regs.register({
      competitionId: competition.id,
      divisionId: division.id,
      athleteIds: [notMine.id],
      entrantId: mine.id,
    }),
    (err) => err.key === 'register.errors.athleteNotYours',
  );
});

test('雙人組勾兩位，一個背號、一筆報名 / a couple is two ticks, one bib, one entry', async () => {
  const account = await teacher();
  const competition = await comps.createCompetition({ name: 'Cup', feeCents: 0, status: 'open' });
  const couple = await comps.addDivision({
    competitionId: competition.id, name: 'Couple', sortOrder: 1, memberMin: 2, memberMax: 2,
  });
  const a = await roster.addAthlete({ entrantId: account.id, name: '王小明', birthDate: '2012-05-04' });
  const b = await roster.addAthlete({ entrantId: account.id, name: '李小美', birthDate: '2013-11-20' });

  const result = await regs.register({
    competitionId: competition.id,
    divisionId: couple.id,
    athleteIds: [a.id, b.id],
    entrantId: account.id,
  });

  assert.equal(result.registration.member_count, 2);
  assert.equal(result.registration.athlete_name, '王小明 / 李小美');
  assert.equal((await regs.listRegistrations(competition.id)).length, 1, 'one entry, not two');

  const members = await regs.membersOf(result.registration.id);
  assert.deepEqual(members.map((m) => Number(m.athlete_id)), [a.id, b.id].map(Number));
});

test('人數不符的勾選送不出去 / the wrong number of ticks is refused', async () => {
  const account = await teacher();
  const competition = await comps.createCompetition({ name: 'Cup', feeCents: 0, status: 'open' });
  const couple = await comps.addDivision({
    competitionId: competition.id, name: 'Couple', sortOrder: 1, memberMin: 2, memberMax: 2,
  });
  const a = await roster.addAthlete({ entrantId: account.id, name: 'A', birthDate: '2012-05-04' });
  const b = await roster.addAthlete({ entrantId: account.id, name: 'B', birthDate: '2013-11-20' });
  const c = await roster.addAthlete({ entrantId: account.id, name: 'C', birthDate: '2013-01-20' });

  await assert.rejects(
    () => regs.register({ competitionId: competition.id, divisionId: couple.id, athleteIds: [a.id], entrantId: account.id }),
    (err) => err.key === 'register.errors.tooFewMembers',
  );
  await assert.rejects(
    () => regs.register({
      competitionId: competition.id, divisionId: couple.id, athleteIds: [a.id, b.id, c.id], entrantId: account.id,
    }),
    (err) => err.key === 'register.errors.tooManyMembers',
  );
});

test('跨組別加收靠名冊編號，同一個帳號內才算 / the surcharge follows the roster id, inside one account', async () => {
  const account = await teacher();
  const other = await teacher('other@example.com');
  const competition = await comps.createCompetition({ name: 'Cup', feeCents: 1000, status: 'open' });
  const latin = await comps.addDivision({
    competitionId: competition.id, name: 'Latin', sortOrder: 1, feeCents: 1000, extraDivisionFeeCents: 500,
  });
  const standard = await comps.addDivision({
    competitionId: competition.id, name: 'Standard', sortOrder: 2, feeCents: 1000, extraDivisionFeeCents: 500,
  });

  const athlete = await roster.addAthlete({ entrantId: account.id, name: '王小明', birthDate: '2012-05-04' });

  const first = await regs.register({
    competitionId: competition.id, divisionId: latin.id, athleteIds: [athlete.id], entrantId: account.id, provider: 'ecpay',
  });
  assert.equal(first.quote.totalCents, 1000, 'the first division has no surcharge');

  const second = await regs.register({
    competitionId: competition.id, divisionId: standard.id, athleteIds: [athlete.id], entrantId: account.id, provider: 'ecpay',
  });
  assert.equal(second.quote.totalCents, 1500, 'the second division carries the surcharge');

  // 另一間教室自己建的同名同生日選手，是另一個編號，不加收。刻意不去猜。
  // The same person entered by another studio has a different id and is not surcharged.
  // That is deliberate: the system does not guess.
  const twin = await roster.addAthlete({ entrantId: other.id, name: '王小明', birthDate: '2012-05-04' });
  const third = await regs.register({
    competitionId: competition.id, divisionId: standard.id, athleteIds: [twin.id], entrantId: other.id, provider: 'ecpay',
  });
  assert.equal(third.quote.totalCents, 1000);
});
