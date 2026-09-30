// 範本目錄（類型 → 分類 → 組別）、記住上次、我的範本。
// The template catalogue (genre -> category -> division), remembered choices, and my templates.
import { resetDatabase, startServer } from './helpers.js';
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createApp } = await import('../src/app.js');
const comps = await import('../src/services/competitions.js');
const setup = await import('../src/services/setup.js');
const fees = await import('../src/services/feeGroups.js');
const schedule = await import('../src/services/schedule.js');
const catalogue = await import('../src/templates/index.js');
const { translate } = await import('../src/i18n/index.js');
const { closePool, one } = await import('../src/db/index.js');

before(resetDatabase);
beforeEach(resetDatabase);
after(closePool);

const tzh = (key, params) => translate('zh-TW', key, params);
const ten = (key, params) => translate('en', key, params);

const CURATED = 'ballroom-tw';

test('目錄有 46 個組別，每一個都有舞科，兩種語言都有名稱 / 46 divisions, all with dances and names in both locales', () => {
  const rows = setup.planFor({ templateKey: CURATED, t: tzh });
  assert.equal(rows.length, 46);
  const keys = new Set(rows.map((r) => r.key));
  assert.equal(keys.size, 46, 'keys are unique');
  const names = new Set(rows.map((r) => r.name));
  assert.equal(names.size, 46, 'names are unique, since a competition forbids two divisions with one name');

  const english = setup.planFor({ templateKey: CURATED, t: ten, locale: 'en' });
  for (const row of rows) {
    assert.ok(row.dances.length > 0, `${row.key} has dances`);
    const zhName = tzh(`setup.tw.${row.key}`);
    const enName = ten(`setup.tw.${row.key}`);
    assert.notEqual(zhName, `setup.tw.${row.key}`, `${row.key} has a zh-TW name`);
    assert.notEqual(enName, `setup.tw.${row.key}`, `${row.key} has an English name`);
    assert.equal(row.name, zhName);
    assert.ok(/[一-鿿]/.test(zhName), `${row.key} zh-TW name is Chinese`);
  }
  assert.equal(english.length, 46);
  assert.ok(english.every((r) => !/[一-鿿]/.test(r.name)), 'the English names are English');
});

test('組別名稱、舞科、年齡、人數照規格 / names, dances, ages and member limits follow the spec', () => {
  const rows = setup.planFor({ templateKey: CURATED, t: tzh });
  const byName = (name) => rows.find((r) => r.name === name);

  const latin5 = byName('亞洲職業公開組(拉丁舞五項)');
  assert.deepEqual(latin5.dances.map((d) => d.key), ['chaCha', 'samba', 'rumba', 'pasoDoble', 'jive']);
  assert.equal(latin5.category, 'pro');
  assert.equal(latin5.group, 'general');
  assert.equal(latin5.memberMin, 2);

  const std4 = byName('U12單人四項公開組(標準舞四項)');
  assert.deepEqual(std4.dances.map((d) => d.key), ['waltz', 'tango', 'slowFoxtrot', 'quickstep']);
  assert.equal(std4.ageMax, 12);
  assert.equal(std4.memberMin, 1);
  assert.equal(std4.memberMax, 1);

  const l3 = byName('U10單人三項公開組(拉丁舞三項)');
  assert.deepEqual(l3.dances.map((d) => d.key), ['chaCha', 'rumba', 'jive']);

  // 只有名稱寫 U 的組別才有年齡限制；成人、壯年、50 歲以上先不限制，主辦之後可自己設定。
  // Only the U groups carry an age limit; adult, senior and 50+ are unrestricted for now.
  assert.equal(byName('50歲以上職業公開組(拉丁舞五項)').ageMin, null);
  assert.equal(byName('成人單人全能公開組(拉丁舞五項)').ageMin, null);
  assert.equal(byName('U18雙人全能公開組(標準舞五項)').ageMax, 18);
  assert.equal(byName('U21雙人全能公開組(標準舞五項)').ageMax, 21);

  // 壯年：單人是 1/1，雙人是 2/2，全部不限年齡。
  // Senior: solo is 1/1, couples 2/2, all unrestricted.
  const senior = rows.filter((r) => r.category === 'senior');
  assert.equal(senior.length, 4);
  assert.ok(senior.every((r) => r.ageMin === null));
  assert.equal(byName('壯年單人公開組(拉丁舞三項)').memberMax, 1);
  assert.equal(byName('壯年公開組(標準舞四項)').memberMax, 2);

  // 師生組：自己的方案、單一舞科、不檢年齡。
  // Pro-am: its own plan, one dance, no age check.
  const dream = byName('PRO-AM 圓夢公開組(標準舞單項VW)');
  assert.deepEqual(dream.dances.map((d) => d.key), ['vienneseWaltz']);
  assert.equal(dream.group, 'proAm');
  assert.equal(dream.ageMin, null);
  assert.equal(dream.ageMax, null);
  assert.equal(dream.memberMin, 2);
  assert.ok(byName('PRO-AM 圓夢公開組(拉丁舞單項P)'));
  assert.ok(byName('PRO-AM 成長公開組(拉丁舞單項C)'));
  assert.equal(rows.filter((r) => r.group === 'proAm').length, 15);
  assert.deepEqual(
    [...new Set(rows.map((r) => r.category))],
    ['pro', 'amateur', 'youthSolo', 'youthCouple', 'adultSolo', 'senior', 'proamDream', 'proamGrowth'],
  );

  // 舞科排序：恰恰、森巴、倫巴、鬥牛、捷舞、華爾滋、探戈、維也納、狐步、快步。
  // Dance order for the whole template.
  const order = catalogue.getTemplate(CURATED).dances.map((d) => d.key);
  assert.deepEqual(order, ['chaCha', 'samba', 'rumba', 'pasoDoble', 'jive', 'waltz', 'tango', 'vienneseWaltz', 'slowFoxtrot', 'quickstep']);
});

