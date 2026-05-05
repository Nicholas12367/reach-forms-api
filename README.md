# reach-forms-api

Form relay for the Reach Screens website. Receives contact-form POSTs from `reach.reachscreens.ca`, persists every submission to SQLite (system of record), then fans out to email + Slack + SMS so a single channel failure can't lose a lead.

## Architecture

```
Browser submit
   │
   ▼
[POST /submit]
   │
   ▼
1. INSERT into SQLite        ← submission is durable here
2. Respond 200 to browser    ← user sees success state immediately
3. In background, fan out:
     ├─ Resend email → info@reachscreens.ca   (with 3× retry)
     ├─ Resend confirmation email → customer
     ├─ Slack/Discord webhook                 (instant push)
     └─ Twilio SMS                            (instant push)
4. UPDATE submission with per-channel delivery status.
```

If every channel fails, the submission still sits in the DB and shows up red in `/admin`. Click `/admin/retry` to flush pending sends.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | `{ ok, hasResend, hasSlack, hasTwilio, submissions: { total, emailed, pending } }` |
| POST | `/submit` | none | Accepts the form JSON, returns `{ ok, id }` immediately |
| GET | `/admin` | HTTP basic | HTML table of recent submissions with delivery status |
| POST | `/admin/retry` | HTTP basic | Retries pending email sends (up to 50 at a time) |

## Environment variables

### Required

| Name | Notes |
|---|---|
| `RESEND_API_KEY` | https://resend.com/api-keys |
| `ADMIN_PASS` | Password for `/admin`. Disabled if unset. |

### Optional

| Name | Default | Notes |
|---|---|---|
| `RESEND_FROM` | `Reach Screens Site <noreply@reachscreens.ca>` | Sender address (must be on a verified domain in Resend) |
| `RESEND_TO` | `info@reachscreens.ca` | Where notification emails land |
| `SLACK_WEBHOOK_URL` | none | Slack/Discord/Mattermost webhook URL — second notification channel |
| `SMS_EMAIL` | none | Email-to-SMS carrier gateway. Set to e.g. `3065551234@txt.bell.ca` to get free SMS via your carrier — no Twilio account needed. Common Canadian gateways: Bell `@txt.bell.ca`, Rogers `@sms.rogers.com`, Telus/Koodo `@msg.telus.com`, Fido `@fido.ca`, Virgin `@vmobile.ca`, SaskTel `@sms.sasktel.com`, Freedom `@txt.freedommobile.ca`. |
| `TWILIO_ACCOUNT_SID` | none | https://www.twilio.com/console |
| `TWILIO_AUTH_TOKEN` | none | Paired with `SID` |
| `TWILIO_FROM` | none | E.164 phone number, e.g. `+13065551234` |
| `TWILIO_TO` | none | E.164 phone number to receive alerts |
| `ADMIN_USER` | `admin` | Username for `/admin` |
| `DB_PATH` | `/data/submissions.db` | SQLite file path. Coolify should mount `/data` as a persistent volume. |
| `PORT` | `3000` | Coolify sets this automatically |

## Coolify setup

1. Add `RESEND_API_KEY`, `ADMIN_PASS`, and `SLACK_WEBHOOK_URL` to the app's env vars.
2. Mount a persistent volume at `/data` so the SQLite file survives redeploys.
3. Re-deploy. Coolify auto-redeploys on push to `main`.

## DNS — domain authentication for deliverable email

If `info@reachscreens.ca` mail keeps landing in spam, add SPF/DKIM/DMARC records to the `reachscreens.ca` DNS zone. Resend has a one-click verifier in their dashboard that tells you the exact records to add.

## Local dev

```bash
npm install
RESEND_API_KEY=re_xxx ADMIN_PASS=hello DB_PATH=./submissions.db npm start
```
