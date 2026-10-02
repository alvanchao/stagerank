import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { query, closePool } from './index.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, 'migrations');

export async function migrate({ log = console.log } = {}) {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await query(sql);
    await query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    log(`[migrate] applied ${file}`);
    count += 1;
  }
  if (count === 0) log('[migrate] already up to date');
  return count;
}

// 測試用：把資料清空但保留結構。
// For tests: empty the tables but keep the schema.
export async function truncateAll() {
  await query(`
    TRUNCATE round_decisions, results, scores, heat_judges, judge_assignments, judges,
             heat_entries, heats, round_entries, rounds, division_dances, dances,
             usage_reports, voucher_entries, competition_vouchers,
             registration_members, payments, registrations, athletes, entrants,
             divisions, fee_groups, competitions,
             login_links, app_settings, saved_templates, usage_received
    RESTART IDENTITY CASCADE
  `);
}

const isMain = process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  migrate()
    .then(() => closePool())
    .catch((err) => {
      console.error('[migrate] failed:', err.message);
      process.exitCode = 1;
      return closePool();
    });
}
