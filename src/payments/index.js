// 共用金流層：上面四家各接一個轉接頭，其他地方只認這一層。
// The shared payment layer. Four adapters plug in underneath; the rest of the app only talks to this.
//
// 外國主辦要加當地的金流，就照同樣格式再寫一個轉接頭放進 ADAPTERS。
// To add a local provider, write one more adapter in the same shape and register it in ADAPTERS.

import crypto from 'node:crypto';
import config from '../config.js';
import ecpay from './ecpay.js';
import newebpay from './newebpay.js';
import paypal from './paypal.js';
import stripe from './stripe.js';
import { partnerIdFor } from './partner.js';

export const ADAPTERS = { ecpay, newebpay, paypal, stripe };

export function getAdapter(provider) {
  return ADAPTERS[provider] || null;
}

export function settingsFor(provider) {
  const settings = config.payments[provider];
  if (!settings) return null;
  return { ...settings, provider };
}

// 一個金流只有在「主辦有開」且「金鑰填齊」時才會出現在報名頁。
// A provider only appears on the registration form when the organiser enabled it and the keys are complete.
export function availableProviders() {
  return Object.keys(ADAPTERS).filter((provider) => {
    const settings = settingsFor(provider);
    return Boolean(settings?.enabled && ADAPTERS[provider].isConfigured(settings));
  });
}

export function providerStatus() {
  return Object.keys(ADAPTERS).map((provider) => {
    const settings = settingsFor(provider) || {};
    return {
      provider,
      enabled: Boolean(settings.enabled),
      configured: ADAPTERS[provider].isConfigured(settings),
      sandbox: settings.sandbox !== false,
      partnerId: partnerIdFor(provider),
    };
  });
}

// 訂單編號：綠界限制 20 個英數字，所以四家一律用同一種短格式。
// Order numbers: ECPay allows 20 alphanumeric characters, so all four share one short format.
export function newOrderId(prefix = 'SR') {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `${prefix}${stamp}${random}`.slice(0, 20);
}

export function createCheckout({ provider, order, urls, now }) {
  const adapter = getAdapter(provider);
  if (!adapter) throw new Error(`unknown payment provider: ${provider}`);
  const settings = settingsFor(provider);
  if (!adapter.isConfigured(settings)) throw new Error(`payment provider not configured: ${provider}`);
  return adapter.createCheckout({ order, urls, settings, now });
}

export function verifyCallback({ provider, body, rawBody, headers, now }) {
  const adapter = getAdapter(provider);
  if (!adapter) throw new Error(`unknown payment provider: ${provider}`);
  return adapter.verifyCallback({ body, rawBody, headers, settings: settingsFor(provider), now });
}

export { partnerIdFor };
export default { ADAPTERS, getAdapter, availableProviders, providerStatus, createCheckout, verifyCallback, newOrderId, partnerIdFor };
