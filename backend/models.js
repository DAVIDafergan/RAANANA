const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  isVerified: { type: Boolean, default: false },
  lastSpin: { type: Date, default: null },
  contactSaved: { type: Boolean, default: false },
  spinCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

const businessSchema = new mongoose.Schema({
  name: { type: String, required: true },
  logoUrl: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

const benefitSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null },
  businessName: { type: String, required: true },
  logoUrl: { type: String, default: '' },
  prizeText: { type: String, required: true },
  probability: { type: Number, required: true, min: 0, max: 100 },
  totalStock: { type: Number, required: true },
  remainingStock: { type: Number, required: true },
  isActive: { type: Boolean, default: true },
  color: { type: String, default: '#7B5CF6' },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null },
});

const spinSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  benefitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Benefit', default: null },
  isWin: { type: Boolean, required: true },
  isRedeemed: { type: Boolean, default: false },
  redeemedAt: { type: Date, default: null },
  spinAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null },
  verificationCode: { type: String, default: null },
  ipAddress: { type: String },
});

const otpSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  code: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  used: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);
const Business = mongoose.model('Business', businessSchema);
const Benefit = mongoose.model('Benefit', benefitSchema);
const Spin = mongoose.model('Spin', spinSchema);
const Otp = mongoose.model('Otp', otpSchema);
const Settings = mongoose.model('Settings', settingsSchema);

module.exports = { User, Business, Benefit, Spin, Otp, Settings };
