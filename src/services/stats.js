// 匿名統計回報。
// Anonymous usage reporting.
//
// 回報的內容：網址、各家金流的交易筆數與金額、比賽場數、夥伴 ID 是否完整。
// 絕對不含選手個資，也絕對不含金流金鑰。唯一的例外是「網站金鑰」：一把只用來證明這個網站是它自己的隨機碼，
// 收集端只存它的雜湊。這個功能在說明文件裡公開寫明。
// What is sent: the site URL, per-provider payment counts and totals, competition count, and whether the
// partner IDs are intact. Never any competitor data, never any payment keys. The one exception is the site key:
// a random code that only proves this site owns its URL; the collector stores just its hash. Documented publicly.
//
// 回報網址不寫死：先讀 GitHub 上的設定檔，日後換帳號時舊版也會跟著改。
// The endpoint is not hard-coded: it is read from a config file on GitHub so old installs follow a move.

import { createHash, randomBytes } from 'node:crypto';
import { one, query } from '../db/index.js';
import config from '../config.js';
import { providerStatus } from '../payments/index.js';

// 回報最多重試幾天，超過就放棄，避免壞掉的網站無限重送。
// How many days a report is retried before it is given up on, so a broken site never resends forever.
export const REPORT_RETRY_DAYS = 14;
const SITE_KEY_SETTING = 'usage.site_key';

// 網站金鑰：第一次用到時產生（24 位元組，base64url，約 192 bits），只存在這個網站自己的資料庫。
// Site key: generated on first use (24 bytes, base64url, ~192 bits) and kept only in this site's own database.
export async function getSiteKey() {
  const found = await one('SELECT value FROM app_settings WHERE key = $1', [SITE_KEY_SETTING]);
  if (found?.value) return found.value;
  const fresh = randomBytes(24).toString('base64url');
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, to_jsonb($2::text), now())
     ON CONFLICT (key) DO NOTHING`,
    [SITE_KEY_SETTING, fresh],
  );
  const row = await one('SELECT value FROM app_settings WHERE key = $1', [SITE_KEY_SETTING]);
  return row.value;
}

export async function siteKeyHash() {
  return createHash('sha256').update(await getSiteKey()).digest('hex');
}

export function buildPayload({ competition, byProvider, voucher }) {
  return {
    schema: 'stagerank.usage.v1',
    app: { name: 'StageRank', version: config.payments.partnerDefaults.appVersion },
    site: { url: config.baseUrl, name: config.siteName },
    competition: {
      // 只送不具辨識性的摘要，連比賽名稱都不送。
      // Only a non-identifying summary; not even the competition's name.
      id_hash: hashId(competition?.id),
      entry_count: voucher?.entry_count ?? 0,
      total_cents: Number(voucher?.total_cents ?? 0),
      currency: competition?.currency || config.currency,
    },
    payments: (byProvider || []).map((row) => ({
      provider: row.provider,
      // 測試還是正式：舊資料沒帶這欄就當成測試，寧可少算也不誤算成真錢。
      // Test or live: absent means test, so nothing is ever counted as real money by mistake.
      sandbox: row.sandbox !== false,
      count: Number(row.count),
      total_cents: Number(row.total_cents),
      with_partner_id: Number(row.with_partner_id),
    })),
    attribution: {
      footer_shown: config.attribution.showFooter,
      partner_ids: Object.fromEntries(providerStatus().map((p) => [p.provider, Boolean(p.partnerId)])),
    },
    reported_at: new Date().toISOString(),
  };
}

function hashId(value) {
  if (value === undefined || value === null) return null;
  // 只是為了讓同一場比賽的重複回報可以合併，不用還原成原本的 id。
  // Only so repeat reports for one competition can be merged; it never needs reversing.
  let hash = 2166136261;
  for (const ch of `${config.baseUrl}#${value}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

