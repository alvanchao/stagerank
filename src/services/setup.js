// 把比賽設定起來，而不必一項一項建。
// 兩條路：跟以前辦過的一樣就整套複製；第一次辦就套範本。
// Getting a competition set up without building it one item at a time.
// Two roads: copy an event that has run before, or start from a template.
import { one, many, withTransaction } from '../db/index.js';
import * as comps from './competitions.js';
import * as feeGroups from './feeGroups.js';
import * as schedule from './schedule.js';
import * as catalogue from '../templates/index.js';

export class SetupError extends Error {
  constructor(key, params = null) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

// ------------------------------------------------------------------ 複製 / copying

// 複製的是「設定」，不是「那一場比賽」：舞科、收費方案、組別、組別的舞科清單。
// 報名、成績、憑證碼一概不動——那是去年的事。
// What is copied is the setup, not the event: dances, fee plans, divisions and each division's
// dance list. Entries, results and the voucher stay behind; they belong to last year.
export async function copyFrom(sourceCompetitionId, targetCompetitionId) {
  const source = await comps.getCompetition(sourceCompetitionId);
  const target = await comps.getCompetition(targetCompetitionId);
  if (!source || !target) throw new SetupError('errors.notFound');
  if (String(source.id) === String(target.id)) throw new SetupError('setup.errors.sameCompetition');

  const existing = await comps.listDivisions(target.id);
  if (existing.length > 0) throw new SetupError('setup.errors.alreadyHasDivisions');

  // 年齡算法跟著複製，比賽日期不跟：日期一定是新的。
  // The age rule carries over; the date does not, because the date is always new.
  await comps.setAgeRule(target.id, { ageBasis: source.age_basis, eventDate: target.event_date });

  const danceMap = new Map();
  for (const dance of await schedule.listDances(source.id)) {
    const copy = await schedule.addDance({
      competitionId: target.id, name: dance.name, sortOrder: dance.sort_order,
    });
    danceMap.set(String(dance.id), copy.id);
  }

  const groupMap = new Map();
  for (const group of await feeGroups.listGroups(source.id)) {
    const copy = await feeGroups.createGroup({
      competitionId: target.id,
      name: group.name,
      baseFeeCents: group.base_fee_cents,
      baseIncludes: group.base_includes,
      extraItemFeeCents: group.extra_item_fee_cents,
      sortOrder: group.sort_order,
    });
    groupMap.set(String(group.id), copy.id);
  }

  let divisions = 0;
  for (const division of await comps.listDivisions(source.id)) {
    const copy = await comps.addDivision({
      competitionId: target.id,
      name: division.name,
      feeCents: division.fee_cents,
      sortOrder: division.sort_order,
      memberMin: division.member_min,
      memberMax: division.member_max,
      feeMode: division.fee_mode,
      extraDivisionFeeCents: division.extra_division_fee_cents,
      ageMin: division.age_min,
      ageMax: division.age_max,
      feeGroupId: division.fee_group_id ? groupMap.get(String(division.fee_group_id)) : null,
      category: division.category,
    });
    divisions += 1;

    const dances = await schedule.dancesForDivision(division.id);
    if (dances.length > 0) {
      await schedule.setDivisionDances(copy.id, dances.map((d) => danceMap.get(String(d.id))).filter(Boolean));
    }
  }

  return { divisions, feeGroups: groupMap.size, dances: danceMap.size };
}

// 辦過的比賽：拿來當複製來源。草稿也列出來，因為主辦可能才建到一半。
// Past competitions, offered as sources to copy. Drafts are listed too: the organiser may have
// been halfway through building one.
export async function copyableCompetitions(excludeId) {
  return many(
    `SELECT c.*, COUNT(d.id)::int AS division_count
     FROM competitions c
     LEFT JOIN divisions d ON d.competition_id = c.id
     WHERE c.id <> $1
     GROUP BY c.id
     HAVING COUNT(d.id) > 0
     ORDER BY c.created_at DESC
     LIMIT 20`,
    [excludeId],
  );
}

// ------------------------------------------------------------------ 範本 / templates

// 範本有三種來源，同一條路徑處理：
//   generated  程式產生的「通用國標舞」（下面的 TEMPLATES.ballroom）
//   curated    src/templates/*.json（與 TEMPLATE_DIR）裡的資料目錄，例如 ballroom-tw
//   saved      主辦自己「存成我的範本」存進資料庫的，key 是 saved:<id>
// Templates come from three sources and share one path: generated (the "generic ballroom" below),
// curated (the data catalogue in src/templates/*.json and TEMPLATE_DIR, e.g. ballroom-tw) and
// saved (the organiser's own "save as my template", stored in the database, key saved:<id>).

// 內建範本：國標舞。年齡組只設上限，所以 13 歲的孩子 U13、U15、U18 都報得了，U11 報不了——
// 這正是實務上的規則，不必另外寫邏輯。成人組只設下限。師生組年齡兩邊都留空，
// 因為老師的年紀不是重點。
// The built-in ballroom template. Age groups set only an upper bound, so a 13-year-old can enter
// U13, U15 and U18 but not U11 — which is the real-world rule and needs no special logic. Adult
// divisions set only a lower bound. Pro-am leaves both blank, since the teacher's age is not
// the point.
export const TEMPLATES = {
  ballroom: {
    key: 'ballroom',
    kind: 'generated',
    genre: 'ballroom',
    labelKey: 'setup.templates.ballroom',
    // 收費方案是範本宣告的預設值，畫面拿來預填；套用時可以被覆蓋。
    // The fee plans are the template's declared defaults, used to prefill the screen and
    // overridable when applying.
    plans: {
      general: { base: 1800, includes: 2, extra: 600 },
      proAm: { base: 2500, includes: 1, extra: 1200 },
    },
    // 舞科名稱跟著語言走：中文的比賽秩序表上該寫「恰恰」，不是 Cha Cha。
    // 存進資料庫的就是翻好的名字，因為舞科本來就是每場比賽自己的一份清單。
    // Dance names follow the language: a Chinese running order should say 恰恰, not Cha Cha.
    // The translated name is what goes into the database, since each competition keeps its own
    // list of dances anyway.
    dances: [
      { key: 'chaCha', style: 'latin' },
      { key: 'samba', style: 'latin' },
      { key: 'rumba', style: 'latin' },
      { key: 'pasoDoble', style: 'latin' },
      { key: 'jive', style: 'latin' },
      { key: 'waltz', style: 'standard' },
      { key: 'tango', style: 'standard' },
      { key: 'vienneseWaltz', style: 'standard' },
      { key: 'slowFoxtrot', style: 'standard' },
      { key: 'quickstep', style: 'standard' },
    ],
    // 只出五項和單項。三項各地的舞科組合不一樣，猜錯比沒做還糟，
    // 主辦自己挑舞科的畫面本來就有。
    // Five-dance and single-dance only. Which three dances make up a three-dance event differs by
    // region, and guessing wrong is worse than not offering it; picking dances by hand is already
    // a screen that exists.
    ageGroups: [
      { key: 'u10', ageMax: 10 },
      { key: 'u12', ageMax: 12 },
      { key: 'u14', ageMax: 14 },
      { key: 'u16', ageMax: 16 },
      { key: 'u18', ageMax: 18 },
      { key: 'adult', ageMin: 19 },
      { key: 'senior', ageMin: 35 },
    ],
    styles: ['latin', 'standard'],
  },
};

export function templateKeys() {
  return [...Object.keys(TEMPLATES), ...catalogue.listTemplates().map((t) => t.key)];
}

// 內建（不用查資料庫）的範本；saved: 開頭的要用 resolveTemplate。
// A template that needs no database lookup; saved: keys go through resolveTemplate.
export function staticTemplate(key) {
  return TEMPLATES[key] || catalogue.getTemplate(key) || null;
}

// 選單用：類型 → 範本。順序是資料目錄的範本在前，自動組合的在後。
// For the picker: genre -> template. Catalogue templates first, the auto-combined one after.
export function pickerTemplates() {
  const rows = catalogue.listTemplates().map((tpl) => ({
    key: tpl.key, genre: tpl.genre, kind: tpl.kind, labelKey: tpl.labelKey || null, label: tpl.label || null,
  }));
  for (const tpl of Object.values(TEMPLATES)) {
    rows.push({ key: tpl.key, genre: tpl.genre, kind: tpl.kind, labelKey: tpl.labelKey, label: null });
  }
  return rows;
}

export function pickerGenres() {
  const genres = new Map(catalogue.listGenres().map((g) => [g.key, g]));
  for (const tpl of Object.values(TEMPLATES)) {
    if (!genres.has(tpl.genre)) genres.set(tpl.genre, { key: tpl.genre, labelKey: `setup.genres.${tpl.genre}`, label: null });
  }
  return [...genres.values()];
}

// 範本檔裡的字可以是字串，也可以是 {"zh-TW": "...", "en": "..."}。
// A string in a template file may be plain text or {"zh-TW": "...", "en": "..."}.
function pick(value, locale) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return value[locale] || value[String(locale || '').split('-')[0]] || value['zh-TW'] || Object.values(value)[0] || null;
}

