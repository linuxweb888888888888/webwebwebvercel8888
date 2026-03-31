require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const ccxt = require('ccxt');

const app = express();
app.use(express.json());

// ============================================================================
// 1. MONGODB DATABASE CONNECTION (Stateless Caching)
// ============================================================================
// In serverless, we must check if the DB is already connected to avoid multiple open pools
let isConnected = false;
async function connectDB() {
    if (isConnected) return;
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/htx-bot');
        isConnected = true;
        console.log("MongoDB Connected.");
    } catch (err) {
        console.error("MongoDB Connection Error:", err);
    }
}

// Dummy Schemas
const Profile = mongoose.model('Profile', new mongoose.Schema({
    apiKey: String, secret: String, trackedCoins: [String], isPaper: Boolean,
    takeProfitPct: Number, stopLossPct: Number, isActive: Boolean
}), 'profiles');

const ProfileState = mongoose.model('ProfileState', new mongoose.Schema({
    profileId: String, positions: Object, lastPnl: Number
}), 'profilestates');

// ============================================================================
// 2. THE STATELESS TRADING ENGINE (The "Tick")
// ============================================================================
// This endpoint replaces setInterval. An external service MUST ping this URL 
// every 6 seconds: POST https://your-app.vercel.app/api/engine/tick
app.post('/api/engine/tick', async (req, res) => {
    await connectDB();
    const startTime = Date.now();

    try {
        // 1. Fetch all ACTIVE profiles from Database
        // const activeProfiles = await Profile.find({ isActive: true });
        
        // Mocking an active profile for demonstration
        const activeProfiles = [{
            _id: 'user_123', isPaper: true, trackedCoins: ['BTC/USDT', 'ETH/USDT'],
            takeProfitPct: 1.5, stopLossPct: -5.0
        }];

        // 2. Instantiate Exchanges & Fetch Live Data dynamically
        const binance = new ccxt.binance();
        
        for (const profile of activeProfiles) {
            console.log(`Processing tick for profile: ${profile._id}`);
            
            // Note: In serverless, we fetch prices per execution. 
            // To optimize, you could use Promise.all() for multiple coins.
            const tickers = await binance.fetchTickers(profile.trackedCoins);

            for (const coin of profile.trackedCoins) {
                const liveData = tickers[coin];
                if (!liveData) continue;

                // 3. Check State (From DB or Exchange directly)
                // const state = await ProfileState.findOne({ profileId: profile._id });
                const hasPosition = false; // Mock

                if (!hasPosition) {
                    // BASE POSITION LOGIC
                    const direction = liveData.percentage > 0 ? 'buy' : 'sell';
                    console.log(`[${profile._id}] Market ${direction} ${coin} at ${liveData.last}`);
                    
                    // await exchange.createMarketOrder(coin, direction, 1);
                    // Update DB State...
                } else {
                    // DCA & TAKE PROFIT LOGIC
                    const positionPnl = -2.5; // Mock calculation
                    
                    if (positionPnl >= profile.takeProfitPct) {
                        console.log(`[${profile._id}] Closing ${coin} - Take Profit!`);
                        // execute close...
                    } else if (positionPnl <= profile.stopLossPct) {
                        console.log(`[${profile._id}] DCA Triggered. Executing halving math...`);
                        // execute DCA...
                    }
                }
            }

            // 4. Run Smart Offsets
            // runSmartOffsets(profile, positions);
        }

        const executionTime = Date.now() - startTime;
        res.status(200).json({ status: "Tick complete", ms: executionTime });

    } catch (err) {
        console.error("Engine Tick Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// 3. FRONTEND & ADMIN ROUTES
// ============================================================================
app.post('/api/admin/force-sync', async (req, res) => {
    await connectDB();
    // Overwrite DB configurations for all users here
    res.json({ message: "Network synced to master template in DB." });
});

// Embedded Frontend
const FRONTEND_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>HTX Pro Terminal (Vercel Edition)</title>
    <style>
        body { background-color: #0b0e11; color: #eaecef; font-family: monospace; padding: 20px; }
        .dashboard { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .card { background: #1e2329; padding: 15px; border-radius: 5px; border-left: 4px solid #fcd535; }
        .log-terminal { background: #000; color: #0f0; padding: 10px; height: 300px; overflow-y: scroll; }
        .btn { background: #fcd535; color: #000; border: none; padding: 10px 20px; cursor: pointer; font-weight: bold; }
    </style>
</head>
<body>
    <h1>🤖 HTX Matrix Engine (Serverless)</h1>
    <div class="dashboard">
        <div class="card">
            <h3>System Control</h3>
            <p>Engine Trigger: <span style="color:#fcd535">External Ping / Manual</span></p>
            <button class="btn" onclick="startFrontendLoop()">Start Frontend 6s Heartbeat</button>
            <button class="btn" style="background:#f6465d;color:#fff" onclick="stopFrontendLoop()">Stop Heartbeat</button>
        </div>
        <div class="card">
            <h3>Execution Logs</h3>
            <div class="log-terminal" id="logs">System initialized...<br></div>
        </div>
    </div>
    <script>
        const logBox = document.getElementById('logs');
        let heartbeat;

        function log(msg) {
            logBox.innerHTML += \`[\${new Date().toLocaleTimeString()}] \${msg}<br>\`;
            logBox.scrollTop = logBox.scrollHeight;
        }

        // Because Vercel can't run setInterval internally, we can force the user's 
        // browser to keep the bot alive by pinging the engine while the dashboard is open.
        function startFrontendLoop() {
            log("Starting 6-second heartbeat ping to Vercel...");
            heartbeat = setInterval(async () => {
                try {
                    const res = await fetch('/api/engine/tick', { method: 'POST' });
                    const data = await res.json();
                    log(\`Tick Executed in \${data.ms}ms\`);
                } catch (e) { log(\`Tick Failed: \${e.message}\`); }
            }, 6000);
        }

        function stopFrontendLoop() {
            clearInterval(heartbeat);
            log("Heartbeat stopped.");
        }
    </script>
</body>
</html>
`;

app.get('*', (req, res) => {
    res.send(FRONTEND_HTML);
});

// ============================================================================
// 4. VERCEL EXPORT (No app.listen!)
// ============================================================================
module.exports = app;
