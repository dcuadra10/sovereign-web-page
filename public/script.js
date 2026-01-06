// Countdown
const launchDate = new Date("2027-02-01T00:00:00Z");

function updateCountdown() {
  const now = new Date();
  const diff = launchDate - now;

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const minutes = Math.floor((diff / (1000 * 60)) % 60);
  const seconds = Math.floor((diff / 1000) % 60);

  document.getElementById("days").textContent = days;
  document.getElementById("hours").textContent = hours;
  document.getElementById("minutes").textContent = minutes;
  document.getElementById("seconds").textContent = seconds;
}

setInterval(updateCountdown, 1000);
updateCountdown();

// WebSocket connection for real-time updates
let socket = null;

// Initialize WebSocket connection
function initializeWebSocket() {
  socket = io();

  socket.on('connect', () => {
    console.log('[WebSocket] Connected to server');
    updateConnectionStatus('🟢 Connected', '#4CAF50');
    // Request initial stats
    socket.emit('requestStats');
  });

  socket.on('serverStatsUpdate', (data) => {
    console.log('[WebSocket] Received real-time stats update:', data);
    updateServerStats(data);
  });

  socket.on('disconnect', () => {
    console.log('[WebSocket] Disconnected from server');
    updateConnectionStatus('🔴 Disconnected', '#f44336');
    // Fallback to static data when disconnected
    setStaticInfo();
  });

  socket.on('connect_error', (error) => {
    console.error('[WebSocket] Connection error:', error);
    updateConnectionStatus('❌ Connection Error', '#ff9800');
    // Fallback to static data on connection error
    setStaticInfo();
  });
}

// Get configuration from server
let botApiUrl = '/api/guild-info';

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    botApiUrl = config.botApiUrl;
  } catch (error) {
    console.warn('Failed to load config, using local endpoint:', error);
  }
}

// Update connection status indicator
function updateConnectionStatus(status, color) {
  const statusElement = document.getElementById("connection-status");
  if (statusElement) {
    statusElement.textContent = status;
    statusElement.style.background = color;
    statusElement.style.color = 'white';
  }
}

// Update last update timestamp
function updateLastUpdateTime() {
  const lastUpdateElement = document.getElementById("last-update");
  if (lastUpdateElement) {
    const now = new Date();
    const timeString = now.toLocaleTimeString();
    lastUpdateElement.textContent = `Last update: ${timeString}`;
  }
}

// Update server stats from WebSocket data
function updateServerStats(data) {
  try {
    // Update member count
    document.getElementById("member-count").textContent = `👥 ${data.totalMembers} Members`;

    // Update server info
    document.getElementById("server-name").textContent = `🌠 ${data.serverName}`;
    document.getElementById("server-online-count").textContent = `🟢 ${data.onlineMembers}`;
    document.getElementById("server-status").textContent = data.status === 'Online' ? '✅ Online' : '❌ Offline';
    document.getElementById("server-notes").textContent = `📝 ${data.notes}`;

    // Update timestamp
    updateLastUpdateTime();

    // Add visual indicator for real-time updates
    addUpdateIndicator();
  } catch (error) {
    console.error('Failed to update server stats:', error);
    setStaticInfo();
  }
}

// Add visual indicator for real-time updates
function addUpdateIndicator() {
  const serverStatusContent = document.getElementById("server-status-content");
  serverStatusContent.style.border = "2px solid #4CAF50";
  serverStatusContent.style.borderRadius = "8px";
  serverStatusContent.style.transition = "border 0.5s ease";

  setTimeout(() => {
    serverStatusContent.style.border = "2px solid transparent";
  }, 1000);
}

// Fetch real-time data from Discord bot API (fallback method)
async function fetchServerStats() {
  try {
    const response = await fetch(botApiUrl);
    const data = await response.json();

    if (response.ok) {
      updateServerStats(data);
    } else {
      // Fallback to static data if API fails
      setStaticInfo();
    }
  } catch (error) {
    console.error('Failed to fetch server stats:', error);
    // Fallback to static data
    setStaticInfo();
  }
}

// Set static info as fallback
function setStaticInfo() {
  // "Registered" y "Online"
  document.getElementById("member-count").textContent = "👥 216 Members";

  // "Server Name", "Status" y "Notes"
  document.getElementById("server-name").textContent = "🌠 Sovereign Empire";
  document.getElementById("server-online-count").textContent = "🟢 120";
  document.getElementById("server-status").textContent = "✅ Online";
  document.getElementById("server-notes").textContent = "📝 Bot configuration in progress";

  // Update connection status
  updateConnectionStatus('⚠️ Bot Offline', '#ff9800');
}

// Load configuration and initialize WebSocket on page load
async function initialize() {
  await loadConfig();

  // Set a timeout to show static info if no connection is made
  setTimeout(() => {
    const connectionStatus = document.getElementById("connection-status");
    if (connectionStatus && connectionStatus.textContent.includes("Connecting")) {
      console.log("Connection timeout, showing static info");
      setStaticInfo();
    }
  }, 10000); // 10 seconds timeout

  // Initialize WebSocket connection for real-time updates
  initializeWebSocket();

  // Fallback: Still fetch stats via API every 60 seconds as backup
  setInterval(fetchServerStats, 60000);
}

// Initialize when page loads
initialize();
