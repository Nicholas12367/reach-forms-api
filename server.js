/* Reach Screens forms-api
 *
 * Receives form submissions and:
 *   1. Persists every submission to SQLite (system of record).
 *   2. Sends an email to info@reachscreens.ca via Resend.
 *   3. Posts a Slack/Discord webhook as a redundant notification channel.
 *   4. Optionally sends an SMS via Twilio.
 *   5. Sends a confirmation email to the customer.
 *   6. Retries the email channel on transient failures.
 *
 * A protected /admin page lists every submission with its delivery status.
 *
 * Environment variables (set via Coolify):
 *   RESEND_API_KEY              required  — transactional email provider
 *   RESEND_FROM                 optional  — default "Reach Screens Site <noreply@reachscreens.ca>"
 *   RESEND_TO                   optional  — default "info@reachscreens.ca"
 *   SLACK_WEBHOOK_URL           optional  — Slack/Discord/Telegram webhook for second channel
 *   TWILIO_ACCOUNT_SID          optional  — for SMS notifications
 *   TWILIO_AUTH_TOKEN           optional  — paired with SID
 *   TWILIO_FROM                 optional  — Twilio phone number (e.g. +14165550000)
 *   TWILIO_TO                   optional  — destination phone number for alerts
 *   ADMIN_USER                  optional  — default "admin"
 *   ADMIN_PASS                  required if /admin used; no default
 *   DB_PATH                     optional  — default "/data/submissions.db"
 *   PORT                        optional  — default 3000
 */
import express from 'express';
import { Resend } from 'resend';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false }));

// ---------- DB setup ------------------------------------------------------
const DB_PATH = process.env.DB_PATH || '/data/submissions.db';
try { mkdirSync(dirname(DB_PATH), { recursive: true }); } catch {}
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    type TEXT,
    name TEXT,
    business TEXT,
    email TEXT,
    phone TEXT,
    package TEXT,
    locations TEXT,
    venue TEXT,
    address TEXT,
    message TEXT,
    email_sent INTEGER DEFAULT 0,
    email_attempts INTEGER DEFAULT 0,
    email_last_error TEXT,
    slack_sent INTEGER DEFAULT 0,
    sms_sent INTEGER DEFAULT 0,
    confirmation_sent INTEGER DEFAULT 0
  );
`);

const insertStmt = db.prepare(`
  INSERT INTO submissions (type, name, business, email, phone, package, locations, venue, address, message)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateDeliveryStmt = db.prepare(`
  UPDATE submissions SET
    email_sent = ?, email_attempts = ?, email_last_error = ?,
    slack_sent = ?, sms_sent = ?, confirmation_sent = ?
  WHERE id = ?
`);

