// 夥伴 ID 的便利貼：抓得到就貼、抓不到就留空、格式不對不用、主辦自己填的永遠優先。
// The partner-id sticky note: applied when reachable, blank when not, bad values ignored,
// the organiser's own value always winning.
import './helpers.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const remote = await import('../src/payments/remoteIds.js');
const { partnerIds, partnerIdFor } = await import('../src/payments/partner.js');
const config = (await import('../src/config.js')).default;

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => remote._resetForTests({}));

test('沒有便利貼時就是出廠值 / with no sticky note, the factory defaults apply', () => {
  assert.equal(partnerIdFor('ecpay'), null, 'ECPay stays blank until contracted');
  assert.equal(partnerIdFor('paypal'), 'StageRank_Cart_PPCP');
});

test('簽約那天改設定檔，所有安裝隔天自己跟上 / one edit to the config reaches every install', async () => {
  const fetchImpl = async () => okResponse({
    endpoint: 'https://example.invalid/usage',
    partner_ids: { ecpayPlatformId: 'P12345', newebpayPartnerId: 'NW-777' },
  });
  await remote.refreshRemoteIds({ fetchImpl });

  // 這正是「便利貼」：程式碼一個字沒改，交易就開始帶作者的代號。
  // This is the whole point: not a line of code changed, and requests now carry the id.
  assert.equal(partnerIdFor('ecpay'), 'P12345');
  assert.equal(partnerIdFor('newebpay'), 'NW-777');
  assert.equal(partnerIdFor('paypal'), 'StageRank_Cart_PPCP', 'untouched keys keep their default');
});

test('抓不到設定檔就留空，交易照跑 / unreachable config means blank, and nothing throws', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const state = await remote.refreshRemoteIds({ fetchImpl });
  assert.equal(state.error, 'ECONNREFUSED');
  assert.equal(partnerIdFor('ecpay'), null);
  assert.deepEqual(remote.remoteIds(), {});
});

test('抓不到就沿用上一次抓到的 / when a later fetch fails, the last good values stay', async () => {
  await remote.refreshRemoteIds({ fetchImpl: async () => okResponse({ partner_ids: { ecpayPlatformId: 'P1' } }) });
  await remote.refreshRemoteIds({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  assert.equal(partnerIdFor('ecpay'), 'P1', 'a bad day at GitHub does not blank a working id');
});

test('格式不對的值不用，交易照跑 / a badly formed value is ignored', async () => {
  const fetchImpl = async () => okResponse({
    partner_ids: {
      ecpayPlatformId: 'has spaces and <tags>',
      newebpayPartnerId: 'x'.repeat(200),
      paypalBnCode: 42,
      stripePartnerId: 'pn_ok-1.0',
      somethingElse: 'never read',
    },
  });
  await remote.refreshRemoteIds({ fetchImpl });
  assert.equal(partnerIdFor('ecpay'), null, 'spaces and angle brackets are refused');
  assert.equal(partnerIdFor('newebpay'), null, 'over-long values are refused');
  assert.equal(partnerIdFor('paypal'), 'StageRank_Cart_PPCP', 'a non-string leaves the default alone');
  assert.equal(partnerIdFor('stripe'), 'pn_ok-1.0', 'a well-formed value is applied');
  assert.ok(!('somethingElse' in remote.remoteIds()), 'unknown keys are dropped');
});

test('主辦自己填的永遠優先 / the organiser’s own value always wins', async () => {
  await remote.refreshRemoteIds({ fetchImpl: async () => okResponse({ partner_ids: { ecpayPlatformId: 'AUTHOR' } }) });

  const before = config.payments.partnerDefaults.ecpayPlatformId;
  config.payments.partnerDefaults.ecpayPlatformId = 'ORGANISER';
  try {
    assert.equal(partnerIdFor('ecpay'), 'ORGANISER');
  } finally {
    config.payments.partnerDefaults.ecpayPlatformId = before;
  }
  assert.equal(partnerIdFor('ecpay'), 'AUTHOR', 'with the override gone, the remote value applies');
});

test('關掉就完全不看 / switched off, the config is never consulted', async () => {
  const before = config.payments.remoteIdsEnabled;
  config.payments.remoteIdsEnabled = false;
  try {
    let called = 0;
    await remote.refreshRemoteIds({ fetchImpl: async () => { called += 1; return okResponse({ partner_ids: { ecpayPlatformId: 'P1' } }); } });
    assert.equal(called, 0, 'no request is made');
    assert.equal(partnerIdFor('ecpay'), null);
  } finally {
    config.payments.remoteIdsEnabled = before;
  }
});

test('專案的設定檔本身是合法的 / the shipped config file parses and validates', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const shipped = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'telemetry.json'), 'utf8'));
  assert.ok(shipped.partner_ids, 'the file carries a partner_ids section');
  const ids = remote.sanitise(shipped.partner_ids);
  // 出廠檔案裡綠界和藍新一定要是空的，否則沒簽約的人交易會失敗。
  // The shipped file must leave ECPay and NewebPay blank, or uncontracted sites fail.
  assert.ok(!ids.ecpayPlatformId, 'ECPay blank until contracted');
  assert.ok(!ids.newebpayPartnerId, 'NewebPay blank until contracted');
  assert.equal(ids.paypalBnCode, 'StageRank_Cart_PPCP');
});

test('便利貼上的代號真的進到綠界的請求裡 / the remote id really lands in the ECPay request', async () => {
  const ecpay = (await import('../src/payments/ecpay.js')).default;
  const settings = { merchantId: '3002607', hashKey: 'pwFHCqoQZGmho4w6', hashIv: 'EkRm7iFT261dpevs', sandbox: true };
  const order = { providerOrderId: 'SR1', amountCents: 1200, description: 'd', itemName: 'i' };
  const urls = { notifyUrl: 'https://x/n', returnUrl: 'https://x/r' };

  const before = ecpay.createCheckout({ order, urls, settings });
  assert.equal(before.fields.PlatformID, undefined, 'blank: the field is omitted entirely');
  assert.equal(before.partnerIdSent, null);

  await remote.refreshRemoteIds({ fetchImpl: async () => okResponse({ partner_ids: { ecpayPlatformId: 'P12345' } }) });
  const after = ecpay.createCheckout({ order, urls, settings });
  assert.equal(after.fields.PlatformID, 'P12345');
  assert.equal(after.partnerIdSent, 'P12345', 'and the report records that it was sent');
});
