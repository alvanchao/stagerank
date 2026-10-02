-- 收集端：各站台送來的匿名統計（只有開啟 STAGERANK_COLLECTOR 的那一台伺服器會用到）。
-- Collector: anonymous reports received from other sites (only used on the server that turns STAGERANK_COLLECTOR on).
CREATE TABLE IF NOT EXISTS usage_received (
  id           BIGSERIAL PRIMARY KEY,
  site_url     TEXT NOT NULL,
  id_hash      TEXT NOT NULL,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_url, id_hash)
);
