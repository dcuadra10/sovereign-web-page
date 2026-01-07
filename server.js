const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const xlsx = require('xlsx');
require('dotenv').config();

const { initDB, getAllStats, getKingdomTotals, upsertStats, createStatsWithInitial, upsertUser, getUser, linkGovernor, setConfig, getConfig, clearAllStats, getAllTiers, upsertTier, deleteTier, getAdmins, addAdmin, removeAdmin } = require('./database');

const app = express();
const JWT_SECRET = process.env.SESSION_SECRET || 'super-secret-key';

initDB();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Auth
function getUserFromToken(req) { try { return jwt.verify(req.cookies.auth_token, JWT_SECRET); } catch { return null; } }
function isAuthenticated(req, res, next) { const user = getUserFromToken(req); if (user) { req.user = user; return next(); } res.redirect('/login'); }

// Dynamic Admin Check
async function isAdmin(req, res, next) {
  const user = getUserFromToken(req);
  if (!user) return res.status(403).send('Forbidden');
  
  const admins = await getAdmins();
  if (admins.find(a => a.discord_id === user.discordId)) {
    req.user = user;
    return next();
  }
  res.status(403).send('Forbidden: Not an admin');
}

// Helpers
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
    kingdom: findColumnIndex(headers, ['Kingdom', 'Origin', 'Server']),
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
      kingdom: cols.kingdom !== -1 && row[cols.kingdom] ? String(row[cols.kingdom]) : '',
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
    if (!tier) return { ...stat, tier: null, killReq: 0, deathReq: 0, killProgress: 0, deathProgress: 0, isCompliant: false };
    
    const killReq = Math.floor(power * Number(tier.kill_multiplier));
    const deathReq = Math.floor(power * Number(tier.death_multiplier));
    
    const initialKills = Number(stat.initial_kill_points) || 0;
    const currentKills = Number(stat.total_kill_points) || 0;
    const killsGained = currentKills - initialKills;
    
    const initialDeads = Number(stat.initial_deads) || 0;
    const currentDeads = Number(stat.deads) || 0;
    const deadsGained = currentDeads - initialDeads;
    
    const killProgress = killReq > 0 ? (killsGained / killReq) * 100 : 100;
    const deathProgress = deathReq > 0 ? (deadsGained / deathReq) * 100 : 100;
    
    const isCompliant = killProgress >= 100 && deathProgress >= 100;

    return {
      ...stat, tier, killReq, deathReq, killsGained, deadsGained, 
      killProgress: Math.min(100, Math.round(killProgress * 10) / 10),
      deathProgress: Math.min(100, Math.round(deathProgress * 10) / 10),
      rawKillProgress: killProgress,
      rawDeathProgress: deathProgress,
      isCompliant
    };
  });
}

// Routes
app.get('/login', (req, res) => { const user = getUserFromToken(req); if (user) return res.redirect('/dashboard'); res.render('login'); });

app.get('/stats', async (req, res) => {
  try {
    const stats = await getAllStats(); const totals = await getKingdomTotals(); const tiers = await getAllTiers(); const sp = await calculateProgress(stats, tiers);
    const currentKvK = await getConfig('current_kvk') || 'Unknown Season';
    res.render('stats', { stats: sp, totals, tiers, currentKvK });
  } catch { res.status(500).send('Error'); }
});

app.get('/auth/discord', (req, res) => res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_CALLBACK_URL)}&response_type=code&scope=identify guilds`));

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code; if (!code) return res.redirect('/login?error=no_code');
  try {
    const tr = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.DISCORD_CALLBACK_URL }) });
    const td = await tr.json(); if (!td.access_token) return res.redirect('/login?error=token_failed');
    
    const ur = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${td.access_token}` } });
    const ud = await ur.json(); await upsertUser(ud.id, ud.username, ud.avatar);
    
    // Check if admin to set flag
    const admins = await getAdmins();
    const isAdminUser = admins.some(a => a.discord_id === ud.id);

    const token = jwt.sign({ discordId: ud.id, username: ud.username, avatar: ud.avatar, isAdmin: isAdminUser, accessToken: td.access_token }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('auth_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7*24*60*60*1000 });
    res.redirect('/dashboard');
  } catch { res.redirect('/login?error=auth_failed'); }
});
app.get('/logout', (req, res) => { res.clearCookie('auth_token'); res.redirect('/'); });

