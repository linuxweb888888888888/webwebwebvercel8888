const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const https = require('https');

// Safe Bcrypt Fallback
let bcrypt;
try { bcrypt = require('bcryptjs'); } 
catch (err) { try { bcrypt = require('bcrypt'); } catch (e) { console.error("⚠️ Bcrypt missing!"); } }

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_this_in_production';

// DATABASE URL
const MONGO_URI = 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';

const PREDEFINED_COINS = ["OP","BIGTIME","MOVE","SSV","COAI","TIA","MERL","MASK","PYTH","ETHFI","CFX","MEME","LUNA","STEEM","BERA","2Z","FIL","APT","1INCH","ARB","XPL","ENA","MMT","AXS","TON","CAKE","BSV","JUP","WIF","LIGHT","PI","SUSHI","LPT","CRV","TAO","ORDI","YFI","LA","ICP","FTT","GIGGLE","LDO","OPN","INJ","SNX","DASH","WLD","KAITO","TRUMP","WAVES","ZEN","ENS","ASTER","VIRTUAL"];

// ==========================================
// 1. MONGODB SETUP & SCHEMAS
// ==========================================
let cachedDb = global.mongoose;
if (!cachedDb) { cachedDb = global.mongoose = { conn: null, promise: null }; }
const connectDB = async () => {
    if (cachedDb.conn) return cachedDb.conn;
    if (!cachedDb.promise) {
        cachedDb.promise = mongoose.connect(MONGO_URI, { bufferCommands: false, maxPoolSize: 10 }).then(m => m).catch(e => { cachedDb.promise = null; throw e; });
    }
    cachedDb.conn = await cachedDb.promise; return cachedDb.conn;
};

const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({ username: { type: String, required: true, unique: true }, password: { type: String, required: true }, plainPassword: { type: String }, isPaper: { type: Boolean, default: true } }));
const CoinSettingSchema = new mongoose.Schema({ symbol: { type: String, required: true }, side: { type: String, default: 'long' }, botActive: { type: Boolean, default: true } });
const SubAccountSchema = new mongoose.Schema({ name: { type: String }, apiKey: { type: String }, secret: { type: String }, side: { type: String, default: 'long' }, leverage: { type: Number, default: 10 }, baseQty: { type: Number, default: 1 }, takeProfitPct: { type: Number, default: 5 }, takeProfitPnl: { type: Number, default: 0 }, stopLossPct: { type: Number, default: -25 }, triggerDcaPnl: { type: Number, default: -2 }, maxContracts: { type: Number, default: 1000 }, realizedPnl: { type: Number, default: 0 }, coins: [CoinSettingSchema] });
const SettingsSchema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, required: true }, qtyMultiplier: { type: Number, default: 1 }, globalTargetPnl: { type: Number, default: 0 }, globalTrailingPnl: { type: Number, default: 0 }, globalSingleCoinTpPnl: { type: Number, default: 0 }, globalTriggerDcaPnl: { type: Number, default: 0 }, smartOffsetNetProfit: { type: Number, default: 0 }, smartOffsetBottomRowV1: { type: Number, default: 5 }, smartOffsetBottomRowV1StopLoss: { type: Number, default: 0 }, smartOffsetStopLoss: { type: Number, default: 0 }, smartOffsetNetProfit2: { type: Number, default: 0 }, smartOffsetStopLoss2: { type: Number, default: 0 }, smartOffsetMaxLossPerMinute: { type: Number, default: 0 }, smartOffsetMaxLossTimeframeSeconds: { type: Number, default: 60 }, minuteCloseAutoDynamic: { type: Boolean, default: false }, minuteCloseTpMinPnl: { type: Number, default: 0 }, minuteCloseTpMaxPnl: { type: Number, default: 0 }, minuteCloseSlMinPnl: { type: Number, default: 0 }, minuteCloseSlMaxPnl: { type: Number, default: 0 }, noPeakSlTimeframeSeconds: { type: Number, default: 1800 }, noPeakSlGatePnl: { type: Number, default: 0 }, subAccounts: [SubAccountSchema], currentGlobalPeak: { type: Number, default: 0 }, lastStopLossTime: { type: Number, default: 0 }, lastNoPeakSlTime: { type: Number, default: 0 }, rollingStopLosses: { type: Array, default: [] }, autoDynamicLastExecution: { type: Object, default: null } });
const OffsetRecordSchema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, required: true }, symbol: { type: String }, reason: { type: String }, winnerSymbol: { type: String }, netProfit: { type: Number }, timestamp: { type: Date, default: Date.now } });
const ProfileStateSchema = new mongoose.Schema({ profileId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true }, userId: { type: mongoose.Schema.Types.ObjectId, required: true }, logs: { type: [String], default: [] }, coinStates: { type: mongoose.Schema.Types.Mixed, default: {} }, lastUpdated: { type: Date, default: Date.now } });
const MainTemplateSchema = new mongoose.Schema({ name: { type: String, required: true, unique: true }, settings: { type: Object, required: true } });

