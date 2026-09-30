import { resetDatabase, makeEntrant } from './helpers.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// 四種名單、對帳用、異常檢查：全部用假資料。
// The four roster views, reconciliation and the checks sheet, all on fake data.

const comps = await import('../src/services/competitions.js');
const regs = await import('../src/services/registrations.js');
const voucher = await import('../src/services/voucher.js');
const schedule = await import('../src/services/schedule.js');
const xlsx = await import('../src/services/exportXlsx.js');
const { translate } = await import('../src/i18n/index.js');
const ExcelJS = (await import('exceljs')).default;
const { closePool } = await import('../src/db/index.js');

before(async () => { await resetDatabase(); });
after(async () => { await closePool(); });
beforeEach(async () => { await resetDatabase(); });

async function readSheets(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = {};
  wb.eachSheet((ws) => {
    out[ws.name] = [];
    ws.eachRow((row) => out[ws.name].push(Array.from({ length: ws.columnCount }, (_, i) => {
      const v = row.getCell(i + 1).value;
      return v === null || v === undefined ? '' : v;
    })));
  });
  return out;
}

async function setup({ duplicate = false } = {}) {
  const competition = await comps.createCompetition({ name: '名單盃', currency: 'TWD', feeCents: 0, status: 'open' });
  const latin = await comps.addDivision({ competitionId: competition.id, name: '單人拉丁', sortOrder: 1 });
  const std = await comps.addDivision({ competitionId: competition.id, name: '單人標準', sortOrder: 2 });
  const couple = await comps.addDivision({ competitionId: competition.id, name: '雙人拉丁', sortOrder: 3, memberMin: 2, memberMax: 2 });
  const t = await makeEntrant({
    email: 'x@example.com', unitName: '甲舞蹈',
    people: [
      { name: '選手一', birthDate: '1995-01-01', region: '台北市' },
      { name: '選手二', birthDate: '1996-02-02', region: '新北市', unitName: '乙舞蹈' },
      { name: '選手三', birthDate: '1997-03-03' },
    ],
  });
  const [a1, a2, a3] = t.athletes;
  const reg = (division, ids) => regs.register({ competitionId: competition.id, divisionId: division.id, entrantId: t.entrant.id, athleteIds: ids.map((a) => a.id) });
  await reg(latin, [a1]);
  await reg(latin, [a2]);
  await reg(std, [a1]);
  await reg(couple, [a1, a2]);
  await reg(couple, [a1, a3]);
  if (duplicate) await reg(latin, [a1]);
  const settled = await voucher.settle(competition.id);
  if (!duplicate) await schedule.assignBibs(settled.voucher.code);
  return { competition };
}

test('四種名單筆數互相吻合，地區與單位逗號串起 / the four lists agree with each other', async () => {
  const { competition } = await setup();
  const t = (k, p) => translate('zh-TW', k, p);
  const sheets = await readSheets(await xlsx.listsWorkbook({ competitionId: competition.id, t }));
  assert.deepEqual(Object.keys(sheets), ['背號', '依組別1', '依組別2', '依選手1', '依選手2', '對帳用', '異常檢查']);

  // 5 筆報名；組合：選手一 3 次、選手二 2 次、選手三 1 次；5 個不同單位（選手一、選手二、選手三、一+二、一+三）
  const entries = 5;
  assert.equal(sheets['依組別1'].length - 1, entries);
  assert.equal(sheets['依組別2'].length - 1, entries + 3, 'plus one heading row per division');
  const perPerson = sheets['依選手1'].slice(1).filter((r) => r[0] !== '');
  const counts = perPerson.map((r) => Number(r[5]));
  assert.equal(counts.reduce((a, b) => a + b, 0), entries, 'divisions entered add up to the entries');
  assert.equal(sheets['依選手2'].length - 1, perPerson.length);
  assert.equal(sheets['背號'].length - 1, perPerson.length, 'one row per bib');

  // 每個組別的隊數寫在第一列
  const first = sheets['依組別1'][1];
  assert.equal(first[0], '單人拉丁');
  assert.equal(Number(first[5]), 2);

  // 雙人組：兩位的地區用逗號串起，單位以選手各自的為準、沒填用報名帳號的單位
  const couple = sheets['依選手2'].find((r) => String(r[0]).includes('選手一, 選手二'));
  assert.ok(couple, 'the couple appears once');
  assert.equal(couple[2], '台北市, 新北市');
  assert.equal(couple[3], '甲舞蹈, 乙舞蹈');

  // 兩位只有一位填地區：位置對得上，沒填的那位留白
  const pair = sheets['背號'].find((r) => r[1] === '選手一, 選手三');
  assert.equal(pair[2], '台北市, ');

  assert.equal(sheets['對帳用'].length - 1, entries);
  assert.equal(sheets['異常檢查'].length, 1, 'no problems on clean data');
});

test('重複報名與重複付款會出現在異常檢查 / a repeat entry shows up in the checks sheet', async () => {
  const { competition } = await setup({ duplicate: true });
  const t = (k, p) => translate('zh-TW', k, p);
  const sheets = await readSheets(await xlsx.listsWorkbook({ competitionId: competition.id, t }));
  const flagged = sheets['異常檢查'].slice(1);
  assert.equal(flagged.length, 2, 'both copies of the repeated entry are listed');
  assert.ok(flagged.every((r) => r[2] === '單人拉丁'));
  assert.equal(sheets['對帳用'].slice(1).filter((r) => r[7] === '重複').length, 2);
});

test('英文介面的名單標題是英文 / English headings', async () => {
  const { competition } = await setup();
  const t = (k, p) => translate('en', k, p);
  const sheets = await readSheets(await xlsx.listsWorkbook({ competitionId: competition.id, t }));
  assert.ok(sheets['By division 1']);
  assert.equal(sheets['依選手2'], undefined);
  assert.equal(sheets['By person 2'][0][4], 'Divisions entered');
});
