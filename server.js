const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const xlsx = require('xlsx');
require('dotenv').config();

const { initDB, getAllStats, upsertStats, createStatsWithInitial, upsertUser, clearAllStats, getAllTiers, upsertTier, deleteTier } = require('./database');

const app = express();
const JWT_SECRET = process.env.SESSION_SECRET || 'super-secret-key';
const ADMIN_ID = '1211770249200795734';

initDB();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files FIRST
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  const user = getUserFromToken(req);
  if (user && user.discordId === ADMIN_ID) { req.user = user; return next(); }
  res.status(403).send('Forbidden');
}

function findColumnIndex(headers, possibleNames) {
  for (const name of possibleNames) {
    const index = headers.findIndex(h => h && h.toString().toLowerCase().includes(name.toLowerCase()));
    if (index !== -1) return index;
  }
  return -1;
}

function parseExcelData(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
  
  if (data.length < 2) throw new Error('Excel file is empty');
  
  const headers = data[0].map(h => h ? h.toString() : '');
  const cols = {
    governorId: findColumnIndex(headers, ['Character ID', 'Governor ID', 'ID']),
    username: findColumnIndex(headers, ['Username', 'Name', 'Player']),
    highestPower: findColumnIndex(headers, ['Highest Power', 'Max Power']),
    t5Deaths: findColumnIndex(headers, ['T5 Deaths', 'T5 Dead']),
    t4Deaths: findColumnIndex(headers, ['T4 Deaths', 'T4 Dead']),
    killPoints: findColumnIndex(headers, ['Total Kill Points', 'Kill Points', 'Kills']),
    resources: findColumnIndex(headers, ['Resources Gathered', 'Resources', 'RSS'])
  };
  
  if (cols.governorId === -1) cols.governorId = 0;
  if (cols.username === -1 && headers.length > 1) cols.username = 1;
  
  const records = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[cols.governorId]) continue;
    
    const t5 = cols.t5Deaths !== -1 ? parseInt(row[cols.t5Deaths]) || 0 : 0;
    const t4 = cols.t4Deaths !== -1 ? parseInt(row[cols.t4Deaths]) || 0 : 0;
    
    records.push({
      governorId: String(row[cols.governorId]),
      username: cols.username !== -1 && row[cols.username] ? String(row[cols.username]) : 'N/A',
      highestPower: cols.highestPower !== -1 ? parseInt(row[cols.highestPower]) || 0 : 0,
      deads: t5 + t4,
      killPoints: cols.killPoints !== -1 ? parseInt(row[cols.killPoints]) || 0 : 0,
      resources: cols.resources !== -1 ? parseInt(row[cols.resources]) || 0 : 0
    });
  }
  return records;
}

async function calculateProgress(stats, tiers) {
  return stats.map(stat => {
    const power = Number(stat.initial_power) || Number(stat.highest_power) || 0;
    const tier = tiers.find(t => power >= Number(t.min_power) && power < Number(t.max_power));
    
    if (!tier) return { ...stat, tier: null, killReq: 0, deathReq: 0, killProgress: 0, deathProgress: 0 };
    
    const killReq = Math.floor(power * Number(tier.kill_multiplier));
    const deathReq = Number(tier.death_requirement);
    
    const initialKills = Number(stat.initial_kill_points) || 0;
    const currentKills = Number(stat.total_kill_points) || 0;
    const killsGained = currentKills - initialKills;
    
    const initialDeads = Number(stat.initial_deads) || 0;
    const currentDeads = Number(stat.deads) || 0;
    const deadsGained = currentDeads - initialDeads;
    
    const killProgress = killReq > 0 ? Math.min(100, (killsGained / killReq) * 100) : 100;
    const deathProgress = deathReq > 0 ? Math.min(100, (deadsGained / deathReq) * 100) : 100;
    
    return {
      ...stat, tier, killReq, deathReq, killsGained, deadsGained,
      killProgress: Math.round(killProgress * 10) / 10,
      deathProgress: Math.round(deathProgress * 10) / 10
    };
  });
}

// HOME - serves index.html from public folder automatically

// LOGIN page
app.get('/login', (req, res) => {
  const user = getUserFromToken(req);
  if (user) return res.redirect('/dashboard');
  res.render('login');
});

// Public stats
app.get('/stats', async (req, res) => {
  try {
    const stats = await getAllStats();
    const tiers = await getAllTiers();
    const statsWithProgress = await calculateProgress(stats, tiers);
    res.render('stats', { stats: statsWithProgress, tiers });
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

app.get('/auth/discord', (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.DISCORD_CALLBACK_URL);
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=identify`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/login?error=no_code');
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
    if (!tokenData.access_token) return res.redirect('/login?error=token_failed');
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
  } catch (error) { res.redirect('/login?error=auth_failed'); }
});

app.get('/logout', (req, res) => { res.clearCookie('auth_token'); res.redirect('/'); });

app.get('/dashboard', isAuthenticated, async (req, res) => {
  try {
    const stats = await getAllStats();
    const tiers = await getAllTiers();
    const statsWithProgress = await calculateProgress(stats, tiers);
    res.render('dashboard', { user: req.user, stats: statsWithProgress, tiers, isAdmin: req.user.discordId === ADMIN_ID });
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

app.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const stats = await getAllStats();
    const tiers = await getAllTiers();
    res.render('admin', { user: req.user, stats, tiers });
  } catch (error) { res.status(500).send('Error: ' + error.message); }
});

app.post('/admin/tier', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { id, name, minPower, maxPower, killMultiplier, deathRequirement } = req.body;
    await upsertTier(id || null, name, parseInt(minPower), parseInt(maxPower), parseFloat(killMultiplier), parseInt(deathRequirement));
    res.redirect('/admin?success=tier_saved');
  } catch (error) { res.redirect('/admin?error=' + encodeURIComponent(error.message)); }
});

app.post('/admin/tier/delete', isAuthenticated, isAdmin, async (req, res) => {
  try {
    await deleteTier(req.body.id);
    res.redirect('/admin?success=tier_deleted');
  } catch (error) { res.redirect('/admin?error=' + encodeURIComponent(error.message)); }
});

app.post('/admin/upload/creation', isAuthenticated, isAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded');
    const records = parseExcelData(req.file.buffer);
    if (records.length === 0) return res.status(400).send('No valid records');
    await clearAllStats();
    for (const r of records) {
      await createStatsWithInitial(r.governorId, r.username, r.highestPower, r.deads, r.killPoints, r.resources);
    }
    res.status(200).send(`Creation complete! Added ${records.length} records`);
  } catch (error) { res.status(500).send('Upload failed: ' + error.message); }
});

app.post('/admin/upload/update', isAuthenticated, isAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded');
    const records = parseExcelData(req.file.buffer);
    if (records.length === 0) return res.status(400).send('No valid records');
    for (const r of records) {
      await upsertStats(r.governorId, r.username, r.highestPower, r.deads, r.killPoints, r.resources);
    }
    res.status(200).send(`Update complete! Processed ${records.length} records`);
  } catch (error) { res.status(500).send('Upload failed: ' + error.message); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getAllStats();
    const tiers = await getAllTiers();
    const statsWithProgress = await calculateProgress(stats, tiers);
    res.json(statsWithProgress);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(process.env.PORT || 3000, () => console.log('Server running'));
}

module.exports = app;