const RealSettings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema, 'settings');
const PaperSettings = mongoose.models.PaperSettings || mongoose.model('PaperSettings', SettingsSchema, 'paper_settings');
const RealOffsetRecord = mongoose.models.OffsetRecord || mongoose.model('OffsetRecord', OffsetRecordSchema, 'offset_records');
const PaperOffsetRecord = mongoose.models.PaperOffsetRecord || mongoose.model('PaperOffsetRecord', OffsetRecordSchema, 'paper_offset_records');
const RealProfileState = mongoose.models.ProfileState || mongoose.model('ProfileState', ProfileStateSchema, 'profile_states');
const PaperProfileState = mongoose.models.PaperProfileState || mongoose.model('PaperProfileState', ProfileStateSchema, 'paper_profile_states');
const MainTemplate = mongoose.models.MainTemplate || mongoose.model('MainTemplate', MainTemplateSchema, 'main_settings_template');

// ==========================================
// ORACLES & BOT ENGINE
// ==========================================
global.customMaxLeverages = {}; global.livePrices = {}; global.activeBots = new Map();
let isBinanceFetching = false; let isHtxFetching = false;
const binanceOracle = new ccxt.binance({ options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 20000 });
const htxOracle = new ccxt.htx({ options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 30000 });

function fetchCustomMaxLeveragesPromise() {
    return new Promise((resolve) => {
        https.get('https://api.hbdm.com/linear-swap-api/v1/swap_cross_adjustfactor', (res) => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (parsed && parsed.data) parsed.data.forEach(item => { const sym = item.contract_code.replace('-', '/') + ':USDT'; let maxL = 1; if (item.list) item.list.forEach(t => { if (t.lever_rate > maxL) maxL = t.lever_rate; }); global.customMaxLeverages[sym] = maxL; });
                } catch(e){} resolve();
            });
        }).on('error', ()=>resolve());
    });
}
function getLeverageForCoin(symbol) { return global.customMaxLeverages[symbol] || (symbol.includes('BTC') ? 125 : symbol.includes('ETH') ? 100 : 20); }

function startPriceOracle() {
    setInterval(async () => { if (isBinanceFetching) return; isBinanceFetching = true; try { const tickers = await binanceOracle.fetchTickers(); for (let sym in tickers) { if (tickers[sym]?.last) global.livePrices[sym] = tickers[sym].last; } } catch(e){} isBinanceFetching = false; }, 3000);
    setInterval(async () => { if (isHtxFetching) return; isHtxFetching = true; try { const tickers = await htxOracle.fetchTickers(); for (let sym in tickers) { if (tickers[sym]?.last) global.livePrices[sym] = tickers[sym].last; } } catch(e){} isHtxFetching = false; }, 5000);
    setInterval(fetchCustomMaxLeveragesPromise, 3600000);
}

function logForProfile(profileId, msg) {
    const bot = global.activeBots.get(profileId);
    if (bot) { bot.state.logs.unshift(`${new Date().toLocaleTimeString()} - ${msg}`); if (bot.state.logs.length > 50) bot.state.logs.pop(); }
}

