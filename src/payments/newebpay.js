// 藍新 NewebPay 轉接頭（MPG 幕前支付）。
// NewebPay adapter (MPG hosted checkout).
//
// EV 查證時打不開藍新的官方手冊，非官方資料顯示 MPG 的標準參數裡可能沒有「軟體商歸因」欄位，
// 已知的 PartnerID 只用在平台商代建商店那類 API。所以這裡的夥伴代號預設留空，
// 等董事長向藍新業務問清楚，再把欄位補上。
// We could not open NewebPay's official manual, and unofficial sources suggest MPG has no vendor-attribution
// field (the known PartnerID belongs to the platform/reseller API). The partner id therefore stays blank
// until this is confirmed with NewebPay directly.

import crypto from 'node:crypto';
import { partnerIds } from './partner.js';

export const id = 'newebpay';

const ENDPOINTS = {
  sandbox: 'https://ccore.newebpay.com/MPG/mpg_gateway',
  live: 'https://core.newebpay.com/MPG/mpg_gateway',
};

export function isConfigured(settings) {
  return Boolean(settings?.merchantId && settings?.hashKey && settings?.hashIv);
}

export function encryptTradeInfo(plainQueryString, hashKey, hashIv) {
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(hashKey, 'utf8'), Buffer.from(hashIv, 'utf8'));
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plainQueryString, 'utf8'), cipher.final()]).toString('hex');
}

export function decryptTradeInfo(tradeInfoHex, hashKey, hashIv) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(hashKey, 'utf8'), Buffer.from(hashIv, 'utf8'));
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(tradeInfoHex, 'hex'), decipher.final()]).toString('utf8');
  // 藍新回傳的字串尾端會有 PKCS7 補位，手動去掉比較穩。
  // NewebPay pads with PKCS7; strip it manually so odd padding does not throw.
  return decrypted.replace(/[\x00-\x20]+$/g, '');
}

export function tradeSha(tradeInfoHex, hashKey, hashIv) {
  return crypto
    .createHash('sha256')
    .update(`HashKey=${hashKey}&${tradeInfoHex}&HashIV=${hashIv}`, 'utf8')
    .digest('hex')
    .toUpperCase();
}

export function createCheckout({ order, urls, settings, now }) {
  const ids = partnerIds();
  const timestamp = Math.floor((now ? now.getTime() : Date.now()) / 1000);

  const plain = new URLSearchParams({
    MerchantID: settings.merchantId,
    RespondType: 'JSON',
    TimeStamp: String(timestamp),
    Version: '2.0',
    MerchantOrderNo: order.providerOrderId,
    Amt: String(order.amountCents),
    ItemDesc: order.itemName,
    NotifyURL: urls.notifyUrl,
    ReturnURL: urls.returnUrl,
    ...(order.email ? { Email: order.email } : {}),
  }).toString();

  const tradeInfo = encryptTradeInfo(plain, settings.hashKey, settings.hashIv);

  const fields = {
    MerchantID: settings.merchantId,
    TradeInfo: tradeInfo,
    TradeSha: tradeSha(tradeInfo, settings.hashKey, settings.hashIv),
    Version: '2.0',
  };

  // 未確認前不送任何夥伴欄位。
  // Nothing partner-related is sent until the field is confirmed with NewebPay.
  if (ids.newebpayPartnerId) fields.PartnerID = ids.newebpayPartnerId;

  return {
    kind: 'form',
    method: 'POST',
    url: settings.sandbox ? ENDPOINTS.sandbox : ENDPOINTS.live,
    fields,
    providerOrderId: order.providerOrderId,
    partnerIdSent: ids.newebpayPartnerId || null,
  };
}

export function verifyCallback({ body, settings }) {
  const tradeInfo = body?.TradeInfo;
  if (!tradeInfo || !isConfigured(settings)) {
    return { valid: false, providerOrderId: null, providerTxnId: null, paid: false, amountCents: null };
  }

  const expectedSha = tradeSha(tradeInfo, settings.hashKey, settings.hashIv);
  const valid = String(body.TradeSha || '').toUpperCase() === expectedSha;
  if (!valid) {
    return { valid: false, providerOrderId: null, providerTxnId: null, paid: false, amountCents: null };
  }

  let parsed = {};
  try {
    parsed = JSON.parse(decryptTradeInfo(tradeInfo, settings.hashKey, settings.hashIv));
  } catch {
    return { valid: false, providerOrderId: null, providerTxnId: null, paid: false, amountCents: null };
  }

  const result = parsed.Result || {};
  return {
    valid: true,
    providerOrderId: result.MerchantOrderNo || null,
    providerTxnId: result.TradeNo || null,
    paid: parsed.Status === 'SUCCESS',
    amountCents: result.Amt !== undefined ? Number.parseInt(result.Amt, 10) : null,
    message: parsed.Message || null,
  };
}

export const callbackAck = 'OK';

export default { id, isConfigured, createCheckout, verifyCallback, callbackAck, encryptTradeInfo, decryptTradeInfo, tradeSha };
