// 報名結果頁的隱私與首頁。
// Privacy of the registration page, and the home page.
import { resetDatabase, startServer, makeEntrant } from './helpers.js';
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/app.js');
const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const { closePool } = await import('../src/db/index.js');

let http;
let staffCookie;

before(async () => {
  await resetDatabase();
  http = await startServer(createApp());
  const login = await http.postForm('/admin/login', { token: 'test-admin-token' });
  staffCookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await http.close();
  await closePool();
});
beforeEach(resetDatabase);

async function enter({ email, name, competitionName = 'Privacy Cup', divisionName = 'Solo U12', fee = 0 }) {
  let competition = (await comps.listCompetitions()).find((c) => c.name === competitionName);
  let division;
  if (!competition) {
    competition = await comps.createCompetition({ name: competitionName, feeCents: fee, status: 'open' });
    division = await comps.addDivision({ competitionId: competition.id, name: divisionName, sortOrder: 1 });
  } else {
    division = (await comps.listDivisions(competition.id))[0];
  }
  const who = await makeEntrant({ email, people: [{ name, birthDate: '2014-05-04' }] });
  const result = await regs.register({
    competitionId: competition.id, divisionId: division.id, athleteIds: [who.athletes[0].id], entrantId: who.entrant.id,
  });
  return { ...who, competition, division, registration: result.registration };
}

test('/r/:id：本人與主辦看得到，其他人一律 404 / owner and organiser see it, everyone else gets the plain 404', async () => {
  const first = await enter({ email: 'a@example.com', name: 'Group A Athlete' });
  const second = await makeEntrant({ email: 'b@example.com', people: [{ name: 'Group B Athlete', birthDate: '2013-01-01' }] });
  const url = `/r/${first.registration.id}`;

  const owner = await http.get(url, { headers: { cookie: first.cookie } });
  assert.equal(owner.status, 200);
  assert.match(await owner.text(), /Group A Athlete/);

  const organiser = await http.get(url, { headers: { cookie: staffCookie } });
  assert.equal(organiser.status, 200);

  // 匿名、別的報名人：跟「根本沒有這個編號」一模一樣，連存在與否都問不出來。
  // Anonymous and another entrant: identical to "no such id", so existence cannot be probed.
  const missing = await http.get('/r/999999', { headers: { cookie: second.cookie } });
  for (const headers of [{}, { cookie: second.cookie }, { cookie: 'stagerank_admin=wrong-token' }]) {
    const res = await http.get(url, { headers });
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.ok(!body.includes('Group A Athlete'), 'the name is not leaked');
    assert.equal(body, await (await http.get('/r/999999', { headers })).text(), 'same page as a missing id');
  }
  assert.equal(missing.status, 404);
  assert.equal((await http.get('/r/not-a-number')).status, 404);

  // 沒有設主辦通行碼的站台，空的 cookie 也不能當主辦。
  // An empty cookie never counts as the organiser.
  assert.equal((await http.get(url, { headers: { cookie: 'stagerank_admin=' } })).status, 404);
});

test('免費報名送出後導到 /r/:id，同一個瀏覽器看得到 / after a free entry the redirect lands on a page the owner can open', async () => {
  const who = await makeEntrant({ email: 'c@example.com', people: [{ name: 'Free Athlete', birthDate: '2014-05-04' }] });
  const competition = await comps.createCompetition({ name: 'Free Cup', feeCents: 0, status: 'open' });
  const division = await comps.addDivision({ competitionId: competition.id, name: 'Open', sortOrder: 1 });
  const res = await http.postForm(`/c/${competition.slug}/register`, {
    divisionId: division.id, athleteIds: String(who.athletes[0].id),
  }, { headers: { cookie: who.cookie } });
  assert.equal(res.status, 303);
  const landing = res.headers.get('location');
  assert.match(landing, /^\/r\/\d+$/);
  assert.equal((await http.get(landing, { headers: { cookie: who.cookie } })).status, 200);
  assert.equal((await http.get(landing)).status, 404, 'a different browser cannot open the same link');
});

test('首頁：沒登入是註冊與登入，登入後是我的報名 / home: sign-up and sign-in when signed out, my entries when signed in', async () => {
  const one = await enter({ email: 'e@example.com', name: 'Home Athlete', competitionName: 'Home Cup', divisionName: 'Division Alpha' });
  await enter({ email: 'f@example.com', name: 'Someone Else', competitionName: 'Home Cup' });

  const anonymous = await (await http.get('/')).text();
  assert.match(anonymous, /href="\/entrant\/signup"/);
  assert.match(anonymous, /href="\/entrant\/login"/);
  assert.ok(!anonymous.includes('id="myEntries"'));
  assert.ok(!anonymous.includes('Home Athlete'), 'no entry is shown to the public');
  assert.match(anonymous, /Home Cup/, 'the competition list stays public');
  assert.ok(!anonymous.includes('/r/'), 'no registration link on the public page');

  const signedIn = await (await http.get('/', { headers: { cookie: one.cookie } })).text();
  assert.match(signedIn, /id="myEntries"/);
  assert.match(signedIn, /Home Athlete/);
  assert.match(signedIn, /Division Alpha/);
  assert.match(signedIn, new RegExp(`href="/r/${one.registration.id}"`));
  assert.match(signedIn, /href="\/entrant"/, 'link to the roster');
  assert.match(signedIn, /action="\/logout"/, 'and the one sign-out button');
  assert.ok(!signedIn.includes('Someone Else'), 'only my own entries');
  assert.ok(!signedIn.includes('href="/entrant/signup"'));

  const empty = await makeEntrant({ email: 'g@example.com', people: [] });
  const emptyHome = await (await http.get('/', { headers: { cookie: empty.cookie } })).text();
  assert.match(emptyHome, /id="myEntries"/);
});

test('登入後的 next 只能是本站路徑 / a sign-in next parameter may only be a path on this site', async () => {
  const who = await makeEntrant({ email: 'h@example.com', password: 'passw0rd!' });
  const good = await http.postForm('/entrant/login', { email: 'h@example.com', password: 'passw0rd!', next: '/c/some' });
  assert.equal(good.headers.get('location'), '/c/some');
  for (const next of ['https://evil.example/', '//evil.example', '/\\evil.example']) {
    const res = await http.postForm('/entrant/login', { email: 'h@example.com', password: 'passw0rd!', next });
    assert.equal(res.headers.get('location'), '/entrant', `refused ${next}`);
  }
  assert.ok(who.entrant.id);
});
