import express from 'express';
import { Resend } from 'resend';

const app = express();
app.use(express.json({ limit: '32kb' }));

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

app.get('/health', (_req, res) => {
  res.json({ ok: true, hasKey: Boolean(process.env.RESEND_API_KEY) });
});

const PACKAGE_LABEL = {
  'local-presence': 'Local Presence ($249/mo)',
  'lloyd-network': 'Lloyd Network ($499/mo)',
  'category-authority': 'Category Authority ($799/mo)',
  'city-takeover': 'City Takeover ($1,299/mo)',
};

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const clean = (s, max = 1000) => String(s || '').trim().slice(0, max);

app.post('/submit', async (req, res) => {
  try {
    if (!process.env.RESEND_API_KEY) {
      console.error('RESEND_API_KEY not set');
      return res.status(503).json({ ok: false, error: 'Service not configured' });
    }

    const body = req.body || {};
    if (clean(body._hp)) return res.json({ ok: true });

    const name = clean(body.name, 200);
    const email = clean(body.email, 200);
    const business = clean(body.business, 200);
    const phone = clean(body.phone, 60);
    const type = body.type === 'host' ? 'host' : 'advertise';
    const pkgRaw = clean(body.package, 60);
    const locationsRaw = clean(body.locations, 500);
    const venue = clean(body.venue, 200);
    const address = clean(body.address, 300);
    const message = clean(body.message, 5000);

    if (!name || !isEmail(email) || !message) {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required fields' });
    }

    const pkgLabel = PACKAGE_LABEL[pkgRaw] || pkgRaw;

    const subject = type === 'host'
      ? `[Reach Screens] Host inquiry from ${name}`
      : `[Reach Screens] Advertiser inquiry from ${name}${pkgLabel ? ` — ${pkgLabel}` : ''}`;

    const lines = [
      `Inquiry type: ${type === 'host' ? 'Wants to host a screen' : 'Wants to advertise'}`,
      ``,
      `Name: ${name}`,
      business && `Business: ${business}`,
      `Email: ${email}`,
      phone && `Phone: ${phone}`,
      pkgLabel && `Package: ${pkgLabel}`,
      locationsRaw && `Selected location IDs: ${locationsRaw}`,
      venue && `Venue type: ${venue}`,
      address && `Business address: ${address}`,
      ``,
      `Message:`,
      message,
    ].filter(Boolean);

    const text = lines.join('\n');

    const resend = new Resend(process.env.RESEND_API_KEY);
    const fromAddr = process.env.RESEND_FROM || 'Reach Screens Site <noreply@reachscreens.ca>';
    const toAddr = process.env.RESEND_TO || 'info@reachscreens.ca';

    const result = await resend.emails.send({
      from: fromAddr,
      to: toAddr,
      replyTo: email,
      subject,
      text,
    });

    if (result.error) {
      console.error('Resend error:', result.error);
      return res.status(502).json({ ok: false, error: 'Send failed' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`forms-api listening on :${PORT}`);
});
