// 每場比賽各自的主持人／點錄通行碼。
// Per-competition host and check-in passcodes.

import crypto from 'node:crypto';
import { one, query } from '../db/index.js';

export const ROLES = ['desk', 'checkin', 'host'];

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 沒有容易看錯的 0/O/1/I

function hash(code) {
  return crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
}

function randomCode() {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

// 產生（或重新產生）一組；舊的立刻失效。回傳明文，只此一次。
// Issue or re-issue one code; the old one stops working at once. The plain text is returned once.
export async function issue(competitionId, role) {
  if (!ROLES.includes(role)) throw new Error('unknown staff role');
  const code = randomCode();
  await query(
    `INSERT INTO competition_staff_codes (competition_id, role, code_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (competition_id, role) DO UPDATE SET code_hash = EXCLUDED.code_hash, created_at = now()`,
    [competitionId, role, hash(code)],
  );
  return code;
}

export async function issueAll(competitionId) {
  const codes = {};
  for (const role of ROLES) codes[role] = await issue(competitionId, role);
  return codes;
}

export async function verify(competitionId, role, code) {
  if (!ROLES.includes(role) || !code) return false;
  const row = await one(
    'SELECT code_hash FROM competition_staff_codes WHERE competition_id = $1 AND role = $2',
    [competitionId, role],
  );
  if (!row) return false;
  const a = Buffer.from(row.code_hash);
  const b = Buffer.from(hash(code));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function status(competitionId) {
  const { rows } = await query(
    'SELECT role, created_at FROM competition_staff_codes WHERE competition_id = $1',
    [competitionId],
  );
  return Object.fromEntries(rows.map((r) => [r.role, r.created_at]));
}
