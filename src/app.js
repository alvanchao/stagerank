import path from 'node:path';
import url from 'node:url';
import express from 'express';
import ejs from 'ejs';
import config from './config.js';
import localeMiddleware from './middleware/locale.js';
import { entryKind } from './services/entryUnits.js';
import { attachEntrant } from './middleware/auth.js';
import publicRoutes from './routes/public.js';
import entrantRoutes from './routes/entrant.js';
import adminRoutes from './routes/admin.js';
import payRoutes from './routes/pay.js';
import staffRoutes from './routes/staff.js';
import judgeRoutes from './routes/judge.js';
import manageRoutes from './routes/manage.js';
import resultsRoutes from './routes/results.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const viewsDir = path.join(here, 'views');

// 每個頁面都先算出內容，再包進 layout，這樣頁尾標示只寫一次。
// Each page renders first, then goes into the layout, so the footer credit is written once.
async function renderPage(res, view, data = {}) {
  const locals = { ...res.locals, ...data };
  const body = await ejs.renderFile(path.join(viewsDir, `${view}.ejs`), locals, { async: false });
  const html = await ejs.renderFile(path.join(viewsDir, 'layout.ejs'), { ...locals, body }, { async: false });
  res.type('html').send(html);
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // 夥伴 ID 多點設置的第三處：回應標頭也帶著，掃描工具靠它統計安裝數。
  // Third partner-id placement: a response header, which is how the install counter finds a site.
  app.use((req, res, next) => {
    res.setHeader('X-Powered-By-App', 'StageRank/0.1.0');
    next();
  });

  app.use(express.urlencoded({ extended: false }));
  // Stripe 驗簽需要原始 body，所以 JSON 解析時順手留一份。
  // Stripe signature checking needs the raw body, so keep a copy while parsing JSON.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    }),
  );
  app.use(localeMiddleware);
  app.use((req, res, next) => {
    res.renderPage = (view, data) => renderPage(res, view, data);
    // 畫面上要說這一組是單人、雙人還是多人，靠人數上下限判斷。
    // Screens say whether a division is a solo, a couple or a team; the member range decides.
    res.locals.kindOf = entryKind;
    // 資料庫的 DATE 取出來是 Date 物件，直接轉字串會變成 "Sat Feb 14 2004 …"，
    // 切前十個字就把年份切掉了。日期一律走這裡轉成 YYYY-MM-DD。
    // A DATE comes back as a Date object, whose string form is "Sat Feb 14 2004 …", so slicing
    // ten characters loses the year. Every date goes through here instead.
    res.locals.ymd = (value) => {
      if (!value) return '';
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    };
    next();
  });
  app.use(attachEntrant);

  // 靜態檔案只有這兩支小腳本，其他全部內嵌。
  // The only static files are these two small scripts; everything else is inline.
  app.use(express.static(path.join(here, 'public'), { maxAge: '1h' }));

  app.use('/', entrantRoutes);
  app.use('/', publicRoutes);
  app.use('/', staffRoutes);
  app.use('/', judgeRoutes);
  app.use('/', resultsRoutes);
  app.use('/pay', payRoutes);
  app.use('/admin', manageRoutes);
  app.use('/admin', adminRoutes);

  app.use((req, res) => {
    res.status(404);
    renderPage(res, 'error', { title: res.locals.t('errors.notFound'), messageKey: 'errors.notFound' });
  });

  app.use((err, req, res, _next) => {
    console.error('[stagerank]', err);
    res.status(500);
    renderPage(res, 'error', { title: res.locals.t('errors.serverError'), messageKey: 'errors.serverError' });
  });

  return app;
}

export { config };
export default createApp;
