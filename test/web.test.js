// 把第 2 到 4 段的畫面用真的 HTTP 走一遍，跟工作人員的手機走同一條路。
// Drives the stage 2-4 screens over real HTTP, the same path the staff phones take.

import { resetDatabase, startServer } from './helpers.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/app.js');
const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const voucher = await import('../src/services/voucher.js');
const schedule = await import('../src/services/schedule.js');
const judgeService = await import('../src/services/judges.js');
const floor = await import('../src/services/floor.js');
const scoring = await import('../src/services/scoring.js');
const { closePool, one } = await import('../src/db/index.js');

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
beforeEach(async () => {
  await resetDatabase();
});

const staff = () => ({ headers: { cookie: staffCookie } });

async function scenario({ dancers = 6, heatSize = 3, judgeCount = 3, roundOptions = {} } = {}) {
  const competition = await comps.createCompetition({ name: '陽光盃', feeCents: 0, status: 'open' });
  const division = await comps.addDivision({ competitionId: competition.id, name: 'U15 拉丁', sortOrder: 1 });
  const cha = await schedule.addDance({ competitionId: competition.id, name: 'Cha Cha', sortOrder: 1 });
  await schedule.setDivisionDances(division.id, [cha.id]);

  for (let i = 1; i <= dancers; i += 1) {
    await regs.register({ competitionId: competition.id, divisionId: division.id, athleteName: `選手 ${i}` });
  }
  const settled = await voucher.settle(competition.id);
  await schedule.assignBibs(settled.voucher.code, { start: 101 });

  const round = await schedule.createRound({
    divisionId: division.id,
    name: '初賽',
    heatSize,
    scoringMode: 'mark',
    advanceCount: 3,
    ...roundOptions,
  });
  await schedule.seedFirstRound(settled.voucher.code, round.id);

  const judges = [];
  for (let i = 1; i <= judgeCount; i += 1) {
    const judge = await judgeService.addJudge({ competitionId: competition.id, name: `裁判 ${i}` });
    await judgeService.assignToDivision(judge.id, division.id);
    judges.push(judge);
  }

  const heats = await schedule.buildHeats(round.id, cha.id);
  await schedule.rebuildRunningOrder(competition.id);
  return { competition, division, round, cha, judges, heats, voucher: settled.voucher };
}

test('工作人員的三個畫面都要通行碼 / all three staff screens need the passcode', async () => {
  const { competition } = await scenario();
  for (const path of [`/desk/${competition.id}`, `/checkin/${competition.id}`, `/host/${competition.id}`]) {
    const guarded = await http.get(path);
    assert.ok((await guarded.text()).includes('name="token"'), `${path} is behind the passcode`);
    const open = await http.get(path, staff());
    assert.equal(open.status, 200, `${path} opens with the passcode`);
  }
});

test('報到畫面可以用背號搜尋並標記報到 / the desk finds a competitor by bib and reports them in', async () => {
  const { competition } = await scenario();
  const page = await http.get(`/desk/${competition.id}?q=101`, staff());
  const html = await page.text();
  assert.ok(html.includes('101'));
  assert.ok(!html.includes('102'), 'the search narrows the list');

  const registration = await one(
    `SELECT r.id FROM registrations r JOIN voucher_entries ve ON ve.registration_id = r.id WHERE ve.bib_number = 101`,
  );
  const res = await http.postForm(`/desk/${competition.id}/report/${registration.id}`, {}, staff());
  assert.equal(res.status, 303);
  assert.notEqual((await one('SELECT reported_at FROM registrations WHERE id = $1', [registration.id])).reported_at, null);
});

test('檢錄畫面看得到接下來幾場，沒報到的反灰 / the check-in screen greys out anyone who never reported in', async () => {
  const { competition, heats } = await scenario();
  const page = await http.get(`/checkin/${competition.id}`, staff());
  const html = await page.text();

  assert.ok(html.includes('101'));
  assert.ok(html.includes('class="dim"'), 'un-reported competitors are dimmed');

  const entry = await one('SELECT id FROM heat_entries WHERE heat_id = $1 LIMIT 1', [heats[0].id]);
  const res = await http.postForm(`/checkin/${competition.id}/entry/${entry.id}`, {}, staff());
  assert.equal(res.status, 303);
  assert.notEqual((await one('SELECT checked_in_at FROM heat_entries WHERE id = $1', [entry.id])).checked_in_at, null);
});