// ---------- CORS ----------------------------------------------------------
const ALLOWED_ORIGINS = new Set([
  'https://reach.reachscreens.ca',
  'https://reachscreens.ca',
  'https://www.reachscreens.ca',
  'http://localhost:8090',
  'http://localhost:3000',
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Health --------------------------------------------------------
app.get('/health', (_req, res) => {
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN email_sent = 1 THEN 1 ELSE 0 END) AS emailed,
      SUM(CASE WHEN email_sent = 0 THEN 1 ELSE 0 END) AS pending
    FROM submissions
  `).get();
  res.json({
    ok: true,
    hasResend: Boolean(process.env.RESEND_API_KEY),
    hasSlack: Boolean(process.env.SLACK_WEBHOOK_URL),
    hasTwilio: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    hasSmsEmail: Boolean(process.env.SMS_EMAIL),
    submissions: counts,
  });
});

// ---------- Helpers -------------------------------------------------------
const PRESENCE_LABEL = {
  // legacy package values (kept for backward compat with old submissions)
  'local-presence': 'Local Presence',
  'lloyd-network': 'Lloyd Network',
  'category-authority': 'Category Authority',
  'city-takeover': 'City Takeover',
  // new outcome values
  'event': 'Promote a one-time event or launch',
  'awareness': 'Build steady local awareness',
  'everywhere': 'Be everywhere your customers go',
  'exploring': 'Just exploring',
  'not-sure': 'Not sure yet',
};
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const clean = (s, max = 1000) => String(s || '').trim().slice(0, max);

function formatBody(row) {
  const presence = PRESENCE_LABEL[row.package] || row.package || '';
  const lines = [
    `Inquiry type: ${row.type === 'host' ? 'Wants to host a screen' : 'Wants to advertise'}`,
    ``,
    `Name: ${row.name}`,
    row.business && `Business: ${row.business}`,
    `Email: ${row.email}`,
    row.phone && `Phone: ${row.phone}`,
    presence && `Presence preference: ${presence}`,
    row.locations && `Selected location IDs: ${row.locations}`,
    row.venue && `Venue type: ${row.venue}`,
    row.address && `Business address: ${row.address}`,
    ``,
    `Message:`,
    row.message,
    ``,
    `— Submitted ${new Date().toISOString()} (id ${row.id})`,
  ].filter(Boolean);
  return lines.join('\n');
}

async function sendEmailWithRetry(row, maxAttempts = 3) {
  if (!process.env.RESEND_API_KEY) {
    return { ok: false, error: 'RESEND_API_KEY not set', attempts: 0 };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromAddr = process.env.RESEND_FROM || 'Reach Screens Site <noreply@reachscreens.ca>';
  const toAddr = process.env.RESEND_TO || 'info@reachscreens.ca';
  const presence = PRESENCE_LABEL[row.package] || row.package || '';
  const subject = row.type === 'host'
    ? `[Reach Screens] Host inquiry from ${row.name}`
    : `[Reach Screens] Advertiser inquiry from ${row.name}${presence ? ` — ${presence}` : ''}`;
  const text = formatBody(row);

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await resend.emails.send({
        from: fromAddr,
        to: toAddr,
        replyTo: row.email,
        subject,
        text,
      });
      if (result.error) {
        lastError = JSON.stringify(result.error);
      } else {
        return { ok: true, attempts: attempt };
      }
    } catch (err) {
      lastError = String(err?.message || err);
    }
    if (attempt < maxAttempts) {
      const backoffMs = attempt * 30_000; // 30s, 60s, 90s
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  return { ok: false, error: lastError, attempts: maxAttempts };
}

async function sendConfirmation(row) {
  if (!process.env.RESEND_API_KEY) return false;
  if (!isEmail(row.email)) return false;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromAddr = process.env.RESEND_FROM || 'Reach Screens <noreply@reachscreens.ca>';
  try {
    const result = await resend.emails.send({
      from: fromAddr,
      to: row.email,
      subject: 'We got your idea — Reach Screens',
      text:
`Hi ${row.name.split(' ')[0] || row.name},

Thanks for reaching out to Reach Screens. We've received your idea and one of us will be in touch within 48 hours with a plan and a price tailored to what you want to promote.

Your message:
${row.message}

If anything urgent, just reply to this email or call (306) 514-3752.

— The Reach Screens team
`,
    });
    return !result.error;
  } catch {
    return false;
  }
}

async function sendSlack(row) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  const presence = PRESENCE_LABEL[row.package] || row.package || '';
  const headline = row.type === 'host'
    ? `🏠 New host inquiry — ${row.name}`
    : `💡 New advertiser inquiry — ${row.name}${presence ? ` (${presence})` : ''}`;
  const payload = {
    text: headline,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: headline } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Email:*\n${row.email}` },
          row.business && { type: 'mrkdwn', text: `*Business:*\n${row.business}` },
          row.phone && { type: 'mrkdwn', text: `*Phone:*\n${row.phone}` },
          presence && { type: 'mrkdwn', text: `*Presence:*\n${presence}` },
        ].filter(Boolean),
      },
      { type: 'section', text: { type: 'mrkdwn', text: `*Idea / Message:*\n${row.message.slice(0, 1500)}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `id ${row.id} · ${new Date().toISOString()}` }] },
    ],
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function sendSms(row) {
  const presence = PRESENCE_LABEL[row.package] || row.package || '';
  const body = `Reach Screens: ${row.type === 'host' ? 'host' : 'ad'} inquiry from ${row.name} (${row.email})${presence ? ` — ${presence}` : ''}`;
  const text = body.slice(0, 320);

  // Path 1: SMS via carrier email gateway (no Twilio needed).
  // Set SMS_EMAIL to e.g. "3065551234@txt.bell.ca" — Resend sends a tiny
  // email there, the carrier gateway converts it to SMS. Free.
  if (process.env.SMS_EMAIL && process.env.RESEND_API_KEY) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const fromAddr = process.env.RESEND_FROM || 'Reach Screens <noreply@reachscreens.ca>';
      const result = await resend.emails.send({
        from: fromAddr,
        to: process.env.SMS_EMAIL,
        subject: 'Reach Screens',  // many gateways prepend subject; keep it short
        text,
      });
      if (!result.error) return true;
    } catch {}
  }

  // Path 2: Twilio SMS API (real SMS, costs ~1¢/msg).
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const to = process.env.TWILIO_TO;
  if (sid && token && from && to) {
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: from, To: to, Body: text }).toString(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  return false;
}

// ---------- /submit -------------------------------------------------------
app.post('/submit', async (req, res) => {
  try {
    const body = req.body || {};
    if (clean(body._hp)) return res.json({ ok: true }); // honeypot trap

    const data = {
      type: body.type === 'host' ? 'host' : 'advertise',
      name: clean(body.name, 200),
      business: clean(body.business, 200),
      email: clean(body.email, 200),
      phone: clean(body.phone, 60),
      package: clean(body.package, 60),
      locations: clean(body.locations, 500),
      venue: clean(body.venue, 200),
      address: clean(body.address, 300),
      message: clean(body.message, 5000),
    };

    if (!data.name || !isEmail(data.email) || !data.message) {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required fields' });
    }

    // STEP 1: persist immediately. Submission is now durable.
    const info = insertStmt.run(
      data.type, data.name, data.business, data.email, data.phone,
      data.package, data.locations, data.venue, data.address, data.message,
    );
    const row = { id: info.lastInsertRowid, ...data };

    // STEP 2: respond to client right away (don't make them wait on email).
    res.json({ ok: true, id: row.id });

    // STEP 3: deliver via every channel in parallel, in the background.
    const [emailRes, slackRes, smsRes, confirmRes] = await Promise.allSettled([
      sendEmailWithRetry(row),
      sendSlack(row),
      sendSms(row),
      sendConfirmation(row),
    ]);

    const emailOk = emailRes.status === 'fulfilled' && emailRes.value.ok;
    const emailAttempts = emailRes.status === 'fulfilled' ? (emailRes.value.attempts || 0) : 0;
    const emailErr = emailRes.status === 'fulfilled' ? (emailRes.value.error || null) : String(emailRes.reason || '');
    const slackOk = slackRes.status === 'fulfilled' && slackRes.value === true;
    const smsOk = smsRes.status === 'fulfilled' && smsRes.value === true;
    const confirmOk = confirmRes.status === 'fulfilled' && confirmRes.value === true;

    updateDeliveryStmt.run(
      emailOk ? 1 : 0, emailAttempts, emailErr,
      slackOk ? 1 : 0,
      smsOk ? 1 : 0,
      confirmOk ? 1 : 0,
      row.id,
    );

    if (!emailOk && !slackOk && !smsOk) {
      console.error(`[id ${row.id}] ALL CHANNELS FAILED for ${row.email}`);
    }
  } catch (err) {
    console.error('Submit error:', err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'Internal error' });
    }
  }
});

// ---------- /admin (protected) -------------------------------------------
function basicAuth(req, res, next) {
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS;
  if (!adminPass) {
    return res.status(503).send('Admin disabled — set ADMIN_PASS env var to enable.');
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Reach Screens Admin"');
    return res.status(401).send('Authentication required.');
  }
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  if (user !== adminUser || pass !== adminPass) {
    res.set('WWW-Authenticate', 'Basic realm="Reach Screens Admin"');
    return res.status(401).send('Invalid credentials.');
  }
  next();
}

app.get('/admin', basicAuth, (_req, res) => {
  const rows = db.prepare(`
    SELECT * FROM submissions ORDER BY id DESC LIMIT 200
  `).all();
  const fmt = (n) => n ? '✓' : '·';
  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>Reach Screens Submissions</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a1628; color: #e6ecf5; margin: 0; padding: 24px; }
  h1 { margin: 0 0 16px; font-size: 22px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.1); vertical-align: top; }
  th { background: rgba(255,255,255,0.05); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; font-size: 11px; }
  tr:hover { background: rgba(92,224,210,0.05); }
  .ok { color: #5CE0D2; }
  .fail { color: #ff6b6b; }
  .muted { color: #6b7890; }
  details { margin: 0; }
  summary { cursor: pointer; }
  pre { white-space: pre-wrap; background: rgba(255,255,255,0.04); padding: 8px; border-radius: 6px; font-size: 12px; max-width: 500px; }
</style>
</head><body>
<h1>Reach Screens — Submissions <span class="muted">(${rows.length})</span></h1>
<table>
<thead><tr>
<th>ID</th><th>When</th><th>Type</th><th>Name</th><th>Business</th><th>Contact</th>
<th>Presence</th><th>Idea</th><th>Em</th><th>Sl</th><th>SMS</th><th>Cf</th>
</tr></thead><tbody>
${rows.map(r => `
<tr>
  <td>${r.id}</td>
  <td class="muted">${r.created_at}</td>
  <td>${r.type}</td>
  <td>${escape(r.name || '')}</td>
  <td>${escape(r.business || '')}</td>
  <td>${escape(r.email || '')}<br><span class="muted">${escape(r.phone || '')}</span></td>
  <td>${escape(PRESENCE_LABEL[r.package] || r.package || '')}</td>
  <td><details><summary>${escape((r.message || '').slice(0, 60))}${(r.message || '').length > 60 ? '…' : ''}</summary><pre>${escape(r.message || '')}</pre></details></td>
  <td class="${r.email_sent ? 'ok' : 'fail'}" title="${escape(r.email_last_error || '')}">${fmt(r.email_sent)}${r.email_attempts > 1 ? ` (${r.email_attempts})` : ''}</td>
  <td class="${r.slack_sent ? 'ok' : 'muted'}">${fmt(r.slack_sent)}</td>
  <td class="${r.sms_sent ? 'ok' : 'muted'}">${fmt(r.sms_sent)}</td>
  <td class="${r.confirmation_sent ? 'ok' : 'muted'}">${fmt(r.confirmation_sent)}</td>
</tr>`).join('')}
</tbody></table>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- /admin/retry (protected) — retry pending email sends ---------
app.post('/admin/retry', basicAuth, async (_req, res) => {
  const pending = db.prepare(`SELECT * FROM submissions WHERE email_sent = 0 ORDER BY id DESC LIMIT 50`).all();
  let fixed = 0;
  for (const row of pending) {
    const result = await sendEmailWithRetry(row, 1);
    if (result.ok) {
      db.prepare(`UPDATE submissions SET email_sent = 1, email_attempts = email_attempts + 1, email_last_error = NULL WHERE id = ?`).run(row.id);
      fixed++;
    } else {
      db.prepare(`UPDATE submissions SET email_attempts = email_attempts + 1, email_last_error = ? WHERE id = ?`).run(result.error, row.id);
    }
  }
  res.json({ ok: true, retried: pending.length, fixed });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`forms-api listening on :${PORT} (db: ${DB_PATH})`);
});
