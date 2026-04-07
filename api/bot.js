const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const path = require('path');
let bcrypt;
try { bcrypt = require('bcryptjs'); } catch (err) { bcrypt = require('bcrypt'); }

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_this_in_production';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';

// ==========================================
// 1. MONGODB DATABASE SETUP
// ==========================================
let cachedDb = global.mongoose;
if (!cachedDb) cachedDb = global.mongoose = { conn: null, promise: null };

const connectDB = async () => {
    if (cachedDb.conn) return cachedDb.conn;
    if (!cachedDb.promise) {
        cachedDb.promise = mongoose.connect(MONGO_URI, { bufferCommands: false, maxPoolSize: 10 })
            .then(mongoose => { console.log('✅ Connected to MongoDB!'); return mongoose; })
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

const SettingsSchema = new mongoose.Schema({ 
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, 
    subAccounts: Array,
    growthWindowMinutes: { type: Number, default: 1 } 
}, { strict: false });
const PaperSettings = mongoose.models.PaperSettings || mongoose.model('PaperSettings', SettingsSchema, 'paper_settings');
const RealSettings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema, 'settings');

const ProfileStateSchema = new mongoose.Schema({ profileId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true }, userId: { type: mongoose.Schema.Types.ObjectId, required: true }, coinStates: { type: mongoose.Schema.Types.Mixed, default: {} } });
const PaperProfileState = mongoose.models.PaperProfileState || mongoose.model('PaperProfileState', ProfileStateSchema, 'profile_states');
const RealProfileState = mongoose.models.ProfileState || mongoose.model('ProfileState', ProfileStateSchema, 'profile_states');

const OffsetRecordSchema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, symbol: { type: String }, reason: { type: String }, winnerSymbol: { type: String }, loserSymbol: { type: String }, netProfit: { type: Number, required: true }, timestamp: { type: Date, default: Date.now } });
const RealOffsetRecord = mongoose.models.OffsetRecord || mongoose.model('OffsetRecord', OffsetRecordSchema, 'offset_records');
const PaperOffsetRecord = mongoose.models.PaperOffsetRecord || mongoose.model('PaperOffsetRecord', OffsetRecordSchema, 'paper_offset_records');

const GrowthExecutionSchema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, isPaper: { type: Boolean }, deltaGrowth: { type: Number, required: true }, executedPnl: { type: Number, required: true }, coins: { type: [String], default: [] }, timestamp: { type: Date, default: Date.now } });
const GrowthExecution = mongoose.models.GrowthExecution || mongoose.model('GrowthExecution', GrowthExecutionSchema, 'growth_executions');

// NEW: Serverless State Management (Stores memory in MongoDB)
const GrowthStateSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    lastPeak: { type: Number, default: 0 },
    livePeak: { type: Number, default: 0 },
    lastTime: { type: Number, default: Date.now },
    nextCloseTime: { type: Number, default: Date.now }
});
const GrowthState = mongoose.models.GrowthState || mongoose.model('GrowthState', GrowthStateSchema, 'growth_states');

// ==========================================
// 3. SERVERLESS GROWTH ENGINE (MongoDB Backed)
// ==========================================
global.isGrowthExecuting = global.isGrowthExecuting || false;

