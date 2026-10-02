// 新功能走一遍：首頁、信箱登入連結、報名頁隱私、範本庫（分組清單）、存成我的範本。
// 跟 e2e.mjs 一樣自己起 app 與資料庫；寄信用記憶體信箱（MAIL_MODE=memory 的效果）。
// A walk through the new features: home page, emailed sign-in links, registration-page privacy, the
// template library (grouped list) and saving my template. Boots the app like e2e.mjs does; mail
// goes to the in-memory outbox (the effect of MAIL_MODE=memory).
import fs from 'node:fs';
import { resetDatabase, startServer } from '../../test/helpers.js';
import { chromium } from 'playwright';

process.env.MAIL_MODE = 'memory';
const { createApp } = await import('../../src/app.js');
const { default: config } = await import('../../src/config.js');
const mailer = await import('../../src/services/mailer.js');
const comps = await import('../../src/services/competitions.js');
const regs = await import('../../src/services/registrations.js');
const roster = await import('../../src/services/athletes.js');
const entrants = await import('../../src/services/entrants.js');
const setup = await import('../../src/services/setup.js');
const { closePool } = await import('../../src/db/index.js');
// helpers.js 已經先載入 config，所以環境變數來不及；直接切換模式。
// helpers.js loads config first, so the environment variable is too late; switch the mode directly.
config.mail.setMode('memory');

const OUT = '/mnt/user-data/outputs/newfeatures';
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/^\d\d-.*\.png$/.test(f)) fs.unlinkSync(`${OUT}/${f}`);

await resetDatabase();
const http = await startServer(createApp());
const BASE = http.base;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

