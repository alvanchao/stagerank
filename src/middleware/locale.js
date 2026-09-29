import config from '../config.js';
import { negotiateLocale, translate, formatMoney, formatDateTime, availableLocales } from '../i18n/index.js';

const COOKIE = 'stagerank_locale';

function readCookie(header, name) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function localeMiddleware(req, res, next) {
  const queryLocale = typeof req.query?.lang === 'string' ? req.query.lang : undefined;
  const locale = negotiateLocale({
    query: queryLocale,
    cookie: readCookie(req.headers.cookie, COOKIE),
    acceptLanguage: req.headers['accept-language'],
    fallback: config.defaultLocale,
  });

  // 使用者手動選了語言就記住，下次直接用。
  // Remember a manual choice so the next visit uses it.
  if (queryLocale && queryLocale === locale) {
    res.cookie?.(COOKIE, locale, { maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: false, sameSite: 'lax' });
  }

  req.locale = locale;
  res.locals.locale = locale;
  res.locals.locales = availableLocales();
  res.locals.t = (key, params) => translate(locale, key, params);
  res.locals.money = (cents, currency) => formatMoney(locale, cents, currency || config.currency);
  res.locals.when = (value) => formatDateTime(locale, value, config.timezone);
  res.locals.config = config;
  res.locals.currentPath = req.path;
  next();
}

export default localeMiddleware;
