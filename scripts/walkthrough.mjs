// Tony 的獨立複驗：用真的瀏覽器把「報名 → 付款 → 結算出憑證碼」走一遍，並截圖。
// Independent walkthrough: drive a real browser through registration, payment and settlement, with screenshots.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgres://postgres:devpass@127.0.0.1:5432/stagerank_demo';
process.env.SITE_NAME = '陽光盃國標舞錦標賽';
process.env.BASE_URL = 'http://127.0.0.1:4173';
process.env.PORT = '4173';
process.env.ADMIN_TOKEN = 'demo-token';
process.env.ECPAY_ENABLED = 'true';
process.env.ECPAY_SANDBOX = 'true';
process.env.ECPAY_MERCHANT_ID = '3002607';
process.env.ECPAY_HASH_KEY = 'pwFHCqoQZGmho4w6';
process.env.ECPAY_HASH_IV = 'EkRm7iFT261dpevs';
process.env.STRIPE_ENABLED = 'true';
process.env.STRIPE_RESTRICTED_KEY = 'rk_test_demo';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_demo';

const { migrate, truncateAll } = await import('../src/db/migrate.js');
const { createApp } = await import('../src/app.js');
const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const voucherService = await import('../src/services/voucher.js');
const paymentsLayer = await import('../src/payments/index.js');
const ecpay = (await import('../src/payments/ecpay.js')).default;
const { one, closePool } = await import('../src/db/index.js');

const shotsDir = path.resolve('docs/shots');
fs.mkdirSync(shotsDir, { recursive: true });

await migrate({ log: () => {} });
await truncateAll();

const competition = await comps.createCompetition({
  name: '2026 陽光盃國標舞錦標賽',
  slug: 'sunshine-2026',
  currency: 'TWD',
  feeCents: 1200,
  status: 'open',
});
for (const [i, name] of ['U12 拉丁', 'U15 拉丁', 'U15 摩登', '成人拉丁'].entries()) {
  await comps.addDivision({ competitionId: competition.id, name, sortOrder: i + 1 });
}

const app = createApp();
const server = await new Promise((resolve) => {
  const s = app.listen(4173, '127.0.0.1', () => resolve(s));
});

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const steps = [];