// 標籤：先找語言檔的 key，找不到（翻譯函式原樣回傳 key）就用後備字串。
// A label: try the locale key first; when it comes back unchanged (missing), use the fallback.
function labeller(t) {
  return (key, params) => (t ? t(key, params) : key);
}

function categoryLabelOf(label, key, fallback) {
  const full = `setup.categories.${key}`;
  const value = label(full);
  return value === full ? (fallback || key) : value;
}

// 收費方案接受兩種寫法：範本用的 {base, includes, extra}，和舊的 {baseFeeCents, ...}。
// A fee plan comes in two spellings: the template's {base, includes, extra} and the older
// {baseFeeCents, ...}.
export function normalisePlan(plan) {
  const p = plan || {};
  const num = (v, d) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };
  return {
    baseFeeCents: num(p.baseFeeCents ?? p.base, 0),
    baseIncludes: Math.max(1, num(p.baseIncludes ?? p.includes, 1)),
    extraItemFeeCents: num(p.extraItemFeeCents ?? p.extra, 0),
  };
}

// 範本的收費方案與舞科順序：套用與畫面預填都從這裡拿。
// The template's fee plans and dance order; applying and the screen's prefill both read this.
export function planMeta({ templateKey = 'ballroom', t, template = null }) {
  const tpl = template || staticTemplate(templateKey);
  if (!tpl) throw new SetupError('setup.errors.unknownTemplate');
  const label = labeller(t);
  const plans = {};
  for (const [key, plan] of Object.entries(tpl.plans || {})) {
    const norm = normalisePlan(plan);
    plans[key] = {
      key,
      name: plan.name ? pick(plan.name, 'zh-TW') : label(`setup.plans.${key}`),
      base: norm.baseFeeCents,
      includes: norm.baseIncludes,
      extra: norm.extraItemFeeCents,
    };
  }
  const danceOrder = tpl.kind === 'saved'
    ? (tpl.payload.dances || [])
    : tpl.dances.map((d) => d.key);
  return { plans, danceOrder };
}

