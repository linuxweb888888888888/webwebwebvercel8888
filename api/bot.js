const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const path = require('path');
let bcrypt;
try { bcrypt = require('bcryptjs'); } catch (err) { bcrypt = require('bcrypt'); }

const PORT = process.env.PORT || 4000; // Runs on port 4000 alongside main bot
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
            .then(mongoose => { console.log('✅ Growth Executer Bot connected to MongoDB!'); return mongoose; })
            .catch(err => { console.error('❌ MongoDB Error:', err); cachedDb.promise = null; });
    }
    cachedDb.conn = await cachedDb.promise;
    return cachedDb.conn;
};

// ==========================================
// 2. MONGOOSE SCHEMAS
// ==========================================
const UserSchema = new mongoose.Schema({ username: { type: String, required: true, unique: true }, password: { type: String, required: true }, isPaper: { type: Boolean, default: true } });
const User = mongoose.models.User || mongoose.model('User', UserSchema);

const SettingsSchema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, subAccounts: Array });
const PaperSettings = mongoose.models.PaperSettings || mongoose.model('PaperSettings', SettingsSchema, 'paper_settings');
const RealSettings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema, 'settings');

const ProfileStateSchema = new mongoose.Schema({ profileId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true }, userId: { type: mongoose.Schema.Types.ObjectId, required: true }, coinStates: { type: mongoose.Schema.Types.Mixed, default: {} } });
const PaperProfileState = mongoose.models.PaperProfileState || mongoose.model('PaperProfileState', ProfileStateSchema, 'profile_states');
const RealProfileState = mongoose.models.ProfileState || mongoose.model('ProfileState', ProfileStateSchema, 'profile_states');

const OffsetRecordSchema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, symbol: { type: String }, reason: { type: String }, winnerSymbol: { type: String }, loserSymbol: { type: String }, netProfit: { type: Number, required: true }, timestamp: { type: Date, default: Date.now } });
const RealOffsetRecord = mongoose.models.OffsetRecord || mongoose.model('OffsetRecord', OffsetRecordSchema, 'offset_records');
const PaperOffsetRecord = mongoose.models.PaperOffsetRecord || mongoose.model('PaperOffsetRecord', OffsetRecordSchema, 'paper_offset_records');

// Dedicated History for the Growth Bot UI
const GrowthExecutionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    isPaper: { type: Boolean },
    deltaGrowth: { type: Number, required: true }, // The target value it looked for
    executedPnl: { type: Number, required: true }, // The actual value it closed
    coins: { type: [String], default: [] },
    timestamp: { type: Date, default: Date.now }
});
const GrowthExecution = mongoose.models.GrowthExecution || mongoose.model('GrowthExecution', GrowthExecutionSchema, 'growth_executions');

// ==========================================
// 3. GROWTH MATCHING & EXECUTION ENGINE
// ==========================================
global.growthStates = {}; // Memory state for 5-min intervals

