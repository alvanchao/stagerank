import { resetDatabase, startServer, makeEntrant } from './helpers.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/app.js');
const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const voucher = await import('../src/services/voucher.js');
const stats = await import('../src/services/stats.js');
const ecpay = (await import('../src/payments/ecpay.js')).default;
const paymentsLayer = await import('../src/payments/index.js');
const { closePool, one } = await import('../src/db/index.js');

let http;

before(async () => {
  await resetDatabase();
  http = await startServer(createApp());
});

after(async () => {
  await http.close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
});

async function makeCompetition({ feeCents = 1200, status = 'open' } = {}) {
  const competition = await comps.createCompetition({
    name: 'Test Cup 2026',
    currency: 'TWD',
    feeCents,
    status,
  });
  const u15 = await comps.addDivision({ competitionId: competition.id, name: 'U15 Latin', sortOrder: 1 });
  const u12 = await comps.addDivision({ competitionId: competition.id, name: 'U12 Latin', sortOrder: 2 });
  return { competition, divisions: [u15, u12] };
}

test('首頁看得到開放中的比賽，草稿不外露 / the home page shows open competitions and hides drafts', async () => {
  await makeCompetition();
  await comps.createCompetition({ name: 'Secret Draft', status: 'draft' });

  const res = await http.get('/');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes('Test Cup 2026'));
  assert.ok(!html.includes('Secret Draft'), 'a draft competition must not be public');
});

test('報名頁依 Accept-Language 出中文或英文 / the form follows Accept-Language', async () => {
  const { competition } = await makeCompetition();

  const zh = await (await http.get(`/c/${competition.slug}`, { headers: { 'Accept-Language': 'zh-TW' } })).text();
  const en = await (await http.get(`/c/${competition.slug}`, { headers: { 'Accept-Language': 'en-US,en' } })).text();

  assert.ok(zh.includes('報名'));
  assert.ok(en.includes('Sign in'));
  assert.ok(!en.includes('報名組別'));
});

