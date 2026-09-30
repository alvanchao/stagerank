-- 報到人員也有自己每場獨立的通行碼。
-- The registration desk gets its own per-competition passcode too.
ALTER TABLE competition_staff_codes DROP CONSTRAINT IF EXISTS competition_staff_codes_role_check;
ALTER TABLE competition_staff_codes
  ADD CONSTRAINT competition_staff_codes_role_check CHECK (role IN ('host', 'checkin', 'desk'));
