# StageRank collector (Cloudflare Worker + D1)

收集端：接收各站台的匿名統計。**這是可選的、由維護者自己部署的**；一般主辦不需要。
Optional, deployed by the maintainer. Organisers running their own StageRank do not need it.

> 以這個資料夾的程式為準。 / The code in this folder is the source of truth.

## 部署 / Deploy (summary)

1. 在 Cloudflare 建一個 D1 資料庫（名稱 `stagerank-usage`），把它的 id 填進 `wrangler.toml`。
   （D1 的 database_id 不是機密，但仍建議只提交範例值。 / The D1 database_id is not a secret, but commit only the placeholder anyway.）
2. 對它執行 `schema.sql`。
3. `npx wrangler deploy`，使用 workers.dev 預設網址（不掛在任何其他網域底下）。
4. 把網址填進 `telemetry.json` 的 `endpoint`。

## 網站怎麼被認領 / How a site is claimed

每個 StageRank 網站有一把隨機金鑰（至少 22 字元，由網站用密碼學隨機數產生）。第一次回報時：

1. 網址先整理成唯一寫法（只留「協定＋主機」）。
2. Worker 去讀 `<網站>/.well-known/stagerank-usage.json`，內容必須是 `{"key_hash":"<金鑰的 SHA-256 十六進位>"}`，與請求裡的金鑰相符才認領。只抓這一個路徑、3 秒逾時、不跟隨轉址、內容上限 2 KB。
3. 認領後，這個網址之後的回報都必須帶同一把金鑰；只存金鑰的雜湊。

所以別人無法搶先登記別人的網址，因為他放不出那個檔案。localhost、IP 位址、沒有點的主機名一律不收。

## 手動解除登記 / Manual un-claim

網站換了金鑰（例如重新安裝）會被 403。維護者在 D1 後台執行：

    DELETE FROM site_keys WHERE site_url = 'https://該網站';

之後該網站下次回報會重新驗證並認領。

## 防護 / Protections

- 內容大小：實際計算位元組，上限 20 KB，不相信 Content-Length。
- 限流（寫在程式裡）：每 IP 每分鐘、每網站每小時、全站每天，可用 `wrangler.toml` 的 `[vars]` 調整。限流表只存 IP 的雜湊，過期的列會在每次接受寫入時順手清掉。
- 比賽代號必須是 8 到 32 位十六進位字元，缺了就拒收。
- 不能倒退：同一場比賽的付款筆數、金額、帶夥伴代號的筆數都只增不減，正式付款不會被測試資料取代。
- 歷史：每份被接受的報告另存於 `usage_history`，不覆蓋。
- 資料庫暫時出錯回 503（不帶內部訊息），StageRank 端會每 6 小時重試。

## 已知限制 / Known limits

- 資料是各站自報，僅供參考；任何人可以架一個真的網站、放出驗證檔，再送假資料。
- 限流是「先讀後加」，不是原子的，同時大量請求可能略超過上限，當作大約值。
- 全站每日上限可以被很多 IP 加很多假網站耗盡，當天正常網站的回報會被 429 延後，不會遺失（會重試）。網域驗證會讓這件事的成本變高。
- 退款造成的數字減少會被拒收（寧可保守）。

## 測試 / Test

需要 Node 22.5 以上（測試用 `node:sqlite` 模擬 D1）。 / Needs Node 22.5+ (the tests use `node:sqlite` to stand in for D1).

    node --test --no-warnings collector-worker/test/worker.test.js
