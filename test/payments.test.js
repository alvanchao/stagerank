import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import config from '../src/config.js';
import * as payments from '../src/payments/index.js';
import { BUILT_IN, partnerIds, partnerIdFor } from '../src/payments/partner.js';
import ecpay from '../src/payments/ecpay.js';
import newebpay from '../src/payments/newebpay.js';
import paypal from '../src/payments/paypal.js';
import stripe from '../src/payments/stripe.js';

const order = {
  providerOrderId: 'SRTEST0001',
  amountCents: 1200,
  currency: 'TWD',
  itemName: 'Test Cup / U15 Latin',
  description: 'Test Cup',
  email: 'dancer@example.com',
  siteName: 'Test Cup',
};
const urls = {
  notifyUrl: 'https://example.org/pay/x/notify',
  returnUrl: 'https://example.org/r/1',
  cancelUrl: 'https://example.org/r/1',
};

test('四家轉接頭都在，介面一致 / all four adapters are registered with the same shape', () => {
  assert.deepEqual(Object.keys(payments.ADAPTERS).sort(), ['ecpay', 'newebpay', 'paypal', 'stripe']);
  for (const [name, adapter] of Object.entries(payments.ADAPTERS)) {
    assert.equal(typeof adapter.isConfigured, 'function', `${name}.isConfigured`);
    assert.equal(typeof adapter.createCheckout, 'function', `${name}.createCheckout`);
    assert.equal(typeof adapter.verifyCallback, 'function', `${name}.verifyCallback`);
  }
});

test('金鑰填齊才會出現在報名頁 / a provider only appears once its keys are complete', () => {
  assert.deepEqual(payments.availableProviders().sort(), ['ecpay', 'newebpay', 'paypal', 'stripe']);
  assert.equal(ecpay.isConfigured({ merchantId: 'x', hashKey: 'y', hashIv: '' }), false);
  assert.equal(newebpay.isConfigured({ merchantId: 'x', hashKey: '', hashIv: 'z' }), false);
  assert.equal(paypal.isConfigured({ clientId: 'x' }), false);
  assert.equal(stripe.isConfigured({ restrictedKey: '' }), false);
});

test('綠界、藍新的平台商代號預設留空 / ECPay and NewebPay platform IDs default to blank', () => {
  assert.equal(BUILT_IN.ecpayPlatformId, '');
  assert.equal(BUILT_IN.newebpayPartnerId, '');
  assert.equal(partnerIdFor('ecpay'), null);
  assert.equal(partnerIdFor('newebpay'), null);

  const checkout = ecpay.createCheckout({ order, urls, settings: payments.settingsFor('ecpay') });
  assert.ok(!('PlatformID' in checkout.fields), 'the field must be omitted entirely, not sent empty');
  assert.equal(checkout.partnerIdSent, null);

  const neweb = newebpay.createCheckout({ order, urls, settings: payments.settingsFor('newebpay') });
  assert.ok(!('PartnerID' in neweb.fields));
  assert.equal(neweb.partnerIdSent, null);
});

