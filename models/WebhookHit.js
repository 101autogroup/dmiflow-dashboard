const mongoose = require('mongoose');

/**
 * One record per call to the AudienceLab webhook, kept 30 days.
 * Lets admins see whether AudienceLab is actually sending, and in what shape.
 */
const webhookHitSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  status: { type: String, enum: ['ok', 'unauthorized', 'missing_secret', 'error', 'probe'], default: 'ok' },
  method: String,
  contentType: String,
  userAgent: String,
  events: { type: Number, default: 0 },
  stored: { type: Number, default: 0 },
  skipped: { type: Number, default: 0 },
  pixelIds: [String],
  // Field names from the first event, so we can fix mapping if AudienceLab's format differs
  sampleKeys: [String],
  error: String
});

webhookHitSchema.index({ at: -1 });
webhookHitSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 86400 });

module.exports = mongoose.model('WebhookHit', webhookHitSchema);
