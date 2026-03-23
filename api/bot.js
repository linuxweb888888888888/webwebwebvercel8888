const express = require('express');
const ccxt = require('ccxt');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

// ==================== GLOBAL CACHE (SERVERLESS OPTIMIZATION) ====================
let cachedDb = null;
const sharedExchange = new ccxt.htx({ enableRateLimit: false, options: { defaultType: 'linear' } });

const FETCH_CURRENCY = 'USDT';
const DISPLAY_CURRENCY = 'USD';

async function getDb() {
    if (cachedDb) return cachedDb;
    if (!process.env.MONGO_URI) return null;
    try {
        const client = await MongoClient.connect(process.env.MONGO_URI);
        cachedDb = client.db("Commercial_Bank_System").collection("session_growth");
        return cachedDb;
    } catch (e) {
        console.error("DB Connection Failed", e);
        return null;
    }
}

// ==================== API: FETCH DATA ====================
app.get('/api/data', async (req, res) => {
    const accountsConfig = process.env.HTX_ACCOUNTS; // Expected: [{"name":"Savings", "apiKey":"...", "secret":"..."}]
    if (!accountsConfig) return res.status(500).json({ error: "Missing HTX_ACCOUNTS Environment Variable" });

    let accounts = [];
    try { accounts = JSON.parse(accountsConfig); } 
    catch (e) { return res.status(500).json({ error: "Invalid HTX_ACCOUNTS JSON formatting." }); }

    let grandTotal = 0; let grandFree = 0; let grandUsed = 0;
    const processedAccounts = [];

    // Process accounts sequentially
    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        sharedExchange.apiKey = acc.apiKey;
        sharedExchange.secret = acc.secret;
        
        let totalEquity = 0; let freeCurrency = 0; let accError = null;

        try {
            const bal = await sharedExchange.fetchBalance({ type: 'swap', marginMode: 'cross' });
            if (bal?.total?.[FETCH_CURRENCY] !== undefined) {
                totalEquity = parseFloat(bal.total[FETCH_CURRENCY] || 0);
                freeCurrency = parseFloat(bal.free[FETCH_CURRENCY] || 0);
            } else { throw new Error("No USDT found"); }

            let totalUnrealizedPnl = 0;
            const ccxtPos = await sharedExchange.fetchPositions(undefined, { marginMode: 'cross' }).catch(() => []);
            if (ccxtPos) ccxtPos.forEach(p => { totalUnrealizedPnl += parseFloat(p.unrealizedPnl || 0); });

            totalEquity = totalEquity - totalUnrealizedPnl;
            
            grandTotal += totalEquity; grandFree += freeCurrency; grandUsed += (totalEquity - freeCurrency);
        } catch (err) {
            accError = "Connection Error";
        }

        processedAccounts.push({
            id: i + 1,
            name: acc.name || `Account ${i + 1}`,
            mask: (1000 + ((i+1) * 739)).toString().slice(-4),
            total: totalEquity,
            free: freeCurrency,
            error: accError,
            isLoaded: true
        });
    }

    // Database Sync
    const dbCollection = await getDb();
    let state = { startTime: Date.now(), startBalance: grandTotal };
    
    if (dbCollection) {
        state = await dbCollection.findOne({ currency: DISPLAY_CURRENCY });
        if (!state) {
            state = { startTime: Date.now(), startBalance: grandTotal };
            await dbCollection.updateOne({ currency: DISPLAY_CURRENCY }, { $set: state }, { upsert: true });
        }
    }

    const now = Date.now();
    const secondsElapsed = Math.max(1, (now - state.startTime) / 1000);
    const growth = grandTotal - state.startBalance;
    const avgGrowthPerSec = growth / secondsElapsed;

    const d = new Date();
    const timestamp = d.toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}) + ' at ' + d.toLocaleTimeString('en-US');

    res.status(200).json({
        combined: {
            currency: DISPLAY_CURRENCY,
            startBalance: state.startBalance, total: grandTotal, free: grandFree, used: grandUsed,
            growth: growth, growthPct: state.startBalance > 0 ? (growth / state.startBalance) * 100 : 0,
            avgGrowthPerSec: avgGrowthPerSec, growthPerHour: avgGrowthPerSec * 3600,
            growthPerDay: avgGrowthPerSec * 86400, growthPerYear: avgGrowthPerSec * 31536000,
            secondsElapsed: secondsElapsed, timestamp: timestamp, isReady: true,
            loadedCount: accounts.length, totalCount: accounts.length
        },
        accounts: processedAccounts
    });
});

