const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const xlsx = require('xlsx');
require('dotenv').config();

const { initDB, getAllStats, getKingdomTotals, upsertStats, createStatsWithInitial, upsertUser, getUser, linkGovernor, setConfig, getConfig, clearAllStats, getAllTiers, upsertTier, deleteTier, getAdmins, addAdmin, removeAdmin, createBackup, getBackups, deleteBackup } = require('./database');

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

// Auth & Admin Middleware
function getUserFromToken(req) { try { return jwt.verify(req.cookies.auth_token, JWT_SECRET); } catch { return null; } }
function isAuthenticated(req, res, next) { const user = getUserFromToken(req); if (user) { req.user = user; return next(); } res.redirect('/login'); }
async function isAdmin(req, res, next) {
  const user = getUserFromToken(req); if (!user) return res.status(403).send('Forbidden');
  const admins = await getAdmins(); if (admins.find(a => a.discord_id === user.discordId)) { req.user = user; return next(); }
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

function parseNumber(str) {
    if (!str) return 0;
    if (typeof str === 'number') return str;
    const s = str.toString().toLowerCase().trim();
    let mult = 1;
    if (s.endsWith('b')) mult = 1000000000;
    else if (s.endsWith('m')) mult = 1000000;
    else if (s.endsWith('k')) mult = 1000;
    
    return Math.floor(parseFloat(s.replace(/[^\d\.]/g, '')) * mult);
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
  if (cols.governorId === -1) cols.governorId = 0; if (cols.username === -1 && headers.length > 1) cols.username = 1;
  const records = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i]; if (!row || !row[cols.governorId]) continue;
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
    const killsGained = (Number(stat.total_kill_points) || 0) - (Number(stat.initial_kill_points) || 0);
    const deadsGained = (Number(stat.deads) || 0) - (Number(stat.initial_deads) || 0);
    const killProgress = killReq > 0 ? (killsGained / killReq) * 100 : 100;
    const deathProgress = deathReq > 0 ? (deadsGained / deathReq) * 100 : 100;
    return {
      ...stat, tier, killReq, deathReq, killsGained, deadsGained, 
      killProgress: Math.min(100, Math.round(killProgress * 10) / 10),
      deathProgress: Math.min(100, Math.round(deathProgress * 10) / 10),
      rawKillProgress: killProgress, rawDeathProgress: deathProgress,
      isCompliant: killProgress >= 100 && deathProgress >= 100
    };
  });
}

// Routes
app.get('/login', (req, res) => { const user = getUserFromToken(req); if (user) return res.redirect('/dashboard'); res.render('login'); });
app.get('/stats', async (req, res) => { try { const s = await getAllStats(); const t = await getKingdomTotals(); const tiers = await getAllTiers(); const sp = await calculateProgress(s, tiers); const k = await getConfig('current_kvk') || 'Unknown'; res.render('stats', { stats: sp, totals: t, tiers, currentKvK: k }); } catch { res.status(500).send('Error'); } });

app.get('/auth/discord', (req, res) => res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_CALLBACK_URL)}&response_type=code&scope=identify guilds`));
app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code; if (!code) return res.redirect('/login');
  try {
    const tr = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.DISCORD_CALLBACK_URL }) });
    const td = await tr.json(); if (!td.access_token) return res.redirect('/login?err=1');
    const ur = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${td.access_token}` } });
    const ud = await ur.json(); await upsertUser(ud.id, ud.username, ud.avatar);
    const admins = await getAdmins(); const isAdminUser = admins.some(a => a.discord_id === ud.id);
    const token = jwt.sign({ discordId: ud.id, username: ud.username, avatar: ud.avatar, isAdmin: isAdminUser, accessToken: td.access_token }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('auth_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7*24*60*60*1000 });
    res.redirect('/dashboard');
  } catch { res.redirect('/login?err=2'); }
});
app.get('/logout', (req, res) => { res.clearCookie('auth_token'); res.redirect('/'); });

