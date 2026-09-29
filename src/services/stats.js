// 匿名統計回報。
// Anonymous usage reporting.
//
// 回報的內容：網址、各家金流的交易筆數與金額、比賽場數、夥伴 ID 是否完整。
// 絕對不含選手個資，也絕對不含金鑰。這個功能在說明文件裡公開寫明。
// What is sent: the site URL, per-provider payment counts and totals, competition count, and whether the
// partner IDs are intact. Never any competitor data, never any keys. This is documented publicly.
//
// 回報網址不寫死：先讀 GitHub 上的設定檔，日後換帳號時舊版也會跟著改。
// The endpoint is not hard-coded: it is read from a config file on GitHub so old installs follow a move.

import { one, query } from '../db/index.js';
import config from '../config.js';
import { providerStatus } from '../payments/index.js';

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
    'SELECT * FROM usage_reports WHERE sent_at IS NULL ORDER BY created_at LIMIT $1',
    [limit],
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

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row.payload),
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

export default { buildPayload, queueReport, resolveEndpoint, flushReports };
