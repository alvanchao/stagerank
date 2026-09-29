-- 參賽單位、收費方式、輪次當天處置。
-- Entry units (solo / couple / team), fee modes, and the host's day-of decision for a round.

-- ---------------------------------------------------------------- 組別 / divisions

-- 一個參賽單位有幾個人。單人 1 人，雙人 2 人，多人由主辦設上下限（例如 3 到 24，或固定 3）。
-- How many people make up one entry: solo is 1, a couple is 2, a team is whatever the organiser
-- sets (3 to 24, say, or exactly 3).
ALTER TABLE divisions ADD COLUMN IF NOT EXISTS member_min INTEGER NOT NULL DEFAULT 1;
ALTER TABLE divisions ADD COLUMN IF NOT EXISTS member_max INTEGER NOT NULL DEFAULT 1;

-- 收費方式：per_entry＝整組收；per_person＝每個人都要收。
-- 同一個組別內的人一律相同，不做個別選手的特例。
-- Fee mode: per_entry charges the unit once, per_person charges every member.
-- Everyone in a division pays the same; there are no per-competitor exceptions.
ALTER TABLE divisions ADD COLUMN IF NOT EXISTS fee_mode TEXT NOT NULL DEFAULT 'per_entry';

-- 跨組別加收：同一個人報第二個組別起，每多報一個組別加收多少。負數就是減免。
-- Cross-division surcharge: what a person pays on top from their second division onwards.
-- A negative amount is a discount.
ALTER TABLE divisions ADD COLUMN IF NOT EXISTS extra_division_fee_cents BIGINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'divisions_fee_mode_check') THEN
    ALTER TABLE divisions ADD CONSTRAINT divisions_fee_mode_check
      CHECK (fee_mode IN ('per_entry', 'per_person'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'divisions_member_range_check') THEN
    ALTER TABLE divisions ADD CONSTRAINT divisions_member_range_check
      CHECK (member_min >= 1 AND member_max >= member_min AND member_max <= 24);
  END IF;
END $$;

-- ---------------------------------------------------------------- 參賽單位的成員 / members of an entry

-- 一筆報名 ＝ 一個參賽單位 ＝ 一個背號。底下可以有 1 個人（單人）、2 個人（雙人）或更多（多人）。
-- 評分本來就是對「一個參賽單位」評，所以這張表不影響任何計算。
-- One registration is one entry unit and one bib. Underneath it are one, two or more people.
-- Scoring already works on the unit, so this table changes no calculation at all.
CREATE TABLE IF NOT EXISTS registration_members (
  id              BIGSERIAL PRIMARY KEY,
  registration_id BIGINT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  athlete_name    TEXT NOT NULL,
  -- 認人用電子郵件，不用姓名：各國同名的機會太高。
  -- People are identified by email, never by name: the same name turns up too often worldwide.
  person_email    TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS registration_members_reg_idx ON registration_members (registration_id, sort_order);
CREATE INDEX IF NOT EXISTS registration_members_email_idx ON registration_members (lower(person_email));

-- 這一筆報名收了多少跨組別加收，記下來才查得出帳。
-- How much cross-division surcharge this entry paid, so the money can be accounted for.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS member_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS extra_fee_cents BIGINT NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------- 輪次當天處置 / the host's decision

-- 排賽序時就設好取幾人，但當天有人沒到，這一輪可能根本不該比。
-- 主持人在該輪開始前決定：照舊、免賽晉級、或直接跳到決賽。
-- The places available are set when the schedule is built, but on the day people do not turn up and
-- the round may not be worth running. Before it starts the host chooses: run it, free pass, or skip
-- straight to the final.
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMPTZ;
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS outcome_by TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rounds_outcome_check') THEN
    ALTER TABLE rounds ADD CONSTRAINT rounds_outcome_check
      CHECK (outcome IN ('normal', 'free_pass', 'skipped'));
  END IF;
END $$;

-- 主持人每一次處置都留紀錄，事後有爭議查得到。
-- Every decision the host makes is recorded, so a later dispute can be checked.
CREATE TABLE IF NOT EXISTS round_decisions (
  id            BIGSERIAL PRIMARY KEY,
  round_id      BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  decision      TEXT NOT NULL CHECK (decision IN ('normal', 'free_pass', 'skipped', 'advance_count')),
  present_count INTEGER,
  expected_count INTEGER,
  advance_count INTEGER,
  decided_by    TEXT NOT NULL DEFAULT 'host',
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  note          TEXT
);
CREATE INDEX IF NOT EXISTS round_decisions_round_idx ON round_decisions (round_id, decided_at DESC);
