-- 改分歷史：評審在這一場結束前重新送出時，被覆蓋掉的舊分數留在這裡，事後查得到。
-- Score history: when a judge resubmits before the heat closes, the overwritten values are kept here for audit.
CREATE TABLE IF NOT EXISTS score_history (
  id              BIGSERIAL PRIMARY KEY,
  round_id        BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  dance_id        BIGINT NOT NULL REFERENCES dances(id) ON DELETE CASCADE,
  heat_id         BIGINT,
  judge_id        BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  round_entry_id  BIGINT NOT NULL REFERENCES round_entries(id) ON DELETE CASCADE,
  marked          BOOLEAN,
  points          NUMERIC(6, 2),
  rank_position   INTEGER,
  auto_collected  BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at    TIMESTAMPTZ NOT NULL,
  superseded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  change_kind     TEXT NOT NULL DEFAULT 'changed'  -- changed | removed
);
CREATE INDEX IF NOT EXISTS score_history_lookup ON score_history (round_id, judge_id, round_entry_id);