app.post('/link-account', isAuthenticated, async (req, res) => {
  const { governorId } = req.body;
  try {
    const guildId = await getConfig('discord_guild_id');
    if (!guildId) return res.status(400).send('Server ID not configured.');
    const gr = await fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${req.user.accessToken}` } });
    if (!gr.ok) return res.status(400).send('Relogin required.');
    const guilds = await gr.json();
    if (!guilds.some(g => g.id === guildId)) return res.status(403).send('Not in Discord Server.');
    const stats = await getAllStats();
    if (!stats.find(s => s.governor_id === governorId)) return res.status(404).send('ID not found.');
    await linkGovernor(req.user.discordId, governorId);
    res.redirect('/dashboard?success=linked');
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
  try {
    const stats = await getAllStats(); const totals = await getKingdomTotals(); const tiers = await getAllTiers(); const sp = await calculateProgress(stats, tiers);
    const currentKvK = await getConfig('current_kvk') || 'Unknown Season';
    const dbUser = await getUser(req.user.discordId);
    
    // Refresh admin status in case it changed
    const admins = await getAdmins();
    const isAdminUser = admins.some(a => a.discord_id === req.user.discordId);
    
    res.render('dashboard', { user: { ...req.user, ...dbUser }, stats: sp, totals, tiers, currentKvK, isAdmin: isAdminUser });
  } catch { res.status(500).send('Error'); }
});

// Admin Routes
app.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
  try { 
    const stats = await getAllStats(); const tiers = await getAllTiers(); const admins = await getAdmins();
    const guildId = await getConfig('discord_guild_id');
    const currentKvK = await getConfig('current_kvk') || '';
    res.render('admin', { user: req.user, stats, tiers, admins, guildId, currentKvK }); 
  } catch { res.status(500).send('Error'); }
});

app.post('/admin/config', isAuthenticated, isAdmin, async (req, res) => { try { await setConfig('discord_guild_id', req.body.guildId); res.redirect('/admin?success=config_saved'); } catch(e) { res.redirect('/admin?error='+e.message); }});

app.post('/admin/kvk', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { kvkName, action } = req.body; await setConfig('current_kvk', kvkName);
    if (action === 'reset') { await clearAllStats(); res.redirect('/admin?success=kvk_reset'); } else { res.redirect('/admin?success=kvk_saved'); }
  } catch(e) { res.redirect('/admin?error='+e.message); }
});

app.post('/admin/manage-admins', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { discordId, note, action } = req.body;
        if (action === 'add') await addAdmin(discordId, note);
        else if (action === 'remove') await removeAdmin(discordId);
        res.redirect('/admin?success=admin_updated');
    } catch(e) { res.redirect('/admin?error='+e.message); }
});

app.post('/admin/tier', isAuthenticated, isAdmin, async (req, res) => { try { await upsertTier(req.body.id||null, req.body.name, parseInt(req.body.minPower), parseInt(req.body.maxPower), parseFloat(req.body.killMultiplier), parseFloat(req.body.deathMultiplier)); res.redirect('/admin?success=tier_saved'); } catch (e) { res.redirect('/admin?error='+e.message); }});
app.post('/admin/tier/delete', isAuthenticated, isAdmin, async (req, res) => { try { await deleteTier(req.body.id); res.redirect('/admin?success=tier_deleted'); } catch { res.redirect('/admin?error=delete_failed'); }});

app.post('/admin/upload/creation', isAuthenticated, isAdmin, upload.single('file'), async (req, res) => { try { if (!req.file) return res.status(400).send('No file'); const r = parseExcelData(req.file.buffer); if (!r.length) return res.status(400).send('No records'); await clearAllStats(); for (const x of r) await createStatsWithInitial(x.governorId, x.username, x.kingdom, x.highestPower, x.deads, x.killPoints, x.resources); res.status(200).send(`Done: ${r.length}`); } catch (e) { res.status(500).send(e.message); }});
app.post('/admin/upload/update', isAuthenticated, isAdmin, upload.single('file'), async (req, res) => { try { if (!req.file) return res.status(400).send('No file'); const r = parseExcelData(req.file.buffer); if (!r.length) return res.status(400).send('No records'); for (const x of r) await upsertStats(x.governorId, x.username, x.kingdom, x.highestPower, x.deads, x.killPoints, x.resources); res.status(200).send(`Done: ${r.length}`); } catch (e) { res.status(500).send(e.message); }});

// Reports API with more filtering options
app.get('/api/reports/non-compliant', isAuthenticated, isAdmin, async (req, res) => {
    const stats = await getAllStats(); const tiers = await getAllTiers(); const sp = await calculateProgress(stats, tiers);
    const list = sp.filter(s => !s.isCompliant).map(s => `${s.username} [${s.governor_id}] - Kills: ${s.killProgress}%, Deaths: ${s.deathProgress}%`);
    res.json(list);
});
app.get('/api/reports/top', isAuthenticated, isAdmin, async (req, res) => {
    const limit = parseInt(req.query.limit) || 10;
    const stats = await getAllStats(); const tiers = await getAllTiers(); const sp = await calculateProgress(stats, tiers);
    sp.sort((a,b) => (b.rawKillProgress + b.rawDeathProgress) - (a.rawKillProgress + a.rawDeathProgress));
    const list = sp.slice(0, limit).map(s => `Top ${sp.indexOf(s)+1}: ${s.username} - Total Score: ${(s.killProgress+s.deathProgress).toFixed(1)}%`);
    res.json(list);
});

app.get('/api/stats', async (req, res) => { try { const stats = await getAllStats(); const tiers = await getAllTiers(); const sp = await calculateProgress(stats, tiers); res.json(sp); } catch { res.status(500).json({ error: 'Error' }); }});

if (process.env.NODE_ENV !== 'production') { app.listen(process.env.PORT || 3000, () => console.log('Server running')); }
module.exports = app;
