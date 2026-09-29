// 夥伴 ID 的「便利貼」：不印死在程式裡，每天去專案的設定檔看一次今天要貼什麼。
//
// 為什麼：作者哪天跟綠界簽約拿到平台代號，只有重新下載程式的人才會帶上，而本專案
// 刻意不做自動更新。把代號放進遠端設定檔，改一個檔案，已經裝好的每一份隔天自己跟上。
//
// 弄不壞任何東西的三條規則：
//   1. 抓不到設定檔 → 留空，跟沒有這個功能時一模一樣。
//   2. 格式不對的值 → 不用，交易照跑。
//   3. 主辦自己在環境變數填的 → 永遠優先，遠端的不蓋過去。
//
// The "sticky note" for partner IDs: not printed into the code, but read once a day from the
// project's config file.
//
// Why: the day the author signs with a provider and gets a platform id, only people who
// re-download the code would carry it, and this project deliberately does no auto-update. With
// the id in a remote config file, one edit reaches every installed copy the next day.
//
// Three rules so nothing can break:
//   1. Config unreachable → blank, exactly as if the feature did not exist.
//   2. A badly formed value → ignored; the transaction proceeds.
//   3. Whatever the organiser set in the environment always wins over the remote value.

import config from '../config.js';

// 允許的欄位與格式。夥伴代號都是短字串：字母、數字、底線、連字號、點。
// The allowed keys and shape. Partner ids are short strings: letters, digits, _ - and dot.
export const REMOTE_KEYS = Object.freeze([
  'ecpayPlatformId',
  'newebpayPartnerId',
  'paypalBnCode',
  'stripePartnerId',
]);
const SAFE = /^[A-Za-z0-9_.-]{1,64}$/;

// 記在記憶體裡就好：重開機就重抓，抓不到就空的，不需要一張表。
// Held in memory: a restart fetches again, and until then it is blank. No table needed.
let cache = { ids: {}, fetchedAt: null, error: null, source: null };

export function sanitise(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of REMOTE_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && SAFE.test(value.trim())) out[key] = value.trim();
  }
  return out;
}

export function remoteIds() {
  return { ...cache.ids };
}

export function remoteStatus() {
  return {
    enabled: config.payments.remoteIdsEnabled,
    fetchedAt: cache.fetchedAt,
    error: cache.error,
    source: cache.source,
    keys: Object.keys(cache.ids),
  };
}

// 測試用：把快取清掉或塞值。
// For tests: reset or preload the cache.
export function _resetForTests(ids = {}) {
  cache = { ids: sanitise(ids), fetchedAt: ids && Object.keys(ids).length ? new Date() : null, error: null, source: 'test' };
}

export async function refreshRemoteIds({ fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!config.payments.remoteIdsEnabled) {
    cache = { ids: {}, fetchedAt: null, error: null, source: 'disabled' };
    return cache;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(config.telemetry.configUrl, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`config ${response.status}`);
    const json = await response.json();
    // 檔案裡沒有這一段，就當成全部留空。
    // A file without this section means everything stays blank.
    cache = {
      ids: sanitise(json?.partner_ids),
      fetchedAt: new Date(),
      error: null,
      source: config.telemetry.configUrl,
    };
  } catch (err) {
    // 抓不到就沿用上一次抓到的；一次都沒抓到就是空的。永遠不丟例外。
    // Unreachable: keep whatever was fetched last time, or blank if never. Never throws.
    cache = { ...cache, error: err.message };
  } finally {
    clearTimeout(timer);
  }
  return cache;
}

// 開機抓一次，之後每天一次。失敗只記錄，不影響任何人。
// Once on boot, then daily. Failures are logged and affect nobody.
export function scheduleRemoteIds({ log = console } = {}) {
  if (!config.payments.remoteIdsEnabled) return null;
  refreshRemoteIds().then((state) => {
    if (state.error) log.warn?.(`[partner-ids] ${state.error}`);
  });
  const timer = setInterval(() => {
    refreshRemoteIds().then((state) => {
      if (state.error) log.warn?.(`[partner-ids] ${state.error}`);
    });
  }, 24 * 60 * 60 * 1000);
  timer.unref();
  return timer;
}

export default { REMOTE_KEYS, sanitise, remoteIds, remoteStatus, refreshRemoteIds, scheduleRemoteIds, _resetForTests };