// 範本攤平成一份「候選項目」清單，每一項都帶著它的舞科。
// 主辦看到的是一份已經產生好的清單，用關掉的方式篩，比從空白勾出來輕鬆得多。
// 每一列：{ key, name, dances:[{key,name}], ageMin, ageMax, memberMin, memberMax, group, category }。
// The template is flattened into a list of candidate divisions, each carrying its dances.
// The organiser sees a list that already exists and removes what they do not want, which is far
// less work than ticking items out of an empty grid.
// Each row: { key, name, dances:[{key,name}], ageMin, ageMax, memberMin, memberMax, group, category }.
export function planFor({ templateKey = 'ballroom', t, template = null, locale = 'zh-TW' }) {
  const tpl = template || staticTemplate(templateKey);
  if (!tpl) throw new SetupError('setup.errors.unknownTemplate');
  const label = labeller(t);
  if (tpl.kind === 'curated') return curatedRows(tpl, label, locale);
  if (tpl.kind === 'saved') return savedRows(tpl, label);
  return generatedRows(tpl, label);
}

function curatedRows(tpl, label, locale) {
  const order = tpl.dances.map((d) => d.key);
  const danceName = (key) => (tpl.danceNames?.[key] ? pick(tpl.danceNames[key], locale) : label(`setup.dances.${key}`));
  const prefix = tpl.nameKeyPrefix || `setup.${tpl.key}`;
  const defaultPlan = Object.keys(tpl.plans || {})[0] || null;
  const rows = [];
  for (const cat of tpl.categories) {
    const categoryLabel = categoryLabelOf(label, cat.key, pick(cat.label, locale));
    for (const div of cat.divisions) {
      const keys = [...(div.dances || tpl.danceSets[div.set])].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const [memberMin, memberMax] = div.members || [2, 2];
      rows.push({
        key: div.key,
        name: div.name ? pick(div.name, locale) : label(`${prefix}.${div.key}`),
        dances: keys.map((key) => ({ key, name: danceName(key) })),
        ageMin: div.ageMin ?? null,
        ageMax: div.ageMax ?? null,
        memberMin,
        memberMax,
        group: div.plan || defaultPlan,
        category: cat.key,
        categoryLabel,
      });
    }
  }
  return rows;
}

