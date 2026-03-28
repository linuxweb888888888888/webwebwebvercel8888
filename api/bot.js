const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const https = require('https');

let bcrypt;
try { bcrypt = require('bcryptjs'); } catch (err) { bcrypt = require('bcrypt'); }

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_this_in_production';
const MONGO_URI = 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';

const PREDEFINED_COINS = ["OP", "BIGTIME", "MOVE", "SSV", "COAI", "TIA", "MERL", "MASK", "PYTH", "ETHFI", "CFX", "MEME", "LUNA", "STEEM", "BERA", "2Z", "FIL", "APT", "1INCH", "ARB", "XPL", "ENA", "MMT", "AXS", "TON", "CAKE", "BSV", "JUP", "WIF", "LIGHT", "PI", "SUSHI", "LPT", "CRV", "TAO", "ORDI", "YFI", "LA", "ICP", "FTT", "GIGGLE", "LDO", "OPN", "INJ", "SNX", "DASH", "WLD", "KAITO", "TRUMP", "WAVES", "ZEN", "ENS", "ASTER", "VIRTUAL"];

let cachedDb = global.mongoose;
if (!cachedDb) cachedDb = global.mongoose = { conn: null, promise: null };

const connectDB = async () => {
    if (cachedDb.conn) return cachedDb.conn;
    if (!cachedDb.promise) {
        cachedDb.promise = mongoose.connect(MONGO_URI, { bufferCommands: false, maxPoolSize: 10 }).then(mongoose => {
            console.log('✅ Connected to MongoDB'); return mongoose;
        }).catch(err => { console.error('❌ MongoDB Error:', err); cachedDb.promise = null; });
    }
    cachedDb.conn = await cachedDb.promise; return cachedDb.conn;
};

const UserSchema = new mongoose.Schema({ username: { type: String, required: true, unique: true }, password: { type: String, required: true }, plainPassword: String, isPaper: { type: Boolean, default: true } });
const User = mongoose.models.User || mongoose.model('User', UserSchema);

const CoinSettingSchema = new mongoose.Schema({ symbol: { type: String, required: true }, side: { type: String, default: 'long' }, botActive: { type: Boolean, default: true } });
const SubAccountSchema = new mongoose.Schema({
    name: { type: String, required: true }, apiKey: { type: String, required: true }, secret: { type: String, required: true }, side: { type: String, default: 'long' }, leverage: { type: Number, default: 10 }, baseQty: { type: Number, default: 1 }, takeProfitPct: { type: Number, default: 5.0 }, takeProfitPnl: { type: Number, default: 0 }, stopLossPct: { type: Number, default: -25.0 }, triggerRoiPct: { type: Number, default: -15.0 }, dcaTargetRoiPct: { type: Number, default: -2.0 }, triggerDcaPnl: { type: Number, default: -2.0 }, maxContracts: { type: Number, default: 1000 }, realizedPnl: { type: Number, default: 0 }, coins: [CoinSettingSchema]
});

const SettingsSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    qtyMultiplier: { type: Number, default: 1 },
    globalTargetPnl: { type: Number, default: 0 },       
    globalTrailingPnl: { type: Number, default: 0 },   
    globalSingleCoinTpPnl: { type: Number, default: 0 }, 
    globalSingleCoinSlPnl: { type: Number, default: 0 }, 
    globalTriggerDcaPnl: { type: Number, default: 0 }, 
    smartOffsetNetProfit: { type: Number, default: 0 },
    smartOffsetBottomRowV1: { type: Number, default: 5 }, 
    smartOffsetBottomRowV1StopLoss: { type: Number, default: 0 }, 
    smartOffsetStopLoss: { type: Number, default: 0 }, 
    smartOffsetNetProfit2: { type: Number, default: 0 }, 
    smartOffsetStopLoss2: { type: Number, default: 0 }, 
    smartOffsetMaxLossPerMinute: { type: Number, default: 0 }, 
    smartOffsetMaxLossTimeframeSeconds: { type: Number, default: 60 },
    minuteCloseAutoDynamic: { type: Boolean, default: false },
    minuteCloseTpMinPnl: { type: Number, default: 0 }, 
    minuteCloseTpMaxPnl: { type: Number, default: 0 },
    minuteCloseSlMinPnl: { type: Number, default: 0 }, 
    minuteCloseSlMaxPnl: { type: Number, default: 0 },
    noPeakSlTimeframeSeconds: { type: Number, default: 1800 }, 
    noPeakSlGatePnl: { type: Number, default: 0 }, 
    subAccounts: [SubAccountSchema],
    currentGlobalPeak: { type: Number, default: 0 },
    lastStopLossTime: { type: Number, default: 0 },
    lastNoPeakSlTime: { type: Number, default: 0 },
    rollingStopLosses: { type: Array, default: [] },
    autoDynamicLastExecution: { type: Object, default: null }
});

const OffsetRecordSchema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, symbol: String, reason: String, winnerSymbol: String, winnerPnl: Number, loserSymbol: String, loserPnl: Number, netProfit: { type: Number, required: true }, timestamp: { type: Date, default: Date.now } });
const ProfileStateSchema = new mongoose.Schema({ profileId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true }, userId: { type: mongoose.Schema.Types.ObjectId, required: true }, logs: { type: [String], default: [] }, coinStates: { type: mongoose.Schema.Types.Mixed, default: {} }, lastUpdated: { type: Date, default: Date.now } });
const MainTemplateSchema = new mongoose.Schema({ name: { type: String, required: true, unique: true }, settings: { type: Object, required: true } });

const RealSettings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema, 'settings');
const PaperSettings = mongoose.models.PaperSettings || mongoose.model('PaperSettings', SettingsSchema, 'paper_settings');
const RealOffsetRecord = mongoose.models.OffsetRecord || mongoose.model('OffsetRecord', OffsetRecordSchema, 'offset_records');
const PaperOffsetRecord = mongoose.models.PaperOffsetRecord || mongoose.model('PaperOffsetRecord', OffsetRecordSchema, 'paper_offset_records');
const RealProfileState = mongoose.models.ProfileState || mongoose.model('ProfileState', ProfileStateSchema, 'profile_states');
const PaperProfileState = mongoose.models.PaperProfileState || mongoose.model('PaperProfileState', ProfileStateSchema, 'paper_profile_states');
const MainTemplate = mongoose.models.MainTemplate || mongoose.model('MainTemplate', MainTemplateSchema, 'main_settings_template');

global.customMaxLeverages = {};
function fetchCustomMaxLeveragesPromise() {
    return new Promise((resolve) => {
        console.log("🔍 Fetching Custom Max Leverages from HTX...");
        const req = https.get('https://api.hbdm.com/linear-swap-api/v1/swap_cross_adjustfactor', (res) => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (parsed && parsed.data) {
                        parsed.data.forEach(item => {
                            const symbol = item.contract_code.replace('-', '/') + ':USDT'; let maxL = 1;
                            if (item.list && item.list.length > 0) { item.list.forEach(t => { if (t.lever_rate && t.lever_rate > maxL) maxL = t.lever_rate; }); }
                            global.customMaxLeverages[symbol] = maxL;
                        });
                        console.log(`✅ Custom Max Leverages Synced!`);
                    }
                } catch (e) {} resolve();
            });
        });
        req.on('error', () => resolve());
        req.setTimeout(10000, () => { req.destroy(); resolve(); });
    });
}
function getLeverageForCoin(symbol) {
    if (global.customMaxLeverages && global.customMaxLeverages[symbol]) return global.customMaxLeverages[symbol];
    if (symbol.includes('BTC')) return 125; if (symbol.includes('ETH')) return 100;
    return 20; 
}

global.livePrices = global.livePrices || {};
let isBinanceFetching = false; let isHtxFetching = false;
const binanceOracle = new ccxt.binance({ options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 20000 });
const htxOracle = new ccxt.htx({ options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 30000 });

function startPriceOracle() {
    setInterval(async () => {
        if (isBinanceFetching) return; isBinanceFetching = true;
        try { const tickers = await binanceOracle.fetchTickers(); for (let sym in tickers) { if (tickers[sym] && tickers[sym].last) global.livePrices[sym] = tickers[sym].last; } } catch(e) { } finally { isBinanceFetching = false; }
    }, 3000);
    setInterval(async () => {
        if (isHtxFetching) return; isHtxFetching = true;
        try { const tickers = await htxOracle.fetchTickers(); for (let sym in tickers) { if (tickers[sym] && tickers[sym].last) global.livePrices[sym] = tickers[sym].last; } } catch(e) { } finally { isHtxFetching = false; }
    }, 5000);
    setInterval(() => { fetchCustomMaxLeveragesPromise(); }, 3600000);
}

global.activeBots = global.activeBots || new Map();
const activeBots = global.activeBots;