const processGrowthExecution = async () => {
    try {
        await connectDB();
        const users = await User.find({ username: { $ne: 'webcoin8888' } }).lean();
        
        for (let u of users) {
            const SettingsModel = u.isPaper ? PaperSettings : RealSettings;
            const StateModel = u.isPaper ? PaperProfileState : RealProfileState;
            const OffsetModel = u.isPaper ? PaperOffsetRecord : RealOffsetRecord;

            const settings = await SettingsModel.findOne({ userId: u._id }).lean();
            if (!settings || !settings.subAccounts) continue;

            const subIds = settings.subAccounts.map(s => s._id.toString());
            const userStates = await StateModel.find({ profileId: { $in: subIds } }).lean();

            let activeCandidates = [];

            // Gather all active trades with Full Metadata for CCXT execution
            userStates.forEach(st => {
                const subAcc = settings.subAccounts.find(s => s._id.toString() === st.profileId.toString());
                if (!subAcc) return;

                if (st.coinStates) {
                    for (let sym in st.coinStates) {
                        const cs = st.coinStates[sym];
                        if (cs.contracts > 0 && (!cs.lockUntil || Date.now() >= cs.lockUntil)) {
                            let actualSide = cs.activeSide || subAcc.coins.find(c => c.symbol === sym)?.side || subAcc.side;
                            activeCandidates.push({ 
                                profileId: st.profileId.toString(), 
                                symbol: sym, 
                                pnl: parseFloat(cs.unrealizedPnl) || 0,
                                contracts: cs.contracts,
                                side: actualSide,
                                subAccount: subAcc
                            });
                        }
                    }
                }
            });

            if (activeCandidates.length < 2) continue;

            // 1. Calculate the current absolute Peak
            let sortedCandidates = [...activeCandidates].sort((a, b) => b.pnl - a.pnl);
            const totalPairs = Math.floor(sortedCandidates.length / 2);
            let peakAccumulation = 0; let runningAccumulation = 0;

            for (let i = 0; i < totalPairs; i++) {
                const w = sortedCandidates[i]; 
                const l = sortedCandidates[sortedCandidates.length - 1 - i];
                runningAccumulation += w.pnl + l.pnl;
                if (runningAccumulation > peakAccumulation) peakAccumulation = runningAccumulation;
            }

            // 2. State & Timer Management
            let userIdStr = u._id.toString();
            if (!global.growthStates[userIdStr]) {
                const lastExec = await GrowthExecution.findOne({ userId: u._id }).sort({ timestamp: -1 });
                global.growthStates[userIdStr] = {
                    lastPeak: lastExec ? (lastExec.absolutePeak || peakAccumulation) : peakAccumulation,
                    lastTime: lastExec ? lastExec.timestamp.getTime() : Date.now()
                };
            }

            let state = global.growthStates[userIdStr];
            let now = Date.now();
            let elapsed = now - state.lastTime;

            state.livePeak = peakAccumulation;
            state.nextCloseTime = state.lastTime + (5 * 60 * 1000);

            // 3. Trigger 5-Minute Window
            if (elapsed >= 5 * 60 * 1000) {
                let deltaGrowth = peakAccumulation - state.lastPeak;
                
                // Only process if delta is a meaningful movement
                if (Math.abs(deltaGrowth) >= 0.0001) {
                    
                    let target = deltaGrowth;
                    let bestMatch = null;
                    let smallestDiff = Infinity;
                    const TOLERANCE = 0.0015; // Must be within $0.0015 of the target value

                    // A. Search for Single Coin Matches
                    for (let c of activeCandidates) {
                        let diff = Math.abs(c.pnl - target);
                        if (diff <= TOLERANCE && diff < smallestDiff) {
                            smallestDiff = diff; bestMatch = [c];
                        }
                    }

                    // B. Search for Pair Matches (Groups of 2)
                    for (let i = 0; i < activeCandidates.length; i++) {
                        for (let j = i + 1; j < activeCandidates.length; j++) {
                            let sum = activeCandidates[i].pnl + activeCandidates[j].pnl;
                            let diff = Math.abs(sum - target);
                            if (diff <= TOLERANCE && diff < smallestDiff) {
                                smallestDiff = diff; bestMatch = [activeCandidates[i], activeCandidates[j]];
                            }
                        }
                    }

                    // C. Execute if Match Found
                    if (bestMatch && bestMatch.length > 0) {
                        let actualNetClosed = 0;
                        let symbolsClosed = [];

                        for (let pos of bestMatch) {
                            try {
                                if (!u.isPaper && pos.subAccount.apiKey) {
                                    const exchange = new ccxt.htx({ apiKey: pos.subAccount.apiKey, secret: pos.subAccount.secret, options: { defaultType: 'swap' } });
                                    const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                                    await exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close' });
                                } else {
                                    // Lock paper profile to simulate close
                                    const bState = await StateModel.findOne({ profileId: pos.profileId });
                                    if (bState && bState.coinStates && bState.coinStates[pos.symbol]) {
                                        bState.coinStates[pos.symbol].contracts = 0;
                                        bState.coinStates[pos.symbol].unrealizedPnl = 0;
                                        bState.coinStates[pos.symbol].lockUntil = Date.now() + 5000;
                                        bState.markModified('coinStates');
                                        await bState.save();
                                    }
                                }

                                actualNetClosed += pos.pnl;
                                symbolsClosed.push(pos.symbol);

                                // Update Realized PNL locally
                                pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.pnl;
                                await SettingsModel.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } });

                            } catch (e) { console.error(`Growth Execution CCXT Error: ${e.message}`); }
                        }

                        // Write to Main Bot Offset History
                        await OffsetModel.create({ userId: u._id, symbol: symbolsClosed.join(' & '), winnerSymbol: 'Growth', loserSymbol: 'Match', reason: `5-Min Growth Target Met (Target: $${deltaGrowth.toFixed(4)})`, netProfit: actualNetClosed });

                        // Write to Growth Bot Local UI History
                        await GrowthExecution.create({ userId: u._id, isPaper: u.isPaper, deltaGrowth: deltaGrowth, executedPnl: actualNetClosed, coins: symbolsClosed });

                        console.log(`[GROWTH BOT] Executed ${symbolsClosed.length} trades for ${u.username}. Target: $${deltaGrowth.toFixed(4)} | Closed: $${actualNetClosed.toFixed(4)}`);
                    } else {
                        // Log that a cycle passed but no math match was found
                        await GrowthExecution.create({ userId: u._id, isPaper: u.isPaper, deltaGrowth: deltaGrowth, executedPnl: 0, coins: ['No Tolerance Match Found'] });
                    }
                }

                // Reset timer and baseline peak for the next 5 mins
                state.lastPeak = peakAccumulation;
                state.lastTime = now;
                state.nextCloseTime = now + (5 * 60 * 1000);
            }
        }
    } catch (e) {
        console.error("Growth Engine Error:", e);
    }
};

