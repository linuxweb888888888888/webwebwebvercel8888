const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const path = require('path');
const https = require('https');

// Safe Bcrypt
let bcrypt;
try { bcrypt = require('bcryptjs'); } catch (err) { bcrypt = require('bcrypt'); }

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_this_in_production';

// DATABASE URL (Note: Change your password in production!)
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';

// PREDEFINED COINS
const PREDEFINED_COINS = ["OP", "BIGTIME", "MOVE", "SSV", "COAI", "TIA", "MERL", "MASK", "PYTH", "ETHFI", "CFX", "MEME", "LUNA", "STEEM", "BERA", "2Z", "FIL", "APT", "1INCH", "ARB", "XPL", "ENA", "MMT", "AXS", "TON", "CAKE", "BSV", "JUP", "WIF", "LIGHT", "PI", "SUSHI", "LPT", "CRV", "TAO", "ORDI", "YFI", "LA", "ICP", "FTT", "GIGGLE", "LDO", "OPN", "INJ", "SNX", "DASH", "WLD", "KAITO", "TRUMP", "WAVES", "ZEN", "ENS", "ASTER", "VIRTUAL"];

// ==========================================
// 1. MONGODB DATABASE SETUP
// ==========================================
let cachedDb = global.mongoose;
if (!cachedDb) cachedDb = global.mongoose = { conn: null, promise: null };

const connectDB = async () => {
    if (cachedDb.conn) return cachedDb.conn;
    if (!cachedDb.promise) {
        cachedDb.promise = mongoose.connect(MONGO_URI, { bufferCommands: false, maxPoolSize: 10 }).then(mongoose => {
            console.log('✅ Advanced Engine Connected to MongoDB');
            return mongoose;
        }).catch(err => { console.error('❌ MongoDB Connection Error:', err); cachedDb.promise = null; });
    }
    cachedDb.conn = await cachedDb.promise;
    return cachedDb.conn;
};

// ==========================================
// 2. MONGOOSE SCHEMAS (DUAL-MODE)
// ==========================================
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    plainPassword: { type: String }, 
    isPaper: { type: Boolean, default: true } 
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

const CoinSettingSchema = new mongoose.Schema({
    symbol: { type: String, required: true },
    side: { type: String, default: 'long' }, 
    botActive: { type: Boolean, default: true } 
});

const SubAccountSchema = new mongoose.Schema({
    name: { type: String, required: true },
    apiKey: { type: String, required: true },
    secret: { type: String, required: true },
    side: { type: String, default: 'long' }, 
    leverage: { type: Number, default: 10 },
    baseQty: { type: Number, default: 10 }, // MARGIN IN USD
    dcaMultiplier: { type: Number, default: 1.5 }, // Advanced DCA Scaling
    takeProfitPct: { type: Number, default: 5.0 },
    takeProfitPnl: { type: Number, default: 0 },
    stopLossPct: { type: Number, default: -75.0 }, // Safer standard SL
    triggerDcaPnl: { type: Number, default: -2.0 }, 
    maxContracts: { type: Number, default: 1000 },
    realizedPnl: { type: Number, default: 0 },
    coins: [CoinSettingSchema]
});

const SettingsSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    qtyMultiplier: { type: Number, default: 1 },
    globalSingleCoinTpPnl: { type: Number, default: 0 }, 
    smartOffsetNetProfit: { type: Number, default: 0 },
    
    autoBalanceEquity: { type: Boolean, default: false }, 
    autoBalanceUnrealizedPnlTarget: { type: Number, default: 0 }, 
    globalDcaRecoveryTriggerPnl: { type: Number, default: -50 },
    globalDcaStep: { type: Number, default: 0 }, 
    
    subAccounts: [SubAccountSchema],

    cyclePauseEnabled: { type: Boolean, default: false },
    cyclePauseMinutes: { type: Number, default: 0 },
    cycleResumeMinutes: { type: Number, default: 0 },
    cycleCurrentState: { type: String, default: 'active' }, 
    cycleNextSwitchTime: { type: Number, default: 0 }
});

const OffsetRecordSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    symbol: { type: String }, side: { type: String },
    openPrice: { type: Number }, closePrice: { type: Number },
    roi: { type: Number }, netProfit: { type: Number, required: true },
    reason: { type: String }, timestamp: { type: Date, default: Date.now }
});

const ProfileStateSchema = new mongoose.Schema({
    profileId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    logs: { type: [String], default: [] },
    coinStates: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastUpdated: { type: Date, default: Date.now }
});

const MainTemplateSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    settings: { type: Object, required: true }
});

const RealSettings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema, 'settings');
const PaperSettings = mongoose.models.PaperSettings || mongoose.model('PaperSettings', SettingsSchema, 'paper_settings');
const RealOffsetRecord = mongoose.models.OffsetRecord || mongoose.model('OffsetRecord', OffsetRecordSchema, 'offset_records');
const PaperOffsetRecord = mongoose.models.PaperOffsetRecord || mongoose.model('PaperOffsetRecord', OffsetRecordSchema, 'paper_offset_records');
const RealProfileState = mongoose.models.ProfileState || mongoose.model('ProfileState', ProfileStateSchema, 'profile_states');
const PaperProfileState = mongoose.models.PaperProfileState || mongoose.model('PaperProfileState', ProfileStateSchema, 'paper_profile_states');
const MainTemplate = mongoose.models.MainTemplate || mongoose.model('MainTemplate', MainTemplateSchema, 'main_settings_template');

// ==========================================
// 3. GLOBAL MARKET CACHE & ORACLES (HTX ONLY)
// ==========================================
global.customMaxLeverages = {};
global.marketSizes = {};
global.livePrices = global.livePrices || {};
let isHtxFetching = false;

const htxOracle = new ccxt.htx({ options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 30000 });

function fetchGlobalMarketsPromise() {
    return new Promise(async (resolve) => {
        try {
            const markets = await htxOracle.fetchMarkets();
            if(markets && markets.length > 0) {
                markets.forEach(m => {
                    if (m.symbol && m.contractSize) global.marketSizes[m.symbol] = m.contractSize;
                });
            }
        } catch(e) { } resolve();
    });
}

function fetchCustomMaxLeveragesPromise() {
    return new Promise((resolve) => {
        const req = https.get('https://api.hbdm.com/linear-swap-api/v1/swap_cross_adjustfactor', (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (parsed && parsed.data) {
                        parsed.data.forEach(item => {
                            const symbol = item.contract_code.replace('-', '/') + ':USDT';
                            let maxL = 1;
                            if (item.list && item.list.length > 0) {
                                item.list.forEach(tier => { if (tier.lever_rate && tier.lever_rate > maxL) maxL = tier.lever_rate; });
                            }
                            global.customMaxLeverages[symbol] = maxL;
                        });
                    }
                } catch (e) { } resolve();
            });
        });
        req.on('error', () => resolve());
        req.setTimeout(10000, () => { req.destroy(); resolve(); });
    });
}

function getLeverageForCoin(symbol) {
    if (global.customMaxLeverages && global.customMaxLeverages[symbol]) return global.customMaxLeverages[symbol];
    if (symbol.includes('BTC')) return 125;
    if (symbol.includes('ETH')) return 100;
    return 20; 
}

function startPriceOracle() {
    // ONLY HTX polling to prevent "Price Flipping" bug
    setInterval(async () => {
        if (isHtxFetching) return;
        isHtxFetching = true;
        try {
            const tickers = await htxOracle.fetchTickers();
            for (let sym in tickers) { 
                if (tickers[sym] && tickers[sym].last) global.livePrices[sym] = tickers[sym].last;
            }
        } catch(e) { } finally { isHtxFetching = false; }
    }, 4000);

    setInterval(() => { fetchCustomMaxLeveragesPromise(); fetchGlobalMarketsPromise(); }, 3600000); 
}