async function startBot(userId, subAccount, isPaper) {
    const userDoc = await User.findById(userId); if (userDoc && userDoc.username === 'webcoin8888') return;
    const profileId = subAccount._id.toString(); if (global.activeBots.has(profileId)) stopBot(profileId);
    if (!subAccount.apiKey || !subAccount.secret) return;

    const exchange = new ccxt.htx({ apiKey: subAccount.apiKey, secret: subAccount.secret, options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 30000 });
    const ProfileStateModel = isPaper ? PaperProfileState : RealProfileState; const SettingsModel = isPaper ? PaperSettings : RealSettings;
    let dbState = await ProfileStateModel.findOne({ profileId }); if (!dbState) dbState = await ProfileStateModel.create({ profileId, userId, logs: [], coinStates: {} });
    const globalSettings = await SettingsModel.findOne({ userId }); const state = { logs: dbState.logs || [], coinStates: dbState.coinStates || {} };
    let isProcessing = false;

    const intervalId = setInterval(async () => {
        if (isProcessing) return; isProcessing = true;
        const botData = global.activeBots.get(profileId); if (!botData) { isProcessing = false; return; }
        const currentSettings = botData.settings; const activeCoins = currentSettings.coins.filter(c => c.botActive);
        if (activeCoins.length === 0) { isProcessing = false; return; }

        try {
            if (!exchange.markets || Object.keys(exchange.markets).length === 0) await exchange.loadMarkets().catch(()=>{});
            let positions = []; if (!isPaper) positions = await exchange.fetchPositions().catch(()=>{});

            for (let coin of activeCoins) {
                const actLev = getLeverageForCoin(coin.symbol); const actSide = coin.side || currentSettings.side;
                if (!state.coinStates[coin.symbol]) state.coinStates[coin.symbol] = { status: 'Running', contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0, lastDcaTime: 0, lockUntil: 0, dcaCount: 0 };
                let cState = state.coinStates[coin.symbol];
                if (cState.lockUntil && Date.now() < cState.lockUntil) continue;
                const cPrice = global.livePrices[coin.symbol]; if (!cPrice) continue; cState.currentPrice = cPrice; cState.activeSide = actSide;

                if (!isPaper) {
                    const pos = positions.find(p => p.symbol === coin.symbol && p.side === actSide && parseFloat(p.contracts || 0) > 0);
                    cState.actualLeverage = pos?.info?.lever_rate ? parseInt(pos.info.lever_rate) : actLev;
                    cState.contracts = pos ? parseFloat(pos.contracts || 0) : 0; cState.avgEntry = pos ? parseFloat(pos.entryPrice || 0) : 0;
                    if (cState.contracts === 0) cState.dcaCount = 0;
                    let gPnl = pos?.unrealizedPnl ? parseFloat(pos.unrealizedPnl) : 0;
                    cState.unrealizedPnl = cState.contracts > 0 ? (gPnl - (cState.contracts * cPrice * 0.001)) : 0;
                    cState.margin = pos ? (parseFloat(pos.initialMargin) || 0) : 0;
                    if (cState.margin === 0 && cState.contracts > 0) cState.margin = (cState.contracts * cState.avgEntry) / cState.actualLeverage;
                    cState.currentRoi = (cState.margin > 0 && cState.contracts > 0) ? (cState.unrealizedPnl / cState.margin) * 100 : 0;
                    cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting';
                } else {
                    cState.actualLeverage = actLev; if (cState.contracts === 0) cState.dcaCount = 0;
                    cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting';
                    if (cState.contracts > 0) {
                        cState.margin = (cState.avgEntry * cState.contracts) / actLev;
                        let gPnl = (actSide === 'long') ? (cPrice - cState.avgEntry) * cState.contracts : (cState.avgEntry - cPrice) * cState.contracts;
                        cState.unrealizedPnl = gPnl - (cState.contracts * cPrice * 0.001);
                        cState.currentRoi = cState.margin > 0 ? (cState.unrealizedPnl / cState.margin) * 100 : 0;
                    } else { cState.unrealizedPnl = 0; cState.margin = 0; cState.currentRoi = 0; }
                }

                if (cState.contracts <= 0) {
                    const reqQty = Math.max(1, Math.floor(currentSettings.baseQty));
                    if (!isPaper) await exchange.createOrder(coin.symbol, 'market', actSide==='long'?'buy':'sell', reqQty, undefined, { offset: 'open', lever_rate: actLev }).catch(()=>{});
                    else { cState.avgEntry = cPrice; cState.contracts = reqQty; }
                    cState.lockUntil = Date.now() + 5000; continue;
                }

                const gTp = parseFloat(botData.globalSettings?.globalSingleCoinTpPnl) || 0; const tpPnl = gTp > 0 ? gTp : parseFloat(currentSettings.takeProfitPnl);
                const tpPct = parseFloat(currentSettings.takeProfitPct) || 0; const slPct = parseFloat(currentSettings.stopLossPct) || -25;
                let isTp = (tpPnl > 0 && cState.unrealizedPnl >= tpPnl) || (tpPct > 0 && cState.currentRoi >= tpPct);
                let isSl = (slPct < 0 && cState.currentRoi <= slPct);

                if (isTp || isSl) {
                    try {
                        if (!isPaper) await exchange.createOrder(coin.symbol, 'market', actSide==='long'?'sell':'buy', cState.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: cState.actualLeverage });
                        else { cState.contracts = 0; cState.unrealizedPnl = 0; }
                        cState.lockUntil = Date.now() + 5000; cState.dcaCount = 0; currentSettings.realizedPnl += cState.unrealizedPnl;
                        SettingsModel.updateOne({ "subAccounts._id": currentSettings._id }, { $set: { "subAccounts.$.realizedPnl": currentSettings.realizedPnl } }).catch(()=>{});
                        continue;
                    } catch (e) { continue; }
                }

                const gDca = parseFloat(botData.globalSettings?.globalTriggerDcaPnl) || 0; const baseDca = gDca < 0 ? gDca : parseFloat(currentSettings.triggerDcaPnl);
                const actDcaPnl = baseDca * ((cState.dcaCount || 0) + 1);
                if (baseDca < 0 && cState.unrealizedPnl <= actDcaPnl && (Date.now() - (cState.lastDcaTime || 0) > 12000)) {
                    const reqQty = cState.contracts > 0 ? cState.contracts : 1;
                    if ((cState.contracts + reqQty) <= currentSettings.maxContracts) {
                        if (!isPaper) await exchange.createOrder(coin.symbol, 'market', actSide==='long'?'buy':'sell', reqQty, undefined, { offset: 'open', lever_rate: actLev }).catch(()=>{});
                        else { const tot = (cState.contracts * cState.avgEntry) + (reqQty * cPrice); cState.contracts += reqQty; cState.avgEntry = tot / cState.contracts; }
                        cState.dcaCount = (cState.dcaCount || 0) + 1; cState.lockUntil = Date.now() + 5000; cState.lastDcaTime = Date.now();
                    }
                }
            }
            await ProfileStateModel.updateOne( { profileId }, { $set: { logs: state.logs, coinStates: state.coinStates, lastUpdated: Date.now() } } ).catch(()=>{});
        } catch (err) { } finally { isProcessing = false; }
    }, 6000);
    global.activeBots.set(profileId, { userId: String(userId), isPaper, settings: subAccount, globalSettings, state, exchange, intervalId });
}
function stopBot(profileId) { if (global.activeBots.has(profileId)) { clearInterval(global.activeBots.get(profileId).intervalId); global.activeBots.delete(profileId); } }

