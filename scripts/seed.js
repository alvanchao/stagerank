// 示範資料：讓主辦第一次裝好就能點點看。
// Demo data so a fresh install has something to click.
import { migrate } from '../src/db/migrate.js';
import * as comps from '../src/services/competitions.js';
import { closePool } from '../src/db/index.js';

await migrate({ log: () => {} });

const competition = await comps.createCompetition({
  name: 'StageRank Demo Cup 2026',
  slug: 'demo-cup-2026',
  currency: 'TWD',
  feeCents: 1200,
  status: 'open',
});

const divisions = ['U12 Latin', 'U15 Latin', 'U15 Standard', 'Adult Latin'];
for (const [index, name] of divisions.entries()) {
  await comps.addDivision({ competitionId: competition.id, name, sortOrder: index + 1 });
}

console.log(`Seeded: /c/${competition.slug} with ${divisions.length} divisions`);
await closePool();
