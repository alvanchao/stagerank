// 選手名冊。綁在報名人帳號上，跨比賽重複使用。
// The athlete roster. It belongs to an entrant account and is reused across competitions.
import { one, many } from '../db/index.js';

export class AthleteError extends Error {
  constructor(key, params = null) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

// 只接受 YYYY-MM-DD。畫面上用 <input type="date">，瀏覽器就會給這個格式，
// 不必去猜 1998/3/5 是三月五日還是五月三日。
// Only YYYY-MM-DD is accepted. The screens use <input type="date">, so the browser hands over
// exactly that, and nobody has to guess whether 3/5 means March or May.
export function parseBirthDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new AthleteError('roster.errors.birthDateInvalid');
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new AthleteError('roster.errors.birthDateInvalid');
  const now = new Date();
  if (date.getTime() > now.getTime()) throw new AthleteError('roster.errors.birthDateFuture');
  if (date.getUTCFullYear() < 1900) throw new AthleteError('roster.errors.birthDateInvalid');
  return text;
}

function toDate(value) {
  if (value instanceof Date) return value;
  return new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
}

// 年齡算法由主辦選：
// year_end  ＝ 比賽當年 12 月 31 日的歲數，同年出生的一律同組（國標舞最常見）
// event_day ＝ 比賽當天的實歲
// The organiser picks the rule: year_end puts everyone born in the same year together,
// event_day uses the actual age on the day.
export function ageOf(birthDate, { basis = 'year_end', referenceDate = new Date() } = {}) {
  const born = toDate(birthDate);
  const reference = toDate(referenceDate instanceof Date ? referenceDate.toISOString() : referenceDate);
  if (basis === 'event_day') {
    let age = reference.getUTCFullYear() - born.getUTCFullYear();
    const beforeBirthday =
      reference.getUTCMonth() < born.getUTCMonth() ||
      (reference.getUTCMonth() === born.getUTCMonth() && reference.getUTCDate() < born.getUTCDate());
    if (beforeBirthday) age -= 1;
    return age;
  }
  return reference.getUTCFullYear() - born.getUTCFullYear();
}

// 比賽的年齡基準日：主辦有填比賽日期就用它，沒填就用今天。
// The date the age is measured against: the competition's own date when set, otherwise today.
export function referenceDateFor(competition) {
  return competition?.event_date ? toDate(competition.event_date) : new Date();
}

export async function addAthlete({ entrantId, name, birthDate, email = null, note = null }) {
  const label = String(name || '').trim();
  if (!label) throw new AthleteError('roster.errors.nameRequired');
  const born = parseBirthDate(birthDate);

  // 同一個名冊裡姓名和生日都一樣，幾乎一定是手滑按了兩次。
  // The same name and birthday inside one roster is almost always a double-tap.
  const clash = await one(
    'SELECT * FROM athletes WHERE entrant_id = $1 AND name = $2 AND birth_date = $3 AND archived_at IS NULL',
    [entrantId, label, born],
  );
  if (clash) throw new AthleteError('roster.errors.duplicate', { name: label });

  return one(
    `INSERT INTO athletes (entrant_id, name, birth_date, email, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [entrantId, label, born, String(email || '').trim() || null, note || null],
  );
}

export async function updateAthlete(id, entrantId, { name, birthDate, email, note }) {
  const existing = await one('SELECT * FROM athletes WHERE id = $1 AND entrant_id = $2', [id, entrantId]);
  if (!existing) throw new AthleteError('errors.notFound');
  const label = String(name || '').trim();
  if (!label) throw new AthleteError('roster.errors.nameRequired');
  return one(
    `UPDATE athletes SET name = $3, birth_date = $4, email = $5, note = $6, updated_at = now()
     WHERE id = $1 AND entrant_id = $2 RETURNING *`,
    [id, entrantId, label, parseBirthDate(birthDate), String(email || '').trim() || null, note || null],
  );
}

// 報過名的選手不刪掉，只收起來：成績和名單都還指著他。
// A competitor who has entered is archived rather than deleted; results and rosters still point at them.
export async function removeAthlete(id, entrantId) {
  const used = await one('SELECT 1 FROM registration_members WHERE athlete_id = $1 LIMIT 1', [id]);
  if (used) {
    const row = await one(
      `UPDATE athletes SET archived_at = now(), updated_at = now()
       WHERE id = $1 AND entrant_id = $2 RETURNING *`,
      [id, entrantId],
    );
    if (!row) throw new AthleteError('errors.notFound');
    return { removed: false, archived: true, athlete: row };
  }
  const row = await one('DELETE FROM athletes WHERE id = $1 AND entrant_id = $2 RETURNING *', [id, entrantId]);
  if (!row) throw new AthleteError('errors.notFound');
  return { removed: true, archived: false, athlete: row };
}

export function listRoster(entrantId, { includeArchived = false } = {}) {
  if (includeArchived) {
    return many('SELECT * FROM athletes WHERE entrant_id = $1 ORDER BY name, birth_date', [entrantId]);
  }
  return many(
    'SELECT * FROM athletes WHERE entrant_id = $1 AND archived_at IS NULL ORDER BY name, birth_date',
    [entrantId],
  );
}

export function getAthlete(id, entrantId = null) {
  if (entrantId === null) return one('SELECT * FROM athletes WHERE id = $1', [id]);
  return one('SELECT * FROM athletes WHERE id = $1 AND entrant_id = $2', [id, entrantId]);
}

export function listByIds(ids, entrantId) {
  if (!ids || ids.length === 0) return Promise.resolve([]);
  return many(
    'SELECT * FROM athletes WHERE id = ANY($1::bigint[]) AND entrant_id = $2',
    [ids.map((id) => Number.parseInt(id, 10)).filter(Number.isFinite), entrantId],
  );
}

// 年齡不符就擋下來，而且要講清楚是哪一位、幾歲、限制是多少。
// 只說「不符資格」的錯誤訊息，老師看了也不知道要改誰。
// An age failure names the person, their age and the limit. "Not eligible" on its own tells
// the teacher nothing about who to fix.
export function ageProblems({ athletes, division, competition }) {
  const min = division.age_min ?? null;
  const max = division.age_max ?? null;
  if (min === null && max === null) return [];

  const basis = competition?.age_basis || 'year_end';
  const reference = referenceDateFor(competition);

  return athletes
    .map((athlete) => ({ athlete, age: ageOf(athlete.birth_date, { basis, referenceDate: reference }) }))
    .filter(({ age }) => (min !== null && age < min) || (max !== null && age > max))
    .map(({ athlete, age }) => ({
      athleteId: athlete.id,
      name: athlete.name,
      age,
      min,
      max,
    }));
}

export default {
  AthleteError,
  parseBirthDate,
  ageOf,
  referenceDateFor,
  addAthlete,
  updateAthlete,
  removeAthlete,
  listRoster,
  getAthlete,
  listByIds,
  ageProblems,
};
