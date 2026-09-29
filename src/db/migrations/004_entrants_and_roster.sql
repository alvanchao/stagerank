-- 報名人帳號與選手名冊，加上年齡驗證。
-- Entrant accounts, their athlete roster, and age checking.

-- ---------------------------------------------------------------- 報名人 / entrants

-- 報名的人通常是教室老師，一次幫二十個學生報名。要他為每個學生打一組電子郵件是不可能的，
-- 小朋友多半也沒有。所以電子郵件是「報名人」的身分，不是「選手」的身分。
-- The person registering is usually a teacher entering twenty students at once. Asking for an
-- email per student is not realistic, and most children do not have one. So the email identifies
-- the entrant, never the athlete.
CREATE TABLE IF NOT EXISTS entrants (
  id             BIGSERIAL PRIMARY KEY,
  email          TEXT NOT NULL,
  -- scrypt，不引進新套件；格式是 scrypt$N$r$p$salt$hash。
  -- scrypt, so no new dependency; stored as scrypt$N$r$p$salt$hash.
  password_hash  TEXT NOT NULL,
  unit_name      TEXT,
  contact_name   TEXT,
  phone          TEXT,
  -- 主辦幫忙重設密碼之後，下次登入必須自己改掉。
  -- After the organiser resets a password the entrant must choose a new one at next login.
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS entrants_email_key ON entrants (lower(email));

-- ---------------------------------------------------------------- 名冊 / the roster

-- 名冊綁在報名人帳號上，跨比賽重複使用：建一次，以後每一場都用點的。
-- 生日是必填，因為組別的年齡限制靠它自動驗證。
-- The roster belongs to the account and is reused across competitions: built once, then ticked.
-- The date of birth is required because it is what the age limits are checked against.
CREATE TABLE IF NOT EXISTS athletes (
  id           BIGSERIAL PRIMARY KEY,
  entrant_id   BIGINT NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  birth_date   DATE NOT NULL,
  -- 選填。有留就能寄成績通知，沒留照樣比賽。
  -- Optional. It allows a results notice; without one the competitor still competes.
  email        TEXT,
  note         TEXT,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS athletes_entrant_idx ON athletes (entrant_id, name);

-- ---------------------------------------------------------------- 接上原本的報名 / wiring it in

-- 舊資料沒有帳號也沒有名冊，欄位一律可以留空，不會壞。
-- Older rows have neither an account nor a roster entry, so both columns stay nullable.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS entrant_id BIGINT REFERENCES entrants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS registrations_entrant_idx ON registrations (entrant_id);

ALTER TABLE registration_members ADD COLUMN IF NOT EXISTS athlete_id BIGINT REFERENCES athletes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS registration_members_athlete_idx ON registration_members (athlete_id);

-- ---------------------------------------------------------------- 年齡 / age

-- 各國規則不同，所以算法由主辦選：
-- year_end＝以比賽當年 12 月 31 日的歲數（同年出生的一律同組，國標舞最常見）
-- event_day＝以比賽當天的實歲
-- The rule differs by country, so the organiser picks:
-- year_end  = the age on 31 December of the competition's year (everyone born in the same year
--             lands in the same group; the usual ballroom convention)
-- event_day = the actual age on the day of the competition
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS age_basis TEXT NOT NULL DEFAULT 'year_end';
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS event_date DATE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'competitions_age_basis_check') THEN
    ALTER TABLE competitions ADD CONSTRAINT competitions_age_basis_check
      CHECK (age_basis IN ('year_end', 'event_day'));
  END IF;
END $$;

-- 組別的年齡上下限。留空＝不限。
-- The division's age bounds. Blank means no limit.
ALTER TABLE divisions ADD COLUMN IF NOT EXISTS age_min INTEGER;
ALTER TABLE divisions ADD COLUMN IF NOT EXISTS age_max INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'divisions_age_range_check') THEN
    ALTER TABLE divisions ADD CONSTRAINT divisions_age_range_check
      CHECK (age_min IS NULL OR age_max IS NULL OR age_max >= age_min);
  END IF;
END $$;
