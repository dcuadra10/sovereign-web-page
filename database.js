const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

// Initialize tables
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
        power BIGINT DEFAULT 0,
        highest_power BIGINT DEFAULT 0,
        deads BIGINT DEFAULT 0,
        total_kill_points BIGINT DEFAULT 0,
        resources_gathered BIGINT DEFAULT 0
      )
    `;
    
    console.log('Database tables initialized');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// User functions
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
  const result = await sql`
    SELECT * FROM users WHERE discord_id = ${discordId}
  `;
  return result[0] || null;
}

// Stats functions
async function getAllStats() {
  const result = await sql`SELECT * FROM stats ORDER BY power DESC`;
  return result;
}

async function upsertStats(governorId, username, power, highestPower, deads, totalKillPoints, resourcesGathered) {
  await sql`
    INSERT INTO stats (governor_id, username, power, highest_power, deads, total_kill_points, resources_gathered)
    VALUES (${governorId}, ${username}, ${power}, ${highestPower}, ${deads}, ${totalKillPoints}, ${resourcesGathered})
    ON CONFLICT (governor_id) DO UPDATE SET
      username = EXCLUDED.username,
      power = EXCLUDED.power,
      highest_power = EXCLUDED.highest_power,
      deads = EXCLUDED.deads,
      total_kill_points = EXCLUDED.total_kill_points,
      resources_gathered = EXCLUDED.resources_gathered
  `;
}

module.exports = {
  sql,
  initDB,
  upsertUser,
  getUser,
  getAllStats,
  upsertStats
};