// 付款成功後：重新算這場比賽目前的匯總，換掉還沒送出的舊報告（沒有就新增），再在背景試送。
// 同一場比賽用同一個代號，收集端會覆蓋舊的，所以數字永遠是最新的、不會重複計算。
// After a payment: recompute this competition's summary, replace any unsent report (or add one), then try to send.
// The same competition id means the collector overwrites the old figures, so totals are current and never double-counted.
export async function reportAfterPayment(registrationId) {
  if (!config.telemetry.enabled) return null;
  const reg = await one('SELECT competition_id FROM registrations WHERE id = $1', [registrationId]);
  if (!reg) return null;
  const competition = await one('SELECT * FROM competitions WHERE id = $1', [reg.competition_id]);
  const voucher = await one(
    `SELECT COUNT(*)::int AS entry_count, COALESCE(SUM(amount_cents), 0)::bigint AS total_cents
     FROM registrations WHERE competition_id = $1 AND status = 'paid'`,
    [reg.competition_id],
  );
  const { rows: byProvider } = await query(
    `SELECT p.provider, p.sandbox, COUNT(*)::int AS count, COALESCE(SUM(p.amount_cents), 0)::bigint AS total_cents,
            COUNT(*) FILTER (WHERE p.partner_id_sent IS NOT NULL)::int AS with_partner_id
     FROM payments p JOIN registrations r ON r.id = p.registration_id
     WHERE r.competition_id = $1 AND p.status = 'paid' GROUP BY p.provider, p.sandbox`,
    [reg.competition_id],
  );
  const payload = buildPayload({ competition, byProvider, voucher });
  const replaced = await one(
    `UPDATE usage_reports SET payload = $2
     WHERE id = (SELECT id FROM usage_reports WHERE sent_at IS NULL AND payload->'competition'->>'id_hash' = $1 ORDER BY id DESC LIMIT 1)
     RETURNING id`,
    [payload.competition.id_hash, JSON.stringify(payload)],
  );
  if (!replaced) await queueReport(payload);
  return flushReports();
}

export async function queueReport(payload) {
  if (!config.telemetry.enabled) return null;
  return one('INSERT INTO usage_reports (payload) VALUES ($1) RETURNING *', [JSON.stringify(payload)]);
}

export async function resolveEndpoint({ fetchImpl = fetch } = {}) {
  if (config.telemetry.endpointOverride) return config.telemetry.endpointOverride;
  const response = await fetchImpl(config.telemetry.configUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`telemetry config ${response.status}`);
  const json = await response.json();
  if (!json?.endpoint) throw new Error('telemetry config has no endpoint');
  return json.endpoint;
}

// 回報失敗完全不影響比賽，只記下來下次再送。
// A failed report never affects the competition; it is recorded and retried later.
export async function flushReports({ fetchImpl = fetch, limit = 20 } = {}) {
  if (!config.telemetry.enabled) return { sent: 0, failed: 0, skipped: true };

  const { rows } = await query(
    `SELECT * FROM usage_reports
     WHERE sent_at IS NULL AND created_at > now() - make_interval(days => $2)
     ORDER BY created_at LIMIT $1`,
    [limit, REPORT_RETRY_DAYS],
  );
  if (rows.length === 0) return { sent: 0, failed: 0 };

  let endpoint;
  try {
    endpoint = await resolveEndpoint({ fetchImpl });
  } catch (err) {
    await query('UPDATE usage_reports SET attempts = attempts + 1, last_error = $2 WHERE sent_at IS NULL', [
      null,
      `endpoint: ${err.message}`,
    ]);
    return { sent: 0, failed: rows.length, error: err.message };
  }

  const siteKey = await getSiteKey();
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      // 網站金鑰只在送出的當下加上去，不存進待送的紀錄裡。
      // The site key is attached only at send time and never stored with the queued report.
      const body = { ...row.payload, site: { ...row.payload.site, key: siteKey } };
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await query('UPDATE usage_reports SET sent_at = now(), attempts = attempts + 1 WHERE id = $1', [row.id]);
      sent += 1;
    } catch (err) {
      await query('UPDATE usage_reports SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [
        row.id,
        err.message,
      ]);
      failed += 1;
    }
  }
  return { sent, failed };
}

// 後台提示用：最近有沒有被收集端用 403 拒絕（網址可能被認領了，或驗證檔讀不到）。
// For the admin notice: was a recent report refused with 403 (URL possibly claimed, or the proof file unreadable)?
export async function recentlyRefused() {
  const row = await one(
    `SELECT COUNT(*)::int AS n FROM usage_reports
     WHERE sent_at IS NULL AND last_error = 'HTTP 403' AND created_at > now() - make_interval(days => $1)`,
    [REPORT_RETRY_DAYS],
  );
  return row.n > 0;
}

export default { getSiteKey, siteKeyHash, recentlyRefused, buildPayload, reportAfterPayment, queueReport, resolveEndpoint, flushReports };