const processGrowthExecution = async () => {
    if (global.isGrowthExecuting) return; 
    global.isGrowthExecuting = true;

    try {
        await connectDB();
        const users = await User.find({ username: { $ne: 'webcoin8888' } }).lean();
        
        for (let u of users) {
            const SettingsModel = u.isPaper ? PaperSettings : RealSettings;
            const StateModel = u.isPaper ? PaperProfileState : RealProfileState;
            const OffsetModel = u.isPaper ? PaperOffsetRecord : RealOffsetRecord;

            const settings = await SettingsModel.findOne({ userId: u._id }).lean();
            if (!settings || !settings.subAccounts) continue;

            const windowMinutes = settings.growthWindowMinutes || 1;
            const windowMs = windowMinutes * 60 * 1000;

            const subIds = settings.subAccounts.map(s => s._id.toString());
            const userStates = await StateModel.find({ profileId: { $in: subIds } }).lean();

            let activeCandidates = [];

            userStates.forEach(st => {
                const subAcc = settings.subAccounts.find(s => s._id.toString() === st.profileId.toString());
                if (!subAcc) return;

                if (st.coinStates) {
                    for (let sym in st.coinStates) {
                        const cs = st.coinStates[sym];
                        if (cs.contracts > 0 && (!cs.lockUntil || Date.now() >= cs.lockUntil)) {
                            let actualSide = cs.activeSide || subAcc.coins.find(c => c.symbol === sym)?.side || subAcc.side;
                            activeCandidates.push({ profileId: st.profileId.toString(), symbol: sym, pnl: parseFloat(cs.unrealizedPnl) || 0, contracts: cs.contracts, side: actualSide, subAccount: subAcc });
                        }
                    }
                }
            });

            if (activeCandidates.length < 2) continue;

            let sortedCandidates = [...activeCandidates].sort((a, b) => b.pnl - a.pnl);
            const totalPairs = Math.floor(sortedCandidates.length / 2);
            let peakAccumulation = 0; let runningAccumulation = 0;

            for (let i = 0; i < totalPairs; i++) {
                const w = sortedCandidates[i]; 
                const l = sortedCandidates[sortedCandidates.length - 1 - i]; 
                runningAccumulation += w.pnl + l.pnl;
                if (runningAccumulation > peakAccumulation) peakAccumulation = runningAccumulation;
            }

            let now = Date.now();
            let state = await GrowthState.findOne({ userId: u._id });
            
            // Initialize Database State if missing
            if (!state) {
                state = await GrowthState.create({
                    userId: u._id, lastPeak: peakAccumulation, livePeak: peakAccumulation,
                    lastTime: now, nextCloseTime: now + windowMs
                });
            }

            let elapsed = now - state.lastTime;
            state.livePeak = peakAccumulation;

            // Trigger Search Window
            if (elapsed >= windowMs) {
                let deltaGrowth = peakAccumulation - state.lastPeak;
                let symbolsClosed = [];
                
                if (Math.abs(deltaGrowth) >= 0.0001) {
                    let target = deltaGrowth;
                    let bestMatch = null;
                    let smallestDiff = Infinity;
                    const TOLERANCE = 0.0015; 

                    for (let c of activeCandidates) {
                        let diff = Math.abs(c.pnl - target);
                        if (diff <= TOLERANCE && diff < smallestDiff) { smallestDiff = diff; bestMatch = [c]; }
                    }

                    for (let i = 0; i < activeCandidates.length; i++) {
                        for (let j = i + 1; j < activeCandidates.length; j++) {
                            let sum = activeCandidates[i].pnl + activeCandidates[j].pnl;
                            let diff = Math.abs(sum - target);
                            if (diff <= TOLERANCE && diff < smallestDiff) { smallestDiff = diff; bestMatch = [activeCandidates[i], activeCandidates[j]]; }
                        }
                    }

                    if (bestMatch && bestMatch.length > 0) {
                        let actualNetClosed = 0;

                        for (let pos of bestMatch) {
                            try {
                                if (!u.isPaper && pos.subAccount.apiKey) {
                                    const exchange = new ccxt.htx({ apiKey: pos.subAccount.apiKey, secret: pos.subAccount.secret, options: { defaultType: 'swap' } });
                                    const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                                    await exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close' });
                                } else {
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

                                pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.pnl;
                                await SettingsModel.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } });

                            } catch (e) { console.error(`Growth Execution Error: ${e.message}`); }
                        }

                        await OffsetModel.create({ userId: u._id, symbol: symbolsClosed.join(' & '), winnerSymbol: 'Growth', loserSymbol: 'Match', reason: `${windowMinutes}-Min Growth Target Met`, netProfit: actualNetClosed });
                        await GrowthExecution.create({ userId: u._id, isPaper: u.isPaper, deltaGrowth: deltaGrowth, executedPnl: actualNetClosed, coins: symbolsClosed });
                    } else {
                        await GrowthExecution.create({ userId: u._id, isPaper: u.isPaper, deltaGrowth: deltaGrowth, executedPnl: 0, coins: ['No Tolerance Match Found'] });
                    }
                }

                // Reset Baseline after window triggers
                let newBaselinePeak = peakAccumulation;
                if (symbolsClosed.length > 0) {
                    let remainingCandidates = activeCandidates.filter(c => !symbolsClosed.includes(c.symbol));
                    remainingCandidates.sort((a, b) => b.pnl - a.pnl);
                    const remPairs = Math.floor(remainingCandidates.length / 2);
                    newBaselinePeak = 0; let runningAcc = 0;
                    for (let i = 0; i < remPairs; i++) {
                        runningAcc += remainingCandidates[i].pnl + remainingCandidates[remainingCandidates.length - 1 - i].pnl;
                        if (runningAcc > newBaselinePeak) newBaselinePeak = runningAcc;
                    }
                }

                state.lastPeak = newBaselinePeak;
                state.livePeak = newBaselinePeak; 
                state.lastTime = now;
                state.nextCloseTime = now + windowMs;
            }

            // Save state updates to MongoDB (Vercel-proof)
            await state.save();
        }
    } catch (e) {
        console.error("Growth Engine Error:", e);
    } finally {
        global.isGrowthExecuting = false;
    }
};

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