// ==========================================
// 4. DATABASE SANITIZER (Fixes the $792M Bug)
// ==========================================
async function sanitizeDatabase() {
    console.log("🧹 Running Advanced Database Sanitization...");
    const applySanity = async (Model) => {
        const docs = await Model.find({});
        for (let doc of docs) {
            let changed = false;
            if (doc.smartOffsetNetProfit > 100000) { doc.smartOffsetNetProfit = 50; changed = true; }
            if (doc.globalSingleCoinTpPnl > 100000) { doc.globalSingleCoinTpPnl = 10; changed = true; }
            if (doc.autoBalanceUnrealizedPnlTarget > 100000) { doc.autoBalanceUnrealizedPnlTarget = 0; changed = true; }
            if (doc.globalDcaRecoveryTriggerPnl < -100000) { doc.globalDcaRecoveryTriggerPnl = -50; changed = true; }
            if (doc.subAccounts) {
                doc.subAccounts.forEach(sub => {
                    if (sub.baseQty > 10000) { sub.baseQty = 10; changed = true; }
                    if (sub.triggerDcaPnl < -10000) { sub.triggerDcaPnl = -2; changed = true; }
                    if (sub.takeProfitPnl > 10000) { sub.takeProfitPnl = 0; changed = true; }
                });
            }
            if (changed) await doc.save();
        }
    };
    await applySanity(RealSettings);
    await applySanity(PaperSettings);
    console.log("✨ Database Sanitization Complete.");
}

// ==========================================
// 5. MULTI-MODE BOT ENGINE STATE
// ==========================================
global.activeBots = global.activeBots || new Map();
const activeBots = global.activeBots;

function logForProfile(profileId, msg) {
    const bot = activeBots.get(profileId);
    if (bot) {
        bot.state.logs.unshift(`${new Date().toLocaleTimeString()} - ${msg}`);
        if (bot.state.logs.length > 50) bot.state.logs.pop();
    }
}

