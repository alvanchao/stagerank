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

function makeMailConfig({ smtpUrl, from, mode }) {
  const resolve = (wanted) => {
    if (wanted === 'smtp') return mail.smtpUrl && mail.from ? 'smtp' : 'off';
    if (wanted === 'memory') return 'memory';
    if (wanted === 'pretend') return 'pretend';
    return 'off';
  };
  const mail = {
    smtpUrl,
    from,
    // 真的 SMTP 優先；沒有才看 MAIL_MODE=memory；否則關閉。
    // Real SMTP wins; otherwise MAIL_MODE=memory; otherwise off.
    mode: smtpUrl && from ? 'smtp' : (mode === 'memory' ? 'memory' : (mode === 'pretend' ? 'pretend' : 'off')),
    // 測試用：在同一個行程裡切換模式，不必重讀環境變數。
    // For tests: switch the mode inside one process without re-reading the environment.
    setMode(next) {
      mail.mode = resolve(next);
    },
    // 假裝寄信：信不會真的寄，驗證碼直接顯示在畫面上。只給測試站，正式比賽前必須關掉。
    // Pretend mail: nothing is sent and the code is shown on screen. For a test site only; switch it off before a real event.
    get pretend() {
      return mail.mode === 'pretend';
    },
    get enabled() {
      return mail.mode !== 'off';
    },
  };
  return mail;
}

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

  // 用 Google 登入主辦後台：只有 ADMIN_EMAILS 名單裡的信箱進得去。
  // Google 只負責證明「你是這個信箱的主人」，比賽資料都還在你自己的資料庫。
  // 沒填 GOOGLE_CLIENT_ID/SECRET 就不會連 Google；GOOGLE_LOGIN_MOCK=true 是「假 Google」，
  // 只給開發與測試，NODE_ENV=production 時一律不啟用。
  // Sign in to the back office with Google. Only emails in ADMIN_EMAILS get in. Google only proves
  // who you are; every competition record stays in your own database. Without GOOGLE_CLIENT_ID/SECRET
  // nothing talks to Google; GOOGLE_LOGIN_MOCK=true is a pretend Google for development and tests
  // and is never honoured when NODE_ENV=production.
  adminEmails: str(env.ADMIN_EMAILS, '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  google: {
    clientId: str(env.GOOGLE_CLIENT_ID, ''),
    clientSecret: str(env.GOOGLE_CLIENT_SECRET, ''),
    // 正式環境（NODE_ENV=production）預設拒絕；測試站要用，必須另外明確設 ALLOW_MOCK_IN_PRODUCTION=true。
    // Refused under NODE_ENV=production unless ALLOW_MOCK_IN_PRODUCTION=true is also set on purpose (a test site).
    mock: bool(env.GOOGLE_LOGIN_MOCK, false)
      && (str(env.NODE_ENV, 'development') !== 'production' || bool(env.ALLOW_MOCK_IN_PRODUCTION, false)),
    get real() { return Boolean(this.clientId && this.clientSecret); },
    get enabled() { return this.real || this.mock; },
  },

  // 報名人登入用的簽章金鑰。沒設就每次啟動隨機產生：安全，但重開機後大家要重新登入。
  // Signs the entrant's login cookie. Left unset it is random per boot: safe, but everyone has
  // to sign in again after a restart.
  sessionSecret: str(env.SESSION_SECRET, '') || randomBytes(32).toString('hex'),

  // 寄信：設了 SMTP_URL 和 MAIL_FROM 就真的寄（nodemailer）；MAIL_MODE=memory 只放在記憶體
  // （開發與測試用，不會真的寄出）；都沒設就關閉，網站照舊用信箱＋密碼登入。
  // 注意 NODE_ENV=test 本身不會打開寄信，測試要用 memory 必須明確設定。
  // Mail: with SMTP_URL and MAIL_FROM mail is really sent (nodemailer); MAIL_MODE=memory keeps it in
  // memory (development and tests, nothing leaves the machine); with neither, mail is off and the
  // site keeps its email + password sign-in. NODE_ENV=test alone does not turn mail on.
  mail: makeMailConfig({
    smtpUrl: str(env.SMTP_URL, ''),
    from: str(env.MAIL_FROM, ''),
    mode: str(env.MAIL_MODE, ''),
  }),

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

  // 收集端：預設關閉。只有專案維護者的那一台伺服器需要打開，用來接收各主辦送來的匿名統計。
  // Collector: off by default. Only the maintainer's own server turns it on, to receive anonymous reports.
  collector: {
    enabled: bool(env.STAGERANK_COLLECTOR, false),
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
      // 選填：PayPal 後台建立 webhook 後的 ID。沒填就不採信 webhook，付款靠回程請款完成。
      // Optional: the id of the webhook created in PayPal. Without it webhooks are not trusted and
      // payment completes through the return capture.
      webhookId: str(env.PAYPAL_WEBHOOK_ID, ''),
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