test('每一列的欄位齊全，舊的通用範本照舊可用 / every row has the full shape, and the generated template still works', () => {
  for (const templateKey of ['ballroom', CURATED]) {
    for (const row of setup.planFor({ templateKey, t: tzh })) {
      for (const field of ['key', 'name', 'dances', 'ageMin', 'ageMax', 'memberMin', 'memberMax', 'group', 'category']) {
        assert.ok(field in row, `${templateKey}/${row.key} has ${field}`);
      }
      for (const dance of row.dances) assert.ok(dance.key && dance.name);
    }
  }
  const old = setup.planFor({ templateKey: 'ballroom', t: tzh });
  assert.ok(old.find((r) => r.key === 'u12-latin-five'));
  assert.deepEqual([...new Set(old.map((r) => r.category))], ['latin', 'standard', 'proAm']);
});

test('類型與範本清單 / genres and templates are listed', () => {
  assert.deepEqual(catalogue.listGenres().map((g) => g.key), ['ballroom']);
  assert.ok(catalogue.listTemplates({ genre: 'ballroom' }).some((t) => t.key === CURATED));
  assert.equal(catalogue.getTemplate('nope'), null);
  const picker = setup.pickerTemplates().map((t) => t.key);
  assert.ok(picker.includes(CURATED) && picker.includes('ballroom'));
  assert.equal(tzh('setup.templates.ballroom'), '通用國標舞（自動組合）');
  assert.equal(tzh('setup.genres.ballroom'), '國標舞');
});