function savedRows(tpl, label) {
  const { payload } = tpl;
  return (payload.divisions || []).map((div) => {
    const category = div.category || null;
    return {
      key: div.key,
      name: div.name,
      dances: (div.dances || []).map((name) => ({ key: name, name })),
      ageMin: div.ageMin ?? null,
      ageMax: div.ageMax ?? null,
      memberMin: div.memberMin ?? 1,
      memberMax: div.memberMax ?? div.memberMin ?? 1,
      group: div.group || null,
      category: category || 'uncategorised',
      categoryLabel: category
        ? categoryLabelOf(label, category, payload.categoryLabels?.[category])
        : label('setup.categories.uncategorised'),
      feeCents: div.feeCents ?? null,
      feeMode: div.feeMode || 'per_entry',
      extraDivisionFeeCents: div.extraDivisionFeeCents || 0,
    };
  });
}

function generatedRows(template, label) {
  const rows = [];
  const catLabel = (key) => categoryLabelOf(label, key, key);
  for (const style of template.styles) {
    const dances = template.dances
      .filter((d) => d.style === style)
      .map((d) => ({ key: d.key, name: label(`setup.dances.${d.key}`) }));
    for (const group of template.ageGroups) {
      // 五項
      rows.push({
        key: `${group.key}-${style}-five`,
        name: label('setup.names.fiveDance', {
          age: label(`setup.ages.${group.key}`),
          style: label(`setup.styles.${style}`),
        }),
        dances,
        ageMin: group.ageMin ?? null,
        ageMax: group.ageMax ?? null,
        memberMin: 2,
        memberMax: 2,
        group: 'general',
        category: style,
        categoryLabel: catLabel(style),
      });
      // 單項
      for (const dance of dances) {
        rows.push({
          key: `${group.key}-${style}-${dance.key}`,
          name: label('setup.names.singleDance', {
            age: label(`setup.ages.${group.key}`),
            dance: dance.name,
          }),
          dances: [dance],
          ageMin: group.ageMin ?? null,
          ageMax: group.ageMax ?? null,
          memberMin: 2,
          memberMax: 2,
          group: 'general',
          category: style,
          categoryLabel: catLabel(style),
        });
      }
    }
  }

  // 師生組：年齡不檢，自己一個收費方案。
  // Pro-am: no age check, and a fee plan of its own.
  for (const style of template.styles) {
    const dances = template.dances
      .filter((d) => d.style === style)
      .map((d) => ({ key: d.key, name: label(`setup.dances.${d.key}`) }));
    for (const dance of dances) {
      rows.push({
        key: `proam-${style}-${dance.key}`,
        name: label('setup.names.proAm', { dance: dance.name }),
        dances: [dance],
        ageMin: null,
        ageMax: null,
        memberMin: 2,
        memberMax: 2,
        group: 'proAm',
        category: 'proAm',
        categoryLabel: catLabel('proAm'),
      });
    }
  }
  return rows;
}

// 找範本：內建的直接拿，saved:<id> 去資料庫讀，讀出來長得跟內建的一樣。
// Find a template: built-ins directly, saved:<id> from the database, shaped like a built-in.
export async function resolveTemplate(templateKey) {
  const key = String(templateKey || 'ballroom');
  const match = /^saved:(\d+)$/.exec(key);
  if (match) {
    const saved = await getSaved(Number.parseInt(match[1], 10));
    if (!saved) throw new SetupError('setup.errors.unknownTemplate');
    return savedAsTemplate(saved);
  }
  const tpl = staticTemplate(key);
  if (!tpl) throw new SetupError('setup.errors.unknownTemplate');
  return tpl;
}

