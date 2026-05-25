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
    confirmation_sent INTEGER DEFAULT 0,
    hubspot_synced INTEGER DEFAULT 0,
    hubspot_contact_id TEXT
  );
`);
// Lightweight migrations for older deployments that already have the table:
try { db.exec(`ALTER TABLE submissions ADD COLUMN hubspot_synced INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE submissions ADD COLUMN hubspot_contact_id TEXT`); } catch {}

// ---------- Analytics events table (reachscreens.ca only) ----------------
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT CURRENT_TIMESTAMP,
    session_id TEXT,
    event_type TEXT,
    path TEXT,
    referrer TEXT,
    label TEXT,
    value REAL,
    ip_hash TEXT,
    device TEXT
  );
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(event_type, ts)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)`); } catch {}
const insertEventStmt = db.prepare(`
  INSERT INTO events (session_id, event_type, path, referrer, label, value, ip_hash, device)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const KNOWN_EVENT_TYPES = new Set([
  'pageview', 'click', 'scroll_depth', 'section_dwell',
  'form_view', 'form_submit', 'outbound_click',
]);

// Only collect analytics from the live Reach Screens site. Other client
// sites on the same forms-api are intentionally NOT in this set.
const TRACK_ORIGINS = new Set([
  'https://reachscreens.ca',
  'https://www.reachscreens.ca',
  'https://reach.reachscreens.ca',
]);

function hashIp(raw) {
  if (!raw) return null;
  const ip = String(raw).split(',')[0].trim();
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::/48';
  const p = ip.split('.');
  return p.length === 4 ? p.slice(0, 3).join('.') + '.0/24' : ip;
}
function deviceFromUA(ua) {
  if (!ua) return 'unknown';
  const s = String(ua).toLowerCase();
  if (/ipad|tablet/.test(s)) return 'tablet';
  if (/mobile|iphone|android/.test(s)) return 'mobile';
  return 'desktop';
}
function clientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
}

// Tiny in-memory rate limiter: 60 events/min/IP. Resets every 60s.
const rlBuckets = new Map();
setInterval(() => rlBuckets.clear(), 60000).unref?.();
function rateLimitOk(ip) {
  const count = (rlBuckets.get(ip) || 0) + 1;
  rlBuckets.set(ip, count);
  return count <= 60;
}

const insertStmt = db.prepare(`
  INSERT INTO submissions (type, name, business, email, phone, package, locations, venue, address, message)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateDeliveryStmt = db.prepare(`
  UPDATE submissions SET
    email_sent = ?, email_attempts = ?, email_last_error = ?,
    slack_sent = ?, sms_sent = ?, confirmation_sent = ?,
    hubspot_synced = ?, hubspot_contact_id = ?
  WHERE id = ?
`);

// ---------- CORS ----------------------------------------------------------
const ALLOWED_ORIGINS = new Set([
  'https://reach.reachscreens.ca',
  'https://reachscreens.ca',
  'https://www.reachscreens.ca',
  'https://reach2.reachscreens.ca',
  'http://localhost:8090',
  'http://localhost:3000',
  'http://localhost:8091',
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
      SUM(CASE WHEN email_sent = 0 THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN hubspot_synced = 1 THEN 1 ELSE 0 END) AS hubspot_synced,
      SUM(CASE WHEN hubspot_synced = 0 THEN 1 ELSE 0 END) AS hubspot_pending
    FROM submissions
  `).get();
  res.json({
    ok: true,
    hasResend: Boolean(process.env.RESEND_API_KEY),
    hasSlack: Boolean(process.env.SLACK_WEBHOOK_URL),
    hasTwilio: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    hasSmsEmail: Boolean(process.env.SMS_EMAIL),
    hasHubspot: Boolean(process.env.HUBSPOT_PRIVATE_APP_TOKEN),
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

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function confirmationHtml(row) {
  const firstName = (row.name || '').split(' ')[0] || row.name || 'there';
  const safeName = htmlEscape(firstName);
  const safeMessage = htmlEscape(row.message || '').replace(/\n/g, '<br>');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>We got your idea — Reach Screens</title></head>
<body style="margin:0; padding:0; background-color:#f4f6f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color:#1a2c4a; -webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f6f9; padding: 32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow: 0 2px 8px rgba(10,22,40,0.06);">
      <tr>
        <td style="background-color:#ffffff; padding: 32px 32px 24px; text-align:left; border-bottom: 1px solid #e6ecf5;">
          <img src="https://reachscreens.ca/assets/logos/reach-screens-watermark.png" alt="Reach Screens" width="220" style="display:block; max-width:220px; width:220px; height:auto; border:0; outline:none; text-decoration:none;">
          <h1 style="margin: 22px 0 0 0; font-size: 26px; line-height:1.2; font-weight:700; color:#0A1628; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">
            We got your idea.
          </h1>
        </td>
      </tr>
      <tr>
        <td style="padding: 32px;">
          <p style="margin: 0 0 18px 0; font-size: 16px; line-height:1.55; color: #1a2c4a;">Hi ${safeName},</p>
          <p style="margin: 0 0 18px 0; font-size: 16px; line-height:1.55; color: #1a2c4a;">
            Thanks for reaching out. One of us will be in touch within <strong>48 hours</strong> with a plan and a price tailored to what you want to promote.
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
            <tr><td style="background-color: #f4f8fb; border-left: 3px solid #5CE0D2; padding: 16px 20px; border-radius: 6px;">
              <div style="font-size: 11px; letter-spacing: 0.1em; text-transform:uppercase; color: #6b7890; font-weight:600; margin-bottom: 6px;">Your idea</div>
              <div style="font-size: 15px; line-height: 1.55; color: #1a2c4a;">${safeMessage}</div>
            </td></tr>
          </table>
          <p style="margin: 0 0 18px 0; font-size: 16px; line-height:1.55; color: #1a2c4a;">
            If anything's urgent, just reply to this email or give us a call at <a href="tel:3065143752" style="color:#0e7c70; font-weight:600; text-decoration:none;">306-514-3752</a>.
          </p>
          <p style="margin: 0; font-size: 16px; line-height:1.55; color: #1a2c4a;">— The Reach Screens team</p>
        </td>
      </tr>
      <tr>
        <td style="background-color: #0E1D33; padding: 28px 32px; color: #9BA8BF;">
          <div style="font-size: 16px; font-weight: 700; color:#ffffff; margin-bottom: 6px;">Reach Screens</div>
          <div style="margin-bottom: 14px; font-size: 13px; color:#9BA8BF;">Local digital advertising in Lloydminster, AB</div>
          <div style="margin-bottom: 4px; font-size:14px;"><a href="tel:3065143752" style="color: #5CE0D2; text-decoration: none;">306-514-3752</a></div>
          <div style="margin-bottom: 4px; font-size:14px;"><a href="mailto:info@reachscreens.ca" style="color: #5CE0D2; text-decoration: none;">info@reachscreens.ca</a></div>
          <div style="margin-bottom: 4px; font-size:14px;"><a href="https://reachscreens.ca" style="color: #5CE0D2; text-decoration: none;">reachscreens.ca</a></div>
          <div style="margin-bottom: 14px; font-size: 13px; color:#6b7890;">P.O. Box 11238<br>Lloydminster, AB T9V 3B5</div>
          <div style="font-size: 11px; color: #6b7890; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.08);">© 2026 Reach Screens. You're receiving this because you submitted an idea on reachscreens.ca.</div>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendConfirmation(row) {
  if (!process.env.RESEND_API_KEY) return false;
  if (!isEmail(row.email)) return false;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromAddr = process.env.RESEND_CONFIRM_FROM || 'Reach Screens <hello@reachscreens.ca>';
  const replyTo = process.env.RESEND_TO || 'info@reachscreens.ca';
  const firstName = (row.name || '').split(' ')[0] || row.name || 'there';
  const text =
`Hi ${firstName},

Thanks for reaching out to Reach Screens. We've received your idea and one of us will be in touch within 48 hours with a plan and a price tailored to what you want to promote.

Your idea:
${row.message}

If anything's urgent, just reply to this email or call 306-514-3752.

— The Reach Screens team

—
Reach Screens — Local digital advertising in Lloydminster, AB
306-514-3752 · info@reachscreens.ca · reachscreens.ca
P.O. Box 11238, Lloydminster, AB T9V 3B5
`;
  try {
    const result = await resend.emails.send({
      from: fromAddr,
      to: row.email,
      replyTo,
      subject: 'We got your idea — Reach Screens',
      text,
      html: confirmationHtml(row),
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

// ---------- HubSpot real-time contact sync --------------------------------
async function sendHubspot(row) {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) return { ok: false, contactId: null, error: 'no token' };

  const presence = PRESENCE_LABEL[row.package] || row.package || '';
  const nameParts = (row.name || '').trim().split(/\s+/);
  const firstname = nameParts[0] || '';
  const lastname = nameParts.slice(1).join(' ') || '';

  // Step 1: Upsert contact by email — creates new or updates existing.
  const contactProps = { email: row.email };
  if (firstname) contactProps.firstname = firstname;
  if (lastname) contactProps.lastname = lastname;
  if (row.phone) contactProps.phone = row.phone;
  if (row.business) contactProps.company = row.business;

  let contactId = null;
  try {
    const upsertRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: [{ idProperty: 'email', id: row.email, properties: contactProps }],
      }),
    });
    if (!upsertRes.ok) {
      const errBody = await upsertRes.text();
      return { ok: false, contactId: null, error: `upsert ${upsertRes.status}: ${errBody.slice(0, 200)}` };
    }
    const upsertJson = await upsertRes.json();
    contactId = upsertJson.results?.[0]?.id || null;
    if (!contactId) return { ok: false, contactId: null, error: 'upsert returned no contact id' };
  } catch (err) {
    return { ok: false, contactId: null, error: `upsert exception: ${err?.message || err}` };
  }

  // Step 2: Attach a Note engagement with the full message + metadata, so
  // every submission shows up in the contact's HubSpot timeline.
  // Failure here is non-fatal — the contact itself is the primary win.
  try {
    const lines = [
      `<p><strong>Inquiry type:</strong> ${row.type === 'host' ? 'Wants to host a screen' : 'Wants to advertise'}</p>`,
    ];
    if (presence) lines.push(`<p><strong>Presence preference:</strong> ${htmlEscape(presence)}</p>`);
    if (row.locations) lines.push(`<p><strong>Selected location IDs:</strong> ${htmlEscape(row.locations)}</p>`);
    if (row.venue) lines.push(`<p><strong>Venue type:</strong> ${htmlEscape(row.venue)}</p>`);
    if (row.address) lines.push(`<p><strong>Business address:</strong> ${htmlEscape(row.address)}</p>`);
    lines.push(`<p><strong>Idea / Message:</strong></p>`);
    lines.push(`<p>${htmlEscape(row.message || '').replace(/\n/g, '<br>')}</p>`);
    lines.push(`<hr><p><em>Submitted via reachscreens.ca contact form (id ${row.id})</em></p>`);

    await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: {
          hs_note_body: lines.join(''),
          hs_timestamp: new Date().toISOString(),
        },
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
        }],
      }),
    });
  } catch {}

  return { ok: true, contactId, error: null };
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
    const [emailRes, slackRes, smsRes, confirmRes, hubspotRes] = await Promise.allSettled([
      sendEmailWithRetry(row),
      sendSlack(row),
      sendSms(row),
      sendConfirmation(row),
      sendHubspot(row),
    ]);

    const emailOk = emailRes.status === 'fulfilled' && emailRes.value.ok;
    const emailAttempts = emailRes.status === 'fulfilled' ? (emailRes.value.attempts || 0) : 0;
    const emailErr = emailRes.status === 'fulfilled' ? (emailRes.value.error || null) : String(emailRes.reason || '');
    const slackOk = slackRes.status === 'fulfilled' && slackRes.value === true;
    const smsOk = smsRes.status === 'fulfilled' && smsRes.value === true;
    const confirmOk = confirmRes.status === 'fulfilled' && confirmRes.value === true;
    const hubspotOk = hubspotRes.status === 'fulfilled' && hubspotRes.value?.ok === true;
    const hubspotContactId = hubspotRes.status === 'fulfilled' ? (hubspotRes.value?.contactId || null) : null;
    if (hubspotRes.status === 'fulfilled' && !hubspotOk && hubspotRes.value?.error) {
      console.error(`[id ${row.id}] HubSpot sync failed: ${hubspotRes.value.error}`);
    }

    updateDeliveryStmt.run(
      emailOk ? 1 : 0, emailAttempts, emailErr,
      slackOk ? 1 : 0,
      smsOk ? 1 : 0,
      confirmOk ? 1 : 0,
      hubspotOk ? 1 : 0, hubspotContactId,
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

// ---------- /track --------------------------------------------------------
// Accepts batched events {events:[...]} from rs-analytics.js on reachscreens.ca.
// Strict origin allowlist + per-IP rate limit so a client bug can't melt the box.
app.post('/track', (req, res) => {
  try {
    const origin = req.headers.origin || '';
    if (!TRACK_ORIGINS.has(origin)) {
      // Silent drop so a misbehaving client doesn't retry forever.
      return res.json({ ok: true, recorded: 0, scope: 'out-of-scope' });
    }
    const ip = hashIp(clientIp(req));
    if (!rateLimitOk(ip || 'unknown')) {
      return res.json({ ok: true, recorded: 0, scope: 'rate-limited' });
    }
    const body = req.body || {};
    const events = Array.isArray(body.events) ? body.events
                   : Array.isArray(body) ? body
                   : [body];
    if (events.length > 30) events.length = 30; // hard cap per request

    const ua = String(req.headers['user-agent'] || '').slice(0, 400);
    const device = deviceFromUA(ua);
    let recorded = 0;
    for (const ev of events) {
      if (!ev || !KNOWN_EVENT_TYPES.has(ev.type)) continue;
      try {
        insertEventStmt.run(
          String(ev.sid || '').slice(0, 64) || null,
          ev.type,
          String(ev.path || '').slice(0, 200) || null,
          String(ev.ref || '').slice(0, 200) || null,
          String(ev.label || '').slice(0, 160) || null,
          Number.isFinite(ev.value) ? ev.value : null,
          ip,
          device,
        );
        recorded++;
      } catch (insertErr) {
        // Don't let one bad row kill the whole batch.
        console.error('Event insert failed:', insertErr.message);
      }
    }
    res.json({ ok: true, recorded });
  } catch (err) {
    console.error('Track handler error:', err);
    if (!res.headersSent) res.status(500).json({ ok: false });
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

// ---------- Admin shell --------------------------------------------------
const NAV_LINKS = [
  { href: '/admin',             label: 'Overview' },
  { href: '/admin/submissions', label: 'Submissions' },
  { href: '/admin/analytics',   label: 'Analytics' },
  { href: '/admin/sessions',    label: 'Sessions' },
];
const RANGES = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
function rangeFromQuery(q) {
  const key = (q && typeof q.range === 'string' && RANGES[q.range]) ? q.range : '7d';
  return { key, days: RANGES[key] };
}
function rangeBar(active) {
  return `<div class="range-bar">${Object.keys(RANGES).map(k =>
    `<a class="${k === active ? 'active' : ''}" href="?range=${k}">${k}</a>`).join('')}</div>`;
}

function adminShell(active, title, body) {
  const navHtml = NAV_LINKS.map(l =>
    `<a class="nav-link${l.href === active ? ' active' : ''}" href="${l.href}">${l.label}</a>`
  ).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — Reach Screens Admin</title>
<style>
  :root { --bg:#0a1628; --panel:#0e1d33; --panel-2:#122545; --line:rgba(255,255,255,0.08);
          --text:#e6ecf5; --muted:#8ea0bd; --dim:#6b7890; --cyan:#5CE0D2; --red:#E11D2C;
          --ok:#5CE0D2; --fail:#ff6b6b; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .shell { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
  aside { background: var(--panel); border-right: 1px solid var(--line); padding: 22px 14px; position: sticky; top: 0; height: 100vh; align-self: start; }
  aside h2 { font-size: 13px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--cyan); margin: 0 0 18px 8px; }
  .nav-link { display: block; padding: 10px 12px; border-radius: 8px; color: var(--muted); text-decoration: none; font-size: 14px; margin-bottom: 2px; }
  .nav-link:hover { background: rgba(255,255,255,0.04); color: var(--text); }
  .nav-link.active { background: var(--red); color: #fff; font-weight: 600; }
  main { padding: 28px 32px 56px; max-width: 1280px; }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; }
  .subtitle { color: var(--muted); margin: 0 0 24px; font-size: 13px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 28px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .card-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.12em; margin: 0 0 6px; }
  .card-value { font-size: 28px; font-weight: 600; margin: 0; }
  .card-sub { font-size: 12px; color: var(--dim); margin-top: 6px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  .panel h3 { margin: 0 0 14px; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  .grid-2 { display: grid; grid-template-columns: 1.4fr 1fr; gap: 18px; }
  @media (max-width: 980px) { .grid-2 { grid-template-columns: 1fr; } .shell { grid-template-columns: 1fr; } aside { position: static; height: auto; } }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { background: rgba(255,255,255,0.03); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; font-size: 10.5px; color: var(--muted); }
  tr:hover td { background: rgba(92,224,210,0.04); }
  .ok { color: var(--ok); } .fail { color: var(--fail); } .muted { color: var(--muted); } .dim { color: var(--dim); }
  details summary { cursor: pointer; }
  pre { white-space: pre-wrap; background: rgba(255,255,255,0.04); padding: 8px 10px; border-radius: 6px; font-size: 12px; max-width: 520px; }
  .range-bar { display: inline-flex; gap: 2px; background: var(--panel-2); padding: 3px; border-radius: 999px; margin-bottom: 16px; }
  .range-bar a { padding: 6px 14px; font-size: 12px; color: var(--muted); text-decoration: none; border-radius: 999px; }
  .range-bar a.active { background: var(--red); color: #fff; font-weight: 600; }
  .bar { height: 8px; background: var(--panel-2); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; background: linear-gradient(90deg, var(--cyan), #2FA9E8); }
  .bar-row { display: grid; grid-template-columns: minmax(0,1fr) 80px; gap: 12px; align-items: center; margin: 6px 0; }
  .bar-row .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .bar-row .val { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12.5px; }
  .spark { display: block; width: 100%; height: 64px; }
  .empty { color: var(--dim); padding: 24px; text-align: center; font-size: 13px; border: 1px dashed var(--line); border-radius: 10px; }
  .pill { display: inline-block; padding: 2px 8px; font-size: 11px; border-radius: 999px; background: rgba(92,224,210,0.12); color: var(--cyan); letter-spacing: 0.04em; text-transform: uppercase; }
  a { color: var(--cyan); }
</style>
</head><body>
<div class="shell">
  <aside>
    <h2>Reach Admin</h2>
    ${navHtml}
    <div style="margin-top: 22px; padding: 0 8px; font-size: 11px; color: var(--dim);">forms-api.reachscreens.ca</div>
  </aside>
  <main>${body}</main>
</div>
</body></html>`;
}

// ---------- SQL aggregation helpers (all GROUP BY in SQL, no JS arrays) -
function sqlSince(days) { return `-${days} days`; }

function topGroups(eventType, days, limit = 12, column = 'label') {
  return db.prepare(`
    SELECT COALESCE(${column}, '(none)') AS k, COUNT(*) AS n
    FROM events
    WHERE event_type = ? AND ts >= datetime('now', ?)
    GROUP BY k ORDER BY n DESC LIMIT ?
  `).all(eventType, sqlSince(days), limit);
}

function dailyCount(eventType, days) {
  // Build the bucket frame in JS so empty days still appear.
  const buckets = new Map();
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  const rows = db.prepare(`
    SELECT substr(ts, 1, 10) AS d, COUNT(*) AS n
    FROM events
    WHERE event_type = ? AND ts >= datetime('now', ?)
    GROUP BY d
  `).all(eventType, sqlSince(days));
  for (const r of rows) if (buckets.has(r.d)) buckets.set(r.d, r.n);
  return [...buckets.entries()].map(([day, v]) => ({ day, v }));
}

function sparkline(points) {
  if (!points.length) return '<svg class="spark"></svg>';
  const w = 320, h = 64, pad = 4;
  const max = Math.max(1, ...points.map(p => p.v));
  const stepX = (w - pad * 2) / Math.max(1, points.length - 1);
  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((p.v / max) * (h - pad * 2));
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = `M ${coords.join(' L ')}`;
  const lastX = (pad + (points.length - 1) * stepX).toFixed(1);
  const areaPath = `${linePath} L ${lastX},${h - pad} L ${pad},${h - pad} Z`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${areaPath}" fill="rgba(92,224,210,0.18)"/>
    <path d="${linePath}" fill="none" stroke="#5CE0D2" stroke-width="1.8"/>
  </svg>`;
}

function barListHtml(items) {
  if (!items.length) return '<div class="empty">Nothing tracked yet for this range.</div>';
  const vals = items.map(i => (Array.isArray(i) ? i[1] : i.n));
  const labels = items.map(i => (Array.isArray(i) ? i[0] : i.k));
  const max = Math.max(...vals, 1);
  return labels.map((k, i) => {
    const v = vals[i];
    const pct = (v / max) * 100;
    return `<div>
      <div class="bar-row"><span class="lbl">${escape(k)}</span><span class="val">${v.toLocaleString()}</span></div>
      <div class="bar"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
    </div>`;
  }).join('');
}

// ---------- /admin (Overview) --------------------------------------------
app.get('/admin', basicAuth, (req, res) => {
  try {
    const { key, days } = rangeFromQuery(req.query);
    const pv = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type='pageview' AND ts >= datetime('now', ?)`).get(sqlSince(days)).n;
    const sessions = db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE session_id IS NOT NULL AND ts >= datetime('now', ?)`).get(sqlSince(days)).n;
    const clicks = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type='click' AND ts >= datetime('now', ?)`).get(sqlSince(days)).n;
    const subs = db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE created_at >= datetime('now', ?)`).get(sqlSince(days)).n;
    const subsAll = db.prepare(`SELECT COUNT(*) AS n FROM submissions`).get().n;
    const eventsAll = db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n;
    const dailyPV = dailyCount('pageview', days);

    const channels = {
      resend: Boolean(process.env.RESEND_API_KEY),
      smsEmail: Boolean(process.env.SMS_EMAIL),
      hubspot: Boolean(process.env.HUBSPOT_PRIVATE_APP_TOKEN),
      slack: Boolean(process.env.SLACK_WEBHOOK_URL),
    };
    const badge = (ok, name) =>
      `<span class="pill" style="background:${ok ? 'rgba(92,224,210,0.12)' : 'rgba(255,107,107,0.12)'};color:${ok ? 'var(--ok)' : 'var(--fail)'}">${name} ${ok ? '✓' : '·'}</span>`;

    const body = `
      <h1>Overview</h1>
      <p class="subtitle">Snapshot for reachscreens.ca — traffic and lead flow.</p>
      ${rangeBar(key)}
      <div class="cards">
        <div class="card"><p class="card-label">Pageviews</p><p class="card-value">${pv.toLocaleString()}</p><p class="card-sub">last ${days}d</p></div>
        <div class="card"><p class="card-label">Unique sessions</p><p class="card-value">${sessions.toLocaleString()}</p><p class="card-sub">distinct visitors</p></div>
        <div class="card"><p class="card-label">Clicks tracked</p><p class="card-value">${clicks.toLocaleString()}</p><p class="card-sub">on the live site</p></div>
        <div class="card"><p class="card-label">Form submissions</p><p class="card-value">${subs.toLocaleString()}</p><p class="card-sub">${subsAll.toLocaleString()} all-time</p></div>
      </div>
      <div class="panel">
        <h3>Pageviews · last ${days} days</h3>
        ${sparkline(dailyPV)}
        <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--dim); margin-top:6px;">
          <span>${dailyPV[0]?.day || ''}</span><span>${dailyPV[dailyPV.length - 1]?.day || ''}</span>
        </div>
      </div>
      <div class="grid-2">
        <div class="panel">
          <h3>Delivery channels</h3>
          <div style="display:flex; flex-wrap:wrap; gap:8px;">
            ${badge(channels.resend, 'Email (Resend)')}
            ${badge(channels.hubspot, 'HubSpot')}
            ${badge(channels.smsEmail, 'SMS via email')}
            ${badge(channels.slack, 'Slack')}
          </div>
          <p class="card-sub" style="margin-top:14px;">${eventsAll.toLocaleString()} analytics events recorded all-time.</p>
        </div>
        <div class="panel">
          <h3>Quick links</h3>
          <p style="margin:0; font-size:13px;"><a href="/admin/submissions">→ View submissions</a></p>
          <p style="margin:6px 0 0; font-size:13px;"><a href="/admin/analytics?range=${key}">→ Open analytics</a></p>
          <p style="margin:6px 0 0; font-size:13px;"><a href="/admin/sessions?range=${key}">→ Recent sessions</a></p>
          <p style="margin:6px 0 0; font-size:13px;"><a href="/health">→ Health JSON</a></p>
        </div>
      </div>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(adminShell('/admin', 'Overview', body));
  } catch (err) {
    console.error('Overview error:', err);
    res.status(500).send(adminShell('/admin', 'Overview', `<h1>Overview</h1><div class="panel"><p>Couldn't load overview: ${escape(err.message)}</p></div>`));
  }
});