// CRON JOB ENDPOINT
app.get('/api/ping', async (req, res) => { 
    await connectDB(); 
    
    // Will run multiple database checks within the 25 seconds Vercel keeps the function open
    const endTime = Date.now() + 25000; 
    let cycles = 0;
    while (Date.now() < endTime) {
        if (!global.isGrowthExecuting) await processGrowthExecution(); 
        cycles++;
        await new Promise(resolve => setTimeout(resolve, 4000)); // Sleep 4s to prevent DB spam
    }
    res.status(200).json({ success: true, pingCycles: cycles, message: "Serverless Database State Checked" }); 
});

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
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const settings = await SettingsModel.findOne({ userId: req.userId }).lean();
    const windowMinutes = settings?.growthWindowMinutes || 1;
    
    let state = await GrowthState.findOne({ userId: req.userId }).lean();
    if (!state) {
        state = { livePeak: 0, nextCloseTime: Date.now() + (windowMinutes * 60000), lastPeak: 0 };
    }
    
    res.json({ ...state, windowMinutes });
});

app.post('/api/growth/settings', authMiddleware, async (req, res) => {
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    let windowMinutes = parseInt(req.body.windowMinutes);
    if (isNaN(windowMinutes) || windowMinutes < 1) windowMinutes = 1;
    
    await SettingsModel.updateOne({ userId: req.userId }, { $set: { growthWindowMinutes: windowMinutes } });
    
    const state = await GrowthState.findOne({ userId: req.userId });
    if (state) {
        state.nextCloseTime = state.lastTime + (windowMinutes * 60000);
        await state.save();
    }
    
    res.json({ success: true, windowMinutes });
});

app.get('/api/growth/history', authMiddleware, async (req, res) => {
    const history = await GrowthExecution.find({ userId: req.userId }).sort({ timestamp: -1 }).limit(50);
    const totalExecutedProfit = history.reduce((sum, t) => sum + t.executedPnl, 0);
    res.json({ history, totalExecutedProfit });
});

