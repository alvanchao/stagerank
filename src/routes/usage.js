// 收集端：接收各站台的匿名統計，並給維護者看合計。預設關閉（STAGERANK_COLLECTOR=true 才開）。
// Collector: receives anonymous usage reports and shows the maintainer the totals. Off unless STAGERANK_COLLECTOR=true.
import express from 'express';
import config from '../config.js';
import { one, many } from '../db/index.js';
import { requireStaff } from '../middleware/auth.js';

const router = express.Router();

function validate(body) {
  if (!body || body.schema !== 'stagerank.usage.v1') return null;
  const site = String(body.site?.url || '').slice(0, 200);
  if (!/^https?:\/\//i.test(site)) return null;
  const hash = String(body.competition?.id_hash || 'none').slice(0, 32);
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  return {
    site,
    hash,
    clean: {
      schema: body.schema,
      app: { version: String(body.app?.version || '').slice(0, 20) },
      site: { url: site },
      competition: {
        id_hash: hash,
        entry_count: num(body.competition?.entry_count),
        total_cents: num(body.competition?.total_cents),
        currency: String(body.competition?.currency || '').slice(0, 8),
      },
      payments: (Array.isArray(body.payments) ? body.payments.slice(0, 10) : []).map((p) => ({
        provider: String(p.provider || '').slice(0, 20),
        sandbox: p.sandbox !== false,
        count: num(p.count),
        total_cents: num(p.total_cents),
        with_partner_id: num(p.with_partner_id),
      })),
    },
  };
}

// 同一場比賽重複回報就覆蓋舊的，所以數字不會被灌高。
// A repeat report for one competition replaces the old one, so numbers do not double-count.
router.post('/usage', express.json({ limit: '20kb' }), async (req, res) => {
  if (!config.collector.enabled) return res.status(404).end();
  const v = validate(req.body);
  if (!v) return res.status(400).json({ ok: false });
  await one(
    `INSERT INTO usage_received (site_url, id_hash, payload) VALUES ($1,$2,$3)
     ON CONFLICT (site_url, id_hash) DO UPDATE SET payload = EXCLUDED.payload, received_at = now()
     RETURNING id`,
    [v.site, v.hash, JSON.stringify(v.clean)],
  );
  return res.json({ ok: true });
});

router.get('/admin/usage', requireStaff, async (req, res, next) => {
  try {
    if (!config.collector.enabled) return res.status(404).end();
    // 只有「正式」付款的比賽才算進談金流用的合計；測試的另外放。
    // Only competitions with live payments count towards the headline totals; test ones are listed apart.
    const totals = await many(
      `SELECT COUNT(DISTINCT site_url)::int AS sites, COUNT(*)::int AS competitions,
              COALESCE(SUM(entry_count), 0)::int AS entries
       FROM (SELECT site_url, id_hash, (payload->'competition'->>'entry_count')::int AS entry_count
             FROM usage_received u
             WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(u.payload->'payments') p
                           WHERE COALESCE((p->>'sandbox')::boolean, TRUE) = FALSE)) s`,
    );
    const rowsFor = (live) => many(
      `SELECT p->>'provider' AS provider, u.payload->'competition'->>'currency' AS currency,
              SUM((p->>'count')::int)::int AS count,
              SUM((p->>'total_cents')::bigint)::bigint AS total_cents,
              SUM((p->>'with_partner_id')::int)::int AS with_partner_id
       FROM usage_received u, jsonb_array_elements(u.payload->'payments') p
       WHERE (COALESCE((p->>'sandbox')::boolean, TRUE) = FALSE) = $1
       GROUP BY 1, 2 ORDER BY 1, 2`,
      [live],
    );
    res.renderPage('admin_usage', {
      title: res.locals.t('usage.title'),
      totals: totals[0],
      liveRows: await rowsFor(true),
      testRows: await rowsFor(false),
    });
  } catch (err) { next(err); }
});

export default router;