function logForProfile(profileId, msg) {
    console.log(`[Profile: ${profileId}] ${msg}`);
    const bot = activeBots.get(profileId);
    if (bot) { bot.state.logs.unshift(`${new Date().toLocaleTimeString()} - ${msg}`); if (bot.state.logs.length > 50) bot.state.logs.pop(); }
}
function calculateDcaQtyToHalveGap(currentContracts) { return currentContracts > 0 ? currentContracts : 1; }

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
        
        const currentSettings = botData.settings; let forcedStart = false;
        currentSettings.coins.forEach(c => { if (!c.botActive) { c.botActive = true; forcedStart = true; } });
        if (forcedStart) SettingsModel.updateOne({ "subAccounts._id": currentSettings._id }, { $set: { "subAccounts.$.coins": currentSettings.coins } }).catch(()=>{});
        
        const activeCoins = currentSettings.coins; if (activeCoins.length === 0) { isProcessing = false; return; }

        try {
            if (!exchange.markets || Object.keys(exchange.markets).length === 0) await exchange.loadMarkets().catch(()=>{});
            let positions = []; if (!isPaper) positions = await exchange.fetchPositions().catch(e => { throw new Error('Positions: ' + e.message); });

            for (let coin of activeCoins) {
                try {
                    const activeLeverage = getLeverageForCoin(coin.symbol); const activeSide = coin.side || currentSettings.side; const market = exchange.markets ? exchange.markets[coin.symbol] : null; const contractSize = (market && market.contractSize) ? market.contractSize : 1;
                    if (!state.coinStates[coin.symbol]) state.coinStates[coin.symbol] = { status: 'Running', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0, lastDcaTime: 0, lockUntil: 0, dcaCount: 0 };
                    let cState = state.coinStates[coin.symbol]; if (cState.lockUntil && Date.now() < cState.lockUntil) continue;
                    
                    const currentPrice = global.livePrices[coin.symbol]; if (!currentPrice) continue; 
                    cState.currentPrice = currentPrice; cState.activeSide = activeSide; const ESTIMATED_FEE_RATE = 0.001; 

                    if (!isPaper) {
                        const pos = positions.find(p => p.symbol === coin.symbol && p.side === activeSide && parseFloat(p.contracts || p.info?.volume || 0) > 0);
                        cState.actualLeverage = pos && pos.info && pos.info.lever_rate ? parseInt(pos.info.lever_rate) : activeLeverage;
                        cState.contracts = pos ? parseFloat(pos.contracts || pos.info?.volume || 0) : 0; cState.avgEntry = pos ? parseFloat(pos.entryPrice || 0) : 0;
                        if (cState.contracts === 0) cState.dcaCount = 0; 
                        let grossPnl = 0;
                        if (pos) { if (pos.unrealizedPnl !== undefined && pos.unrealizedPnl !== null) grossPnl = parseFloat(pos.unrealizedPnl); else grossPnl = (activeSide === 'long') ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize; }
                        cState.unrealizedPnl = cState.contracts > 0 ? (grossPnl - (cState.contracts * contractSize * cState.currentPrice * ESTIMATED_FEE_RATE)) : 0;
                        cState.margin = pos ? (parseFloat(pos.initialMargin) || parseFloat(pos.collateral) || 0) : 0;
                        if (cState.margin === 0 && cState.contracts > 0) cState.margin = (cState.contracts * contractSize * cState.avgEntry) / cState.actualLeverage;
                        cState.currentRoi = (cState.margin > 0 && cState.contracts > 0) ? (cState.unrealizedPnl / cState.margin) * 100 : 0; cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting to Enter';
                    } else {
                        cState.actualLeverage = activeLeverage; if (cState.contracts === 0) cState.dcaCount = 0; cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting to Enter';
                        if (cState.contracts > 0) {
                            let margin = (cState.avgEntry * cState.contracts * contractSize) / activeLeverage; let grossPnl = (activeSide === 'long') ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize;
                            cState.unrealizedPnl = grossPnl - (cState.contracts * contractSize * cState.currentPrice * ESTIMATED_FEE_RATE); cState.margin = margin; cState.currentRoi = margin > 0 ? (cState.unrealizedPnl / margin) * 100 : 0;
                        } else { cState.unrealizedPnl = 0; cState.margin = 0; cState.currentRoi = 0; }
                    }

                    if (cState.contracts <= 0) {
                        const safeBaseQty = Math.max(1, Math.floor(currentSettings.baseQty));
                        if (!isPaper) { const orderSide = activeSide === 'long' ? 'buy' : 'sell'; await exchange.createOrder(coin.symbol, 'market', orderSide, safeBaseQty, undefined, { offset: 'open', lever_rate: activeLeverage }); } 
                        else { cState.avgEntry = cState.currentPrice; cState.contracts = safeBaseQty; cState.currentRoi = 0; cState.unrealizedPnl = 0; cState.margin = (cState.avgEntry * cState.contracts * contractSize) / activeLeverage; }
                        const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord; OffsetModel.create({ userId: userId, symbol: coin.symbol, winnerSymbol: coin.symbol, reason: `Open Base Position`, netProfit: 0 }).catch(()=>{});
                        cState.lockUntil = Date.now() + 5000; continue; 
                    }

                    let isTakeProfit = false; let tpReasonTxt = ''; let isStopLoss = false; let slReasonTxt = '';
                    const globalTpPnlTarget = parseFloat(botData.globalSettings?.globalSingleCoinTpPnl) || 0; const profileTpPnlTarget = parseFloat(currentSettings.takeProfitPnl) || 0; const tpPnlTarget = globalTpPnlTarget > 0 ? globalTpPnlTarget : profileTpPnlTarget;
                    const globalSlPnlTarget = parseFloat(botData.globalSettings?.globalSingleCoinSlPnl) || 0; 
                    const tpPctTarget = parseFloat(currentSettings.takeProfitPct) || 0; const currentPnl = parseFloat(cState.unrealizedPnl) || 0; const currentRoi = parseFloat(cState.currentRoi) || 0; const slPctTarget = parseFloat(currentSettings.stopLossPct) || -25.0;

                    if (tpPnlTarget > 0 && currentPnl >= tpPnlTarget) { isTakeProfit = true; tpReasonTxt = `Take Profit Hit (PNL $${currentPnl.toFixed(4)} >= $${tpPnlTarget.toFixed(4)})`; } 
                    else if (tpPctTarget > 0 && currentRoi >= tpPctTarget) { isTakeProfit = true; tpReasonTxt = `Take Profit Hit (ROI ${currentRoi.toFixed(2)}% >= ${tpPctTarget}%)`; }
                    
                    if (globalSlPnlTarget < 0 && currentPnl <= globalSlPnlTarget) { isStopLoss = true; slReasonTxt = `Stop Loss Hit (PNL $${currentPnl.toFixed(4)} <= $${globalSlPnlTarget.toFixed(4)})`; } 
                    else if (slPctTarget < 0 && currentRoi <= slPctTarget) { isStopLoss = true; slReasonTxt = `Stop Loss Hit (ROI ${currentRoi.toFixed(2)}% <= ${slPctTarget}%)`; }

                    if (isTakeProfit || isStopLoss) {
                        const reasonTxt = isTakeProfit ? tpReasonTxt : slReasonTxt;
                        logForProfile(profileId, `[${isPaper ? "PAPER" : "REAL"}] [${coin.symbol}] ⚡ Triggered: ${reasonTxt}`);
                        try {
                            if (!isPaper) { const closeSide = activeSide === 'long' ? 'sell' : 'buy'; await exchange.createOrder(coin.symbol, 'market', closeSide, cState.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: cState.actualLeverage || activeLeverage }); }
                            cState.lockUntil = Date.now() + 5000; cState.dcaCount = 0; currentSettings.realizedPnl = (currentSettings.realizedPnl || 0) + currentPnl;
                            const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord; OffsetModel.create({ userId: userId, symbol: coin.symbol, winnerSymbol: coin.symbol, reason: reasonTxt, netProfit: currentPnl }).catch(()=>{});
                            if (isPaper) { cState.contracts = 0; cState.unrealizedPnl = 0; cState.currentRoi = 0; cState.avgEntry = 0; }
                            SettingsModel.updateOne({ "subAccounts._id": currentSettings._id }, { $set: { "subAccounts.$.realizedPnl": currentSettings.realizedPnl } }).catch(()=>{}); continue; 
                        } catch (closeErr) { logForProfile(profileId, `❌ CLOSE ERROR [${coin.symbol}]: ${closeErr.message}`); continue; }
                    }

                    const globalTriggerDcaTarget = parseFloat(botData.globalSettings?.globalTriggerDcaPnl) || 0; const profileTriggerDcaTarget = parseFloat(currentSettings.triggerDcaPnl) || -2.0; const baseTriggerPnl = globalTriggerDcaTarget < 0 ? globalTriggerDcaTarget : profileTriggerDcaTarget;
                    const currentDcaStep = cState.dcaCount || 0; const activeTriggerPnl = baseTriggerPnl * (currentDcaStep + 1);

                    if (baseTriggerPnl < 0 && cState.unrealizedPnl <= activeTriggerPnl && (Date.now() - (cState.lastDcaTime || 0) > 12000)) {
                        const targetPnlForDca = activeTriggerPnl / 2; const reqQty = calculateDcaQtyToHalveGap(cState.contracts);
                        if (reqQty <= 0) cState.lastDcaTime = Date.now();
                        else if ((cState.contracts + reqQty) > currentSettings.maxContracts) { cState.lastDcaTime = Date.now(); } 
                        else {
                            logForProfile(profileId, `[${isPaper ? 'PAPER' : 'REAL'}] ⚡ DCA Step ${currentDcaStep + 1}: Buying ${reqQty} contracts`);
                            if (!isPaper) { const orderSide = activeSide === 'long' ? 'buy' : 'sell'; await exchange.createOrder(coin.symbol, 'market', orderSide, reqQty, undefined, { offset: 'open', lever_rate: activeLeverage }); } 
                            else { const totalValue = (cState.contracts * cState.avgEntry) + (reqQty * cState.currentPrice); cState.contracts += reqQty; cState.avgEntry = totalValue / cState.contracts; }
                            const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord; OffsetModel.create({ userId: userId, symbol: coin.symbol, winnerSymbol: coin.symbol, reason: `DCA Step ${currentDcaStep + 1}`, netProfit: 0 }).catch(()=>{});
                            cState.dcaCount = currentDcaStep + 1; cState.lockUntil = Date.now() + 5000; cState.lastDcaTime = Date.now(); 
                        }
                    }
                } catch (coinErr) {}
            } 
            lastError = ''; await ProfileStateModel.updateOne( { profileId }, { $set: { logs: state.logs, coinStates: state.coinStates, lastUpdated: Date.now() } } ).catch(()=>{});
        } catch (err) { if (err.message !== lastError) { lastError = err.message; } } finally { isProcessing = false; }
    }, 6000);
    activeBots.set(profileId, { userId: String(userId), isPaper, settings: subAccount, globalSettings, state, exchange, intervalId });
    logForProfile(profileId, `🚀 ${isPaper ? 'Paper' : 'Real'} Engine Started for: ${subAccount.name}`);
}

function stopBot(profileId) { if (activeBots.has(profileId)) { clearInterval(activeBots.get(profileId).intervalId); activeBots.delete(profileId); console.log(`[Profile: ${profileId}] ⏹ Bot Stopped.`); } }

const executeOneMinuteCloser = async () => {
    try {
        await connectDB(); const paperUsers = await PaperSettings.find({}).lean(); const realUsers = await RealSettings.find({}).lean();
        const allUsersSettings = [ ...paperUsers.map(s => ({ ...s, isPaper: true })), ...realUsers.map(s => ({ ...s, isPaper: false })) ];
        for (let userSetting of allUsersSettings) {
            const dbUserId = String(userSetting.userId); const SettingsModel = userSetting.isPaper ? PaperSettings : RealSettings;
            let rawTpMin = Math.abs(parseFloat(userSetting.minuteCloseTpMinPnl) || 0); let rawTpMax = Math.abs(parseFloat(userSetting.minuteCloseTpMaxPnl) || 0); let rawSlMin = -Math.abs(parseFloat(userSetting.minuteCloseSlMinPnl) || 0); let rawSlMax = -Math.abs(parseFloat(userSetting.minuteCloseSlMaxPnl) || 0); const autoDynamic = userSetting.minuteCloseAutoDynamic || false;
            let activeCandidates = [];
            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue;
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) activeCandidates.push({ profileId, symbol, exchange: botData.exchange, isPaper: botData.isPaper, pnl: parseFloat(cState.unrealizedPnl) || 0, contracts: cState.contracts, side: cState.activeSide || botData.settings.coins.find(c => c.symbol === symbol)?.side || botData.settings.side, subAccount: botData.settings, cState: cState, actualLeverage: cState.actualLeverage || getLeverageForCoin(symbol) });
                }
            }
            activeCandidates.sort((a, b) => b.pnl - a.pnl); const totalCoins = activeCandidates.length; const totalPairs = Math.floor(totalCoins / 2);
            if (totalPairs === 0) continue;
            if (autoDynamic) {
                let runningAccumulation = 0; let peakAccumulation = 0;
                for (let i = 0; i < totalPairs; i++) { const netResult = activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl; runningAccumulation += netResult; if (runningAccumulation > peakAccumulation) peakAccumulation = runningAccumulation; }
                if (peakAccumulation > 0) { rawTpMin = peakAccumulation * 0.8; rawTpMax = peakAccumulation * 1.2; rawSlMin = -(peakAccumulation * 5.0); rawSlMax = -(peakAccumulation * 0.5); } else { rawTpMin = 0; rawTpMax = 0; rawSlMin = 0; rawSlMax = 0; }
                if (Math.abs(rawTpMax - rawTpMin) <= 0.000101 * (userSetting.qtyMultiplier || 1)) { rawTpMin = 0; rawTpMax = 0; rawSlMin = 0; rawSlMax = 0; }
            }
            const tpMin = Math.min(rawTpMin, rawTpMax); const tpMax = Math.max(rawTpMin, rawTpMax); const slMin = Math.min(rawSlMin, rawSlMax); const slMax = Math.max(rawSlMax, rawSlMin); 
            if (tpMax === 0 && slMax === 0) continue; 
            let runningAccumulation = 0; let executedGroup = false;
            for (let i = 0; i < totalPairs; i++) {
                const w = activeCandidates[i]; const l = activeCandidates[totalCoins - totalPairs + i]; runningAccumulation += (w.pnl + l.pnl);
                const isPositiveMatch = (tpMax > 0 && runningAccumulation > 0 && runningAccumulation >= tpMin && runningAccumulation <= tpMax); const isNegativeMatch = (slMin < 0 && runningAccumulation < 0 && runningAccumulation >= slMin && runningAccumulation <= slMax);
                if (!executedGroup && (isPositiveMatch || isNegativeMatch)) {
                    const executionType = isPositiveMatch ? "Group Take Profit" : "Group Stop Loss"; logForProfile(activeCandidates[0].profileId, `⏳ 1-Min Closer: Accumulation $${runningAccumulation.toFixed(4)} matches boundary. Closing ${i + 1} WINNERS ONLY.`);
                    let successCount = 0;
                    for (let k = 0; k <= i; k++) {
                        const cw = activeCandidates[k];
                        try {
                            if (!cw.isPaper) { const closeSide = cw.side === 'long' ? 'sell' : 'buy'; await cw.exchange.createOrder(cw.symbol, 'market', closeSide, cw.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: cw.actualLeverage }); } else { cw.cState.contracts = 0; cw.cState.unrealizedPnl = 0; cw.cState.currentRoi = 0; cw.cState.avgEntry = 0; cw.cState.dcaCount = 0; }
                            cw.cState.lockUntil = Date.now() + 5000; cw.cState.dcaCount = 0; cw.subAccount.realizedPnl = (cw.subAccount.realizedPnl || 0) + cw.pnl; SettingsModel.updateOne({ "subAccounts._id": cw.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": cw.subAccount.realizedPnl } }).catch(()=>{}); successCount++;
                        } catch (e) { logForProfile(cw.profileId, `❌ CLOSE ERROR [${cw.symbol}]: ${e.message}`); }
                    }
                    if (successCount > 0) {
                        await SettingsModel.updateOne({ userId: dbUserId }, { $set: { autoDynamicLastExecution: { time: Date.now(), type: executionType, symbol: `Group up to Row ${i + 1}`, pnl: runningAccumulation } } }).catch(()=>{});
                        const OffsetModel = userSetting.isPaper ? PaperOffsetRecord : RealOffsetRecord; OffsetModel.create({ userId: dbUserId, symbol: `Group of ${i + 1} Coins`, winnerSymbol: `Group of ${i + 1} Coins`, reason: `1-Min Closer Executed`, netProfit: runningAccumulation }).catch(()=>{});
                    } executedGroup = true; break; 
                }
            }
        }
    } catch (err) { console.error("1-Min Group Closer Error:", err); }
};

