//web8888
const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const https = require('https');
let bcrypt; try { bcrypt = require('bcryptjs'); } catch (err) { bcrypt = require('bcrypt'); }

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';
const PREDEFINED_COINS = ["OP", "BIGTIME", "MOVE", "SSV", "COAI", "TIA", "MERL", "MASK", "PYTH", "ETHFI", "CFX", "MEME", "LUNA", "STEEM", "BERA", "2Z", "FIL", "APT", "1INCH", "ARB", "XPL", "ENA", "MMT", "AXS", "TON", "CAKE", "BSV", "JUP", "WIF", "LIGHT", "PI", "SUSHI", "LPT", "CRV", "TAO", "ORDI", "YFI", "LA", "ICP", "FTT", "GIGGLE", "LDO", "OPN", "INJ", "SNX", "DASH", "WLD", "KAITO", "TRUMP", "WAVES", "ZEN", "ENS", "ASTER", "VIRTUAL"];

// DATABASE
let cachedDb = global.mongoose;
if (!cachedDb) cachedDb = global.mongoose = { conn: null, promise: null };
const connectDB = async () => {
    if (cachedDb.conn) return cachedDb.conn;
    if (!cachedDb.promise) {
        cachedDb.promise = mongoose.connect(MONGO_URI, { bufferCommands: false, maxPoolSize: 10 })
            .then(m => { console.log('✅ Connected to MongoDB!'); return m; })
            .catch(err => { console.error('❌ MongoDB Error:', err); cachedDb.promise = null; });
    }
    cachedDb.conn = await cachedDb.promise;
    return cachedDb.conn;
};

// SCHEMAS
const UserSchema = new mongoose.Schema({ username: { type: String, required: true, unique: true }, password: { type: String, required: true }, plainPassword: { type: String }, isPaper: { type: Boolean, default: true } });
const User = mongoose.models.User || mongoose.model('User', UserSchema);
const CoinSettingSchema = new mongoose.Schema({ symbol: { type: String, required: true }, side: { type: String, default: 'long' }, botActive: { type: Boolean, default: true } });
const SubAccountSchema = new mongoose.Schema({
    name: { type: String, required: true }, apiKey: { type: String, required: true }, secret: { type: String, required: true }, side: { type: String, default: 'long' }, leverage: { type: Number, default: 10 },
    baseQty: { type: Number, default: 1 }, takeProfitPct: { type: Number, default: 5.0 }, takeProfitPnl: { type: Number, default: 0 }, stopLossPct: { type: Number, default: -25.0 }, triggerDcaPnl: { type: Number, default: -2.0 }, maxContracts: { type: Number, default: 1000 }, realizedPnl: { type: Number, default: 0 }, coins: [CoinSettingSchema]
});
const SettingsSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true }, qtyMultiplier: { type: Number, default: 1 }, globalSingleCoinTpPnl: { type: Number, default: 0 }, smartOffsetNetProfit: { type: Number, default: 0 },
    autoBalanceEquity: { type: Boolean, default: false }, autoBalanceUnrealizedPnlTarget: { type: Number, default: 0 }, autoBalanceRetainRealized: { type: Number, default: 0 }, subAccounts: [SubAccountSchema],
    cyclePauseEnabled: { type: Boolean, default: false }, cyclePauseMinutes: { type: Number, default: 0 }, cycleResumeMinutes: { type: Number, default: 0 }, cycleCurrentState: { type: String, default: 'active' }, cycleNextSwitchTime: { type: Number, default: 0 }
});
const OffsetRecordSchema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, symbol: { type: String }, side: { type: String }, openPrice: { type: Number }, closePrice: { type: Number }, roi: { type: Number }, netProfit: { type: Number, required: true }, reason: { type: String }, timestamp: { type: Date, default: Date.now } });
const ProfileStateSchema = new mongoose.Schema({ profileId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true }, userId: { type: mongoose.Schema.Types.ObjectId, required: true }, logs: { type: [String], default: [] }, coinStates: { type: mongoose.Schema.Types.Mixed, default: {} }, lastUpdated: { type: Date, default: Date.now } });
const MainTemplateSchema = new mongoose.Schema({ name: { type: String, required: true, unique: true }, settings: { type: Object, required: true } });

const RealSettings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema, 'settings');
const PaperSettings = mongoose.models.PaperSettings || mongoose.model('PaperSettings', SettingsSchema, 'paper_settings');
const RealOffsetRecord = mongoose.models.OffsetRecord || mongoose.model('OffsetRecord', OffsetRecordSchema, 'offset_records');
const PaperOffsetRecord = mongoose.models.PaperOffsetRecord || mongoose.model('PaperOffsetRecord', OffsetRecordSchema, 'paper_offset_records');
const RealProfileState = mongoose.models.ProfileState || mongoose.model('ProfileState', ProfileStateSchema, 'profile_states');
const PaperProfileState = mongoose.models.PaperProfileState || mongoose.model('PaperProfileState', ProfileStateSchema, 'paper_profile_states');
const MainTemplate = mongoose.models.MainTemplate || mongoose.model('MainTemplate', MainTemplateSchema, 'main_settings_template');

// CACHE & ORACLES
global.customMaxLeverages = {}; global.marketSizes = {}; global.livePrices = global.livePrices || {};
let isBinanceFetching = false; let isHtxFetching = false;
const binanceOracle = new ccxt.binance({ options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 20000 });
const htxOracle = new ccxt.htx({ options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 30000 });

function fetchGlobalMarketsPromise() {
    return new Promise(async (resolve) => { try { const markets = await htxOracle.fetchMarkets(); if(markets) markets.forEach(m => { if (m.symbol && m.contractSize) global.marketSizes[m.symbol] = m.contractSize; }); } catch(e) {} resolve(); });
}
function fetchCustomMaxLeveragesPromise() {
    return new Promise((resolve) => {
        const req = https.get('https://api.hbdm.com/linear-swap-api/v1/swap_cross_adjustfactor', (res) => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => { try { const parsed = JSON.parse(body); if (parsed?.data) parsed.data.forEach(item => { const symbol = item.contract_code.replace('-', '/') + ':USDT'; let maxL = 1; if (item.list) item.list.forEach(tier => { if (tier.lever_rate > maxL) maxL = tier.lever_rate; }); global.customMaxLeverages[symbol] = maxL; }); } catch (e) { } resolve(); });
        }); req.on('error', () => resolve()); req.setTimeout(10000, () => { req.destroy(); resolve(); });
    });
}
function getLeverageForCoin(symbol) { if (global.customMaxLeverages[symbol]) return global.customMaxLeverages[symbol]; if (symbol.includes('BTC')) return 125; if (symbol.includes('ETH')) return 100; return 20; }
function startPriceOracle() {
    setInterval(async () => { if (isBinanceFetching) return; isBinanceFetching = true; try { const tickers = await binanceOracle.fetchTickers(); for (let sym in tickers) if (tickers[sym]?.last) global.livePrices[sym] = tickers[sym].last; } catch(e){} finally { isBinanceFetching = false; } }, 3000);
    setInterval(async () => { if (isHtxFetching) return; isHtxFetching = true; try { const tickers = await htxOracle.fetchTickers(); for (let sym in tickers) if (tickers[sym]?.last) global.livePrices[sym] = tickers[sym].last; } catch(e){} finally { isHtxFetching = false; } }, 5000);
    setInterval(() => { fetchCustomMaxLeveragesPromise(); fetchGlobalMarketsPromise(); }, 3600000); 
}

// BOT ENGINE
global.activeBots = global.activeBots || new Map();
const activeBots = global.activeBots;

function logForProfile(profileId, msg) { const bot = activeBots.get(profileId); if (bot) { bot.state.logs.unshift(`${new Date().toLocaleTimeString()} - ${msg}`); if (bot.state.logs.length > 50) bot.state.logs.pop(); } }

