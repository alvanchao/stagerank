# StageRank

Free, open-source competition management: online registration, payments, running order, heats, check-in, floor control, judging and results. Built for dance competitions, usable for anything judged in heats.

免費、原始碼公開的比賽管理系統：線上報名、金流、秩序表、分批、報到檢錄、主持人控場、裁判評分、成績公告。為舞蹈比賽而做，任何分批評分的比賽都能用。

MIT licensed. You owe the author nothing. There is one request, near the bottom of this page.

**Community / 交流群:** questions, ideas and show-and-tell in the [StageRank Telegram group](https://t.me/+oIadPNmIKrEwZDE1). 使用問題、功能想法與經驗分享，歡迎加入 Telegram 交流群。

![The host's floor-control board](docs/shots/15-host-standby.png)

---

> **Before a real event / 正式比賽前:** a test site runs with "pretend" email and Google sign-in switched on. Read [docs/GOING-LIVE.md](docs/GOING-LIVE.md) first. 測試站會開著「假裝寄信」和「假 Google 登入」，正式比賽前請先看 [docs/GOING-LIVE.md](docs/GOING-LIVE.md)。

## What it does

**Before the competition**

- Entrants — a studio, a teacher, a parent — hold an account and a roster. The roster is built once, with a name and a date of birth per person, and reused for every competition after that: entering is then a matter of ticking names. Only the account holder needs an email address; the competitors need none, which matters when most of them are children.
- Online registration with entry fees per competition or per division.
- A division is solo, couple or team, set by a member range: 1–1, 2–2, 3–24, or a fixed 3–3 for a division that takes threes only. One entry is one bib whatever its size, so nothing downstream changes.
- Four ways to charge. A flat fee for the whole entry; a fee per person; a surcharge (or a discount, with a negative number) for somebody entering a second division; or a **fee plan** — "1800 covers two items, then 600 each" — which is how most ballroom competitions actually price. One division counts as one item, so the organiser's own division split is what the money follows.
- A fee plan is counted per person and per plan. Pro-am has become common and must not be counted together with the ordinary divisions, so it gets a plan of its own: two general items already entered do not make the first pro-am item cheaper, and the reverse holds too. An organiser can add as many plans as the event needs without touching code.
- The entry screen prices each competitor on their own line as the name is ticked — "item 3 · 600" — so nobody submits and then argues about the total. Which item number each member was on, and what they paid, is stored with the entry, so the books can be checked afterwards.
- The repeat is recognised by the roster entry, never by name — two countries will always have two people with the same one.
- The entry form refuses to submit until the right number of people is ticked.
- Age limits per division are two separate bounds, both optional, which is what makes the usual convention work by itself: a 13-year-old can enter U13, U15 and U18 — those set only an upper bound — and is refused by U11. Adult divisions set only a lower bound. A pro-am division leaves both blank, since the teacher's age is not the point. Limits are checked against the roster's dates of birth: anyone outside them cannot be ticked and is told why on the spot. How age is counted is the organiser's choice — the age on 31 December of the competition's year, which keeps everyone born in the same year together, or the actual age on the day — because the convention differs by country.
- Payments through ECPay, NewebPay, PayPal or Stripe — the organiser's own keys, so the money goes straight to the organiser.
- Building the divisions starts with one question: is this the same event you have run before? If it is, the whole setup — dances, fee plans, divisions, and each division's dance list — copies across from the earlier competition in one press, and only the date is new. Entries and results stay behind where they belong.
- The home page starts with an account strip: **Sign up** and **Sign in** for a visitor, and **My entries** for a signed-in entrant — every entry across every competition, with its status, amount and a link to the entry page. The competition list underneath stays public and shows only name, status and fee.
- An entry page (`/r/<id>`) carries a competitor's name and the amount, so a sequential id is not enough to open it: only the organiser and the signed-in entrant who owns the entry can. Everyone else gets the ordinary 404 (not 403), so even the existence of an id cannot be confirmed.
- **Template library, three levels.** The setup page picks a *genre* (first one: ballroom), then a *template*, then shows its divisions grouped by *category*, each category with its own select-all / select-none, plus a global all/none and a running count. A row says how many dances, the age limits and whether it is solo, couple or team. The curated `ballroom-tw` template carries 46 divisions (professional, amateur, youth solo and couple, adult solo, senior, and the two pro-am series) with the dances already attached and two fee plans (general 1800 covering 2 then 600; pro-am 2500 covering 1 then 1200) prefilled. The older generated template stays selectable as "Generic ballroom (auto-combined)".
- **Remembers the last choice.** Applying a template stores its fee plans and ticked divisions; the next time that template is opened they come back prefilled, falling back to the template's own defaults. Once a competition has divisions, "Save as my template" keeps them — literal names, dances, ages, member limits, fee plans, category — under a name of your own; they appear in the picker under "My templates" and apply through exactly the same path. Saving under an existing name overwrites it.
- A first-time organiser starts from the built-in ballroom template instead. It generates the divisions already wired to their dances, with everything switched on, and the organiser switches off what they are not running. Removing from a list is far less work than ticking items out of an empty grid, and it also shows them what they could be running. Three-dance events are deliberately not offered, because which three dances they are differs by region, and guessing wrong is worse than leaving it out. Dance names follow the interface language, so a Chinese running order says 恰恰 rather than Cha Cha.
- Nothing is final until somebody enters: while the entry list is empty the whole setup can be cleared and rebuilt. Once the first entry arrives it locks, because moving divisions at that point makes the roster stop adding up.
- Closing registration issues a **competition voucher code**. Everything after that point requires it.
- Bibs, divisions, dances and rounds; heats split evenly; small divisions merged onto one floor.
- Judges assigned per division. Warnings for unassigned divisions and even-sized panels on the skating system.

**On the day**

- A check-in desk marks who has arrived; anyone who never reported in is greyed out for the marshal.
- The marshal sees the next few heats, checks competitors in, and reports a heat ready.
- The host runs the floor: change over, countdown, auto-collect, start, reorder, merge, mark absent, and add a latecomer mid-heat.
- Before a round starts the host sees how many were expected and how many actually turned up, and decides: carry on as planned, change how many go through, pass everyone to the next round without dancing it, or skip straight to the final. The decision is the host's alone — on the day there is no time to consult anyone — and it is refused once that round has started scoring.
- Judges see only the current heat, and only the divisions they were assigned to. A waiting notice tells them how many heats until their next one.
- Leaving the screen while scoring voids that judge for that heat only. Standby, waiting and submitting are all fine.
- Everything syncs live to every phone in the room.

**Scoring and results**

- Three modes per round, chosen by the organiser: marks (crosses), points, or places.
- Marks add up across every dance and judge; the quota is the whole dance by default, or fixed per heat.
- Points average, with an optional trim of the highest and lowest.
- Places by rank sum, or by the **skating system** (majority, then count, then sum).
- Results are private until the organiser publishes them. Competitors look themselves up by bib.

**Everywhere**

- Traditional Chinese and English built in; adding a language is one file.
- Dates, times and money follow the locale and the currency.

## Install

### Docker (one command)

```bash
git clone https://github.com/alvanchao/stagerank.git
cd stagerank
cp .env.example .env     # fill in SITE_NAME, ADMIN_TOKEN and your payment keys
docker compose up -d
```

Open `http://localhost:3000`. The database schema is created on first boot.

### Railway (one account, no terminal)

1. Create a Railway project and add a **PostgreSQL** service.
2. Add a service from this GitHub repository.
3. In the app service's variables, set `DATABASE_URL` to the Postgres service's connection string, plus `SITE_NAME`, `BASE_URL`, `ADMIN_TOKEN` and your payment keys.
4. Deploy. Railway builds the Dockerfile and the schema is created on boot.

Roughly US$5 a month at the time of writing. Check Railway's current pricing.

### Vercel + Supabase (free to start)

1. Create a Supabase project and copy its Postgres connection string.
2. Import this repository into Vercel.
3. Set `DATABASE_URL` (the Supabase string), `DATABASE_SSL=true`, `SITE_NAME`, `BASE_URL`, `ADMIN_TOKEN` and your payment keys.
4. Deploy.

Two things to know before a real competition on the free tier: a Supabase project that has been idle is paused and needs waking up beforehand, and Vercel's Hobby plan has non-commercial terms that a paid competition may not fit. Check both before the day.

### Node and Postgres by hand

```bash
npm install
cp .env.example .env
npm run migrate
npm run seed     # optional demo competition
npm start
```

## Configuration

Everything is environment variables — see [`.env.example`](.env.example). Two things every organiser sets:

- `SITE_NAME` — your competition's name, shown in the header.
- Your own payment keys. **Keys are read from the environment only.** They are never written to the database and never appear in the source.

Optional: `SMTP_URL` and `MAIL_FROM` (emailed 6-digit sign-in codes for entrants), `ADMIN_EMAILS` with `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (organiser sign-in with Google), `TEMPLATE_DIR` (your own templates, see "Adding a template or genre"). `MAIL_MODE=pretend` and `GOOGLE_LOGIN_MOCK=true` are **test-site-only** pretend modes — see [docs/GOING-LIVE.md](docs/GOING-LIVE.md) before a real event.

A payment provider stays hidden on the registration form until it is both enabled and fully keyed.

### How each provider completes a payment

- **ECPay, NewebPay** — the payer is sent to the provider's page, and the provider calls back `/pay/<provider>/notify`. The callback is signature-checked (ECPay MAC, NewebPay AES + SHA) before anything is marked paid. The site therefore needs a **publicly reachable `BASE_URL`**.
- **PayPal** — StageRank creates the order, sends the payer to PayPal to approve, and when the payer returns it **captures the payment itself**; only PayPal answering `COMPLETED` (with a matching amount) marks it paid. No webhook is required. Optionally create a webhook in PayPal and set `PAYPAL_WEBHOOK_ID`: notifications are then confirmed with PayPal's own verification call. Without that ID, webhooks are simply ignored.
- **Stripe** — StageRank creates a Checkout Session, sends the payer there, and on return **asks Stripe whether the session was paid**. The restricted key (`rk_…`) needs write access to *Checkout Sessions* (to create) and read access (to check). NT$ amounts are converted for Stripe's two-decimal TWD rule.

## The day, screen by screen

| Who | Where | Passcode |
| --- | --- | --- |
| Organiser | `/admin` | `ADMIN_TOKEN` |
| Registration desk | `/desk` | a personal single-use code (organiser page → Staff) |
| Marshal (check-in) | `/checkin` | a personal single-use code (organiser page → Staff) |
| Host | `/host` | a personal single-use code (organiser page → Staff) |
| Entrant (studio or parent) | `/entrant` | their own email and password, or an emailed 6-digit code when mail is configured |
| Judge | `/judge` | their own login code |
| Competitors and public | `/results` | none |

Staff sign in through the staff app at `/staff/app`: the organiser creates a batch of names, each person gets a personal code and QR that works once, and the server remembers them until the competition is ended or they are revoked. The page asks to be installed to the home screen first (a plain browser can be allowed per batch as a fallback). Check-in staff and the host can also open `/desk` to rescue someone the desk missed. Staff screens are built to be added to a phone's home screen and run full-screen.

A judge's login code is generated by the organiser and can be handed out on the day, so a stand-in judge needs no account set up in advance.

**Email sign-in codes (optional).** Set `SMTP_URL` and `MAIL_FROM` and the entrant screens become passwordless: signing up asks for an email address (and an optional unit, contact and phone), signing in asks for the address only, and a random 6-digit code is mailed. The code works once, for 10 minutes, and is void after 5 wrong tries; only a keyed hash of it is stored. The login page answers "if this address is registered, we have sent a code" whether or not the address exists, sends at most one mail per address per 60 seconds, and signing up an address that already exists looks identical and changes nothing. The mail is in the language of the request. With no mail configured nothing changes: email and password, and the organiser's temporary-password reset below. `MAIL_MODE=memory` keeps mail in an in-memory outbox (`src/services/mailer.js` exports `outbox`) for development and tests; nothing is sent. `MAIL_MODE=pretend` also sends nothing and **shows the code on the screen** so a test site can be tried without a mail service — it gives no protection at all, so never leave it on for a real event ([docs/GOING-LIVE.md](docs/GOING-LIVE.md)). `NODE_ENV=test` alone does not switch mail on.

**Organiser sign-in with Google (optional).** Set `ADMIN_EMAILS` (comma separated) and `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and the back-office login page offers *Sign in with Google*; only listed addresses get in. Google proves who you are and nothing else: competition data stays in your own database. The passcode `ADMIN_TOKEN` keeps working as a fallback. `GOOGLE_LOGIN_MOCK=true` swaps Google for a pretend page where typing a listed email signs you in — for development only; under `NODE_ENV=production` it is refused unless `ALLOW_MOCK_IN_PRODUCTION=true` is also set on purpose.

In password mode, a forgotten entrant password is handled face to face: the organiser issues a temporary one from `/admin/entrants`, and the entrant must choose their own at the next sign-in. There is deliberately no "email me a reset link", because a self-hosted site may have no mail service at all, and a competition that cannot send mail should still be able to take entries.

## Adding a template or genre

The template library is data. The built-in catalogue lives in `src/templates/*.json`; to add your own without touching code, put JSON files in a folder and set `TEMPLATE_DIR=/path/to/folder` (they are read at start-up, next to the built-in ones; a file cannot replace a built-in `key`, and a broken file is skipped with a warning). A file looks like this:

```json
{
  "key": "my-genre-2027",
  "genre": "my-genre",
  "genreLabel": { "zh-TW": "我的類型", "en": "My genre" },
  "label": { "zh-TW": "我的範本", "en": "My template" },
  "dances": [ { "key": "floor", "style": "x" }, { "key": "vault", "style": "x" } ],
  "danceNames": { "floor": { "zh-TW": "自由體操", "en": "Floor" }, "vault": { "zh-TW": "跳馬", "en": "Vault" } },
  "danceSets": { "both": ["floor", "vault"] },
  "plans": { "general": { "base": 1800, "includes": 2, "extra": 600 } },
  "categories": [
    { "key": "kids", "label": { "zh-TW": "兒童", "en": "Kids" }, "divisions": [
      { "key": "k1", "name": { "zh-TW": "兒童全能", "en": "Kids all-round" },
        "set": "both", "members": [1, 1], "ageMax": 10, "plan": "general" }
    ] }
  ]
}
```

`dances` fixes the order dances are created in. A division lists `dances` directly or names a `set` from `danceSets`; `members` is `[min, max]` (default `[2, 2]`); `ageMin` / `ageMax` are optional; `plan` names an entry of `plans` (default: the first). Anywhere a label is expected you may write a plain string, a `{ locale: text }` object, or leave it out and add locale keys instead (`setup.genres.<genre>`, `setup.categories.<category>`, `setup.dances.<dance>`, `setup.plans.<plan>`, and `setup.<key>.<division>` or `nameKeyPrefix` for division names — this is how `ballroom-tw` does it).

## Adding your language

1. Copy `src/locales/en.json` to `src/locales/<your-code>.json`.
2. Translate the values. Leave the keys alone.
3. Restart. Your language appears in the picker automatically.

Every visible string lives in those files; a test fails the build if any is hard-coded. Pull requests with new translations are very welcome.

## How the competition voucher code works

Registration is the only place money changes hands. When the organiser closes registration, the payment module settles every confirmed entry into one roster and issues a **competition voucher code** — globally unique and unguessable. Bibs, running order, floor control, judging and results all check that code before they will run, and read competitors from the roster it is bound to.

Three payment sources produce an identical voucher, so the rest of the system behaves the same either way: online payment, a free competition (fee set to 0), and cash or bank transfer marked by the organiser.

After a late entry, a withdrawal or a refund, **re-settle** issues a new code and revokes the old one immediately. Once judging has started, re-settling is refused so the roster cannot move mid-competition.

## The anti-cheating rule, and its limits

While a heat is being scored, a judge who leaves the screen has their scoring for **that heat** voided; the next heat starts clean. Standby, waiting between heats, and the moment after submitting are all exempt, and so is a refresh the system itself triggers.

What this cannot do: a web app cannot silence LINE, incoming calls or other notifications. That is an iPhone and Android limitation, not a choice. Instead the judge is asked to turn on Do Not Disturb before the round, and a notification only matters if the judge taps it and leaves the screen.

## The one request

StageRank is free. You do not pay the author, and you never will.

The only request is that you keep two things in place:

1. **The "Powered by StageRank" footer**, which is how other organisers find the project.
2. **The partner IDs** sent to the payment providers, which is how the author can show those providers how much business this software brings them.

Neither costs you anything. Neither affects your money — payments go straight to your own account through your own keys. Both are on by default and can be switched off in `.env`.

**Where the partner IDs come from.** They are not printed into the code. Once a day your installation reads [`telemetry.json`](telemetry.json) from this repository and takes the `partner_ids` it finds there. That is deliberate: the day the author signs with a provider and receives a platform id, one edit to that file reaches every installed copy the next day, without anyone updating anything — and this project does no automatic updates. Three rules keep it harmless. If the file cannot be reached, the ids stay blank, exactly as if the feature did not exist. A badly formed value is ignored and the transaction proceeds. And anything you set yourself in `.env` always wins over the file. `STAGERANK_REMOTE_PARTNER_IDS=false` stops the lookup altogether.

**This is a request, not a legal obligation.** The MIT licence does not require it, and removing them is not unlawful. We simply hope you leave them alone, because they are what keeps this project maintained.

## What we send back

**This is always on, and there is deliberately no setting to switch it off.** It is a project decision, stated here openly. StageRank is MIT-licensed, so anyone who does not want it may change the code themselves (the reporting lives in `src/services/stats.js`).

A summary is queued when a competition is settled and again after every successful online payment, containing:

- your site URL and site name,
- a short hash that stands for the competition (not its name or id),
- the number of competitors in the settled roster, the fee total and currency,
- per-provider payment counts and totals (test and live apart), and how many carried the partner ID,
- the program version, whether the footer credit is shown, whether each provider's partner ID is set (yes/no only, not the ID), and the time of the report,
- a random **site key** (see below).

It contains **no competitor data of any kind** — not names, not emails, not even the competition's name — and **no payment keys**. A failed report never affects a competition in progress; it is retried for up to 14 days and then dropped.

Nothing is sent until the site has a real address: `BASE_URL` must be an `https` production domain (not `localhost`, not an IP address), and the dashboard says so until it is set.

**The site key.** The first time it reports, each install makes one random key and keeps it only in its own database. It is only used to prove the URL is yours: the site publishes just the key's *hash* at `/.well-known/stagerank-usage.json`, and the key itself is never published. See [`docs/GOING-LIVE.md`](docs/GOING-LIVE.md) for how to check that file is reachable.

**Where it goes.** The address is read from [`telemetry.json`](telemetry.json) in this repository, but a report is only ever sent to a collector host that is *also* hard-coded in the program (`allowedHosts` in `src/config.js`), over https and without following redirects. So the destination is the program's list intersected with `telemetry.json`: editing the config file alone cannot send reports anywhere new, and moving to a host outside that list needs a new release.

## Your competitors' data is yours

StageRank is self-hosted. Competitor names, emails, scores and payment records live in your database, on your server, under your control — and under your responsibility for whatever data protection law applies to you. The authors never see them.

## Development

```bash
npm test          # the whole suite
npm run test:unit # everything except the browser tests
npm run demo      # drives a whole competition through a real browser and writes docs/shots
```

Tests need a Postgres at `TEST_DATABASE_URL` (default `postgres://postgres:devpass@127.0.0.1:5432/stagerank_test`). The browser tests skip themselves if no Chromium is installed; `npx playwright install chromium` provides one.

## What still needs a real-world check

Honest list, so nobody is surprised:

- Sandbox status: **ECPay and NewebPay** have been run end to end against their sandboxes (order, payment, callback, marked paid). **PayPal and Stripe** are covered by unit and HTTP tests against a fake provider; a real sandbox run is still to be recorded here.
- ECPay's and NewebPay's platform/partner fields are deliberately left blank, because sending one without a contract can fail the transaction. NewebPay's official manual could not be obtained; whether MPG has a vendor attribution field at all is unconfirmed.
- The skating system implements the majority rules (majority, count, sum, then the next place) and combines dances by rank sum. Federations differ in the later tie-breaks; check it against your own rulebook before using it for a titled event.
- The Docker image has not been built on a machine with access to Docker Hub.
- The same person entered by two different studios counts as two people, so a cross-division surcharge is not charged across accounts. This is deliberate: matching them would mean guessing, and an organiser cannot reliably tell two same-named competitors apart either.
- There is no bulk import of a roster yet. Names are typed one after another, which for a class of twenty takes a few minutes and happens once. An import would need far more validation than it saves, so it waits until somebody actually asks.

## Licence

[MIT](LICENSE).


## Usage statistics and the collector

Each install sends a small anonymous summary right after every successful online payment (and again when the organiser closes registration), containing exactly what the "What we send back" section lists (site address and name, competition summary, per-provider payment counts and totals, program version and similar details). It never contains competitor names, emails or any payment key, and there is deliberately no setting to switch it off (see "What we send back"). Where reports go is read from `telemetry.json` in this repository, and only to a collector host that is hard-coded in the program, over https.

Each install makes one random **site key** the first time it reports and keeps it in its own database. The report carries that key so a collector can tell later reports from the same site; the site also publishes only the key's hash at `/.well-known/stagerank-usage.json`, which a collector can read once to check that the site really owns its URL. Reports that cannot be delivered are retried for up to 14 days and then dropped, and if the collector refuses one with 403 the organiser dashboard shows a notice. None of this affects a competition.

The built-in collector described next is **for the maintainer's own test site only** (it has no site keys and no domain verification); the real collector is the Cloudflare Worker in [`collector-worker/`](collector-worker/). The maintainer's test server can receive them: set `STAGERANK_COLLECTOR=true` and the server accepts `POST /usage` and shows totals to the organiser at `/admin/usage` (sites, competitions, entries, amounts per provider and currency). A repeat report for the same competition replaces the old one, so numbers are not double-counted. Figures are self-reported by each site, so treat them as indicative.
