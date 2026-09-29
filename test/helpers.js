// 測試用的共用工具：每個測試檔開頭都先設好環境變數，再載入 config。
// Shared test helpers. Environment variables are set before config is imported.

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://postgres:devpass@127.0.0.1:5432/stagerank_test';
process.env.BASE_URL = 'http://127.0.0.1:0';
process.env.SITE_NAME = 'Test Cup';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.STAGERANK_REPORT_USAGE = 'false';

// 四家金流都開，金鑰用假的但格式正確，這樣測試不必連外網。
// All four providers are enabled with well-formed fake keys, so no test needs the network.
process.env.ECPAY_ENABLED = 'true';
process.env.ECPAY_SANDBOX = 'true';
process.env.ECPAY_MERCHANT_ID = '3002607';
process.env.ECPAY_HASH_KEY = 'pwFHCqoQZGmho4w6';
process.env.ECPAY_HASH_IV = 'EkRm7iFT261dpevs';

process.env.NEWEBPAY_ENABLED = 'true';
process.env.NEWEBPAY_SANDBOX = 'true';
process.env.NEWEBPAY_MERCHANT_ID = 'MS1234567';
process.env.NEWEBPAY_HASH_KEY = 'abcdefghijklmnopqrstuvwxyz012345'; // 32 bytes for AES-256
process.env.NEWEBPAY_HASH_IV = '0123456789abcdef'; // 16 bytes

process.env.PAYPAL_ENABLED = 'true';
process.env.PAYPAL_SANDBOX = 'true';
process.env.PAYPAL_CLIENT_ID = 'test-client-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';

process.env.STRIPE_ENABLED = 'true';
process.env.STRIPE_RESTRICTED_KEY = 'rk_test_abc123';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

const { migrate, truncateAll } = await import('../src/db/migrate.js');
const entrants = await import('../src/services/entrants.js');
const roster = await import('../src/services/athletes.js');

// 報名一律要登入，所以測試需要一個已經登入、名冊裡有人的報名人。
// Entering means signing in, so a test needs an entrant who is signed in and has a roster.
export async function makeEntrant({
  email = 'teacher@example.com',
  password = 'passw0rd!',
  unitName = 'Sunrise Dance',
  people = [{ name: 'Wang Hsiao-ming', birthDate: '2012-05-04' }],
} = {}) {
  const entrant = await entrants.signUp({ email, password, unitName });
  const athletes = [];
  for (const person of people) {
    athletes.push(await roster.addAthlete({ entrantId: entrant.id, ...person }));
  }
  return {
    entrant,
    athletes,
    // 直接做一個登入 cookie：測試要驗的是報名，不是登入表單本身。
    // A ready-made login cookie: these tests are about entering, not about the sign-in form.
    cookie: `${entrants.ENTRANT_COOKIE}=${encodeURIComponent(entrants.makeToken(entrant.id))}`,
  };
}

export async function resetDatabase() {
  await migrate({ log: () => {} });
  await truncateAll();
}

// 起一個真的 HTTP server，用真的 fetch 打，跟使用者的瀏覽器走同一條路。
// Start a real HTTP server and drive it with real fetch, the same path a browser takes.
export async function startServer(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    server,
    close: () => new Promise((resolve) => server.close(resolve)),
    async get(path, options = {}) {
      return fetch(`${base}${path}`, { redirect: 'manual', ...options });
    },
    async postForm(path, fields, options = {}) {
      // 真實瀏覽器送多選欄位是重複同一個欄位名（mark=1&mark=2），不是逗號串起來。
      // A real browser repeats the field name for multi-select values, so the helper must too.
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(fields)) {
        if (Array.isArray(value)) for (const item of value) body.append(key, item);
        else body.append(key, value);
      }
      return fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(options.headers || {}) },
        body: body.toString(),
        redirect: 'manual',
      });
    },
    async postJson(path, body, headers = {}) {
      return fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        redirect: 'manual',
      });
    },
  };
}
