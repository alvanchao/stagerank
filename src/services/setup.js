// 把比賽設定起來，而不必一項一項建。
// 兩條路：跟以前辦過的一樣就整套複製；第一次辦就套範本。
// Getting a competition set up without building it one item at a time.
// Two roads: copy an event that has run before, or start from a template.
import { one, many, withTransaction } from '../db/index.js';
import * as comps from './competitions.js';
import * as feeGroups from './feeGroups.js';
import * as schedule from './schedule.js';

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
  return Object.keys(TEMPLATES);
}

// 範本攤平成一份「候選項目」清單，每一項都帶著它的舞科。
// 主辦看到的是一份已經產生好的清單，用關掉的方式篩，比從空白勾出來輕鬆得多。
// The template is flattened into a list of candidate divisions, each carrying its dances.
// The organiser sees a list that already exists and removes what they do not want, which is far
// less work than ticking items out of an empty grid.
export function planFor({ templateKey = 'ballroom', t }) {
  const template = TEMPLATES[templateKey];
  if (!template) throw new SetupError('setup.errors.unknownTemplate');
  const label = (key, params) => (t ? t(key, params) : key);

  const rows = [];
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
      });
    }
  }

  return rows;
}

// 套用範本：只建被選中的項目，舞科一起掛好，收費方案也建起來。
// 生出來就是能跑的組別，主辦不必再替四十幾個組別一個一個掛舞科。
// Applying the template creates only the chosen rows, wires up their dances and builds the fee
// plans. What comes out can actually run, so nobody has to attach dances to forty divisions.
export async function applyTemplate({
  competitionId, templateKey = 'ballroom', keys, t,
  generalPlan = { baseFeeCents: 0, baseIncludes: 1, extraItemFeeCents: 0 },
  proAmPlan = { baseFeeCents: 0, baseIncludes: 1, extraItemFeeCents: 0 },
}) {
  const competition = await comps.getCompetition(competitionId);
  if (!competition) throw new SetupError('errors.notFound');

  const existing = await comps.listDivisions(competitionId);
  if (existing.length > 0) throw new SetupError('setup.errors.alreadyHasDivisions');

  const plan = planFor({ templateKey, t });
  const wanted = keys && keys.length > 0
    ? plan.filter((row) => keys.includes(row.key))
    : plan;
  if (wanted.length === 0) throw new SetupError('setup.errors.nothingChosen');

  const label = (key) => (t ? t(key) : key);

  // 舞科只建被用到的那幾支。
  // Only the dances something actually uses are created.
  const template = TEMPLATES[templateKey];
  const needed = new Map();
  for (const row of wanted) {
    for (const dance of row.dances) needed.set(dance.key, dance.name);
  }
  const danceMap = new Map();
  for (const [key, name] of needed) {
    const order = template.dances.findIndex((d) => d.key === key);
    const dance = await schedule.addDance({ competitionId, name, sortOrder: order });
    danceMap.set(key, dance.id);
  }

  const groups = {};
  if (wanted.some((row) => row.group === 'general')) {
    groups.general = await feeGroups.createGroup({
      competitionId, name: label('setup.plans.general'), sortOrder: 1, ...generalPlan,
    });
  }
  if (wanted.some((row) => row.group === 'proAm')) {
    groups.proAm = await feeGroups.createGroup({
      competitionId, name: label('setup.plans.proAm'), sortOrder: 2, ...proAmPlan,
    });
  }

  let created = 0;
  for (const [index, row] of wanted.entries()) {
    const group = groups[row.group];
    const division = await comps.addDivision({
      competitionId,
      name: row.name,
      feeCents: null,
      sortOrder: index + 1,
      memberMin: row.memberMin,
      memberMax: row.memberMax,
      feeMode: group ? 'tiered' : 'per_entry',
      feeGroupId: group ? group.id : null,
      ageMin: row.ageMin,
      ageMax: row.ageMax,
    });
    await schedule.setDivisionDances(division.id, row.dances.map((dance) => danceMap.get(dance.key)));
    created += 1;
  }

  return { created, dances: danceMap.size, groups: Object.keys(groups).length };
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
  planFor,
  applyTemplate,
  copyFrom,
  copyableCompetitions,
  clearSetup,
  canClear,
};
