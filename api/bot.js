const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const path = require('path');

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
const MONGO_URI = 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';

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
    maxContracts: { type: Number, default: 1000 },
    realizedPnl: { type: Number, default: 0 },
    coins: [CoinSettingSchema]
});

const SettingsSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    qtyMultiplier: { type: Number, default: 1 },
    globalTargetPnl: { type: Number, default: 0 },       
    globalTrailingPnl: { type: Number, default: 0 },     
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

// UNIVERSAL HISTORY SCHEMA
const OffsetRecordSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    symbol: { type: String }, 
    reason: { type: String }, 
    winnerSymbol: { type: String },
    winnerPnl: { type: Number },
    loserSymbol: { type: String },
    loserPnl: { type: Number },
    netProfit: { type: Number, required: true },
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

// MULTI-MODE DB COLLECTIONS
const RealSettings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema, 'settings');
const PaperSettings = mongoose.models.PaperSettings || mongoose.model('PaperSettings', SettingsSchema, 'paper_settings');
const RealOffsetRecord = mongoose.models.OffsetRecord || mongoose.model('OffsetRecord', OffsetRecordSchema, 'offset_records');
const PaperOffsetRecord = mongoose.models.PaperOffsetRecord || mongoose.model('PaperOffsetRecord', OffsetRecordSchema, 'paper_offset_records');
const RealProfileState = mongoose.models.ProfileState || mongoose.model('ProfileState', ProfileStateSchema, 'profile_states');
const PaperProfileState = mongoose.models.PaperProfileState || mongoose.model('PaperProfileState', ProfileStateSchema, 'paper_profile_states');
const MainTemplate = mongoose.models.MainTemplate || mongoose.model('MainTemplate', MainTemplateSchema, 'main_settings_template');

// ==========================================
// 3. MULTI-MODE BOT ENGINE STATE
// ==========================================
global.activeBots = global.activeBots || new Map();
const activeBots = global.activeBots;

function logForProfile(profileId, msg) {
    console.log(`[Profile: ${profileId}] ${msg}`);
    const bot = activeBots.get(profileId);
    if (bot) {
        bot.state.logs.unshift(`${new Date().toLocaleTimeString()} - ${msg}`);
        if (bot.state.logs.length > 50) bot.state.logs.pop();
    }
}

function calculateDcaQty(side, P0, Pc, C0, leverage, targetRoiPct) {
    const R = targetRoiPct / 100;
    let Pnew, Cn;
    if (side === 'long') {
        Pnew = Pc / (1 + (R / leverage));
        Cn = C0 * (P0 - Pnew) / (Pnew - Pc);
    } else {
        Pnew = Pc / (1 - (R / leverage));
        Cn = C0 * (Pnew - P0) / (Pc - Pnew);
    }
    if (Cn <= 0 || isNaN(Cn) || !isFinite(Cn)) return 0;
    return Math.ceil(Cn); 
}

async function startBot(userId, subAccount, isPaper) {
    const userDoc = await User.findById(userId);
    if (userDoc && userDoc.username === 'webcoin8888') {
        console.log(`[Profile: ${subAccount._id}] 🛑 Engine Disabled: Master account (webcoin8888) is for database template editing only.`);
        return;
    }

    const profileId = subAccount._id.toString();
    if (activeBots.has(profileId)) stopBot(profileId);

    if (!subAccount.apiKey || !subAccount.secret) return;

    const exchange = new ccxt.htx({ 
        apiKey: subAccount.apiKey, 
        secret: subAccount.secret, 
        options: { defaultType: 'swap' },
        enableRateLimit: true 
    });
    
    const ProfileStateModel = isPaper ? PaperProfileState : RealProfileState;
    const SettingsModel = isPaper ? PaperSettings : RealSettings;

    let dbState = await ProfileStateModel.findOne({ profileId });
    if (!dbState) {
        dbState = await ProfileStateModel.create({ profileId, userId, logs: [], coinStates: {} });
    }
    
    const state = { logs: dbState.logs || [], coinStates: dbState.coinStates || {} };
    let isProcessing = false;
    let lastError = '';

    const intervalId = setInterval(async () => {
        if (isProcessing) return; 
        isProcessing = true;

        const botData = activeBots.get(profileId);
        if (!botData) { isProcessing = false; return; }
        
        const currentSettings = botData.settings;
        
        // --- FORCE ALL COINS ACTIVE ALWAYS ---
        let forcedStart = false;
        currentSettings.coins.forEach(c => {
            if (!c.botActive) {
                c.botActive = true;
                forcedStart = true;
            }
        });
        
        if (forcedStart) {
            logForProfile(profileId, `🔄 Auto-Healed: Restarted stopped coins to keep them active always.`);
            SettingsModel.updateOne(
                { "subAccounts._id": currentSettings._id },
                { $set: { "subAccounts.$.coins": currentSettings.coins } }
            ).catch(()=>{});
        }
        
        const activeCoins = currentSettings.coins;

        if (activeCoins.length === 0) { isProcessing = false; return; }

        try {
            if (!exchange.markets) await exchange.loadMarkets().catch(()=>{});
            const symbolsToFetch = activeCoins.map(c => c.symbol);
            
            let positions = [];
            let allTickers = {};

            if (!isPaper) {
                const [fetchedPos, fetchedTick] = await Promise.all([
                    exchange.fetchPositions(symbolsToFetch).catch(e => { throw new Error('Positions: ' + e.message); }),
                    exchange.fetchTickers(symbolsToFetch).catch(e => { throw new Error('Tickers: ' + e.message); })
                ]);
                positions = fetchedPos;
                allTickers = fetchedTick;
            } else {
                allTickers = await exchange.fetchTickers(symbolsToFetch).catch(e => { throw new Error('Tickers: ' + e.message); });
            }

            for (let coin of activeCoins) {
                try {
                    const activeLeverage = 10;
                    const activeSide = coin.side || currentSettings.side;
                    const market = exchange.markets[coin.symbol];
                    const contractSize = (market && market.contractSize) ? market.contractSize : 1;

                    if (!state.coinStates[coin.symbol]) {
                        state.coinStates[coin.symbol] = { status: 'Running', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0, lastDcaTime: 0, lockUntil: 0 };
                    }

                    let cState = state.coinStates[coin.symbol];
                    if (cState.lockUntil && Date.now() < cState.lockUntil) continue;
                    
                    const ticker = allTickers[coin.symbol];
                    if (!ticker || !ticker.last) continue; 
                    
                    cState.currentPrice = ticker.last;
                    cState.activeSide = activeSide;

                    const ESTIMATED_FEE_RATE = 0.001; 

                    if (!isPaper) {
                        const pos = positions.find(p => p.symbol === coin.symbol && p.side === activeSide);
                        cState.contracts = pos ? pos.contracts : 0;
                        cState.avgEntry = pos ? pos.entryPrice : 0;
                        
                        let grossPnl = 0;
                        if (pos) {
                            if (pos.unrealizedPnl !== undefined && pos.unrealizedPnl !== null) {
                                grossPnl = pos.unrealizedPnl;
                            } else {
                                grossPnl = (activeSide === 'long') 
                                    ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize 
                                    : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize;
                            }
                        }

                        const positionValue = cState.contracts * contractSize * cState.currentPrice;
                        const estimatedFee = positionValue * ESTIMATED_FEE_RATE;

                        cState.unrealizedPnl = cState.contracts > 0 ? (grossPnl - estimatedFee) : 0;
                        cState.margin = pos ? (pos.initialMargin || pos.cost || 0) : 0;
                        cState.currentRoi = (cState.margin > 0 && cState.contracts > 0) ? (cState.unrealizedPnl / cState.margin) * 100 : 0; 
                        cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting to Enter';
                    } else {
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
                        const modeTxt = isPaper ? "PAPER" : "REAL";
                        logForProfile(profileId, `[${modeTxt}] 🛒 Opening base position of ${safeBaseQty} contracts (${activeSide}) at ~${cState.currentPrice}.`);
                        
                        if (!isPaper) {
                            const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                            await exchange.createOrder(coin.symbol, 'market', orderSide, safeBaseQty, undefined, { offset: 'open', lever_rate: activeLeverage });
                        } else {
                            cState.avgEntry = cState.currentPrice; 
                            cState.contracts = safeBaseQty; 
                            cState.currentRoi = 0; 
                            cState.unrealizedPnl = 0; 
                            cState.margin = (cState.avgEntry * cState.contracts * contractSize) / activeLeverage;
                        }

                        // PRECISE EXCHANGE LOG: Opening Position
                        const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                        OffsetModel.create({
                            userId: userId,
                            symbol: coin.symbol,
                            winnerSymbol: coin.symbol, 
                            reason: `Open Base Position (${safeBaseQty} contracts)`,
                            netProfit: 0
                        }).catch(()=>{});
                        
                        cState.lockUntil = Date.now() + 5000; 
                        continue; 
                    }

                    // 2. TAKE PROFIT OR STOP LOSS
                    let isTakeProfit = false;
                    let tpReasonTxt = '';
                    
                    const tpPnlTarget = parseFloat(currentSettings.takeProfitPnl) || 0;
                    const tpPctTarget = parseFloat(currentSettings.takeProfitPct) || 0;
                    const currentPnl = parseFloat(cState.unrealizedPnl) || 0;
                    const currentRoi = parseFloat(cState.currentRoi) || 0;
                    const slPctTarget = parseFloat(currentSettings.stopLossPct) || -25.0;

                    if (tpPnlTarget > 0 && currentPnl >= tpPnlTarget) {
                        isTakeProfit = true;
                        tpReasonTxt = `Take Profit Hit (PNL $${currentPnl.toFixed(4)} >= $${tpPnlTarget.toFixed(4)})`;
                    } else if (tpPctTarget > 0 && currentRoi >= tpPctTarget) {
                        isTakeProfit = true;
                        tpReasonTxt = `Take Profit Hit (ROI ${currentRoi.toFixed(2)}% >= ${tpPctTarget}%)`;
                    }
                    
                    const isStopLoss = slPctTarget < 0 && currentRoi <= slPctTarget;

                    if (isTakeProfit || isStopLoss) {
                        const reasonTxt = isTakeProfit ? tpReasonTxt : `Stop Loss Hit (ROI ${currentRoi.toFixed(2)}% <= ${slPctTarget}%)`;
                        const modeTxt = isPaper ? "PAPER" : "REAL";
                        
                        logForProfile(profileId, `[${modeTxt}] [${coin.symbol}] ⚡ Triggered: ${reasonTxt}. Attempting to close ${cState.contracts} contracts.`);
                        
                        try {
                            if (!isPaper) {
                                const closeSide = activeSide === 'long' ? 'sell' : 'buy';
                                await exchange.createOrder(coin.symbol, 'market', closeSide, cState.contracts, undefined, { offset: 'close' });
                            }

                            cState.lockUntil = Date.now() + 5000;
                            currentSettings.realizedPnl = (currentSettings.realizedPnl || 0) + currentPnl;
                            
                            const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                            OffsetModel.create({
                                userId: userId,
                                symbol: coin.symbol,
                                winnerSymbol: coin.symbol,
                                reason: reasonTxt,
                                netProfit: currentPnl
                            }).catch(()=>{});

                            if (isPaper) {
                                cState.contracts = 0; cState.unrealizedPnl = 0; cState.currentRoi = 0; cState.avgEntry = 0;
                            }

                            SettingsModel.updateOne({ "subAccounts._id": currentSettings._id }, { $set: { "subAccounts.$.realizedPnl": currentSettings.realizedPnl } }).catch(()=>{});
                            continue; 
                        } catch (closeErr) {
                            logForProfile(profileId, `[${modeTxt}] [${coin.symbol}] ❌ FAILED TO CLOSE: ${closeErr.message}`);
                            continue;
                        }
                    }

                    // 3. DCA TRIGGER
                    if (cState.currentRoi <= currentSettings.triggerRoiPct && (Date.now() - (cState.lastDcaTime || 0) > 12000)) {
                        const reqQty = calculateDcaQty(activeSide, cState.avgEntry, cState.currentPrice, cState.contracts, activeLeverage, currentSettings.dcaTargetRoiPct);

                        if (reqQty <= 0) {
                            cState.lastDcaTime = Date.now();
                        } else if ((cState.contracts + reqQty) > currentSettings.maxContracts) {
                            logForProfile(profileId, `[${isPaper ? 'PAPER' : 'REAL'}] 🛡️ DCA Safety Triggered. Max contracts reached.`);
                            cState.lastDcaTime = Date.now(); 
                        } else {
                            logForProfile(profileId, `[${isPaper ? 'PAPER' : 'REAL'}] ⚡ Executing DCA: Buying ${reqQty} contracts at ~${cState.currentPrice}`);
                            
                            if (!isPaper) {
                                const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                                await exchange.createOrder(coin.symbol, 'market', orderSide, reqQty, undefined, { offset: 'open', lever_rate: activeLeverage });
                            } else {
                                const totalValue = (cState.contracts * cState.avgEntry) + (reqQty * cState.currentPrice);
                                cState.contracts += reqQty;
                                cState.avgEntry = totalValue / cState.contracts;
                            }

                            // PRECISE EXCHANGE LOG: DCA Addition
                            const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                            OffsetModel.create({
                                userId: userId,
                                symbol: coin.symbol,
                                winnerSymbol: coin.symbol,
                                reason: `DCA Added ${reqQty} Contracts (ROI dropped to ${currentSettings.triggerRoiPct}%)`,
                                netProfit: 0
                            }).catch(()=>{});

                            cState.lockUntil = Date.now() + 5000; 
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
                logForProfile(profileId, `❌ Global API Error (Retrying next cycle): ${err.message}`);
                lastError = err.message;
            }
        } finally {
            isProcessing = false;
        }
    }, 6000);

    activeBots.set(profileId, { userId: String(userId), isPaper, settings: subAccount, state, exchange, intervalId });
    logForProfile(profileId, `🚀 ${isPaper ? 'Paper' : 'Real Live'} Engine Started for: ${subAccount.name}`);
}

function stopBot(profileId) {
    if (activeBots.has(profileId)) {
        clearInterval(activeBots.get(profileId).intervalId);
        activeBots.delete(profileId);
        console.log(`[Profile: ${profileId}] ⏹ Bot Stopped.`);
    }
}

// =========================================================================
// 4. BACKGROUND TASKS (DUAL-MODE)
// =========================================================================
const executeOneMinuteCloser = async () => {
    try {
        await connectDB();
        const paperUsers = await PaperSettings.find({}).lean();
        const realUsers = await RealSettings.find({}).lean();
        
        const allUsersSettings = [
            ...paperUsers.map(s => ({ ...s, isPaper: true })),
            ...realUsers.map(s => ({ ...s, isPaper: false }))
        ];

        for (let userSetting of allUsersSettings) {
            const dbUserId = String(userSetting.userId);
            const SettingsModel = userSetting.isPaper ? PaperSettings : RealSettings;
            
            let rawTpMin = Math.abs(parseFloat(userSetting.minuteCloseTpMinPnl) || 0);
            let rawTpMax = Math.abs(parseFloat(userSetting.minuteCloseTpMaxPnl) || 0);
            let rawSlMin = -Math.abs(parseFloat(userSetting.minuteCloseSlMinPnl) || 0);
            let rawSlMax = -Math.abs(parseFloat(userSetting.minuteCloseSlMaxPnl) || 0);
            const autoDynamic = userSetting.minuteCloseAutoDynamic || false;
            
            let activeCandidates = [];
            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue;
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                        activeCandidates.push({
                            profileId, symbol, exchange: botData.exchange, isPaper: botData.isPaper,
                            pnl: parseFloat(cState.unrealizedPnl) || 0,
                            contracts: cState.contracts,
                            side: cState.activeSide || botData.settings.coins.find(c => c.symbol === symbol)?.side || botData.settings.side,
                            subAccount: botData.settings,
                            cState: cState
                        });
                    }
                }
            }

            activeCandidates.sort((a, b) => b.pnl - a.pnl);
            const totalCoins = activeCandidates.length;
            const totalPairs = Math.floor(totalCoins / 2);

            if (totalPairs === 0) continue;

            if (autoDynamic) {
                let runningAccumulation = 0;
                let peakAccumulation = 0;

                for (let i = 0; i < totalPairs; i++) {
                    const netResult = activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl;
                    runningAccumulation += netResult;
                    if (runningAccumulation > peakAccumulation) { peakAccumulation = runningAccumulation; }
                }

                if (peakAccumulation > 0) { 
                    rawTpMin = peakAccumulation * 0.8; rawTpMax = peakAccumulation * 1.2;
                    rawSlMin = -(peakAccumulation * 5.0); rawSlMax = -(peakAccumulation * 0.5); 
                } else {
                    rawTpMin = 0; rawTpMax = 0; rawSlMin = 0; rawSlMax = 0;
                }

                const multiplier = userSetting.qtyMultiplier || 1;
                if (Math.abs(rawTpMax - rawTpMin) <= 0.000101 * multiplier) {
                    rawTpMin = 0; rawTpMax = 0; rawSlMin = 0; rawSlMax = 0;
                }
            }

            const tpMin = Math.min(rawTpMin, rawTpMax); const tpMax = Math.max(rawTpMin, rawTpMax);
            const slMin = Math.min(rawSlMin, rawSlMax); const slMax = Math.max(rawSlMax, rawSlMin); 

            if (tpMax === 0 && slMax === 0) continue; 

            let runningAccumulation = 0;
            let executedGroup = false;

            for (let i = 0; i < totalPairs; i++) {
                const w = activeCandidates[i];
                const l = activeCandidates[totalCoins - totalPairs + i];
                runningAccumulation += (w.pnl + l.pnl);

                const isPositiveMatch = (tpMax > 0 && runningAccumulation > 0 && runningAccumulation >= tpMin && runningAccumulation <= tpMax);
                const isNegativeMatch = (slMin < 0 && runningAccumulation < 0 && runningAccumulation >= slMin && runningAccumulation <= slMax);

                if (!executedGroup && (isPositiveMatch || isNegativeMatch)) {
                    const executionType = isPositiveMatch ? "Group Take Profit" : "Group Stop Loss";
                    
                    const autoDynData = { time: Date.now(), type: executionType, symbol: `Group up to Row ${i + 1} (WINNERS ONLY)`, pnl: runningAccumulation };
                    await SettingsModel.updateOne({ userId: dbUserId }, { $set: { autoDynamicLastExecution: autoDynData } }).catch(console.error);

                    const OffsetModel = userSetting.isPaper ? PaperOffsetRecord : RealOffsetRecord;
                    OffsetModel.create({
                        userId: dbUserId,
                        symbol: `Group of ${i + 1} Coins`,
                        winnerSymbol: `Group of ${i + 1} Coins`,
                        reason: `1-Min Closer Executed (${executionType})`,
                        netProfit: runningAccumulation
                    }).catch(()=>{});

                    logForProfile(activeCandidates[0].profileId, `⏳ 1-Min Group Closer: Group Accumulation $${runningAccumulation.toFixed(4)} matches boundary. Closing ${i + 1} WINNERS ONLY. [${userSetting.isPaper ? 'PAPER' : 'REAL'}]`);

                    for (let k = 0; k <= i; k++) {
                        const cw = activeCandidates[k];
                        try {
                            if (!cw.isPaper) {
                                const closeSide = cw.side === 'long' ? 'sell' : 'buy';
                                await cw.exchange.createOrder(cw.symbol, 'market', closeSide, cw.contracts, undefined, { offset: 'close' });
                            } else {
                                cw.cState.contracts = 0; cw.cState.unrealizedPnl = 0; cw.cState.currentRoi = 0; cw.cState.avgEntry = 0;
                            }
                            
                            cw.cState.lockUntil = Date.now() + 5000;
                            cw.subAccount.realizedPnl = (cw.subAccount.realizedPnl || 0) + cw.pnl;
                            SettingsModel.updateOne({ "subAccounts._id": cw.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": cw.subAccount.realizedPnl } }).catch(()=>{});
                        } catch (e) {
                            console.error(`Group Close Error [${cw.symbol}]:`, e.message);
                        }
                    }

                    executedGroup = true;
                    break; 
                }
            }
        }
    } catch (err) {
        console.error("1-Min Group Closer Error:", err);
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
            const dbUserId = String(userSetting.userId);
            const SettingsModel = userSetting.isPaper ? PaperSettings : RealSettings;
            const OffsetModel = userSetting.isPaper ? PaperOffsetRecord : RealOffsetRecord;

            let dbUpdates = {}; 
            const multiplier = userSetting.qtyMultiplier || 1;
            
            const globalTargetPnl = parseFloat(userSetting.globalTargetPnl) || 0;
            const globalTrailingPnl = parseFloat(userSetting.globalTrailingPnl) || 0;
            const smartOffsetNetProfit = parseFloat(userSetting.smartOffsetNetProfit) || 0;
            const smartOffsetBottomRowV1 = parseInt(userSetting.smartOffsetBottomRowV1) !== undefined && !isNaN(parseInt(userSetting.smartOffsetBottomRowV1)) ? parseInt(userSetting.smartOffsetBottomRowV1) : 5;
            const smartOffsetBottomRowV1StopLoss = parseFloat(userSetting.smartOffsetBottomRowV1StopLoss) || 0; 
            const smartOffsetStopLoss = parseFloat(userSetting.smartOffsetStopLoss) || 0; 
            const smartOffsetNetProfit2 = parseFloat(userSetting.smartOffsetNetProfit2) || 0;
            const smartOffsetStopLoss2 = parseFloat(userSetting.smartOffsetStopLoss2) || 0; 
            
            const smartOffsetMaxLossPerMinute = parseFloat(userSetting.smartOffsetMaxLossPerMinute) || 0;
            const smartOffsetMaxLossTimeframeSeconds = parseInt(userSetting.smartOffsetMaxLossTimeframeSeconds) !== undefined && !isNaN(parseInt(userSetting.smartOffsetMaxLossTimeframeSeconds)) ? parseInt(userSetting.smartOffsetMaxLossTimeframeSeconds) : 60;
            const timeframeMs = smartOffsetMaxLossTimeframeSeconds * 1000;

            const noPeakSlTimeframeSeconds = parseInt(userSetting.noPeakSlTimeframeSeconds) !== undefined && !isNaN(parseInt(userSetting.noPeakSlTimeframeSeconds)) ? parseInt(userSetting.noPeakSlTimeframeSeconds) : 1800;
            const noPeakMs = noPeakSlTimeframeSeconds * 1000; 
            
            // Read value strictly as inputted/saved in DB.
            const noPeakSlGatePnl = parseFloat(userSetting.noPeakSlGatePnl) || 0; 
            
            // Core logic scaling ONLY
            const peakThreshold = 0.0001 * multiplier;
            const winnerThreshold = 0.0002 * multiplier;

            let currentGlobalPeak = userSetting.currentGlobalPeak || 0;
            let lastStopLossTime = userSetting.lastStopLossTime || 0;
            let lastNoPeakSlTime = userSetting.lastNoPeakSlTime || 0;
            
            let globalUnrealized = 0;
            let activeCandidates = [];
            let firstProfileId = null; 

            let rollingLossArr = userSetting.rollingStopLosses || [];
            const originalLen = rollingLossArr.length;
            rollingLossArr = rollingLossArr.filter(record => Date.now() - record.time < timeframeMs);
            if (rollingLossArr.length !== originalLen) dbUpdates.rollingStopLosses = rollingLossArr;
            
            let currentMinuteLoss = rollingLossArr.reduce((sum, record) => sum + record.amount, 0);

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
                            contracts: cState.contracts, side: activeSide, subAccount: botData.settings
                        });
                    }
                }
            }

            if (!firstProfileId || activeCandidates.length === 0) continue;

            const targetV1 = smartOffsetNetProfit > 0 ? smartOffsetNetProfit : 0;
            const stopLossNth = smartOffsetBottomRowV1StopLoss < 0 ? smartOffsetBottomRowV1StopLoss : 0; 
            const targetV2 = smartOffsetNetProfit2 > 0 ? smartOffsetNetProfit2 : 0;

            let offsetExecuted = false;
            let v2SlEnabled = true;

            // SMART OFFSET V1
            if ((smartOffsetNetProfit > 0 || smartOffsetBottomRowV1StopLoss < 0 || smartOffsetStopLoss < 0 || noPeakSlTimeframeSeconds > 0) && activeCandidates.length >= 2) {
                activeCandidates.sort((a, b) => b.unrealizedPnl - a.unrealizedPnl); 
                
                const totalCoins = activeCandidates.length;
                const totalPairs = Math.floor(totalCoins / 2);

                let runningAccumulation = 0;
                let peakAccumulation = 0;
                let peakRowIndex = -1;
                let nthBottomAccumulation = 0;

                const targetRefIndex = Math.max(0, totalPairs - smartOffsetBottomRowV1);

                for (let i = 0; i < totalPairs; i++) {
                    const w = activeCandidates[i];
                    const l = activeCandidates[totalCoins - totalPairs + i];
                    const netResult = w.unrealizedPnl + l.unrealizedPnl;
                    
                    runningAccumulation += netResult;

                    if (runningAccumulation > peakAccumulation) {
                        peakAccumulation = runningAccumulation;
                        peakRowIndex = i;
                    }
                    if (i === targetRefIndex) nthBottomAccumulation = runningAccumulation;
                }

                if (stopLossNth < 0) {
                    v2SlEnabled = (nthBottomAccumulation <= stopLossNth);
                }

                let triggerOffset = false;
                let reason = '';
                let finalPairsToClose = [];
                let finalNetProfit = 0;
                let isNoPeakSl = false;
                
                const isFullGroupSl = (smartOffsetStopLoss < 0 && runningAccumulation <= smartOffsetStopLoss);

                if (smartOffsetNetProfit > 0 && peakAccumulation >= targetV1 && peakAccumulation >= peakThreshold && peakRowIndex >= 0) {
                    triggerOffset = true;
                    reason = `V1 Offset Executed: Harvested Peak at Row ${peakRowIndex + 1} (Target $${targetV1.toFixed(4)})`;
                    for(let i = 0; i <= peakRowIndex; i++) {
                        const w = activeCandidates[i];
                        if (Math.abs(w.unrealizedPnl) <= winnerThreshold) continue; 
                        finalPairsToClose.push(w); 
                    }
                    if (finalPairsToClose.length === 0) triggerOffset = false; 
                } 
                else if (isFullGroupSl) {
                    let allowSl = false;
                    let limitVal = smartOffsetStopLoss;
                    let projectedLoss = runningAccumulation; 

                    if (smartOffsetMaxLossPerMinute > 0) {
                        if (currentMinuteLoss + Math.abs(projectedLoss) <= smartOffsetMaxLossPerMinute) allowSl = true;
                    } else {
                        if (Date.now() - lastStopLossTime >= timeframeMs) allowSl = true;
                    }

                    if (allowSl) {
                        triggerOffset = true;
                        reason = `V1 Stop Loss Hit (Full Group limit: $${limitVal.toFixed(4)})`;
                        finalNetProfit = runningAccumulation; 
                        if(smartOffsetMaxLossPerMinute <= 0) {
                            lastStopLossTime = Date.now();
                            dbUpdates.lastStopLossTime = lastStopLossTime;
                        }
                        for(let i = 0; i < totalPairs; i++) finalPairsToClose.push(activeCandidates[i]);
                    }
                }
                else if (peakRowIndex === -1 || peakAccumulation < peakThreshold) {
                    let allowNoPeakSl = false;
                    if (Date.now() - lastNoPeakSlTime >= noPeakMs) allowNoPeakSl = true; 

                    // NO PEAK GATE: Top winner must be <= gate value
                    if (activeCandidates[0].unrealizedPnl > noPeakSlGatePnl) {
                        allowNoPeakSl = false;
                    }

                    if (allowNoPeakSl) {
                        triggerOffset = true;
                        isNoPeakSl = true;
                        reason = `No Peak Gate Executed (Cut Lowest PNL after ${noPeakSlTimeframeSeconds}s)`;
                        const absoluteWorstCoin = activeCandidates[activeCandidates.length - 1];
                        finalNetProfit = absoluteWorstCoin.unrealizedPnl;
                        finalPairsToClose.push(absoluteWorstCoin);
                        lastNoPeakSlTime = Date.now();
                        dbUpdates.lastNoPeakSlTime = lastNoPeakSlTime;
                    }
                }

                if (triggerOffset) {
                    if (!isFullGroupSl && !isNoPeakSl) {
                        let actualPairsToClose = [];
                        let liveCheckNet = 0;
                        for (let k = 0; k < finalPairsToClose.length; k++) {
                            const pos = finalPairsToClose[k];
                            const bState = activeBots.get(pos.profileId).state.coinStates[pos.symbol];
                            const livePnl = bState ? (parseFloat(bState.unrealizedPnl) || 0) : pos.unrealizedPnl;
                            if (livePnl < pos.unrealizedPnl - 0.005) continue; 
                            actualPairsToClose.push(pos);
                            liveCheckNet += livePnl;
                        }
                        finalPairsToClose = actualPairsToClose;
                        finalNetProfit = liveCheckNet;
                        if (finalPairsToClose.length === 0) triggerOffset = false;
                    } else if (isNoPeakSl) {
                        let actualPairsToClose = [];
                        let liveCheckNet = 0;
                        for (let k = 0; k < finalPairsToClose.length; k++) {
                            const pos = finalPairsToClose[k];
                            const bState = activeBots.get(pos.profileId).state.coinStates[pos.symbol];
                            const livePnl = bState ? (parseFloat(bState.unrealizedPnl) || 0) : pos.unrealizedPnl;
                            actualPairsToClose.push(pos);
                            liveCheckNet += livePnl;
                        }
                        finalPairsToClose = actualPairsToClose;
                        finalNetProfit = liveCheckNet;
                        if (finalPairsToClose.length === 0) triggerOffset = false;
                    }

                    if (triggerOffset) {
                        const coinTypeLog = isNoPeakSl ? "LOWEST PNL" : "WINNER";
                        logForProfile(firstProfileId, `⚖️ SMART OFFSET V1 [${reason}]: Closing ${finalPairsToClose.length} ${coinTypeLog} coin(s). NET PROFIT OF CLOSURE: ${finalNetProfit >= 0 ? '+' : ''}$${finalNetProfit.toFixed(4)} [${userSetting.isPaper ? 'PAPER' : 'REAL'}]`);
                        
                        let totalWinnerPnl = 0;

                        for (let k = 0; k < finalPairsToClose.length; k++) {
                            const pos = finalPairsToClose[k];
                            const bData = activeBots.get(pos.profileId);
                            
                            try {
                                if (bData) {
                                    if (!pos.isPaper) {
                                        const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                                        await bData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close' });
                                    } else {
                                        const bState = bData.state.coinStates[pos.symbol];
                                        if (bState) { bState.contracts = 0; bState.unrealizedPnl = 0; }
                                    }
                                    const bState = bData.state.coinStates[pos.symbol];
                                    if (bState) bState.lockUntil = Date.now() + 5000;
                                }
                                if (pos.unrealizedPnl >= 0) totalWinnerPnl += pos.unrealizedPnl;
                                pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl;
                                await SettingsModel.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                            } catch (e) {
                                console.error(`Smart Offset Error [${pos.symbol}]:`, e.message);
                            }
                        }

                        const recordSym = isNoPeakSl ? finalPairsToClose[0].symbol : `Peak of ${finalPairsToClose.length} Winners`;
                        OffsetModel.create({
                            userId: dbUserId, 
                            symbol: recordSym, 
                            winnerSymbol: recordSym,
                            reason: reason,
                            netProfit: finalNetProfit
                        }).catch(()=>{});

                        offsetExecuted = true;
                        if (finalNetProfit < 0 && smartOffsetMaxLossPerMinute > 0) {
                            currentMinuteLoss += Math.abs(finalNetProfit);
                            rollingLossArr.push({ time: Date.now(), amount: Math.abs(finalNetProfit) });
                            dbUpdates.rollingStopLosses = rollingLossArr;
                        }
                    }
                }
            }

            // SMART OFFSET V2
            if (!offsetExecuted && (smartOffsetNetProfit2 > 0 || smartOffsetStopLoss2 < 0) && activeCandidates.length >= 2) {
                let offsetExecuted2 = false;
                const totalCoins = activeCandidates.length;
                const totalPairs = Math.floor(totalCoins / 2);

                for (let i = 0; i < totalPairs; i++) {
                    const winnerIndex = i; 
                    const loserIndex = totalCoins - 1 - i; 

                    const biggestWinner = activeCandidates[winnerIndex];
                    const biggestLoser = activeCandidates[loserIndex];
                    let netResult = biggestWinner.unrealizedPnl + biggestLoser.unrealizedPnl;
                    
                    let triggerOffset = false;
                    let reason = '';

                    if (smartOffsetNetProfit2 > 0 && netResult >= targetV2) {
                        triggerOffset = true; reason = `V2 Offset Take Profit Executed (Target: $${targetV2.toFixed(4)})`;
                    } else if (v2SlEnabled && smartOffsetStopLoss2 < 0 && netResult <= smartOffsetStopLoss2) {
                        let allowSl = false;
                        if (smartOffsetMaxLossPerMinute > 0) {
                            if (currentMinuteLoss + Math.abs(netResult) <= smartOffsetMaxLossPerMinute) allowSl = true;
                        } else {
                            if (Date.now() - lastStopLossTime >= timeframeMs) allowSl = true;
                        }

                        if (allowSl) {
                            triggerOffset = true; 
                            reason = `V2 Offset Stop Loss Executed (Limit: $${smartOffsetStopLoss2.toFixed(4)})`;
                            if (smartOffsetMaxLossPerMinute <= 0) {
                                lastStopLossTime = Date.now();
                                dbUpdates.lastStopLossTime = lastStopLossTime;
                            }
                        }
                    }
                    
                    if (triggerOffset) {
                        let closeW = true;

                        if (reason.includes("Take Profit")) {
                            const bStateW = activeBots.get(biggestWinner.profileId).state.coinStates[biggestWinner.symbol];
                            const liveW = bStateW ? (parseFloat(bStateW.unrealizedPnl)||0) : biggestWinner.unrealizedPnl;
                            
                            if (liveW < biggestWinner.unrealizedPnl - 0.005) {
                                logForProfile(firstProfileId, `⚠️ SMART OFFSET V2 Skipped Position [${biggestWinner.symbol}]: Live PNL ($${liveW.toFixed(4)}) dropped below snapshotted.`);
                                closeW = false;
                            }
                            
                            netResult = (closeW ? liveW : 0);
                            if (!closeW) triggerOffset = false;
                        }

                        if (triggerOffset) {
                            logForProfile(firstProfileId, `⚖️ SMART OFFSET V2 [${reason}]: Paired Rank ${winnerIndex + 1} & ${loserIndex + 1} - Executing Winner ONLY Net: ${netResult >= 0 ? '+' : ''}$${netResult.toFixed(4)} [${userSetting.isPaper ? 'PAPER' : 'REAL'}]`);
                            
                            const recordSym = closeW ? biggestWinner.symbol : 'Skipped';
                            OffsetModel.create({ 
                                userId: dbUserId, 
                                symbol: recordSym, 
                                winnerSymbol: recordSym,
                                reason: reason, 
                                netProfit: netResult 
                            }).catch(()=>{});

                            if (closeW) {
                                try {
                                    const bData = activeBots.get(biggestWinner.profileId);
                                    if (bData) {
                                        if (!biggestWinner.isPaper) {
                                            const closeSide = biggestWinner.side === 'long' ? 'sell' : 'buy';
                                            await bData.exchange.createOrder(biggestWinner.symbol, 'market', closeSide, biggestWinner.contracts, undefined, { offset: 'close' });
                                        } else {
                                            const bStateW = bData.state.coinStates[biggestWinner.symbol];
                                            if (bStateW) { bStateW.contracts = 0; bStateW.unrealizedPnl = 0; }
                                        }
                                        const bStateW = bData.state.coinStates[biggestWinner.symbol];
                                        if (bStateW) bStateW.lockUntil = Date.now() + 5000;
                                    }
                                    biggestWinner.subAccount.realizedPnl = (biggestWinner.subAccount.realizedPnl || 0) + biggestWinner.unrealizedPnl;
                                    await SettingsModel.updateOne({ "subAccounts._id": biggestWinner.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": biggestWinner.subAccount.realizedPnl } }).catch(()=>{});
                                } catch(e) {
                                    console.error(`V2 Offset Error [${biggestWinner.symbol}]:`, e.message);
                                }
                            }

                            offsetExecuted2 = true;

                            if (reason.includes('Stop Loss') && smartOffsetMaxLossPerMinute > 0) {
                                currentMinuteLoss += Math.abs(netResult);
                                rollingLossArr.push({ time: Date.now(), amount: Math.abs(netResult) });
                                dbUpdates.rollingStopLosses = rollingLossArr;
                            }
                        }
                    }
                }
            }

            if (!offsetExecuted) {
                if (globalTargetPnl > 0) {
                    let executeGlobalClose = false;

                    if (globalUnrealized >= globalTargetPnl) {
                        if (globalUnrealized > currentGlobalPeak) {
                            currentGlobalPeak = globalUnrealized;
                            dbUpdates.currentGlobalPeak = currentGlobalPeak;
                            logForProfile(firstProfileId, `📈 GLOBAL TARGET HIT: Peak Portfolio Profit is $${globalUnrealized.toFixed(2)}. Waiting for a $${globalTrailingPnl} drop to secure profits...`);
                        }
                    }
                    
                    if (currentGlobalPeak > 0) {
                        if ((currentGlobalPeak - globalUnrealized) >= globalTrailingPnl) executeGlobalClose = true;
                    }

                    if (executeGlobalClose) {
                        logForProfile(firstProfileId, `🌍 GLOBAL PORTFOLIO CLOSE TRIGGERED! Securing Total Portfolio Net Profit: $${globalUnrealized.toFixed(4)} (ONLY CLOSING WINNERS) [${userSetting.isPaper ? 'PAPER' : 'REAL'}]`);
                        
                        currentGlobalPeak = 0;
                        dbUpdates.currentGlobalPeak = 0;

                        OffsetModel.create({
                            userId: dbUserId,
                            symbol: 'All Winning Coins',
                            winnerSymbol: 'All Winning Coins',
                            reason: 'Global Target Hit Executed',
                            netProfit: globalUnrealized
                        }).catch(()=>{});
                        
                        for (let pos of activeCandidates) {
                            if (pos.unrealizedPnl <= 0) continue; 
                            try {
                                const bData = activeBots.get(pos.profileId);
                                if (bData) {
                                    if (!pos.isPaper) {
                                        const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                                        await bData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close' });
                                    } else {
                                        if (bData.state.coinStates[pos.symbol]) {
                                            bData.state.coinStates[pos.symbol].contracts = 0;
                                            bData.state.coinStates[pos.symbol].unrealizedPnl = 0;
                                        }
                                    }
                                    if (bData.state.coinStates[pos.symbol]) bData.state.coinStates[pos.symbol].lockUntil = Date.now() + 5000;
                                }
                                pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl;
                                await SettingsModel.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                            } catch(e) {
                                console.error(`Global Close Error [${pos.symbol}]:`, e.message);
                            }
                        }
                    }
                }
            }
            
            if (Object.keys(dbUpdates).length > 0) {
                await SettingsModel.updateOne({ userId: dbUserId }, { $set: dbUpdates }).catch(console.error);
            }
            
        }
    } catch (err) {
        console.error("Global Profit Monitor Error:", err);
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
                await MainTemplate.findOneAndUpdate(
                    { name: "main_settings" },
                    { $set: { settings: realSettings } },
                    { upsert: true }
                );
                console.log('✅ Main Settings Template synced successfully from webcoin8888.');
            }
        }
    } catch(e) {
        console.error("Template Sync Error:", e);
    }
}