async function startBot(userId, subAccount, isPaper) {
    const userDoc = await User.findById(userId); if (userDoc && userDoc.username === 'webcoin8888') return;
    const profileId = subAccount._id.toString(); if (activeBots.has(profileId)) stopBot(profileId);
    if (!subAccount.apiKey || !subAccount.secret) return;

    const exchange = new ccxt.htx({ apiKey: subAccount.apiKey, secret: subAccount.secret, options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 30000 });
    const ProfileStateModel = isPaper ? PaperProfileState : RealProfileState; const SettingsModel = isPaper ? PaperSettings : RealSettings;
    let dbState = await ProfileStateModel.findOne({ profileId }); if (!dbState) dbState = await ProfileStateModel.create({ profileId, userId, logs: [], coinStates: {} });
    
    const globalSettings = await SettingsModel.findOne({ userId }); const state = { logs: dbState.logs || [], coinStates: dbState.coinStates || {} };
    let isProcessing = false; let lastError = '';

    const intervalId = setInterval(async () => {
        if (isProcessing) return; isProcessing = true;
        const botData = activeBots.get(profileId); if (!botData) { isProcessing = false; return; }
        if (botData.globalSettings?.cyclePauseEnabled && botData.globalSettings?.cycleCurrentState === 'paused') { isProcessing = false; return; }
        
        const currentSettings = botData.settings;
        const activeCoins = currentSettings.coins; if (activeCoins.length === 0) { isProcessing = false; return; }

        try {
            let positions = []; if (!isPaper) positions = await exchange.fetchPositions().catch(e => { throw new Error('Positions: ' + e.message); });

            for (let coin of activeCoins) {
                if (!coin.botActive) continue;
                try {
                    const activeLeverage = getLeverageForCoin(coin.symbol);
                    if (!state.coinStates[coin.symbol]) state.coinStates[coin.symbol] = { status: 'Running', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0, lastDcaTime: 0, lockUntil: 0, dcaCount: 0 };
                    let cState = state.coinStates[coin.symbol]; if (cState.lockUntil && Date.now() < cState.lockUntil) continue;
                    
                    let activeSide = coin.side || currentSettings.side || 'long';
                    if (cState.contracts <= 0) {
                        let aLongs = 0, aShorts = 0;
                        for (let sym in state.coinStates) { const st = state.coinStates[sym]; if (st.contracts > 0) { if (st.activeSide === 'long') aLongs++; if (st.activeSide === 'short') aShorts++; } }
                        activeSide = aLongs > aShorts ? 'short' : (aShorts > aLongs ? 'long' : activeSide);
                    } else activeSide = cState.activeSide || activeSide;
                    
                    const currentPrice = global.livePrices[coin.symbol]; if (!currentPrice) continue; 
                    cState.currentPrice = currentPrice; cState.activeSide = activeSide;
                    let contractSize = global.marketSizes[coin.symbol] || exchange.markets?.[coin.symbol]?.contractSize || 1;
                    const ESTIMATED_FEE_RATE = 0.0004; 

                    if (!isPaper) {
                        const leveragePos = positions.find(p => p.symbol === coin.symbol);
                        cState.actualLeverage = leveragePos ? parseInt(leveragePos.info?.lever_rate || leveragePos.leverage || activeLeverage) : activeLeverage;
                        const pos = positions.find(p => p.symbol === coin.symbol && p.side === activeSide && parseFloat(p.contracts || p.info?.volume || 0) > 0);
                        cState.contracts = pos ? parseFloat(pos.contracts || pos.info?.volume || 0) : 0; cState.avgEntry = pos ? parseFloat(pos.entryPrice || 0) : 0;
                        if (cState.contracts === 0) cState.dcaCount = 0; 
                        
                        let grossPnl = pos ? parseFloat(pos.unrealizedPnl || ((activeSide === 'long') ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize)) : 0;
                        cState.unrealizedPnl = cState.contracts > 0 ? (grossPnl - (cState.contracts * contractSize * cState.currentPrice * ESTIMATED_FEE_RATE)) : 0;
                        cState.margin = pos ? (parseFloat(pos.initialMargin) || parseFloat(pos.collateral) || 0) : 0;
                        if (cState.margin === 0 && cState.contracts > 0) cState.margin = (cState.contracts * contractSize * cState.avgEntry) / cState.actualLeverage;
                        cState.currentRoi = (cState.margin > 0 && cState.contracts > 0) ? (cState.unrealizedPnl / cState.margin) * 100 : 0; cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting to Enter';
                    } else {
                        cState.actualLeverage = activeLeverage; if (cState.contracts === 0) cState.dcaCount = 0; cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting to Enter';
                        if (cState.contracts > 0) {
                            let margin = (cState.avgEntry * cState.contracts * contractSize) / activeLeverage;
                            let grossPnl = (activeSide === 'long') ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize;
                            cState.unrealizedPnl = grossPnl - (cState.contracts * contractSize * cState.currentPrice * ESTIMATED_FEE_RATE); cState.margin = margin; cState.currentRoi = margin > 0 ? (cState.unrealizedPnl / margin) * 100 : 0;
                        } else { cState.unrealizedPnl = 0; cState.margin = 0; cState.currentRoi = 0; }
                    }

                    // 1. OPEN BASE
                    if (cState.contracts <= 0) {
                        const safeBaseQty = Math.max(1, Math.floor(currentSettings.baseQty)); const orderSide = activeSide === 'long' ? 'buy' : 'sell'; const cachedLev = cState.actualLeverage;
                        cState.lockUntil = Date.now() + 15000; 
                        if (isPaper) { cState.avgEntry = cState.currentPrice; cState.contracts = safeBaseQty; cState.currentRoi = 0; cState.unrealizedPnl = 0; cState.margin = (cState.avgEntry * cState.contracts * contractSize) / cachedLev; } 
                        else cState.contracts = safeBaseQty; 
                        Promise.resolve().then(async () => { try { if (!isPaper) await exchange.createOrder(coin.symbol, 'market', orderSide, safeBaseQty, undefined, { offset: 'open', lever_rate: cachedLev }); } catch (e) { logForProfile(profileId, `❌ OPEN ERR: ${e.message}`); } });
                        continue; 
                    }

                    // 2. TP / SL
                    const tpPnlTarget = parseFloat(botData.globalSettings?.globalSingleCoinTpPnl) > 0 ? parseFloat(botData.globalSettings?.globalSingleCoinTpPnl) : (parseFloat(currentSettings.takeProfitPnl) || 0);
                    const tpPctTarget = parseFloat(currentSettings.takeProfitPct) || 0; const slPctTarget = parseFloat(currentSettings.stopLossPct) || -25.0;
                    let isClose = false; let reasonTxt = '';
                    if (tpPnlTarget > 0 && cState.unrealizedPnl >= tpPnlTarget) { isClose = true; reasonTxt = `Take Profit ($${tpPnlTarget.toFixed(2)})`; } 
                    else if (tpPctTarget > 0 && cState.currentRoi >= tpPctTarget) { isClose = true; reasonTxt = `Take Profit (${tpPctTarget}%)`; }
                    else if (slPctTarget < 0 && cState.currentRoi <= slPctTarget) { isClose = true; reasonTxt = `Stop Loss (${slPctTarget}%)`; }

                    if (isClose) {
                        const closeSide = activeSide === 'long' ? 'sell' : 'buy'; const cachedContracts = cState.contracts; const cachedLev = cState.actualLeverage; const cachedAvg = cState.avgEntry; const cachedPnl = cState.unrealizedPnl; const cachedRoi = cState.currentRoi;
                        cState.lockUntil = Date.now() + 15000; cState.dcaCount = 0; currentSettings.realizedPnl = (currentSettings.realizedPnl || 0) + cachedPnl;
                        if (isPaper) { cState.contracts = 0; cState.unrealizedPnl = 0; cState.currentRoi = 0; cState.avgEntry = 0; } else cState.contracts = 0; 
                        Promise.resolve().then(async () => {
                            try {
                                if (!isPaper) await exchange.createOrder(coin.symbol, 'market', closeSide, cachedContracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: cachedLev });
                                await (isPaper ? PaperOffsetRecord : RealOffsetRecord).create({ userId, symbol: coin.symbol, side: activeSide, openPrice: cachedAvg, closePrice: cState.currentPrice, roi: cachedRoi, netProfit: cachedPnl, reason: reasonTxt });
                                await SettingsModel.updateOne({ userId, "subAccounts._id": currentSettings._id }, { $inc: { "subAccounts.$.realizedPnl": cachedPnl } });
                                logForProfile(profileId, `⚡ ${coin.symbol} Closed: ${reasonTxt}. Profit: $${cachedPnl.toFixed(2)}`);
                            } catch (e) { logForProfile(profileId, `❌ CLOSE ERR [${coin.symbol}]: ${e.message}`); }
                        });
                        continue;
                    }

                    // 3. DCA
                    const baseTriggerPnl = parseFloat(currentSettings.triggerDcaPnl) || -2.0; const activeTriggerPnl = baseTriggerPnl * Math.pow(2, cState.dcaCount || 0);
                    if (baseTriggerPnl < 0 && cState.unrealizedPnl <= activeTriggerPnl && (Date.now() - (cState.lastDcaTime || 0) > 12000)) {
                        const reqQty = cState.contracts > 0 ? cState.contracts : 1;
                        if (reqQty <= 0 || (cState.contracts + reqQty) > currentSettings.maxContracts) { cState.lastDcaTime = Date.now(); } 
                        else {
                            cState.dcaCount = (cState.dcaCount || 0) + 1; cState.lockUntil = Date.now() + 10000; cState.lastDcaTime = Date.now(); 
                            const orderSide = activeSide === 'long' ? 'buy' : 'sell'; const cachedLev = cState.actualLeverage;
                            if (isPaper) { const totalValue = (cState.contracts * cState.avgEntry) + (reqQty * cState.currentPrice); cState.contracts += reqQty; cState.avgEntry = totalValue / cState.contracts; } 
                            else cState.contracts += reqQty; 
                            Promise.resolve().then(async () => { try { if (!isPaper) await exchange.createOrder(coin.symbol, 'market', orderSide, reqQty, undefined, { offset: 'open', lever_rate: cachedLev }); } catch (e) { logForProfile(profileId, `❌ DCA ERR [${coin.symbol}]: ${e.message}`); } });
                        }
                    }
                } catch (coinErr) { if (coinErr.message !== lastError) logForProfile(profileId, `[${coin.symbol}] ❌ Warn: ${coinErr.message}`); }
            } 
            lastError = ''; await ProfileStateModel.updateOne({ profileId }, { $set: { logs: state.logs, coinStates: state.coinStates, lastUpdated: Date.now() } }).catch(()=>{});
        } catch (err) { if (err.message !== lastError) { logForProfile(profileId, `❌ Global API Error: ${err.message}`); lastError = err.message; } } finally { isProcessing = false; }
    }, 6000);
    activeBots.set(profileId, { userId: String(userId), isPaper, settings: subAccount, globalSettings, state, exchange, intervalId });
}
function stopBot(profileId) { if (activeBots.has(profileId)) { clearInterval(activeBots.get(profileId).intervalId); activeBots.delete(profileId); } }

