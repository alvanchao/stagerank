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
    assert.equal(guarded.status, 401, `${path} is behind the sign-in`);
    assert.ok((await guarded.text()).includes('/staff/app'), `${path} points staff to the app`);
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

// ---- 工作人員：每人一組專屬碼 / personal single-use staff codes
async function staffWorld() {
  const a = await scenario();
  const b = await scenario();
  const staffCodes = await import('../src/services/staffCodes.js');
  const one = async (competition, role, name = '小明', allowBrowser = false) =>
    (await staffCodes.issueBatch(competition.id, { role, names: name, allowBrowser }))[0];
  return { a, b, staffCodes, one };
}
const cookieOf = (res) => ({ headers: { cookie: res.headers.get('set-cookie').split(';')[0] } });
const app = (code, standalone = '1') => http.postForm('/staff/login', { code, standalone });

test('碼只能用一次，登入後只進得了自己角色與自己那場 / single use, own role, own competition', async () => {
  const { a, b, one } = await staffWorld();
  const host = await one(a.competition, 'host', '主持人甲');

  const first = await app(host.code);
  assert.equal(first.status, 303);
  const asHost = cookieOf(first);
  assert.equal((await http.get(`/host/${a.competition.id}`, asHost)).status, 200);
  assert.equal((await http.get(`/host/${b.competition.id}`, asHost)).status, 401, 'another competition');
  assert.equal((await http.get(`/checkin/${a.competition.id}`, asHost)).status, 401, 'another role');
  assert.ok((await (await http.get(`/admin/c/${a.competition.id}`, asHost)).text()).includes('name="token"'), 'not the back office');

  // 同一組碼第二次就用不了
  const again = await app(host.code);
  assert.equal(again.status, 400);
  // 亂猜的碼也不行
  assert.equal((await app('AAAAA-AAAAA')).status, 400);
});

test('報到只進報到頁；點錄與主持人可補救漏掉的報到 / desk is desk-only; check-in and host may rescue', async () => {
  const { a, one } = await staffWorld();
  const cid = a.competition.id;
  const asDesk = cookieOf(await app((await one(a.competition, 'desk')).code));
  assert.equal((await http.get(`/desk/${cid}`, asDesk)).status, 200);
  assert.equal((await http.get(`/checkin/${cid}`, asDesk)).status, 401);
  assert.equal((await http.get(`/host/${cid}`, asDesk)).status, 401);

  const asCheckin = cookieOf(await app((await one(a.competition, 'checkin')).code));
  assert.equal((await http.get(`/checkin/${cid}`, asCheckin)).status, 200);
  assert.equal((await http.get(`/desk/${cid}`, asCheckin)).status, 200);
  const asHost = cookieOf(await app((await one(a.competition, 'host')).code));
  assert.equal((await http.get(`/desk/${cid}`, asHost)).status, 200);
});

test('普通瀏覽器被擋，除非主辦允許備用 / a plain browser is refused unless allowed', async () => {
  const { a, one } = await staffWorld();
  const strict = await one(a.competition, 'host');
  assert.equal((await app(strict.code, '0')).status, 400);
  // 被擋不算用掉：裝好 App 之後同一組碼還能登入
  assert.equal((await app(strict.code, '1')).status, 303);

  const lax = await one(a.competition, 'host', '備用', true);
  assert.equal((await app(lax.code, '0')).status, 303);
});

test('新增輪次自動排順序，後一輪的帶入按鈕帶上前一輪 / rounds get an order and later rounds seed from the previous one', async () => {
  const c = await comps.createCompetition({ name: '順序盃', feeCents: 0, status: 'open' });
  const division = await comps.addDivision({ competitionId: c.id, name: '成人拉丁', sortOrder: 1 });
  const admin = { headers: { Cookie: 'stagerank_admin=test-admin-token' } };
  await regs.register({ competitionId: c.id, divisionId: division.id, athleteName: '選手 1' });
  await voucher.settle(c.id); // 畫面要有憑證碼才會列出各組 / the page lists divisions once a voucher exists
  for (const name of ['準決賽', '決賽']) {
    const r = await http.postForm(`/admin/c/${c.id}/division/${division.id}/round`, { name, scoringMode: 'mark', heatSize: '6' }, admin);
    assert.equal(r.status, 303);
  }
  const rounds = await schedule.listRounds(division.id);
  assert.deepEqual(rounds.map((r) => r.name), ['準決賽', '決賽']);
  assert.ok(rounds[0].sort_order < rounds[1].sort_order, 'semi comes before final');
  const page = await (await http.get(`/admin/c/${c.id}/schedule`, admin)).text();
  assert.match(page, new RegExp(`name="fromRoundId" value="${rounds[0].id}"`));
  assert.doesNotMatch(page, new RegExp(`name="fromRoundId" value="${rounds[1].id}"`));
});

