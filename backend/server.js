require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { User, Business, Benefit, Spin, Otp, Settings } = require('./models');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Serve static files: frontend at /, admin at /admin, vcf at /raanana-wheel.vcf
app.use(express.static(path.join(__dirname, '../public')));
app.use('/admin', express.static(path.join(__dirname, '../admin')));

// Rate limiters
const spinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const otpLimiter = rateLimit({ windowMs: 60 * 1000, max: 3, standardHeaders: true, legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const userLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

// DB connect
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// Seed default settings on startup
async function seedSettings() {
  const defaults = [
    { key: 'wheelActive', value: true },
    { key: 'globalLossProbability', value: 80 },
    { key: 'weekendBonus', value: false },
  ];
  for (const d of defaults) {
    await Settings.findOneAndUpdate({ key: d.key }, { $setOnInsert: { value: d.value } }, { upsert: true, new: true });
  }
}
mongoose.connection.once('open', seedSettings);

// ─── AUTH ───────────────────────────────────────────

const ADMIN_PHONE = process.env.ADMIN_PHONE || '0556674329';

function normalizePhone(phone) {
  let normalized = phone.replace(/\D/g, '');
  // Treat Israeli country code (972) as local prefix (0)
  if (normalized.startsWith('972') && normalized.length >= 12) {
    normalized = '0' + normalized.slice(3);
  }
  return normalized;
}

app.post('/api/auth/send-otp', otpLimiter, async (req, res) => {
  try {
    const { phone, name } = req.body;
    if (!phone || !name || typeof phone !== 'string' || typeof name !== 'string') {
      return res.status(400).json({ error: 'חסרים פרטים' });
    }

    const normalizedPhone = normalizePhone(phone);

    let user = await User.findOne({ phone: normalizedPhone });
    const isReturningUser = !!user;
    if (!user) {
      user = await User.create({ phone: normalizedPhone, name, isVerified: true });
    } else {
      await User.updateOne({ _id: user._id }, { isVerified: true, name });
      user = await User.findById(user._id);
    }

    let canSpin = true;
    let nextSpinAt = null;
    if (user.lastSpin) {
      const next = new Date(user.lastSpin.getTime() + 24 * 60 * 60 * 1000);
      if (next > new Date()) {
        if (user.bonusSpins > 0) {
          canSpin = true;
        } else {
          canSpin = false;
          nextSpinAt = next;
        }
      }
    }

    const token = Buffer.from(`${user._id}:${process.env.SECRET || 'dev'}`).toString('base64');
    return res.json({ success: true, autoVerified: true, token, userId: user._id, name: user.name, isReturningUser, canSpin, nextSpinAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phone, name, code } = req.body;
    const normalizedPhone = normalizePhone(phone || '');
    const otp = await Otp.findOne({ phone: normalizedPhone, code, used: false });
    if (!otp || otp.expiresAt < new Date()) {
      return res.status(401).json({ error: 'קוד שגוי או פג תוקף' });
    }
    await Otp.updateOne({ _id: otp._id }, { used: true });

    let user = await User.findOne({ phone: normalizedPhone });
    if (!user) {
      user = await User.create({ phone: normalizedPhone, name, isVerified: true });
    } else {
      await User.updateOne({ _id: user._id }, { isVerified: true, name });
    }

    const token = Buffer.from(`${user._id}:${process.env.SECRET || 'dev'}`).toString('base64');
    res.json({ success: true, token, userId: user._id, name: user.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ─── MIDDLEWARE ──────────────────────────────────────

async function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'לא מחובר' });
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    const [userId] = decoded.split(':');
    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ error: 'משתמש לא נמצא' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'טוקן לא תקין' });
  }
}

function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'לא מורשה' });
  }
  next();
}

// ─── USER ROUTES ─────────────────────────────────────

