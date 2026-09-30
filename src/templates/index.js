// 範本目錄：類型（第 1 層）→ 範本 → 分類（第 2 層）→ 組別（第 3 層）。
// 目錄是資料，不是程式：src/templates/*.json 內建，另外可用環境變數 TEMPLATE_DIR
// 指到自己的資料夾，放進去的 *.json 會一起載入，新增類型完全不必改程式。
// The template catalogue: genre (level 1) -> template -> category (level 2) -> division (level 3).
// The catalogue is data, not code: src/templates/*.json ships with the app, and TEMPLATE_DIR can
// point at a folder of your own whose *.json files are loaded alongside, so a new genre needs no
// code change.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));

let cache = null;

// 檢查一份範本檔的結構；壞掉的檔案跳過並警告，不讓整個網站起不來。
// Validate one template file. A broken file is skipped with a warning rather than stopping the site.
export function validate(def) {
  const problems = [];
  const isKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v);
  if (!def || typeof def !== 'object') return ['not an object'];
  if (!isKey(def.key)) problems.push('key missing or malformed');
  if (!isKey(def.genre)) problems.push('genre missing or malformed');
  if (!Array.isArray(def.dances) || def.dances.length === 0) problems.push('dances must be a non-empty list');
  if (!Array.isArray(def.categories) || def.categories.length === 0) problems.push('categories must be a non-empty list');
  const danceKeys = new Set((def.dances || []).map((d) => d?.key));
  const seen = new Set();
  const plans = def.plans || {};
  for (const cat of def.categories || []) {
    if (!isKey(cat?.key)) problems.push('a category has no key');
    for (const div of cat?.divisions || []) {
      if (!isKey(div?.key)) { problems.push('a division has no key'); continue; }
      if (seen.has(div.key)) problems.push(`duplicate division key ${div.key}`);
      seen.add(div.key);
      const list = div.dances || def.danceSets?.[div.set];
      if (!Array.isArray(list) || list.length === 0) problems.push(`${div.key} has no dances`);
      else for (const d of list) if (!danceKeys.has(d)) problems.push(`${div.key} uses unknown dance ${d}`);
      if (div.plan && !plans[div.plan]) problems.push(`${div.key} uses unknown plan ${div.plan}`);
    }
  }
  return problems;
}

function readDir(dir, into, { external }) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    if (external) console.warn(`[templates] cannot read TEMPLATE_DIR ${dir}: ${err.message}`);
    return;
  }
  for (const file of files) {
    try {
      const def = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const problems = validate(def);
      if (problems.length > 0) {
        console.warn(`[templates] skipped ${file}: ${problems.join('; ')}`);
        continue;
      }
      // 內建的先載入；自己的檔案不可以蓋掉內建的 key，免得行為悄悄改變。
      // Built-ins load first; a file of your own cannot replace a built-in key, so behaviour never
      // changes silently.
      if (into.has(def.key)) {
        console.warn(`[templates] skipped ${file}: key ${def.key} already exists`);
        continue;
      }
      into.set(def.key, { ...def, kind: 'curated' });
    } catch (err) {
      console.warn(`[templates] skipped ${file}: ${err.message}`);
    }
  }
}

function load() {
  if (cache) return cache;
  const map = new Map();
  readDir(here, map, { external: false });
  const extra = process.env.TEMPLATE_DIR;
  if (extra && extra.trim()) readDir(path.resolve(extra.trim()), map, { external: true });
  cache = map;
  return cache;
}

// 測試或熱更新用：重新讀一次。
// For tests or a hot reload: read everything again.
export function reload() {
  cache = null;
  return load();
}

export function getTemplate(key) {
  return load().get(key) || null;
}

export function listTemplates({ genre } = {}) {
  return [...load().values()].filter((t) => !genre || t.genre === genre);
}

// 有哪些類型（第 1 層）。標籤用 setup.genres.<key>，也可以在範本檔裡寫 genreLabel。
// The genres (level 1). The label is setup.genres.<key>, or a genreLabel inside a template file.
export function listGenres() {
  const genres = new Map();
  for (const tpl of load().values()) {
    if (!genres.has(tpl.genre)) genres.set(tpl.genre, { key: tpl.genre, labelKey: `setup.genres.${tpl.genre}`, label: tpl.genreLabel || null });
  }
  return [...genres.values()];
}

export default { listGenres, listTemplates, getTemplate, reload, validate };