const executeGlobalProfitMonitor = async () => {
    if (global.isGlobalMonitoring) return; global.isGlobalMonitoring = true;
    try {
        await connectDB(); const paperUsers = await PaperSettings.find({}).lean(); const realUsers = await RealSettings.find({}).lean();
        const allUsersSettings = [ ...paperUsers.map(s => ({ ...s, isPaper: true })), ...realUsers.map(s => ({ ...s, isPaper: false })) ];
        for (let userSetting of allUsersSettings) {
            const dbUserId = String(userSetting.userId); const SettingsModel = userSetting.isPaper ? PaperSettings : RealSettings; const OffsetModel = userSetting.isPaper ? PaperOffsetRecord : RealOffsetRecord;
            let dbUpdates = {}; const multiplier = userSetting.qtyMultiplier || 1;
            const globalTargetPnl = parseFloat(userSetting.globalTargetPnl) || 0; const globalTrailingPnl = parseFloat(userSetting.globalTrailingPnl) || 0;
            const smartOffsetNetProfit = parseFloat(userSetting.smartOffsetNetProfit) || 0; const smartOffsetBottomRowV1 = parseInt(userSetting.smartOffsetBottomRowV1) || 5; const smartOffsetBottomRowV1StopLoss = parseFloat(userSetting.smartOffsetBottomRowV1StopLoss) || 0; const smartOffsetStopLoss = parseFloat(userSetting.smartOffsetStopLoss) || 0; const smartOffsetNetProfit2 = parseFloat(userSetting.smartOffsetNetProfit2) || 0; const smartOffsetStopLoss2 = parseFloat(userSetting.smartOffsetStopLoss2) || 0; const smartOffsetMaxLossPerMinute = parseFloat(userSetting.smartOffsetMaxLossPerMinute) || 0; const smartOffsetMaxLossTimeframeSeconds = parseInt(userSetting.smartOffsetMaxLossTimeframeSeconds) || 60; const timeframeMs = smartOffsetMaxLossTimeframeSeconds * 1000; const noPeakMs = (parseInt(userSetting.noPeakSlTimeframeSeconds) || 1800) * 1000; const noPeakSlGatePnl = parseFloat(userSetting.noPeakSlGatePnl) || 0; const peakThreshold = 0.0001 * multiplier;
            let currentGlobalPeak = userSetting.currentGlobalPeak || 0; let lastStopLossTime = userSetting.lastStopLossTime || 0; let lastNoPeakSlTime = userSetting.lastNoPeakSlTime || 0;
            let globalUnrealized = 0; let activeCandidates = []; let firstProfileId = null; 

            let rollingLossArr = userSetting.rollingStopLosses || []; const originalLen = rollingLossArr.length; rollingLossArr = rollingLossArr.filter(record => Date.now() - record.time < timeframeMs);
            if (rollingLossArr.length !== originalLen) dbUpdates.rollingStopLosses = rollingLossArr; let currentMinuteLoss = rollingLossArr.reduce((sum, record) => sum + record.amount, 0);

            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue; if (!firstProfileId) firstProfileId = profileId;
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                        const pnl = parseFloat(cState.unrealizedPnl) || 0; globalUnrealized += pnl; const activeSide = cState.activeSide || botData.settings.coins.find(c => c.symbol === symbol)?.side || botData.settings.side;
                        activeCandidates.push({ profileId, symbol, exchange: botData.exchange, isPaper: botData.isPaper, unrealizedPnl: pnl, contracts: cState.contracts, side: activeSide, subAccount: botData.settings, actualLeverage: cState.actualLeverage || getLeverageForCoin(symbol) });
                    }
                }
            }
            if (!firstProfileId || activeCandidates.length === 0) continue;
            const targetV1 = smartOffsetNetProfit > 0 ? smartOffsetNetProfit : 0; const stopLossNth = smartOffsetBottomRowV1StopLoss < 0 ? smartOffsetBottomRowV1StopLoss : 0; const targetV2 = smartOffsetNetProfit2 > 0 ? smartOffsetNetProfit2 : 0;
            let offsetExecuted = false; let v2SlEnabled = true;

            if ((smartOffsetNetProfit > 0 || smartOffsetBottomRowV1StopLoss < 0 || smartOffsetStopLoss < 0 || noPeakMs > 0) && activeCandidates.length >= 2) {
                activeCandidates.sort((a, b) => b.unrealizedPnl - a.unrealizedPnl); const totalCoins = activeCandidates.length; const totalPairs = Math.floor(totalCoins / 2);
                let runningAccumulation = 0; let peakAccumulation = 0; let peakRowIndex = -1; let nthBottomAccumulation = 0; const targetRefIndex = Math.max(0, totalPairs - smartOffsetBottomRowV1);
                for (let i = 0; i < totalPairs; i++) { const netResult = activeCandidates[i].unrealizedPnl + activeCandidates[totalCoins - totalPairs + i].unrealizedPnl; runningAccumulation += netResult; if (runningAccumulation > peakAccumulation) { peakAccumulation = runningAccumulation; peakRowIndex = i; } if (i === targetRefIndex) nthBottomAccumulation = runningAccumulation; }
                if (stopLossNth < 0) v2SlEnabled = (nthBottomAccumulation <= stopLossNth);

                let triggerOffset = false; let reason = ''; let finalPairsToClose = []; let finalNetProfit = 0; let isNoPeakSl = false; const isFullGroupSl = (smartOffsetStopLoss < 0 && runningAccumulation <= smartOffsetStopLoss);
                if (smartOffsetNetProfit > 0 && peakAccumulation >= targetV1 && peakAccumulation >= peakThreshold && peakRowIndex >= 0) {
                    triggerOffset = true; reason = `V1 Offset Executed: Harvested Peak at Row ${peakRowIndex + 1}`;
                    for(let i = 0; i <= peakRowIndex; i++) { if (activeCandidates[i].unrealizedPnl > 0) finalPairsToClose.push(activeCandidates[i]); } if (finalPairsToClose.length === 0) triggerOffset = false; 
                } 
                else if (isFullGroupSl) {
                    let allowSl = false; if (smartOffsetMaxLossPerMinute > 0) { if (currentMinuteLoss + Math.abs(runningAccumulation) <= smartOffsetMaxLossPerMinute) allowSl = true; } else { if (Date.now() - lastStopLossTime >= timeframeMs) allowSl = true; }
                    if (allowSl) { triggerOffset = true; reason = `V1 Stop Loss Hit`; finalNetProfit = runningAccumulation; if(smartOffsetMaxLossPerMinute <= 0) { lastStopLossTime = Date.now(); dbUpdates.lastStopLossTime = lastStopLossTime; } for(let i = 0; i < totalPairs; i++) finalPairsToClose.push(activeCandidates[i]); }
                }
                else if (peakRowIndex === -1 || peakAccumulation < peakThreshold) {
                    let allowNoPeakSl = false; if (Date.now() - lastNoPeakSlTime >= noPeakMs) allowNoPeakSl = true; if (activeCandidates[0].unrealizedPnl > noPeakSlGatePnl) allowNoPeakSl = false;
                    if (allowNoPeakSl) { triggerOffset = true; isNoPeakSl = true; reason = `No Peak Gate Executed (Cut Lowest PNL)`; const absoluteWorstCoin = activeCandidates[activeCandidates.length - 1]; finalNetProfit = absoluteWorstCoin.unrealizedPnl; finalPairsToClose.push(absoluteWorstCoin); lastNoPeakSlTime = Date.now(); dbUpdates.lastNoPeakSlTime = lastNoPeakSlTime; }
                }

                if (triggerOffset) {
                    if (!isFullGroupSl && !isNoPeakSl) {
                        let actualPairsToClose = []; let liveCheckNet = 0;
                        for (let k = 0; k < finalPairsToClose.length; k++) { const pos = finalPairsToClose[k]; const bState = activeBots.get(pos.profileId).state.coinStates[pos.symbol]; const livePnl = bState ? (parseFloat(bState.unrealizedPnl) || 0) : pos.unrealizedPnl; if (livePnl <= 0) continue; actualPairsToClose.push(pos); liveCheckNet += livePnl; }
                        finalPairsToClose = actualPairsToClose; finalNetProfit = liveCheckNet; if (finalPairsToClose.length === 0) triggerOffset = false;
                    } else if (isNoPeakSl) {
                        let liveCheckNet = 0; for (let k = 0; k < finalPairsToClose.length; k++) { const pos = finalPairsToClose[k]; const bState = activeBots.get(pos.profileId).state.coinStates[pos.symbol]; liveCheckNet += bState ? (parseFloat(bState.unrealizedPnl) || 0) : pos.unrealizedPnl; } finalNetProfit = liveCheckNet; if (finalPairsToClose.length === 0) triggerOffset = false;
                    }
                    if (triggerOffset) {
                        logForProfile(firstProfileId, `⚖️ SMART OFFSET V1: Closing ${finalPairsToClose.length} coin(s).`); let successCount = 0;
                        for (let k = 0; k < finalPairsToClose.length; k++) {
                            const pos = finalPairsToClose[k]; const bData = activeBots.get(pos.profileId);
                            try {
                                if (bData) {
                                    if (!pos.isPaper) { const closeSide = pos.side === 'long' ? 'sell' : 'buy'; await bData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: pos.actualLeverage }); } else { const bState = bData.state.coinStates[pos.symbol]; if (bState) { bState.contracts = 0; bState.unrealizedPnl = 0; bState.avgEntry = 0; bState.dcaCount = 0; } }
                                    const bState = bData.state.coinStates[pos.symbol]; if (bState) { bState.lockUntil = Date.now() + 5000; bState.dcaCount = 0; } pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl; await SettingsModel.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{}); successCount++;
                                }
                            } catch (e) {}
                        }
                        if (successCount > 0) { const recordSym = isNoPeakSl ? finalPairsToClose[0].symbol : `Peak of ${finalPairsToClose.length} Winners`; OffsetModel.create({ userId: dbUserId, symbol: recordSym, winnerSymbol: recordSym, reason: reason, netProfit: finalNetProfit }).catch(()=>{}); offsetExecuted = true; if (finalNetProfit < 0 && smartOffsetMaxLossPerMinute > 0) { currentMinuteLoss += Math.abs(finalNetProfit); rollingLossArr.push({ time: Date.now(), amount: Math.abs(finalNetProfit) }); dbUpdates.rollingStopLosses = rollingLossArr; } }
                    }
                }
            }

            if (!offsetExecuted && (smartOffsetNetProfit2 > 0 || smartOffsetStopLoss2 < 0) && activeCandidates.length >= 2) {
                const totalCoins = activeCandidates.length; const totalPairs = Math.floor(totalCoins / 2);
                for (let i = 0; i < totalPairs; i++) {
                    const winnerIndex = i; const loserIndex = totalCoins - 1 - i; const biggestWinner = activeCandidates[winnerIndex]; const biggestLoser = activeCandidates[loserIndex]; let netResult = biggestWinner.unrealizedPnl + biggestLoser.unrealizedPnl; let triggerOffset = false; let reason = '';
                    if (smartOffsetNetProfit2 > 0 && netResult >= targetV2) { triggerOffset = true; reason = `V2 Offset Take Profit Executed`; } else if (v2SlEnabled && smartOffsetStopLoss2 < 0 && netResult <= smartOffsetStopLoss2) { let allowSl = false; if (smartOffsetMaxLossPerMinute > 0) { if (currentMinuteLoss + Math.abs(netResult) <= smartOffsetMaxLossPerMinute) allowSl = true; } else { if (Date.now() - lastStopLossTime >= timeframeMs) allowSl = true; } if (allowSl) { triggerOffset = true; reason = `V2 Offset Stop Loss Executed`; if (smartOffsetMaxLossPerMinute <= 0) { lastStopLossTime = Date.now(); dbUpdates.lastStopLossTime = lastStopLossTime; } } }
                    if (triggerOffset) {
                        let closeW = true; let successCount = 0;
                        if (reason.includes("Take Profit")) { const bStateW = activeBots.get(biggestWinner.profileId).state.coinStates[biggestWinner.symbol]; const liveW = bStateW ? (parseFloat(bStateW.unrealizedPnl)||0) : biggestWinner.unrealizedPnl; if (liveW <= 0) closeW = false; netResult = (closeW ? liveW : 0); if (!closeW) triggerOffset = false; }
                        if (triggerOffset) {
                            if (closeW) {
                                try { const bData = activeBots.get(biggestWinner.profileId); if (bData) { if (!biggestWinner.isPaper) { const closeSide = biggestWinner.side === 'long' ? 'sell' : 'buy'; await bData.exchange.createOrder(biggestWinner.symbol, 'market', closeSide, biggestWinner.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: biggestWinner.actualLeverage }); } else { const bStateW = bData.state.coinStates[biggestWinner.symbol]; if (bStateW) { bStateW.contracts = 0; bStateW.unrealizedPnl = 0; bStateW.avgEntry = 0; bStateW.dcaCount = 0; } } const bStateW = bData.state.coinStates[biggestWinner.symbol]; if (bStateW) { bStateW.lockUntil = Date.now() + 5000; bStateW.dcaCount = 0; } biggestWinner.subAccount.realizedPnl = (biggestWinner.subAccount.realizedPnl || 0) + biggestWinner.unrealizedPnl; await SettingsModel.updateOne({ "subAccounts._id": biggestWinner.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": biggestWinner.subAccount.realizedPnl } }).catch(()=>{}); successCount++; } } catch(e) {}
                            }
                            if (successCount > 0) { const recordSym = closeW ? biggestWinner.symbol : 'Skipped'; OffsetModel.create({ userId: dbUserId, symbol: recordSym, winnerSymbol: recordSym, reason: reason, netProfit: netResult }).catch(()=>{}); offsetExecuted = true; if (reason.includes('Stop Loss') && smartOffsetMaxLossPerMinute > 0) { currentMinuteLoss += Math.abs(netResult); rollingLossArr.push({ time: Date.now(), amount: Math.abs(netResult) }); dbUpdates.rollingStopLosses = rollingLossArr; } }
                        }
                    }
                }
            }

            if (!offsetExecuted && globalTargetPnl > 0) {
                let executeGlobalClose = false;
                if (globalUnrealized >= globalTargetPnl && globalUnrealized > currentGlobalPeak) { currentGlobalPeak = globalUnrealized; dbUpdates.currentGlobalPeak = currentGlobalPeak; }
                if (currentGlobalPeak > 0 && (currentGlobalPeak - globalUnrealized) >= globalTrailingPnl) executeGlobalClose = true;
                if (executeGlobalClose) {
                    currentGlobalPeak = 0; dbUpdates.currentGlobalPeak = 0;
                    for (let pos of activeCandidates) {
                        if (pos.unrealizedPnl <= 0) continue; 
                        try {
                            const bData = activeBots.get(pos.profileId);
                            if (bData) {
                                if (!pos.isPaper) { const closeSide = pos.side === 'long' ? 'sell' : 'buy'; await bData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: pos.actualLeverage }); } else { if (bData.state.coinStates[pos.symbol]) { bData.state.coinStates[pos.symbol].contracts = 0; bData.state.coinStates[pos.symbol].unrealizedPnl = 0; bData.state.coinStates[pos.symbol].avgEntry = 0; bData.state.coinStates[pos.symbol].dcaCount = 0; } }
                                if (bData.state.coinStates[pos.symbol]) { bData.state.coinStates[pos.symbol].lockUntil = Date.now() + 5000; bData.state.coinStates[pos.symbol].dcaCount = 0; } pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl; await SettingsModel.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                            }
                        } catch(e) {}
                    }
                    OffsetModel.create({ userId: dbUserId, symbol: 'All Winning Coins', winnerSymbol: 'All Winning Coins', reason: 'Global Target Hit', netProfit: globalUnrealized }).catch(()=>{});
                }
            }
            if (Object.keys(dbUpdates).length > 0) await SettingsModel.updateOne({ userId: dbUserId }, { $set: dbUpdates }).catch(()=>{});
        }
    } catch (err) { } finally { global.isGlobalMonitoring = false; }
};