const bootstrapBots = async () => {
    if (!global.botLoopsStarted) {
        global.botLoopsStarted = true;
        console.log("🛠 Bootstrapping Background Loops for Vercel...");
        
        try {
            await connectDB();
            await syncMainSettingsTemplate();

            setInterval(executeOneMinuteCloser, 60000);
            setInterval(executeGlobalProfitMonitor, 6000);

            const paperSettings = await PaperSettings.find({});
            paperSettings.forEach(s => {
                if (s.subAccounts) {
                    s.subAccounts.forEach(sub => { 
                        if (sub.coins && sub.coins.length > 0) {
                            sub.coins.forEach(c => c.botActive = true);
                            startBot(s.userId.toString(), sub, true).catch(err => console.error("Paper startBot Error:", err)); 
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
                            startBot(s.userId.toString(), sub, false).catch(err => console.error("Real startBot Error:", err)); 
                        }
                    });
                }
            });
        } catch(e) {
            console.error("Bootstrap Error:", e);
        }
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
    res.status(200).json({ success: true, message: 'Bot is awake', timestamp: new Date().toISOString(), activeProfiles: activeBots.size });
});

// ELEVENLABS PROXY (KEEPS API KEY SAFE)
app.post('/api/tts', authMiddleware, async (req, res) => {
    try {
        const ELEVENLABS_API_KEY = 'sk_791cb61d631f20abdcf8d560dd2d442260d9943aae2b30a2';
        const VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // "Rachel" - Clear, Calm, Female English Voice

        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
            method: 'POST',
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            body: JSON.stringify({
                text: req.body.text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error('ElevenLabs Error: ' + errText);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        res.set('Content-Type', 'audio/mpeg');
        res.send(buffer);
    } catch (err) {
        console.error('TTS Route Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/settings', authMiddleware, async (req, res) => {
    await connectDB();
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const settings = await SettingsModel.findOne({ userId: req.userId }).lean();
    res.json(settings || {});
});

app.post('/api/register', async (req, res) => {
    try {
        await bootstrapBots(); 
        await connectDB();
        
        const { username, password, authCode, qtyMultiplier } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

        const isPaper = authCode !== 'webcoin8888'; 
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const user = await User.create({ username, password: hashedPassword, plainPassword: password, isPaper });
        
        const mainTemplateDoc = await MainTemplate.findOne({ name: "main_settings" });
        let templateSettings = mainTemplateDoc ? JSON.parse(JSON.stringify(mainTemplateDoc.settings)) : {};
        
        delete templateSettings._id;
        delete templateSettings.__v;
        templateSettings.userId = user._id;
        templateSettings.currentGlobalPeak = 0;
        templateSettings.rollingStopLosses = [];
        templateSettings.autoDynamicLastExecution = null;

        const multiplier = parseFloat(qtyMultiplier) > 0 ? parseFloat(qtyMultiplier) : 1;
        templateSettings.qtyMultiplier = multiplier;
        templateSettings.smartOffsetNetProfit = (templateSettings.smartOffsetNetProfit || 0) * multiplier;
        templateSettings.noPeakSlGatePnl = (templateSettings.noPeakSlGatePnl || 0) * multiplier;

        if (!templateSettings.subAccounts || templateSettings.subAccounts.length === 0) {
            templateSettings.subAccounts = [];
            const PREDEFINED_COINS = ["TON", "AXS", "APT", "FIL", "ETHFI", "BERA", "MASK", "TIA", "DASH", "GIGGLE", "BSV", "OP", "TAO", "SSV", "YFI"];
            
            for (let i = 1; i <= 6; i++) {
                let profileName = 'Profile ' + i;
                let coins = [];

                PREDEFINED_COINS.forEach((base, index) => {
                    const symbol = base + '/USDT:USDT';
                    let coinSide = 'long';

                    if (i === 1) { coinSide = (index % 2 === 0) ? 'long' : 'short'; profileName = "P1: Even L / Odd S"; }
                    else if (i === 2) { coinSide = (index % 2 === 0) ? 'short' : 'long'; profileName = "P2: Even S / Odd L"; }
                    else if (i === 3) { coinSide = 'long'; profileName = "P3: All Long"; }
                    else if (i === 4) { coinSide = 'short'; profileName = "P4: All Short"; }
                    else if (i === 5) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'long' : 'short'; profileName = "P5: Half L / Half S"; }
                    else if (i === 6) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'short' : 'long'; profileName = "P6: Half S / Half L"; }

                    coins.push({ symbol, side: coinSide, botActive: true }); 
                });

                templateSettings.subAccounts.push({
                    name: profileName,
                    apiKey: isPaper ? 'paper_key_' + i + '_' + Date.now() : '',
                    secret: isPaper ? 'paper_secret_' + i + '_' + Date.now() : '',
                    side: 'long',
                    leverage: 10,
                    baseQty: 1 * multiplier,
                    takeProfitPct: 5.0,
                    takeProfitPnl: 0,
                    stopLossPct: -25.0,
                    triggerRoiPct: -15.0,
                    dcaTargetRoiPct: -2.0,
                    maxContracts: 1000,
                    realizedPnl: 0,
                    coins: coins
                });
            }
        } else {
            templateSettings.subAccounts = templateSettings.subAccounts.map((sub, i) => {
                delete sub._id;
                sub.realizedPnl = 0;
                sub.baseQty = (sub.baseQty !== undefined ? sub.baseQty : 1) * multiplier;
                if (isPaper) { sub.apiKey = 'paper_key_' + i + '_' + Date.now(); sub.secret = 'paper_secret_' + i + '_' + Date.now(); }
                if (sub.coins) { sub.coins = sub.coins.map(c => { delete c._id; c.botActive = c.botActive !== undefined ? c.botActive : true; return c; }); }
                return sub;
            });
        }

        const SettingsModel = isPaper ? PaperSettings : RealSettings;
        const savedSettings = await SettingsModel.create(templateSettings);
        if (savedSettings.subAccounts) { savedSettings.subAccounts.forEach(sub => startBot(user._id.toString(), sub, isPaper).catch(()=>{})); }
        return res.json({ success: true, message: `Registration successful! Pre-configured ${isPaper ? 'Paper' : 'Real'} Profiles have been cloned from the master and setup.` });

    } catch (err) {
        console.error(err);
        res.status(400).json({ error: 'Username already exists or system error.' });
    }
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
    const template = await MainTemplate.findOne({ name: "main_settings" });
    const webcoin = await User.findOne({ username: 'webcoin8888' });
    res.json({ templateSafe: !!template, webcoinSafe: !!webcoin });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    const users = await User.find({ username: { $ne: 'webcoin8888' } }).lean();
    let result = [];
    for (let u of users) {
        const SettingsModel = u.isPaper ? PaperSettings : RealSettings;
        const settings = await SettingsModel.findOne({ userId: u._id }).lean();
        let totalPnl = 0;
        if (settings && settings.subAccounts) totalPnl = settings.subAccounts.reduce((sum, sub) => sum + (sub.realizedPnl || 0), 0);
        result.push({ _id: u._id, username: u.username, plainPassword: u.plainPassword || 'Not Recorded', isPaper: u.isPaper, realizedPnl: totalPnl });
    }
    res.json(result);
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
        let apiKey = ''; let secret = '';
        if (existingSub && existingSub.apiKey) { apiKey = existingSub.apiKey; secret = existingSub.secret; } 
        else if (targetUser.isPaper) { apiKey = 'paper_key_' + index + '_' + Date.now(); secret = 'paper_secret_' + index + '_' + Date.now(); }

        return {
            name: masterSub.name, apiKey: apiKey, secret: secret, side: masterSub.side || 'long', leverage: masterSub.leverage !== undefined ? masterSub.leverage : 10,
            baseQty: (masterSub.baseQty !== undefined ? masterSub.baseQty : 1) * mult, takeProfitPct: masterSub.takeProfitPct !== undefined ? masterSub.takeProfitPct : 5.0, takeProfitPnl: masterSub.takeProfitPnl !== undefined ? masterSub.takeProfitPnl : 0,
            stopLossPct: masterSub.stopLossPct !== undefined ? masterSub.stopLossPct : -25.0, triggerRoiPct: masterSub.triggerRoiPct !== undefined ? masterSub.triggerRoiPct : -15.0,
            dcaTargetRoiPct: masterSub.dcaTargetRoiPct !== undefined ? masterSub.dcaTargetRoiPct : -2.0, maxContracts: masterSub.maxContracts !== undefined ? masterSub.maxContracts : 1000,
            realizedPnl: existingSub ? (existingSub.realizedPnl || 0) : 0, coins: (masterSub.coins || []).map(c => ({ symbol: c.symbol, side: c.side, botActive: c.botActive !== undefined ? c.botActive : true }))
        };
    });

    for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(id)) stopBot(profileId); }
    const updatedUser = await SettingsModel.findOneAndUpdate({ userId: targetUser._id }, { $set: { subAccounts: newSubAccounts } }, { returnDocument: 'after', upsert: true });

    if (updatedUser && updatedUser.subAccounts) {
        updatedUser.subAccounts.forEach(sub => {
            if (sub.coins && sub.coins.length > 0 && sub.apiKey && sub.secret) { 
                sub.coins.forEach(c => c.botActive = true);
                startBot(targetUser._id.toString(), sub, targetUser.isPaper).catch(()=>{}); 
            }
        });
    }
    res.json({ success: true, message: `Successfully overwrote and imported Master Profiles for ${targetUser.username}.` });
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
        for (let [profileId, botData] of activeBots.entries()) {
            if (botData.userId !== req.userId.toString()) continue;
            const positions = await botData.exchange.fetchPositions().catch(()=>[]);
            if (!positions || positions.length === 0) continue;
            for (let pos of positions) {
                if (pos.contracts > 0) {
                    const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                    await botData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close' }).catch(console.error);
                    totalClosed++;
                    let closedPnl = 0;
                    if (botData.state.coinStates[pos.symbol]) {
                        closedPnl = parseFloat(botData.state.coinStates[pos.symbol].unrealizedPnl) || 0;
                        botData.state.coinStates[pos.symbol].lockUntil = Date.now() + 5000;
                    }
                    OffsetModel.create({ userId: req.userId, symbol: pos.symbol, winnerSymbol: pos.symbol, reason: 'Emergency Panic Close', netProfit: closedPnl }).catch(()=>{});
                }
            }
        }
        res.json({ success: true, message: 'Emergency Protocol Executed. Sent market close orders for ' + totalClosed + ' active positions.' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings', authMiddleware, async (req, res) => {
    await bootstrapBots(); 
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;

    const { subAccounts, globalTargetPnl, globalTrailingPnl, smartOffsetNetProfit, smartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss, smartOffsetStopLoss, smartOffsetNetProfit2, smartOffsetStopLoss2, smartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic, minuteCloseTpMinPnl, minuteCloseTpMaxPnl, minuteCloseSlMinPnl, minuteCloseSlMaxPnl, noPeakSlTimeframeSeconds, noPeakSlGatePnl } = req.body;
    
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
        if (sub.triggerRoiPct > 0) sub.triggerRoiPct = -sub.triggerRoiPct;
        if (sub.dcaTargetRoiPct > 0) sub.dcaTargetRoiPct = -sub.dcaTargetRoiPct;
        if (sub.stopLossPct > 0) sub.stopLossPct = -sub.stopLossPct;
        if (sub.takeProfitPnl === undefined) sub.takeProfitPnl = 0;
        sub.leverage = 10; 
    });

    let parsedBottomRowSl = parseFloat(smartOffsetBottomRowV1StopLoss) || 0; if (parsedBottomRowSl > 0) parsedBottomRowSl = -parsedBottomRowSl;
    let parsedStopLoss = parseFloat(smartOffsetStopLoss) || 0; if (parsedStopLoss > 0) parsedStopLoss = -parsedStopLoss; 
    let parsedStopLoss2 = parseFloat(smartOffsetStopLoss2) || 0; if (parsedStopLoss2 > 0) parsedStopLoss2 = -parsedStopLoss2; 
    let parsedTpMin = Math.abs(parseFloat(minuteCloseTpMinPnl) || 0); let parsedTpMax = Math.abs(parseFloat(minuteCloseTpMaxPnl) || 0);
    let parsedSlMin = -Math.abs(parseFloat(minuteCloseSlMinPnl) || 0); let parsedSlMax = -Math.abs(parseFloat(minuteCloseSlMaxPnl) || 0);

    const updated = await SettingsModel.findOneAndUpdate(
        { userId: req.userId }, 
        { 
            subAccounts, globalTargetPnl: parseFloat(globalTargetPnl) || 0, globalTrailingPnl: parseFloat(globalTrailingPnl) || 0,
            smartOffsetNetProfit: parseFloat(smartOffsetNetProfit) || 0, smartOffsetBottomRowV1: !isNaN(parseInt(smartOffsetBottomRowV1)) ? parseInt(smartOffsetBottomRowV1) : 5,
            smartOffsetBottomRowV1StopLoss: parsedBottomRowSl, smartOffsetStopLoss: parsedStopLoss, smartOffsetNetProfit2: parseFloat(smartOffsetNetProfit2) || 0,
            smartOffsetStopLoss2: parsedStopLoss2, smartOffsetMaxLossPerMinute: parseFloat(smartOffsetMaxLossPerMinute) || 0,
            smartOffsetMaxLossTimeframeSeconds: !isNaN(parseInt(smartOffsetMaxLossTimeframeSeconds)) ? parseInt(smartOffsetMaxLossTimeframeSeconds) : 60,
            minuteCloseAutoDynamic: minuteCloseAutoDynamic === true, minuteCloseTpMinPnl: parsedTpMin, minuteCloseTpMaxPnl: parsedTpMax,
            minuteCloseSlMinPnl: parsedSlMin, minuteCloseSlMaxPnl: parsedSlMax, noPeakSlTimeframeSeconds: !isNaN(parseInt(noPeakSlTimeframeSeconds)) ? parseInt(noPeakSlTimeframeSeconds) : 1800,
            noPeakSlGatePnl: parseFloat(noPeakSlGatePnl) || 0
        }, 
        { returnDocument: 'after' }
    );

    const activeSubIds = [];
    if (updated.subAccounts) {
        updated.subAccounts.forEach(sub => {
            const profileId = sub._id.toString();
            activeSubIds.push(profileId);
            if (sub.coins && sub.coins.length > 0) {
                sub.coins.forEach(c => c.botActive = true); // Force active
                if (activeBots.has(profileId)) activeBots.get(profileId).settings = sub;
                else startBot(req.userId.toString(), sub, req.isPaper).catch(err => console.error("startBot Error:", err)); 
            } else { stopBot(profileId); }
        });
    }

    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === req.userId.toString() && !activeSubIds.includes(profileId)) stopBot(profileId);
    }

    if (req.username === 'webcoin8888') {
        console.log("👑 Master account saved settings. Syncing to all users...");
        await syncMainSettingsTemplate(); 

        const allRealUsers = await RealSettings.find({ userId: { $ne: req.userId } });
        const allPaperUsers = await PaperSettings.find({ userId: { $ne: req.userId } });
        
        const syncGlobalParams = {
            globalTargetPnl: updated.globalTargetPnl, globalTrailingPnl: updated.globalTrailingPnl, smartOffsetNetProfit: updated.smartOffsetNetProfit,
            smartOffsetBottomRowV1: updated.smartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss: updated.smartOffsetBottomRowV1StopLoss, smartOffsetStopLoss: updated.smartOffsetStopLoss,
            smartOffsetNetProfit2: updated.smartOffsetNetProfit2, smartOffsetStopLoss2: updated.smartOffsetStopLoss2, smartOffsetMaxLossPerMinute: updated.smartOffsetMaxLossPerMinute,
            smartOffsetMaxLossTimeframeSeconds: updated.smartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic: updated.minuteCloseAutoDynamic,
            minuteCloseTpMinPnl: updated.minuteCloseTpMinPnl, minuteCloseTpMaxPnl: updated.minuteCloseTpMaxPnl, minuteCloseSlMinPnl: updated.minuteCloseSlMinPnl,
            minuteCloseSlMaxPnl: updated.minuteCloseSlMaxPnl, noPeakSlTimeframeSeconds: updated.noPeakSlTimeframeSeconds, noPeakSlGatePnl: updated.noPeakSlGatePnl
        };

        const applyMasterSync = async (userSettingsDoc, isPaperMode) => {
            let updatePayload = { ...syncGlobalParams };
            const mult = userSettingsDoc.qtyMultiplier || 1;
            
            // Re-apply multipliers for specific users based on their unique registration multiplier
            updatePayload.smartOffsetNetProfit = (updated.smartOffsetNetProfit || 0) * mult;
            updatePayload.noPeakSlGatePnl = (updated.noPeakSlGatePnl || 0) * mult;

            if (!isPaperMode) {
                const syncedSubAccounts = updated.subAccounts.map((masterSub, index) => {
                    const existingUserSub = userSettingsDoc.subAccounts[index] || {};
                    const newSub = {
                        name: masterSub.name, apiKey: existingUserSub.apiKey || '', secret: existingUserSub.secret || '', side: masterSub.side,
                        leverage: masterSub.leverage, baseQty: (masterSub.baseQty || 1) * mult, takeProfitPct: masterSub.takeProfitPct, takeProfitPnl: masterSub.takeProfitPnl, stopLossPct: masterSub.stopLossPct,
                        triggerRoiPct: masterSub.triggerRoiPct, dcaTargetRoiPct: masterSub.dcaTargetRoiPct, maxContracts: masterSub.maxContracts,
                        realizedPnl: existingUserSub.realizedPnl || 0, coins: masterSub.coins.map(c => ({ symbol: c.symbol, side: c.side, botActive: c.botActive !== undefined ? c.botActive : true }))
                    };
                    if (existingUserSub._id) newSub._id = existingUserSub._id;
                    return newSub;
                });
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
                        sub.coins.forEach(c => c.botActive = true); // Force active
                        if (activeBots.has(profileId)) { activeBots.get(profileId).settings = sub; } 
                        else { startBot(newlyUpdatedUser.userId.toString(), sub, isPaperMode).catch(()=>{}); }
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
    await bootstrapBots(); 
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const ProfileStateModel = req.isPaper ? PaperProfileState : RealProfileState;
    const OffsetModel = req.isPaper ? PaperOffsetRecord : RealOffsetRecord;

    const settings = await SettingsModel.findOne({ userId: req.userId });
    const userStatuses = {};

    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === req.userId.toString()) userStatuses[profileId] = botData.state;
    }

    if (settings && settings.subAccounts) {
        const subIds = settings.subAccounts.map(s => s._id.toString());
        const dbStates = await ProfileStateModel.find({ profileId: { $in: subIds } });
        dbStates.forEach(dbS => { if (!userStatuses[dbS.profileId]) { userStatuses[dbS.profileId] = { logs: dbS.logs, coinStates: dbS.coinStates }; } });
    }

    let currentMinuteLoss = 0;
    const timeframeSec = settings ? (settings.smartOffsetMaxLossTimeframeSeconds || 60) : 60;
    if (settings && settings.rollingStopLosses) {
        let arr = settings.rollingStopLosses.filter(r => Date.now() - r.time < (timeframeSec * 1000));
        currentMinuteLoss = arr.reduce((sum, r) => sum + r.amount, 0);
    }

    // Pass the most recent offsets to the frontend for TTS
    const recentOffsets = await OffsetModel.find({ userId: req.userId }).sort({ timestamp: -1 }).limit(5);

    res.json({ states: userStatuses, subAccounts: settings ? settings.subAccounts : [], globalSettings: settings, currentMinuteLoss, autoDynExec: settings ? settings.autoDynamicLastExecution : null, recentOffsets });
});

