# Going live checklist / 正式上線前必做清單

> **重要 / Important.** 測試站為了方便，會打開幾個「假裝」的開關。
> **正式比賽之前，這份清單一定要走完。** 否則別人只要知道某個信箱，就能冒充登入。
>
> A test site switches on a few "pretend" settings for convenience.
> **Work through this list before a real event.** Otherwise anyone who knows an email address can sign in as that person.

## 1. Turn the "pretend" switches off / 關掉「假裝」開關

| Variable | Test site | Live site | 說明 |
| --- | --- | --- | --- |
| `MAIL_MODE` | `pretend` | **delete it** (or leave empty) | 假裝寄信：6 位數驗證碼直接**顯示在畫面上**，知道信箱就能登入。 |
| `GOOGLE_LOGIN_MOCK` | `true` | **delete it** (or `false`) | 假 Google：輸入名單內的信箱就進後台，**沒有任何驗證**。 |
| `ALLOW_MOCK_IN_PRODUCTION` | `true` | **delete it** | 只是讓假 Google 能在 `NODE_ENV=production` 下運作的保險開關。 |

Both pretend modes print a warning in the server log at boot, and the pages say "test mode" on screen.
兩種假裝模式啟動時都會在伺服器日誌印出警告，畫面上也會標明「測試模式」。

## 2. Real email for entrants / 報名者要有真的寄信服務

Entrants sign in with a one-time 6-digit code that is **mailed to them**. Only the owner of the mailbox can read it — that is what makes knowing someone's email address useless to an attacker.
報名者用「寄到信箱的 6 位數驗證碼」登入。只有信箱主人看得到，知道別人信箱也沒用。

You need an SMTP service. A free tier is usually enough for a small event (for example **Resend**, Brevo, Mailgun, Amazon SES, or your own mail server).
需要一個 SMTP 寄信服務，小型比賽通常免費額度就夠（例如 **Resend**、Brevo、Mailgun、Amazon SES，或自己的郵件主機）。

Set these two variables on the host:

```
SMTP_URL=smtp://user:password@smtp.example.com:587
MAIL_FROM="StageRank <noreply@your-domain.example>"
```

- `MAIL_FROM` must be an address on a domain you have verified with the mail service (SPF / DKIM), or mail will land in spam or be refused.
- Keep both values in environment variables only. Never commit them.
- Once both are set, the pretend mail mode is unnecessary: the site mails the code and never shows it on screen.
- Codes are good for 10 minutes, work once, are void after 5 wrong tries, and one address can ask for one code per minute.

## 3. Real Google sign-in for the organiser / 主辦要用真的 Google 登入

Google only proves "you own this email". Every competition record stays in **your own** database; Google never receives any competition data.
Google 只證明「你是這個信箱的主人」，比賽資料都留在你自己的資料庫，不會傳給 Google。

1. In Google Cloud Console create a **new, separate project** (do not reuse a project that belongs to another app).
2. Create an OAuth client of type *Web application*. Add this redirect URI: `https://YOUR-SITE/admin/google/callback`.
3. Set on the host:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ADMIN_EMAILS=you@gmail.com,second-organiser@gmail.com
BASE_URL=https://YOUR-SITE
```

4. **`ADMIN_EMAILS` must be addresses you really own.** The test site uses a made-up address such as `fake_mail_admin@gmail.com`; if you switch real Google sign-in on while that is still listed, whoever owns that Gmail account can enter your back office.
5. Remove the pretend switches from section 1.

The organiser passcode (`ADMIN_TOKEN`) still works as a fallback. Leave it set so you can always get in, and **change it to a long random value** before a real event (the test value is not secret enough).
主辦通行碼 `ADMIN_TOKEN` 仍可當備用。正式比賽前請換成一組又長又隨機的值。

## 4. Other things to check before a real event / 其他正式比賽前要確認

- `ADMIN_TOKEN` changed to a long random value (see above) / 換掉主辦通行碼。
- `SESSION_SECRET` set to a fixed random value, so entrants are not signed out on every restart / 固定的隨機密鑰。
- `BASE_URL` is the real public address (used in payment callbacks and Google sign-in) / 填真實網址。
- Payment keys are the **live** ones, and sandbox is off (`ECPAY_SANDBOX`, `NEWEBPAY_SANDBOX`, PayPal / Stripe live keys) / 金流改正式金鑰、關掉沙盒。
- Delete test competitions and test entrant accounts that you do not want on the live site / 刪掉測試比賽與測試帳號。
- Your hosting plan still covers the event dates (a free trial can end) / 確認主機方案在比賽日期仍有效。
- The database has a backup you have actually tested restoring / 資料庫備份，而且試過還原。
- Competitors' real names and any minors' data are never published; results screens show only what you chose to publish / 真實姓名與未成年資料不外流。
