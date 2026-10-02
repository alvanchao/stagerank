// 比賽憑證碼。
// The competition voucher code.
//
// 報名結束時，金流模組把這一場所有已確認收款的報名結算成一份名單，並產生一個憑證碼。
// 後面的背號、秩序表、控場、評分、成績全部要有這個憑證碼才能啟用，沒有就不能作業。
// When registration closes, the payment module settles every confirmed registration into one roster and
// issues a voucher code. Bibs, running order, floor control, judging and results all require it to run.
//
// 老實說：程式是開源的，懂程式的人可以把這道檢查拿掉，技術上擋不住。
// 跟夥伴 ID 一樣，目標是多數人照預設流程走。
// Being honest: this is open source, so anyone who can code can remove the check. Like the partner IDs,
// the aim is that the default path is the one almost everyone takes.

import crypto from 'node:crypto';
import { one, many, withTransaction } from '../db/index.js';
import { getCompetition } from './competitions.js';

export class VoucherError extends Error {
  constructor(key) {
    super(key);
    this.key = key;
    this.name = 'VoucherError';
  }
}

// 全球唯一、隨機、猜不到。24 個字母數字 × 每字 5 bits = 120 bits，撞碼機率可以忽略。
// 字母表刻意拿掉 0/O/1/I，電話裡唸給工作人員也不會聽錯。
// Globally unique, random and unguessable: 24 symbols x 5 bits = 120 bits of entropy.
// The alphabet drops 0/O/1/I so the code can be read aloud to staff without confusion.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 24;
const GROUP_SIZE = 6;

export function generateCode(length = CODE_LENGTH) {
  const buf = crypto.randomBytes(length);
  let out = '';
  for (const byte of buf) out += ALPHABET[byte % ALPHABET.length];
  const groups = [];
  for (let i = 0; i < length; i += GROUP_SIZE) groups.push(out.slice(i, i + GROUP_SIZE));
  return `SR-${groups.join('-')}`;
}

// 結束報名並產生憑證碼。重新結算走的是同一段程式，只是先把舊碼作廢。
// Close registration and issue the voucher. Re-settling runs the same code after revoking the old one.
export async function settle(competitionId, { resettle = false } = {}) {
  const competition = await getCompetition(competitionId);
  if (!competition) throw new VoucherError('errors.notFound');

  // 比賽開始評分之後就不能再重新結算，否則名單會在比賽中途變動。
  // Once judging has started the roster must not move, so re-settling is refused.
  if (resettle && competition.scoring_started_at) throw new VoucherError('admin.cannotResettle');

  return withTransaction(async (client) => {
    await client.query('UPDATE competition_vouchers SET revoked_at = now() WHERE competition_id = $1 AND revoked_at IS NULL', [
      competitionId,
    ]);

    const { rows: entries } = await client.query(
      `SELECT r.id, r.division_id, r.athlete_name, r.unit_name, r.amount_cents
       FROM registrations r JOIN divisions d ON d.id = r.division_id
       WHERE r.competition_id = $1 AND r.status = 'paid'
       ORDER BY d.sort_order, d.id, r.id`,
      [competitionId],
    );

    const totalCents = entries.reduce((sum, entry) => sum + Number(entry.amount_cents), 0);

    let voucher;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const { rows } = await client.query(
          `INSERT INTO competition_vouchers (competition_id, code, entry_count, total_cents)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [competitionId, generateCode(), entries.length, totalCents],
        );
        voucher = rows[0];
        break;
      } catch (err) {
        if (err.code !== '23505') throw err; // 只在極罕見的撞碼時重試 / retry only on the vanishingly rare collision
      }
    }
    if (!voucher) throw new VoucherError('errors.serverError');

    for (const entry of entries) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, registration_id, division_id, athlete_name, unit_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [voucher.id, entry.id, entry.division_id, entry.athlete_name, entry.unit_name],
      );
    }

    await client.query(`UPDATE competitions SET status = 'closed', updated_at = now() WHERE id = $1`, [competitionId]);

    // 產生憑證碼的同時順便排一筆統計回報，一場比賽回報一次，數字最完整。
    // Queue one usage report at the same moment: once per competition, when the numbers are complete.
    const { rows: byProvider } = await client.query(
      `SELECT p.provider, p.sandbox,
              COUNT(*)::int AS count,
              COALESCE(SUM(p.amount_cents), 0)::bigint AS total_cents,
              COUNT(*) FILTER (WHERE p.partner_id_sent IS NOT NULL)::int AS with_partner_id
       FROM payments p JOIN registrations r ON r.id = p.registration_id
       WHERE r.competition_id = $1 AND p.status = 'paid'
       GROUP BY p.provider, p.sandbox`,
      [competitionId],
    );

    return { voucher, entries, totalCents, byProvider };
  });
}

export function activeVoucher(competitionId) {
  return one(
    'SELECT * FROM competition_vouchers WHERE competition_id = $1 AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1',
    [competitionId],
  );
}

export function voucherByCode(code) {
  return one('SELECT * FROM competition_vouchers WHERE code = $1', [code]);
}

export function entriesFor(voucherId) {
  return many(
    `SELECT ve.*, d.name AS division_name
     FROM voucher_entries ve JOIN divisions d ON d.id = ve.division_id
     WHERE ve.voucher_id = $1
     ORDER BY d.sort_order, d.id, ve.id`,
    [voucherId],
  );
}

// 後續模組的入口：先驗憑證碼，再從它對應的名單讀取選手。
// The gate every later module calls: check the code, then read the roster it is bound to.
export async function requireVoucher(code) {
  if (!code) throw new VoucherError('admin.voucherNone');
  const voucher = await voucherByCode(String(code).trim().toUpperCase());
  if (!voucher) throw new VoucherError('admin.voucherNone');
  if (voucher.revoked_at) throw new VoucherError('admin.voucherRevoked');
  return voucher;
}

export async function rosterFor(code) {
  const voucher = await requireVoucher(code);
  return { voucher, entries: await entriesFor(voucher.id) };
}

export default {
  VoucherError,
  generateCode,
  settle,
  activeVoucher,
  voucherByCode,
  entriesFor,
  requireVoucher,
  rosterFor,
};
