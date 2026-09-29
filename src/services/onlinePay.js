// API 型金流（PayPal、Stripe）的兩步流程：
//   1. startApi：把訂單送給對方，拿回付款網址，記下對方的訂單編號，再把使用者送過去。
//   2. finishReturn：使用者付完回來，我們向對方查證／請款；對方說成功才標記已付款。
//
// 綠界、藍新是「表單型」，一步就送出去，不走這裡。
//
// The two-step flow for API-style providers (PayPal, Stripe):
//   1. startApi: send the order to the provider, get the payment URL, remember the provider's own order
//      id, and send the payer there.
//   2. finishReturn: the payer comes back, we verify or capture with the provider, and only the
//      provider's "yes" marks the registration paid.
// ECPay and NewebPay are form-style and go out in one step, so they never come through here.

import { one, query } from '../db/index.js';
import * as payments from '../payments/index.js';
import { applyPaymentResult } from './registrations.js';

export class PaymentStartError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaymentStartError';
  }
}

export function isApiProvider(provider) {
  const adapter = payments.getAdapter(provider);
  return Boolean(adapter && typeof adapter.startCheckout === 'function' && typeof adapter.completeReturn === 'function');
}

export async function startApi({ provider, checkout, fetchImpl }) {
  const adapter = payments.getAdapter(provider);
  const settings = payments.settingsFor(provider);
  try {
    const { redirectUrl, remoteId } = await adapter.startCheckout({ checkout, settings, fetchImpl });
    await query(
      `UPDATE payments SET provider_txn_id = $3
       WHERE provider = $1 AND provider_order_id = $2`,
      [provider, checkout.providerOrderId, remoteId],
    );
    return redirectUrl;
  } catch (err) {
    await query(
      `UPDATE payments SET status = 'failed', raw = $3
       WHERE provider = $1 AND provider_order_id = $2 AND status = 'created'`,
      [provider, checkout.providerOrderId, JSON.stringify({ stagerank_reason: 'start_failed', error: String(err.message).slice(0, 300) })],
    );
    console.error(`[pay] ${provider} start failed:`, err.message);
    throw new PaymentStartError(err.message);
  }
}

// 使用者回來的網址人人打得開，所以這裡不信網址上的任何內容：
// 只用我們自己存的訂單編號去問對方，答案由對方說了算。
// The return URL is public, so nothing in it is trusted: we ask the provider about our own stored
// order id and the provider's answer decides.
export async function finishReturn({ provider, registrationId, fetchImpl }) {
  if (!isApiProvider(provider)) return { ok: false, reason: 'not_api_provider' };

  const payment = await one(
    `SELECT * FROM payments WHERE registration_id = $1 AND provider = $2 ORDER BY id DESC LIMIT 1`,
    [registrationId, provider],
  );
  if (!payment) return { ok: false, reason: 'unknown_order' };
  if (payment.status === 'paid') return { ok: true, alreadyPaid: true };
  if (!payment.provider_txn_id) return { ok: false, reason: 'not_started' };

  const adapter = payments.getAdapter(provider);
  const settings = payments.settingsFor(provider);
  let result;
  try {
    result = await adapter.completeReturn({ remoteId: payment.provider_txn_id, settings, fetchImpl });
  } catch (err) {
    console.error(`[pay] ${provider} return check failed:`, err.message);
    return { ok: false, reason: 'provider_unreachable' };
  }

  // 沒付成功（取消、還沒核准）不改成 failed：使用者可能只是先回來，還能再試。
  // Not paid (cancelled, not approved yet) is not marked failed: the payer may simply have come back early.
  if (!result.paid) return { ok: true, paid: false };

  return applyPaymentResult({
    provider,
    providerOrderId: payment.provider_order_id,
    providerTxnId: result.providerTxnId,
    paid: true,
    amountCents: result.amountCents,
    raw: result.raw,
  });
}

export default { PaymentStartError, isApiProvider, startApi, finishReturn };