// ==========================================
// 5. FRONTEND UI (MATERIAL DESIGN - GREEN BASE)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Growth Executer Bot</title>
        <!-- Material Icons & Clean Fonts -->
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <link href="https://fonts.googleapis.com/icon?family=Material+Icons+Round" rel="stylesheet">
        <style>
            :root { 
                --bg: #f4f7f6; --surface: #ffffff; --surface-border: #e0e0e0; 
                --text: #2c3e50; --text-muted: #7f8c8d;
                --primary: #2e7d32; --primary-light: #4caf50; --primary-hover: #1b5e20; 
                --up-color: #2e7d32; --down-color: #c62828; --warn-color: #f57c00;
                --shadow-sm: 0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.03);
                --shadow-md: 0 4px 6px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.04);
                --shadow-lg: 0 10px 15px rgba(0,0,0,0.05), 0 4px 6px rgba(0,0,0,0.03);
            }
            body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; }
            
            .navbar { background: var(--surface); border-bottom: 1px solid var(--surface-border); padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; box-shadow: var(--shadow-sm); }
            .logo { font-size: 1.4rem; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; letter-spacing: -0.5px; }
            .logo .material-icons-round { color: var(--primary); font-size: 1.8rem; }
            .logo span { color: var(--primary); }
            
            .container { max-width: 1200px; margin: 40px auto; padding: 0 20px; }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; margin-bottom: 32px; }
            
            .panel { background: var(--surface); border: 1px solid var(--surface-border); border-radius: 12px; padding: 28px; box-shadow: var(--shadow-md); transition: transform 0.2s, box-shadow 0.2s; }
            .panel:hover { box-shadow: var(--shadow-lg); transform: translateY(-2px); }
            .panel h2 { margin: 0 0 16px 0; font-size: 0.95rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px; }
            .panel h2 .material-icons-round { font-size: 1.2rem; color: var(--primary-light); }
            
            .big-stat { font-size: 2.4rem; font-weight: 700; margin: 0; }
            .text-up { color: var(--up-color); }
            .text-down { color: var(--down-color); }
            .text-warn { color: var(--warn-color); }
            
            .input-group { position: relative; margin-bottom: 16px; display: flex; align-items: center; }
            .input-group .material-icons-round { position: absolute; left: 14px; color: var(--text-muted); font-size: 1.2rem; }
            input { width: 100%; padding: 14px 14px 14px 44px; background: #fafafa; border: 1px solid var(--surface-border); color: var(--text); border-radius: 8px; font-family: 'Inter', sans-serif; font-size: 0.95rem; transition: border-color 0.2s, background 0.2s; box-sizing: border-box; }
            input:focus { border-color: var(--primary); background: #fff; outline: none; box-shadow: 0 0 0 3px rgba(76, 175, 80, 0.15); }
            
            .btn { width: 100%; padding: 14px; background: var(--primary); border: none; color: white; font-weight: 600; font-size: 0.95rem; border-radius: 8px; cursor: pointer; transition: background 0.2s, transform 0.1s, box-shadow 0.2s; display: flex; justify-content: center; align-items: center; gap: 8px; box-shadow: 0 2px 4px rgba(46, 125, 50, 0.2); }
            .btn:hover { background: var(--primary-hover); transform: translateY(-1px); box-shadow: 0 4px 8px rgba(46, 125, 50, 0.3); }
            .btn:active { transform: translateY(0); box-shadow: none; }
            
            table { width: 100%; border-collapse: collapse; text-align: left; }
            th { padding: 16px; border-bottom: 2px solid var(--surface-border); color: var(--text-muted); font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
            td { padding: 16px; border-bottom: 1px solid var(--surface-border); font-size: 0.95rem; color: var(--text); }
            tr:hover td { background-color: #f9fbf9; }
            
            .coin-badge { display: inline-flex; align-items: center; background: #e8f5e9; border: 1px solid #c8e6c9; padding: 4px 10px; border-radius: 6px; font-size: 0.8rem; font-weight: 600; margin: 2px; color: var(--primary); }
            .timer-box { font-size: 2.2rem; font-weight: 700; color: var(--text); letter-spacing: 1px; }
            #auth-view { max-width: 420px; margin: 12vh auto; }
            #dashboard-view { display: none; }
            .flex-center { display: flex; align-items: center; gap: 12px; }
        </style>
    </head>
    <body>
        <div id="auth-view" class="panel">
            <div class="logo" style="justify-content: center; margin-bottom: 32px;"><span class="material-icons-round">eco</span> Auto<span>Growth</span></div>
            <div class="input-group"><span class="material-icons-round">person</span><input type="text" id="username" placeholder="HTX Bot Username"></div>
            <div class="input-group"><span class="material-icons-round">lock</span><input type="password" id="password" placeholder="Password"></div>
            <button class="btn" onclick="login()"><span class="material-icons-round" style="font-size: 1.2rem;">login</span> SECURE LOGIN</button>
            <p id="auth-msg" style="text-align: center; color: var(--down-color); font-size: 0.9rem; margin-top: 16px; font-weight: 500;"></p>
        </div>

        <div id="dashboard-view">
            <div class="navbar">
                <div class="logo"><span class="material-icons-round">eco</span> Auto<span>Growth</span></div>
                <div class="flex-center">
                    <span id="user-display" style="color: var(--text-muted); font-weight: 500; display: flex; align-items: center; gap: 6px;"></span>
                    <a href="#" onclick="logout()" style="color: var(--down-color); text-decoration: none; font-weight: 600; display: flex; align-items: center; gap: 4px; margin-left: 16px;">
                        <span class="material-icons-round" style="font-size: 1.2rem;">logout</span> Disconnect
                    </a>
                </div>
            </div>

            <div class="container">
                <div class="grid">
                    <div class="panel">
                        <h2><span class="material-icons-round">schedule</span> Next Search Window</h2>
                        <div class="timer-box" id="countdown">00:00</div>
                        <div style="margin-top: 20px; display: flex; align-items: center; gap: 12px;">
                            <div class="input-group" style="margin: 0; width: 120px;">
                                <span class="material-icons-round" style="font-size: 1.1rem; left: 10px;">timer</span>
                                <input type="number" id="window-input" min="1" step="1" style="padding-left: 36px; text-align: center; padding-top: 10px; padding-bottom: 10px;">
                            </div>
                            <span style="color: var(--text-muted); font-size: 0.9rem; font-weight: 500;">Mins</span>
                            <button class="btn" style="width: auto; padding: 10px 24px; font-size: 0.85rem;" onclick="saveWindowSettings()">SAVE</button>
                        </div>
                    </div>
                    
                    <div class="panel">
                        <h2><span class="material-icons-round">track_changes</span> Current Peak Target</h2>
                        <div class="big-stat text-warn" id="live-delta">$0.0000</div>
                        <div style="margin-top: 8px; font-size: 0.9rem; color: var(--text-muted); display: flex; align-items: center; gap: 6px;">
                            <span class="material-icons-round" style="font-size: 1.1rem;">info</span> Growth delta since last cycle
                        </div>
                    </div>
                    
                    <div class="panel" style="border: 2px solid var(--primary-light); background: #fcfdfc;">
                        <h2 style="color: var(--primary);"><span class="material-icons-round">account_balance_wallet</span> Total Auto-Growth</h2>
                        <div class="big-stat text-up" id="total-profit">$0.00</div>
                    </div>
                </div>

                <div class="panel">
                    <h2><span class="material-icons-round">history</span> Real Market Executions</h2>
                    <div style="overflow-x: auto; margin-top: 10px;">
                        <table id="trades-table">
                            <thead>
                                <tr><th>Date & Time</th><th>Target Growth</th><th>Executed PNL</th><th>Status</th><th>Coins Closed</th></tr>
                            </thead>
                            <tbody id="trades-body">
                                <tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">Waiting for execution data...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>

        <script>
            let token = localStorage.getItem('g_token');
            let nextCloseMs = Date.now() + 60000;
            let syncInterval, uiInterval;

            async function checkAuth() {
                if (!token) { document.getElementById('auth-view').style.display = 'block'; document.getElementById('dashboard-view').style.display = 'none'; return; }
                try {
                    const res = await fetch('/api/growth/me', { headers: { 'Authorization': 'Bearer ' + token } });
                    if (!res.ok) throw new Error();
                    const data = await res.json();
                    
                    const modeHtml = data.isPaper ? '<span style="background: #e0e0e0; color: #616161; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; margin-left: 8px;">PAPER</span>' : '<span style="background: #e8f5e9; color: #2e7d32; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; margin-left: 8px; font-weight: bold;">LIVE</span>';
                    document.getElementById('user-display').innerHTML = '<span class="material-icons-round" style="font-size: 1.2rem;">account_circle</span> ' + data.username + modeHtml;
                    document.getElementById('auth-view').style.display = 'none'; document.getElementById('dashboard-view').style.display = 'block';
                    startEngine();
                } catch(e) { logout(); }
            }

            async function login() {
                const user = document.getElementById('username').value;
                const pass = document.getElementById('password').value;
                const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
                const data = await res.json();
                if (data.token) { token = data.token; localStorage.setItem('g_token', token); checkAuth(); } 
                else { document.getElementById('auth-msg').innerText = "Invalid credentials. Please try again."; }
            }

            function logout() { localStorage.removeItem('g_token'); token = null; if(syncInterval) clearInterval(syncInterval); if(uiInterval) clearInterval(uiInterval); checkAuth(); }

            function startEngine() { syncData(); syncInterval = setInterval(syncData, 5000); uiInterval = setInterval(updateUI, 1000); }

            async function saveWindowSettings() {
                const val = document.getElementById('window-input').value;
                await fetch('/api/growth/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ windowMinutes: val }) });
                syncData(); 
            }

            async function syncData() {
                const liveRes = await fetch('/api/growth/live', { headers: { 'Authorization': 'Bearer ' + token } });
                const liveData = await liveRes.json();
                
                nextCloseMs = liveData.nextCloseTime;
                if (document.activeElement !== document.getElementById('window-input')) document.getElementById('window-input').value = liveData.windowMinutes || 1;
                
                let delta = (liveData.livePeak || 0) - (liveData.lastPeak || 0);
                const deltaEl = document.getElementById('live-delta');
                deltaEl.innerText = (delta >= 0 ? '+$' : '-$') + Math.abs(delta).toFixed(4);
                deltaEl.className = 'big-stat ' + (delta >= 0 ? 'text-up' : 'text-down');

                const tradeRes = await fetch('/api/growth/history', { headers: { 'Authorization': 'Bearer ' + token } });
                const tradeData = await tradeRes.json();
                
                const tpEl = document.getElementById('total-profit');
                let tp = tradeData.totalExecutedProfit || 0;
                tpEl.innerText = (tp >= 0 ? '+$' : '-$') + Math.abs(tp).toFixed(4);
                tpEl.className = 'big-stat ' + (tp >= 0 ? 'text-up' : 'text-down');
                renderTable(tradeData.history);
            }

            function renderTable(history) {
                const tbody = document.getElementById('trades-body');
                if (!history || history.length === 0) { tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;"><span class="material-icons-round" style="font-size: 2rem; color: #e0e0e0; display: block; margin-bottom: 8px;">manage_search</span> Engine is actively scanning. No executions yet.</td></tr>'; return; }

                let html = '';
                history.forEach(t => {
                    let d = new Date(t.timestamp);
                    let targetClass = t.deltaGrowth >= 0 ? 'text-up' : 'text-down';
                    let execClass = t.executedPnl >= 0 ? 'text-up' : 'text-down';
                    
                    let coinHtml = t.coins.map(c => {
                        if (c === 'No Tolerance Match Found') return '<span style="color: var(--down-color); font-size: 0.85rem; font-weight: 500;"><span class="material-icons-round" style="font-size:1rem; vertical-align:middle; margin-right:4px;">warning</span>No Math Match</span>';
                        return '<span class="coin-badge">' + c.split('/')[0] + '</span>';
                    }).join('');

                    let status = t.executedPnl === 0 && t.coins[0] === 'No Tolerance Match Found' 
                        ? '<span style="color: var(--text-muted); font-weight: 600; display:flex; align-items:center; gap:4px;"><span class="material-icons-round" style="font-size:1.1rem;">skip_next</span> SKIPPED</span>' 
                        : '<span style="color: var(--up-color); font-weight: 600; display:flex; align-items:center; gap:4px;"><span class="material-icons-round" style="font-size:1.1rem;">check_circle</span> EXECUTED</span>';

                    html += '<tr>' +
                        '<td style="color: var(--text-muted); font-size: 0.85rem;">' + d.toLocaleDateString() + ' <br><strong style="color: var(--text);">' + d.toLocaleTimeString() + '</strong></td>' +
                        '<td class="' + targetClass + '" style="font-weight: 600;">' + (t.deltaGrowth >= 0 ? '+' : '') + '$' + t.deltaGrowth.toFixed(4) + '</td>' +
                        '<td class="' + execClass + '" style="font-weight: 700; font-size: 1.05rem;">' + (t.executedPnl >= 0 ? '+' : '') + '$' + t.executedPnl.toFixed(4) + '</td>' +
                        '<td>' + status + '</td>' +
                        '<td>' + coinHtml + '</td>' +
                    '</tr>';
                });
                tbody.innerHTML = html;
            }

            function updateUI() {
                let diff = nextCloseMs - Date.now();
                if (diff < 0) diff = 0;
                let mins = Math.floor(diff / 60000); let secs = Math.floor((diff % 60000) / 1000);
                document.getElementById('countdown').innerText = (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
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
