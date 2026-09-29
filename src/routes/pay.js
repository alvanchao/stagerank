import express from 'express';
import * as payments from '../payments/index.js';
import * as regs from '../services/registrations.js';
import * as onlinePay from '../services/onlinePay.js';

const router = express.Router();

// 金流平台的付款通知。驗章不過一律不算付款。
// Provider callbacks. A failed signature check never marks anything paid.
router.post('/:provider/notify', async (req, res) => {
  const { provider } = req.params;
  const adapter = payments.getAdapter(provider);
  if (!adapter) return res.status(404).send('unknown provider');

  try {
    const result = payments.verifyCallback({
      provider,
      body: req.body,
      rawBody: req.rawBody,
      headers: req.headers,
    });

    // PayPal：本地驗不了，要拿標頭與內容去問 PayPal；沒設 webhook ID 就一律不採信。
    // PayPal cannot be verified locally: the headers and body go back to PayPal, and without a webhook
    // id nothing is trusted.
    if (!result.valid && result.needsRemoteVerification && typeof adapter.verifyRemote === 'function') {
      try {
        result.valid = await adapter.verifyRemote({
          body: req.body,
          headers: req.headers,
          settings: payments.settingsFor(provider),
        });
      } catch (err) {
        console.warn(`[pay] ${provider} remote verification failed: ${err.message}`);
        result.valid = false;
      }
    }

    if (!result.valid) {
      console.warn(`[pay] ${provider} callback failed verification`);
      return res.status(400).send('invalid signature');
    }

    // 已驗證但不是「款項入帳」的事件（例如剛建立訂單）：收下就好，不改任何狀態。
    // A verified event that is not "money received" is acknowledged and changes nothing.
    if (!result.paid && provider === 'paypal') return res.send(adapter.callbackAck ?? 'OK');

    const applied = await regs.applyPaymentResult({
      provider,
      providerOrderId: result.providerOrderId,
      providerTxnId: result.providerTxnId,
      paid: result.paid,
      amountCents: result.amountCents,
      raw: req.body,
    });

    if (!applied.ok) {
      console.warn(`[pay] ${provider} callback rejected: ${applied.reason}`);
      return res.status(400).send(applied.reason);
    }

    return res.send(adapter.callbackAck ?? 'OK');
  } catch (err) {
    console.error(`[pay] ${provider} callback error`, err);
    return res.status(500).send('error');
  }
});

// PayPal、Stripe 付完（或取消）之後回到這裡，由我們向對方查證再導回報名頁。
// PayPal and Stripe send the payer back here after paying (or cancelling); we verify with the provider
// and then show the registration page.
router.get('/:provider/return/:registrationId', async (req, res, next) => {
  try {
    const { provider } = req.params;
    const registrationId = Number.parseInt(req.params.registrationId, 10);
    if (!onlinePay.isApiProvider(provider) || !Number.isInteger(registrationId)) {
      return res.redirect(303, '/');
    }
    await onlinePay.finishReturn({ provider, registrationId });
    return res.redirect(303, `/r/${registrationId}`);
  } catch (err) {
    return next(err);
  }
});

export default router;