test('PayPal 與 Stripe 一定帶我們的歸因 / PayPal and Stripe always carry our attribution', () => {
  const pp = paypal.createCheckout({ order, urls, settings: payments.settingsFor('paypal') });
  assert.equal(pp.headers['PayPal-Partner-Attribution-Id'], BUILT_IN.paypalBnCode);
  assert.equal(pp.partnerIdSent, BUILT_IN.paypalBnCode);

  const st = stripe.createCheckout({ order, urls, settings: payments.settingsFor('stripe') });
  const appInfo = JSON.parse(st.headers['X-Stripe-Client-User-Agent']);
  assert.equal(appInfo.application.name, 'StageRank');
  assert.equal(appInfo.application.url, BUILT_IN.appUrl);
  assert.match(st.headers['User-Agent'], /^StageRank\//);
});

test('夥伴 ID 可以被主機設定覆蓋，空字串不算 / host settings may override, blank never counts', () => {
  const original = { ...config.payments.partnerDefaults };
  try {
    config.payments.partnerDefaults.paypalBnCode = '   ';
    assert.equal(partnerIds().paypalBnCode, BUILT_IN.paypalBnCode, 'blank falls back to the built-in default');

    config.payments.partnerDefaults.paypalBnCode = 'Custom_BN_Code';
    assert.equal(partnerIdFor('paypal'), 'Custom_BN_Code');

    config.payments.partnerDefaults.ecpayPlatformId = '3002599';
    const checkout = ecpay.createCheckout({ order, urls, settings: payments.settingsFor('ecpay') });
    assert.equal(checkout.fields.PlatformID, '3002599', 'once contracted, the field is sent');
    assert.equal(checkout.partnerIdSent, '3002599');
  } finally {
    Object.assign(config.payments.partnerDefaults, original);
  }
});

test('綠界檢查碼：有算、會變、大寫十六進位 / ECPay MAC is computed, deterministic and sensitive', () => {
  const settings = payments.settingsFor('ecpay');
  const a = ecpay.createCheckout({ order, urls, settings, now: new Date('2026-09-22T01:00:00Z') });
  const b = ecpay.createCheckout({ order, urls, settings, now: new Date('2026-09-22T01:00:00Z') });
  assert.equal(a.fields.CheckMacValue, b.fields.CheckMacValue, 'same input, same MAC');
  assert.match(a.fields.CheckMacValue, /^[0-9A-F]{64}$/);

  const changed = ecpay.checkMacValue({ ...a.fields, TotalAmount: '9999' }, settings.hashKey, settings.hashIv);
  assert.notEqual(changed, a.fields.CheckMacValue, 'changing the amount must change the MAC');
});

test('綠界的 .NET UrlEncode 特例 / ECPay .NET UrlEncode special cases', () => {
  assert.equal(ecpay.dotNetUrlEncode('a b'), 'a+b');
  assert.equal(ecpay.dotNetUrlEncode('a-b_c.d!e*f(g)h'), 'a-b_c.d!e*f(g)h');
  assert.equal(ecpay.dotNetUrlEncode('https://x.tw/a?b=c'), 'https%3a%2f%2fx.tw%2fa%3fb%3dc');
});

test('綠界通知：驗章過才算付款 / ECPay callback only counts when the MAC checks out', () => {
  const settings = payments.settingsFor('ecpay');
  const body = {
    MerchantID: settings.merchantId,
    MerchantTradeNo: 'SRTEST0001',
    RtnCode: '1',
    RtnMsg: 'Succeeded',
    TradeNo: '2609220000001',
    TradeAmt: '1200',
    PaymentDate: '2026/09/22 09:00:00',
  };
  body.CheckMacValue = ecpay.checkMacValue(body, settings.hashKey, settings.hashIv);

  const good = ecpay.verifyCallback({ body, settings });
  assert.equal(good.valid, true);
  assert.equal(good.paid, true);
  assert.equal(good.providerOrderId, 'SRTEST0001');
  assert.equal(good.amountCents, 1200);

  const tampered = ecpay.verifyCallback({ body: { ...body, TradeAmt: '1' }, settings });
  assert.equal(tampered.valid, false, 'a forged amount must fail verification');
  assert.equal(tampered.paid, false);

  const failed = { ...body, RtnCode: '10100248' };
  failed.CheckMacValue = ecpay.checkMacValue(failed, settings.hashKey, settings.hashIv);
  const failedResult = ecpay.verifyCallback({ body: failed, settings });
  assert.equal(failedResult.valid, true);
  assert.equal(failedResult.paid, false, 'a valid signature on a failed payment is still not paid');
});

test('藍新：加密解密可以來回，驗章會擋篡改 / NewebPay encrypt-decrypt round trips and rejects tampering', () => {
  const settings = payments.settingsFor('newebpay');
  const checkout = newebpay.createCheckout({ order, urls, settings, now: new Date('2026-09-22T01:00:00Z') });
  assert.match(checkout.fields.TradeInfo, /^[0-9a-f]+$/);
  assert.match(checkout.fields.TradeSha, /^[0-9A-F]{64}$/);

  const plain = newebpay.decryptTradeInfo(checkout.fields.TradeInfo, settings.hashKey, settings.hashIv);
  const parsed = Object.fromEntries(new URLSearchParams(plain));
  assert.equal(parsed.MerchantOrderNo, 'SRTEST0001');
  assert.equal(parsed.Amt, '1200');
  assert.equal(parsed.MerchantID, settings.merchantId);

  const payload = JSON.stringify({
    Status: 'SUCCESS',
    Message: 'ok',
    Result: { MerchantOrderNo: 'SRTEST0001', TradeNo: 'NB260922', Amt: 1200 },
  });
  const tradeInfo = newebpay.encryptTradeInfo(payload, settings.hashKey, settings.hashIv);
  const tradeSha = newebpay.tradeSha(tradeInfo, settings.hashKey, settings.hashIv);

  const good = newebpay.verifyCallback({ body: { TradeInfo: tradeInfo, TradeSha: tradeSha }, settings });
  assert.equal(good.valid, true);
  assert.equal(good.paid, true);
  assert.equal(good.providerOrderId, 'SRTEST0001');
  assert.equal(good.amountCents, 1200);

  const bad = newebpay.verifyCallback({ body: { TradeInfo: tradeInfo, TradeSha: 'DEADBEEF' }, settings });
  assert.equal(bad.valid, false);
});

test('PayPal 金額換算：TWD 不除以 100 / PayPal amounts respect zero-decimal currencies', () => {
  assert.equal(paypal.formatAmount(1200, 'TWD'), '1200');
  assert.equal(paypal.formatAmount(1200, 'USD'), '12.00');
  const request = paypal.createCheckout({ order, urls, settings: payments.settingsFor('paypal') });
  assert.equal(request.body.purchase_units[0].amount.value, '1200');
  assert.equal(request.body.purchase_units[0].amount.currency_code, 'TWD');
});

test('PayPal webhook 沒驗簽就不算付款 / an unverified PayPal webhook is never paid', () => {
  const result = paypal.verifyCallback({
    body: { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id: 'SRTEST0001', id: 'CAP1' } },
  });
  assert.equal(result.valid, false);
  assert.equal(result.needsRemoteVerification, true);
});