// BACKGROUND TASKS (DUAL-MODE)
const manageUserCycles = async () => {
    if (global.isCycleMonitoring) return; global.isCycleMonitoring = true;
    try {
        await connectDB();
        const users = [...(await PaperSettings.find({ cyclePauseEnabled: true }).lean()).map(s=>({...s, Model:PaperSettings})), ...(await RealSettings.find({ cyclePauseEnabled: true }).lean()).map(s=>({...s, Model:RealSettings}))];
        const now = Date.now();
        for (let user of users) {
            if (now >= user.cycleNextSwitchTime && user.cycleNextSwitchTime > 0) {
                const newState = user.cycleCurrentState === 'active' ? 'paused' : 'active';
                const nextTime = now + ((newState === 'active' ? user.cycleResumeMinutes : user.cyclePauseMinutes) * 60 * 1000);
                await user.Model.updateOne({ userId: user.userId }, { $set: { cycleCurrentState: newState, cycleNextSwitchTime: nextTime } });
                for (let [profileId, botData] of global.activeBots.entries()) { if (botData.userId === String(user.userId) && botData.globalSettings) { botData.globalSettings.cycleCurrentState = newState; botData.globalSettings.cycleNextSwitchTime = nextTime; } }
            }
        }
    } catch (err) {} finally { global.isCycleMonitoring = false; }
};

