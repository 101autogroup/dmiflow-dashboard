const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const audiencelab = require('../services/audiencelab');

/**
 * AudienceLab webhook receiver.
 *
 * Paste this URL into the pixel's webhook / HTTP endpoint setting in AudienceLab:
 *   https://my.dmiflow.com/webhooks/audiencelab/<AUDIENCELAB_WEBHOOK_SECRET>
 *
 * The secret in the path is the auth (AudienceLab's HTTP endpoint does not sign
 * requests). One URL serves every pixel - each event carries its own pixel_id.
 */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

router.post('/:secret', express.json({ limit: '10mb' }), async (req, res) => {
  const secret = process.env.AUDIENCELAB_WEBHOOK_SECRET;
  if (!secret || !safeEqual(req.params.secret, secret)) {
    return res.status(401).json({ ok: false });
  }

  try {
    const result = await audiencelab.ingest(req.body);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('AudienceLab webhook error:', err.message);
    // 500 so AudienceLab retries
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
