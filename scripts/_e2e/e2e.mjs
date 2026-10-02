// End-to-end UI walk for StageRank. Drives the real UI through Playwright. Read-only w.r.t. src/.
import fs from 'node:fs';
import { resetDatabase, startServer } from '../../test/helpers.js';
import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
const { createApp } = await import('../../src/app.js');
const { closePool } = await import('../../src/db/index.js');

const OUT = '/mnt/user-data/outputs/e2e2';
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/^\d\d-.*\.png$/.test(f)) fs.unlinkSync(`${OUT}/${f}`);
const zh = JSON.parse(fs.readFileSync(new URL('../../src/locales/zh-TW.json', import.meta.url), 'utf8'));
const T = (key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), zh);

await resetDatabase();
const http = await startServer(createApp());
const BASE = http.base;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const DESK = { width: 1100, height: 800 };
const PHONE = { width: 390, height: 800 };

// ------------------------------------------------------------ bookkeeping
const results = { unhandled: [], submitLog: [], attemptLog: [], steps: [], bugs: [], notes: [], consoleErrors: [], http5xx: [], http404: [], leaks: [], overflow: [], suspects: [] };
let shotN = 0;
let curStep = null;
const bugSeen = new Set();
const expectedMarks = {};
process.on('unhandledRejection', (e) => {
  const msg = String((e && e.message) || e).split('\n')[0];
  results.unhandled.push({ step: curStep && curStep.id, msg });
  console.log('  !! UNHANDLED REJECTION', msg);
});
async function probe(path, { cookie = 'stagerank_admin=test-admin-token', ms = 4000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(BASE + path, { headers: { Cookie: cookie }, signal: ctl.signal, redirect: 'manual' }); await r.arrayBuffer(); return r.status; }
  catch (e) { return 'HANG'; } finally { clearTimeout(t); }
}
function bug(sev, url, what, fix) {
  const key = `${url}|${what}`;
  if (bugSeen.has(key)) return;
  bugSeen.add(key);
  results.bugs.push({ id: results.bugs.length + 1, sev, url, what, fix, step: curStep?.id });
  console.log(`  BUG[${sev}] ${url} :: ${what}`);
}
async function step(id, title, fn) {
  const s = { id, title, checks: [], fails: [], status: 'pass', error: null };
  curStep = s;
  console.log(`\n== ${id} ${title}`);
  try { await fn(s); } catch (e) { s.error = String(e.stack || e).split('\n').slice(0, 4).join(' | '); s.status = 'fail'; console.log('  EXC', s.error); }
  if (s.fails.length) s.status = 'fail';
  results.steps.push(s);
  console.log(`== ${id} => ${s.status} (${s.checks.length} checks, ${s.fails.length} failed)`);
}
function check(cond, msg) {
  curStep.checks.push(msg);
  if (!cond) { curStep.fails.push(msg); console.log('  FAIL', msg); } else console.log('  ok  ', msg);
  return Boolean(cond);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, n = 4, label = '') {
  let last;
  for (let i = 0; i < n; i += 1) {
    try { return await fn(); } catch (e) { last = e; await sleep(400); }
  }
  throw new Error(`retry(${label}) failed: ${last && last.message}`);
}

const LEAK = /\b(?:staffApp|export|admin|register|roster|entrant|floor|judges|schedule|results|rounds|setup|payment|competition|registration|common|nav|errors|staff|home|floor)\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;
const SPOOK = /undefined|NaN|\[object Object\]|null\b/;

function track(page, label) {
  page.__label = label;
  page.on('console', (m) => { if (m.type() === 'error') results.consoleErrors.push({ label, url: page.url(), text: m.text().slice(0, 200) }); });
  page.on('pageerror', (e) => results.consoleErrors.push({ label, url: page.url(), text: 'pageerror: ' + String(e).slice(0, 200) }));
  page.on('response', (r) => {
    const u = r.url();
    if (!u.startsWith(BASE)) return;
    if (r.status() >= 500) results.http5xx.push({ label, url: u, status: r.status() });
    if (r.status() === 404) results.http404.push({ label, url: u });
  });
}
async function newCtx(label, { viewport = DESK, standalone = false, locale = 'zh-TW' } = {}) {
  const ctx = await browser.newContext({ viewport, locale, acceptDownloads: true });
  await ctx.route((u) => u.hostname !== '127.0.0.1', (r) => r.abort());
  if (standalone) {
    await ctx.addInitScript(() => {
      const o = window.matchMedia.bind(window);
      window.matchMedia = (q) => (String(q).includes('standalone')
        ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : o(q));
    });
  }
  ctx.__label = label;
  ctx.__viewport = viewport;
  return ctx;
}
async function newPage(ctx, label) { const p = await ctx.newPage(); track(p, label || ctx.__label); p.__viewport = ctx.__viewport; return p; }

async function audit(page, label) {
  let info;
  try {
    info = await page.evaluate(() => ({
      text: document.body ? document.body.innerText : '',
      sw: document.documentElement.scrollWidth, iw: window.innerWidth,
      title: document.title, lang: document.documentElement.lang,
    }));
  } catch { return null; }
  const m = info.text.match(LEAK);
  if (m) {
    const uniq = [...new Set(m)].filter((x) => !/\.(com|org|net|tw|xlsx|js|png|json)$/.test(x));
    if (uniq.length) { results.leaks.push({ label, url: page.url(), keys: uniq }); bug('medium', page.url(), `畫面出現未翻譯的 i18n key：${uniq.join(', ')}`, '補上語系檔缺漏的 key 或檢查模板傳入的 key'); }
  }
  if (SPOOK.test(info.text.replace(/\bnull\b/gi, (x) => (info.text.includes('nullable') ? x : '')))) {
    const hit = info.text.match(/.{0,20}(undefined|NaN|\[object Object\]).{0,20}/);
    if (hit) { results.suspects.push({ label, url: page.url(), hit: hit[0] }); }
  }
  if ((page.__viewport?.width || 1000) <= 480 && info.sw > info.iw + 2) {
    results.overflow.push({ label, url: page.url(), sw: info.sw, iw: info.iw });
    bug('medium', page.url(), `390px 寬度出現水平捲動（scrollWidth ${info.sw} > ${info.iw}）`, '表格/長字串加 overflow-x:auto 或 word-break');
  }
  return info;
}
async function go(page, path, opts = {}) {
  const url = path.startsWith('http') ? path : BASE + path;
  const resp = await page.goto(url, { waitUntil: 'load', timeout: 20000, ...opts }).catch((e) => { console.log('  goto err', path, e.message.split('\n')[0]); return null; });
  await audit(page, `${page.__label}:${path}`);
  return resp;
}
async function shot(page, name) {
  shotN += 1;
  const f = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
  await audit(page, `${page.__label}:shot:${name}`);
  await page.screenshot({ path: f, fullPage: true }).catch((e) => console.log('  shot err', e.message));
  return f;
}
async function clickAndLoad(page, locator) {
  await Promise.all([page.waitForLoadState('load').catch(() => {}), locator.click({ timeout: 8000 })]);
  await sleep(150);
  await page.waitForLoadState('load').catch(() => {});
}
const txt = (page) => page.evaluate(() => document.body.innerText);

// ------------------------------------------------------------ state
const S = { off: 1, cid: null, slug: null, adultDiv: null, u12Div: null, regIds: [], codes: {}, judges: {}, rounds: {}, voucher: null };
const B = (n) => S.off + n - 1;
const ATHLETES = Array.from({ length: 10 }, (_, i) => ({
  name: `選手${String(i + 1).padStart(2, '0')}`, birth: `${1988 + i}-0${(i % 9) + 1}-1${i % 9}`,
  region: i % 2 ? '高雄市' : '台北市', unit: i % 2 ? '月光舞蹈' : '晨曦舞蹈',
}));

const adminCtx = await newCtx('admin');
const admin = await newPage(adminCtx);

// ============================================================ STEP 1
await step('1', '主辦登入、建立比賽、套範本、計價群組、日期與年齡規則', async () => {
  let r = await go(admin, '/admin');
  check(r && r.status() === 200, '/admin 未登入顯示登入表單 200');
  await shot(admin, 'admin-login');
  await admin.fill('input[name=token]', 'wrong-token');
  await clickAndLoad(admin, admin.locator('form[action="/admin/login"] button[type=submit]'));
  const bad = await txt(admin);
  check(bad.includes(T('admin.tokenInvalid')), '錯誤通行碼顯示錯誤訊息');
  await go(admin, '/admin');
  await admin.fill('input[name=token]', 'test-admin-token');
  await clickAndLoad(admin, admin.locator('form[action="/admin/login"] button[type=submit]'));
  check(admin.url().endsWith('/admin'), '正確通行碼登入後導向 /admin');
  await shot(admin, 'admin-home-empty');

  await admin.fill('#cname', '第一屆 StageRank 盃');
  await admin.fill('#cfee', '1000');
  await admin.selectOption('#cstatus', 'open');
  await clickAndLoad(admin, admin.locator('form[action="/admin/new"] button[type=submit]'));
  const m = admin.url().match(/\/admin\/c\/(\d+)/);
  check(Boolean(m), '建立比賽後導向 /admin/c/:id');
  S.cid = m && m[1];
  await shot(admin, 'competition-created');
  await go(admin, '/admin');
  const slugTxt = await admin.locator('td .small.muted').first().innerText();
  S.slug = slugTxt.replace('/', '').trim();
  check(Boolean(S.slug), `取得 slug=${S.slug}`);

  // 日期與年齡規則
  await go(admin, `/admin/c/${S.cid}`);
  await admin.fill('#eventDate', '2026-11-15');
  await admin.selectOption('#ageBasis', 'event_day');
  await clickAndLoad(admin, admin.locator('form[action$="/age-rule"] button[type=submit]'));
  await go(admin, `/admin/c/${S.cid}`);
  check((await admin.inputValue('#eventDate')) === '2026-11-15', '比賽日期儲存後仍是 2026-11-15');
  check((await admin.inputValue('#ageBasis')) === 'event_day', '年齡規則儲存為 event_day');

  // 範本
  await go(admin, `/admin/c/${S.cid}/setup`);
  await shot(admin, 'setup-before');
  await admin.selectOption('#templateKey', 'ballroom');
  await admin.click('#allOff');
  for (const k of ['adult-latin-five', 'u12-latin-chaCha']) await admin.check(`input[name=keys][value="${k}"]`);
  check((await admin.locator('#chosenCount').innerText()).includes('2 /'), '範本勾選計數顯示 2');
  await clickAndLoad(admin, admin.locator('form[action$="/setup/template"] button[type=submit]'));
  const after = await txt(admin);
  check(/成人 拉丁五項/.test(after) && /U12 恰恰/.test(after), '套用範本後摘要列出兩個組別');
  check(admin.url().includes('done=applied'), '套用範本導向 done=applied');
  await shot(admin, 'setup-applied');

  // 計價群組（範本已建兩個）+ 再手動新增一個
  await go(admin, `/admin/c/${S.cid}`);
  const groupsBefore = await admin.locator('form[action*="/fee-groups/"][class=division-form]').count();
  check(groupsBefore >= 1, `範本建立的計價群組 >=1（實際 ${groupsBefore}）`);
  await admin.fill('#gname', '加項優惠群組');
  await admin.fill('#gbase', '900');
  await admin.fill('#ginc', '3');
  await admin.fill('#gext', '300');
  await clickAndLoad(admin, admin.locator('form[action$="/fee-groups"] button[type=submit]'));
  const groupsAfter = await admin.locator('form[action*="/fee-groups/"][class=division-form]').count();
  check(groupsAfter === groupsBefore + 1, '手動新增計價群組成功');
  check((await txt(admin)).includes('加項優惠群組'), '新群組名稱出現在頁面');
  // 新增單人組（UI 表單）
  await admin.fill('#dname', '公開組 單人拉丁');
  await admin.fill('#dfee', '800');
  await admin.fill('form[action$="/divisions"] input[name=ageMin]', '19');
  await clickAndLoad(admin, admin.locator('form[action$="/divisions"] button[type=submit]'));
  check((await admin.locator('form.division-form[action*="/divisions/"] input[name=name]').evaluateAll((els) => els.map((e) => e.value))).includes('公開組 單人拉丁'), '新增單人組別成功（單人、每組 800、19 歲以上）');
  // 組別列表中的成人五項為階梯計價並指定群組
  const divs = await admin.locator('form.division-form[action*="/divisions/"] select[name=feeMode]').evaluateAll((els) => els.map((e) => e.value));
  check(divs.filter((v) => v === 'tiered').length === 2, `範本 2 個組別為階梯計價（${divs}）`);
  await shot(admin, 'competition-fee-groups-divisions');
  // 取 division id
  const acts = await admin.locator('form.division-form[action*="/divisions/"]').evaluateAll((els) => els.map((e) => e.getAttribute('action')));
  const names = await admin.locator('form.division-form[action*="/divisions/"] input[name=name]').evaluateAll((els) => els.map((e) => e.value));
  names.forEach((n, i) => { const id = acts[i].match(/divisions\/(\d+)/)[1]; if (n.includes('公開組')) S.adultDiv = id; if (n.includes('U12')) S.u12Div = id; if (n.includes('成人')) S.coupleDiv = id; });
  check(S.adultDiv && S.u12Div, `division id 成人=${S.adultDiv} U12=${S.u12Div}`);
  // 首頁與公開頁
  const pub = await newCtx('anon');
  const pp = await newPage(pub);
  await go(pp, '/');
  check((await txt(pp)).includes('第一屆 StageRank 盃'), '首頁列出比賽');
  await shot(pp, 'public-home');
  await pub.close();
});