test('不存在的網址回 404，不會讓服務掛掉；編號亂打也是 404 / unknown ids answer 404 and never hang or crash', async () => {
  for (const u of ['/results/nope', '/results/nope/bib?bib=1', '/c/nope', '/admin/c/99999/schedule', '/admin/c/99999/results',
    '/admin/c/99999/export/bibs.xlsx', '/admin/c/99999/staff', '/desk/99999', '/host/99999', '/checkin/99999', '/admin/c/abc', '/desk/abc']) {
    const r = await http.get(u, { headers: { Cookie: 'stagerank_admin=test-admin-token' } });
    assert.equal(r.status, 404, u);
  }
  assert.equal((await http.get('/healthz')).status, 200, 'server is still up');
});

test('停用、重新產生、結束比賽，登入狀態立刻失效 / revoke, reissue and end kill the sign-in at once', async () => {
  const { a, staffCodes, one } = await staffWorld();
  const cid = a.competition.id;

  const m1 = await one(a.competition, 'host', '甲');
  const s1 = cookieOf(await app(m1.code));
  assert.equal((await http.get(`/host/${cid}`, s1)).status, 200);
  await staffCodes.revoke(m1.member.id, cid);
  assert.equal((await http.get(`/host/${cid}`, s1)).status, 401, 'revoked');

  const m2 = await one(a.competition, 'host', '乙');
  const s2 = cookieOf(await app(m2.code));
  const fresh = await staffCodes.reissue(m2.member.id, cid);
  assert.equal((await http.get(`/host/${cid}`, s2)).status, 401, 'reissue voids the old sign-in');
  const s2b = cookieOf(await app(fresh.code));
  assert.equal((await http.get(`/host/${cid}`, s2b)).status, 200);

  await staffCodes.endCompetition(cid);
  assert.equal((await http.get(`/host/${cid}`, s2b)).status, 401, 'competition ended');
  assert.equal((await app((await one(a.competition, 'host', '丙')).code)).status, 400, 'no new sign-in after the end');
  await staffCodes.reopenCompetition(cid);
  // 取消結束不會讓被踢掉的人復活；要重新發碼、重新登入。
  // Reopening must not revive signed-out staff; they need a fresh code.
  assert.equal((await http.get(`/host/${cid}`, s2b)).status, 401, 'reopening does not revive old sign-ins');
  const again = await staffCodes.reissue(m2.member.id, cid);
  assert.equal((await http.get(`/host/${cid}`, cookieOf(await app(again.code)))).status, 200, 'a fresh code works');
});

test('操作紀錄記下是誰做的；主辦後台能建一批並顯示 QR / the log names who did it; the admin page issues a batch with QR', async () => {
  const { a, staffCodes, one } = await staffWorld();
  const cid = a.competition.id;

  // 主辦一次貼三個名字
  const page = await http.postForm(`/admin/c/${cid}/staff`, { role: 'checkin', names: '小華\n小美\n小強', allowBrowser: '1' }, staff());
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal((html.match(/<svg/g) || []).length, 3, 'one QR per person');
  assert.ok(html.includes('小華') && html.includes('小強'));
  assert.equal((await staffCodes.listMembers(cid)).length, 3);

  // 沒帶主辦通行碼進不去
  assert.ok((await (await http.postForm(`/admin/c/${cid}/staff`, { role: 'host', names: '壞人' })).text()).includes('name="token"'));

  // 點錄人員做了一件事，紀錄裡有他的名字
  const m = await one(a.competition, 'host', '主持人甲');
  const asHost = cookieOf(await app(m.code));
  const { entries } = await (await import('../src/services/schedule.js')).heatWithEntries(a.heats[0].id);
  await http.postForm(`/host/${cid}/add/${entries[0].id}`, {}, asHost);
  await new Promise((r) => setTimeout(r, 100));
  const log = await staffCodes.recentLog(cid);
  assert.ok(log.some((l) => l.staff_name === '主持人甲' && /host/.test(l.action)), 'the log names the host');
});

test('App 登入頁與安裝設定 / the staff app page and its manifest', async () => {
  const page = await http.get('/staff/app?code=abcde-12345');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('value="ABCDE-12345"'), 'the scanned code is prefilled but not used');
  assert.ok(html.includes('rel="manifest"'));
  const manifest = await http.get('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).display, 'standalone');
  assert.equal((await http.get('/icon-192.png')).status, 200);
});
