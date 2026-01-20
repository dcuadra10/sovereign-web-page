const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const xlsx = require('xlsx');
const crypto = require('crypto');
const http = require('http'); // Native HTTP
require('dotenv').config();

const { initDB, getAllStats, getKingdomTotals, upsertStats, createStatsWithInitial, upsertUser, getUser, getUserByEmail, linkGovernor, getLinkedUsers, unlinkUser, setConfig, getConfig, clearAllStats, getAllTiers, upsertTier, deleteTier, getAdmins, getAdminsWithDetails, addAdmin, removeAdmin, createBackup, getBackups, getBackupById, deleteBackup, createAnnouncement, getAnnouncements, getAnnouncementsForUser, deleteAnnouncement, getProjectInfo, setProjectInfo,
    createRole, getRoles, deleteRole, assignRoleToUser, removeRoleFromUser, getUserRoles, getUsersByRole,
    createForm, getActiveForms, getAllFormsAdmin, getFormById, toggleFormStatus, deleteForm, submitFormResponse, getFormResponses, hasUserCompletedForm,
    saveChatMessage, getRecentChatMessages
} = require('./database');

const app = express();
const server = http.createServer(app);
const JWT_SECRET = process.env.SESSION_SECRET || 'super-secret-key';

// Socket.IO Setup
let io;
try {
    const { Server } = require("socket.io");
    io = new Server(server);
    console.log('Socket.io initialized');
} catch (e) {
    console.log('Socket.io verification failed (run npm install socket.io)');
}

// Email Setup
let transporter = null;
try {
    const nodemailer = require('nodemailer');
    if (process.env.EMAIL_USER) {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
    }
} catch (e) { }

async function sendEmailNotification(recipients, subject, content) {
    const validEmails = recipients.filter(e => e && e.includes('@'));
    if (validEmails.length === 0) return;
    if (transporter) {
        try {
            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                bcc: validEmails,
                subject: `Sovereign Empire: ${subject}`,
                html: `<div style="font-family:sans-serif; padding:20px; background:#f4f4f4;"><div style="max-width:600px; margin:0 auto; background:white; padding:20px; border-radius:10px;"><h2 style="color:#7c3aed;">${subject}</h2><div style="line-height:1.6;">${content}</div><hr style="margin:20px 0; border:none; border-top:1px solid #eee;"><p style="font-size:12px; color:#888;">Sovereign Empire Notification</p></div></div>`
            });
            console.log(`Email sent to ${validEmails.length} recipients.`);
        } catch (e) { console.error('Email Error:', e); }
    } else {
        console.log(`[MOCK EMAIL] TO: ${validEmails.length} users | SUBJECT: ${subject}`);
    }
}

