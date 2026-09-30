// 匯出 Excel：背號表與賽序表。欄位標題都走語言檔，跟著使用者選的語言。
// Excel export of the bib list and the running order. Every heading comes from the locale files.

import ExcelJS from 'exceljs';
import * as schedule from './schedule.js';
import { many } from '../db/index.js';
import * as voucherService from './voucher.js';

function styled(sheet, columns) {
  sheet.columns = columns;
  const head = sheet.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE3D6' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

async function toBuffer(workbook) {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function bibsWorkbook({ voucherCode, t }) {
  const roster = await schedule.rosterWithBibs(voucherCode);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(t('export.bibsSheet'));
  styled(sheet, [
    { header: t('export.bib'), key: 'bib', width: 8 },
    { header: t('export.name'), key: 'name', width: 28 },
    { header: t('export.unit'), key: 'unit', width: 24 },
    { header: t('export.division'), key: 'division', width: 22 },
  ]);
  roster
    .slice()
    .sort((a, b) => (a.bib_number ?? 1e9) - (b.bib_number ?? 1e9) || String(a.division_name).localeCompare(String(b.division_name)))
    .forEach((r) => sheet.addRow({ bib: r.bib_number ?? '', name: r.athlete_name, unit: r.unit_name || '', division: r.division_name }));
  return toBuffer(workbook);
}

export async function orderWorkbook({ competitionId, t }) {
  const order = await schedule.runningOrder(competitionId);
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet(t('export.orderSheet'));
  styled(summary, [
    { header: t('export.order'), key: 'order', width: 8 },
    { header: t('export.heat'), key: 'heat', width: 36 },
    { header: t('export.dance'), key: 'dance', width: 16 },
    { header: t('export.division'), key: 'division', width: 24 },
    { header: t('export.count'), key: 'count', width: 10 },
    { header: t('export.bibs'), key: 'bibs', width: 50 },
  ]);

  const detail = workbook.addWorksheet(t('export.detailSheet'));
  styled(detail, [
    { header: t('export.order'), key: 'order', width: 8 },
    { header: t('export.heat'), key: 'heat', width: 36 },
    { header: t('export.bib'), key: 'bib', width: 8 },
    { header: t('export.name'), key: 'name', width: 28 },
    { header: t('export.division'), key: 'division', width: 22 },
  ]);

  let index = 0;
  for (const heat of order) {
    index += 1;
    const { entries } = await schedule.heatWithEntries(heat.id);
    const sorted = entries.slice().sort((a, b) => (a.bib_number ?? 1e9) - (b.bib_number ?? 1e9));
    summary.addRow({
      order: index,
      heat: heat.label,
      dance: heat.dance_name,
      division: (heat.division_names || []).join(' / '),
      count: entries.length,
      bibs: sorted.map((e) => e.bib_number ?? '').join(', '),
    });
    for (const e of sorted) {
      detail.addRow({ order: index, heat: heat.label, bib: e.bib_number ?? '', name: e.athlete_name, division: e.division_name });
    }
  }
  return toBuffer(workbook);
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------------------------------------------------------------- 名單四種＋對帳

const ZERO_DECIMAL = new Set(['TWD', 'JPY', 'KRW', 'VND', 'CLP', 'ISK']);
const amountOf = (cents, currency) => (ZERO_DECIMAL.has(String(currency || 'TWD').toUpperCase()) ? Number(cents) : Number(cents) / 100);
const joinIfAny = (parts) => (parts.some((p) => p) ? parts.map((p) => p || '').join(', ') : '');

async function loadUnits(voucherId) {
  const entries = await many(
    `SELECT ve.id, ve.registration_id, ve.division_id, ve.bib_number, ve.athlete_name, COALESCE(NULLIF(ve.unit_name, ''), en.unit_name) AS reg_unit,
            d.name AS division_name, r.status, r.amount_cents, r.currency
     FROM voucher_entries ve
     JOIN divisions d ON d.id = ve.division_id
     JOIN registrations r ON r.id = ve.registration_id
     LEFT JOIN entrants en ON en.id = r.entrant_id
     WHERE ve.voucher_id = $1
     ORDER BY d.sort_order, d.id, ve.bib_number NULLS LAST, ve.id`,
    [voucherId],
  );
  const ids = entries.map((e) => e.registration_id);
  const members = ids.length
    ? await many(
      `SELECT rm.registration_id, rm.athlete_name, a.region, a.unit_name
       FROM registration_members rm LEFT JOIN athletes a ON a.id = rm.athlete_id
       WHERE rm.registration_id = ANY($1::bigint[]) ORDER BY rm.registration_id, rm.sort_order, rm.id`,
      [ids],
    )
    : [];
  const payments = ids.length
    ? await many(
      'SELECT registration_id, provider_order_id, status FROM payments WHERE registration_id = ANY($1::bigint[]) ORDER BY id',
      [ids],
    )
    : [];

  return entries.map((e) => {
    const ms = members.filter((m) => String(m.registration_id) === String(e.registration_id));
    const names = ms.length ? ms.map((m) => m.athlete_name).join(', ') : e.athlete_name;
    const pays = payments.filter((p) => String(p.registration_id) === String(e.registration_id));
    const paidPays = pays.filter((p) => p.status === 'paid');
    const shown = paidPays.length ? paidPays : pays;
    return {
      ...e,
      names,
      region: joinIfAny(ms.map((m) => m.region)),
      unit: joinIfAny((ms.length ? ms : [{}]).map((m) => m.unit_name || e.reg_unit)),
      orderNo: shown.map((p) => p.provider_order_id).join(', '),
      orderCount: shown.length,
      paidCount: paidPays.length,
    };
  });
}

export async function listsWorkbook({ competitionId, t }) {
  const voucher = await voucherService.activeVoucher(competitionId);
  const workbook = new ExcelJS.Workbook();
  const units = voucher ? await loadUnits(voucher.id) : [];

  // 同一組人整場一個背號：依背號合併成「人」。沒有背號的（尚未編號）各算各的。
  const people = new Map();
  for (const u of units) {
    const key = u.bib_number !== null ? `b${u.bib_number}` : `r${u.registration_id}`;
    if (!people.has(key)) people.set(key, { ...u, divisions: [] });
    people.get(key).divisions.push(u.division_name);
  }
  const personList = [...people.values()].sort((a, b) => (a.bib_number ?? 1e9) - (b.bib_number ?? 1e9));

  // 1 背號總表
  const bibs = workbook.addWorksheet(t('export.sheetBibs'));
  styled(bibs, [
    { header: t('export.no'), key: 'no', width: 8 }, { header: t('export.name'), key: 'name', width: 28 },
    { header: t('export.region'), key: 'region', width: 18 }, { header: t('export.unit'), key: 'unit', width: 30 },
    { header: t('export.bib'), key: 'bib', width: 8 },
  ]);
  personList.forEach((p) => bibs.addRow({ no: p.registration_id, name: p.names, region: p.region, unit: p.unit, bib: p.bib_number ?? '' }));

  // 2 依組別（組別名稱寫在每段第一列，隊數在第一列）
  const byDiv = new Map();
  for (const u of units) {
    if (!byDiv.has(u.division_id)) byDiv.set(u.division_id, { name: u.division_name, rows: [] });
    byDiv.get(u.division_id).rows.push(u);
  }
  const d1 = workbook.addWorksheet(t('export.sheetByDivision1'));
  styled(d1, [
    { header: t('export.division'), key: 'division', width: 30 }, { header: t('export.name'), key: 'name', width: 28 },
    { header: t('export.bib'), key: 'bib', width: 8 }, { header: t('export.region'), key: 'region', width: 18 },
    { header: t('export.unit'), key: 'unit', width: 30 }, { header: t('export.countUnits'), key: 'count', width: 10 },
  ]);
  for (const g of byDiv.values()) {
    g.rows.forEach((u, i) => d1.addRow({
      division: i === 0 ? g.name : '', name: u.names, bib: u.bib_number ?? '', region: u.region, unit: u.unit,
      count: i === 0 ? g.rows.length : '',
    }));
  }

  // 3 依組別（組別名稱獨立一列標題）
  const d2 = workbook.addWorksheet(t('export.sheetByDivision2'));
  styled(d2, [
    { header: '', key: 'a', width: 30 }, { header: t('export.name'), key: 'name', width: 28 },
    { header: t('export.bib'), key: 'bib', width: 8 }, { header: t('export.region'), key: 'region', width: 18 },
    { header: t('export.unit'), key: 'unit', width: 30 }, { header: t('export.countUnits'), key: 'count', width: 10 },
  ]);
  for (const g of byDiv.values()) {
    const head = d2.addRow({ a: g.name, count: g.rows.length });
    head.font = { bold: true };
    g.rows.forEach((u) => d2.addRow({ name: u.names, bib: u.bib_number ?? '', region: u.region, unit: u.unit }));
  }

  // 4 依選手（每個組別一列，選手資料只寫第一列）
  const p1 = workbook.addWorksheet(t('export.sheetByPerson1'));
  styled(p1, [
    { header: t('export.name'), key: 'name', width: 28 }, { header: t('export.bib'), key: 'bib', width: 8 },
    { header: t('export.region'), key: 'region', width: 18 }, { header: t('export.unit'), key: 'unit', width: 30 },
    { header: t('export.division'), key: 'division', width: 34 }, { header: t('export.countDivisions'), key: 'count', width: 12 },
  ]);
  for (const p of personList) {
    p.divisions.forEach((dv, i) => p1.addRow(i === 0
      ? { name: p.names, bib: p.bib_number ?? '', region: p.region, unit: p.unit, division: dv, count: p.divisions.length }
      : { division: dv }));
  }

  // 5 依選手（一人一列，組別橫向排開）
  const maxDiv = Math.max(1, ...personList.map((p) => p.divisions.length));
  const p2 = workbook.addWorksheet(t('export.sheetByPerson2'));
  styled(p2, [
    { header: t('export.name'), key: 'name', width: 28 }, { header: t('export.bib'), key: 'bib', width: 8 },
    { header: t('export.region'), key: 'region', width: 18 }, { header: t('export.unit'), key: 'unit', width: 30 },
    { header: t('export.countDivisions'), key: 'count', width: 12 },
    ...Array.from({ length: maxDiv }, (_, i) => ({ header: t('export.division_n', { n: i + 1 }), key: `d${i}`, width: 34 })),
  ]);
  for (const p of personList) {
    const row = { name: p.names, bib: p.bib_number ?? '', region: p.region, unit: p.unit, count: p.divisions.length };
    p.divisions.forEach((dv, i) => { row[`d${i}`] = dv; });
    p2.addRow(row);
  }

  // 6 對帳用
  const dupCount = new Map();
  for (const u of units) {
    const k = `${u.division_id}|${u.bib_number ?? u.names}`;
    dupCount.set(k, (dupCount.get(k) || 0) + 1);
  }
  const isDup = (u) => dupCount.get(`${u.division_id}|${u.bib_number ?? u.names}`) > 1;
  const recon = workbook.addWorksheet(t('export.sheetRecon'));
  styled(recon, [
    { header: t('export.orderNo'), key: 'order', width: 20 }, { header: t('export.region'), key: 'region', width: 18 },
    { header: t('export.unit'), key: 'unit', width: 30 }, { header: t('export.payStatus'), key: 'status', width: 12 },
    { header: t('export.amount'), key: 'amount', width: 10 }, { header: t('export.name'), key: 'name', width: 28 },
    { header: t('export.division'), key: 'division', width: 34 }, { header: t('export.duplicate'), key: 'dup', width: 10 },
  ]);
  for (const u of units) {
    recon.addRow({
      order: u.orderNo, region: u.region, unit: u.unit, status: t(`export.status_${u.status}`),
      amount: amountOf(u.amount_cents, u.currency), name: u.names, division: u.division_name, dup: isDup(u) ? t('export.yes') : '',
    });
  }

  // 7 異常檢查：同一組人同一組別重複、或同一筆報名付了不只一次
  const issues = workbook.addWorksheet(t('export.sheetIssues'));
  styled(issues, [
    { header: t('export.name'), key: 'name', width: 28 }, { header: t('export.bib'), key: 'bib', width: 8 },
    { header: t('export.division'), key: 'division', width: 34 }, { header: t('export.orders'), key: 'orders', width: 10 },
    { header: t('export.orderList'), key: 'list', width: 34 }, { header: t('export.region'), key: 'region', width: 18 },
    { header: t('export.unit'), key: 'unit', width: 30 },
  ]);
  for (const u of units.filter((x) => isDup(x) || x.paidCount > 1)) {
    issues.addRow({ name: u.names, bib: u.bib_number ?? '', division: u.division_name, orders: u.orderCount, list: u.orderNo, region: u.region, unit: u.unit });
  }

  return toBuffer(workbook);
}
