const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./database');

const ADMIN_ID = '1211770249200795734';

passport.serializeUser((user, done) => {
  done(null, user.discordId);
});

passport.deserializeUser((discordId, done) => {
  const user = db.prepare('SELECT * FROM users WHERE discordId = ?').get(discordId);
  if (user) {
    user.isAdmin = user.discordId === ADMIN_ID;
  }
  done(null, user || null);
});

passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL,
  scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
  const stmt = db.prepare(`
    INSERT INTO users (discordId, username, avatar)
    VALUES (?, ?, ?)
    ON CONFLICT(discordId) DO UPDATE SET
      username = excluded.username,
      avatar = excluded.avatar
  `);
  stmt.run(profile.id, profile.username, profile.avatar);
  
  const user = {
    discordId: profile.id,
    username: profile.username,
    avatar: profile.avatar,
    isAdmin: profile.id === ADMIN_ID
  };
  done(null, user);
}));

module.exports = { passport, ADMIN_ID };
