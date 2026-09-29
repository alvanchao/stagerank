// 收費方案：基本盤含幾項、之後每項多少，以及師生組為什麼要自己數。
// Fee plans: a base covering N items, a price per extra, and why pro-am counts on its own.
import { resetDatabase } from './helpers.js';
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const entrants = await import('../src/services/entrants.js');
const roster = await import('../src/services/athletes.js');
const comps = await import('../src/services/competitions.js');
const fees = await import('../src/services/feeGroups.js');
const regs = await import('../src/services/registrations.js');
const { closePool } = await import('../src/db/index.js');

before(resetDatabase);
beforeEach(resetDatabase);
after(closePool);

// 一場用「基本費 1800 含 2 項、第 3 項起每項 600」收費的比賽，外加一個師生組方案。
// A competition charging 1800 for the first two items and 600 for each after that,
// plus a separate pro-am plan.
async function setUp() {
  const competition = await comps.createCompetition({ name: 'Fee Cup', feeCents: 0, status: 'open' });
  const general = await fees.createGroup({
    competitionId: competition.id, name: '一般組', baseFeeCents: 1800, baseIncludes: 2, extraItemFeeCents: 600,
  });
  const proAm = await fees.createGroup({
    competitionId: competition.id, name: '師生組', baseFeeCents: 2500, baseIncludes: 1, extraItemFeeCents: 1200,
  });

  const division = async (name, group, extra = {}) => comps.addDivision({
    competitionId: competition.id, name, sortOrder: 1, feeMode: 'tiered', feeGroupId: group.id, ...extra,
  });

  const account = await entrants.signUp({ email: 'teacher@example.com', password: 'passw0rd!' });
  const athlete = await roster.addAthlete({ entrantId: account.id, name: '王小明', birthDate: '2012-05-04' });

  return { competition, general, proAm, division, account, athlete };
}

test('第 n 項的價格照方案走 / the nth item is priced by the plan', () => {
  const plan = { base_fee_cents: 1800, base_includes: 2, extra_item_fee_cents: 600 };
  assert.equal(fees.priceOfItem(plan, 1), 1800, 'the base covers the first');
  assert.equal(fees.priceOfItem(plan, 2), 0, 'the second is inside the base');
  assert.equal(fees.priceOfItem(plan, 3), 600);
  assert.equal(fees.priceOfItem(plan, 9), 600);

  // 含 1 項就是最常見的「第一項多少、之後每項多少」。
  // Covering one item is the common "so much for the first, so much for each after".
  const simple = { base_fee_cents: 1200, base_includes: 1, extra_item_fee_cents: 500 };
  assert.equal(fees.priceOfItem(simple, 1), 1200);
  assert.equal(fees.priceOfItem(simple, 2), 500);
});

test('一路報下去，價格照基本盤和加項走 / entering item after item follows the plan', async () => {
  const { competition, general, division, account, athlete } = await setUp();
  const cha = await division('恰恰單項', general);
  const rumba = await division('倫巴單項', general);
  const jive = await division('捷舞單項', general);
  const samba = await division('森巴單項', general);

  const enter = async (d) => regs.register({
    competitionId: competition.id, divisionId: d.id, athleteIds: [athlete.id], entrantId: account.id,
    provider: 'ecpay',
  });

  assert.equal((await enter(cha)).quote.totalCents, 1800, 'first item: the base fee');
  assert.equal((await enter(rumba)).quote.totalCents, 0, 'second item: inside the base');
  assert.equal((await enter(jive)).quote.totalCents, 600, 'third item: an extra');
  assert.equal((await enter(samba)).quote.totalCents, 600, 'fourth item: another extra');
});

test('師生組自己數自己的 / the pro-am plan counts on its own', async () => {
  const { competition, general, proAm, division, account, athlete } = await setUp();
  const cha = await division('恰恰單項', general);
  const rumba = await division('倫巴單項', general);
  const proAmCha = await division('師生組 恰恰', proAm);

  const enter = async (d) => regs.register({
    competitionId: competition.id, divisionId: d.id, athleteIds: [athlete.id], entrantId: account.id,
    provider: 'ecpay',
  });

  await enter(cha);
  await enter(rumba);
  // 一般組已經兩項了，但師生組是另一群，所以這裡還是第 1 項，收師生組的基本費。
  // Two items in the general plan already, but pro-am is a different plan, so this is its
  // first item and costs the pro-am base fee.
  assert.equal((await enter(proAmCha)).quote.totalCents, 2500);

  // 反過來也一樣：師生組報過，不會讓一般組的第三項變便宜。
  // And the other way round: a pro-am entry does not make the general plan's third item cheaper.
  const jive = await division('捷舞單項', general);
  assert.equal((await enter(jive)).quote.totalCents, 600);
});

