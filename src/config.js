// StageRank 設定。
// 鐵則：金鑰只從主機環境變數讀，絕不寫進程式碼，也絕不寫進資料庫。
// Rule: secrets come from the host environment only. Never hard-code them, never store them in the database.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// 極簡 .env 讀取器，避免多一個相依套件。
// Minimal .env loader so self-hosters do not need an extra dependency.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.resolve(process.cwd(), '.env'));

const env = process.env;
const bool = (v, dflt = false) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));
const int = (v, dflt) => (v === undefined || v === '' ? dflt : Number.parseInt(v, 10));
// 空字串一律視為「沒填」，因為綠界、藍新的平台商代號未簽約時必須留空。
// An empty string means "not set": ECPay/NewebPay platform IDs must stay blank until a contract exists.
const str = (v, dflt = '') => (v === undefined || v.trim() === '' ? dflt : v.trim());

export const config = {
  env: str(env.NODE_ENV, 'development'),
  port: int(env.PORT, 3000),
  baseUrl: str(env.BASE_URL, `http://localhost:${int(env.PORT, 3000)}`),

  // 主辦自己填的兩樣東西：網站名稱與金流金鑰。
  // The two things an organiser fills in: site name and payment keys.
  siteName: str(env.SITE_NAME, 'StageRank'),
  defaultLocale: str(env.DEFAULT_LOCALE, 'zh-TW'),
  currency: str(env.CURRENCY, 'TWD'),
  timezone: str(env.TZ_DISPLAY, 'Asia/Taipei'),

  adminToken: str(env.ADMIN_TOKEN, ''),

  // 報名人登入用的簽章金鑰。沒設就每次啟動隨機產生：安全，但重開機後大家要重新登入。
  // Signs the entrant's login cookie. Left unset it is random per boot: safe, but everyone has
  // to sign in again after a restart.
  sessionSecret: str(env.SESSION_SECRET, '') || randomBytes(32).toString('hex'),

  database: {
    url: str(env.DATABASE_URL, 'postgres://postgres:devpass@127.0.0.1:5432/stagerank'),
    ssl: bool(env.DATABASE_SSL, false),
  },

  // 頁尾標示與統計回報：預設開啟，說明文件請求保留，但不強制。
  // Footer credit and usage reporting: on by default, requested (not enforced) in the docs.
  attribution: {
    showFooter: bool(env.STAGERANK_SHOW_CREDIT, true),
    projectUrl: 'https://github.com/alvanchao/stagerank',
  },
  telemetry: {
    enabled: bool(env.STAGERANK_REPORT_USAGE, true),
    // 回報網址不寫死：先讀 GitHub 上的設定檔，換帳號時舊版也跟著改。
    // The endpoint is not hard-coded: it is read from a config file on GitHub so old installs follow a move.
    configUrl: str(
      env.STAGERANK_TELEMETRY_CONFIG_URL,
      'https://raw.githubusercontent.com/alvanchao/stagerank/main/telemetry.json',
    ),
    endpointOverride: str(env.STAGERANK_TELEMETRY_ENDPOINT, ''),
  },

  payments: {
    // 夥伴 ID 每天去專案設定檔看一次。關掉就只用寫死的值和主辦自己填的。
    // Partner ids are read from the project's config file once a day. Off, only the built-in
    // values and the organiser's own apply.
    remoteIdsEnabled: bool(env.STAGERANK_REMOTE_PARTNER_IDS, true),
    // 夥伴 ID 多點設置的其中一處：整體預設值。
    // One of the several places the partner IDs live: the global defaults.
    partnerDefaults: {
      ecpayPlatformId: str(env.STAGERANK_ECPAY_PLATFORM_ID, ''), // 未簽約必須留空 / must stay blank until contracted
      newebpayPartnerId: str(env.STAGERANK_NEWEBPAY_PARTNER_ID, ''), // 未簽約必須留空 / must stay blank until contracted
      paypalBnCode: str(env.STAGERANK_PAYPAL_BN_CODE, 'StageRank_Cart_PPCP'),
      stripePartnerId: str(env.STAGERANK_STRIPE_PARTNER_ID, ''),
      appName: 'StageRank',
      appVersion: '0.1.0',
      appUrl: 'https://github.com/alvanchao/stagerank',
    },
    ecpay: {
      enabled: bool(env.ECPAY_ENABLED, false),
      sandbox: bool(env.ECPAY_SANDBOX, true),
      merchantId: str(env.ECPAY_MERCHANT_ID, ''),
      hashKey: str(env.ECPAY_HASH_KEY, ''),
      hashIv: str(env.ECPAY_HASH_IV, ''),
    },
    newebpay: {
      enabled: bool(env.NEWEBPAY_ENABLED, false),
      sandbox: bool(env.NEWEBPAY_SANDBOX, true),
      merchantId: str(env.NEWEBPAY_MERCHANT_ID, ''),
      hashKey: str(env.NEWEBPAY_HASH_KEY, ''),
      hashIv: str(env.NEWEBPAY_HASH_IV, ''),
    },
    paypal: {
      enabled: bool(env.PAYPAL_ENABLED, false),
      sandbox: bool(env.PAYPAL_SANDBOX, true),
      clientId: str(env.PAYPAL_CLIENT_ID, ''),
      clientSecret: str(env.PAYPAL_CLIENT_SECRET, ''),
    },
    stripe: {
      enabled: bool(env.STRIPE_ENABLED, false),
      // Stripe 已不允許外掛要求完整權限金鑰，所以請主辦貼受限金鑰 rk_。
      // Stripe no longer lets plugins ask for full secret keys, so organisers paste a restricted key (rk_).
      restrictedKey: str(env.STRIPE_RESTRICTED_KEY, ''),
      webhookSecret: str(env.STRIPE_WEBHOOK_SECRET, ''),
    },
  },
};

export function enabledProviders() {
  return Object.entries(config.payments)
    .filter(([key, value]) => key !== 'partnerDefaults' && value && value.enabled)
    .map(([key]) => key);
}

export default config;
