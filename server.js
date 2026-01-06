const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
require("dotenv").config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Configuration Endpoint
app.get('/api/config', (req, res) => {
  res.json({
    botApiUrl: '/api/guild-info' // Frontend still calls this local endpoint
  });
});

// API Endpoint - Proxy to Koyeb Bot
app.get('/api/guild-info', async (req, res) => {
  try {
    const koyebUrl = process.env.KOYEB_BOT_URL || 'http://localhost:3000'; // Default or Env
    // Fetch stats from the Bot running on Koyeb
    const response = await fetch(`${koyebUrl}/api/stats`);

    if (!response.ok) {
      console.error(`[API Proxy] Bot fetch failed: ${response.status} ${response.statusText}`);
      throw new Error(`Bot API returned ${response.status}`);
    }

    const statsData = await response.json();
    res.json(statsData);

  } catch (error) {
    console.error("[API /guild-info] Error fetching from Bot:", error.message);
    if (error.cause) console.error("Cause:", error.cause);

    // Return detailed fallback data matching the new branding
    res.json({
      serverName: "Sovereign Empire",
      status: "Online",
      totalMembers: 216,
      onlineMembers: 120, // Simulated or fallback
      notes: "Bot connecting... (Please wait)"
    });
  }
});

// WebSocket Connection (Optional: Keep alive, or proxy real-time if needed)
io.on('connection', (socket) => {
  console.log(`[WebSocket] Client connected: ${socket.id}`);

  socket.on('requestStats', () => {
    // We could trigger a fetch here and emit back, but polling via API is simpler for Vercel.
    // For now, we do nothing or could emit the fallback.
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
