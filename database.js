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
        resources_gathered BIGINT DEFAULT 0
      )
    `;
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

async function clearAllStats() {
  await sql`DELETE FROM stats`;
  console.log('All stats cleared');
}

module.exports = {
  sql,
  initDB,
  upsertUser,
  getUser,
  getAllStats,
  upsertStats,
  clearAllStats
};