// ---------- /admin/submissions -------------------------------------------
app.get('/admin/submissions', basicAuth, (_req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM submissions ORDER BY id DESC LIMIT 200`).all();
    const fmt = (n) => n ? '✓' : '·';
    const tableHtml = rows.length === 0 ? '<div class="empty">No submissions yet.</div>' : `
      <table>
        <thead><tr>
          <th>ID</th><th>When</th><th>Type</th><th>Name</th><th>Business</th><th>Contact</th>
          <th>Presence</th><th>Idea</th><th>Em</th><th>Sl</th><th>SMS</th><th>Cf</th><th>Hs</th>
        </tr></thead>
        <tbody>
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
            <td class="${r.hubspot_synced ? 'ok' : 'muted'}" title="${escape(r.hubspot_contact_id || '')}">${fmt(r.hubspot_synced)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    const body = `
      <h1>Submissions <span class="muted" style="font-weight:400; font-size:14px;">(${rows.length})</span></h1>
      <p class="subtitle">Every inquiry the form has received, newest first. Em/Sl/SMS/Cf/Hs columns show delivery to each channel.</p>
      <div class="panel" style="padding:0; overflow:hidden;">${tableHtml}</div>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(adminShell('/admin/submissions', 'Submissions', body));
  } catch (err) {
    console.error('Submissions error:', err);
    res.status(500).send(adminShell('/admin/submissions', 'Submissions', `<h1>Submissions</h1><div class="panel"><p>${escape(err.message)}</p></div>`));
  }
});

// ---------- /admin/analytics ---------------------------------------------
app.get('/admin/analytics', basicAuth, (req, res) => {
  try {
    const { key, days } = rangeFromQuery(req.query);
    const since = sqlSince(days);

    const pv = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type='pageview' AND ts >= datetime('now', ?)`).get(since).n;
    const sessions = db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE session_id IS NOT NULL AND ts >= datetime('now', ?)`).get(since).n;
    const clicks = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type='click' AND ts >= datetime('now', ?)`).get(since).n;

    const topPages = topGroups('pageview', days, 10, 'path');
    const topClicks = topGroups('click', days, 12, 'label');

    // Scroll depth funnel — distinct sessions reaching each milestone.
    const milestones = [25, 50, 75, 100];
    const funnel = milestones.map(m => {
      const r = db.prepare(`
        SELECT COUNT(DISTINCT session_id) AS n
        FROM events
        WHERE event_type='scroll_depth' AND value >= ? AND ts >= datetime('now', ?)
      `).get(m, since);
      return [m + '%', r.n];
    });

    // Section dwell time — sum + avg per section.
    const dwellRows = db.prepare(`
      SELECT COALESCE(label, '(unknown)') AS k,
             SUM(value) AS total,
             AVG(value) AS avg,
             COUNT(*) AS n
      FROM events
      WHERE event_type='section_dwell' AND ts >= datetime('now', ?)
      GROUP BY k ORDER BY total DESC LIMIT 10
    `).all(since);
    const topDwell = dwellRows.map(r => [`${r.k}  ·  ${(r.avg || 0).toFixed(1)}s avg (${r.n} visits)`, Math.round(r.total || 0)]);

    const devices = db.prepare(`
      SELECT COALESCE(device, 'unknown') AS k, COUNT(*) AS n
      FROM events WHERE event_type='pageview' AND ts >= datetime('now', ?)
      GROUP BY k ORDER BY n DESC
    `).all(since);

    const refs = db.prepare(`
      SELECT COALESCE(NULLIF(referrer, ''), 'direct') AS k, COUNT(*) AS n
      FROM events WHERE event_type='pageview' AND ts >= datetime('now', ?)
      GROUP BY k ORDER BY n DESC LIMIT 10
    `).all(since).map(r => ({
      ...r,
      k: r.k.replace(/^https?:\/\//, '').split('/')[0] || 'direct',
    }));
    // Re-aggregate after host extraction
    const refsMap = new Map();
    for (const r of refs) refsMap.set(r.k, (refsMap.get(r.k) || 0) + r.n);
    const refList = [...refsMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

    const dailyPV = dailyCount('pageview', days);

    const body = `
      <h1>Analytics</h1>
      <p class="subtitle">Traffic, clicks, scroll depth, and section dwell time on reachscreens.ca.</p>
      ${rangeBar(key)}
      <div class="cards">
        <div class="card"><p class="card-label">Pageviews</p><p class="card-value">${pv.toLocaleString()}</p></div>
        <div class="card"><p class="card-label">Sessions</p><p class="card-value">${sessions.toLocaleString()}</p></div>
        <div class="card"><p class="card-label">Clicks tracked</p><p class="card-value">${clicks.toLocaleString()}</p></div>
        <div class="card"><p class="card-label">Reached 75% scroll</p><p class="card-value">${(funnel[2]?.[1] || 0).toLocaleString()}</p><p class="card-sub">distinct sessions</p></div>
      </div>
      <div class="panel"><h3>Pageviews per day</h3>${sparkline(dailyPV)}</div>
      <div class="grid-2">
        <div class="panel"><h3>Top pages</h3>${barListHtml(topPages)}</div>
        <div class="panel"><h3>Most-clicked buttons &amp; links</h3>${barListHtml(topClicks)}</div>
      </div>
      <div class="grid-2">
        <div class="panel"><h3>Scroll-depth funnel</h3>${barListHtml(funnel)}</div>
        <div class="panel"><h3>Section dwell · total seconds</h3>${barListHtml(topDwell)}</div>
      </div>
      <div class="grid-2">
        <div class="panel"><h3>Devices</h3>${barListHtml(devices)}</div>
        <div class="panel"><h3>Referrers</h3>${barListHtml(refList)}</div>
      </div>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(adminShell('/admin/analytics', 'Analytics', body));
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).send(adminShell('/admin/analytics', 'Analytics', `<h1>Analytics</h1><div class="panel"><p>${escape(err.message)}</p></div>`));
  }
});

// ---------- /admin/sessions ----------------------------------------------
app.get('/admin/sessions', basicAuth, (req, res) => {
  try {
    const { key, days } = rangeFromQuery(req.query);
    const since = sqlSince(days);

    // Summary per session — newest 50, computed entirely in SQL.
    const sessions = db.prepare(`
      SELECT
        session_id AS sid,
        MIN(ts) AS start_ts,
        MAX(ts) AS end_ts,
        MAX(device) AS device,
        MAX(referrer) AS referrer,
        SUM(CASE WHEN event_type='pageview' THEN 1 ELSE 0 END) AS pageviews,
        SUM(CASE WHEN event_type='click' THEN 1 ELSE 0 END) AS clicks,
        COALESCE(MAX(CASE WHEN event_type='scroll_depth' THEN value END), 0) AS max_scroll
      FROM events
      WHERE session_id IS NOT NULL AND ts >= datetime('now', ?)
      GROUP BY session_id
      ORDER BY end_ts DESC
      LIMIT 50
    `).all(since);

    // For each session, fetch events lazily — only top 200 per session.
    const eventStmt = db.prepare(`
      SELECT ts, event_type, path, label, value FROM events
      WHERE session_id = ? ORDER BY ts ASC LIMIT 200
    `);

    const list = sessions.length === 0 ? '<div class="empty">No sessions in this range yet.</div>' : sessions.map(s => {
      const evs = eventStmt.all(s.sid);
      const refHost = (s.referrer || 'direct').replace(/^https?:\/\//, '').split('/')[0] || 'direct';
      return `
        <details class="panel" style="margin-bottom:10px;">
          <summary style="cursor:pointer; display:flex; gap:14px; flex-wrap:wrap; align-items:center; font-size:13px;">
            <span class="dim">${escape(s.start_ts)}</span>
            <span class="pill">${escape(s.device || 'unknown')}</span>
            <span>${s.pageviews} PV · ${s.clicks} clicks · max ${s.max_scroll}% scroll</span>
            <span class="dim">ref: ${escape(refHost)}</span>
            <span class="dim" style="margin-left:auto;">${escape((s.sid || '').slice(0, 10))}…</span>
          </summary>
          <table style="margin-top:14px;">
            <thead><tr><th>Time</th><th>Event</th><th>Path</th><th>Label</th><th>Value</th></tr></thead>
            <tbody>
            ${evs.map(e => `
              <tr>
                <td class="muted">${escape(e.ts)}</td>
                <td>${escape(e.event_type)}</td>
                <td>${escape(e.path || '')}</td>
                <td>${escape(e.label || '')}</td>
                <td class="muted">${e.value == null ? '' : e.value}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>`;
    }).join('');

    const body = `
      <h1>Sessions</h1>
      <p class="subtitle">Each row is one visitor session — expand to see the event-by-event trail.</p>
      ${rangeBar(key)}
      ${list}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(adminShell('/admin/sessions', 'Sessions', body));
  } catch (err) {
    console.error('Sessions error:', err);
    res.status(500).send(adminShell('/admin/sessions', 'Sessions', `<h1>Sessions</h1><div class="panel"><p>${escape(err.message)}</p></div>`));
  }
});

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- /admin/hubspot-pending (protected) — list rows not yet synced to HubSpot ----------
app.get('/admin/hubspot-pending', basicAuth, (_req, res) => {
  const rows = db.prepare(`
    SELECT id, created_at, type, name, business, email, phone, package, message
    FROM submissions
    WHERE hubspot_synced = 0
    ORDER BY id ASC
    LIMIT 100
  `).all();
  res.json({ ok: true, count: rows.length, submissions: rows });
});

// ---------- /admin/hubspot-mark-synced (protected) — mark a submission as synced ----------
app.post('/admin/hubspot-mark-synced', basicAuth, (req, res) => {
  const id = parseInt(req.body?.id, 10);
  const contactId = String(req.body?.contact_id || '').slice(0, 64);
  if (!id || !contactId) {
    return res.status(400).json({ ok: false, error: 'id and contact_id required' });
  }
  const result = db.prepare(`
    UPDATE submissions SET hubspot_synced = 1, hubspot_contact_id = ?
    WHERE id = ?
  `).run(contactId, id);
  res.json({ ok: true, updated: result.changes, id, contact_id: contactId });
});

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
