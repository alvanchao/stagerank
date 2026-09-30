-- 工作人員改成「每人一組專屬通行碼」：碼只能用一次，登入後由伺服器記住這個人。
-- Staff now get one personal, single-use passcode each; the server remembers who signed in.
DROP TABLE IF EXISTS competition_staff_codes;

ALTER TABLE competitions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS staff_members (
  id             BIGSERIAL PRIMARY KEY,
  competition_id BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('desk', 'checkin', 'host')),
  -- 只存雜湊；明文只在產生當下顯示一次。
  -- Only hashes are stored; the plain code is shown once when issued.
  code_hash      TEXT NOT NULL UNIQUE,
  session_hash   TEXT,
  -- 備用：允許不安裝成 App、直接用瀏覽器登入（例如手機不支援）。
  -- Fallback for a device that cannot install: allow signing in from a plain browser.
  allow_browser  BOOLEAN NOT NULL DEFAULT FALSE,
  redeemed_at    TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_members_competition_idx ON staff_members (competition_id);
CREATE INDEX IF NOT EXISTS staff_members_session_idx ON staff_members (session_hash);

-- 誰在什麼時候做了什麼。
-- Who did what, and when.
CREATE TABLE IF NOT EXISTS staff_log (
  id             BIGSERIAL PRIMARY KEY,
  competition_id BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  staff_id       BIGINT REFERENCES staff_members(id) ON DELETE SET NULL,
  staff_name     TEXT NOT NULL,
  role           TEXT NOT NULL,
  action         TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_log_competition_idx ON staff_log (competition_id, id DESC);
