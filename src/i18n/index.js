// 多語系：所有畫面文字都在 src/locales/*.json，程式裡不寫死任何一句中文或英文。
// i18n: every visible string lives in src/locales/*.json. No Chinese or English is hard-coded in the code.
//
// 要加新語言：複製 en.json、翻譯、存成 <語言代碼>.json 放回同一個資料夾，重開就會出現。
// To add a language: copy en.json, translate it, save it as <code>.json in the same folder, restart.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const localesDir = path.resolve(here, '..', 'locales');

const catalogues = new Map();
let fallbackLocale = 'en';

function loadAll() {
  catalogues.clear();
  for (const file of fs.readdirSync(localesDir)) {
    if (!file.endsWith('.json')) continue;
    const code = path.basename(file, '.json');
    try {
      catalogues.set(code, JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8')));
    } catch (err) {
      console.error(`[i18n] could not read ${file}: ${err.message}`);
    }
  }
  if (!catalogues.has(fallbackLocale)) {
    fallbackLocale = catalogues.keys().next().value || 'en';
  }
}

loadAll();

export function availableLocales() {
  return [...catalogues.entries()].map(([code, cat]) => ({
    code,
    name: cat?._meta?.name || code,
    englishName: cat?._meta?.englishName || code,
  }));
}

export function hasLocale(code) {
  return catalogues.has(code);
}

function lookup(catalogue, key) {
  let node = catalogue;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

// 找不到翻譯時往回退：完整代碼 → 語言代碼 → 預設語言 → key 本身。
// Missing string falls back: exact code -> base language -> fallback locale -> the key itself.
export function translate(locale, key, params) {
  const candidates = [locale, locale?.split('-')[0], fallbackLocale];
  let text;
  for (const code of candidates) {
    if (!code) continue;
    const catalogue = catalogues.get(code);
    if (!catalogue) continue;
    text = lookup(catalogue, key);
    if (text !== undefined) break;
  }
  if (text === undefined) return key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

function dateLocaleFor(locale) {
  const catalogue = catalogues.get(locale) || catalogues.get(locale?.split('-')[0]);
  return catalogue?._meta?.dateLocale || locale || fallbackLocale;
}

// 日期、時間、金額的格式跟著語言和幣別走。
// Dates, times and money follow the locale and the currency.
export function formatMoney(locale, cents, currency) {
  const zeroDecimal = new Set(['TWD', 'JPY', 'KRW', 'VND', 'CLP', 'ISK']);
  const code = (currency || 'TWD').toUpperCase();
  const value = zeroDecimal.has(code) ? cents : cents / 100;
  try {
    return new Intl.NumberFormat(dateLocaleFor(locale), {
      style: 'currency',
      currency: code,
      maximumFractionDigits: zeroDecimal.has(code) ? 0 : 2,
    }).format(value);
  } catch {
    return `${code} ${value}`;
  }
}

export function formatDateTime(locale, value, timeZone) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(dateLocaleFor(locale), {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timeZone || undefined,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

// 從 cookie、網址參數或瀏覽器的 Accept-Language 決定語言。
// Pick the locale from a cookie, a query parameter, or the browser's Accept-Language header.
export function negotiateLocale({ query, cookie, acceptLanguage, fallback }) {
  const wanted = [query, cookie].filter(Boolean);
  for (const code of wanted) {
    if (catalogues.has(code)) return code;
    const base = code.split('-')[0];
    const match = [...catalogues.keys()].find((c) => c === base || c.split('-')[0] === base);
    if (match) return match;
  }

  const ranked = (acceptLanguage || '')
    .split(',')
    .map((part) => {
      const [tag, ...rest] = part.trim().split(';');
      const q = rest.find((r) => r.trim().startsWith('q='));
      return { tag: tag.trim(), q: q ? Number.parseFloat(q.split('=')[1]) || 0 : 1 };
    })
    .filter((entry) => entry.tag)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    if (catalogues.has(tag)) return tag;
    const base = tag.split('-')[0];
    const match = [...catalogues.keys()].find((c) => c === base || c.split('-')[0] === base);
    if (match) return match;
  }

  return catalogues.has(fallback) ? fallback : fallbackLocale;
}

export function reload() {
  loadAll();
}
