// PayPal 與 Stripe 的兩步流程：建訂單 → 使用者付款回來 → 向對方查證再標記已付款。
// 全部用假的 fetch，不連外網；重點是「對方沒說成功，就絕不算付款」。
// The two-step flow for PayPal and Stripe: create the order, the payer returns, verify with the provider,
// then mark paid. Everything runs on a fake fetch; the point is that without the provider's "yes"
// nothing is ever marked paid.
import { resetDatabase, makeEntrant, startServer } from './helpers.js';
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const onlinePay = await import('../src/services/onlinePay.js');
const paypal = (await import('../src/payments/paypal.js')).default;
const stripe = (await import('../src/payments/stripe.js')).default;
const payments = await import('../src/payments/index.js');
const config = (await import('../src/config.js')).default;
const { createApp } = await import('../src/app.js');
const { query, closePool } = await import('../src/db/index.js');

before(resetDatabase);
beforeEach(resetDatabase);
after(closePool);

async function enter(provider) {
  const competition = await comps.createCompetition({ name: 'Online Cup', feeCents: 1200, status: 'open', currency: 'TWD' });
  const division = await comps.addDivision({
    competitionId: competition.id, name: 'Solo', sortOrder: 1, memberMin: 1, memberMax: 1,
  });
  const me = await makeEntrant();
  const result = await regs.register({
    competitionId: competition.id, divisionId: division.id,
    athleteIds: [me.athletes[0].id], entrantId: me.entrant.id, provider,
  });
  return { competition, result, me };
}

// 一個記下所有呼叫的假 fetch；handlers 依網址片段決定回什麼。
// A fake fetch that records every call; handlers pick the reply by URL fragment.
function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    for (const [fragment, reply] of Object.entries(handlers)) {
      if (String(url).includes(fragment)) {
        const { status = 200, json = {} } = typeof reply === 'function' ? reply(options) : reply;
        return { ok: status >= 200 && status < 300, status, json: async () => json };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

const paypalHandlers = (capture = {}) => ({
  '/v1/oauth2/token': { json: { access_token: 'TOKEN123' } },
  '/v2/checkout/orders/PPORDER1/capture': {
    json: {
      status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { value: '1200', currency_code: 'TWD' } }] } }],
      ...capture,
    },
  },
  '/v2/checkout/orders': {
    json: { id: 'PPORDER1', links: [{ rel: 'payer-action', href: 'https://sandbox.paypal.test/approve?token=PPORDER1' }] },
  },
});

test('PayPal：建訂單帶著 BN code，回傳核准網址 / PayPal order carries the BN code and returns the approval URL', async () => {
  const { result } = await enter('paypal');
  const fetchImpl = fakeFetch(paypalHandlers());

  const url = await onlinePay.startApi({ provider: 'paypal', checkout: result.checkout, fetchImpl });
  assert.equal(url, 'https://sandbox.paypal.test/approve?token=PPORDER1');

  const order = fetchImpl.calls.find((c) => c.url.endsWith('/v2/checkout/orders'));
  assert.equal(order.options.headers.Authorization, 'Bearer TOKEN123');
  assert.equal(order.options.headers['PayPal-Partner-Attribution-Id'], 'StageRank_Cart_PPCP');
  const body = JSON.parse(order.options.body);
  assert.equal(body.purchase_units[0].amount.value, '1200');
  assert.match(body.application_context.return_url, /\/pay\/paypal\/return\/\d+$/);

  const { rows } = await query(`SELECT * FROM payments WHERE provider = 'paypal'`);
  assert.equal(rows[0].provider_txn_id, 'PPORDER1', "PayPal's own order id is remembered");
  assert.equal(rows[0].status, 'created', 'nothing is paid yet');
});

test('PayPal：核准後請款成功才算付款 / paid only after PayPal captures', async () => {
  const { result } = await enter('paypal');
  const fetchImpl = fakeFetch(paypalHandlers());
  await onlinePay.startApi({ provider: 'paypal', checkout: result.checkout, fetchImpl });

  const done = await onlinePay.finishReturn({ provider: 'paypal', registrationId: result.registration.id, fetchImpl });
  assert.equal(done.ok, true);
  assert.equal(done.paid, true);

  const registration = await regs.getRegistration(result.registration.id);
  assert.equal(registration.status, 'paid');
  const capture = fetchImpl.calls.find((c) => c.url.includes('/capture'));
  assert.equal(capture.options.headers['PayPal-Partner-Attribution-Id'], 'StageRank_Cart_PPCP', 'capture carries the BN code too');

  // 同一個回程網址被重複打開：直接說已付款，不會再請一次款。
  // Opening the return URL again must not capture twice.
  const before = fetchImpl.calls.length;
  const again = await onlinePay.finishReturn({ provider: 'paypal', registrationId: result.registration.id, fetchImpl });
  assert.equal(again.alreadyPaid, true);
  assert.equal(fetchImpl.calls.length, before, 'no second call to PayPal');
});

