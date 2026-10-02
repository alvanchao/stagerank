// StageRank 使用統計收集端（Cloudflare Worker + D1）。
// StageRank usage collector (Cloudflare Worker + D1).
//
// 順序刻意如此：先做不花資料庫的檢查（大小、格式），再做限流，最後才寫入，
// 這樣亂發的垃圾請求不會消耗 D1 的每日額度。
// The order is deliberate: checks that cost no database work (size, format) come first, then rate
// limits, and only then writes, so junk traffic does not burn the D1 daily quota.

export const MAX_BYTES = 20 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// 不相信 Content-Length（可以謊報或用分段傳送），一邊讀一邊計算實際位元組。
// Never trust Content-Length (it can lie, or be absent with chunked bodies); count real bytes as they arrive.
export async function readLimited(request, maxBytes = MAX_BYTES) {
  return readStream(request.body, maxBytes);
}

async function readStream(body, maxBytes) {
  if (!body) return { tooLarge: false, text: '' };
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  return { tooLarge: false, text: new TextDecoder().decode(bytes) };
}

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

// 網址整理成唯一寫法：只留「協定＋主機」，主機小寫、去掉埠、路徑、查詢與結尾斜線。
// 超過長度就拒收，不截斷；帶帳密、IP 位址、沒有點的主機名（localhost 之類）一律拒收。
// Normalise to one spelling: scheme + host only, lower-cased, no default port, path, query or trailing slash.
// Too long is refused, never truncated; credentials, IP literals and dotless hosts (localhost) are refused.
export function normalizeSite(input) {
  let url;
  try { url = new URL(String(input || '')); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname;
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.endsWith('.')) return null;
  const origin = url.origin;
  return origin.length <= 200 ? origin : null;
}

export function validate(body) {
  if (!body || typeof body !== 'object' || body.schema !== 'stagerank.usage.v1') return null;
  const site = normalizeSite(body.site?.url);
  if (!site) return null;
  const key = String(body.site?.key || '');
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(key)) return null;
  // 沒有比賽代號就拒收，不要讓不同比賽擠在同一列互相覆蓋。
  // No competition id means refused, so different competitions never share one row and overwrite each other.
  const hash = String(body.competition?.id_hash || '');
  if (!/^[0-9a-f]{8,32}$/.test(hash)) return null;
  return {
    site,
    hash,
    key,
    clean: {
      schema: body.schema,
      app: { version: String(body.app?.version || '').slice(0, 20) },
      site: { url: site },
      competition: {
        id_hash: hash,
        entry_count: num(body.competition?.entry_count),
        total_cents: num(body.competition?.total_cents),
        currency: String(body.competition?.currency || '').slice(0, 8),
      },
      payments: (Array.isArray(body.payments) ? body.payments.slice(0, 10) : []).map((p) => ({
        provider: String(p?.provider || '').slice(0, 20),
        sandbox: p?.sandbox !== false,
        count: num(p?.count),
        total_cents: num(p?.total_cents),
        with_partner_id: num(p?.with_partner_id),
      })),
    },
  };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 限流：先讀（讀的額度大），超過就直接拒絕、不寫入；沒超過才加一。
// Rate limit: read first (reads are plentiful); over the limit is refused without a write; only then count it.
async function overLimit(db, bucket, limit, windowSec, now) {
  const row = await db.prepare('SELECT window_start, count FROM rate_limit WHERE bucket = ?1').bind(bucket).first();
  const windowStart = Math.floor(now / windowSec) * windowSec;
  return Boolean(row && row.window_start === windowStart && row.count >= limit);
}

async function countHit(db, bucket, windowSec, now) {
  const windowStart = Math.floor(now / windowSec) * windowSec;
  await db
    .prepare(
      `INSERT INTO rate_limit (bucket, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (bucket) DO UPDATE SET
         count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
         window_start = ?2`,
    )
    .bind(bucket, windowStart)
    .run();
}

// 一場比賽的付款只會增加：新的報告不能比舊的少，也不能把正式付款變成沒有。
// A competition's payments only grow: a new report may not show less than the old one, nor drop live payments.
export function regresses(oldClean, newClean) {
  const keyOf = (p) => `${p.provider}|${p.sandbox !== false}`;
  const next = new Map(newClean.payments.map((p) => [keyOf(p), p]));
  for (const old of oldClean.payments) {
    const now = next.get(keyOf(old));
    if (!now) return true;
    if (now.count < old.count || now.total_cents < old.total_cents || now.with_partner_id < old.with_partner_id) return true;
  }
  return false;
}

// 網域驗證：第一次認領時，確認對方網站真的放了這把金鑰的雜湊。只抓這一個固定路徑、設逾時、不跟隨轉址、限制大小。
// Domain verification: on the first claim, check the site really publishes this key's hash. One fixed path,
// a timeout, no redirects, a size cap.
export const WELL_KNOWN = '/.well-known/stagerank-usage.json';

