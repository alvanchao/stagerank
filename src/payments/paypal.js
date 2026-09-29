// PayPal 轉接頭（Orders API v2）。
// PayPal adapter (Orders API v2).
//
// BN code 走 PayPal-Partner-Attribution-Id 標頭，是 PayPal 官方為「追蹤夥伴帶來的交易」設計的欄位。
// 主辦用自己的憑證呼叫，我們只在標頭帶上自己的 BN code，不影響金流，錢照樣直接進主辦帳戶。
// The BN code goes in the PayPal-Partner-Attribution-Id header — PayPal's own field for tracking a
// partner's transactions. The organiser calls with their own credentials; the money still goes to them.
// 來源 / source: https://developer.paypal.com/api/rest/requests/

import { partnerIds } from './partner.js';

export const id = 'paypal';

const ENDPOINTS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

export function isConfigured(settings) {
  return Boolean(settings?.clientId && settings?.clientSecret);
}

// PayPal 用小數點金額，所以零小數幣別要換算。
// PayPal takes decimal amounts, so zero-decimal currencies need converting.
const ZERO_DECIMAL = new Set(['TWD', 'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF']);

export function formatAmount(cents, currency) {
  const code = (currency || 'USD').toUpperCase();
  if (ZERO_DECIMAL.has(code)) return String(cents);
  return (cents / 100).toFixed(2);
}

export function buildOrderRequest({ order, urls, settings }) {
  const ids = partnerIds();
  const base = settings.sandbox ? ENDPOINTS.sandbox : ENDPOINTS.live;

  const headers = {
    'Content-Type': 'application/json',
    'PayPal-Request-Id': order.providerOrderId,
  };
  // 夥伴 ID 多點設置的第二處：轉接頭自己再取一次，不依賴呼叫端傳進來。
  // Second of the partner-id placements: the adapter reads it again rather than trusting its caller.
  if (ids.paypalBnCode) headers['PayPal-Partner-Attribution-Id'] = ids.paypalBnCode;

  return {
    kind: 'api',
    method: 'POST',
    url: `${base}/v2/checkout/orders`,
    headers,
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: order.providerOrderId,
          custom_id: order.providerOrderId,
          description: order.itemName,
          amount: {
            currency_code: (order.currency || 'USD').toUpperCase(),
            value: formatAmount(order.amountCents, order.currency),
          },
        },
      ],
      application_context: {
        brand_name: order.siteName,
        return_url: urls.returnUrl,
        cancel_url: urls.cancelUrl || urls.returnUrl,
        user_action: 'PAY_NOW',
      },
    },
    providerOrderId: order.providerOrderId,
    partnerIdSent: ids.paypalBnCode || null,
  };
}

export function createCheckout(args) {
  return buildOrderRequest(args);
}

