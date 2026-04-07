const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const path = require('path');
let bcrypt;
try { bcrypt = require('bcryptjs'); } catch (err) { bcrypt = require('bcrypt'); }

const PORT = process.env.PORT || 4000; // Running on port 4000 so it doesn't conflict with main bot
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_this_in_production';
const MONGO_URI = 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';

// ==========================================
// 1. MONGODB DATABASE SETUP
// ==========================================
let cachedDb = global.mongoose;
if (!cachedDb) cachedDb = global.mongoose = { conn: null, promise: null };

const connectDB = async () => {
    if (cachedDb.conn) return cachedDb.conn;
    if (!cachedDb.promise) {
        cachedDb.promise = mongoose.connect(MONGO_URI, { bufferCommands: false, maxPoolSize: 10 })
            .then(mongoose => { console.log('✅ Virtual Bot connected to MongoDB successfully!'); return mongoose; })
            .catch(err => { console.error('❌ MongoDB Error:', err); cachedDb.promise = null; });
    }
    cachedDb.conn = await cachedDb.promise;
    return cachedDb.conn;
};

// ==========================================
// 2. MONGOOSE SCHEMAS (Re-used + New)
// ==========================================
const UserSchema = new mongoose.Schema({ username: { type: String, required: true, unique: true }, password: { type: String, required: true }, isPaper: { type: Boolean, default: true } });
const User = mongoose.models.User || mongoose.model('User', UserSchema);

const SettingsSchema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, subAccounts: Array });
const PaperSettings = mongoose.models.PaperSettings || mongoose.model('PaperSettings', SettingsSchema, 'paper_settings');
const RealSettings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema, 'settings');

const ProfileStateSchema = new mongoose.Schema({ profileId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true }, userId: { type: mongoose.Schema.Types.ObjectId, required: true }, coinStates: { type: mongoose.Schema.Types.Mixed, default: {} } });
const PaperProfileState = mongoose.models.PaperProfileState || mongoose.model('PaperProfileState', ProfileStateSchema, 'profile_states');
const RealProfileState = mongoose.models.ProfileState || mongoose.model('ProfileState', ProfileStateSchema, 'profile_states');

// NEW: Virtual Trade Record Schema
const VirtualTradeSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    isPaper: { type: Boolean },
    pnl: { type: Number, required: true }, // The 5-min delta growth
    absolutePeak: { type: Number, required: true }, // The peak value at the time of snapshot
    roi: { type: Number, required: true },
    coins: { type: [String], default: [] }, // Coins making up the peak
    timestamp: { type: Date, default: Date.now }
});
const VirtualTrade = mongoose.models.VirtualTrade || mongoose.model('VirtualTrade', VirtualTradeSchema, 'virtual_trades');

// ==========================================
// 3. VIRTUAL PEAK ENGINE (Runs every 10 sec)
// ==========================================
global.virtualStates = {}; // memory state for countdowns