test('線上報名會開單、帶夥伴 ID、且還沒付款 / an online entry opens an order and stays unpaid', async () => {
  const { competition, divisions } = await makeCompetition();

  const who = await makeEntrant();

  const res = await http.postForm(`/c/${competition.slug}/register`, {
    unitName: 'Sunrise Dance',
    athleteIds: [String(who.athletes[0].id)],
    divisionId: divisions[0].id,
    provider: 'ecpay',
  }, { headers: { Cookie: who.cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('payment-stage.ecpay.com.tw'), 'the user is posted to the ECPay sandbox');
  assert.ok(html.includes('CheckMacValue'));

  const list = await regs.listRegistrations(competition.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'pending', 'no money has arrived yet');
  assert.equal(list[0].amount_cents, 1200);

  const payment = await one('SELECT * FROM payments WHERE registration_id = $1', [list[0].id]);
  assert.equal(payment.provider, 'ecpay');
  assert.equal(payment.status, 'created');
  assert.equal(payment.sandbox, true);
  assert.equal(payment.partner_id_sent, null, 'ECPay platform id stays blank until contracted');
});

test('表單擋掉缺漏、別人的選手與不存在的組別 / the form rejects missing, borrowed and invalid input', async () => {
  const { competition, divisions } = await makeCompetition();
  const who = await makeEntrant();
  const stranger = await makeEntrant({ email: 'other@example.com', people: [{ name: 'Not Mine', birthDate: '2010-01-01' }] });

  const noOne = await http.postForm(`/c/${competition.slug}/register`, {
    divisionId: divisions[0].id,
    provider: 'ecpay',
  }, { headers: { Cookie: who.cookie } });
  assert.equal(noOne.status, 400, 'nobody ticked');

  const badDivision = await http.postForm(`/c/${competition.slug}/register`, {
    athleteIds: [String(who.athletes[0].id)],
    divisionId: '999999',
    provider: 'ecpay',
  }, { headers: { Cookie: who.cookie } });
  assert.equal(badDivision.status, 400);

  // 別人名冊裡的選手不可以拿來報名，就算知道編號也一樣。
  // Someone else's roster cannot be entered, even when the id is known.
  const borrowed = await http.postForm(`/c/${competition.slug}/register`, {
    athleteIds: [String(stranger.athletes[0].id)],
    divisionId: divisions[0].id,
    provider: 'ecpay',
  }, { headers: { Cookie: who.cookie } });
  assert.equal(borrowed.status, 400);

  const notSignedIn = await http.postForm(`/c/${competition.slug}/register`, {
    athleteIds: [String(who.athletes[0].id)],
    divisionId: divisions[0].id,
    provider: 'ecpay',
  });
  assert.equal(notSignedIn.status, 400, 'entering without signing in is refused');

  assert.equal((await regs.listRegistrations(competition.id)).length, 0);
});

test('報名截止後不能再報名 / registration is refused once closed', async () => {
  const { competition, divisions } = await makeCompetition({ status: 'closed' });
  const who = await makeEntrant();
  const res = await http.postForm(`/c/${competition.slug}/register`, {
    athleteIds: [String(who.athletes[0].id)],
    divisionId: divisions[0].id,
    provider: 'ecpay',
  }, { headers: { Cookie: who.cookie } });
  assert.equal(res.status, 400);
  assert.equal((await regs.listRegistrations(competition.id)).length, 0);
});

test('免費比賽直接完成，不必選付款方式 / a free competition settles immediately', async () => {
  const { competition, divisions } = await makeCompetition({ feeCents: 0 });

  const who = await makeEntrant();
  const res = await http.postForm(`/c/${competition.slug}/register`, {
    athleteIds: [String(who.athletes[0].id)],
    divisionId: divisions[0].id,
  }, { headers: { Cookie: who.cookie } });
  assert.equal(res.status, 303);

  const list = await regs.listRegistrations(competition.id);
  assert.equal(list[0].status, 'paid');
  assert.equal(list[0].paid_source, 'free');
  const payment = await one('SELECT * FROM payments WHERE registration_id = $1', [list[0].id]);
  assert.equal(payment, null, 'a free entry never touches a payment provider');
});

test('金流通知驗章過才轉成已付款 / a verified callback is what turns an entry paid', async () => {
  const { competition, divisions } = await makeCompetition();
  const who = await makeEntrant();
  await http.postForm(`/c/${competition.slug}/register`, {
    athleteIds: [String(who.athletes[0].id)],
    divisionId: divisions[0].id,
    provider: 'ecpay',
  }, { headers: { Cookie: who.cookie } });

  const registration = (await regs.listRegistrations(competition.id))[0];
  const payment = await one('SELECT * FROM payments WHERE registration_id = $1', [registration.id]);
  const settings = paymentsLayer.settingsFor('ecpay');

  const body = {
    MerchantID: settings.merchantId,
    MerchantTradeNo: payment.provider_order_id,
    RtnCode: '1',
    RtnMsg: 'Succeeded',
    TradeNo: '2609220000042',
    TradeAmt: '1200',
  };
  body.CheckMacValue = ecpay.checkMacValue(body, settings.hashKey, settings.hashIv);

  const ok = await http.postForm('/pay/ecpay/notify', body);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '1|OK');

  const after = await regs.getRegistration(registration.id);
  assert.equal(after.status, 'paid');
  assert.equal(after.paid_source, 'online');
});

test('偽造的通知會被擋下來 / a forged callback changes nothing', async () => {
  const { competition, divisions } = await makeCompetition();
  const who = await makeEntrant();
  await http.postForm(`/c/${competition.slug}/register`, {
    athleteIds: [String(who.athletes[0].id)],
    divisionId: divisions[0].id,
    provider: 'ecpay',
  }, { headers: { Cookie: who.cookie } });
  const registration = (await regs.listRegistrations(competition.id))[0];
  const payment = await one('SELECT * FROM payments WHERE registration_id = $1', [registration.id]);

  const forged = await http.postForm('/pay/ecpay/notify', {
    MerchantTradeNo: payment.provider_order_id,
    RtnCode: '1',
    TradeAmt: '1200',
    CheckMacValue: 'F'.repeat(64),
  });
  assert.equal(forged.status, 400);
  assert.equal((await regs.getRegistration(registration.id)).status, 'pending');
});

test('金額對不上就不算付款 / a mismatched amount is refused', async () => {
  const { competition, divisions } = await makeCompetition();
  const who = await makeEntrant();
  await http.postForm(`/c/${competition.slug}/register`, {
    athleteIds: [String(who.athletes[0].id)],
    divisionId: divisions[0].id,
    provider: 'ecpay',
  }, { headers: { Cookie: who.cookie } });
  const registration = (await regs.listRegistrations(competition.id))[0];
  const payment = await one('SELECT * FROM payments WHERE registration_id = $1', [registration.id]);
  const settings = paymentsLayer.settingsFor('ecpay');

  const body = {
    MerchantID: settings.merchantId,
    MerchantTradeNo: payment.provider_order_id,
    RtnCode: '1',
    TradeNo: 'X1',
    TradeAmt: '1', // 驗章是對的，但金額被改小了 / correctly signed, but the amount is wrong
  };
  body.CheckMacValue = ecpay.checkMacValue(body, settings.hashKey, settings.hashIv);

  const res = await http.postForm('/pay/ecpay/notify', body);
  assert.equal(res.status, 400);
  assert.equal((await regs.getRegistration(registration.id)).status, 'pending');
});

test('重送的通知不會重複計算 / a retried callback is idempotent', async () => {
  const { competition, divisions } = await makeCompetition();
  const who = await makeEntrant();
  await http.postForm(`/c/${competition.slug}/register`, {
    athleteIds: [String(who.athletes[0].id)],
    divisionId: divisions[0].id,
    provider: 'ecpay',
  }, { headers: { Cookie: who.cookie } });
  const registration = (await regs.listRegistrations(competition.id))[0];
  const payment = await one('SELECT * FROM payments WHERE registration_id = $1', [registration.id]);
  const settings = paymentsLayer.settingsFor('ecpay');
  const body = {
    MerchantID: settings.merchantId,
    MerchantTradeNo: payment.provider_order_id,
    RtnCode: '1',
    TradeNo: 'X2',
    TradeAmt: '1200',
  };
  body.CheckMacValue = ecpay.checkMacValue(body, settings.hashKey, settings.hashIv);

  await http.postForm('/pay/ecpay/notify', body);
  const second = await http.postForm('/pay/ecpay/notify', body);
  assert.equal(second.status, 200);

  const paidCount = await one(
    `SELECT COUNT(*)::int AS n FROM payments WHERE registration_id = $1 AND status = 'paid'`,
    [registration.id],
  );
  assert.equal(paidCount.n, 1);
});

test('結束報名產生憑證碼，只收已付款的人 / closing registration issues a voucher over paid entries only', async () => {
  const { competition, divisions } = await makeCompetition();

  const paid = await regs.register({
    competitionId: competition.id,
    divisionId: divisions[0].id,
    athleteName: 'Paid One',
    provider: 'ecpay',
  });
  await regs.markPaidManually(paid.registration.id);

  await regs.register({
    competitionId: competition.id,
    divisionId: divisions[1].id,
    athleteName: 'Unpaid One',
    provider: 'ecpay',
  });

  const { voucher: issued, entries } = await voucher.settle(competition.id);

  assert.match(issued.code, /^SR(-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}){4}$/);
  assert.equal(issued.entry_count, 1);
  assert.equal(Number(issued.total_cents), 1200);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].athlete_name, 'Paid One');

  const after = await comps.getCompetition(competition.id);
  assert.equal(after.status, 'closed');
});

