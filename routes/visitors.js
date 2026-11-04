const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');
const PixelVisitor = require('../models/PixelVisitor');
const audiencelab = require('../services/audiencelab');
const WebhookHit = require('../models/WebhookHit');

const PAGE_SIZE = 50;

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;')
    .replace(/\$/g, '&#36;');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which pixel this request may see. Clients: only their assigned pixel.
 * Admins: their own assigned pixel, or any pixel via ?pixel=.
 */
async function resolvePixel(req) {
  const user = await User.findById(req.session.user.id);
  if (!user) return { user: null, pixelId: null, accounts: [] };
  if (user.role !== 'admin') {
    return { user, pixelId: user.assignedPixelId || null, label: user.pixelLabel || '', accounts: [] };
  }
  // Admins can view any account's pixel; default to their own, else the first one assigned
  const accounts = await User.find({ assignedPixelId: { $nin: [null, ''] } })
    .select('name pixelLabel assignedPixelId').sort({ name: 1 }).lean();
  const wanted = req.query.pixel ? String(req.query.pixel) : (user.assignedPixelId || (accounts[0] && accounts[0].assignedPixelId) || null);
  const acct = accounts.find(a => a.assignedPixelId === wanted);
  return { user, pixelId: wanted, label: acct ? (acct.pixelLabel || acct.name) : (user.pixelLabel || ''), accounts };
}

function buildQuery(pixelId, q) {
  const query = { pixelId };
  if (q.search) {
    const rx = new RegExp(escapeRegex(String(q.search).trim()), 'i');
    query.$or = [
      { firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx },
      { company: rx }, { city: rx }
    ];
  }
  if (q.startDate || q.endDate) {
    query.lastSeen = {};
    if (q.startDate) query.lastSeen.$gte = new Date(q.startDate);
    if (q.endDate) query.lastSeen.$lt = new Date(new Date(q.endDate).getTime() + 86400000);
  }
  return query;
}

function fmtDate(d) {
  return d ? new Date(d).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  }) : '';
}

// Pages a visitor viewed, newest first. Older imports may only have the URL
// inside the raw profile columns, so fall back to scanning those.
function pagesOf(v) {
  const pages = (v.pages || []).filter(p => p && p.url)
    .slice().sort((a, b) => new Date(b.at) - new Date(a.at));
  if (pages.length) return pages;
  const url = audiencelab.findPageUrl(v.profile || {});
  return url ? [{ url, at: v.lastSeen }] : [];
}

function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  const n = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return n.length === 10 ? '(' + n.slice(0, 3) + ') ' + n.slice(3, 6) + '-' + n.slice(6) : String(p || '');
}

function shortUrl(u) {
  if (!u) return '';
  try {
    const x = new URL(u);
    const path = (x.pathname + x.search) || '/';
    return path.length > 40 ? path.slice(0, 40) + '...' : path;
  } catch (e) {
    return u.length > 40 ? u.slice(0, 40) + '...' : u;
  }
}

// Intent score 0-100: repeat visits, recency, and visiting buying pages.
const HIGH_INTENT = /(lease|special|inventory|vehicle|vdp|finance|credit|apply|pre-?approv|trade|appointment|schedule|book|contact|quote|pric|deal|offer|checkout|service|repair)/i;

function pathOf(u) {
  try { const x = new URL(u); return (x.pathname || '/').replace(/\/+$/, '') || '/'; } catch (e) { return u || ''; }
}

function scoreVisitor(v, pages, now) {
  let s = Math.min(v.visitCount || 1, 6) * 7;                    // up to 42
  const days = v.lastSeen ? (now - new Date(v.lastSeen)) / 86400000 : 99;
  s += days <= 1 ? 28 : days <= 3 ? 20 : days <= 7 ? 12 : days <= 14 ? 6 : 0; // up to 28
  if (pages.some(p => HIGH_INTENT.test(pathOf(p.url)))) s += 20; // buying pages
  s += Math.min(new Set(pages.map(p => pathOf(p.url))).size, 4) * 2.5; // up to 10
  return Math.min(100, Math.round(s));
}

function tierOf(score) {
  return score >= 65 ? 'hot' : score >= 40 ? 'warm' : 'cold';
}

