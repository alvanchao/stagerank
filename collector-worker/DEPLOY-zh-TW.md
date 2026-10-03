# 在 Cloudflare 建立收集端（董事長自己操作的步驟）

目標：建一個免費的 Worker（程式）加一個 D1（資料庫），不需要安裝任何東西，全部在 Cloudflare 網頁後台點選。
**整個過程不需要把任何密碼、金鑰或權杖交給任何人（包含我）。** 畫面文字可能和下面略有不同，找意思相近的選項即可。

> 先不要推 GitHub、也不要把 repo 改公開，等第 7 步完成之後再說。

## 1. 登入
用你自己的 Cloudflare 帳號登入（建議用 StageRank 自己的帳號或你個人帳號，不要放進 kokorotomo 的網域設定裡）。**不需要**動任何網域或 DNS。

## 2. 建資料庫（D1）
1. 左邊選單 → **Storage & databases**（儲存與資料庫）→ **D1 SQL database**。
2. 按 **Create database**，名稱填 `stagerank-usage`，其他保持預設，建立。
3. 進入這個資料庫 → **Console** 分頁。
4. 把資料夾裡 `schema.sql` 的內容整份貼進去，按執行（Execute）。成功後在 **Tables** 看得到 `usage_received`、`usage_history`、`site_keys`、`rate_limit` 四張表。

## 3. 建 Worker
1. 左邊選單 → **Workers & Pages** → **Create** → **Create Worker**。
2. 名稱填 `stagerank-usage`，按 **Deploy**（先用預設的 Hello World）。
3. 部署完按 **Edit code**，把編輯器裡原本的程式**全部刪掉**，貼上 `src/index.js` 的內容，按 **Deploy**。

## 4. 把資料庫接到 Worker
1. 進入這個 Worker → **Settings**（設定）→ **Bindings**（綁定）→ **Add** → **D1 database**。
2. **Variable name** 一定要填 `DB`（大寫），資料庫選 `stagerank-usage`，儲存。
3. 同一頁的 **Variables and secrets**：可以不加；要調整限流的話，新增文字變數 `LIMIT_IP_PER_MIN`（預設 30）、`LIMIT_SITE_PER_HOUR`（預設 20）、`LIMIT_GLOBAL_PER_DAY`（預設 5000）。
4. 儲存並重新部署。

## 5. 記下網址
Worker 的 **Settings → Domains & Routes** 會有一個 `workers.dev` 網址，格式像
`stagerank-usage.<你的帳號子網域>.workers.dev`。
**請把這個完整網址貼給我**（網址不是機密）。第一次用 workers.dev 時 Cloudflare 會要你取一個「帳號子網域」，這個名字就是 `<你的帳號子網域>`。

## 6. 自己測一下
在電腦上開終端機（或叫我用瀏覽器測）：

    curl -i https://stagerank-usage.<你的帳號子網域>.workers.dev/

預期看到 **405**（只收 POST）。再試：

    curl -i -X POST https://stagerank-usage.<你的帳號子網域>.workers.dev/ -d "{}"

預期看到 **400** 且內容是 `{"ok":false}`。兩個都對就表示 Worker 活著、資料庫也接好了（若看到 503，多半是第 4 步的 `DB` 沒綁好）。

## 7. 交給我
你把第 5 步的網址告訴我後，我會：
1. 把 `*.<你的帳號子網域>.workers.dev` 填進程式的 `allowedHosts`，把完整收集網址填進 `telemetry.json`；
2. 重跑全部測試，給 Tony 看差異；
3. 通過後，才輪到你推上 GitHub、再改成公開。

## 看資料
D1 → `stagerank-usage` → **Console**，貼上去執行：

正式付款的合計（不含測試）：

    SELECT json_extract(p.value,'$.provider') AS provider,
           json_extract(u.payload,'$.competition.currency') AS currency,
           SUM(json_extract(p.value,'$.count')) AS payments,
           SUM(json_extract(p.value,'$.total_cents')) AS amount,
           SUM(json_extract(p.value,'$.with_partner_id')) AS with_partner_id
    FROM usage_received u, json_each(u.payload,'$.payments') p
    WHERE json_extract(p.value,'$.sandbox') = 0
    GROUP BY 1, 2;

有正式付款的網站數與比賽數：

    SELECT COUNT(DISTINCT site_url) AS sites, COUNT(*) AS competitions
    FROM usage_received u
    WHERE EXISTS (SELECT 1 FROM json_each(u.payload,'$.payments') p
                  WHERE json_extract(p.value,'$.sandbox') = 0);

（TWD 的金額是原值，不要除以 100；其他幣別是最小單位。這些數字是各網站自報，僅供參考。）

## 解除某個網站的登記
網站重新安裝弄丟金鑰會被 403。你確認是對方本人之後，在 Console 執行（網址換成他的）：

    DELETE FROM site_keys WHERE site_url = 'https://對方的網站';

## 一些提醒
- 免費額度：Worker 每天 10 萬次請求、D1 每天 10 萬次寫入、5 GB 容量。每筆付款才寫一次，用不完。
- 之後要換成自己的網域也可以，但程式裡的 `allowedHosts` 要一起更新並發新版。
- 部署版本紀錄（2026-10-02）：後台貼上的是「去掉註解與縮排」的 `src/index.js`，功能相同。原檔 SHA-256：`6e1bc897e4096895028a65cff39284a13dba25fee4535a697761daced082bf43（含統計頁）`。之後更新請直接貼原檔，並把新的 SHA-256 記在這裡，日後才能比對有沒有被改過。
- 每網站每小時預設上限 20 筆；超過會暫時回 429，StageRank 會自動重試，資料不會遺失。要放寬可在 Worker 設定變數 `LIMIT_SITE_PER_HOUR`。

## 統計頁（只有你看得到）
打開 `https://stagerank-usage.<你的帳號>.workers.dev/stats`，瀏覽器會跳出登入框：使用者名稱隨便填，密碼填你設定的 `STATS_PASSWORD`。看得到網站數、比賽數、正式付款匯總與最近 10 筆回報。

設定方式：Worker → 設定 → 變數和祕密 → 新增，類型選「祕密 (Secret)」，名稱 `STATS_PASSWORD`，值用 32 字元以上的隨機字串（至少 16 字元，否則頁面不啟用）。沒設這個變數，`/stats` 就是 404。

連續輸錯 10 次，該 IP 5 分鐘內會被擋（429）。要換密碼就改這個變數的值。
