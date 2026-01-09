const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function initDB() {
  try {
    await sql`CREATE TABLE IF NOT EXISTS users (discord_id TEXT UNIQUE, username TEXT, avatar TEXT, governor_id TEXT)`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS governor_id TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`;

    await sql`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`;
    
    await sql`
      CREATE TABLE IF NOT EXISTS stats (
        governor_id TEXT PRIMARY KEY, username TEXT, kingdom TEXT,
        highest_power BIGINT DEFAULT 0, deads BIGINT DEFAULT 0, total_kill_points BIGINT DEFAULT 0, resources_gathered BIGINT DEFAULT 0,
        initial_power BIGINT DEFAULT 0, initial_deads BIGINT DEFAULT 0, initial_kill_points BIGINT DEFAULT 0
      )
    `;
    await sql`ALTER TABLE stats ADD COLUMN IF NOT EXISTS kingdom TEXT`;
    await sql`ALTER TABLE stats ADD COLUMN IF NOT EXISTS initial_power BIGINT DEFAULT 0`;
    await sql`ALTER TABLE stats ADD COLUMN IF NOT EXISTS initial_deads BIGINT DEFAULT 0`;
    await sql`ALTER TABLE stats ADD COLUMN IF NOT EXISTS initial_kill_points BIGINT DEFAULT 0`;
    
    await sql`
        CREATE TABLE IF NOT EXISTS tiers (
            id SERIAL PRIMARY KEY, name TEXT NOT NULL, min_power BIGINT NOT NULL, max_power BIGINT NOT NULL,
            kill_multiplier DECIMAL(5,2) DEFAULT 1.00, death_multiplier DECIMAL(5,4) DEFAULT 0.0000
        )
    `;
    
    await sql`CREATE TABLE IF NOT EXISTS admins (discord_id TEXT PRIMARY KEY, note TEXT)`;
    await sql`INSERT INTO admins (discord_id, note) VALUES ('1211770249200795734', 'Super Admin') ON CONFLICT DO NOTHING`;
    
    await sql`
        CREATE TABLE IF NOT EXISTS backups (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            data JSONB NOT NULL,
            kvk_season TEXT,
            filename TEXT
        )
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS announcements (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `;
    console.log('Database initialized and migrated');
  } catch (error) { console.error('DB init error:', error); }
}

async function upsertUser(id, username, avatar, email=null, passHash=null) {
  if (email) {
      await sql`INSERT INTO users (discord_id, username, avatar, email, password_hash) VALUES (${id}, ${username}, ${avatar}, ${email}, ${passHash}) 
      ON CONFLICT (discord_id) DO UPDATE SET username=EXCLUDED.username, avatar=EXCLUDED.avatar, email=EXCLUDED.email, password_hash=EXCLUDED.password_hash`;
  } else {
      await sql`INSERT INTO users (discord_id, username, avatar) VALUES (${id}, ${username}, ${avatar}) 
      ON CONFLICT (discord_id) DO UPDATE SET username = EXCLUDED.username, avatar = EXCLUDED.avatar`;
  }
}
async function linkGovernor(userId, governorId) { await sql`UPDATE users SET governor_id = ${governorId} WHERE discord_id = ${userId}`; }
async function getUser(id) { const r = await sql`SELECT * FROM users WHERE discord_id = ${id}`; return r[0] || null; }
async function getUserByEmail(email) { const r = await sql`SELECT * FROM users WHERE email = ${email}`; return r[0] || null; }
async function getLinkedUsers() { return await sql`SELECT * FROM users WHERE governor_id IS NOT NULL`; }
async function unlinkUser(id) { await sql`UPDATE users SET governor_id = NULL WHERE discord_id = ${id}`; }

async function setConfig(key, value) { await sql`INSERT INTO config (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`; }
async function getConfig(key) { const r = await sql`SELECT value FROM config WHERE key = ${key}`; return r[0]?.value || null; }

async function getAllStats() { return await sql`SELECT * FROM stats ORDER BY highest_power DESC`; }
async function getKingdomTotals() { const r = await sql`SELECT COUNT(*) as count, SUM(highest_power) as total_power, SUM(total_kill_points) as total_kills, SUM(deads) as total_deads FROM stats`; return r[0]; }
async function upsertStats(govId, name, kingdom, power, deads, kills, rss) {
  await sql`
    INSERT INTO stats (governor_id, username, kingdom, highest_power, deads, total_kill_points, resources_gathered, initial_power, initial_deads, initial_kill_points) 
    VALUES (${govId}, ${name}, ${kingdom}, ${power}, ${deads}, ${kills}, ${rss}, ${power}, ${deads}, ${kills}) 
    ON CONFLICT (governor_id) DO UPDATE SET username = EXCLUDED.username, kingdom = EXCLUDED.kingdom, highest_power = EXCLUDED.highest_power, deads = EXCLUDED.deads, total_kill_points = EXCLUDED.total_kill_points, resources_gathered = EXCLUDED.resources_gathered
  `;
}
async function createStatsWithInitial(govId, name, kingdom, power, deads, kills, rss) {
  await sql`
    INSERT INTO stats (governor_id, username, kingdom, highest_power, deads, total_kill_points, resources_gathered, initial_power, initial_deads, initial_kill_points) 
    VALUES (${govId}, ${name}, ${kingdom}, ${power}, ${deads}, ${kills}, ${rss}, ${power}, ${deads}, ${kills}) 
    ON CONFLICT (governor_id) DO UPDATE SET username = EXCLUDED.username, kingdom = EXCLUDED.kingdom, highest_power = EXCLUDED.highest_power, deads = EXCLUDED.deads, total_kill_points = EXCLUDED.total_kill_points, resources_gathered = EXCLUDED.resources_gathered, initial_power = EXCLUDED.initial_power, initial_deads = EXCLUDED.initial_deads, initial_kill_points = EXCLUDED.initial_kill_points
  `;
}
async function clearAllStats() { await sql`DELETE FROM stats`; }
async function getAllTiers() { return await sql`SELECT * FROM tiers ORDER BY min_power ASC`; }
async function upsertTier(id, name, min, max, killMult, deathMult) { if (id) await sql`UPDATE tiers SET name=${name}, min_power=${min}, max_power=${max}, kill_multiplier=${killMult}, death_multiplier=${deathMult} WHERE id=${id}`; else await sql`INSERT INTO tiers (name, min_power, max_power, kill_multiplier, death_multiplier) VALUES (${name}, ${min}, ${max}, ${killMult}, ${deathMult})`; }
async function deleteTier(id) { await sql`DELETE FROM tiers WHERE id = ${id}`; }

async function getAdmins() { return await sql`SELECT * FROM admins`; }
async function getAdminsWithDetails() { 
    return await sql`
        SELECT a.discord_id, a.note, u.username, u.avatar 
        FROM admins a 
        LEFT JOIN users u ON a.discord_id = u.discord_id
    `; 
}
async function addAdmin(discordId, note) { await sql`INSERT INTO admins (discord_id, note) VALUES (${discordId}, ${note}) ON CONFLICT (discord_id) DO UPDATE SET note = EXCLUDED.note`; }
async function removeAdmin(discordId) { await sql`DELETE FROM admins WHERE discord_id = ${discordId}`; }

async function createBackup(name, kvk, filename) { const stats = await getAllStats(); if (stats.length === 0) return; await sql`INSERT INTO backups (name, data, kvk_season, filename) VALUES (${name}, ${JSON.stringify(stats)}, ${kvk}, ${filename})`; }
async function getBackups() { return await sql`SELECT id, name, created_at, kvk_season, filename, jsonb_array_length(data) as count FROM backups ORDER BY created_at DESC`; }
async function getBackupById(id) { const r = await sql`SELECT * FROM backups WHERE id = ${id}`; return r[0]; }
async function deleteBackup(id) { await sql`DELETE FROM backups WHERE id = ${id}`; }

async function createAnnouncement(title, content) { await sql`INSERT INTO announcements (title, content) VALUES (${title}, ${content})`; }
async function getAnnouncements() { return await sql`SELECT * FROM announcements ORDER BY created_at DESC`; }
async function deleteAnnouncement(id) { await sql`DELETE FROM announcements WHERE id = ${id}`; }
async function getProjectInfo() { return await getConfig('project_info_text'); }
async function setProjectInfo(text) { await setConfig('project_info_text', text); }

module.exports = {
  sql, initDB, upsertUser, getUser, getUserByEmail, linkGovernor, getLinkedUsers, unlinkUser, setConfig, getConfig,
  getAllStats, getKingdomTotals, upsertStats, createStatsWithInitial, clearAllStats, getAllTiers, upsertTier, deleteTier,
  getAdmins, getAdminsWithDetails, addAdmin, removeAdmin,
  createBackup, getBackups, getBackupById, deleteBackup,
  createAnnouncement, getAnnouncements, deleteAnnouncement, getProjectInfo, setProjectInfo
};