let failures = 0;
let shots = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`);
  if (!cond) failures += 1;
};
const LEAK = /\b(?:setup|home|entrant|mail|register|registration|admin|common|nav|errors)\.[A-Za-z_][A-Za-z0-9_.]*/;
async function shot(page, name) {
  shots += 1;
  const text = await page.evaluate(() => document.body.innerText);
  const leak = text.match(LEAK);
  check(!leak, `no untranslated key on ${name}${leak ? ` (${leak[0]})` : ''}`);
  await page.screenshot({ path: `${OUT}/${String(shots).padStart(2, '0')}-${name}.png`, fullPage: true });
}
async function newPage(viewport = { width: 1100, height: 800 }) {
  const ctx = await browser.newContext({ viewport, locale: 'zh-TW' });
  return ctx.newPage();
}
const linkFor = (email) => {
  const mail = [...mailer.outbox].reverse().find((m) => m.to === email);
  return mail ? mail.text.match(/https?:\/\/\S+\/entrant\/link\?\S+/)[0].replace(config.baseUrl, BASE) : null;
};

try {
  // 1. 匿名首頁
  console.log('== 1 home, anonymous');
  const competition = await comps.createCompetition({ name: '晨光盃', feeCents: 0, status: 'open' });
  const division = await comps.addDivision({ competitionId: competition.id, name: 'U12 單人', sortOrder: 1, memberMin: 1, memberMax: 1 });
  const a = await newPage();
  await a.goto(BASE);
  check(await a.locator('a[href="/entrant/signup"]').isVisible(), 'the sign-up button is shown');
  check(await a.locator('a[href="/entrant/login"]').isVisible(), 'the sign-in button is shown');
  check((await a.locator('body').innerText()).includes('晨光盃'), 'the competition list is public');
  await shot(a, 'home-anonymous');

  // 2. 用信箱註冊
  console.log('== 2 sign up by email');
  await a.click('a[href="/entrant/signup"]');
  check((await a.locator('input[type=password]').count()) === 0, 'no password field in mail mode');
  await a.fill('#email', 'alice@example.com');
  await a.fill('#unitName', '晨光舞蹈教室');
  await shot(a, 'signup-mail');
  await a.click('button[type=submit]');
  check((await a.locator('body').innerText()).includes('如果這個信箱已註冊，我們已寄出登入連結'), 'the neutral confirmation is shown');
  await shot(a, 'link-sent');

  // 3. 信裡的連結：先看到確認頁，按了才登入
  console.log('== 3 read the link from the outbox and sign in');
  const linkA = linkFor('alice@example.com');
  check(Boolean(linkA), 'the outbox holds a link');
  await a.goto(linkA);
  check((await a.locator('button[type=submit]').innerText()) === '登入', 'GET shows a sign-in button');
  check(!(await a.context().cookies()).some((c) => c.name === 'stagerank_entrant'), 'opening the link alone does not sign in');
  await shot(a, 'link-confirm');
  await Promise.all([a.waitForURL(`${BASE}/entrant`), a.click('button[type=submit]')]);
  check(a.url() === `${BASE}/entrant`, 'pressing the button lands on the roster page');
  await a.goto(linkA);
  check((await a.locator('body').innerText()).includes('已經用過或已過期'), 'the same link is dead the second time');

  // 4. 報名 → 首頁「我的報名」
  console.log('== 4 an entry shows on the home page');
  const alice = await entrants.findByEmail('alice@example.com');
  const athlete = await roster.addAthlete({ entrantId: alice.id, name: '選手甲', birthDate: '2014-05-04' });
  const entry = await regs.register({ competitionId: competition.id, divisionId: division.id, athleteIds: [athlete.id], entrantId: alice.id });
  await a.goto(BASE);
  const home = await a.locator('#myEntries').innerText();
  check(home.includes('我的報名') && home.includes('選手甲') && home.includes('U12 單人') && home.includes('晨光盃'), 'my entries lists the entry');
  check(await a.locator(`#myEntries a[href="/r/${entry.registration.id}"]`).isVisible(), 'with a link to the entry page');
  check(await a.locator('#myEntries a[href="/entrant"]').isVisible(), 'and to the roster');
  await shot(a, 'home-signed-in');
  const own = await a.goto(`${BASE}/r/${entry.registration.id}`);
  check(own.status() === 200, 'the owner opens the entry page');
  await shot(a, 'entry-owner');

  // 5. 第二個人打不開
  console.log('== 5 a second user cannot open it');
  const b = await newPage();
  await b.goto(`${BASE}/entrant/login`);
  await b.fill('#email', 'bob@example.com');
  await b.click('button[type=submit]');
  check(!linkFor('bob@example.com'), 'login for an unknown address sends nothing');
  await b.goto(`${BASE}/entrant/signup`);
  await b.fill('#email', 'bob@example.com');
  await b.click('button[type=submit]');
  await b.goto(linkFor('bob@example.com'));
  await Promise.all([b.waitForURL(`${BASE}/entrant`), b.click('button[type=submit]')]);
  const denied = await b.goto(`${BASE}/r/${entry.registration.id}`);
  check(denied.status() === 404, 'the second user gets 404');
  check(!(await b.locator('body').innerText()).includes('選手甲'), 'and no name leaks');
  await shot(b, 'entry-other-user-404');
  const anon = await newPage();
  check((await anon.goto(`${BASE}/r/${entry.registration.id}`)).status() === 404, 'anonymous gets 404 too');

  // 6. 主辦：建比賽、套 ballroom-tw
  console.log('== 6 organiser: create a competition and apply ballroom-tw');
  const admin = await newPage({ width: 1100, height: 900 });
  await admin.goto(`${BASE}/admin`);
  await admin.fill('#token', 'test-admin-token');
  await Promise.all([admin.waitForLoadState('load'), admin.click('button[type=submit]')]);
  await admin.fill('#cname', '國標舞新功能盃');
  await Promise.all([admin.waitForURL(/\/admin\/c\/\d+$/), admin.click('form[action="/admin/new"] button[type=submit]')]);
  const cid = admin.url().match(/\/admin\/c\/(\d+)/)[1];
  await admin.goto(`${BASE}/admin/c/${cid}/setup`);
  check((await admin.inputValue('#templateKey')) === 'ballroom-tw', 'ballroom-tw is preselected');
  const visible = admin.locator('.plan-panel:not([hidden])');
  check((await visible.locator('input[type=checkbox]').count()) === 47, '47 divisions listed');
  check((await visible.locator('.plan-cat').count()) === 8, 'in 8 categories');
  check((await admin.locator('#chosenCount').innerText()).trim() === '47 / 47', 'the count reads 47 / 47');
  check((await visible.locator('input[name=plan_general_base]').inputValue()) === '1800', 'general plan prefilled');
  check((await visible.locator('input[name=plan_proAm_base]').inputValue()) === '2500', 'pro-am plan prefilled');
  await shot(admin, 'setup-ballroom-tw');

  // 分類自己的全選／全不選
  await visible.locator('.plan-cat[data-cat=pro] .cat-off').click();
  check((await admin.locator('#chosenCount').innerText()).trim() === '39 / 47', 'category none: 47 -> 39');
  await visible.locator('.plan-cat[data-cat=pro] .cat-on').click();
  await admin.click('#allOff');
  check((await admin.locator('#chosenCount').innerText()).trim() === '0 / 47', 'global none: 0 / 47');
  await visible.locator('.plan-cat[data-cat=youthSolo] .cat-on').click();
  await visible.locator('.plan-cat[data-cat=proamDream] .cat-on').click();
  check((await admin.locator('#chosenCount').innerText()).trim() === '18 / 47', 'two categories on: 18 / 47');
  await admin.fill('input[name=plan_general_base]:not([disabled])', '2000');
  await shot(admin, 'setup-categories-picked');

  // 切到通用範本再切回來：欄位互不干擾
  await admin.selectOption('#templateKey', 'ballroom');
  check((await admin.locator('.plan-panel:not([hidden]) input[type=checkbox]').count()) === 94, 'the generic template shows its own 94 rows');
  await shot(admin, 'setup-generic-template');
  await admin.selectOption('#templateKey', 'ballroom-tw');

  await Promise.all([admin.waitForURL(/done=applied/), admin.click('form#tplForm button[type=submit]')]);
  const built = await comps.listDivisions(Number(cid));
  check(built.length === 18, `applied: ${built.length} divisions`);
  await shot(admin, 'setup-applied-save-template');

  // 7. 存成我的範本
  console.log('== 7 save as my template');
  await admin.fill('#tplName', '我的青少年加圓夢');
  await Promise.all([admin.waitForURL(/done=savedAs/), admin.click('form[action$="/setup/save-template"] button[type=submit]')]);
  check((await admin.locator('.notice').innerText()).includes('我的青少年加圓夢'), 'the saved message names the template');
  check((await setup.listSaved()).length === 1, 'one saved template in the database');

  // 8. 下一場比賽：我的範本出現在選單，收費是上次填的
  console.log('== 8 next competition sees my template and the last fees');
  const next = await comps.createCompetition({ name: '第二場', feeCents: 0, status: 'draft' });
  await admin.goto(`${BASE}/admin/c/${next.id}/setup`);
  check((await admin.inputValue('#templateKey')) === 'ballroom-tw', 'the last used template is preselected');
  check((await admin.locator('.plan-panel:not([hidden]) input[name=plan_general_base]').inputValue()) === '2000', 'the last fee is remembered');
  check((await admin.locator('#chosenCount').innerText()).trim() === '18 / 47', 'the last ticks are remembered');
  await admin.selectOption('#genreSelect', 'mine');
  check((await admin.locator('#templateKey option:not([disabled])').allInnerTexts()).includes('我的青少年加圓夢'), 'my template is under 我的範本');
  await shot(admin, 'setup-my-templates');
  await Promise.all([admin.waitForURL(/done=applied/), admin.click('form#tplForm button[type=submit]')]);
  check((await comps.listDivisions(next.id)).length === 18, 'the saved template applies through the same path');

  // 9. 手機寬度
  console.log('== 9 phone width');
  const phone = await newPage({ width: 390, height: 800 });
  await phone.goto(BASE);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 2, `no horizontal scroll on the phone home page (${overflow})`);
  await shot(phone, 'home-phone');
  const phoneAdmin = await newPage({ width: 390, height: 800 });
  await phoneAdmin.goto(`${BASE}/admin`);
  await phoneAdmin.fill('#token', 'test-admin-token');
  await Promise.all([phoneAdmin.waitForLoadState('load'), phoneAdmin.click('button[type=submit]')]);
  const third = await comps.createCompetition({ name: '第三場', feeCents: 0, status: 'draft' });
  await phoneAdmin.goto(`${BASE}/admin/c/${third.id}/setup`);
  const overflow2 = await phoneAdmin.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow2 <= 2, `no horizontal scroll on the phone setup page (${overflow2})`);
  await shot(phoneAdmin, 'setup-phone');
} catch (err) {
  failures += 1;
  console.log('EXCEPTION', err.stack);
} finally {
  await browser.close();
  await http.close();
  await closePool();
}
console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
