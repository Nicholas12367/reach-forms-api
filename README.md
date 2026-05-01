# reach-forms-api

Tiny relay that takes contact-form POSTs from `reach.reachscreens.ca` and emails them to `info@reachscreens.ca` via Resend.

## Endpoints

- `GET /health` — returns `{ ok, hasKey }` for sanity-checking the deploy.
- `POST /submit` — accepts JSON body with the form fields and sends an email.

## Required env vars

- `RESEND_API_KEY` — from https://resend.com/api-keys
- `RESEND_FROM` (optional) — defaults to `Reach Screens Site <noreply@reachscreens.ca>`
- `RESEND_TO` (optional) — defaults to `info@reachscreens.ca`
- `PORT` (optional) — defaults to `3000`. Coolify sets this automatically.

## Local dev

```bash
npm install
RESEND_API_KEY=re_xxx npm start
```