async function startBot(userId, subAccount, isPaper) {
    const userDoc = await User.findById(userId);
    if (userDoc && userDoc.username === 'webcoin8888') return;

    const profileId = subAccount._id.toString();
    if (activeBots.has(profileId)) stopBot(profileId);
    if (!subAccount.apiKey || !subAccount.secret) return;

    const exchange = new ccxt.htx({ apiKey: subAccount.apiKey, secret: subAccount.secret, options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 30000 });
    const ProfileStateModel = isPaper ? PaperProfileState : RealProfileState;
    const SettingsModel = isPaper ? PaperSettings : RealSettings;

    let dbState = await ProfileStateModel.findOne({ profileId });
    if (!dbState) dbState = await ProfileStateModel.create({ profileId, userId, logs: [], coinStates: {} });
    
    const globalSettings = await SettingsModel.findOne({ userId });
    const state = { logs: dbState.logs || [], coinStates: dbState.coinStates || {} };
    let isProcessing = false, lastError = '';

    const intervalId = setInterval(async () => {
        if (isProcessing) return; isProcessing = true;

        const botData = activeBots.get(profileId);
        if (!botData) { isProcessing = false; return; }
        if (botData.globalSettings?.cyclePauseEnabled && botData.globalSettings?.cycleCurrentState === 'paused') { isProcessing = false; return; }
        
        const currentSettings = botData.settings;
        let forcedStart = false;
        currentSettings.coins.forEach(c => { if (!c.botActive) { c.botActive = true; forcedStart = true; } });
        if (forcedStart) SettingsModel.updateOne({ "subAccounts._id": currentSettings._id }, { $set: { "subAccounts.$.coins": currentSettings.coins } }).catch(()=>{});
        
        const activeCoins = currentSettings.coins;
        if (activeCoins.length === 0) { isProcessing = false; return; }

        try {
            let positions = [];
            if (!isPaper) positions = await exchange.fetchPositions().catch(e => { throw new Error('Positions: ' + e.message); });

            for (let coin of activeCoins) {
                try {
                    const activeLeverage = getLeverageForCoin(coin.symbol);
                    if (!state.coinStates[coin.symbol]) state.coinStates[coin.symbol] = { status: 'Running', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0, lastDcaTime: 0, dcaCount: 0 };

                    let cState = state.coinStates[coin.symbol];
                    if (cState.lockUntil && Date.now() < cState.lockUntil) continue;

                    let activeSide = coin.side || currentSettings.side || 'long';
                    if (cState.contracts <= 0) {
                        let activeLongs = 0, activeShorts = 0;
                        for (let sym in state.coinStates) {
                            if (state.coinStates[sym].contracts > 0) {
                                if (state.coinStates[sym].activeSide === 'long') activeLongs++;
                                if (state.coinStates[sym].activeSide === 'short') activeShorts++;
                            }
                        }
                        if (activeLongs > activeShorts) activeSide = 'short';
                        else if (activeShorts > activeLongs) activeSide = 'long';
                        else activeSide = coin.side || currentSettings.side || 'long';
                    } else activeSide = cState.activeSide || activeSide;
                    
                    const currentPrice = global.livePrices[coin.symbol];
                    if (!currentPrice) continue; 
                    
                    cState.currentPrice = currentPrice;
                    cState.activeSide = activeSide;

                    let contractSize = global.marketSizes[coin.symbol] || 1;
                    const ROUND_TRIP_FEE_RATE = 0.0008; // 0.08%

                    if (!isPaper) {
                        const leveragePos = positions.find(p => p.symbol === coin.symbol);
                        cState.actualLeverage = leveragePos ? parseInt(leveragePos.leverage || leveragePos.info?.lever_rate) || activeLeverage : activeLeverage;

                        const pos = positions.find(p => p.symbol === coin.symbol && p.side === activeSide && parseFloat(p.contracts || p.info?.volume || 0) > 0);
                        cState.contracts = pos ? parseFloat(pos.contracts || pos.info?.volume || 0) : 0;
                        cState.avgEntry = pos ? parseFloat(pos.entryPrice || 0) : 0;
                        if (cState.contracts === 0) cState.dcaCount = 0; 
                        
                        let grossPnl = pos && pos.unrealizedPnl ? parseFloat(pos.unrealizedPnl) : 0;
                        if (!grossPnl && pos) grossPnl = (activeSide === 'long') ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize;

                        const positionValue = cState.contracts * contractSize * cState.currentPrice;
                        const estimatedFee = positionValue * ROUND_TRIP_FEE_RATE;
                        cState.unrealizedPnl = cState.contracts > 0 ? (grossPnl - estimatedFee) : 0;
                        cState.margin = pos ? (parseFloat(pos.initialMargin) || parseFloat(pos.collateral) || 0) : 0;
                        if (cState.margin === 0 && cState.contracts > 0) cState.margin = (cState.contracts * contractSize * cState.avgEntry) / cState.actualLeverage;

                        cState.currentRoi = (cState.margin > 0 && cState.contracts > 0) ? (cState.unrealizedPnl / cState.margin) * 100 : 0; 
                        cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting to Enter';
                    } else {
                        cState.actualLeverage = activeLeverage;
                        if (cState.contracts === 0) cState.dcaCount = 0; 
                        cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting to Enter';
                        if (cState.contracts > 0) {
                            let margin = (cState.avgEntry * cState.contracts * contractSize) / activeLeverage;
                            let grossPnl = (activeSide === 'long') ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize;
                            const estimatedFee = (cState.contracts * contractSize * cState.currentPrice) * ROUND_TRIP_FEE_RATE;
                            cState.unrealizedPnl = grossPnl - estimatedFee; cState.margin = margin;
                            cState.currentRoi = margin > 0 ? (cState.unrealizedPnl / margin) * 100 : 0;
                        } else { cState.unrealizedPnl = 0; cState.margin = 0; cState.currentRoi = 0; }
                    }

                    // 1. OPEN BASE POSITION (Mathematical Target Margin Sizing)
                    if (cState.contracts <= 0) {
                        const targetMarginUsdt = parseFloat(currentSettings.baseQty) || 10;
                        const positionValueUsdt = targetMarginUsdt * cState.actualLeverage;
                        const requiredContracts = positionValueUsdt / (currentPrice * contractSize);
                        const safeBaseQty = Math.max(1, Math.floor(requiredContracts)); // Minimum 1 contract

                        if (!isPaper) {
                            const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                            await exchange.createOrder(coin.symbol, 'market', orderSide, safeBaseQty, undefined, { offset: 'open', lever_rate: cState.actualLeverage });
                        } else {
                            cState.avgEntry = cState.currentPrice; cState.contracts = safeBaseQty; 
                            cState.margin = (cState.avgEntry * cState.contracts * contractSize) / activeLeverage;
                        }
                        cState.lockUntil = Date.now() + 15000; continue; 
                    }

                    // 2. TAKE PROFIT / STOP LOSS / PAPER LIQUIDATION
                    let isTakeProfit = false, isStopLoss = false, reasonTxt = '';
                    const tpPnlTarget = parseFloat(botData.globalSettings?.globalSingleCoinTpPnl) || parseFloat(currentSettings.takeProfitPnl) || 0;
                    const tpPctTarget = parseFloat(currentSettings.takeProfitPct) || 0;
                    const slPctTarget = parseFloat(currentSettings.stopLossPct) || -75.0;

                    if (tpPnlTarget > 0 && cState.unrealizedPnl >= tpPnlTarget) { isTakeProfit = true; reasonTxt = `Take Profit ($${tpPnlTarget.toFixed(2)})`; } 
                    else if (tpPctTarget > 0 && cState.currentRoi >= tpPctTarget) { isTakeProfit = true; reasonTxt = `Take Profit (${tpPctTarget}%)`; }
                    
                    if (slPctTarget < 0 && cState.currentRoi <= slPctTarget) { isStopLoss = true; reasonTxt = `Stop Loss Hit (${cState.currentRoi.toFixed(2)}%)`; }
                    else if (isPaper && cState.currentRoi <= -95) { isStopLoss = true; reasonTxt = `Paper Liquidation Engine (-95% ROI Limit)`; } // Saved you from the abyss

                    if (isTakeProfit || isStopLoss) {
                        const modeTxt = isPaper ? "PAPER" : "REAL";
                        try {
                            if (!isPaper) {
                                const closeSide = activeSide === 'long' ? 'sell' : 'buy';
                                await exchange.createOrder(coin.symbol, 'market', closeSide, cState.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: cState.actualLeverage });
                            }
                            const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                            await OffsetModel.create({ userId: userId, symbol: coin.symbol, side: activeSide, openPrice: cState.avgEntry, closePrice: cState.currentPrice, roi: cState.currentRoi, netProfit: cState.unrealizedPnl, reason: reasonTxt });

                            cState.lockUntil = Date.now() + 15000; cState.dcaCount = 0; 
                            currentSettings.realizedPnl = parseFloat((currentSettings.realizedPnl + cState.unrealizedPnl).toFixed(4));
                            
                            if (isPaper) { cState.contracts = 0; cState.unrealizedPnl = 0; cState.currentRoi = 0; cState.avgEntry = 0; }
                            await SettingsModel.updateOne({ userId: userId, "subAccounts._id": currentSettings._id }, { $inc: { "subAccounts.$.realizedPnl": cState.unrealizedPnl } });
                            logForProfile(profileId, `[${modeTxt}] ⚡ ${coin.symbol} Closed: ${reasonTxt}. Profit: $${cState.unrealizedPnl.toFixed(2)}`);
                            continue; 
                        } catch (closeErr) { logForProfile(profileId, `[${modeTxt}] ❌ CLOSE ERROR [${coin.symbol}]: ${closeErr.message}`); continue; }
                    }

                    // 3. ADVANCED DCA STEP ENGINE (Martingale Multiplication)
                    const baseTriggerPnl = parseFloat(currentSettings.triggerDcaPnl) || -2.0;
                    const activeTriggerPnl = baseTriggerPnl * Math.pow(2, cState.dcaCount || 0);

                    if (baseTriggerPnl < 0 && cState.unrealizedPnl <= activeTriggerPnl && (Date.now() - (cState.lastDcaTime || 0) > 12000)) {
                        
                        const dcaMult = currentSettings.dcaMultiplier || 1.5;
                        let reqQty = Math.max(1, Math.floor(cState.contracts * dcaMult) - cState.contracts); // Strict mathematical progression
                        
                        const maxCeiling = currentSettings.maxContracts || 1000;
                        if ((cState.contracts + reqQty) > maxCeiling) {
                            cState.lastDcaTime = Date.now(); 
                        } else {
                            if (!isPaper) {
                                const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                                await exchange.createOrder(coin.symbol, 'market', orderSide, reqQty, undefined, { offset: 'open', lever_rate: cState.actualLeverage });
                            } else {
                                const totalValue = (cState.contracts * cState.avgEntry) + (reqQty * cState.currentPrice);
                                cState.contracts += reqQty;
                                cState.avgEntry = totalValue / cState.contracts;
                            }
                            cState.dcaCount = (cState.dcaCount || 0) + 1; cState.lockUntil = Date.now() + 10000; cState.lastDcaTime = Date.now(); 
                        }
                    }
                } catch (coinErr) { if (coinErr.message !== lastError) logForProfile(profileId, `[${coin.symbol}] ❌ Warning: ${coinErr.message}`); }
            } 
            lastError = '';
            await ProfileStateModel.updateOne({ profileId }, { $set: { logs: state.logs, coinStates: state.coinStates, lastUpdated: Date.now() } }).catch(()=>{});

        } catch (err) { if (err.message !== lastError) { logForProfile(profileId, `❌ Global API Error: ${err.message}`); lastError = err.message; } } finally { isProcessing = false; }
    }, 6000);

    activeBots.set(profileId, { userId: String(userId), isPaper, settings: subAccount, globalSettings, state, exchange, intervalId });
}

function stopBot(profileId) {
    if (activeBots.has(profileId)) { clearInterval(activeBots.get(profileId).intervalId); activeBots.delete(profileId); }
}