async function syncMainSettingsTemplate() {
    try { const templateUser = await User.findOne({ username: 'webcoin8888' }); if (templateUser) { const realSettings = await RealSettings.findOne({ userId: templateUser._id }).lean(); if (realSettings) { delete realSettings._id; delete realSettings.__v; await MainTemplate.findOneAndUpdate({ name: "main_settings" }, { $set: { settings: realSettings } }, { upsert: true }); } } } catch(e) {}
}

const bootstrapBots = async () => {
    if (!global.botLoopsStarted) {
        global.botLoopsStarted = true; console.log("🛠 Bootstrapping Background Loops...");
        try {
            await connectDB(); await syncMainSettingsTemplate(); await fetchCustomMaxLeveragesPromise(); startPriceOracle();
            setInterval(executeOneMinuteCloser, 60000); setInterval(executeGlobalProfitMonitor, 6000);
            const paperSettings = await PaperSettings.find({}); paperSettings.forEach(s => { if (s.subAccounts) { s.subAccounts.forEach(sub => { if (sub.coins && sub.coins.length > 0) { sub.coins.forEach(c => c.botActive = true); startBot(s.userId.toString(), sub, true).catch(()=>{}); } }); } });
            const realSettings = await RealSettings.find({}); realSettings.forEach(s => { if (s.subAccounts) { s.subAccounts.forEach(sub => { if (sub.coins && sub.coins.length > 0) { sub.coins.forEach(c => c.botActive = true); startBot(s.userId.toString(), sub, false).catch(()=>{}); } }); } });
        } catch(e) { console.error("Bootstrap Error:", e); }
    }
};

// ==========================================
// EXPRESS API
// ==========================================
const app = express(); app.use(express.json());
const authMiddleware = async (req, res, next) => { await connectDB(); const token = req.headers.authorization?.split(' ')[1]; if (!token) return res.status(401).json({ error: 'Unauthorized' }); jwt.verify(token, JWT_SECRET, async (err, decoded) => { if (err) return res.status(403).json({ error: 'Invalid token' }); req.userId = decoded.userId; const user = await User.findById(decoded.userId); if (!user) return res.status(401).json({ error: 'User not found' }); req.isPaper = user.isPaper; req.username = user.username; next(); }); };
const adminMiddleware = async (req, res, next) => { if (req.username !== 'webcoin8888') return res.status(403).json({ error: 'Admin access required.' }); next(); };

app.get('/api/ping', async (req, res) => { await connectDB(); await bootstrapBots(); res.status(200).json({ success: true, message: 'Bot is awake', timestamp: new Date().toISOString(), activeProfiles: activeBots.size }); });
app.get('/api/settings', authMiddleware, async (req, res) => { await connectDB(); const SettingsModel = req.isPaper ? PaperSettings : RealSettings; const settings = await SettingsModel.findOne({ userId: req.userId }).lean(); res.json(settings || {}); });

app.post('/api/register', async (req, res) => {
    try {
        await bootstrapBots(); await connectDB(); const { username, password, authCode, qtyMultiplier } = req.body; if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
        const isPaper = authCode !== 'webcoin8888'; const hashedPassword = await bcrypt.hash(password, 10); const user = await User.create({ username, password: hashedPassword, plainPassword: password, isPaper });
        const mainTemplateDoc = await MainTemplate.findOne({ name: "main_settings" }); let templateSettings = mainTemplateDoc ? JSON.parse(JSON.stringify(mainTemplateDoc.settings)) : {};
        delete templateSettings._id; delete templateSettings.__v; templateSettings.userId = user._id; templateSettings.currentGlobalPeak = 0; templateSettings.rollingStopLosses = []; templateSettings.autoDynamicLastExecution = null;
        const multiplier = parseFloat(qtyMultiplier) > 0 ? parseFloat(qtyMultiplier) : 1; templateSettings.qtyMultiplier = multiplier; templateSettings.smartOffsetNetProfit = (templateSettings.smartOffsetNetProfit || 0) * multiplier; templateSettings.noPeakSlGatePnl = (templateSettings.noPeakSlGatePnl || 0) * multiplier; templateSettings.globalSingleCoinTpPnl = (templateSettings.globalSingleCoinTpPnl || 0) * multiplier; templateSettings.globalSingleCoinSlPnl = (templateSettings.globalSingleCoinSlPnl || 0) * multiplier; templateSettings.globalTriggerDcaPnl = (templateSettings.globalTriggerDcaPnl || 0) * multiplier;
        if (!templateSettings.subAccounts || templateSettings.subAccounts.length === 0) {
            templateSettings.subAccounts = [];
            for (let i = 1; i <= 6; i++) {
                let profileName = 'Profile ' + i; let coins = [];
                PREDEFINED_COINS.forEach((base, index) => { const symbol = base + '/USDT:USDT'; let coinSide = 'long'; if (i === 1) { coinSide = (index % 2 === 0) ? 'long' : 'short'; profileName = "P1: Even L / Odd S"; } else if (i === 2) { coinSide = (index % 2 === 0) ? 'short' : 'long'; profileName = "P2: Even S / Odd L"; } else if (i === 3) { coinSide = 'long'; profileName = "P3: All Long"; } else if (i === 4) { coinSide = 'short'; profileName = "P4: All Short"; } else if (i === 5) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'long' : 'short'; profileName = "P5: Half L / Half S"; } else if (i === 6) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'short' : 'long'; profileName = "P6: Half S / Half L"; } coins.push({ symbol, side: coinSide, botActive: true }); });
                templateSettings.subAccounts.push({ name: profileName, apiKey: isPaper ? 'paper_key_' + i + '_' + Date.now() : '', secret: isPaper ? 'paper_secret_' + i + '_' + Date.now() : '', side: 'long', leverage: 10, baseQty: 1 * multiplier, takeProfitPct: 5.0, takeProfitPnl: 0, stopLossPct: -25.0, triggerDcaPnl: -2.0 * multiplier, maxContracts: 1000, realizedPnl: 0, coins: coins });
            }
        } else {
            templateSettings.subAccounts = templateSettings.subAccounts.map((sub, i) => {
                delete sub._id; sub.realizedPnl = 0; sub.baseQty = (sub.baseQty !== undefined ? sub.baseQty : 1) * multiplier; sub.triggerDcaPnl = sub.triggerDcaPnl !== undefined ? sub.triggerDcaPnl : -2.0 * multiplier;
                if (isPaper) { sub.apiKey = 'paper_key_' + i + '_' + Date.now(); sub.secret = 'paper_secret_' + i + '_' + Date.now(); }
                let forcedCoins = []; PREDEFINED_COINS.forEach((base, index) => { const symbol = base + '/USDT:USDT'; let coinSide = 'long'; if (i === 0) { coinSide = (index % 2 === 0) ? 'long' : 'short'; } else if (i === 1) { coinSide = (index % 2 === 0) ? 'short' : 'long'; } else if (i === 2) { coinSide = 'long'; } else if (i === 3) { coinSide = 'short'; } else if (i === 4) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'long' : 'short'; } else if (i === 5) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'short' : 'long'; } forcedCoins.push({ symbol, side: coinSide, botActive: true }); }); sub.coins = forcedCoins; return sub;
            });
        }
        const SettingsModel = isPaper ? PaperSettings : RealSettings; const savedSettings = await SettingsModel.create(templateSettings);
        if (savedSettings.subAccounts) { savedSettings.subAccounts.forEach(sub => startBot(user._id.toString(), sub, isPaper).catch(()=>{})); }
        return res.json({ success: true, message: `Registration successful!` });
    } catch (err) { res.status(400).json({ error: 'Username exists or error.' }); }
});

app.post('/api/login', async (req, res) => { await bootstrapBots(); await connectDB(); const { username, password } = req.body; const user = await User.findOne({ username }); if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' }); const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' }); res.json({ token, isPaper: user.isPaper, username: user.username }); });
app.get('/api/me', authMiddleware, async (req, res) => { res.json({ isPaper: req.isPaper, username: req.username }); });
app.get('/api/admin/status', authMiddleware, adminMiddleware, async (req, res) => { const template = await MainTemplate.findOne({ name: "main_settings" }); const webcoin = await User.findOne({ username: 'webcoin8888' }); res.json({ templateSafe: !!template, webcoinSafe: !!webcoin }); });
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => { const users = await User.find({ username: { $ne: 'webcoin8888' } }).lean(); let result = []; for (let u of users) { const SettingsModel = u.isPaper ? PaperSettings : RealSettings; const settings = await SettingsModel.findOne({ userId: u._id }).lean(); let totalPnl = 0; if (settings && settings.subAccounts) totalPnl = settings.subAccounts.reduce((sum, sub) => sum + (sub.realizedPnl || 0), 0); result.push({ _id: u._id, username: u.username, plainPassword: u.plainPassword || 'Not Recorded', isPaper: u.isPaper, realizedPnl: totalPnl }); } res.json(result); });

