import { resetDatabase, makeEntrant, startServer } from '../../test/helpers.js';
import { chromium } from 'playwright';
import fs from 'node:fs';
const { createApp } = await import('../../src/app.js');
const comps = await import('../../src/services/competitions.js');
const regs = await import('../../src/services/registrations.js');
const voucher = await import('../../src/services/voucher.js');
const schedule = await import('../../src/services/schedule.js');
const xlsx = await import('../../src/services/exportXlsx.js');
const { translate } = await import('../../src/i18n/index.js');
const { closePool } = await import('../../src/db/index.js');
await resetDatabase();
const http = await startServer(createApp());
const c = await comps.createCompetition({ name: '名單範例盃', currency: 'TWD', feeCents: 0, status: 'open' });
const latin = await comps.addDivision({ competitionId: c.id, name: '單人拉丁', sortOrder: 1 });
const std = await comps.addDivision({ competitionId: c.id, name: '單人標準', sortOrder: 2 });
const cp = await comps.addDivision({ competitionId: c.id, name: '雙人拉丁', sortOrder: 3, memberMin: 2, memberMax: 2 });
const t = await makeEntrant({ email: 'x@example.com', unitName: '甲舞蹈', people: [
  { name: '選手一', birthDate: '1995-01-01', region: '台北市' },
  { name: '選手二', birthDate: '1996-02-02', region: '新北市', unitName: '乙舞蹈' },
  { name: '選手三', birthDate: '1997-03-03', region: '台北市' },
  { name: '選手四', birthDate: '1998-03-03', region: '桃園市' } ] });
const [a, b, d, e] = t.athletes;
const reg = (dv, ids) => regs.register({ competitionId: c.id, divisionId: dv.id, entrantId: t.entrant.id, athleteIds: ids.map((x) => x.id) });
await reg(latin, [a]); await reg(latin, [b]); await reg(latin, [e]); await reg(std, [a]); await reg(std, [d]);
await reg(cp, [a, b]); await reg(cp, [d, e]);
const s = await voucher.settle(c.id);
await schedule.assignBibs(s.voucher.code);
const buf = await xlsx.listsWorkbook({ competitionId: c.id, t: (k, p) => translate('zh-TW', k, p) });
fs.writeFileSync('/mnt/user-data/outputs/lists-zh-TW.xlsx', buf);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 420, height: 800 } });
await ctx.addCookies([{ name: t.cookie.split('=')[0], value: t.cookie.split('=').slice(1).join('='), url: http.base }]);
const page = await ctx.newPage();
await page.goto(`${http.base}/entrant?edit=${b.id}`);
await page.screenshot({ path: '/mnt/user-data/outputs/walkthrough/21-選手名冊-地區與單位欄位.png', fullPage: true });
await browser.close(); await http.close(); await closePool();