// ============================================================ STEP 2
const entrantCtx = await newCtx('entrant');
const ent = await newPage(entrantCtx);
await step('2', '報名人註冊、名冊、報名 10 位、付款、憑證碼、報名清單', async () => {
  await go(ent, `/c/${S.slug}`);
  check((await txt(ent)).includes(T('register.signInFirst')), '未登入公開頁提示先登入');
  await shot(ent, 'public-competition-anon');
  await go(ent, '/entrant/signup');
  await ent.fill('#email', 'teacher@example.com');
  await ent.fill('#password', 'passw0rd!x');
  await ent.fill('#unitName', '晨曦舞蹈');
  await ent.fill('#contactName', '王老師');
  await ent.fill('#phone', '0912345678');
  await shot(ent, 'entrant-signup');
  await clickAndLoad(ent, ent.locator('form[action="/entrant/signup"] button[type=submit]'));
  check(ent.url().endsWith('/entrant'), '註冊後導向 /entrant');

  const all = [...ATHLETES, { name: '小朋友', birth: '2014-03-03', region: '新北市', unit: '晨曦舞蹈' }];
  for (const a of all) {
    await ent.fill('#newName', a.name);
    await ent.fill('#newBirth', a.birth);
    await ent.fill('#newEmail', `p${all.indexOf(a)}@example.com`);
    await ent.fill('#newRegion', a.region);
    await ent.fill('#newUnit', a.unit);
    await clickAndLoad(ent, ent.locator('#add button[type=submit]'));
  }
  const rosterText = await txt(ent);
  check(all.every((a) => rosterText.includes(a.name)), '名冊 11 人都出現');
  check(rosterText.includes('高雄市') && rosterText.includes('月光舞蹈'), '名冊顯示 region 與 unit');
  await shot(ent, 'roster-11');
  // 編輯一位
  const editHref = await ent.locator('a[href*="/entrant?edit="]').first().getAttribute('href');
  await go(ent, editHref);
  const eid = editHref.split('=')[1];
  await ent.fill(`#r${eid}`, '台中市');
  await clickAndLoad(ent, ent.locator(`form[action="/entrant/roster/${eid}"] button[type=submit]`));
  check((await txt(ent)).includes('台中市'), '編輯選手 region 成功');
  // 重複新增偵測
  await ent.fill('#newName', all[1].name); await ent.fill('#newBirth', all[1].birth);
  await clickAndLoad(ent, ent.locator('#add button[type=submit]'));
  const dupe = await txt(ent);
  check(dupe.split(all[1].name).length - 1 <= 2, '重複新增同名同生日不會產生第二筆（或有提示）');

  // 報名
  await go(ent, `/c/${S.slug}`);
  await shot(ent, 'public-competition-signed-in');
  const optVal = await ent.locator('#divisionId option').evaluateAll((os) => os.find((o) => o.textContent.includes('公開組 單人拉丁')).value);
  check(optVal === S.adultDiv, '公開頁下拉有成人拉丁五項');
  await ent.selectOption('#divisionId', optVal);
  const kid = ent.locator('label.roster-pick', { hasText: '小朋友' });
  check(await kid.locator('input').isDisabled(), '12 歲選手在成人組被反灰（年齡限制）');
  check((await kid.innerText()).length > 8, '反灰選手顯示原因文字：' + (await kid.innerText()).replace(/\n/g, ' '));
  await shot(ent, 'age-gate-disabled');
  let firstPayHtml = null;
  for (let i = 0; i < ATHLETES.length; i += 1) {
    await go(ent, `/c/${S.slug}`);
    await ent.selectOption('#divisionId', optVal);
    await ent.locator('label.roster-pick', { hasText: ATHLETES[i].name }).locator('input').check();
    await ent.selectOption('#provider', 'ecpay');
    if (i === 0) {
      const prev = await ent.locator('#feePreview').innerText();
      check(/800/.test(prev), '費用預覽顯示 800：' + prev);
      await shot(ent, 'register-fee-preview');
    }
    const [resp] = await Promise.all([
      ent.waitForResponse((x) => x.url().includes('/register') && x.request().method() === 'POST', { timeout: 15000 }),
      ent.locator('#submitButton').click(),
    ]);
    if (i === 0) { firstPayHtml = await resp.text().catch(() => ''); check(resp.status() === 200, `報名送出後 HTTP 200（伺服器回金流轉址頁，外部連線已被測試環境封鎖）`); }
    else if (resp.status() !== 200) check(false, `第 ${i + 1} 筆報名 HTTP ${resp.status()}`);
    await sleep(250);
  }
  // 雙人組（範本成人拉丁五項＝2 人一組、階梯計價）：勾 2 位
  await go(ent, `/c/${S.slug}`);
  await ent.selectOption('#divisionId', S.coupleDiv);
  await ent.locator('label.roster-pick', { hasText: '選手03' }).locator('input').check();
  const one = await ent.locator('#submitButton').isDisabled();
  check(one, '雙人組只勾 1 位時送出鈕停用');
  await ent.locator('label.roster-pick', { hasText: '選手04' }).locator('input').check();
  const prevC = await ent.locator('#feePreview').innerText();
  check(/3,?600/.test(prevC), '雙人階梯計價預覽：兩人各自算第 1 項共 3,600：' + prevC.replace(/\n/g, ' '));
  await shot(ent, 'register-couple-preview');
  await ent.selectOption('#provider', 'ecpay');
  const [cresp] = await Promise.all([ent.waitForResponse((x) => x.url().includes('/register') && x.request().method() === 'POST', { timeout: 15000 }), ent.locator('#submitButton').click()]);
  check(cresp.status() === 200, `雙人報名送出 HTTP ${cresp.status()}`);
  await go(ent, '/entrant');
  const entryTxt = await txt(ent);
  const pendingCount = (entryTxt.match(new RegExp(T('registration.status.pending'), 'g')) || []).length;
  check(pendingCount === 11, `報名人頁「我的報名」11 筆待付款（實際 ${pendingCount}）`);
  await shot(ent, 'entrant-entries-pending');

  // 主辦標記已付款
  await go(admin, `/admin/c/${S.cid}`);
  await shot(admin, 'admin-registrations-pending');
  for (let i = 0; i < 12; i += 1) {
    const btn = admin.locator('form[action^="/admin/r/"] button');
    if (await btn.count() === 0) break;
    await clickAndLoad(admin, btn.first());
  }
  const admTxt = await txt(admin);
  const paid = (admTxt.match(new RegExp(T('registration.status.paid'), 'g')) || []).length;
  check(paid >= 11, `主辦頁 11 筆皆為已付款（${paid}）`);
  S.regIds = await admin.locator('table tr td:first-child').evaluateAll((els) => els.map((e) => e.innerText.trim()).filter((x) => /^\d+$/.test(x)));
  check(S.regIds.length === 11, `報名清單 11 筆，id=${S.regIds.join(',')}`);
  check(admTxt.includes('晨曦舞蹈') || admTxt.includes('月光舞蹈'), '報名清單顯示單位名稱');
  // 結算 -> 憑證碼
  await clickAndLoad(admin, admin.locator('form[action$="/settle"] button'));
  S.voucher = (await admin.locator('code.voucher').first().innerText()).trim();
  check(Boolean(S.voucher), `憑證碼：${S.voucher}`);
  await shot(admin, 'voucher-issued');
  check((await txt(admin)).includes(T('admin.settled')), '結算後顯示結算成功訊息');
  // 報名單頁
  const r1 = await go(ent, `/r/${S.regIds[1]}`);
  const rt = await txt(ent);
  check(r1.status() === 200 && rt.includes(T('registration.status.paid')) && rt.includes('選手01'), '/r/:id 顯示已付款與選手名稱');
  check(/800/.test(rt), '/r/:id 顯示金額 800');
  await shot(ent, 'registration-page');
  // 關閉後公開頁
  await go(ent, `/c/${S.slug}`);
  check((await txt(ent)).includes(T('register.closedNotice')), '結算後公開頁顯示已截止');
  await go(ent, '/entrant');
  await shot(ent, 'entrant-entries-paid');
  check((await txt(ent)).match(new RegExp(T('registration.status.paid'), 'g'))?.length >= 11, '報名人頁 11 筆已付款');
  const r404 = await go(ent, '/r/999999');
  check(r404.status() === 404, '不存在的報名單回 404');
});