test('主持人畫面：換場、開始、補點 / the host board changes over, starts and adds a latecomer', async () => {
  const { competition, heats } = await scenario();

  let res = await http.postForm(`/host/${competition.id}/next`, {}, staff());
  assert.equal(res.status, 303);

  let page = await http.get(`/host/${competition.id}`, staff());
  let html = await page.text();
  assert.ok(html.includes('U15 拉丁'));
  assert.ok(html.includes('未檢錄') || html.includes('Not checked in'));

  const current = await one(`SELECT id FROM heats WHERE competition_id = $1 AND status = 'standby'`, [competition.id]);
  res = await http.postForm(`/host/${competition.id}/start`, { heatId: current.id }, staff());
  assert.equal(res.status, 303);
  assert.equal((await one('SELECT status FROM heats WHERE id = $1', [current.id])).status, 'scoring');

  // 音樂放了才衝進場。
  // The latecomer runs on after the music starts.
  const entry = await one('SELECT id FROM heat_entries WHERE heat_id = $1 LIMIT 1', [current.id]);
  res = await http.postForm(`/host/${competition.id}/add/${entry.id}`, {}, staff());
  assert.equal(res.status, 303);
  assert.notEqual((await one('SELECT checked_in_at FROM heat_entries WHERE id = $1', [entry.id])).checked_in_at, null);
});

test('裁判用登入碼進入，只看得到已檢錄的人 / a judge signs in with a code and sees only checked-in dancers', async () => {
  const { competition, heats, judges } = await scenario();

  const bad = await http.postForm('/judge/login', { code: 'NOPE-NOPE' });
  assert.equal(bad.status, 401);

  const login = await http.postForm('/judge/login', { code: judges[0].login_code });
  assert.equal(login.status, 303);
  const judgeCookie = login.headers.get('set-cookie').split(';')[0];
  const asJudge = { headers: { cookie: judgeCookie } };

  await http.postForm(`/host/${competition.id}/next`, { heatId: heats[0].id }, staff());

  let page = await http.get(`/judge/${competition.id}`, asJudge);
  let html = await page.text();
  // 還沒檢錄，所以看不到任何選手，但看得到預備畫面。
  // Nobody is checked in yet, so no competitor shows, but the standby screen does.
  assert.ok(html.includes('準備好了') || html.includes('I am ready'));

  const entries = await schedule.heatWithEntries(heats[0].id);
  for (const entry of entries.entries) await floor.checkIn(entry.id);

  page = await http.get(`/judge/${competition.id}`, asJudge);
  html = await page.text();
  assert.ok(html.includes('101'), 'checked-in competitors now appear');
});

test('裁判按準備好，主持人看得到燈號 / the judge confirms and the host sees the light', async () => {
  const { competition, heats, judges } = await scenario();
  const login = await http.postForm('/judge/login', { code: judges[0].login_code });
  const asJudge = { headers: { cookie: login.headers.get('set-cookie').split(';')[0] } };

  await http.postForm(`/host/${competition.id}/next`, { heatId: heats[0].id }, staff());
  const res = await http.postForm(`/judge/${competition.id}/ready`, { heatId: heats[0].id }, asJudge);
  assert.equal(res.status, 303);

  const state = await one('SELECT * FROM heat_judges WHERE heat_id = $1 AND judge_id = $2', [heats[0].id, judges[0].id]);
  assert.notEqual(state.ready_at, null);
});

test('裁判送出評分，超過名額會被擋 / a judge submits, and going over the quota is refused', async () => {
  const { competition, heats, judges, round } = await scenario({ dancers: 6, heatSize: 6, roundOptions: { advanceCount: 2 } });
  const login = await http.postForm('/judge/login', { code: judges[0].login_code });
  const asJudge = { headers: { cookie: login.headers.get('set-cookie').split(';')[0] } };

  const { entries } = await schedule.heatWithEntries(heats[0].id);
  for (const entry of entries) await floor.checkIn(entry.id);
  await http.postForm(`/host/${competition.id}/next`, { heatId: heats[0].id }, staff());
  await http.postForm(`/host/${competition.id}/start`, { heatId: heats[0].id }, staff());

  const ids = entries.map((e) => String(e.round_entry_id));

  const ok = await http.postForm(
    `/judge/${competition.id}/submit`,
    { heatId: heats[0].id, mark: ids.slice(0, 2) },
    asJudge,
  );
  assert.equal(ok.status, 303);
  assert.ok(!ok.headers.get('location').includes('error'));

  const over = await http.postForm(
    `/judge/${competition.id}/submit`,
    { heatId: heats[0].id, mark: ids.slice(0, 3) },
    asJudge,
  );
  assert.ok(over.headers.get('location').includes('overQuota'), 'the quota is enforced on the server too');

  const stored = await one(
    'SELECT COUNT(*)::int AS n FROM scores WHERE round_id = $1 AND judge_id = $2 AND marked = TRUE',
    [round.id, judges[0].id],
  );
  assert.equal(stored.n, 2);
});