test('PayPal：使用者取消或沒核准就不算付款 / cancelled or unapproved is never paid', async () => {
  const { result } = await enter('paypal');
  // 先列的先比對，所以覆蓋用的放最前面。
  // Handlers match in order, so the override goes first.
  const fetchImpl = fakeFetch({
    '/capture': { status: 422, json: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] } },
    ...paypalHandlers(),
  });
  await onlinePay.startApi({ provider: 'paypal', checkout: result.checkout, fetchImpl });

  const done = await onlinePay.finishReturn({ provider: 'paypal', registrationId: result.registration.id, fetchImpl });
  assert.equal(done.paid, false);
  assert.equal((await regs.getRegistration(result.registration.id)).status, 'pending');
});

test('PayPal：金額對不上就不算付款 / a mismatched amount is refused', async () => {
  const { result } = await enter('paypal');
  const fetchImpl = fakeFetch(paypalHandlers({
    purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { value: '1', currency_code: 'TWD' } }] } }],
  }));
  await onlinePay.startApi({ provider: 'paypal', checkout: result.checkout, fetchImpl });

  const done = await onlinePay.finishReturn({ provider: 'paypal', registrationId: result.registration.id, fetchImpl });
  assert.equal(done.ok, false);
  assert.equal(done.reason, 'amount_mismatch');
  assert.equal((await regs.getRegistration(result.registration.id)).status, 'pending');
});

test('建立訂單失敗：報名保留、付款標失敗、不丟 500 / a failed start keeps the registration and marks the payment failed', async () => {
  const { result } = await enter('paypal');
  const fetchImpl = fakeFetch({ '/v1/oauth2/token': { status: 401, json: { error: 'invalid_client' } } });
  await assert.rejects(
    () => onlinePay.startApi({ provider: 'paypal', checkout: result.checkout, fetchImpl }),
    onlinePay.PaymentStartError,
  );
  const { rows } = await query(`SELECT status FROM payments WHERE provider = 'paypal'`);
  assert.equal(rows[0].status, 'failed');
  assert.equal((await regs.getRegistration(result.registration.id)).status, 'pending');
});

test('Stripe：建結帳頁、回程查證 / Stripe session is created and verified on return', async () => {
  const { result } = await enter('stripe');
  const fetchImpl = fakeFetch({
    '/v1/checkout/sessions/cs_test_1': {
      json: { id: 'cs_test_1', status: 'complete', payment_status: 'paid', amount_total: 120000, currency: 'twd', payment_intent: 'pi_1' },
    },
    '/v1/checkout/sessions': { json: { id: 'cs_test_1', url: 'https://checkout.stripe.test/c/pay/cs_test_1' } },
  });

  const url = await onlinePay.startApi({ provider: 'stripe', checkout: result.checkout, fetchImpl });
  assert.equal(url, 'https://checkout.stripe.test/c/pay/cs_test_1');
  const created = fetchImpl.calls[0];
  assert.match(created.options.headers.Authorization, /^Bearer rk_test_/);
  const sent = Object.fromEntries(new URLSearchParams(created.options.body));
  assert.equal(sent['line_items[0][price_data][unit_amount]'], '120000', 'NT$1200 goes out as 120000');
  assert.match(sent.success_url, /\/pay\/stripe\/return\/\d+$/);

  const done = await onlinePay.finishReturn({ provider: 'stripe', registrationId: result.registration.id, fetchImpl });
  assert.equal(done.paid, true, 'the 120000 that comes back is read as NT$1200 and matches');
  assert.equal((await regs.getRegistration(result.registration.id)).status, 'paid');
});