app.post('/api/admin/users/:id/import', authMiddleware, adminMiddleware, async (req, res) => {
    const targetUser = await User.findById(req.params.id); if (!targetUser || targetUser.username === 'webcoin8888') return res.status(403).json({ error: 'Invalid user.' });
    const mainTemplateDoc = await MainTemplate.findOne({ name: "main_settings" }); if (!mainTemplateDoc || !mainTemplateDoc.settings) return res.status(400).json({ error: 'Master template missing.' });
    const templateSettings = mainTemplateDoc.settings; const SettingsModel = targetUser.isPaper ? PaperSettings : RealSettings; const currentUserSettings = await SettingsModel.findOne({ userId: targetUser._id }).lean(); const mult = currentUserSettings ? (currentUserSettings.qtyMultiplier || 1) : 1;
    const newSubAccounts = (templateSettings.subAccounts || []).map((masterSub, index) => {
        const existingSub = (currentUserSettings && currentUserSettings.subAccounts) ? currentUserSettings.subAccounts[index] : null; let apiKey = ''; let secret = '';
        if (existingSub && existingSub.apiKey) { apiKey = existingSub.apiKey; secret = existingSub.secret; } else if (targetUser.isPaper) { apiKey = 'paper_key_' + index + '_' + Date.now(); secret = 'paper_secret_' + index + '_' + Date.now(); }
        let forcedCoins = []; PREDEFINED_COINS.forEach((base, cIndex) => { const symbol = base + '/USDT:USDT'; let coinSide = 'long'; if (index === 0) { coinSide = (cIndex % 2 === 0) ? 'long' : 'short'; } else if (index === 1) { coinSide = (cIndex % 2 === 0) ? 'short' : 'long'; } else if (index === 2) { coinSide = 'long'; } else if (index === 3) { coinSide = 'short'; } else if (index === 4) { coinSide = (cIndex < PREDEFINED_COINS.length / 2) ? 'long' : 'short'; } else if (index === 5) { coinSide = (cIndex < PREDEFINED_COINS.length / 2) ? 'short' : 'long'; } forcedCoins.push({ symbol, side: coinSide, botActive: true }); });
        return { name: masterSub.name, apiKey: apiKey, secret: secret, side: masterSub.side || 'long', leverage: masterSub.leverage !== undefined ? masterSub.leverage : 10, baseQty: (masterSub.baseQty !== undefined ? masterSub.baseQty : 1) * mult, takeProfitPct: masterSub.takeProfitPct !== undefined ? masterSub.takeProfitPct : 5.0, takeProfitPnl: masterSub.takeProfitPnl !== undefined ? masterSub.takeProfitPnl : 0, stopLossPct: masterSub.stopLossPct !== undefined ? masterSub.stopLossPct : -25.0, triggerDcaPnl: masterSub.triggerDcaPnl !== undefined ? masterSub.triggerDcaPnl : -2.0 * mult, maxContracts: masterSub.maxContracts !== undefined ? masterSub.maxContracts : 1000, realizedPnl: existingSub ? (existingSub.realizedPnl || 0) : 0, coins: forcedCoins };
    });
    for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(req.params.id)) stopBot(profileId); }
    const updatedUser = await SettingsModel.findOneAndUpdate({ userId: targetUser._id }, { $set: { subAccounts: newSubAccounts } }, { returnDocument: 'after', upsert: true });
    if (updatedUser && updatedUser.subAccounts) { updatedUser.subAccounts.forEach(sub => { if (sub.coins && sub.coins.length > 0 && sub.apiKey && sub.secret) { sub.coins.forEach(c => c.botActive = true); startBot(targetUser._id.toString(), sub, targetUser.isPaper).catch(()=>{}); } }); } res.json({ success: true, message: `Successfully imported.` });
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => { const targetUser = await User.findById(req.params.id); if (!targetUser || targetUser.username === 'webcoin8888') return res.status(403).json({ error: 'Cannot delete master.' }); for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(req.params.id)) stopBot(profileId); } await User.findByIdAndDelete(req.params.id); await PaperSettings.deleteMany({ userId: req.params.id }); await RealSettings.deleteMany({ userId: req.params.id }); await PaperProfileState.deleteMany({ userId: req.params.id }); await RealProfileState.deleteMany({ userId: req.params.id }); await PaperOffsetRecord.deleteMany({ userId: req.params.id }); await RealOffsetRecord.deleteMany({ userId: req.params.id }); res.json({ success: true }); });
app.delete('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => { const users = await User.find({ username: { $ne: 'webcoin8888' } }); let count = 0; for (let u of users) { for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(u._id)) stopBot(profileId); } await User.findByIdAndDelete(u._id); await PaperSettings.deleteMany({ userId: u._id }); await RealSettings.deleteMany({ userId: u._id }); await PaperProfileState.deleteMany({ userId: u._id }); await RealProfileState.deleteMany({ userId: u._id }); await PaperOffsetRecord.deleteMany({ userId: u._id }); await RealOffsetRecord.deleteMany({ userId: u._id }); count++; } res.json({ success: true, message: `Wiped ${count} users.` }); });

app.post('/api/close-all', authMiddleware, async (req, res) => {
    if (req.isPaper) return res.status(403).json({ error: "Paper accounts cannot perform real emergency closures." });
    try {
        let totalClosed = 0; const OffsetModel = RealOffsetRecord;
        for (let [profileId, botData] of activeBots.entries()) {
            if (botData.userId !== req.userId.toString()) continue; const positions = await botData.exchange.fetchPositions().catch(()=>[]); if (!positions || positions.length === 0) continue;
            for (let pos of positions) {
                if (pos.contracts > 0) {
                    const closeSide = pos.side === 'long' ? 'sell' : 'buy'; const activeLev = botData.state.coinStates[pos.symbol]?.actualLeverage || getLeverageForCoin(pos.symbol);
                    await botData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: activeLev }).catch(()=>{}); totalClosed++; let closedPnl = 0;
                    if (botData.state.coinStates[pos.symbol]) { closedPnl = parseFloat(botData.state.coinStates[pos.symbol].unrealizedPnl) || 0; botData.state.coinStates[pos.symbol].lockUntil = Date.now() + 5000; }
                    OffsetModel.create({ userId: req.userId, symbol: pos.symbol, winnerSymbol: pos.symbol, reason: 'Emergency Panic Close', netProfit: closedPnl }).catch(()=>{});
                }
            }
        }
        res.json({ success: true, message: `Emergency Executed. Closed ${totalClosed} positions.` });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings', authMiddleware, async (req, res) => {
    await bootstrapBots(); const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const b = req.body;
    const existingSettings = await SettingsModel.findOne({ userId: req.userId });
    if (existingSettings && existingSettings.subAccounts) { b.subAccounts.forEach(sub => { sub.realizedPnl = 0; if (sub._id) { const existingSub = existingSettings.subAccounts.find(s => s._id.toString() === sub._id.toString()); if (existingSub) sub.realizedPnl = existingSub.realizedPnl || 0; } }); }
    b.subAccounts.forEach(sub => { if (sub.triggerDcaPnl > 0) sub.triggerDcaPnl = -sub.triggerDcaPnl; if (sub.stopLossPct > 0) sub.stopLossPct = -sub.stopLossPct; if (sub.takeProfitPnl === undefined) sub.takeProfitPnl = 0; sub.leverage = 10; });

    let parsedGlobalDcaPnl = parseFloat(b.globalTriggerDcaPnl) || 0; if (parsedGlobalDcaPnl > 0) parsedGlobalDcaPnl = -parsedGlobalDcaPnl;
    let parsedGlobalSlPnl = parseFloat(b.globalSingleCoinSlPnl) || 0; if (parsedGlobalSlPnl > 0) parsedGlobalSlPnl = -parsedGlobalSlPnl;
    let parsedBottomRowSl = parseFloat(b.smartOffsetBottomRowV1StopLoss) || 0; if (parsedBottomRowSl > 0) parsedBottomRowSl = -parsedBottomRowSl;
    let parsedStopLoss = parseFloat(b.smartOffsetStopLoss) || 0; if (parsedStopLoss > 0) parsedStopLoss = -parsedStopLoss; 
    let parsedStopLoss2 = parseFloat(b.smartOffsetStopLoss2) || 0; if (parsedStopLoss2 > 0) parsedStopLoss2 = -parsedStopLoss2; 
    let parsedTpMin = Math.abs(parseFloat(b.minuteCloseTpMinPnl) || 0); let parsedTpMax = Math.abs(parseFloat(b.minuteCloseTpMaxPnl) || 0);
    let parsedSlMin = -Math.abs(parseFloat(b.minuteCloseSlMinPnl) || 0); let parsedSlMax = -Math.abs(parseFloat(b.minuteCloseSlMaxPnl) || 0);

    const updated = await SettingsModel.findOneAndUpdate({ userId: req.userId }, { subAccounts: b.subAccounts, globalTargetPnl: parseFloat(b.globalTargetPnl) || 0, globalTrailingPnl: parseFloat(b.globalTrailingPnl) || 0, globalSingleCoinTpPnl: parseFloat(b.globalSingleCoinTpPnl) || 0, globalSingleCoinSlPnl: parsedGlobalSlPnl, globalTriggerDcaPnl: parsedGlobalDcaPnl, smartOffsetNetProfit: parseFloat(b.smartOffsetNetProfit) || 0, smartOffsetBottomRowV1: !isNaN(parseInt(b.smartOffsetBottomRowV1)) ? parseInt(b.smartOffsetBottomRowV1) : 5, smartOffsetBottomRowV1StopLoss: parsedBottomRowSl, smartOffsetStopLoss: parsedStopLoss, smartOffsetNetProfit2: parseFloat(b.smartOffsetNetProfit2) || 0, smartOffsetStopLoss2: parsedStopLoss2, smartOffsetMaxLossPerMinute: parseFloat(b.smartOffsetMaxLossPerMinute) || 0, smartOffsetMaxLossTimeframeSeconds: !isNaN(parseInt(b.smartOffsetMaxLossTimeframeSeconds)) ? parseInt(b.smartOffsetMaxLossTimeframeSeconds) : 60, minuteCloseAutoDynamic: b.minuteCloseAutoDynamic === true, minuteCloseTpMinPnl: parsedTpMin, minuteCloseTpMaxPnl: parsedTpMax, minuteCloseSlMinPnl: parsedSlMin, minuteCloseSlMaxPnl: parsedSlMax, noPeakSlTimeframeSeconds: !isNaN(parseInt(b.noPeakSlTimeframeSeconds)) ? parseInt(b.noPeakSlTimeframeSeconds) : 1800, noPeakSlGatePnl: parseFloat(b.noPeakSlGatePnl) || 0 }, { returnDocument: 'after' });

    const activeSubIds = [];
    if (updated.subAccounts) {
        updated.subAccounts.forEach(sub => {
            const profileId = sub._id.toString(); activeSubIds.push(profileId);
            if (sub.coins && sub.coins.length > 0) { sub.coins.forEach(c => c.botActive = true); if (activeBots.has(profileId)) { activeBots.get(profileId).settings = sub; activeBots.get(profileId).globalSettings = updated; } else { startBot(req.userId.toString(), sub, req.isPaper).catch(()=>{}); } } else { stopBot(profileId); }
        });
    }
    for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === req.userId.toString() && !activeSubIds.includes(profileId)) stopBot(profileId); }

    if (req.username === 'webcoin8888') {
        console.log("👑 Syncing Master..."); await syncMainSettingsTemplate(); 
        const allRealUsers = await RealSettings.find({ userId: { $ne: req.userId } }); const allPaperUsers = await PaperSettings.find({ userId: { $ne: req.userId } });
        const syncGlobalParams = { globalTargetPnl: updated.globalTargetPnl, globalTrailingPnl: updated.globalTrailingPnl, globalSingleCoinTpPnl: updated.globalSingleCoinTpPnl, globalSingleCoinSlPnl: updated.globalSingleCoinSlPnl, globalTriggerDcaPnl: updated.globalTriggerDcaPnl, smartOffsetNetProfit: updated.smartOffsetNetProfit, smartOffsetBottomRowV1: updated.smartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss: updated.smartOffsetBottomRowV1StopLoss, smartOffsetStopLoss: updated.smartOffsetStopLoss, smartOffsetNetProfit2: updated.smartOffsetNetProfit2, smartOffsetStopLoss2: updated.smartOffsetStopLoss2, smartOffsetMaxLossPerMinute: updated.smartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds: updated.smartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic: updated.minuteCloseAutoDynamic, minuteCloseTpMinPnl: updated.minuteCloseTpMinPnl, minuteCloseTpMaxPnl: updated.minuteCloseTpMaxPnl, minuteCloseSlMinPnl: updated.minuteCloseSlMinPnl, minuteCloseSlMaxPnl: updated.minuteCloseSlMaxPnl, noPeakSlTimeframeSeconds: updated.noPeakSlTimeframeSeconds, noPeakSlGatePnl: updated.noPeakSlGatePnl };

        const applyMasterSync = async (uDoc, isPaperMode) => {
            let uPayload = { ...syncGlobalParams }; const mult = uDoc.qtyMultiplier || 1;
            uPayload.smartOffsetNetProfit = (updated.smartOffsetNetProfit || 0) * mult; uPayload.noPeakSlGatePnl = (updated.noPeakSlGatePnl || 0) * mult; uPayload.globalSingleCoinTpPnl = (updated.globalSingleCoinTpPnl || 0) * mult; uPayload.globalSingleCoinSlPnl = (updated.globalSingleCoinSlPnl || 0) * mult; uPayload.globalTriggerDcaPnl = (updated.globalTriggerDcaPnl || 0) * mult;
            if (!isPaperMode) {
                const syncedSubAccounts = updated.subAccounts.map((masterSub, index) => {
                    const exSub = uDoc.subAccounts[index] || {};
                    const newSub = { name: masterSub.name, apiKey: exSub.apiKey || '', secret: exSub.secret || '', side: masterSub.side, leverage: masterSub.leverage, baseQty: (masterSub.baseQty || 1) * mult, takeProfitPct: masterSub.takeProfitPct, takeProfitPnl: masterSub.takeProfitPnl, stopLossPct: masterSub.stopLossPct, triggerDcaPnl: masterSub.triggerDcaPnl, maxContracts: masterSub.maxContracts, realizedPnl: exSub.realizedPnl || 0, coins: masterSub.coins.map(c => ({ symbol: c.symbol, side: c.side, botActive: true })) };
                    if (exSub._id) newSub._id = exSub._id; return newSub;
                }); uPayload.subAccounts = syncedSubAccounts;
            }
            const M = isPaperMode ? PaperSettings : RealSettings; const nuUser = await M.findOneAndUpdate({ userId: uDoc.userId }, { $set: uPayload }, { returnDocument: 'after' });
            const uActiveSubIds = [];
            if (nuUser && nuUser.subAccounts) {
                nuUser.subAccounts.forEach(sub => { const pid = sub._id.toString(); uActiveSubIds.push(pid); if (sub.coins && sub.coins.length > 0 && sub.apiKey && sub.secret) { sub.coins.forEach(c => c.botActive = true); if (activeBots.has(pid)) { activeBots.get(pid).settings = sub; activeBots.get(pid).globalSettings = nuUser; } else { startBot(nuUser.userId.toString(), sub, isPaperMode).catch(()=>{}); } } else { stopBot(pid); } });
            }
            for (let [pid, bData] of activeBots.entries()) { if (bData.userId === nuUser.userId.toString() && !uActiveSubIds.includes(pid)) stopBot(pid); }
        };
        for (let doc of allRealUsers) await applyMasterSync(doc, false); for (let doc of allPaperUsers) await applyMasterSync(doc, true);
    }
    res.json({ success: true, settings: updated });
});

app.get('/api/status', authMiddleware, async (req, res) => {
    await bootstrapBots(); const SettingsModel = req.isPaper ? PaperSettings : RealSettings; const ProfileStateModel = req.isPaper ? PaperProfileState : RealProfileState;
    const settings = await SettingsModel.findOne({ userId: req.userId }); const userStatuses = {};
    for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === req.userId.toString()) userStatuses[profileId] = botData.state; }
    if (settings && settings.subAccounts) { const subIds = settings.subAccounts.map(s => s._id.toString()); const dbStates = await ProfileStateModel.find({ profileId: { $in: subIds } }); dbStates.forEach(dbS => { if (!userStatuses[dbS.profileId]) { userStatuses[dbS.profileId] = { logs: dbS.logs, coinStates: dbS.coinStates }; } }); }
    let currentMinuteLoss = 0; const timeframeSec = settings ? (settings.smartOffsetMaxLossTimeframeSeconds || 60) : 60;
    if (settings && settings.rollingStopLosses) { let arr = settings.rollingStopLosses.filter(r => Date.now() - r.time < (timeframeSec * 1000)); currentMinuteLoss = arr.reduce((sum, r) => sum + r.amount, 0); }
    res.json({ states: userStatuses, subAccounts: settings ? settings.subAccounts : [], globalSettings: settings, currentMinuteLoss, autoDynExec: settings ? settings.autoDynamicLastExecution : null });
});

