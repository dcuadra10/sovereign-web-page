const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const xlsx = require('xlsx');
require('dotenv').config();

const { initDB, getAllStats, upsertStats, upsertUser, getUser } = require('./database');

const app = express();
const JWT_SECRET = process.env.SESSION_SECRET || 'super-secret-key';
const ADMIN_ID = '1211770249200795734';

// Initialize database
initDB();

// Trust proxy for Vercel
app.set('trust proxy', 1);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Get user from JWT cookie
function getUserFromToken(req) {
  try {
    const token = req.cookies.auth_token;
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Middleware
function isAuthenticated(req, res, next) {
  const user = getUserFromToken(req);
  if (user) {
    req.user = user;
    return next();
  }
  res.redirect('/');
}

function isAdmin(req, res, next) {
  const user = getUserFromToken(req);
  if (user && user.discordId === ADMIN_ID) {
    req.user = user;
    return next();
  }
  res.status(403).send('Forbidden');
}

// File upload
const upload = multer({ dest: '/tmp/uploads/' });

// Routes
app.get('/', (req, res) => {
  const user = getUserFromToken(req);
  if (user) {
    return res.redirect('/dashboard');
  }
  res.render('login');
});

// Public stats
app.get('/stats', async (req, res) => {
  try {
    const stats = await getAllStats();
    res.render('stats', { stats });
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

// Discord OAuth - redirect to Discord
app.get('/auth/discord', (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.DISCORD_CALLBACK_URL);
  const scope = encodeURIComponent('identify');
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}`);
});

// Discord OAuth callback
app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    // Exchange code for token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.DISCORD_CALLBACK_URL
      })
    });

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
      console.error('Token error:', tokenData);
      return res.redirect('/?error=token_failed');
    }

    // Get user info
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userResponse.json();

    // Save to database
    await upsertUser(userData.id, userData.username, userData.avatar);

    // Create JWT token
    const token = jwt.sign({
      discordId: userData.id,
      username: userData.username,
      avatar: userData.avatar,
      isAdmin: userData.id === ADMIN_ID
    }, JWT_SECRET, { expiresIn: '7d' });

    // Set cookie
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.redirect('/dashboard');
  } catch (error) {
    console.error('Auth error:', error);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.redirect('/');
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
  try {
    const stats = await getAllStats();
    res.render('dashboard', { 
      user: req.user, 
      stats,
      isAdmin: req.user.discordId === ADMIN_ID 
    });
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

app.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const stats = await getAllStats();
    res.render('admin', { user: req.user, stats });
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

app.post('/admin/upload', isAuthenticated, isAdmin, upload.single('file'), async (req, res) => {
  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[0]) {
        const t5Deaths = parseInt(row[4]) || 0;
        const t4Deaths = parseInt(row[5]) || 0;
        const deads = t5Deaths + t4Deaths;
        
        await upsertStats(
          String(row[0]),
          row[1] || '',
          parseInt(row[2]) || 0,
          parseInt(row[3]) || 0,
          deads,
          parseInt(row[6]) || 0,
          parseInt(row[7]) || 0
        );
      }
    }
    
    res.redirect('/admin?success=1');
  } catch (error) {
    res.redirect('/admin?error=' + encodeURIComponent(error.message));
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getAllStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server on port ${PORT}`));
}

module.exports = app;
