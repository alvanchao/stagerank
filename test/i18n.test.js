import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {
  translate,
  negotiateLocale,
  formatMoney,
  formatDateTime,
  availableLocales,
} from '../src/i18n/index.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const localesDir = path.resolve(here, '..', 'src', 'locales');
const srcDir = path.resolve(here, '..', 'src');

test('繁中與英文都載入得到 / both shipped locales load', () => {
  const codes = availableLocales().map((l) => l.code).sort();
  assert.deepEqual(codes, ['en', 'zh-TW']);
});

test('每個語言檔的 key 完全一樣，沒有漏翻 / all locale files have identical keys', () => {
  const flatten = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([key, value]) => {
      if (key === '_meta') return [];
      const full = prefix ? `${prefix}.${key}` : key;
      return value && typeof value === 'object' ? flatten(value, full) : [full];
    });

  const files = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'));
  const sets = files.map((file) => ({
    file,
    keys: flatten(JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'))).sort(),
  }));

  const reference = sets[0];
  for (const other of sets.slice(1)) {
    const missing = reference.keys.filter((k) => !other.keys.includes(k));
    const extra = other.keys.filter((k) => !reference.keys.includes(k));
    assert.deepEqual(missing, [], `${other.file} is missing: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${other.file} has extra: ${extra.join(', ')}`);
  }
});

test('程式裡不寫死中文 / no Chinese is hard-coded outside locale files and comments', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'locales') continue;
        walk(full);
        continue;
      }
      if (!/\.(js|ejs)$/.test(entry.name)) continue;
      // 先整份去掉跨行的註解，再逐行檢查。EJS 的 <%# %> 也是註解，不會出現在畫面上。
      // Strip multi-line comments from the whole file first, then check line by line. An EJS
      // <%# %> block is a comment too and never reaches the screen.
      const text = fs.readFileSync(full, 'utf8')
        .replace(/<%#[\s\S]*?%>/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      text.split(/\r?\n/).forEach((line, index) => {
        // 註解裡的中文是給維護者看的，不算畫面文字。
        // Chinese in comments is for maintainers, not user-visible text.
        const stripped = line
          .replace(/\/\/.*$/, '')
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/^\s*\*.*$/, '');
        if (/[一-鿿]/.test(stripped)) offenders.push(`${path.relative(srcDir, full)}:${index + 1}`);
      });
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, [], `hard-coded Chinese found at: ${offenders.join(', ')}`);
});

test('找不到翻譯時往回退，不會噴出 undefined / missing keys fall back rather than breaking', () => {
  assert.equal(translate('zh-TW', 'common.submit'), '送出');
  assert.equal(translate('en', 'common.submit'), 'Submit');
  assert.equal(translate('fr', 'common.submit'), 'Submit'); // unknown locale -> fallback
  assert.equal(translate('en', 'nope.not.here'), 'nope.not.here');
});

test('依瀏覽器語言自動切換 / the browser language decides the locale', () => {
  const pick = (accept, query, cookie) =>
    negotiateLocale({ acceptLanguage: accept, query, cookie, fallback: 'zh-TW' });

  assert.equal(pick('en-US,en;q=0.9'), 'en');
  assert.equal(pick('zh-TW,zh;q=0.9,en;q=0.8'), 'zh-TW');
  assert.equal(pick('ja,ko;q=0.8'), 'zh-TW', 'unsupported languages fall back to the default');
  assert.equal(pick('en-US,en;q=0.9', 'zh-TW'), 'zh-TW', 'an explicit choice wins over the browser');
  assert.equal(pick('en-US', undefined, 'zh-TW'), 'zh-TW', 'a remembered choice wins over the browser');
  assert.equal(pick('zh-HK'), 'zh-TW', 'a related variant maps to the closest shipped locale');
});

test('金額格式跟著語言和幣別走 / money follows locale and currency', () => {
  // TWD、JPY 沒有小數，不可以被除以 100。
  // TWD and JPY have no decimal part and must not be divided by 100.
  assert.match(formatMoney('zh-TW', 1200, 'TWD'), /1,200/);
  assert.ok(!formatMoney('zh-TW', 1200, 'TWD').includes('12.00'));
  assert.match(formatMoney('en', 1200, 'USD'), /12\.00/);
  assert.match(formatMoney('en', 1200, 'JPY'), /1,200/);
});

test('日期格式跟著語言走 / dates follow the locale', () => {
  const when = new Date('2026-09-22T01:30:00Z');
  const zh = formatDateTime('zh-TW', when, 'Asia/Taipei');
  const en = formatDateTime('en', when, 'Asia/Taipei');
  assert.ok(zh.includes('2026'));
  assert.ok(en.includes('2026'));
  assert.notEqual(zh, en);
  assert.equal(formatDateTime('en', null), '');
});

test('加新語言只要丟一個檔案進去 / adding a language is one file', async () => {
  const temp = path.join(localesDir, 'xx.json');
  const english = JSON.parse(fs.readFileSync(path.join(localesDir, 'en.json'), 'utf8'));
  english._meta = { name: 'Test', englishName: 'Test', code: 'xx', dateLocale: 'en' };
  english.common.submit = 'SUBMIT-XX';
  fs.writeFileSync(temp, JSON.stringify(english, null, 2));
  try {
    const { reload, translate: t2, availableLocales: list } = await import('../src/i18n/index.js');
    reload();
    assert.ok(list().some((l) => l.code === 'xx'));
    assert.equal(t2('xx', 'common.submit'), 'SUBMIT-XX');
  } finally {
    fs.unlinkSync(temp);
    const { reload } = await import('../src/i18n/index.js');
    reload();
  }
});
