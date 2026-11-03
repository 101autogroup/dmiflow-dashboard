/**
 * AudienceLab pixel integration.
 *
 * Data comes in through the webhook (routes/pixelWebhook.js). This module turns
 * an AudienceLab V3 SuperPixel event into a PixelVisitor upsert.
 *
 * V3 event shape (per AudienceLab docs): top-level pixel_id, hem_sha256,
 * event_timestamp, ip_address, activity_start_date, activity_end_date,
 * event_data { url, title, referrer, ... } and resolution { ...person fields }.
 * Field names inside `resolution` vary by plan, so lookups below are
 * case-insensitive with several candidate keys, and the whole resolution
 * object is kept in `profile` so nothing is lost.
 */
const PixelVisitor = require('../models/PixelVisitor');

function lowerKeys(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) out[String(k).toLowerCase()] = v;
  return out;
}

function firstVal(v, splitList = false) {
  if (v == null) return '';
  if (Array.isArray(v)) return firstVal(v[0], splitList);
  if (typeof v === 'object') return '';
  const s = String(v).trim();
  // AudienceLab sends comma-separated lists for multi-value fields (emails, phones)
  return splitList ? s.split(',')[0].trim() : s;
}

function pick(lk, keys, splitList = false) {
  for (const k of keys) {
    const v = firstVal(lk[k], splitList);
    if (v) return v;
  }
  return '';
}

const pickList = (lk, keys) => pick(lk, keys, true);

function toDate(v) {
  if (!v) return null;
  const n = Number(v);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// Flatten nested objects into "a.b" keys so the CSV export can show every field.
function flatten(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = (prefix ? `${prefix}.${k}` : k).replace(/\$/g, '_').replace(/\./g, '_');
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function normalizeEvent(raw) {
  const top = lowerKeys(raw);
  const res = lowerKeys(top.resolution || top.person || {});
  const ev = lowerKeys(top.event_data || top.eventdata || {});
  const all = { ...top, ...res }; // allow flat payloads too

  const pixelId = firstVal(top.pixel_id || top.pixelid || top.pixel);
  const fallbackKey = [pick(all, ['first_name', 'firstname']), pick(all, ['last_name', 'lastname']),
    pickList(all, ['mobile_phone', 'personal_phone', 'direct_number', 'phone']), pick(all, ['personal_zip', 'zip'])]
    .filter(Boolean).join('|').toLowerCase();
  const email = pickList(all, ['personal_emails', 'personal_email', 'personal_verified_emails', 'email', 'business_email', 'business_emails', 'business_verified_emails', 'emails']).toLowerCase();
  const hem = firstVal(top.hem_sha256 || top.hem || top.sha256_personal_email || res.sha256_personal_email || '');
  const ip = firstVal(top.ip_address || top.ip || '');
  const personKey = hem || email || (fallbackKey ? `p:${fallbackKey}` : '') || (ip ? `ip:${ip}` : '');

  const at = toDate(top.event_timestamp || top.timestamp || top.activity_end_date || top.activity_start_date ||
    top.last_seen || top.last_visit || top.created_at || top.date || top.event_date) || new Date();

  return {
    pixelId,
    personKey,
    at,
    fields: {
      firstName: pick(all, ['first_name', 'firstname']),
      lastName: pick(all, ['last_name', 'lastname']),
      email,
      phone: pickList(all, ['mobile_phone', 'personal_phone', 'direct_number', 'phone', 'company_phone']),
      address: pick(all, ['personal_address', 'address', 'street']),
      city: pick(all, ['personal_city', 'city', 'company_city']),
      state: pick(all, ['personal_state', 'state', 'company_state']),
      zip: pick(all, ['personal_zip', 'zip', 'postal_code', 'company_zip']),
      company: pick(all, ['company_name', 'company']),
      jobTitle: pick(all, ['job_title', 'title']),
      linkedin: pick(all, ['linkedin_url', 'individual_linkedin_url', 'linkedin']),
      ipAddress: ip,
      hemSha256: hem
    },
    profile: flatten(top.resolution || top.person || {}),
    page: {
      url: firstVal(ev.url || ev.page_url || ev.event_url || ev.full_url || ev.landing_page || top.url || top.page_url),
      title: firstVal(ev.title || ev.page_title),
      referrer: firstVal(ev.referrer || top.referrer),
      eventType: firstVal(top.event_type || ev.event_type || 'page_view'),
      at
    }
  };
}

/**
 * Store one or many events. Returns { stored, skipped }.
 */
async function ingest(payload) {
  const events = Array.isArray(payload) ? payload
    : Array.isArray(payload?.events) ? payload.events
    : Array.isArray(payload?.data) ? payload.data
    : [payload];

  let stored = 0;
  let skipped = 0;

  for (const raw of events) {
    const e = normalizeEvent(raw);
    if (!e.pixelId || !e.personKey) { skipped++; continue; }

    // Only overwrite profile fields with non-empty values
    const set = {};
    for (const [k, v] of Object.entries(e.fields)) if (v) set[k] = v;
    for (const [k, v] of Object.entries(e.profile)) if (v !== '' && v != null) set[`profile.${k}`] = v;

    const update = {
      $set: set,
      $inc: { visitCount: 1 },
      $min: { firstSeen: e.at },
      $max: { lastSeen: e.at }
    };
    if (e.page.url) update.$push = { pages: { $each: [e.page], $slice: -50 } };

    await PixelVisitor.updateOne(
      { pixelId: e.pixelId, personKey: e.personKey },
      update,
      { upsert: true }
    );
    stored++;
  }

  return { stored, skipped };
}

/**
 * Import rows from an AudienceLab CSV export into one pixel. Each row is a flat
 * object keyed by the CSV header. All columns are kept in `profile`.
 */
async function ingestRows(pixelId, rows) {
  const events = rows
    .filter(r => r && typeof r === 'object')
    .map(r => ({ ...r, pixel_id: pixelId, resolution: r, event_data: r }));
  return ingest(events);
}

/** Pixel IDs that have sent data, for the admin assign dropdown. */
async function knownPixels() {
  return PixelVisitor.aggregate([
    { $group: { _id: '$pixelId', visitors: { $sum: 1 }, lastSeen: { $max: '$lastSeen' } } },
    { $sort: { lastSeen: -1 } }
  ]);
}

module.exports = { ingest, ingestRows, normalizeEvent, knownPixels };
