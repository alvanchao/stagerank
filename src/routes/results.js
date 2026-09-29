// 公開成績：主辦按「公告」才對外顯示，不會自動外流。選手用背號查詢。
// Public results: nothing shows until the organiser publishes. Competitors look themselves up by bib.

import express from 'express';
import { many, one } from '../db/index.js';
import * as comps from '../services/competitions.js';
import * as scoring from '../services/scoring.js';
import * as schedule from '../services/schedule.js';
import * as voucherService from '../services/voucher.js';

const router = express.Router();

// 短網址：選手直接打 /results。
// The short URL competitors will type: /results.
router.get('/results', async (req, res, next) => {
  try {
    const all = await comps.listCompetitions();
    const live = all.filter((c) => c.status !== 'draft');
    if (live.length === 1) return res.redirect(303, `/results/${live[0].slug}`);
    return res.renderPage('pick_competition', {
      title: res.locals.t('results.title'),
      kind: 'results',
      competitions: live,
      useSlug: true,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/results/:slug', async (req, res, next) => {
  try {
    const competition = await comps.getCompetitionBySlug(req.params.slug);
    if (!competition) return res.status(404).renderPage('error', { messageKey: 'errors.notFound' });

    const divisions = await comps.listDivisions(competition.id);
    const blocks = [];
    for (const division of divisions) {
      const rounds = (await schedule.listRounds(division.id)).filter((r) => r.published_at);
      const withResults = [];
      for (const round of rounds) {
        withResults.push({ round, results: await scoring.resultsFor(round.id) });
      }
      if (withResults.length > 0) blocks.push({ division, rounds: withResults });
    }

    await res.renderPage('results', {
      title: res.locals.t('results.title'),
      competition,
      blocks,
      lookup: null,
      bib: String(req.query.bib || '').trim(),
      notFound: false,
    });
  } catch (err) {
    next(err);
  }
});

// 選手用背號查自己的成績，以及自己每支舞在第幾個 heat。
// A competitor looks up their own result, and which heat they are in for each dance.
router.get('/results/:slug/bib', async (req, res, next) => {
  try {
    const competition = await comps.getCompetitionBySlug(req.params.slug);
    if (!competition) return res.status(404).renderPage('error', { messageKey: 'errors.notFound' });

    const bib = Number.parseInt(String(req.query.bib || '').trim(), 10);
    let lookup = null;

    if (Number.isFinite(bib)) {
      const results = await many(
        `SELECT r.*, ro.name AS round_name, d.name AS division_name, re.athlete_name
         FROM results r
         JOIN round_entries re ON re.id = r.round_entry_id
         JOIN rounds ro ON ro.id = r.round_id
         JOIN divisions d ON d.id = re.division_id
         WHERE d.competition_id = $1 AND re.bib_number = $2 AND ro.published_at IS NOT NULL
         ORDER BY ro.sort_order, ro.id`,
        [competition.id, bib],
      );

      // 每支舞在第幾個 heat，選手自己查得到。
      // Which heat they are in for each dance, so they can check for themselves.
      const heats = await many(
        `SELECT h.label, h.status, da.name AS dance_name, ro.name AS round_name,
                (SELECT COUNT(*) FROM heats h2
                 WHERE h2.dance_id = h.dance_id
                   AND h2.id IN (SELECT heat_id FROM heat_entries WHERE round_id = he.round_id)
                   AND h2.sort_key <= h.sort_key)::int AS heat_number
         FROM heat_entries he
         JOIN heats h ON h.id = he.heat_id
         JOIN dances da ON da.id = h.dance_id
         JOIN rounds ro ON ro.id = he.round_id
         JOIN round_entries re ON re.id = he.round_entry_id
         JOIN divisions d ON d.id = re.division_id
         WHERE d.competition_id = $1 AND re.bib_number = $2
         ORDER BY h.sort_key`,
        [competition.id, bib],
      );

      const name = results[0]?.athlete_name
        || (await one(
          `SELECT re.athlete_name FROM round_entries re JOIN divisions d ON d.id = re.division_id
           WHERE d.competition_id = $1 AND re.bib_number = $2 LIMIT 1`,
          [competition.id, bib],
        ))?.athlete_name;

      lookup = { bib, name, results, heats };
    }

    await res.renderPage('results', {
      title: res.locals.t('results.lookup'),
      competition,
      blocks: [],
      lookup,
      bib: String(req.query.bib || '').trim(),
      notFound: Boolean(lookup && !lookup.name),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
