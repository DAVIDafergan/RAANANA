require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const multer = require('multer');
const admin = require('firebase-admin');
const { User, Business, Benefit, Spin, Otp, Settings } = require('./models');

// ─── FIREBASE ADMIN INIT ─────────────────────────────
if (
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY &&
  !admin.apps.length
) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Serve static files: frontend at /, admin at /admin, vcf at /raanana-wheel.vcf
app.use(express.static(path.join(__dirname, '../public')));
app.use('/admin', express.static(path.join(__dirname, '../admin')));

// ─── FIREBASE CLIENT CONFIG (injected from env vars) ─────────────────────────
app.get('/firebase-env.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(`window.FIREBASE_CONFIG = {
  apiKey: ${JSON.stringify(process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '')},
  authDomain: ${JSON.stringify(process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || '')},
  projectId: ${JSON.stringify(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || '')},
  storageBucket: ${JSON.stringify(process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || '')},
  messagingSenderId: ${JSON.stringify(process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '')},
  appId: ${JSON.stringify(process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '')},
};`);
});

// ─── FILE UPLOAD CONFIG (LOGO) ───────────────────────
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
const MAX_LOGO_SIZE = 2 * 1024 * 1024; // 2 MB

const logoStorage = multer.diskStorage({
  destination: path.join(__dirname, '../public/uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `logo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});

const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: MAX_LOGO_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('סוג קובץ לא נתמך. יש להשתמש ב-JPEG, PNG, GIF, WebP או SVG.'));
    }
  },
});

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
    { key: 'winnerRatioWinners', value: 20 },
    { key: 'winnerRatioSpins', value: 100 },
  ];
  for (const d of defaults) {
    await Settings.findOneAndUpdate({ key: d.key }, { $setOnInsert: { value: d.value } }, { upsert: true, new: true });
  }
}
mongoose.connection.once('open', seedSettings);

// ─── AUTH ───────────────────────────────────────────

const ADMIN_PHONE = process.env.ADMIN_PHONE || '0556674329';
const MAX_BONUS_SPINS = 10;

function normalizePhone(phone) {
  let normalized = phone.replace(/\D/g, '');
  // Treat Israeli country code (972) as local prefix (0)
  // Israeli numbers with country code are exactly 12 digits (972 + 9 digits)
  if (normalized.startsWith('972') && normalized.length === 12) {
    normalized = '0' + normalized.slice(3);
  }
  return normalized;
}

// Convert a local Israeli number (0XX…) to E.164 (+972XX…)
function toE164(phone) {
  if (phone.startsWith('0')) return '+972' + phone.slice(1);
  if (!phone.startsWith('+')) return '+' + phone;
  return phone;
}

// Send OTP via Twilio REST API.
// If Twilio credentials are not configured, falls back to console log (dev mode).
async function sendSmsOtp(phone, code) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone  = process.env.TWILIO_FROM_PHONE;

  if (!accountSid || !authToken || !fromPhone) {
    console.log(`[DEV] OTP for ${phone}: ${code}`);
    return;
  }

  const toPhone  = toE164(phone);
  const body     = `קוד האימות שלך לגלגל המזל רעננה: ${code}`;
  const postData = new URLSearchParams({ To: toPhone, From: fromPhone, Body: body }).toString();
  const auth     = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`SMS send failed: ${res.statusCode} ${data}`));
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── QUICK LOGIN (returning users – phone only, no OTP) ─────────────────────