async function siteVerifies(env, site, keyHash) {
  try {
    const doFetch = env.VERIFY_FETCH || fetch;
    const res = await doFetch(site + WELL_KNOWN, {
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
      headers: { accept: 'application/json' },
    });
    if (res.status !== 200) return false;
    const read = await readStream(res.body, 2048);
    if (read.tooLarge) return false;
    return JSON.parse(read.text)?.key_hash === keyHash;
  } catch {
    return false;
  }
}

// 限流表只存 IP 的雜湊，並在每次接受寫入時順手清掉過期的列。
// The rate-limit table stores only a hash of the IP, and expired rows are swept on each accepted write.
async function sweepRateLimit(db, now) {
  await db
    .prepare('DELETE FROM rate_limit WHERE rowid IN (SELECT rowid FROM rate_limit WHERE window_start < ?1 LIMIT 20)')
    .bind(now - 2 * 86400)
    .run();
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch {
      // 資料庫暫時出錯：回 503，StageRank 端會稍後重試；不帶任何內部訊息。
      // Database trouble: 503 so StageRank retries later; no internal detail.
      return json({ ok: false }, 503);
    }
  },
};

async function handle(request, env) {
  if (request.method !== 'POST') return new Response(null, { status: 405 });

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) return json({ ok: false }, 413);
  const read = await readLimited(request);
  if (read.tooLarge) return json({ ok: false }, 413);

  let body;
  try { body = JSON.parse(read.text); } catch { return json({ ok: false }, 400); }
  const v = validate(body);
  if (!v) return json({ ok: false }, 400);

  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const limits = {
    ip: Number(env.LIMIT_IP_PER_MIN || 30),
    site: Number(env.LIMIT_SITE_PER_HOUR || 20),
    day: Number(env.LIMIT_GLOBAL_PER_DAY || 5000),
  };
  // 注意：先讀後加並非原子，同時大量請求可能略超過上限，所以這是「大約」的限流。
  // Note: read-then-count is not atomic, so a burst can slightly exceed a limit; these limits are approximate.
  const ipHash = (await sha256Hex(request.headers.get('cf-connecting-ip') || 'unknown')).slice(0, 16);
  const buckets = [
    [`ip:${ipHash}`, limits.ip, 60],
    [`site:${v.site}`, limits.site, 3600],
    ['global', limits.day, 86400],
  ];
  for (const [bucket, limit, windowSec] of buckets) {
    if (await overLimit(db, bucket, limit, windowSec, now)) return json({ ok: false }, 429);
  }
  // 被拒絕的嘗試只算進這個 IP 的次數，不算進網站或全站的次數：否則有人故意狂送錯的認領，
  // 就能把某個真網站的額度用光。請保持這個性質。
  // Refused attempts count against the IP only, never the site or the global bucket: otherwise someone could
  // deliberately spam bad claims and burn a real site's quota. Keep it that way.
  const refuse = async (status) => { await countHit(db, buckets[0][0], buckets[0][2], now); return json({ ok: false }, status); };

  // 認領網站網址：第一次要先通過網域驗證，之後必須帶同一把金鑰。
  // Claiming a site URL: the first claim must pass domain verification; later reports must carry the same key.
  const keyHash = await sha256Hex(v.key);
  let claimed = await db.prepare('SELECT key_hash FROM site_keys WHERE site_url = ?1').bind(v.site).first();
  if (!claimed) {
    // 第一次認領只接受 https：驗證檔若走明文 http，可能被中間人改寫。
    // Only https can make a first claim: a proof file fetched over plain http could be rewritten in transit.
    if (!v.site.startsWith('https://')) return refuse(403);
    if (!(await siteVerifies(env, v.site, keyHash))) return refuse(403);
    await db.prepare('INSERT OR IGNORE INTO site_keys (site_url, key_hash) VALUES (?1, ?2)').bind(v.site, keyHash).run();
    claimed = await db.prepare('SELECT key_hash FROM site_keys WHERE site_url = ?1').bind(v.site).first();
  }
  if (!claimed || claimed.key_hash !== keyHash) return refuse(403);

  const existing = await db
    .prepare('SELECT payload FROM usage_received WHERE site_url = ?1 AND id_hash = ?2')
    .bind(v.site, v.hash)
    .first();
  if (existing) {
    let old = null;
    try { old = JSON.parse(existing.payload); } catch { /* 壞資料就當沒有 / corrupt row counts as none */ }
    if (old && regresses(old, v.clean)) return refuse(409);
  }

  const payload = JSON.stringify(v.clean);
  await db.batch([
    db
      .prepare(
        `INSERT INTO usage_received (site_url, id_hash, payload) VALUES (?1, ?2, ?3)
         ON CONFLICT (site_url, id_hash) DO UPDATE SET payload = excluded.payload, received_at = datetime('now')`,
      )
      .bind(v.site, v.hash, payload),
    db.prepare('INSERT INTO usage_history (site_url, id_hash, payload) VALUES (?1, ?2, ?3)').bind(v.site, v.hash, payload),
  ]);

  for (const [bucket, , windowSec] of buckets) await countHit(db, bucket, windowSec, now);
  await sweepRateLimit(db, now);
  return json({ ok: true });
}
