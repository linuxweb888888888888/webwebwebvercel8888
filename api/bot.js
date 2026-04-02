//web8888

const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const path = require('path');
const https = require('https');

// Safe Bcrypt Fallback for Vercel
let bcrypt;
try {
    bcrypt = require('bcryptjs');
} catch (err) {
    bcrypt = require('bcrypt');
}

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_this_in_production';

// DATABASE URL
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';

// NEW MASTER COIN LIST (54 Coins)
const PREDEFINED_COINS = ["OP", "BIGTIME", "MOVE", "SSV", "COAI", "TIA", "MERL", "MASK", "PYTH", "ETHFI", "CFX", "MEME", "LUNA", "STEEM", "BERA", "2Z", "FIL", "APT", "1INCH", "ARB", "XPL", "ENA", "MMT", "AXS", "TON", "CAKE", "BSV", "JUP", "WIF", "LIGHT", "PI", "SUSHI", "LPT", "CRV", "TAO", "ORDI", "YFI", "LA", "ICP", "FTT", "GIGGLE", "LDO", "OPN", "INJ", "SNX", "DASH", "WLD", "KAITO", "TRUMP", "WAVES", "ZEN", "ENS", "ASTER", "VIRTUAL"];

// ==========================================
// 1. MONGODB DATABASE SETUP
// ==========================================
let cachedDb = global.mongoose;
if (!cachedDb) {
    cachedDb = global.mongoose = { conn: null, promise: null };
}

const connectDB = async () => {
    if (cachedDb.conn) return cachedDb.conn;
    if (!cachedDb.promise) {
        cachedDb.promise = mongoose.connect(MONGO_URI, { 
            bufferCommands: false,
            maxPoolSize: 10 
        }).then((mongoose) => {
            console.log('✅ Connected to MongoDB successfully!');
            return mongoose;
        }).catch(err => {
            console.error('❌ MongoDB Connection Error:', err);
            cachedDb.promise = null; 
        });
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
    baseQty: { type: Number, default: 1 },
    takeProfitPct: { type: Number, default: 5.0 },
    takeProfitPnl: { type: Number, default: 0 },
    stopLossPct: { type: Number, default: -25.0 },
    triggerRoiPct: { type: Number, default: -15.0 },
    dcaTargetRoiPct: { type: Number, default: -2.0 },
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
    
    // Global DCA Recovery Settings
    autoBalanceEquity: { type: Boolean, default: false }, 
    autoBalanceUnrealizedPnlTarget: { type: Number, default: 0 }, 
    globalDcaRecoveryTriggerPnl: { type: Number, default: -50 },
    globalDcaStep: { type: Number, default: 0 }, // Tracks exponential DCA trigger depth
    
    subAccounts: [SubAccountSchema],

    cyclePauseEnabled: { type: Boolean, default: false },
    cyclePauseMinutes: { type: Number, default: 0 },
    cycleResumeMinutes: { type: Number, default: 0 },
    cycleCurrentState: { type: String, default: 'active' }, 
    cycleNextSwitchTime: { type: Number, default: 0 }
});

const OffsetRecordSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    symbol: { type: String }, 
    side: { type: String },
    openPrice: { type: Number },
    closePrice: { type: Number },
    roi: { type: Number },
    netProfit: { type: Number, required: true },
    reason: { type: String },
    timestamp: { type: Date, default: Date.now }
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
// GLOBAL MARKET CACHE & ORACLES
// ==========================================
global.customMaxLeverages = {};
global.marketSizes = {};
global.livePrices = global.livePrices || {};
let isBinanceFetching = false;
let isHtxFetching = false;

const binanceOracle = new ccxt.binance({ options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 20000 });
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
        } catch(e) { }
        resolve();
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
                                item.list.forEach(tier => {
                                    if (tier.lever_rate && tier.lever_rate > maxL) maxL = tier.lever_rate;
                                });
                            }
                            global.customMaxLeverages[symbol] = maxL;
                        });
                    }
                } catch (e) { }
                resolve();
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
    setInterval(async () => {
        if (isBinanceFetching) return;
        isBinanceFetching = true;
        try {
            const tickers = await binanceOracle.fetchTickers();
            for (let sym in tickers) { 
                if (tickers[sym] && tickers[sym].last) global.livePrices[sym] = tickers[sym].last;
            }
        } catch(e) { } finally { isBinanceFetching = false; }
    }, 3000);

    setInterval(async () => {
        if (isHtxFetching) return;
        isHtxFetching = true;
        try {
            const tickers = await htxOracle.fetchTickers();
            for (let sym in tickers) { 
                if (tickers[sym] && tickers[sym].last) global.livePrices[sym] = tickers[sym].last;
            }
        } catch(e) { } finally { isHtxFetching = false; }
    }, 5000);

    setInterval(() => {
        fetchCustomMaxLeveragesPromise();
        fetchGlobalMarketsPromise();
    }, 3600000); 
}

// ==========================================
// 3. MULTI-MODE BOT ENGINE STATE
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

function calculateDcaQtyToHalveGap(currentContracts) {
    return currentContracts > 0 ? currentContracts : 1;
}

async function startBot(userId, subAccount, isPaper) {
    const userDoc = await User.findById(userId);
    if (userDoc && userDoc.username === 'webcoin8888') return;

    const profileId = subAccount._id.toString();
    if (activeBots.has(profileId)) stopBot(profileId);

    if (!subAccount.apiKey || !subAccount.secret) return;

    const exchange = new ccxt.htx({ 
        apiKey: subAccount.apiKey, 
        secret: subAccount.secret, 
        options: { defaultType: 'swap' },
        enableRateLimit: true,
        timeout: 30000 
    });
    
    const ProfileStateModel = isPaper ? PaperProfileState : RealProfileState;
    const SettingsModel = isPaper ? PaperSettings : RealSettings;

    let dbState = await ProfileStateModel.findOne({ profileId });
    if (!dbState) {
        dbState = await ProfileStateModel.create({ profileId, userId, logs: [], coinStates: {} });
    }
    
    const globalSettings = await SettingsModel.findOne({ userId });
    const state = { logs: dbState.logs || [], coinStates: dbState.coinStates || {} };
    let isProcessing = false;
    let lastError = '';

    const intervalId = setInterval(async () => {
        if (isProcessing) return; 
        isProcessing = true;

        const botData = activeBots.get(profileId);
        if (!botData) { isProcessing = false; return; }

        if (botData.globalSettings?.cyclePauseEnabled && botData.globalSettings?.cycleCurrentState === 'paused') {
            isProcessing = false; 
            return; 
        }
        
        const currentSettings = botData.settings;
        let forcedStart = false;
        currentSettings.coins.forEach(c => {
            if (!c.botActive) { c.botActive = true; forcedStart = true; }
        });
        
        if (forcedStart) {
            SettingsModel.updateOne({ "subAccounts._id": currentSettings._id }, { $set: { "subAccounts.$.coins": currentSettings.coins } }).catch(()=>{});
        }
        
        const activeCoins = currentSettings.coins;
        if (activeCoins.length === 0) { isProcessing = false; return; }

        try {
            let positions = [];
            if (!isPaper) {
                positions = await exchange.fetchPositions().catch(e => { throw new Error('Positions: ' + e.message); });
            }

            for (let coin of activeCoins) {
                try {
                    const activeLeverage = getLeverageForCoin(coin.symbol);
                    
                    if (!state.coinStates[coin.symbol]) {
                        state.coinStates[coin.symbol] = { status: 'Running', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0, lastDcaTime: 0, lockUntil: 0, dcaCount: 0 };
                    }

                    let cState = state.coinStates[coin.symbol];
                    if (cState.lockUntil && Date.now() < cState.lockUntil) continue;

                    let activeSide = coin.side || currentSettings.side || 'long';
                    if (cState.contracts <= 0) {
                        let activeLongs = 0;
                        let activeShorts = 0;
                        for (let sym in state.coinStates) {
                            const st = state.coinStates[sym];
                            if (st.contracts > 0) {
                                if (st.activeSide === 'long') activeLongs++;
                                if (st.activeSide === 'short') activeShorts++;
                            }
                        }
                        if (activeLongs > activeShorts) activeSide = 'short';
                        else if (activeShorts > activeLongs) activeSide = 'long';
                        else activeSide = coin.side || currentSettings.side || 'long';
                    } else {
                        activeSide = cState.activeSide || activeSide;
                    }
                    
                    const currentPrice = global.livePrices[coin.symbol];
                    if (!currentPrice) continue; 
                    
                    cState.currentPrice = currentPrice;
                    cState.activeSide = activeSide;

                    let contractSize = 1;
                    if (global.marketSizes && global.marketSizes[coin.symbol]) {
                        contractSize = global.marketSizes[coin.symbol];
                    } else if (exchange.markets && exchange.markets[coin.symbol]) {
                        contractSize = exchange.markets[coin.symbol].contractSize || 1;
                    }

                    const ESTIMATED_FEE_RATE = 0.0004; 

                    if (!isPaper) {
                        const leveragePos = positions.find(p => p.symbol === coin.symbol);
                        let liveLeverage = activeLeverage;
                        if (leveragePos) {
                            if (leveragePos.info && leveragePos.info.lever_rate) liveLeverage = parseInt(leveragePos.info.lever_rate);
                            else if (leveragePos.leverage) liveLeverage = parseInt(leveragePos.leverage);
                        }
                        cState.actualLeverage = liveLeverage;

                        const pos = positions.find(p => p.symbol === coin.symbol && p.side === activeSide && parseFloat(p.contracts || p.info?.volume || 0) > 0);

                        cState.contracts = pos ? parseFloat(pos.contracts || pos.info?.volume || 0) : 0;
                        cState.avgEntry = pos ? parseFloat(pos.entryPrice || 0) : 0;
                        if (cState.contracts === 0) cState.dcaCount = 0; 
                        
                        let grossPnl = 0;
                        if (pos) {
                            if (pos.unrealizedPnl !== undefined && pos.unrealizedPnl !== null) {
                                grossPnl = parseFloat(pos.unrealizedPnl);
                            } else {
                                grossPnl = (activeSide === 'long') 
                                    ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize 
                                    : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize;
                            }
                        }

                        const positionValue = cState.contracts * contractSize * cState.currentPrice;
                        const estimatedFee = positionValue * ESTIMATED_FEE_RATE;
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
                            let grossPnl = (activeSide === 'long') 
                                ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize 
                                : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize;
                            
                            const positionValue = cState.contracts * contractSize * cState.currentPrice;
                            const estimatedFee = positionValue * ESTIMATED_FEE_RATE;

                            cState.unrealizedPnl = grossPnl - estimatedFee;
                            cState.margin = margin;
                            cState.currentRoi = margin > 0 ? (cState.unrealizedPnl / margin) * 100 : 0;
                        } else {
                            cState.unrealizedPnl = 0;
                            cState.margin = 0;
                            cState.currentRoi = 0;
                        }
                    }

                    // 1. OPEN BASE POSITION
                    if (cState.contracts <= 0) {
                        const safeBaseQty = Math.max(1, Math.floor(currentSettings.baseQty));
                        if (!isPaper) {
                            const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                            await exchange.createOrder(coin.symbol, 'market', orderSide, safeBaseQty, undefined, { offset: 'open', lever_rate: cState.actualLeverage });
                        } else {
                            cState.avgEntry = cState.currentPrice; 
                            cState.contracts = safeBaseQty; 
                            cState.currentRoi = 0; 
                            cState.unrealizedPnl = 0; 
                            cState.margin = (cState.avgEntry * cState.contracts * contractSize) / activeLeverage;
                        }
                        cState.lockUntil = Date.now() + 15000; 
                        continue; 
                    }

                    // 2. TAKE PROFIT OR STOP LOSS
                    let isTakeProfit = false;
                    let tpReasonTxt = '';
                    let isStopLoss = false;
                    let slReasonTxt = '';
                    
                    const globalTpPnlTarget = parseFloat(botData.globalSettings?.globalSingleCoinTpPnl) || 0;
                    const profileTpPnlTarget = parseFloat(currentSettings.takeProfitPnl) || 0;
                    const tpPnlTarget = globalTpPnlTarget > 0 ? globalTpPnlTarget : profileTpPnlTarget;
                    
                    const tpPctTarget = parseFloat(currentSettings.takeProfitPct) || 0;
                    const currentPnl = parseFloat(cState.unrealizedPnl) || 0;
                    const currentRoi = parseFloat(cState.currentRoi) || 0;
                    const slPctTarget = parseFloat(currentSettings.stopLossPct) || -25.0;

                    if (tpPnlTarget > 0 && currentPnl >= tpPnlTarget) {
                        isTakeProfit = true;
                        tpReasonTxt = `Take Profit ($${tpPnlTarget.toFixed(2)})`;
                    } else if (tpPctTarget > 0 && currentRoi >= tpPctTarget) {
                        isTakeProfit = true;
                        tpReasonTxt = `Take Profit (${tpPctTarget}%)`;
                    }
                    
                    if (slPctTarget < 0 && currentRoi <= slPctTarget) {
                        isStopLoss = true;
                        slReasonTxt = `Stop Loss Hit (${slPctTarget}%)`;
                    }

                    if (isTakeProfit || isStopLoss) {
                        const reasonTxt = isTakeProfit ? tpReasonTxt : slReasonTxt;
                        const modeTxt = isPaper ? "PAPER" : "REAL";
                        
                        try {
                            if (!isPaper) {
                                const closeSide = activeSide === 'long' ? 'sell' : 'buy';
                                await exchange.createOrder(coin.symbol, 'market', closeSide, cState.contracts, undefined, { 
                                    offset: 'close', reduceOnly: true, lever_rate: cState.actualLeverage 
                                });
                            }

                            const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                            await OffsetModel.create({ 
                                userId: userId, 
                                symbol: coin.symbol, 
                                side: activeSide,
                                openPrice: cState.avgEntry,
                                closePrice: cState.currentPrice,
                                roi: currentRoi,
                                netProfit: currentPnl,
                                reason: reasonTxt 
                            });

                            cState.lockUntil = Date.now() + 15000;
                            cState.dcaCount = 0; 
                            currentSettings.realizedPnl = (currentSettings.realizedPnl || 0) + currentPnl;
                            
                            if (isPaper) {
                                cState.contracts = 0; cState.unrealizedPnl = 0; cState.currentRoi = 0; cState.avgEntry = 0;
                            }

                            // ATOMIC DB UPDATE
                            await SettingsModel.updateOne(
                                { userId: userId, "subAccounts._id": currentSettings._id }, 
                                { $inc: { "subAccounts.$.realizedPnl": currentPnl } }
                            );

                            logForProfile(profileId, `[${modeTxt}] ⚡ ${coin.symbol} Closed: ${reasonTxt}. Profit: $${currentPnl.toFixed(2)}`);
                            continue; 

                        } catch (closeErr) {
                            logForProfile(profileId, `[${modeTxt}] ❌ CLOSE ERROR [${coin.symbol}]: ${closeErr.message}`);
                            continue;
                        }
                    }

                    // 3. DCA PNL STEP GRID TRIGGER
                    const profileTriggerDcaTarget = parseFloat(currentSettings.triggerDcaPnl) || -2.0;
                    const baseTriggerPnl = profileTriggerDcaTarget;
                    const currentDcaStep = cState.dcaCount || 0;
                    const activeTriggerPnl = baseTriggerPnl * Math.pow(2, currentDcaStep);

                    if (baseTriggerPnl < 0 && cState.unrealizedPnl <= activeTriggerPnl && (Date.now() - (cState.lastDcaTime || 0) > 12000)) {
                        
                        const reqQty = calculateDcaQtyToHalveGap(cState.contracts);

                        if (reqQty <= 0) {
                            cState.lastDcaTime = Date.now();
                        } else if ((cState.contracts + reqQty) > currentSettings.maxContracts) {
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
                            cState.dcaCount = currentDcaStep + 1; 
                            cState.lockUntil = Date.now() + 10000; 
                            cState.lastDcaTime = Date.now(); 
                        }
                    }
                } catch (coinErr) {
                    if (coinErr.message !== lastError) logForProfile(profileId, `[${coin.symbol}] ❌ Warning: ${coinErr.message}`);
                }
            } 
            lastError = '';

            await ProfileStateModel.updateOne(
                { profileId },
                { $set: { logs: state.logs, coinStates: state.coinStates, lastUpdated: Date.now() } }
            ).catch(()=>{});

        } catch (err) {
            if (err.message !== lastError) {
                logForProfile(profileId, `❌ Global API Error: ${err.message}`);
                lastError = err.message;
            }
        } finally {
            isProcessing = false;
        }
    }, 6000);

    activeBots.set(profileId, { userId: String(userId), isPaper, settings: subAccount, globalSettings, state, exchange, intervalId });
}

function stopBot(profileId) {
    if (activeBots.has(profileId)) {
        clearInterval(activeBots.get(profileId).intervalId);
        activeBots.delete(profileId);
    }
}