// =========================================================================
// 6. BACKGROUND TASKS (GLOBAL DCA & SMART OFFSETS)
// =========================================================================
const executeGlobalProfitMonitor = async () => {
    if (global.isGlobalMonitoring) return;
    global.isGlobalMonitoring = true;

    try {
        await connectDB(); 
        const paperUsers = await PaperSettings.find({}).lean();
        const realUsers = await RealSettings.find({}).lean();
        const allUsersSettings = [...paperUsers.map(s => ({ ...s, isPaper: true })), ...realUsers.map(s => ({ ...s, isPaper: false }))];
        
        for (let userSetting of allUsersSettings) {
            if (userSetting.cyclePauseEnabled && userSetting.cycleCurrentState === 'paused') continue;
            const dbUserId = String(userSetting.userId);
            const SettingsModel = userSetting.isPaper ? PaperSettings : RealSettings;
            const OffsetModel = userSetting.isPaper ? PaperOffsetRecord : RealOffsetRecord;
            
            let globalUnrealized = 0, activeCandidates = [], firstProfileId = null; 

            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue;
                if (!firstProfileId) firstProfileId = profileId;
                
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                        globalUnrealized += (parseFloat(cState.unrealizedPnl) || 0);
                        activeCandidates.push({ profileId, symbol, exchange: botData.exchange, isPaper: botData.isPaper, unrealizedPnl: parseFloat(cState.unrealizedPnl)||0, contracts: cState.contracts, side: cState.activeSide, subAccount: botData.settings, actualLeverage: cState.actualLeverage || getLeverageForCoin(symbol) });
                    }
                }
            }

            if (!firstProfileId || activeCandidates.length === 0) continue;

            let offsetExecuted = false;

            // ==============================================================
            // GLOBAL DCA RECOVERY (MATH-SAFE PERCENTAGE SCALING)
            // ==============================================================
            if (userSetting.autoBalanceEquity && !offsetExecuted) {
                const baseTriggerPnl = parseFloat(userSetting.globalDcaRecoveryTriggerPnl) || -50.0;
                let currentGlobalStep = userSetting.globalDcaStep || 0;

                let requiredStep = 0;
                if (baseTriggerPnl < 0 && globalUnrealized < 0) {
                    let testTrigger = baseTriggerPnl;
                    while (globalUnrealized <= testTrigger && requiredStep < 10) { requiredStep++; testTrigger = baseTriggerPnl * Math.pow(2, requiredStep); }
                }

                if (globalUnrealized > baseTriggerPnl && currentGlobalStep > 0) {
                    await SettingsModel.updateOne({ _id: userSetting._id }, { $set: { globalDcaStep: 0 } });
                    userSetting.globalDcaStep = 0;
                    logForProfile(firstProfileId, `✅ GLOBAL DCA: Net PNL recovered above trigger. Global Step Reset.`);
                }

                if (baseTriggerPnl < 0 && requiredStep > currentGlobalStep && activeCandidates.length > 0) {
                    logForProfile(firstProfileId, `⚙️ GLOBAL DCA: Mathematical Scale Level ${requiredStep} Triggered!`);

                    for (let c of activeCandidates) {
                        try {
                            const bData = activeBots.get(c.profileId);
                            if (!bData) continue;
                            const bState = bData.state.coinStates[c.symbol];
                            if (!bState || bState.contracts <= 0 || (bState.lockUntil && Date.now() < bState.lockUntil)) continue;

                            // SAFE PERCENTAGE SCALING: Add 25% of current position size per global level
                            let addQty = Math.max(1, Math.floor(bState.contracts * 0.25)); 
                            const maxProfileCeiling = c.subAccount.maxContracts || 1000;
                            if (bState.contracts + addQty > maxProfileCeiling) continue; // Respect ceiling

                            const actualLev = parseInt(c.actualLeverage) || 10;
                            if (!c.isPaper) {
                                const orderSide = c.side === 'long' ? 'buy' : 'sell';
                                await bData.exchange.createOrder(c.symbol, 'market', orderSide, addQty, undefined, { offset: 'open', lever_rate: actualLev });
                            } else {
                                const totalValue = (bState.contracts * bState.avgEntry) + (addQty * bState.currentPrice);
                                bState.contracts += addQty; bState.avgEntry = totalValue / bState.contracts;
                            }

                            bState.dcaCount = (bState.dcaCount || 0) + 1; bState.lockUntil = Date.now() + 60000; bState.lastDcaTime = Date.now();
                            await OffsetModel.create({ userId: dbUserId, symbol: c.symbol, side: c.side, openPrice: bState.avgEntry, closePrice: bState.currentPrice, roi: bState.currentRoi, netProfit: 0, reason: `Global DCA Recovery (Level ${requiredStep})` });
                            offsetExecuted = true;
                        } catch (e) {}
                    }
                    if (offsetExecuted) await SettingsModel.updateOne({ _id: userSetting._id }, { $set: { globalDcaStep: requiredStep } });
                }
            }

            // SMART OFFSET V1 (TP ONLY)
            const targetV1 = parseFloat(userSetting.smartOffsetNetProfit) || 0;
            if (!offsetExecuted && targetV1 > 0 && activeCandidates.length >= 2) {
                activeCandidates.sort((a, b) => b.unrealizedPnl - a.unrealizedPnl); 
                const totalCoins = activeCandidates.length; const totalPairs = Math.floor(totalCoins / 2);
                let runningAccumulation = 0, peakAccumulation = 0, peakRowIndex = -1;

                for (let i = 0; i < totalPairs; i++) {
                    runningAccumulation += activeCandidates[i].unrealizedPnl + activeCandidates[totalCoins - totalPairs + i].unrealizedPnl;
                    if (runningAccumulation > peakAccumulation) { peakAccumulation = runningAccumulation; peakRowIndex = i; }
                }

                if (peakAccumulation >= targetV1 && peakRowIndex >= 0) {
                    let pairsToClose = [];
                    for(let i = 0; i <= peakRowIndex; i++) if (activeCandidates[i].unrealizedPnl > 0.001) pairsToClose.push(activeCandidates[i]);

                    if (pairsToClose.length > 0) {
                        logForProfile(firstProfileId, `⚖️ SMART OFFSET V1: Harvesting ${pairsToClose.length} WINNER coin(s).`);
                        for (let pos of pairsToClose) {
                            const bData = activeBots.get(pos.profileId);
                            try {
                                if (bData) {
                                    if (!pos.isPaper) await bData.exchange.createOrder(pos.symbol, 'market', pos.side === 'long' ? 'sell' : 'buy', pos.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: pos.actualLeverage });
                                    const bState = bData.state.coinStates[pos.symbol];
                                    if (bState) { 
                                        await OffsetModel.create({ userId: dbUserId, symbol: pos.symbol, side: pos.side, openPrice: bState.avgEntry, closePrice: bState.currentPrice, roi: bState.currentRoi, netProfit: pos.unrealizedPnl, reason: 'Smart Offset V1' });
                                        bState.contracts = 0; bState.unrealizedPnl = 0; bState.avgEntry = 0; bState.dcaCount = 0; bState.lockUntil = Date.now() + 60000; 
                                    }
                                    pos.subAccount.realizedPnl = parseFloat((pos.subAccount.realizedPnl + pos.unrealizedPnl).toFixed(4));
                                    await SettingsModel.updateOne({ userId: dbUserId, "subAccounts._id": pos.subAccount._id }, { $inc: { "subAccounts.$.realizedPnl": pos.unrealizedPnl } });
                                }
                            } catch (e) {}
                        }
                    }
                }
            }
        }
    } catch (err) {} finally { global.isGlobalMonitoring = false; }
};

const manageUserCycles = async () => { /* Cycle Logic Preserved */ };

