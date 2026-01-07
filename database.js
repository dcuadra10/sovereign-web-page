const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function initDB() {
  try {
    await sql`CREATE TABLE IF NOT EXISTS users (discord_id TEXT PRIMARY KEY, username TEXT, avatar TEXT)`;
    
    await sql`
      CREATE TABLE IF NOT EXISTS stats (
        governor_id TEXT PRIMARY KEY,
        username TEXT,
        highest_power BIGINT DEFAULT 0,
        deads BIGINT DEFAULT 0,
        total_kill_points BIGINT DEFAULT 0,
        resources_gathered BIGINT DEFAULT 0,
        initial_power BIGINT DEFAULT 0,
        initial_deads BIGINT DEFAULT 0,
        initial_kill_points BIGINT DEFAULT 0
      )
    `;

    // Drop old tiers table to recreate with correct columns
    // NOTE: This will wipe existing tiers, but it's cleaner for schema change
    // If you want to keep tiers, we would alter table, but for dev speed recreating is safer to avoid type mismatch
    // But since user might have tiers, let's try to alter first
    
    await sql`
      CREATE TABLE IF NOT EXISTS tiers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        min_power BIGINT NOT NULL,
        max_power BIGINT NOT NULL,
        kill_multiplier DECIMAL(5,2) DEFAULT 1.00,
        death_multiplier DECIMAL(5,4) DEFAULT 0.0000 -- e.g. 0.01 = 1%
      )
    `;

    // Add columns/rename if needed
    try {
        // Check if death_requirement exists (old column)
        const check = await sql`SELECT column_name FROM information_schema.columns WHERE table_name='tiers' AND column_name='death_requirement'`;
        if (check.length > 0) {
            await sql`ALTER TABLE tiers DROP COLUMN death_requirement`;
            await sql`ALTER TABLE tiers ADD COLUMN death_multiplier DECIMAL(5,4) DEFAULT 0.0000`;
            console.log('Migrated tiers table: Dropped death_requirement, added death_multiplier');
        }
    } catch (e) {
        console.log('Migration check skipped/failed', e.message);
    }
    
    try {
      await sql`ALTER TABLE stats ADD COLUMN IF NOT EXISTS initial_power BIGINT DEFAULT 0`;
      await sql`ALTER TABLE stats ADD COLUMN IF NOT EXISTS initial_deads BIGINT DEFAULT 0`;
      await sql`ALTER TABLE stats ADD COLUMN IF NOT EXISTS initial_kill_points BIGINT DEFAULT 0`;
    } catch (e) {}

    console.log('Database initialized');
  } catch (error) {
    console.error('DB init error:', error);
  }
}

async function upsertUser(discordId, username, avatar) {
  await sql`
    INSERT INTO users (discord_id, username, avatar) VALUES (${discordId}, ${username}, ${avatar})
    ON CONFLICT (discord_id) DO UPDATE SET username = EXCLUDED.username, avatar = EXCLUDED.avatar
  `;
}

async function getUser(discordId) {
  const result = await sql`SELECT * FROM users WHERE discord_id = ${discordId}`;
  return result[0] || null;
}

async function getAllStats() {
  return await sql`SELECT * FROM stats ORDER BY highest_power DESC`;
}

async function upsertStats(govId, name, power, deads, kills, rss) {
  await sql`
    INSERT INTO stats (governor_id, username, highest_power, deads, total_kill_points, resources_gathered)
    VALUES (${govId}, ${name}, ${power}, ${deads}, ${kills}, ${rss})
    ON CONFLICT (governor_id) DO UPDATE SET
      username = EXCLUDED.username, highest_power = EXCLUDED.highest_power,
      deads = EXCLUDED.deads, total_kill_points = EXCLUDED.total_kill_points,
      resources_gathered = EXCLUDED.resources_gathered
  `;
}

async function createStatsWithInitial(govId, name, power, deads, kills, rss) {
  await sql`
    INSERT INTO stats (governor_id, username, highest_power, deads, total_kill_points, resources_gathered, initial_power, initial_deads, initial_kill_points)
    VALUES (${govId}, ${name}, ${power}, ${deads}, ${kills}, ${rss}, ${power}, ${deads}, ${kills})
    ON CONFLICT (governor_id) DO UPDATE SET
      username = EXCLUDED.username, highest_power = EXCLUDED.highest_power,
      deads = EXCLUDED.deads, total_kill_points = EXCLUDED.total_kill_points,
      resources_gathered = EXCLUDED.resources_gathered,
      initial_power = EXCLUDED.initial_power, initial_deads = EXCLUDED.initial_deads, initial_kill_points = EXCLUDED.initial_kill_points
  `;
}

async function clearAllStats() {
  await sql`DELETE FROM stats`;
}

// Tiers
async function getAllTiers() {
  return await sql`SELECT * FROM tiers ORDER BY min_power ASC`;
}

async function upsertTier(id, name, min, max, killMult, deathMult) {
  if (id) {
    await sql`UPDATE tiers SET name=${name}, min_power=${min}, max_power=${max}, kill_multiplier=${killMult}, death_multiplier=${deathMult} WHERE id=${id}`;
  } else {
    await sql`INSERT INTO tiers (name, min_power, max_power, kill_multiplier, death_multiplier) VALUES (${name}, ${min}, ${max}, ${killMult}, ${deathMult})`;
  }
}

async function deleteTier(id) {
  await sql`DELETE FROM tiers WHERE id = ${id}`;
}

module.exports = {
  sql, initDB, upsertUser, getUser, getAllStats, upsertStats,
  createStatsWithInitial, clearAllStats, getAllTiers, upsertTier, deleteTier
};
