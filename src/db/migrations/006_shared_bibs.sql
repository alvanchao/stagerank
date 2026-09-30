-- 背號改成「一個參賽單位整場一個號碼」：同一組人報多個組別，沿用同一個背號。
-- 所以同一份名單裡，同一個背號可以出現在不同組別，但同一個組別內仍然不能重複。
-- Bibs are now one number per entry unit for the whole competition: the same people entered in
-- several divisions keep the same bib. So one bib may appear in different divisions of a roster,
-- but never twice inside one division.
DROP INDEX IF EXISTS voucher_entries_bib_idx;
CREATE UNIQUE INDEX IF NOT EXISTS voucher_entries_bib_division_idx
  ON voucher_entries (voucher_id, division_id, bib_number) WHERE bib_number IS NOT NULL;