app.post('/api/auth/quick-login', userLimiter, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'חסר מספר טלפון' });
    }
    const normalizedPhone = normalizePhone(phone);
    const user = await User.findOne({ phone: normalizedPhone, isVerified: true });
    if (!user) {
      return res.json({ isNewUser: true });
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
    return res.json({ success: true, token, userId: user._id, name: user.name, canSpin, nextSpinAt, bonusSpins: user.bonusSpins });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ─── FIREBASE AUTH ENDPOINT ─────────────────────────

app.post('/api/auth/firebase-verify', otpLimiter, async (req, res) => {
  try {
    if (!admin.apps.length) {
      return res.status(503).json({ error: 'Firebase לא מוגדר בשרת – פנה למנהל' });
    }
    const { idToken, name } = req.body;
    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'חסר idToken' });
    }

    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (firebaseErr) {
      const code = firebaseErr.code || '';
      if (code === 'auth/id-token-expired') return res.status(401).json({ error: 'פג תוקף, נסה שוב' });
      return res.status(401).json({ error: 'token לא תקין' });
    }

    const firebasePhone = decodedToken.phone_number;
    if (!firebasePhone) {
      return res.status(400).json({ error: 'לא נמצא מספר טלפון ב-token' });
    }

    const normalizedPhone = normalizePhone(firebasePhone);
    let user = await User.findOne({ phone: normalizedPhone });

    // New user without a name — ask the client to re-submit with a name
    if (!user && (!name || typeof name !== 'string' || !name.trim())) {
      return res.json({ isNewUser: true, needsName: true });
    }

    const isNewUser = !user;
    if (!user) {
      user = await User.create({ phone: normalizedPhone, name: name.trim(), isVerified: true });
    } else {
      const upd = { isVerified: true };
      if (name && typeof name === 'string' && name.trim()) upd.name = name.trim();
      await User.updateOne({ _id: user._id }, upd);
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
    return res.json({ success: true, token, userId: user._id, name: user.name, isNewUser, canSpin, nextSpinAt, bonusSpins: user.bonusSpins });
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
      .select('businessName logoUrl prizeText color probability remainingStock');
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

    let isUsingBonusSpin = false;
    let originalNextSpinAt = null;

    if (user.lastSpin) {
      const nextSpin = new Date(user.lastSpin.getTime() + 24 * 60 * 60 * 1000);
      if (nextSpin > new Date()) {
        if (user.bonusSpins > 0) {
          isUsingBonusSpin = true;
          originalNextSpinAt = nextSpin;
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

    if (isUsingBonusSpin) {
      await User.updateOne({ _id: user._id }, { $inc: { spinCount: 1 } });
    } else {
      await User.updateOne({ _id: user._id }, { lastSpin: new Date(), $inc: { spinCount: 1 } });
    }

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
      const verificationCode = crypto.randomBytes(2).toString('hex').toUpperCase();
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
      return res.json({ isWin: false, nextSpinAt: isUsingBonusSpin ? originalNextSpinAt : new Date(Date.now() + 24 * 60 * 60 * 1000) });
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

app.post('/api/admin/upload-logo', adminAuth, adminLimiter, (req, res, next) => {
  logoUpload.single('logo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
    res.json({ logoUrl: `/uploads/${req.file.filename}` });
  });
});

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

app.get('/api/admin/users', adminAuth, adminLimiter, async (req, res) => {
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
    if (!Number.isInteger(count) || count < 1 || count > MAX_BONUS_SPINS) {
      return res.status(400).json({ error: `count חייב להיות מספר שלם בין 1 ל-${MAX_BONUS_SPINS}` });
    }
    await User.updateMany({}, { $set: { bonusSpins: count } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.delete('/api/admin/users/:id', adminAuth, adminLimiter, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });
    await Spin.deleteMany({ userId: req.params.id });
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
    // When totalStock is updated, adjust remainingStock by the same delta so restocked
    // benefits (remainingStock was 0) become visible on the wheel again.
    if (data.totalStock !== undefined) {
      const newTotal = Number(data.totalStock);
      if (!Number.isFinite(newTotal) || newTotal < 0) {
        return res.status(400).json({ error: 'totalStock חייב להיות מספר חיובי' });
      }
      const existing = await Benefit.findById(req.params.id);
      if (existing) {
        const delta = newTotal - existing.totalStock;
        data.remainingStock = Math.max(0, existing.remainingStock + delta);
      }
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