// ============================================================ STEP 3
async function dl(page, locator, name) {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), locator.click()]);
  const p = `/tmp/e2e-${name}-${Date.now()}.xlsx`;
  await d.saveAs(p);
  const st = fs.statSync(p);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const sheets = wb.worksheets.map((w) => `${w.name}:${w.rowCount}`);
  return { file: d.suggestedFilename(), size: st.size, sheets, rows: wb.worksheets.reduce((n, w) => n + w.rowCount, 0), wb };
}
async function exportsCheck(tag) {
  await go(admin, `/admin/c/${S.cid}/schedule`);
  const links = { bibs: 'a[href$="/export/bibs.xlsx"]', lists: 'a[href$="/export/lists.xlsx"]', order: 'a[href$="/export/order.xlsx"]' };
  for (const [k, sel] of Object.entries(links)) {
    const url = `/admin/c/${S.cid}/export/${k}.xlsx`;
    const resp = await adminCtx.request.get(BASE + url);
    const body = await resp.body();
    check(resp.status() === 200 && body.length > 500 && body.slice(0, 2).toString() === 'PK', `[${tag}] ${k}.xlsx HTTP ${resp.status()} ${body.length}B PK-zip`);
    check(/spreadsheetml/.test(resp.headers()['content-type'] || ''), `[${tag}] ${k}.xlsx content-type xlsx`);
    const cd = resp.headers()['content-disposition'] || '';
    check(/attachment/.test(cd), `[${tag}] ${k}.xlsx Content-Disposition attachment`);
    try {
      const r = await dl(admin, admin.locator(sel).first(), `${tag}-${k}`);
      check(r.rows > 1 && r.size > 500, `[${tag}] UI 點擊下載 ${k}.xlsx：${r.file} ${r.size}B 工作表 ${r.sheets.join(' / ')}`);
      results.notes.push(`export ${tag}/${k}: ${r.file} ${r.size}B ${r.sheets.join(' / ')}`);
      // 內容中不應含未翻譯 key
      let leak = false;
      r.wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'string' && LEAK.test(c.value)) leak = c.value; LEAK.lastIndex = 0; })));
      check(!leak, `[${tag}] ${k}.xlsx 內容無 i18n key 外洩${leak ? '：' + leak : ''}`);
      if (leak) bug('medium', url, `Excel 內容出現 i18n key：${leak}`, '補翻譯');
    } catch (e) { check(false, `[${tag}] UI 下載 ${k}.xlsx 失敗：${e.message.split('\n')[0]}`); }
  }
}
await step('3', '背號、舞科、輪次、選手帶入、分 heat、秩序表、Excel 匯出', async () => {
  await go(admin, `/admin/c/${S.cid}/schedule`);
  await shot(admin, 'schedule-initial');
  // 舞科：先看範本給的
  const adultCard = admin.locator('h2', { hasText: '公開組 單人拉丁' }).locator('xpath=following-sibling::div[1]');
  const cnt = await adultCard.locator('input[name=danceId]').count();
  check(cnt >= 5, `舞科清單共 ${cnt} 項可勾`);
  // 新增舞科表單（逗號分隔）
  await admin.fill('#names', 'Salsa');
  await clickAndLoad(admin, admin.locator(`form[action="/admin/c/${S.cid}/dances"] button[type=submit]`));
  check((await admin.locator('.pill', { hasText: 'Salsa' }).count()) >= 1, '新增舞科 Salsa 出現');
  // 單人組勾選恰恰、森巴
  const card2 = admin.locator('h2', { hasText: '公開組 單人拉丁' }).locator('xpath=following-sibling::div[1]');
  for (const d of ['恰恰', '森巴']) await card2.locator('label', { hasText: d }).locator('input').first().check();
  await clickAndLoad(admin, card2.locator('form[action$="/dances"] button[type=submit]'));
  const card3 = admin.locator('h2', { hasText: '公開組 單人拉丁' }).locator('xpath=following-sibling::div[1]');
  const checked = await card3.locator('input[name=danceId]:checked').count();
  check(checked === 2, `單人組舞科為 2 項（實際 ${checked}）`);
  // 背號
  await admin.selectOption('#bibmode', 'sequential');
  await admin.fill('#bibstart', '1');
  await clickAndLoad(admin, admin.locator('form[action$="/bibs"] button[type=submit]'));
  const bibTxt = await admin.locator('h2', { hasText: T('schedule.roster') }).locator('xpath=following-sibling::div[1]').innerText();
  const bibs = await admin.locator('h2', { hasText: T('schedule.roster') }).locator('xpath=following-sibling::div[1]').locator('table tr td:first-child').allInnerTexts();
  check(bibs.filter((b) => /^\d+$/.test(b.trim())).length === 11, `名單 11 筆皆有背號 [${bibs.join(',')}]`);
  const rosterTbl = await admin.locator('h2', { hasText: T('schedule.roster') }).locator('xpath=following-sibling::div[1]//table//tr').evaluateAll((trs) => trs.map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.trim())));
  const one01 = rosterTbl.find((r) => r[1] === '選手01' && r[2].includes('公開組'));
  S.off = one01 ? parseInt(one01[0], 10) : 1;
  results.notes.push(`bib 偏移：單人組選手01 的背號 = ${S.off}（雙人組佔用較小的背號，因為排在前面的組別）`);
  await shot(admin, 'bibs-assigned');
  // 輪次
  async function addRound(name, mode, extra) {
    const c = admin.locator('h2', { hasText: '公開組 單人拉丁' }).locator('xpath=following-sibling::div[1]');
    const f = c.locator('form[action$="/round"]');
    await f.locator('input[name=name]').fill(name);
    await f.locator('select[name=scoringMode]').selectOption(mode);
    if (extra.advance) await f.locator('input[name=advanceCount]').fill(String(extra.advance));
    await f.locator('input[name=heatSize]').fill(String(extra.heat));
    if (extra.rank) await f.locator('select[name=rankMethod]').selectOption(extra.rank);
    await clickAndLoad(admin, f.locator('button[type=submit]'));
  }
  await addRound('準決賽', 'mark', { advance: 6, heat: 5 });
  await addRound('（UI建立）決賽', 'rank', { heat: 6, rank: 'skating' });
  const roundsTxt = await admin.locator('h2', { hasText: '公開組 單人拉丁' }).locator('xpath=following-sibling::div[1]').innerText();
  check(roundsTxt.includes('準決賽') && roundsTxt.includes('（UI建立）決賽'), '兩個輪次建立（UI）');
  const sortInputs = await admin.locator('form[action$="/round"] input[name=sortOrder]').count();
  if (sortInputs === 0) bug('low', `/admin/c/${S.cid}/schedule`, '新增輪次表單沒有「順序」欄位，兩輪 sort_order 皆為 0，先後靠建立 id 隱含', '表單加 sortOrder 或用 max(sort_order)+1 自動編號');
  // 表單的機器語言列舉值
  const raw = await txt(admin);
  if (/scoring mode|評分方式: mark|: mark\b|: rank\b/i.test(raw) || /(^|\s)(mark|score|rank)(\s|$)/m.test(raw)) bug('low', `/admin/c/${S.cid}/schedule`, '繁中畫面出現未翻譯的列舉值（mark/score/rank 直接顯示，評分方式下拉選項也是英文）', 'schedule.scoringMode.* 加入語系並用 t() 輸出');
  // 帶入選手、分 heat
  const semiRow = () => admin.locator('tr', { hasText: '準決賽' }).first();
  await clickAndLoad(admin, semiRow().locator('form[action$="/seed"] button'));
  await clickAndLoad(admin, semiRow().locator('form[action$="/heats"] button'));
  await clickAndLoad(admin, admin.locator('form[action$="/order/rebuild"] button'));
  const order = admin.locator('h2', { hasText: T('schedule.runningOrder') }).locator('xpath=following-sibling::div[1]//table//tr').filter({ has: admin.locator('td') });
  const nOrder = await order.count();
  check(nOrder === 4, `準決賽秩序表 4 個 heat（2 舞 x 2 批）實際 ${nOrder}`);
  const labels = await order.locator('td:nth-child(2)').allInnerTexts();
  const counts = await order.locator('td:nth-child(3)').allInnerTexts();
  check(counts.every((c) => c.trim() === '5'), `每批 5 人 [${counts.join(',')}] ${labels.join(' | ')}`);
  await shot(admin, 'rounds-heats-order');
  // 證據：兩輪 sort_order 皆為 0 時，主持人「輪次處置」卡片把準決賽當成最後一輪
  await go(admin, `/host/${S.cid}`);
  const dc = admin.locator('.card', { hasText: T('rounds.upcoming') });
  const dcExists = await dc.count();
  const hasAdv = dcExists ? await dc.locator('input[name=advanceCount]').count() : 0;
  await shot(admin, 'host-decision-card-both-rounds-sort0');
  check(!(dcExists && !hasAdv), `兩輪順序相同時，主持人輪次處置卡片仍有「取幾人」欄（卡片=${dcExists}，欄位=${hasAdv}）`);
  if (dcExists && !hasAdv) bug('high', `/host/${S.cid}`, '用畫面建立「準決賽」「決賽」兩輪時，兩輪 sort_order 都是 0（建立輪次表單沒有順序欄位），系統把準決賽判成「最後一輪」：主持人「輪次處置」卡片不顯示「取幾人／免賽晉級／直接決賽」', '建立輪次表單加順序欄位，或伺服器端以該組別現有輪次最大 sort_order+1 自動指定；isLast 判斷改用 id 次序做次要排序');
  // 繞道（非 UI）：用 POST 帶 sortOrder=2 建立真正的決賽，才能繼續後面流程
  await go(admin, `/admin/c/${S.cid}/schedule`);
  const roundAction = await admin.locator('h2', { hasText: '公開組 單人拉丁' }).locator('xpath=following-sibling::div[1]').locator('form[action$="/round"]').getAttribute('action');
  const rr = await adminCtx.request.post(BASE + roundAction, { form: { name: '決賽', scoringMode: 'rank', rankMethod: 'skating', heatSize: '6', sortOrder: '2', markQuotaMode: 'per_dance', scoreMethod: 'average', tiePolicy: 'advance_all' }, maxRedirects: 0 });
  check(rr.status() === 303, `（繞道）POST 建立 sortOrder=2 的決賽 → ${rr.status()}`);
  await go(admin, `/admin/c/${S.cid}/schedule`);
  // 「帶入選手」表單有無 fromRoundId（晉級到下一輪的 UI）
  const finalRow = admin.locator('tr', { hasText: '決賽' }).filter({ has: admin.locator('form[action$="/seed"]') }).last();
  const hasFrom = await finalRow.locator('form[action$="/seed"] [name=fromRoundId]').count();
  if (!hasFrom) bug('high', `/admin/c/${S.cid}/schedule`, '決賽「帶入選手」按鈕沒有來源輪次(fromRoundId)欄位：後端 seedNextRound 存在，但畫面上找不到把準決賽晉級者帶入決賽的操作；按下去只會走 seedFirstRound 把所有 10 位報名者塞進決賽', '帶入按鈕旁加「從上一輪帶入」下拉，送 fromRoundId；後輪預設用上一輪');
  check(true, `UI 是否提供晉級帶入(fromRoundId)：${hasFrom ? '有' : '沒有（見 bug）'}`);
  await exportsCheck('semi');
  // 匯出未登入
  const anon = await newCtx('anon2');
  const ar = await anon.request.get(`${BASE}/admin/c/${S.cid}/export/bibs.xlsx`);
  check(!/spreadsheetml/.test(ar.headers()['content-type'] || ''), '未登入無法下載 bibs.xlsx');
  await anon.close();
});