test('雙人組兩位各自算自己的項數 / in a couple each dancer counts their own items', async () => {
  const { competition, general, division, account, athlete } = await setUp();
  const partner = await roster.addAthlete({ entrantId: account.id, name: '李小美', birthDate: '2013-11-20' });

  const solo = await division('恰恰單項', general);
  const solo2 = await division('倫巴單項', general);
  const couple = await division('雙人拉丁', general, { memberMin: 2, memberMax: 2 });

  // 小明先自己報兩項，用掉基本盤；小美還沒報過。
  // 王小明 uses up the base on two solo items; 李小美 has entered nothing.
  const enterOne = (d) => regs.register({
    competitionId: competition.id, divisionId: d.id, athleteIds: [athlete.id],
    entrantId: account.id, provider: 'ecpay',
  });
  await enterOne(solo);
  await enterOne(solo2);

  const result = await regs.register({
    competitionId: competition.id, divisionId: couple.id, athleteIds: [athlete.id, partner.id],
    entrantId: account.id, provider: 'ecpay',
  });

  // 小明是第 3 項收 600，小美是第 1 項收 1800，合計 2400。
  // 王小明 is on item 3 at 600, 李小美 on item 1 at 1800: 2400 together.
  assert.equal(result.quote.totalCents, 2400);
  const lines = result.quote.lines;
  assert.equal(lines.find((l) => String(l.athleteId) === String(athlete.id)).itemIndex, 3);
  assert.equal(lines.find((l) => String(l.athleteId) === String(partner.id)).itemIndex, 1);
});

test('每位成員的項次和金額有存下來 / each member’s item number and price are recorded', async () => {
  const { competition, general, division, account, athlete } = await setUp();
  const cha = await division('恰恰單項', general);
  const rumba = await division('倫巴單項', general);
  const jive = await division('捷舞單項', general);

  const enter = async (d) => regs.register({
    competitionId: competition.id, divisionId: d.id, athleteIds: [athlete.id], entrantId: account.id,
    provider: 'ecpay',
  });
  await enter(cha);
  await enter(rumba);
  const third = await enter(jive);

  const members = await regs.membersOf(third.registration.id);
  assert.equal(members[0].item_index, 3);
  assert.equal(Number(members[0].item_fee_cents), 600);
});

test('取消掉的報名不佔項數 / a cancelled entry stops taking up an item', async () => {
  const { competition, general, division, account, athlete } = await setUp();
  const cha = await division('恰恰單項', general);
  const rumba = await division('倫巴單項', general);
  const jive = await division('捷舞單項', general);

  const enter = async (d) => regs.register({
    competitionId: competition.id, divisionId: d.id, athleteIds: [athlete.id], entrantId: account.id,
    provider: 'ecpay',
  });

  const first = await enter(cha);
  await enter(rumba);
  await regs.cancelRegistration(first.registration.id);

  // 取消了一項，所以這一項回到第 2 項，還在基本盤裡，不收錢。
  // One item cancelled, so this one is back to item 2, still inside the base, and free.
  assert.equal((await enter(jive)).quote.totalCents, 0);
});

test('沒挑方案的階梯組別不會亂報價 / a tiered division with no plan does not invent a price', async () => {
  const competition = await comps.createCompetition({ name: 'Half Set Up', feeCents: 900, status: 'open' });
  const orphan = await comps.addDivision({
    competitionId: competition.id, name: '設到一半', sortOrder: 1, feeMode: 'tiered',
  });
  const account = await entrants.signUp({ email: 'teacher@example.com', password: 'passw0rd!' });
  const athlete = await roster.addAthlete({ entrantId: account.id, name: '王小明', birthDate: '2012-05-04' });

  // 退回比賽的預設報名費，不是 0，也不是隨便一個數字。
  // It falls back to the competition fee, rather than zero or some invented number.
  const result = await regs.register({
    competitionId: competition.id, divisionId: orphan.id, athleteIds: [athlete.id],
    entrantId: account.id, provider: 'ecpay',
  });
  assert.equal(result.quote.totalCents, 900);
});

test('方案還有組別在用就不給刪 / a plan still in use cannot be deleted', async () => {
  const { general, division } = await setUp();
  await division('恰恰單項', general);
  const result = await fees.deleteGroup(general.id);
  assert.equal(result.deleted, false);
  assert.equal(result.reason, 'has_divisions');
});
