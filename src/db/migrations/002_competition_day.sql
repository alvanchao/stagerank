-- 第 2 到 4 段：舞科、輪次、背號、heat 分批、併場、裁判、報到檢錄、評分、成績。
-- Stages 2-4: dances, rounds, bibs, heats, merged heats, judges, check-in, scoring, results.
--
-- 用詞 / vocabulary:
--   division 組別 (U15 Latin) > round 輪 (初賽/複賽/決賽) > dance 舞科 (Cha Cha) > heat 批
--   heat 是「主持人一次放出來、同時站在場上的那一批人」。併場時一個 heat 會有好幾個組別的人。
--   A heat is everyone on the floor at once. When divisions are merged, one heat holds several of them.

-- 報到：比賽當天在報到處報到，通常就是領背號的時候。
-- Check-in desk: the competitor reports on the day, usually when collecting their bib.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS reported_at TIMESTAMPTZ;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS reported_by TEXT;

-- 背號只給結算名單裡的人，依組別自動編號。
-- Bibs go only to competitors on the settled roster, numbered per division.
ALTER TABLE voucher_entries ADD COLUMN IF NOT EXISTS bib_number INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS voucher_entries_bib_idx
  ON voucher_entries (voucher_id, bib_number) WHERE bib_number IS NOT NULL;

-- 舞科掛在比賽底下，這樣併場時不同組別可以共用同一支舞。
-- Dances belong to the competition so merged divisions can share one.
CREATE TABLE IF NOT EXISTS dances (
  id              BIGSERIAL PRIMARY KEY,
  competition_id  BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (competition_id, name)
);

-- 哪個組別跳哪幾支舞。
-- Which dances a division performs.
CREATE TABLE IF NOT EXISTS division_dances (
  id            BIGSERIAL PRIMARY KEY,
  division_id   BIGINT NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  dance_id      BIGINT NOT NULL REFERENCES dances(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (division_id, dance_id)
);

CREATE TABLE IF NOT EXISTS rounds (
  id              BIGSERIAL PRIMARY KEY,
  division_id     BIGINT NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  -- 每一輪的評分方式由主辦自己選，不寫死。
  -- The organiser picks the scoring mode per round; nothing is hard-coded.
  scoring_mode    TEXT NOT NULL DEFAULT 'mark' CHECK (scoring_mode IN ('mark', 'score', 'rank')),
  advance_count   INTEGER,
  -- mark 的勾選名額：預設每支舞總名額（董事長選的做法 A），另有每個 heat 固定名額。
  -- Mark quota: "whole dance" is the default (option A); "per heat" is the alternative.
  mark_quota_mode TEXT NOT NULL DEFAULT 'per_dance' CHECK (mark_quota_mode IN ('per_dance', 'per_heat')),
  score_method    TEXT NOT NULL DEFAULT 'average' CHECK (score_method IN ('average', 'trimmed')),
  rank_method     TEXT NOT NULL DEFAULT 'sum' CHECK (rank_method IN ('sum', 'skating')),
  tie_policy      TEXT NOT NULL DEFAULT 'advance_all' CHECK (tie_policy IN ('advance_all', 'dance_off')),
  heat_size       INTEGER NOT NULL DEFAULT 10 CHECK (heat_size > 0),
  -- 預設每支舞的 heat 成員相同；少數主辦要每支舞重新分。
  -- By default a round's heats keep the same members for every dance; some organisers reshuffle.
  reshuffle_per_dance BOOLEAN NOT NULL DEFAULT FALSE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'closed')),
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (division_id, name)
);

-- 這一輪有哪些選手。第一輪從憑證碼的名單來，後面幾輪從晉級名單來。
-- Who is in this round: the first round comes from the voucher roster, later rounds from who advanced.
CREATE TABLE IF NOT EXISTS round_entries (
  id              BIGSERIAL PRIMARY KEY,
  round_id        BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  registration_id BIGINT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  division_id     BIGINT NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  bib_number      INTEGER,
  athlete_name    TEXT NOT NULL,
  unit_name       TEXT,
  -- absent 是主持人標記缺席；成績單會顯示缺席。
  -- 'absent' is the host marking a no-show; results record it as absent.
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'absent')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, registration_id)
);

CREATE INDEX IF NOT EXISTS round_entries_round_idx ON round_entries (round_id, status);

-- 一個 heat：某一支舞、某一批人，同時站在場上。
-- One heat: one dance, one group of people, all on the floor together.
CREATE TABLE IF NOT EXISTS heats (
  id              BIGSERIAL PRIMARY KEY,
  competition_id  BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  dance_id        BIGINT NOT NULL REFERENCES dances(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  -- 上場順序。主持人臨時調整順序改的就是這個值。
  -- Running order. Re-ordering on the day changes this value.
  sort_key        DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- pending 還沒上場 / standby 預備（裁判按準備好）/ scoring 評分中 / closed 已結束
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'standby', 'scoring', 'closed')),
  standby_at      TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  -- 併場：把幾個人數少的組別併成同一場。這裡記下被併進來的 heat 原本的樣子，方便再拆開。
  -- Merging: remember what was folded in so it can be split apart again.
  merged_from     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS heats_order_idx ON heats (competition_id, sort_key, id);