const executeOneMinuteCloser = async () => {};
const executeGlobalProfitMonitor = async () => {};
const syncMainSettingsTemplate = async () => {};

const bootstrapBots = async () => {
    if (!global.botLoopsStarted) {
        global.botLoopsStarted = true;
        try {
            await connectDB(); await syncMainSettingsTemplate(); await fetchCustomMaxLeveragesPromise(); startPriceOracle();
            const papers = await PaperSettings.find({}); papers.forEach(s => { if (s.subAccounts) s.subAccounts.forEach(sub => { if (sub.coins) startBot(s.userId.toString(), sub, true).catch(()=>{}); }); });
            const reals = await RealSettings.find({}); reals.forEach(s => { if (s.subAccounts) s.subAccounts.forEach(sub => { if (sub.coins) startBot(s.userId.toString(), sub, false).catch(()=>{}); }); });
        } catch(e) {}
    }
};

// ==========================================
// API ROUTES
// ==========================================
const app = express(); app.use(express.json());
const authMw = async (req, res, next) => { await connectDB(); const t = req.headers.authorization?.split(' ')[1]; if (!t) return res.status(401).json({error:'Unauthorized'}); jwt.verify(t, JWT_SECRET, async (err, d) => { if (err) return res.status(403).json({error:'Invalid'}); req.userId = d.userId; const u = await User.findById(d.userId); if (!u) return res.status(401).json({error:'Not found'}); req.isPaper = u.isPaper; req.username = u.username; next(); }); };
const adminMw = (req, res, next) => { if (req.username !== 'webcoin8888') return res.status(403).json({error:'Admin only'}); next(); };

app.post('/api/register', async (req, res) => {
    bootstrapBots().catch(()=>{}); await connectDB();
    const { username, password, authCode } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username/Password required' });
    const isPaper = authCode !== 'webcoin8888';
    try {
        const hash = await bcrypt.hash(password, 10);
        const user = await User.create({ username, password: hash, plainPassword: password, isPaper });
        const SettingsModel = isPaper ? PaperSettings : RealSettings;
        await SettingsModel.create({ userId: user._id, subAccounts: [{ name: "Default Profile", apiKey: isPaper?'paper':'', secret: isPaper?'paper':'', coins: [{ symbol: 'BTC/USDT:USDT', side: 'long', botActive: true }] }] });
        res.json({ success: true, message: "Registered!" });
    } catch(e) { res.status(400).json({ error: "Username taken" }); }
});

app.post('/api/login', async (req, res) => {
    bootstrapBots().catch(()=>{}); await connectDB();
    const { username, password } = req.body; const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ token: jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' }), isPaper: user.isPaper, username: user.username });
});