// =========================================================================
// 4. BACKGROUND TASKS (DUAL-MODE)
// =========================================================================
const manageUserCycles = async () => {
    if (global.isCycleMonitoring) return;
    global.isCycleMonitoring = true;
    try {
        await connectDB();
        const paperUsers = await PaperSettings.find({ cyclePauseEnabled: true }).lean();
        const realUsers = await RealSettings.find({ cyclePauseEnabled: true }).lean();

        const allUsers = [
            ...paperUsers.map(s => ({ ...s, isPaper: true, Model: PaperSettings })),
            ...realUsers.map(s => ({ ...s, isPaper: false, Model: RealSettings }))
        ];

        const now = Date.now();
        for (let user of allUsers) {
            if (now >= user.cycleNextSwitchTime && user.cycleNextSwitchTime > 0) {
                const newState = user.cycleCurrentState === 'active' ? 'paused' : 'active';
                const durationMins = newState === 'active' ? user.cycleResumeMinutes : user.cyclePauseMinutes;
                const nextTime = now + (durationMins * 60 * 1000);

                await user.Model.updateOne(
                    { userId: user.userId },
                    { $set: { cycleCurrentState: newState, cycleNextSwitchTime: nextTime } }
                );

                for (let [profileId, botData] of global.activeBots.entries()) {
                    if (botData.userId === String(user.userId) && botData.globalSettings) {
                        botData.globalSettings.cycleCurrentState = newState;
                        botData.globalSettings.cycleNextSwitchTime = nextTime;
                    }
                }
            }
        }
    } catch (err) {
    } finally {
        global.isCycleMonitoring = false;
    }
};

const executeGlobalProfitMonitor = async () => {
    if (global.isGlobalMonitoring) return;
    global.isGlobalMonitoring = true;

    try {
        await connectDB(); 
        const paperUsers = await PaperSettings.find({}).lean();
        const realUsers = await RealSettings.find({}).lean();
        
        const allUsersSettings = [
            ...paperUsers.map(s => ({ ...s, isPaper: true })),
            ...realUsers.map(s => ({ ...s, isPaper: false }))
        ];
        
        for (let userSetting of allUsersSettings) {
            if (userSetting.cyclePauseEnabled && userSetting.cycleCurrentState === 'paused') continue;

            const dbUserId = String(userSetting.userId);
            const SettingsModel = userSetting.isPaper ? PaperSettings : RealSettings;
            const OffsetModel = userSetting.isPaper ? PaperOffsetRecord : RealOffsetRecord;

            const multiplier = userSetting.qtyMultiplier || 1;
            const smartOffsetNetProfit = parseFloat(userSetting.smartOffsetNetProfit) || 0;
            const peakThreshold = 0.0001 * multiplier;
            const winnerThreshold = 0.0002 * multiplier;
            
            let globalUnrealized = 0;
            let activeCandidates = [];
            let firstProfileId = null; 

            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue;
                if (!firstProfileId) firstProfileId = profileId;
                
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                        const pnl = parseFloat(cState.unrealizedPnl) || 0;
                        globalUnrealized += pnl;
                        
                        const activeSide = cState.activeSide || botData.settings.coins.find(c => c.symbol === symbol)?.side || botData.settings.side;
                        
                        activeCandidates.push({
                            profileId, symbol, exchange: botData.exchange, isPaper: botData.isPaper, unrealizedPnl: pnl,
                            contracts: cState.contracts, side: activeSide, subAccount: botData.settings, actualLeverage: cState.actualLeverage || getLeverageForCoin(symbol)
                        });
                    }
                }
            }

            if (!firstProfileId || activeCandidates.length === 0) continue;

            const targetV1 = smartOffsetNetProfit > 0 ? smartOffsetNetProfit : 0;
            let offsetExecuted = false;

            // ==============================================================
            // GLOBAL DCA RECOVERY (MATH BASED WITH EXPONENTIAL STEP)
            // ==============================================================
            if (userSetting.autoBalanceEquity && !offsetExecuted) {
                // Target and Base Trigger are already multiplied by qtyMultiplier in DB
                const targetPnl = parseFloat(userSetting.autoBalanceUnrealizedPnlTarget) || 0;
                const baseTriggerPnl = parseFloat(userSetting.globalDcaRecoveryTriggerPnl) || -50.0;
                
                // Active trigger calculates the exponential step requirement (e.g. -9.9k -> -19.8k -> -39.6k)
                const currentGlobalStep = userSetting.globalDcaStep || 0;
                const activeTriggerPnl = baseTriggerPnl * Math.pow(2, currentGlobalStep);

                // 1. Reset logic: If PNL has recovered above the base trigger, reset step to 0
                if (globalUnrealized > baseTriggerPnl && currentGlobalStep > 0) {
                    await SettingsModel.updateOne({ _id: userSetting._id }, { $set: { globalDcaStep: 0 } });
                    userSetting.globalDcaStep = 0; 
                    logForProfile(firstProfileId, `✅ GLOBAL DCA: Net PNL recovered above base trigger ($${baseTriggerPnl.toFixed(2)}). Resetting Global Step to 0.`);
                }

                // 2. Execute Math Recovery if PNL drops below the ACTIVE step trigger
                if (baseTriggerPnl < 0 && globalUnrealized <= activeTriggerPnl && activeCandidates.length > 0) {
                    
                    logForProfile(firstProfileId, `⚙️ GLOBAL DCA: Net PNL ($${globalUnrealized.toFixed(2)}) hit active trigger ($${activeTriggerPnl.toFixed(2)} / Step ${currentGlobalStep}). Executing math recovery...`);

                    const numCoins = activeCandidates.length;
                    const gapToTarget = targetPnl - globalUnrealized; 
                    const gapPerCoin = gapToTarget / numCoins;

                    for (let c of activeCandidates) {
                        try {
                            const bData = activeBots.get(c.profileId);
                            if (!bData) continue;
                            const bState = bData.state.coinStates[c.symbol];
                            if (!bState) continue;

                            // Skip this individual coin if it's currently locked to prevent API spam,
                            // but DO NOT block the rest of the portfolio from receiving the global DCA blast.
                            if (bState.lockUntil && Date.now() < bState.lockUntil) continue;

                            const contractSize = global.marketSizes[c.symbol] || 1;
                            
                            // Target a 1% price bounce
                            const bouncePct = 0.01;
                            const favorablePriceMove = bState.currentPrice * bouncePct;
                            
                            let addQty = gapPerCoin / (favorablePriceMove * contractSize);
                            addQty = Math.max(1, Math.ceil(addQty)); 

                            const actualLev = parseInt(c.actualLeverage) || 10;

                            if (!c.isPaper) {
                                const orderSide = c.side === 'long' ? 'buy' : 'sell';
                                await bData.exchange.createOrder(c.symbol, 'market', orderSide, addQty, undefined, { offset: 'open', lever_rate: actualLev });
                            } else {
                                const totalValue = (bState.contracts * bState.avgEntry) + (addQty * bState.currentPrice);
                                bState.contracts += addQty;
                                bState.avgEntry = totalValue / bState.contracts;
                            }

                            bState.dcaCount = (bState.dcaCount || 0) + 1;
                            bState.lockUntil = Date.now() + 60000; 
                            bState.lastDcaTime = Date.now();

                            await OffsetModel.create({
                                userId: dbUserId, symbol: c.symbol, side: c.side,
                                openPrice: bState.avgEntry, closePrice: bState.currentPrice, roi: bState.currentRoi,
                                netProfit: 0, reason: `Global DCA Recovery (+${addQty})`
                            });

                            logForProfile(firstProfileId, `⚙️ RECOVERY: Added ${addQty} qty to ${c.symbol} (Math: Cover gap on 1% bounce).`);
                            offsetExecuted = true;
                        } catch (e) {
                            logForProfile(firstProfileId, `❌ RECOVERY ERR [${c.symbol}]: ${e.message}`);
                        }
                    }

                    // Increment Global Step so it doesn't infinitely spam on the very next 6-second tick
                    if (offsetExecuted) {
                        await SettingsModel.updateOne({ _id: userSetting._id }, { $inc: { globalDcaStep: 1 } });
                        userSetting.globalDcaStep = currentGlobalStep + 1;
                    }
                }
            }

            // SMART OFFSET V1 (TP ONLY)
            if (!offsetExecuted && smartOffsetNetProfit > 0 && activeCandidates.length >= 2) {
                activeCandidates.sort((a, b) => b.unrealizedPnl - a.unrealizedPnl); 
                
                const totalCoins = activeCandidates.length;
                const totalPairs = Math.floor(totalCoins / 2);

                let runningAccumulation = 0;
                let peakAccumulation = 0;
                let peakRowIndex = -1;

                for (let i = 0; i < totalPairs; i++) {
                    const w = activeCandidates[i];
                    const l = activeCandidates[totalCoins - totalPairs + i];
                    const netResult = w.unrealizedPnl + l.unrealizedPnl;
                    
                    runningAccumulation += netResult;

                    if (runningAccumulation > peakAccumulation) {
                        peakAccumulation = runningAccumulation;
                        peakRowIndex = i;
                    }
                }

                let triggerOffset = false;
                let reason = '';
                let finalPairsToClose = [];

                if (smartOffsetNetProfit > 0 && peakAccumulation >= targetV1 && peakAccumulation >= peakThreshold && peakRowIndex >= 0) {
                    triggerOffset = true;
                    reason = `Smart Offset V1`;
                    for(let i = 0; i <= peakRowIndex; i++) {
                        const w = activeCandidates[i];
                        if (Math.abs(w.unrealizedPnl) <= winnerThreshold) continue; 
                        finalPairsToClose.push(w); 
                    }
                    if (finalPairsToClose.length === 0) triggerOffset = false; 
                } 

                if (triggerOffset) {
                    let actualPairsToClose = [];
                    for (let k = 0; k < finalPairsToClose.length; k++) {
                        const pos = finalPairsToClose[k];
                        const bState = activeBots.get(pos.profileId).state.coinStates[pos.symbol];
                        const livePnl = bState ? (parseFloat(bState.unrealizedPnl) || 0) : pos.unrealizedPnl;
                        if (livePnl <= 0) continue; 
                        actualPairsToClose.push(pos);
                    }
                    finalPairsToClose = actualPairsToClose;
                    if (finalPairsToClose.length === 0) triggerOffset = false;

                    if (triggerOffset) {
                        logForProfile(firstProfileId, `⚖️ SMART OFFSET V1: Closing ${finalPairsToClose.length} WINNER coin(s).`);

                        for (let k = 0; k < finalPairsToClose.length; k++) {
                            const pos = finalPairsToClose[k];
                            const bData = activeBots.get(pos.profileId);
                            
                            try {
                                if (bData) {
                                    if (!pos.isPaper) {
                                        const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                                        await bData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { 
                                            offset: 'close', reduceOnly: true, lever_rate: pos.actualLeverage 
                                        });
                                    } 

                                    const bState = bData.state.coinStates[pos.symbol];
                                    
                                    if (bState) { 
                                        await OffsetModel.create({
                                            userId: dbUserId, symbol: pos.symbol, side: pos.side,
                                            openPrice: bState.avgEntry, closePrice: bState.currentPrice, roi: bState.currentRoi,
                                            netProfit: pos.unrealizedPnl, reason: 'Smart Offset V1'
                                        });

                                        bState.contracts = 0; bState.unrealizedPnl = 0; bState.avgEntry = 0; bState.dcaCount = 0; 
                                        bState.lockUntil = Date.now() + 60000; 
                                    }
                                    
                                    pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl;
                                    
                                    await SettingsModel.updateOne(
                                        { userId: dbUserId, "subAccounts._id": pos.subAccount._id }, 
                                        { $inc: { "subAccounts.$.realizedPnl": pos.unrealizedPnl } }
                                    );

                                    offsetExecuted = true;
                                }
                            } catch (e) {
                                logForProfile(firstProfileId, `❌ CLOSE ERROR [${pos.symbol}]: ${e.message}`);
                            }
                        }
                    }
                }
            }
        }
    } catch (err) {
    } finally {
        global.isGlobalMonitoring = false; 
    }
};

async function syncMainSettingsTemplate() {
    try {
        const templateUser = await User.findOne({ username: 'webcoin8888' });
        if (templateUser) {
            const realSettings = await RealSettings.findOne({ userId: templateUser._id }).lean();
            if (realSettings) {
                delete realSettings._id;
                delete realSettings.__v;
                await MainTemplate.findOneAndUpdate({ name: "main_settings" }, { $set: { settings: realSettings } }, { upsert: true });
            }
        }
    } catch(e) { }
}

const bootstrapBots = async () => {
    if (!global.botLoopsStarted) {
        global.botLoopsStarted = true;
        try {
            await connectDB();
            await syncMainSettingsTemplate();
            await fetchCustomMaxLeveragesPromise();
            await fetchGlobalMarketsPromise();
            startPriceOracle();
            setInterval(executeGlobalProfitMonitor, 6000);
            setInterval(manageUserCycles, 10000);

            const paperSettings = await PaperSettings.find({});
            paperSettings.forEach(s => {
                if (s.subAccounts) {
                    s.subAccounts.forEach(sub => { 
                        if (sub.coins && sub.coins.length > 0) {
                            sub.coins.forEach(c => c.botActive = true);
                            startBot(s.userId.toString(), sub, true).catch(()=>{}); 
                        }
                    });
                }
            });

            const realSettings = await RealSettings.find({});
            realSettings.forEach(s => {
                if (s.subAccounts) {
                    s.subAccounts.forEach(sub => { 
                        if (sub.coins && sub.coins.length > 0) {
                            sub.coins.forEach(c => c.botActive = true);
                            startBot(s.userId.toString(), sub, false).catch(()=>{}); 
                        }
                    });
                }
            });
        } catch(e) { }
    }
};

// ==========================================
// 6. EXPRESS API & AUTHENTICATION
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
        req.isPaper = user.isPaper;
        req.username = user.username; 
        next();
    });
};

const adminMiddleware = async (req, res, next) => {
    if (req.username !== 'webcoin8888') return res.status(403).json({ error: 'Admin access required.' });
    next();
};

app.get('/api/ping', async (req, res) => {
    await connectDB(); 
    await bootstrapBots(); 
    setTimeout(() => {
        res.status(200).json({ success: true, message: 'Bot was forced to stay awake and execute trades', timestamp: new Date().toISOString(), activeProfiles: activeBots.size });
    }, 8000);
});

app.get('/api/settings', authMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    await connectDB();
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const settings = await SettingsModel.findOne({ userId: req.userId }).lean();
    res.json(settings || {});
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        await connectDB();
        const realSettings = await RealSettings.find({}).populate('userId', 'username isPaper').lean();
        let users = [];
        realSettings.forEach(s => {
            if(s.userId && s.userId.username !== 'webcoin8888') {
                let totalPnl = s.subAccounts.reduce((sum, sub) => sum + (sub.realizedPnl || 0), 0);
                users.push({ username: s.userId.username, pnl: totalPnl });
            }
        });
        users.sort((a,b) => b.pnl - a.pnl);
        res.json(users.slice(0, 5));
    } catch (e) { res.status(500).json([]); }
});

app.post('/api/register', async (req, res) => {
    try {
        await bootstrapBots(); 
        await connectDB();
        
        const { username, password, qtyMultiplier, customCoins, authCode } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

        const isPaper = (authCode !== 'payed');
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const user = await User.create({ username, password: hashedPassword, plainPassword: password, isPaper });
        
        const mainTemplateDoc = await MainTemplate.findOne({ name: "main_settings" });
        let templateSettings = mainTemplateDoc ? JSON.parse(JSON.stringify(mainTemplateDoc.settings)) : {};
        
        delete templateSettings._id;
        delete templateSettings.__v;
        templateSettings.userId = user._id;
        templateSettings.cyclePauseEnabled = false;
        templateSettings.cyclePauseMinutes = 0;
        templateSettings.cycleResumeMinutes = 0;
        templateSettings.cycleCurrentState = 'active';
        templateSettings.cycleNextSwitchTime = 0;
        templateSettings.globalDcaStep = 0;

        const multiplier = parseFloat(qtyMultiplier) > 0 ? parseFloat(qtyMultiplier) : 1;
        templateSettings.qtyMultiplier = multiplier;
        templateSettings.smartOffsetNetProfit = (templateSettings.smartOffsetNetProfit || 0) * multiplier;
        templateSettings.globalSingleCoinTpPnl = (templateSettings.globalSingleCoinTpPnl || 0) * multiplier;
        templateSettings.autoBalanceUnrealizedPnlTarget = (templateSettings.autoBalanceUnrealizedPnlTarget !== undefined ? templateSettings.autoBalanceUnrealizedPnlTarget : 0) * multiplier;
        templateSettings.globalDcaRecoveryTriggerPnl = (templateSettings.globalDcaRecoveryTriggerPnl !== undefined ? templateSettings.globalDcaRecoveryTriggerPnl : -50) * multiplier;

        let coinList = PREDEFINED_COINS;
        if (customCoins) {
            coinList = customCoins.split(' ').map(c => c.trim().toUpperCase()).filter(c => c);
            if (coinList.length === 0) coinList = PREDEFINED_COINS;
        }

        if (!templateSettings.subAccounts || templateSettings.subAccounts.length === 0) {
            templateSettings.subAccounts = [];
            for (let i = 1; i <= 6; i++) {
                let profileName = 'Profile ' + i;
                let coins = [];
                coinList.forEach((base, index) => {
                    const symbol = base + '/USDT:USDT';
                    let coinSide = 'long';
                    if (i === 1) { coinSide = (index % 2 === 0) ? 'long' : 'short'; profileName = "P1: Even L / Odd S"; }
                    else if (i === 2) { coinSide = (index % 2 === 0) ? 'short' : 'long'; profileName = "P2: Even S / Odd L"; }
                    else if (i === 3) { coinSide = 'long'; profileName = "P3: All Long"; }
                    else if (i === 4) { coinSide = 'short'; profileName = "P4: All Short"; }
                    else if (i === 5) { coinSide = (index < coinList.length / 2) ? 'long' : 'short'; profileName = "P5: Half L / Half S"; }
                    else if (i === 6) { coinSide = (index < coinList.length / 2) ? 'short' : 'long'; profileName = "P6: Half S / Half L"; }
                    coins.push({ symbol, side: coinSide, botActive: true }); 
                });
                templateSettings.subAccounts.push({
                    name: profileName, apiKey: isPaper ? 'paper_key_' + i + '_' + Date.now() : '', secret: isPaper ? 'paper_secret_' + i + '_' + Date.now() : '', side: 'long',
                    leverage: 10, baseQty: 1 * multiplier, takeProfitPct: 5.0, takeProfitPnl: 0, stopLossPct: -25.0, triggerDcaPnl: -2.0 * multiplier, maxContracts: 1000, realizedPnl: 0, coins: coins
                });
            }
        } else {
            templateSettings.subAccounts = templateSettings.subAccounts.map((sub, i) => {
                delete sub._id;
                sub.realizedPnl = 0;
                sub.baseQty = (sub.baseQty !== undefined ? sub.baseQty : 1) * multiplier;
                sub.triggerDcaPnl = sub.triggerDcaPnl !== undefined ? sub.triggerDcaPnl : -2.0 * multiplier;
                sub.apiKey = isPaper ? 'paper_key_' + i + '_' + Date.now() : ''; 
                sub.secret = isPaper ? 'paper_secret_' + i + '_' + Date.now() : ''; 
                let forcedCoins = [];
                coinList.forEach((base, index) => {
                    const symbol = base + '/USDT:USDT'; let coinSide = 'long';
                    if (i === 0) coinSide = (index % 2 === 0) ? 'long' : 'short'; else if (i === 1) coinSide = (index % 2 === 0) ? 'short' : 'long'; else if (i === 2) coinSide = 'long'; else if (i === 3) coinSide = 'short'; else if (i === 4) coinSide = (index < coinList.length / 2) ? 'long' : 'short'; else if (i === 5) coinSide = (index < coinList.length / 2) ? 'short' : 'long'; 
                    forcedCoins.push({ symbol, side: coinSide, botActive: true }); 
                });
                sub.coins = forcedCoins;
                return sub;
            });
        }
        const SettingsModel = isPaper ? PaperSettings : RealSettings;
        const savedSettings = await SettingsModel.create(templateSettings);
        if (savedSettings.subAccounts) { savedSettings.subAccounts.forEach(sub => startBot(user._id.toString(), sub, isPaper).catch(()=>{})); }
        return res.json({ success: true, message: `Registration successful! Pre-configured ${isPaper ? 'Paper' : 'Live'} Profiles have been setup.` });

    } catch (err) { res.status(400).json({ error: 'Username already exists or system error.' }); }
});

