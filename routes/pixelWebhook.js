const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const audiencelab = require('../services/audiencelab');
const WebhookHit = require('../models/WebhookHit');

/**
 * AudienceLab webhook receiver.
 *
 * Paste this URL into the pixel's webhook / HTTP endpoint setting in AudienceLab:
 *   https://my.dmiflow.com/webhooks/audiencelab/<AUDIENCELAB_WEBHOOK_SECRET>
 *
 * The secret in the path is the auth (AudienceLab's HTTP endpoint does not sign
 * requests). One URL serves every pixel - each event carries its own pixel_id.
 *
 * Every call is recorded in WebhookHit (30 days) so admins can see on the
 * Visitors page whether AudienceLab is sending and what it sends.
 */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Accept non-JSON bodies too (text/plain, NDJSON) - the global JSON parser only handles application/json
const anyBody = express.text({ type: (req) => !/application\/json/i.test(req.headers['content-type'] || ''), limit: '10mb' });

function parseBody(body) {
  if (body && typeof body === 'object') return body;
  const s = String(body || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { /* fall through */ }
  // NDJSON: one JSON object per line
  const lines = s.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch (e) { return null; } }
  return out.length ? out : null;
}

function eventsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.events)) return payload.events;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return payload ? [payload] : [];
}

function sampleKeysOf(events) {
  const first = events[0];
  if (!first || typeof first !== 'object') return [];
  const keys = Object.keys(first);
  const nested = ['resolution', 'event_data', 'person'].flatMap(k =>
    first[k] && typeof first[k] === 'object' ? Object.keys(first[k]).map(x => k + '.' + x) : []);
  return keys.concat(nested).slice(0, 80);
}

async function record(req, data) {
  try {
    await WebhookHit.create({
      method: req.method,
      contentType: String(req.headers['content-type'] || '').slice(0, 100),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
      ...data
    });
  } catch (e) {
    console.error('WebhookHit record failed:', e.message);
  }
}

// Some services "test" a URL with GET/HEAD before saving it
router.get('/:secret?', async (req, res) => {
  await record(req, { status: 'probe' });
  console.log('AudienceLab webhook probe:', req.method);
  res.status(200).json({ ok: true, service: 'dmiflow-audiencelab-webhook' });
});

// URL pasted without the secret
router.post('/', anyBody, async (req, res) => {
  await record(req, { status: 'missing_secret' });
  console.warn('AudienceLab webhook called without secret');
  res.status(401).json({ ok: false, error: 'missing secret in URL' });
});

router.post('/:secret', anyBody, async (req, res) => {
  const secret = process.env.AUDIENCELAB_WEBHOOK_SECRET;
  if (!secret || !safeEqual(req.params.secret, secret)) {
    await record(req, { status: 'unauthorized' });
    console.warn('AudienceLab webhook: wrong secret');
    return res.status(401).json({ ok: false });
  }

  const payload = parseBody(req.body);
  const events = eventsOf(payload);
  const pixelIds = [...new Set(events.map(e => e && (e.pixel_id || e.PIXEL_ID || e.pixelId)).filter(Boolean).map(String))].slice(0, 10);

  try {
    const result = await audiencelab.ingest(events);
    await record(req, { status: 'ok', events: events.length, stored: result.stored, skipped: result.skipped, pixelIds, sampleKeys: sampleKeysOf(events) });
    console.log(`AudienceLab webhook: ${events.length} events, ${result.stored} stored, ${result.skipped} skipped, pixels=${pixelIds.join('|')}`);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    await record(req, { status: 'error', events: events.length, pixelIds, sampleKeys: sampleKeysOf(events), error: String(err.message).slice(0, 300) });
    console.error('AudienceLab webhook error:', err.message);
    // 500 so AudienceLab retries
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
