// 綠界 ECPay 轉接頭（全方位金流 AioCheckOut V5）。
// ECPay adapter (AioCheckOut V5).
//
// PlatformID 是「特約合作平台商代號」，要與綠界簽專案合作才能用；官方明寫一般商店留空。
// 帶了 PlatformID 之後，檢查碼要改用平台商的 HashKey/HashIV 計算，所以未簽約前一律留空。
// PlatformID is ECPay's contracted-platform field. Ordinary merchants must leave it blank, and once it
// is sent the MAC must be computed with the platform's own key, so we keep it blank until contracted.
// 來源 / source: https://developers.ecpay.com.tw/?p=2862

import crypto from 'node:crypto';
import { partnerIds } from './partner.js';

export const id = 'ecpay';

const ENDPOINTS = {
  sandbox: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
  live: 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5',
};

export function isConfigured(settings) {
  return Boolean(settings?.merchantId && settings?.hashKey && settings?.hashIv);
}

// .NET 的 UrlEncode 與 encodeURIComponent 有幾處不同，檢查碼必須照綠界的規則做。
// ECPay follows .NET's UrlEncode, which differs from encodeURIComponent in a few characters.
export function dotNetUrlEncode(value) {
  return encodeURIComponent(value)
    .toLowerCase()
    .replace(/%20/g, '+')
    .replace(/%2d/g, '-')
    .replace(/%5f/g, '_')
    .replace(/%2e/g, '.')
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')');
}

export function checkMacValue(params, hashKey, hashIv) {
  const entries = Object.entries(params)
    .filter(([key]) => key !== 'CheckMacValue')
    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const raw = `HashKey=${hashKey}&${entries.map(([k, v]) => `${k}=${v}`).join('&')}&HashIV=${hashIv}`;
  const encoded = dotNetUrlEncode(raw);
  return crypto.createHash('sha256').update(encoded, 'utf8').digest('hex').toUpperCase();
}

function tradeDate(now = new Date()) {
  // 綠界要求 yyyy/MM/dd HH:mm:ss，且用台灣時間。
  // ECPay wants yyyy/MM/dd HH:mm:ss in Taiwan time.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

export function createCheckout({ order, urls, settings, now }) {
  const ids = partnerIds();
  const params = {
    MerchantID: settings.merchantId,
    MerchantTradeNo: order.providerOrderId,
    MerchantTradeDate: tradeDate(now),
    PaymentType: 'aio',
    TotalAmount: String(order.amountCents),
    TradeDesc: order.description,
    ItemName: order.itemName,
    ReturnURL: urls.notifyUrl,
    ClientBackURL: urls.returnUrl,
    ChoosePayment: 'ALL',
    EncryptType: '1',
  };

  // 未簽約時 ecpayPlatformId 是空字串，這個欄位就整個不送，交易才不會被擋。
  // While the platform id is blank the field is omitted entirely, so ordinary merchants are unaffected.
  if (ids.ecpayPlatformId) params.PlatformID = ids.ecpayPlatformId;

  params.CheckMacValue = checkMacValue(params, settings.hashKey, settings.hashIv);

  return {
    kind: 'form',
    method: 'POST',
    url: settings.sandbox ? ENDPOINTS.sandbox : ENDPOINTS.live,
    fields: params,
    providerOrderId: order.providerOrderId,
    partnerIdSent: ids.ecpayPlatformId || null,
  };
}

export function verifyCallback({ body, settings }) {
  const mac = body?.CheckMacValue;
  const expected = isConfigured(settings) ? checkMacValue(body || {}, settings.hashKey, settings.hashIv) : null;
  const valid = Boolean(mac && expected && mac.toUpperCase() === expected);

  return {
    valid,
    providerOrderId: body?.MerchantTradeNo || null,
    providerTxnId: body?.TradeNo || null,
    paid: valid && String(body?.RtnCode) === '1',
    amountCents: body?.TradeAmt ? Number.parseInt(body.TradeAmt, 10) : null,
    message: body?.RtnMsg || null,
  };
}

// 綠界要求收到通知後回傳這串文字，否則會重送。
// ECPay expects this exact body back, otherwise it retries the notification.
export const callbackAck = '1|OK';

export default { id, isConfigured, createCheckout, verifyCallback, callbackAck, checkMacValue, dotNetUrlEncode };
