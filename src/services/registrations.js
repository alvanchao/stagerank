import { one, many, withTransaction } from '../db/index.js';
import * as payments from '../payments/index.js';
import { getCompetition, getDivision } from './competitions.js';
import * as units from './entryUnits.js';
import * as roster from './athletes.js';

export class RegistrationError extends Error {
  constructor(key, params = null) {
    super(key);
    this.params = params;
    this.key = key; // 錯誤訊息的翻譯 key，訊息本身在語言檔裡 / translation key; the text lives in the locale files
    this.name = 'RegistrationError';
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 報名一個參賽單位。單人就一位成員，雙人兩位，多人由組別的上下限決定。
// Register one entry unit: one member for a solo, two for a couple, and whatever the division allows
// for a team.
//
// 舊的呼叫方式（athleteName 一個字串）仍然可以用，會被當成單人。
// The old single-name call still works and is treated as a one-person entry.
export async function register({
  competitionId,
  divisionId,
  members,
  athleteIds,
  entrantId = null,
  athleteName,
  athleteEmail,
  unitName,
  provider,
}) {
  const competition = await getCompetition(competitionId);
  if (!competition) throw new RegistrationError('register.errors.notOpen');
  if (competition.status !== 'open') throw new RegistrationError('register.errors.notOpen');

  if (!divisionId) throw new RegistrationError('register.errors.divisionRequired');
  const division = await getDivision(divisionId);
  if (!division || String(division.competition_id) !== String(competitionId)) {
    throw new RegistrationError('register.errors.divisionInvalid');
  }

  // 從名冊勾選：只帶編號進來，姓名和生日一律以名冊為準，不信畫面送上來的字。
  // Ticked off the roster: only ids arrive, and the name and birthday come from the roster itself,
  // never from what the form claims.
  let chosen = null;
  if (Array.isArray(athleteIds) && athleteIds.length > 0) {
    if (!entrantId) throw new RegistrationError('register.errors.signInRequired');
    chosen = await roster.listByIds(athleteIds, entrantId);
    if (chosen.length !== new Set(athleteIds.map(String)).size) {
      throw new RegistrationError('register.errors.athleteNotYours');
    }
    const problems = roster.ageProblems({ athletes: chosen, division, competition });
    if (problems.length > 0) {
      const first = problems[0];
      throw new RegistrationError('register.errors.ageOutOfRange', {
        name: first.name,
        age: first.age,
        min: first.min === null ? '—' : first.min,
        max: first.max === null ? '—' : first.max,
      });
    }
  }

  const supplied = chosen
    ? chosen.map((athlete) => ({
      athleteId: athlete.id,
      athleteName: athlete.name,
      personEmail: athlete.email,
    }))
    : (Array.isArray(members) && members.length > 0
      ? members
      : [{ athleteName, personEmail: athleteEmail }]);

  let parsed;
  try {
    parsed = units.parseMembers(supplied, division);
  } catch (err) {
    if (err instanceof units.MemberError) throw new RegistrationError(err.key, err.params);
    throw err;
  }

  const priced = await units.quote({ competition, division, members: parsed });
  const amountCents = priced.totalCents;
  const label = units.displayName(parsed);
  const contactEmail = parsed.find((m) => m.personEmail)?.personEmail || null;
  const club = String(unitName || '').trim() || null;

  // 階梯計價時，每位成員各自是第幾項、收了多少，一起存起來：
  // 事後有人問「為什麼這筆比較便宜」，翻得出答案。
  // Under tiered pricing each member's item number and price are stored too, so that
  // "why did this one cost less" has an answer afterwards.
  const lineFor = (member) =>
    (priced.lines || []).find((line) => String(line.athleteId) === String(member.athleteId)) || null;

  async function insertMembers(client, registrationId) {
    for (const [index, member] of parsed.entries()) {
      const line = lineFor(member);
      await client.query(
        `INSERT INTO registration_members
           (registration_id, athlete_id, athlete_name, person_email, sort_order, item_index, item_fee_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [registrationId, member.athleteId || null, member.athleteName, member.personEmail, index,
         line ? line.itemIndex : null, line ? line.itemFeeCents : null],
      );
    }
  }

  // 免費比賽：費用是 0，系統直接發，後續流程跟線上付款完全一樣。
  // Free competition: the fee is 0, so the registration is settled straight away and behaves identically.
  if (amountCents === 0) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO registrations
           (competition_id, division_id, entrant_id, athlete_name, athlete_email, unit_name,
            amount_cents, currency, status, paid_source, paid_at, member_count, extra_fee_cents)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, 'paid', 'free', now(), $8, $9) RETURNING *`,
        [competitionId, divisionId, entrantId, label, contactEmail, club,
         competition.currency, parsed.length, priced.extraCents],
      );
      const registration = rows[0];
      await insertMembers(client, registration.id);
      return { registration, checkout: null, free: true, quote: priced, members: parsed };
    });
  }

  if (!provider) throw new RegistrationError('register.errors.providerRequired');
  if (!payments.availableProviders().includes(provider)) {
    throw new RegistrationError('register.errors.providerUnavailable');
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO registrations
         (competition_id, division_id, entrant_id, athlete_name, athlete_email, unit_name,
          amount_cents, currency, status, member_count, extra_fee_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10) RETURNING *`,
      [
        competitionId,
        divisionId,
        entrantId,
        label,
        contactEmail,
        club,
        amountCents,
        competition.currency,
        parsed.length,
        priced.extraCents,
      ],
    );
    const registration = rows[0];
    await insertMembers(client, registration.id);

    const providerOrderId = payments.newOrderId();
    const adapter = payments.getAdapter(provider);
    const apiReturn = typeof adapter.completeReturn === 'function';
    const checkout = payments.createCheckout({
      provider,
      order: {
        providerOrderId,
        amountCents,
        currency: competition.currency,
        itemName: `${competition.name} / ${division.name}`,
        description: competition.name,
        email: contactEmail,
        siteName: competition.name,
      },
      urls: {
        notifyUrl: `${process.env.BASE_URL || ''}/pay/${provider}/notify`,
        // PayPal、Stripe 付完要先回到 /pay/.../return 讓我們向對方查證；綠界、藍新直接回報名頁。
        // PayPal and Stripe return via /pay/.../return so we can verify with them first; ECPay and
        // NewebPay go straight back to the registration page.
        returnUrl: apiReturn
          ? `${process.env.BASE_URL || ''}/pay/${provider}/return/${registration.id}`
          : `${process.env.BASE_URL || ''}/r/${registration.id}`,
        cancelUrl: `${process.env.BASE_URL || ''}/r/${registration.id}`,
      },
    });

    await client.query(
      `INSERT INTO payments
         (registration_id, provider, provider_order_id, amount_cents, currency, status, partner_id_sent, sandbox)
       VALUES ($1, $2, $3, $4, $5, 'created', $6, $7)`,
      [
        registration.id,
        provider,
        providerOrderId,
        amountCents,
        competition.currency,
        checkout.partnerIdSent,
        payments.settingsFor(provider)?.sandbox !== false,
      ],
    );

    return { registration, checkout, free: false, quote: priced, members: parsed };
  });
}

export function membersOf(registrationId) {
  return many(
    'SELECT * FROM registration_members WHERE registration_id = $1 ORDER BY sort_order, id',
    [registrationId],
  );
}

export function getRegistration(id) {
  return one('SELECT * FROM registrations WHERE id = $1', [id]);
}

export function listRegistrations(competitionId) {
  return many(
    `SELECT r.*, d.name AS division_name, d.fee_mode
     FROM registrations r JOIN divisions d ON d.id = r.division_id
     WHERE r.competition_id = $1
     ORDER BY d.sort_order, d.id, r.id`,
    [competitionId],
  );
}

export function getPaymentByOrderId(provider, providerOrderId) {
  return one('SELECT * FROM payments WHERE provider = $1 AND provider_order_id = $2', [provider, providerOrderId]);
}

// 收到金流通知：只有驗章通過、金額相符才算付款成功。
// A provider callback only counts as paid when the signature checks out and the amount matches.
export async function applyPaymentResult(args) {
  const result = await applyPaymentResultInner(args);
  // 付款成功就把這場比賽最新的匿名統計送出去（背景進行，失敗完全不影響付款）。
  // On a fresh successful payment, send the competition's latest anonymous summary (in the background; never affects the payment).
  if (result?.paid && !result.alreadyPaid && result.registrationId) {
    const stats = await import('./stats.js');
    stats.reportAfterPayment(result.registrationId).catch((err) => console.warn('[stats]', err.message));
  }
  return result;
}

async function applyPaymentResultInner({ provider, providerOrderId, providerTxnId, paid, amountCents, raw }) {
  return withTransaction(async (client) => {
    const { rows: paymentRows } = await client.query(
      'SELECT * FROM payments WHERE provider = $1 AND provider_order_id = $2 FOR UPDATE',
      [provider, providerOrderId],
    );
    const payment = paymentRows[0];
    if (!payment) return { ok: false, reason: 'unknown_order' };

    if (amountCents !== null && amountCents !== undefined && Number(amountCents) !== Number(payment.amount_cents)) {
      await client.query(
        `UPDATE payments SET status = 'failed', raw = $2 WHERE id = $1`,
        [payment.id, JSON.stringify({ ...raw, stagerank_reason: 'amount_mismatch' })],
      );
      return { ok: false, reason: 'amount_mismatch' };
    }

    // 已經處理過的通知直接當成功回覆，金流平台常會重送。
    // Providers retry notifications, so an already-processed one is acknowledged without changing anything.
    if (payment.status === 'paid') return { ok: true, alreadyPaid: true, paymentId: payment.id };

    if (!paid) {
      await client.query(`UPDATE payments SET status = 'failed', raw = $2 WHERE id = $1`, [
        payment.id,
        JSON.stringify(raw || {}),
      ]);
      return { ok: true, paid: false, paymentId: payment.id };
    }

    await client.query(
      `UPDATE payments SET status = 'paid', provider_txn_id = $2, paid_at = now(), raw = $3 WHERE id = $1`,
      [payment.id, providerTxnId || null, JSON.stringify(raw || {})],
    );
    await client.query(
      `UPDATE registrations SET status = 'paid', paid_source = 'online', paid_at = now(), updated_at = now()
       WHERE id = $1 AND status <> 'paid'`,
      [payment.registration_id],
    );

    return { ok: true, paid: true, paymentId: payment.id, registrationId: payment.registration_id };
  });
}

// 現場付現或轉帳：主辦後台手動標記。這種付款不經過金流平台，不帶夥伴 ID。
// Cash or bank transfer, marked by the organiser. It never touches a provider and carries no partner id.
export function markPaidManually(registrationId) {
  return one(
    `UPDATE registrations
     SET status = 'paid', paid_source = 'manual', paid_at = now(), updated_at = now()
     WHERE id = $1 AND status <> 'paid' RETURNING *`,
    [registrationId],
  );
}

export function cancelRegistration(registrationId) {
  return one(
    `UPDATE registrations SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *`,
    [registrationId],
  );
}

export function refundRegistration(registrationId) {
  return one(
    `UPDATE registrations SET status = 'refunded', updated_at = now() WHERE id = $1 RETURNING *`,
    [registrationId],
  );
}

export function listForEntrant(entrantId) {
  return many(
    `SELECT r.*, d.name AS division_name, d.fee_mode, c.name AS competition_name, c.slug AS competition_slug
     FROM registrations r
     JOIN divisions d ON d.id = r.division_id
     JOIN competitions c ON c.id = r.competition_id
     WHERE r.entrant_id = $1
     ORDER BY r.created_at DESC`,
    [entrantId],
  );
}

export default {
  RegistrationError,
  register,
  membersOf,
  listForEntrant,
  getRegistration,
  listRegistrations,
  getPaymentByOrderId,
  applyPaymentResult,
  markPaidManually,
  cancelRegistration,
  refundRegistration,
};
