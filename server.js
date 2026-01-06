const express = require('express');
const path = require('path');
const session = require('express-session');
const { createServer } = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const xlsx = require('xlsx');
require('dotenv').config();

const db = require('./database');
const { passport, ADMIN_ID } = require('./auth');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

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
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
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
const upload = multer({ dest: 'uploads/' });

// Routes
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/dashboard');
  }
  res.render('login');
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

app.get('/dashboard', isAuthenticated, (req, res) => {
  const stats = db.prepare('SELECT * FROM stats').all();
  res.render('dashboard', { 
    user: req.user, 
    stats,
    isAdmin: req.user.discordId === ADMIN_ID 
  });
});

app.get('/admin', isAuthenticated, isAdmin, (req, res) => {
  const stats = db.prepare('SELECT * FROM stats').all();
  res.render('admin', { user: req.user, stats });
});

app.post('/admin/upload', isAuthenticated, isAdmin, upload.single('file'), (req, res) => {
  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    
    // Skip header row
    const stmt = db.prepare(`
      INSERT INTO stats (governorId, username, power, highestPower, deads, totalKillPoints, resourcesGathered)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(governorId) DO UPDATE SET
        username = excluded.username,
        power = excluded.power,
        highestPower = excluded.highestPower,
        deads = excluded.deads,
        totalKillPoints = excluded.totalKillPoints,
        resourcesGathered = excluded.resourcesGathered
    `);
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[0]) {
        // Combine T5 Deaths (index 4) + T4 Deaths (index 5) into deads
        const t5Deaths = parseInt(row[4]) || 0;
        const t4Deaths = parseInt(row[5]) || 0;
        const deads = t5Deaths + t4Deaths;
        
        stmt.run(
          String(row[0]),  // governorId
          row[1] || '',    // username
          parseInt(row[2]) || 0, // power
          parseInt(row[3]) || 0, // highestPower
          deads,           // deads (T4 + T5)
          parseInt(row[6]) || 0, // totalKillPoints (adjust index based on Excel)
          parseInt(row[7]) || 0  // resourcesGathered (adjust index based on Excel)
        );
      }
    }
    
    res.redirect('/admin?success=1');
  } catch (error) {
    console.error('Upload error:', error);
    res.redirect('/admin?error=' + encodeURIComponent(error.message));
  }
});

// API endpoint for stats
app.get('/api/stats', (req, res) => {
  const stats = db.prepare('SELECT * FROM stats').all();
  res.json(stats);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