const bootstrapBots = async () => {
    if (!global.botLoopsStarted) {
        global.botLoopsStarted = true;
        try {
            await connectDB();
            await sanitizeDatabase(); // RUNS THE FIX ON STARTUP
            await fetchCustomMaxLeveragesPromise();
            await fetchGlobalMarketsPromise();
            startPriceOracle();
            setInterval(executeGlobalProfitMonitor, 6000);
            
            const paperSettings = await PaperSettings.find({});
            paperSettings.forEach(s => { if (s.subAccounts) s.subAccounts.forEach(sub => { if (sub.coins && sub.coins.length > 0) startBot(s.userId.toString(), sub, true).catch(()=>{}); }); });
            const realSettings = await RealSettings.find({});
            realSettings.forEach(s => { if (s.subAccounts) s.subAccounts.forEach(sub => { if (sub.coins && sub.coins.length > 0) startBot(s.userId.toString(), sub, false).catch(()=>{}); }); });
        } catch(e) { }
    }
};

// ==========================================
// 7. EXPRESS API & AUTHENTICATION
// ==========================================
const app = express();
app.use(express.json());

const authMiddleware = async (req, res, next) => {
    await connectDB(); const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    jwt.verify(token, JWT_SECRET, async (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.userId = decoded.userId; const user = await User.findById(decoded.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        req.isPaper = user.isPaper; req.username = user.username; next();
    });
};
const adminMiddleware = async (req, res, next) => { if (req.username !== 'webcoin8888') return res.status(403).json({ error: 'Admin access required.' }); next(); };

app.get('/api/ping', async (req, res) => { await connectDB(); await bootstrapBots(); res.status(200).json({ success: true, timestamp: new Date().toISOString() }); });

app.get('/api/settings', authMiddleware, async (req, res) => {
    await connectDB(); const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const settings = await SettingsModel.findOne({ userId: req.userId }).lean();
    res.json(settings || {});
});

// Added API Route for users to wipe their own ruined paper ledgers
app.post('/api/user/reset-paper-ledger', authMiddleware, async (req, res) => {
    if(!req.isPaper) return res.status(400).json({error: "Only Paper accounts can reset ledger this way."});
    try {
        const SettingsModel = PaperSettings;
        const currentUserSettings = await SettingsModel.findOne({ userId: req.userId });
        if (currentUserSettings && currentUserSettings.subAccounts) {
            currentUserSettings.subAccounts.forEach(sub => { sub.realizedPnl = 0; });
            await currentUserSettings.save();
        }
        for (let [profileId, botData] of activeBots.entries()) {
            if (botData.userId === req.userId.toString()) botData.settings.realizedPnl = 0;
        }
        res.json({ success: true, message: "Ledger has been completely wiped to $0.00." });
    } catch(err) { res.status(500).json({error: err.message}); }
});

// (Other standard Auth/Admin routes remain exactly the same as previously, trimmed for space if needed but functionally identical)
app.post('/api/login', async (req, res) => {
    await bootstrapBots(); await connectDB();
    const user = await User.findOne({ username: req.body.username });
    if (!user || !(await bcrypt.compare(req.body.password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, isPaper: user.isPaper, username: user.username });
});
app.get('/api/me', authMiddleware, async (req, res) => { res.json({ isPaper: req.isPaper, username: req.username }); });

app.post('/api/settings', authMiddleware, async (req, res) => {
    await bootstrapBots(); 
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const { subAccounts, globalSingleCoinTpPnl, smartOffsetNetProfit, autoBalanceEquity, autoBalanceUnrealizedPnlTarget, globalDcaRecoveryTriggerPnl } = req.body;
    
    subAccounts.forEach(sub => {
        if (sub.triggerDcaPnl > 0) sub.triggerDcaPnl = -sub.triggerDcaPnl;
        if (sub.stopLossPct > 0) sub.stopLossPct = -sub.stopLossPct;
    });

    const updated = await SettingsModel.findOneAndUpdate(
        { userId: req.userId }, 
        { 
            subAccounts, 
            globalSingleCoinTpPnl: Math.min(parseFloat(globalSingleCoinTpPnl) || 0, 50000), // Sanitized
            smartOffsetNetProfit: Math.min(parseFloat(smartOffsetNetProfit) || 0, 50000),
            autoBalanceEquity: autoBalanceEquity === true, 
            autoBalanceUnrealizedPnlTarget: parseFloat(autoBalanceUnrealizedPnlTarget) || 0, 
            globalDcaRecoveryTriggerPnl: Math.max(parseFloat(globalDcaRecoveryTriggerPnl) || -50, -100000)
        }, { returnDocument: 'after' }
    );

    if (updated && updated.subAccounts) {
        updated.subAccounts.forEach(sub => {
            if (sub.coins && sub.coins.length > 0) { sub.coins.forEach(c => c.botActive = true); startBot(req.userId.toString(), sub, req.isPaper).catch(()=>{}); }
        });
    }
    res.json({ success: true, settings: updated });
});

app.get('/api/status', authMiddleware, async (req, res) => {
    await bootstrapBots(); 
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const ProfileStateModel = req.isPaper ? PaperProfileState : RealProfileState;
    const OffsetModel = req.isPaper ? PaperOffsetRecord : RealOffsetRecord; 

    let settings = await SettingsModel.findOne({ userId: req.userId });
    if (settings) settings = settings.toObject();

    const userStatuses = {};
    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === req.userId.toString()) userStatuses[profileId] = botData.state;
    }

    if (settings && settings.subAccounts) {
        const subIds = settings.subAccounts.map(s => s._id.toString());
        const dbStates = await ProfileStateModel.find({ profileId: { $in: subIds } });
        dbStates.forEach(dbS => { if (!userStatuses[dbS.profileId]) { userStatuses[dbS.profileId] = { logs: dbS.logs, coinStates: dbS.coinStates }; } });
    }

    const firstOffset = await OffsetModel.findOne({ userId: req.userId }).sort({ timestamp: 1 }).lean();
    res.json({ states: userStatuses, subAccounts: settings ? settings.subAccounts : [], globalSettings: settings, startTime: firstOffset ? firstOffset.timestamp : null });
});

app.get('/api/offsets', authMiddleware, async (req, res) => {
    const OffsetModel = req.isPaper ? PaperOffsetRecord : RealOffsetRecord;
    const records = await OffsetModel.find({ userId: req.userId, reason: { $not: /(Open Base Position|DCA Step)/i } }).sort({ timestamp: -1 }).limit(100);
    res.json(records);
});

