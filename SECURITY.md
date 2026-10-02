# Security policy / 資安通報

## 中文

如果你發現 StageRank 的安全漏洞（例如可以繞過登入、看到別人的資料、偽造付款結果），請**不要**公開發 Issue。

請到本專案 GitHub 頁面的 **Security → Report a vulnerability**（私下通報）回報，並附上重現步驟。
我們會盡快回覆，修好後再公開說明。

回報時請不要附上真實的選手姓名、金鑰或密碼。

## English

If you find a security vulnerability in StageRank (for example a login bypass, access to another person's data, or forged payment results), please **do not** open a public issue.

Use **Security → Report a vulnerability** on this repository's GitHub page (private reporting) and include steps to reproduce.
We will reply as soon as we can and disclose after a fix is available.

Please do not include real athlete names, keys or passwords in your report.

## Scope / 範圍

StageRank is self-hosted: each organiser runs their own copy. Keep `ADMIN_TOKEN`, payment keys and `SESSION_SECRET` in environment variables only, and follow `docs/GOING-LIVE.md` before taking real payments.