test('Stripe：沒付款（unpaid）就不算 / an unpaid Stripe session is not paid', async () => {
  const { result } = await enter('stripe');
  const fetchImpl = fakeFetch({
    '/v1/checkout/sessions/cs_test_2': { json: { id: 'cs_test_2', status: 'open', payment_status: 'unpaid', amount_total: 120000, currency: 'twd' } },
    '/v1/checkout/sessions': { json: { id: 'cs_test_2', url: 'https://checkout.stripe.test/c/pay/cs_test_2' } },
  });
  await onlinePay.startApi({ provider: 'stripe', checkout: result.checkout, fetchImpl });
  const done = await onlinePay.finishReturn({ provider: 'stripe', registrationId: result.registration.id, fetchImpl });
  assert.equal(done.paid, false);
  assert.equal((await regs.getRegistration(result.registration.id)).status, 'pending');
});

test('Stripe 金額換算 / Stripe amount conversion', () => {
  assert.equal(stripe.unitAmount(1200, 'TWD'), 120000);
  assert.equal(stripe.fromUnitAmount(120000, 'twd'), 1200);
  assert.equal(stripe.unitAmount(1200, 'USD'), 1200, 'USD cents pass through');
  assert.equal(stripe.unitAmount(1200, 'JPY'), 1200, 'JPY is truly zero-decimal');
  assert.equal(paypal.parseAmount('1200', 'TWD'), 1200);
  assert.equal(paypal.parseAmount('12.34', 'USD'), 1234);
});

test('PayPal webhook：沒設 webhook ID 一律不採信，設了要 PayPal 說 SUCCESS / webhook is trusted only when PayPal says SUCCESS', async () => {
  const settings = { ...payments.settingsFor('paypal'), webhookId: '' };
  const body = { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id: 'X', id: 'C', status: 'COMPLETED' } };
  const headers = { 'paypal-transmission-id': 't', 'paypal-transmission-sig': 's', 'paypal-transmission-time': 'now', 'paypal-cert-url': 'u', 'paypal-auth-algo': 'a' };

  assert.equal(await paypal.verifyRemote({ body, headers, settings, fetchImpl: fakeFetch({}) }), false, 'no webhook id: never trusted');

  const withId = { ...settings, webhookId: 'WH-1' };
  const ok = fakeFetch({
    '/v1/oauth2/token': { json: { access_token: 'T' } },
    '/verify-webhook-signature': { json: { verification_status: 'SUCCESS' } },
  });
  assert.equal(await paypal.verifyRemote({ body, headers, settings: withId, fetchImpl: ok }), true);
  const sentBody = JSON.parse(ok.calls.at(-1).options.body);
  assert.equal(sentBody.webhook_id, 'WH-1');
  assert.deepEqual(sentBody.webhook_event, body, 'the event goes to PayPal untouched');

  const fail = fakeFetch({
    '/v1/oauth2/token': { json: { access_token: 'T' } },
    '/verify-webhook-signature': { json: { verification_status: 'FAILURE' } },
  });
  assert.equal(await paypal.verifyRemote({ body, headers, settings: withId, fetchImpl: fail }), false);

  // 只有「款項入帳」才算付款，「使用者按了同意」不算。
  // Only "capture completed" counts, not "the payer said yes".
  assert.equal(paypal.verifyCallback({ body }).paid, true);
  assert.equal(paypal.verifyCallback({ body: { ...body, event_type: 'CHECKOUT.ORDER.APPROVED' } }).paid, false);
});

test('網址層：回程網址向 PayPal 查證後導回報名頁 / the return URL verifies then redirects, over real HTTP', async () => {
  const { result } = await enter('paypal');
  const provider = fakeFetch(paypalHandlers());
  await onlinePay.startApi({ provider: 'paypal', checkout: result.checkout, fetchImpl: provider });

  const server = await startServer(createApp());
  // 只把打往 PayPal 的呼叫換成假的，測試自己打伺服器的照舊。
  // Only calls to PayPal are faked; the test's own calls to the server stay real.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => (String(url).includes('paypal.com') ? provider(url, options) : realFetch(url, options));
  try {
    const res = await server.get(`/pay/paypal/return/${result.registration.id}?token=IGNORED&PayerID=X`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/r/${result.registration.id}`);
    assert.equal((await regs.getRegistration(result.registration.id)).status, 'paid');

    const junk = await server.get('/pay/ecpay/return/1');
    assert.equal(junk.headers.get('location'), '/', 'form-style providers have no return route');
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }
});

test('config 有 webhookId 欄位 / config exposes the optional webhook id', () => {
  assert.equal(typeof config.payments.paypal.webhookId, 'string');
});