async function shot(page, name, note) {
  const file = path.join(shotsDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  steps.push({ name, note });
  console.log(`  [shot] ${name} — ${note}`);
}

try {
  // 1. 選手用手機報名（繁中）
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: 'zh-TW',
    extraHTTPHeaders: { 'Accept-Language': 'zh-TW,zh;q=0.9' },
  });
  const page = await phone.newPage();

  await page.goto('http://127.0.0.1:4173/');
  await shot(page, '01-home-zh', '選手手機首頁（繁體中文，依瀏覽器語言自動切換）');

  await page.click('text=我要報名');
  await page.waitForLoadState('networkidle');
  await page.fill('#athleteName', '王小明');
  await page.fill('#unitName', '晨光舞蹈教室');
  await page.fill('#athleteEmail', 'ming@example.com');
  const u15Value = await page.$eval('#divisionId', (el) => {
    const match = [...el.options].find((o) => o.textContent.includes('U15 拉丁'));
    return match.value;
  });
  await page.selectOption('#divisionId', u15Value);
  await page.selectOption('#provider', 'ecpay');
  await shot(page, '02-register-zh', '報名表填好，選綠界付款');

  await page.click('button[type=submit]');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  console.log(`  [nav] 送出後到達：${page.url()}`);

  // 2. 英文介面（同一支程式，只換 Accept-Language）
  const enCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: 'en-GB',
    extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' },
  });
  const enPage = await enCtx.newPage();
  await enPage.goto('http://127.0.0.1:4173/c/sunshine-2026');
  await shot(enPage, '03-register-en', '同一頁，瀏覽器語言是英文就自動變英文');

  // 3. 綠界回傳付款成功的通知（驗章過）
  const registration = (await regs.listRegistrations(competition.id))[0];
  const payment = await one('SELECT * FROM payments WHERE registration_id = $1', [registration.id]);
  const settings = paymentsLayer.settingsFor('ecpay');
  const body = {
    MerchantID: settings.merchantId,
    MerchantTradeNo: payment.provider_order_id,
    RtnCode: '1',
    RtnMsg: 'Succeeded',
    TradeNo: '2609220000777',
    TradeAmt: '1200',
    PaymentDate: '2026/09/22 09:10:00',
  };
  body.CheckMacValue = ecpay.checkMacValue(body, settings.hashKey, settings.hashIv);
  const notifyRes = await fetch('http://127.0.0.1:4173/pay/ecpay/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  console.log(`  [notify] 綠界通知回應：${notifyRes.status} ${await notifyRes.text()}`);

  await page.goto(`http://127.0.0.1:4173/r/${registration.id}`);
  await shot(page, '04-receipt-zh', '付款完成後選手看到的畫面');

  // 4. 再加幾位選手，其中一位現場付現
  for (const [name, unit, division] of [
    ['林佳穎', '星光舞蹈', 'U15 拉丁'],
    ['陳柏宇', '晨光舞蹈教室', 'U15 拉丁'],
    ['黃詩涵', '飛揚舞蹈', 'U12 拉丁'],
  ]) {
    const divisions = await comps.listDivisions(competition.id);
    const target = divisions.find((d) => d.name === division);
    const result = await regs.register({
      competitionId: competition.id,
      divisionId: target.id,
      athleteName: name,
      unitName: unit,
      provider: 'ecpay',
    });
    if (name !== '陳柏宇') await regs.markPaidManually(result.registration.id);
  }

  // 5. 主辦後台
  const desktop = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    locale: 'zh-TW',
    extraHTTPHeaders: { 'Accept-Language': 'zh-TW,zh;q=0.9' },
  });
  const admin = await desktop.newPage();
  await admin.goto('http://127.0.0.1:4173/admin');
  await admin.fill('#token', 'demo-token');
  await shot(admin, '05-admin-login', '後台要通行碼；沒設通行碼時後台整個停用');

  await admin.click('button[type=submit]');
  await admin.waitForLoadState('networkidle');
  await shot(admin, '06-admin-index', '後台首頁：比賽清單與金流金鑰狀態（綠界夥伴代號留空）');

  await admin.click(`a[href="/admin/c/${competition.id}"]`);
  await admin.waitForLoadState('networkidle');
  await shot(admin, '07-admin-before-settle', '結算前：一位未付款，憑證碼尚未產生');

  await admin.click('form[action$="/settle"] button');
  await admin.waitForLoadState('networkidle');
  await shot(admin, '08-admin-voucher', '按下結束報名，憑證碼產生（只收已付款的人）');

  const activeVoucher = await voucherService.activeVoucher(competition.id);
  const roster = await voucherService.rosterFor(activeVoucher.code);
  console.log(`  [voucher] ${activeVoucher.code} — ${roster.entries.length} 人 / entries`);
  for (const entry of roster.entries) console.log(`            ${entry.division_name} · ${entry.athlete_name}`);

  const unpaid = (await regs.listRegistrations(competition.id)).find((r) => r.status === 'pending');
  console.log(`  [check] 未付款的「${unpaid.athlete_name}」不在名單裡：${!roster.entries.some((e) => e.athlete_name === unpaid.athlete_name)}`);

  // 6. 深色模式
  const dark = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    locale: 'zh-TW',
    extraHTTPHeaders: { 'Accept-Language': 'zh-TW,zh;q=0.9' },
  });
  const darkPage = await dark.newPage();
  await darkPage.goto('http://127.0.0.1:4173/c/sunshine-2026');
  await shot(darkPage, '09-register-dark', '深色模式（手機常用）');

  fs.writeFileSync(path.join(shotsDir, 'index.json'), JSON.stringify(steps, null, 2));
  console.log(`\n共 ${steps.length} 張截圖，放在 docs/shots/`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await closePool();
}
