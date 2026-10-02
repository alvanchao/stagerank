-- StageRank 收集端（Cloudflare D1）。/ StageRank collector (Cloudflare D1).
-- 目前最新一份：每個 (網站, 比賽) 一列。 / Latest report: one row per (site, competition).
CREATE TABLE IF NOT EXISTS usage_received (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  site_url     TEXT NOT NULL CHECK (length(site_url) <= 200),
  id_hash      TEXT NOT NULL CHECK (length(id_hash) <= 32),
  payload      TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site_url, id_hash)
);
-- 每一份被接受的報告都另存一份，不覆蓋，被蓋掉時可以還原。
-- Every accepted report is also appended here and never overwritten, so a bad write can be undone.
CREATE TABLE IF NOT EXISTS usage_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  site_url     TEXT NOT NULL,
  id_hash      TEXT NOT NULL,
  payload      TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 網站金鑰：第一次回報的網站「認領」自己的網址，之後必須帶同一把。只存雜湊。
-- Site keys: the first report claims the URL; later reports must carry the same key. Only the hash is stored.
CREATE TABLE IF NOT EXISTS site_keys (
  site_url   TEXT PRIMARY KEY,
  key_hash   TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 限流計數。 / Rate-limit counters.
CREATE TABLE IF NOT EXISTS rate_limit (
  bucket       TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
