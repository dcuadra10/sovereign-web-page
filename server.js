const express = require('express');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const xlsx = require('xlsx');
require('dotenv').config();

const { initDB, getAllStats, upsertStats } = require('./database');
const { passport, ADMIN_ID } = require('./auth');

const app = express();

// Initialize database on startup
initDB();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'super-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 
  }
}));

// Passport
app.use(passport.initialize());
app.use(passport.session());

// Middleware to check auth
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

function isAdmin(req, res, next) {
  if (req.isAuthenticated() && req.user.discordId === ADMIN_ID) return next();
  res.status(403).send('Forbidden');
}

// File upload
const upload = multer({ dest: '/tmp/uploads/' });

// Routes
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/dashboard');
  }
  res.render('login');
});

// Public stats page (no login required)
app.get('/stats', async (req, res) => {
  try {
    const stats = await getAllStats();
    res.render('stats', { stats });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).send('Error loading stats');
  }
});

app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => {
    res.redirect('/dashboard');
  }
);

app.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
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
    console.error('Dashboard error:', error);
    res.status(500).send('Error loading dashboard');
  }
});

app.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const stats = await getAllStats();
    res.render('admin', { user: req.user, stats });
  } catch (error) {
    console.error('Admin error:', error);
    res.status(500).send('Error loading admin panel');
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
    console.error('Upload error:', error);
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
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