test('套用 ballroom-tw：舞科、方案、分類都建好 / applying ballroom-tw builds dances, plans and categories', async () => {
  const competition = await comps.createCompetition({ name: 'TW Cup', feeCents: 0, status: 'draft' });
  const result = await setup.applyTemplate({ competitionId: competition.id, templateKey: CURATED, t: tzh });
  assert.equal(result.created, 46);
  assert.equal(result.groups, 2);

  const divisions = await comps.listDivisions(competition.id);
  assert.equal(divisions.length, 46);
  const solo = divisions.find((d) => d.name === 'U15單人全能公開組(標準舞五項)');
  assert.equal(solo.member_min, 1);
  assert.equal(solo.member_max, 1);
  assert.equal(solo.age_max, 15);
  assert.equal(solo.category, 'youthSolo');
  assert.equal((await schedule.dancesForDivision(solo.id)).length, 5);

  // 舞科建成一套，照排序。
  // The dances exist once each, in the sort order.
  const dances = await schedule.listDances(competition.id);
  assert.deepEqual(dances.map((d) => d.name), ['恰恰', '森巴', '倫巴', '鬥牛', '捷舞', '華爾滋', '探戈', '維也納華爾滋', '狐步', '快步']);

  // 沒傳方案就是 0（跟以前一樣），師生組掛在師生組方案上。
  // No plans given means zero, as before; pro-am hangs on the pro-am plan.
  const groups = await fees.listGroups(competition.id);
  assert.equal(groups.length, 2);
  const dream = divisions.find((d) => d.name.startsWith('PRO-AM 圓夢'));
  const dreamGroup = groups.find((g) => String(g.id) === String(dream.fee_group_id));
  assert.equal(dreamGroup.name, '師生組');
});

test('plans 覆蓋、舊的 generalPlan / proAmPlan 仍可用 / the plans override works and the old arguments still do', async () => {
  const a = await comps.createCompetition({ name: 'New Args', feeCents: 0, status: 'draft' });
  await setup.applyTemplate({
    competitionId: a.id,
    templateKey: CURATED,
    t: tzh,
    keys: ['asiaProOpenLatin', 'dreamStdW'],
    plans: { general: { base: 2000, includes: 3, extra: 700 }, proAm: { base: 3000, includes: 1, extra: 1500 } },
  });
  const groupsA = await fees.listGroups(a.id);
  const general = groupsA.find((g) => g.name === '一般組');
  const proAm = groupsA.find((g) => g.name === '師生組');
  assert.deepEqual([Number(general.base_fee_cents), general.base_includes, Number(general.extra_item_fee_cents)], [2000, 3, 700]);
  assert.deepEqual([Number(proAm.base_fee_cents), proAm.base_includes, Number(proAm.extra_item_fee_cents)], [3000, 1, 1500]);

  const b = await comps.createCompetition({ name: 'Old Args', feeCents: 0, status: 'draft' });
  await setup.applyTemplate({
    competitionId: b.id,
    templateKey: CURATED,
    t: tzh,
    keys: ['asiaProOpenLatin'],
    generalPlan: { baseFeeCents: 1234, baseIncludes: 2, extraItemFeeCents: 99 },
  });
  const [only] = await fees.listGroups(b.id);
  assert.equal(Number(only.base_fee_cents), 1234, 'only the plan that is used is created, from the old argument');

  // plans 比舊參數優先。
  // plans beat the old arguments.
  const c = await comps.createCompetition({ name: 'Both', feeCents: 0, status: 'draft' });
  await setup.applyTemplate({
    competitionId: c.id, templateKey: CURATED, t: tzh, keys: ['asiaProOpenLatin'],
    plans: { general: { base: 5, includes: 1, extra: 1 } },
    generalPlan: { baseFeeCents: 999, baseIncludes: 1, extraItemFeeCents: 999 },
  });
  assert.equal(Number((await fees.listGroups(c.id))[0].base_fee_cents), 5);
});

test('記住上次：套用後存起來，下次預填，沒記過就用範本預設 / the last choice is remembered and prefills next time', async () => {
  const before = await setup.pickerModel({ t: tzh });
  const fresh = before.panels.find((p) => p.key === CURATED);
  assert.equal(fresh.remembered, false);
  assert.equal(fresh.plans.find((p) => p.key === 'general').base, 1800, 'the template default');
  assert.equal(fresh.categories.flatMap((c) => c.rows).every((r) => r.checked), true);
  assert.equal(before.selected, CURATED);

  const competition = await comps.createCompetition({ name: 'Remember', feeCents: 0, status: 'draft' });
  await setup.applyTemplate({
    competitionId: competition.id,
    templateKey: CURATED,
    t: tzh,
    keys: ['asiaProOpenLatin', 'dreamStdW'],
    plans: { general: { base: 2222, includes: 3, extra: 333 }, proAm: { base: 4444, includes: 1, extra: 555 } },
  });

  const stored = await one("SELECT value FROM app_settings WHERE key = 'setup.last.ballroom-tw'");
  assert.equal(stored.value.templateKey, CURATED);
  assert.deepEqual(stored.value.keys.sort(), ['asiaProOpenLatin', 'dreamStdW']);
  assert.deepEqual(stored.value.plans.general, { base: 2222, includes: 3, extra: 333 });

  const after = await setup.pickerModel({ t: tzh });
  const panel = after.panels.find((p) => p.key === CURATED);
  assert.equal(panel.remembered, true);
  assert.equal(panel.plans.find((p) => p.key === 'general').base, 2222);
  assert.equal(panel.plans.find((p) => p.key === 'proAm').extra, 555);
  const checked = panel.categories.flatMap((c) => c.rows).filter((r) => r.checked).map((r) => r.key).sort();
  assert.deepEqual(checked, ['asiaProOpenLatin', 'dreamStdW']);

  // 另一個範本不受影響。
  // Another template is untouched.
  const other = after.panels.find((p) => p.key === 'ballroom');
  assert.equal(other.remembered, false);
});

