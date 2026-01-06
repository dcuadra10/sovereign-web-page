const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'stats.db'));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discordId TEXT PRIMARY KEY,
    username TEXT,
    avatar TEXT
  );

  CREATE TABLE IF NOT EXISTS stats (
    governorId TEXT PRIMARY KEY,
    username TEXT,
    power INTEGER DEFAULT 0,
    highestPower INTEGER DEFAULT 0,
    deads INTEGER DEFAULT 0,
    totalKillPoints INTEGER DEFAULT 0,
    resourcesGathered INTEGER DEFAULT 0
  );
`);

module.exports = db;