test('沒有憑證碼，後續模組就不能作業 / later modules refuse to run without a voucher', async () => {
  await assert.rejects(() => voucher.requireVoucher(null), (err) => err.key === 'admin.voucherNone');
  await assert.rejects(() => voucher.requireVoucher('SR-AAAAAA-BBBBBB-CCCCCC-DDDDDD'), (err) => err.key === 'admin.voucherNone');
});

test('憑證碼可以讀出它綁的那份名單 / a voucher reads back exactly its own roster', async () => {
  const { competition, divisions } = await makeCompetition({ feeCents: 0 });
  for (const name of ['A One', 'B Two', 'C Three']) {
    await regs.register({ competitionId: competition.id, divisionId: divisions[0].id, athleteName: name });
  }
  const { voucher: issued } = await voucher.settle(competition.id);
  const { entries } = await voucher.rosterFor(issued.code);
  assert.deepEqual(entries.map((e) => e.athlete_name), ['A One', 'B Two', 'C Three']);
});

test('重新結算會換新碼、舊碼立刻失效 / re-settling issues a new code and kills the old one', async () => {
  const { competition, divisions } = await makeCompetition({ feeCents: 0 });
  await regs.register({ competitionId: competition.id, divisionId: divisions[0].id, athleteName: 'First' });

  const first = (await voucher.settle(competition.id)).voucher;
  assert.equal(first.entry_count, 1);

  // 補報名一位（比賽已結算，所以先開回報名中）
  // A late entry: reopen, register, then re-settle.
  await comps.setStatus(competition.id, 'open');
  await regs.register({ competitionId: competition.id, divisionId: divisions[0].id, athleteName: 'Late' });

  const second = (await voucher.settle(competition.id, { resettle: true })).voucher;
  assert.notEqual(second.code, first.code);
  assert.equal(second.entry_count, 2);

  await assert.rejects(() => voucher.requireVoucher(first.code), (err) => err.key === 'admin.voucherRevoked');
  const stillGood = await voucher.requireVoucher(second.code);
  assert.equal(stillGood.code, second.code);
});

