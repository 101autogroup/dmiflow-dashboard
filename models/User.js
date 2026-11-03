const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  role: {
    type: String,
    enum: ['admin', 'user'],
    default: 'user'
  },
  assignedAgentIds: [{
    type: String
  }],
  // AudienceLab pixel whose identified visitors this account can see (one per account)
  assignedPixelId: {
    type: String,
    default: null,
    trim: true
  },
  pixelLabel: {
    type: String,
    default: '',
    trim: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: {
    type: Date
  }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('passwordHash')) return next();
  
  try {
    const salt = await bcrypt.genSalt(12);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

// Get safe user object (without password)
userSchema.methods.toSafeObject = function() {
  return {
    id: this._id,
    email: this.email,
    name: this.name,
    role: this.role,
    assignedAgentIds: this.assignedAgentIds,
    assignedPixelId: this.assignedPixelId,
    createdAt: this.createdAt
  };
};

module.exports = mongoose.model('User', userSchema);

