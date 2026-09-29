-- StageRank 第 1 段：比賽、組別、報名、付款、比賽憑證碼、統計回報。
-- StageRank stage 1: competitions, divisions, registrations, payments, competition voucher, usage reports.

CREATE TABLE IF NOT EXISTS competitions (
  id              BIGSERIAL PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  -- draft 尚未開放 / open 報名中 / closed 已結算（有憑證碼）
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  currency        TEXT NOT NULL DEFAULT 'TWD',
  fee_cents       BIGINT NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  opens_at        TIMESTAMPTZ,
  closes_at       TIMESTAMPTZ,
  -- 比賽已經開始評分之後就不能再重新結算
  scoring_started_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS divisions (
  id              BIGSERIAL PRIMARY KEY,
  competition_id  BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- 各組別可以有自己的報名費；NULL 表示沿用比賽的預設費用
  fee_cents       BIGINT CHECK (fee_cents IS NULL OR fee_cents >= 0),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (competition_id, name)
);

CREATE TABLE IF NOT EXISTS registrations (
  id              BIGSERIAL PRIMARY KEY,
  competition_id  BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_id     BIGINT NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  athlete_name    TEXT NOT NULL,
  athlete_email   TEXT,
  unit_name       TEXT,
  amount_cents    BIGINT NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  currency        TEXT NOT NULL DEFAULT 'TWD',
  -- pending 未付款 / paid 已確認收款 / cancelled 取消 / refunded 已退款
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'paid', 'cancelled', 'refunded')),
  -- 付款來源三種：線上付款、免費比賽、現場付現或轉帳
  paid_source     TEXT CHECK (paid_source IN ('online', 'free', 'manual')),
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registrations_competition_idx ON registrations (competition_id, status);

CREATE TABLE IF NOT EXISTS payments (
  id                BIGSERIAL PRIMARY KEY,
  registration_id   BIGINT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('ecpay', 'newebpay', 'paypal', 'stripe')),
  provider_order_id TEXT NOT NULL,
  provider_txn_id   TEXT,
  amount_cents      BIGINT NOT NULL CHECK (amount_cents >= 0),
  currency          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'created'
                      CHECK (status IN ('created', 'paid', 'failed', 'refunded')),
  -- 這一筆送出去時帶了哪個夥伴 ID；沒帶就是 NULL，統計時分得出來
  partner_id_sent   TEXT,
  sandbox           BOOLEAN NOT NULL DEFAULT TRUE,
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at           TIMESTAMPTZ,
  UNIQUE (provider, provider_order_id)
);

CREATE TABLE IF NOT EXISTS competition_vouchers (
  id              BIGSERIAL PRIMARY KEY,
  competition_id  BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  -- 全球唯一、隨機、猜不到
  code            TEXT NOT NULL UNIQUE,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  entry_count     INTEGER NOT NULL DEFAULT 0,
  total_cents     BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS vouchers_active_idx
  ON competition_vouchers (competition_id) WHERE revoked_at IS NULL;

-- 憑證碼綁住的那一份結算名單
CREATE TABLE IF NOT EXISTS voucher_entries (
  id              BIGSERIAL PRIMARY KEY,
  voucher_id      BIGINT NOT NULL REFERENCES competition_vouchers(id) ON DELETE CASCADE,
  registration_id BIGINT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  division_id     BIGINT NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  athlete_name    TEXT NOT NULL,
  unit_name       TEXT,
  UNIQUE (voucher_id, registration_id)
);

-- 匿名統計回報的待送佇列（不含任何選手個資、不含金鑰）
CREATE TABLE IF NOT EXISTS usage_reports (
  id              BIGSERIAL PRIMARY KEY,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);

CREATE INDEX IF NOT EXISTS usage_reports_pending_idx ON usage_reports (created_at) WHERE sent_at IS NULL;