app.post('/api/login', async (req, res) => {
    await bootstrapBots(); 
    await connectDB();
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, isPaper: user.isPaper, username: user.username });
});

app.get('/api/me', authMiddleware, async (req, res) => { res.json({ isPaper: req.isPaper, username: req.username }); });

app.get('/api/admin/status', authMiddleware, adminMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const template = await MainTemplate.findOne({ name: "main_settings" });
    const webcoin = await User.findOne({ username: 'webcoin8888' });
    res.json({ templateSafe: !!template, webcoinSafe: !!webcoin });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const users = await User.find({ username: { $ne: 'webcoin8888' } }).lean();
    let result = [];
    for (let u of users) {
        const SettingsModel = u.isPaper ? PaperSettings : RealSettings;
        const settings = await SettingsModel.findOne({ userId: u._id }).lean();
        let totalPnl = 0;
        if (settings && settings.subAccounts) totalPnl = settings.subAccounts.reduce((sum, sub) => sum + (sub.realizedPnl || 0), 0);
        result.push({ 
            _id: u._id, username: u.username, plainPassword: u.plainPassword || 'Not Recorded', isPaper: u.isPaper, realizedPnl: totalPnl,
            cyclePauseEnabled: settings?.cyclePauseEnabled || false, cycleCurrentState: settings?.cycleCurrentState || 'active', cyclePauseMinutes: settings?.cyclePauseMinutes || 0, cycleResumeMinutes: settings?.cycleResumeMinutes || 0, cycleNextSwitchTime: settings?.cycleNextSwitchTime || 0
        });
    }
    res.json(result);
});

app.post('/api/admin/users/:id/cycle', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    const { enabled, pauseMinutes, resumeMinutes } = req.body;
    const targetUser = await User.findById(id);
    if (!targetUser || targetUser.username === 'webcoin8888') return res.status(403).json({ error: 'Invalid user' });

    const SettingsModel = targetUser.isPaper ? PaperSettings : RealSettings;
    const pMins = Math.max(1, parseInt(pauseMinutes) || 1);
    const rMins = Math.max(1, parseInt(resumeMinutes) || 1);

    const update = { cyclePauseEnabled: !!enabled, cyclePauseMinutes: pMins, cycleResumeMinutes: rMins };
    const existing = await SettingsModel.findOne({ userId: targetUser._id });
    if (enabled) {
        if (!existing || !existing.cyclePauseEnabled) { update.cycleCurrentState = 'paused'; update.cycleNextSwitchTime = Date.now() + (pMins * 60 * 1000); }
    } else { update.cycleCurrentState = 'active'; update.cycleNextSwitchTime = 0; }

    const newlyUpdated = await SettingsModel.findOneAndUpdate({ userId: targetUser._id }, { $set: update }, { new: true });
    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === String(id) && botData.globalSettings) {
            botData.globalSettings.cyclePauseEnabled = newlyUpdated.cyclePauseEnabled; botData.globalSettings.cycleCurrentState = newlyUpdated.cycleCurrentState; botData.globalSettings.cycleNextSwitchTime = newlyUpdated.cycleNextSwitchTime; botData.globalSettings.cyclePauseMinutes = newlyUpdated.cyclePauseMinutes; botData.globalSettings.cycleResumeMinutes = newlyUpdated.cycleResumeMinutes;
        }
    }
    res.json({ success: true, message: 'Cycle settings updated successfully.' });
});

app.post('/api/admin/users/:id/import', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    const targetUser = await User.findById(id);
    if (!targetUser || targetUser.username === 'webcoin8888') return res.status(403).json({ error: 'Invalid user or cannot import to master.' });
    
    const mainTemplateDoc = await MainTemplate.findOne({ name: "main_settings" });
    if (!mainTemplateDoc || !mainTemplateDoc.settings) return res.status(400).json({ error: 'Master template not found in database.' });

    const templateSettings = mainTemplateDoc.settings;
    const SettingsModel = targetUser.isPaper ? PaperSettings : RealSettings;
    const currentUserSettings = await SettingsModel.findOne({ userId: targetUser._id }).lean();
    const mult = currentUserSettings ? (currentUserSettings.qtyMultiplier || 1) : 1;

    const newSubAccounts = (templateSettings.subAccounts || []).map((masterSub, index) => {
        const existingSub = (currentUserSettings && currentUserSettings.subAccounts) ? currentUserSettings.subAccounts[index] : null;
        
        let apiKey = masterSub.apiKey || ''; 
        let secret = masterSub.secret || '';

        if (targetUser.isPaper && (!apiKey || !secret)) { 
            apiKey = 'paper_key_' + index + '_' + Date.now(); 
            secret = 'paper_secret_' + index + '_' + Date.now(); 
        }

        let importedCoins = [];
        if (masterSub.coins && masterSub.coins.length > 0) {
            importedCoins = masterSub.coins.map(c => ({
                symbol: c.symbol,
                side: c.side,
                botActive: c.botActive !== undefined ? c.botActive : true
            }));
        }

        return {
            name: masterSub.name, 
            apiKey: apiKey, 
            secret: secret, 
            side: masterSub.side || 'long', 
            leverage: masterSub.leverage !== undefined ? masterSub.leverage : 10,
            baseQty: (masterSub.baseQty !== undefined ? masterSub.baseQty : 1) * mult, 
            takeProfitPct: masterSub.takeProfitPct !== undefined ? masterSub.takeProfitPct : 5.0, 
            takeProfitPnl: masterSub.takeProfitPnl !== undefined ? masterSub.takeProfitPnl : 0,
            stopLossPct: masterSub.stopLossPct !== undefined ? masterSub.stopLossPct : -25.0, 
            triggerDcaPnl: masterSub.triggerDcaPnl !== undefined ? masterSub.triggerDcaPnl : -2.0 * mult, 
            maxContracts: masterSub.maxContracts !== undefined ? masterSub.maxContracts : 1000, 
            realizedPnl: existingSub ? (existingSub.realizedPnl || 0) : 0, 
            coins: importedCoins
        };
    });

    if (currentUserSettings && currentUserSettings.subAccounts && currentUserSettings.subAccounts.length > newSubAccounts.length) {
        const extraProfiles = currentUserSettings.subAccounts.slice(newSubAccounts.length);
        newSubAccounts.push(...extraProfiles);
    }

    for (let [profileId, botData] of activeBots.entries()) { 
        if (botData.userId === String(id)) stopBot(profileId); 
    }
    
    const updatedUser = await SettingsModel.findOneAndUpdate(
        { userId: targetUser._id }, 
        { $set: { subAccounts: newSubAccounts } }, 
        { returnDocument: 'after', upsert: true }
    );

    if (updatedUser && updatedUser.subAccounts) {
        updatedUser.subAccounts.forEach(sub => {
            if (sub.coins && sub.coins.length > 0 && sub.apiKey && sub.secret) { 
                sub.coins.forEach(c => c.botActive = true);
                startBot(targetUser._id.toString(), sub, targetUser.isPaper).catch(()=>{}); 
            }
        });
    }
    res.json({ success: true, message: `Successfully overwrote Master Profiles (Keys & Matrices synced) for ${targetUser.username}.` });
});

app.post('/api/admin/users/:id/reset-pnl', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    const targetUser = await User.findById(id);
    if (!targetUser || targetUser.username === 'webcoin8888') return res.status(403).json({ error: 'Invalid user.' });
    
    const SettingsModel = targetUser.isPaper ? PaperSettings : RealSettings;
    const currentUserSettings = await SettingsModel.findOne({ userId: targetUser._id });
    
    if (currentUserSettings && currentUserSettings.subAccounts) {
        currentUserSettings.subAccounts.forEach(sub => { sub.realizedPnl = 0; });
        await currentUserSettings.save();
    }

    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === String(id)) botData.settings.realizedPnl = 0;
    }
    
    res.json({ success: true, message: `Realized PNL reset to 0 for ${targetUser.username}.` });
});

app.post('/api/admin/users/:id/close-all', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    const targetUser = await User.findById(id);
    if (!targetUser || targetUser.username === 'webcoin8888') return res.status(403).json({ error: 'Invalid user.' });

    let totalClosed = 0;
    const SettingsModel = targetUser.isPaper ? PaperSettings : RealSettings;
    const OffsetModel = targetUser.isPaper ? PaperOffsetRecord : RealOffsetRecord;
    
    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === String(id)) {
            if (!targetUser.isPaper) {
                const positions = await botData.exchange.fetchPositions().catch(()=>[]);
                if (positions && positions.length > 0) {
                    for (let pos of positions) {
                        if (pos.contracts > 0) {
                            const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                            const activeLev = parseInt(pos.leverage || (pos.info && pos.info.lever_rate)) || botData.state.coinStates[pos.symbol]?.actualLeverage || getLeverageForCoin(pos.symbol);
                            await botData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: activeLev }).catch(console.error);
                        }
                    }
                }
            }
            
            for (let sym in botData.state.coinStates) {
                const cState = botData.state.coinStates[sym];
                if (cState.contracts > 0) {
                    const closePnl = parseFloat(cState.unrealizedPnl) || 0;
                    botData.settings.realizedPnl = (botData.settings.realizedPnl || 0) + closePnl;
                    OffsetModel.create({ 
                        userId: targetUser._id, symbol: sym, side: cState.activeSide,
                        openPrice: cState.avgEntry, closePrice: cState.currentPrice, roi: cState.currentRoi,
                        netProfit: closePnl, reason: 'Admin Force Close All'
                    }).catch(()=>{});
                    totalClosed++;
                }
                cState.contracts = 0;
                cState.unrealizedPnl = 0;
                cState.avgEntry = 0;
                cState.dcaCount = 0;
                cState.lockUntil = Date.now() + 120000; 
            }
            
            await SettingsModel.updateOne(
                { "subAccounts._id": botData.settings._id }, 
                { $set: { "subAccounts.$.realizedPnl": botData.settings.realizedPnl } } // Resetting/overwriting is fine for total wipe
            ).catch(()=>{});
        }
    }
    res.json({ success: true, message: `Force closed ${totalClosed} positions for ${targetUser.username}. Trading paused for 2 minutes.` });
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    const targetUser = await User.findById(id);
    if (!targetUser || targetUser.username === 'webcoin8888') return res.status(403).json({ error: 'Cannot delete master account.' });

    for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(id)) stopBot(profileId); }
    await User.findByIdAndDelete(id); await PaperSettings.deleteMany({ userId: id }); await RealSettings.deleteMany({ userId: id });
    await PaperProfileState.deleteMany({ userId: id }); await RealProfileState.deleteMany({ userId: id });
    await PaperOffsetRecord.deleteMany({ userId: id }); await RealOffsetRecord.deleteMany({ userId: id });
    res.json({ success: true, message: 'Deleted user ' + targetUser.username });
});

app.delete('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    const users = await User.find({ username: { $ne: 'webcoin8888' } });
    let count = 0;
    for (let u of users) {
        for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(u._id)) stopBot(profileId); }
        await User.findByIdAndDelete(u._id); await PaperSettings.deleteMany({ userId: u._id }); await RealSettings.deleteMany({ userId: u._id });
        await PaperProfileState.deleteMany({ userId: u._id }); await RealProfileState.deleteMany({ userId: u._id });
        await PaperOffsetRecord.deleteMany({ userId: u._id }); await RealOffsetRecord.deleteMany({ userId: u._id });
        count++;
    }
    res.json({ success: true, message: 'Safely wiped ' + count + ' users. Master settings strictly intact.' });
});

