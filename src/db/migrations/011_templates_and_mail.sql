-- 011：記住上次用的設定、我的範本、免密碼登入連結。
-- 011: remembered settings, saved templates, passwordless login links.

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saved_templates (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 只存 token 的 sha256；明文只在信裡出現一次。
-- Only the sha256 of the token is stored; the plain token exists once, inside the mail.
CREATE TABLE IF NOT EXISTS login_links (
  id          BIGSERIAL PRIMARY KEY,
  entrant_id  BIGINT NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_links_entrant_idx ON login_links (entrant_id, created_at DESC);

-- 組別屬於哪個分類（範本第 2 層）；手動建立的組別為 NULL。
-- Which category (template level 2) a division belongs to; NULL for hand-made divisions.
ALTER TABLE divisions ADD COLUMN IF NOT EXISTS category TEXT;