function savedAsTemplate(saved) {
  return {
    key: `saved:${saved.id}`,
    kind: 'saved',
    genre: 'mine',
    savedId: saved.id,
    name: saved.name,
    payload: saved.payload,
    plans: saved.payload.plans || {},
  };
}

// 套用範本：只建被選中的項目，舞科一起掛好，收費方案也建起來。
// 生出來就是能跑的組別，主辦不必再替四十幾個組別一個一個掛舞科。
// 收費方案的優先順序：plans（新，依方案 key）> generalPlan / proAmPlan（舊）> 我的範本自己存的收費 > 全部 0。
// Applying the template creates only the chosen rows, wires up their dances and builds the fee
// plans. What comes out can actually run, so nobody has to attach dances to forty divisions.
// Fee plan precedence: plans (new, by plan key) > generalPlan / proAmPlan (old) > the saved template's own fees > all zero.
export async function applyTemplate({
  competitionId, templateKey = 'ballroom', keys, t, locale = 'zh-TW',
  plans = null, generalPlan = null, proAmPlan = null,
}) {
  const competition = await comps.getCompetition(competitionId);
  if (!competition) throw new SetupError('errors.notFound');

  const existing = await comps.listDivisions(competitionId);
  if (existing.length > 0) throw new SetupError('setup.errors.alreadyHasDivisions');

  const template = await resolveTemplate(templateKey);
  const rows = planFor({ templateKey, t, template, locale });
  const wanted = keys && keys.length > 0
    ? rows.filter((row) => keys.includes(row.key))
    : rows;
  if (wanted.length === 0) throw new SetupError('setup.errors.nothingChosen');

  const meta = planMeta({ templateKey, t, template });

  // 舞科只建被用到的那幾支。
  // Only the dances something actually uses are created.
  const needed = new Map();
  for (const row of wanted) {
    for (const dance of row.dances) needed.set(dance.key, dance.name);
  }
  const danceMap = new Map();
  for (const [key, name] of needed) {
    const order = meta.danceOrder.indexOf(key);
    const dance = await schedule.addDance({ competitionId, name, sortOrder: order });
    danceMap.set(key, dance.id);
  }

  // 每個被用到的方案建一個收費群組。
  // One fee group per plan that is actually used.
  const legacy = { general: generalPlan, proAm: proAmPlan };
  const used = Object.keys(meta.plans).filter((key) => wanted.some((row) => row.group === key));
  const groups = {};
  const effective = {};
  for (const [index, key] of used.entries()) {
    // 我的範本存的就是當時的收費，沒指定就沿用；內建範本沒指定維持 0（跟以前一樣）。
    // A saved template stores the fees it was made with, so unspecified means reuse them; a built-in
    // template left unspecified stays at zero, as it always did.
    const declared = template.kind === 'saved' ? meta.plans[key] : null;
    const chosen = normalisePlan(plans?.[key] || legacy[key] || declared);
    groups[key] = await feeGroups.createGroup({
      competitionId, name: meta.plans[key].name, sortOrder: index + 1, ...chosen,
    });
    effective[key] = { base: chosen.baseFeeCents, includes: chosen.baseIncludes, extra: chosen.extraItemFeeCents };
  }

  let created = 0;
  for (const [index, row] of wanted.entries()) {
    const group = groups[row.group];
    const division = await comps.addDivision({
      competitionId,
      name: row.name,
      feeCents: row.feeCents ?? null,
      sortOrder: index + 1,
      memberMin: row.memberMin,
      memberMax: row.memberMax,
      feeMode: group ? 'tiered' : (row.feeMode || 'per_entry'),
      extraDivisionFeeCents: row.extraDivisionFeeCents || 0,
      feeGroupId: group ? group.id : null,
      ageMin: row.ageMin,
      ageMax: row.ageMax,
      category: row.category === 'uncategorised' ? null : row.category,
    });
    await schedule.setDivisionDances(division.id, row.dances.map((dance) => danceMap.get(dance.key)));
    created += 1;
  }

  // 記住這次的選擇，下次開同一個範本時預填。記不起來也不影響這次的結果。
  // Remember this choice to prefill the next time the same template is opened. Failing to
  // remember never affects what was just built.
  try {
    await setSetting(`setup.last.${template.key}`, {
      templateKey: template.key, plans: effective, keys: wanted.map((row) => row.key),
    });
    await setSetting('setup.lastTemplate', { templateKey: template.key });
  } catch (err) {
    console.warn('[setup] could not remember last used template:', err.message);
  }

  return { created, dances: danceMap.size, groups: Object.keys(groups).length };
}