export function tokenRequest({ settings }) {
  const base = settings.sandbox ? ENDPOINTS.sandbox : ENDPOINTS.live;
  const basic = Buffer.from(`${settings.clientId}:${settings.clientSecret}`, 'utf8').toString('base64');
  const ids = partnerIds();
  const headers = {
    Authorization: `Basic ${basic}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (ids.paypalBnCode) headers['PayPal-Partner-Attribution-Id'] = ids.paypalBnCode;
  return { url: `${base}/v1/oauth2/token`, method: 'POST', headers, body: 'grant_type=client_credentials' };
}

// PayPal 金額字串換回最小單位（formatAmount 的反向）。
// The inverse of formatAmount: a PayPal amount string back to the smallest unit.
export function parseAmount(value, currency) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const code = (currency || 'USD').toUpperCase();
  return ZERO_DECIMAL.has(code) ? Math.round(number) : Math.round(number * 100);
}

async function accessToken({ settings, fetchImpl }) {
  const request = tokenRequest({ settings });
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new Error(`paypal token ${response.status}`);
  }
  return json.access_token;
}

// 第一步：把訂單送給 PayPal，拿回讓使用者去核准付款的網址。
// Step one: send the order to PayPal and get back the URL where the payer approves it.
export async function startCheckout({ checkout, settings, fetchImpl = fetch }) {
  const token = await accessToken({ settings, fetchImpl });
  const response = await fetchImpl(checkout.url, {
    method: 'POST',
    headers: { ...checkout.headers, Authorization: `Bearer ${token}` },
    body: JSON.stringify(checkout.body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.id) {
    throw new Error(`paypal order ${response.status}`);
  }
  const link = (json.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!link?.href) throw new Error('paypal order has no approval link');
  return { redirectUrl: link.href, remoteId: json.id };
}

// 第二步：使用者核准後回到我們這裡，由我們向 PayPal 請款；PayPal 說 COMPLETED 才算付款。
// 不靠 webhook，所以測試環境不必設 webhook 也能走完。
// Step two: the payer comes back approved and we capture. Only COMPLETED counts as paid. This does
// not depend on a webhook, so a sandbox without one still works end to end.
export async function completeReturn({ remoteId, settings, fetchImpl = fetch }) {
  const token = await accessToken({ settings, fetchImpl });
  const base = settings.sandbox ? ENDPOINTS.sandbox : ENDPOINTS.live;
  const ids = partnerIds();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'PayPal-Request-Id': `cap-${remoteId}`,
  };
  if (ids.paypalBnCode) headers['PayPal-Partner-Attribution-Id'] = ids.paypalBnCode;

  const response = await fetchImpl(`${base}/v2/checkout/orders/${encodeURIComponent(remoteId)}/capture`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const json = await response.json().catch(() => ({}));
  const capture = json?.purchase_units?.[0]?.payments?.captures?.[0] || null;
  const paid = response.ok && json.status === 'COMPLETED' && capture?.status === 'COMPLETED';
  return {
    paid,
    providerTxnId: capture?.id || remoteId,
    amountCents: capture ? parseAmount(capture.amount?.value, capture.amount?.currency_code) : null,
    raw: { status: json.status || null, http: response.status, capture_id: capture?.id || null },
  };
}

// webhook 驗簽：把收到的標頭與內容原封不動交給 PayPal 查證。需要主辦在 PayPal 後台建好 webhook，
// 把它的 ID 填進 PAYPAL_WEBHOOK_ID；沒填就一律不採信（付款照樣能靠上面的回程請款完成）。
// Webhook verification: hand PayPal the headers and body untouched. The organiser creates the
// webhook in PayPal and sets PAYPAL_WEBHOOK_ID; without it webhooks are never trusted (payment
// still completes through the return capture above).
export async function verifyRemote({ body, headers, settings, fetchImpl = fetch }) {
  if (!settings?.webhookId) return false;
  const token = await accessToken({ settings, fetchImpl });
  const base = settings.sandbox ? ENDPOINTS.sandbox : ENDPOINTS.live;
  const h = (name) => headers?.[name] ?? headers?.[name.toLowerCase()];
  const response = await fetchImpl(`${base}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: settings.webhookId,
      webhook_event: body,
    }),
  });
  const json = await response.json().catch(() => ({}));
  return response.ok && json.verification_status === 'SUCCESS';
}

// PayPal 的 webhook 要拿 PayPal 的憑證做驗簽，需要網路。
// 沒有驗簽成功之前一律不算付款，避免有人偽造通知。
// Verifying a PayPal webhook needs a network call to PayPal. Until that succeeds we never mark it paid.
export function verifyCallback({ body }) {
  const resource = body?.resource || {};
  const eventType = body?.event_type || '';
  // 只認「款項已入帳」這一種事件；CHECKOUT.ORDER.APPROVED 只是使用者按了同意，還沒收到錢。
  // Only "capture completed" counts. ORDER.APPROVED just means the payer said yes; no money yet.
  const captured = eventType === 'PAYMENT.CAPTURE.COMPLETED' && resource.status === 'COMPLETED';

  return {
    valid: false, // 需要向 PayPal 驗簽才算有效 / only a verified signature makes this valid
    needsRemoteVerification: true,
    providerOrderId: resource.custom_id || resource.invoice_id || null,
    providerTxnId: resource.id || null,
    paid: captured,
    amountCents: captured ? parseAmount(resource.amount?.value, resource.amount?.currency_code) : null,
    message: eventType || null,
  };
}

export const callbackAck = '';

export default {
  id, isConfigured, createCheckout, buildOrderRequest, tokenRequest, startCheckout, completeReturn,
  verifyCallback, verifyRemote, callbackAck, formatAmount, parseAmount,
};
