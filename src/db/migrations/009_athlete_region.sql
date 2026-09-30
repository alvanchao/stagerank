-- 選手可以填「地區」（台灣顯示成縣市）與自己的「單位」。都是選填；沒填就留白，不影響報名。
-- Optional region (shown as county/city in Taiwan) and unit per athlete. Blank is fine.
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS unit_name TEXT;