// 設定頁的選單資料：類型 → 範本 → 分類 → 組別，加上每個範本預填的收費與勾選。
// 預填先看「上次用這個範本的選擇」，沒有才用範本自己宣告的預設。
// The data behind the setup page's picker: genre -> template -> category -> division, plus each
// template's prefilled fees and ticks. The last choice made with that template wins; without one
// the template's own declared defaults apply.
export async function pickerModel({ t, locale = 'zh-TW' }) {
  const label = labeller(t);
  const saved = await listSaved();
  const entries = pickerTemplates().map((entry) => ({ ...entry, template: staticTemplate(entry.key) }));
  for (const row of saved) {
    const template = savedAsTemplate(row);
    entries.push({ key: template.key, genre: 'mine', kind: 'saved', labelKey: null, label: row.name, template, savedId: row.id });
  }

  const panels = [];
  for (const entry of entries) {
    const rows = planFor({ templateKey: entry.key, t, template: entry.template, locale });
    const meta = planMeta({ templateKey: entry.key, t, template: entry.template });
    const last = await lastUsed(entry.key);
    const plans = Object.values(meta.plans).map((plan) => ({ ...plan, ...(last?.plans?.[plan.key] || {}) }));
    const remembered = Array.isArray(last?.keys) ? new Set(last.keys) : null;
    // 上次的勾選裡一個都對不上（範本改過了），就當作沒記過。
    // If none of the remembered ticks matches any more (the template changed), treat it as never remembered.
    const useRemembered = remembered && rows.some((row) => remembered.has(row.key));

    const categories = [];
    for (const row of rows) {
      let bucket = categories.find((c) => c.key === row.category);
      if (!bucket) {
        bucket = { key: row.category, label: row.categoryLabel || row.category, rows: [] };
        categories.push(bucket);
      }
      bucket.rows.push({ ...row, checked: useRemembered ? remembered.has(row.key) : true });
    }
    panels.push({
      key: entry.key,
      genre: entry.genre,
      kind: entry.kind,
      savedId: entry.savedId || null,
      label: entry.label ? pick(entry.label, locale) : label(entry.labelKey),
      plans,
      categories,
      total: rows.length,
      remembered: Boolean(useRemembered),
    });
  }

  const genres = pickerGenres().map((g) => ({ key: g.key, label: g.label ? pick(g.label, locale) : label(g.labelKey) }));
  if (saved.length > 0) genres.push({ key: 'mine', label: label('setup.myTemplates') });

  const lastPick = await getSetting('setup.lastTemplate');
  const preferred = [lastPick?.templateKey, 'ballroom-tw'].find((key) => key && panels.some((p) => p.key === key));
  const selected = preferred || panels[0]?.key || null;
  return { genres, panels, selected };
}

// ------------------------------------------------------------------ 記住上次 / remembering

export async function getSetting(key) {
  const row = await one('SELECT value FROM app_settings WHERE key = $1', [key]);
  return row ? row.value : null;
}

