const mongoose = require('mongoose');

/**
 * One identified person per AudienceLab pixel.
 *
 * Repeat visits from the same person are merged into one document (keyed by
 * pixelId + personKey). Visitors are stored by pixel, not by user, so assigning
 * a pixel to an account later immediately shows that pixel's full history.
 */
const pageViewSchema = new mongoose.Schema({
  url: String,
  title: String,
  referrer: String,
  eventType: String,
  at: Date
}, { _id: false });

const pixelVisitorSchema = new mongoose.Schema({
  pixelId: { type: String, required: true, index: true },
  // hem_sha256, else email, else ip - whatever identifies the person best
  personKey: { type: String, required: true },

  firstName: String,
  lastName: String,
  email: String,
  phone: String,
  address: String,
  city: String,
  state: String,
  zip: String,
  company: String,
  jobTitle: String,
  linkedin: String,
  ipAddress: String,
  hemSha256: String,

  // Every field AudienceLab sent in `resolution`, flattened. Used for the full CSV export.
  profile: { type: mongoose.Schema.Types.Mixed, default: {} },

  pages: { type: [pageViewSchema], default: [] }, // last 50 page views
  visitCount: { type: Number, default: 0 },
  firstSeen: { type: Date, index: true },
  lastSeen: { type: Date, index: true }
}, { timestamps: true, minimize: false });

pixelVisitorSchema.index({ pixelId: 1, personKey: 1 }, { unique: true });
pixelVisitorSchema.index({ pixelId: 1, lastSeen: -1 });

module.exports = mongoose.model('PixelVisitor', pixelVisitorSchema);