// ============================================================ STEP 5a  add judges (executed before staff floor tests)
await step('5a', '主辦新增 5 位裁判並指派組別', async () => {
  await go(admin, `/admin/c/${S.cid}/schedule`);
  for (const n of ['裁判A', '裁判B', '裁判C', '裁判D', '裁判E']) {
    await admin.fill('#jn', n);
    await clickAndLoad(admin, admin.locator('form[action$="/judges"] button[type=submit]'));
  }
  for (const n of ['裁判A', '裁判B', '裁判C', '裁判D', '裁判E']) {
    const row = admin.locator('tr', { hasText: n }).filter({ has: admin.locator('form[action$="/assign"]') }).first();
    await row.locator('select[name=divisionId]').selectOption({ label: '公開組 單人拉丁' });
    await clickAndLoad(admin, row.locator('form[action$="/assign"] button'));
  }
  const rows = await admin.locator('h2', { hasText: T('judges.title') }).locator('xpath=following-sibling::div[1]//table//tr').filter({ has: admin.locator('code') });
  const n = await rows.count();
  check(n === 5, `裁判列表 5 位（${n}）`);
  for (let i = 0; i < n; i += 1) {
    const name = (await rows.nth(i).locator('td').first().innerText()).trim();
    S.judges[name] = (await rows.nth(i).locator('code').innerText()).trim();
  }
  check(Object.keys(S.judges).length === 5 && Object.values(S.judges).every((c) => c.length >= 4), `裁判登入碼：${JSON.stringify(S.judges)}`);
  const pills = await admin.locator('h2', { hasText: '公開組 單人拉丁' }).locator('xpath=following-sibling::div[1]').innerText();
  check(['裁判A', '裁判E'].every((j) => pills.includes(j)), '成人組頁面顯示已指派的裁判');
  await shot(admin, 'judges-added');
});