app.post('/link-account', isAuthenticated, async (req, res) => {
  try {
    const gid = await getConfig('discord_guild_id'); if (!gid) return res.status(400).send('No Guild ID');
    const gr = await fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${req.user.accessToken}` } });
    if (!gr.ok) return res.status(400).send('Relogin');
    const guilds = await gr.json(); if (!guilds.some(g => g.id === gid)) return res.status(403).send('Not in server');
    const s = await getAllStats(); if (!s.find(x => x.governor_id === req.body.governorId)) return res.status(404).send('ID not found');
    await linkGovernor(req.user.discordId, req.body.governorId); res.redirect('/dashboard?ok=1');
  } catch(e) { res.status(500).send(e.message); }
});

app.get('/dashboard', isAuthenticated, async (req, res) => { try { const s = await getAllStats(); const t = await getKingdomTotals(); const tiers = await getAllTiers(); const sp = await calculateProgress(s, tiers); const k = await getConfig('current_kvk'); const u = await getUser(req.user.discordId); const a = await getAdmins(); res.render('dashboard', { user: {...req.user, ...u}, stats: sp, totals: t, tiers, currentKvK: k, isAdmin: a.some(admin=>admin.discord_id===req.user.discordId) }); } catch { res.status(500).send('Error'); } });

// Admin
app.get('/admin', isAuthenticated, isAdmin, async (req, res) => { 
  try { 
    const s = await getAllStats(); const t = await getAllTiers(); const a = await getAdmins(); const backups = await getBackups(); 
    const g = await getConfig('discord_guild_id'); 
    const k = await getConfig('current_kvk');
    const lastK = await getConfig('last_scan_kingdom');
    const lastD = await getConfig('last_scan_end_date');
    
    res.render('admin', { user: req.user, stats: s, tiers: t, admins: a, backups, guildId: g, currentKvK: k, lastK, lastD }); 
  } catch { res.status(500).send('Error'); } 
});

app.post('/admin/config', isAuthenticated, isAdmin, async (req, res) => { await setConfig('discord_guild_id', req.body.guildId); res.redirect('/admin'); });
app.post('/admin/kvk', isAuthenticated, isAdmin, async (req, res) => {
    const kvk = await getConfig('current_kvk');
    if (req.body.action === 'reset') {
        await createBackup(`Auto-Backup (Reset ${kvk})`, kvk, 'Reset Action');
        await clearAllStats();
    }
    await setConfig('current_kvk', req.body.kvkName);
    res.redirect('/admin?ok=kvk');
});
app.post('/admin/manage-admins', isAuthenticated, isAdmin, async (req, res) => { if (req.body.action==='add') await addAdmin(req.body.discordId, req.body.note); else await removeAdmin(req.body.discordId); res.redirect('/admin'); });

// --- TIER PARSING LOGIC HERE ---
app.post('/admin/tier', isAuthenticated, isAdmin, async (req, res) => { 
    try {
        const min = parseNumber(req.body.minPower);
        const max = parseNumber(req.body.maxPower);
        await upsertTier(
            req.body.id||null, 
            req.body.name, 
            min, 
            max, 
            parseFloat(req.body.killMultiplier), 
            parseFloat(req.body.deathMultiplier)
        ); 
        res.redirect('/admin?ok=tier'); 
    } catch(e) { res.redirect('/admin?err=' + e.message); }
});
// ------------------------------

app.post('/admin/tier/delete', isAuthenticated, isAdmin, async (req, res) => { await deleteTier(req.body.id); res.redirect('/admin'); });

app.post('/admin/backup/delete', isAuthenticated, isAdmin, async (req, res) => { await deleteBackup(req.body.id); res.redirect('/admin?ok=del_backup'); });

// Upload with Validation
app.post('/admin/upload/:type', isAuthenticated, isAdmin, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file');
        const r = parseExcelData(req.file.buffer);
        if (!r.length) return res.status(400).send('No records');

        const filename = req.file.originalname; // e.g., 3386-2026-01-05-2026-01-20.xlsx
        const match = filename.match(/^(\d+)-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})/);
        const force = req.query.force === 'true';

        // Validation only for UPDATE
        if (req.params.type === 'update' && match && !force) {
            const newKingdom = match[1];
            const newStart = match[2];
            const oldKindgom = await getConfig('last_scan_kingdom');
            const oldEnd = await getConfig('last_scan_end_date');

            if (oldKindgom && oldKindgom !== newKingdom) {
                return res.status(409).json({ warning: `Kingdom mismatch! Previous: ${oldKindgom}, File: ${newKingdom}. Use same Kingdom?` });
            }
            if (oldEnd && oldEnd !== newStart) {
                return res.status(409).json({ warning: `Date gap! Previous ended: ${oldEnd}, File starts: ${newStart}. Recommendation: Match start date with previous end date.` });
            }
        }

        if (req.params.type === 'creation') {
            const kvk = await getConfig('current_kvk');
            await createBackup(`Auto-Backup (New List ${kvk})`, kvk, filename);
            await clearAllStats();
            for (const x of r) await createStatsWithInitial(x.governorId, x.username, x.kingdom, x.highestPower, x.deads, x.killPoints, x.resources);
        } else {
            for (const x of r) await upsertStats(x.governorId, x.username, x.kingdom, x.highestPower, x.deads, x.killPoints, x.resources);
        }

        // Save new config
        if (match) {
            await setConfig('last_scan_kingdom', match[1]);
            await setConfig('last_scan_end_date', match[3]);
        }

        res.status(200).send(`Done: ${r.length}`);
    } catch (e) { res.status(500).send(e.message); }
});

// Reports
app.get('/api/reports/non-compliant', isAuthenticated, isAdmin, async (req, res) => { const s = await getAllStats(); const t = await getAllTiers(); const sp = await calculateProgress(s, t); res.json(sp.filter(x=>!x.isCompliant).map(x=>`${x.governor_id} ${x.username} - Kills: ${x.killProgress}% | Deaths: ${x.deathProgress}%`)); });
app.get('/api/reports/top', isAuthenticated, isAdmin, async (req, res) => { const s = await getAllStats(); const t = await getAllTiers(); const sp = await calculateProgress(s, t); sp.sort((a,b)=>(b.rawKillProgress+b.rawDeathProgress)-(a.rawKillProgress+a.rawDeathProgress)); res.json(sp.slice(0, parseInt(req.query.limit)||10).map((x,i)=>`Top ${i+1}: ${x.governor_id} ${x.username} - Score: ${(x.killProgress+x.deathProgress).toFixed(1)}%`)); });
app.get('/api/stats', async (req, res) => { const s = await getAllStats(); const t = await getAllTiers(); const sp = await calculateProgress(s, t); res.json(sp); });

if (process.env.NODE_ENV !== 'production') { app.listen(process.env.PORT || 3000, () => console.log('Server running')); }
module.exports = app;