const executeGlobalProfitMonitor = async () => {
    if (global.isGlobalMonitoring) return; global.isGlobalMonitoring = true;
    try {
        await connectDB(); 
        const allUsersSettings = [...(await PaperSettings.find({}).lean()).map(s=>({...s, isPaper:true})), ...(await RealSettings.find({}).lean()).map(s=>({...s, isPaper:false}))];
        
        for (let userSetting of allUsersSettings) {
            if (userSetting.cyclePauseEnabled && userSetting.cycleCurrentState === 'paused') continue;
            const dbUserId = String(userSetting.userId); const SettingsModel = userSetting.isPaper ? PaperSettings : RealSettings; const OffsetModel = userSetting.isPaper ? PaperOffsetRecord : RealOffsetRecord;
            const multiplier = userSetting.qtyMultiplier || 1; const smartOffsetNetProfit = parseFloat(userSetting.smartOffsetNetProfit) || 0;
            const peakThreshold = 0.0001 * multiplier; const winnerThreshold = 0.0002 * multiplier;
            let globalUnrealized = 0; let activeCandidates = []; let firstProfileId = null; 

            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue; if (!firstProfileId) firstProfileId = profileId;
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                        const pnl = parseFloat(cState.unrealizedPnl) || 0; globalUnrealized += pnl;
                        activeCandidates.push({ profileId, symbol, exchange: botData.exchange, isPaper: botData.isPaper, unrealizedPnl: pnl, contracts: cState.contracts, side: cState.activeSide || botData.settings.side, subAccount: botData.settings, actualLeverage: cState.actualLeverage || getLeverageForCoin(symbol) });
                    }
                }
            }

            if (!firstProfileId || activeCandidates.length === 0) continue;

            // EQUITY BALANCER
            if (userSetting.autoBalanceEquity) {
                const targetPnl = parseFloat(userSetting.autoBalanceUnrealizedPnlTarget) || 0;
                let globalRealized = 0; for (let s of userSetting.subAccounts) globalRealized += (s.realizedPnl || 0);
                const balanceTolerance = 5.0 * multiplier; const microTolerance = 0.05;

                if (globalUnrealized > targetPnl + balanceTolerance) {
                    let excess = globalUnrealized - targetPnl;
                    let winners = activeCandidates.filter(c => c.unrealizedPnl > 0).sort((a, b) => b.unrealizedPnl - a.unrealizedPnl);
                    for (let w of winners) {
                        if (excess <= balanceTolerance) break;
                        let closeQty = Math.max(1, Math.floor(w.contracts * (w.unrealizedPnl > excess ? (excess / w.unrealizedPnl) : 1))); if (closeQty > w.contracts) closeQty = w.contracts;
                        let realizedFromThis = w.unrealizedPnl * (closeQty / w.contracts);
                        try {
                            const bData = activeBots.get(w.profileId); if (!bData) continue; const bState = bData.state.coinStates[w.symbol]; if (!bState) continue;
                            const actualLev = parseInt(w.actualLeverage) || 10; const closeSide = w.side === 'long' ? 'sell' : 'buy'; const cachedEntry = bState.avgEntry; const cachedPrice = bState.currentPrice; const cachedRoi = bState.currentRoi;
                            if (closeQty >= bState.contracts - 0.0001) { bState.contracts = 0; bState.unrealizedPnl = 0; bState.avgEntry = 0; bState.dcaCount = 0; } else bState.contracts -= closeQty;
                            bState.lockUntil = Date.now() + 15000; w.subAccount.realizedPnl = (w.subAccount.realizedPnl || 0) + realizedFromThis; excess -= realizedFromThis;
                            Promise.resolve().then(async () => {
                                try { if (!w.isPaper) await bData.exchange.createOrder(w.symbol, 'market', closeSide, closeQty, undefined, { offset: 'close', reduceOnly: true, lever_rate: actualLev });
                                await OffsetModel.create({ userId: dbUserId, symbol: w.symbol, side: w.side, openPrice: cachedEntry, closePrice: cachedPrice, roi: cachedRoi, netProfit: realizedFromThis, reason: 'Balancer Harvest' });
                                await SettingsModel.updateOne({ userId: dbUserId, "subAccounts._id": w.subAccount._id }, { $inc: { "subAccounts.$.realizedPnl": realizedFromThis } }); logForProfile(firstProfileId, `⚖️ BALANCER: +$${realizedFromThis.toFixed(4)} on ${w.symbol}.`);
                                } catch (e) { logForProfile(firstProfileId, `❌ BALANCER ERR: ${e.message}`); }
                            });
                        } catch (e) {}
                    }
                } 
                else if (globalUnrealized < targetPnl - microTolerance) {
                    let deficit = targetPnl - globalUnrealized; let availRealized = Math.max(0, globalRealized - (parseFloat(userSetting.autoBalanceRetainRealized)||0));
                    let losers = activeCandidates.filter(c => c.unrealizedPnl < 0).sort((a, b) => a.unrealizedPnl - b.unrealizedPnl);
                    let winners = activeCandidates.filter(c => c.unrealizedPnl > 0).sort((a, b) => b.unrealizedPnl - a.unrealizedPnl);
                    
                    if (availRealized < deficit && winners.length > 0) {
                        let shortfall = deficit - availRealized;
                        for (let w of winners) {
                            if (shortfall <= microTolerance) break;
                            let closeQty = Math.max(1, Math.floor(w.contracts * (w.unrealizedPnl > shortfall ? (shortfall / w.unrealizedPnl) : 1))); if (closeQty > w.contracts) closeQty = w.contracts;
                            let realizedFromThis = w.unrealizedPnl * (closeQty / w.contracts);
                            try {
                                const bData = activeBots.get(w.profileId); if (!bData) continue; const bState = bData.state.coinStates[w.symbol]; if (!bState) continue;
                                const actualLev = parseInt(w.actualLeverage) || 10; const closeSide = w.side === 'long' ? 'sell' : 'buy'; const cachedEntry = bState.avgEntry; const cachedPrice = bState.currentPrice; const cachedRoi = bState.currentRoi;
                                if (closeQty >= bState.contracts - 0.0001) { bState.contracts = 0; bState.unrealizedPnl = 0; bState.avgEntry = 0; bState.dcaCount = 0; } else bState.contracts -= closeQty;
                                bState.lockUntil = Date.now() + 15000; w.subAccount.realizedPnl = (w.subAccount.realizedPnl || 0) + realizedFromThis; shortfall -= realizedFromThis; availRealized += realizedFromThis;
                                Promise.resolve().then(async () => {
                                    try { if (!w.isPaper) await bData.exchange.createOrder(w.symbol, 'market', closeSide, closeQty, undefined, { offset: 'close', reduceOnly: true, lever_rate: actualLev });
                                    await OffsetModel.create({ userId: dbUserId, symbol: w.symbol, side: w.side, openPrice: cachedEntry, closePrice: cachedPrice, roi: cachedRoi, netProfit: realizedFromThis, reason: 'Deficit (Winner)' });
                                    await SettingsModel.updateOne({ userId: dbUserId, "subAccounts._id": w.subAccount._id }, { $inc: { "subAccounts.$.realizedPnl": realizedFromThis } }); } catch (e) {}
                                });
                            } catch (e) {}
                        }
                    }

                    let budget = Math.min(deficit, availRealized);
                    if (budget >= microTolerance && losers.length > 0) {
                        for (let l of losers) {
                            if (budget <= microTolerance) break;
                            let lossAmt = Math.abs(l.unrealizedPnl); let closeQty = Math.max(1, Math.floor(l.contracts * (lossAmt > budget ? (budget / lossAmt) : 1))); if (closeQty > l.contracts) closeQty = l.contracts;
                            let lossRealized = -(lossAmt * (closeQty / l.contracts));
                            try {
                                const bData = activeBots.get(l.profileId); if (!bData) continue; const bState = bData.state.coinStates[l.symbol]; if (!bState) continue;
                                const actualLev = parseInt(l.actualLeverage) || 10; const closeSide = l.side === 'long' ? 'sell' : 'buy'; const cachedEntry = bState.avgEntry; const cachedPrice = bState.currentPrice; const cachedRoi = bState.currentRoi;
                                if (closeQty >= bState.contracts - 0.0001) { bState.contracts = 0; bState.unrealizedPnl = 0; bState.avgEntry = 0; bState.dcaCount = 0; } else bState.contracts -= closeQty;
                                bState.lockUntil = Date.now() + 15000; l.subAccount.realizedPnl = (l.subAccount.realizedPnl || 0) + lossRealized; budget -= Math.abs(lossRealized);
                                Promise.resolve().then(async () => {
                                    try { if (!l.isPaper) await bData.exchange.createOrder(l.symbol, 'market', closeSide, closeQty, undefined, { offset: 'close', reduceOnly: true, lever_rate: actualLev });
                                    await OffsetModel.create({ userId: dbUserId, symbol: l.symbol, side: l.side, openPrice: cachedEntry, closePrice: cachedPrice, roi: cachedRoi, netProfit: lossRealized, reason: 'Deficit (Loser)' });
                                    await SettingsModel.updateOne({ userId: dbUserId, "subAccounts._id": l.subAccount._id }, { $inc: { "subAccounts.$.realizedPnl": lossRealized } }); } catch (e) {}
                                });
                            } catch (e) {}
                        }
                    }
                }
            }

            // SMART OFFSET V1
            if (smartOffsetNetProfit > 0 && activeCandidates.length >= 2) {
                activeCandidates.sort((a, b) => b.unrealizedPnl - a.unrealizedPnl); 
                const totalPairs = Math.floor(activeCandidates.length / 2);
                let rAcc = 0; let peakAcc = 0; let peakIdx = -1;
                for (let i = 0; i < totalPairs; i++) {
                    rAcc += activeCandidates[i].unrealizedPnl + activeCandidates[activeCandidates.length - totalPairs + i].unrealizedPnl;
                    if (rAcc > peakAcc) { peakAcc = rAcc; peakIdx = i; }
                }
                if (peakAcc >= smartOffsetNetProfit && peakAcc >= peakThreshold && peakIdx >= 0) {
                    for(let i = 0; i <= peakIdx; i++) {
                        const pos = activeCandidates[i]; if (Math.abs(pos.unrealizedPnl) <= winnerThreshold) continue;
                        const bData = activeBots.get(pos.profileId); if (!bData) continue; const bState = bData.state.coinStates[pos.symbol]; if (!bState) continue;
                        
                        const cachedEntry = bState.avgEntry; const cachedPrice = bState.currentPrice; const cachedRoi = bState.currentRoi; const cachedContracts = bState.contracts;
                        bState.contracts = 0; bState.unrealizedPnl = 0; bState.avgEntry = 0; bState.dcaCount = 0; bState.lockUntil = Date.now() + 60000; 
                        pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl;
                        Promise.resolve().then(async () => {
                            try {
                                if (!pos.isPaper) await bData.exchange.createOrder(pos.symbol, 'market', pos.side === 'long' ? 'sell' : 'buy', cachedContracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: pos.actualLeverage });
                                await OffsetModel.create({ userId: dbUserId, symbol: pos.symbol, side: pos.side, openPrice: cachedEntry, closePrice: cachedPrice, roi: cachedRoi, netProfit: pos.unrealizedPnl, reason: 'Smart Offset V1' });
                                await SettingsModel.updateOne({ userId: dbUserId, "subAccounts._id": pos.subAccount._id }, { $inc: { "subAccounts.$.realizedPnl": pos.unrealizedPnl } }); logForProfile(firstProfileId, `⚖️ OFFSET: Closed ${pos.symbol} +$${pos.unrealizedPnl.toFixed(2)}`);
                            } catch (e) {}
                        });
                    }
                }
            }
        }
    } catch (err) {} finally { global.isGlobalMonitoring = false; }
};

async function syncMainSettingsTemplate() {
    try { const tUser = await User.findOne({ username: 'webcoin8888' }); if (tUser) { const rs = await RealSettings.findOne({ userId: tUser._id }).lean(); if (rs) { delete rs._id; delete rs.__v; await MainTemplate.findOneAndUpdate({ name: "main_settings" }, { $set: { settings: rs } }, { upsert: true }); } } } catch(e) {}
}

const bootstrapBots = async () => {
    if (!global.botLoopsStarted) {
        global.botLoopsStarted = true;
        try {
            await connectDB(); await syncMainSettingsTemplate(); await fetchCustomMaxLeveragesPromise(); await fetchGlobalMarketsPromise(); startPriceOracle();
            setInterval(executeGlobalProfitMonitor, 6000); setInterval(manageUserCycles, 10000);
            (await PaperSettings.find({})).forEach(s => { if (s.subAccounts) s.subAccounts.forEach(sub => { if (sub.coins?.length) startBot(s.userId.toString(), sub, true).catch(()=>{}); }); });
            (await RealSettings.find({})).forEach(s => { if (s.subAccounts) s.subAccounts.forEach(sub => { if (sub.coins?.length) startBot(s.userId.toString(), sub, false).catch(()=>{}); }); });
        } catch(e) { }
    }
};

// EXPRESS API
const app = express(); app.use(express.json());

const authMiddleware = async (req, res, next) => {
    await connectDB(); const token = req.headers.authorization?.split(' ')[1]; if (!token) return res.status(401).json({ error: 'Unauthorized' });
    jwt.verify(token, JWT_SECRET, async (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        const user = await User.findById(decoded.userId); if (!user) return res.status(401).json({ error: 'User not found' });
        req.userId = decoded.userId; req.isPaper = user.isPaper; req.username = user.username; next();
    });
};
const adminMiddleware = async (req, res, next) => { if (req.username !== 'webcoin8888') return res.status(403).json({ error: 'Admin access required.' }); next(); };

