# 🎡 גלגל המזל – רעננה

## מבנה הפרויקט
```
raanana-wheel/
├── backend/
│   ├── server.js      ← Express API
│   └── models.js      ← MongoDB schemas
├── public/
│   ├── index.html     ← אפליקציית הגלגל (מוגש מ-/)
│   └── raanana-wheel.vcf
├── admin/
│   └── index.html     ← דשבורד ניהול (מוגש מ-/admin)
├── package.json
└── .env.example
```

## פריסה ב-Railway

### 1. MongoDB Atlas
1. צור חשבון ב-https://cloud.mongodb.com
2. New Project → Build a Database → M0 (Free)
3. Create User: שם + סיסמה
4. Network Access → Add IP → 0.0.0.0/0
5. Connect → Drivers → העתק URI

### 2. GitHub
```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USER/raanana-wheel.git
git push -u origin main
```

### 3. Railway
1. railway.app → New Project → Deploy from GitHub
2. בחר את הריפו
3. Settings:
   - **Start Command:** `node backend/server.js`
   - (אין צורך לשנות Root Directory)

### 4. Environment Variables ב-Railway
```
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/raanana-wheel
SECRET=your-random-secret-string-here
ADMIN_KEY=your-admin-password
PORT=3001
FRONTEND_URL=*
NODE_ENV=production
```

### 5. שליחת SMS אמיתית
ב-`backend/server.js` הסר את ה-comment ב-sendOTP ועדכן עם InfoBip/Twilio.

## URLs לאחר פריסה
- גלגל: `https://your-app.railway.app`
- ניהול: `https://your-app.railway.app/admin`
- ממשק API: `https://your-app.railway.app/api`

## המספר לשמירה
055-667-4329 — הקובץ VCF נמצא בכתובת `/raanana-wheel.vcf`