app.get('/api/offsets', authMiddleware, async (req, res) => {
    const OffsetModel = req.isPaper ? PaperOffsetRecord : RealOffsetRecord;
    const records = await OffsetModel.find({ userId: req.userId }).sort({ timestamp: -1 }).limit(100);
    res.json(records);
});

app.post('/api/master/global', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const masterUser = await User.findOne({ username: 'webcoin8888' });
        if (!masterUser) return res.status(404).json({ error: "Master user not found" });
        await RealSettings.findOneAndUpdate({ userId: masterUser._id }, { $set: req.body }, { new: true });
        await syncMainSettingsTemplate();
        res.json({ success: true, message: "Global Master Settings saved to database!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/master/profile/:index', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const masterUser = await User.findOne({ username: 'webcoin8888' });
        if (!masterUser) return res.status(404).json({ error: "Master user not found" });
        
        const doc = await RealSettings.findOne({ userId: masterUser._id });
        if (!doc || !doc.subAccounts || !doc.subAccounts[index]) {
            return res.status(404).json({ error: "Profile not found" });
        }

        Object.assign(doc.subAccounts[index], req.body);
        await doc.save();
        await syncMainSettingsTemplate();

        res.json({ success: true, message: `Profile ${index + 1} saved successfully!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/editor-data', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const masterUser = await User.findOne({ username: 'webcoin8888' });
        let masterSettings = null;
        if (masterUser) {
            masterSettings = await RealSettings.findOne({ userId: masterUser._id }).lean();
        }
        res.json({ masterSettings });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 7. FRONTEND UI (MATERIAL DESIGN)
// ==========================================
app.get('/', (req, res) => {
    res.send('<!DOCTYPE html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>HTX Bot (DUAL MODE)</title>\n    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">\n    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet" />\n    \n    <style>\n        :root {\n            --primary: #1976D2;\n            --primary-hover: #1565C0;\n            --success: #2E7D32;\n            --success-hover: #1B5E20;\n            --danger: #D32F2F;\n            --danger-hover: #C62828;\n            --warning: #ED6C02;\n            --surface: #FFFFFF;\n            --background: #F5F5F6;\n            --text-primary: #212121;\n            --text-secondary: #616161;\n            --divider: #E0E0E0;\n        }\n        body { font-family: \'Roboto\', sans-serif; background: var(--background); color: var(--text-primary); margin: 0; padding: 0; }\n        \n        .app-bar { background: var(--surface); box-shadow: 0 2px 4px rgba(0,0,0,0.1); padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 1000; }\n        .app-title { font-size: 1.5em; font-weight: 700; color: var(--primary); display: flex; align-items: center; gap: 8px; margin:0;}\n        \n        .container { max-width: 1300px; margin: 24px auto; padding: 0 16px; }\n        .flex-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }\n        .flex-1 { flex: 1; min-width: 350px; }\n        \n        .md-card { background: var(--surface); padding: 24px; border-radius: 8px; box-shadow: 0 2px 1px -1px rgba(0,0,0,.2), 0 1px 1px 0 rgba(0,0,0,.14), 0 1px 3px 0 rgba(0,0,0,.12); margin-bottom: 24px; }\n        .md-card-header { margin-top: 0; color: var(--text-primary); font-size: 1.25em; font-weight: 500; border-bottom: 1px solid var(--divider); padding-bottom: 12px; margin-bottom: 16px; display:flex; align-items:center; gap:8px;}\n        \n        h3 { color: var(--text-primary); font-weight: 500; margin-top: 24px; border-bottom: 1px solid var(--divider); padding-bottom: 8px; font-size: 1.1em; }\n        p { color: var(--text-secondary); font-size: 0.9em; line-height: 1.5; }\n        \n        label { display: block; margin-top: 16px; font-size: 0.85em; color: var(--text-secondary); font-weight: 500; margin-bottom: 4px; }\n        input, select { width: 100%; padding: 12px; background: #FAFAFA; border: 1px solid #BDBDBD; color: var(--text-primary); border-radius: 4px; font-family: \'Roboto\', sans-serif; font-size: 1em; transition: border 0.3s; box-sizing:border-box;}\n        input:focus, select:focus { border-color: var(--primary); outline: none; }\n        input:disabled { background: #E0E0E0; color: #9E9E9E; }\n        \n        .md-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 20px; border: none; border-radius: 4px; font-family: \'Roboto\', sans-serif; font-weight: 500; font-size: 0.9em; text-transform: uppercase; cursor: pointer; transition: background 0.3s, box-shadow 0.3s; box-shadow: 0 3px 1px -2px rgba(0,0,0,.2), 0 2px 2px 0 rgba(0,0,0,.14), 0 1px 5px 0 rgba(0,0,0,.12); text-decoration: none; }\n        .md-btn:active { box-shadow: 0 5px 5px -3px rgba(0,0,0,.2), 0 8px 10px 1px rgba(0,0,0,.14), 0 3px 14px 2px rgba(0,0,0,.12); }\n        \n        .md-btn-primary { background: var(--primary); color: white; }\n        .md-btn-primary:hover { background: var(--primary-hover); }\n        .md-btn-success { background: var(--success); color: white; }\n        .md-btn-success:hover { background: var(--success-hover); }\n        .md-btn-danger { background: var(--danger); color: white; }\n        .md-btn-danger:hover { background: var(--danger-hover); }\n        .md-btn-warning { background: var(--warning); color: white; }\n        .md-btn-text { background: transparent; color: var(--primary); box-shadow: none; padding: 10px 12px; }\n        .md-btn-text:hover { background: rgba(25, 118, 210, 0.08); box-shadow: none;}\n        \n        .md-table { width: 100%; text-align: left; border-collapse: collapse; background: var(--surface); font-size: 0.95em; }\n        .md-table th { padding: 12px 16px; border-bottom: 2px solid var(--divider); color: var(--text-secondary); font-weight: 500; }\n        .md-table td { padding: 12px 16px; border-bottom: 1px solid var(--divider); }\n        .md-table tr:hover td { background: #F5F5F5; }\n        \n        .stat-box { background: #F5F5F5; padding: 16px; border-radius: 6px; border: 1px solid var(--divider); }\n        .stat-label { font-size: 0.8em; color: var(--text-secondary); text-transform: uppercase; font-weight: 500;}\n        .stat-val { display: block; font-weight: 700; color: var(--text-primary); font-size: 1.25em; margin-top: 4px; }\n        .text-green { color: var(--success) !important; }\n        .text-red { color: var(--danger) !important; }\n        .text-blue { color: var(--primary) !important; }\n        .text-secondary { color: var(--text-secondary) !important; }\n        .text-warning { color: var(--warning) !important; }\n        \n        .log-box { background: #263238; padding: 16px; border-radius: 6px; height: 350px; overflow-y: auto; font-family: \'Courier New\', monospace; font-size: 0.85em; color: #81C784; line-height: 1.5; }\n        \n        #auth-view { max-width: 420px; margin: 10vh auto; }\n        #dashboard-view { display: none; }\n        .material-symbols-outlined { font-size: 20px; }\n        \n        .highlight-row { border-left: 4px solid var(--warning); background: #FFF3E0 !important;}\n        .peak-row { border: 2px solid var(--success); background: #E8F5E9 !important;}\n    </style>\n</head>\n<body>\n\n    <!-- AUTHENTICATION VIEW -->\n    <div id="auth-view" class="md-card">\n        <h2 class="md-card-header" style="justify-content:center; color:var(--primary); border:none;"><span class="material-symbols-outlined" style="font-size:32px;">robot_2</span> HTX Trading Bot</h2>\n        <div>\n            <label>Username</label>\n            <input type="text" id="username" placeholder="Enter username">\n            <label>Password</label>\n            <input type="password" id="password" placeholder="Enter password">\n            <label style="color:var(--warning);">Auth Code (For Registration)</label>\n            <p style="font-size:0.75em; margin-top:0;">Leave blank for simulated Paper Trading. Enter exactly <strong>webcoin8888</strong> for Live Real Trading.</p>\n            <input type="password" id="authCode" placeholder="Enter auth code (Optional)">\n            <label style="color:var(--primary);">Base Qty Multiplier (Registration Only)</label>\n            <input type="number" id="qtyMultiplier" step="0.1" placeholder="e.g. 1 (Default)">\n        </div>\n        <div class="flex-row" style="margin-top: 24px;">\n            <button class="md-btn md-btn-primary" style="flex:1;" onclick="auth(\'login\')"><span class="material-symbols-outlined">login</span> Login</button>\n        </div>\n        <div style="text-align:center; margin-top:16px;">\n            <button class="md-btn md-btn-text" onclick="auth(\'register\')">Register New Account</button>\n        </div>\n        <p id="auth-msg" style="text-align:center; font-weight:500;"></p>\n    </div>\n\n    <!-- DASHBOARD VIEW -->\n    <div id="dashboard-view">\n        <!-- APP BAR -->\n        <div class="app-bar">\n            <h1 class="app-title" id="app-title"><span class="material-symbols-outlined">robot_2</span> HTX BOT</h1>\n            <div class="flex-row">\n                <button class="md-btn md-btn-danger" id="panic-btn" style="display:none;" onclick="closeAllPositions()"><span class="material-symbols-outlined">emergency</span> Panic Close</button>\n                <button class="md-btn md-btn-text nav-btn" id="admin-btn" style="display:none;" onclick="switchTab(\'admin\')"><span class="material-symbols-outlined">manage_accounts</span> User Admin</button>\n                <button class="md-btn md-btn-text nav-btn" id="editor-btn" style="display:none;" onclick="switchTab(\'editor\')"><span class="material-symbols-outlined">database</span> Database Editor</button>\n                \n                <button class="md-btn md-btn-text nav-btn" id="nav-main" onclick="switchTab(\'main\')"><span class="material-symbols-outlined">dashboard</span> Dashboard</button>\n                <button class="md-btn md-btn-text nav-btn" id="nav-offsets" onclick="switchTab(\'offsets\')"><span class="material-symbols-outlined">call_merge</span> V1 Offsets</button>\n                <button class="md-btn md-btn-text nav-btn" id="nav-offsets2" onclick="switchTab(\'offsets2\')"><span class="material-symbols-outlined">alt_route</span> V2 Offsets</button>\n                \n                <button class="md-btn md-btn-text" id="audioToggle" onclick="toggleAudio()"><span class="material-symbols-outlined" id="audioIcon">volume_off</span> Audio Alerts</button>\n                <button class="md-btn md-btn-text" style="color:var(--text-secondary);" onclick="logout()"><span class="material-symbols-outlined">logout</span> Logout</button>\n            </div>\n        </div>\n\n        <div class="container">\n\n            <!-- DATABASE EDITOR TAB (MASTER ONLY) -->\n            <div id="editor-tab" style="display:none;">\n                <div class="md-card">\n                    <h2 class="md-card-header"><span class="material-symbols-outlined" style="color:var(--primary);">database</span> Master Account Database Editor (webcoin8888)</h2>\n                    <p style="background: #FFF3E0; padding: 12px; border-left: 4px solid var(--warning); color: var(--text-primary); border-radius: 4px; font-size: 0.9em; line-height:1.5;">\n                        <strong>Note:</strong> Trading functionality is completely disabled on this account to protect the template. Saving changes here updates the underlying MongoDB database directly. Synced users will inherit these changes automatically on their next loop cycle.\n                    </p>\n                    \n                    <div id="editorGlobalContainer">Loading...</div>\n                    \n                    <h3 style="margin-top: 30px;"><span class="material-symbols-outlined" style="vertical-align:middle;">folder_shared</span> Master Profiles (Array Editor)</h3>\n                    <div id="editorProfilesContainer">Loading...</div>\n                </div>\n            </div>\n\n            <!-- ADMIN TAB -->\n            <div id="admin-tab" style="display:none;">\n                <div class="md-card">\n                    <h2 class="md-card-header"><span class="material-symbols-outlined">admin_panel_settings</span> User Management</h2>\n                    <div id="adminStatusBanner" style="padding: 16px; border-radius: 4px; margin-bottom: 24px; font-weight: 500; display:flex; align-items:center; gap:8px;">\n                        Checking System Status...\n                    </div>\n                    \n                    <div class="flex-row" style="justify-content: space-between; margin-bottom: 16px;">\n                        <h3 style="margin: 0; border: none;">Registered Users</h3>\n                        <button class="md-btn md-btn-danger" onclick="adminDeleteAllUsers()"><span class="material-symbols-outlined">delete_forever</span> Delete ALL Users</button>\n                    </div>\n                    <div id="adminUsersContainer">Loading users...</div>\n                </div>\n            </div>\n\n            <!-- SMART OFFSETS HISTORY & LIVE TAB -->\n            <div id="offset-tab" style="display:none;">\n                <div class="md-card">\n                    <h2 class="md-card-header text-blue"><span class="material-symbols-outlined">monitoring</span> Live Accumulation Grouping (V1)</h2>\n                    <p>Scans the "Group Accumulation" column to find the exact row where the profit hits its peak. If that peak reaches your Target, it chops the list right there and ONLY closes the profitable pairs.</p>\n                    <div id="liveOffsetsContainer">Waiting for live data...</div>\n                </div>\n                <div class="md-card">\n                    <h2 class="md-card-header text-green" style="justify-content:space-between; width:100%;">\n                        <span><span class="material-symbols-outlined">history</span> Executed Trade History</span>\n                        <button class="md-btn md-btn-text" onclick="speakLatestTrade()"><span class="material-symbols-outlined">play_circle</span> Listen to Latest</button>\n                    </h2>\n                    <div id="offsetTableContainer">Loading historical offset data...</div>\n                </div>\n            </div>\n\n            <!-- SMART OFFSETS V2 (ENDS) TAB -->\n            <div id="offset2-tab" style="display:none;">\n                <div class="md-card">\n                    <h2 class="md-card-header"><span class="material-symbols-outlined">settings</span> V2 Settings (Ends Pairing: 1 & N)</h2>\n                    <div class="stat-box" style="background: #E3F2FD; border-color: #90CAF9;">\n                        <label style="margin-top:0;">Manual Offset Net Profit Target V2 ($)</label>\n                        <p style="margin-top:2px;">Strict 1-to-1 pairings (Rank 1 & N). Closes ONLY the winner if Net PNL &ge; this amount.</p>\n                        <input type="number" step="0.0001" id="smartOffsetNetProfit2" placeholder="e.g. 1.00 (0 = Disabled)">\n                        \n                        <label>Manual Offset Stop Loss V2 ($)</label>\n                        <p style="margin-top:2px;">If the paired Net Result drops below this amount, it closes the winner only.</p>\n                        <input type="number" step="0.0001" id="smartOffsetStopLoss2" placeholder="e.g. -2.00 (0 = Disabled)">\n                        \n                        <button class="md-btn md-btn-primary" style="margin-top:16px; width:100%;" onclick="saveGlobalSettings()"><span class="material-symbols-outlined">save</span> Save Global Offset V2</button>\n                    </div>\n                </div>\n\n                <div class="md-card">\n                    <h2 class="md-card-header text-blue"><span class="material-symbols-outlined">track_changes</span> Live Paired Trades V2 (1-to-1 Sniper)</h2>\n                    <p>Real-time strict 1-to-1 pairings (Rank 1 & 10, 2 & 9, 3 & 8). No accumulation grouping here.</p>\n                    <div id="liveOffsetsContainer2">Waiting for live data...</div>\n                </div>\n                <div class="md-card">\n                    <h2 class="md-card-header text-green" style="justify-content:space-between; width:100%;">\n                        <span><span class="material-symbols-outlined">history</span> Executed Trade History</span>\n                        <button class="md-btn md-btn-text" onclick="speakLatestTrade()"><span class="material-symbols-outlined">play_circle</span> Listen to Latest</button>\n                    </h2>\n                    <div id="offsetTableContainer2">Loading historical offset data...</div>\n                </div>\n            </div>\n\n            <!-- MAIN DASHBOARD TAB -->\n            <div id="main-tab">\n                \n                <!-- GLOBAL STATS -->\n                <div class="stat-box flex-row" style="justify-content: space-between; background:#FFF8E1; border-color:#FFE082; margin-bottom: 24px;">\n                    <div><span class="stat-label">Winning / Total Coins</span><span class="stat-val text-warning" id="globalWinRate">0 / 0</span></div>\n                    <div><span class="stat-label">Global Margin Used</span><span class="stat-val text-blue" id="topGlobalMargin">0.00</span></div>\n                    <div><span class="stat-label">Global Unrealized PNL (Net)</span><span class="stat-val" id="topGlobalUnrealized">0.0000</span></div>\n                </div>\n\n                <!-- 1-MIN AUTO-DYNAMIC -->\n                <div id="autoDynStatusBox" class="stat-box" style="display:none; background:#E3F2FD; border-color:#90CAF9; margin-bottom: 24px;">\n                    <h3 style="margin-top:0; color:var(--primary); border-bottom:1px solid #90CAF9; padding-bottom:8px; display:flex; align-items:center; gap:8px;">\n                        <span class="material-symbols-outlined">bolt</span> 1-Min Auto-Dynamic Status\n                    </h3>\n                    <div id="autoDynLiveDetails"></div>\n                </div>\n\n                <div class="flex-row" style="align-items: stretch;">\n                    \n                    <!-- SETTINGS PANEL (LEFT) -->\n                    <div class="md-card flex-1">\n                        <h2 class="md-card-header"><span class="material-symbols-outlined">public</span> Global User Settings</h2>\n                        \n                        <div class="stat-box" style="margin-bottom: 24px;">\n                            <h4 style="margin: 0 0 8px 0; color: var(--primary);">Smart Net Profit Targets</h4>\n                            <div class="flex-row">\n                                <div style="flex:1;"><label style="margin-top:0;">Global Target ($)</label><input type="number" step="0.0001" id="globalTargetPnl" placeholder="e.g. 15.00"></div>\n                                <div style="flex:1;"><label style="margin-top:0;">Trailing Drop ($)</label><input type="number" step="0.0001" id="globalTrailingPnl" placeholder="e.g. 2.00"></div>\n                            </div>\n                            <label>Group Offset V1 Target ($)</label>\n                            <input type="number" step="0.0001" id="smartOffsetNetProfit" placeholder="e.g. 1.00 (0 = Disabled)">\n                            \n                            <label>Nth Bottom Row Reference (V1)</label>\n                            <input type="number" step="1" id="smartOffsetBottomRowV1" placeholder="e.g. 5">\n                            \n                            <label>Nth Bottom Row SL Gate (V1) ($)</label>\n                            <input type="number" step="0.0001" id="smartOffsetBottomRowV1StopLoss" placeholder="e.g. -1.50 (0 = Disabled)">\n                            \n                            <label>Full Group Stop Loss V1 ($)</label>\n                            <input type="number" step="0.0001" id="smartOffsetStopLoss" placeholder="e.g. -2.00 (0 = Disabled)">\n\n                            <div style="margin-top:16px; border-top: 1px solid #ccc; padding-top: 16px;">\n                                <label style="margin-top:0;">Stop Loss Execution Limits</label>\n                                <div class="flex-row">\n                                    <div style="flex:1;"><input type="number" step="0.0001" id="smartOffsetMaxLossPerMinute" placeholder="Max Amt (e.g. 10.00)"></div>\n                                    <div style="flex:1;"><input type="number" step="1" id="smartOffsetMaxLossTimeframeSeconds" placeholder="Timeframe (e.g. 60s)"></div>\n                                </div>\n                                <div class="flex-row">\n                                    <div style="flex:1;"><label>No Peak SL Time (Secs)</label><input type="number" step="1" id="noPeakSlTimeframeSeconds" placeholder="e.g. 1800"></div>\n                                    <div style="flex:1;"><label>No Peak Gate PNL ($)</label><input type="number" step="0.0001" id="noPeakSlGatePnl" placeholder="e.g. 0"></div>\n                                </div>\n                            </div>\n\n                            <div style="margin-top:16px; border-top: 1px solid #ccc; padding-top: 16px;">\n                                <label style="margin-top:0; display:flex; align-items:center; cursor:pointer;">\n                                    <input type="checkbox" id="minuteCloseAutoDynamic" style="width:auto; margin:0 8px 0 0;"> Enable Auto-Dynamic Closer\n                                </label>\n                                <div style="background:#FFF; padding:12px; border:1px solid #E0E0E0; border-radius:4px; margin-top:12px;">\n                                    <label style="margin-top:0; color:var(--success);">Take Profit Range ($)</label>\n                                    <div class="flex-row">\n                                        <div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseTpMinPnl" placeholder="Min TP"></div>\n                                        <div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseTpMaxPnl" placeholder="Max TP"></div>\n                                    </div>\n                                    <label style="margin-top:12px; color:var(--danger);">Stop Loss Range ($)</label>\n                                    <div class="flex-row">\n                                        <div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseSlMinPnl" placeholder="Min SL"></div>\n                                        <div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseSlMaxPnl" placeholder="Max SL"></div>\n                                    </div>\n                                </div>\n                            </div>\n                            <button class="md-btn md-btn-primary" style="margin-top:16px; width:100%;" onclick="saveGlobalSettings()"><span class="material-symbols-outlined">save</span> Save Global Settings</button>\n                        </div>\n\n                        <h2 class="md-card-header"><span class="material-symbols-outlined">manage_accounts</span> Profile Setup</h2>\n                        <div class="stat-box" style="margin-bottom: 24px;">\n                            <div class="flex-row" style="justify-content: space-between; margin-bottom: 12px;">\n                                <h4 style="margin: 0;">Switch Profile</h4>\n                                <label style="margin: 0; display:flex; align-items:center; cursor:pointer; text-transform:none;"><input type="checkbox" style="width:auto; margin:0 6px 0 0;" onchange="toggleNewKeys(this)"> Show Keys</label>\n                            </div>\n                            <div class="flex-row" style="margin-bottom: 12px;">\n                                <select id="subAccountSelect" style="flex:2;"><option value="">-- Select Profile --</option></select>\n                                <button class="md-btn md-btn-primary" onclick="loadSubAccount()"><span class="material-symbols-outlined">download</span> Load</button>\n                                <button class="md-btn md-btn-danger" onclick="removeSubAccount()"><span class="material-symbols-outlined">delete</span></button>\n                            </div>\n                            <div class="flex-row">\n                                <input type="text" id="newSubName" placeholder="Profile Name" style="flex:1;">\n                                <input type="password" id="newSubKey" placeholder="API Key" style="flex:1;">\n                                <input type="password" id="newSubSecret" placeholder="Secret Key" style="flex:1;">\n                                <button class="md-btn md-btn-success" onclick="addSubAccount()"><span class="material-symbols-outlined">add</span></button>\n                            </div>\n                        </div>\n\n                        <div id="settingsContainer" style="display:none;">\n                            <div class="flex-row" style="justify-content: space-between; margin-top:16px;">\n                                <label style="margin:0;">Active Profile Keys</label>\n                                <label style="margin:0; display:flex; align-items:center; cursor:pointer; text-transform:none;"><input type="checkbox" id="showActiveKeysCheckbox" style="width:auto; margin:0 6px 0 0;" onchange="toggleActiveKeys(this)"> Show Keys</label>\n                            </div>\n                            <input type="password" id="apiKey" placeholder="HTX API Key" style="margin-top:8px;">\n                            <input type="password" id="secret" placeholder="HTX Secret Key">\n\n                            <div class="flex-row" style="margin-top: 16px; margin-bottom: 16px;">\n                                <button class="md-btn md-btn-success" style="flex:1;" onclick="globalToggleBot(true)"><span class="material-symbols-outlined">play_arrow</span> Start All</button>\n                                <button class="md-btn md-btn-danger" style="flex:1;" onclick="globalToggleBot(false)"><span class="material-symbols-outlined">stop</span> Stop All</button>\n                            </div>\n\n                            <div class="flex-row">\n                                <div style="flex:1"><label>Side</label><select id="side"><option value="long">Long</option><option value="short">Short</option></select></div>\n                                <div style="flex:1"><label>Leverage</label><input type="number" id="leverage" disabled value="10"></div>\n                            </div>\n                            \n                            <label>Base Contracts Qty</label>\n                            <input type="number" id="baseQty">\n\n                            <div class="flex-row">\n                                <div style="flex:1"><label>TP Exit (%)</label><input type="number" step="0.1" id="takeProfitPct"></div>\n                                <div style="flex:1"><label class="text-green">Single Coin TP PNL ($)</label><input type="number" step="0.0001" id="takeProfitPnl" placeholder="e.g. 1.50 (0 = Disabled)"></div>\n                            </div>\n                            <div class="flex-row">\n                                <div style="flex:1"><label>Stop Loss (%)</label><input type="number" step="0.1" id="stopLossPct"></div>\n                                <div style="flex:1"><label>Trigger DCA (%)</label><input type="number" step="0.1" id="triggerRoiPct"></div>\n                            </div>\n                            <div class="flex-row">\n                                <div style="flex:1"><label>Math Target ROI (%)</label><input type="number" step="0.1" id="dcaTargetRoiPct"></div>\n                                <div style="flex:1"><label>Max Safety Contracts</label><input type="number" id="maxContracts"></div>\n                            </div>\n\n                            <h3 style="margin-top:30px;"><span class="material-symbols-outlined" style="vertical-align:middle;">toll</span> Coins Configuration</h3>\n                            <div class="stat-box" style="margin-bottom: 16px;">\n                                <div class="flex-row" style="margin-bottom: 12px;">\n                                    <div style="flex:1;"><label style="margin-top:0;">Status</label><select id="predefStatus"><option value="started">Started</option><option value="stopped">Stopped</option></select></div>\n                                    <div style="flex:1;"><label style="margin-top:0;">Logic Side</label><select id="predefSide"><option value="oddLong">Odd L / Even S</option><option value="evenLong">Even L / Odd S</option><option value="allLong">All Long</option><option value="allShort">All Short</option></select></div>\n                                </div>\n                                <button class="md-btn md-btn-primary" style="width:100%;" onclick="addPredefinedList()"><span class="material-symbols-outlined">playlist_add</span> Add Predefined List</button>\n                            </div>\n\n                            <div class="flex-row" style="margin-bottom: 16px;">\n                                <input type="text" id="newCoinSymbol" placeholder="e.g. DOGE/USDT:USDT" style="margin:0; flex:2;">\n                                <button class="md-btn md-btn-success" style="flex:1;" onclick="addCoinUI()"><span class="material-symbols-outlined">add</span> Add</button>\n                            </div>\n\n                            <div id="coinsListContainer"></div>\n                            <button class="md-btn md-btn-primary" style="width:100%; margin-top:24px;" onclick="saveSettings()"><span class="material-symbols-outlined">save</span> Save Profile Settings</button>\n                        </div>\n                    </div>\n\n                    <!-- LIVE DASHBOARD (RIGHT) -->\n                    <div class="md-card flex-1" style="flex: 1.5;">\n                        <h2 class="md-card-header"><span class="material-symbols-outlined">query_stats</span> Live Dashboard</h2>\n                        <div class="stat-box flex-row" style="background:#E8F5E9; border-color:#A5D6A7; margin-bottom:24px;">\n                            <div style="flex:1;"><span class="stat-label">Global Realized PNL</span><span class="stat-val" id="globalPnl">0.00</span></div>\n                            <div style="flex:1;"><span class="stat-label">Profile Realized PNL</span><span class="stat-val" id="profilePnl">0.00</span></div>\n                            <div style="flex:1;"><span class="stat-label">Profile Margin Used</span><span class="stat-val text-blue" id="profileMargin">0.00</span></div>\n                        </div>\n                        \n                        <div id="dashboardStatusContainer"><p style="color:var(--text-secondary);">No profile loaded or no coins active.</p></div>\n\n                        <h3 style="margin-top:30px;"><span class="material-symbols-outlined" style="vertical-align:middle;">terminal</span> System Logs</h3>\n                        <div class="log-box" id="logs">Waiting for logs...</div>\n                    </div>\n                </div>\n            </div>\n        </div>\n    </div>\n\n    <script>\n        let token = localStorage.getItem(\'token\');\n        let isPaperUser = true; \n        let myUsername = \'\';\n        let statusInterval = null;\n        let mySubAccounts = [];\n        let myGlobalTargetPnl = 0;\n        let myGlobalTrailingPnl = 0;\n        let mySmartOffsetNetProfit = 0;\n        let mySmartOffsetBottomRowV1 = 5;\n        let mySmartOffsetBottomRowV1StopLoss = 0; \n        let mySmartOffsetStopLoss = 0;\n        let mySmartOffsetNetProfit2 = 0;\n        let mySmartOffsetStopLoss2 = 0;\n        let mySmartOffsetMaxLossPerMinute = 0;\n        let mySmartOffsetMaxLossTimeframeSeconds = 60;\n        let myMinuteCloseAutoDynamic = false;\n        let myMinuteCloseTpMinPnl = 0;\n        let myMinuteCloseTpMaxPnl = 0;\n        let myMinuteCloseSlMinPnl = 0;\n        let myMinuteCloseSlMaxPnl = 0;\n        let myNoPeakSlTimeframeSeconds = 1800;\n        let myNoPeakSlGatePnl = 0;\n        let currentProfileIndex = -1;\n        let myCoins = [];\n        \n        // TTS AUDIO VARIABLES\n        let audioEnabled = false;\n        let seenOffsets = new Set();\n        let isFirstLoad = true;\n        let latestTradeToSpeak = "No trades have been executed yet.";\n        \n        let audioQueue = [];\n        let isPlayingAudio = false;\n\n        async function processAudioQueue() {\n            if (isPlayingAudio || audioQueue.length === 0) return;\n            isPlayingAudio = true;\n            const textToSpeak = audioQueue.shift();\n            \n            try {\n                const res = await fetch(\'/api/tts\', {\n                    method: \'POST\',\n                    headers: { \n                        \'Content-Type\': \'application/json\',\n                        \'Authorization\': \'Bearer \' + token\n                    },\n                    body: JSON.stringify({ text: textToSpeak })\n                });\n\n                if (res.ok) {\n                    const blob = await res.blob();\n                    const audioUrl = URL.createObjectURL(blob);\n                    const audio = new Audio(audioUrl);\n                    audio.onended = () => {\n                        isPlayingAudio = false;\n                        processAudioQueue();\n                    };\n                    audio.play();\n                } else {\n                    isPlayingAudio = false;\n                    processAudioQueue();\n                }\n            } catch (e) {\n                console.error(\'TTS Error:\', e);\n                isPlayingAudio = false;\n                processAudioQueue();\n            }\n        }\n\n        function toggleAudio() {\n            audioEnabled = !audioEnabled;\n            document.getElementById(\'audioIcon\').innerText = audioEnabled ? \'volume_up\' : \'volume_off\';\n            if (audioEnabled) {\n                speakText("Audio alerts enabled.");\n            }\n        }\n\n        function speakText(text) {\n            if (!audioEnabled) return;\n            \n            let cleanText = text;\n            cleanText = cleanText.replace(/([A-Z]+)\\//USDT:USDT/g, "$1"); // Turns "OP/USDT:USDT" to "OP"\n            cleanText = cleanText.replace(/\\([^)]+\\)/g, ""); // Deletes math inside parentheses like "(Limit: $-0.0001)"\n            cleanText = cleanText.replace(/[🛒⚡🛑🔥⚠️⚖️📈🌍❌🔄🛡️]/g, \'\'); // Strip emojis\n            cleanText = cleanText.replace(/\\$([0-9]+\\.[0-9]+)/g, "$1 dollars"); // Read dollar amounts naturally\n            cleanText = cleanText.replace(/\\-([0-9]+\\.[0-9]+)/g, "minus $1"); // Handle negative signs naturally\n            \n            audioQueue.push(cleanText);\n            processAudioQueue();\n        }\n\n        function speakLatestTrade() {\n            if (!audioEnabled) {\n                audioEnabled = true;\n                document.getElementById(\'audioIcon\').innerText = \'volume_up\';\n            }\n            speakText(latestTradeToSpeak);\n        }\n\n        const PREDEFINED_COINS = ["TON", "AXS", "APT", "FIL", "ETHFI", "BERA", "MASK", "TIA", "DASH", "GIGGLE", "BSV", "OP", "TAO", "SSV", "YFI"];\n\n        async function checkAuth() {\n            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }\n            \n            if (token) {\n                try {\n                    const meRes = await fetch(\'/api/me\', { headers: { \'Authorization\': \'Bearer \' + token } });\n                    if (!meRes.ok) throw new Error("Invalid token");\n                    const meData = await meRes.json();\n                    isPaperUser = meData.isPaper;\n                    myUsername = meData.username;\n                    updateUIMode();\n                } catch(e) {\n                    logout();\n                    return;\n                }\n\n                document.getElementById(\'auth-view\').style.display = \'none\';\n                document.getElementById(\'dashboard-view\').style.display = \'block\';\n                \n                if (myUsername !== \'webcoin8888\') {\n                    await fetchSettings();\n                    await loadStatus(); \n                    statusInterval = setInterval(loadStatus, 5000);\n                }\n            } else {\n                document.getElementById(\'auth-view\').style.display = \'block\';\n                document.getElementById(\'dashboard-view\').style.display = \'none\';\n            }\n        }\n\n        function updateUIMode() {\n            const titleEl = document.getElementById(\'app-title\');\n            const panicBtn = document.getElementById(\'panic-btn\');\n            const levInput = document.getElementById(\'leverage\');\n            const adminBtn = document.getElementById(\'admin-btn\');\n            const editorBtn = document.getElementById(\'editor-btn\');\n            const navMain = document.getElementById(\'nav-main\');\n            const navOffsets = document.getElementById(\'nav-offsets\');\n            const navOffsets2 = document.getElementById(\'nav-offsets2\');\n            \n            if (myUsername === \'webcoin8888\') {\n                adminBtn.style.display = \'inline-flex\';\n                editorBtn.style.display = \'inline-flex\';\n                \n                navMain.style.display = \'none\';\n                navOffsets.style.display = \'none\';\n                navOffsets2.style.display = \'none\';\n\n                titleEl.innerHTML = \'<span class="material-symbols-outlined">shield_person</span> MASTER DASHBOARD\';\n                titleEl.style.color = "var(--primary)"; \n                panicBtn.style.display = "none";\n\n                switchTab(\'editor\');\n            } else {\n                adminBtn.style.display = \'none\';\n                editorBtn.style.display = \'none\';\n                \n                navMain.style.display = \'inline-flex\';\n                navOffsets.style.display = \'inline-flex\';\n                navOffsets2.style.display = \'inline-flex\';\n\n                if (isPaperUser) {\n                    titleEl.innerHTML = \'<span class="material-symbols-outlined">robot_2</span> PAPER TRADING BOT\';\n                    titleEl.style.color = "var(--primary)"; \n                    panicBtn.style.display = "none";\n                } else {\n                    titleEl.innerHTML = \'<span class="material-symbols-outlined">robot_2</span> LIVE REAL BOT\';\n                    titleEl.style.color = "var(--success)"; \n                    panicBtn.style.display = "inline-flex";\n                }\n                if (levInput) levInput.disabled = true;\n                switchTab(\'main\');\n            }\n        }\n\n        function switchTab(tab) {\n            document.getElementById(\'main-tab\').style.display = \'none\';\n            document.getElementById(\'offset-tab\').style.display = \'none\';\n            document.getElementById(\'offset2-tab\').style.display = \'none\';\n            document.getElementById(\'admin-tab\').style.display = \'none\';\n            document.getElementById(\'editor-tab\').style.display = \'none\';\n\n            if (tab === \'main\') {\n                document.getElementById(\'main-tab\').style.display = \'block\';\n            } else if (tab === \'offsets\') {\n                document.getElementById(\'offset-tab\').style.display = \'block\';\n                loadOffsets();\n            } else if (tab === \'offsets2\') {\n                document.getElementById(\'offset2-tab\').style.display = \'block\';\n                loadOffsets();\n            } else if (tab === \'admin\') {\n                document.getElementById(\'admin-tab\').style.display = \'block\';\n                loadAdminData();\n            } else if (tab === \'editor\') {\n                document.getElementById(\'editor-tab\').style.display = \'block\';\n                loadMasterEditor();\n            }\n        }\n\n        async function auth(action) {\n            const username = document.getElementById(\'username\').value;\n            const password = document.getElementById(\'password\').value;\n            const authCode = document.getElementById(\'authCode\').value;\n            const qtyMultiplier = document.getElementById(\'qtyMultiplier\') ? document.getElementById(\'qtyMultiplier\').value : 1;\n\n            document.getElementById(\'auth-msg\').innerText = "Processing...";\n            document.getElementById(\'auth-msg\').style.color = "var(--text-secondary)";\n            \n            const bodyObj = { username, password };\n            if (action === \'register\') {\n                bodyObj.authCode = authCode;\n                bodyObj.qtyMultiplier = qtyMultiplier;\n            }\n\n            try {\n                const res = await fetch(\'/api/\' + action, {\n                    method: \'POST\',\n                    headers: { \'Content-Type\': \'application/json\' },\n                    body: JSON.stringify(bodyObj)\n                });\n                const data = await res.json();\n                \n                if (data.token) {\n                    token = data.token;\n                    localStorage.setItem(\'token\', token);\n                    document.getElementById(\'auth-msg\').innerText = "";\n                    await checkAuth(); \n                } else {\n                    document.getElementById(\'auth-msg\').innerText = data.error || data.message;\n                    document.getElementById(\'auth-msg\').style.color = data.success ? \'var(--success)\' : \'var(--danger)\';\n                }\n            } catch (e) {\n                document.getElementById(\'auth-msg\').innerText = "Server error.";\n                document.getElementById(\'auth-msg\').style.color = "var(--danger)";\n            }\n        }\n\n        async function closeAllPositions() {\n            if (isPaperUser) return alert("Paper Accounts cannot execute real emergency close orders.");\n            if (!confirm("🚨 WARNING: FORCE CLOSE ALL POSITIONS on every active profile?")) return;\n            \n            const res = await fetch(\'/api/close-all\', { method: \'POST\', headers: { \'Authorization\': \'Bearer \' + token } });\n            const data = await res.json();\n            if(data.success) alert(data.message);\n            else alert("Error: " + data.error);\n        }\n\n        async function loadMasterEditor() {\n            try {\n                const res = await fetch(\'/api/admin/editor-data\', { headers: { \'Authorization\': \'Bearer \' + token } });\n                const data = await res.json();\n                const masterSettings = data.masterSettings;\n                \n                if (!masterSettings) {\n                    document.getElementById(\'editorGlobalContainer\').innerHTML = \'<p class="text-red">Master user "webcoin8888" settings not found in database.</p>\';\n                    return;\n                }\n\n                let globalHtml = \'\';\n                globalHtml += \'<form id="globalSettingsForm">\';\n                globalHtml += \'<div class="flex-row" style="margin-bottom: 12px;">\';\n                globalHtml += \'<div class="flex-1"><label>Global Target PNL ($)</label><input type="number" step="0.0001" id="e_globalTargetPnl" value="\' + (masterSettings.globalTargetPnl !== undefined ? masterSettings.globalTargetPnl : 0) + \'"></div>\';\n                globalHtml += \'<div class="flex-1"><label>Global Trailing PNL ($)</label><input type="number" step="0.0001" id="e_globalTrailingPnl" value="\' + (masterSettings.globalTrailingPnl !== undefined ? masterSettings.globalTrailingPnl : 0) + \'"></div>\';\n                globalHtml += \'</div>\';\n                globalHtml += \'<div class="flex-row" style="margin-bottom: 12px;">\';\n                globalHtml += \'<div class="flex-1"><label>Group Offset Target V1 ($)</label><input type="number" step="0.0001" id="e_smartOffsetNetProfit" value="\' + (masterSettings.smartOffsetNetProfit !== undefined ? masterSettings.smartOffsetNetProfit : 0) + \'"></div>\';\n                globalHtml += \'<div class="flex-1"><label>Full Group Stop Loss V1 ($)</label><input type="number" step="0.0001" id="e_smartOffsetStopLoss" value="\' + (masterSettings.smartOffsetStopLoss !== undefined ? masterSettings.smartOffsetStopLoss : 0) + \'"></div>\';\n                globalHtml += \'</div>\';\n                globalHtml += \'<div class="flex-row" style="margin-bottom: 12px;">\';\n                globalHtml += \'<div class="flex-1"><label>Smart Offset Target V2 ($)</label><input type="number" step="0.0001" id="e_smartOffsetNetProfit2" value="\' + (masterSettings.smartOffsetNetProfit2 !== undefined ? masterSettings.smartOffsetNetProfit2 : 0) + \'"></div>\';\n                globalHtml += \'<div class="flex-1"><label>Smart Offset Stop Loss V2 ($)</label><input type="number" step="0.0001" id="e_smartOffsetStopLoss2" value="\' + (masterSettings.smartOffsetStopLoss2 !== undefined ? masterSettings.smartOffsetStopLoss2 : 0) + \'"></div>\';\n                globalHtml += \'</div>\';\n                globalHtml += \'<div class="flex-row" style="margin-bottom: 12px;">\';\n                globalHtml += \'<div class="flex-1"><label>Max Loss Limit Amount ($)</label><input type="number" step="0.0001" id="e_smartOffsetMaxLossPerMinute" value="\' + (masterSettings.smartOffsetMaxLossPerMinute !== undefined ? masterSettings.smartOffsetMaxLossPerMinute : 0) + \'"></div>\';\n                globalHtml += \'<div class="flex-1"><label>Max Loss Timeframe (Seconds)</label><input type="number" step="1" id="e_smartOffsetMaxLossTimeframeSeconds" value="\' + (masterSettings.smartOffsetMaxLossTimeframeSeconds !== undefined ? masterSettings.smartOffsetMaxLossTimeframeSeconds : 60) + \'"></div>\';\n                globalHtml += \'</div>\';\n                globalHtml += \'<div class="flex-row" style="margin-bottom: 12px;">\';\n                globalHtml += \'<div class="flex-1"><label>No Peak SL Timeframe (Secs)</label><input type="number" step="1" id="e_noPeakSlTimeframeSeconds" value="\' + (masterSettings.noPeakSlTimeframeSeconds !== undefined ? masterSettings.noPeakSlTimeframeSeconds : 1800) + \'"></div>\';\n                globalHtml += \'<div class="flex-1"><label>No Peak Gate PNL ($)</label><input type="number" step="0.0001" id="e_noPeakSlGatePnl" value="\' + (masterSettings.noPeakSlGatePnl !== undefined ? masterSettings.noPeakSlGatePnl : 0) + \'"></div>\';\n                globalHtml += \'</div>\';\n                globalHtml += \'<div class="flex-row" style="margin-bottom: 16px;">\';\n                globalHtml += \'<label style="display:flex; align-items:center; cursor:pointer;"><input type="checkbox" id="e_minuteCloseAutoDynamic" \' + (masterSettings.minuteCloseAutoDynamic ? \'checked\' : \'\') + \' style="width:auto; margin:0 8px 0 0;"> 1-Min Auto-Dynamic Status</label>\';\n                globalHtml += \'</div>\';\n                globalHtml += \'<button type="button" class="md-btn md-btn-primary" onclick="saveMasterGlobalSettings()"><span class="material-symbols-outlined">save</span> Save Global Settings</button>\';\n                globalHtml += \'<div id="e_globalMsg" style="margin-top: 8px; font-weight: bold;"></div>\';\n                globalHtml += \'</form>\';\n                \n                document.getElementById(\'editorGlobalContainer\').innerHTML = globalHtml;\n\n                let profilesHtml = \'\';\n                if (masterSettings.subAccounts && masterSettings.subAccounts.length > 0) {\n                    masterSettings.subAccounts.forEach((sub, i) => {\n                        const activeCoins = (sub.coins || []).filter(c => c.botActive);\n                        const coinHtml = activeCoins.map(c => \n                            \'<span style="display:inline-block; background:\' + (c.side === \'short\' ? \'#fad2cf\' : \'#ceead6\') + \'; color:\' + (c.side === \'short\' ? \'#d93025\' : \'#1e8e3e\') + \'; padding:4px 8px; border-radius:12px; font-size:12px; font-weight:bold; margin:2px;">\' + c.symbol + \' (\' + c.side + \')</span>\'\n                        ).join(\' \');\n\n                        profilesHtml += \'<div class="stat-box" style="margin-bottom: 24px; border: 1px solid var(--primary); background: #fff;">\';\n                        profilesHtml += \'<div style="background: #e8f0fe; padding: 12px 16px; margin: -16px -16px 16px -16px; border-bottom: 1px solid var(--primary); color: var(--primary); display:flex; justify-content:space-between; font-weight:bold; border-radius: 6px 6px 0 0;">\';\n                        profilesHtml += \'<span>\' + (i + 1) + \'. \' + sub.name + \'</span>\';\n                        profilesHtml += \'<span>Default Side: \' + (sub.side || \'long\').toUpperCase() + \'</span>\';\n                        profilesHtml += \'</div>\';\n                        \n                        profilesHtml += \'<div class="flex-row" style="margin-bottom: 16px;">\';\n                        profilesHtml += \'<div class="flex-1"><label style="margin-top:0;">API Key</label><input type="text" id="p_\' + i + \'_apiKey" value="\' + (sub.apiKey || \'\') + \'"></div>\';\n                        profilesHtml += \'<div class="flex-1"><label style="margin-top:0;">Secret Key</label><input type="text" id="p_\' + i + \'_secret" value="\' + (sub.secret || \'\') + \'"></div>\';\n                        profilesHtml += \'</div>\';\n\n                        profilesHtml += \'<div style="overflow-x:auto;">\';\n                        profilesHtml += \'<table class="md-table" style="margin-bottom: 16px;">\';\n                        profilesHtml += \'<tr><th>Base Qty</th><th>Take Profit %</th><th class="text-green">Single Coin TP PNL ($)</th><th>Stop Loss %</th><th>DCA Trigger %</th><th>Target ROI %</th><th>Max Contracts</th></tr>\';\n                        profilesHtml += \'<tr>\';\n                        profilesHtml += \'<td><input type="number" step="1" id="p_\' + i + \'_baseQty" value="\' + (sub.baseQty !== undefined ? sub.baseQty : 1) + \'"></td>\';\n                        profilesHtml += \'<td><input type="number" step="0.1" id="p_\' + i + \'_takeProfitPct" value="\' + (sub.takeProfitPct !== undefined ? sub.takeProfitPct : 5.0) + \'"></td>\';\n                        profilesHtml += \'<td><input type="number" step="0.0001" id="p_\' + i + \'_takeProfitPnl" value="\' + (sub.takeProfitPnl !== undefined ? sub.takeProfitPnl : 0) + \'"></td>\';\n                        profilesHtml += \'<td><input type="number" step="0.1" id="p_\' + i + \'_stopLossPct" value="\' + (sub.stopLossPct !== undefined ? sub.stopLossPct : -25.0) + \'"></td>\';\n                        profilesHtml += \'<td><input type="number" step="0.1" id="p_\' + i + \'_triggerRoiPct" value="\' + (sub.triggerRoiPct !== undefined ? sub.triggerRoiPct : -15.0) + \'"></td>\';\n                        profilesHtml += \'<td><input type="number" step="0.1" id="p_\' + i + \'_dcaTargetRoiPct" value="\' + (sub.dcaTargetRoiPct !== undefined ? sub.dcaTargetRoiPct : -2.0) + \'"></td>\';\n                        profilesHtml += \'<td><input type="number" step="1" id="p_\' + i + \'_maxContracts" value="\' + (sub.maxContracts !== undefined ? sub.maxContracts : 1000) + \'"></td>\';\n                        profilesHtml += \'</tr></table></div>\';\n\n                        profilesHtml += \'<p style="margin-bottom: 8px;"><strong>Active Coins Trading (\' + activeCoins.length + \'):</strong></p>\';\n                        profilesHtml += \'<div style="margin-bottom: 16px;">\' + (coinHtml || \'<span class="text-secondary">No active coins</span>\') + \'</div>\';\n\n                        profilesHtml += \'<button type="button" class="md-btn md-btn-success" onclick="saveMasterProfile(\' + i + \')"><span class="material-symbols-outlined">done</span> Save Profile \' + (i + 1) + \'</button>\';\n                        profilesHtml += \'<div id="p_\' + i + \'_msg" style="margin-top: 8px; font-weight: bold;"></div>\';\n                        profilesHtml += \'</div>\';\n                    });\n                } else {\n                    profilesHtml += \'<p class="text-secondary">No profiles configured for the master account.</p>\';\n                }\n                document.getElementById(\'editorProfilesContainer\').innerHTML = profilesHtml;\n\n            } catch (e) {\n                document.getElementById(\'editorGlobalContainer\').innerHTML = \'<p class="text-red">Error loading editor data.</p>\';\n            }\n        }\n\n        async function saveMasterGlobalSettings() {\n            const payload = {\n                globalTargetPnl: document.getElementById(\'e_globalTargetPnl\').value !== \'\' ? parseFloat(document.getElementById(\'e_globalTargetPnl\').value) : 0,\n                globalTrailingPnl: document.getElementById(\'e_globalTrailingPnl\').value !== \'\' ? parseFloat(document.getElementById(\'e_globalTrailingPnl\').value) : 0,\n                smartOffsetNetProfit: document.getElementById(\'e_smartOffsetNetProfit\').value !== \'\' ? parseFloat(document.getElementById(\'e_smartOffsetNetProfit\').value) : 0,\n                smartOffsetStopLoss: document.getElementById(\'e_smartOffsetStopLoss\').value !== \'\' ? parseFloat(document.getElementById(\'e_smartOffsetStopLoss\').value) : 0,\n                smartOffsetNetProfit2: document.getElementById(\'e_smartOffsetNetProfit2\').value !== \'\' ? parseFloat(document.getElementById(\'e_smartOffsetNetProfit2\').value) : 0,\n                smartOffsetStopLoss2: document.getElementById(\'e_smartOffsetStopLoss2\').value !== \'\' ? parseFloat(document.getElementById(\'e_smartOffsetStopLoss2\').value) : 0,\n                smartOffsetMaxLossPerMinute: document.getElementById(\'e_smartOffsetMaxLossPerMinute\').value !== \'\' ? parseFloat(document.getElementById(\'e_smartOffsetMaxLossPerMinute\').value) : 0,\n                smartOffsetMaxLossTimeframeSeconds: document.getElementById(\'e_smartOffsetMaxLossTimeframeSeconds\').value !== \'\' ? parseInt(document.getElementById(\'e_smartOffsetMaxLossTimeframeSeconds\').value) : 60,\n                noPeakSlTimeframeSeconds: document.getElementById(\'e_noPeakSlTimeframeSeconds\').value !== \'\' ? parseInt(document.getElementById(\'e_noPeakSlTimeframeSeconds\').value) : 1800,\n                noPeakSlGatePnl: document.getElementById(\'e_noPeakSlGatePnl\').value !== \'\' ? parseFloat(document.getElementById(\'e_noPeakSlGatePnl\').value) : 0,\n                minuteCloseAutoDynamic: document.getElementById(\'e_minuteCloseAutoDynamic\').checked\n            };\n\n            const msgDiv = document.getElementById(\'e_globalMsg\');\n            try {\n                const res = await fetch(\'/api/master/global\', {\n                    method: \'POST\',\n                    headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token },\n                    body: JSON.stringify(payload)\n                });\n                const data = await res.json();\n                if (data.success) {\n                    msgDiv.className = "text-green";\n                    msgDiv.innerText = data.message;\n                } else {\n                    msgDiv.className = "text-red";\n                    msgDiv.innerText = "Error: " + data.error;\n                }\n            } catch(err) {\n                msgDiv.className = "text-red";\n                msgDiv.innerText = "Fetch Error: " + err.message;\n            }\n            setTimeout(() => { msgDiv.innerText = \'\'; }, 3000);\n        }\n\n        async function saveMasterProfile(index) {\n            const payload = {\n                apiKey: document.getElementById(\'p_\' + index + \'_apiKey\').value,\n                secret: document.getElementById(\'p_\' + index + \'_secret\').value,\n                baseQty: document.getElementById(\'p_\' + index + \'_baseQty\').value !== \'\' ? parseFloat(document.getElementById(\'p_\' + index + \'_baseQty\').value) : 1,\n                takeProfitPct: document.getElementById(\'p_\' + index + \'_takeProfitPct\').value !== \'\' ? parseFloat(document.getElementById(\'p_\' + index + \'_takeProfitPct\').value) : 5.0,\n                takeProfitPnl: document.getElementById(\'p_\' + index + \'_takeProfitPnl\').value !== \'\' ? parseFloat(document.getElementById(\'p_\' + index + \'_takeProfitPnl\').value) : 0,\n                stopLossPct: document.getElementById(\'p_\' + index + \'_stopLossPct\').value !== \'\' ? parseFloat(document.getElementById(\'p_\' + index + \'_stopLossPct\').value) : -25.0,\n                triggerRoiPct: document.getElementById(\'p_\' + index + \'_triggerRoiPct\').value !== \'\' ? parseFloat(document.getElementById(\'p_\' + index + \'_triggerRoiPct\').value) : -15.0,\n                dcaTargetRoiPct: document.getElementById(\'p_\' + index + \'_dcaTargetRoiPct\').value !== \'\' ? parseFloat(document.getElementById(\'p_\' + index + \'_dcaTargetRoiPct\').value) : -2.0,\n                maxContracts: document.getElementById(\'p_\' + index + \'_maxContracts\').value !== \'\' ? parseInt(document.getElementById(\'p_\' + index + \'_maxContracts\').value) : 1000\n            };\n\n            const msgDiv = document.getElementById(\'p_\' + index + \'_msg\');\n            try {\n                const res = await fetch(\'/api/master/profile/\' + index, {\n                    method: \'POST\',\n                    headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token },\n                    body: JSON.stringify(payload)\n                });\n                const data = await res.json();\n                if (data.success) {\n                    msgDiv.className = "text-green";\n                    msgDiv.innerText = data.message;\n                } else {\n                    msgDiv.className = "text-red";\n                    msgDiv.innerText = "Error: " + data.error;\n                }\n            } catch(err) {\n                msgDiv.className = "text-red";\n                msgDiv.innerText = "Fetch Error: " + err.message;\n            }\n            setTimeout(() => { msgDiv.innerText = \'\'; }, 3000);\n        }\n\n        async function loadAdminData() {\n            try {\n                const statusRes = await fetch(\'/api/admin/status\', { headers: { \'Authorization\': \'Bearer \' + token } });\n                const statusData = await statusRes.json();\n\n                const banner = document.getElementById(\'adminStatusBanner\');\n                if (statusData.templateSafe && statusData.webcoinSafe) {\n                    banner.style.background = \'#E8F5E9\';\n                    banner.style.color = \'var(--success)\';\n                    banner.innerHTML = \'<span class="material-symbols-outlined">check_circle</span> SYSTEM SAFE: Master Template Protected.\';\n                } else {\n                    banner.style.background = \'#FFEBEE\';\n                    banner.style.color = \'var(--danger)\';\n                    banner.innerHTML = \'<span class="material-symbols-outlined">error</span> WARNING: Master Template missing!\';\n                }\n\n                const usersRes = await fetch(\'/api/admin/users\', { headers: { \'Authorization\': \'Bearer \' + token } });\n                const users = await usersRes.json();\n\n                let html = \'<table class="md-table">\';\n                html += \'<tr><th>Username</th><th>Password</th><th>Mode</th><th>Global PNL</th><th>Actions</th></tr>\';\n\n                if (users.length === 0) {\n                    html += \'<tr><td colspan="5" style="text-align:center;">No users found.</td></tr>\';\n                } else {\n                    users.forEach(u => {\n                        const modeText = u.isPaper ? \'<span class="text-blue" style="font-weight:bold;">PAPER</span>\' : \'<span class="text-green" style="font-weight:bold;">REAL</span>\';\n                        const pnlColor = u.realizedPnl >= 0 ? \'text-green\' : \'text-red\';\n                        html += \'<tr>\' +\n                            \'<td style="font-weight:bold;">\' + u.username + \'</td>\' +\n                            \'<td style="font-family:monospace;">\' + u.plainPassword + \'</td>\' +\n                            \'<td>\' + modeText + \'</td>\' +\n                            \'<td class="\' + pnlColor + \'" style="font-weight:bold;">$\' + u.realizedPnl.toFixed(4) + \'</td>\' +\n                            \'<td>\' +\n                                \'<button class="md-btn md-btn-primary" style="padding:6px 12px; margin-right:8px;" onclick="adminImportProfiles(\\\'\' + u._id + \'\\\')"><span class="material-symbols-outlined" style="font-size:16px;">download</span> Import Profiles</button>\' +\n                                \'<button class="md-btn md-btn-danger" style="padding:6px 12px;" onclick="adminDeleteUser(\\\'\' + u._id + \'\\\')"><span class="material-symbols-outlined" style="font-size:16px;">delete</span></button>\' +\n                            \'</td>\' +\n                        \'</tr>\';\n                    });\n                }\n                html += \'</table>\';\n                document.getElementById(\'adminUsersContainer\').innerHTML = html;\n\n            } catch (e) {\n                document.getElementById(\'adminUsersContainer\').innerHTML = \'<p class="text-red">Error loading admin data.</p>\';\n            }\n        }\n\n        async function adminImportProfiles(id) {\n            if (!confirm("OVERWRITE their profiles with Master configurations?")) return;\n            const res = await fetch(\'/api/admin/users/\' + id + \'/import\', { method: \'POST\', headers: { \'Authorization\': \'Bearer \' + token } });\n            const data = await res.json();\n            if(data.success) { alert(data.message); loadAdminData(); } else alert("Error: " + data.error);\n        }\n\n        async function adminDeleteUser(id) {\n            if (!confirm("Delete this user permanently?")) return;\n            const res = await fetch(\'/api/admin/users/\' + id, { method: \'DELETE\', headers: { \'Authorization\': \'Bearer \' + token } });\n            const data = await res.json();\n            if(data.success) { loadAdminData(); } else alert("Error: " + data.error);\n        }\n\n        async function adminDeleteAllUsers() {\n            if (!confirm("🚨 EXTREME WARNING: Completely wipe all users?")) return;\n            const res = await fetch(\'/api/admin/users\', { method: \'DELETE\', headers: { \'Authorization\': \'Bearer \' + token } });\n            const data = await res.json();\n            if(data.success) { alert(data.message); loadAdminData(); } else alert("Error: " + data.error);\n        }\n\n        function logout() { \n            localStorage.removeItem(\'token\'); \n            token = null; \n            mySubAccounts = [];\n            myCoins = [];\n            currentProfileIndex = -1;\n            document.getElementById(\'settingsContainer\').style.display = \'none\';\n            document.getElementById(\'coinsListContainer\').innerHTML = \'\';\n            document.getElementById(\'logs\').innerHTML = \'\';\n            document.getElementById(\'dashboardStatusContainer\').innerHTML = \'<p>No profile loaded.</p>\';\n            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }\n            checkAuth(); \n        }\n        \n        function toggleNewKeys(cb) { const type = cb.checked ? \'text\' : \'password\'; document.getElementById(\'newSubKey\').type = type; document.getElementById(\'newSubSecret\').type = type; }\n        function toggleActiveKeys(cb) { const type = cb.checked ? \'text\' : \'password\'; document.getElementById(\'apiKey\').type = type; document.getElementById(\'secret\').type = type; }\n\n        async function fetchSettings() {\n            try {\n                const res = await fetch(\'/api/settings\', { headers: { \'Authorization\': \'Bearer \' + token } });\n                if (res.status === 401 || res.status === 403) return logout();\n                const config = await res.json();\n                \n                myGlobalTargetPnl = config.globalTargetPnl !== undefined ? config.globalTargetPnl : 0;\n                myGlobalTrailingPnl = config.globalTrailingPnl !== undefined ? config.globalTrailingPnl : 0;\n                mySmartOffsetNetProfit = config.smartOffsetNetProfit !== undefined ? config.smartOffsetNetProfit : 0;\n                mySmartOffsetBottomRowV1 = config.smartOffsetBottomRowV1 !== undefined ? config.smartOffsetBottomRowV1 : 5;\n                mySmartOffsetBottomRowV1StopLoss = config.smartOffsetBottomRowV1StopLoss !== undefined ? config.smartOffsetBottomRowV1StopLoss : 0; \n                mySmartOffsetStopLoss = config.smartOffsetStopLoss !== undefined ? config.smartOffsetStopLoss : 0;\n                mySmartOffsetNetProfit2 = config.smartOffsetNetProfit2 !== undefined ? config.smartOffsetNetProfit2 : 0;\n                mySmartOffsetStopLoss2 = config.smartOffsetStopLoss2 !== undefined ? config.smartOffsetStopLoss2 : 0;\n                mySmartOffsetMaxLossPerMinute = config.smartOffsetMaxLossPerMinute !== undefined ? config.smartOffsetMaxLossPerMinute : 0;\n                mySmartOffsetMaxLossTimeframeSeconds = config.smartOffsetMaxLossTimeframeSeconds !== undefined ? config.smartOffsetMaxLossTimeframeSeconds : 60;\n                \n                myMinuteCloseAutoDynamic = config.minuteCloseAutoDynamic || false;\n                myMinuteCloseTpMinPnl = config.minuteCloseTpMinPnl !== undefined ? config.minuteCloseTpMinPnl : 0;\n                myMinuteCloseTpMaxPnl = config.minuteCloseTpMaxPnl !== undefined ? config.minuteCloseTpMaxPnl : 0;\n                myMinuteCloseSlMinPnl = config.minuteCloseSlMinPnl !== undefined ? config.minuteCloseSlMinPnl : 0;\n                myMinuteCloseSlMaxPnl = config.minuteCloseSlMaxPnl !== undefined ? config.minuteCloseSlMaxPnl : 0;\n\n                myNoPeakSlTimeframeSeconds = config.noPeakSlTimeframeSeconds !== undefined ? config.noPeakSlTimeframeSeconds : 1800;\n                myNoPeakSlGatePnl = config.noPeakSlGatePnl !== undefined ? config.noPeakSlGatePnl : 0;\n                \n                document.getElementById(\'globalTargetPnl\').value = myGlobalTargetPnl;\n                document.getElementById(\'globalTrailingPnl\').value = myGlobalTrailingPnl;\n                document.getElementById(\'smartOffsetNetProfit\').value = mySmartOffsetNetProfit;\n                document.getElementById(\'smartOffsetBottomRowV1\').value = mySmartOffsetBottomRowV1;\n                document.getElementById(\'smartOffsetBottomRowV1StopLoss\').value = mySmartOffsetBottomRowV1StopLoss; \n                document.getElementById(\'smartOffsetStopLoss\').value = mySmartOffsetStopLoss;\n                document.getElementById(\'smartOffsetNetProfit2\').value = mySmartOffsetNetProfit2;\n                document.getElementById(\'smartOffsetStopLoss2\').value = mySmartOffsetStopLoss2;\n                document.getElementById(\'smartOffsetMaxLossPerMinute\').value = mySmartOffsetMaxLossPerMinute;\n                document.getElementById(\'smartOffsetMaxLossTimeframeSeconds\').value = mySmartOffsetMaxLossTimeframeSeconds;\n                \n                document.getElementById(\'minuteCloseAutoDynamic\').checked = myMinuteCloseAutoDynamic;\n                document.getElementById(\'minuteCloseTpMinPnl\').value = myMinuteCloseTpMinPnl;\n                document.getElementById(\'minuteCloseTpMaxPnl\').value = myMinuteCloseTpMaxPnl;\n                document.getElementById(\'minuteCloseSlMinPnl\').value = myMinuteCloseSlMinPnl;\n                document.getElementById(\'minuteCloseSlMaxPnl\').value = myMinuteCloseSlMaxPnl;\n\n                document.getElementById(\'noPeakSlTimeframeSeconds\').value = myNoPeakSlTimeframeSeconds;\n                document.getElementById(\'noPeakSlGatePnl\').value = myNoPeakSlGatePnl;\n\n                mySubAccounts = config.subAccounts || [];\n                renderSubAccounts();\n                \n                if (mySubAccounts.length > 0) {\n                    document.getElementById(\'subAccountSelect\').value = 0;\n                    loadSubAccount();\n                } else {\n                    currentProfileIndex = -1;\n                    document.getElementById(\'settingsContainer\').style.display = \'none\';\n                    document.getElementById(\'dashboardStatusContainer\').innerHTML = \'<p>No profile loaded.</p>\';\n                    myCoins = [];\n                }\n            } catch(e) { console.error(e); }\n        }\n\n        async function saveGlobalSettings() {\n            myGlobalTargetPnl = document.getElementById(\'globalTargetPnl\').value !== \'\' ? parseFloat(document.getElementById(\'globalTargetPnl\').value) : 0;\n            myGlobalTrailingPnl = document.getElementById(\'globalTrailingPnl\').value !== \'\' ? parseFloat(document.getElementById(\'globalTrailingPnl\').value) : 0;\n            mySmartOffsetNetProfit = document.getElementById(\'smartOffsetNetProfit\').value !== \'\' ? parseFloat(document.getElementById(\'smartOffsetNetProfit\').value) : 0;\n            mySmartOffsetBottomRowV1 = document.getElementById(\'smartOffsetBottomRowV1\').value !== \'\' ? parseInt(document.getElementById(\'smartOffsetBottomRowV1\').value) : 5;\n            mySmartOffsetBottomRowV1StopLoss = document.getElementById(\'smartOffsetBottomRowV1StopLoss\').value !== \'\' ? parseFloat(document.getElementById(\'smartOffsetBottomRowV1StopLoss\').value) : 0; \n            mySmartOffsetStopLoss = document.getElementById(\'smartOffsetStopLoss\').value !== \'\' ? parseFloat(document.getElementById(\'smartOffsetStopLoss\').value) : 0; \n            mySmartOffsetNetProfit2 = document.getElementById(\'smartOffsetNetProfit2\').value !== \'\' ? parseFloat(document.getElementById(\'smartOffsetNetProfit2\').value) : 0;\n            mySmartOffsetStopLoss2 = document.getElementById(\'smartOffsetStopLoss2\').value !== \'\' ? parseFloat(document.getElementById(\'smartOffsetStopLoss2\').value) : 0; \n            mySmartOffsetMaxLossPerMinute = document.getElementById(\'smartOffsetMaxLossPerMinute\').value !== \'\' ? parseFloat(document.getElementById(\'smartOffsetMaxLossPerMinute\').value) : 0;\n            mySmartOffsetMaxLossTimeframeSeconds = document.getElementById(\'smartOffsetMaxLossTimeframeSeconds\').value !== \'\' ? parseInt(document.getElementById(\'smartOffsetMaxLossTimeframeSeconds\').value) : 60;\n            \n            myMinuteCloseAutoDynamic = document.getElementById(\'minuteCloseAutoDynamic\').checked;\n            myMinuteCloseTpMinPnl = document.getElementById(\'minuteCloseTpMinPnl\').value !== \'\' ? Math.abs(parseFloat(document.getElementById(\'minuteCloseTpMinPnl\').value)) : 0;\n            myMinuteCloseTpMaxPnl = document.getElementById(\'minuteCloseTpMaxPnl\').value !== \'\' ? Math.abs(parseFloat(document.getElementById(\'minuteCloseTpMaxPnl\').value)) : 0;\n            myMinuteCloseSlMinPnl = document.getElementById(\'minuteCloseSlMinPnl\').value !== \'\' ? -Math.abs(parseFloat(document.getElementById(\'minuteCloseSlMinPnl\').value)) : 0;\n            myMinuteCloseSlMaxPnl = document.getElementById(\'minuteCloseSlMaxPnl\').value !== \'\' ? -Math.abs(parseFloat(document.getElementById(\'minuteCloseSlMaxPnl\').value)) : 0;\n\n            myNoPeakSlTimeframeSeconds = document.getElementById(\'noPeakSlTimeframeSeconds\').value !== \'\' ? parseInt(document.getElementById(\'noPeakSlTimeframeSeconds\').value) : 1800;\n            myNoPeakSlGatePnl = document.getElementById(\'noPeakSlGatePnl\').value !== \'\' ? parseFloat(document.getElementById(\'noPeakSlGatePnl\').value) : 0;\n            \n            const data = { subAccounts: mySubAccounts, globalTargetPnl: myGlobalTargetPnl, globalTrailingPnl: myGlobalTrailingPnl, smartOffsetNetProfit: mySmartOffsetNetProfit, smartOffsetBottomRowV1: mySmartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss: mySmartOffsetBottomRowV1StopLoss, smartOffsetStopLoss: mySmartOffsetStopLoss, smartOffsetNetProfit2: mySmartOffsetNetProfit2, smartOffsetStopLoss2: mySmartOffsetStopLoss2, smartOffsetMaxLossPerMinute: mySmartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds: mySmartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic: myMinuteCloseAutoDynamic, minuteCloseTpMinPnl: myMinuteCloseTpMinPnl, minuteCloseTpMaxPnl: myMinuteCloseTpMaxPnl, minuteCloseSlMinPnl: myMinuteCloseSlMinPnl, minuteCloseSlMaxPnl: myMinuteCloseSlMaxPnl, noPeakSlTimeframeSeconds: myNoPeakSlTimeframeSeconds, noPeakSlGatePnl: myNoPeakSlGatePnl };\n            await fetch(\'/api/settings\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token }, body: JSON.stringify(data) });\n            alert(\'Global Settings Saved!\');\n        }\n\n        function renderSubAccounts() {\n            const select = document.getElementById(\'subAccountSelect\');\n            select.innerHTML = \'<option value="">-- Create/Select Profile --</option>\';\n            if(mySubAccounts.length > 0) {\n                select.innerHTML = \'\';\n                mySubAccounts.forEach((sub, i) => select.innerHTML += \'<option value="\' + i + \'">\' + sub.name + \'</option>\');\n            }\n        }\n\n        async function addSubAccount() {\n            const name = document.getElementById(\'newSubName\').value.trim();\n            const key = document.getElementById(\'newSubKey\').value.trim();\n            const secret = document.getElementById(\'newSubSecret\').value.trim();\n            if(!name || !key || !secret) return alert("Fill all fields!");\n            \n            mySubAccounts.push({ name, apiKey: key, secret: secret, side: \'long\', leverage: 10, baseQty: 1, takeProfitPct: 5.0, takeProfitPnl: 0, stopLossPct: -25.0, triggerRoiPct: -15.0, dcaTargetRoiPct: -2.0, maxContracts: 1000, realizedPnl: 0, coins: [] });\n            await saveSettings(true);\n            document.getElementById(\'newSubName\').value = \'\'; document.getElementById(\'newSubKey\').value = \'\'; document.getElementById(\'newSubSecret\').value = \'\';\n            renderSubAccounts();\n            document.getElementById(\'subAccountSelect\').value = mySubAccounts.length - 1;\n            loadSubAccount();\n        }\n\n        function loadSubAccount() {\n            const select = document.getElementById(\'subAccountSelect\');\n            const index = parseInt(select.value);\n            if(!isNaN(index) && index >= 0) {\n                currentProfileIndex = index;\n                const profile = mySubAccounts[index];\n                \n                document.getElementById(\'settingsContainer\').style.display = \'block\';\n                document.getElementById(\'apiKey\').value = profile.apiKey || \'\';\n                document.getElementById(\'secret\').value = profile.secret || \'\';\n                \n                const cb = document.getElementById(\'showActiveKeysCheckbox\');\n                if(cb) { cb.checked = false; toggleActiveKeys(cb); }\n\n                document.getElementById(\'side\').value = profile.side || \'long\';\n                document.getElementById(\'leverage\').value = 10;\n                document.getElementById(\'baseQty\').value = profile.baseQty !== undefined ? profile.baseQty : 1;\n                document.getElementById(\'takeProfitPct\').value = profile.takeProfitPct !== undefined ? profile.takeProfitPct : 5.0;\n                document.getElementById(\'takeProfitPnl\').value = profile.takeProfitPnl !== undefined ? profile.takeProfitPnl : 0;\n                document.getElementById(\'stopLossPct\').value = profile.stopLossPct !== undefined ? profile.stopLossPct : -25.0; \n                document.getElementById(\'triggerRoiPct\').value = profile.triggerRoiPct !== undefined ? profile.triggerRoiPct : -15.0;\n                document.getElementById(\'dcaTargetRoiPct\').value = profile.dcaTargetRoiPct !== undefined ? profile.dcaTargetRoiPct : -2.0;\n                document.getElementById(\'maxContracts\').value = profile.maxContracts !== undefined ? profile.maxContracts : 1000;\n                \n                myCoins = profile.coins || [];\n                renderCoinsSettings();\n            }\n        }\n\n        async function removeSubAccount() {\n            const select = document.getElementById(\'subAccountSelect\');\n            const index = parseInt(select.value);\n            if(!isNaN(index) && index >= 0) {\n                mySubAccounts.splice(index, 1);\n                await saveSettings(true);\n                renderSubAccounts();\n                if(mySubAccounts.length > 0) { document.getElementById(\'subAccountSelect\').value = 0; loadSubAccount(); } \n                else { currentProfileIndex = -1; document.getElementById(\'settingsContainer\').style.display = \'none\'; myCoins = []; document.getElementById(\'dashboardStatusContainer\').innerHTML = \'<p>No profile loaded.</p>\'; document.getElementById(\'logs\').innerHTML = \'\'; }\n            }\n        }\n\n        async function globalToggleBot(active) {\n            if(currentProfileIndex === -1) return alert("Load a profile first!");\n            if(myCoins.length === 0) return alert("Add coins first!");\n            myCoins.forEach(c => c.botActive = active);\n            await saveSettings(true); \n            alert(active ? "Started all coins on this profile!" : "Stopped all coins.");\n        }\n\n        function addPredefinedList() {\n            if(currentProfileIndex === -1) return alert("Load a profile first!");\n            const sideMode = document.getElementById(\'predefSide\').value;\n            const startMode = document.getElementById(\'predefStatus\').value === \'started\';\n\n            PREDEFINED_COINS.forEach((base, index) => {\n                const symbol = base + \'/USDT:USDT\';\n                if(myCoins.some(c => c.symbol === symbol)) return; \n\n                let coinSide = \'long\';\n                if (sideMode === \'allShort\') coinSide = \'short\';\n                else if (sideMode === \'oddLong\') coinSide = (index % 2 === 0) ? \'long\' : \'short\'; \n                else if (sideMode === \'evenLong\') coinSide = (index % 2 === 0) ? \'short\' : \'long\'; \n\n                myCoins.push({ symbol: symbol, side: coinSide, botActive: startMode });\n            });\n            renderCoinsSettings();\n        }\n\n        function addCoinUI() {\n            if(currentProfileIndex === -1) return alert("Load a profile first!");\n            const symbol = document.getElementById(\'newCoinSymbol\').value.toUpperCase().trim();\n            const masterSide = document.getElementById(\'side\').value; \n            if(!symbol) return alert("Enter pair!");\n            if(myCoins.some(c => c.symbol === symbol)) return alert("Already exists!");\n\n            myCoins.push({ symbol: symbol, side: masterSide, botActive: true }); \n            document.getElementById(\'newCoinSymbol\').value = \'\';\n            renderCoinsSettings();\n        }\n\n        function removeCoinUI(index) { myCoins.splice(index, 1); renderCoinsSettings(); }\n\n        function renderCoinsSettings() {\n            const container = document.getElementById(\'coinsListContainer\');\n            container.innerHTML = \'\';\n            myCoins.forEach((coin, i) => {\n                const box = document.createElement(\'div\');\n                box.className = \'stat-box flex-row\';\n                box.style.justifyContent = \'space-between\';\n                box.style.marginBottom = \'8px\';\n                const displaySide = coin.side || document.getElementById(\'side\').value;\n                const sideColor = displaySide === \'long\' ? \'text-green\' : \'text-red\';\n\n                box.innerHTML = \'<span style="font-weight: 500; font-size: 1.1em;">\' + coin.symbol + \' <span class="\' + sideColor + \'" style="font-size: 0.75em; text-transform: uppercase;">(\' + displaySide + \')</span></span><button class="md-btn md-btn-danger" style="padding:6px 12px; font-size:0.8em;" onclick="removeCoinUI(\' + i + \')"><span class="material-symbols-outlined" style="font-size:16px;">delete</span></button>\';\n                container.appendChild(box);\n            });\n        }\n\n        async function saveSettings(silent = false) {\n            if(currentProfileIndex === -1) return alert("Load a profile first!");\n\n            const profile = mySubAccounts[currentProfileIndex];\n            profile.apiKey = document.getElementById(\'apiKey\').value;\n            profile.secret = document.getElementById(\'secret\').value;\n            profile.side = document.getElementById(\'side\').value;\n            profile.leverage = 10;\n            profile.baseQty = document.getElementById(\'baseQty\').value !== \'\' ? parseFloat(document.getElementById(\'baseQty\').value) : 1;\n            profile.takeProfitPct = document.getElementById(\'takeProfitPct\').value !== \'\' ? parseFloat(document.getElementById(\'takeProfitPct\').value) : 5.0;\n            profile.takeProfitPnl = document.getElementById(\'takeProfitPnl\').value !== \'\' ? parseFloat(document.getElementById(\'takeProfitPnl\').value) : 0;\n            profile.stopLossPct = document.getElementById(\'stopLossPct\').value !== \'\' ? parseFloat(document.getElementById(\'stopLossPct\').value) : -25.0;\n            profile.triggerRoiPct = document.getElementById(\'triggerRoiPct\').value !== \'\' ? parseFloat(document.getElementById(\'triggerRoiPct\').value) : -15.0;\n            profile.dcaTargetRoiPct = document.getElementById(\'dcaTargetRoiPct\').value !== \'\' ? parseFloat(document.getElementById(\'dcaTargetRoiPct\').value) : -2.0;\n            profile.maxContracts = document.getElementById(\'maxContracts\').value !== \'\' ? parseInt(document.getElementById(\'maxContracts\').value) : 1000;\n            profile.coins = myCoins;\n\n            const data = { subAccounts: mySubAccounts, globalTargetPnl: myGlobalTargetPnl, globalTrailingPnl: myGlobalTrailingPnl, smartOffsetNetProfit: mySmartOffsetNetProfit, smartOffsetBottomRowV1: mySmartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss: mySmartOffsetBottomRowV1StopLoss, smartOffsetStopLoss: mySmartOffsetStopLoss, smartOffsetNetProfit2: mySmartOffsetNetProfit2, smartOffsetStopLoss2: mySmartOffsetStopLoss2, smartOffsetMaxLossPerMinute: mySmartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds: mySmartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic: myMinuteCloseAutoDynamic, minuteCloseTpMinPnl: myMinuteCloseTpMinPnl, minuteCloseTpMaxPnl: myMinuteCloseTpMaxPnl, minuteCloseSlMinPnl: myMinuteCloseSlMinPnl, minuteCloseSlMaxPnl: myMinuteCloseSlMaxPnl, noPeakSlTimeframeSeconds: myNoPeakSlTimeframeSeconds, noPeakSlGatePnl: myNoPeakSlGatePnl };\n            const res = await fetch(\'/api/settings\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token }, body: JSON.stringify(data) });\n            const json = await res.json();\n            mySubAccounts = json.settings.subAccounts || [];\n            \n            if (!silent) alert(\'Profile Settings Saved!\');\n        }\n\n        async function toggleCoinBot(symbol, active) {\n            const coin = myCoins.find(c => c.symbol === symbol);\n            if(coin) coin.botActive = active;\n            await saveSettings(true); \n        }\n\n        async function loadOffsets() {\n            const res = await fetch(\'/api/offsets\', { headers: { \'Authorization\': \'Bearer \' + token } });\n            if (!res.ok) return;\n            const records = await res.json();\n            \n            if (records.length === 0) {\n                const noData = \'<p class="text-secondary">No trades executed yet.</p>\';\n                document.getElementById(\'offsetTableContainer\').innerHTML = noData;\n                document.getElementById(\'offsetTableContainer2\').innerHTML = noData;\n                return;\n            }\n\n            let ih = \'<table class="md-table">\';\n            ih += \'<tr><th>Date/Time</th><th>Symbol / Event</th><th>Action / Reason</th><th>Net Profit</th></tr>\';\n            \n            records.forEach(r => {\n                const dateObj = new Date(r.timestamp);\n                const symbolText = r.symbol || r.winnerSymbol || \'Unknown\';\n                const reasonText = r.reason || (r.loserSymbol ? \'Smart Offset (Legacy)\' : \'Unknown\');\n                const net = r.netProfit !== undefined ? r.netProfit : 0;\n                \n                const nColor = net >= 0 ? \'text-green\' : \'text-red\';\n\n                ih += \'<tr>\' +\n                    \'<td class="text-secondary">\' + dateObj.toLocaleDateString() + \' \' + dateObj.toLocaleTimeString() + \'</td>\' +\n                    \'<td class="text-blue" style="font-weight:500;">\' + symbolText + \'</td>\' +\n                    \'<td style="font-weight:500;">\' + reasonText + \'</td>\' +\n                    \'<td class="\' + nColor + \'" style="font-weight:700;">\' + (net >= 0 ? \'+\' : \'\') + \'$\' + net.toFixed(4) + \'</td>\' +\n                \'</tr>\';\n            });\n            ih += \'</table>\';\n            document.getElementById(\'offsetTableContainer\').innerHTML = ih;\n            document.getElementById(\'offsetTableContainer2\').innerHTML = ih;\n        }\n\n        async function loadStatus() {\n            const res = await fetch(\'/api/status\', { headers: { \'Authorization\': \'Bearer \' + token } });\n            if (res.status === 401 || res.status === 403) return logout();\n            \n            const data = await res.json();\n            const allStatuses = data.states || {};\n            const subAccountsUpdated = data.subAccounts || [];\n            const globalSet = data.globalSettings || {};\n            const currentMinuteLoss = data.currentMinuteLoss || 0;\n\n            let globalTotal = 0;\n            subAccountsUpdated.forEach(sub => {\n                globalTotal += (sub.realizedPnl || 0);\n                const localSub = mySubAccounts.find(s => s._id === sub._id);\n                if(localSub) localSub.realizedPnl = sub.realizedPnl;\n            });\n\n            let globalUnrealized = 0;\n            let globalMarginUsed = 0;\n            let totalTrading = 0;\n            let totalAboveZero = 0;\n            let activeCandidates = [];\n\n            for (let pid in allStatuses) {\n                const st = allStatuses[pid];\n\n                if (st && st.coinStates) {\n                    for (let sym in st.coinStates) {\n                        const cs = st.coinStates[sym];\n                        if (cs.contracts > 0) {\n                            globalMarginUsed += (parseFloat(cs.margin) || 0);\n                        }\n                        if (cs.contracts > 0 && (!cs.lockUntil || Date.now() >= cs.lockUntil)) {\n                            totalTrading++;\n                            const pnlNum = parseFloat(cs.unrealizedPnl) || 0;\n                            if (cs.currentRoi > 0) totalAboveZero++;\n                            globalUnrealized += pnlNum;\n                            activeCandidates.push({ symbol: sym, pnl: pnlNum });\n                        }\n                    }\n                }\n            }\n\n            // TTS: Play new Executed Trades automatically\n            if (data.recentOffsets && data.recentOffsets.length > 0) {\n                \n                // 1. ALWAYS set the absolute newest trade for the "Listen to Latest" button\n                const latestOffset = data.recentOffsets[0];\n                const symLatest = latestOffset.symbol ? latestOffset.symbol.replace(\'/USDT:USDT\', \'\') : \'Unknown Pair\';\n                const netLatest = parseFloat(latestOffset.netProfit) || 0;\n                const pWordLatest = netLatest >= 0 ? "profit" : "loss";\n                const cleanReasonLatest = latestOffset.reason ? latestOffset.reason.replace(/\\([^)]+\\)/g, \'\').trim() : \'\';\n                \n                let textToAssign = \'Trade event on \' + symLatest + \'. \' + cleanReasonLatest + \'.\';\n                if (netLatest !== 0) textToAssign += \' Net \' + pWordLatest + \' of \' + Math.abs(netLatest).toFixed(4) + \' dollars.\';\n                latestTradeToSpeak = textToAssign;\n\n                // 2. Loop to speak NEW trades aloud\n                for (let i = data.recentOffsets.length - 1; i >= 0; i--) {\n                    const offset = data.recentOffsets[i];\n                    if (!seenOffsets.has(offset._id)) {\n                        seenOffsets.add(offset._id);\n                        \n                        if (!isFirstLoad) {\n                            const loopSym = offset.symbol ? offset.symbol.replace(\'/USDT:USDT\', \'\') : \'Unknown Pair\';\n                            const loopNet = parseFloat(offset.netProfit) || 0;\n                            const loopPWord = loopNet >= 0 ? "profit" : "loss";\n                            const loopReason = offset.reason ? offset.reason.replace(/\\([^)]+\\)/g, \'\').trim() : \'\';\n                            \n                            let loopText = \'Trade event on \' + loopSym + \'. \' + loopReason + \'.\';\n                            if (loopNet !== 0) loopText += \' Net \' + loopPWord + \' of \' + Math.abs(loopNet).toFixed(4) + \' dollars.\';\n                            \n                            speakText(loopText);\n                        }\n                    }\n                }\n            } else if (isFirstLoad) {\n                latestTradeToSpeak = "No trades have been executed yet.";\n            }\n\n            if (isFirstLoad) isFirstLoad = false;\n\n            document.getElementById(\'topGlobalMargin\').innerText = "$" + globalMarginUsed.toFixed(2);\n\n            const timeframeSec = globalSet.smartOffsetMaxLossTimeframeSeconds !== undefined ? globalSet.smartOffsetMaxLossTimeframeSeconds : 60;\n            const maxLossPerMin = globalSet.smartOffsetMaxLossPerMinute || 0;\n            const lossTrackerHtml = maxLossPerMin > 0 \n                ? \'<div style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--divider);">⏳ <strong>\' + timeframeSec + \'s Loss Tracker:</strong> $\' + currentMinuteLoss.toFixed(2) + \' / $\' + maxLossPerMin.toFixed(2) + \' Limit</div>\'\n                : \'<div style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--divider);">⏳ <strong>\' + timeframeSec + \'s Loss Tracker:</strong> Limited to 1 SL execution per \' + timeframeSec + \'s</div>\';\n            \n            activeCandidates.sort((a, b) => b.pnl - a.pnl);\n            const totalCoins = activeCandidates.length;\n            const totalPairs = Math.floor(totalCoins / 2);\n            let hasDynamicBoundary = false;\n            let peakAccumulation = 0;\n\n            const multiplier = globalSet.qtyMultiplier || 1;\n            const noPeakGateVal = globalSet.noPeakSlGatePnl !== undefined ? parseFloat(globalSet.noPeakSlGatePnl) : 0; \n            const peakThreshold = 0.0001 * multiplier;\n            const winnerThreshold = 0.0002 * multiplier;\n\n            if (totalPairs > 0) {\n                let rAcc = 0;\n                for (let i = 0; i < totalPairs; i++) {\n                    rAcc += activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl;\n                    if (rAcc > peakAccumulation) peakAccumulation = rAcc;\n                }\n                if (peakAccumulation >= peakThreshold) hasDynamicBoundary = true;\n            }\n\n            const autoDynCheckbox = document.getElementById(\'minuteCloseAutoDynamic\');\n            const tpMinInput = document.getElementById(\'minuteCloseTpMinPnl\');\n            const tpMaxInput = document.getElementById(\'minuteCloseTpMaxPnl\');\n            const slMinInput = document.getElementById(\'minuteCloseSlMinPnl\');\n            const slMaxInput = document.getElementById(\'minuteCloseSlMaxPnl\');\n            const autoDynStatusBox = document.getElementById(\'autoDynStatusBox\');\n\n            if (autoDynCheckbox && autoDynCheckbox.checked) {\n                tpMinInput.disabled = true; tpMaxInput.disabled = true;\n                slMinInput.disabled = true; slMaxInput.disabled = true;\n                autoDynStatusBox.style.display = \'block\';\n\n                let tpMinBound = peakAccumulation * 0.8;\n                let tpMaxBound = peakAccumulation * 1.2;\n                let slMaxBound = -(peakAccumulation * 0.5);\n                let slMinBound = -(peakAccumulation * 5.0);\n\n                if (hasDynamicBoundary) {\n                    tpMinInput.value = tpMinBound.toFixed(4);\n                    tpMaxInput.value = tpMaxBound.toFixed(4);\n                    slMaxInput.value = slMaxBound.toFixed(4);\n                    slMinInput.value = slMinBound.toFixed(4);\n                }\n\n                let adHtml = \'\';\n                if (hasDynamicBoundary && totalPairs > 0) {\n                    let highestGroupAcc = -99999;\n                    let lowestGroupAcc = 99999;\n                    let highestGroupIndex = -1;\n                    let lowestGroupIndex = -1;\n\n                    let currentAcc = 0;\n                    for (let i = 0; i < totalPairs; i++) {\n                        currentAcc += activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl;\n                        if (currentAcc > highestGroupAcc) { highestGroupAcc = currentAcc; highestGroupIndex = i; }\n                        if (currentAcc < lowestGroupAcc) { lowestGroupAcc = currentAcc; lowestGroupIndex = i; }\n                    }\n\n                    let distToTp = tpMinBound - highestGroupAcc;\n                    let distToSl = lowestGroupAcc - slMaxBound; \n\n                    let tpDistText = distToTp > 0 ? \'$\' + distToTp.toFixed(4) + \' away\' : \'<span class="text-green" style="font-weight:bold;">IN RANGE</span>\';\n                    let slDistText = distToSl > 0 ? \'$\' + distToSl.toFixed(4) + \' away\' : \'<span class="text-red" style="font-weight:bold;">IN RANGE</span>\';\n\n                    adHtml += \'<div class="flex-row" style="justify-content: space-between; margin-bottom: 12px;">\';\n                    adHtml += \'<div><span class="stat-label">Closest to TP ($\' + tpMinBound.toFixed(4) + \')</span><span class="stat-val" style="font-size:1em;">Row \' + (highestGroupIndex + 1) + \': <span class="\' + (highestGroupAcc >= 0 ? \'text-green\' : \'text-red\') + \'">$\' + highestGroupAcc.toFixed(4) + \'</span> (\' + tpDistText + \')</span></div>\';\n                    adHtml += \'<div><span class="stat-label">Closest to SL ($\' + slMaxBound.toFixed(4) + \')</span><span class="stat-val" style="font-size:1em;">Row \' + (lowestGroupIndex + 1) + \': <span class="\' + (lowestGroupAcc >= 0 ? \'text-green\' : \'text-red\') + \'">$\' + lowestGroupAcc.toFixed(4) + \'</span> (\' + slDistText + \')</span></div>\';\n                    adHtml += \'</div>\';\n                } else {\n                    adHtml += \'<p>Calculating dynamic boundaries... (needs active positive peak)</p>\';\n                }\n\n                if (data.autoDynExec) {\n                    const typeColor = data.autoDynExec.type === \'Group Take Profit\' ? \'text-green\' : \'text-red\';\n                    adHtml += \'<div style="border-top:1px dashed #90CAF9; padding-top:12px; font-size:0.9em;">\' +\n                        \'<strong>Last Execution:</strong> <span class="\' + typeColor + \'" style="font-weight:bold;">\' + data.autoDynExec.type + \'</span> on <strong>\' + data.autoDynExec.symbol + \'</strong> at <span class="\' + typeColor + \'">$\' + data.autoDynExec.pnl.toFixed(4) + \'</span>\' +\n                    \'</div>\';\n                }\n                document.getElementById(\'autoDynLiveDetails\').innerHTML = adHtml;\n            } else if (autoDynCheckbox) {\n                tpMinInput.disabled = false; tpMaxInput.disabled = false;\n                slMinInput.disabled = false; slMaxInput.disabled = false;\n                autoDynStatusBox.style.display = \'none\';\n            }\n\n            // V1 LIVE TABLE\n            if (document.getElementById(\'offset-tab\').style.display === \'block\') {\n                const targetV1 = globalSet.smartOffsetNetProfit || 0;\n                const stopLossNth = globalSet.smartOffsetBottomRowV1StopLoss || 0; \n                const fullGroupSl = globalSet.smartOffsetStopLoss || 0; \n                const bottomRowN = globalSet.smartOffsetBottomRowV1 !== undefined ? globalSet.smartOffsetBottomRowV1 : 5;\n\n                if (totalPairs === 0) {\n                    document.getElementById(\'liveOffsetsContainer\').innerHTML = \'<p class="text-secondary">Not enough active trades to form pairs.</p>\';\n                } else {\n                    let liveHtml = \'<table class="md-table">\';\n                    liveHtml += \'<tr><th>Rank Pair</th><th>Winner Coin</th><th>Winner PNL</th><th>Loser Coin</th><th>Loser PNL</th><th>Pair Net</th><th class="text-blue">Group Accumulation</th></tr>\';\n\n                    let runningAccumulation = 0; let peakAccumulation = 0; let peakRowIndex = -1; let nthBottomAccumulation = 0;\n                    const targetRefIndex = Math.max(0, totalPairs - bottomRowN);\n\n                    for (let i = 0; i < totalPairs; i++) {\n                        const w = activeCandidates[i]; const l = activeCandidates[totalCoins - totalPairs + i];\n                        runningAccumulation += w.pnl + l.pnl;\n                        if (runningAccumulation > peakAccumulation) { peakAccumulation = runningAccumulation; peakRowIndex = i; }\n                        if (i === targetRefIndex) nthBottomAccumulation = runningAccumulation;\n                    }\n\n                    let topStatusMessage = \'\'; let executingPeak = false; let executingSl = false; let executingNoPeakSl = false; \n                    const isHitFullGroupSl = (fullGroupSl < 0 && runningAccumulation <= fullGroupSl);\n\n                    if (targetV1 > 0 && peakAccumulation >= targetV1 && peakAccumulation >= peakThreshold && peakRowIndex >= 0) {\n                        topStatusMessage = \'<span class="text-green" style="font-weight:bold;">🔥 Harvesting Peak Profit ($\' + peakAccumulation.toFixed(4) + \') at Row \' + (peakRowIndex + 1) + \'!</span>\';\n                        executingPeak = true;\n                    } else if (isHitFullGroupSl) { \n                        let blockedByLimit = (maxLossPerMin > 0 && (currentMinuteLoss + Math.abs(runningAccumulation)) > maxLossPerMin);\n                        if (blockedByLimit) topStatusMessage = \'<span class="text-red" style="font-weight:bold;">🛑 Stop Loss Blocked by Timeframe Limit!</span>\';\n                        else { executingSl = true; topStatusMessage = \'<span class="text-red" style="font-weight:bold;">🔥 Stop Loss Hit (Group &le; $\' + fullGroupSl.toFixed(4) + \')!</span>\'; }\n                    } else if (peakRowIndex === -1 || peakAccumulation < peakThreshold) {\n                        if (activeCandidates[0].pnl > noPeakGateVal) {\n                            executingNoPeakSl = false;\n                            topStatusMessage = \'<span class="text-warning" style="font-weight:bold;">⚠️ No Peak Found. GATED: Waiting for winners to drop &le; $\' + noPeakGateVal.toFixed(4) + \'.</span>\';\n                        } else {\n                            executingNoPeakSl = true;\n                            topStatusMessage = \'<span class="text-red" style="font-weight:bold;">⚠️ No Peak & Winners &le; $\' + noPeakGateVal.toFixed(4) + \'. Ready to cut lowest PNL every \' + (globalSet.noPeakSlTimeframeSeconds !== undefined ? globalSet.noPeakSlTimeframeSeconds : 1800) + \' secs.</span>\';\n                        }\n                    } else {\n                        let pColor = peakAccumulation >= peakThreshold ? \'text-green\' : \'text-secondary\';\n                        topStatusMessage = \'TP Status: <span class="text-blue" style="font-weight:bold;"><span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle;">search</span> Seeking Peak &ge; $\' + targetV1.toFixed(4) + \'</span> | Current Peak: <strong class="\' + pColor + \'">+$\' + peakAccumulation.toFixed(4) + \'</strong>\';\n                    }\n\n                    let displayAccumulation = 0;\n                    for (let i = 0; i < totalPairs; i++) {\n                        const winnerIndex = i; const loserIndex = totalCoins - totalPairs + i;\n                        const w = activeCandidates[winnerIndex]; const l = activeCandidates[loserIndex];\n                        const net = w.pnl + l.pnl; displayAccumulation += net;\n                        \n                        let statusIcon = \'hourglass_empty Waiting\';\n                        if (executingPeak) {\n                            if (i <= peakRowIndex) statusIcon = Math.abs(w.pnl) <= winnerThreshold ? \'pause_circle Skipped\' : \'local_fire_department Harvesting\';\n                            else statusIcon = \'pause_circle Ignored\';\n                        } else if (executingSl) statusIcon = \'local_fire_department Executing SL\';\n                        else if (executingNoPeakSl) statusIcon = (i === totalPairs - 1) ? \'local_fire_department Cutting\' : \'trending_down Waiting\';\n                        else statusIcon = (i <= peakRowIndex && peakAccumulation >= peakThreshold) ? \'trending_up Part of Peak\' : \'trending_down Dragging down\';\n\n                        const wColor = w.pnl >= 0 ? \'text-green\' : \'text-red\';\n                        const lColor = l.pnl >= 0 ? \'text-green\' : \'text-red\';\n                        const nColor = net >= 0 ? \'text-green\' : \'text-red\';\n                        const cColor = displayAccumulation >= 0 ? \'text-green\' : \'text-red\';\n\n                        let rowClass = (i === peakRowIndex && peakAccumulation >= peakThreshold) ? \'peak-row\' : \'\';\n                        if (i === targetRefIndex) rowClass += \' highlight-row\'; \n\n                        liveHtml += \'<tr class="\' + rowClass + \'">\' +\n                            \'<td class="text-secondary">\' + (winnerIndex + 1) + \' & \' + (loserIndex + 1) + \' <br><span class="text-blue" style="font-size:0.75em"><span class="material-symbols-outlined" style="font-size:12px; vertical-align:middle;">\' + statusIcon.split(\' \')[0] + \'</span> \' + statusIcon.substring(statusIcon.indexOf(\' \')+1) + \'</span></td>\' +\n                            \'<td style="font-weight:500;">\' + w.symbol + \'</td>\' +\n                            \'<td class="\' + wColor + \'" style="font-weight:700;">\' + (w.pnl >= 0 ? \'+\' : \'\') + \'$\' + w.pnl.toFixed(4) + \'</td>\' +\n                            \'<td style="font-weight:500;">\' + l.symbol + \'</td>\' +\n                            \'<td class="\' + lColor + \'" style="font-weight:700;">\' + (l.pnl >= 0 ? \'+\' : \'\') + \'$\' + l.pnl.toFixed(4) + \'</td>\' +\n                            \'<td class="\' + nColor + \'" style="font-weight:700; background: #FAFAFA;">\' + (net >= 0 ? \'+\' : \'\') + \'$\' + net.toFixed(4) + \'</td>\' +\n                            \'<td class="\' + cColor + \'" style="font-weight:700; background: #F5F5F5;">\' +\n                                (displayAccumulation >= 0 ? \'+\' : \'\') + \'$\' + displayAccumulation.toFixed(4) +\n                                (i === targetRefIndex ? \'<br><span style="font-size:0.7em; color:var(--warning);"><span class="material-symbols-outlined" style="font-size:12px; vertical-align:middle;">star</span> Nth Row Ref Gate</span>\' : \'\') +\n                            \'</td>\' +\n                        \'</tr>\';\n                    }\n                    liveHtml += \'</table>\';\n                    \n                    let dynamicInfoHtml = \'<div class="stat-box" style="margin-bottom:16px; background:#E3F2FD; border-color:#90CAF9; color:var(--primary);">\' +\n                        \'<div class="flex-row" style="justify-content: space-between; margin-bottom: 8px;">\' +\n                            \'<div><span class="material-symbols-outlined" style="vertical-align:middle;">my_location</span> Target: $\' + targetV1.toFixed(4) + \'</div>\' +\n                            \'<div><span class="material-symbols-outlined" style="vertical-align:middle;">block</span> Full Group Stop: $\' + fullGroupSl.toFixed(4) + \'</div>\' +\n                            \'<div><span class="material-symbols-outlined" style="vertical-align:middle; color:var(--warning);">star</span> Row \' + bottomRowN + \' Gate Limit: $\' + stopLossNth.toFixed(4) + \'</div>\' +\n                        \'</div>\' +\n                        lossTrackerHtml +\n                        \'<div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--divider); font-size: 1.1em;">Live Status: \' + topStatusMessage + \'</div>\' +\n                    \'</div>\';\n\n                    document.getElementById(\'liveOffsetsContainer\').innerHTML = dynamicInfoHtml + liveHtml;\n                }\n            }\n\n            // V2 LIVE TABLE\n            if (document.getElementById(\'offset2-tab\').style.display === \'block\') {\n                const targetV2 = globalSet.smartOffsetNetProfit2 || 0;\n                const limitV2 = globalSet.smartOffsetStopLoss2 || 0;\n                const stopLossNth = globalSet.smartOffsetBottomRowV1StopLoss || 0;\n                const bottomRowN = globalSet.smartOffsetBottomRowV1 !== undefined ? globalSet.smartOffsetBottomRowV1 : 5;\n                const targetRefIndex = Math.max(0, totalPairs - bottomRowN);\n\n                let nthBottomAccumulation = 0; let tempAcc = 0;\n                for (let i = 0; i < totalPairs; i++) {\n                    tempAcc += activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl;\n                    if (i === targetRefIndex) nthBottomAccumulation = tempAcc;\n                }\n\n                let v2SlEnabled = true;\n                if (stopLossNth < 0) v2SlEnabled = (nthBottomAccumulation <= stopLossNth);\n\n                if (totalPairs === 0) {\n                    document.getElementById(\'liveOffsetsContainer2\').innerHTML = \'<p class="text-secondary">Not enough active trades to form pairs.</p>\';\n                } else {\n                    let liveHtml = \'<table class="md-table">\';\n                    liveHtml += \'<tr><th>Rank Pair</th><th>Winner Coin</th><th>Winner PNL</th><th>Loser Coin</th><th>Loser PNL</th><th>Live Net Profit</th></tr>\';\n\n                    let topStatusMessage2 = \'<span style="color:var(--warning);"><span class="material-symbols-outlined" style="vertical-align:middle;">hourglass_empty</span> Evaluating pairs... Target not reached.</span>\';\n\n                    for (let i = 0; i < totalPairs; i++) {\n                        const winnerIndex = i; const loserIndex = totalCoins - 1 - i;\n                        const w = activeCandidates[winnerIndex]; const l = activeCandidates[loserIndex];\n                        const net = w.pnl + l.pnl;\n\n                        const wColor = w.pnl >= 0 ? \'text-green\' : \'text-red\';\n                        const lColor = l.pnl >= 0 ? \'text-green\' : \'text-red\';\n                        const nColor = net >= 0 ? \'text-green\' : \'text-red\';\n                        \n                        const isTargetHit = (targetV2 > 0 && net >= targetV2);\n                        const isSlHit = (v2SlEnabled && limitV2 < 0 && net <= limitV2);\n                        \n                        let statusIcon = \'hourglass_empty Evaluating\';\n                        if (isTargetHit) {\n                            statusIcon = \'local_fire_department Executing TP...\';\n                            topStatusMessage2 = \'<span class="text-green" style="font-weight:bold;">🔥 Executing Pair \' + (winnerIndex+1) + \' for TP!</span>\';\n                        } else if (isSlHit) {\n                            let blockedByLimit = (maxLossPerMin > 0 && (currentMinuteLoss + Math.abs(net)) > maxLossPerMin);\n                            if (blockedByLimit) {\n                                statusIcon = \'block Blocked by Limit\';\n                                if (topStatusMessage2.includes(\'Evaluating\')) topStatusMessage2 = \'<span class="text-red" style="font-weight:bold;">🛑 Stop Loss V2 Blocked by Limit!</span>\';\n                            } else {\n                                statusIcon = \'block Executing SL...\';\n                                topStatusMessage2 = \'<span class="text-red" style="font-weight:bold;">🛑 Executing Pair \' + (winnerIndex+1) + \' for SL!</span>\';\n                            }\n                        } else if (!v2SlEnabled && limitV2 < 0 && net <= limitV2) {\n                            statusIcon = \'pause_circle SL Gated\';\n                        }\n\n                        liveHtml += \'<tr>\' +\n                            \'<td class="text-secondary">\' + (winnerIndex + 1) + \' & \' + (loserIndex + 1) + \' <br><span class="text-blue" style="font-size:0.75em"><span class="material-symbols-outlined" style="font-size:12px; vertical-align:middle;">\' + statusIcon.split(\' \')[0] + \'</span> \' + statusIcon.substring(statusIcon.indexOf(\' \')+1) + \'</span></td>\' +\n                            \'<td style="font-weight:500;">\' + w.symbol + \'</td>\' +\n                            \'<td class="\' + wColor + \'" style="font-weight:700;">\' + (w.pnl >= 0 ? \'+\' : \'\') + \'$\' + w.pnl.toFixed(4) + \'</td>\' +\n                            \'<td style="font-weight:500;">\' + l.symbol + \'</td>\' +\n                            \'<td class="\' + lColor + \'" style="font-weight:700;">\' + (l.pnl >= 0 ? \'+\' : \'\') + \'$\' + l.pnl.toFixed(4) + \'</td>\' +\n                            \'<td class="\' + nColor + \'" style="font-weight:700; background: #FAFAFA;">\' + (net >= 0 ? \'+\' : \'\') + \'$\' + net.toFixed(4) + \'</td>\' +\n                        \'</tr>\';\n                    }\n                    liveHtml += \'</table>\';\n                    \n                    let slGateStatus = stopLossNth < 0 \n                        ? (v2SlEnabled ? \'<span class="text-red" style="font-weight:bold;">ENABLED</span> (V1 Accum &le; Limit)\' : \'<span style="color:var(--warning); font-weight:bold;">GATED</span> (V1 Accum &gt; Limit)\')\n                        : \'<span class="text-green" style="font-weight:bold;">ALWAYS ENABLED</span> (No Gate Set)\';\n\n                    let dynamicInfoHtml2 = \'<div class="stat-box" style="margin-bottom:16px; background:#E3F2FD; border-color:#90CAF9; color:var(--primary);">\' +\n                        \'<div class="flex-row" style="justify-content: space-between; margin-bottom: 8px;">\' +\n                            \'<div><span class="material-symbols-outlined" style="vertical-align:middle;">my_location</span> TP V2: $\' + targetV2.toFixed(4) + \'</div>\' +\n                            \'<div><span class="material-symbols-outlined" style="vertical-align:middle;">block</span> SL V2: $\' + limitV2.toFixed(4) + \'</div>\' +\n                            \'<div style="font-size:0.9em;"><span class="material-symbols-outlined" style="vertical-align:middle;">security</span> V2 Gate: \' + slGateStatus + \'</div>\' +\n                        \'</div>\' +\n                        lossTrackerHtml +\n                        \'<div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--divider); font-size: 1.1em;">Live Status: \' + topStatusMessage2 + \'</div>\' +\n                    \'</div>\';\n\n                    document.getElementById(\'liveOffsetsContainer2\').innerHTML = dynamicInfoHtml2 + liveHtml;\n                }\n            }\n\n            document.getElementById(\'globalWinRate\').innerText = totalAboveZero + \' / \' + totalTrading;\n            const topPnlEl = document.getElementById(\'topGlobalUnrealized\');\n            topPnlEl.innerText = (globalUnrealized >= 0 ? "+$" : "-$") + Math.abs(globalUnrealized).toFixed(4);\n            topPnlEl.className = \'stat-val \' + (globalUnrealized >= 0 ? \'text-green\' : \'text-red\');\n\n            if(currentProfileIndex === -1) return;\n\n            const globalPnlEl = document.getElementById(\'globalPnl\');\n            globalPnlEl.innerText = (globalTotal >= 0 ? "+$" : "-$") + Math.abs(globalTotal).toFixed(4);\n            globalPnlEl.className = \'stat-val \' + (globalTotal >= 0 ? \'text-green\' : \'text-red\');\n\n            const profile = mySubAccounts[currentProfileIndex];\n            const profilePnlEl = document.getElementById(\'profilePnl\');\n            const pPnl = profile.realizedPnl || 0;\n            profilePnlEl.innerText = (pPnl >= 0 ? "+$" : "-$") + Math.abs(pPnl).toFixed(4);\n            profilePnlEl.className = \'stat-val \' + (pPnl >= 0 ? \'text-green\' : \'text-red\');\n\n            let profileMargin = 0;\n            const stateData = allStatuses[profile._id] || { coinStates: {}, logs: [] };\n            \n            if(!myCoins || myCoins.length === 0) {\n                document.getElementById(\'dashboardStatusContainer\').innerHTML = \'<p class="text-secondary">No coins added to this profile.</p>\';\n                document.getElementById(\'profileMargin\').innerText = "$0.00";\n            } else {\n                let html = \'\';\n                myCoins.forEach(coin => {\n                    const state = stateData.coinStates && stateData.coinStates[coin.symbol] ? stateData.coinStates[coin.symbol] : { status: \'Stopped\', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0 };\n                    \n                    if (state.contracts > 0) {\n                        profileMargin += (parseFloat(state.margin) || 0);\n                    }\n\n                    let statusColor = state.status === \'Running\' ? \'text-green\' : \'text-red\';\n                    let roiColorClass = state.currentRoi >= 0 ? \'text-green\' : \'text-red\';\n                    const displaySide = coin.side || profile.side || \'long\';\n\n                    if (state.lockUntil && Date.now() < state.lockUntil) {\n                        statusColor = \'text-warning\';\n                        state.status = \'Closing / Locked\';\n                    }\n\n                    html += \'<div class="stat-box" style="margin-bottom:16px;">\' +\n                        \'<div class="flex-row" style="justify-content: space-between; border-bottom: 1px solid var(--divider); padding-bottom: 12px; margin-bottom: 12px;">\' +\n                            \'<div style="font-size: 1.1em; font-weight: 500;">\' +\n                                coin.symbol + \' <span class="text-secondary" style="font-size: 0.8em;">(\' + displaySide.toUpperCase() + \')</span> - Status: <span class="\' + statusColor + \'" style="font-weight:700;">\' + state.status + \'</span>\' +\n                            \'</div>\' +\n                            \'<div class="flex-row">\' +\n                                \'<button class="md-btn md-btn-success" style="padding:6px 12px;" onclick="toggleCoinBot(\\\'\' + coin.symbol + \'\\\', true)"><span class="material-symbols-outlined" style="font-size:18px;">play_arrow</span> Start</button>\' +\n                                \'<button class="md-btn md-btn-danger" style="padding:6px 12px;" onclick="toggleCoinBot(\\\'\' + coin.symbol + \'\\\', false)"><span class="material-symbols-outlined" style="font-size:18px;">stop</span> Stop</button>\' +\n                            \'</div>\' +\n                        \'</div>\' +\n                        \'<div class="flex-row" style="justify-content: space-between;">\' +\n                            \'<div><span class="stat-label">Price</span><span class="stat-val" style="font-size:1em;">\' + (state.currentPrice || 0) + \'</span></div>\' +\n                            \'<div><span class="stat-label">Avg Entry</span><span class="stat-val" style="font-size:1em;">\' + (state.avgEntry || 0) + \'</span></div>\' +\n                            \'<div><span class="stat-label">Contracts</span><span class="stat-val" style="font-size:1em;">\' + (state.contracts || 0) + \'</span></div>\' +\n                            \'<div><span class="stat-label">Unrealized PNL</span><span class="stat-val \' + roiColorClass + \'" style="font-size:1em;">\' + (state.unrealizedPnl || 0).toFixed(4) + \'</span></div>\' +\n                            \'<div><span class="stat-label">ROI %</span><span class="stat-val \' + roiColorClass + \'" style="font-size:1em;">\' + (state.currentRoi || 0).toFixed(2) + \'%</span></div>\' +\n                        \'</div>\' +\n                    \'</div>\';\n                });\n                document.getElementById(\'dashboardStatusContainer\').innerHTML = html;\n                document.getElementById(\'profileMargin\').innerText = "$" + profileMargin.toFixed(2);\n            }\n\n            document.getElementById(\'logs\').innerHTML = (stateData.logs || []).join(\'<br>\');\n        }\n\n        checkAuth(); // Initialize\n    </script>\n</body>\n</html>');
});

// VERCEL EXPORT: Safe Execution Block
if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Running locally on http://localhost:${PORT}`));
}
module.exports = app;