function toRow(v, now) {
  const pages = pagesOf(v);
  const score = scoreVisitor(v, pages, now);
  return {
    id: String(v._id),
    name: [v.firstName, v.lastName].filter(Boolean).join(' ') || 'Unknown',
    initials: ((v.firstName || '?')[0] + ((v.lastName || '')[0] || '')).toUpperCase(),
    email: v.email || '',
    phone: v.phone || '',
    phoneDisplay: fmtPhone(v.phone),
    location: [v.city, v.state].filter(Boolean).join(', '),
    company: v.company || '',
    jobTitle: v.jobTitle || '',
    visits: v.visitCount || 0,
    lastPage: (pages[0] || {}).url || '',
    lastPageShort: shortUrl((pages[0] || {}).url || ''),
    lastSeen: fmtDate(v.lastSeen),
    lastSeenTs: v.lastSeen ? new Date(v.lastSeen).getTime() : 0,
    pageCount: pages.length,
    score,
    tier: tierOf(score),
    _pages: pages,
    _v: v
  };
}

// Chart + insight data across the whole pixel
function buildInsights(rows, now) {
  const DAYS = 30;
  const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const labels = [];
  const counts = {};
  for (let i = DAYS - 1; i >= 0; i--) {
    const k = dayKey(now - i * 86400000);
    labels.push(k);
    counts[k] = 0;
  }
  const pageCounts = {};
  const cityCounts = {};
  for (const r of rows) {
    const days = new Set();
    for (const p of r._pages) if (p.at) days.add(dayKey(p.at));
    if (!days.size && r._v.lastSeen) days.add(dayKey(r._v.lastSeen));
    days.forEach(k => { if (k in counts) counts[k]++; });

    new Set(r._pages.map(p => pathOf(p.url))).forEach(path => {
      if (path) pageCounts[path] = (pageCounts[path] || 0) + 1;
    });
    if (r.location) cityCounts[r.location] = (cityCounts[r.location] || 0) + 1;
  }
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => ({ label: k, count: c }));
  return {
    daily: {
      labels: labels.map(k => new Date(k + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
      data: labels.map(k => counts[k])
    },
    topPages: top(pageCounts, 7),
    topCities: top(cityCounts, 6)
  };
}

function safeJson(o) {
  return JSON.stringify(o).replace(/</g, '\\u003c');
}

// Admin-only: is AudienceLab actually calling the webhook, and for which pixels?
async function syncStatus(pixelId) {
  const dayAgo = new Date(Date.now() - 86400000);
  const [last, lastOk, byStatus, pixelsSeen] = await Promise.all([
    WebhookHit.findOne().sort({ at: -1 }).lean(),
    WebhookHit.findOne({ status: 'ok' }).sort({ at: -1 }).lean(),
    WebhookHit.aggregate([{ $match: { at: { $gte: dayAgo } } }, { $group: { _id: '$status', n: { $sum: 1 }, events: { $sum: '$events' }, stored: { $sum: '$stored' } } }]),
    WebhookHit.aggregate([{ $match: { status: 'ok' } }, { $unwind: '$pixelIds' }, { $group: { _id: '$pixelIds', n: { $sum: 1 }, last: { $max: '$at' } } }, { $sort: { last: -1 } }, { $limit: 10 }])
  ]);
  const s = {};
  byStatus.forEach(b => { s[b._id] = b; });
  return {
    lastAt: last ? fmtDate(last.at) : '',
    lastStatus: last ? last.status : '',
    lastOkAt: lastOk ? fmtDate(lastOk.at) : '',
    lastOkEvents: lastOk ? lastOk.events : 0,
    lastOkStored: lastOk ? lastOk.stored : 0,
    sampleKeys: lastOk ? (lastOk.sampleKeys || []) : [],
    hits24: (s.ok ? s.ok.n : 0),
    events24: (s.ok ? s.ok.events : 0),
    stored24: (s.ok ? s.ok.stored : 0),
    rejected24: (s.unauthorized ? s.unauthorized.n : 0) + (s.missing_secret ? s.missing_secret.n : 0),
    probes24: s.probe ? s.probe.n : 0,
    errors24: s.error ? s.error.n : 0,
    pixelsSeen: pixelsSeen.map(p => ({ id: p._id, n: p.n, last: fmtDate(p.last), matches: p._id === pixelId }))
  };
}

// List
router.get('/', requireAuth, async (req, res) => {
  try {
    const { user, pixelId, label, accounts } = await resolvePixel(req);
    const filters = {
      search: req.query.search || '',
      startDate: req.query.startDate || '',
      endDate: req.query.endDate || '',
      sort: req.query.sort === 'recent' ? 'recent' : 'intent',
      tier: ['hot', 'warm', 'cold'].includes(req.query.tier) ? req.query.tier : ''
    };

    if (!pixelId) {
      return res.render('visitors/index', {
        title: 'Website Visitors', esc, noPixel: true, visitors: [], stats: null,
        filters, pagination: { page: 1, totalPages: 1, total: 0 }, qs: '', pixelLabel: '',
        isAdmin: user && user.role === 'admin', accounts: [], pixelId: '', hotLeads: [], insightsJson: '{}', insights: null, sync: null
      });
    }

    const now = Date.now();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const hasFilter = !!(filters.search || filters.startDate || filters.endDate);

    // Score in memory: a pixel holds thousands of people at most, which is cheap
    const allDocs = await PixelVisitor.find({ pixelId }).limit(50000).lean();
    const all = allDocs.map(v => toRow(v, now));
    let matching = all;
    if (hasFilter) {
      const ids = new Set((await PixelVisitor.find(buildQuery(pixelId, req.query)).select('_id').lean()).map(d => String(d._id)));
      matching = all.filter(r => ids.has(r.id));
    }
    if (filters.tier) matching = matching.filter(r => r.tier === filters.tier);
    matching.sort(filters.sort === 'recent'
      ? (a, b) => b.lastSeenTs - a.lastSeenTs
      : (a, b) => (b.score - a.score) || (b.lastSeenTs - a.lastSeenTs));

    const total = matching.length;
    const visitors = matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    const weekAgo = now - 7 * 86400000;
    const newest = all.reduce((m, r) => Math.max(m, r.lastSeenTs), 0);
    const hotAll = all.filter(r => r.tier === 'hot');
    const hotLeads = all.slice().sort((a, b) => (b.score - a.score) || (b.lastSeenTs - a.lastSeenTs)).filter(r => r.tier !== 'cold').slice(0, 6);

    const insights = buildInsights(all, now);
    let sync = null;
    if (user.role === 'admin') {
      try { sync = await syncStatus(pixelId); } catch (e) { console.error('Sync status error:', e.message); }
    }

    const qsParams = new URLSearchParams();
    for (const k of ['search', 'startDate', 'endDate', 'tier']) if (filters[k]) qsParams.set(k, filters[k]);
    if (filters.sort !== 'intent') qsParams.set('sort', filters.sort);
    if (user.role === 'admin') qsParams.set('pixel', pixelId);

    res.render('visitors/index', {
      title: 'Website Visitors',
      esc,
      noPixel: false,
      visitors,
      hotLeads,
      insights,
      insightsJson: safeJson(insights),
      sync,
      stats: {
        allTime: all.length,
        last7: all.filter(r => r.lastSeenTs >= weekAgo).length,
        hot: hotAll.length,
        withPhone: all.filter(r => r.phone).length,
        lastReceived: newest ? fmtDate(newest) : 'No data yet'
      },
      filters,
      qs: qsParams.toString(),
      pixelQs: user.role === 'admin' ? 'pixel=' + encodeURIComponent(pixelId) : '',
      pixelLabel: label || '',
      accounts: accounts.map(a => ({ pixelId: a.assignedPixelId, name: a.name, label: a.pixelLabel || '' })),
      refreshed: req.query.refreshed === '1',
      isAdmin: user.role === 'admin',
      pixelId,
      pagination: { page, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total }
    });
  } catch (err) {
    console.error('Visitors page error:', err);
    res.status(500).render('error', { title: 'Error', message: 'Failed to load website visitors.' });
  }
});

// CSV export - every field, including the full AudienceLab profile
router.get('/export.csv', requireAuth, async (req, res) => {
  try {
    const { pixelId } = await resolvePixel(req);
    if (!pixelId) return res.redirect('/visitors');

    const rows = await PixelVisitor.find(buildQuery(pixelId, req.query)).sort({ lastSeen: -1 }).lean();

    const base = ['First Name', 'Last Name', 'Email', 'Phone', 'Address', 'City', 'State', 'Zip',
      'Company', 'Job Title', 'LinkedIn', 'Visits', 'First Seen', 'Last Seen', 'Last Page', 'Pages Visited', 'IP Address'];
    const profileKeys = [...new Set(rows.flatMap(r => Object.keys(r.profile || {})))].sort();

    const cell = (v) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = [[...base, ...profileKeys].map(cell).join(',')];
    for (const r of rows) {
      const pages = pagesOf(r).slice().reverse(); // oldest first
      lines.push([
        r.firstName, r.lastName, r.email, r.phone, r.address, r.city, r.state, r.zip,
        r.company, r.jobTitle, r.linkedin, r.visitCount,
        r.firstSeen ? new Date(r.firstSeen).toISOString() : '',
        r.lastSeen ? new Date(r.lastSeen).toISOString() : '',
        pages.length ? pages[pages.length - 1].url : '',
        [...new Set(pages.map(p => p.url).filter(Boolean))].join(' | '),
        r.ipAddress,
        ...profileKeys.map(k => (r.profile || {})[k])
      ].map(cell).join(','));
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="website-visitors-${stamp}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  } catch (err) {
    console.error('Visitors export error:', err);
    res.redirect('/visitors');
  }
});

// CSV import (admin only). The browser parses the AudienceLab CSV export and
// posts rows here in chunks, so large files stay under Vercel's 4.5MB body limit.
router.post('/import', requireAuth, express.json({ limit: '4mb' }), async (req, res) => {
  try {
    const user = await User.findById(req.session.user.id);
    if (!user || user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admins only' });

    const pixelId = String(req.body.pixelId || '').trim();
    const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 1000) : [];
    if (!pixelId) return res.status(400).json({ ok: false, error: 'Missing pixel' });

    const result = await audiencelab.ingestRows(pixelId, rows);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Visitors import error:', err);
    return res.status(500).json({ ok: false, error: 'Import failed' });
  }
});

// One visitor: every page viewed + every field AudienceLab sent
router.get('/person/:id', requireAuth, async (req, res) => {
  try {
    const { user, pixelId } = await resolvePixel(req);
    if (!pixelId || !/^[a-f0-9]{24}$/i.test(req.params.id)) return res.redirect('/visitors');

    // Scoped to the pixel this user may see, so clients can't open other accounts' people
    const v = await PixelVisitor.findOne({ _id: req.params.id, pixelId }).lean();
    if (!v) return res.status(404).render('error', { title: 'Not found', message: 'Visitor not found.' });

    const pages = pagesOf(v).map(p => ({ url: p.url, title: p.title || '', at: fmtDate(p.at) }));
    const fields = Object.entries(v.profile || {})
      .filter(([, val]) => val !== '' && val != null)
      .map(([k, val]) => ({ key: k.replace(/_/g, ' ').toLowerCase(), val: String(val) }))
      .sort((a, b) => a.key.localeCompare(b.key));

    res.render('visitors/detail', {
      title: 'Visitor',
      esc,
      back: '/visitors' + (user.role === 'admin' ? '?pixel=' + encodeURIComponent(pixelId) : ''),
      pixelQs: user.role === 'admin' ? '?pixel=' + encodeURIComponent(pixelId) : '',
      person: {
        name: [v.firstName, v.lastName].filter(Boolean).join(' ') || 'Unknown',
        email: v.email || '', phone: v.phone || '', phoneDisplay: fmtPhone(v.phone),
        address: [v.address, v.city, v.state, v.zip].filter(Boolean).join(', '),
        company: v.company || '', jobTitle: v.jobTitle || '', linkedin: v.linkedin || '',
        visits: v.visitCount || 0, firstSeen: fmtDate(v.firstSeen), lastSeen: fmtDate(v.lastSeen),
        score: scoreVisitor(v, pagesOf(v), Date.now()),
        tier: tierOf(scoreVisitor(v, pagesOf(v), Date.now()))
      },
      pages,
      fields
    });
  } catch (err) {
    console.error('Visitor detail error:', err);
    res.redirect('/visitors');
  }
});

// Refresh - data arrives live via webhook, so this just reloads the latest
router.post('/refresh', requireAuth, (req, res) => {
  const qs = new URLSearchParams(req.body.qs || '');
  qs.set('refreshed', '1');
  res.redirect('/visitors?' + qs.toString());
});

module.exports = router;
