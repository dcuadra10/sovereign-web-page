const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function initDB() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        discord_id TEXT PRIMARY KEY,
        username TEXT,
        avatar TEXT
      )
    `;
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
    await sql`
      CREATE TABLE IF NOT EXISTS tiers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        min_power BIGINT NOT NULL,
        max_power BIGINT NOT NULL,
        kill_multiplier DECIMAL(5,2) DEFAULT 1.00,
        death_requirement BIGINT DEFAULT 0
      )
    `;
    
    // Add initial columns if they don't exist (for existing tables)
    try {
      await sql`ALTER TABLE stats ADD COLUMN IF NOT EXISTS initial_power BIGINT DEFAULT 0`;
      await sql`ALTER TABLE stats ADD COLUMN IF NOT EXISTS initial_deads BIGINT DEFAULT 0`;
      await sql`ALTER TABLE stats ADD COLUMN IF NOT EXISTS initial_kill_points BIGINT DEFAULT 0`;
    } catch (e) { console.log('Columns may already exist'); }
    
    console.log('Database initialized');
  } catch (error) {
    console.error('DB init error:', error);
  }
}

async function upsertUser(discordId, username, avatar) {
  await sql`
    INSERT INTO users (discord_id, username, avatar)
    VALUES (${discordId}, ${username}, ${avatar})
    ON CONFLICT (discord_id) DO UPDATE SET
      username = EXCLUDED.username,
      avatar = EXCLUDED.avatar
  `;
}

async function getUser(discordId) {
  const result = await sql`SELECT * FROM users WHERE discord_id = ${discordId}`;
  return result[0] || null;
}

async function getAllStats() {
  return await sql`SELECT * FROM stats ORDER BY highest_power DESC`;
}

async function upsertStats(governorId, username, highestPower, deads, totalKillPoints, resourcesGathered) {
  await sql`
    INSERT INTO stats (governor_id, username, highest_power, deads, total_kill_points, resources_gathered)
    VALUES (${governorId}, ${username}, ${highestPower}, ${deads}, ${totalKillPoints}, ${resourcesGathered})
    ON CONFLICT (governor_id) DO UPDATE SET
      username = EXCLUDED.username,
      highest_power = EXCLUDED.highest_power,
      deads = EXCLUDED.deads,
      total_kill_points = EXCLUDED.total_kill_points,
      resources_gathered = EXCLUDED.resources_gathered
  `;
}

// For CREATION - saves initial values
async function createStatsWithInitial(governorId, username, highestPower, deads, totalKillPoints, resourcesGathered) {
  await sql`
    INSERT INTO stats (governor_id, username, highest_power, deads, total_kill_points, resources_gathered, initial_power, initial_deads, initial_kill_points)
    VALUES (${governorId}, ${username}, ${highestPower}, ${deads}, ${totalKillPoints}, ${resourcesGathered}, ${highestPower}, ${deads}, ${totalKillPoints})
    ON CONFLICT (governor_id) DO UPDATE SET
      username = EXCLUDED.username,
      highest_power = EXCLUDED.highest_power,
      deads = EXCLUDED.deads,
      total_kill_points = EXCLUDED.total_kill_points,
      resources_gathered = EXCLUDED.resources_gathered,
      initial_power = EXCLUDED.initial_power,
      initial_deads = EXCLUDED.initial_deads,
      initial_kill_points = EXCLUDED.initial_kill_points
  `;
}

async function clearAllStats() {
  await sql`DELETE FROM stats`;
  console.log('All stats cleared');
}

// Tier functions
async function getAllTiers() {
  return await sql`SELECT * FROM tiers ORDER BY min_power ASC`;
}

async function upsertTier(id, name, minPower, maxPower, killMultiplier, deathRequirement) {
  if (id) {
    await sql`
      UPDATE tiers SET 
        name = ${name},
        min_power = ${minPower},
        max_power = ${maxPower},
        kill_multiplier = ${killMultiplier},
        death_requirement = ${deathRequirement}
      WHERE id = ${id}
    `;
  } else {
    await sql`
      INSERT INTO tiers (name, min_power, max_power, kill_multiplier, death_requirement)
      VALUES (${name}, ${minPower}, ${maxPower}, ${killMultiplier}, ${deathRequirement})
    `;
  }
}

async function deleteTier(id) {
  await sql`DELETE FROM tiers WHERE id = ${id}`;
}

async function getTierForPower(power) {
  const result = await sql`
    SELECT * FROM tiers 
    WHERE ${power} >= min_power AND ${power} < max_power
    LIMIT 1
  `;
  return result[0] || null;
}

module.exports = {
  sql,
  initDB,
  upsertUser,
  getUser,
  getAllStats,
  upsertStats,
  createStatsWithInitial,
  clearAllStats,
  getAllTiers,
  upsertTier,
  deleteTier,
  getTierForPower
};