test('我的範本：存起來、出現在選單、用同一條路套用 / saving, listing and applying my templates', async () => {
  const source = await comps.createCompetition({ name: 'Source Cup', feeCents: 0, status: 'draft' });
  await setup.applyTemplate({
    competitionId: source.id, templateKey: CURATED, t: tzh,
    keys: ['u12SoloLatin', 'seniorLatin', 'dreamLatR'],
    plans: { general: { base: 1500, includes: 2, extra: 400 }, proAm: { base: 2600, includes: 1, extra: 900 } },
  });
  // 一個手動加的、沒有分類也沒有方案的組別。
  // A hand-made division with no category and no plan.
  await comps.addDivision({ competitionId: source.id, name: '自己加的組別', feeCents: 700, sortOrder: 99, memberMin: 3, memberMax: 4, ageMin: 20 });

  await assert.rejects(() => setup.saveAsTemplate({ competitionId: source.id, name: '  ', t: tzh }), (e) => e.key === 'setup.errors.templateNameRequired');
  const empty = await comps.createCompetition({ name: 'Empty', feeCents: 0, status: 'draft' });
  await assert.rejects(() => setup.saveAsTemplate({ competitionId: empty.id, name: 'X', t: tzh }), (e) => e.key === 'setup.errors.nothingToSave');

  const saved = await setup.saveAsTemplate({ competitionId: source.id, name: '我的春季盃', t: tzh });
  assert.equal(saved.payload.divisions.length, 4);
  assert.equal(saved.payload.plans.plan1.base, 1500);
  const solo = saved.payload.divisions.find((d) => d.name === 'U12單人四項公開組(拉丁舞四項)');
  assert.deepEqual(solo.dances, ['恰恰', '森巴', '倫巴', '捷舞']);
  assert.equal(solo.category, 'youthSolo');
  assert.equal(solo.ageMax, 12);
  assert.equal(solo.memberMax, 1);

  // 同名覆蓋，不是報錯，也不是多一份。
  // The same name overwrites: no error, no second copy.
  await setup.saveAsTemplate({ competitionId: source.id, name: '我的春季盃', t: tzh });
  assert.equal((await setup.listSaved()).length, 1);

  const model = await setup.pickerModel({ t: tzh });
  assert.ok(model.genres.some((g) => g.key === 'mine' && g.label === '我的範本'));
  const panel = model.panels.find((p) => p.key === `saved:${saved.id}`);
  assert.equal(panel.label, '我的春季盃');
  assert.equal(panel.genre, 'mine');
  assert.deepEqual(panel.categories.map((c) => c.label), ['青少年單人', '壯年', 'PRO-AM 圓夢', '未分類']);

  // 套到另一場比賽：名稱、舞科（舞名就是 key）、年齡、人數、方案數值都在。
  // Applied to another competition: names, dances (the dance name is the key), ages, member
  // limits and plan values all come along.
  const target = await comps.createCompetition({ name: 'Target Cup', feeCents: 0, status: 'draft' });
  const result = await setup.applyTemplate({ competitionId: target.id, templateKey: `saved:${saved.id}`, t: tzh });
  assert.equal(result.created, 4);
  const divisions = await comps.listDivisions(target.id);
  assert.deepEqual(divisions.map((d) => d.name).sort(), (await comps.listDivisions(source.id)).map((d) => d.name).sort());
  const custom = divisions.find((d) => d.name === '自己加的組別');
  assert.equal(custom.member_min, 3);
  assert.equal(custom.member_max, 4);
  assert.equal(custom.age_min, 20);
  assert.equal(Number(custom.fee_cents), 700);
  assert.equal(custom.fee_group_id, null);
  const copied = divisions.find((d) => d.name === 'U12單人四項公開組(拉丁舞四項)');
  assert.equal(copied.category, 'youthSolo');
  assert.deepEqual((await schedule.dancesForDivision(copied.id)).map((d) => d.name), ['恰恰', '森巴', '倫巴', '捷舞']);
  const groups = await fees.listGroups(target.id);
  assert.equal(groups.length, 2);
  assert.equal(Number(groups.find((g) => g.name === '一般組').base_fee_cents), 1500);

  // 用「我的範本」套用也會被記住。
  // Applying a saved template is remembered as well.
  const again = await setup.pickerModel({ t: tzh });
  assert.equal(again.selected, `saved:${saved.id}`);
  assert.equal(again.panels.find((p) => p.key === `saved:${saved.id}`).remembered, true);

  await setup.deleteSaved(saved.id);
  assert.equal((await setup.listSaved()).length, 0);
  const zed = await comps.createCompetition({ name: 'Z', feeCents: 0, status: 'draft' });
  await assert.rejects(
    () => setup.applyTemplate({ competitionId: zed.id, templateKey: `saved:${saved.id}`, t: tzh }),
    (e) => e.key === 'setup.errors.unknownTemplate',
  );
});