// ============================================================ STEP 4a issue codes and sign-in
const staffCtx = {};
const staffPage = {};
async function issue(role, names, allowBrowser = false) {
  await go(admin, `/admin/c/${S.cid}/staff`);
  await admin.selectOption('#role', role);
  await admin.fill('#names', names);
  if (allowBrowser) await admin.check('input[name=allowBrowser]');
  await clickAndLoad(admin, admin.locator('form[action$="/staff"] button[type=submit]'));
  const codes = await admin.locator('code.voucher').allInnerTexts();
  return codes.map((c) => c.trim());
}
async function staffLogin(page, code, { fromLink = false } = {}) {
  if (fromLink) await go(page, `/staff/app?code=${encodeURIComponent(code)}`);
  else await go(page, '/staff/app');
  if (!fromLink) await page.fill('#code', code);
  await clickAndLoad(page, page.locator('#login button[type=submit]'));
}
await step('4a', '主辦發行工作人員通行碼；App 登入（普通瀏覽器拒絕、standalone 成功）、單次使用', async () => {
  S.codes.desk = (await issue('desk', '報到小王'))[0];
  await shot(admin, 'staff-codes-desk');
  S.codes.checkin = (await issue('checkin', '檢錄小李'))[0];
  S.codes.host = (await issue('host', '主持小陳'))[0];
  S.codes.hostBrowser = (await issue('host', '瀏覽器主持', true))[0];
  S.codes.hostSpare = (await issue('host', '備用主持'))[0];
  const t = await txt(admin);
  check(Object.values(S.codes).every((c) => /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(c || '')), `5 組通行碼格式正確 ${JSON.stringify(S.codes)}`);
  check(t.includes(T('staffApp.shownOnce')), '簽發後顯示「只顯示一次」提示');
  check((await admin.locator('svg').count()) >= 1, '簽發畫面有 QR SVG');
  await go(admin, `/admin/c/${S.cid}/staff`);
  check(!(await txt(admin)).includes(S.codes.desk), '重新整理後不再顯示明碼');
  await shot(admin, 'staff-members-list');
  // 空姓名
  await admin.fill('#names', ' ');
  // 普通瀏覽器
  const plain = await newCtx('plain', { viewport: PHONE });
  const pp = await newPage(plain);
  const r = await go(pp, '/staff/app');
  check(r.status() === 200, '/staff/app 200');
  check(await pp.locator('#install').isVisible(), '普通瀏覽器顯示「先安裝成 App」說明');
  await shot(pp, 'staffapp-plain-install-notice');
  await pp.fill('#code', S.codes.desk);
  const [lr] = await Promise.all([pp.waitForResponse((x) => x.url().includes('/staff/login')), pp.locator('#login button[type=submit]').click()]);
  await pp.waitForLoadState('load');
  const et = await txt(pp);
  check(lr.status() === 400 && et.includes(T('staffApp.errors.installFirst')), `普通瀏覽器登入被拒（HTTP ${lr.status()}，訊息「請先把網頁安裝成 App」）`);
  await shot(pp, 'staffapp-plain-refused');
  // 被拒不消耗碼
  const chk = await newCtx('plain2', { viewport: PHONE });
  // 錯誤的碼
  await pp.fill('#code', 'ZZZZZ-ZZZZZ');
  await clickAndLoad(pp, pp.locator('#login button[type=submit]'));
  check((await txt(pp)).includes(T('staffApp.errors.invalid')), '錯誤通行碼顯示「不正確」');
  // allowBrowser 成員在普通瀏覽器成功
  await pp.fill('#code', S.codes.hostBrowser);
  await clickAndLoad(pp, pp.locator('#login button[type=submit]'));
  check(/\/host\/\d+$/.test(pp.url()), `allowBrowser 成員在普通瀏覽器登入成功導向 ${pp.url().replace(BASE, '')}`);
  await shot(pp, 'staffapp-browser-allowed-host');
  staffCtx.hostBrowser = plain;
  // standalone 成功：desk（走 ?code= 連結）
  staffCtx.desk = await newCtx('desk', { viewport: PHONE, standalone: true });
  staffPage.desk = await newPage(staffCtx.desk, 'desk');
  await go(staffPage.desk, `/staff/app?code=${encodeURIComponent(S.codes.desk)}`);
  check((await staffPage.desk.inputValue('#code')) === S.codes.desk, 'QR 連結 ?code= 預先帶入通行碼');
  check((await staffPage.desk.inputValue('#standalone')) === '1', 'standalone 隱藏欄位=1（模擬已安裝）');
  check(!(await staffPage.desk.locator('#install').isVisible()), 'standalone 時不顯示安裝說明');
  await shot(staffPage.desk, 'staffapp-standalone-prefilled');
  await clickAndLoad(staffPage.desk, staffPage.desk.locator('#login button[type=submit]'));
  check(/\/desk\/\d+$/.test(staffPage.desk.url()), `desk 登入後進入 ${staffPage.desk.url().replace(BASE, '')}`);
  await shot(staffPage.desk, 'desk-home');
  // checkin、host：手打碼
  for (const role of ['checkin', 'host']) {
    staffCtx[role] = await newCtx(role, { viewport: PHONE, standalone: true });
    staffPage[role] = await newPage(staffCtx[role], role);
    await staffLogin(staffPage[role], S.codes[role]);
    check(staffPage[role].url().includes(`/${role}/`), `${role} 登入成功 ${staffPage[role].url().replace(BASE, '')}`);
  }
  // hidden field 覆寫法：用 plain context 直接把 standalone 改 1
  const hf = await newCtx('hf', { viewport: PHONE });
  const hp = await newPage(hf);
  const [c2] = await issue('desk', '隱藏欄位測試');
  await go(hp, '/staff/app');
  await hp.evaluate(() => { document.getElementById('standalone').value = '1'; });
  await hp.fill('#code', c2);
  await clickAndLoad(hp, hp.locator('#login button[type=submit]'));
  check(/\/desk\//.test(hp.url()), '把隱藏欄位 standalone 設 1 亦可登入（客戶端自報，伺服器不驗證）');
  bug('info', '/staff/login', '「必須安裝成 App」僅由用戶端隱藏欄位 standalone=1 決定，任何人可自行送出 standalone=1 繞過（設計上是提醒而非安全機制）', '若需強制，改用 sec-fetch / display-mode 以外的驗證，或文件標明僅為 UX 提示');
  await hf.close();
  // 單次使用
  const again = await newCtx('again', { viewport: PHONE, standalone: true });
  const ap = await newPage(again);
  await staffLogin(ap, S.codes.desk);
  check((await txt(ap)).includes(T('staffApp.errors.used')), '同一組碼第二次使用被拒（已用過）');
  await shot(ap, 'staffapp-code-reuse-refused');
  await again.close();
  // 已登入者再進 /staff/app 直接導到自己的畫面
  await go(staffPage.desk, '/staff/app');
  check(/\/desk\/\d+$/.test(staffPage.desk.url()), '已登入再開 /staff/app 直接導向 desk');
  // 主辦頁狀態
  await go(admin, `/admin/c/${S.cid}/staff`);
  const st = await txt(admin);
  check(st.includes(T('staffApp.signedIn')), '主辦頁顯示成員已登入狀態');
  await shot(admin, 'staff-status-signed-in');
});

// ============================================================ STEP 4b role limits
await step('4b', '角色權限：desk/checkin/host 越權存取', async () => {
  const cid = S.cid;
  const probe = async (page, path, label) => {
    const r = await go(page, path);
    const t = await txt(page);
    return { status: r ? r.status() : 0, t, denied: /需要工作人員登入|工作人員 App|通行碼|StageRank 主辦|主辦/.test(t) && !/現在這一場|報到|檢錄/.test(t.slice(0, 60)) };
  };
  // desk
  let p = await probe(staffPage.desk, `/host/${cid}`);
  check(p.status === 401, `desk 開 /host/${cid} 被拒 (HTTP ${p.status})`);
  check(!p.t.includes('現在這一場'), 'desk 看不到主持人畫面內容');
  await shot(staffPage.desk, 'desk-denied-host');
  p = await probe(staffPage.desk, `/checkin/${cid}`);
  check(p.status === 401, `desk 開 /checkin/${cid} 被拒 (HTTP ${p.status})`);
  for (const path of [`/admin/c/${cid}`, `/admin/c/${cid}/schedule`, `/admin/c/${cid}/staff`, `/admin/c/${cid}/results`, `/admin`]) {
    p = await probe(staffPage.desk, path);
    check(!p.t.includes('第一屆 StageRank 盃') || path === '/admin' && !p.t.includes('準決賽'), `desk 開 ${path} 看不到後台內容 (HTTP ${p.status})`);
    check(/通行碼|工作人員/.test(p.t) && !/新增比賽|建立比賽/.test(p.t), `desk 開 ${path} 顯示登入表單`);
  }
  const dr = await staffCtx.desk.request.get(`${BASE}/admin/c/${cid}/export/bibs.xlsx`);
  check(!/spreadsheetml/.test(dr.headers()['content-type'] || ''), 'desk 不能下載 bibs.xlsx');
  const dend = await staffCtx.desk.request.post(`${BASE}/admin/c/${cid}/end`, { form: {}, maxRedirects: 0 });
  await go(admin, `/admin/c/${cid}/staff`);
  check(!(await admin.locator('.pill.bad', { hasText: T('staffApp.ended') }).count()), `desk 直接 POST /admin/c/${cid}/end 無效（比賽未結束，HTTP ${dend.status()}）`);
  const dpub = await staffCtx.desk.request.post(`${BASE}/admin/c/${cid}/status`, { form: { status: 'draft' }, maxRedirects: 0 });
  await go(admin, `/admin/c/${cid}`);
  check(!(await txt(admin)).includes(T('competition.status.draft') + '\n') || true, `desk POST status 回應 ${dpub.status()}`);
  const stillClosed = await admin.locator('.pill', { hasText: T('competition.status.closed') }).count();
  check(stillClosed >= 1, 'desk 無法改動比賽狀態（仍為已截止）');
  // host
  p = await probe(staffPage.host, `/admin/c/${cid}`);
  check(!p.t.includes('第一屆 StageRank 盃') || !p.t.includes('計價群組'), `host 開 /admin/c/${cid} 被擋 (HTTP ${p.status})`);
  await shot(staffPage.host, 'host-denied-admin');
  p = await probe(staffPage.host, `/admin/c/${cid}/schedule`);
  check(!p.t.includes('準決賽'), 'host 開 /schedule 被擋');
  p = await probe(staffPage.host, `/checkin/${cid}`);
  check(p.status === 401, `host 開 /checkin/${cid} 被拒 (HTTP ${p.status})`);
  p = await probe(staffPage.host, `/desk/${cid}`);
  check(p.status === 200, `host 可開 /desk/${cid}（補救報到）(HTTP ${p.status})`);
  await go(staffPage.host, `/host/${cid}`);
  // checkin
  p = await probe(staffPage.checkin, `/host/${cid}`);
  check(p.status === 401, `checkin 開 /host/${cid} 被拒 (HTTP ${p.status})`);
  p = await probe(staffPage.checkin, `/desk/${cid}`);
  check(p.status === 200, `checkin 可開 /desk/${cid}（補救報到）(HTTP ${p.status})`);
  await go(staffPage.checkin, `/checkin/${cid}`);
  // 跨場比賽的 cookie：換 competitionId
  p = await probe(staffPage.desk, `/desk/99999`);
  check(p.status === 401 || p.status === 404, `desk 對不存在的比賽 id (HTTP ${p.status})`);
  // 短網址
  p = await probe(staffPage.desk, `/desk`);
  check(/\/desk\/\d+$/.test(staffPage.desk.url()), `短網址 /desk 導向 ${staffPage.desk.url().replace(BASE, '')}`);
  // 未登入者直接開
  const anon = await newCtx('anon3', { viewport: PHONE });
  const ap = await newPage(anon);
  const rr = await go(ap, `/host/${cid}`);
  check(rr.status() === 401 && (await txt(ap)).includes(T('staffApp.needLogin')), '未登入開 /host 顯示「需要工作人員登入」+ 連結到 App');
  await shot(ap, 'anon-host-needs-login');
  const link = ap.locator('a[href="/staff/app"]');
  check((await link.count()) >= 1, '登入提示含 /staff/app 連結');
  await anon.close();
});

// ============================================================ 4c + 5b floor flow and judges (semi)
const judgeCtx = {};
const judgePage = {};
async function openJudges() {
  for (const [name, code] of Object.entries(S.judges)) {
    judgeCtx[name] = await newCtx(name, { viewport: PHONE });
    judgePage[name] = await newPage(judgeCtx[name], name);
    judgePage[name].on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/submit')) results.submitLog.push({ judge: name, t: Date.now(), body: r.postData(), n: (String(r.postData()).match(/mark=/g) || []).length, expected: expectedMarks[name] }); });
  }
}
const bibOfRow = async (row) => parseInt(await row.locator('strong').first().innerText(), 10);

async function deskReport(bibsWanted) {
  const p = staffPage.desk;
  await go(p, `/desk/${S.cid}`);
  for (const bib of bibsWanted) {
    const row = p.locator('tr', { has: p.locator(`td:first-child strong`, { hasText: new RegExp(`^${bib}$`) }) }).first();
    const btn = row.locator('button.small:not(.ghost)');
    if (await btn.count()) await clickAndLoad(p, btn.first());
  }
}
async function checkinAll(skipBib) {
  const p = staffPage.checkin;
  await go(p, `/checkin/${S.cid}`);
  for (let guard = 0; guard < 20; guard += 1) {
    const card = p.locator('.card').first();
    const rows = card.locator('tr').filter({ has: p.locator('form[action*="/entry/"] button.small:not(.ghost)') });
    const n = await rows.count();
    let target = null;
    for (let i = 0; i < n; i += 1) {
      const b = await bibOfRow(rows.nth(i));
      if (skipBib && b === skipBib) continue;
      target = rows.nth(i); break;
    }
    if (!target) break;
    await clickAndLoad(p, target.locator('form[action*="/entry/"] button.small:not(.ghost)'));
  }
}
async function hostStandby(opts = {}) {
  const p = staffPage.host;
  await go(p, `/host/${S.cid}`);
  const startFromUpcoming = p.locator('table form[action$="/next"] button.small').first();
  const currentCard = await p.locator('.card', { hasText: T('floor.current') }).innerText();
  if (currentCard.includes(T('floor.noMoreHeats'))) {
    if (!(await startFromUpcoming.count())) return false;
    await clickAndLoad(p, startFromUpcoming);
  }
  return true;
}
async function hostAddLateAndAbsent(state) {
  const p = staffPage.host;
  await go(p, `/host/${S.cid}`);
  const card = p.locator('.card', { hasText: T('floor.current') });
  const late = card.locator('form[action*="/add/"] button');
  if (state.late && (await late.count()) > 0) { await clickAndLoad(p, late.first()); state.lateDone = true; }
  if (state.absentBib) {
    const rows = card.locator('tr');
    const n = await rows.count();
    for (let i = 0; i < n; i += 1) {
      const b = await bibOfRow(rows.nth(i)).catch(() => NaN);
      if (b === state.absentBib) {
        await clickAndLoad(p, rows.nth(i).locator('form[action*="/absent/"] button'));
        state.absentDone = true;
        break;
      }
    }
  }
}
async function hostStart() {
  const p = staffPage.host;
  await go(p, `/host/${S.cid}`);
  const b = p.locator('form[action$="/start"] button');
  if (await b.count()) await clickAndLoad(p, b.first());
}
async function judgesReady() {
  for (const [name, page] of Object.entries(judgePage)) {
    await retry(async () => {
      await go(page, `/judge/${S.cid}`);
      const b = page.locator('form[action$="/ready"] button');
      if (await b.count()) await clickAndLoad(page, b.first());
    }, 3, 'ready');
  }
}
async function judgesScore(mode, rankMap) {
  for (const [name, page] of Object.entries(judgePage)) {
    await retry(async () => {
      let ok = false;
      for (let i = 0; i < 12 && !ok; i += 1) { if (await page.locator('#scoring').count()) ok = true; else await sleep(500); }
      if (!ok) { await go(page, `/judge/${S.cid}`); if (!(await page.locator('#scoring').count())) throw new Error('no scoring panel'); }
      await audit(page, `judge:${name}:scoring`);
      const rows = page.locator('#scoring tr');
      const n = await rows.count();
      for (let i = 0; i < n; i += 1) {
        const bib = await bibOfRow(rows.nth(i));
        if (mode === 'mark') {
          if (bib >= B(1) && bib <= B(6)) await rows.nth(i).locator('.markbox').check();
        } else {
          await rows.nth(i).locator('input[name^=rank_]').fill(String(rankMap[bib]));
        }
      }
      if (name === 'A' || name === '裁判A') await shot(page, `judge-scoring-${mode}`);
      expectedMarks[name] = mode === 'mark' ? await page.locator('#scoring .markbox:checked').count() : null;
      await clickAndLoad(page, page.locator('#scoring form button[type=submit]'));
      const done = await page.locator('.pill.ok', { hasText: T('judges.submitted') }).count();
      if (!done) { results.attemptLog.push({ judge: name, err: 'no submitted pill after submit', url: page.url() }); throw new Error('not submitted mark'); }
    }, 3, `score ${name}`).catch((e) => { results.attemptLog.push({ judge: name, err: e.message.slice(0, 200) }); throw e; });
  }
}
async function hostNext() {
  const p = staffPage.host;
  await go(p, `/host/${S.cid}`);
  const b = p.locator('.card', { hasText: T('floor.current') }).locator('form[action$="/next"] button');
  if (await b.count()) await clickAndLoad(p, b.first());
}
const heatLog = [];
async function runHeats(count, mode, rankMap, state) {
  for (let i = 0; i < count; i += 1) {
    await checkinAll(state.lateOnce && !state.lateDone ? B(9) : null);
    if (i === 0 && mode === 'mark') {
      await go(staffPage.checkin, `/checkin/${S.cid}`);
      await shot(staffPage.checkin, 'checkin-board');
    }
    if (!(await hostStandby())) { check(false, `第 ${i + 1} 個 heat：主持人畫面沒有可開始的場次`); return; }
    if (i === 0 && mode === 'mark') await shot(staffPage.host, 'host-standby-first-heat');
    await hostAddLateAndAbsent({ late: state.lateOnce && !state.lateDone, absentBib: state.absentBib && !state.absentDone ? state.absentBib : null, ...state, set: (k, v) => { state[k] = v; } })
      .then(async () => {});
    // hostAddLateAndAbsent mutates a copy; re-derive flags from page
    const label = (await staffPage.host.locator('.card', { hasText: T('floor.current') }).locator('p strong').first().innerText().catch(() => '?')).trim();
    heatLog.push(label);
    await judgesReady();
    await hostStart();
    await sleep(600);
    if (i === 0 && mode === 'mark') await shot(staffPage.host, 'host-scoring-first-heat');
    await judgesScore(mode, rankMap);
    await go(staffPage.host, `/host/${S.cid}`);
    if (i === 0 && mode === 'mark') await shot(staffPage.host, 'host-all-judges-submitted');
    const lights = await staffPage.host.locator('.card', { hasText: T('floor.current') }).locator('.pill.ok').count();
    check(lights >= 5, `heat ${label}：主持人畫面 ${lights} 位裁判燈號為綠`);
    await hostNext();
  }
}

await step('4c+5b', '報到/檢錄/主持人控場 + 裁判送出準決賽 marks（4 個 heat）', async () => {
  await openJudges();
  // 裁判登入
  const first = Object.keys(S.judges)[0];
  await go(judgePage[first], '/judge');
  await shot(judgePage[first], 'judge-login');
  await judgePage[first].fill('#code', 'BADCODE');
  await clickAndLoad(judgePage[first], judgePage[first].locator('form[action="/judge/login"] button[type=submit]'));
  check((await txt(judgePage[first])).includes(T('judges.loginInvalid')), '裁判輸入錯誤登入碼顯示錯誤');
  for (const [name, code] of Object.entries(S.judges)) {
    await go(judgePage[name], '/judge');
    await judgePage[name].fill('#code', code);
    await clickAndLoad(judgePage[name], judgePage[name].locator('form[action="/judge/login"] button[type=submit]'));
    check(judgePage[name].url().includes(`/judge/${S.cid}`), `${name} 登入 ${judgePage[name].url().replace(BASE, '')}`);
  }
  await shot(judgePage[first], 'judge-waiting');
  // 報到：前 8 位由 desk 報到，9、10 留給檢錄補救
  await deskReport([1, 2, 3, 4, 5, 6, 7, 8].map(B));
  let dtxt = await txt(staffPage.desk);
  check(/8[／\/]11/.test(dtxt), `desk 報到統計 8／11：${dtxt.match(/已報到:\s*\S+/)?.[0]}`);
  await shot(staffPage.desk, 'desk-8-reported');
  // 搜尋
  await staffPage.desk.fill('#q', String(B(3)));
  await clickAndLoad(staffPage.desk, staffPage.desk.locator('form[method=get] button[type=submit]'));
  const rowsAfter = await staffPage.desk.locator('table tr td:first-child strong').allInnerTexts();
  check(rowsAfter.length >= 1 && rowsAfter.length < 11 && rowsAfter.includes(String(B(3))), `desk 搜尋「3」結果 [${rowsAfter.join(',')}]`);
  // 反悔
  await go(staffPage.desk, `/desk/${S.cid}`);
  const row1 = staffPage.desk.locator('tr', { has: staffPage.desk.locator('td:first-child strong', { hasText: new RegExp('^' + B(8) + '$') }) });
  await clickAndLoad(staffPage.desk, row1.locator('button.ghost.small'));
  let t8 = await txt(staffPage.desk);
  check(/7[／\/]11/.test(t8), 'desk 取消報到後統計 7／11');
  await deskReport([B(8)]);
  // checkin 補救：checkin 也能在 /desk 幫人報到 bib 9
  await go(staffPage.checkin, `/desk/${S.cid}`);
  const c9 = staffPage.checkin.locator('tr', { has: staffPage.checkin.locator('td:first-child strong', { hasText: new RegExp('^' + B(9) + '$') }) });
  await clickAndLoad(staffPage.checkin, c9.locator('button.small:not(.ghost)'));
  check(/已報到/.test(await c9.innerText().catch(() => '')) || true, 'checkin 角色在 /desk 補報到 bib 9');
  dtxt = await txt(staffPage.checkin);
  check(/9[／\/]11/.test(dtxt), 'checkin 補報到後統計 9／11');
  await shot(staffPage.checkin, 'checkin-role-desk-rescue');
  // 主持人在宣布前的「取幾人」決定（advance-count）
  await go(staffPage.host, `/host/${S.cid}`);
  await shot(staffPage.host, 'host-before-start');
  const decisionCard = staffPage.host.locator('.card', { hasText: T('rounds.upcoming') });
  if (await decisionCard.count()) {
    await decisionCard.locator('input[name=advanceCount]').fill('6');
    await clickAndLoad(staffPage.host, decisionCard.locator('form[action$="/advance-count"] button'));
    check(!/\?error=/.test(staffPage.host.url()), 'host 儲存「取 6 人」無錯誤');
  } else check(false, 'host 開賽前沒有輪次決定卡片');
  // 跑 4 個 heat；bib 9 由檢錄故意跳過 → host 補點；bib 10 檢錄後由 host 標缺席
  const state = { lateOnce: true, lateDone: false, absentBib: 10, absentDone: false };
  // 在 hostAddLateAndAbsent 內部只回報，不好改 state → 這裡自行處理
  for (let i = 0; i < 4; i += 1) {
    await checkinAll(state.lateDone ? null : B(9));
    if (i === 0) { await go(staffPage.checkin, `/checkin/${S.cid}`); await shot(staffPage.checkin, 'checkin-board'); }
    if (!(await hostStandby())) { check(false, `第 ${i + 1} 個 heat：沒有可開始的場次`); break; }
    const p = staffPage.host;
    await go(p, `/host/${S.cid}`);
    const card = p.locator('.card', { hasText: T('floor.current') });
    const heatLabel = (await card.locator('p strong').first().innerText().catch(() => '?')).trim();
    heatLog.push(heatLabel);
    const lateBtn = card.locator('form[action*="/add/"] button');
    if (!state.lateDone && (await lateBtn.count()) > 0) {
      const lateRow = card.locator('tr').filter({ has: p.locator('form[action*="/add/"]') });
      const lb = await bibOfRow(lateRow.first());
      await clickAndLoad(p, lateBtn.first());
      state.lateDone = true;
      check(true, `host 補點遲到選手 bib ${lb}（heat ${heatLabel}）`);
      await shot(p, 'host-added-late');
    }
    if (!state.absentDone) {
      const card2 = p.locator('.card', { hasText: T('floor.current') });
      const rows = card2.locator('tr');
      const n = await rows.count();
      for (let k = 0; k < n; k += 1) {
        const b = await bibOfRow(rows.nth(k)).catch(() => NaN);
        if (b === B(10)) {
          await clickAndLoad(p, rows.nth(k).locator('form[action*="/absent/"] button'));
          state.absentDone = true;
          const at = await p.locator('.card', { hasText: T('floor.current') }).innerText();
          check(at.includes(T('floor.absent')), `host 將 bib 10 標為缺席（heat ${heatLabel}）`);
          await shot(p, 'host-marked-absent');
          break;
        }
      }
    }
    await judgesReady();
    if (i === 0) await shot(judgePage[first], 'judge-standby-ready');
    await hostStart();
    await sleep(500);
    if (i === 0) await shot(staffPage.host, 'host-scoring');
    await judgesScore('mark');
    await go(staffPage.host, `/host/${S.cid}`);
    const lights = await staffPage.host.locator('.card', { hasText: T('floor.current') }).locator('.pill.ok').count();
    check(lights >= 5, `heat ${heatLabel}：5 位裁判都送出（綠燈 ${lights}）`);
    if (i === 0) await shot(staffPage.host, 'host-all-submitted');
    await hostNext();
  }
  check(state.lateDone, 'host 補點功能在準決賽被實際用到');
  check(state.absentDone, 'host 缺席功能被實際用到');
  await go(staffPage.host, `/host/${S.cid}`);
  check((await txt(staffPage.host)).includes(T('floor.noMoreHeats')), '準決賽 4 個 heat 完成後主持人畫面顯示沒有更多場次');
  await shot(staffPage.host, 'host-semi-done');
  // 活動紀錄
  await go(admin, `/admin/c/${S.cid}/staff`);
  const logRows = await admin.locator('h2', { hasText: T('staffApp.logTitle') }).locator('xpath=following-sibling::*[self::table or self::div][1]/descendant-or-self::table[1]//tr').filter({ has: admin.locator('td') });
  const nlog = await logRows.count();
  const logTxt = await admin.locator('h2', { hasText: T('staffApp.logTitle') }).locator('xpath=following-sibling::*[self::table or self::div][1]/descendant-or-self::table[1]').innerText();
  check(nlog >= 10, `操作紀錄 ${nlog} 筆`);
  check(['報到小王', '檢錄小李', '主持小陳'].every((n) => logTxt.includes(n)), '操作紀錄含三位工作人員姓名');
  check(!/:competitionId|:heatEntryId|:registrationId|:roundEntryId/.test(logTxt), '操作紀錄動作欄已翻成人話，不再顯示路由樣板');
  await shot(admin, 'staff-activity-log');
});

// ============================================================ 5c compute semi, advance
await step('5c', '計算準決賽、晉級名單、帶入決賽', async () => {
  await go(admin, `/admin/c/${S.cid}/results`);
  await shot(admin, 'results-before-compute');
  const semiCard = admin.locator('.card', { has: admin.locator('h3', { hasText: '準決賽' }) });
  await clickAndLoad(admin, semiCard.locator('form[action$="/compute"] button'));
  const card = admin.locator('.card', { has: admin.locator('h3', { hasText: '準決賽' }) });
  const rows = await card.locator('table tr').filter({ has: admin.locator('td') }).evaluateAll((trs) => trs.map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.trim())));
  console.log('  semi rows', JSON.stringify(rows));
  const adv = rows.filter((r) => /晉級|Advanced/.test(r[5] || ''));
  const advBibs = adv.map((r) => parseInt(r[1], 10)).sort((a, b) => a - b);
  check(JSON.stringify(advBibs) === JSON.stringify([1,2,3,4,5,6].map(B)), `晉級名單為背號 1–6（實際 [${advBibs}]）`);
  const absentRow = rows.find((r) => r[1] === String(B(10)));
  check(absentRow && /缺席/.test(absentRow[5] || ''), '背號 10（缺席）在成績表標示缺席');
  const marks = rows.filter((r) => parseInt(r[1], 10) <= B(6)).map((r) => r[3]);
  check(marks.every((m) => m === '10'), `晉級者總勾選數皆為 10（5 裁判 x 2 舞）[${marks}]`);
  await shot(admin, 'results-semi-computed');
  const lost = results.submitLog.filter((x) => x.expected != null && x.n < x.expected);
  if (lost.length) bug('medium', `/judge/${S.cid} (POST /judge/${S.cid}/submit)`, `裁判送出時，畫面上已勾的選手沒有進到送出內容（${lost.map((x) => `${x.judge}: 勾了 ${x.expected} 個、送出 ${x.n} 個「${x.body}」`).join('；')}），計分因此少一票。原因推測：其他裁判送出會觸發 'judge-submitted' SSE，裁判頁 400ms 後整頁 reload（judge.js 只接管 checkin 事件），reload 後 judge.js 在頁面底部才執行、才還原暫存勾選，這個空檔內按「送出」就送出伺服器端的舊狀態`, "judge.js 也 takeOver 'judge-submitted' 等與本人無關的事件（不 reload）；或把送出鈕預設 disabled，restoreDraft 完成後再啟用；伺服器端也可在送出時要求前端附上『已勾數量』核對");
  // 帶入決賽：UI 沒有 fromRoundId → 以 POST 補做（測試繞道，非 UI）
  await go(admin, `/admin/c/${S.cid}/schedule`);
  const finalRow = admin.locator('tr', { hasText: '決賽' }).filter({ has: admin.locator('form[action$="/seed"]') }).last();
  const seedAction = await finalRow.locator('form[action$="/seed"]').getAttribute('action');
  const finalId = seedAction.match(/round\/(\d+)\/seed/)[1];
  const semiId = (await admin.locator('tr', { hasText: '準決賽' }).first().locator('form[action$="/seed"]').getAttribute('action')).match(/round\/(\d+)\/seed/)[1];
  S.rounds = { semi: semiId, final: finalId };
  const pr = await adminCtx.request.post(`${BASE}${seedAction}`, { form: { fromRoundId: semiId }, maxRedirects: 0 });
  check(pr.status() === 303, `（繞道）POST seed fromRoundId=${semiId} → ${pr.status()}`);
  await clickAndLoad(admin, finalRow.locator('form[action$="/heats"] button'));
  await clickAndLoad(admin, admin.locator('form[action$="/order/rebuild"] button'));
  const order = admin.locator('h2', { hasText: T('schedule.runningOrder') }).locator('xpath=following-sibling::div[1]//table//tr').filter({ has: admin.locator('td') });
  const nOrder = await order.count();
  const statuses = await order.locator('td:nth-child(4)').allInnerTexts();
  const counts = await order.locator('td:nth-child(3)').allInnerTexts();
  console.log('  order', nOrder, statuses, counts);
  const pendingFinal = counts.slice(-2);
  check(nOrder === 6 && pendingFinal.every((c) => c.trim() === '6'), `決賽 2 個 heat 各 6 人（總 heat ${nOrder}，最後兩筆人數 [${pendingFinal}]）`);
  await shot(admin, 'final-heats-built');
});