app.get('/api/user/status', auth, userLimiter, async (req, res) => {
  try {
    const user = req.user;
    let canSpin = true;
    let nextSpinAt = null;
    if (user.lastSpin) {
      const next = new Date(user.lastSpin.getTime() + 24 * 60 * 60 * 1000);
      if (next > new Date()) {
        if (user.bonusSpins > 0) {
          canSpin = true;
        } else {
          canSpin = false;
          nextSpinAt = next;
        }
      }
    }
    res.json({ name: user.name, canSpin, nextSpinAt, bonusSpins: user.bonusSpins });
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/benefits', auth, async (req, res) => {
  try {
    const benefits = await Benefit.find({ isActive: true, remainingStock: { $gt: 0 } })
      .select('businessName logoUrl prizeText color probability');
    const setting = await Settings.findOne({ key: 'globalLossProbability' });
    res.json({ benefits, lossProbability: setting?.value ?? 80 });
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/spin', auth, spinLimiter, async (req, res) => {
  try {
    const user = req.user;

    const wheelSetting = await Settings.findOne({ key: 'wheelActive' });
    if (wheelSetting?.value === false) {
      return res.status(403).json({ error: 'הגלגל כבה כרגע, חזרו מחר!' });
    }

    if (user.lastSpin) {
      const nextSpin = new Date(user.lastSpin.getTime() + 24 * 60 * 60 * 1000);
      if (nextSpin > new Date()) {
        if (user.bonusSpins > 0) {
          await User.updateOne({ _id: user._id }, { $inc: { bonusSpins: -1 } });
        } else {
          return res.status(429).json({ error: 'כבר סובבת היום!', nextSpinAt: nextSpin });
        }
      }
    }

    const benefits = await Benefit.find({ isActive: true, remainingStock: { $gt: 0 } });
    const lossSetting = await Settings.findOne({ key: 'globalLossProbability' });
    let lossProb = lossSetting?.value ?? 80;

    const weekendSetting = await Settings.findOne({ key: 'weekendBonus' });
    const isWeekend = [5, 6].includes(new Date().getDay());
    if (weekendSetting?.value && isWeekend) lossProb = Math.max(lossProb - 20, 20);

    await User.updateOne({ _id: user._id }, { lastSpin: new Date(), $inc: { spinCount: 1 } });

    const rand = Math.random() * 100;
    let winner = null;
    if (rand >= lossProb && benefits.length > 0) {
      const totalProb = benefits.reduce((s, b) => s + b.probability, 0);
      let pick = Math.random() * totalProb;
      for (const b of benefits) {
        pick -= b.probability;
        if (pick <= 0) { winner = b; break; }
      }
    }

    if (winner) {
      await Benefit.updateOne({ _id: winner._id }, { $inc: { remainingStock: -1 } });
      const verificationCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const spin = await Spin.create({
        userId: user._id, benefitId: winner._id,
        isWin: true, expiresAt, verificationCode, ipAddress: req.ip,
      });
      return res.json({
        isWin: true,
        prize: { businessName: winner.businessName, logoUrl: winner.logoUrl, prizeText: winner.prizeText },
        expiresAt, verificationCode, spinId: spin._id,
      });
    } else {
      await Spin.create({ userId: user._id, isWin: false, ipAddress: req.ip });
      return res.json({ isWin: false, nextSpinAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/redeem/:code', adminAuth, async (req, res) => {
  try {
    const spin = await Spin.findOne({ verificationCode: req.params.code, isWin: true });
    if (!spin) return res.status(404).json({ error: 'קוד לא נמצא' });
    if (spin.isRedeemed) return res.status(409).json({ error: 'כבר נוצל' });
    if (spin.expiresAt < new Date()) return res.status(410).json({ error: 'פג תוקף' });
    await Spin.updateOne({ _id: spin._id }, { isRedeemed: true, redeemedAt: new Date() });
    const user = await User.findById(spin.userId).select('name phone');
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ─── ADMIN ROUTES ────────────────────────────────────

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalSpins = await Spin.countDocuments();
    const totalWins = await Spin.countDocuments({ isWin: true });
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const spinsToday = await Spin.countDocuments({ spinAt: { $gte: todayStart } });
    const spinsPerHour = await Spin.aggregate([
      { $match: { spinAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } },
      { $group: { _id: { $hour: '$spinAt' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    res.json({ totalUsers, totalSpins, totalWins, spinsToday, spinsPerHour });
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/admin/wins', adminAuth, adminLimiter, async (req, res) => {
  try {
    const wins = await Spin.find({ isWin: true })
      .populate('userId', 'name phone')
      .populate('benefitId', 'businessName prizeText')
      .sort({ spinAt: -1 })
      .limit(100);
    res.json(wins);
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const users = await User.find().select('name phone spinCount lastSpin bonusSpins createdAt').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/admin/grant-bonus-spins', adminAuth, adminLimiter, async (req, res) => {
  try {
    const count = parseInt(req.body.count, 10);
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      return res.status(400).json({ error: 'count חייב להיות מספר שלם בין 1 ל-10' });
    }
    await User.updateMany({}, { $set: { bonusSpins: count } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/admin/users/:id/grant-spin', adminAuth, adminLimiter, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { $inc: { bonusSpins: 1 } }, { new: true });
    if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });
    res.json({ success: true, bonusSpins: user.bonusSpins });
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/admin/benefits', adminAuth, async (req, res) => {
  try {
    const benefits = await Benefit.find().sort({ createdAt: -1 });
    res.json(benefits);
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/admin/benefits', adminAuth, adminLimiter, async (req, res) => {
  try {
    const data = { ...req.body, remainingStock: req.body.totalStock };
    if (data.businessId) {
      if (!mongoose.Types.ObjectId.isValid(data.businessId)) {
        return res.status(400).json({ error: 'businessId לא תקין' });
      }
      const biz = await Business.findById(data.businessId);
      if (biz) { data.businessName = biz.name; data.logoUrl = biz.logoUrl; }
    }
    const benefit = await Benefit.create(data);
    res.json(benefit);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/benefits/:id', adminAuth, adminLimiter, async (req, res) => {
  try {
    const data = { ...req.body };
    if (data.businessId) {
      if (!mongoose.Types.ObjectId.isValid(data.businessId)) {
        return res.status(400).json({ error: 'businessId לא תקין' });
      }
      const biz = await Business.findById(data.businessId);
      if (biz) { data.businessName = biz.name; data.logoUrl = biz.logoUrl; }
    }
    const benefit = await Benefit.findByIdAndUpdate(req.params.id, data, { new: true });
    res.json(benefit);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/benefits/:id', adminAuth, async (req, res) => {
  try {
    await Benefit.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.put('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    const { key, value } = req.body;
    await Settings.findOneAndUpdate({ key }, { value, updatedAt: new Date() }, { upsert: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    const settings = await Settings.find();
    const map = {};
    settings.forEach(s => { map[s.key] = s.value; });
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ─── BUSINESS ROUTES ─────────────────────────────────

app.get('/api/admin/businesses', adminAuth, adminLimiter, async (req, res) => {
  try {
    const businesses = await Business.find().sort({ createdAt: -1 });
    res.json(businesses);
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/admin/businesses', adminAuth, adminLimiter, async (req, res) => {
  try {
    const { name, logoUrl } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'שם עסק חסר' });
    }
    const business = await Business.create({ name: name.trim(), logoUrl: logoUrl || '' });
    res.json(business);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/businesses/:id', adminAuth, adminLimiter, async (req, res) => {
  try {
    const { name, logoUrl } = req.body;
    const update = {};
    if (name !== undefined) update.name = name.trim();
    if (logoUrl !== undefined) update.logoUrl = logoUrl;
    const business = await Business.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!business) return res.status(404).json({ error: 'עסק לא נמצא' });
    // sync name/logo on linked benefits
    await Benefit.updateMany({ businessId: business._id }, { businessName: business.name, logoUrl: business.logoUrl });
    res.json(business);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/businesses/:id', adminAuth, adminLimiter, async (req, res) => {
  try {
    await Business.findByIdAndDelete(req.params.id);
    // unlink benefits so they are not orphaned
    await Benefit.updateMany({ businessId: req.params.id }, { $unset: { businessId: 1 } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// Fallback: serve frontend for all non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/admin')) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🎡 Raanana Wheel running on port ${PORT}`));