test('Stripe：受限金鑰與驗簽 / Stripe uses a restricted key and verifies signatures', () => {
  assert.equal(stripe.isRestrictedKey('rk_test_abc'), true);
  assert.equal(stripe.isRestrictedKey('sk_test_abc'), false);

  const settings = payments.settingsFor('stripe');
  const checkout = stripe.createCheckout({ order, urls, settings });
  assert.match(checkout.headers.Authorization, /^Bearer rk_test_/);
  const sent = Object.fromEntries(new URLSearchParams(checkout.body));
  assert.equal(sent['line_items[0][price_data][unit_amount]'], '1200', 'TWD must not be divided by 100');
  assert.equal(sent['line_items[0][price_data][currency]'], 'twd');
  assert.equal(sent.client_reference_id, 'SRTEST0001');

  const payload = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: 'SRTEST0001', payment_status: 'paid', amount_total: 1200, payment_intent: 'pi_1' } },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', settings.webhookSecret)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex');

  const good = stripe.verifyCallback({
    body: JSON.parse(payload),
    rawBody: payload,
    headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
    settings,
  });
  assert.equal(good.valid, true);
  assert.equal(good.paid, true);
  assert.equal(good.providerOrderId, 'SRTEST0001');

  const bad = stripe.verifyCallback({
    body: JSON.parse(payload),
    rawBody: payload,
    headers: { 'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)}` },
    settings,
  });
  assert.equal(bad.valid, false);

  const old = stripe.verifyCallback({
    body: JSON.parse(payload),
    rawBody: payload,
    headers: { 'stripe-signature': `t=${timestamp - 4000},v1=${signature}` },
    settings,
  });
  assert.equal(old.valid, false, 'a replayed old signature must be rejected');
});

test('訂單編號符合綠界的 20 字英數限制 / order ids fit ECPay 20-char alphanumeric rule', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const id = payments.newOrderId();
    assert.match(id, /^[A-Z0-9]{1,20}$/);
    assert.ok(!seen.has(id), 'order ids must not repeat');
    seen.add(id);
  }
});