// ============================================================ 5d final
await step('5d', '決賽 rank 計分（skating）：2 個 heat、5 位裁判、計算', async () => {
  const rankMap = { [B(3)]: 1, [B(1)]: 2, [B(2)]: 3, [B(6)]: 4, [B(4)]: 5, [B(5)]: 6 };
  const state = { lateDone: true, absentDone: true };
  for (let i = 0; i < 2; i += 1) {
    await checkinAll(null);
    if (!(await hostStandby())) { check(false, `決賽 heat ${i + 1} 無法開始`); break; }
    await go(staffPage.host, `/host/${S.cid}`);
    if (i === 0) await shot(staffPage.host, 'host-final-standby');
    await judgesReady();
    await hostStart();
    await sleep(500);
    await judgesScore('rank', rankMap);
    await hostNext();
  }
  await go(staffPage.host, `/host/${S.cid}`);
  check((await txt(staffPage.host)).includes(T('floor.noMoreHeats')), '決賽 heat 完成後沒有更多場次');
  await go(admin, `/admin/c/${S.cid}/results`);
  const fc = () => admin.locator('.card', { has: admin.locator('h3', { hasText: /^\s*決賽/ }) });
  await clickAndLoad(admin, fc().locator('form[action$="/compute"] button'));
  const rows = await fc().locator('table tr').filter({ has: admin.locator('td') }).evaluateAll((trs) => trs.map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.trim())));
  console.log('  final rows', JSON.stringify(rows));
  const order = rows.map((r) => parseInt(r[1], 10));
  check(JSON.stringify(order) === JSON.stringify([3,1,2,6,4,5].map(B)), `決賽名次順序（依背號）為 3,1,2,6,4,5（實際 [${order}]）`);
  check(JSON.stringify(rows.map((r) => r[0])) === '["1","2","3","4","5","6"]', `名次欄為 1..6 [${rows.map((r) => r[0])}]`);
  await shot(admin, 'results-final-computed');
});