app.post('/api/close-all', authMiddleware, async (req, res) => {
    if (req.isPaper) return res.status(403).json({ error: "Paper accounts cannot perform real emergency closures. Stop bots manually." });
    try {
        let totalClosed = 0;
        const OffsetModel = RealOffsetRecord;
        const SettingsModel = RealSettings;
        for (let [profileId, botData] of activeBots.entries()) {
            if (botData.userId !== req.userId.toString()) continue;
            const positions = await botData.exchange.fetchPositions().catch(()=>[]);
            if (!positions || positions.length === 0) continue;
            for (let pos of positions) {
                if (pos.contracts > 0) {
                    const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                    const activeLev = parseInt(pos.leverage || (pos.info && pos.info.lever_rate)) || botData.state.coinStates[pos.symbol]?.actualLeverage || getLeverageForCoin(pos.symbol);
                    await botData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: activeLev }).catch(console.error);
                    totalClosed++;
                    let closedPnl = 0;
                    const bState = botData.state.coinStates[pos.symbol];
                    if (bState) {
                        closedPnl = parseFloat(bState.unrealizedPnl) || 0;
                        bState.lockUntil = Date.now() + 60000;
                    }
                    OffsetModel.create({ 
                        userId: req.userId, symbol: pos.symbol, side: pos.side,
                        openPrice: bState ? bState.avgEntry : 0, closePrice: bState ? bState.currentPrice : 0, roi: bState ? bState.currentRoi : 0,
                        netProfit: closedPnl, reason: 'Emergency Panic Close' 
                    }).catch(()=>{});

                    await SettingsModel.updateOne(
                        { userId: req.userId, "subAccounts._id": botData.settings._id }, 
                        { $inc: { "subAccounts.$.realizedPnl": closedPnl } }
                    ).catch(()=>{});
                }
            }
        }
        res.json({ success: true, message: 'Emergency Protocol Executed. Sent market close orders for ' + totalClosed + ' active positions.' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/close-position', authMiddleware, async (req, res) => {
    const { symbol, profileId } = req.body;
    if (!symbol) return res.status(400).json({ error: "Symbol required" });

    try {
        let closed = false;
        for (let [pId, botData] of activeBots.entries()) {
            if (botData.userId !== req.userId.toString()) continue;
            if (profileId && pId !== profileId) continue; 

            const cState = botData.state.coinStates[symbol];
            if (!cState || cState.contracts <= 0) continue;

            const closePnl = parseFloat(cState.unrealizedPnl) || 0;

            if (!req.isPaper) {
                const positions = await botData.exchange.fetchPositions().catch(()=>[]);
                const pos = positions.find(p => p.symbol === symbol && p.contracts > 0);
                if (pos) {
                    const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                    const activeLev = parseInt(pos.leverage || (pos.info && pos.info.lever_rate)) || cState.actualLeverage || getLeverageForCoin(symbol);
                    await botData.exchange.createOrder(symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: activeLev });
                }
            }

            const OffsetModel = req.isPaper ? PaperOffsetRecord : RealOffsetRecord;
            OffsetModel.create({ 
                userId: req.userId, symbol: symbol, side: cState.activeSide,
                openPrice: cState.avgEntry, closePrice: cState.currentPrice, roi: cState.currentRoi,
                netProfit: closePnl, reason: 'Manual User Close' 
            }).catch(()=>{});

            cState.contracts = 0; cState.unrealizedPnl = 0; cState.avgEntry = 0; cState.dcaCount = 0;
            cState.lockUntil = Date.now() + 60000;

            botData.settings.realizedPnl = (botData.settings.realizedPnl || 0) + closePnl;
            const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
            
            await SettingsModel.updateOne(
                { userId: req.userId, "subAccounts._id": botData.settings._id }, 
                { $inc: { "subAccounts.$.realizedPnl": closePnl } }
            ).catch(()=>{});

            closed = true;
            break; 
        }

        if (closed) res.json({ success: true, message: `Closed ${symbol} successfully.` });
        else res.status(400).json({ error: "Position not found or already closed." });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings', authMiddleware, async (req, res) => {
    await bootstrapBots(); 
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;

    const { subAccounts, globalSingleCoinTpPnl, smartOffsetNetProfit, autoBalanceEquity, autoBalanceUnrealizedPnlTarget, globalDcaRecoveryTriggerPnl } = req.body;
    
    const existingSettings = await SettingsModel.findOne({ userId: req.userId });
    if (existingSettings && existingSettings.subAccounts) {
        subAccounts.forEach(sub => {
            sub.realizedPnl = 0; 
            if (sub._id) {
                const existingSub = existingSettings.subAccounts.find(s => s._id.toString() === sub._id.toString());
                if (existingSub) sub.realizedPnl = existingSub.realizedPnl || 0;
            }
        });
    }

    subAccounts.forEach(sub => {
        if (sub.triggerDcaPnl > 0) sub.triggerDcaPnl = -sub.triggerDcaPnl;
        if (sub.stopLossPct > 0) sub.stopLossPct = -sub.stopLossPct;
        if (sub.takeProfitPnl === undefined) sub.takeProfitPnl = 0;
        sub.leverage = 10; 
    });

    const updated = await SettingsModel.findOneAndUpdate(
        { userId: req.userId }, 
        { 
            subAccounts, globalSingleCoinTpPnl: parseFloat(globalSingleCoinTpPnl) || 0,
            smartOffsetNetProfit: parseFloat(smartOffsetNetProfit) || 0,
            autoBalanceEquity: autoBalanceEquity === true, 
            autoBalanceUnrealizedPnlTarget: parseFloat(autoBalanceUnrealizedPnlTarget) || 0, 
            globalDcaRecoveryTriggerPnl: parseFloat(globalDcaRecoveryTriggerPnl) || -50
        }, { returnDocument: 'after' }
    );

    const activeSubIds = [];
    if (updated.subAccounts) {
        updated.subAccounts.forEach(sub => {
            const profileId = sub._id.toString();
            activeSubIds.push(profileId);
            if (sub.coins && sub.coins.length > 0) {
                sub.coins.forEach(c => c.botActive = true); 
                startBot(req.userId.toString(), sub, req.isPaper).catch(err => console.error("startBot Error:", err)); 
            } else { stopBot(profileId); }
        });
    }

    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === req.userId.toString() && !activeSubIds.includes(profileId)) stopBot(profileId);
    }

    if (req.username === 'webcoin8888') {
        await syncMainSettingsTemplate(); 

        const allRealUsers = await RealSettings.find({ userId: { $ne: req.userId } });
        const allPaperUsers = await PaperSettings.find({ userId: { $ne: req.userId } });
        
        const syncGlobalParams = {
            globalSingleCoinTpPnl: updated.globalSingleCoinTpPnl,
            smartOffsetNetProfit: updated.smartOffsetNetProfit,
            autoBalanceEquity: updated.autoBalanceEquity, 
            autoBalanceUnrealizedPnlTarget: updated.autoBalanceUnrealizedPnlTarget, 
            globalDcaRecoveryTriggerPnl: updated.globalDcaRecoveryTriggerPnl
        };

        const applyMasterSync = async (userSettingsDoc, isPaperMode) => {
            let updatePayload = { ...syncGlobalParams };
            const mult = userSettingsDoc.qtyMultiplier || 1;
            
            updatePayload.smartOffsetNetProfit = (updated.smartOffsetNetProfit || 0) * mult;
            updatePayload.globalSingleCoinTpPnl = (updated.globalSingleCoinTpPnl || 0) * mult;
            updatePayload.autoBalanceUnrealizedPnlTarget = (updated.autoBalanceUnrealizedPnlTarget || 0) * mult;
            updatePayload.globalDcaRecoveryTriggerPnl = (updated.globalDcaRecoveryTriggerPnl || -50) * mult;

            if (!isPaperMode) {
                let fallbackApiKey = '';
                let fallbackSecret = '';
                if (userSettingsDoc.subAccounts) {
                    const validSub = userSettingsDoc.subAccounts.find(s => s.apiKey && s.apiKey.trim() !== '' && !s.apiKey.startsWith('paper_'));
                    if (validSub) {
                        fallbackApiKey = validSub.apiKey;
                        fallbackSecret = validSub.secret;
                    }
                }

                const syncedSubAccounts = updated.subAccounts.map((masterSub, index) => {
                    const existingUserSub = userSettingsDoc.subAccounts[index] || {};
                    let subKey = fallbackApiKey;
                    let subSec = fallbackSecret;

                    if (existingUserSub.apiKey && existingUserSub.apiKey.trim() !== '') {
                        subKey = existingUserSub.apiKey;
                        subSec = existingUserSub.secret;
                    }

                    const newSub = {
                        name: masterSub.name, apiKey: subKey, secret: subSec, side: masterSub.side,
                        leverage: masterSub.leverage, baseQty: (masterSub.baseQty || 1) * mult, takeProfitPct: masterSub.takeProfitPct, takeProfitPnl: masterSub.takeProfitPnl, stopLossPct: masterSub.stopLossPct,
                        triggerDcaPnl: masterSub.triggerDcaPnl, maxContracts: masterSub.maxContracts,
                        realizedPnl: existingUserSub.realizedPnl || 0, coins: masterSub.coins.map(c => ({ symbol: c.symbol, side: c.side, botActive: c.botActive !== undefined ? c.botActive : true }))
                    };
                    if (existingUserSub._id) newSub._id = existingUserSub._id;
                    return newSub;
                });

                if (userSettingsDoc.subAccounts && userSettingsDoc.subAccounts.length > updated.subAccounts.length) {
                    const extraProfiles = userSettingsDoc.subAccounts.slice(updated.subAccounts.length);
                    syncedSubAccounts.push(...extraProfiles);
                }

                updatePayload.subAccounts = syncedSubAccounts;
            }

            const ModelToUse = isPaperMode ? PaperSettings : RealSettings;
            const newlyUpdatedUser = await ModelToUse.findOneAndUpdate({ userId: userSettingsDoc.userId }, { $set: updatePayload }, { returnDocument: 'after' });

            const userActiveSubIds = [];
            if (newlyUpdatedUser && newlyUpdatedUser.subAccounts) {
                newlyUpdatedUser.subAccounts.forEach(sub => {
                    const profileId = sub._id.toString();
                    userActiveSubIds.push(profileId);
                    if (sub.coins && sub.coins.length > 0 && sub.apiKey && sub.secret) {
                        sub.coins.forEach(c => c.botActive = true); 
                        startBot(newlyUpdatedUser.userId.toString(), sub, isPaperMode).catch(()=>{}); 
                    } else { stopBot(profileId); }
                });
            }

            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId === newlyUpdatedUser.userId.toString() && !userActiveSubIds.includes(profileId)) stopBot(profileId);
            }
        };

        for (let doc of allRealUsers) await applyMasterSync(doc, false);
        for (let doc of allPaperUsers) await applyMasterSync(doc, true);
    }
    res.json({ success: true, settings: updated });
});

app.get('/api/status', authMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    await bootstrapBots(); 
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const ProfileStateModel = req.isPaper ? PaperProfileState : RealProfileState;
    const OffsetModel = req.isPaper ? PaperOffsetRecord : RealOffsetRecord; 

    let settings = await SettingsModel.findOne({ userId: req.userId });
    if (settings) settings = settings.toObject();

    const userStatuses = {};

    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === req.userId.toString()) {
            userStatuses[profileId] = botData.state;
        }
    }

    if (settings && settings.subAccounts) {
        const subIds = settings.subAccounts.map(s => s._id.toString());
        const dbStates = await ProfileStateModel.find({ profileId: { $in: subIds } });
        dbStates.forEach(dbS => { if (!userStatuses[dbS.profileId]) { userStatuses[dbS.profileId] = { logs: dbS.logs, coinStates: dbS.coinStates }; } });
    }

    const firstOffset = await OffsetModel.findOne({ userId: req.userId }).sort({ timestamp: 1 }).lean();
    const startTime = firstOffset ? firstOffset.timestamp : null;

    res.json({ states: userStatuses, subAccounts: settings ? settings.subAccounts : [], globalSettings: settings, startTime });
});

app.get('/api/offsets', authMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const OffsetModel = req.isPaper ? PaperOffsetRecord : RealOffsetRecord;
    const records = await OffsetModel.find({ 
        userId: req.userId,
        reason: { $not: /(Open Base Position|DCA Step)/i }
    }).sort({ timestamp: -1 }).limit(100);
    res.json(records);
});

