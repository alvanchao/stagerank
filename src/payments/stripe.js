// Stripe 轉接頭（Checkout Session）。
// Stripe adapter (Checkout Session).
//
// Stripe 官方已經不允許外掛向使用者索取完整權限的金鑰（sk_），改用受限金鑰（rk_）。
// 所以主辦貼的是 rk_，權限只夠開結帳頁，比較安全。
// Stripe no longer lets plugins ask users for a full secret key (sk_); organisers paste a restricted
// key (rk_) instead, scoped just wide enough to create a checkout session.
// 來源 / source: https://docs.stripe.com/stripe-apps/plugins/decide-migration
//
// 軟體商歸因走 X-Stripe-Client-User-Agent 的 application 欄位（SDK 的 setAppInfo 做的就是這件事）。
// partner_id 要加入 Stripe 夥伴計畫才有；沒有時只帶 name 與 url，官方說這樣也可以。
// Attribution goes in the application block of X-Stripe-Client-User-Agent (what setAppInfo does).
// partner_id only exists for Stripe partners; without one we send name and url, which Stripe allows.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { partnerIds } from './partner.js';

export const id = 'stripe';

const API_BASE = 'https://api.stripe.com';

export function isConfigured(settings) {
  return Boolean(settings?.restrictedKey);
}

export function isRestrictedKey(key) {
  return typeof key === 'string' && /^rk_(test|live)_/.test(key);
}

const ZERO_DECIMAL = new Set(['TWD', 'JPY', 'KRW', 'VND', 'CLP', 'ISK']);

// Stripe 的 unit_amount 用最小幣別單位；零小數幣別（如 TWD、JPY）直接就是整數。
// Stripe's unit_amount is in the smallest unit; for zero-decimal currencies that is the integer itself.
export function unitAmount(cents, currency) {
  const code = (currency || 'usd').toUpperCase();
  return ZERO_DECIMAL.has(code) ? cents : cents;
}

export function appInfoHeader() {
  const ids = partnerIds();
  const application = { name: ids.appName, version: ids.appVersion, url: ids.appUrl };
  if (ids.stripePartnerId) application.partner_id = ids.stripePartnerId;
  return JSON.stringify({
    application,
    bindings_version: ids.appVersion,
    lang: 'node',
    publisher: ids.appName.toLowerCase(),
  });
}

export function createCheckout({ order, urls, settings }) {
  const ids = partnerIds();
  const currency = (order.currency || 'usd').toLowerCase();

  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('client_reference_id', order.providerOrderId);
  form.set('success_url', urls.returnUrl);
  form.set('cancel_url', urls.cancelUrl || urls.returnUrl);
  form.set('line_items[0][quantity]', '1');
  form.set('line_items[0][price_data][currency]', currency);
  form.set('line_items[0][price_data][unit_amount]', String(unitAmount(order.amountCents, order.currency)));
  form.set('line_items[0][price_data][product_data][name]', order.itemName);
  form.set('metadata[stagerank_order]', order.providerOrderId);
  if (order.email) form.set('customer_email', order.email);

  return {
    kind: 'api',
    method: 'POST',
    url: `${API_BASE}/v1/checkout/sessions`,
    headers: {
      Authorization: `Bearer ${settings.restrictedKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': order.providerOrderId,
      'X-Stripe-Client-User-Agent': appInfoHeader(),
      'User-Agent': `${ids.appName}/${ids.appVersion} (${ids.appUrl})`,
    },
    body: form.toString(),
    providerOrderId: order.providerOrderId,
    partnerIdSent: ids.stripePartnerId || null,
  };
}

// Stripe webhook 驗簽：t=時間戳,v1=簽章，簽的是 `${t}.${原始 body}`。
// Stripe webhook signing: header is t=timestamp,v1=signature over `${t}.${raw body}`.
export function verifySignature({ rawBody, signatureHeader, secret, toleranceSeconds = 300, now = Date.now() }) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const idx = p.indexOf('=');
      return [p.slice(0, idx).trim(), p.slice(idx + 1).trim()];
    }),
  );
  const timestamp = Number.parseInt(parts.t, 10);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  const given = parts.v1 || '';
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

export function verifyCallback({ body, rawBody, headers, settings, now }) {
  const signatureHeader = headers?.['stripe-signature'] || headers?.['Stripe-Signature'];
  const valid = verifySignature({
    rawBody,
    signatureHeader,
    secret: settings?.webhookSecret,
    now: now ? now.getTime() : Date.now(),
  });

  const object = body?.data?.object || {};
  const type = body?.type || '';

  return {
    valid,
    providerOrderId: object.client_reference_id || object.metadata?.stagerank_order || null,
    providerTxnId: object.payment_intent || object.id || null,
    paid: valid && type === 'checkout.session.completed' && object.payment_status === 'paid',
    amountCents: object.amount_total ?? null,
    message: type || null,
  };
}

export const callbackAck = JSON.stringify({ received: true });

export default { id, isConfigured, createCheckout, verifyCallback, verifySignature, appInfoHeader, isRestrictedKey, callbackAck };
