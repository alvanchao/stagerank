-- 計價群組：基本盤加上加報項目。
-- Fee groups: a base package plus extra items.

-- 國標舞常見的收法是「基本費含幾項，之後每加一項多少錢」，而不是每一組各一個價。
-- 師生組近年流行，而且不能跟一般組別合起來算，所以項數要分群各自數。
-- The usual ballroom scheme is "a base fee covering N items, then so much per extra item",
-- not a price per division. Pro-am divisions have become common and must not be counted
-- together with the ordinary ones, so each group counts its own items.
CREATE TABLE IF NOT EXISTS fee_groups (
  id              BIGSERIAL PRIMARY KEY,
  competition_id  BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- 基本費，以及它含了幾項。含 1 項就是最常見的「第一項多少、之後每項多少」。
  -- The base fee and how many items it covers. Covering 1 is the common
  -- "so much for the first, so much for each after that".
  base_fee_cents  BIGINT NOT NULL DEFAULT 0,
  base_includes   INTEGER NOT NULL DEFAULT 1,
  extra_item_fee_cents BIGINT NOT NULL DEFAULT 0,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fee_groups_competition_idx ON fee_groups (competition_id, sort_order, id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fee_groups_base_includes_check') THEN
    ALTER TABLE fee_groups ADD CONSTRAINT fee_groups_base_includes_check
      CHECK (base_includes >= 1 AND base_includes <= 50);
  END IF;
END $$;

-- 組別屬於哪一群。留空＝不吃階梯規則，照舊用整組收或每人收。
-- Which group a division belongs to. Blank means it ignores the tiered rule and keeps
-- charging per entry or per person as before.
ALTER TABLE divisions ADD COLUMN IF NOT EXISTS fee_group_id BIGINT REFERENCES fee_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS divisions_fee_group_idx ON divisions (fee_group_id);

-- 收費方式多一個 tiered：吃所屬群組的基本盤＋加項規則。
-- A third fee mode, tiered: it follows its group's base-plus-extras rule.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'divisions_fee_mode_check') THEN
    ALTER TABLE divisions DROP CONSTRAINT divisions_fee_mode_check;
  END IF;
  ALTER TABLE divisions ADD CONSTRAINT divisions_fee_mode_check
    CHECK (fee_mode IN ('per_entry', 'per_person', 'tiered'));
END $$;

-- 這一筆報名，每位成員各自是第幾項、收了多少，記下來才查得出帳，
-- 也才解釋得了「為什麼這筆比上一筆便宜」。
-- Which item number each member was on and what they were charged. Without this the books
-- cannot be checked, and nobody can explain why one entry cost less than the last.
ALTER TABLE registration_members ADD COLUMN IF NOT EXISTS item_index INTEGER;
ALTER TABLE registration_members ADD COLUMN IF NOT EXISTS item_fee_cents BIGINT;