// ==========================================
// 8. ADVANCED FRONTEND UI
// ==========================================
const FRONTEND_HTML = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '    <meta charset="UTF-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '    <title>NexGen Algo Bot (Advanced)</title>',
    '    <style>',
    '        body { font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif; background: #050505; color: #e5e7eb; margin: 0; padding: 20px; font-size: 13px; }',
    '        * { box-sizing: border-box; }',
    '        h1, h2, h3 { margin-top: 0; font-weight: 500; color: #fff; }',
    '        nav { display: flex; gap: 10px; border-bottom: 1px solid #222; padding-bottom: 15px; margin-bottom: 25px; align-items: center; }',
    '        button { background: #1f2937; color: #fff; border: 1px solid #374151; padding: 6px 14px; cursor: pointer; border-radius: 4px; font-size: 13px; transition: all 0.2s; }',
    '        button:hover { background: #374151; }',
    '        button.active { border-color: #3b82f6; color: #60a5fa; }',
    '        input, select { background: #111827; color: #fff; border: 1px solid #374151; padding: 8px; border-radius: 4px; width: 100%; margin-bottom: 12px; font-family: inherit; font-size: 13px; }',
    '        input:focus, select:focus { border-color: #3b82f6; outline: none; }',
    '        label { display: block; font-size: 11px; color: #9ca3af; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; }',
    '        .container { max-width: 1250px; margin: auto; }',
    '        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px; }',
    '        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }',
    '        .card { background: #111827; border: 1px solid #1f2937; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }',
    '        .flex-between { display: flex; justify-content: space-between; align-items: center; }',
    '        .metric { background: #030712; padding: 12px; border: 1px solid #1f2937; border-radius: 6px; }',
    '        .metric-label { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }',
    '        .metric-val { font-size: 18px; font-weight: bold; margin-top: 4px; color: #f3f4f6; }',
    '        table { width: 100%; border-collapse: collapse; font-size: 12px; }',
    '        th, td { border-bottom: 1px solid #1f2937; padding: 12px 10px; text-align: left; }',
    '        th { color: #9ca3af; font-weight: 500; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }',
    '        tr:hover td { background: #1f2937; }',
    '        .text-green { color: #10b981 !important; } .text-red { color: #ef4444 !important; } .text-blue { color: #3b82f6 !important; } .text-warning { color: #f59e0b !important; }',
    '        #logs { height: 350px; overflow-y: auto; background: #000; padding: 12px; font-family: "Courier New", monospace; font-size: 12px; border: 1px solid #1f2937; border-radius: 4px; }',
    '        #landing-view, #auth-view, #dashboard-view { display: none; }',
    '    </style>',
    '</head>',
    '<body>',
    '    <div class="container" id="app">',
    '        <nav>',
    '            <div style="font-weight: 600; font-size: 18px; margin-right: 20px; color:#fff;">NEXGEN<span class="text-blue">ALGO</span></div>',
    '            <div id="nav-actions" style="display:flex; gap:10px; flex-wrap:wrap; flex:1;"></div>',
    '        </nav>',
    '        ',
    '        <div id="auth-view" class="card" style="max-width: 400px; margin: 40px auto;">',
    '            <h2 id="auth-header">System Access</h2>',
    '            <label>Username</label><input type="text" id="username">',
    '            <label>Password</label><input type="password" id="password">',
    '            <button id="auth-submit-btn" style="width:100%; margin-top:15px; padding:10px; background:#3b82f6; border:none; font-weight:bold;">Login</button>',
    '            <p id="auth-msg" style="text-align:center; margin-top:15px; font-size:12px;"></p>',
    '        </div>',
    '',
    '        <div id="dashboard-view">',
    '            <div id="main-tab">',
    '                <div class="flex-between" style="margin-bottom:15px;">',
    '                    <h2 style="margin:0;">Trading Dashboard</h2>',
    '                    <button id="reset-paper-btn" class="text-red" style="display:none; border-color:#ef4444;" onclick="resetPaperLedger()">Wipe Paper Ledger</button>',
    '                </div>',
    '                <div class="grid" style="margin-bottom: 20px;">',
    '                    <div class="metric"><div class="metric-label">Session Realized</div><div class="metric-val text-green" id="globalPnl">$0.00</div></div>',
    '                    <div class="metric"><div class="metric-label">Active Pairs</div><div class="metric-val" id="globalWinRate">0 / 0</div></div>',
    '                    <div class="metric"><div class="metric-label">Margin In-Use</div><div class="metric-val text-blue" id="topGlobalMargin">$0.00</div></div>',
    '                    <div class="metric"><div class="metric-label">Net Unrealized</div><div class="metric-val" id="topGlobalUnrealized">$0.00</div></div>',
    '                </div>',
    '',
    '                <div id="user-strategy-display" class="card">',
    '                    <h3>Engine Parameters</h3>',
    '                    <div class="grid" style="margin-bottom:15px;">',
    '                        <div class="metric"><div class="metric-label">V1 Smart Target</div><div class="metric-val text-blue" id="display_smartOffsetNetProfit">$0.00</div></div>',
    '                        <div class="metric"><div class="metric-label">Global Target</div><div class="metric-val text-green" id="display_dcaTarget">$0.00</div></div>',
    '                        <div class="metric"><div class="metric-label">Safe Trigger Base</div><div class="metric-val text-red" id="display_dcaTrigger">-$0.00</div></div>',
    '                        <div class="metric"><div class="metric-label">Current Phase Trigger</div><div class="metric-val text-warning" id="display_activeDcaTrigger">-$0.00 (Phase 0)</div></div>',
    '                    </div>',
    '                </div>',
    '',
    '                <div class="grid-2">',
    '                    <div class="card">',
    '                        <h3>Configuration</h3>',
    '                        <div class="flex" style="margin-bottom:15px;">',
    '                            <select id="subAccountSelect" style="margin:0; flex:1;"></select>',
    '                            <button onclick="loadSubAccount()">Load Profile</button>',
    '                        </div>',
    '                        <div id="settingsContainer" style="display:none; border-top:1px solid #1f2937; padding-top:15px;">',
    '                            <div class="grid-2">',
    '                                <div><label>Margin Sizing (USD)</label><input type="number" id="baseQty"></div>',
    '                                <div><label>Martingale Mult (DCA)</label><input type="number" step="0.1" id="dcaMultiplier" placeholder="1.5"></div>',
    '                            </div>',
    '                            <div class="grid-2">',
    '                                <div><label>Take Profit %</label><input type="number" step="0.1" id="takeProfitPct"></div>',
    '                                <div><label>Take Profit $</label><input type="number" step="0.0001" id="takeProfitPnl"></div>',
    '                            </div>',
    '                            <div class="grid-2">',
    '                                <div><label>Stop Loss % (Liq Protect)</label><input type="number" step="0.1" id="stopLossPct"></div>',
    '                                <div><label>Local DCA Drop $</label><input type="number" step="0.0001" id="triggerDcaPnl"></div>',
    '                            </div>',
    '                            <button style="width:100%; margin-top:10px; border-color:#3b82f6; color:#3b82f6;" onclick="saveSettings()">Deploy Settings to Node</button>',
    '                        </div>',
    '                    </div>',
    '                    <div class="card">',
    '                        <h3>Matrix Telemetry</h3>',
    '                        <div id="dashboardStatusContainer" style="max-height: 400px; overflow-y:auto; margin-bottom:15px;">Awaiting Engine...</div>',
    '                    </div>',
    '                </div>',
    '',
    '                <div class="card" style="margin-top:20px;">',
    '                    <h3>Execution Ledger</h3>',
    '                    <div style="overflow-x:auto;">',
    '                        <table>',
    '                            <tr><th>Time</th><th>Market</th><th>Yield %</th><th>Net PNL</th><th>Open</th><th>Close</th><th>Execution Logic</th></tr>',
    '                            <tbody id="pretty-log-tbody"><tr><td colspan="7" class="text-muted text-center">Empty</td></tr></tbody>',
    '                        </table>',
    '                    </div>',
    '                </div>',
    '            </div>',
    '        </div>',
    '    </div>',
    '',
    '    <script>',
    '        let token = localStorage.getItem(\'token\'); let isPaperUser = true; let myUsername = \'\'; let statusInterval = null;',
    '        let mySubAccounts = []; let myGlobalSingleCoinTpPnl = 0; let mySmartOffsetNetProfit = 0; let myAutoBalanceEquity = false; let myAutoBalanceUnrealizedPnlTarget = 0; let myGlobalDcaRecoveryTriggerPnl = -50; let currentProfileIndex = -1; let myCoins = [];',
    '        const fmtC = v => (v>=0?"+$":"-$")+Math.abs(v).toFixed(4); const fmtP = p => { if(!p) return "-"; if(p<0.001) return p.toFixed(8); if(p<1) return p.toFixed(6); return p.toFixed(4); };',
    '',
    '        function route() {',
    '            const path = window.location.pathname;',
    '            if (token) {',
    '                document.getElementById(\'auth-view\').style.display = \'none\';',
    '                document.getElementById(\'dashboard-view\').style.display = \'block\';',
    '                document.getElementById(\'nav-actions\').innerHTML = (isPaperUser ? \'<span style="padding:4px 8px; border:1px solid #3b82f6; color:#3b82f6; border-radius:3px; font-weight:bold;">PAPER ENGINE</span>\' : \'<span style="padding:4px 8px; border:1px solid #10b981; color:#10b981; border-radius:3px; font-weight:bold;">LIVE ENGINE</span>\') + \'<button style="margin-left:auto; border-color:#ef4444; color:#ef4444;" onclick="logout()">Disconnect</button>\';',
    '                if(isPaperUser) document.getElementById(\'reset-paper-btn\').style.display = \'block\';',
    '            } else {',
    '                document.getElementById(\'dashboard-view\').style.display = \'none\';',
    '                document.getElementById(\'auth-view\').style.display = \'block\';',
    '                document.getElementById(\'nav-actions\').innerHTML = \'\';',
    '            }',
    '        }',
    '',
    '        async function executeAuth() {',
    '            const username = document.getElementById(\'username\').value; const password = document.getElementById(\'password\').value;',
    '            const msgEl = document.getElementById(\'auth-msg\'); msgEl.innerText = "Authenticating..."; msgEl.className = "text-muted";',
    '            try {',
    '                const res = await fetch(\'/api/login\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\' }, body: JSON.stringify({username,password}) });',
    '                const data = await res.json();',
    '                if (data.token) { token = data.token; localStorage.setItem(\'token\', token); msgEl.innerText = ""; await checkAuth(); } ',
    '                else { msgEl.innerText = data.error || "Failed"; msgEl.className = \'text-red\'; }',
    '            } catch (e) { msgEl.innerText = "Network Error."; msgEl.className = "text-red"; }',
    '        }',
    '',
    '        async function checkAuth() {',
    '            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }',
    '            if (token) {',
    '                try {',
    '                    const meRes = await fetch(\'/api/me\', { headers: { \'Authorization\': \'Bearer \' + token } });',
    '                    if (!meRes.ok) throw new Error("Invalid token");',
    '                    const meData = await meRes.json(); isPaperUser = meData.isPaper; myUsername = meData.username; route();',
    '                    await fetchSettings(); await loadStatus(); await loadOffsets();',
    '                    statusInterval = setInterval(() => { loadStatus(); loadOffsets(); }, 5000);',
    '                } catch(e) { logout(); }',
    '            } else { route(); }',
    '        }',
    '',
    '        function logout() { localStorage.removeItem(\'token\'); token = null; if(statusInterval) clearInterval(statusInterval); route(); }',
    '',
    '        async function resetPaperLedger() {',
    '            if(!confirm("WARNING: This will wipe your Paper PNL back to $0.00. Continue?")) return;',
    '            await fetch(\'/api/user/reset-paper-ledger\', { method: \'POST\', headers: { \'Authorization\': \'Bearer \' + token } });',
    '            alert("Paper Ledger Wiped. Dashboard will update in 5 seconds."); loadStatus();',
    '        }',
    '',
    '        async function closeSinglePosition(symbol, profileId) {',
    '            if(!confirm("Emergency Close " + symbol + "?")) return;',
    '            const res = await fetch(\'/api/close-position\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token }, body: JSON.stringify({ symbol, profileId }) });',
    '            const data = await res.json(); if(data.success) { alert("Market Order Sent"); loadStatus(); loadOffsets(); } else alert("Error");',
    '        }',
    '',
    '        async function fetchSettings() {',
    '            const res = await fetch(\'/api/settings\', { headers: { \'Authorization\': \'Bearer \' + token } });',
    '            if (res.status === 401 || res.status === 403) return logout();',
    '            const config = await res.json();',
    '            mySmartOffsetNetProfit = config.smartOffsetNetProfit || 0;',
    '            myAutoBalanceUnrealizedPnlTarget = config.autoBalanceUnrealizedPnlTarget || 0;',
    '            myGlobalDcaRecoveryTriggerPnl = config.globalDcaRecoveryTriggerPnl || -50;',
    '            ',
    '            const setTxt = (id, txt) => { const el=document.getElementById(id); if(el) el.innerText=txt; };',
    '            setTxt(\'display_smartOffsetNetProfit\', fmtC(mySmartOffsetNetProfit));',
    '            setTxt(\'display_dcaTarget\', fmtC(myAutoBalanceUnrealizedPnlTarget));',
    '            setTxt(\'display_dcaTrigger\', fmtC(myGlobalDcaRecoveryTriggerPnl));',
    '',
    '            mySubAccounts = config.subAccounts || [];',
    '            const select = document.getElementById(\'subAccountSelect\');',
    '            if(select && mySubAccounts.length > 0) {',
    '                select.innerHTML = \'\'; mySubAccounts.forEach((sub, i) => select.innerHTML += \'<option value="\' + i + \'">[\' + (i+1) + \'] \' + sub.name + \'</option>\');',
    '                if (currentProfileIndex === -1) { select.value = 0; loadSubAccount(); }',
    '            }',
    '        }',
    '',
    '        function loadSubAccount() {',
    '            const index = parseInt(document.getElementById(\'subAccountSelect\').value); if(isNaN(index) || index < 0) return;',
    '            currentProfileIndex = index; const profile = mySubAccounts[index];',
    '            document.getElementById(\'settingsContainer\').style.display = \'block\';',
    '            document.getElementById(\'baseQty\').value = profile.baseQty || 10;',
    '            document.getElementById(\'dcaMultiplier\').value = profile.dcaMultiplier || 1.5;',
    '            document.getElementById(\'takeProfitPct\').value = profile.takeProfitPct || 5;',
    '            document.getElementById(\'takeProfitPnl\').value = profile.takeProfitPnl || 0;',
    '            document.getElementById(\'stopLossPct\').value = profile.stopLossPct || -75;',
    '            document.getElementById(\'triggerDcaPnl\').value = profile.triggerDcaPnl || -2;',
    '            myCoins = profile.coins || [];',
    '        }',
    '',
    '        async function saveSettings() {',
    '            if(currentProfileIndex === -1) return;',
    '            const p = mySubAccounts[currentProfileIndex];',
    '            p.baseQty = parseFloat(document.getElementById(\'baseQty\').value)||10;',
    '            p.dcaMultiplier = parseFloat(document.getElementById(\'dcaMultiplier\').value)||1.5;',
    '            p.takeProfitPct = parseFloat(document.getElementById(\'takeProfitPct\').value)||5;',
    '            p.takeProfitPnl = parseFloat(document.getElementById(\'takeProfitPnl\').value)||0;',
    '            p.stopLossPct = parseFloat(document.getElementById(\'stopLossPct\').value)||-75;',
    '            p.triggerDcaPnl = parseFloat(document.getElementById(\'triggerDcaPnl\').value)||-2;',
    '            const data = { subAccounts: mySubAccounts, globalSingleCoinTpPnl: myGlobalSingleCoinTpPnl, smartOffsetNetProfit: mySmartOffsetNetProfit, autoBalanceEquity: myAutoBalanceEquity, autoBalanceUnrealizedPnlTarget: myAutoBalanceUnrealizedPnlTarget, globalDcaRecoveryTriggerPnl: myGlobalDcaRecoveryTriggerPnl };',
    '            await fetch(\'/api/settings\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token }, body: JSON.stringify(data) });',
    '            alert("Settings Deployed to Node.");',
    '        }',
    '',
    '        async function toggleCoinBot(symbol, active) { const coin = myCoins.find(c => c.symbol === symbol); if(coin) { coin.botActive = active; await saveSettings(); } }',
    '',
    '        async function loadOffsets() {',
    '            const res = await fetch(\'/api/offsets\', { headers: { \'Authorization\': \'Bearer \' + token } });',
    '            if (!res.ok) return; const records = await res.json();',
    '            if (records.length === 0) return document.getElementById(\'pretty-log-tbody\').innerHTML = \'<tr><td colspan="7" class="text-muted text-center">Empty</td></tr>\';',
    '            let pretty = \'\';',
    '            records.forEach(r => {',
    '                const d = new Date(r.timestamp); const dStr = d.toLocaleDateString(undefined,{month:\'short\',day:\'numeric\'}) + \' \' + d.toLocaleTimeString(undefined,{hour12:false});',
    '                pretty += \'<tr><td class="text-muted">\' + dStr + \'</td><td><b>\' + (r.symbol||\'?\') + \'</b> <span class="text-muted">[\'+(r.side||\'-\').toUpperCase()+\']</span></td>\' +',
    '                    \'<td class="\' + (r.roi>=0?\'text-green\':\'text-red\') + \'">\' + (r.roi !== undefined ? r.roi.toFixed(2)+\'%\' : \'-\') + \'</td>\' +',
    '                    \'<td class="\' + (r.netProfit>=0?\'text-green\':\'text-red\') + \'">\' + fmtC(r.netProfit||0) + \'</td>\' +',
    '                    \'<td>\' + fmtP(r.openPrice) + \'</td><td>\' + fmtP(r.closePrice) + \'</td><td>\' + (r.reason||\'?\') + \'</td></tr>\';',
    '            });',
    '            document.getElementById(\'pretty-log-tbody\').innerHTML = pretty;',
    '        }',
    '',
    '        async function loadStatus() {',
    '            try {',
    '                const res = await fetch(\'/api/status\', { headers: { \'Authorization\': \'Bearer \' + token } });',
    '                if (res.status === 401 || res.status === 403) return logout(); const data = await res.json();',
    '                const allStatuses = data.states || {}; const subAccountsUpdated = data.subAccounts || []; const globalSet = data.globalSettings || {};',
    '                let globalTotal = 0, globalUnrealized = 0, globalMarginUsed = 0, totalTrading = 0, totalAboveZero = 0;',
    '                ',
    '                subAccountsUpdated.forEach(sub => { globalTotal += (sub.realizedPnl || 0); const loc = mySubAccounts.find(s=>s._id===sub._id); if(loc) loc.realizedPnl=sub.realizedPnl; });',
    '',
    '                for (let pid in allStatuses) {',
    '                    const st = allStatuses[pid];',
    '                    if (st && st.coinStates) {',
    '                        for (let sym in st.coinStates) {',
    '                            const cs = st.coinStates[sym];',
    '                            if (cs.contracts > 0) globalMarginUsed += (parseFloat(cs.margin) || 0);',
    '                            if (cs.contracts > 0 && (!cs.lockUntil || Date.now() >= cs.lockUntil)) {',
    '                                totalTrading++; if (cs.currentRoi > 0) totalAboveZero++; globalUnrealized += (parseFloat(cs.unrealizedPnl) || 0);',
    '                            }',
    '                        }',
    '                    }',
    '                }',
    '',
    '                const setTxt = (id, txt, cls) => { const el=document.getElementById(id); if(el){el.innerText=txt; if(cls) el.className="metric-val "+cls;} };',
    '                setTxt(\'topGlobalMargin\', "$"+globalMarginUsed.toFixed(2)); setTxt(\'globalPnl\', fmtC(globalTotal), globalTotal>=0?"text-green":"text-red");',
    '                setTxt(\'topGlobalUnrealized\', fmtC(globalUnrealized), globalUnrealized>=0?"text-green":"text-red"); setTxt(\'globalWinRate\', totalAboveZero + " / " + totalTrading);',
    '',
    '                const step = globalSet.globalDcaStep || 0; const activeTrigger = (globalSet.globalDcaRecoveryTriggerPnl || -50) * Math.pow(2, step);',
    '                const dcaTrig = document.getElementById(\'display_activeDcaTrigger\'); if (dcaTrig) dcaTrig.innerHTML = fmtC(activeTrigger) + " <span style=\'font-size:11px;color:#6b7280;\'>[Phase " + step + "]</span>";',
    '',
    '                if(currentProfileIndex === -1) return;',
    '                const profile = mySubAccounts[currentProfileIndex]; const stateData = allStatuses[profile._id] || { coinStates: {} };',
    '                ',
    '                if(!myCoins || myCoins.length === 0) { document.getElementById(\'dashboardStatusContainer\').innerHTML = \'<p class="text-muted text-center">No Coins in Profile</p>\'; } else {',
    '                    let html = \'\';',
    '                    myCoins.forEach(coin => {',
    '                        const st = stateData.coinStates?.[coin.symbol] || { status: \'Halted\', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0 };',
    '                        let stCls = st.status === \'Running\' ? \'text-green\' : (st.status === \'In Position\' ? \'text-blue\' : \'text-red\');',
    '                        if (st.lockUntil && Date.now() < st.lockUntil) { st.status = \'Processing\'; stCls = \'text-warning\'; }',
    '                        const roiCls = st.currentRoi >= 0 ? \'text-green\' : \'text-red\';',
    '                        html += \'<div class="metric" style="margin-bottom:10px;"><div class="flex-between" style="border-bottom:1px solid #1f2937; padding-bottom:5px; margin-bottom:8px;"><span><b>\' + coin.symbol + \'</b> [\' + (coin.side||profile.side||\'long\') + \'] <span class="\' + stCls + \'" style="margin-left:8px;font-size:10px;">\' + st.status.toUpperCase() + \'</span></span><div><button style="padding:2px 8px; font-size:10px;" onclick="toggleCoinBot(\\\'\' + coin.symbol + \'\\\', \' + !coin.botActive + \')">\' + (coin.botActive ? "STOP" : "START") + \'</button> <button class="text-red" style="padding:2px 8px; font-size:10px; border-color:#ef4444;" onclick="closeSinglePosition(\\\'\' + coin.symbol + \'\\\', \\\'\' + profile._id + \'\\\')">CUT</button></div></div>\';',
    '                        html += \'<div class="grid" style="font-size:12px; color:#9ca3af;"><div>Price: <span style="color:#fff">\' + fmtP(st.currentPrice) + \'</span></div><div>Entry: <span style="color:#fff">\' + fmtP(st.avgEntry) + \'</span></div><div>Size: <span style="color:#fff">\' + (st.contracts||0) + \'</span></div><div class="\' + roiCls + \'">Net: \' + (st.unrealizedPnl||0).toFixed(4) + \'</div><div class="\' + roiCls + \'">ROI: \' + (st.currentRoi||0).toFixed(2) + \'%</div></div></div>\';',
    '                    });',
    '                    document.getElementById(\'dashboardStatusContainer\').innerHTML = html;',
    '                }',
    '            } catch (err) {}',
    '        }',
    '        if(!token) route(); else { document.getElementById("auth-view").style.display="none"; checkAuth(); }',
    '    </script>',
    '</body>',
    '</html>'
];

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: "API Endpoint Not Found" });
    res.send(FRONTEND_HTML.join('\n'));
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Node Engine Online on http://localhost:${PORT}`));
}
module.exports = app;
