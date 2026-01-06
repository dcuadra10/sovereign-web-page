const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { upsertUser, getUser } = require('./database');

const ADMIN_ID = '1211770249200795734';

passport.serializeUser((user, done) => {
  done(null, user.discordId);
});

passport.deserializeUser(async (discordId, done) => {
  try {
    const user = await getUser(discordId);
    if (user) {
      done(null, {
        discordId: user.discord_id,
        username: user.username,
        avatar: user.avatar,
        isAdmin: user.discord_id === ADMIN_ID
      });
    } else {
      done(null, null);
    }
  } catch (error) {
    done(error, null);
  }
});

passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL,
  scope: ['identify']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    await upsertUser(profile.id, profile.username, profile.avatar);
    
    const user = {
      discordId: profile.id,
      username: profile.username,
      avatar: profile.avatar,
      isAdmin: profile.id === ADMIN_ID
    };
    done(null, user);
  } catch (error) {
    done(error, null);
  }
}));

module.exports = { passport, ADMIN_ID };