const processVirtualPeak = async () => {
    try {
        await connectDB();
        const users = await User.find({ username: { $ne: 'webcoin8888' } }).lean();
        
        for (let u of users) {
            const SettingsModel = u.isPaper ? PaperSettings : RealSettings;
            const StateModel = u.isPaper ? PaperProfileState : RealProfileState;

            const settings = await SettingsModel.findOne({ userId: u._id }).lean();
            if (!settings || !settings.subAccounts) continue;

            const subIds = settings.subAccounts.map(s => s._id.toString());
            const userStates = await StateModel.find({ profileId: { $in: subIds } }).lean();

            let activeCandidates = [];
            let totalMargin = 0;

            // Gather all active trades from all profiles
            userStates.forEach(st => {
                if (st.coinStates) {
                    for (let sym in st.coinStates) {
                        const cs = st.coinStates[sym];
                        if (cs.contracts > 0) {
                            activeCandidates.push({ symbol: sym, pnl: parseFloat(cs.unrealizedPnl) || 0 });
                            totalMargin += parseFloat(cs.margin) || 0;
                        }
                    }
                }
            });

            if (activeCandidates.length < 2) continue;

            // Calculate Peak
            activeCandidates.sort((a, b) => b.pnl - a.pnl);
            const totalCoins = activeCandidates.length;
            const totalPairs = Math.floor(totalCoins / 2);
            
            let peakAccumulation = 0;
            let peakCoins = new Set();
            let runningAccumulation = 0;
            let tempCoins = [];

            for (let i = 0; i < totalPairs; i++) {
                const w = activeCandidates[i]; 
                const l = activeCandidates[totalCoins - 1 - i]; // Biggest Winner + Biggest Loser
                runningAccumulation += w.pnl + l.pnl;
                tempCoins.push(w.symbol, l.symbol);
                
                if (runningAccumulation > peakAccumulation) {
                    peakAccumulation = runningAccumulation;
                    peakCoins = new Set(tempCoins); // Snapshot the coins at this peak
                }
            }

            // Virtual Trade Execution Logic (Every 5 Minutes)
            let userIdStr = u._id.toString();
            if (!global.virtualStates[userIdStr]) {
                // Initialize from DB if restarted
                const lastTrade = await VirtualTrade.findOne({ userId: u._id }).sort({ timestamp: -1 });
                global.virtualStates[userIdStr] = {
                    lastPeak: lastTrade ? lastTrade.absolutePeak : peakAccumulation,
                    lastTime: lastTrade ? lastTrade.timestamp.getTime() : Date.now()
                };
            }

            let state = global.virtualStates[userIdStr];
            let now = Date.now();
            let elapsed = now - state.lastTime;

            // Write live data to memory for the UI to fetch
            state.livePeak = peakAccumulation;
            state.nextCloseTime = state.lastTime + (5 * 60 * 1000);

            // 5 Minutes passed? Execute virtual trade!
            if (elapsed >= 5 * 60 * 1000) {
                let deltaGrowth = peakAccumulation - state.lastPeak;
                let virtualRoi = totalMargin > 0 ? (deltaGrowth / totalMargin) * 100 : 0;

                await VirtualTrade.create({
                    userId: u._id,
                    isPaper: u.isPaper,
                    pnl: deltaGrowth,
                    absolutePeak: peakAccumulation,
                    roi: virtualRoi,
                    coins: Array.from(peakCoins)
                });

                console.log(`[VIRTUAL BOT] Logged 5-min trade for ${u.username}. Growth: $${deltaGrowth.toFixed(4)}`);

                // Reset timer and baseline peak
                state.lastPeak = peakAccumulation;
                state.lastTime = now;
                state.nextCloseTime = now + (5 * 60 * 1000);
            }
        }
    } catch (e) {
        console.error("Virtual Engine Error:", e);
    }
};

// Run the engine every 10 seconds
setInterval(processVirtualPeak, 10000);

// ==========================================
// 4. EXPRESS API ROUTES
// ==========================================
const app = express();
app.use(express.json());

const authMiddleware = async (req, res, next) => {
    await connectDB();
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    jwt.verify(token, JWT_SECRET, async (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.userId = decoded.userId;
        const user = await User.findById(decoded.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        req.isPaper = user.isPaper; req.username = user.username; 
        next();
    });
};

app.post('/api/login', async (req, res) => {
    await connectDB();
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, isPaper: user.isPaper, username: user.username });
});

app.get('/api/virtual/me', authMiddleware, (req, res) => res.json({ username: req.username }));

app.get('/api/virtual/live', authMiddleware, async (req, res) => {
    const state = global.virtualStates[req.userId] || { livePeak: 0, nextCloseTime: Date.now() + 300000 };
    res.json(state);
});

app.get('/api/virtual/trades', authMiddleware, async (req, res) => {
    const trades = await VirtualTrade.find({ userId: req.userId }).sort({ timestamp: -1 }).limit(50);
    
    // Calculate Total Virtual Profit
    const totalProfit = trades.reduce((sum, t) => sum + t.pnl, 0);
    
    res.json({ trades, totalProfit });
});