// ADMIN: GLOBAL SETTINGS SYNC
app.post('/api/master/global', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const masterUser = await User.findOne({ username: 'webcoin8888' });
        if (!masterUser) return res.status(404).json({ error: "Master user not found" });

        const payload = {
            globalSingleCoinTpPnl: parseFloat(req.body.globalSingleCoinTpPnl) || 0,
            smartOffsetNetProfit: parseFloat(req.body.smartOffsetNetProfit) || 0,
            autoBalanceEquity: req.body.autoBalanceEquity === true, 
            autoBalanceUnrealizedPnlTarget: parseFloat(req.body.autoBalanceUnrealizedPnlTarget) || 0, 
            globalDcaRecoveryTriggerPnl: parseFloat(req.body.globalDcaRecoveryTriggerPnl) || -50
        };

        await RealSettings.findOneAndUpdate({ userId: masterUser._id }, { $set: payload }, { new: true, upsert: true });
        await syncMainSettingsTemplate();

        const allRealUsers = await RealSettings.find({ userId: { $ne: masterUser._id } });
        const allPaperUsers = await PaperSettings.find({ userId: { $ne: masterUser._id } });

        const applyMasterGlobalSync = async (userSettingsDoc, ModelToUse) => {
            const mult = userSettingsDoc.qtyMultiplier || 1;
            let syncPayload = { ...payload };
            
            syncPayload.smartOffsetNetProfit = (syncPayload.smartOffsetNetProfit || 0) * mult;
            syncPayload.globalSingleCoinTpPnl = (syncPayload.globalSingleCoinTpPnl || 0) * mult;
            syncPayload.autoBalanceUnrealizedPnlTarget = (syncPayload.autoBalanceUnrealizedPnlTarget || 0) * mult;
            syncPayload.globalDcaRecoveryTriggerPnl = (syncPayload.globalDcaRecoveryTriggerPnl || -50) * mult;
            
            const newlyUpdated = await ModelToUse.findOneAndUpdate({ userId: userSettingsDoc.userId }, { $set: syncPayload }, { returnDocument: 'after' });
            
            if (newlyUpdated && newlyUpdated.subAccounts) {
                newlyUpdated.subAccounts.forEach(sub => {
                    const profileId = sub._id.toString();
                    if (global.activeBots.has(profileId)) { global.activeBots.get(profileId).globalSettings = newlyUpdated; }
                });
            }
        };

        for (let doc of allRealUsers) await applyMasterGlobalSync(doc, RealSettings);
        for (let doc of allPaperUsers) await applyMasterGlobalSync(doc, PaperSettings);

        res.json({ success: true, message: "Global Config Synchronized!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ADMIN: PROFILE SETTINGS SYNC 
app.post('/api/master/profile/:index', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const masterUser = await User.findOne({ username: 'webcoin8888' });
        if (!masterUser) return res.status(404).json({ error: "Master user not found" });
        
        const doc = await RealSettings.findOne({ userId: masterUser._id });
        if (!doc || !doc.subAccounts || !doc.subAccounts[index]) return res.status(404).json({ error: "Profile not found" });

        const profilePayload = {
            apiKey: req.body.apiKey || '', secret: req.body.secret || '', baseQty: parseFloat(req.body.baseQty) || 1, takeProfitPct: parseFloat(req.body.takeProfitPct) || 5.0,
            takeProfitPnl: parseFloat(req.body.takeProfitPnl) || 0, stopLossPct: -Math.abs(parseFloat(req.body.stopLossPct) || 25.0), triggerDcaPnl: -Math.abs(parseFloat(req.body.triggerDcaPnl) || 2.0), maxContracts: parseInt(req.body.maxContracts) || 1000
        };

        Object.assign(doc.subAccounts[index], profilePayload);
        await doc.save();
        await syncMainSettingsTemplate();

        const applyMasterProfileSync = async (ModelToUse) => {
            const usersDocs = await ModelToUse.find({ userId: { $ne: masterUser._id } });
            for (let uDoc of usersDocs) {
                if (uDoc.subAccounts && uDoc.subAccounts[index]) {
                    const mult = uDoc.qtyMultiplier || 1;
                    const existingUserSub = uDoc.subAccounts[index];
                    
                    existingUserSub.baseQty = (profilePayload.baseQty || 1) * mult; existingUserSub.takeProfitPct = profilePayload.takeProfitPct; existingUserSub.takeProfitPnl = profilePayload.takeProfitPnl;
                    existingUserSub.stopLossPct = profilePayload.stopLossPct; existingUserSub.triggerDcaPnl = (profilePayload.triggerDcaPnl || -2.0) * mult; existingUserSub.maxContracts = profilePayload.maxContracts;
                    
                    await ModelToUse.updateOne({ "subAccounts._id": existingUserSub._id }, { $set: { "subAccounts.$": existingUserSub } });

                    startBot(uDoc.userId.toString(), existingUserSub, uDoc.isPaper).catch(()=>{});
                }
            }
        };

        await applyMasterProfileSync(RealSettings);
        await applyMasterProfileSync(PaperSettings);

        res.json({ success: true, message: `Profile ${index + 1} Array Synchronized!` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/editor-data', authMiddleware, adminMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
        const masterUser = await User.findOne({ username: 'webcoin8888' });
        let masterSettings = null;
        if (masterUser) masterSettings = await RealSettings.findOne({ userId: masterUser._id }).lean();
        res.json({ masterSettings });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 7. FRONTEND UI (ZERO-DEPENDENCY MINIMALIST)
// ==========================================

const FRONTEND_HTML = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '    <meta charset="UTF-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '    <title>NexGen Algo Bot</title>',
    '    <style>',
    '        body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #ededed; margin: 0; padding: 20px; line-height: 1.5; font-size: 14px; }',
    '        * { box-sizing: border-box; }',
    '        h1, h2, h3, h4 { margin-top: 0; font-weight: 600; }',
    '        h1 { border-bottom: 1px solid #333; padding-bottom: 10px; margin-bottom: 20px; }',
    '        nav { display: flex; gap: 10px; border-bottom: 1px solid #333; padding-bottom: 15px; margin-bottom: 20px; flex-wrap: wrap; }',
    '        button { background: #222; color: #fff; border: 1px solid #444; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 13px; }',
    '        button:hover { background: #333; }',
    '        button.active { border-color: #60a5fa; color: #60a5fa; }',
    '        input, select { background: #111; color: #fff; border: 1px solid #333; padding: 6px; border-radius: 4px; width: 100%; margin-bottom: 10px; font-family: inherit; font-size: 13px; }',
    '        input:focus, select:focus { border-color: #60a5fa; outline: none; }',
    '        input:disabled { background: #222; color: #666; cursor: not-allowed; }',
    '        label { display: block; font-size: 12px; color: #aaa; margin-bottom: 4px; text-transform: uppercase; }',
    '        .container { max-width: 1200px; margin: auto; }',
    '        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }',
    '        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }',
    '        .card { background: #121212; border: 1px solid #222; padding: 20px; border-radius: 6px; margin-bottom: 20px; }',
    '        .flex { display: flex; gap: 10px; align-items: center; }',
    '        .flex-between { display: flex; justify-content: space-between; align-items: center; }',
    '        .metric { background: #0f0f0f; padding: 10px; border: 1px solid #222; border-radius: 4px; }',
    '        .metric-label { font-size: 11px; color: #888; text-transform: uppercase; }',
    '        .metric-val { font-size: 18px; font-weight: bold; margin-top: 5px; }',
    '        table { width: 100%; border-collapse: collapse; font-size: 13px; }',
    '        th, td { border: 1px solid #222; padding: 10px; text-align: left; }',
    '        th { background: #111; color: #888; font-weight: normal; text-transform: uppercase; font-size: 11px; }',
    '        tr:hover td { background: #1a1a1a; }',
    '        .text-green { color: #4ade80 !important; }',
    '        .text-red { color: #f87171 !important; }',
    '        .text-blue { color: #60a5fa !important; }',
    '        .text-warning { color: #facc15 !important; }',
    '        .text-muted { color: #666 !important; }',
    '        #logs { height: 350px; overflow-y: auto; background: #000; padding: 10px; font-family: monospace; font-size: 12px; border: 1px solid #222; color: #4ade80; }',
    '        #landing-view, #auth-view, #dashboard-view { display: none; }',
    '        #landing-view { text-align: center; padding: 50px 10px; }',
    '        .checkbox-wrapper { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; cursor: pointer; }',
    '        .checkbox-wrapper input { width: auto; margin: 0; }',
    '        #payment-modal { display:none; position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); background:#111; padding:20px; border:1px solid #333; z-index:100; width:90%; max-width:400px; }',
    '    </style>',
    '</head>',
    '<body>',
    '    <div class="container" id="app">',
    '        <nav>',
    '            <div style="font-weight: bold; font-size: 16px; margin-right: 20px; line-height: 30px;">NexGen Algo</div>',
    '            <div id="nav-actions" class="flex" style="flex-wrap: wrap;"></div>',
    '        </nav>',
    '        ',
    '        <div id="landing-view">',
    '            <h1 style="border:none; font-size: 28px;">Minimal Trading Bot Node</h1>',
    '            <p class="text-muted" style="max-width: 600px; margin: 0 auto 30px;">Automate HTX portfolios with clean execution, low overhead, and dual-mode environment logic.</p>',
    '            <div class="flex" style="justify-content:center; margin-bottom: 40px;">',
    '                <button onclick="navigateTo(\'/register\')">Register Free</button>',
    '                <button onclick="navigateTo(\'/login\')">Login</button>',
    '            </div>',
    '            <div class="grid-2 text-left" style="max-width: 600px; margin: auto;">',
    '                <div class="card">',
    '                    <h3>Paper Mode</h3>',
    '                    <p class="text-muted">Simulate strategies freely.</p>',
    '                    <button style="width:100%" onclick="navigateTo(\'/register\')">Start Paper</button>',
    '                </div>',
    '                <div class="card" style="border-color:#60a5fa;">',
    '                    <h3 class="text-blue">Live Network</h3>',
    '                    <p class="text-muted">Real execution requires payment.</p>',
    '                    <button style="width:100%; border-color:#60a5fa; color:#60a5fa;" onclick="showPaymentModal()">Pay with BTC</button>',
    '                </div>',
    '            </div>',
    '            <h3 style="margin-top: 40px;">Top Nodes</h3>',
    '            <table id="leaderboard-table"></table>',
    '        </div>',
    '',
    '        <div id="payment-modal">',
    '            <h3>Bitcoin Payment</h3>',
    '            <p class="text-muted">Send payment to unlock Live Mode:</p>',
    '            <code style="display:block; background:#000; padding:10px; border:1px dashed #444; margin-bottom:15px; word-wrap:break-word;">bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh</code>',
    '            <label>Transaction ID (TxID)</label>',
    '            <input type="text" id="btc-txid" placeholder="TxID">',
    '            <button style="width:100%; margin-bottom:10px;" onclick="verifyPayment()">Verify</button>',
    '            <button style="width:100%;" onclick="document.getElementById(\'payment-modal\').style.display=\'none\'">Cancel</button>',
    '            <p id="payment-msg" class="text-green" style="margin-top:10px;"></p>',
    '        </div>',
    '',
    '        <div id="auth-view" class="card" style="max-width: 400px; margin: 40px auto;">',
    '            <h2 id="auth-header">Login</h2>',
    '            <label>Username</label><input type="text" id="username">',
    '            <label>Password</label><input type="password" id="password">',
    '            <div id="register-fields" style="display:none; border-top:1px solid #333; padding-top:15px; margin-top:5px;">',
    '                <label>Qty Multiplier</label><input type="number" id="qtyMultiplier" step="0.1" placeholder="1.0">',
    '                <label>Custom Coins (Space separated)</label><input type="text" id="customCoins" placeholder="e.g. BTC ETH">',
    '                <label>Live Access Code (Leave blank for Paper)</label><input type="password" id="authCode">',
    '            </div>',
    '            <button id="auth-submit-btn" style="width:100%; margin-top:15px; padding:10px;">Login</button>',
    '            <div style="text-align:center; margin-top:15px;"><button id="auth-toggle-btn" style="background:transparent; border:none; color:#888;">Switch mode</button></div>',
    '            <p id="auth-msg" style="text-align:center; margin-top:10px;"></p>',
    '        </div>',
    '',
    '        <div id="dashboard-view">',
    '            <div id="editor-tab" style="display:none;">',
    '                <div class="card">',
    '                    <h2>Template Editor (Admin)</h2>',
    '                    <p class="text-muted" style="margin-bottom:20px;">Master node templates map to all clients.</p>',
    '                    <div id="editorGlobalContainer">Loading...</div>',
    '                    <h3 style="margin-top:30px; border-top:1px solid #333; padding-top:20px;">Profile Templates</h3>',
    '                    <div id="editorProfilesContainer">Loading...</div>',
    '                </div>',
    '            </div>',
    '',
    '            <div id="admin-tab" style="display:none;">',
    '                <div class="card">',
    '                    <div class="flex-between" style="margin-bottom:20px;">',
    '                        <h2>Node Management</h2>',
    '                        <button class="text-red" style="border-color:#f87171;" onclick="adminDeleteAllUsers()">Wipe All Clients</button>',
    '                    </div>',
    '                    <div id="adminStatusBanner" style="padding:10px; border:1px solid #333; margin-bottom:20px;">Checking...</div>',
    '                    <div id="adminUsersContainer" style="overflow-x:auto;">Loading...</div>',
    '                </div>',
    '            </div>',
    '',
    '            <div id="offset-tab" style="display:none;">',
    '                <div class="card">',
    '                    <h2>Array V1 Offsets</h2>',
    '                    <div id="liveOffsetsContainer" style="overflow-x:auto;">Waiting for vector data...</div>',
    '                </div>',
    '                <div class="card">',
    '                    <h2>Execution Ledger</h2>',
    '                    <div id="offsetTableContainer" style="overflow-x:auto;">Loading...</div>',
    '                </div>',
    '            </div>',
    '',
    '            <div id="main-tab">',
    '                <div class="grid" style="margin-bottom: 20px;">',
    '                    <div class="metric"><div class="metric-label">Session Realized</div><div class="metric-val text-green" id="globalPnl">$0.00</div></div>',
    '                    <div class="metric"><div class="metric-label">Active / Total</div><div class="metric-val" id="globalWinRate">0 / 0</div></div>',
    '                    <div class="metric"><div class="metric-label">Collateral</div><div class="metric-val text-blue" id="topGlobalMargin">$0.00</div></div>',
    '                    <div class="metric"><div class="metric-label">Net Unrealized</div><div class="metric-val" id="topGlobalUnrealized">$0.00</div></div>',
    '                </div>',
    '                <div class="grid" style="margin-bottom: 20px;">',
    '                    <div class="metric"><div class="metric-label">Est/Hour</div><div class="metric-val text-muted" id="estHour">$0.00</div></div>',
    '                    <div class="metric"><div class="metric-label">Est/Day</div><div class="metric-val text-muted" id="estDay">$0.00</div></div>',
    '                    <div class="metric"><div class="metric-label">Est/Month</div><div class="metric-val text-muted" id="estMonth">$0.00</div></div>',
    '                    <div class="metric"><div class="metric-label">Est/Year</div><div class="metric-val text-muted" id="estYear">$0.00</div></div>',
    '                </div>',
    '',
    '                <div id="user-strategy-display" class="card" style="display:none;">',
    '                    <h3>Active Strategy Parameters</h3>',
    '                    <div class="grid">',
    '                        <div class="metric"><div class="metric-label">Univ. Coin TP</div><div class="metric-val" id="display_globalSingleCoinTpPnl">$0.00</div></div>',
    '                        <div class="metric"><div class="metric-label">V1 Offset Target</div><div class="metric-val" id="display_smartOffsetNetProfit">$0.00</div></div>',
    '                    </div>',
    '                </div>',
    '                <div id="user-autobalance-display" class="card" style="display:none;">',
    '                    <h3>Global DCA Recovery <span style="font-size:11px; font-weight:normal; color:#aaa; text-transform:none;">(Master Switch)</span></h3>',
    '                    <div class="grid" style="margin-bottom:15px;">',
    '                        <div class="metric"><div class="metric-label">Status</div><div class="metric-val" id="display_autoBalanceStatus">-</div></div>',
    '                        <div class="metric"><div class="metric-label">Target Net PNL</div><div class="metric-val text-green" id="display_dcaTarget">$0.00</div></div>',
    '                        <div class="metric"><div class="metric-label">Base Trigger PNL</div><div class="metric-val text-red" id="display_dcaTrigger">-$0.00</div></div>',
    '                        <div class="metric"><div class="metric-label">Active Trigger (Step)</div><div class="metric-val text-warning" id="display_activeDcaTrigger">-$0.00 (Step 0)</div></div>',
    '                    </div>',
    '                </div>',
    '                <div id="user-extremes-display" class="card" style="display:none;">',
    '                    <h3>Live Extremes</h3>',
    '                    <div class="grid">',
    '                        <div class="metric"><div class="metric-label">Top Node</div><div class="metric-val text-green" id="display_highestPnlNode" style="font-size:14px;">-</div></div>',
    '                        <div class="metric"><div class="metric-label">Bottom Node</div><div class="metric-val text-red" id="display_lowestPnlNode" style="font-size:14px;">-</div></div>',
    '                        <div class="metric"><div class="metric-label">V1 Target</div><div class="metric-val text-blue" id="display_v1TargetPeak">$0.00</div></div>',
    '                        <div class="metric"><div class="metric-label">V1 Live</div><div class="metric-val" id="display_v1MaxDetected">$0.00</div></div>',
    '                    </div>',
    '                </div>',
    '',
    '                <div id="advanced-trading-ui" style="display:none;" class="grid-2">',
    '                    <div>',
    '                        <div class="card">',
    '                            <h3>Global Logic</h3>',
    '                            <div class="grid-2">',
    '                                <div><label>Univ. Coin TP ($)</label><input type="number" step="0.0001" id="globalSingleCoinTpPnl"></div>',
    '                                <div><label>V1 Offset Target ($)</label><input type="number" step="0.0001" id="smartOffsetNetProfit"></div>',
    '                            </div>',
    '                            <div style="border-top:1px solid #333; padding-top:15px; margin-top:10px;">',
    '                                <label class="checkbox-wrapper"><input type="checkbox" id="autoBalanceEquity"><span>Enable Global DCA Recovery</span></label>',
    '                                <div class="grid-2">',
    '                                    <div><label>Target Net PNL ($)</label><input type="number" id="autoBalanceUnrealizedPnlTarget"></div>',
    '                                    <div><label>Trigger Net PNL ($)</label><input type="number" id="globalDcaRecoveryTriggerPnl"></div>',
    '                                </div>',
    '                            </div>',
    '                            <button style="width:100%; margin-top:10px;" onclick="saveGlobalSettings()">Deploy Global</button>',
    '                        </div>',
    '',
    '                        <div class="card">',
    '                            <h3>Profiles</h3>',
    '                            <div class="flex" style="margin-bottom:15px;">',
    '                                <select id="subAccountSelect" style="margin:0; flex:1;"></select>',
    '                                <button onclick="loadSubAccount()">Load</button>',
    '                                <button class="text-red" style="border-color:#f87171;" onclick="removeSubAccount()">Del</button>',
    '                            </div>',
    '                            <div class="grid" style="margin-bottom:15px;">',
    '                                <input type="text" id="newSubName" placeholder="Alias">',
    '                                <input type="password" id="newSubKey" placeholder="API Key">',
    '                                <input type="password" id="newSubSecret" placeholder="Secret">',
    '                                <button onclick="addSubAccount()">Add Profile</button>',
    '                            </div>',
    '',
    '                            <div id="settingsContainer" style="display:none; border-top:1px solid #333; padding-top:15px;">',
    '                                <div class="grid-2">',
    '                                    <div><label>API Key</label><input type="password" id="apiKey"></div>',
    '                                    <div><label>Secret</label><input type="password" id="secret"></div>',
    '                                </div>',
    '                                <div class="flex" style="margin-bottom:15px;">',
    '                                    <button style="flex:1; border-color:#4ade80; color:#4ade80;" onclick="globalToggleBot(true)">Start All</button>',
    '                                    <button style="flex:1; border-color:#f87171; color:#f87171;" onclick="globalToggleBot(false)">Stop All</button>',
    '                                </div>',
    '                                <div class="grid-2">',
    '                                    <div><label>Bias</label><select id="side"><option value="long">Long</option><option value="short">Short</option></select></div>',
    '                                    <div><label>Leverage</label><input type="text" id="leverage" disabled value="Auto"></div>',
    '                                </div>',
    '                                <div class="grid-2">',
    '                                    <div><label>Base Qty</label><input type="number" id="baseQty"></div>',
    '                                    <div><label>Max Ceiling</label><input type="number" id="maxContracts"></div>',
    '                                </div>',
    '                                <div class="grid-2">',
    '                                    <div><label>Local TP %</label><input type="number" step="0.1" id="takeProfitPct"></div>',
    '                                    <div><label>Local TP $</label><input type="number" step="0.0001" id="takeProfitPnl"></div>',
    '                                </div>',
    '                                <div class="grid-2">',
    '                                    <div><label>Local SL %</label><input type="number" step="0.1" id="stopLossPct"></div>',
    '                                    <div><label>Local DCA $</label><input type="number" step="0.0001" id="triggerDcaPnl"></div>',
    '                                </div>',
    '                                <div style="border-top:1px solid #333; padding-top:15px; margin-top:5px;">',
    '                                    <div class="grid-2" style="margin-bottom:10px;">',
    '                                        <select id="predefSide"><option value="evenLong">Even L/Odd S</option><option value="oddLong">Odd L/Even S</option><option value="allLong">All L</option><option value="allShort">All S</option></select>',
    '                                        <select id="predefStatus"><option value="started">Active</option><option value="stopped">Halted</option></select>',
    '                                    </div>',
    '                                    <button style="width:100%; margin-bottom:15px;" onclick="addPredefinedList()">Inject Standard Matrix</button>',
    '                                    <div class="flex" style="margin-bottom:10px;">',
    '                                        <input type="text" id="newCoinSymbol" placeholder="COIN/USDT:USDT" style="margin:0;">',
    '                                        <button onclick="addCoinUI()">Add</button>',
    '                                    </div>',
    '                                    <div id="coinsListContainer" style="max-height:200px; overflow-y:auto; margin-bottom:15px;"></div>',
    '                                    <button style="width:100%; border-color:#60a5fa; color:#60a5fa;" onclick="saveSettings()">Write to DB</button>',
    '                                </div>',
    '                            </div>',
    '                        </div>',
    '                    </div>',
    '                    <div>',
    '                        <div class="card">',
    '                            <h3>Telemetry</h3>',
    '                            <div class="grid-2" style="margin-bottom:15px;">',
    '                                <div class="metric"><div class="metric-label">Profile Rlz</div><div class="metric-val" id="profilePnl">$0.00</div></div>',
    '                                <div class="metric"><div class="metric-label">Profile Margin</div><div class="metric-val text-blue" id="profileMargin">$0.00</div></div>',
    '                            </div>',
    '                            <div id="dashboardStatusContainer" style="max-height: 400px; overflow-y:auto; margin-bottom:15px;">Awaiting Engine...</div>',
    '                            <h3>Output Stream</h3>',
    '                            <div id="logs"></div>',
    '                        </div>',
    '                    </div>',
    '                </div>',
    '',
    '                <div class="card" style="margin-top:20px;">',
    '                    <h3>Recent Closed Trades</h3>',
    '                    <div style="overflow-x:auto;">',
    '                        <table>',
    '                            <tr><th>Time</th><th>Coin</th><th>ROI %</th><th>PNL</th><th>Open Price</th><th>Close Price</th><th>Reason</th></tr>',
    '                            <tbody id="pretty-log-tbody"><tr><td colspan="7" class="text-muted text-center">Empty</td></tr></tbody>',
    '                        </table>',
    '                    </div>',
    '                </div>',
    '                <div class="card">',
    '                    <h3>Active Profiles</h3>',
    '                    <div style="overflow-x:auto;">',
    '                        <table>',
    '                            <tr><th>Profile Name</th><th>Env</th><th>Status</th><th>Bias</th><th>PNL</th></tr>',
    '                            <tbody id="active-profiles-tbody"><tr><td colspan="5" class="text-muted text-center">Loading...</td></tr></tbody>',
    '                        </table>',
    '                    </div>',
    '                </div>',
    '            </div>',
    '        </div>',
    '    </div>',
    '',
    '    <script>',
    '        let token = localStorage.getItem(\'token\');',
    '        let isPaperUser = true; ',
    '        let myUsername = \'\';',
    '        let statusInterval = null;',
    '        let mySubAccounts = [];',
    '        let myGlobalSingleCoinTpPnl = 0;',
    '        let mySmartOffsetNetProfit = 0;',
    '        let myAutoBalanceEquity = false;',
    '        let myAutoBalanceUnrealizedPnlTarget = 0;',
    '        let myGlobalDcaRecoveryTriggerPnl = -50;',
    '        let currentProfileIndex = -1;',
    '        let myCoins = [];',
    '        const PREDEFINED_COINS = ["OP", "BIGTIME", "MOVE", "SSV", "COAI", "TIA", "MERL", "MASK", "PYTH", "ETHFI", "CFX", "MEME", "LUNA", "STEEM", "BERA", "2Z", "FIL", "APT", "1INCH", "ARB", "XPL", "ENA", "MMT", "AXS", "TON", "CAKE", "BSV", "JUP", "WIF", "LIGHT", "PI", "SUSHI", "LPT", "CRV", "TAO", "ORDI", "YFI", "LA", "ICP", "FTT", "GIGGLE", "LDO", "OPN", "INJ", "SNX", "DASH", "WLD", "KAITO", "TRUMP", "WAVES", "ZEN", "ENS", "ASTER", "VIRTUAL"];',
    '',
    '        const fmtC = v => (v>=0?"+$":"-$")+Math.abs(v).toFixed(4);',
    '        const fmtP = p => { if(!p) return "-"; if(p<0.001) return p.toFixed(8); if(p<1) return p.toFixed(6); return p.toFixed(4); };',
    '',
    '        function navigateTo(path) {',
    '            window.history.pushState({}, \'\', path);',
    '            route();',
    '        }',
    '        window.onpopstate = route;',
    '',
    '        function route() {',
    '            const path = window.location.pathname;',
    '            const isLoggedIn = !!token;',
    '            document.getElementById(\'landing-view\').style.display = \'none\';',
    '            document.getElementById(\'auth-view\').style.display = \'none\';',
    '            document.getElementById(\'dashboard-view\').style.display = \'none\';',
    '            if (isLoggedIn) {',
    '                if ([\'/\', \'/login\', \'/register\'].includes(path)) return navigateTo(\'/dashboard\');',
    '                document.getElementById(\'dashboard-view\').style.display = \'block\';',
    '                updateUIMode();',
    '                [\'main-tab\', \'offset-tab\', \'admin-tab\', \'editor-tab\'].forEach(t => document.getElementById(t).style.display = \'none\');',
    '                document.querySelectorAll(\'.nav-btn\').forEach(b => b.classList.remove(\'active\'));',
    '                if (path === \'/admin\') { document.getElementById(\'admin-tab\').style.display = \'block\'; document.getElementById(\'btn-tab-admin\')?.classList.add(\'active\'); loadAdminData(); }',
    '                else if (path === \'/editor\') { document.getElementById(\'editor-tab\').style.display = \'block\'; document.getElementById(\'btn-tab-editor\')?.classList.add(\'active\'); loadMasterEditor(); }',
    '                else if (path === \'/matrix-v1\') { document.getElementById(\'offset-tab\').style.display = \'block\'; document.getElementById(\'btn-tab-offsets\')?.classList.add(\'active\'); loadOffsets(); }',
    '                else { document.getElementById(\'main-tab\').style.display = \'block\'; document.getElementById(\'btn-tab-main\')?.classList.add(\'active\'); if (path !== \'/dashboard\') window.history.replaceState({}, \'\', \'/dashboard\'); }',
    '            } else {',
    '                if (path === \'/login\') { document.getElementById(\'auth-view\').style.display = \'block\'; setupAuthUI(\'login\'); }',
    '                else if (path === \'/register\') { document.getElementById(\'auth-view\').style.display = \'block\'; setupAuthUI(\'register\'); }',
    '                else { if (path !== \'/\') window.history.replaceState({}, \'\', \'/\'); document.getElementById(\'landing-view\').style.display = \'block\'; updateLoggedOutNav(); fetchLeaderboard(); }',
    '            }',
    '        }',
    '',
    '        function setupAuthUI(mode) {',
    '            const header = document.getElementById(\'auth-header\');',
    '            const btn = document.getElementById(\'auth-submit-btn\');',
    '            const toggleBtn = document.getElementById(\'auth-toggle-btn\');',
    '            const regFields = document.getElementById(\'register-fields\');',
    '            if(mode === \'register\') {',
    '                header.innerText = "Deploy Instance";',
    '                btn.innerText = "Register";',
    '                btn.onclick = () => executeAuth(\'register\');',
    '                toggleBtn.innerText = "Existing? Login here";',
    '                toggleBtn.onclick = () => navigateTo(\'/login\');',
    '                regFields.style.display = \'block\';',
    '            } else {',
    '                header.innerText = "Secure Login";',
    '                btn.innerText = "Login";',
    '                btn.onclick = () => executeAuth(\'login\');',
    '                toggleBtn.innerText = "New? Register here";',
    '                toggleBtn.onclick = () => navigateTo(\'/register\');',
    '                regFields.style.display = \'none\';',
    '            }',
    '        }',
    '',
    '        async function fetchLeaderboard() {',
    '            try {',
    '                const res = await fetch(\'/api/leaderboard\');',
    '                if(res.ok) {',
    '                    const users = await res.json();',
    '                    let html = "<tr><th>Rank</th><th>Alias</th><th>Env</th><th>Net PNL</th></tr>";',
    '                    if(users.length === 0) html += "<tr><td colspan=\'4\' class=\'text-muted text-center\'>No active nodes</td></tr>";',
    '                    users.forEach((u, i) => html += "<tr><td>#" + (i+1) + "</td><td>" + u.username + "</td><td><span class=\'text-green\'>LIVE</span></td><td class=\'text-green\'>+$" + u.pnl.toFixed(2) + "</td></tr>");',
    '                    document.getElementById("leaderboard-table").innerHTML = html;',
    '                }',
    '            } catch(e) {}',
    '        }',
    '',
    '        async function checkAuth() {',
    '            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }',
    '            if (token) {',
    '                try {',
    '                    const meRes = await fetch(\'/api/me\', { headers: { \'Authorization\': \'Bearer \' + token } });',
    '                    if (!meRes.ok) throw new Error("Invalid token");',
    '                    const meData = await meRes.json();',
    '                    isPaperUser = meData.isPaper;',
    '                    myUsername = meData.username;',
    '                    route();',
    '                    if (myUsername !== \'webcoin8888\') {',
    '                        await fetchSettings();',
    '                        await loadStatus();',
    '                        await loadOffsets();',
    '                        statusInterval = setInterval(() => { loadStatus(); loadOffsets(); }, 5000);',
    '                    }',
    '                } catch(e) { logout(); }',
    '            } else { route(); }',
    '        }',
    '',
    '        function updateLoggedOutNav() {',
    '            document.getElementById(\'nav-actions\').innerHTML = \'<button onclick="navigateTo(\\\'/login\\\')">Login</button><button style="border-color:#60a5fa; color:#60a5fa;" onclick="navigateTo(\\\'/register\\\')">Register</button>\';',
    '        }',
    '',
    '        function updateUIMode() {',
    '            const navActions = document.getElementById(\'nav-actions\');',
    '            let navHtml = \'\';',
    '            if (myUsername === \'webcoin8888\') {',
    '                navHtml += \'<button class="nav-btn" id="btn-tab-editor" onclick="navigateTo(\\\'/editor\\\')">Templates</button>\';',
    '                navHtml += \'<button class="nav-btn" id="btn-tab-admin" onclick="navigateTo(\\\'/admin\\\')">Users</button>\';',
    '                navHtml += \'<button class="nav-btn" id="btn-tab-main" onclick="navigateTo(\\\'/dashboard\\\')">Matrix Hub</button>\';',
    '                navHtml += \'<button class="nav-btn" id="btn-tab-offsets" onclick="navigateTo(\\\'/matrix-v1\\\')">Array V1</button>\';',
    '                navHtml += \'<button style="margin-left:auto; border-color:#f87171; color:#f87171;" onclick="logout()">Logout</button>\';',
    '                navActions.innerHTML = navHtml;',
    '                document.getElementById(\'advanced-trading-ui\').style.display = \'flex\';',
    '                [\'user-strategy-display\', \'user-extremes-display\', \'user-autobalance-display\'].forEach(id => { const el=document.getElementById(id); if(el) el.style.display=\'none\';});',
    '            } else {',
    '                navHtml += isPaperUser ? \'<span style="padding:4px 8px; font-size:12px; border:1px solid #60a5fa; color:#60a5fa; border-radius:3px;">PAPER</span>\' : \'<span style="padding:4px 8px; font-size:12px; border:1px solid #4ade80; color:#4ade80; border-radius:3px;">LIVE</span>\';',
    '                navHtml += \'<button class="nav-btn" id="btn-tab-main" onclick="navigateTo(\\\'/dashboard\\\')">Dashboard</button>\';',
    '                navHtml += \'<button style="margin-left:auto; border-color:#f87171; color:#f87171;" onclick="logout()">Logout</button>\';',
    '                navActions.innerHTML = navHtml;',
    '                document.getElementById(\'advanced-trading-ui\').style.display = \'none\';',
    '                [\'user-strategy-display\', \'user-extremes-display\', \'user-autobalance-display\'].forEach(id => { const el=document.getElementById(id); if(el) el.style.display=\'block\';});',
    '            }',
    '        }',
    '',
    '        function showPaymentModal() { document.getElementById(\'payment-modal\').style.display = \'block\'; }',
    '        function verifyPayment() {',
    '            const txid = document.getElementById(\'btc-txid\').value.trim();',
    '            if(!txid) return alert("Enter TxID");',
    '            document.getElementById(\'payment-msg\').innerHTML = "Verified! Access Code: <b>payed</b><br><br><button onclick=\'document.getElementById(\\"payment-modal\\").style.display=\\"none\\"; navigateTo(\\"/register\\"); setTimeout(()=>document.getElementById(\\"authCode\\").value=\\"payed\\", 100);\'>Proceed</button>";',
    '        }',
    '',
    '        async function executeAuth(action) {',
    '            const username = document.getElementById(\'username\').value;',
    '            const password = document.getElementById(\'password\').value;',
    '            const msgEl = document.getElementById(\'auth-msg\');',
    '            msgEl.innerText = "Connecting..."; msgEl.className = "text-muted";',
    '            const bodyObj = { username, password };',
    '            if (action === \'register\') { ',
    '                bodyObj.qtyMultiplier = document.getElementById(\'qtyMultiplier\')?.value || 1;',
    '                bodyObj.customCoins = document.getElementById(\'customCoins\')?.value || \'\';',
    '                bodyObj.authCode = document.getElementById(\'authCode\')?.value.trim() || \'\';',
    '            }',
    '            try {',
    '                const res = await fetch(\'/api/\' + action, { method: \'POST\', headers: { \'Content-Type\': \'application/json\' }, body: JSON.stringify(bodyObj) });',
    '                const data = await res.json();',
    '                if (data.token) { token = data.token; localStorage.setItem(\'token\', token); msgEl.innerText = ""; await checkAuth(); } ',
    '                else { msgEl.innerText = data.error || data.message; msgEl.className = data.success ? \'text-green\' : \'text-red\'; }',
    '            } catch (e) { msgEl.innerText = "Relay failed."; msgEl.className = "text-red"; }',
    '        }',
    '',
    '        async function closeAllPositions() {',
    '            if (isPaperUser) return alert("Paper Accounts cannot force close.");',
    '            if (!confirm("FORCE CLOSE ALL?")) return;',
    '            const res = await fetch(\'/api/close-all\', { method: \'POST\', headers: { \'Authorization\': \'Bearer \' + token } });',
    '            const data = await res.json();',
    '            alert(data.success ? data.message : "Error: " + data.error);',
    '        }',
    '',
    '        async function closeSinglePosition(symbol, profileId) {',
    '            if(!confirm("Close " + symbol + "?")) return;',
    '            try {',
    '                const res = await fetch(\'/api/close-position\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token }, body: JSON.stringify({ symbol, profileId }) });',
    '                const data = await res.json();',
    '                if(data.success) { alert("Closed"); loadStatus(); loadOffsets(); } else alert("Error: " + data.error);',
    '            } catch(e) { alert("Error."); }',
    '        }',
    '',
    '        async function loadMasterEditor() {',
    '            try {',
    '                const res = await fetch(\'/api/admin/editor-data\', { headers: { \'Authorization\': \'Bearer \' + token } });',
    '                const data = await res.json();',
    '                const masterSettings = data.masterSettings;',
    '                if (!masterSettings) { document.getElementById(\'editorGlobalContainer\').innerHTML = \'<p class="text-red">Missing config.</p>\'; return; }',
    '                let globalHtml = \'<div class="grid-2"><div><label>Univ. Coin TP ($)</label><input type="number" step="0.0001" id="e_globalSingleCoinTpPnl" value="\' + (masterSettings.globalSingleCoinTpPnl||0) + \'"></div></div>\';',
    '                globalHtml += \'<div style="margin-top:10px; border-top:1px solid #333; padding-top:10px;"><label class="checkbox-wrapper"><input type="checkbox" id="e_autoBalanceEquity" \' + (masterSettings.autoBalanceEquity ? "checked" : "") + \'><span>Enable Global DCA Recovery</span></label>\';',
    '                globalHtml += \'<div class="grid-2"><div><label>Target Net PNL ($)</label><input type="number" id="e_autoBalanceUnrealizedPnlTarget" value="\' + (masterSettings.autoBalanceUnrealizedPnlTarget||0) + \'"></div><div><label>Base Trigger PNL ($)</label><input type="number" id="e_globalDcaRecoveryTriggerPnl" value="\' + (masterSettings.globalDcaRecoveryTriggerPnl||-50) + \'"></div></div></div>\';',
    '                globalHtml += \'<div class="grid-2" style="margin-top:10px;"><div><label>V1 Offset Target ($)</label><input type="number" step="0.0001" id="e_smartOffsetNetProfit" value="\' + (masterSettings.smartOffsetNetProfit||0) + \'"></div></div>\';',
    '                globalHtml += \'<button style="width:100%; margin-top:15px; border-color:#60a5fa; color:#60a5fa;" onclick="saveMasterGlobalSettings()">Overwrite & Sync Global</button><div id="e_globalMsg" style="margin-top:10px;"></div>\';',
    '                document.getElementById(\'editorGlobalContainer\').innerHTML = globalHtml;',
    '                let profilesHtml = \'\';',
    '                if (masterSettings.subAccounts && masterSettings.subAccounts.length > 0) {',
    '                    masterSettings.subAccounts.forEach((sub, i) => {',
    '                        profilesHtml += \'<div class="metric" style="margin-bottom:20px;">\';',
    '                        profilesHtml += \'<div class="flex-between" style="margin-bottom:10px;"><b>[\' + (i+1) + \'] \' + sub.name + \'</b><span class="text-muted">\' + (sub.side||"long").toUpperCase() + \'</span></div>\';',
    '                        profilesHtml += \'<div class="grid-2"><div><label>API Key</label><input type="text" id="p_\' + i + \'_apiKey" value="\' + (sub.apiKey||\'\') + \'"></div><div><label>Secret</label><input type="text" id="p_\' + i + \'_secret" value="\' + (sub.secret||\'\') + \'"></div></div>\';',
    '                        profilesHtml += \'<div style="overflow-x:auto;"><table><tr><th>Base</th><th>TP %</th><th>TP $</th><th>SL %</th><th>DCA $</th><th>Max</th></tr><tr><td><input type="number" id="p_\' + i + \'_baseQty" value="\' + (sub.baseQty||1) + \'"></td><td><input type="number" step="0.1" id="p_\' + i + \'_takeProfitPct" value="\' + (sub.takeProfitPct||5) + \'"></td><td><input type="number" step="0.0001" id="p_\' + i + \'_takeProfitPnl" value="\' + (sub.takeProfitPnl||0) + \'"></td><td><input type="number" step="0.1" id="p_\' + i + \'_stopLossPct" value="\' + (sub.stopLossPct||-25) + \'"></td><td><input type="number" step="0.0001" id="p_\' + i + \'_triggerDcaPnl" value="\' + (sub.triggerDcaPnl||-2) + \'"></td><td><input type="number" id="p_\' + i + \'_maxContracts" value="\' + (sub.maxContracts||1000) + \'"></td></tr></table></div>\';',
    '                        profilesHtml += \'<button style="width:100%; margin-top:10px;" onclick="saveMasterProfile(\' + i + \')">Sync Template \' + (i+1) + \'</button><div id="p_\' + i + \'_msg" style="margin-top:5px;"></div></div>\';',
    '                    });',
    '                }',
    '                document.getElementById(\'editorProfilesContainer\').innerHTML = profilesHtml;',
    '            } catch (e) { document.getElementById(\'editorGlobalContainer\').innerHTML = \'<p class="text-red">Error loading.</p>\'; }',
    '        }',
    '',
    '        async function saveMasterGlobalSettings() {',
    '            const getVal = (id, def) => { const el = document.getElementById(id); return el && el.value !== \'\' ? parseFloat(el.value) : def; };',
    '            const payload = {',
    '                globalSingleCoinTpPnl: getVal(\'e_globalSingleCoinTpPnl\', 0), smartOffsetNetProfit: getVal(\'e_smartOffsetNetProfit\', 0),',
    '                autoBalanceEquity: document.getElementById(\'e_autoBalanceEquity\')?.checked||false, autoBalanceUnrealizedPnlTarget: getVal(\'e_autoBalanceUnrealizedPnlTarget\', 0), globalDcaRecoveryTriggerPnl: getVal(\'e_globalDcaRecoveryTriggerPnl\', -50)',
    '            };',
    '            const res = await fetch(\'/api/master/global\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token }, body: JSON.stringify(payload) });',
    '            const data = await res.json();',
    '            const msgDiv = document.getElementById(\'e_globalMsg\');',
    '            if(msgDiv) { msgDiv.innerText = data.success ? "Synced!" : "Error"; msgDiv.className = data.success ? "text-green" : "text-red"; setTimeout(()=>msgDiv.innerText=\'\', 3000); }',
    '        }',
    '',
    '        async function saveMasterProfile(index) {',
    '            const getVal = (id, def) => { const el = document.getElementById(id); return el && el.value !== \'\' ? parseFloat(el.value) : def; };',
    '            const payload = {',
    '                apiKey: document.getElementById(\'p_\' + index + \'_apiKey\')?.value || \'\', secret: document.getElementById(\'p_\' + index + \'_secret\')?.value || \'\',',
    '                baseQty: getVal(\'p_\' + index + \'_baseQty\', 1), takeProfitPct: getVal(\'p_\' + index + \'_takeProfitPct\', 5), takeProfitPnl: getVal(\'p_\' + index + \'_takeProfitPnl\', 0),',
    '                stopLossPct: getVal(\'p_\' + index + \'_stopLossPct\', -25), triggerDcaPnl: getVal(\'p_\' + index + \'_triggerDcaPnl\', -2), maxContracts: getVal(\'p_\' + index + \'_maxContracts\', 1000)',
    '            };',
    '            const res = await fetch(\'/api/master/profile/\' + index, { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token }, body: JSON.stringify(payload) });',
    '            const data = await res.json();',
    '            const msgDiv = document.getElementById(\'p_\' + index + \'_msg\');',
    '            if(msgDiv) { msgDiv.innerText = data.success ? "Synced!" : "Error"; msgDiv.className = data.success ? "text-green" : "text-red"; setTimeout(()=>msgDiv.innerText=\'\', 3000); }',
    '        }',
    '',
    '        async function loadAdminData() {',
    '            try {',
    '                const statusRes = await fetch(\'/api/admin/status\', { headers: { \'Authorization\': \'Bearer \' + token } });',
    '                const statusData = await statusRes.json();',
    '                const banner = document.getElementById(\'adminStatusBanner\');',
    '                if (statusData.templateSafe && statusData.webcoinSafe) { banner.style.borderColor = \'#4ade80\'; banner.innerHTML = \'<span class="text-green">System Safe</span>\'; }',
    '                else { banner.style.borderColor = \'#f87171\'; banner.innerHTML = \'<span class="text-red">Template Compromised!</span>\'; }',
    '                ',
    '                const usersRes = await fetch(\'/api/admin/users\', { headers: { \'Authorization\': \'Bearer \' + token } });',
    '                const users = await usersRes.json();',
    '                let html = \'<table><tr><th>Client</th><th>Pass</th><th>Env</th><th>PNL</th><th>Cycle</th><th>Actions</th></tr>\';',
    '                if (users.length === 0) { html += \'<tr><td colspan="6" class="text-muted text-center">No clients</td></tr>\'; }',
    '                else {',
    '                    users.forEach(u => {',
    '                        const mode = u.isPaper ? \'<span class="text-blue">PAPER</span>\' : \'<span class="text-green">LIVE</span>\';',
    '                        const pnlColor = u.realizedPnl >= 0 ? \'text-green\' : \'text-red\';',
    '                        const cycle = u.cyclePauseEnabled ? (u.cycleCurrentState === "active" ? "<span class=\'text-green\'>ACT</span>" : "<span class=\'text-warning\'>PAUS</span>") : "<span class=\'text-muted\'>OFF</span>";',
    '                        html += \'<tr><td>\' + u.username + \'</td><td>\' + u.plainPassword + \'</td><td>\' + mode + \'</td><td class="\' + pnlColor + \'">$\' + u.realizedPnl.toFixed(2) + \'</td><td>\' + cycle + \'</td>\' +',
    '                            \'<td><button onclick="document.getElementById(\\\'cycle_row_\' + u._id + \'\\\').style.display=\\\'table-row\\\'">Cyc</button> <button onclick="adminImportProfiles(\\\'\' + u._id + \'\\\')">Over</button> <button onclick="adminResetPnl(\\\'\' + u._id + \'\\\')">0 PNL</button> <button class="text-red" onclick="adminCloseAll(\\\'\' + u._id + \'\\\')">Kill</button> <button class="text-red" onclick="adminDeleteUser(\\\'\' + u._id + \'\\\')">Del</button></td></tr>\';',
    '                        html += \'<tr id="cycle_row_\' + u._id + \'" style="display:none;"><td colspan="6"><div class="flex">Pause Min: <input style="width:60px;" type="number" id="pause_min_\' + u._id + \'" value="\' + u.cyclePauseMinutes + \'"> Run Min: <input style="width:60px;" type="number" id="resume_min_\' + u._id + \'" value="\' + u.cycleResumeMinutes + \'"> <select style="width:80px;" id="cycle_en_\' + u._id + \'"><option value="true" \' + (u.cyclePauseEnabled?"selected":"") + \'>ON</option><option value="false" \' + (!u.cyclePauseEnabled?"selected":"") + \'>OFF</option></select><button onclick="adminSaveCycle(\\\'\' + u._id + \'\\\')">Save</button></div></td></tr>\';',
    '                    });',
    '                }',
    '                html += \'</table>\';',
    '                document.getElementById(\'adminUsersContainer\').innerHTML = html;',
    '            } catch (e) {}',
    '        }',
    '',
    '        async function adminSaveCycle(id) {',
    '            const enabled = document.getElementById("cycle_en_" + id).value === "true";',
    '            const pauseMinutes = document.getElementById("pause_min_" + id).value;',
    '            const resumeMinutes = document.getElementById("resume_min_" + id).value;',
    '            const res = await fetch("/api/admin/users/" + id + "/cycle", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token }, body: JSON.stringify({ enabled, pauseMinutes, resumeMinutes }) });',
    '            const data = await res.json(); if(data.success) loadAdminData(); else alert("Error");',
    '        }',
    '        async function adminImportProfiles(id) { if(!confirm("Overwrite?")) return; await fetch(\'/api/admin/users/\' + id + \'/import\', { method:\'POST\', headers:{\'Authorization\':\'Bearer \'+token} }); loadAdminData(); }',
    '        async function adminResetPnl(id) { if(!confirm("Reset?")) return; await fetch(\'/api/admin/users/\' + id + \'/reset-pnl\', { method:\'POST\', headers:{\'Authorization\':\'Bearer \'+token} }); loadAdminData(); }',
    '        async function adminCloseAll(id) { if(!confirm("Close ALL for user?")) return; await fetch(\'/api/admin/users/\' + id + \'/close-all\', { method:\'POST\', headers:{\'Authorization\':\'Bearer \'+token} }); loadAdminData(); }',
    '        async function adminDeleteUser(id) { if(!confirm("Delete?")) return; await fetch(\'/api/admin/users/\' + id, { method:\'DELETE\', headers:{\'Authorization\':\'Bearer \'+token} }); loadAdminData(); }',
    '        async function adminDeleteAllUsers() { if(!confirm("WIPE ALL?")) return; await fetch(\'/api/admin/users\', { method:\'DELETE\', headers:{\'Authorization\':\'Bearer \'+token} }); loadAdminData(); }',
    '',
    '        function logout() { localStorage.removeItem(\'token\'); token = null; if (statusInterval) clearInterval(statusInterval); navigateTo(\'/\'); window.location.reload(); }',
    '',
    '        async function fetchSettings() {',
    '            try {',
    '                const res = await fetch(\'/api/settings\', { headers: { \'Authorization\': \'Bearer \' + token } });',
    '                if (res.status === 401 || res.status === 403) return logout();',
    '                const config = await res.json();',
    '                myGlobalSingleCoinTpPnl = config.globalSingleCoinTpPnl || 0;',
    '                mySmartOffsetNetProfit = config.smartOffsetNetProfit || 0;',
    '                myAutoBalanceEquity = config.autoBalanceEquity || false;',
    '                myAutoBalanceUnrealizedPnlTarget = config.autoBalanceUnrealizedPnlTarget || 0;',
    '                myGlobalDcaRecoveryTriggerPnl = config.globalDcaRecoveryTriggerPnl || -50;',
    '                const setVal = (id, val) => { const el = document.getElementById(id); if(el) el.value = val; };',
    '                setVal(\'globalSingleCoinTpPnl\', myGlobalSingleCoinTpPnl);',
    '                setVal(\'smartOffsetNetProfit\', mySmartOffsetNetProfit);',
    '                if(document.getElementById(\'autoBalanceEquity\')) document.getElementById(\'autoBalanceEquity\').checked = myAutoBalanceEquity;',
    '                setVal(\'autoBalanceUnrealizedPnlTarget\', myAutoBalanceUnrealizedPnlTarget);',
    '                setVal(\'globalDcaRecoveryTriggerPnl\', myGlobalDcaRecoveryTriggerPnl);',
    '                ',
    '                const setTxt = (id, txt) => { const el=document.getElementById(id); if(el) el.innerText=txt; };',
    '                setTxt(\'display_globalSingleCoinTpPnl\', fmtC(myGlobalSingleCoinTpPnl));',
    '                setTxt(\'display_smartOffsetNetProfit\', fmtC(mySmartOffsetNetProfit));',
    '                setTxt(\'display_dcaTarget\', fmtC(myAutoBalanceUnrealizedPnlTarget));',
    '                setTxt(\'display_dcaTrigger\', fmtC(myGlobalDcaRecoveryTriggerPnl));',
    '',
    '                const abStatus = document.getElementById(\'display_autoBalanceStatus\');',
    '                if(abStatus) abStatus.innerHTML = myAutoBalanceEquity ? \'<span class="text-green">ON</span>\' : \'<span class="text-muted">OFF</span>\';',
    '',
    '                mySubAccounts = config.subAccounts || [];',
    '                renderSubAccounts();',
    '                if (mySubAccounts.length > 0) { document.getElementById(\'subAccountSelect\').value = 0; loadSubAccount(); } ',
    '                else { currentProfileIndex = -1; document.getElementById(\'settingsContainer\').style.display = \'none\'; }',
    '            } catch(e) {}',
    '        }',
    '',
    '        async function saveGlobalSettings() {',
    '            const getVal = (id, def) => { const el = document.getElementById(id); return el && el.value !== \'\' ? parseFloat(el.value) : def; };',
    '            myGlobalSingleCoinTpPnl = getVal(\'globalSingleCoinTpPnl\', 0);',
    '            mySmartOffsetNetProfit = getVal(\'smartOffsetNetProfit\', 0);',
    '            myAutoBalanceEquity = document.getElementById(\'autoBalanceEquity\')?.checked || false;',
    '            myAutoBalanceUnrealizedPnlTarget = getVal(\'autoBalanceUnrealizedPnlTarget\', 0);',
    '            myGlobalDcaRecoveryTriggerPnl = getVal(\'globalDcaRecoveryTriggerPnl\', -50);',
    '            const data = { subAccounts: mySubAccounts, globalSingleCoinTpPnl: myGlobalSingleCoinTpPnl, smartOffsetNetProfit: mySmartOffsetNetProfit, autoBalanceEquity: myAutoBalanceEquity, autoBalanceUnrealizedPnlTarget: myAutoBalanceUnrealizedPnlTarget, globalDcaRecoveryTriggerPnl: myGlobalDcaRecoveryTriggerPnl };',
    '            await fetch(\'/api/settings\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token }, body: JSON.stringify(data) });',
    '        }',
    '',
    '        function renderSubAccounts() {',
    '            const select = document.getElementById(\'subAccountSelect\');',
    '            if(!select) return;',
    '            select.innerHTML = mySubAccounts.length ? \'\' : \'<option value="">Empty</option>\';',
    '            mySubAccounts.forEach((sub, i) => select.innerHTML += \'<option value="\' + i + \'">[\' + (i+1) + \'] \' + sub.name + \'</option>\');',
    '        }',
    '',
    '        async function addSubAccount() {',
    '            const name = document.getElementById(\'newSubName\').value.trim();',
    '            const key = document.getElementById(\'newSubKey\').value.trim();',
    '            const secret = document.getElementById(\'newSubSecret\').value.trim();',
    '            if(!name || (!isPaperUser && (!key || !secret))) return alert("Keys required.");',
    '            mySubAccounts.push({ name, apiKey: isPaperUser ? "PAPER" : key, secret: isPaperUser ? "PAPER" : secret, side: \'long\', leverage: 10, baseQty: 1, takeProfitPct: 5, takeProfitPnl: 0, stopLossPct: -25, triggerDcaPnl: -2, maxContracts: 1000, realizedPnl: 0, coins: [] });',
    '            await saveSettings(true);',
    '            document.getElementById(\'newSubName\').value = \'\'; document.getElementById(\'newSubKey\').value = \'\'; document.getElementById(\'newSubSecret\').value = \'\';',
    '            renderSubAccounts(); document.getElementById(\'subAccountSelect\').value = mySubAccounts.length - 1; loadSubAccount();',
    '        }',
    '',
    '        function loadSubAccount() {',
    '            const index = parseInt(document.getElementById(\'subAccountSelect\').value);',
    '            if(isNaN(index) || index < 0) return;',
    '            currentProfileIndex = index;',
    '            const profile = mySubAccounts[index];',
    '            document.getElementById(\'settingsContainer\').style.display = \'block\';',
    '            document.getElementById(\'apiKey\').value = isPaperUser ? "PAPER" : (profile.apiKey||\'\'); document.getElementById(\'apiKey\').disabled = isPaperUser;',
    '            document.getElementById(\'secret\').value = isPaperUser ? "PAPER" : (profile.secret||\'\'); document.getElementById(\'secret\').disabled = isPaperUser;',
    '            document.getElementById(\'side\').value = profile.side || \'long\';',
    '            document.getElementById(\'baseQty\').value = profile.baseQty || 1;',
    '            document.getElementById(\'takeProfitPct\').value = profile.takeProfitPct || 5;',
    '            document.getElementById(\'takeProfitPnl\').value = profile.takeProfitPnl || 0;',
    '            document.getElementById(\'stopLossPct\').value = profile.stopLossPct || -25;',
    '            document.getElementById(\'triggerDcaPnl\').value = profile.triggerDcaPnl || -2;',
    '            document.getElementById(\'maxContracts\').value = profile.maxContracts || 1000;',
    '            myCoins = profile.coins || [];',
    '            renderCoinsSettings();',
    '        }',
    '',
    '        async function removeSubAccount() {',
    '            if(currentProfileIndex < 0) return;',
    '            mySubAccounts.splice(currentProfileIndex, 1);',
    '            await saveSettings(true);',
    '            renderSubAccounts();',
    '            if(mySubAccounts.length > 0) { document.getElementById(\'subAccountSelect\').value = 0; loadSubAccount(); } ',
    '            else { currentProfileIndex = -1; document.getElementById(\'settingsContainer\').style.display = \'none\'; }',
    '        }',
    '',
    '        async function globalToggleBot(active) {',
    '            if(currentProfileIndex === -1) return;',
    '            myCoins.forEach(c => c.botActive = active);',
    '            await saveSettings(true);',
    '        }',
    '',
    '        function addPredefinedList() {',
    '            if(currentProfileIndex === -1) return;',
    '            const sideMode = document.getElementById(\'predefSide\').value;',
    '            const startMode = document.getElementById(\'predefStatus\').value === \'started\';',
    '            PREDEFINED_COINS.forEach((base, index) => {',
    '                const symbol = base + \'/USDT:USDT\';',
    '                if(!myCoins.some(c => c.symbol === symbol)) {',
    '                    let coinSide = \'long\';',
    '                    if (sideMode === \'allShort\') coinSide = \'short\';',
    '                    else if (sideMode === \'oddLong\') coinSide = (index % 2 === 0) ? \'long\' : \'short\';',
    '                    else if (sideMode === \'evenLong\') coinSide = (index % 2 === 0) ? \'short\' : \'long\';',
    '                    myCoins.push({ symbol, side: coinSide, botActive: startMode });',
    '                }',
    '            });',
    '            renderCoinsSettings();',
    '        }',
    '',
    '        function addCoinUI() {',
    '            if(currentProfileIndex === -1) return;',
    '            const symbol = document.getElementById(\'newCoinSymbol\').value.toUpperCase().trim();',
    '            if(symbol && !myCoins.some(c => c.symbol === symbol)) {',
    '                myCoins.push({ symbol, side: document.getElementById(\'side\').value, botActive: true });',
    '                document.getElementById(\'newCoinSymbol\').value = \'\';',
    '                renderCoinsSettings();',
    '            }',
    '        }',
    '',
    '        function removeCoinUI(index) { myCoins.splice(index, 1); renderCoinsSettings(); }',
    '',
    '        function renderCoinsSettings() {',
    '            const container = document.getElementById(\'coinsListContainer\');',
    '            container.innerHTML = \'\';',
    '            myCoins.forEach((coin, i) => {',
    '                const displaySide = coin.side || document.getElementById(\'side\').value;',
    '                const sideColor = displaySide === \'long\' ? \'text-green\' : \'text-red\';',
    '                container.innerHTML += \'<div class="flex-between metric" style="margin-bottom:5px;"><span>\' + coin.symbol + \' <span class="\' + sideColor + \'">[\' + displaySide + \']</span></span><button class="text-red" style="padding:2px 6px; border:none; background:transparent;" onclick="removeCoinUI(\' + i + \')">X</button></div>\';',
    '            });',
    '        }',
    '',
    '        async function saveSettings(silent = false) {',
    '            if(currentProfileIndex === -1) return;',
    '            const p = mySubAccounts[currentProfileIndex];',
    '            if(!isPaperUser) { p.apiKey = document.getElementById(\'apiKey\').value; p.secret = document.getElementById(\'secret\').value; }',
    '            p.side = document.getElementById(\'side\').value;',
    '            p.baseQty = parseFloat(document.getElementById(\'baseQty\').value)||1;',
    '            p.takeProfitPct = parseFloat(document.getElementById(\'takeProfitPct\').value)||5;',
    '            p.takeProfitPnl = parseFloat(document.getElementById(\'takeProfitPnl\').value)||0;',
    '            p.stopLossPct = parseFloat(document.getElementById(\'stopLossPct\').value)||-25;',
    '            p.triggerDcaPnl = parseFloat(document.getElementById(\'triggerDcaPnl\').value)||-2;',
    '            p.maxContracts = parseInt(document.getElementById(\'maxContracts\').value)||1000;',
    '            p.coins = myCoins;',
    '            const data = { subAccounts: mySubAccounts, globalSingleCoinTpPnl: myGlobalSingleCoinTpPnl, smartOffsetNetProfit: mySmartOffsetNetProfit, autoBalanceEquity: myAutoBalanceEquity, autoBalanceUnrealizedPnlTarget: myAutoBalanceUnrealizedPnlTarget, globalDcaRecoveryTriggerPnl: myGlobalDcaRecoveryTriggerPnl };',
    '            const res = await fetch(\'/api/settings\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token }, body: JSON.stringify(data) });',
    '            const json = await res.json(); mySubAccounts = json.settings.subAccounts || [];',
    '        }',
    '',
    '        async function toggleCoinBot(symbol, active) { const coin = myCoins.find(c => c.symbol === symbol); if(coin) { coin.botActive = active; await saveSettings(true); } }',
    '',
    '        async function loadOffsets() {',
    '            const res = await fetch(\'/api/offsets\', { headers: { \'Authorization\': \'Bearer \' + token } });',
    '            if (!res.ok) return;',
    '            const records = await res.json();',
    '            if (records.length === 0) {',
    '                const empty = \'<tr><td colspan="7" class="text-muted text-center">Empty</td></tr>\';',
    '                if(document.getElementById(\'offsetTableContainer\')) document.getElementById(\'offsetTableContainer\').innerHTML = empty;',
    '                if(document.getElementById(\'pretty-log-tbody\')) document.getElementById(\'pretty-log-tbody\').innerHTML = empty;',
    '                return;',
    '            }',
    '            let pretty = \'\';',
    '            records.forEach(r => {',
    '                const d = new Date(r.timestamp);',
    '                const dStr = d.toLocaleDateString(undefined,{month:\'short\',day:\'numeric\'}) + \' \' + d.toLocaleTimeString(undefined,{hour12:false});',
    '                const sym = r.symbol || \'?\';',
    '                const net = r.netProfit || 0;',
    '                const roi = r.roi !== undefined ? r.roi.toFixed(2)+\'%\' : \'-\';',
    '                const openP = r.openPrice ? fmtP(r.openPrice) : \'-\';',
    '                const closeP = r.closePrice ? fmtP(r.closePrice) : \'-\';',
    '                const side = r.side ? \' <span class="text-muted" style="font-size:11px;">[\'+r.side.toUpperCase()+\']</span>\' : \'\';',
    '                ',
    '                const row = \'<tr>\' +',
    '                    \'<td class="text-muted">\' + dStr + \'</td>\' +',
    '                    \'<td><b>\' + sym + \'</b>\' + side + \'</td>\' +',
    '                    \'<td class="\' + (r.roi>=0?\'text-green\':\'text-red\') + \'">\' + roi + \'</td>\' +',
    '                    \'<td class="\' + (net>=0?\'text-green\':\'text-red\') + \'">\' + (net>=0?\'+\':\'\') + \'$\' + net.toFixed(4) + \'</td>\' +',
    '                    \'<td>\' + openP + \'</td>\' +',
    '                    \'<td>\' + closeP + \'</td>\' +',
    '                    \'<td>\' + (r.reason||\'?\') + \'</td>\' +',
    '                    \'</tr>\';',
    '                pretty += row;',
    '            });',
    '            const fullTable = \'<table><tr><th>Time</th><th>Coin</th><th>ROI %</th><th>PNL</th><th>Open Price</th><th>Close Price</th><th>Reason</th></tr>\' + pretty + \'</table>\';',
    '            if(document.getElementById(\'offsetTableContainer\')) document.getElementById(\'offsetTableContainer\').innerHTML = fullTable;',
    '            if(document.getElementById(\'pretty-log-tbody\')) document.getElementById(\'pretty-log-tbody\').innerHTML = pretty;',
    '        }',
    '',
    '        async function loadStatus() {',
    '            try {',
    '                const res = await fetch(\'/api/status\', { headers: { \'Authorization\': \'Bearer \' + token } });',
    '                if (res.status === 401 || res.status === 403) return logout();',
    '                const data = await res.json();',
    '                const allStatuses = data.states || {};',
    '                const subAccountsUpdated = data.subAccounts || [];',
    '                const globalSet = data.globalSettings || {};',
    '                ',
    '                if (myUsername !== \'webcoin8888\' && subAccountsUpdated.length !== mySubAccounts.length) fetchSettings();',
    '',
    '                let globalTotal = 0, globalUnrealized = 0, globalMarginUsed = 0, totalTrading = 0, totalAboveZero = 0, globalRealized = 0;',
    '                let activeCandidates = [];',
    '                subAccountsUpdated.forEach(sub => { ',
    '                    globalTotal += (sub.realizedPnl || 0); ',
    '                    globalRealized += (sub.realizedPnl || 0);',
    '                    const loc = mySubAccounts.find(s=>s._id===sub._id); ',
    '                    if(loc) loc.realizedPnl=sub.realizedPnl; ',
    '                });',
    '',
    '                for (let pid in allStatuses) {',
    '                    const st = allStatuses[pid];',
    '                    if (st && st.coinStates) {',
    '                        for (let sym in st.coinStates) {',
    '                            const cs = st.coinStates[sym];',
    '                            if (cs.contracts > 0) globalMarginUsed += (parseFloat(cs.margin) || 0);',
    '                            if (cs.contracts > 0 && (!cs.lockUntil || Date.now() >= cs.lockUntil)) {',
    '                                totalTrading++; const pnlNum = parseFloat(cs.unrealizedPnl) || 0;',
    '                                if (cs.currentRoi > 0) totalAboveZero++;',
    '                                globalUnrealized += pnlNum; activeCandidates.push({ symbol: sym, pnl: pnlNum, profileId: pid });',
    '                            }',
    '                        }',
    '                    }',
    '                }',
    '',
    '                const setTxt = (id, txt, cls) => { const el=document.getElementById(id); if(el){el.innerText=txt; if(cls) el.className="metric-val "+cls;} };',
    '                ',
    '                setTxt(\'topGlobalMargin\', "$"+globalMarginUsed.toFixed(2));',
    '                setTxt(\'globalPnl\', fmtC(globalTotal), globalTotal>=0?"text-green":"text-red");',
    '                setTxt(\'topGlobalUnrealized\', fmtC(globalUnrealized), globalUnrealized>=0?"text-green":"text-red");',
    '                setTxt(\'globalWinRate\', totalAboveZero + " / " + totalTrading);',
    '',
    '                const baseTrigger = globalSet.globalDcaRecoveryTriggerPnl || -50;',
    '                const step = globalSet.globalDcaStep || 0;',
    '                const activeTrigger = baseTrigger * Math.pow(2, step);',
    '                if (document.getElementById(\'display_activeDcaTrigger\')) {',
    '                    document.getElementById(\'display_activeDcaTrigger\').innerHTML = fmtC(activeTrigger) + " <span style=\'font-size:12px;color:#888;\'>[Step " + step + "]</span>";',
    '                }',
    '',
    '                activeCandidates.sort((a, b) => b.pnl - a.pnl);',
    '                const totalCoins = activeCandidates.length, totalPairs = Math.floor(totalCoins / 2);',
    '                let peakAccumulation = 0;',
    '                const multiplier = globalSet.qtyMultiplier || 1, peakThreshold = 0.0001 * multiplier;',
    '                if (totalPairs > 0) { let rAcc = 0; for (let i = 0; i < totalPairs; i++) { rAcc += activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl; if (rAcc > peakAccumulation) peakAccumulation = rAcc; } }',
    '',
    '                if(document.getElementById("display_highestPnlNode")) {',
    '                    if (activeCandidates.length > 0) {',
    '                        const hi = activeCandidates[0], lo = activeCandidates[activeCandidates.length - 1];',
    '                        document.getElementById("display_highestPnlNode").innerHTML = hi.symbol + " <br>" + fmtC(hi.pnl) + " <button style=\'padding:2px 5px;font-size:10px;\' onclick=\'closeSinglePosition(\\"" + hi.symbol + "\\", \\"" + hi.profileId + "\\")\'>Close</button>";',
    '                        document.getElementById("display_lowestPnlNode").innerHTML = lo.symbol + " <br>" + fmtC(lo.pnl);',
    '                    } else {',
    '                        document.getElementById("display_highestPnlNode").innerHTML = "-"; document.getElementById("display_lowestPnlNode").innerHTML = "-";',
    '                    }',
    '                    setTxt(\'display_v1TargetPeak\', fmtC(globalSet.smartOffsetNetProfit||0));',
    '                    setTxt(\'display_v1MaxDetected\', fmtC(peakAccumulation), peakAccumulation>=0?"text-green":"text-red");',
    '                }',
    '',
    '                if (document.getElementById(\'offset-tab\')?.style.display === \'block\') {',
    '                    const targetV1 = globalSet.smartOffsetNetProfit || 0;',
    '                    if (totalPairs === 0) document.getElementById(\'liveOffsetsContainer\').innerHTML = \'<p class="text-muted text-center">No pairs.</p>\';',
    '                    else {',
    '                        let liveHtml = \'<table><tr><th>Pair</th><th>Win Node</th><th>Delta</th><th>Lose Node</th><th>Delta</th><th>Pair Net</th><th>Accum</th></tr>\';',
    '                        let rAcc = 0, pIdx = -1, tPeak = 0;',
    '                        for (let i = 0; i < totalPairs; i++) { rAcc += activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl; if (rAcc > tPeak) { tPeak = rAcc; pIdx = i; } }',
    '                        let exec = (targetV1 > 0 && tPeak >= targetV1 && tPeak >= peakThreshold && pIdx >= 0);',
    '                        let dAcc = 0;',
    '                        for (let i = 0; i < totalPairs; i++) {',
    '                            const w = activeCandidates[i], l = activeCandidates[totalCoins - totalPairs + i], net = w.pnl + l.pnl; dAcc += net;',
    '                            let stat = exec ? (i <= pIdx ? "Harvest" : "Skip") : ((i <= pIdx && tPeak >= peakThreshold) ? "Peak" : "Base");',
    '                            liveHtml += \'<tr><td class="text-muted">[\' + (i+1) + \'] \' + stat + \'</td><td>\' + w.symbol + \'</td><td class="\' + (w.pnl>=0?"text-green":"text-red") + \'">\' + fmtC(w.pnl) + \'</td><td>\' + l.symbol + \'</td><td class="\' + (l.pnl>=0?"text-green":"text-red") + \'">\' + fmtC(l.pnl) + \'</td><td class="\' + (net>=0?"text-green":"text-red") + \'">\' + fmtC(net) + \'</td><td class="\' + (dAcc>=0?"text-green":"text-red") + \'">\' + fmtC(dAcc) + \'</td></tr>\';',
    '                        }',
    '                        liveHtml += \'</table>\';',
    '                        document.getElementById(\'liveOffsetsContainer\').innerHTML = \'<p>Target: <b>\' + fmtC(targetV1) + \'</b> | Peak Found: <b>\' + fmtC(tPeak) + \'</b></p>\' + liveHtml;',
    '                    }',
    '                }',
    '',
    '                let summaryHtml = "";',
    '                if (subAccountsUpdated.length === 0) summaryHtml = "<tr><td colspan=\'5\' class=\'text-muted text-center\'>No profiles</td></tr>";',
    '                else {',
    '                    subAccountsUpdated.forEach((sub, i) => {',
    '                        const pnl = sub.realizedPnl || 0;',
    '                        const hasKeys = isPaperUser || (sub.apiKey && sub.secret);',
    '                        const envText = hasKeys ? (isPaperUser ? "<span class=\'text-blue\'>PAPER</span>" : "<span class=\'text-green\'>LIVE</span>") : "<span class=\'text-warning\'>NO KEYS</span>";',
    '                        const isRunning = allStatuses[sub._id] !== undefined && sub.coins?.some(c => c.botActive);',
    '                        const statTxt = !hasKeys ? "Offline" : (isRunning ? "<span class=\'text-green\'>[▶] Run</span>" : "<span class=\'text-red\'>[■] Stop</span>");',
    '                        summaryHtml += "<tr><td>[" + (i+1) + "] " + sub.name + "</td><td>" + envText + "</td><td>" + statTxt + "</td><td>" + (sub.side||"long").toUpperCase() + "</td><td class=\'" + (pnl>=0?"text-green":"text-red") + "\'>" + fmtC(pnl) + "</td></tr>";',
    '                    });',
    '                }',
    '                const summaryTbody = document.getElementById("active-profiles-tbody"); if (summaryTbody) summaryTbody.innerHTML = summaryHtml;',
    '',
    '                const elapsedHrs = Math.max(Date.now() - (data.startTime ? new Date(data.startTime).getTime() : Date.now()), 3600000) / 3600000;',
    '                const hrly = globalTotal / elapsedHrs;',
    '                setTxt("estHour", fmtC(hrly), hrly>=0?"text-green":"text-red"); setTxt("estDay", fmtC(hrly*24), hrly>=0?"text-green":"text-red");',
    '                setTxt("estMonth", fmtC(hrly*24*30), hrly>=0?"text-green":"text-red"); setTxt("estYear", fmtC(hrly*24*365), hrly>=0?"text-green":"text-red");',
    '',
    '                if(currentProfileIndex === -1) return;',
    '                const profile = mySubAccounts[currentProfileIndex];',
    '                setTxt(\'profilePnl\', fmtC(profile.realizedPnl||0), (profile.realizedPnl||0)>=0?"text-green":"text-red");',
    '                ',
    '                let pMargin = 0;',
    '                const stateData = allStatuses[profile._id] || { coinStates: {}, logs: [] };',
    '                let pBanner = (globalSet.cyclePauseEnabled && globalSet.cycleCurrentState === "paused") ? \'<div style="background:#450a0a; color:#f87171; padding:10px; margin-bottom:10px;">[!] Paused by Cycle Timer</div>\' : \'\';',
    '',
    '                if(!myCoins || myCoins.length === 0) {',
    '                    const dsc = document.getElementById(\'dashboardStatusContainer\'); if(dsc) dsc.innerHTML = pBanner + \'<p class="text-muted text-center">Empty</p>\';',
    '                    setTxt(\'profileMargin\', "$0.00");',
    '                } else {',
    '                    let html = pBanner;',
    '                    myCoins.forEach(coin => {',
    '                        const st = stateData.coinStates?.[coin.symbol] || { status: \'Halted\', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0 };',
    '                        if (st.contracts > 0) pMargin += (parseFloat(st.margin) || 0);',
    '                        let stCls = st.status === \'Running\' ? \'text-green\' : (st.status === \'In Position\' ? \'text-blue\' : \'text-red\');',
    '                        if (globalSet.cyclePauseEnabled && globalSet.cycleCurrentState === \'paused\') { st.status = \'Paused\'; stCls = \'text-warning\'; }',
    '                        else if (st.lockUntil && Date.now() < st.lockUntil) { st.status = \'Process\'; stCls = \'text-warning\'; }',
    '                        const roiCls = st.currentRoi >= 0 ? \'text-green\' : \'text-red\';',
    '                        html += \'<div class="metric" style="margin-bottom:10px;"><div class="flex-between" style="border-bottom:1px solid #222; padding-bottom:5px; margin-bottom:5px;"><span><b>\' + coin.symbol + \'</b> [\' + (coin.side||profile.side||\'long\') + \'] <span class="\' + stCls + \'">\' + st.status + \'</span></span><div><button onclick="toggleCoinBot(\\\'\' + coin.symbol + \'\\\', true)">▶</button> <button class="text-red" style="border-color:#f87171;" onclick="toggleCoinBot(\\\'\' + coin.symbol + \'\\\', false)">■</button></div></div>\';',
    '                        html += \'<div class="grid" style="font-size:12px;"><div>Price: \' + fmtP(st.currentPrice) + \'</div><div>Entry: \' + fmtP(st.avgEntry) + \'</div><div>Size: \' + (st.contracts||0) + \'</div><div class="\' + roiCls + \'">Net: \' + (st.unrealizedPnl||0).toFixed(4) + \'</div><div class="\' + roiCls + \'">ROI: \' + (st.currentRoi||0).toFixed(2) + \'%</div></div></div>\';',
    '                    });',
    '                    const dsc = document.getElementById(\'dashboardStatusContainer\'); if(dsc) dsc.innerHTML = html;',
    '                    setTxt(\'profileMargin\', "$" + pMargin.toFixed(2));',
    '                }',
    '',
    '                const logsEl = document.getElementById(\'logs\');',
    '                if(logsEl) {',
    '                    logsEl.innerHTML = (stateData.logs || []).map(l => {',
    '                        if(l.includes(\'❌\')) return \'<span class="text-red">\' + l + \'</span>\';',
    '                        if(l.includes(\'⚡\')||l.includes(\'🛒\')) return \'<span class="text-blue">\' + l + \'</span>\';',
    '                        if(l.includes(\'⚙️\')||l.includes(\'⚖️\')) return \'<span class="text-warning">\' + l + \'</span>\';',
    '                        return l;',
    '                    }).join(\'<br>\');',
    '                }',
    '            } catch (err) {}',
    '        }',
    '        checkAuth();',
    '    </script>',
    '</body>',
    '</html>'
];

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: "API Endpoint Not Found" });
    res.send(FRONTEND_HTML.join('\n'));
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Running locally on http://localhost:${PORT}`));
}
module.exports = app;
