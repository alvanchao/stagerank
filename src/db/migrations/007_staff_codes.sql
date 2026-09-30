-- 每場比賽各自的工作人員通行碼（主持人、點錄）。只存雜湊，明文只在產生當下顯示一次。
-- Per-competition staff passcodes (host, check-in). Only a hash is stored; the plain code is shown once.
CREATE TABLE IF NOT EXISTS competition_staff_codes (
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('host', 'checkin')),
  code_hash      TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id, role)
);