// ==================== API: RESET SESSION ====================
app.post('/api/reset', async (req, res) => {
    const dbCollection = await getDb();
    if (dbCollection) {
        await dbCollection.updateOne(
            { currency: DISPLAY_CURRENCY },
            { $set: { startTime: Date.now(), startBalance: req.body.currentTotal || 0, updatedAt: new Date() } },
            { upsert: true }
        );
    }
    res.status(200).json({ success: true });
});

// ==================== FRONTEND: SERVE HTML ====================
app.get('/', (req, res) => {
    res.send(getHtml());
});

// Tell Vercel this is an Express app
module.exports = app;

// ==================== HTML TEMPLATE ====================
function getHtml() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Account Summary - Citi</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root { --citi-blue: #003b70; --citi-light-blue: #056dae; --citi-red: #e5231b; --bg-color: #f4f4f4; --white: #ffffff; --text-dark: #333333; --text-gray: #666666; --border-color: #dcdcdc; --green: #218c39; --red: #d32f2f; }
        * { box-sizing: border-box; }
        body { background: var(--bg-color); color: var(--text-dark); font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
        .top-nav { background-color: var(--citi-blue); height: 60px; width: 100%; display: flex; justify-content: space-between; align-items: center; padding: 0 40px; border-top: 4px solid var(--citi-red); }
        .logo-area { color: var(--white); font-size: 26px; font-weight: bold; letter-spacing: -1px; display: flex; align-items: center; }
        .logo-citi { font-family: 'Trebuchet MS', sans-serif; position: relative; }
        .logo-arc { position: absolute; top: -5px; left: 5px; width: 20px; height: 12px; border-top: 3px solid var(--citi-red); border-radius: 50% 50% 0 0; }
        .nav-links { display: flex; gap: 20px; color: var(--white); font-size: 13px; font-weight: bold; }
        .nav-links span { cursor: pointer; opacity: 0.9; } .nav-links span:hover { text-decoration: underline; opacity: 1; }
        .sub-nav { background-color: var(--white); border-bottom: 1px solid var(--border-color); padding: 15px 40px; display: flex; gap: 30px; font-size: 14px; font-weight: bold; color: var(--citi-blue); }
        .sub-nav .active { border-bottom: 3px solid var(--citi-blue); padding-bottom: 13px; }
        .container { max-width: 1100px; margin: 30px auto; padding: 0 20px; display: grid; grid-template-columns: 2fr 1fr; gap: 30px; }
        .page-header { grid-column: 1 / -1; margin-bottom: 10px; }
        .page-header h1 { font-size: 24px; font-weight: normal; margin: 0 0 5px 0; color: var(--text-dark); }
        .page-header p { font-size: 12px; color: var(--text-gray); margin: 0; }
        .panel { background: var(--white); border: 1px solid var(--border-color); border-radius: 4px; margin-bottom: 25px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .panel-header { background: #f8f8f8; padding: 15px 20px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; }
        .panel-header h2 { font-size: 16px; font-weight: bold; color: var(--text-dark); margin: 0; }
        .account-table { width: 100%; border-collapse: collapse; }
        .account-table th { text-align: left; padding: 12px 20px; font-size: 11px; text-transform: uppercase; color: var(--text-gray); border-bottom: 1px solid var(--border-color); font-weight: normal; }
        .account-table td { padding: 18px 20px; border-bottom: 1px solid #eeeeee; vertical-align: top; }
        .account-table tr:hover { background-color: #fafafa; cursor: pointer; }
        .acct-name { font-size: 15px; color: var(--citi-light-blue); font-weight: bold; text-decoration: none; }
        .acct-name:hover { text-decoration: underline; }
        .acct-mask { font-size: 12px; color: var(--text-gray); display: block; margin-top: 4px; }
        .acct-bal { font-size: 16px; font-weight: bold; text-align: right; }
        .acct-avail { font-size: 12px; color: var(--text-gray); text-align: right; display: block; margin-top: 4px; }
        .total-row { background-color: #f8f8f8; border-top: 2px solid var(--border-color); }
        .total-row td { padding: 15px 20px; font-weight: bold; font-size: 18px; }
        .sidebar-data-row { display: flex; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid #eeeeee; font-size: 13px; }
        .sidebar-data-row .label { color: var(--text-gray); } .sidebar-data-row .value { font-weight: bold; font-size: 14px;}
        .highlight-block { padding: 20px; text-align: center; background: #eef4fb; border-bottom: 1px solid var(--border-color); }
        .highlight-title { font-size: 12px; text-transform: uppercase; color: var(--citi-blue); font-weight: bold; margin-bottom: 8px;}
        .highlight-amount { font-size: 28px; font-weight: normal; color: var(--citi-blue); }
        .btn-primary { background-color: var(--citi-light-blue); color: white; border: none; padding: 10px 15px; border-radius: 3px; font-size: 13px; font-weight: bold; cursor: pointer; width: 100%; margin-top: 15px; }
        .btn-primary:hover { background-color: var(--citi-blue); }
        .color-green { color: var(--green); } .color-red { color: var(--red); }
        .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ccc; margin-right: 5px;}
        .status-dot.active { background: var(--green); }
        @media (max-width: 850px) { .container { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <div class="top-nav">
        <div class="logo-area"><div class="logo-citi">citi<div class="logo-arc"></div></div></div>
        <div class="nav-links"><span>Locations</span><span>Contact Us</span><span>Sign Off</span></div>
    </div>
    <div class="sub-nav"><div class="active">Account Summary</div><div>Payments & Transfers</div><div>Investments</div><div>Profile & Settings</div></div>
    
    <div class="container">
        <div class="page-header">
            <h1 id="greeting">Connecting to Core Banking Network...</h1>
            <p><span class="status-dot" id="connDot"></span> Last successful sync: <span id="time">--</span></p>
        </div>

        <div class="left-col">
            <div class="panel">
                <div class="panel-header">
                    <h2>Deposit Accounts</h2><span style="font-size: 13px; font-weight: bold; color: var(--text-gray);">Base Currency: USD</span>
                </div>
                <table class="account-table">
                    <thead><tr><th>Account Name</th><th style="text-align:right">Present Balance</th></tr></thead>
                    <tbody id="accBody"></tbody>
                    <tr class="total-row"><td>Total Deposit Accounts</td><td style="text-align:right" id="grandTotal">--</td></tr>
                </table>
            </div>
        </div>

        <div class="right-col">
            <div class="panel">
                <div class="panel-header"><h2>Statement Period Summary</h2></div>
                <div class="sidebar-data-row"><span class="label">Starting Balance</span><span class="value" id="startBal">--</span></div>
                <div class="sidebar-data-row"><span class="label">Total Available</span><span class="value" id="availBal">--</span></div>
                <div class="sidebar-data-row"><span class="label">Session Elapsed</span><span class="value" id="elapsed">--</span></div>
                <div style="padding: 15px 20px;"><button class="btn-primary" onclick="resetSession()">Generate New Statement</button></div>
            </div>

            <div class="panel">
                <div class="panel-header"><h2>Yield & Accrual (YTD)</h2></div>
                <div class="highlight-block">
                    <div class="highlight-title">Total Interest Accrued</div>
                    <div class="highlight-amount" id="interestAccrued">--</div>
                    <div style="font-size: 12px; margin-top:5px;" id="effectiveYield">APY Equivalent: --</div>
                </div>
                <div style="padding: 15px 20px; font-size: 12px; color: var(--text-gray); background:#fcfcfc; border-bottom:1px solid #eee;"><strong>Forecasted Interest Trajectory</strong></div>
                <div class="sidebar-data-row"><span class="label">Per Second</span><span class="value" id="projSec" style="font-family: monospace;">--</span></div>
                <div class="sidebar-data-row"><span class="label">Hourly Accrual</span><span class="value" id="projHour">--</span></div>
                <div class="sidebar-data-row"><span class="label">Daily Accrual</span><span class="value" id="projDay">--</span></div>
                <div class="sidebar-data-row"><span class="label">Annualized Est.</span><span class="value" id="projYear">--</span></div>
            </div>
        </div>
    </div>

<script>
    let currentGrandTotal = 0;

    async function resetSession() { 
        if(confirm('Initialize a new statement period? Your starting balance will be updated to your current Present Balance.')) {
            await fetch('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentTotal: currentGrandTotal }) });
            fetchData();
        }
    }
    
    const fmtFiat = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
    const fmtMicro = (n) => { let val = Number(n); return (val < 0 ? '-$' : '$') + Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 }); };
    const fmtPct = (n) => (n > 0 ? '+' : '') + Number(n).toFixed(2) + '%';
    const colorClass = (n) => n > 0 ? 'color-green' : (n < 0 ? 'color-red' : '');
    const formatTime = (seconds) => {
        const h = Math.floor(seconds / 3600).toString().padStart(2,'0');
        const m = Math.floor((seconds % 3600) / 60).toString().padStart(2,'0');
        const s = Math.floor(seconds % 60).toString().padStart(2,'0');
        return \`\${h}:\${m}:\${s}\`;
    };

    const updateVal = (id, val, formatter, colorize=false, forcePlus=false) => {
        const el = document.getElementById(id);
        if(!el) return;
        let txt = formatter(val);
        if(forcePlus && val > 0 && !txt.startsWith('+') && !txt.startsWith('+$')) txt = txt.replace('$', '+$');
        el.innerText = txt;
        if(colorize) el.className = 'value ' + colorClass(val);
    };

    async function fetchData() {
        try {
            document.getElementById('connDot').classList.remove('active');
            const res = await fetch('/api/data');
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            updateUI(data);
            document.getElementById('connDot').classList.add('active');
        } catch (e) { console.error("Fetch Error:", e); }
    }

    function updateUI(data) {
        const c = data.combined;
        currentGrandTotal = c.total;

        const hour = new Date().getHours();
        let greet = hour < 12 ? 'Good morning' : (hour < 17 ? 'Good afternoon' : 'Good evening');
        document.getElementById('greeting').innerText = \`\${greet}, Priority Client\`;
        document.getElementById('time').innerText = c.timestamp;
        document.getElementById('elapsed').innerText = formatTime(c.secondsElapsed);

        document.getElementById('grandTotal').innerText = fmtFiat(c.total);
        document.getElementById('startBal').innerText = fmtFiat(c.startBalance);
        document.getElementById('availBal').innerText = fmtFiat(c.free);

        let interestTxt = fmtFiat(c.growth);
        if (c.growth > 0) interestTxt = interestTxt.replace('$', '+$');
        const intEl = document.getElementById('interestAccrued');
        intEl.innerText = interestTxt;
        intEl.className = 'highlight-amount ' + colorClass(c.growth);
        document.getElementById('effectiveYield').innerHTML = \`APY Equivalent: <strong class="\${colorClass(c.growthPct)}">\${fmtPct(c.growthPct)}</strong>\`;

        updateVal('projSec', c.avgGrowthPerSec, fmtMicro, true, true);
        updateVal('projHour', c.growthPerHour, fmtFiat, true, true);
        updateVal('projDay', c.growthPerDay, fmtFiat, true, true);
        updateVal('projYear', c.growthPerYear, fmtFiat, true, true);

        const tbody = document.getElementById('accBody');
        tbody.innerHTML = '';
        data.accounts.forEach(acc => {
            const tr = document.createElement('tr');
            let balHtml = acc.error ? \`<span class="color-red" style="font-size:13px;">Action Required: \${acc.error}</span>\` : \`<div class="acct-bal">\${fmtFiat(acc.total)}</div><div class="acct-avail">Available: \${fmtFiat(acc.free)}</div>\`;
            let acctType = acc.id % 2 === 0 ? 'Priority Savings' : 'Citigold Checking';
            tr.innerHTML = \`<td><a href="#" class="acct-name">\${acctType}</a><span class="acct-mask">Account ending in \${acc.mask}</span></td><td style="text-align:right; vertical-align:middle;">\${balHtml}</td>\`;
            tbody.appendChild(tr);
        });
    }

    fetchData();
    // Request update every 5 seconds (Avoids rate limits on free Vercel tiers)
    setInterval(fetchData, 5000); 
</script>
</body>
</html>
    `;
}
