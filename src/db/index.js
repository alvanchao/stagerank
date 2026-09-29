import pg from 'pg';
import config from '../config.js';

// 金額一律用整數（最小幣別單位）存，避免浮點誤差。
// Money is stored as integers in the smallest currency unit to avoid float errors.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number.parseInt(v, 10))); // int8

let pool;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.database.url,
      ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
      max: 10,
    });
  }
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

export async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

export async function many(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
