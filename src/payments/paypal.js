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

// PayPal 的 webhook 要拿 PayPal 的憑證做驗簽，需要網路。
// 沒有驗簽成功之前一律不算付款，避免有人偽造通知。
// Verifying a PayPal webhook needs a network call to PayPal. Until that succeeds we never mark it paid.
export function verifyCallback({ body }) {
  const resource = body?.resource || {};
  const eventType = body?.event_type || '';
  const captured = eventType === 'PAYMENT.CAPTURE.COMPLETED' || eventType === 'CHECKOUT.ORDER.APPROVED';

  return {
    valid: false, // 需要向 PayPal 驗簽才算有效 / only a verified signature makes this valid
    needsRemoteVerification: true,
    providerOrderId: resource.custom_id || resource.invoice_id || null,
    providerTxnId: resource.id || null,
    paid: captured,
    amountCents: null,
    message: eventType || null,
  };
}

export const callbackAck = '';

export default { id, isConfigured, createCheckout, buildOrderRequest, tokenRequest, verifyCallback, callbackAck, formatAmount };
