import express from 'express';
import * as payments from '../payments/index.js';
import * as regs from '../services/registrations.js';

const router = express.Router();

// 金流平台的付款通知。驗章不過一律不算付款。
// Provider callbacks. A failed signature check never marks anything paid.
router.post('/:provider/notify', async (req, res) => {
  const { provider } = req.params;
  if (!payments.getAdapter(provider)) return res.status(404).send('unknown provider');

  try {
    const result = payments.verifyCallback({
      provider,
      body: req.body,
      rawBody: req.rawBody,
      headers: req.headers,
    });

    if (!result.valid) {
      console.warn(`[pay] ${provider} callback failed verification`);
      return res.status(400).send('invalid signature');
    }

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

    return res.send(payments.getAdapter(provider).callbackAck ?? 'OK');
  } catch (err) {
    console.error(`[pay] ${provider} callback error`, err);
    return res.status(500).send('error');
  }
});

export default router;
