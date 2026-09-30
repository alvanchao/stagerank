-- 信箱驗證碼登入：寄 6 位數字，10 分鐘有效，只能用一次，錯 5 次作廢。只存雜湊。
-- Email code sign-in: a 6-digit number, good for 10 minutes, single use, void after 5 wrong tries. Hash only.
CREATE TABLE IF NOT EXISTS login_codes (
  id          BIGSERIAL PRIMARY KEY,
  entrant_id  BIGINT NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_codes_entrant_idx ON login_codes (entrant_id, created_at DESC);