test('開始評分之後不能重新結算 / once judging starts, re-settling is refused', async () => {
  const { competition, divisions } = await makeCompetition({ feeCents: 0 });
  await regs.register({ competitionId: competition.id, divisionId: divisions[0].id, athleteName: 'Only' });
  const first = (await voucher.settle(competition.id)).voucher;

  await comps.markScoringStarted(competition.id);

  await assert.rejects(
    () => voucher.settle(competition.id, { resettle: true }),
    (err) => err.key === 'admin.cannotResettle',
  );
  const unchanged = await voucher.requireVoucher(first.code);
  assert.equal(unchanged.code, first.code, 'the original voucher is untouched');
});

test('統計回報不含個資、不含金鑰 / the usage report carries no competitor data and no keys', async () => {
  const { competition, divisions } = await makeCompetition({ feeCents: 0 });
  await regs.register({ competitionId: competition.id, divisionId: divisions[0].id, athleteName: 'Chen Mei-ling' });
  const settled = await voucher.settle(competition.id);

  const payload = stats.buildPayload({
    competition: await comps.getCompetition(competition.id),
    byProvider: settled.byProvider,
    voucher: settled.voucher,
  });
  const text = JSON.stringify(payload);

  assert.ok(!text.includes('Chen Mei-ling'), 'no competitor names');
  assert.ok(!text.includes('Test Cup 2026'), 'not even the competition name');
  assert.ok(!text.includes('pwFHCqoQZGmho4w6'), 'no ECPay hash key');
  assert.ok(!text.includes('rk_test_'), 'no Stripe key');
  assert.ok(!text.includes('test-client-secret'), 'no PayPal secret');
  assert.equal(payload.competition.entry_count, 1);
  assert.equal(payload.schema, 'stagerank.usage.v1');
});

test('後台要通行碼，答對才進得去 / the back office needs the passcode', async () => {
  const guarded = await http.get('/admin');
  assert.ok((await guarded.text()).includes('name="token"'), 'an unauthenticated visitor sees the login form');

  const wrong = await http.postForm('/admin/login', { token: 'nope' });
  assert.equal(wrong.status, 401);

  const right = await http.postForm('/admin/login', { token: 'test-admin-token' });
  assert.equal(right.status, 303);
  const cookie = right.headers.get('set-cookie').split(';')[0];

  const inside = await http.get('/admin', { headers: { cookie } });
  const html = await inside.text();
  assert.ok(!html.includes('name="token"'));
  assert.ok(html.includes('StageRank') || html.includes('ECPay') || html.includes('綠界'));
});

test('後台可以標記現場收款並結算出憑證碼 / the back office can settle a cash entry end to end', async () => {
  const { competition, divisions } = await makeCompetition();
  await regs.register({
    competitionId: competition.id,
    divisionId: divisions[0].id,
    athleteName: 'Cash Payer',
    provider: 'ecpay',
  });
  const registration = (await regs.listRegistrations(competition.id))[0];

  const login = await http.postForm('/admin/login', { token: 'test-admin-token' });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const marked = await http.postForm(
    `/admin/r/${registration.id}/mark-paid`,
    { competitionId: competition.id },
    { headers: { cookie } },
  );
  assert.equal(marked.status, 303);
  const afterMark = await regs.getRegistration(registration.id);
  assert.equal(afterMark.status, 'paid');
  assert.equal(afterMark.paid_source, 'manual', 'cash never counts as an online payment');

  const settled = await http.postForm(`/admin/c/${competition.id}/settle`, {}, { headers: { cookie } });
  assert.equal(settled.status, 200);
  const active = await voucher.activeVoucher(competition.id);
  assert.equal(active.entry_count, 1);
  assert.ok((await settled.text()).includes(active.code), 'the organiser can see the code on screen');
});

test('頁尾標示預設出現在每一頁 / the footer credit is on by default on every page', async () => {
  const { competition } = await makeCompetition();
  for (const path of ['/', `/c/${competition.slug}`, '/admin']) {
    const html = await (await http.get(path)).text();
    assert.ok(html.includes('StageRank'), `${path} carries the credit`);
    assert.ok(html.includes('github.com/alvanchao/stagerank'), `${path} links back to the project`);
  }
});