// ==========================================
// 5. FRONTEND UI (CYBERPUNK / DARK DESIGN)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Virtual Peak Bot</title>
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
        <style>
            :root { 
                --bg: #090a0f; --surface: #13151c; --surface-border: #1f222e; 
                --text: #e2e8f0; --text-muted: #94a3b8;
                --neon-green: #10b981; --neon-red: #ef4444; 
                --neon-blue: #0ea5e9; --neon-purple: #8b5cf6;
            }
            body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; }
            .mono { font-family: 'JetBrains Mono', monospace; }
            
            .navbar { background: rgba(19, 21, 28, 0.8); backdrop-filter: blur(10px); border-bottom: 1px solid var(--surface-border); padding: 15px 30px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; }
            .logo { font-size: 1.5rem; font-weight: 800; color: var(--neon-blue); letter-spacing: -0.5px; text-transform: uppercase; }
            .logo span { color: var(--neon-purple); }
            
            .container { max-width: 1200px; margin: 40px auto; padding: 0 20px; }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 30px; }
            
            .panel { background: var(--surface); border: 1px solid var(--surface-border); border-radius: 12px; padding: 25px; box-shadow: 0 8px 30px rgba(0,0,0,0.5); }
            .panel h2 { margin: 0 0 20px 0; font-size: 1rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; }
            
            .big-stat { font-size: 2.5rem; font-weight: 800; margin: 0; text-shadow: 0 0 20px rgba(0,0,0,0.5); }
            .text-up { color: var(--neon-green); text-shadow: 0 0 15px rgba(16, 185, 129, 0.3); }
            .text-down { color: var(--neon-red); text-shadow: 0 0 15px rgba(239, 68, 68, 0.3); }
            
            input { width: 100%; padding: 14px; background: #0f1117; border: 1px solid var(--surface-border); color: white; border-radius: 8px; font-family: 'Inter', sans-serif; margin-bottom: 15px; box-sizing: border-box; }
            input:focus { border-color: var(--neon-blue); outline: none; }
            
            .btn { width: 100%; padding: 14px; background: linear-gradient(135deg, var(--neon-blue), var(--neon-purple)); border: none; color: white; font-weight: 700; border-radius: 8px; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; font-size: 1rem; }
            .btn:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(139, 92, 246, 0.4); }
            
            table { width: 100%; border-collapse: collapse; text-align: left; }
            th { padding: 15px; border-bottom: 1px solid var(--surface-border); color: var(--text-muted); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 1px; }
            td { padding: 15px; border-bottom: 1px solid var(--surface-border); font-size: 0.95rem; }
            
            .coin-badge { display: inline-block; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 4px 8px; border-radius: 4px; font-size: 0.75rem; margin: 2px; color: var(--text-muted); }
            
            #auth-view { max-width: 400px; margin: 15vh auto; }
            #dashboard-view { display: none; }
            
            .timer-box { font-family: 'JetBrains Mono', monospace; font-size: 2rem; color: var(--neon-blue); letter-spacing: 2px; }
        </style>
    </head>
    <body>

        <!-- AUTH SCREEN -->
        <div id="auth-view" class="panel">
            <div class="logo" style="text-align: center; margin-bottom: 30px;">Virtual<span>Peak</span> Bot</div>
            <input type="text" id="username" placeholder="HTX Bot Username">
            <input type="password" id="password" placeholder="Password">
            <button class="btn" onclick="login()">INITIALIZE LINK</button>
            <p id="auth-msg" style="text-align: center; color: var(--neon-red); font-size: 0.9rem; margin-top: 15px;"></p>
        </div>

        <!-- DASHBOARD -->
        <div id="dashboard-view">
            <div class="navbar">
                <div class="logo">Virtual<span>Peak</span></div>
                <div><span id="user-display" style="margin-right: 20px; color: var(--text-muted);"></span><a href="#" onclick="logout()" style="color: var(--neon-red); text-decoration: none; font-weight: bold;">DISCONNECT</a></div>
            </div>

            <div class="container">
                <div class="grid">
                    <div class="panel">
                        <h2>Time Until Next Virtual Close</h2>
                        <div class="timer-box" id="countdown">05:00</div>
                    </div>
                    <div class="panel">
                        <h2>Live Current Peak Value</h2>
                        <div class="big-stat mono" id="live-peak">$0.0000</div>
                    </div>
                    <div class="panel" style="border-color: var(--neon-purple); box-shadow: 0 0 20px rgba(139,92,246,0.1);">
                        <h2 style="color: var(--neon-purple);">Total Virtual Profit (All Time)</h2>
                        <div class="big-stat mono text-up" id="total-profit">$0.00</div>
                    </div>
                </div>

                <div class="panel">
                    <h2>Virtual Trade History (5-Min Cycles)</h2>
                    <div style="overflow-x: auto;">
                        <table id="trades-table">
                            <thead>
                                <tr>
                                    <th>Date & Time</th>
                                    <th>Peak Value at Snapshot</th>
                                    <th>5-Min Peak Growth (PnL)</th>
                                    <th>Virtual ROI</th>
                                    <th>Coins in Peak</th>
                                </tr>
                            </thead>
                            <tbody id="trades-body">
                                <tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Waiting for data...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>

        <script>
            let token = localStorage.getItem('v_token');
            let nextCloseMs = Date.now() + 300000;
            let syncInterval, uiInterval;

            async function checkAuth() {
                if (!token) {
                    document.getElementById('auth-view').style.display = 'block';
                    document.getElementById('dashboard-view').style.display = 'none';
                    return;
                }
                try {
                    const res = await fetch('/api/virtual/me', { headers: { 'Authorization': 'Bearer ' + token } });
                    if (!res.ok) throw new Error();
                    const data = await res.json();
                    document.getElementById('user-display').innerText = "Logged in as: " + data.username;
                    
                    document.getElementById('auth-view').style.display = 'none';
                    document.getElementById('dashboard-view').style.display = 'block';
                    
                    startEngine();
                } catch(e) { logout(); }
            }

            async function login() {
                const user = document.getElementById('username').value;
                const pass = document.getElementById('password').value;
                const res = await fetch('/api/login', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: user, password: pass })
                });
                const data = await res.json();
                if (data.token) {
                    token = data.token; localStorage.setItem('v_token', token);
                    checkAuth();
                } else {
                    document.getElementById('auth-msg').innerText = "Invalid credentials.";
                }
            }

            function logout() {
                localStorage.removeItem('v_token');
                token = null;
                if(syncInterval) clearInterval(syncInterval);
                if(uiInterval) clearInterval(uiInterval);
                checkAuth();
            }

            function startEngine() {
                syncData();
                syncInterval = setInterval(syncData, 5000);
                uiInterval = setInterval(updateUI, 1000);
            }

            async function syncData() {
                // Fetch Live Peak and Target Time
                const liveRes = await fetch('/api/virtual/live', { headers: { 'Authorization': 'Bearer ' + token } });
                const liveData = await liveRes.json();
                
                nextCloseMs = liveData.nextCloseTime;
                
                const peakEl = document.getElementById('live-peak');
                let peakVal = liveData.livePeak || 0;
                peakEl.innerText = (peakVal >= 0 ? '+$' : '-$') + Math.abs(peakVal).toFixed(4);
                peakEl.className = 'big-stat mono ' + (peakVal >= 0 ? 'text-up' : 'text-down');

                // Fetch Trade History
                const tradeRes = await fetch('/api/virtual/trades', { headers: { 'Authorization': 'Bearer ' + token } });
                const tradeData = await tradeRes.json();
                
                const tpEl = document.getElementById('total-profit');
                let tp = tradeData.totalProfit || 0;
                tpEl.innerText = (tp >= 0 ? '+$' : '-$') + Math.abs(tp).toFixed(4);
                tpEl.className = 'big-stat mono ' + (tp >= 0 ? 'text-up' : 'text-down');

                renderTable(tradeData.trades);
            }

            function renderTable(trades) {
                const tbody = document.getElementById('trades-body');
                if (!trades || trades.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No virtual trades executed yet. Wait 5 minutes.</td></tr>';
                    return;
                }

                let html = '';
                trades.forEach(t => {
                    let d = new Date(t.timestamp);
                    let pnlClass = t.pnl >= 0 ? 'text-up' : 'text-down';
                    let pnlSign = t.pnl >= 0 ? '+' : '';
                    
                    let coinHtml = t.coins.map(c => '<span class="coin-badge">' + c.split('/')[0] + '</span>').join('');

                    html += '<tr>' +
                        '<td style="color: var(--text-muted);">' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString() + '</td>' +
                        '<td class="mono">$' + t.absolutePeak.toFixed(4) + '</td>' +
                        '<td class="mono ' + pnlClass + '" style="font-weight:bold;">' + pnlSign + '$' + t.pnl.toFixed(4) + '</td>' +
                        '<td class="mono ' + pnlClass + '">' + pnlSign + t.roi.toFixed(2) + '%</td>' +
                        '<td>' + (coinHtml || '<span style="color:#555;">None</span>') + '</td>' +
                    '</tr>';
                });
                tbody.innerHTML = html;
            }

            function updateUI() {
                let diff = nextCloseMs - Date.now();
                if (diff < 0) diff = 0;
                
                let mins = Math.floor(diff / 60000);
                let secs = Math.floor((diff % 60000) / 1000);
                
                document.getElementById('countdown').innerText = 
                    (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
            }

            checkAuth();
        </script>
    </body>
    </html>
    `);
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Virtual Peak Bot running locally on http://localhost:${PORT}`));
}
module.exports = app;