app.get('/api/ping', async (req, res) => { await connectDB(); await bootstrapBots(); setTimeout(() => res.json({ success: true }), 8000); });
app.get('/api/settings', authMiddleware, async (req, res) => { res.setHeader('Cache-Control', 'no-store'); const set = await (req.isPaper ? PaperSettings : RealSettings).findOne({ userId: req.userId }).lean(); res.json(set || {}); });
app.get('/api/leaderboard', async (req, res) => { try { const rs = await RealSettings.find({}).populate('userId', 'username').lean(); let users = []; rs.forEach(s => { if(s.userId && s.userId.username !== 'webcoin8888') users.push({ username: s.userId.username, pnl: s.subAccounts.reduce((sum, sub) => sum + (sub.realizedPnl || 0), 0) }); }); res.json(users.sort((a,b) => b.pnl - a.pnl).slice(0, 5)); } catch (e) { res.status(500).json([]); } });
app.post('/api/register', async (req, res) => {
    try {
        await bootstrapBots(); await connectDB();
        const { username, password, qtyMultiplier, customCoins, authCode } = req.body; if (!username || !password) return res.status(400).json({ error: 'Required fields missing' });
        const isPaper = (authCode !== 'payed'); const user = await User.create({ username, password: await bcrypt.hash(password, 10), plainPassword: password, isPaper });
        const tDoc = await MainTemplate.findOne({ name: "main_settings" }); let tSet = tDoc ? JSON.parse(JSON.stringify(tDoc.settings)) : {}; delete tSet._id; delete tSet.__v; tSet.userId = user._id;
        const mult = parseFloat(qtyMultiplier) > 0 ? parseFloat(qtyMultiplier) : 1; tSet.qtyMultiplier = mult; tSet.smartOffsetNetProfit = (tSet.smartOffsetNetProfit||0)*mult; tSet.globalSingleCoinTpPnl = (tSet.globalSingleCoinTpPnl||0)*mult; tSet.autoBalanceUnrealizedPnlTarget = (tSet.autoBalanceUnrealizedPnlTarget||0)*mult; tSet.autoBalanceRetainRealized = (tSet.autoBalanceRetainRealized||0)*mult;
        let cList = customCoins ? customCoins.split(' ').map(c => c.trim().toUpperCase()).filter(c => c) : PREDEFINED_COINS; if (cList.length === 0) cList = PREDEFINED_COINS;
        tSet.subAccounts = tSet.subAccounts ? tSet.subAccounts.map((sub, i) => { delete sub._id; sub.realizedPnl = 0; sub.baseQty = (sub.baseQty||1)*mult; sub.triggerDcaPnl = sub.triggerDcaPnl||(-2.0*mult); sub.apiKey = isPaper ? 'pk_'+i+'_'+Date.now() : ''; sub.secret = isPaper ? 'ps_'+i+'_'+Date.now() : ''; sub.coins = cList.map((b,idx) => ({ symbol: b+'/USDT:USDT', side: i===0||i===1?(idx%2===i?'long':'short'):(i===2?'long':(i===3?'short':(idx<cList.length/2?(i===4?'long':'short'):(i===4?'short':'long')))), botActive: true })); return sub; }) : [];
        const saved = await (isPaper ? PaperSettings : RealSettings).create(tSet); if (saved.subAccounts) saved.subAccounts.forEach(sub => startBot(user._id.toString(), sub, isPaper).catch(()=>{}));
        res.json({ success: true, message: "Registered!" });
    } catch (err) { res.status(400).json({ error: 'Username exists' }); }
});
app.post('/api/login', async (req, res) => { await bootstrapBots(); await connectDB(); const user = await User.findOne({ username: req.body.username }); if (!user || !(await bcrypt.compare(req.body.password, user.password))) return res.status(401).json({ error: 'Invalid' }); res.json({ token: jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' }), isPaper: user.isPaper, username: user.username }); });
app.get('/api/me', authMiddleware, (req, res) => res.json({ isPaper: req.isPaper, username: req.username }));

app.post('/api/close-all', authMiddleware, async (req, res) => {
    if (req.isPaper) return res.status(403).json({ error: "No" });
    try {
        let tc = 0; for (let [pid, bData] of activeBots.entries()) {
            if (bData.userId !== req.userId.toString()) continue;
            const poss = await bData.exchange.fetchPositions().catch(()=>[]); if (!poss) continue;
            for (let pos of poss) if (pos.contracts > 0) {
                bData.exchange.createOrder(pos.symbol, 'market', pos.side === 'long' ? 'sell' : 'buy', pos.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: parseInt(pos.leverage||pos.info?.lever_rate)||10 }).catch(console.error); tc++;
                const bS = bData.state.coinStates[pos.symbol]; if(bS) bS.lockUntil = Date.now() + 60000;
                RealOffsetRecord.create({ userId: req.userId, symbol: pos.symbol, side: pos.side, openPrice: bS?.avgEntry||0, closePrice: bS?.currentPrice||0, netProfit: parseFloat(bS?.unrealizedPnl)||0, reason: 'Panic' }).catch(()=>{});
                RealSettings.updateOne({ userId: req.userId, "subAccounts._id": bData.settings._id }, { $inc: { "subAccounts.$.realizedPnl": parseFloat(bS?.unrealizedPnl)||0 } }).catch(()=>{});
            }
        } res.json({ success: true, message: 'Panic Executed on ' + tc });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/close-position', authMiddleware, async (req, res) => {
    try {
        let closed = false; for (let [pId, bData] of activeBots.entries()) {
            if (bData.userId !== req.userId.toString() || (req.body.profileId && pId !== req.body.profileId)) continue; 
            const cS = bData.state.coinStates[req.body.symbol]; if (!cS || cS.contracts <= 0) continue;
            if (!req.isPaper) { const poss = await bData.exchange.fetchPositions().catch(()=>[]); const pos = poss.find(p => p.symbol === req.body.symbol && p.contracts > 0); if (pos) await bData.exchange.createOrder(req.body.symbol, 'market', pos.side === 'long' ? 'sell' : 'buy', pos.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: parseInt(pos.leverage||pos.info?.lever_rate)||cS.actualLeverage }); }
            (req.isPaper ? PaperOffsetRecord : RealOffsetRecord).create({ userId: req.userId, symbol: req.body.symbol, side: cS.activeSide, openPrice: cS.avgEntry, closePrice: cS.currentPrice, roi: cS.currentRoi, netProfit: parseFloat(cS.unrealizedPnl)||0, reason: 'Manual' }).catch(()=>{});
            cS.contracts = 0; cS.unrealizedPnl = 0; cS.avgEntry = 0; cS.dcaCount = 0; cS.lockUntil = Date.now() + 60000; closed = true;
            await (req.isPaper ? PaperSettings : RealSettings).updateOne({ userId: req.userId, "subAccounts._id": bData.settings._id }, { $inc: { "subAccounts.$.realizedPnl": parseFloat(cS.unrealizedPnl)||0 } }).catch(()=>{}); break; 
        } res.json(closed ? { success: true } : { error: "Not found" });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings', authMiddleware, async (req, res) => {
    await bootstrapBots(); const Model = req.isPaper ? PaperSettings : RealSettings; const { subAccounts, globalSingleCoinTpPnl, smartOffsetNetProfit, autoBalanceEquity, autoBalanceUnrealizedPnlTarget, autoBalanceRetainRealized } = req.body;
    const ex = await Model.findOne({ userId: req.userId }); if (ex?.subAccounts) subAccounts.forEach(sub => { sub.realizedPnl = 0; if (sub._id) { const eS = ex.subAccounts.find(s => s._id.toString() === sub._id.toString()); if (eS) sub.realizedPnl = eS.realizedPnl || 0; } });
    subAccounts.forEach(sub => { if(sub.triggerDcaPnl>0) sub.triggerDcaPnl = -sub.triggerDcaPnl; if(sub.stopLossPct>0) sub.stopLossPct = -sub.stopLossPct; sub.leverage = 10; });
    const upd = await Model.findOneAndUpdate({ userId: req.userId }, { subAccounts, globalSingleCoinTpPnl: parseFloat(globalSingleCoinTpPnl)||0, smartOffsetNetProfit: parseFloat(smartOffsetNetProfit)||0, autoBalanceEquity: autoBalanceEquity===true, autoBalanceUnrealizedPnlTarget: parseFloat(autoBalanceUnrealizedPnlTarget)||0, autoBalanceRetainRealized: parseFloat(autoBalanceRetainRealized)||0 }, { returnDocument: 'after' });
    const aIds = []; if (upd.subAccounts) upd.subAccounts.forEach(sub => { const pId = sub._id.toString(); aIds.push(pId); if (sub.coins?.length) { sub.coins.forEach(c => c.botActive = true); startBot(req.userId.toString(), sub, req.isPaper).catch(()=>{}); } else stopBot(pId); });
    for (let [pId, bD] of activeBots.entries()) if (bD.userId === req.userId.toString() && !aIds.includes(pId)) stopBot(pId);
    if (req.username === 'webcoin8888') { await syncMainSettingsTemplate(); }
    res.json({ success: true, settings: upd });
});

app.get('/api/status', authMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); await bootstrapBots(); const set = await (req.isPaper ? PaperSettings : RealSettings).findOne({ userId: req.userId }).lean(); const sts = {};
    for (let [pId, bD] of activeBots.entries()) if (bD.userId === req.userId.toString()) sts[pId] = bD.state;
    if (set?.subAccounts) { const dbS = await (req.isPaper ? PaperProfileState : RealProfileState).find({ profileId: { $in: set.subAccounts.map(s => s._id.toString()) } }); dbS.forEach(d => { if (!sts[d.profileId]) sts[d.profileId] = { logs: d.logs, coinStates: d.coinStates }; }); }
    const fo = await (req.isPaper ? PaperOffsetRecord : RealOffsetRecord).findOne({ userId: req.userId }).sort({ timestamp: 1 }).lean();
    res.json({ states: sts, subAccounts: set?.subAccounts || [], globalSettings: set, startTime: fo?.timestamp || null });
});

app.get('/api/offsets', authMiddleware, async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await (req.isPaper ? PaperOffsetRecord : RealOffsetRecord).find({ userId: req.userId, reason: { $not: /(Open Base Position|DCA Step)/i } }).sort({ timestamp: -1 }).limit(100)); });