// Run the engine every 10 seconds
setInterval(processGrowthExecution, 10000);

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

app.get('/api/growth/me', authMiddleware, (req, res) => res.json({ username: req.username, isPaper: req.isPaper }));

app.get('/api/growth/live', authMiddleware, async (req, res) => {
    const state = global.growthStates[req.userId] || { livePeak: 0, nextCloseTime: Date.now() + 300000, lastPeak: 0 };
    res.json(state);
});

app.get('/api/growth/history', authMiddleware, async (req, res) => {
    const history = await GrowthExecution.find({ userId: req.userId }).sort({ timestamp: -1 }).limit(50);
    const totalExecutedProfit = history.reduce((sum, t) => sum + t.executedPnl, 0);
    res.json({ history, totalExecutedProfit });
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
        <title>Growth Executer Bot</title>
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
        <style>
            :root { 
                --bg: #090a0f; --surface: #13151c; --surface-border: #1f222e; 
                --text: #e2e8f0; --text-muted: #94a3b8;
                --neon-green: #10b981; --neon-red: #ef4444; 
                --neon-blue: #0ea5e9; --neon-purple: #8b5cf6; --neon-orange: #f59e0b;
            }
            body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; }
            .mono { font-family: 'JetBrains Mono', monospace; }
            
            .navbar { background: rgba(19, 21, 28, 0.8); backdrop-filter: blur(10px); border-bottom: 1px solid var(--surface-border); padding: 15px 30px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; }
            .logo { font-size: 1.5rem; font-weight: 800; color: var(--neon-blue); letter-spacing: -0.5px; text-transform: uppercase; }
            .logo span { color: var(--neon-orange); }
            
            .container { max-width: 1200px; margin: 40px auto; padding: 0 20px; }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-bottom: 30px; }
            
            .panel { background: var(--surface); border: 1px solid var(--surface-border); border-radius: 12px; padding: 25px; box-shadow: 0 8px 30px rgba(0,0,0,0.5); }
            .panel h2 { margin: 0 0 20px 0; font-size: 1rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; }
            
            .big-stat { font-size: 2.2rem; font-weight: 800; margin: 0; text-shadow: 0 0 20px rgba(0,0,0,0.5); }
            .text-up { color: var(--neon-green); text-shadow: 0 0 15px rgba(16, 185, 129, 0.3); }
            .text-down { color: var(--neon-red); text-shadow: 0 0 15px rgba(239, 68, 68, 0.3); }
            .text-warn { color: var(--neon-orange); text-shadow: 0 0 15px rgba(245, 158, 11, 0.3); }
            
            input { width: 100%; padding: 14px; background: #0f1117; border: 1px solid var(--surface-border); color: white; border-radius: 8px; font-family: 'Inter', sans-serif; margin-bottom: 15px; box-sizing: border-box; }
            input:focus { border-color: var(--neon-blue); outline: none; }
            
            .btn { width: 100%; padding: 14px; background: linear-gradient(135deg, var(--neon-orange), var(--neon-red)); border: none; color: white; font-weight: 700; border-radius: 8px; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; font-size: 1rem; }
            .btn:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(239, 68, 68, 0.4); }
            
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
            <div class="logo" style="text-align: center; margin-bottom: 30px;">Auto<span>Growth</span> Bot</div>
            <input type="text" id="username" placeholder="HTX Bot Username">
            <input type="password" id="password" placeholder="Password">
            <button class="btn" onclick="login()">INITIALIZE LINK</button>
            <p id="auth-msg" style="text-align: center; color: var(--neon-red); font-size: 0.9rem; margin-top: 15px;"></p>
        </div>

        <!-- DASHBOARD -->
        <div id="dashboard-view">
            <div class="navbar">
                <div class="logo">Auto<span>Growth</span> Executer</div>
                <div><span id="user-display" style="margin-right: 20px; color: var(--text-muted);"></span><a href="#" onclick="logout()" style="color: var(--neon-red); text-decoration: none; font-weight: bold;">DISCONNECT</a></div>
            </div>

            <div class="container">
                <div class="grid">
                    <div class="panel">
                        <h2>Time Until Next Search Window</h2>
                        <div class="timer-box" id="countdown">05:00</div>
                    </div>
                    <div class="panel">
                        <h2>Current Peak Growth (Target)</h2>
                        <div class="big-stat mono text-warn" id="live-delta">$0.0000</div>
                        <div style="margin-top: 8px; font-size: 0.85rem; color: var(--text-muted);">Delta since last execution</div>
                    </div>
                    <div class="panel" style="border-color: var(--neon-orange); box-shadow: 0 0 20px rgba(245,158,11,0.1);">
                        <h2 style="color: var(--neon-orange);">Total Executed Auto-Growth</h2>
                        <div class="big-stat mono text-up" id="total-profit">$0.00</div>
                    </div>
                </div>

                <div class="panel">
                    <h2>Real Market Executions (5-Min Cycles)</h2>
                    <div style="overflow-x: auto;">
                        <table id="trades-table">
                            <thead>
                                <tr>
                                    <th>Date & Time</th>
                                    <th>Target Growth (Delta)</th>
                                    <th>Matched & Executed PNL</th>
                                    <th>Status</th>
                                    <th>Coins Closed</th>
                                </tr>
                            </thead>
                            <tbody id="trades-body">
                                <tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Waiting for execution data...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>

        <script>
            let token = localStorage.getItem('g_token');
            let nextCloseMs = Date.now() + 300000;
            let syncInterval, uiInterval;

            async function checkAuth() {
                if (!token) {
                    document.getElementById('auth-view').style.display = 'block';
                    document.getElementById('dashboard-view').style.display = 'none';
                    return;
                }
                try {
                    const res = await fetch('/api/growth/me', { headers: { 'Authorization': 'Bearer ' + token } });
                    if (!res.ok) throw new Error();
                    const data = await res.json();
                    document.getElementById('user-display').innerText = "Logged in as: " + data.username + (data.isPaper ? ' (PAPER)' : ' (REAL LIVE)');
                    
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
                    token = data.token; localStorage.setItem('g_token', token);
                    checkAuth();
                } else {
                    document.getElementById('auth-msg').innerText = "Invalid credentials.";
                }
            }

            function logout() {
                localStorage.removeItem('g_token');
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
                // Fetch Live Target Delta
                const liveRes = await fetch('/api/growth/live', { headers: { 'Authorization': 'Bearer ' + token } });
                const liveData = await liveRes.json();
                
                nextCloseMs = liveData.nextCloseTime;
                
                let delta = (liveData.livePeak || 0) - (liveData.lastPeak || 0);
                const deltaEl = document.getElementById('live-delta');
                deltaEl.innerText = (delta >= 0 ? '+$' : '-$') + Math.abs(delta).toFixed(4);
                deltaEl.className = 'big-stat mono ' + (delta >= 0 ? 'text-up' : 'text-down');

                // Fetch Execution History
                const tradeRes = await fetch('/api/growth/history', { headers: { 'Authorization': 'Bearer ' + token } });
                const tradeData = await tradeRes.json();
                
                const tpEl = document.getElementById('total-profit');
                let tp = tradeData.totalExecutedProfit || 0;
                tpEl.innerText = (tp >= 0 ? '+$' : '-$') + Math.abs(tp).toFixed(4);
                tpEl.className = 'big-stat mono ' + (tp >= 0 ? 'text-up' : 'text-down');

                renderTable(tradeData.history);
            }

            function renderTable(history) {
                const tbody = document.getElementById('trades-body');
                if (!history || history.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No executions recorded. Engine scans every 5 minutes.</td></tr>';
                    return;
                }

                let html = '';
                history.forEach(t => {
                    let d = new Date(t.timestamp);
                    let targetClass = t.deltaGrowth >= 0 ? 'text-up' : 'text-down';
                    let execClass = t.executedPnl >= 0 ? 'text-up' : 'text-down';
                    
                    let targetSign = t.deltaGrowth >= 0 ? '+' : '';
                    let execSign = t.executedPnl >= 0 ? '+' : '';
                    
                    let coinHtml = t.coins.map(c => {
                        if (c === 'No Tolerance Match Found') return '<span style="color: var(--neon-red); font-size:0.8rem;">No Open Positions Matched Value</span>';
                        return '<span class="coin-badge">' + c.split('/')[0] + '</span>';
                    }).join('');

                    let status = t.executedPnl === 0 && t.coins[0] === 'No Tolerance Match Found' 
                        ? '<span style="color:var(--neon-red); font-weight:bold;">SKIPPED</span>' 
                        : '<span style="color:var(--neon-green); font-weight:bold;">EXECUTED</span>';

                    html += '<tr>' +
                        '<td style="color: var(--text-muted);">' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString() + '</td>' +
                        '<td class="mono ' + targetClass + '">' + targetSign + '$' + t.deltaGrowth.toFixed(4) + '</td>' +
                        '<td class="mono ' + execClass + '" style="font-weight:bold;">' + execSign + '$' + t.executedPnl.toFixed(4) + '</td>' +
                        '<td>' + status + '</td>' +
                        '<td>' + coinHtml + '</td>' +
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
    app.listen(PORT, () => console.log(`🚀 Auto-Growth Executer running locally on http://localhost:${PORT}`));
}
module.exports = app;