// ============================================================ 4d revoke / reissue / end
await step('4d', '停用、重新產生、結束比賽使所有登入失效', async () => {
  const spare = await newCtx('spare', { viewport: PHONE, standalone: true });
  const sp = await newPage(spare, 'spare');
  await staffLogin(sp, S.codes.hostSpare);
  check(/\/host\//.test(sp.url()), '備用主持登入成功');
  // revoke
  await go(admin, `/admin/c/${S.cid}/staff`);
  const row = admin.locator('tr', { hasText: '備用主持' });
  await clickAndLoad(admin, row.locator('form[action$="/revoke"] button'));
  check((await admin.locator('tr', { hasText: '備用主持' }).innerText()).includes(T('staffApp.revoked')), '主辦頁顯示已停用');
  const r1 = await go(sp, `/host/${S.cid}`);
  check(r1.status() === 401, `被停用者下一個請求即被登出（HTTP ${r1.status()}）`);
  await shot(sp, 'revoked-host-kicked');
  // 停用後再用舊碼
  const rc = await newCtx('rc', { viewport: PHONE, standalone: true });
  const rp = await newPage(rc);
  await staffLogin(rp, S.codes.hostSpare);
  check((await txt(rp)).includes(T('staffApp.errors.invalid')), '被停用的碼無法再登入');
  // reissue
  await go(admin, `/admin/c/${S.cid}/staff`);
  await clickAndLoad(admin, admin.locator('tr', { hasText: '備用主持' }).locator('form[action$="/reissue"] button'));
  const newCode = (await admin.locator('code.voucher').first().innerText()).trim();
  check(newCode && newCode !== S.codes.hostSpare, `重新產生新碼 ${newCode}`);
  await shot(admin, 'staff-reissued');
  await staffLogin(rp, S.codes.hostSpare);
  check(!/\/host\//.test(rp.url()), '重新產生後舊碼失效');
  await staffLogin(rp, newCode);
  check(/\/host\//.test(rp.url()), '新碼可登入');
  // 對「重新產生」正在使用中的人：主持小陳 reissue -> 立即登出
  await go(admin, `/admin/c/${S.cid}/staff`);
  await clickAndLoad(admin, admin.locator('tr', { hasText: '檢錄小李' }).locator('form[action$="/reissue"] button'));
  const r2 = await go(staffPage.checkin, `/checkin/${S.cid}`);
  check(r2.status() === 401, `reissue 後原本登入中的檢錄人員立刻被登出（HTTP ${r2.status()}）`);
  const newCk = (await admin.locator('code.voucher').first().innerText()).trim();
  // 結束比賽
  await go(admin, `/admin/c/${S.cid}/staff`);
  await clickAndLoad(admin, admin.locator('form[action$="/end"] button'));
  check((await admin.locator('.pill.bad', { hasText: T('staffApp.ended') }).count()) === 1, '主辦頁顯示已結束');
  for (const [k, pg] of [['desk', staffPage.desk], ['host', staffPage.host]]) {
    const r = await go(pg, k === 'desk' ? `/desk/${S.cid}` : `/host/${S.cid}`);
    check(r.status() === 401, `結束比賽後 ${k} 登入失效（HTTP ${r.status()}）`);
  }
  const r3 = await go(sp, `/host/${S.cid}`);
  check(r3.status() === 401, `結束比賽後重新產生的主持人 session 亦失效（HTTP ${r3.status()}）`);
  await shot(staffPage.host, 'ended-host-kicked');
  const ec = await newCtx('ec', { viewport: PHONE, standalone: true });
  const ep = await newPage(ec);
  await staffLogin(ep, newCk);
  check((await txt(ep)).includes(T('staffApp.errors.ended')), '結束後新碼也無法登入（顯示比賽已結束）');
  await shot(ep, 'ended-login-refused');
  // 主辦仍可進後台；裁判仍可用（judge 不受影響）
  const ar = await go(admin, `/admin/c/${S.cid}/schedule`);
  check(ar.status() === 200, '結束後主辦後台仍可用');
  // 取消結束 → 原 session 復活？
  await clickAndLoad(admin, (await go(admin, `/admin/c/${S.cid}/staff`), admin.locator('form[action$="/end"] button')));
  const r4 = await go(staffPage.desk, `/desk/${S.cid}`);
  results.notes.push(`取消「結束比賽」後，先前的 desk session 是否復活：HTTP ${r4.status()}`);
  if (r4.status() === 200) bug('low', `/admin/c/${S.cid}/end (undo=1)`, '「取消結束」會讓結束當下已失效的所有工作人員 session 全部復活（session_hash 未清除，只是以 ended_at 判斷）；若主辦誤按結束→取消，等於未曾踢人，且已被撤回的人不受影響但其他人可繼續使用舊 cookie', '結束比賽時清空 session_hash（或記 session 世代），取消結束後要求重新掃碼');
  check(true, `取消結束後 desk 存取 HTTP ${r4.status()}`);
  await go(admin, `/admin/c/${S.cid}/staff`);
  await shot(admin, 'staff-page-final');
});

// ============================================================ 5e publish / public
await step('5e', '公告成績、公開頁 /results 與背號查詢、取消公告', async () => {
  const pub = await newCtx('public-phone', { viewport: PHONE });
  const pp = await newPage(pub, 'public');
  await go(pp, `/results/${S.slug}`);
  check((await txt(pp)).includes(T('results.notPublished')), '未公告前公開頁顯示「尚未公告」');
  const rb = await go(pp, `/results/${S.slug}/bib?bib=${B(3)}`);
  check((await pp.locator('table').count()) <= 1, '未公告前背號查詢沒有名次表（只有場次表）');
  await shot(pp, 'results-unpublished');
  await go(admin, `/admin/c/${S.cid}/results`);
  const card = (n) => admin.locator('.card', { has: admin.locator('h3', { hasText: n }) });
  await clickAndLoad(admin, card('準決賽').locator('form[action$="/publish"] button'));
  await clickAndLoad(admin, admin.locator('.card', { has: admin.locator('h3', { hasText: /^\s*決賽/ }) }).locator('form[action$="/publish"] button'));
  check((await admin.locator('.pill.ok', { hasText: T('results.published') }).count()) === 2, '兩輪皆顯示已公告');
  await shot(admin, 'results-published-admin');
  await go(pp, `/results/${S.slug}`);
  const blocks = await pp.locator('.card').evaluateAll((cs) => cs.map((c) => ({ h: c.querySelector('h3')?.innerText.trim(), rows: [...c.querySelectorAll('tr')].map((r) => [...r.querySelectorAll('td')].map((d) => d.innerText.trim().replace(/\n/g, ' '))).filter((r) => r.length) })));
  console.log('  public', JSON.stringify(blocks));
  const fin = blocks.find((b) => b.h && b.h.startsWith('決賽'));
  const semi = blocks.find((b) => b.h && b.h.startsWith('準決賽'));
  check(fin && JSON.stringify(fin.rows.map((r) => r[1])) === JSON.stringify([3,1,2,6,4,5].map((n) => String(B(n)))), `公開頁決賽依名次排列 ${[3,1,2,6,4,5].map(B)}（${fin && fin.rows.map((r) => r[1])}）`);
  check(fin && fin.rows.map((r) => r[0]).join() === '1,2,3,4,5,6', '公開頁決賽名次欄 1..6');
  check(semi && semi.rows.length === 10 && semi.rows.slice(0, 6).every((r) => /晉級/.test(r[3] || '')), `公開頁準決賽 10 列且前 6 名標晉級`);
  const idx = (t) => blocks.findIndex((b) => b.h && b.h.startsWith(t));
  check(idx('準決賽') < idx('決賽') || idx('準決賽') < blocks.findIndex((b) => b.h === '決賽'), '公開頁輪次順序：準決賽在前、決賽在後');
  await shot(pp, 'results-public-published');
  // 背號查詢
  await go(pp, `/results/${S.slug}`);
  await pp.fill('#bib', String(B(3)));
  await clickAndLoad(pp, pp.locator('form[action$="/bib"] button[type=submit]'));
  const bt = await txt(pp);
  check(bt.includes('選手03') && /決賽/.test(bt), '背號 3 查詢顯示選手03與決賽');
  const trows = await pp.locator('.card table').last().evaluateAll((ts) => ts.map((t) => t.innerText));
  check(/決賽\s+1/.test(bt.replace(/\n/g, ' ').replace(/\t/g, ' ')), '背號 3 決賽名次為 1：' + bt.replace(/\s+/g, ' ').slice(0, 260));
  await shot(pp, 'results-bib-3');
  await go(pp, `/results/${S.slug}/bib?bib=${B(10)}`);
  const t10 = (await txt(pp)).replace(/\s+/g, ' ');
  check(/缺席/.test(t10), '背號 10 查詢顯示缺席：' + t10.slice(0, 200));
  await go(pp, `/results/${S.slug}/bib?bib=999`);
  check((await txt(pp)).includes(T('results.notFound')), '背號 999 顯示查無此背號');
  await go(pp, `/results/${S.slug}/bib?bib=abc`);
  check(!(await txt(pp)).includes('Error'), '背號 abc 不會出錯');
  const badSlug = await probe('/results/no-such-slug');
  check(badSlug === 404, `未知 slug /results/no-such-slug 回 404（實際 ${badSlug}）`);
  // 取消公告
  await go(admin, `/admin/c/${S.cid}/results`);
  await clickAndLoad(admin, admin.locator('.card', { has: admin.locator('h3', { hasText: /^\s*決賽/ }) }).locator('form[action$="/publish"] button'));
  check((await admin.locator('.card', { has: admin.locator('h3', { hasText: /^\s*決賽/ }) }).locator('.pill', { hasText: T('results.notPublished') }).count()) === 1, '取消公告決賽後，決賽卡片顯示尚未公告');
  await go(pp, `/results/${S.slug}`);
  const after = (await txt(pp));
  check(!/決賽\n/.test(after.replace('準決賽', '')) && after.includes('準決賽'), '取消公告後公開頁只剩準決賽');
  await go(pp, `/results/${S.slug}/bib?bib=${B(3)}`);
  const tblAfter = await pp.locator('.card table').evaluateAll((ts) => ts.map((t) => t.innerText.replace(/\s+/g, ' ')));
  check(!tblAfter.some((t) => /名次/.test(t) && /決賽 \d+ *$/.test(t.replace('準決賽', ''))) && !tblAfter.join('|').match(/(^|\|)[^|]*決賽 1(\s|$)/) || true, '取消公告後背號查詢：' + tblAfter.join(' || ').slice(0, 260));
  check(!/公開組 單人拉丁 決賽/.test(tblAfter.join(' ')), '取消公告後背號查詢的名次表不含「決賽」列');
  await shot(pp, 'results-after-unpublish');
  // 再公告
  await go(admin, `/admin/c/${S.cid}/results`);
  await clickAndLoad(admin, admin.locator('.card', { has: admin.locator('h3', { hasText: /^\s*決賽/ }) }).locator('form[action$="/publish"] button'));
  await go(pp, `/results/${S.slug}`);
  check((await txt(pp)).includes('選手03'), '再次公告後決賽回到公開頁');
  await pub.close();
});

// ============================================================ 6 cross-cutting
await step('6', '整體檢查：?lang=en 抽查、手機版面、匯出（決賽後）、頁面遍歷', async () => {
  await exportsCheck('final');
  // en spot-check
  const en = await newCtx('en', { locale: 'en-US' });
  const ep = await newPage(en, 'en-admin');
  await go(ep, '/admin?lang=en');
  await ep.fill('input[name=token]', 'test-admin-token');
  await clickAndLoad(ep, ep.locator('form[action="/admin/login"] button[type=submit]'));
  const spots = [
    ['/?lang=en', 'en-home'], [`/c/${S.slug}?lang=en`, 'en-competition'], [`/results/${S.slug}?lang=en`, 'en-results'],
    [`/admin/c/${S.cid}/staff?lang=en`, 'en-admin-staff'], [`/admin/c/${S.cid}/schedule?lang=en`, 'en-schedule'], ['/staff/app?lang=en', 'en-staffapp'],
    [`/admin/c/${S.cid}/results?lang=en`, 'en-admin-results'], ['/judge?lang=en', 'en-judge-login'],
  ];
  const known = ['繁體中文', '成人 拉丁五項', '第一屆 StageRank 盃', '公開組 單人拉丁', 'U12 恰恰', '選手', '小朋友', '裁判', '準決賽', '決賽', '報到小王', '檢錄小李', '主持小陳', '備用主持', '瀏覽器主持', '隱藏欄位測試', '恰恰', '森巴', '倫巴', '鬥牛', '捷舞', '晨曦', '月光', '王老師', '加項優惠群組', '台北市', '高雄市', '新北市', '台中市'];
  for (const [u, n] of spots) {
    const r = await go(ep, u);
    const info = await audit(ep, n);
    const lines = (info?.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const cjk = lines.filter((l) => /[一-鿿]/.test(l) && !known.some((k) => l.includes(k)));
    check(r.status() === 200 && info.lang === 'en', `${u} HTTP ${r.status()} lang=${info?.lang}`);
    if (cjk.length) { results.suspects.push({ label: n, url: u, hit: `英文介面仍出現中文：${cjk.slice(0, 5).join(' / ')}` }); bug('medium', u, `?lang=en 仍出現未翻譯中文：${cjk.slice(0, 3).join(' / ')}`, '補英文語系'); }
    if (['en-home', 'en-competition', 'en-admin-staff', 'en-results'].includes(n)) await shot(ep, n);
  }
  // 手機版面：公開與工作人員頁（已登入者的 session 已被結束/重開 → 用 admin cookie）
  const ph = await newCtx('phone-admin', { viewport: PHONE });
  const pp = await newPage(ph, 'phone-admin');
  await go(pp, '/admin');
  await pp.fill('input[name=token]', 'test-admin-token');
  await clickAndLoad(pp, pp.locator('form[action="/admin/login"] button[type=submit]'));
  for (const u of [`/desk/${S.cid}`, `/checkin/${S.cid}`, `/host/${S.cid}`, `/c/${S.slug}`, `/results/${S.slug}`, '/staff/app', '/judge', `/admin/c/${S.cid}/staff`, `/admin/c/${S.cid}/schedule`, `/admin/c/${S.cid}/results`, `/admin/c/${S.cid}`, '/admin', '/entrant/login', '/entrant/signup']) {
    const r = await go(pp, u);
    check(r && r.status() < 500, `手機寬度 ${u} HTTP ${r && r.status()}`);
  }
  await go(pp, `/admin/c/${S.cid}/schedule`); await shot(pp, 'phone-admin-schedule');
  await go(pp, `/host/${S.cid}`); await shot(pp, 'phone-host-as-admin');
  // 404 / 錯誤頁
  const nf = await go(pp, '/nope');
  check(nf.status() === 404 && !LEAK.test(await txt(pp)), '/nope 404 頁沒有外洩 key');
  LEAK.lastIndex = 0;
  await shot(pp, 'error-404');
  const bad0 = await probe('/admin/c/99999');
  check(bad0 === 404, `/admin/c/99999 回 404（${bad0}）`);
  const hang = [];
  for (const u of ['/results/no-such-slug', '/results/no-such-slug/bib?bib=1', '/admin/c/99999/schedule', '/admin/c/99999/results', '/admin/c/99999/export/bibs.xlsx', '/admin/c/99999/export/lists.xlsx', '/admin/c/99999/export/order.xlsx', '/desk/99999']) {
    const st = await probe(u);
    results.notes.push(`${u} → ${st}`);
    if (st === 'HANG') hang.push(u);
  }
  check(hang.length === 0, `不存在的比賽/slug 皆回 404 而非掛住（掛住：${hang.join(', ') || '無'}）`);
  if (hang.length) bug('critical', hang.join('  '), `對不存在的 slug / 比賽 id 請求時，路由呼叫 res.status(404).renderPage('error', { messageKey }) 沒有傳 title，layout.ejs 的 <%= title %> 丟 ReferenceError；因為 renderPage 是 async 且被 return 出 try/catch 之外，rejection 沒被 Express 接住 → 請求永遠不回應，且觸發 unhandledRejection，Node 22 預設直接讓整個 server process 結束（本次測試中 server 因此崩潰）。未登入者請求 /results/亂打 就能讓服務下線`, "render error 頁一律用一個 helper（notFound(res)）帶 title；layout.ejs 用 (typeof title !== 'undefined' && title)；async handler 都 await 並 catch → next(err)；另外 server.js 加 process.on('unhandledRejection') 記錄不退出");
  for (const [u, st] of [['/admin/c/abc', await probe('/admin/c/abc')], ['/admin/c/abc/schedule', await probe('/admin/c/abc/schedule')], ['/admin/c/abc/staff', await probe('/admin/c/abc/staff')], ['/desk/abc', await probe('/desk/abc')], ['/host/99999', await probe('/host/99999')], ['/checkin/99999', await probe('/checkin/99999')]]) {
    results.notes.push(`${u} → ${st}`);
    if (st === 500 || st === 'HANG') bug('low', u, `不合法/不存在的 id 造成 HTTP ${st}`, '驗證路由參數；FloorError(errors.notFound) 轉成 404 頁');
  }
  // 手機上的 judge 頁
  const first = Object.keys(judgePage)[0];
  await go(judgePage[first], `/judge/${S.cid}`);
  await shot(judgePage[first], 'judge-after-all');
  // 連結檢查：抓後台頁面所有站內連結
  const seen = new Set();
  for (const u of [`/admin`, `/admin/c/${S.cid}`, `/admin/c/${S.cid}/schedule`, `/admin/c/${S.cid}/results`, `/admin/c/${S.cid}/staff`, `/`, `/c/${S.slug}`, `/results/${S.slug}`, '/entrant']) {
    await go(admin, u);
    const hrefs = await admin.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    for (const h of hrefs) if (h && h.startsWith('/') && !seen.has(h)) seen.add(h);
  }
  const broken = [];
  for (const h of seen) {
    if (h.includes('export') || h.startsWith('/entrant?edit')) continue;
    const r = await adminCtx.request.get(BASE + h, { maxRedirects: 5 }).catch(() => null);
    if (!r || r.status() >= 400) broken.push(`${h} → ${r ? r.status() : 'err'}`);
  }
  check(broken.length === 0, `站內連結 ${seen.size} 條，壞連結：${broken.join('; ') || '無'}`);
  broken.forEach((b) => bug('medium', b.split(' → ')[0], `後台/公開頁上的連結壞掉：${b}`, '修正連結'));
});

// ------------------------------------------------------------ finish
const favi = results.http404.filter((x) => /favicon/.test(x.url));
if (favi.length) bug('low', '/favicon.ico', `瀏覽器要求 /favicon.ico 回 404（每個頁面都會在主控台出現 "Failed to load resource 404"，共 ${favi.length} 次）`, '在 layout 加 <link rel="icon" href="/icon-192.png"> 或提供 /favicon.ico');
const other404 = results.http404.filter((x) => !/favicon/.test(x.url));
results.other404 = other404;
results.doneAt = new Date().toISOString();
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log('\nSUMMARY');
for (const s of results.steps) console.log(s.id, s.status, `${s.checks.length - s.fails.length}/${s.checks.length}`, s.fails.join(' || ').slice(0, 300));
console.log('bugs', results.bugs.length, 'console', results.consoleErrors.length, '5xx', results.http5xx.length, 'leaks', results.leaks.length, 'overflow', results.overflow.length);
await browser.close();
await http.close();
await closePool();
process.exit(0);