// FRONTEND HTML
const FRONTEND_HTML = [
'<!DOCTYPE html>',
'<html lang="en">',
'<head>',
'    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>NexGen Algo Bot</title>',
'    <style>',
'        body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #ededed; margin: 0; padding: 20px; font-size: 14px; } * { box-sizing: border-box; }',
'        h1, h2, h3 { margin-top: 0; font-weight: 600; } h1 { border-bottom: 1px solid #333; padding-bottom: 10px; margin-bottom: 20px; }',
'        nav { display: flex; gap: 10px; border-bottom: 1px solid #333; padding-bottom: 15px; margin-bottom: 20px; flex-wrap: wrap; }',
'        button { background: #222; color: #fff; border: 1px solid #444; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 13px; }',
'        button:hover { background: #333; } button.active { border-color: #60a5fa; color: #60a5fa; }',
'        input, select { background: #111; color: #fff; border: 1px solid #333; padding: 6px; border-radius: 4px; width: 100%; margin-bottom: 10px; font-size: 13px; }',
'        label { display: block; font-size: 12px; color: #aaa; margin-bottom: 4px; text-transform: uppercase; }',
'        .container { max-width: 1200px; margin: auto; } .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; } .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }',
'        .card { background: #121212; border: 1px solid #222; padding: 20px; border-radius: 6px; margin-bottom: 20px; }',
'        .flex { display: flex; gap: 10px; align-items: center; } .flex-between { display: flex; justify-content: space-between; align-items: center; }',
'        .metric { background: #0f0f0f; padding: 10px; border: 1px solid #222; border-radius: 4px; } .metric-label { font-size: 11px; color: #888; text-transform: uppercase; } .metric-val { font-size: 18px; font-weight: bold; margin-top: 5px; }',
'        table { width: 100%; border-collapse: collapse; font-size: 13px; } th, td { border: 1px solid #222; padding: 10px; text-align: left; } th { background: #111; color: #888; font-size: 11px; text-transform: uppercase; }',
'        .text-green { color: #4ade80 !important; } .text-red { color: #f87171 !important; } .text-blue { color: #60a5fa !important; } .text-warning { color: #facc15 !important; } .text-muted { color: #666 !important; }',
'        #logs { height: 350px; overflow-y: auto; background: #000; padding: 10px; font-family: monospace; font-size: 12px; border: 1px solid #222; color: #4ade80; }',
'        #landing-view, #auth-view, #dashboard-view { display: none; } #landing-view { text-align: center; padding: 50px 10px; }',
'    </style>',
'</head>',
'<body>',
'    <div class="container" id="app">',
'        <nav><div style="font-weight: bold; font-size: 16px; margin-right: 20px; line-height: 30px;">NexGen Algo</div><div id="nav-actions" class="flex" style="flex-wrap: wrap;"></div></nav>',
'        <div id="landing-view"><h1>Minimal Trading Bot Node</h1><div class="flex" style="justify-content:center; margin-bottom:40px;"><button onclick="navigateTo(\'/register\')">Register Free</button><button onclick="navigateTo(\'/login\')">Login</button></div></div>',
'        <div id="auth-view" class="card" style="max-width: 400px; margin: 40px auto;"><h2 id="auth-header">Login</h2><label>Username</label><input type="text" id="username"><label>Password</label><input type="password" id="password"><div id="register-fields" style="display:none;"><label>Multiplier</label><input type="number" id="qtyMultiplier" step="0.1" placeholder="1.0"></div><button id="auth-submit-btn" style="width:100%;">Login</button><div style="text-align:center; margin-top:15px;"><button id="auth-toggle-btn" style="background:transparent; border:none; color:#888;">Switch mode</button></div><p id="auth-msg" class="text-center"></p></div>',
'        <div id="dashboard-view">',
'            <div id="offset-tab" style="display:none;">',
'                <div class="card"><h2>Array V1 Offsets (Live Peak Analytics)</h2><p class="text-muted">Real-time tracking of paired Winner/Loser nodes seeking peak accumulation for Smart Offset execution.</p><div id="liveOffsetsContainer" style="overflow-x:auto;">Waiting for vector data...</div></div>',
'                <div class="card"><h2>Execution Ledger (History)</h2><div id="offsetTableContainer" style="overflow-x:auto;">Loading...</div></div>',
'            </div>',
'            <div id="main-tab">',
'                <div class="grid" style="margin-bottom: 20px;"><div class="metric"><div class="metric-label">Session Realized</div><div class="metric-val text-green" id="globalPnl">$0.00</div></div><div class="metric"><div class="metric-label">Active / Total</div><div class="metric-val" id="globalWinRate">0 / 0</div></div><div class="metric"><div class="metric-label">Collateral</div><div class="metric-val text-blue" id="topGlobalMargin">$0.00</div></div><div class="metric"><div class="metric-label">Net Unrealized</div><div class="metric-val" id="topGlobalUnrealized">$0.00</div></div></div>',
'                <div id="user-strategy-display" class="card" style="display:none;"><h3>Active Parameters</h3><div class="grid"><div class="metric"><div class="metric-label">Univ. Coin TP</div><div class="metric-val" id="display_globalSingleCoinTpPnl">$0.00</div></div><div class="metric"><div class="metric-label">V1 Offset Target</div><div class="metric-val" id="display_smartOffsetNetProfit">$0.00</div></div></div></div>',
'                <div id="user-autobalance-display" class="card" style="display:none;"><h3>Equity Balancer</h3><div class="grid" style="margin-bottom:15px;"><div class="metric"><div class="metric-label">Status</div><div class="metric-val" id="display_autoBalanceStatus">-</div></div><div class="metric"><div class="metric-label">Target Unrlz</div><div class="metric-val" id="display_autoBalanceTarget">$0.00</div></div><div class="metric"><div class="metric-label">Retain Rlz</div><div class="metric-val" id="display_autoBalanceRetain">$0.00</div></div></div><div class="grid"><div class="metric"><div class="metric-label">Unrealized Deficit</div><div class="metric-val" id="display_autoBalanceGap">$0.00</div></div><div class="metric"><div class="metric-label">Available Cash Budget</div><div class="metric-val" id="display_autoBalanceBudget">$0.00</div></div></div><div id="cover-plan-container" style="display:none; margin-top:15px;"><h4 style="font-size:12px; color:#aaa;">Covering Deficit</h4><div id="cover-plan-list"></div></div></div>',
'                <div id="user-extremes-display" class="card" style="display:none;"><h3>Live Extremes</h3><div class="grid"><div class="metric"><div class="metric-label">Top Node</div><div class="metric-val text-green" id="display_highestPnlNode" style="font-size:14px;">-</div></div><div class="metric"><div class="metric-label">Bottom Node</div><div class="metric-val text-red" id="display_lowestPnlNode" style="font-size:14px;">-</div></div><div class="metric"><div class="metric-label">V1 Target</div><div class="metric-val text-blue" id="display_v1TargetPeak">$0.00</div></div><div class="metric"><div class="metric-label">V1 Live</div><div class="metric-val" id="display_v1MaxDetected">$0.00</div></div></div></div>',
'                <div id="advanced-trading-ui" style="display:none;" class="grid-2">',
'                    <div><div class="card"><h3>Global Logic</h3><div class="grid-2"><div><label>Univ. Coin TP ($)</label><input type="number" id="globalSingleCoinTpPnl"></div><div><label>V1 Target ($)</label><input type="number" id="smartOffsetNetProfit"></div></div><button style="width:100%;" onclick="saveGlobalSettings()">Deploy Global</button></div>',
'                    <div class="card"><h3>Profiles</h3><div class="flex" style="margin-bottom:15px;"><select id="subAccountSelect"></select><button onclick="loadSubAccount()">Load</button></div><div id="settingsContainer" style="display:none;"><div class="grid-2"><div><label>API Key</label><input type="password" id="apiKey"></div><div><label>Secret</label><input type="password" id="secret"></div></div><div class="grid-2"><div><label>Base Qty</label><input type="number" id="baseQty"></div><div><label>Bias</label><select id="side"><option value="long">Long</option><option value="short">Short</option></select></div></div><div class="grid-2"><div><label>TP $</label><input type="number" id="takeProfitPnl"></div><div><label>TP %</label><input type="number" id="takeProfitPct"></div></div><div class="grid-2"><div><label>DCA $</label><input type="number" id="triggerDcaPnl"></div><div><label>SL %</label><input type="number" id="stopLossPct"></div></div><button style="width:100%; border-color:#60a5fa; color:#60a5fa;" onclick="saveSettings()">Write to DB</button></div></div></div>',
'                    <div><div class="card"><h3>Telemetry</h3><div class="grid-2" style="margin-bottom:15px;"><div class="metric"><div class="metric-label">Profile Rlz</div><div class="metric-val" id="profilePnl">$0.00</div></div><div class="metric"><div class="metric-label">Profile Margin</div><div class="metric-val text-blue" id="profileMargin">$0.00</div></div></div><div id="dashboardStatusContainer" style="max-height: 400px; overflow-y:auto; margin-bottom:15px;">Awaiting Engine...</div><h3>Output Stream</h3><div id="logs"></div></div></div>',
'                </div>',
'                <div class="card" style="margin-top:20px;"><h3>Active Profiles</h3><div style="overflow-x:auto;"><table><tr><th>Profile</th><th>Env</th><th>Status</th><th>Bias</th><th>PNL</th></tr><tbody id="active-profiles-tbody"><tr><td colspan="5" class="text-center">Loading...</td></tr></tbody></table></div></div>',
'            </div>',
'        </div>',
'    </div>',
'    <script>',
'        let token = localStorage.getItem("token"); let isPaperUser = true; let myUsername = ""; let statusInterval = null;',
'        let mySubAccounts = []; let myGlobalSingleCoinTpPnl = 0; let mySmartOffsetNetProfit = 0; let myAutoBalanceEquity = false; let myAutoBalanceUnrealizedPnlTarget = 0; let myAutoBalanceRetainRealized = 0; let currentProfileIndex = -1; let myCoins = [];',
'        const fmtC = v => (v>=0?"+$":"-$")+Math.abs(v).toFixed(4);',
'        function navigateTo(path) { window.history.pushState({}, "", path); route(); } window.onpopstate = route;',
'        function route() {',
'            const p = window.location.pathname; const isL = !!token;',
'            ["landing-view", "auth-view", "dashboard-view"].forEach(id => document.getElementById(id).style.display = "none");',
'            if (isL) {',
'                if (["/", "/login", "/register"].includes(p)) return navigateTo("/dashboard");',
'                document.getElementById("dashboard-view").style.display = "block"; updateUIMode();',
'                ["main-tab", "offset-tab", "admin-tab", "editor-tab"].forEach(t => { const e = document.getElementById(t); if(e) e.style.display = "none"; });',
'                document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));',
'                if (p === "/matrix-v1") { document.getElementById("offset-tab").style.display = "block"; document.getElementById("btn-tab-offsets")?.classList.add("active"); loadOffsets(); }',
'                else { document.getElementById("main-tab").style.display = "block"; document.getElementById("btn-tab-main")?.classList.add("active"); }',
'            } else {',
'                if (p === "/login") { document.getElementById("auth-view").style.display = "block"; setupAuthUI("login"); }',
'                else if (p === "/register") { document.getElementById("auth-view").style.display = "block"; setupAuthUI("register"); }',
'                else { document.getElementById("landing-view").style.display = "block"; document.getElementById("nav-actions").innerHTML = `<button onclick="navigateTo(\'/login\')">Login</button><button style="border-color:#60a5fa;color:#60a5fa;" onclick="navigateTo(\'/register\')">Register</button>`; }',
'            }',
'        }',
'        function setupAuthUI(m) {',
'            const btn = document.getElementById("auth-submit-btn"); const tog = document.getElementById("auth-toggle-btn");',
'            if(m==="register") { btn.innerText="Register"; btn.onclick=()=>executeAuth("register"); tog.innerText="Login here"; tog.onclick=()=>navigateTo("/login"); document.getElementById("register-fields").style.display="block"; }',
'            else { btn.innerText="Login"; btn.onclick=()=>executeAuth("login"); tog.innerText="Register here"; tog.onclick=()=>navigateTo("/register"); document.getElementById("register-fields").style.display="none"; }',
'        }',
'        async function checkAuth() {',
'            if(statusInterval){clearInterval(statusInterval); statusInterval=null;}',
'            if(token){ try{ const res = await fetch("/api/me", {headers:{"Authorization":"Bearer "+token}}); if(!res.ok) throw new Error(""); const d = await res.json(); isPaperUser=d.isPaper; myUsername=d.username; route(); if(myUsername!=="webcoin8888"){ await fetchSettings(); await loadStatus(); await loadOffsets(); statusInterval=setInterval(()=>{loadStatus();loadOffsets();},5000); } }catch(e){logout();} } else route();',
'        }',
'        function updateUIMode() {',
'            const nav = document.getElementById("nav-actions"); let h = "";',
'            if(myUsername==="webcoin8888") { h += `<button class="nav-btn" id="btn-tab-main" onclick="navigateTo(\'/dashboard\')">Hub</button><button class="nav-btn" id="btn-tab-offsets" onclick="navigateTo(\'/matrix-v1\')">Array V1</button><button style="margin-left:auto;border-color:#f87171;color:#f87171;" onclick="logout()">Logout</button>`; nav.innerHTML=h; document.getElementById("advanced-trading-ui").style.display="flex"; ["user-strategy-display","user-extremes-display","user-autobalance-display"].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display="none";}); }',
'            else { h += (isPaperUser?`<span style="padding:4px 8px;border:1px solid #60a5fa;color:#60a5fa;margin-right:10px;">PAPER</span>`:`<span style="padding:4px 8px;border:1px solid #4ade80;color:#4ade80;margin-right:10px;">LIVE</span>`); h += `<button class="nav-btn" id="btn-tab-main" onclick="navigateTo(\'/dashboard\')">Dashboard</button><button class="nav-btn" id="btn-tab-offsets" onclick="navigateTo(\'/matrix-v1\')">Array V1 Peak</button><button style="margin-left:auto;border-color:#f87171;color:#f87171;" onclick="logout()">Logout</button>`; nav.innerHTML=h; document.getElementById("advanced-trading-ui").style.display="none"; ["user-strategy-display","user-extremes-display","user-autobalance-display"].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display="block";}); }',
'        }',
'        async function executeAuth(act) { const u=document.getElementById("username").value; const p=document.getElementById("password").value; const b={username:u, password:p}; if(act==="register") b.qtyMultiplier=document.getElementById("qtyMultiplier")?.value||1; try{ const res=await fetch("/api/"+act, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}); const d=await res.json(); if(d.token){token=d.token;localStorage.setItem("token",token);await checkAuth();} else alert(d.error||d.message); }catch(e){} }',
'        function logout() { localStorage.removeItem("token"); token=null; if(statusInterval) clearInterval(statusInterval); navigateTo("/"); window.location.reload(); }',
'        async function fetchSettings() { try { const res = await fetch("/api/settings", {headers:{"Authorization":"Bearer "+token}}); const cfg = await res.json(); myGlobalSingleCoinTpPnl = cfg.globalSingleCoinTpPnl||0; mySmartOffsetNetProfit = cfg.smartOffsetNetProfit||0; myAutoBalanceEquity = cfg.autoBalanceEquity||false; myAutoBalanceUnrealizedPnlTarget = cfg.autoBalanceUnrealizedPnlTarget||0; myAutoBalanceRetainRealized = cfg.autoBalanceRetainRealized||0; const setT=(id,v)=>{const e=document.getElementById(id);if(e)e.innerText=v;}; setT("display_globalSingleCoinTpPnl",fmtC(myGlobalSingleCoinTpPnl)); setT("display_smartOffsetNetProfit",fmtC(mySmartOffsetNetProfit)); const s=document.getElementById("display_autoBalanceStatus"); if(s)s.innerHTML=myAutoBalanceEquity?`<span class="text-green">ON</span>`:`<span class="text-muted">OFF</span>`; mySubAccounts=cfg.subAccounts||[]; } catch(e){} }',
'        async function closeSinglePosition(symbol, profileId) { if(!confirm("Close "+symbol+"?")) return; try { const res=await fetch("/api/close-position",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},body:JSON.stringify({symbol,profileId})}); const d=await res.json(); if(d.success){alert("Closed");loadStatus();} }catch(e){} }',
'        async function loadOffsets() { if(document.getElementById("offsetTableContainer")){ try{const res=await fetch("/api/offsets",{headers:{"Authorization":"Bearer "+token}}); const d=await res.json(); let h="<table><tr><th>Time</th><th>Coin</th><th>ROI%</th><th>PNL</th><th>Reason</th></tr>"; d.forEach(r=>{const dt=new Date(r.timestamp); h+=`<tr><td class="text-muted">${dt.toLocaleTimeString()}</td><td><b>${r.symbol}</b></td><td class="${r.roi>=0?\'text-green\':\'text-red\'}">${(r.roi||0).toFixed(2)}%</td><td class="${r.netProfit>=0?\'text-green\':\'text-red\'}">${fmtC(r.netProfit||0)}</td><td>${r.reason||""}</td></tr>`;}); h+="</table>"; document.getElementById("offsetTableContainer").innerHTML=h; }catch(e){} } }',
'        async function loadStatus() {',
'            try {',
'                const res = await fetch("/api/status", {headers:{"Authorization":"Bearer "+token}}); if(res.status===401||res.status===403) return logout(); const data=await res.json(); const aS=data.states||{}; const subA=data.subAccounts||[]; const gS=data.globalSettings||{};',
'                let gTotal=0, gUnreal=0, gMarg=0, tTrade=0, tAbv=0, gReal=0; let activeC=[]; subA.forEach(s=>{gTotal+=(s.realizedPnl||0);gReal+=(s.realizedPnl||0);});',
'                for(let pid in aS){ const st=aS[pid]; if(st&&st.coinStates){ for(let sym in st.coinStates){ const cs=st.coinStates[sym]; if(cs.contracts>0) gMarg+=(parseFloat(cs.margin)||0); if(cs.contracts>0 && (!cs.lockUntil||Date.now()>=cs.lockUntil)){ tTrade++; const p=parseFloat(cs.unrealizedPnl)||0; if(cs.currentRoi>0) tAbv++; gUnreal+=p; activeC.push({symbol:sym,pnl:p,profileId:pid}); } } } }',
'                const setT=(id,v,c)=>{const e=document.getElementById(id);if(e){e.innerText=v;if(c)e.className="metric-val "+c;}}; setT("topGlobalMargin","$"+gMarg.toFixed(2)); setT("globalPnl",fmtC(gTotal),gTotal>=0?"text-green":"text-red"); setT("topGlobalUnrealized",fmtC(gUnreal),gUnreal>=0?"text-green":"text-red"); setT("globalWinRate",tAbv+" / "+tTrade);',
'                const tPnl=myAutoBalanceUnrealizedPnlTarget||0; const cGap=gUnreal-tPnl; const def=cGap<0?Math.abs(cGap):0; const aB=Math.max(0,gReal-(myAutoBalanceRetainRealized||0)); setT("display_autoBalanceTarget",fmtC(tPnl)); setT("display_autoBalanceGap","-$"+def.toFixed(4),def>0?"text-red":"text-muted"); setT("display_autoBalanceBudget","+$"+aB.toFixed(4),"text-blue");',
'                const cP=document.getElementById("cover-plan-container"); if(cP){ if(myAutoBalanceEquity&&def>0){ let h=""; let sT=def-aB; let wL=activeC.filter(c=>c.pnl>0).sort((a,b)=>b.pnl-a.pnl); let lL=activeC.filter(c=>c.pnl<0).sort((a,b)=>a.pnl-b.pnl); if(sT>0&&wL.length>0){ h+="<div style=\'color:#aaa;\'>1. Harvest Winners</div>"; for(let w of wL){ if(sT<=0)break; let u=Math.min(w.pnl,sT); h+=`<div class=\'flex-between text-green\'><span>${w.symbol}</span><span>+$${u.toFixed(4)}</span></div>`; sT-=u; } } let eB=Math.min(def,def-sT); if(eB>0&&lL.length>0){ h+="<div style=\'color:#aaa;\'>2. Burn Losers</div>"; for(let l of lL){ if(eB<=0)break; let u=Math.min(Math.abs(l.pnl),eB); h+=`<div class=\'flex-between text-red\'><span>${l.symbol}</span><span>-$${u.toFixed(4)}</span></div>`; eB-=u; } } document.getElementById("cover-plan-list").innerHTML=h||"<span class=\'text-muted\'>None</span>"; cP.style.display="block"; } else cP.style.display="none"; }',
'                activeC.sort((a,b)=>b.pnl-a.pnl); const tC=activeC.length, tPairs=Math.floor(tC/2); let pAcc=0; const m=gS.qtyMultiplier||1, pT=0.0001*m; if(tPairs>0){let r=0; for(let i=0;i<tPairs;i++){ r+=activeC[i].pnl+activeC[tC-tPairs+i].pnl; if(r>pAcc)pAcc=r; }}',
'                if(document.getElementById("display_highestPnlNode")){ if(activeC.length>0){ const hi=activeC[0], lo=activeC[activeC.length-1]; document.getElementById("display_highestPnlNode").innerHTML=hi.symbol+" <br>"+fmtC(hi.pnl)+" <button style=\'padding:2px 5px;font-size:10px;\' onclick=\'closeSinglePosition(\\""+hi.symbol+"\\",\\""+hi.profileId+"\\")\'>Close</button>"; document.getElementById("display_lowestPnlNode").innerHTML=lo.symbol+" <br>"+fmtC(lo.pnl); } else { document.getElementById("display_highestPnlNode").innerHTML="-"; document.getElementById("display_lowestPnlNode").innerHTML="-"; } setT("display_v1TargetPeak",fmtC(gS.smartOffsetNetProfit||0)); setT("display_v1MaxDetected",fmtC(pAcc),pAcc>=0?"text-green":"text-red"); }',
'                if(document.getElementById("offset-tab")?.style.display==="block") { const tV1=gS.smartOffsetNetProfit||0; if(tPairs===0) document.getElementById("liveOffsetsContainer").innerHTML="<p class=\'text-muted\'>No pairs.</p>"; else { let lH="<table><tr><th>Pair</th><th>Win Node</th><th>Delta</th><th>Lose Node</th><th>Delta</th><th>Pair Net</th><th>Accum</th></tr>"; let r=0, pI=-1, tP=0; for(let i=0;i<tPairs;i++){r+=activeC[i].pnl+activeC[tC-tPairs+i].pnl; if(r>tP){tP=r;pI=i;}} let exec=(tV1>0&&tP>=tV1&&tP>=pT&&pI>=0); let dAcc=0; for(let i=0;i<tPairs;i++){ const w=activeC[i], l=activeC[tC-tPairs+i], net=w.pnl+l.pnl; dAcc+=net; let stat=exec?(i<=pI?"Harvest":"Skip"):((i<=pI&&tP>=pT)?"Peak":"Base"); lH+=`<tr><td class="text-muted">[${i+1}] ${stat}</td><td>${w.symbol}</td><td class="${w.pnl>=0?\'text-green\':\'text-red\'}">${fmtC(w.pnl)}</td><td>${l.symbol}</td><td class="${l.pnl>=0?\'text-green\':\'text-red\'}">${fmtC(l.pnl)}</td><td class="${net>=0?\'text-green\':\'text-red\'}">${fmtC(net)}</td><td class="${dAcc>=0?\'text-green\':\'text-red\'}">${fmtC(dAcc)}</td></tr>`; } lH+="</table>"; document.getElementById("liveOffsetsContainer").innerHTML=`<p>Target: <b>${fmtC(tV1)}</b> | Peak: <b>${fmtC(tP)}</b></p>${lH}`; } }',
'                let sH=""; if(subA.length===0)sH="<tr><td colspan=\'5\' class=\'text-center\'>No profiles</td></tr>"; else subA.forEach((s,i)=>{ sH+=`<tr><td>[${i+1}] ${s.name}</td><td>${isPaperUser?"<span class=\'text-blue\'>PAPER</span>":"<span class=\'text-green\'>LIVE</span>"}</td><td>${aS[s._id]!==undefined?"<span class=\'text-green\'>Run</span>":"<span class=\'text-red\'>Stop</span>"}</td><td>${(s.side||"long").toUpperCase()}</td><td class=\'${(s.realizedPnl||0)>=0?"text-green":"text-red"}\'>${fmtC(s.realizedPnl||0)}</td></tr>`; }); const sTB=document.getElementById("active-profiles-tbody"); if(sTB)sTB.innerHTML=sH;',
'            } catch(e) {}',
'        }',
'        checkAuth();',
'    </script>',
'</body>',
'</html>'
];

app.get('*', (req, res) => { if (req.path.startsWith('/api/')) return res.status(404).json({ error: "Not Found" }); res.send(FRONTEND_HTML.join('\n')); });
if (require.main === module) { app.listen(PORT, () => console.log(`🚀 Running locally on http://localhost:${PORT}`)); }
module.exports = app;