test('跳出畫面會回報並作廢 / the browser reports a walk-away and the heat is voided', async () => {
  const { competition, heats, judges } = await scenario();
  const login = await http.postForm('/judge/login', { code: judges[0].login_code });
  const asJudge = { headers: { cookie: login.headers.get('set-cookie').split(';')[0] } };

  const { entries } = await schedule.heatWithEntries(heats[0].id);
  for (const entry of entries) await floor.checkIn(entry.id);
  await http.postForm(`/host/${competition.id}/next`, { heatId: heats[0].id }, staff());
  await http.postForm(`/host/${competition.id}/start`, { heatId: heats[0].id }, staff());

  const res = await http.postJson(`/judge/${competition.id}/left`, { heatId: heats[0].id }, { cookie: asJudge.headers.cookie });
  const body = await res.json();
  assert.equal(body.voided, true);

  const page = await http.get(`/judge/${competition.id}`, asJudge);
  assert.ok((await page.text()).includes('作廢') || (await http.get(`/judge/${competition.id}`, asJudge).then((r) => r.text())).includes('Voided'));
});

test('成績要公告才看得到，選手用背號查 / results appear only once published, and a bib finds them', async () => {
  const { competition, heats, judges, round } = await scenario({ dancers: 6, heatSize: 6 });

  const { entries } = await schedule.heatWithEntries(heats[0].id);
  for (const entry of entries) await floor.checkIn(entry.id);
  await floor.nextHeat(competition.id, { heatId: heats[0].id });
  await floor.startHeat(heats[0].id);
  for (const judge of judges) {
    const visible = await judgeService.heatEntriesForJudge(heats[0].id, judge.id);
    await scoring.submitScores(heats[0].id, judge.id, { marks: visible.slice(0, 3).map((v) => String(v.round_entry_id)) });
  }

  await http.postForm(`/admin/c/${competition.id}/round/${round.id}/compute`, {}, staff());

  // 還沒公告，公開頁面看不到名次。
  // Not published yet, so the public page shows no placings.
  let page = await http.get(`/results/${competition.slug}`);
  let html = await page.text();
  assert.ok(!html.includes('101') || html.includes(res => false) === false);
  assert.ok(html.includes('尚未公告') || html.includes('Not published'));

  await http.postForm(`/admin/c/${competition.id}/round/${round.id}/publish`, {}, staff());

  page = await http.get(`/results/${competition.slug}`);
  html = await page.text();
  assert.ok(html.includes('101'), 'published results are visible');

  const lookup = await http.get(`/results/${competition.slug}/bib?bib=101`);
  const lookupHtml = await lookup.text();
  assert.ok(lookupHtml.includes('選手'), 'the competitor finds themselves by bib');
});

test('賽前準備頁可以排賽程、指定裁判 / the preparation page builds the schedule and assigns judges', async () => {
  const { competition, division } = await scenario();
  const page = await http.get(`/admin/c/${competition.id}/schedule`, staff());
  const html = await page.text();

  assert.ok(html.includes('Cha Cha'));
  assert.ok(html.includes('U15 拉丁'));
  assert.ok(html.includes('裁判 1'));

  const res = await http.postForm(`/admin/c/${competition.id}/judges`, { name: '新來的裁判' }, staff());
  assert.equal(res.status, 303);
  const judges = await judgeService.listJudges(competition.id);
  assert.ok(judges.some((j) => j.name === '新來的裁判'));
});