app.get('/api/me', authMw, (req, res) => res.json({ isPaper: req.isPaper, username: req.username }));
app.get('/api/settings', authMw, async (req, res) => { const Model = req.isPaper ? PaperSettings : RealSettings; res.json((await Model.findOne({ userId: req.userId }).lean()) || {}); });
app.get('/api/status', authMw, async (req, res) => {
    const Model = req.isPaper ? PaperSettings : RealSettings; const s = await Model.findOne({ userId: req.userId });
    const states = {}; for (let [pid, b] of activeBots.entries()) { if (b.userId === req.userId.toString()) states[pid] = b.state; }
    res.json({ states, subAccounts: s ? s.subAccounts : [], globalSettings: s });
});
app.get('/api/offsets', authMw, async (req, res) => { const Model = req.isPaper ? PaperOffsetRecord : RealOffsetRecord; res.json(await Model.find({ userId: req.userId }).sort({ timestamp: -1 }).limit(100)); });
app.get('/api/admin/users', authMw, adminMw, async (req, res) => { res.json(await User.find({ username: { $ne: 'webcoin8888' } }).lean()); });
app.get('/api/admin/status', authMw, adminMw, async (req, res) => { res.json({ templateSafe: true, webcoinSafe: true }); });
app.get('/api/admin/editor-data', authMw, adminMw, async (req, res) => { res.json({ masterSettings: await RealSettings.findOne({ userId: (await User.findOne({ username: 'webcoin8888' }))._id }).lean() }); });
app.post('/api/settings', authMw, async (req, res) => { const Model = req.isPaper ? PaperSettings : RealSettings; const updated = await Model.findOneAndUpdate({ userId: req.userId }, { $set: req.body }, { returnDocument: 'after', upsert: true }); res.json({ success: true, settings: updated }); });
app.post('/api/master/global', authMw, adminMw, async (req, res) => { res.json({ success: true, message: "Saved" }); });
app.post('/api/master/profile/:index', authMw, adminMw, async (req, res) => { res.json({ success: true, message: "Saved" }); });
// ==========================================
// 7. FRONTEND UI (MATERIAL DESIGN)
// ==========================================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HTX Bot (DUAL MODE)</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet" />
    <style>
        :root { --primary: #1976D2; --success: #2E7D32; --danger: #D32F2F; --warning: #ED6C02; --surface: #FFFFFF; --background: #F5F5F6; --text-primary: #212121; --text-secondary: #616161; --divider: #E0E0E0; }
        body { font-family: 'Roboto', sans-serif; background: var(--background); color: var(--text-primary); margin: 0; padding: 0; }
        .app-bar { background: var(--surface); box-shadow: 0 2px 4px rgba(0,0,0,0.1); padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 1000; }
        .app-title { font-size: 1.5em; font-weight: 700; color: var(--primary); display: flex; align-items: center; gap: 8px; margin:0;}
        .container { max-width: 1300px; margin: 24px auto; padding: 0 16px; }
        .flex-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
        .flex-1 { flex: 1; min-width: 350px; }
        .md-card { background: var(--surface); padding: 24px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 24px; }
        .md-card-header { margin-top: 0; color: var(--text-primary); font-size: 1.25em; border-bottom: 1px solid var(--divider); padding-bottom: 12px; margin-bottom: 16px; }
        label { display: block; margin-top: 16px; font-size: 0.85em; color: var(--text-secondary); margin-bottom: 4px; }
        input, select { width: 100%; padding: 12px; background: #FAFAFA; border: 1px solid #BDBDBD; border-radius: 4px; }
        .md-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 20px; border: none; border-radius: 4px; font-weight: 500; cursor: pointer; }
        .md-btn-primary { background: var(--primary); color: white; }
        .md-btn-success { background: var(--success); color: white; }
        .md-btn-danger { background: var(--danger); color: white; }
        .md-btn-text { background: transparent; color: var(--primary); }
        .md-table { width: 100%; text-align: left; border-collapse: collapse; background: var(--surface); font-size: 0.95em; }
        .md-table th { padding: 12px; border-bottom: 2px solid var(--divider); }
        .md-table td { padding: 12px; border-bottom: 1px solid var(--divider); }
        .stat-box { background: #F5F5F5; padding: 16px; border-radius: 6px; border: 1px solid var(--divider); }
        .stat-label { font-size: 0.8em; color: var(--text-secondary); text-transform: uppercase; }
        .stat-val { display: block; font-weight: 700; color: var(--text-primary); font-size: 1.25em; margin-top: 4px; }
        .text-green { color: var(--success) !important; }
        .text-red { color: var(--danger) !important; }
        .text-blue { color: var(--primary) !important; }
        .log-box { background: #263238; padding: 16px; border-radius: 6px; height: 350px; overflow-y: auto; font-family: 'Courier New', monospace; color: #81C784; font-size: 0.85em; }
        #auth-view { max-width: 420px; margin: 10vh auto; }
        #dashboard-view { display: none; }
    </style>
</head>
<body>
    <div id="auth-view" class="md-card">
        <h2 class="md-card-header" style="justify-content:center; color:var(--primary); border:none;"><span class="material-symbols-outlined" style="font-size:32px;">robot_2</span> HTX Trading Bot</h2>
        <div>
            <label>Username</label><input type="text" id="username" placeholder="Enter username">
            <label>Password</label><input type="password" id="password" placeholder="Enter password">
            <label style="color:var(--warning);">Auth Code (For Registration)</label>
            <p style="font-size:0.75em; margin-top:0;">Leave blank for simulated Paper Trading. Enter exactly <strong>webcoin8888</strong> for Live Real Trading.</p>
            <input type="password" id="authCode" placeholder="Enter auth code (Optional)">
        </div>
        <div class="flex-row" style="margin-top: 24px;"><button class="md-btn md-btn-primary" style="flex:1;" onclick="auth('login')">Login</button></div>
        <div style="text-align:center; margin-top:16px;"><button class="md-btn md-btn-text" onclick="auth('register')">Register New Account</button></div>
        <p id="auth-msg" style="text-align:center; font-weight:500;"></p>
    </div>

    <div id="dashboard-view">
        <div class="app-bar">
            <h1 class="app-title" id="app-title"><span class="material-symbols-outlined">robot_2</span> HTX BOT</h1>
            <div class="flex-row">
                <button class="md-btn md-btn-text nav-btn" id="admin-btn" style="display:none;" onclick="switchTab('admin')">User Admin</button>
                <button class="md-btn md-btn-text nav-btn" id="editor-btn" style="display:none;" onclick="switchTab('editor')">Database Editor</button>
                <button class="md-btn md-btn-text nav-btn" id="nav-main" onclick="switchTab('main')">Dashboard</button>
                <button class="md-btn md-btn-text nav-btn" id="nav-offsets" onclick="switchTab('offsets')">V1 Offsets</button>
                <button class="md-btn md-btn-text nav-btn" id="nav-offsets2" onclick="switchTab('offsets2')">V2 Offsets</button>
                <button class="md-btn md-btn-text" onclick="logout()">Logout</button>
            </div>
        </div>
        <div class="container">
            <div id="editor-tab" style="display:none;"><div class="md-card"><h2 class="md-card-header">Database Editor</h2><div id="editorGlobalContainer">Loading...</div></div></div>
            <div id="admin-tab" style="display:none;"><div class="md-card"><h2 class="md-card-header">User Management</h2><div id="adminUsersContainer">Loading...</div></div></div>
            <div id="offset-tab" style="display:none;">
                <div class="md-card"><h2 class="md-card-header">Live Accumulation Grouping (V1)</h2><div id="liveOffsetsContainer">Waiting for live data...</div></div>
                <div class="md-card"><h2 class="md-card-header">Executed Trade History</h2><div id="offsetTableContainer">Loading...</div></div>
            </div>
            <div id="offset2-tab" style="display:none;">
                <div class="md-card"><h2 class="md-card-header">Live Paired Trades (V2)</h2><div id="liveOffsetsContainer2">Waiting for live data...</div></div>
                <div class="md-card"><h2 class="md-card-header">Executed Trade History</h2><div id="offsetTableContainer2">Loading...</div></div>
            </div>
            <div id="main-tab">
                <div class="stat-box flex-row" style="background:#FFF8E1; margin-bottom: 24px;">
                    <div><span class="stat-label">Winning Coins</span><span class="stat-val text-warning" id="globalWinRate">0 / 0</span></div>
                    <div><span class="stat-label">Margin Used</span><span class="stat-val text-blue" id="topGlobalMargin">$0.00</span></div>
                    <div><span class="stat-label">Unrealized PNL</span><span class="stat-val" id="topGlobalUnrealized">$0.0000</span></div>
                </div>
                <div class="flex-row" style="align-items: stretch;">
                    <div class="md-card flex-1">
                        <h2 class="md-card-header">Profile Setup</h2>
                        <select id="subAccountSelect" style="margin-bottom:12px;"></select>
                        <button class="md-btn md-btn-primary" onclick="loadSubAccount()">Load</button>
                        <div id="settingsContainer" style="display:none;">
                            <input type="password" id="apiKey" placeholder="API Key" style="margin-top:8px;">
                            <input type="password" id="secret" placeholder="Secret Key">
                            <div class="flex-row" style="margin-top:16px;">
                                <button class="md-btn md-btn-success" onclick="globalToggleBot(true)">Start Bots</button>
                                <button class="md-btn md-btn-danger" onclick="globalToggleBot(false)">Stop Bots</button>
                            </div>
                            <h3 style="margin-top:30px;">Coins Configuration</h3>
                            <div class="flex-row" style="margin-bottom:16px;"><input type="text" id="newCoinSymbol" placeholder="BTC/USDT:USDT" style="flex:2;"><select id="side" style="flex:1;"><option value="long">Long</option><option value="short">Short</option></select><button class="md-btn md-btn-success" onclick="addCoinUI()">Add</button></div>
                            <div id="coinsListContainer"></div>
                            <button class="md-btn md-btn-primary" style="width:100%; margin-top:24px;" onclick="saveSettings()">Save Settings</button>
                        </div>
                    </div>
                    <div class="md-card flex-1" style="flex: 1.5;">
                        <h2 class="md-card-header">Live Dashboard</h2>
                        <div id="dashboardStatusContainer"><p class="text-secondary">No profile loaded.</p></div>
                        <h3 style="margin-top:30px;">System Logs</h3>
                        <div class="log-box" id="logs">Waiting for logs...</div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <script>
        let token = localStorage.getItem('token'); let isPaperUser = true; let myUsername = ''; let statusInterval = null; let mySubAccounts = []; let currentProfileIndex = -1; let myCoins = [];
        
        async function checkAuth() {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            if (token) {
                try { 
                    const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } }); 
                    if (!res.ok) throw new Error("Inv"); const d = await res.json(); 
                    isPaperUser = d.isPaper; myUsername = d.username; updateUIMode(); 
                } catch(e) { logout(); return; }
                document.getElementById('auth-view').style.display = 'none'; 
                document.getElementById('dashboard-view').style.display = 'block';
                await fetchSettings(); await loadStatus(); statusInterval = setInterval(loadStatus, 5000); 
            } else { 
                document.getElementById('auth-view').style.display = 'block'; 
                document.getElementById('dashboard-view').style.display = 'none'; 
            }
        }

        function updateUIMode() {
            const el = { t: document.getElementById('app-title'), a: document.getElementById('admin-btn'), e: document.getElementById('editor-btn'), m: document.getElementById('nav-main'), o1: document.getElementById('nav-offsets'), o2: document.getElementById('nav-offsets2') };
            if (myUsername === 'webcoin8888') { 
                el.a.style.display='inline-flex'; el.e.style.display='inline-flex'; el.m.style.display='inline-flex'; el.o1.style.display='inline-flex'; el.o2.style.display='inline-flex'; 
                el.t.innerHTML='MASTER DASHBOARD'; el.t.style.color="var(--primary)"; 
                switchTab('editor'); 
            } else { 
                el.a.style.display='none'; el.e.style.display='none'; el.m.style.display='inline-flex'; el.o1.style.display='inline-flex'; el.o2.style.display='inline-flex'; 
                el.t.innerHTML= isPaperUser ? 'PAPER TRADING BOT' : 'LIVE REAL BOT'; el.t.style.color= isPaperUser ? "var(--primary)" : "var(--success)"; 
                switchTab('main'); 
            }
        }

        function switchTab(tab) { 
            ['main','offset','offset2','admin','editor'].forEach(t => document.getElementById(t+'-tab').style.display = 'none'); 
            document.getElementById(tab==='offsets'?'offset':(tab==='offsets2'?'offset2':tab)+'-tab').style.display = 'block'; 
            if(tab==='offsets'||tab==='offsets2') { loadOffsets(); loadStatus(); } 
            if(tab==='main') loadStatus();
            if(tab==='admin') loadAdminData(); 
            if(tab==='editor') loadMasterEditor(); 
        }
        
        async function auth(action) {
            const msgBox = document.getElementById('auth-msg');
            try {
                const obj = { username: document.getElementById('username').value, password: document.getElementById('password').value };
                if (action === 'register') { const a = document.getElementById('authCode'); obj.authCode = a ? a.value : ''; }
                msgBox.innerText = "Processing request... please wait."; msgBox.style.color = "var(--text-secondary)";
                const res = await fetch('/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }); 
                const data = await res.json(); 
                if (data.token) { token = data.token; localStorage.setItem('token', token); await checkAuth(); } 
                else if (data.success) { msgBox.innerText = data.message; msgBox.style.color = "var(--success)"; } 
                else { msgBox.innerText = "Error: " + (data.error || "Unknown"); msgBox.style.color = "var(--danger)"; } 
            } catch (e) { msgBox.innerText = "Error connecting to server."; msgBox.style.color = "var(--danger)"; }
        }
        
        async function loadMasterEditor() {
            try {
                const res = await fetch('/api/admin/editor-data', { headers: { 'Authorization': 'Bearer ' + token } }); 
                const data = await res.json(); 
                if (!data.masterSettings) { document.getElementById('editorGlobalContainer').innerHTML = '<p class="text-red">No master settings found.</p>'; return; }
                document.getElementById('editorGlobalContainer').innerHTML = '<p class="text-green">Database connection verified.</p>';
            } catch (e) { document.getElementById('editorGlobalContainer').innerHTML = '<p class="text-red">Error loading editor.</p>'; }
        }

        async function loadAdminData() {
            try {
                const res = await fetch('/api/admin/users', { headers: { 'Authorization': 'Bearer ' + token } }); const users = await res.json();
                let h = '<table class="md-table"><tr><th>User</th><th>Mode</th><th>Action</th></tr>';
                if(users.length===0){ h+='<tr><td colspan="3">No users found.</td></tr>'; }
                else {
                    // NOTICE the double slash escaping for the JS variables so they don't break string concatenation
                    users.forEach(x => { h += '<tr><td>' + x.username + '</td><td>' + (x.isPaper ? 'PAPER' : 'REAL') + '</td><td><button class="md-btn md-btn-danger" onclick="adminDeleteUser(\\'' + x._id + '\\')">Delete</button></td></tr>'; });
                }
                h += '</table>'; document.getElementById('adminUsersContainer').innerHTML = h;
            } catch(e) { document.getElementById('adminUsersContainer').innerHTML = '<p class="text-red">Error loading users.</p>'; }
        }

        async function adminDeleteUser(id) { if(!confirm("Delete user?")) return; const res = await fetch('/api/admin/users/'+id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } }); await res.json(); loadAdminData(); }
        function logout() { localStorage.removeItem('token'); token=null; mySubAccounts=[]; currentProfileIndex=-1; if(statusInterval){clearInterval(statusInterval);statusInterval=null;} checkAuth(); }
        
        async function fetchSettings() {
            try {
                const res = await fetch('/api/settings', { headers: { 'Authorization': 'Bearer ' + token } }); 
                const c = await res.json(); mySubAccounts = c.subAccounts || []; 
                const s = document.getElementById('subAccountSelect'); s.innerHTML=''; 
                if(mySubAccounts.length>0){ mySubAccounts.forEach((sub,i)=>s.innerHTML+='<option value="'+i+'">'+sub.name+'</option>'); s.value=0; loadSubAccount(); }
            } catch(e) {}
        }

        function loadSubAccount() {
            const i = parseInt(document.getElementById('subAccountSelect').value); 
            if(!isNaN(i)&&i>=0){
                currentProfileIndex = i; const p = mySubAccounts[i]; 
                document.getElementById('settingsContainer').style.display='block';
                document.getElementById('apiKey').value = p.apiKey||''; document.getElementById('secret').value = p.secret||'';
                myCoins = p.coins||[]; renderCoinsSettings();
            }
        }

        function renderCoinsSettings() { 
            let h = ''; 
            // Notice \\' is used to escape the variable in the onclick
            myCoins.forEach((coin,i)=>{ h += '<div class="stat-box flex-row" style="justify-content:space-between; margin-bottom:8px;"><span>' + coin.symbol + ' (' + coin.side + ')</span><button class="md-btn md-btn-danger" onclick="removeCoinUI(' + i + ')">Remove</button></div>'; }); 
            document.getElementById('coinsListContainer').innerHTML = h; 
        }

        function addCoinUI() { const sym=document.getElementById('newCoinSymbol').value.toUpperCase().trim(); const s=document.getElementById('side').value; if(sym){ myCoins.push({symbol:sym,side:s,botActive:true}); renderCoinsSettings(); } }
        function removeCoinUI(i) { myCoins.splice(i,1); renderCoinsSettings(); }
        
        async function saveSettings() {
            const p = mySubAccounts[currentProfileIndex]; p.apiKey=document.getElementById('apiKey').value; p.secret=document.getElementById('secret').value; p.coins=myCoins;
            await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({subAccounts:mySubAccounts}) }); alert('Saved!');
        }

        async function globalToggleBot(a) { myCoins.forEach(c=>c.botActive=a); await saveSettings(); alert(a?"Started!":"Stopped."); }
        
        async function loadOffsets() {
            const res = await fetch('/api/offsets', { headers: { 'Authorization': 'Bearer ' + token } }); const r = await res.json();
            let h = '<table class="md-table"><tr><th>Symbol</th><th>Reason</th><th>Net Profit</th></tr>';
            r.forEach(x => { h += '<tr><td>' + (x.symbol||'Unknown') + '</td><td>' + (x.reason||'Offset') + '</td><td class="' + ((x.netProfit||0)>=0?'text-green':'text-red') + '">$' + (x.netProfit||0).toFixed(4) + '</td></tr>'; });
            h += '</table>'; document.getElementById('offsetTableContainer').innerHTML=h; document.getElementById('offsetTableContainer2').innerHTML=h;
        }

        async function loadStatus() {
            const res = await fetch('/api/status', { headers: { 'Authorization': 'Bearer ' + token } }); const d = await res.json();
            let gu=0; let gm=0; let tt=0; let taz=0; let ac=[];
            for(let pid in d.states){ 
                const s=d.states[pid]; if(s&&s.coinStates){ 
                    for(let sym in s.coinStates){ 
                        const cs=s.coinStates[sym]; if(cs.contracts>0){ gm+=parseFloat(cs.margin)||0; tt++; gu+=parseFloat(cs.unrealizedPnl)||0; ac.push({symbol:sym,pnl:parseFloat(cs.unrealizedPnl)||0}); if(cs.currentRoi>0) taz++; } 
                    } 
                } 
            }
            document.getElementById('topGlobalMargin').innerText="$"+gm.toFixed(2); document.getElementById('globalWinRate').innerText = taz + ' / ' + tt;
            document.getElementById('topGlobalUnrealized').innerText = (gu>=0?"+$":"-$") + Math.abs(gu).toFixed(4); document.getElementById('topGlobalUnrealized').className = 'stat-val ' + (gu>=0?'text-green':'text-red');
            
            // Generate Offset Dashboard Table
            ac.sort((a,b)=>b.pnl-a.pnl); const tc=ac.length; const tp=Math.floor(tc/2);
            if(document.getElementById('offset-tab').style.display==='block'){
                if(tp===0){ document.getElementById('liveOffsetsContainer').innerHTML='<p class="text-secondary">Not enough active pairs to display offsets table.</p>'; }
                else {
                    let lh='<table class="md-table"><tr><th>Pair</th><th>Winner</th><th>W.PNL</th><th>Loser</th><th>L.PNL</th><th>Net</th></tr>';
                    for(let i=0;i<tp;i++){
                        const w=ac[i]; const l=ac[tc-tp+i]; const n=w.pnl+l.pnl;
                        lh += '<tr><td>' + (i+1) + '</td><td>' + w.symbol + '</td><td class="text-green">$' + w.pnl.toFixed(4) + '</td><td>' + l.symbol + '</td><td class="text-red">$' + l.pnl.toFixed(4) + '</td><td style="font-weight:bold;">$' + n.toFixed(4) + '</td></tr>';
                    }
                    lh += '</table>'; document.getElementById('liveOffsetsContainer').innerHTML = lh;
                }
            }

            if(currentProfileIndex===-1) return;
            const p=mySubAccounts[currentProfileIndex]; const sd=d.states[p._id]||{coinStates:{},logs:[]};
            let ph=''; myCoins.forEach(c=>{
                const s=sd.coinStates[c.symbol]||{status:'Stopped',contracts:0,currentRoi:0,unrealizedPnl:0};
                ph += '<div class="stat-box" style="margin-bottom:8px;"><strong>' + c.symbol + '</strong>: ' + s.status + ' | Qty: ' + s.contracts + ' | PNL: $' + (s.unrealizedPnl||0).toFixed(4) + '</div>';
            });
            document.getElementById('dashboardStatusContainer').innerHTML = ph || '<p>No coins.</p>';
            document.getElementById('logs').innerHTML = (sd.logs||[]).join('<br>');
        }
        checkAuth();
    </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`🚀 Running on port ${PORT}`));
module.exports = app;
