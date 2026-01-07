const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const xlsx = require('xlsx');
require('dotenv').config();

const { initDB, getAllStats, upsertStats, upsertUser, getUser, clearAllStats } = require('./database');

const app = express();
const JWT_SECRET = process.env.SESSION_SECRET || 'super-secret-key';
const ADMIN_ID = '1211770249200795734';

initDB();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

function getUserFromToken(req) {
  try {
    const token = req.cookies.auth_token;
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch { return null; }
}

function isAuthenticated(req, res, next) {
  const user = getUserFromToken(req);
  if (user) { req.user = user; return next(); }
  res.redirect('/');
}

function isAdmin(req, res, next) {
  const user = getUserFromToken(req);
  if (user && user.discordId === ADMIN_ID) { req.user = user; return next(); }
  res.status(403).send('Forbidden');
}

// Helper function to find column index by header name
function findColumnIndex(headers, possibleNames) {
  for (const name of possibleNames) {
    const index = headers.findIndex(h => 
      h && h.toString().toLowerCase().includes(name.toLowerCase())
    );
    if (index !== -1) return index;
  }
  return -1;
}

// Parse Excel data - more lenient, uses defaults for missing columns
function parseExcelData(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
  
  if (data.length < 2) throw new Error('Excel file is empty or has no data rows');
  
  const headers = data[0].map(h => h ? h.toString() : '');
  console.log('Excel Headers:', headers);
  
  // Find column indices - all optional except we need at least an ID
  const cols = {
    governorId: findColumnIndex(headers, ['Character ID', 'Governor ID', 'ID', 'Gov ID']),
    username: findColumnIndex(headers, ['Username', 'Name', 'Player', 'Nickname']),
    highestPower: findColumnIndex(headers, ['Highest Power', 'Max Power', 'Peak Power']),
    t5Deaths: findColumnIndex(headers, ['T5 Deaths', 'T5 Dead', 'T5']),
    t4Deaths: findColumnIndex(headers, ['T4 Deaths', 'T4 Dead', 'T4']),
    killPoints: findColumnIndex(headers, ['Total Kill Points', 'Kill Points', 'Kills', 'KP']),
    resources: findColumnIndex(headers, ['Resources Gathered', 'Resources', 'RSS', 'Gathered'])
  };
  
  console.log('Found column indices:', cols);
  
  // If no Governor ID column found, use first column
  if (cols.governorId === -1) {
    console.log('No ID column found, using first column');
    cols.governorId = 0;
  }
  
  // If no username column found, use second column or N/A
  if (cols.username === -1 && headers.length > 1) {
    cols.username = 1;
  }
  
  const records = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    
    // Skip empty rows
    if (!row || row.length === 0) continue;
    
    const governorId = row[cols.governorId];
    if (!governorId) continue; // Skip if no ID
    
    const t5Deaths = cols.t5Deaths !== -1 && row[cols.t5Deaths] !== undefined ? parseInt(row[cols.t5Deaths]) || 0 : 0;
    const t4Deaths = cols.t4Deaths !== -1 && row[cols.t4Deaths] !== undefined ? parseInt(row[cols.t4Deaths]) || 0 : 0;
    
    records.push({
      governorId: String(governorId),
      username: cols.username !== -1 && row[cols.username] ? String(row[cols.username]) : 'N/A',
      highestPower: cols.highestPower !== -1 && row[cols.highestPower] !== undefined ? parseInt(row[cols.highestPower]) || 0 : 0,
      deads: t5Deaths + t4Deaths,
      killPoints: cols.killPoints !== -1 && row[cols.killPoints] !== undefined ? parseInt(row[cols.killPoints]) || 0 : 0,
      resources: cols.resources !== -1 && row[cols.resources] !== undefined ? parseInt(row[cols.resources]) || 0 : 0
    });
  }
  
  console.log(`Parsed ${records.length} records`);
  return records;
}

// Routes
app.get('/', (req, res) => {
  const user = getUserFromToken(req);
  if (user) return res.redirect('/dashboard');
  res.render('login');
});

app.get('/stats', async (req, res) => {
  try {
    const stats = await getAllStats();
    res.render('stats', { stats });
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

app.get('/auth/discord', (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.DISCORD_CALLBACK_URL);
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=identify`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code, redirect_uri: process.env.DISCORD_CALLBACK_URL
      })
    });
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) return res.redirect('/?error=token_failed');

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userResponse.json();
    await upsertUser(userData.id, userData.username, userData.avatar);

    const token = jwt.sign({
      discordId: userData.id, username: userData.username,
      avatar: userData.avatar, isAdmin: userData.id === ADMIN_ID
    }, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('auth_token', token, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.redirect('/dashboard');
  } catch (error) { res.redirect('/?error=auth_failed'); }
});

app.get('/logout', (req, res) => { res.clearCookie('auth_token'); res.redirect('/'); });

app.get('/dashboard', isAuthenticated, async (req, res) => {
  try {
    const stats = await getAllStats();
    res.render('dashboard', { user: req.user, stats, isAdmin: req.user.discordId === ADMIN_ID });
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

app.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const stats = await getAllStats();
    res.render('admin', { user: req.user, stats });
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

// CREATION upload - clears all data and uploads fresh
app.post('/admin/upload/creation', isAuthenticated, isAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded');
    
    const records = parseExcelData(req.file.buffer);
    if (records.length === 0) return res.status(400).send('No valid records found in file');
    
    await clearAllStats();
    
    for (const record of records) {
      await upsertStats(
        record.governorId, record.username, record.highestPower,
        record.deads, record.killPoints, record.resources
      );
    }
    
    res.status(200).send(`Creation complete! Cleared old data and added ${records.length} records`);
  } catch (error) {
    console.error('Creation upload error:', error);
    res.status(500).send('Upload failed: ' + error.message);
  }
});

// UPDATE upload - updates existing data, adds new entries
app.post('/admin/upload/update', isAuthenticated, isAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded');
    
    const records = parseExcelData(req.file.buffer);
    if (records.length === 0) return res.status(400).send('No valid records found in file');
    
    for (const record of records) {
      await upsertStats(
        record.governorId, record.username, record.highestPower,
        record.deads, record.killPoints, record.resources
      );
    }
    
    res.status(200).send(`Update complete! Processed ${records.length} records`);
  } catch (error) {
    console.error('Update upload error:', error);
    res.status(500).send('Upload failed: ' + error.message);
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getAllStats();
    res.json(stats);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server on port ${PORT}`));
}

module.exports = app;