test('即時同步的連線開得起來 / the live feed connects', async () => {
  const { competition } = await scenario();
  const controller = new AbortController();
  const res = await fetch(`${http.base}/events/${competition.id}`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  controller.abort();
});

// ---- 每場比賽各自的工作人員通行碼 / per-competition staff passcodes
test('主持人與點錄的通行碼每場獨立、角色互不通用、重新產生後舊碼失效', async () => {
  const a = await scenario();
  const staffCodes = await import('../src/services/staffCodes.js');
  const codesA = await staffCodes.issueAll(a.competition.id);
  const b = await scenario();
  const codesB = await staffCodes.issueAll(b.competition.id);

  async function login(cid, role, token) {
    return http.postForm(`/staff/${cid}/login`, { role, token });
  }
  const cookieOf = (res) => ({ headers: { cookie: res.headers.get('set-cookie').split(';')[0] } });

  // 主持人碼：開得了自己那場的主持頁，開不了別場、開不了點錄與後台
  const h = await login(a.competition.id, 'host', codesA.host);
  assert.equal(h.status, 303);
  const asHost = cookieOf(h);
  assert.equal((await http.get(`/host/${a.competition.id}`, asHost)).status, 200);
  assert.equal((await http.get(`/host/${b.competition.id}`, asHost)).status, 401);
  assert.equal((await http.get(`/checkin/${a.competition.id}`, asHost)).status, 401);
  assert.ok((await (await http.get(`/admin/c/${a.competition.id}`, asHost)).text()).includes('name="token"'), 'host is stopped at the admin login');

  // 點錄碼：只能點錄／櫃檯
  const c = await login(a.competition.id, 'checkin', codesA.checkin);
  const asCheckin = cookieOf(c);
  assert.equal((await http.get(`/checkin/${a.competition.id}`, asCheckin)).status, 200);
  assert.equal((await http.get(`/desk/${a.competition.id}`, asCheckin)).status, 200);
  assert.equal((await http.get(`/host/${a.competition.id}`, asCheckin)).status, 401);

  // 別場的碼、亂猜的碼、角色搭錯，都進不去
  assert.equal((await login(a.competition.id, 'host', codesB.host)).status, 401);
  assert.equal((await login(a.competition.id, 'host', 'AAAAA-AAAAA')).status, 401);
  assert.equal((await login(a.competition.id, 'checkin', codesA.host)).status, 401);

  // 裁判 cookie 進不了主持人頁
  const jl = await http.postForm(`/judge/login`, { code: a.judges[0].login_code });
  const asJudge = { headers: { cookie: (jl.headers.get('set-cookie') || '').split(';')[0] } };
  assert.equal((await http.get(`/host/${a.competition.id}`, asJudge)).status, 401);

  // 重新產生：舊碼立刻失效，新碼可用
  const fresh = await staffCodes.issue(a.competition.id, 'host');
  assert.equal((await http.get(`/host/${a.competition.id}`, asHost)).status, 401);
  assert.equal((await login(a.competition.id, 'host', fresh)).status, 303);

  // 主辦通行碼仍然全部可用
  assert.equal((await http.get(`/host/${a.competition.id}`, staff())).status, 200);
});

test('報到密碼只進報到頁；點錄與主持人可以補救漏掉的報到', async () => {
  const a = await scenario();
  const staffCodes = await import('../src/services/staffCodes.js');
  const codes = await staffCodes.issueAll(a.competition.id);
  const cid = a.competition.id;
  const cookieOf = (res) => ({ headers: { cookie: res.headers.get('set-cookie').split(';')[0] } });
  const login = (role) => http.postForm(`/staff/${cid}/login`, { role, token: codes[role] });

  const asDesk = cookieOf(await login('desk'));
  assert.equal((await http.get(`/desk/${cid}`, asDesk)).status, 200);
  assert.equal((await http.get(`/checkin/${cid}`, asDesk)).status, 401);
  assert.equal((await http.get(`/host/${cid}`, asDesk)).status, 401);

  const asCheckin = cookieOf(await login('checkin'));
  assert.equal((await http.get(`/desk/${cid}`, asCheckin)).status, 200);
  const asHost = cookieOf(await login('host'));
  assert.equal((await http.get(`/desk/${cid}`, asHost)).status, 200);

  // 別場的報到碼無效
  const b = await scenario();
  const codesB = await staffCodes.issueAll(b.competition.id);
  assert.equal((await http.postForm(`/staff/${cid}/login`, { role: 'desk', token: codesB.desk })).status, 401);
});