initDB();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function hashPassword(password) { const salt = crypto.randomBytes(16).toString('hex'); const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex'); return `${salt}:${hash}`; }
function verifyPassword(password, storedHash) { if (!storedHash) return false; const [salt, key] = storedHash.split(':'); const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex'); return key === hash; }

function getUserFromToken(req) { try { return jwt.verify(req.cookies.auth_token, JWT_SECRET); } catch { return null; } }
function isAuthenticated(req, res, next) { const user = getUserFromToken(req); if (user) { req.user = user; return next(); } res.redirect('/login'); }
async function isAdmin(req, res, next) { const user = getUserFromToken(req); if (!user) return res.status(403).send('Forbidden'); const admins = await getAdmins(); if (user.discordId && admins.find(a => a.discord_id === user.discordId)) { req.user = user; return next(); } res.status(403).send('Forbidden'); }

// ONBOARDING CHECK
async function checkOnboarding(req, res, next) {
    if (!req.user) return next();
    if (req.path.startsWith('/admin') || req.path.startsWith('/logout') || req.path.startsWith('/api') || req.path.match(/^\/forms\/\d+/)) return next();

    const onboardingId = await getConfig('onboarding_form_id');
    if (onboardingId) {
        const completed = await hasUserCompletedForm(req.user.discordId || req.user.email, onboardingId);
        if (!completed) {
            return res.redirect(`/forms/${onboardingId}?onboarding=true`);
        }
    }
    next();
}

// === NEW MARKDOWN PARSER ===
function parseMarkdown(text) {
    if (!text) return '';
    let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = html.split('\n');
    let output = [];
    let inCodeBlock = false;
    for (let line of lines) {
        if (line.trim().startsWith('```')) { inCodeBlock = !inCodeBlock; output.push(inCodeBlock ? '<pre style="background:rgba(0,0,0,0.3); padding:15px; border-radius:8px; overflow-x:auto; font-family:monospace; line-height:1.2; border:1px solid rgba(255,255,255,0.1);">' : '</pre>'); continue; }
        if (inCodeBlock) { output.push(line); continue; }
        if (line.match(/^#\s+(.*)/)) { line = line.replace(/^#\s+(.*)/, '<h2 style="color:#a78bfa; margin:15px 0 10px; font-size:1.4rem; border-bottom:1px solid rgba(167,139,250,0.3); padding-bottom:5px;">$1</h2>'); }
        else if (line.match(/^##\s+(.*)/)) { line = line.replace(/^##\s+(.*)/, '<h3 style="color:#c4b5fd; font-size:1.2rem; margin:12px 0 8px;">$1</h3>'); }
        else if (line.match(/^###\s+(.*)/)) { line = line.replace(/^###\s+(.*)/, '<h4 style="color:#ddd; font-size:1.1rem; margin:10px 0;">$1</h4>'); }
        else if (line.match(/^>\s+(.*)/)) { line = line.replace(/^>\s+(.*)/, '<blockquote style="border-left:4px solid #7c3aed; background:rgba(124,58,237,0.1); padding:10px 15px; margin:10px 0; color:#e2e8f0; font-style:italic; border-radius:0 8px 8px 0;">$1</blockquote>'); }
        else if (line.match(/^\s*-\s+(.*)/) || line.match(/^\s*\*\s+(.*)/)) { line = line.replace(/^\s*[-*]\s+(.*)/, '<div style="display:flex; gap:8px; align-items:flex-start; margin-bottom:4px;"><span style="color:#a78bfa;"></span><span>$1</span></div>'); }
        else if (line.match(/^\s*-#\s+(.*)/)) { line = line.replace(/^\s*-#\s+(.*)/, '<div style="margin-left:20px; font-size:0.85rem; opacity:0.7; font-style:italic;">$1</div>'); }
        else { if (line.trim().length > 0) line += '<br>'; }
        line = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/__(.*?)__/g, '<u>$1</u>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/`(.*?)`/g, '<code style="background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; font-family:monospace; color:#f472b6;">$1</code>').replace(/&lt;@(\d+)&gt;/g, '<span style="color:#a78bfa; background:rgba(124, 58, 237, 0.15); padding:2px 6px; border-radius:4px; font-weight:500;">@Member</span>').replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#38bdf8; text-decoration:underline;">$1</a>');
        output.push(line);
    }
    return output.join('\n');
}

function findColumnIndex(headers, possibleNames) { for (const name of possibleNames) { let index = headers.findIndex(h => h && h.toString().toLowerCase() === name.toLowerCase()); if (index !== -1) return index; index = headers.findIndex(h => h && h.toString().toLowerCase().includes(name.toLowerCase())); if (index !== -1) return index; } return -1; }
function parseNumber(str) { if (!str) return 0; if (typeof str === 'number') return str; const s = str.toString().toLowerCase().trim(); let mult = 1; if (s.endsWith('b')) mult = 1000000000; else if (s.endsWith('m')) mult = 1000000; else if (s.endsWith('k')) mult = 1000; return Math.floor(parseFloat(s.replace(/[^\d\.]/g, '')) * mult); }
function parseExcelData(buffer) { const workbook = xlsx.read(buffer, { type: 'buffer' }); const sheet = workbook.Sheets[workbook.SheetNames[0]]; const data = xlsx.utils.sheet_to_json(sheet, { header: 1 }); if (data.length < 2) throw new Error('Excel file is empty'); const headers = data[0].map(h => h ? h.toString() : ''); const cols = { governorId: findColumnIndex(headers, ['Character ID', 'Governor ID', 'ID']), username: findColumnIndex(headers, ['Username', 'Name', 'Player']), kingdom: findColumnIndex(headers, ['Kingdom', 'Origin', 'Server']), power: findColumnIndex(headers, ['Power', 'Current Power']), t5Deaths: findColumnIndex(headers, ['T5 Deaths', 'T5 Dead']), t4Deaths: findColumnIndex(headers, ['T4 Deaths', 'T4 Dead']), killPoints: findColumnIndex(headers, ['Total Kill Points', 'Kill Points', 'Kills']), resources: findColumnIndex(headers, ['Resources Gathered', 'Resources', 'RSS']) }; if (cols.power === -1) { cols.power = findColumnIndex(headers, ['Highest Power', 'Max Power']); } if (cols.governorId === -1) cols.governorId = 0; if (cols.username === -1 && headers.length > 1) cols.username = 1; const records = []; for (let i = 1; i < data.length; i++) { const row = data[i]; if (!row || !row[cols.governorId]) continue; const t5 = cols.t5Deaths !== -1 ? parseInt(row[cols.t5Deaths]) || 0 : 0; const t4 = cols.t4Deaths !== -1 ? parseInt(row[cols.t4Deaths]) || 0 : 0; records.push({ governorId: String(row[cols.governorId]), username: cols.username !== -1 && row[cols.username] ? String(row[cols.username]) : 'N/A', kingdom: cols.kingdom !== -1 && row[cols.kingdom] ? String(row[cols.kingdom]) : '', highestPower: cols.power !== -1 ? parseInt(row[cols.power]) || 0 : 0, deads: t5 + t4, killPoints: cols.killPoints !== -1 ? parseInt(row[cols.killPoints]) || 0 : 0, resources: cols.resources !== -1 ? parseInt(row[cols.resources]) || 0 : 0 }); } return records; }
async function calculateProgress(stats, tiers) { return stats.map(stat => { const power = Number(stat.initial_power) || Number(stat.highest_power) || 0; const tier = tiers.find(t => power >= Number(t.min_power) && power < Number(t.max_power)); if (!tier) return { ...stat, tier: null, killReq: 0, deathReq: 0, killProgress: 0, deathProgress: 0, isCompliant: false }; const killReq = Math.floor(power * Number(tier.kill_multiplier)); const deathReq = Math.floor(power * Number(tier.death_multiplier)); const killsGained = (Number(stat.total_kill_points) || 0) - (Number(stat.initial_kill_points) || 0); const deadsGained = (Number(stat.deads) || 0) - (Number(stat.initial_deads) || 0); const killProgress = killReq > 0 ? (killsGained / killReq) * 100 : 100; const deathProgress = deathReq > 0 ? (deadsGained / deathReq) * 100 : 100; return { ...stat, tier, killReq, deathReq, killsGained, deadsGained, killProgress: Math.min(100, Math.round(killProgress * 10) / 10), deathProgress: Math.min(100, Math.round(deathProgress * 10) / 10), rawKillProgress: killProgress, rawDeathProgress: deathProgress, isCompliant: killProgress >= 100 && deathProgress >= 100 }; }); }

// SOCKET LOGIC
if (io) {
    io.on('connection', async (socket) => {
        const msgs = await getRecentChatMessages();
        socket.emit('history', msgs);

        socket.on('chatMessage', async (data) => {
            // Data received: { userId, username, avatar, message }
            if (!data.message || !data.message.trim()) return;
            // Basic sanitization
            const cleanMsg = data.message.replace(/</g, "&lt;").replace(/>/g, "&gt;");

            await saveChatMessage(data.userId, data.username, data.avatar, cleanMsg);
            io.emit('message', { ...data, message: cleanMsg, created_at: new Date() });
        });
    });
}

// ROUTES
app.get('/', async (req, res) => { try { const isVisible = await getConfig('public_stats_visible'); const user = getUserFromToken(req); res.render('index', { statsVisible: isVisible !== 'false', user }); } catch (e) { res.status(500).send(e.message); } });
app.get('/login', (req, res) => { const u = getUserFromToken(req); if (u) return res.redirect('/dashboard'); res.render('login', { error: req.query.err ? 'Login failed.' : null }); });
app.get('/register', (req, res) => { res.render('register', { error: req.query.err }); });
app.post('/register', async (req, res) => { try { const { username, email, password } = req.body; if (!email || !password || password.length < 6) return res.render('register', { error: 'Invalid input.' }); const existing = await getUserByEmail(email); if (existing) return res.render('register', { error: 'Email exists.' }); const uuid = crypto.randomUUID(); const hash = hashPassword(password); await upsertUser(uuid, username, null, email, hash); const token = jwt.sign({ discordId: uuid, username, email, isAdmin: false }, JWT_SECRET, { expiresIn: '7d' }); res.cookie('auth_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }); res.redirect('/dashboard'); } catch (e) { res.render('register', { error: 'Error: ' + e.message }); } });
app.post('/login', async (req, res) => { try { const { email, password } = req.body; const user = await getUserByEmail(email); if (!user || !verifyPassword(password, user.password_hash)) return res.redirect('/login?err=1'); const admins = await getAdmins(); const isAdminUser = admins.some(a => a.discord_id === user.discord_id); const token = jwt.sign({ discordId: user.discord_id, username: user.username, email: user.email, avatar: user.avatar, isAdmin: isAdminUser }, JWT_SECRET, { expiresIn: '7d' }); res.cookie('auth_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }); res.redirect('/dashboard'); } catch (e) { res.redirect('/login?err=1'); } });
app.get('/auth/discord', (req, res) => res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_CALLBACK_URL)}&response_type=code&scope=identify guilds guilds.members.read email`));
app.get('/auth/discord/callback', async (req, res) => { const code = req.query.code; if (!code) return res.redirect('/login'); try { const tr = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.DISCORD_CALLBACK_URL }) }); const td = await tr.json(); if (!td.access_token) return res.redirect('/login?err=1'); const ur = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${td.access_token}` } }); const ud = await ur.json(); await upsertUser(ud.id, ud.username, ud.avatar, ud.email); const admins = await getAdmins(); const isAdminUser = admins.some(a => a.discord_id === ud.id); const token = jwt.sign({ discordId: ud.id, username: ud.username, avatar: ud.avatar, email: ud.email, isAdmin: isAdminUser, accessToken: td.access_token }, JWT_SECRET, { expiresIn: '7d' }); res.cookie('auth_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }); res.redirect('/dashboard'); } catch { res.redirect('/login?err=2'); } });
app.get('/logout', (req, res) => { res.clearCookie('auth_token'); res.redirect('/'); });

// DASHBOARD (Apply Onboarding Check Here)
app.get('/dashboard', isAuthenticated, checkOnboarding, async (req, res) => {
    try {
        const isVisible = await getConfig('public_stats_visible');
        const s = await getAllStats(); const t = await getKingdomTotals(); const tiers = await getAllTiers(); const sp = await calculateProgress(s, tiers);
        const k = await getConfig('current_kvk');
        const u = await getUser(req.user.discordId);
        const a = await getAdmins();
        const adminList = await getAdminsWithDetails();
        const lastStart = await getConfig('season_start_date');
        const forms = await getActiveForms();
        const userRoles = await getUserRoles(req.user.discordId);
        let announcements = await getAnnouncementsForUser(req.user.discordId);
        announcements = announcements.map(a => ({ ...a, content: parseMarkdown(a.content) }));
        let projectInfo = await getProjectInfo();
        projectInfo = parseMarkdown(projectInfo);

        // Modules Config
        const modules = {
            announcements: await getConfig('mod_announcements') || 'true',
            project_info: await getConfig('mod_project_info') || 'true',
            discord: await getConfig('mod_discord') || 'true',
            forms: await getConfig('mod_forms') || 'true'
        };

        res.render('dashboard', { user: { ...req.user, ...(u || {}) }, stats: sp, totals: t, tiers, currentKvK: k, seasonStart: lastStart, isAdmin: a.some(admin => admin.discord_id === req.user.discordId), statsVisible: isVisible !== 'false', announcements, projectInfo, adminList, forms, userRoles, modules });
    } catch (e) { res.status(500).send('Error loading dashboard: ' + e.message); }
});

// FORM ROUTES
app.get('/forms/:id', isAuthenticated, async (req, res) => { try { const form = await getFormById(req.params.id); if (!form || (!form.is_active && !req.user.isAdmin)) return res.status(404).send('Form unavailable'); res.render('form-view', { form, user: req.user, isOnboarding: req.query.onboarding === 'true' }); } catch (e) { res.status(500).send(e.message); } });
app.post('/forms/:id/submit', isAuthenticated, upload.any(), async (req, res) => {
    try {
        const form = await getFormById(req.params.id);
        if (!form) return res.status(404).send('Form not found');

        const answers = { ...req.body };
        if (req.files && req.files.length) {
            req.files.forEach(f => {
                answers[f.fieldname] = `data:${f.mimetype};base64,${f.buffer.toString('base64')}`;
                answers[f.fieldname + '_name'] = f.originalname;
            });
        }

        await submitFormResponse(form.id, req.user.discordId || req.user.email, req.user.username, answers);

        // 1. Assign Global Role (if set)
        if (form.assign_role_id) {
            await assignRoleToUser(req.user.discordId, form.assign_role_id);
        }

        // 2. Assign Answer-Specific Roles (If Configured)
        if (form.schema && Array.isArray(form.schema)) {
            for (const field of form.schema) {
                if (field.roleMap && answers[field.label]) {
                    const selectedValue = answers[field.label];
                    const roleIdToAssign = field.roleMap[selectedValue];
                    if (roleIdToAssign) {
                        try {
                            await assignRoleToUser(req.user.discordId || req.user.email /*Fallback for non-discord users logic*/, roleIdToAssign);
                            console.log(`Assigned mapped role ${roleIdToAssign} to User for answer "${selectedValue}"`);
                        } catch (err) { console.error('Error assigning role:', err); }
                    }
                }
            }
        }

        res.send('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3;url=/dashboard" /><title>Submitted</title><style>body{background:#0f172a;color:white;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;}</style></head><body><h1> Submitted Successfully!</h1><p>Redirecting to dashboard...</p></body></html>');
    } catch (e) { res.status(500).send(e.message); }
});

// ADMIN (Config Onboarding)
app.post('/admin/onboarding', isAuthenticated, isAdmin, async (req, res) => { await setConfig('onboarding_form_id', req.body.formId); res.redirect('/admin/forms'); });

// ADMIN ROUTES (Standard)
app.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const s = await getAllStats();
        const t = await getAllTiers();
        const a = await getAdmins();
        const backups = await getBackups() || [];
        const g = await getConfig('discord_guild_id') || '';
        const r = await getConfig('discord_role_id') || '';
        const k = await getConfig('current_kvk') || '';
        const linked = await getLinkedUsers() || [];
        const statsVisible = await getConfig('public_stats_visible');
        const announcements = await getAnnouncements();
        const projectInfo = await getProjectInfo();
        const roles = await getRoles();

        // Modules Config
        const modules = {
            announcements: await getConfig('mod_announcements') || 'true',
            project_info: await getConfig('mod_project_info') || 'true',
            discord: await getConfig('mod_discord') || 'true',
            data: await getConfig('mod_data') || 'true',
            backups: await getConfig('mod_backups') || 'true',
            forms: await getConfig('mod_forms') || 'true'
        };

        res.render('admin', { user: req.user, stats: s, tiers: t, admins: a, backups, linkedUsers: linked, guildId: g, roleId: r, currentKvK: k, statsVisible: statsVisible !== 'false', announcements, projectInfo, roles, modules });
    } catch (e) { res.status(500).send('Admin Panel Error: ' + e.message); }
});

app.post('/admin/modules', isAuthenticated, isAdmin, async (req, res) => {
    await setConfig('mod_announcements', req.body.mod_announcements ? 'true' : 'false');
    await setConfig('mod_project_info', req.body.mod_project_info ? 'true' : 'false');
    await setConfig('mod_discord', req.body.mod_discord ? 'true' : 'false');
    await setConfig('mod_data', req.body.mod_data ? 'true' : 'false');
    await setConfig('mod_backups', req.body.mod_backups ? 'true' : 'false');
    await setConfig('mod_forms', req.body.mod_forms ? 'true' : 'false');
    res.redirect('/admin?ok=modules_updated');
});
app.post('/admin/announcement', isAuthenticated, isAdmin, async (req, res) => { if (req.body.action === 'create') { const targetRoleId = req.body.roleId && req.body.roleId !== 'all' ? parseInt(req.body.roleId) : null; await createAnnouncement(req.body.title, req.body.content, targetRoleId); const recipients = targetRoleId ? (await getUsersByRole(targetRoleId)).map(u => u.email) : []; if (recipients.length && recipients.length < 50) sendEmailNotification(recipients, req.body.title, parseMarkdown(req.body.content)); } else if (req.body.action === 'delete') { await deleteAnnouncement(req.body.id); } res.redirect('/admin?ok=announcement'); });
app.get('/admin/forms', isAuthenticated, isAdmin, async (req, res) => { const forms = await getAllFormsAdmin(); const roles = await getRoles(); const onboardingId = await getConfig('onboarding_form_id'); res.render('admin-forms', { forms, roles, user: req.user, onboardingId }); });
app.post('/admin/forms/create', isAuthenticated, isAdmin, async (req, res) => { await createForm(req.body.title, req.body.description, JSON.parse(req.body.schema), req.body.assignRoleId || null); res.redirect('/admin/forms'); });
app.post('/admin/forms/toggle', isAuthenticated, isAdmin, async (req, res) => { await toggleFormStatus(req.body.id); res.redirect('/admin/forms'); });
app.post('/admin/forms/delete', isAuthenticated, isAdmin, async (req, res) => { await deleteForm(req.body.id); res.redirect('/admin/forms'); });
app.get('/admin/forms/:id/responses', isAuthenticated, isAdmin, async (req, res) => { const form = await getFormById(req.params.id); const responses = await getFormResponses(req.params.id); res.render('admin-form-responses', { form, responses, user: req.user }); });
app.post('/admin/roles/create', isAuthenticated, isAdmin, async (req, res) => { await createRole(req.body.name, req.body.color); res.redirect('/admin/forms'); });
app.post('/admin/roles/delete', isAuthenticated, isAdmin, async (req, res) => { await deleteRole(req.body.id); res.redirect('/admin/forms'); });

// Other Admin Post Routes
app.post('/admin/project-info', isAuthenticated, isAdmin, async (req, res) => { await setProjectInfo(req.body.content); res.redirect('/admin?ok=info_upd'); });
app.post('/admin/toggle-stats', isAuthenticated, isAdmin, async (req, res) => { const current = await getConfig('public_stats_visible'); await setConfig('public_stats_visible', current === 'false' ? 'true' : 'false'); res.redirect('/admin?ok=visibility_toggle'); });
app.post('/admin/unlink', isAuthenticated, isAdmin, async (req, res) => { await unlinkUser(req.body.discordId); res.redirect('/admin?ok=unlink'); });
app.post('/admin/config', isAuthenticated, isAdmin, async (req, res) => { await setConfig('discord_guild_id', req.body.guildId); await setConfig('discord_role_id', req.body.roleId); res.redirect('/admin'); });
app.post('/admin/kvk', isAuthenticated, isAdmin, async (req, res) => { const kvk = await getConfig('current_kvk'); if (req.body.action === 'reset') { await createBackup(`Auto-Backup (Reset ${kvk})`, kvk, 'Reset Action'); await clearAllStats(); } await setConfig('current_kvk', req.body.kvkName); res.redirect('/admin?ok=kvk'); });
app.post('/admin/manage-admins', isAuthenticated, isAdmin, async (req, res) => { if (req.body.action === 'add') await addAdmin(req.body.discordId, req.body.note); else await removeAdmin(req.body.discordId); res.redirect('/admin'); });
app.post('/admin/tier', isAuthenticated, isAdmin, async (req, res) => { try { const min = parseNumber(req.body.minPower); const max = parseNumber(req.body.maxPower); await upsertTier(req.body.id || null, req.body.name, min, max, parseFloat(req.body.killMultiplier), parseFloat(req.body.deathMultiplier)); res.redirect('/admin?ok=tier'); } catch (e) { res.redirect('/admin?err=' + e.message); } });
app.post('/admin/tier/delete', isAuthenticated, isAdmin, async (req, res) => { await deleteTier(req.body.id); res.redirect('/admin'); });
app.post('/admin/backup/delete', isAuthenticated, isAdmin, async (req, res) => { await deleteBackup(req.body.id); res.redirect('/admin?ok=del_backup'); });
app.get('/admin/backup/download/:id', isAuthenticated, isAdmin, async (req, res) => { try { const b = await getBackupById(req.params.id); if (!b) return res.status(404).send('Backup not found'); res.setHeader('Content-Disposition', `attachment; filename="backup-${b.kvk_season}-${b.id}.json"`); res.setHeader('Content-Type', 'application/json'); res.send(JSON.stringify(b.data, null, 2)); } catch (e) { res.status(500).send(e.message); } });
app.post('/admin/upload/:type', isAuthenticated, isAdmin, upload.single('file'), async (req, res) => { try { if (!req.file) return res.status(400).send('No file'); const r = parseExcelData(req.file.buffer); if (!r.length) return res.status(400).send('No records'); const filename = req.file.originalname; const match = filename.match(/^(\d+)-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})/); const force = req.query.force === 'true'; if (req.params.type === 'update' && match && !force) { const newKingdom = match[1]; const newStart = match[2]; const oldKindgom = await getConfig('last_scan_kingdom'); const oldEnd = await getConfig('last_scan_end_date'); if (oldKindgom && oldKindgom !== newKingdom) { return res.status(409).json({ warning: `Kingdom mismatch! Previous: ${oldKindgom}, File: ${newKingdom}. Use same Kingdom?` }); } if (oldEnd && oldEnd !== newStart) { return res.status(409).json({ warning: `Date gap! Previous ended: ${oldEnd}, File starts: ${newStart}. Recommendation: Match start date with previous end date.` }); } } if (req.params.type === 'creation') { const kvk = await getConfig('current_kvk'); await createBackup(`Auto-Backup (New List ${kvk})`, kvk, filename); await clearAllStats(); for (const x of r) await createStatsWithInitial(x.governorId, x.username, x.kingdom, x.highestPower, x.deads, x.killPoints, x.resources); if (match) await setConfig('season_start_date', match[2]); } else { for (const x of r) await upsertStats(x.governorId, x.username, x.kingdom, x.highestPower, x.deads, x.killPoints, x.resources); } if (match) { await setConfig('last_scan_kingdom', match[1]); await setConfig('last_scan_end_date', match[3]); } res.status(200).send(`Done: ${r.length}`); } catch (e) { res.status(500).send(e.message); } });
app.post('/link-account', isAuthenticated, async (req, res) => { try { const guildId = await getConfig('discord_guild_id'); const roleId = await getConfig('discord_role_id'); const s = await getAllStats(); if (!s.find(x => x.governor_id === req.body.governorId)) { return res.redirect('/dashboard?error=Governor ID not found in the stats list.'); } if (req.user.accessToken) { if (!guildId) return res.redirect('/dashboard?error=Guild Config Missing'); const memberReq = await fetch(`https://discord.com/api/users/@me/guilds/${guildId}/member`, { headers: { Authorization: `Bearer ${req.user.accessToken}` } }); if (!memberReq.ok) return res.redirect('/dashboard?error=Verify Failed'); const member = await memberReq.json(); if (roleId && (!member.roles || !member.roles.includes(roleId))) return res.redirect('/dashboard?error=Missing Role'); } await linkGovernor(req.user.discordId, req.body.governorId); res.redirect('/dashboard?success=Account Linked'); } catch (e) { res.redirect('/dashboard?error=' + encodeURIComponent(e.message)); } });
app.get('/stats', async (req, res) => { try { const isVisible = await getConfig('public_stats_visible'); if (isVisible === 'false') { return res.send('<!DOCTYPE html><html lang="en"><head><title>Maintenance</title><style>body{background:#0f0c29;color:white;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;}</style></head><body><div style="text-align:center;"><h1> Stats Temporarily Unavailable</h1><p>We are updating the data. Please check back later.</p><a href="/" style="color:#a78bfa;">Return Home</a></div></body></html>'); } const s = await getAllStats(); const t = await getKingdomTotals(); const tiers = await getAllTiers(); const sp = await calculateProgress(s, tiers); sp.sort((a, b) => { const scoreA = a.killsGained + (a.deadsGained * 2); const scoreB = b.killsGained + (b.deadsGained * 2); return scoreB - scoreA; }); const k = await getConfig('current_kvk') || 'Unknown'; res.render('stats', { stats: sp, totals: t, tiers, currentKvK: k }); } catch { res.status(500).send('Error'); } });
app.get('/api/reports/non-compliant', isAuthenticated, isAdmin, async (req, res) => { const s = await getAllStats(); const t = await getAllTiers(); const sp = await calculateProgress(s, t); res.json(sp.filter(x => !x.isCompliant).map(x => `${x.governor_id} ${x.username}`)); });
app.get('/api/reports/top', isAuthenticated, isAdmin, async (req, res) => { const s = await getAllStats(); const t = await getAllTiers(); const sp = await calculateProgress(s, t); sp.sort((a, b) => { const scoreA = a.killsGained + (a.deadsGained * 2); const scoreB = b.killsGained + (b.deadsGained * 2); return scoreB - scoreA; }); res.json(sp.slice(0, parseInt(req.query.limit) || 10).map((x, i) => `Top ${i + 1}: ${x.governor_id} ${x.username}`)); });
app.get('/api/stats', async (req, res) => { const s = await getAllStats(); const t = await getAllTiers(); const sp = await calculateProgress(s, t); res.json(sp); });

if (process.env.NODE_ENV !== 'production') { server.listen(process.env.PORT || 3000, () => console.log('Server running on port ' + (process.env.PORT || 3000))); }
module.exports = app;
