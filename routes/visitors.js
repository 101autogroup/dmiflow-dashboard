const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');
const PixelVisitor = require('../models/PixelVisitor');
const audiencelab = require('../services/audiencelab');

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

// List
router.get('/', requireAuth, async (req, res) => {
  try {
    const { user, pixelId, label, accounts } = await resolvePixel(req);
    const filters = {
      search: req.query.search || '',
      startDate: req.query.startDate || '',
      endDate: req.query.endDate || ''
    };

    if (!pixelId) {
      return res.render('visitors/index', {
        title: 'Website Visitors', esc, noPixel: true, visitors: [], stats: null,
        filters, pagination: { page: 1, totalPages: 1, total: 0 }, qs: '', pixelLabel: '',
        isAdmin: user && user.role === 'admin', accounts: [], pixelId: ''
      });
    }

    const query = buildQuery(pixelId, req.query);
    const page = Math.max(1, parseInt(req.query.page) || 1);

    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const [total, rows, allTime, last7, newest] = await Promise.all([
      PixelVisitor.countDocuments(query),
      PixelVisitor.find(query).sort({ lastSeen: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
      PixelVisitor.countDocuments({ pixelId }),
      PixelVisitor.countDocuments({ pixelId, lastSeen: { $gte: weekAgo } }),
      PixelVisitor.findOne({ pixelId }).sort({ lastSeen: -1 }).select('lastSeen').lean()
    ]);

    const byTime = (pages) => (pages || []).slice().sort((a, b) => new Date(b.at) - new Date(a.at));

    const visitors = rows.map(v => ({
      id: String(v._id),
      name: [v.firstName, v.lastName].filter(Boolean).join(' ') || 'Unknown',
      email: v.email || '',
      phone: v.phone || '',
      location: [v.city, v.state].filter(Boolean).join(', '),
      company: v.company || '',
      jobTitle: v.jobTitle || '',
      visits: v.visitCount || 0,
      lastPage: (byTime(v.pages)[0] || {}).url || '',
      lastSeen: fmtDate(v.lastSeen),
      pages: byTime(v.pages).slice(0, 10).map(p => ({ url: p.url || '', at: fmtDate(p.at) }))
    }));

    const qsParams = new URLSearchParams();
    for (const k of ['search', 'startDate', 'endDate']) if (filters[k]) qsParams.set(k, filters[k]);
    if (user.role === 'admin') qsParams.set('pixel', pixelId);

    res.render('visitors/index', {
      title: 'Website Visitors',
      esc,
      noPixel: false,
      visitors,
      stats: { allTime, last7, lastReceived: newest ? fmtDate(newest.lastSeen) : 'No data yet' },
      filters,
      qs: qsParams.toString(),
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
      const pages = (r.pages || []).slice().sort((a, b) => new Date(a.at) - new Date(b.at));
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

// Refresh - data arrives live via webhook, so this just reloads the latest
router.post('/refresh', requireAuth, (req, res) => {
  const qs = new URLSearchParams(req.body.qs || '');
  qs.set('refreshed', '1');
  res.redirect('/visitors?' + qs.toString());
});

module.exports = router;