CREATE TABLE IF NOT EXISTS heat_entries (
  id              BIGSERIAL PRIMARY KEY,
  heat_id         BIGINT NOT NULL REFERENCES heats(id) ON DELETE CASCADE,
  round_entry_id  BIGINT NOT NULL REFERENCES round_entries(id) ON DELETE CASCADE,
  round_id        BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  division_id     BIGINT NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  -- 檢錄：裁判畫面只列出「已檢錄」的選手，沒檢錄的人不會出現。
  -- Check-in: a judge only sees competitors marked present; nobody else appears on their screen.
  checked_in_at   TIMESTAMPTZ,
  checked_in_by   TEXT,
  UNIQUE (heat_id, round_entry_id)
);

CREATE INDEX IF NOT EXISTS heat_entries_heat_idx ON heat_entries (heat_id);

CREATE TABLE IF NOT EXISTS judges (
  id              BIGSERIAL PRIMARY KEY,
  competition_id  BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- 登入碼：代班裁判不用事先建帳號，主持人現場發一組碼就能上線。
  -- Login code: a stand-in judge needs no account, just a code handed out on the day.
  login_code      TEXT NOT NULL UNIQUE,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 每個組別指定裁判。併場時裁判只看得到他負責的組別。
-- Judges are assigned per division. In a merged heat a judge only sees the divisions they cover.
CREATE TABLE IF NOT EXISTS judge_assignments (
  id            BIGSERIAL PRIMARY KEY,
  judge_id      BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  division_id   BIGINT NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (judge_id, division_id)
);

-- 裁判就緒確認與跳出作廢，都綁在某一個 heat 上。
-- Both the ready confirmation and the walk-away rule are per heat.
CREATE TABLE IF NOT EXISTS heat_judges (
  id            BIGSERIAL PRIMARY KEY,
  heat_id       BIGINT NOT NULL REFERENCES heats(id) ON DELETE CASCADE,
  judge_id      BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  ready_at      TIMESTAMPTZ,
  -- 評分中離開畫面就作廢；預備狀態與候場期間不算。
  -- Leaving the screen while scoring voids this heat for that judge. Standby and waiting do not count.
  voided_at     TIMESTAMPTZ,
  void_reason   TEXT,
  submitted_at  TIMESTAMPTZ,
  UNIQUE (heat_id, judge_id)
);

-- 評分。一位裁判、一支舞、一位選手一筆。
-- One row per judge, dance and competitor.
CREATE TABLE IF NOT EXISTS scores (
  id              BIGSERIAL PRIMARY KEY,
  round_id        BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  dance_id        BIGINT NOT NULL REFERENCES dances(id) ON DELETE CASCADE,
  heat_id         BIGINT NOT NULL REFERENCES heats(id) ON DELETE CASCADE,
  judge_id        BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  round_entry_id  BIGINT NOT NULL REFERENCES round_entries(id) ON DELETE CASCADE,
  marked          BOOLEAN,
  points          NUMERIC(6, 2),
  rank_position   INTEGER,
  -- 換場倒數結束時自動收件的，記下來，事後查得到。
  -- Auto-collected at the change-over countdown; recorded so it can be audited later.
  auto_collected  BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, dance_id, judge_id, round_entry_id)
);

CREATE INDEX IF NOT EXISTS scores_round_idx ON scores (round_id, dance_id);

-- 每一輪算完的結果。公告前不對外顯示。
-- The computed outcome of a round. Nothing is public until the organiser publishes it.
CREATE TABLE IF NOT EXISTS results (
  id              BIGSERIAL PRIMARY KEY,
  round_id        BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  round_entry_id  BIGINT NOT NULL REFERENCES round_entries(id) ON DELETE CASCADE,
  total_marks     INTEGER,
  total_points    NUMERIC(8, 2),
  final_rank      INTEGER,
  advanced        BOOLEAN NOT NULL DEFAULT FALSE,
  absent          BOOLEAN NOT NULL DEFAULT FALSE,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, round_entry_id)
);

ALTER TABLE rounds ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
-- 是否公開每位裁判的個別給分，由主辦設定。
-- Whether individual judges' marks are public is the organiser's choice.
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS show_judge_detail BOOLEAN NOT NULL DEFAULT FALSE;
-- 換場倒數秒數，主辦設定，0 就是立刻換場。
-- Change-over countdown in seconds, set by the organiser; 0 means change immediately.
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS changeover_seconds INTEGER NOT NULL DEFAULT 8;
-- 檢錄人員的畫面要看接下來幾場。
-- How many upcoming heats the check-in staff see.
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS lookahead_heats INTEGER NOT NULL DEFAULT 3;
-- 每場預估時間，用來估「還有多久輪到你」，比賽開始後改用實測平均。
-- Estimated minutes per heat, used for the judge's waiting notice until real timings exist.
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS estimated_heat_seconds INTEGER NOT NULL DEFAULT 150;
-- 是否開放檢錄人員重新分 heat。
-- Whether check-in staff may re-split heats.
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS checkin_can_resplit BOOLEAN NOT NULL DEFAULT TRUE;
