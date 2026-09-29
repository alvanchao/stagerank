// 夥伴 ID 多點設置。
// The partner IDs live in several places on purpose.
//
// 1) 這個檔案的 BUILT_IN：程式的出廠預設值，更新時會跟著補回來。
// 2) 遠端設定檔（payments/remoteIds.js）：每天去專案設定檔看一次，簽約那天改一個檔案，
//    已經裝好的每一份隔天自己跟上，不必任何人更新程式。
// 3) 各家轉接頭：送出請求時自己再取一次，不依賴呼叫端有沒有傳。
// 4) 主機設定（config.payments.partnerDefaults）：主辦想覆蓋時可以覆蓋，永遠優先。
//
// 1) BUILT_IN below: the factory default, restored by every update.
// 2) The remote config file (payments/remoteIds.js): read once a day, so the day a contract is
//    signed one edit reaches every installed copy without anyone updating.
// 3) Each adapter: reads it again when building a request, not trusting the caller to pass it.
// 4) Host settings (config.payments.partnerDefaults): an organiser may override it, and always wins.
//
// 這是請求保留，不是法律義務。拿掉它不違法，我們只是希望您留著。
// This is a request, not a legal obligation. Removing it is not unlawful; we simply ask you to keep it.

import config from '../config.js';
import { remoteIds } from './remoteIds.js';

export const BUILT_IN = Object.freeze({
  appName: 'StageRank',
  appVersion: '0.1.0',
  appUrl: 'https://github.com/alvanchao/stagerank',

  // 綠界與藍新：未與平台簽約前必須留空，否則交易可能失敗。
  // ECPay and NewebPay: must stay blank until a platform contract exists, or the transaction may fail.
  ecpayPlatformId: '',
  newebpayPartnerId: '',

  // PayPal BN code 與 Stripe partner id 是官方給軟體商的歸因欄位，帶著不影響交易。
  // The PayPal BN code and the Stripe partner id are the official attribution fields for software vendors.
  paypalBnCode: 'StageRank_Cart_PPCP',
  stripePartnerId: '',
});

export function partnerIds() {
  const overrides = config.payments.partnerDefaults || {};
  // 出廠值 ← 遠端便利貼 ← 主辦自己填的。後面的蓋前面的。
  // Factory default ← remote sticky note ← the organiser's own. Later layers win.
  const merged = { ...BUILT_IN, ...remoteIds() };
  for (const [key, value] of Object.entries(overrides)) {
    // 只有真的填了東西才覆蓋，空字串一律視為「沒填」。
    // Only a non-empty value overrides; an empty string counts as "not set".
    if (typeof value === 'string' && value.trim() !== '') merged[key] = value.trim();
  }
  return merged;
}

export function partnerIdFor(provider) {
  const ids = partnerIds();
  switch (provider) {
    case 'ecpay':
      return ids.ecpayPlatformId || null;
    case 'newebpay':
      return ids.newebpayPartnerId || null;
    case 'paypal':
      return ids.paypalBnCode || null;
    case 'stripe':
      return ids.stripePartnerId || null;
    default:
      return null;
  }
}