export async function setSetting(key, value) {
  await one(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     RETURNING key`,
    [key, JSON.stringify(value)],
  );
}

export function lastUsed(templateKey) {
  return getSetting(`setup.last.${templateKey}`);
}

// ------------------------------------------------------------------ 我的範本 / my templates

export function listSaved() {
  return many('SELECT * FROM saved_templates ORDER BY name');
}

export function getSaved(id) {
  return one('SELECT * FROM saved_templates WHERE id = $1', [id]);
}

export async function deleteSaved(id) {
  await one('DELETE FROM saved_templates WHERE id = $1 RETURNING id', [id]);
  await one('DELETE FROM app_settings WHERE key = $1 RETURNING key', [`setup.last.saved:${id}`]);
}

// 把這場比賽現在的組別存成範本：名稱、舞科、年齡、人數、收費方案都照字面存，
// 不靠語言檔，所以換語言、換比賽都套得回來。同名就覆蓋，等於「更新我的範本」。
// Save this competition's divisions as a template. Names, dances, ages, member limits and fee plans
// are stored literally, independent of the locale files. The same name overwrites, which is how a
// template is updated.
export async function saveAsTemplate({ competitionId, name, t }) {
  const title = String(name || '').trim().slice(0, 80);
  if (!title) throw new SetupError('setup.errors.templateNameRequired');
  const divisions = await comps.listDivisions(competitionId);
  if (divisions.length === 0) throw new SetupError('setup.errors.nothingToSave');

  const label = labeller(t);
  const groupRows = await feeGroups.listGroups(competitionId);
  const planKeyOf = new Map();
  const plans = {};
  for (const [index, group] of groupRows.entries()) {
    const key = `plan${index + 1}`;
    planKeyOf.set(String(group.id), key);
    plans[key] = {
      name: group.name,
      base: Number(group.base_fee_cents),
      includes: Number(group.base_includes),
      extra: Number(group.extra_item_fee_cents),
    };
  }

  const dances = (await schedule.listDances(competitionId)).map((d) => d.name);
  const categoryLabels = {};
  const rows = [];
  for (const [index, division] of divisions.entries()) {
    if (division.category && !(division.category in categoryLabels)) {
      categoryLabels[division.category] = categoryLabelOf(label, division.category, division.category);
    }
    rows.push({
      key: `d${index + 1}`,
      name: division.name,
      dances: (await schedule.dancesForDivision(division.id)).map((d) => d.name),
      ageMin: division.age_min ?? null,
      ageMax: division.age_max ?? null,
      memberMin: division.member_min,
      memberMax: division.member_max,
      group: division.fee_group_id ? (planKeyOf.get(String(division.fee_group_id)) || null) : null,
      category: division.category || null,
      feeMode: division.fee_mode,
      feeCents: division.fee_cents === null || division.fee_cents === undefined ? null : Number(division.fee_cents),
      extraDivisionFeeCents: Number(division.extra_division_fee_cents || 0),
    });
  }

  const payload = { version: 1, dances, plans, categoryLabels, divisions: rows };
  return one(
    `INSERT INTO saved_templates (name, payload) VALUES ($1, $2::jsonb)
     ON CONFLICT (name) DO UPDATE SET payload = EXCLUDED.payload
     RETURNING *`,
    [title, JSON.stringify(payload)],
  );
}

// ------------------------------------------------------------------ 重來 / starting over

// 還沒有人報名就可以整批清掉重來。有人報名之後鎖住——那時候動組別，名單會對不上。
// Everything can be cleared and rebuilt while nobody has entered. Once somebody has, it locks:
// moving divisions at that point makes the roster stop adding up.
export async function clearSetup(competitionId) {
  const entered = await one(
    'SELECT 1 FROM registrations WHERE competition_id = $1 LIMIT 1',
    [competitionId],
  );
  if (entered) throw new SetupError('setup.errors.alreadyEntered');

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'DELETE FROM divisions WHERE competition_id = $1 RETURNING id',
      [competitionId],
    );
    await client.query('DELETE FROM fee_groups WHERE competition_id = $1', [competitionId]);
    await client.query('DELETE FROM dances WHERE competition_id = $1', [competitionId]);
    return { removed: rows.length };
  });
}

export async function canClear(competitionId) {
  const entered = await one('SELECT 1 FROM registrations WHERE competition_id = $1 LIMIT 1', [competitionId]);
  return !entered;
}

export default {
  SetupError,
  TEMPLATES,
  templateKeys,
  staticTemplate,
  resolveTemplate,
  pickerTemplates,
  pickerGenres,
  normalisePlan,
  planMeta,
  planFor,
  pickerModel,
  applyTemplate,
  getSetting,
  setSetting,
  lastUsed,
  listSaved,
  getSaved,
  deleteSaved,
  saveAsTemplate,
  copyFrom,
  copyableCompetitions,
  clearSetup,
  canClear,
};