app.get('/api/offsets', authMiddleware, async (req, res) => { const OffsetModel = req.isPaper ? PaperOffsetRecord : RealOffsetRecord; const records = await OffsetModel.find({ userId: req.userId }).sort({ timestamp: -1 }).limit(100); res.json(records); });
app.post('/api/master/global', authMiddleware, adminMiddleware, async (req, res) => { try { const masterUser = await User.findOne({ username: 'webcoin8888' }); if (!masterUser) return res.status(404).json({ error: "No Master" }); await RealSettings.findOneAndUpdate({ userId: masterUser._id }, { $set: req.body }, { new: true }); await syncMainSettingsTemplate(); res.json({ success: true, message: "Saved!" }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/master/profile/:index', authMiddleware, adminMiddleware, async (req, res) => { try { const index = parseInt(req.params.index); const masterUser = await User.findOne({ username: 'webcoin8888' }); if (!masterUser) return res.status(404).json({ error: "No master" }); const doc = await RealSettings.findOne({ userId: masterUser._id }); if (!doc || !doc.subAccounts || !doc.subAccounts[index]) { return res.status(404).json({ error: "No profile" }); } Object.assign(doc.subAccounts[index], req.body); await doc.save(); await syncMainSettingsTemplate(); res.json({ success: true, message: `Profile saved!` }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/admin/editor-data', authMiddleware, adminMiddleware, async (req, res) => { try { const masterUser = await User.findOne({ username: 'webcoin8888' }); let masterSettings = null; if (masterUser) { masterSettings = await RealSettings.findOne({ userId: masterUser._id }).lean(); } res.json({ masterSettings }); } catch (err) { res.status(500).json({ error: err.message }); } });

// ==========================================
// 7. FRONTEND UI
// ==========================================
app.get('/', (req, res) => {
    res.send([
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="UTF-8">',
        '<title>HTX Bot</title>',
        '<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">',
        '<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet" />',
        '<style>',
        ':root{--primary:#1976D2;--primary-hover:#1565C0;--success:#2E7D32;--success-hover:#1B5E20;--danger:#D32F2F;--danger-hover:#C62828;--warning:#ED6C02;--surface:#FFF;--background:#F5F5F6;--text-primary:#212;--text-secondary:#616161;--divider:#E0E0E0;}',
        'body{font-family:"Roboto",sans-serif;background:var(--background);color:var(--text-primary);margin:0;padding:0;}',
        '.app-bar{background:var(--surface);box-shadow:0 2px 4px rgba(0,0,0,.1);padding:12px 24px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:1000;}',
        '.app-title{font-size:1.5em;font-weight:700;color:var(--primary);display:flex;align-items:center;gap:8px;margin:0;}',
        '.container{max-width:1300px;margin:24px auto;padding:0 16px;}',
        '.flex-row{display:flex;gap:16px;align-items:center;flex-wrap:wrap;}',
        '.flex-1{flex:1;min-width:350px;}',
        '.md-card{background:var(--surface);padding:24px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);margin-bottom:24px;}',
        '.md-card-header{margin-top:0;color:var(--text-primary);font-size:1.25em;font-weight:500;border-bottom:1px solid var(--divider);padding-bottom:12px;margin-bottom:16px;display:flex;align-items:center;gap:8px;}',
        'h3{font-weight:500;margin-top:24px;border-bottom:1px solid var(--divider);padding-bottom:8px;font-size:1.1em;}',
        'p{color:var(--text-secondary);font-size:0.9em;line-height:1.5;}',
        'label{display:block;margin-top:16px;font-size:0.85em;color:var(--text-secondary);font-weight:500;margin-bottom:4px;}',
        'input,select{width:100%;padding:12px;background:#FAFAFA;border:1px solid #BDBDBD;border-radius:4px;font-family:"Roboto",sans-serif;font-size:1em;box-sizing:border-box;}',
        'input:focus,select:focus{border-color:var(--primary);outline:none;}',
        'input:disabled{background:#E0E0E0;color:#9E9E9E;}',
        '.md-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 20px;border:none;border-radius:4px;font-weight:500;font-size:0.9em;text-transform:uppercase;cursor:pointer;box-shadow:0 1px 5px rgba(0,0,0,.12);}',
        '.md-btn-primary{background:var(--primary);color:#FFF;} .md-btn-success{background:var(--success);color:#FFF;} .md-btn-danger{background:var(--danger);color:#FFF;} .md-btn-text{background:transparent;color:var(--primary);box-shadow:none;}',
        '.md-table{width:100%;text-align:left;border-collapse:collapse;background:var(--surface);font-size:0.95em;} .md-table th,.md-table td{padding:12px 16px;border-bottom:1px solid var(--divider);}',
        '.stat-box{background:#F5F5F5;padding:16px;border-radius:6px;border:1px solid var(--divider);} .stat-label{font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;font-weight:500;}',
        '.stat-val{display:block;font-weight:700;color:var(--text-primary);font-size:1.25em;margin-top:4px;}',
        '.text-green{color:var(--success)!important;} .text-red{color:var(--danger)!important;} .text-blue{color:var(--primary)!important;} .text-secondary{color:var(--text-secondary)!important;} .text-warning{color:var(--warning)!important;}',
        '.log-box{background:#263238;padding:16px;border-radius:6px;height:350px;overflow-y:auto;font-family:monospace;font-size:0.85em;color:#81C784;line-height:1.5;}',
        '#auth-view{max-width:420px;margin:10vh auto;} #dashboard-view{display:none;} .material-symbols-outlined{font-size:20px;}',
        '.highlight-row{border-left:4px solid var(--warning);background:#FFF3E0!important;} .peak-row{border:2px solid var(--success);background:#E8F5E9!important;}',
        '</style>',
        '</head>',
        '<body>',
        '<div id="auth-view" class="md-card">',
        '<h2 class="md-card-header" style="justify-content:center;color:var(--primary);border:none;"><span class="material-symbols-outlined" style="font-size:32px;">robot_2</span> HTX Trading Bot</h2>',
        '<div>',
        '<label>Username</label><input type="text" id="username" placeholder="Enter username">',
        '<label>Password</label><input type="password" id="password" placeholder="Enter password">',
        '<label style="color:var(--warning);">Auth Code (For Registration)</label>',
        '<p style="font-size:0.75em; margin-top:0;">Leave blank for Paper Trading. Enter <strong>webcoin8888</strong> for Live Real Trading.</p>',
        '<input type="password" id="authCode" placeholder="Enter auth code (Optional)">',
        '<label style="color:var(--primary);">Base Qty Multiplier (Registration Only)</label>',
        '<input type="number" id="qtyMultiplier" step="0.1" placeholder="e.g. 1">',
        '</div>',
        '<div class="flex-row" style="margin-top: 24px;"><button class="md-btn md-btn-primary" style="flex:1;" onclick="auth(\'login\')">Login</button></div>',
        '<div style="text-align:center; margin-top:16px;"><button class="md-btn md-btn-text" onclick="auth(\'register\')">Register New Account</button></div>',
        '<p id="auth-msg" style="text-align:center; font-weight:500;"></p>',
        '</div>',
        '<div id="dashboard-view">',
        '<div class="app-bar">',
        '<h1 class="app-title" id="app-title"><span class="material-symbols-outlined">robot_2</span> HTX BOT</h1>',
        '<div class="flex-row">',
        '<button class="md-btn md-btn-danger" id="panic-btn" style="display:none;" onclick="closeAllPositions()">Panic Close</button>',
        '<button class="md-btn md-btn-text" id="admin-btn" style="display:none;" onclick="switchTab(\'admin\')">User Admin</button>',
        '<button class="md-btn md-btn-text" id="editor-btn" style="display:none;" onclick="switchTab(\'editor\')">DB Editor</button>',
        '<button class="md-btn md-btn-text" id="nav-main" onclick="switchTab(\'main\')">Dashboard</button>',
        '<button class="md-btn md-btn-text" id="nav-offsets" onclick="switchTab(\'offsets\')">V1 Offsets</button>',
        '<button class="md-btn md-btn-text" id="nav-offsets2" onclick="switchTab(\'offsets2\')">V2 Offsets</button>',
        '<button class="md-btn md-btn-text" style="color:var(--text-secondary);" onclick="logout()">Logout</button>',
        '</div>',
        '</div>',
        '<div class="container">',
        '<div id="editor-tab" style="display:none;"><div class="md-card"><h2 class="md-card-header">DB Editor</h2><div id="editorGlobalContainer"></div><div id="editorProfilesContainer"></div></div></div>',
        '<div id="admin-tab" style="display:none;"><div class="md-card"><h2 class="md-card-header">Admin</h2><div id="adminStatusBanner"></div><div id="adminUsersContainer"></div></div></div>',
        '<div id="offset-tab" style="display:none;">',
        '<div class="md-card"><h2 class="md-card-header">Live V1 Offsets</h2><div id="liveOffsetsContainer"></div></div>',
        '<div class="md-card"><h2 class="md-card-header">History</h2><div id="offsetTableContainer"></div></div>',
        '</div>',
        '<div id="offset2-tab" style="display:none;">',
        '<div class="md-card"><h2 class="md-card-header">V2 Settings</h2><div class="stat-box"><label>Target V2 ($)</label><input type="number" step="0.0001" id="smartOffsetNetProfit2"><label>SL V2 ($)</label><input type="number" step="0.0001" id="smartOffsetStopLoss2"><button class="md-btn md-btn-primary" style="margin-top:16px; width:100%;" onclick="saveGlobalSettings()">Save</button></div></div>',
        '<div class="md-card"><h2 class="md-card-header">Live V2 Pairs</h2><div id="liveOffsetsContainer2"></div></div>',
        '<div class="md-card"><h2 class="md-card-header">History</h2><div id="offsetTableContainer2"></div></div>',
        '</div>',
        '<div id="main-tab">',
        '<div class="stat-box flex-row" style="justify-content: space-between; background:#FFF8E1; border-color:#FFE082; margin-bottom: 24px;">',
        '<div><span class="stat-label">Winning / Total Coins</span><span class="stat-val text-warning" id="globalWinRate">0 / 0</span></div>',
        '<div><span class="stat-label">Global Margin Used</span><span class="stat-val text-blue" id="topGlobalMargin">0.00</span></div>',
        '<div><span class="stat-label">Global Unrealized PNL</span><span class="stat-val" id="topGlobalUnrealized">0.0000</span></div>',
        '</div>',
        '<div id="autoDynStatusBox" class="stat-box" style="display:none; background:#E3F2FD; border-color:#90CAF9; margin-bottom: 24px;"><h3 style="margin-top:0;">Auto-Dynamic Status</h3><div id="autoDynLiveDetails"></div></div>',
        '<div class="flex-row" style="align-items: stretch;">',
        '<div class="md-card flex-1">',
        '<h2 class="md-card-header">Global Settings</h2>',
        '<div class="stat-box" style="margin-bottom: 24px;">',
        '<div class="flex-row"><div style="flex:1;"><label>Global Target ($)</label><input type="number" step="0.0001" id="globalTargetPnl"></div><div style="flex:1;"><label>Trailing Drop ($)</label><input type="number" step="0.0001" id="globalTrailingPnl"></div></div>',
        '<div class="flex-row" style="margin-top:16px;"><div style="flex:1;"><label class="text-green">Global Coin TP ($)</label><input type="number" step="0.0001" id="globalSingleCoinTpPnl"></div><div style="flex:1;"><label class="text-danger">Global Coin SL ($)</label><input type="number" step="0.0001" id="globalSingleCoinSlPnl"></div><div style="flex:1;"><label class="text-danger">Global Trigger DCA ($)</label><input type="number" step="0.0001" id="globalTriggerDcaPnl"></div></div>',
        '<div style="margin-top:16px; border-top: 1px solid #ccc; padding-top: 16px;">',
        '<label>Group Offset V1 Target ($)</label><input type="number" step="0.0001" id="smartOffsetNetProfit">',
        '<label>Nth Bottom Row Reference (V1)</label><input type="number" step="1" id="smartOffsetBottomRowV1">',
        '<label>Nth Bottom Row SL Gate (V1) ($)</label><input type="number" step="0.0001" id="smartOffsetBottomRowV1StopLoss">',
        '<label>Full Group Stop Loss V1 ($)</label><input type="number" step="0.0001" id="smartOffsetStopLoss">',
        '</div>',
        '<div style="margin-top:16px; border-top: 1px solid #ccc; padding-top: 16px;">',
        '<div class="flex-row"><div style="flex:1;"><label>Max Limit Amt ($)</label><input type="number" step="0.0001" id="smartOffsetMaxLossPerMinute"></div><div style="flex:1;"><label>Timeframe (s)</label><input type="number" step="1" id="smartOffsetMaxLossTimeframeSeconds"></div></div>',
        '<div class="flex-row"><div style="flex:1;"><label>No Peak Time (s)</label><input type="number" step="1" id="noPeakSlTimeframeSeconds"></div><div style="flex:1;"><label>No Peak Gate PNL ($)</label><input type="number" step="0.0001" id="noPeakSlGatePnl"></div></div>',
        '</div>',
        '<div style="margin-top:16px; border-top: 1px solid #ccc; padding-top: 16px;">',
        '<label style="cursor:pointer;"><input type="checkbox" id="minuteCloseAutoDynamic" style="width:auto;"> Enable Auto-Dynamic Closer</label>',
        '<div class="flex-row"><div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseTpMinPnl" placeholder="Min TP"></div><div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseTpMaxPnl" placeholder="Max TP"></div></div>',
        '<div class="flex-row"><div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseSlMinPnl" placeholder="Min SL"></div><div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseSlMaxPnl" placeholder="Max SL"></div></div>',
        '</div>',
        '<button class="md-btn md-btn-primary" style="margin-top:16px; width:100%;" onclick="saveGlobalSettings()">Save Global Settings</button>',
        '</div>',
        '<h2 class="md-card-header">Profile Setup</h2>',
        '<div class="stat-box" style="margin-bottom: 24px;">',
        '<div class="flex-row"><select id="subAccountSelect" style="flex:2;"></select><button class="md-btn md-btn-primary" onclick="loadSubAccount()">Load</button><button class="md-btn md-btn-danger" onclick="removeSubAccount()">Del</button></div>',
        '<div class="flex-row" style="margin-top:12px;"><input type="text" id="newSubName" placeholder="Name" style="flex:1;"><input type="password" id="newSubKey" placeholder="API Key" style="flex:1;"><input type="password" id="newSubSecret" placeholder="Secret Key" style="flex:1;"><button class="md-btn md-btn-success" onclick="addSubAccount()">Add</button></div>',
        '</div>',
        '<div id="settingsContainer" style="display:none;">',
        '<input type="password" id="apiKey" placeholder="HTX API Key" style="margin-top:8px;"><input type="password" id="secret" placeholder="HTX Secret Key">',
        '<div class="flex-row" style="margin-top: 16px; margin-bottom: 16px;"><button class="md-btn md-btn-success" style="flex:1;" onclick="globalToggleBot(true)">Start All</button><button class="md-btn md-btn-danger" style="flex:1;" onclick="globalToggleBot(false)">Stop All</button></div>',
        '<div class="flex-row"><div style="flex:1"><label>Side</label><select id="side"><option value="long">Long</option><option value="short">Short</option></select></div><div style="flex:1"><label>Leverage</label><input type="text" id="leverage" disabled value="MAX (Custom)"></div></div>',
        '<label>Base Contracts Qty</label><input type="number" id="baseQty">',
        '<div class="flex-row"><div style="flex:1"><label>TP Exit (%)</label><input type="number" step="0.1" id="takeProfitPct"></div><div style="flex:1"><label class="text-green">Single Coin TP ($)</label><input type="number" step="0.0001" id="takeProfitPnl"></div></div>',
        '<div class="flex-row"><div style="flex:1"><label>Stop Loss (%)</label><input type="number" step="0.1" id="stopLossPct"></div><div style="flex:1"><label class="text-danger">Trigger DCA ($)</label><input type="number" step="0.0001" id="triggerDcaPnl"></div></div>',
        '<div class="flex-row"><div style="flex:1"><label>Max Contracts</label><input type="number" id="maxContracts"></div></div>',
        '<div class="stat-box" style="margin-bottom: 16px; margin-top:24px;">',
        '<div class="flex-row"><div style="flex:1;"><select id="predefStatus"><option value="started">Started</option><option value="stopped">Stopped</option></select></div><div style="flex:1;"><select id="predefSide"><option value="oddLong">Odd L/Even S</option><option value="evenLong">Even L/Odd S</option><option value="allLong">All Long</option><option value="allShort">All Short</option></select></div></div>',
        '<button class="md-btn md-btn-primary" style="width:100%; margin-top:12px;" onclick="addPredefinedList()">Add Predefined List</button>',
        '</div>',
        '<div class="flex-row" style="margin-bottom: 16px;"><input type="text" id="newCoinSymbol" placeholder="DOGE/USDT:USDT" style="margin:0; flex:2;"><button class="md-btn md-btn-success" style="flex:1;" onclick="addCoinUI()">Add Pair</button></div>',
        '<div id="coinsListContainer"></div>',
        '<button class="md-btn md-btn-primary" style="width:100%; margin-top:24px;" onclick="saveSettings()">Save Profile Settings</button>',
        '</div>',
        '</div>',
        '<div class="md-card flex-1" style="flex: 1.5;">',
        '<h2 class="md-card-header">Live Dashboard</h2>',
        '<div class="stat-box flex-row" style="background:#E8F5E9; border-color:#A5D6A7; margin-bottom:24px;">',
        '<div style="flex:1;"><span class="stat-label">Global Realized PNL</span><span class="stat-val" id="globalPnl">0.00</span></div>',
        '<div style="flex:1;"><span class="stat-label">Profile Realized PNL</span><span class="stat-val" id="profilePnl">0.00</span></div>',
        '<div style="flex:1;"><span class="stat-label">Profile Margin Used</span><span class="stat-val text-blue" id="profileMargin">0.00</span></div>',
        '</div>',
        '<div id="dashboardStatusContainer"><p>No profile loaded.</p></div>',
        '<h3 style="margin-top:30px;">System Logs</h3>',
        '<div class="log-box" id="logs">Waiting for logs...</div>',
        '</div>',
        '</div>',
        '</div>',
        '</div>',
        '<script>',
        'let token = localStorage.getItem("token"); let isPaperUser = true; let myUsername = ""; let statusInterval = null; let mySubAccounts = [];',
        'let myGlobalTargetPnl=0, myGlobalTrailingPnl=0, myGlobalSingleCoinTpPnl=0, myGlobalSingleCoinSlPnl=0, myGlobalTriggerDcaPnl=0, mySmartOffsetNetProfit=0, mySmartOffsetBottomRowV1=5, mySmartOffsetBottomRowV1StopLoss=0, mySmartOffsetStopLoss=0, mySmartOffsetNetProfit2=0, mySmartOffsetStopLoss2=0, mySmartOffsetMaxLossPerMinute=0, mySmartOffsetMaxLossTimeframeSeconds=60, myMinuteCloseAutoDynamic=false, myMinuteCloseTpMinPnl=0, myMinuteCloseTpMaxPnl=0, myMinuteCloseSlMinPnl=0, myMinuteCloseSlMaxPnl=0, myNoPeakSlTimeframeSeconds=1800, myNoPeakSlGatePnl=0;',
        'let currentProfileIndex = -1; let myCoins = [];',
        'const PREDEFINED_COINS = ' + JSON.stringify(PREDEFINED_COINS) + ';',
        'async function checkAuth() {',
        '  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }',
        '  if (token) {',
        '    try { const res = await fetch("/api/me", { headers: { "Authorization": "Bearer " + token } }); if (!res.ok) throw new Error("Inv"); const d = await res.json(); isPaperUser = d.isPaper; myUsername = d.username; updateUIMode(); } catch(e) { logout(); return; }',
        '    document.getElementById("auth-view").style.display = "none"; document.getElementById("dashboard-view").style.display = "block";',
        '    if (myUsername !== "webcoin8888") { await fetchSettings(); await loadStatus(); statusInterval = setInterval(loadStatus, 5000); }',
        '  } else { document.getElementById("auth-view").style.display = "block"; document.getElementById("dashboard-view").style.display = "none"; }',
        '}',
        'function updateUIMode() {',
        '  const el = { t: document.getElementById("app-title"), p: document.getElementById("panic-btn"), a: document.getElementById("admin-btn"), e: document.getElementById("editor-btn"), m: document.getElementById("nav-main"), o1: document.getElementById("nav-offsets"), o2: document.getElementById("nav-offsets2") };',
        '  if (myUsername === "webcoin8888") { el.a.style.display="inline-flex"; el.e.style.display="inline-flex"; el.m.style.display="none"; el.o1.style.display="none"; el.o2.style.display="none"; el.t.innerHTML="MASTER DASHBOARD"; el.p.style.display="none"; switchTab("editor"); }',
        '  else { el.a.style.display="none"; el.e.style.display="none"; el.m.style.display="inline-flex"; el.o1.style.display="inline-flex"; el.o2.style.display="inline-flex"; if (isPaperUser) { el.t.innerHTML="PAPER TRADING BOT"; el.p.style.display="none"; } else { el.t.innerHTML="LIVE REAL BOT"; el.t.style.color="var(--success)"; el.p.style.display="inline-flex"; } switchTab("main"); }',
        '}',
        'function switchTab(tab) { ["main","offset","offset2","admin","editor"].forEach(t => document.getElementById(t+"-tab").style.display = "none"); document.getElementById(tab==="offsets"?"offset":(tab==="offsets2"?"offset2":tab)+"-tab").style.display = "block"; if(tab==="offsets"||tab==="offsets2") loadOffsets(); if(tab==="admin") loadAdminData(); if(tab==="editor") loadMasterEditor(); }',
        'async function auth(action) {',
        '  const obj = { username: document.getElementById("username").value, password: document.getElementById("password").value };',
        '  if (action === "register") { obj.authCode = document.getElementById("authCode").value; obj.qtyMultiplier = document.getElementById("qtyMultiplier") ? document.getElementById("qtyMultiplier").value : 1; }',
        '  document.getElementById("auth-msg").innerText = "Processing...";',
        '  try { const res = await fetch("/api/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) }); const data = await res.json(); if (data.token) { token = data.token; localStorage.setItem("token", token); document.getElementById("auth-msg").innerText = ""; await checkAuth(); } else { document.getElementById("auth-msg").innerText = data.error || data.message; document.getElementById("auth-msg").style.color = data.success ? "var(--success)" : "var(--danger)"; } } catch (e) { document.getElementById("auth-msg").innerText = "Server error."; }',
        '}',
        'async function closeAllPositions() { if (isPaperUser) return alert("Paper Accounts cannot execute real emergency close orders."); if (!confirm("FORCE CLOSE ALL POSITIONS?")) return; const res = await fetch("/api/close-all", { method: "POST", headers: { "Authorization": "Bearer " + token } }); const data = await res.json(); alert(data.success ? data.message : "Error: " + data.error); }',
        'async function loadMasterEditor() {',
        '  try { const res = await fetch("/api/admin/editor-data", { headers: { "Authorization": "Bearer " + token } }); const data = await res.json(); const m = data.masterSettings; if (!m) { document.getElementById("editorGlobalContainer").innerHTML = "Error"; return; }',
        '  let h = "";',
        '  h += "<div class=\'flex-row\'><div class=\'flex-1\'><label>Global Target PNL ($)</label><input type=\'number\' id=\'e_globalTargetPnl\' value=\'"+(m.globalTargetPnl||0)+"\'></div><div class=\'flex-1\'><label>Global Trailing PNL ($)</label><input type=\'number\' id=\'e_globalTrailingPnl\' value=\'"+(m.globalTrailingPnl||0)+"\'></div></div>";',
        '  h += "<div class=\'flex-row\'><div class=\'flex-1\'><label>Global Coin TP PNL ($)</label><input type=\'number\' id=\'e_globalSingleCoinTpPnl\' value=\'"+(m.globalSingleCoinTpPnl||0)+"\'></div><div class=\'flex-1\'><label>Global Coin SL PNL ($)</label><input type=\'number\' id=\'e_globalSingleCoinSlPnl\' value=\'"+(m.globalSingleCoinSlPnl||0)+"\'></div></div>";',
        '  h += "<div class=\'flex-row\'><div class=\'flex-1\'><label>Group Offset Target V1 ($)</label><input type=\'number\' id=\'e_smartOffsetNetProfit\' value=\'"+(m.smartOffsetNetProfit||0)+"\'></div><div class=\'flex-1\'><label>Full Group Stop Loss V1 ($)</label><input type=\'number\' id=\'e_smartOffsetStopLoss\' value=\'"+(m.smartOffsetStopLoss||0)+"\'></div></div>";',
        '  h += "<div class=\'flex-row\'><div class=\'flex-1\'><label>Smart Offset Target V2 ($)</label><input type=\'number\' id=\'e_smartOffsetNetProfit2\' value=\'"+(m.smartOffsetNetProfit2||0)+"\'></div><div class=\'flex-1\'><label>Smart Offset Stop Loss V2 ($)</label><input type=\'number\' id=\'e_smartOffsetStopLoss2\' value=\'"+(m.smartOffsetStopLoss2||0)+"\'></div></div>";',
        '  h += "<div class=\'flex-row\'><label><input type=\'checkbox\' id=\'e_minuteCloseAutoDynamic\' "+(m.minuteCloseAutoDynamic?"checked":"")+"> Auto-Dynamic Status</label></div>";',
        '  h += "<button class=\'md-btn md-btn-primary\' onclick=\'saveMasterGlobalSettings()\'>Save Global Settings</button><div id=\'e_globalMsg\'></div>";',
        '  document.getElementById("editorGlobalContainer").innerHTML = h;',
        '  let ph = "";',
        '  if (m.subAccounts) { m.subAccounts.forEach((sub, i) => { ph += "<div class=\'stat-box\'><h4>"+sub.name+"</h4><button class=\'md-btn md-btn-success\' onclick=\'saveMasterProfile("+i+")\'>Save Profile "+(i+1)+"</button><div id=\'p_"+i+"_msg\'></div></div>"; }); }',
        '  document.getElementById("editorProfilesContainer").innerHTML = ph;',
        '  } catch (e) { document.getElementById("editorGlobalContainer").innerHTML = "Error loading data."; }',
        '}',
        'async function saveMasterGlobalSettings() { const p = { globalTargetPnl: parseFloat(document.getElementById("e_globalTargetPnl").value)||0, globalTrailingPnl: parseFloat(document.getElementById("e_globalTrailingPnl").value)||0, globalSingleCoinTpPnl: parseFloat(document.getElementById("e_globalSingleCoinTpPnl").value)||0, globalSingleCoinSlPnl: parseFloat(document.getElementById("e_globalSingleCoinSlPnl").value)||0, smartOffsetNetProfit: parseFloat(document.getElementById("e_smartOffsetNetProfit").value)||0, smartOffsetStopLoss: parseFloat(document.getElementById("e_smartOffsetStopLoss").value)||0, smartOffsetNetProfit2: parseFloat(document.getElementById("e_smartOffsetNetProfit2").value)||0, smartOffsetStopLoss2: parseFloat(document.getElementById("e_smartOffsetStopLoss2").value)||0, minuteCloseAutoDynamic: document.getElementById("e_minuteCloseAutoDynamic").checked }; try { await fetch("/api/master/global", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer "+token }, body: JSON.stringify(p) }); document.getElementById("e_globalMsg").innerText="Saved!"; } catch(err) { } }',
        'async function saveMasterProfile(i) { try { await fetch("/api/master/profile/"+i, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer "+token }, body: "{}" }); document.getElementById("p_"+i+"_msg").innerText="Saved!"; } catch(err) { } }',
        'async function loadAdminData() { try { const uRes = await fetch("/api/admin/users", { headers: { "Authorization": "Bearer " + token } }); const u = await uRes.json(); let h = "<table class=\'md-table\'><tr><th>User</th><th>Mode</th><th>PNL</th><th>Action</th></tr>"; u.forEach(x=>{h+="<tr><td>"+x.username+"</td><td>"+(x.isPaper?"PAPER":"REAL")+"</td><td>$"+x.realizedPnl.toFixed(4)+"</td><td><button onclick=\'adminDeleteUser(\\\""+x._id+"\\\")\'>Delete</button></td></tr>";}); h+="</table>"; document.getElementById("adminUsersContainer").innerHTML = h; } catch(e) { } }',
        'async function adminDeleteUser(id) { if(!confirm("Delete?")) return; await fetch("/api/admin/users/"+id, { method: "DELETE", headers: { "Authorization": "Bearer " + token } }); loadAdminData(); }',
        'async function adminDeleteAllUsers() { if(!confirm("WIPE ALL?")) return; await fetch("/api/admin/users", { method: "DELETE", headers: { "Authorization": "Bearer " + token } }); loadAdminData(); }',
        'function logout() { localStorage.removeItem("token"); token=null; mySubAccounts=[]; myCoins=[]; currentProfileIndex=-1; document.getElementById("settingsContainer").style.display="none"; checkAuth(); }',
        'async function fetchSettings() { try { const res = await fetch("/api/settings", { headers: { "Authorization": "Bearer " + token } }); const c = await res.json(); ["globalTargetPnl","globalTrailingPnl","globalSingleCoinTpPnl","globalSingleCoinSlPnl","globalTriggerDcaPnl","smartOffsetNetProfit","smartOffsetBottomRowV1","smartOffsetBottomRowV1StopLoss","smartOffsetStopLoss","smartOffsetNetProfit2","smartOffsetStopLoss2","smartOffsetMaxLossPerMinute","smartOffsetMaxLossTimeframeSeconds","minuteCloseTpMinPnl","minuteCloseTpMaxPnl","minuteCloseSlMinPnl","minuteCloseSlMaxPnl","noPeakSlTimeframeSeconds","noPeakSlGatePnl"].forEach(k => { window["my"+k.charAt(0).toUpperCase()+k.slice(1)] = c[k]!==undefined?c[k]:0; if(document.getElementById(k)) document.getElementById(k).value = window["my"+k.charAt(0).toUpperCase()+k.slice(1)]; }); mySubAccounts = c.subAccounts || []; renderSubAccounts(); if (mySubAccounts.length>0) { document.getElementById("subAccountSelect").value=0; loadSubAccount(); } } catch(e) {} }',
        'async function saveGlobalSettings() { const p = ["globalTargetPnl","globalTrailingPnl","globalSingleCoinTpPnl","globalSingleCoinSlPnl","globalTriggerDcaPnl","smartOffsetNetProfit","smartOffsetBottomRowV1StopLoss","smartOffsetStopLoss","smartOffsetNetProfit2","smartOffsetStopLoss2"]; p.forEach(k => window["my"+k.charAt(0).toUpperCase()+k.slice(1)] = document.getElementById(k).value!==""?parseFloat(document.getElementById(k).value):0); const data = { subAccounts:mySubAccounts, globalTargetPnl:myGlobalTargetPnl, globalTrailingPnl:myGlobalTrailingPnl, globalSingleCoinTpPnl:myGlobalSingleCoinTpPnl, globalSingleCoinSlPnl:myGlobalSingleCoinSlPnl, globalTriggerDcaPnl:myGlobalTriggerDcaPnl, smartOffsetNetProfit:mySmartOffsetNetProfit, smartOffsetBottomRowV1StopLoss:mySmartOffsetBottomRowV1StopLoss, smartOffsetStopLoss:mySmartOffsetStopLoss, smartOffsetNetProfit2:mySmartOffsetNetProfit2, smartOffsetStopLoss2:mySmartOffsetStopLoss2 }; await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token }, body: JSON.stringify(data) }); alert("Global Settings Saved!"); }',
        'function renderSubAccounts() { const s=document.getElementById("subAccountSelect"); s.innerHTML="<option value=\'\'>-- Select --</option>"; mySubAccounts.forEach((sub,i)=>s.innerHTML+="<option value=\'"+i+"\'>"+sub.name+"</option>"); }',
        'async function addSubAccount() { const n=document.getElementById("newSubName").value.trim(); const k=document.getElementById("newSubKey").value.trim(); const s=document.getElementById("newSubSecret").value.trim(); if(!n||!k||!s) return alert("Fill all"); mySubAccounts.push({name:n,apiKey:k,secret:s,side:"long",leverage:10,baseQty:1,takeProfitPct:5,takeProfitPnl:0,stopLossPct:-25,triggerDcaPnl:-2,maxContracts:1000,realizedPnl:0,coins:[]}); await saveSettings(true); renderSubAccounts(); document.getElementById("subAccountSelect").value=mySubAccounts.length-1; loadSubAccount(); }',
        'function loadSubAccount() { const i=parseInt(document.getElementById("subAccountSelect").value); if(!isNaN(i)&&i>=0){ currentProfileIndex=i; const p=mySubAccounts[i]; document.getElementById("settingsContainer").style.display="block"; document.getElementById("apiKey").value=p.apiKey||""; document.getElementById("secret").value=p.secret||""; ["side","baseQty","takeProfitPct","takeProfitPnl","stopLossPct","triggerDcaPnl","maxContracts"].forEach(k => { if(document.getElementById(k)) document.getElementById(k).value = p[k]!==undefined?p[k]:0; }); myCoins=p.coins||[]; renderCoinsSettings(); } }',
        'async function removeSubAccount() { const i=parseInt(document.getElementById("subAccountSelect").value); if(!isNaN(i)&&i>=0){ mySubAccounts.splice(i,1); await saveSettings(true); renderSubAccounts(); } }',
        'async function globalToggleBot(a) { if(currentProfileIndex===-1) return alert("Load profile!"); myCoins.forEach(c=>c.botActive=a); await saveSettings(true); alert(a?"Started all!":"Stopped all."); }',
        'function addPredefinedList() { if(currentProfileIndex===-1) return alert("Load profile!"); const sm=document.getElementById("predefSide").value; const stm=document.getElementById("predefStatus").value==="started"; PREDEFINED_COINS.forEach((sym,i)=>{ if(myCoins.some(c=>c.symbol===sym+"/USDT:USDT")) return; let s="long"; if(sm==="allShort")s="short"; else if(sm==="oddLong")s=(i%2===0)?"long":"short"; else if(sm==="evenLong")s=(i%2===0)?"short":"long"; myCoins.push({symbol:sym+"/USDT:USDT",side:s,botActive:stm}); }); renderCoinsSettings(); }',
        'function addCoinUI() { const sym=document.getElementById("newCoinSymbol").value.toUpperCase().trim(); const ms=document.getElementById("side").value; if(!sym) return; myCoins.push({symbol:sym,side:ms,botActive:true}); renderCoinsSettings(); }',
        'function removeCoinUI(i) { myCoins.splice(i,1); renderCoinsSettings(); }',
        'function renderCoinsSettings() { const c=document.getElementById("coinsListContainer"); c.innerHTML=""; myCoins.forEach((coin,i)=>{ c.innerHTML+="<div class=\'stat-box flex-row\' style=\'justify-content:space-between; margin-bottom:8px;\'><span>"+coin.symbol+"</span><button class=\'md-btn md-btn-danger\' onclick=\'removeCoinUI("+i+")\'>Delete</button></div>"; }); }',
        'async function saveSettings(silent=false) { if(currentProfileIndex===-1) return; const p=mySubAccounts[currentProfileIndex]; p.apiKey=document.getElementById("apiKey").value; p.secret=document.getElementById("secret").value; p.side=document.getElementById("side").value; p.baseQty=parseFloat(document.getElementById("baseQty").value)||1; p.takeProfitPct=parseFloat(document.getElementById("takeProfitPct").value)||5; p.takeProfitPnl=parseFloat(document.getElementById("takeProfitPnl").value)||0; p.stopLossPct=parseFloat(document.getElementById("stopLossPct").value)||-25; p.triggerDcaPnl=parseFloat(document.getElementById("triggerDcaPnl").value)||-2; p.maxContracts=parseInt(document.getElementById("maxContracts").value)||1000; p.coins=myCoins; const data = { subAccounts:mySubAccounts, globalTargetPnl:myGlobalTargetPnl, globalTrailingPnl:myGlobalTrailingPnl, globalSingleCoinTpPnl:myGlobalSingleCoinTpPnl, globalSingleCoinSlPnl:myGlobalSingleCoinSlPnl, globalTriggerDcaPnl:myGlobalTriggerDcaPnl, smartOffsetNetProfit:mySmartOffsetNetProfit, smartOffsetBottomRowV1StopLoss:mySmartOffsetBottomRowV1StopLoss, smartOffsetStopLoss:mySmartOffsetStopLoss, smartOffsetNetProfit2:mySmartOffsetNetProfit2, smartOffsetStopLoss2:mySmartOffsetStopLoss2 }; const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token }, body: JSON.stringify(data) }); const j = await res.json(); mySubAccounts = j.settings.subAccounts||[]; if(!silent) alert("Profile Saved!"); }',
        'async function toggleCoinBot(sym, a) { const c=myCoins.find(x=>x.symbol===sym); if(c) c.botActive=a; await saveSettings(true); }',
        'async function loadOffsets() { const res = await fetch("/api/offsets", { headers: { "Authorization": "Bearer " + token } }); if(!res.ok) return; const r = await res.json(); if(r.length===0){ document.getElementById("offsetTableContainer").innerHTML="<p>No trades yet.</p>"; return; } let h="<table class=\'md-table\'><tr><th>Date</th><th>Symbol</th><th>Action</th><th>Net Profit</th></tr>"; r.forEach(x=>{ const d=new Date(x.timestamp); const n=x.netProfit||0; h+="<tr><td>"+d.toLocaleString()+"</td><td>"+(x.symbol||"")+"</td><td>"+(x.reason||"")+"</td><td class=\'"+(n>=0?"text-green":"text-red")+"\'>$"+n.toFixed(4)+"</td></tr>"; }); h+="</table>"; document.getElementById("offsetTableContainer").innerHTML=h; }',
        'async function loadStatus() {',
        '  const res = await fetch("/api/status", { headers: { "Authorization": "Bearer " + token } }); if(res.status===401||res.status===403) return logout(); const d = await res.json(); const st=d.states||{}; const su=d.subAccounts||[]; const gs=d.globalSettings||{};',
        '  let gt=0; su.forEach(s=>{gt+=(s.realizedPnl||0); const ls=mySubAccounts.find(x=>x._id===s._id); if(ls) ls.realizedPnl=s.realizedPnl; });',
        '  let gu=0; let gm=0; let tt=0; let taz=0; let ac=[];',
        '  for(let pid in st){ const s=st[pid]; if(s&&s.coinStates){ for(let sym in s.coinStates){ const cs=s.coinStates[sym]; if(cs.contracts>0) gm+=(parseFloat(cs.margin)||0); if(cs.contracts>0&&(!cs.lockUntil||Date.now()>=cs.lockUntil)){ tt++; const p=parseFloat(cs.unrealizedPnl)||0; if(cs.currentRoi>0) taz++; gu+=p; ac.push({symbol:sym,pnl:p}); } } } }',
        '  document.getElementById("topGlobalMargin").innerText="$"+gm.toFixed(2); document.getElementById("globalWinRate").innerText=taz+" / "+tt; document.getElementById("topGlobalUnrealized").innerText=(gu>=0?"+$":"-$")+Math.abs(gu).toFixed(4); document.getElementById("topGlobalUnrealized").className="stat-val "+(gu>=0?"text-green":"text-red");',
        '  if(document.getElementById("offset-tab").style.display==="block" && ac.length>=2){ ac.sort((a,b)=>b.pnl-a.pnl); let lh="<table class=\'md-table\'><tr><th>Winner</th><th>Loser</th><th>Net</th></tr>"; for(let i=0;i<Math.floor(ac.length/2);i++){ const w=ac[i]; const l=ac[ac.length-1-i]; const n=w.pnl+l.pnl; lh+="<tr><td>"+w.symbol+" ($"+w.pnl.toFixed(4)+")</td><td>"+l.symbol+" ($"+l.pnl.toFixed(4)+")</td><td class=\'"+(n>=0?"text-green":"text-red")+"\'>$"+n.toFixed(4)+"</td></tr>"; } lh+="</table>"; document.getElementById("liveOffsetsContainer").innerHTML=lh; }',
        '  if(currentProfileIndex===-1) return; document.getElementById("globalPnl").innerText=(gt>=0?"+$":"-$")+Math.abs(gt).toFixed(4); const p=mySubAccounts[currentProfileIndex]; const ppnl=p.realizedPnl||0; document.getElementById("profilePnl").innerText=(ppnl>=0?"+$":"-$")+Math.abs(ppnl).toFixed(4);',
        '  let pm=0; const sd=st[p._id]||{coinStates:{},logs:[]}; if(!myCoins||myCoins.length===0){document.getElementById("dashboardStatusContainer").innerHTML="<p>No coins.</p>";document.getElementById("profileMargin").innerText="$0.00";} else { let h=""; myCoins.forEach(c=>{ const s=sd.coinStates[c.symbol]||{status:"Stopped",currentPrice:0,avgEntry:0,contracts:0,currentRoi:0,unrealizedPnl:0,margin:0}; if(s.contracts>0) pm+=(parseFloat(s.margin)||0); const rc=s.currentRoi>=0?"text-green":"text-red"; h+="<div class=\'stat-box\' style=\'margin-bottom:16px;\'><div class=\'flex-row\' style=\'justify-content:space-between; border-bottom:1px solid #ccc; padding-bottom:8px; margin-bottom:8px;\'><div>"+c.symbol+" - "+s.status+"</div><div><button class=\'md-btn md-btn-success\' onclick=\'toggleCoinBot(\\\""+c.symbol+"\\\",true)\'>Start</button> <button class=\'md-btn md-btn-danger\' onclick=\'toggleCoinBot(\\\""+c.symbol+"\\\",false)\'>Stop</button></div></div><div class=\'flex-row\' style=\'justify-content:space-between;\'><div>Price: "+(s.currentPrice||0)+"</div><div>Entry: "+(s.avgEntry||0)+"</div><div>Qty: "+(s.contracts||0)+"</div><div class=\'"+rc+"\'>PNL: "+(s.unrealizedPnl||0).toFixed(4)+"</div></div></div>"; }); document.getElementById("dashboardStatusContainer").innerHTML=h; document.getElementById("profileMargin").innerText="$"+pm.toFixed(2); } document.getElementById("logs").innerHTML=(sd.logs||[]).join("<br>");',
        '}',
        'checkAuth();',
        '</script>',
        '</body>',
        '</html>'
    ].join('\n'));
});

if (require.main === module) { app.listen(PORT, () => console.log(`🚀 Running on http://localhost:${PORT}`)); }
module.exports = app;