test('TEMPLATE_DIR：放一個 JSON 就多一個類型，壞檔案跳過 / TEMPLATE_DIR adds a genre without code; a broken file is skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagerank-tpl-'));
  fs.writeFileSync(path.join(dir, 'gym.json'), JSON.stringify({
    key: 'gym-demo',
    genre: 'gymnastics',
    genreLabel: { 'zh-TW': '體操', en: 'Gymnastics' },
    label: { 'zh-TW': '體操範例', en: 'Gymnastics demo' },
    dances: [{ key: 'floor', style: 'x' }, { key: 'vault', style: 'x' }],
    danceNames: { floor: { 'zh-TW': '自由體操', en: 'Floor' }, vault: { 'zh-TW': '跳馬', en: 'Vault' } },
    plans: { general: { base: 100, includes: 1, extra: 50 } },
    categories: [{ key: 'kids', label: { 'zh-TW': '兒童', en: 'Kids' }, divisions: [
      { key: 'k1', name: { 'zh-TW': '兒童全能', en: 'Kids all-round' }, dances: ['floor', 'vault'], ageMax: 10, members: [1, 1] },
    ] }],
  }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ key: 'bad', genre: 'g', dances: [{ key: 'a' }], categories: [{ key: 'c', divisions: [{ key: 'd', dances: ['zzz'] }] }] }));
  fs.writeFileSync(path.join(dir, 'clash.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'gym.json'), 'utf8')), key: CURATED }));

  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  process.env.TEMPLATE_DIR = dir;
  try {
    catalogue.reload();
    assert.deepEqual(catalogue.listGenres().map((g) => g.key).sort(), ['ballroom', 'gymnastics']);
    assert.ok(catalogue.getTemplate('gym-demo'));
    assert.equal(catalogue.getTemplate('bad'), null);
    assert.equal(catalogue.getTemplate(CURATED).categories.length, 8, 'a built-in key cannot be replaced');
    assert.ok(warnings.length >= 3, `broken, invalid and clashing files are reported: ${warnings.join(' | ')}`);

    const rows = setup.planFor({ templateKey: 'gym-demo', t: tzh, locale: 'zh-TW' });
    assert.equal(rows[0].name, '兒童全能');
    assert.equal(rows[0].categoryLabel, '兒童');
    assert.deepEqual(rows[0].dances.map((d) => d.name), ['自由體操', '跳馬']);
    assert.equal(setup.planFor({ templateKey: 'gym-demo', t: ten, locale: 'en' })[0].name, 'Kids all-round');

    const model = await setup.pickerModel({ t: tzh, locale: 'zh-TW' });
    assert.ok(model.genres.some((g) => g.key === 'gymnastics' && g.label === '體操'));

    const competition = await comps.createCompetition({ name: 'Gym', feeCents: 0, status: 'draft' });
    const result = await setup.applyTemplate({ competitionId: competition.id, templateKey: 'gym-demo', t: tzh, plans: { general: { base: 120, includes: 1, extra: 60 } } });
    assert.equal(result.created, 1);
    assert.equal((await schedule.listDances(competition.id)).length, 2);
  } finally {
    console.warn = warn;
    delete process.env.TEMPLATE_DIR;
    catalogue.reload();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(catalogue.listGenres().map((g) => g.key), ['ballroom']);
});

test('設定頁：分組清單、分類全選、存成我的範本 / the setup page groups by category and saves my template', async () => {
  const http = await startServer(createApp());
  try {
    const login = await http.postForm('/admin/login', { token: 'test-admin-token' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const staff = { headers: { cookie } };
    const competition = await comps.createCompetition({ name: 'Page Cup', feeCents: 0, status: 'draft' });

    const page = await (await http.get(`/admin/c/${competition.id}/setup`, staff)).text();
    assert.match(page, /data-cat="pro"/);
    assert.match(page, /data-cat="proamGrowth"/);
    assert.match(page, /亞洲職業公開組\(拉丁舞五項\)/);
    assert.match(page, /name="plan_general_base" value="1800"/);
    assert.match(page, /通用國標舞（自動組合）/);
    assert.ok(!page.includes('setup.tw.'), 'no untranslated key leaks');

    // 用表單送出：只勾兩個，收費自己填。
    // Post the form: two ticked, fees typed in.
    const res = await http.postForm(`/admin/c/${competition.id}/setup/template`, {
      templateKey: CURATED,
      keys: ['asiaProOpenLatin', 'dreamStdW'],
      plan_general_base: '2100', plan_general_includes: '2', plan_general_extra: '650',
      plan_proAm_base: '2700', plan_proAm_includes: '1', plan_proAm_extra: '1300',
    }, staff);
    assert.equal(res.status, 303);
    assert.equal((await comps.listDivisions(competition.id)).length, 2);
    assert.equal(Number((await fees.listGroups(competition.id)).find((g) => g.name === '一般組').base_fee_cents), 2100);

    // 有組別之後出現「存成我的範本」。
    // With divisions in place the "save as my template" form appears.
    const built = await (await http.get(`/admin/c/${competition.id}/setup`, staff)).text();
    assert.match(built, /setup\/save-template/);
    const save = await http.postForm(`/admin/c/${competition.id}/setup/save-template`, { name: '網頁存的範本' }, staff);
    assert.equal(save.status, 303);
    assert.equal((await setup.listSaved()).length, 1);
    const done = await (await http.get(save.headers.get('location'), staff)).text();
    assert.match(done, /已存成範本「網頁存的範本」/);

    // 另一場空的比賽：選單裡有「我的範本」，預設選中上次用的，收費是上次填的。
    // Another empty competition: "My templates" is in the picker, the last used one is preselected
    // and the fees are the ones typed last time.
    const next = await comps.createCompetition({ name: 'Next Cup', feeCents: 0, status: 'draft' });
    const nextPage = await (await http.get(`/admin/c/${next.id}/setup`, staff)).text();
    assert.match(nextPage, /<option value="ballroom-tw"[^>]*selected/);
    assert.match(nextPage, /網頁存的範本/);
    assert.match(nextPage, /name="plan_general_base" value="2100"/);

    const bad = await http.postForm(`/admin/c/${next.id}/setup/save-template`, { name: 'nothing' }, staff);
    assert.equal(bad.status, 400, 'a competition with no divisions cannot be saved');
    const unknown = await http.postForm(`/admin/c/${next.id}/setup/template`, { templateKey: 'saved:99999', keys: ['x'] }, staff);
    assert.equal(unknown.status, 400);
  } finally {
    await http.close();
  }
});
