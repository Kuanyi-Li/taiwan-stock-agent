// ── app.js  ── Main orchestration v3
// 修正：零股、滾動、圓餅圖、直觀買賣訊號、目標追蹤現金/美金、資產曲線、短線推薦

// ── CURRENCY module ───────────────────────────────────
const CURRENCY = {
  usdRate: null,
  async fetchUSDRate() {
    try {
      const res = await DATA._fetch('https://query2.finance.yahoo.com/v8/finance/chart/USDTWD=X?interval=1d&range=5d&_=' + Date.now());
      const json = await res.json();
      const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) { this.usdRate = +price.toFixed(2); this._updateDisplay(); }
      else throw new Error('no price');
    } catch(e) {
      // 備援：用固定匯率
      if (!this.usdRate) this.usdRate = 32.0;
    }
  },
  _updateDisplay() {
    const el = document.getElementById('usd-rate-display');
    if (el && this.usdRate) el.textContent = `1 USD = ${this.usdRate} TWD`;
  },
  toTWD(usd) { return usd * (this.usdRate || 32.0); },
};

// ── VIX module（台股波動恐慌指標）────────────────────
const VIX = {
  level: null,     // 數值
  label: null,     // 文字
  cls: null,       // CSS class
  score: 0,        // 對評分的影響 (-2 ~ +2)

  async fetch() {
    try {
      // 用 ^TWII 的日線計算20日歷史波動率估算恐慌指數
      const res = await DATA._fetchWithFallback('https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=3mo');
      const json = await res.json();
      const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
      if (closes.length < 21) return;

      // 計算 20 日年化波動率
      const returns = [];
      for (let i = 1; i < closes.length; i++) {
        if (closes[i] && closes[i-1]) returns.push(Math.log(closes[i] / closes[i-1]));
      }
      const last20 = returns.slice(-20);
      const mean = last20.reduce((a, b) => a + b, 0) / last20.length;
      const variance = last20.reduce((a, r) => a + (r - mean) ** 2, 0) / last20.length;
      const vol = Math.sqrt(variance * 252) * 100; // 年化波動率 %

      this.level = +vol.toFixed(1);
      this._classify(vol);
      this._updateDisplay();
    } catch(e) {
      console.warn('[VIX] fetch failed:', e.message);
    }
  },

  _classify(vol) {
    // 台股典型波動率範圍：10-15% 正常，>25% 恐慌，>35% 極度恐慌
    if (vol >= 35) {
      this.label = '極度恐慌';  this.cls = 'vix-extreme';  this.score = +2; // 超跌 → 逆向買入機會
    } else if (vol >= 25) {
      this.label = '市場恐慌';  this.cls = 'vix-fear';     this.score = +1;
    } else if (vol >= 18) {
      this.label = '偏向謹慎';  this.cls = 'vix-caution';  this.score = 0;
    } else if (vol >= 13) {
      this.label = '市場平靜';  this.cls = 'vix-neutral';  this.score = 0;
    } else {
      this.label = '過度樂觀';  this.cls = 'vix-greed';    this.score = -1; // 過熱 → 小心回調
    }
  },

  _updateDisplay() {
    const el = document.getElementById('vix-badge');
    if (!el || !this.level) return;
    el.innerHTML = `波動率 <strong>${this.level}%</strong> <span class="${this.cls}">${this.label}</span>`;

    // 更新說明
    const tip = document.getElementById('vix-tip');
    const tips = {
      'vix-extreme': '⚡ 極度恐慌，歷史上常是底部區域，逢回可逆向布局',
      'vix-fear':    '⚠️ 市場恐慌，短期波動大，建議分批進場',
      'vix-caution': '🔶 市場偏謹慎，控制倉位，不宜追高',
      'vix-neutral': '✅ 市場平穩，技術面訊號較可靠',
      'vix-greed':   '🔴 市場過熱，注意回調風險，逢高減碼',
    };
    if (tip) tip.textContent = tips[this.cls] || '';
  },
};


const GOALS = {
  defaults: { target: 3000000, years: 2.5, purpose: '買房頭期款', strategy: 'long', cashTWD: 0, cashUSD: 0 },

  get() { return JSON.parse(localStorage.getItem('twsa-goals') || 'null') || this.defaults; },
  save(data) {
    data._lastSyncedAt = new Date().toISOString();
    localStorage.setItem('twsa-goals', JSON.stringify(data));
    SYNC.markDirty();
  },

  // 記錄每日市值（資產曲線用）
  recordSnapshot() {
    const history = JSON.parse(localStorage.getItem('twsa-value-history') || '[]');
    const today = new Date().toISOString().split('T')[0];
    const totalVal = this._calcTotal();
    const last = history[history.length - 1];
    if (!last || last.date !== today) {
      history.push({ date: today, value: totalVal });
      if (history.length > 365) history.shift();
      localStorage.setItem('twsa-value-history', JSON.stringify(history));
    }
  },

  _calcTotal() {
    const g = this.get();
    // ★ 台股+美股合計，不管目前切到哪個市場
    const twVal = APP._twPortfolio.reduce((sum, s) => sum + (s.price ?? s.cost) * s.shares, 0);
    const usVal = APP._usPortfolio.reduce((sum, s) => sum + (s.price ?? s.cost) * s.shares, 0);
    const usValTWD = CURRENCY.toTWD(usVal);
    const cashTWD = parseFloat(g.cashTWD) || 0;
    const cashUSD = parseFloat(g.cashUSD) || 0;
    return twVal + usValTWD + cashTWD + CURRENCY.toTWD(cashUSD);
  },

  // ── 淨值走勢圖（用 recordSnapshot 累積的歷史資料）─────
  async renderNetWorthChart() {
    const history = JSON.parse(localStorage.getItem('twsa-value-history') || '[]');
    const section = document.getElementById('networth-section');
    if (!section) return;
    if (history.length < 2) { section.style.display = 'none'; return; }
    section.style.display = 'block';

    const canvas = document.getElementById('networthChart');
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const W = wrap.clientWidth || 260, H = 60;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const values = history.map(h => h.value);
    const minV = Math.min(...values), maxV = Math.max(...values);
    const range = (maxV - minV) || 1;
    const n = values.length;
    const xOf = i => (i / (n - 1)) * W;
    const yOf = v => H - 4 - ((v - minV) / range) * (H - 8);

    const isUp = values[values.length - 1] >= values[0];
    const color = isUp ? '#E24B4A' : '#1D9E75';

    // 填色區域
    ctx.beginPath();
    ctx.moveTo(xOf(0), H);
    values.forEach((v, i) => ctx.lineTo(xOf(i), yOf(v)));
    ctx.lineTo(xOf(n-1), H);
    ctx.closePath();
    ctx.fillStyle = isUp ? 'rgba(226,75,74,0.1)' : 'rgba(29,158,117,0.1)';
    ctx.fill();

    // 折線
    ctx.beginPath();
    values.forEach((v, i) => { const x = xOf(i), y = yOf(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.stroke();

    // 大盤比較
    this._renderBenchmarkCompare(history);
  },

  // ── 跟加權指數比較同期報酬率 ─────────────────────────
  async _renderBenchmarkCompare(history, targetId) {
    const el = document.getElementById(targetId || 'benchmark-compare');
    if (!el || history.length < 2) return;
    try {
      // ★ 修正 Infinity% bug：用第一筆「非零」的快照當基準，避免除以0
      const validHistory = history.filter(h => h.value > 0);
      if (validHistory.length < 2) { el.textContent = ''; return; }
      const startDate = validHistory[0].date;
      const startVal = validHistory[0].value;
      const endVal = validHistory[validHistory.length - 1].value;
      const portfolioPct = (endVal - startVal) / startVal * 100;

      // 抓加權指數同期資料
      const data = await DATA.fetchHistory('^TWII', '1d');
      const startCandle = data.find(d => new Date(d.t).toISOString().slice(0,10) >= startDate) || data[0];
      const endCandle = data[data.length - 1];
      const benchPct = (endCandle.c - startCandle.c) / startCandle.c * 100;

      const diff = portfolioPct - benchPct;
      const beatMarket = diff >= 0;
      el.innerHTML = `你 <strong style="color:${portfolioPct>=0?'#E24B4A':'#1D9E75'}">${portfolioPct>=0?'+':''}${portfolioPct.toFixed(1)}%</strong> vs 加權 <strong>${benchPct>=0?'+':''}${benchPct.toFixed(1)}%</strong> <span style="color:${beatMarket?'#E24B4A':'#1D9E75'}">(${beatMarket?'贏':'輸'}${Math.abs(diff).toFixed(1)}%)</span>`;
    } catch(e) { el.textContent = ''; }
  },

  // ── 產業集中度風險提示 ────────────────────────────────
  renderConcentrationWarning() {
    const el = document.getElementById('concentration-warning');
    if (!el) return;
    const portfolio = APP.portfolio;
    if (portfolio.length < 2) { el.style.display = 'none'; return; }

    const totalVal = portfolio.reduce((sum, s) => sum + (s.price ?? s.cost) * s.shares, 0);
    if (!totalVal) { el.style.display = 'none'; return; }

    const bySector = {};
    portfolio.forEach(s => {
      const sector = getStockSector(s.code);
      const val = (s.price ?? s.cost) * s.shares;
      bySector[sector] = (bySector[sector] || 0) + val;
    });

    const sorted = Object.entries(bySector).map(([sector, val]) => ({ sector, pct: val / totalVal * 100 })).sort((a,b) => b.pct - a.pct);
    const top = sorted[0];
    if (!top || top.pct < 35) { el.style.display = 'none'; return; }

    el.style.display = 'block';
    const level = top.pct >= 55 ? 'high' : 'mid';
    el.className = `concentration-warn ${level}`;
    el.textContent = `⚠️ ${top.sector}佔投資組合 ${top.pct.toFixed(0)}%，集中度偏高，建議留意產業系統性風險`;
  },

  updateDashboard() {
    const g = this.get();
    // ★ 台股+美股合計
    const twVal = APP._twPortfolio.reduce((sum, s) => sum + (s.price ?? s.cost) * s.shares, 0);
    const usVal = APP._usPortfolio.reduce((sum, s) => sum + (s.price ?? s.cost) * s.shares, 0);
    const usValTWD = CURRENCY.toTWD(usVal);
    const stockVal = twVal + usValTWD; // 總股票市值（換算台幣）
    const cashTWD = parseFloat(g.cashTWD) || 0;
    const cashUSD = parseFloat(g.cashUSD) || 0;
    const cashUSDtw = CURRENCY.toTWD(cashUSD);
    const totalVal = stockVal + cashTWD + cashUSDtw;
    const target = g.target;
    const diff = target - totalVal;
    const pct = Math.min(100, totalVal / target * 100);

    const startDate = g.startDate ? new Date(g.startDate) : new Date(Date.now() - 365*86400000);
    const monthsPassed = (Date.now() - startDate.getTime()) / (30.44*86400000);
    const initialVal = g.initialValue || Math.max(1, totalVal * 0.8);
    const annualReturn = monthsPassed > 0.5 ? ((totalVal / initialVal) ** (12/monthsPassed) - 1) * 100 : 0;
    const yearsNeeded = annualReturn > 0 ? Math.log(target/totalVal) / Math.log(1 + annualReturn/100) : null;
    const eta = yearsNeeded !== null
      ? new Date(Date.now() + yearsNeeded*365*86400000).toLocaleDateString('zh-TW', { year:'numeric', month:'short' })
      : '—';
    const requiredAnnual = totalVal > 0 ? (((target/totalVal) ** (1/g.years)) - 1) * 100 : 0;

    const fmtM = v => {
      if (v >= 1e6) return (v/1e4).toFixed(0)+'萬';
      if (v >= 1e4) return (v/1e4).toFixed(1)+'萬';
      return v.toFixed(0)+'元';
    };

    const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
    const setW = (id, w) => { const el = document.getElementById(id); if(el) el.style.width = w; };

    set('goal-stock-val', usValTWD > 0
      ? `${fmtM(twVal)}（台）+ ${fmtM(usValTWD)}（美）`
      : fmtM(twVal));
    set('goal-cash-twd-val', fmtM(cashTWD));
    set('goal-cash-usd-val', `$${cashUSD.toLocaleString()} (≈${fmtM(cashUSDtw)})`);
    set('goal-total-val', fmtM(totalVal));
    set('goal-target-val', fmtM(target));
    set('goal-diff', diff > 0 ? `距目標還差 ${fmtM(diff)}` : '🎉 已達目標！');
    set('goal-pct', pct.toFixed(1) + '%');
    setW('goal-progress-bar', pct.toFixed(1) + '%');
    set('goal-annual-return', annualReturn > 0 ? '+' + annualReturn.toFixed(1) + '%/年' : '—');
    set('goal-required-return', requiredAnnual.toFixed(1) + '%/年');
    set('goal-eta', eta);
    set('goal-years-left', g.years.toFixed(1) + ' 年');

    const barEl = document.getElementById('goal-progress-bar');
    if (barEl) barEl.style.background = pct >= 100 ? 'var(--green-l)' : pct >= 60 ? 'var(--amber)' : 'var(--red)';

    // 資產結構比例（台股/美股/現金）
    if (totalVal > 0) {
      const twPct   = (twVal/totalVal*100).toFixed(0);
      const usPct   = (usValTWD/totalVal*100).toFixed(0);
      const cashPct = ((cashTWD+cashUSDtw)/totalVal*100).toFixed(0);
      set('goal-stock-pct', twPct + '%');
      set('goal-cash-pct', cashPct + '%');
      const stockBar = document.getElementById('goal-asset-stock-bar');
      const cashBar  = document.getElementById('goal-asset-cash-bar');
      if (stockBar) stockBar.style.width = (+twPct + +usPct) + '%';
      if (cashBar)  cashBar.style.width  = cashPct + '%';
    }

    this._drawValueChart();
  },

  _drawValueChart() {
    const canvas = document.getElementById('value-chart');
    if (!canvas) return;
    const history = JSON.parse(localStorage.getItem('twsa-value-history') || '[]');
    if (history.length < 2) {
      const ctx = canvas.getContext('2d');
      const W = canvas.parentElement?.clientWidth || 400;
      canvas.width = W; canvas.height = 100;
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('資產曲線將在資料累積後顯示（需至少2天）', W/2, 55);
      return;
    }
    const W = canvas.parentElement?.clientWidth || 400;
    const H = 100;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const vals = history.map(h => h.value);
    const minV = Math.min(...vals) * 0.98;
    const maxV = Math.max(...vals) * 1.02;
    const n = history.length;
    const xOf = i => (i/(n-1)) * (W - 32) + 8;
    const yOf = v => H - 16 - ((v - minV)/(maxV - minV || 1)) * (H - 24);

    // Gradient fill
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(29,158,117,0.3)');
    grad.addColorStop(1, 'rgba(29,158,117,0)');
    ctx.beginPath();
    history.forEach((h, i) => { i===0 ? ctx.moveTo(xOf(i), yOf(h.value)) : ctx.lineTo(xOf(i), yOf(h.value)); });
    ctx.lineTo(xOf(n-1), H); ctx.lineTo(xOf(0), H); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    // Line
    ctx.beginPath(); ctx.strokeStyle = '#1D9E75'; ctx.lineWidth = 2;
    history.forEach((h, i) => { i===0 ? ctx.moveTo(xOf(i), yOf(h.value)) : ctx.lineTo(xOf(i), yOf(h.value)); });
    ctx.stroke();

    // Target line
    const g = this.get();
    if (g.target > minV && g.target < maxV) {
      const ty = yOf(g.target);
      ctx.strokeStyle = 'rgba(226,75,74,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(8, ty); ctx.lineTo(W-8, ty); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(226,75,74,0.8)'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText('目標', W-4, ty-3);
    }

    // Labels
    const isDark = !document.body.classList.contains('light-mode');
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)';
    ctx.font = '10px monospace'; ctx.textAlign = 'center';
    if (history.length > 0) {
      ctx.fillText(history[0].date.slice(5), xOf(0), H - 2);
      ctx.fillText(history[history.length-1].date.slice(5), xOf(n-1), H - 2);
    }
  },
};

// ── TRADES module ─────────────────────────────────────
const TRADES = {
  get() { return JSON.parse(localStorage.getItem('twsa-trades') || '[]'); },
  save(trades) {
    localStorage.setItem('twsa-trades', JSON.stringify(trades));
    SYNC.markDirty();
  },
  add(trade) {
    const trades = this.get();
    trades.unshift({ ...trade, id: Date.now() });
    this.save(trades);
  },
  getById(id) { return this.get().find(t => t.id === id); },
  update(id, fields) {
    const trades = this.get();
    const idx = trades.findIndex(t => t.id === id);
    if (idx === -1) return false;
    trades[idx] = { ...trades[idx], ...fields };
    this.save(trades);
    return true;
  },
  delete(id) {
    const trades = this.get().filter(t => t.id !== id);
    this.save(trades);
  },

  // 根據所有交易紀錄重新計算持股均價和數量
  recalcPortfolio() {
    const trades = this.get();
    const isUS = APP.activeMarket === 'US';
    const storageKey = isUS ? 'ussa-portfolio' : 'twsa-portfolio';
    const portfolio = JSON.parse(localStorage.getItem(storageKey) || '[]');

    // 過濾當前市場的交易
    const mktTrades = trades.filter(t => (t.market || 'TW') === (isUS ? 'US' : 'TW'));

    // 重新建立每支股票的持倉
    const holdings = {}; // code -> {shares, totalCost, firstDate}
    // 按時間正序處理
    [...mktTrades].reverse().forEach(t => {
      if (!holdings[t.code]) holdings[t.code] = { shares: 0, totalCost: 0, firstDate: t.date };
      if (t.action === 'buy') {
        holdings[t.code].totalCost += t.price * t.shares;
        holdings[t.code].shares    += t.shares;
        if (!holdings[t.code].firstDate || t.date < holdings[t.code].firstDate) holdings[t.code].firstDate = t.date;
      } else if (t.action === 'sell') {
        holdings[t.code].shares -= t.shares;
        // 賣出時均價不變，按比例扣除成本
        if (holdings[t.code].shares > 0) {
          const avgCost = holdings[t.code].totalCost / (holdings[t.code].shares + t.shares);
          holdings[t.code].totalCost -= avgCost * t.shares;
        } else {
          holdings[t.code].totalCost = 0;
        }
      }
    });

    // 更新 portfolio
    const newPortfolio = portfolio.map(s => {
      const h = holdings[s.code];
      if (!h || h.shares <= 0) return null; // 已清倉
      return {
        ...s,
        shares: Math.max(0, Math.round(h.shares * 100) / 100),
        cost:   h.shares > 0 ? +((h.totalCost / h.shares)).toFixed(4) : s.cost,
        date:   h.firstDate || s.date,
      };
    }).filter(Boolean);

    // 保存
    const portfolio_key = isUS ? '_usPortfolio' : '_twPortfolio';
    APP[portfolio_key] = newPortfolio;
    APP.save();
  },

  // ── 交易統計分析：勝率、平均持有天數、平均賺賠比 ──────
  // 用「賣出時的損益」逐筆配對計算（賣出價 vs 當時均價），只統計已實現損益
  renderStats() {
    const el = document.getElementById('trade-stats');
    if (!el) return;
    const trades = this.get();
    const sells = trades.filter(t => t.action === 'sell' && t.realizedPnl != null);
    if (sells.length < 1) { el.innerHTML = ''; return; }

    const wins = sells.filter(t => t.realizedPnl > 0);
    const losses = sells.filter(t => t.realizedPnl <= 0);
    const winRate = wins.length / sells.length * 100;
    const avgWin = wins.length ? wins.reduce((s,t) => s + t.realizedPnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s,t) => s + t.realizedPnl, 0) / losses.length) : 0;
    const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
    const avgHoldDays = sells.filter(t => t.holdDays != null).length
      ? sells.reduce((s,t) => s + (t.holdDays || 0), 0) / sells.filter(t => t.holdDays != null).length
      : null;

    const fmtRatio = r => r === Infinity ? '∞' : r.toFixed(2);
    el.innerHTML = `
      <div class="trade-stat-card">
        <div class="trade-stat-label">勝率</div>
        <div class="trade-stat-value" style="color:${winRate>=50?'#E24B4A':'#1D9E75'}">${winRate.toFixed(0)}%</div>
      </div>
      <div class="trade-stat-card">
        <div class="trade-stat-label">已實現交易數</div>
        <div class="trade-stat-value">${sells.length}</div>
      </div>
      <div class="trade-stat-card">
        <div class="trade-stat-label">平均賺賠比</div>
        <div class="trade-stat-value">${fmtRatio(winLossRatio)}</div>
      </div>
      <div class="trade-stat-card">
        <div class="trade-stat-label">平均持有天數</div>
        <div class="trade-stat-value">${avgHoldDays != null ? Math.round(avgHoldDays) + '天' : '—'}</div>
      </div>`;
  },

  // ── 回填舊交易的已實現損益（功能上線前的賣出紀錄沒有 realizedPnl，這裡補算）──
  // 按時間正序重播買賣，算出每次賣出當下的均價，藉此推算損益與持有天數
  backfillRealizedPnl() {
    const trades = this.get();
    const needsBackfill = trades.some(t => t.action === 'sell' && t.realizedPnl == null);
    if (!needsBackfill) return;

    const bySymbol = {}; // code -> { shares, totalCost, firstDate }
    const sorted = [...trades].sort((a, b) => {
      const d = (a.date || '').localeCompare(b.date || '');
      return d !== 0 ? d : (a.id || 0) - (b.id || 0);
    });

    sorted.forEach(t => {
      const key = `${t.market || 'TW'}_${t.code}`;
      if (!bySymbol[key]) bySymbol[key] = { shares: 0, totalCost: 0, firstDate: t.date };
      const h = bySymbol[key];
      if (t.action === 'buy') {
        h.totalCost += t.price * t.shares;
        h.shares += t.shares;
        if (!h.firstDate || t.date < h.firstDate) h.firstDate = t.date;
      } else if (t.action === 'sell') {
        const avgCost = h.shares > 0 ? h.totalCost / h.shares : t.price;
        if (t.realizedPnl == null) {
          t.realizedPnl = +((t.price - avgCost) * t.shares).toFixed(2);
          t.holdDays = h.firstDate ? Math.floor((new Date(t.date) - new Date(h.firstDate)) / 86400000) : null;
        }
        h.totalCost -= avgCost * t.shares;
        h.shares -= t.shares;
      }
    });

    this.save(trades);
  },

  render() {
    this.backfillRealizedPnl();
    this.renderStats();
    const list = document.getElementById('trade-list');
    if (!list) return;
    const trades = this.get();
    if (!trades.length) { list.innerHTML = '<div class="empty-state">暫無交易紀錄</div>'; return; }
    const isUS = APP.activeMarket === 'US';
    list.innerHTML = trades.slice(0, 50).map(t => {
      const isBuy = t.action === 'buy';
      const total = t.shares * t.price;
      const fee = t.fee || 0;
      const tIsUS = (t.market || 'TW') === 'US';
      const totalDisplay = tIsUS
        ? `US$${total.toFixed(0)}`
        : (total >= 10000 ? `${(total/10000).toFixed(2)}萬` : `${total.toFixed(0)}元`);
      const sharesDisplay = sharesDisp(t.shares, t.market || 'TW');
      const priceDisplay = tIsUS ? `US$${t.price}` : `$${t.price}`;
      return `<div class="trade-item">
        <div class="ti-left">
          <span class="ti-action ${isBuy?'buy':'sell'}">${isBuy?'買進':'賣出'}</span>
          <span class="ti-code">${t.code}</span>
          <span class="ti-name">${t.name}</span>
        </div>
        <div class="ti-mid">
          <span>${sharesDisplay} @ ${priceDisplay}</span>
          <span class="ti-date">${t.date || '—'}</span>
        </div>
        <div class="ti-right">
          <span class="${isBuy?'dn-color':'up-color'}">${isBuy?'-':'+'}${totalDisplay}</span>
          ${fee ? `<span class="ti-fee">稅費 $${fee}</span>` : ''}
          <button class="ti-edit-btn" onclick="openEditTrade(${t.id})" title="編輯">✏️</button>
        </div>
        ${t.note ? `<div class="ti-note">${t.note}</div>` : ''}
      </div>`;
    }).join('');
  },
};

// ── SIGNAL module（統一買賣訊號，優先用技術分析）────
const SIGNAL = {
  // 7 級訊號
  LEVELS: [
    { tier:0, label:'緊急出場', short:'🔴 出清',  cls:'signal-emergency'   },
    { tier:1, label:'強力賣出', short:'🔴 大賣',  cls:'signal-strong-sell' },
    { tier:2, label:'建議減碼', short:'🟠 小賣',  cls:'signal-sell'        },
    { tier:3, label:'持有觀望', short:'⚪ 觀望',  cls:'signal-hold'        },
    { tier:4, label:'可考慮加碼',short:'🟢 小買', cls:'signal-buy'         },
    { tier:5, label:'積極買進', short:'🟢 大買',  cls:'signal-strong-buy'  },
    { tier:6, label:'強力買進', short:'🟢 全買',  cls:'signal-max-buy'     },
  ],

  // 完整評分（有技術分析時用）
  fromScore(score, gainPct, supportBreak, mode = 'long') {
    const vixAdj = VIX.score || 0;
    const adjusted = score + vixAdj * 0.5;
    const isLong = mode === 'long';

    if (isLong) {
      // 長線：停損門檻 -25%（-15% 只是觀察）
      if (supportBreak && gainPct <= -25) return this.LEVELS[0]; // 跌破支撐且虧損>25%
      if (gainPct <= -25)  return this.LEVELS[1];                // 虧損超過-25%才強賣
      if (gainPct <= -15)  return this.LEVELS[2];                // -15% 建議減碼評估
      // 技術面訊號（±10 範圍）
      if (adjusted < 0)    return this.LEVELS[3];
      if (adjusted < 4)    return this.LEVELS[3];  // 長線偏中性也持有
      if (adjusted < 6)    return this.LEVELS[4];
      if (adjusted < 8)    return this.LEVELS[5];
      return this.LEVELS[6];
    }

    // 短線模式（±10 範圍）
    // ★ 獲利了結改為建議性（不強制 sell，改用 buy/hold 訊號）
    if (supportBreak || gainPct <= -8) return this.LEVELS[0];
    if (adjusted <= -5)  return this.LEVELS[1];
    if (adjusted <= -2)  return this.LEVELS[2];
    if (adjusted < 2)    return this.LEVELS[3];
    // 獲利但技術面仍偏多 → 繼續持有，不強制賣
    if (gainPct >= 35)   return this.LEVELS[3];  // 達目標但顯示觀望（提示了結但不強制）
    if (adjusted < 5)    return this.LEVELS[4];
    if (adjusted < 7)    return this.LEVELS[5];
    return this.LEVELS[6];
  },

  // 快速估算（沒有技術分析時，純用損益%）
  quickEstimate(stock) {
    if (!stock.price) return { ...this.LEVELS[3], label:'待更新', short:'⚫ —' };

    const mode = APP.getStockMode(stock.code);
    const isLong = mode === 'long';

    // ★ 優先用此股票自己的快取分析結果
    const cached = ANALYSIS._cache[stock.code];
    const cachedInd = cached?.ind || null;
    if (cachedInd) {
      const score = ANALYSIS._calcScore(cachedInd);
      const gainPct = (stock.price - stock.cost) / stock.cost * 100;
      const supportBreak = stock.price < (cachedInd.support || 0) * 0.98;
      return this.fromScore(score, gainPct, supportBreak, mode);
    }

    // 當前選中股票但尚未分析完
    if (APP.activeSymbol === stock.code) {
      return { ...this.LEVELS[3], label:'分析中', short:'⏳ —' };
    }

    // 無快取 → 純損益%估算
    const gainPct = stock.cost ? (stock.price - stock.cost) / stock.cost * 100 : 0;
    if (isLong) {
      // 長線：停損門檻更寬
      if (gainPct <= -15) return this.LEVELS[0];
      if (gainPct <= -10) return this.LEVELS[2];
      return { ...this.LEVELS[3], label:'待分析', short:'⚪ —' };
    }
    // 短線
    if (gainPct <= -8)  return this.LEVELS[0];
    if (gainPct <= -5)  return this.LEVELS[2];
    if (gainPct >= 30)  return this.LEVELS[1];
    if (gainPct >= 20)  return this.LEVELS[2];
    return { ...this.LEVELS[3], label:'待分析', short:'⚪ —' };
  },
};

// ── DASHBOARD module（總覽：所有持股K線+成交量+訊號卡片）──
// 三個主畫面（總覽/個股詳細/績效）互斥切換的共用函式
function showMainView(view) {
  const dv = document.getElementById('dashboard-content');
  const detail = document.getElementById('detail-content');
  const perf = document.getElementById('performance-content');
  const cal = document.getElementById('calendar-page-content');
  const bt = document.getElementById('backtest-content');
  const sidebar = document.querySelector('.sidebar');
  const layout = document.querySelector('.app-layout');
  if (dv) dv.style.display = view === 'dashboard' ? '' : 'none';
  if (detail) detail.style.display = view === 'detail' ? '' : 'none';
  if (perf) perf.style.display = view === 'performance' ? '' : 'none';
  if (cal) cal.style.display = view === 'calendar' ? '' : 'none';
  if (bt) bt.style.display = view === 'backtest' ? '' : 'none';
  // 績效、日曆、回測頁面內容較豐富，隱藏側邊欄讓版面更寬敞
  const hideSidebar = view === 'performance' || view === 'calendar' || view === 'backtest';
  if (sidebar) sidebar.style.display = hideSidebar ? 'none' : '';
  if (layout) layout.classList.toggle('sidebar-hidden', hideSidebar);
  const dashBtn = document.getElementById('dashboard-toggle-btn');
  if (dashBtn) dashBtn.textContent = view === 'dashboard' ? '📈 個股' : '🏠 總覽';
}

// ── Performance module（績效分析獨立頁面）──────────────
// ── TradeCalendar module（交易與除權息日曆，月檢視）──────
const TradeCalendar = {
  _year: new Date().getFullYear(),
  _month: new Date().getMonth(), // 0-indexed
  _divCache: null, // 該月除權息事件快取

  toggle() {
    const cal = document.getElementById('calendar-page-content');
    const isShowing = cal.style.display !== 'none';
    if (isShowing) {
      showMainView('detail');
      if (!APP.activeSymbol && APP.portfolio.length) APP.selectStock(APP.portfolio[0].code, 0, 'portfolio');
      else if (CHART.currentData.length) setTimeout(() => CHART.draw(), 50);
    } else {
      showMainView('calendar');
      this.render();
    }
  },

  prevMonth() { this._month--; if (this._month < 0) { this._month = 11; this._year--; } this.render(); },
  nextMonth() { this._month++; if (this._month > 11) { this._month = 0; this._year++; } this.render(); },
  goToday() { this._year = new Date().getFullYear(); this._month = new Date().getMonth(); this.render(); },

  async render() {
    const title = document.getElementById('cal-page-title');
    if (title) title.textContent = `${this._year}年${this._month + 1}月`;

    // 抓該月的除權息事件（僅台股，用 TWSE 公開資料裡符合該月份的部分；美股用估算）
    await this._loadDivEventsForMonth();

    const grid = document.getElementById('cal-grid');
    if (!grid) return;

    const firstDay = new Date(this._year, this._month, 1);
    const startWeekday = firstDay.getDay(); // 0=Sun
    const daysInMonth = new Date(this._year, this._month + 1, 0).getDate();
    const daysInPrevMonth = new Date(this._year, this._month, 0).getDate();
    const todayStr = new Date().toISOString().slice(0, 10);

    const trades = TRADES.get();
    const cells = [];
    // 上個月補齊
    for (let i = startWeekday - 1; i >= 0; i--) {
      const d = daysInPrevMonth - i;
      const m = this._month === 0 ? 12 : this._month;
      const y = this._month === 0 ? this._year - 1 : this._year;
      cells.push({ day: d, dateStr: `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`, otherMonth: true });
    }
    // 本月
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${this._year}-${String(this._month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      cells.push({ day: d, dateStr, otherMonth: false });
    }
    // 下個月補齊到湊滿整週
    let nextDay = 1;
    while (cells.length % 7 !== 0) {
      const m = this._month === 11 ? 1 : this._month + 2;
      const y = this._month === 11 ? this._year + 1 : this._year;
      cells.push({ day: nextDay, dateStr: `${y}-${String(m).padStart(2,'0')}-${String(nextDay).padStart(2,'0')}`, otherMonth: true });
      nextDay++;
    }

    grid.innerHTML = cells.map(c => {
      const dayTrades = trades.filter(t => t.date === c.dateStr);
      const dayDivs = (this._divCache || []).filter(e => e.date === c.dateStr);
      const events = [
        ...dayTrades.map(t => `<div class="cal-event ${t.action}">${t.action==='buy'?'買':'賣'} ${t.code} ${t.shares}股</div>`),
        ...dayDivs.map(e => `<div class="cal-event div">💰 ${e.code}${e.estimated?'(估)':''}</div>`),
      ];
      const isToday = c.dateStr === todayStr;
      return `
        <div class="cal-day-cell ${c.otherMonth?'other-month':''} ${isToday?'today':''}" onclick="TradeCalendar.onDayClick('${c.dateStr}')">
          <div class="cal-day-num">${c.day}</div>
          <div class="cal-day-events">${events.join('')}</div>
        </div>`;
    }).join('');
  },

  async _loadDivEventsForMonth() {
    // 用既有的 ExDividend 快取（近期資料），篩選出屬於目前檢視月份的部分
    try {
      const twEvents = await ExDividend.getTWUpcoming(APP._twPortfolio.map(s=>s.code));
      const usEvents = (await Promise.all(APP._usPortfolio.map(s => ExDividend.getUSEstimate(s.code)))).filter(Boolean);
      const monthPrefix = `${this._year}-${String(this._month+1).padStart(2,'0')}`;
      this._divCache = [...twEvents, ...usEvents].filter(e => e.date.startsWith(monthPrefix));
    } catch(e) { this._divCache = []; }
  },

  onDayClick(dateStr) {
    openAddTradeModal();
    setTimeout(() => { document.getElementById('at-date').value = dateStr; }, 0);
  },
};

// ── AICycle module（AI循環階段：基建 vs 應用端相對強度輪動指標）──
// ⚠️ 這是用股價動能推論的代理指標，不是真正的產業基本面分析，僅供留意訊號參考
const AICycle = {
  INFRA: ['2330', 'NVDA', 'ASML', 'AMD', '^SOX'],  // 賣鏟子：晶圓代工/設備/GPU/半導體指數
  APP:   ['GOOGL', 'AAPL', 'MSFT', 'META'],        // 用鏟子：已變現的應用端龍頭

  _cacheKey() { return 'twsa-aicycle-cache'; },

  async compute() {
    const cacheRaw = localStorage.getItem(this._cacheKey());
    if (cacheRaw) {
      try {
        const cache = JSON.parse(cacheRaw);
        if (Date.now() - cache.ts < 6 * 3600000) return cache.result; // 6小時快取
      } catch(e) {}
    }

    const allSymbols = [...this.INFRA, ...this.APP];
    const histories = {};
    for (const sym of allSymbols) {
      try {
        histories[sym] = await DATA.fetchHistory(sym, '1d');
        await new Promise(r => setTimeout(r, 200)); // 節流
      } catch(e) { histories[sym] = null; }
    }

    const calcReturn = (data, days) => {
      if (!data || data.length < days + 1) return null;
      const now = data[data.length - 1].c;
      const past = data[data.length - 1 - days].c;
      return (now - past) / past * 100;
    };

    const basketReturn = (symbols, days) => {
      const rets = symbols.map(s => calcReturn(histories[s], days)).filter(r => r != null);
      return rets.length ? rets.reduce((a,b)=>a+b,0) / rets.length : null;
    };

    const infraRet20 = basketReturn(this.INFRA, 20);
    const infraRet60 = basketReturn(this.INFRA, 60);
    const appRet20 = basketReturn(this.APP, 20);
    const appRet60 = basketReturn(this.APP, 60);

    // 相對強度價差：正值=基建領先，負值=應用領先
    const spread20 = (infraRet20 != null && appRet20 != null) ? infraRet20 - appRet20 : null;
    const spread60 = (infraRet60 != null && appRet60 != null) ? infraRet60 - appRet60 : null;

    const phase = this._classifyPhase(spread20, spread60);

    // 兩籃子近90天累計報酬走勢（重基期=100），供畫圖
    const rebase = (symbols, n) => {
      const series = symbols.map(sym => {
        const data = histories[sym];
        if (!data || data.length < n) return null;
        const slice = data.slice(-n);
        const base = slice[0].c;
        return slice.map(d => d.c / base * 100);
      }).filter(Boolean);
      if (!series.length) return [];
      const len = Math.min(...series.map(s => s.length));
      const avg = [];
      for (let i = 0; i < len; i++) {
        avg.push(series.reduce((sum, s) => sum + s[i], 0) / series.length);
      }
      return avg;
    };
    const N = 90;
    const infraSeries = rebase(this.INFRA, N);
    const appSeries = rebase(this.APP, N);

    const result = { infraRet20, infraRet60, appRet20, appRet60, spread20, spread60, phase, infraSeries, appSeries, computedAt: new Date().toISOString() };
    localStorage.setItem(this._cacheKey(), JSON.stringify({ ts: Date.now(), result }));
    return result;
  },

  // 分級邏輯（見設計說明，用相對強度價差的近期vs中期趨勢判斷階段）
  _classifyPhase(spread20, spread60) {
    if (spread20 == null || spread60 == null) {
      return { level: 0, label: '資料不足', color: '#8b949e', desc: '尚無足夠歷史資料計算' };
    }
    const expectedPace = spread60 * (20/60); // 60天價差若均勻分布，20天「應該」佔的比例
    if (spread20 <= -5) {
      if (spread60 <= 0) {
        return { level: 4, label: '應用端主導', color: '#37adf0', desc: '應用端近期與中期都領先，資金可能已轉移到變現端' };
      }
      return { level: 3, label: '輪動訊號', color: '#f97316', desc: '應用端近期明顯超前，中期仍是基建領先，可能是轉折初期' };
    }
    if (spread20 > 5 && spread20 >= expectedPace * 0.8) {
      return { level: 1, label: '基建早期擴張', color: '#E24B4A', desc: '基建端持續領先且動能未減，資金仍在湧入硬體端' };
    }
    if (spread60 > 0 && spread20 < expectedPace * 0.5) {
      return { level: 2, label: '基建晚期／過熱', color: '#eab308', desc: '中期仍是基建領先，但近期動能明顯鈍化，留意轉折風險' };
    }
    return { level: 0, label: '盤整／不明確', color: '#8b949e', desc: '兩籃子相對強度不明顯，暫無清楚訊號' };
  },
};

const Performance = {
  _period: 'all', // 1m/3m/6m/1y/all

  toggle() {
    const perf = document.getElementById('performance-content');
    const isShowing = perf.style.display !== 'none';
    if (isShowing) {
      showMainView('detail');
      if (!APP.activeSymbol && APP.portfolio.length) APP.selectStock(APP.portfolio[0].code, 0, 'portfolio');
      else if (CHART.currentData.length) setTimeout(() => CHART.draw(), 50);
    } else {
      showMainView('performance');
      this.render();
    }
  },

  _filterHistory(history) {
    if (this._period === 'all') return history;
    const days = { '1m':30, '3m':90, '6m':180, '1y':365 }[this._period];
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0,10);
    return history.filter(h => h.date >= cutoff);
  },

  setPeriod(p) {
    this._period = p;
    document.querySelectorAll('.perf-period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === p));
    this._drawNetWorthChart();
  },

  async render() {
    const body = document.getElementById('perf-body');
    if (!body) return;
    body.innerHTML = `
      <div class="perf-card" style="margin-bottom:14px">
        <div class="perf-card-title">💰 淨值走勢</div>
        <div class="perf-period-tabs">
          ${['1m','3m','6m','1y','all'].map(p => `<button class="perf-period-btn ${p===this._period?'active':''}" data-period="${p}" onclick="Performance.setPeriod('${p}')">${ {'1m':'1個月','3m':'3個月','6m':'6個月','1y':'1年','all':'全部'}[p] }</button>`).join('')}
        </div>
        <div class="perf-big-canvas-wrap"><canvas id="perf-networth-canvas"></canvas></div>
        <div id="perf-benchmark" style="margin-top:10px;font-size:15px;font-weight:600;color:var(--text-1)"></div>
      </div>
      <div class="perf-grid">
        <div class="perf-card">
          <div class="perf-card-title">📊 交易統計</div>
          <div id="perf-trade-stats"></div>
        </div>
        <div class="perf-card">
          <div class="perf-card-title">🏭 產業集中度</div>
          <div id="perf-sector-breakdown" class="perf-sector-bar-wrap"></div>
        </div>
        <div class="perf-card">
          <div class="perf-card-title">🏆 最佳/最差交易</div>
          <div id="perf-best-worst"></div>
        </div>
        <div class="perf-card">
          <div class="perf-card-title">📅 本月/今年損益</div>
          <div id="perf-period-pnl"></div>
        </div>
      </div>
      <div class="perf-card" style="margin-bottom:14px">
        <div class="perf-card-title">📊 月度已實現損益</div>
        <div class="perf-big-canvas-wrap" style="height:160px"><canvas id="perf-monthly-canvas"></canvas></div>
      </div>
      <div class="perf-card">
        <div class="perf-card-title">🏅 個股累計損益排行</div>
        <div id="perf-stock-ranking"></div>
      </div>
      <div class="perf-card" style="margin-top:14px">
        <div class="perf-card-title">🤖 AI循環階段（基建 vs 應用端輪動）</div>
        <div class="form-note" style="margin-bottom:10px">⚠️ 用股價相對強度動能推論的代理指標，非產業基本面分析，僅供留意訊號參考，不構成投資建議。</div>
        <div id="ai-cycle-body"><div class="empty-state">計算中...</div></div>
      </div>
      <div class="perf-card" style="margin-top:14px">
        <div class="perf-card-title">📊 今日台股類股漲跌排行</div>
        <div class="form-note" style="margin-bottom:10px">TWSE官方36種產業分類，只有今日快照，無歷史走勢。</div>
        <div id="sector-ranking-body"><div class="empty-state">載入中...</div></div>
      </div>
      <div class="perf-card" style="margin-top:14px">
        <div class="perf-card-title">🏦 持股三大法人買賣超（今日）</div>
        <div class="form-note" style="margin-bottom:10px">外資、投信、自營商買賣超股數，正值＝買超、負值＝賣超。</div>
        <div id="inst-flow-body"><div class="empty-state">載入中...</div></div>
      </div>`;

    this._drawNetWorthChart();
    this._renderTradeStats();
    this._renderSectorBreakdown();
    this._renderBestWorst();
    this._renderPeriodPnl();
    this._drawMonthlyPnlChart();
    this._renderStockRanking();
    this._renderAICycle();
    this._renderSectorRanking();
    this._renderInstFlow();
  },

  async _renderSectorRanking() {
    const el = document.getElementById('sector-ranking-body');
    if (!el) return;
    const list = await DATA.fetchSectorRanking();
    if (!list.length) { el.innerHTML = '<div class="empty-state">暫無資料</div>'; return; }
    const maxAbs = Math.max(...list.map(s => Math.abs(s.chgPct)), 1);
    el.innerHTML = list.map(s => {
      const color = s.chgPct >= 0 ? '#E24B4A' : '#1D9E75';
      const pct = Math.abs(s.chgPct) / maxAbs * 100;
      return `
        <div class="perf-sector-row" style="margin-bottom:5px">
          <span class="perf-sector-name" style="width:100px">${s.name}</span>
          <div class="perf-sector-track"><div class="perf-sector-fill" style="width:${pct}%;background:${color}"></div></div>
          <span class="perf-sector-pct" style="width:60px;color:${color}">${s.chgPct>=0?'+':''}${s.chgPct.toFixed(2)}%</span>
        </div>`;
    }).join('');
  },

  async _renderInstFlow() {
    const el = document.getElementById('inst-flow-body');
    if (!el) return;
    const portfolio = APP._twPortfolio;
    if (!portfolio.length) { el.innerHTML = '<div class="empty-state">尚無台股持股</div>'; return; }
    const inst = await DATA.fetchInstitutional();
    if (!inst) { el.innerHTML = '<div class="empty-state">暫無資料</div>'; return; }
    const rows = portfolio.map(s => {
      const d = inst.byCode[s.code];
      if (!d) return null;
      return { code: s.code, name: s.name, ...d };
    }).filter(Boolean).sort((a,b) => b.total - a.total);
    if (!rows.length) { el.innerHTML = '<div class="empty-state">暫無資料（可能還沒收盤公布）</div>'; return; }
    const fmtShares = n => {
      const abs = Math.abs(n);
      const str = abs >= 10000 ? (abs/1000).toFixed(0)+'張' : abs.toLocaleString()+'股';
      return (n>=0?'+':'-') + str;
    };
    el.innerHTML = `
      <div style="font-size:10px;color:var(--text-3);margin-bottom:8px">資料日期：${inst.date}</div>
      ${rows.map(r => `
        <div class="perf-trade-item">
          <span>${r.code} ${r.name}</span>
          <span style="display:flex;gap:10px;font-size:11px">
            <span style="color:var(--text-2)">外資 <b style="color:${r.foreign>=0?'#E24B4A':'#1D9E75'}">${fmtShares(r.foreign)}</b></span>
            <span style="color:var(--text-2)">投信 <b style="color:${r.trust>=0?'#E24B4A':'#1D9E75'}">${fmtShares(r.trust)}</b></span>
            <span style="color:${r.total>=0?'#E24B4A':'#1D9E75'};font-weight:700">合計 ${fmtShares(r.total)}</span>
          </span>
        </div>`).join('')}
    `;
  },

  async _renderAICycle() {
    const body = document.getElementById('ai-cycle-body');
    if (!body) return;
    try {
      const r = await AICycle.compute();
      const p = r.phase;
      const fmtPct = v => v == null ? '—' : `${v>=0?'+':''}${v.toFixed(1)}%`;
      body.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <span style="font-size:22px;font-weight:700;color:${p.color}">${p.label}</span>
        </div>
        <div style="font-size:13px;color:var(--text-2);margin-bottom:14px;line-height:1.6">${p.desc}</div>
        <div class="perf-grid" style="margin-bottom:14px">
          <div>
            <div class="perf-stat-row"><span class="perf-stat-name">🔧 基建籃子 20日</span><span class="perf-stat-num" style="color:${(r.infraRet20??0)>=0?'#E24B4A':'#1D9E75'}">${fmtPct(r.infraRet20)}</span></div>
            <div class="perf-stat-row"><span class="perf-stat-name">🔧 基建籃子 60日</span><span class="perf-stat-num" style="color:${(r.infraRet60??0)>=0?'#E24B4A':'#1D9E75'}">${fmtPct(r.infraRet60)}</span></div>
          </div>
          <div>
            <div class="perf-stat-row"><span class="perf-stat-name">💰 應用籃子 20日</span><span class="perf-stat-num" style="color:${(r.appRet20??0)>=0?'#E24B4A':'#1D9E75'}">${fmtPct(r.appRet20)}</span></div>
            <div class="perf-stat-row"><span class="perf-stat-name">💰 應用籃子 60日</span><span class="perf-stat-num" style="color:${(r.appRet60??0)>=0?'#E24B4A':'#1D9E75'}">${fmtPct(r.appRet60)}</span></div>
          </div>
        </div>
        <div style="display:flex;gap:14px;margin-bottom:8px;font-size:12px">
          <span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:50%;background:#f97316;display:inline-block"></span>基建籃子（台積電/NVDA/ASML/AMD/費半）</span>
          <span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:50%;background:#37adf0;display:inline-block"></span>應用籃子（GOOGL/AAPL/MSFT/META）</span>
        </div>
        <div class="perf-big-canvas-wrap" style="height:180px"><canvas id="ai-cycle-canvas"></canvas></div>`;
      this._drawAICycleChart(r.infraSeries, r.appSeries);
    } catch(e) {
      body.innerHTML = `<div class="empty-state">計算失敗，稍後重試</div>`;
    }
  },

  _drawAICycleChart(infraSeries, appSeries) {
    const canvas = document.getElementById('ai-cycle-canvas');
    if (!canvas || !infraSeries.length || !appSeries.length) return;
    const wrap = canvas.parentElement;
    const W = wrap.clientWidth || 600, H = 180;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const isDark = !document.body.classList.contains('light-mode');
    const axisColor = isDark ? '#8b949e' : '#57606a';
    const gridColor = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';

    const PAD = { l:44, r:12, t:10, b:10 };
    const chartW = W - PAD.l - PAD.r, chartH = H - PAD.t - PAD.b;
    const n = Math.min(infraSeries.length, appSeries.length);
    const all = [...infraSeries.slice(-n), ...appSeries.slice(-n)];
    const minV = Math.min(...all), maxV = Math.max(...all);
    const range = (maxV - minV) || 1;
    const xOf = i => PAD.l + (i / (n-1)) * chartW;
    const yOf = v => PAD.t + chartH - ((v - minV) / range) * chartH;

    ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
    [0, 0.5, 1].forEach(f => {
      const y = PAD.t + f * chartH;
      ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
      ctx.fillStyle = axisColor;
      ctx.fillText((maxV - f * range).toFixed(0), PAD.l - 6, y + 4);
    });

    const drawLine = (series, color) => {
      ctx.beginPath();
      series.slice(-n).forEach((v, i) => { const x=xOf(i), y=yOf(v); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.stroke();
    };
    drawLine(infraSeries, '#f97316');
    drawLine(appSeries, '#37adf0');
  },

  // ── 月度已實現損益長條圖（近12個月）─────────────────
  _drawMonthlyPnlChart() {
    const canvas = document.getElementById('perf-monthly-canvas');
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const W = wrap.clientWidth || 600, H = 160;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const isDark = !document.body.classList.contains('light-mode');
    const axisColor = isDark ? '#8b949e' : '#57606a';

    const sells = TRADES.get().filter(t => t.action === 'sell' && t.realizedPnl != null);
    if (!sells.length) {
      ctx.fillStyle = axisColor; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('尚無已實現交易資料', W/2, H/2);
      return;
    }

    // ★ 只列出「實際有交易」的月份，沒交易的月份不顯示
    const byMonth = {};
    sells.forEach(t => {
      const m = t.date?.slice(0, 7);
      if (!m) return;
      byMonth[m] = (byMonth[m] || 0) + t.realizedPnl;
    });
    const months = Object.keys(byMonth).sort();
    const values = months.map(m => byMonth[m]);

    const PAD = { l:50, r:10, t:10, b:24 };
    const chartW = W - PAD.l - PAD.r, chartH = H - PAD.t - PAD.b;
    const maxAbs = Math.max(...values.map(Math.abs), 1);
    const zeroY = PAD.t + chartH / 2;
    const barW = chartW / months.length * 0.6;
    const gap = chartW / months.length;

    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(PAD.l, zeroY); ctx.lineTo(W - PAD.r, zeroY); ctx.stroke();

    months.forEach((m, i) => {
      const v = values[i];
      const x = PAD.l + i * gap + (gap - barW) / 2;
      const bh = Math.abs(v) / maxAbs * (chartH / 2 - 4);
      const y = v >= 0 ? zeroY - bh : zeroY;
      ctx.fillStyle = v >= 0 ? '#E24B4A' : (v < 0 ? '#1D9E75' : 'rgba(255,255,255,0.1)');
      ctx.fillRect(x, y, barW, Math.max(1, bh));

      // 資料跨年時顯示 YY/MM，否則只顯示 MM
      const spansYears = months[0].slice(0,4) !== months[months.length-1].slice(0,4);
      const label = spansYears ? m.slice(2).replace('-','/') : m.slice(5) + '月';
      ctx.fillStyle = axisColor; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(label, x + barW/2, H - 8);
    });
  },

  // ── 個股累計已實現損益排行（由高到低）───────────────
  _renderStockRanking() {
    const el = document.getElementById('perf-stock-ranking');
    if (!el) return;
    const sells = TRADES.get().filter(t => t.action === 'sell' && t.realizedPnl != null);
    if (!sells.length) { el.innerHTML = '<div class="empty-state" style="padding:10px 0">尚無已實現交易</div>'; return; }
    const byCode = {};
    sells.forEach(t => {
      const key = `${t.market||'TW'}_${t.code}`;
      if (!byCode[key]) byCode[key] = { code: t.code, name: t.name, pnl: 0, count: 0 };
      byCode[key].pnl += t.realizedPnl;
      byCode[key].count += 1;
    });
    const sorted = Object.values(byCode).sort((a,b) => b.pnl - a.pnl);
    const maxAbs = Math.max(...sorted.map(s => Math.abs(s.pnl)), 1);
    el.innerHTML = sorted.map(s => {
      const pct = Math.abs(s.pnl) / maxAbs * 100;
      const color = s.pnl >= 0 ? '#E24B4A' : '#1D9E75';
      return `
        <div class="perf-sector-row" style="margin-bottom:6px">
          <span class="perf-sector-name" style="width:110px">${s.code} ${s.name}</span>
          <div class="perf-sector-track"><div class="perf-sector-fill" style="width:${pct}%;background:${color}"></div></div>
          <span class="perf-sector-pct" style="width:90px;color:${color}">${s.pnl>=0?'+':''}${s.pnl.toFixed(0)}元</span>
        </div>`;
    }).join('');
  },

  _drawNetWorthChart() {
    const history = this._filterHistory(JSON.parse(localStorage.getItem('twsa-value-history') || '[]'));
    const canvas = document.getElementById('perf-networth-canvas');
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const W = wrap.clientWidth || 600, H = 220;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const isDark = !document.body.classList.contains('light-mode');
    const axisColor = isDark ? '#8b949e' : '#57606a';   // canvas fillStyle 不支援 CSS 變數，必須用實際色碼
    const gridColor = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';
    const axisLineColor = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)';

    const benchEl = document.getElementById('perf-benchmark');
    if (history.length < 2) {
      ctx.fillStyle = axisColor; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('資料累積中，明天再回來看趨勢', W/2, H/2);
      if (benchEl) benchEl.textContent = '';
      return;
    }

    const PAD = { l:52, r:12, t:10, b:26 };
    const chartW = W - PAD.l - PAD.r, chartH = H - PAD.t - PAD.b;
    const values = history.map(h => h.value);
    const minV = Math.min(...values), maxV = Math.max(...values);
    const range = (maxV - minV) || 1;
    const n = values.length;
    const xOf = i => PAD.l + (i / (n-1)) * chartW;
    const yOf = v => PAD.t + chartH - ((v - minV) / range) * chartH;

    // 水平格線 + Y軸標籤（3條）
    ctx.font = '13px sans-serif'; ctx.textAlign = 'right';
    [0, 0.5, 1].forEach(f => {
      const y = PAD.t + f * chartH;
      ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
      const val = maxV - f * range;
      ctx.fillStyle = axisColor;
      ctx.fillText(val >= 10000 ? (val/10000).toFixed(0)+'萬' : val.toFixed(0), PAD.l - 8, y + 4);
    });

    // 面積 + 折線
    const isUp = values[n-1] >= values[0];
    const color = isUp ? '#E24B4A' : '#1D9E75';
    ctx.beginPath();
    ctx.moveTo(xOf(0), PAD.t + chartH);
    values.forEach((v,i) => ctx.lineTo(xOf(i), yOf(v)));
    ctx.lineTo(xOf(n-1), PAD.t + chartH);
    ctx.closePath();
    ctx.fillStyle = isUp ? 'rgba(226,75,74,0.12)' : 'rgba(29,158,117,0.12)';
    ctx.fill();

    ctx.beginPath();
    values.forEach((v,i) => { const x=xOf(i), y=yOf(v); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.stroke();

    // 水平座標軸（底線）+ 垂直座標軸（左線）
    ctx.strokeStyle = axisLineColor; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(PAD.l, PAD.t + chartH); ctx.lineTo(W - PAD.r, PAD.t + chartH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PAD.l, PAD.t); ctx.lineTo(PAD.l, PAD.t + chartH); ctx.stroke();

    // X軸日期刻度（依可視寬度與資料時間跨度自適應決定刻度數與格式）
    ctx.font = '13px sans-serif';
    ctx.setLineDash([2,3]);
    // 寬度每 130px 大約能容納一個刻度，且不超過資料點數
    const maxTicks = Math.max(2, Math.min(n, Math.floor(chartW / 130) + 1));
    const tickCount = Math.min(maxTicks, 6);
    const tickIdxs = [];
    for (let k = 0; k < tickCount; k++) {
      const idx = Math.round((k / (tickCount - 1)) * (n - 1));
      if (!tickIdxs.includes(idx)) tickIdxs.push(idx);
    }
    // 資料跨越不同年份時，日期格式要帶年份；同一年只顯示月-日
    const spansMultipleYears = history[0].date.slice(0,4) !== history[n-1].date.slice(0,4);
    tickIdxs.forEach((idx, k) => {
      const x = xOf(idx);
      ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + chartH); ctx.stroke();
      ctx.fillStyle = axisColor;
      ctx.textAlign = k === 0 ? 'left' : (k === tickIdxs.length - 1 ? 'right' : 'center');
      const dateStr = history[idx].date;
      ctx.fillText(spansMultipleYears ? dateStr : dateStr.slice(5), x, H - 8);
    });
    ctx.setLineDash([]);

    GOALS._renderBenchmarkCompare(history, 'perf-benchmark');
  },

  _renderTradeStats() {
    const el = document.getElementById('perf-trade-stats');
    if (!el) return;
    const trades = TRADES.get();
    const sells = trades.filter(t => t.action === 'sell' && t.realizedPnl != null);
    if (!sells.length) { el.innerHTML = '<div class="empty-state" style="padding:10px 0">尚無已實現交易</div>'; return; }
    const wins = sells.filter(t => t.realizedPnl > 0);
    const losses = sells.filter(t => t.realizedPnl <= 0);
    const winRate = wins.length / sells.length * 100;
    const avgWin = wins.length ? wins.reduce((s,t)=>s+t.realizedPnl,0)/wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s,t)=>s+t.realizedPnl,0)/losses.length) : 0;
    const ratio = avgLoss > 0 ? (avgWin/avgLoss).toFixed(2) : (avgWin>0?'∞':'—');
    const totalRealized = sells.reduce((s,t)=>s+t.realizedPnl,0);
    const avgHold = sells.filter(t=>t.holdDays!=null).length
      ? Math.round(sells.reduce((s,t)=>s+(t.holdDays||0),0)/sells.filter(t=>t.holdDays!=null).length) : null;
    el.innerHTML = `
      <div class="perf-stat-row"><span class="perf-stat-name">勝率</span><span class="perf-stat-num" style="color:${winRate>=50?'#E24B4A':'#1D9E75'}">${winRate.toFixed(0)}%（${wins.length}/${sells.length}）</span></div>
      <div class="perf-stat-row"><span class="perf-stat-name">累計已實現損益</span><span class="perf-stat-num" style="color:${totalRealized>=0?'#E24B4A':'#1D9E75'}">${totalRealized>=0?'+':''}${totalRealized.toFixed(0)}元</span></div>
      <div class="perf-stat-row"><span class="perf-stat-name">平均賺賠比</span><span class="perf-stat-num">${ratio}</span></div>
      <div class="perf-stat-row"><span class="perf-stat-name">平均持有天數</span><span class="perf-stat-num">${avgHold!=null?avgHold+'天':'—'}</span></div>`;
  },

  _renderSectorBreakdown() {
    const el = document.getElementById('perf-sector-breakdown');
    if (!el) return;
    const portfolio = APP.portfolio;
    if (!portfolio.length) { el.innerHTML = '<div class="empty-state" style="padding:10px 0">尚無持股</div>'; return; }
    const totalVal = portfolio.reduce((s,x)=>s+(x.price??x.cost)*x.shares,0) || 1;
    const bySector = {};
    portfolio.forEach(s => {
      const sector = getStockSector(s.code);
      bySector[sector] = (bySector[sector]||0) + (s.price??s.cost)*s.shares;
    });
    const sorted = Object.entries(bySector).map(([sector,val])=>({sector,pct:val/totalVal*100})).sort((a,b)=>b.pct-a.pct);
    const colors = ['#E24B4A','#eab308','#37adf0','#1D9E75','#a78bfa','#f97316'];
    el.innerHTML = sorted.map((s,i) => `
      <div class="perf-sector-row">
        <span class="perf-sector-name">${s.sector}</span>
        <div class="perf-sector-track"><div class="perf-sector-fill" style="width:${s.pct}%;background:${colors[i%colors.length]}"></div></div>
        <span class="perf-sector-pct">${s.pct.toFixed(0)}%</span>
      </div>`).join('');
  },

  _renderBestWorst() {
    const el = document.getElementById('perf-best-worst');
    if (!el) return;
    const sells = TRADES.get().filter(t => t.action === 'sell' && t.realizedPnl != null);
    if (!sells.length) { el.innerHTML = '<div class="empty-state" style="padding:10px 0">尚無已實現交易</div>'; return; }
    const sorted = [...sells].sort((a,b) => b.realizedPnl - a.realizedPnl);
    const best = sorted.slice(0, 3);
    const worst = sorted.slice(-3).reverse().filter(t => !best.includes(t));
    const row = (t, isBest) => `<div class="perf-trade-item"><span>${t.code} ${t.name}</span><span style="color:${isBest?'#E24B4A':'#1D9E75'};font-weight:700">${t.realizedPnl>=0?'+':''}${t.realizedPnl.toFixed(0)}元</span></div>`;
    el.innerHTML = `
      <div style="font-size:11px;color:var(--text-3);margin-bottom:4px">🥇 最佳</div>
      ${best.map(t => row(t, true)).join('') || '<div class="empty-state" style="padding:4px 0">—</div>'}
      <div style="font-size:11px;color:var(--text-3);margin:10px 0 4px">📉 最差</div>
      ${worst.map(t => row(t, false)).join('') || '<div class="empty-state" style="padding:4px 0">—</div>'}`;
  },

  _renderPeriodPnl() {
    const el = document.getElementById('perf-period-pnl');
    if (!el) return;
    const sells = TRADES.get().filter(t => t.action === 'sell' && t.realizedPnl != null);
    const now = new Date();
    const thisMonth = now.toISOString().slice(0,7);
    const thisYear = now.toISOString().slice(0,4);
    const monthPnl = sells.filter(t => t.date?.startsWith(thisMonth)).reduce((s,t)=>s+t.realizedPnl,0);
    const yearPnl = sells.filter(t => t.date?.startsWith(thisYear)).reduce((s,t)=>s+t.realizedPnl,0);
    const monthCount = sells.filter(t => t.date?.startsWith(thisMonth)).length;
    const yearCount = sells.filter(t => t.date?.startsWith(thisYear)).length;
    el.innerHTML = `
      <div class="perf-stat-row"><span class="perf-stat-name">本月已實現損益（${monthCount}筆）</span><span class="perf-stat-num" style="color:${monthPnl>=0?'#E24B4A':'#1D9E75'}">${monthPnl>=0?'+':''}${monthPnl.toFixed(0)}元</span></div>
      <div class="perf-stat-row"><span class="perf-stat-name">今年已實現損益（${yearCount}筆）</span><span class="perf-stat-num" style="color:${yearPnl>=0?'#E24B4A':'#1D9E75'}">${yearPnl>=0?'+':''}${yearPnl.toFixed(0)}元</span></div>`;
  },
};

const Dashboard = {
  _rendering: false,

  toggle() {
    const dv = document.getElementById('dashboard-content');
    const isShowingDash = dv.style.display !== 'none';
    if (isShowingDash) {
      showMainView('detail');
      if (!APP.activeSymbol && APP.portfolio.length) {
        APP.selectStock(APP.portfolio[0].code, 0, 'portfolio');
      } else if (CHART.currentData.length) {
        setTimeout(() => CHART.draw(), 50); // 修正剛顯示時canvas寬度計算
      }
    } else {
      showMainView('dashboard');
      this.render();
    }
  },

  isCompact() { return localStorage.getItem('dash-compact-mode') === '1'; },
  toggleCompact() {
    const now = !this.isCompact();
    localStorage.setItem('dash-compact-mode', now ? '1' : '0');
    const btn = document.getElementById('dash-mode-toggle');
    if (btn) btn.textContent = now ? '🖼️ 完整模式' : '📋 精簡模式';
    this.render();
  },

  async render() {
    if (this._rendering) return;
    this._rendering = true;
    const grid = document.getElementById('dashboard-grid');
    if (!grid) { this._rendering = false; return; }
    const compact = this.isCompact();
    grid.classList.toggle('compact-grid', compact);
    const btn = document.getElementById('dash-mode-toggle');
    if (btn) btn.textContent = compact ? '🖼️ 完整模式' : '📋 精簡模式';
    if (typeof CHART !== 'undefined') CHART._renderMALegend();

    // 卡片清單：大盤指數（多個）+ 持股 + 自選（依目前市場）
    const isUS = APP.activeMarket === 'US';
    const indexCards = isUS
      ? [
          { code:'^GSPC', name:'S&P 500', isIndex:true },
          { code:'^IXIC', name:'那斯達克', isIndex:true },
          { code:'^DJI',  name:'道瓊工業', isIndex:true },
          { code:'^SOX',  name:'費城半導體', isIndex:true },
        ]
      : [
          { code:'^TWII', name:'加權指數', isIndex:true },
        ];
    // ★ 台股模式不顯示費半卡片，但背景仍抓資料維持半導體股預測連動修正
    if (!isUS) {
      DATA.fetchHistory('^SOX', '1d').catch(() => {});
    }
    const stockCardsRaw = [
      ...APP.portfolio.map(s => ({ code:s.code, name:s.name, isIndex:false, isWatch:false })),
      ...APP.watchlist
        .filter(w => !APP.portfolio.some(s => s.code === w.code))
        .map(w => ({ code:w.code, name:w.name, isIndex:false, isWatch:true })),
    ];
    // ★ 依使用者自訂排序（若有），未列入排序的新股票排在後面
    const order = this.getOrder();
    const stockCards = order.length
      ? [...stockCardsRaw].sort((a, b) => {
          const ia = order.indexOf(a.code), ib = order.indexOf(b.code);
          if (ia === -1 && ib === -1) return 0;
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        })
      : stockCardsRaw;
    const cards = [...indexCards, ...stockCards];

    if (stockCards.length === 0) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">尚無持股或自選股，請先新增</div>`;
      const sumEl = document.getElementById('dashboard-summary');
      if (sumEl) sumEl.innerHTML = '';
      this._rendering = false;
      return;
    }

    // 先畫出卡片骨架，資料抓回來後逐一補上
    grid.innerHTML = cards.map((c, i) => this._cardSkeleton(c, i, compact)).join('');

    // ★ 12張卡以內：動態計算每列卡片數，讓整個網格剛好填滿容器高度、不需捲動
    // 超過12張：卡片大小固定，改成滾輪捲動顯示，不再繼續自適應縮小
    const total = cards.length;
    const maxCols = compact ? 6 : 3;
    const cols = Math.min(maxCols, total);
    const overLimit = total > 12;
    grid.classList.toggle('scrollable', overLimit);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    if (overLimit) {
      grid.style.gridTemplateRows = ''; // 交給 grid-auto-rows（CSS）決定固定高度
    } else {
      const rows = Math.ceil(total / cols);
      grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    }

    // ★ 並行觸發所有卡片載入：價格立即顯示（同步），K線/預測線背景抓取
    // 實際的網路請求節流交給共用佇列（DATA._enqueue）處理，不再額外死等
    this._sigTiers = {}; // 收集訊號分級供摘要列統計
    await Promise.all(cards.map((c, i) => this._loadCard(c, i, compact)));
    this._renderSummary(cards);
    // 卡片自己算好的指標已寫回全域快取，順便刷新側邊欄讓訊號同步更新
    APP.renderStockList();
    APP._renderSignalOverview();
    this._rendering = false;
  },

  // 頂部摘要列：整體買/賣/觀望張數統計
  _renderSummary(cards) {
    const sumEl = document.getElementById('dashboard-summary');
    if (!sumEl) return;
    let buy = 0, sell = 0, hold = 0;
    Object.values(this._sigTiers || {}).forEach(tier => {
      if (tier >= 4) buy++;
      else if (tier <= 2) sell++;
      else hold++;
    });
    const total = buy + sell + hold;
    if (!total) { sumEl.innerHTML = ''; return; }
    sumEl.innerHTML = `
      <span class="sum-chip" style="color:#E24B4A">🟥 ${buy} 檔建議買進</span>
      <span class="sum-chip" style="color:var(--text-3)">⬜ ${hold} 檔持有觀望</span>
      <span class="sum-chip" style="color:#1D9E75">🟩 ${sell} 檔建議減碼/出場</span>`;
  },

  _idOf(code) { return code.replace(/[^a-zA-Z0-9]/g, '_'); },

  _cardSkeleton(c, i, compact) {
    const id = this._idOf(c.code);
    const canvasHtml = compact ? '' : `<canvas class="dash-card-canvas" id="dash-canvas-${id}"></canvas>`;
    return `
      <div class="dash-card ${c.isIndex ? 'dash-card-index' : ''} ${compact ? 'compact' : ''}" id="dash-card-${id}" onclick="Dashboard._onCardClick('${c.code}', ${c.isWatch ? "'watch'" : "'portfolio'"})">
        <div class="dash-card-head">
          <span class="dash-card-code" id="dash-code-${id}">${c.code}</span>
          <span class="dash-card-name" id="dash-name-${id}">${c.name}</span>
        </div>
        <div class="dash-card-price-row">
          <div class="dash-price-left">
            <span class="dash-card-price" id="dash-price-${id}">—</span>
            <span class="dash-card-chg" id="dash-chg-${id}"></span>
          </div>
          ${compact ? '' : `<div class="dash-card-stats" id="dash-stats-${id}"></div>`}
        </div>
        ${canvasHtml}
        <div class="dash-card-badge-row" id="dash-badge-${id}">
          <span class="dash-badge-loading">載入中...</span>
        </div>
      </div>`;
  },

  async _loadCard(c, i, compact) {
    const id = this._idOf(c.code);
    const priceEl = document.getElementById(`dash-price-${id}`);
    const chgEl = document.getElementById(`dash-chg-${id}`);
    const codeEl = document.getElementById(`dash-code-${id}`);
    const nameEl = document.getElementById(`dash-name-${id}`);
    const isUSStock = c.isIndex ? false : DATA.isUSCode(c.code);

    // ★ 第一階段（同步、立即）：用已經批次抓好的報價先顯示價格，不等K線資料
    const renderPrice = (price, prevClose) => {
      const chg = price - prevClose;
      const chgPct = prevClose ? chg / prevClose * 100 : 0;
      const colorClass = chgColorClass(chg);
      if (priceEl) { priceEl.textContent = (isUSStock ? 'US$' : '') + price.toFixed(2); priceEl.className = 'dash-card-price ' + colorClass; }
      if (codeEl) codeEl.className = 'dash-card-code ' + colorClass;
      if (nameEl) nameEl.className = 'dash-card-name ' + colorClass;
      if (chgEl) {
        const isUp = chg >= 0;
        chgEl.className = 'dash-card-chg ' + (isUp ? 'up-color' : 'dn-color');
        chgEl.textContent = `${isUp?'▲':'▼'}${Math.abs(chg).toFixed(2)} (${Math.abs(chgPct).toFixed(2)}%)`;
      }
      return { chg, chgPct };
    };

    const live0 = DATA.priceStore[c.code];
    if (live0?.price) renderPrice(live0.price, live0.prevClose ?? live0.price);

    try {
      // ★ 第二階段（非同步）：抓完整1年日線（跟個股詳細頁的長線資料一樣），確保預測線100%一致
      // 精簡模式優先用已有報價，避免不必要的歷史資料抓取
      let price, prevClose, data = null;
      const live = DATA.priceStore[c.code];
      if (compact && live?.price) {
        price = live.price;
        prevClose = live.prevClose ?? price;
      } else {
        data = await DATA.fetchHistory(c.code, '1d');
        if (!data || data.length < 3) throw new Error('no data');
        const last = data[data.length - 1];
        const prev = data.length >= 2 ? data[data.length - 2].c : last.c;
        price = live?.price && live.source !== 'twse-prev' ? live.price : last.c;
        prevClose = live?.prevClose ?? prev;
      }
      const { chg } = renderPrice(price, prevClose);

      // ★ 關鍵修正：卡片自己算完的指標直接寫回全域快取，
      // 這樣訊號徽章第一次渲染就有正確結果，不用等背景分析、也不會卡在「分析中」
      if (!compact && data && !c.isIndex && !ANALYSIS._cache[c.code]) {
        try {
          const ind = ANALYSIS._calcIndicators(data);
          ANALYSIS._cache[c.code] = { ind, candles: data };
        } catch(e) { /* 靜默失敗，quickEstimate 會fallback */ }
      }

      // ★ 今日統計小字：成交量、最高、最低、勾選的均線、本益比
      if (!compact && data) {
        this._renderCardStats(id, data, isUSStock, c.code);
      }

      let prediction = null;
      if (!compact) {
        const canvas = document.getElementById(`dash-canvas-${id}`);
        if (canvas && data) prediction = this._drawMiniChart(canvas, data, c.code);
      }

      const trendBadge = prediction
        ? (() => {
            const tc = CHART._trendColor(prediction.trend);
            const bgAlpha = prediction.trend.dir === 'flat' ? 0.12 : (0.10 + prediction.trend.level * 0.05);
            const rgbMap = { up:[226,75,74], down:[29,158,117], flat:[156,163,175] };
            const rgb = rgbMap[prediction.trend.dir];
            return `<span class="dash-trend-badge" style="color:${tc};background:rgba(${rgb[0]},${rgb[1]},${rgb[2]},${bgAlpha});border:1px solid ${tc}">${prediction.trend.short} ${prediction.pctChange>=0?'+':''}${prediction.pctChange.toFixed(1)}%</span>`;
          })()
        : '';

      // 訊號徽章（指數只顯示趨勢分級，不顯示買賣訊號）
      const badgeEl = document.getElementById(`dash-badge-${id}`);
      if (badgeEl) {
        if (c.isIndex) {
          badgeEl.innerHTML = trendBadge;
        } else {
          const s = APP.portfolio.find(x => x.code === c.code) || { code: c.code, price, cost: price };
          const sig = SIGNAL.quickEstimate({ ...s, price });
          const tier = sig?.tier ?? 3;
          this._sigTiers[c.code] = tier; // 供摘要列統計
          let priceHtml = '';
          if (tier <= 2) {
            // 賣出家族：顯示建議賣出參考價（現價附近）
            priceHtml = `<span class="dash-badge-price">參考 ${isUSStock?'US$':''}${price.toFixed(2)}</span>`;
          } else if (tier >= 4) {
            // 買進家族：顯示建議進場價（現價回檔3%）
            const entry = price * 0.97;
            priceHtml = `<span class="dash-badge-price">進場 ${isUSStock?'US$':''}${entry.toFixed(2)}</span>`;
          }
          badgeEl.innerHTML = `<span class="dash-badge ${sig.cls}">${sig.short} ${sig.label}</span>${priceHtml}${trendBadge}`;
        }
      }
    } catch(e) {
      const badgeEl = document.getElementById(`dash-badge-${id}`);
      if (badgeEl) badgeEl.innerHTML = `<span class="dash-badge-error">資料載入失敗</span>`;
    }
  },

  // 輕量預測：直接呼叫 CHART 的共用預測引擎，與個股詳細頁完全同一套邏輯與參數
  // 近期10天/中期40天回看窗口與主圖完全相同（資料不足時內部會自動用全部可用資料）
  // ★ 指標直接從完整資料同步算出（不依賴 ANALYSIS._cache 的背景分析時機，避免總覽/詳細頁不一致）
  _miniPredict(data, days, code) {
    let ind;
    try {
      ind = ANALYSIS._cache[code]?.ind ?? ANALYSIS._calcIndicators(data);
    } catch(e) { ind = null; }
    return CHART._predictEngine(data, days, code, {
      nearLookback: 10,
      midLookback: 40,
      hlLookback: 40,
      zScore: 1.3,
      ind,
    });
  },

  // 輕量K線+成交量+預測線繪製（單一canvas）
  // fullData：完整歷史（供預測計算，與詳細頁一致）；畫面只顯示最近一小段蠟燭
  _drawMiniChart(canvas, fullData, code) {
    const rect = canvas.getBoundingClientRect();
    const W = rect.width || 260;
    const H = rect.height || 90;
    if (W < 5 || H < 5) return; // 尚未完成排版，跳過
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const DISPLAY_N = 24; // 畫面只顯示最近24根蠟燭（跟主圖預設1日週期一致視覺密度）
    const data = fullData.slice(-DISPLAY_N);
    const n = data.length;
    if (!n) return;
    const volH = Math.max(10, H * 0.16), gapY = 2;
    const priceH = H - volH - gapY;

    const predictDays = 15; // 與個股詳細頁一致
    // ★ 預測用完整歷史資料計算，與個股詳細頁的 currentData 邏輯完全相同
    const prediction = this._miniPredict(fullData, predictDays, code);
    const extraBars = prediction ? predictDays : 0;
    const totalBars = n + extraBars;

    const PAD = { l:2, r:2 };
    const chartW = W - PAD.l - PAD.r;
    const gapRatio = 0.3;
    const barW = Math.max(0.8, chartW / (totalBars * (1 + gapRatio)));
    const gap = barW * gapRatio;
    const xOf = i => PAD.l + i * (barW + gap);

    // ── 均線資料（先算好，才能把數值範圍一起納入Y軸計算，避免均線被裁切）──
    const maColors = { 5:'#EF9F27', 10:'#a78bfa', 20:'#378ADD', 60:'#D4537E', 120:'#2ee88f', 240:'#f97316' };
    const maLines = [];
    if (typeof CHART !== 'undefined') {
      const allCloses = fullData.map(d => d.c);
      const offset = fullData.length - n; // data 是 fullData 最後 n 筆，算均線要對齊回原始索引
      CHART.selectedMAs.forEach(period => {
        const full = CHART._ma(allCloses, period);
        const visible = full.slice(offset, offset + n);
        maLines.push({ period, color: maColors[period] || '#888', values: visible });
      });
    }

    const highs = data.map(d => d.h), lows = data.map(d => d.l);
    let maxP = Math.max(...highs), minP = Math.min(...lows);
    if (prediction) {
      prediction.points.forEach(p => { maxP = Math.max(maxP, p.upper); minP = Math.min(minP, p.lower); });
    }
    maLines.forEach(m => m.values.forEach(v => { if (v) { maxP = Math.max(maxP, v); minP = Math.min(minP, v); } }));
    const range = (maxP - minP) || 1;
    const yOf = p => (1 - (p - minP) / range) * priceH;

    // ── 格線（水平3條 + 垂直分段），淡色不搶眼 ──
    const isDark = !document.body.classList.contains('light-mode');
    const gridColor = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)';
    ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    // 水平格線：上/中/下三條
    [0, 0.5, 1].forEach(frac => {
      const y = frac * priceH;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    });
    // 垂直格線：依可視K線數平均分4段
    const vStep = Math.max(1, Math.ceil(n / 4));
    for (let i = 0; i < n; i += vStep) {
      const x = xOf(i);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, priceH); ctx.stroke();
    }
    ctx.setLineDash([]);

    data.forEach((d, i) => {
      const prevClose = i > 0 ? data[i-1].c : d.o;
      const isUp = d.c >= prevClose;
      const color = isUp ? '#E24B4A' : '#1D9E75';
      const x = xOf(i);
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
      // 影線
      ctx.beginPath();
      ctx.moveTo(x + barW/2, yOf(d.h));
      ctx.lineTo(x + barW/2, yOf(d.l));
      ctx.stroke();
      // 實體
      const yo = yOf(d.o), yc = yOf(d.c);
      const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(x, top, barW, bh);
    });

    // ── 均線（用勾選的週期，跟個股詳細頁同一套邏輯與資料）──────
    maLines.forEach(m => {
      ctx.beginPath();
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1;
      let started = false;
      m.values.forEach((v, i) => {
        if (!v) return;
        const x = xOf(i) + barW/2, y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });

    // ── 均價水平線（若持有此股票）──────────────────────
    const heldStock = code ? APP.portfolio.find(s => s.code === code) : null;
    if (heldStock?.cost && heldStock.cost >= minP && heldStock.cost <= maxP) {
      const costY = yOf(heldStock.cost);
      ctx.beginPath();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#eab308'; ctx.lineWidth = 1;
      ctx.moveTo(0, costY); ctx.lineTo(W, costY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 預測延伸（區間 + 中線虛線 + 偏多偏空分級標籤，紅漲綠跌配色與主圖一致）
    if (prediction) {
      const lastX = xOf(n-1) + barW/2, lastY = yOf(data[n-1].c);
      const trend = prediction.trend;
      const trendColor = CHART._trendColor(trend);
      const rgbMap = { up:[226,75,74], down:[29,158,117], flat:[156,163,175] };
      const rgb = rgbMap[trend.dir];
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      prediction.points.forEach((p, i) => ctx.lineTo(xOf(n+i)+barW/2, yOf(p.upper)));
      for (let i = prediction.points.length-1; i>=0; i--) ctx.lineTo(xOf(n+i)+barW/2, yOf(prediction.points[i].lower));
      ctx.closePath();
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.08 + trend.level * 0.04})`;
      ctx.fill();

      ctx.beginPath();
      ctx.setLineDash([2,2]);
      ctx.strokeStyle = trendColor; ctx.lineWidth = 1.5;
      ctx.moveTo(lastX, lastY);
      prediction.points.forEach((p,i) => ctx.lineTo(xOf(n+i)+barW/2, yOf(p.mid)));
      ctx.stroke();
      ctx.setLineDash([]);

      // 分級標籤（放大字體+底色背景，確保清楚可讀）
      const labelText = `${trend.short} ${prediction.pctChange>=0?'+':''}${prediction.pctChange.toFixed(1)}%`;
      ctx.font = 'bold 14px sans-serif';
      const tw = ctx.measureText(labelText).width;
      const lx = Math.max(2, xOf(n) - 2), ly = 3;
      ctx.fillStyle = 'rgba(13,17,23,0.8)';
      ctx.fillRect(lx - 2, ly, tw + 8, 17);
      ctx.fillStyle = trendColor;
      ctx.textAlign = 'left';
      ctx.fillText(labelText, lx + 2, ly + 13);
    }

    // 成交量
    const maxV = Math.max(...data.map(d => d.v)) || 1;
    const volTop = priceH + gapY;
    data.forEach((d, i) => {
      const prevClose = i > 0 ? data[i-1].c : d.o;
      const isUp = d.c >= prevClose;
      ctx.fillStyle = isUp ? 'rgba(226,75,74,0.5)' : 'rgba(29,158,117,0.5)';
      const bh = d.v > 0 ? Math.max(1, (d.v / maxV) * volH) : 0;
      ctx.fillRect(xOf(i), volTop + volH - bh, barW, bh);
    });

    return prediction;
  },

  _onCardClick(code, source) {
    showMainView('detail');
    const list = source === 'watch' ? APP.watchlist : APP.portfolio;
    const idx = list.findIndex(s => s.code === code);
    APP.selectStock(code, idx >= 0 ? idx : 0, source);
    setTimeout(() => CHART.draw(), 80);
  },

  // 輕量更新：只更新價格文字/徽章，不重抓K線、不重繪canvas（節省資源）
  updateLivePrices() {
    const dv = document.getElementById('dashboard-content');
    if (!dv || dv.style.display === 'none') return;
    const isUS = APP.activeMarket === 'US';
    // ★ 大盤指數卡片也要一起更新，之前漏掉導致指數卡片價格凍結不動
    const indexCodes = isUS ? ['^GSPC','^IXIC','^DJI','^SOX'] : ['^TWII'];
    const stockCards = [
      ...indexCodes.map(code => ({ code, isIndex: true })),
      ...APP.portfolio.map(s => ({ code:s.code, isWatch:false })),
      ...APP.watchlist.filter(w => !APP.portfolio.some(s => s.code === w.code)).map(w => ({ code:w.code, isWatch:true })),
    ];
    stockCards.forEach(c => {
      const id = this._idOf(c.code);
      const q = DATA.priceStore[c.code];
      if (!q?.price) return;
      const priceEl = document.getElementById(`dash-price-${id}`);
      const chgEl = document.getElementById(`dash-chg-${id}`);
      const codeEl = document.getElementById(`dash-code-${id}`);
      const nameEl = document.getElementById(`dash-name-${id}`);
      const isUSStock = c.isIndex ? false : DATA.isUSCode(c.code);
      if (priceEl) priceEl.textContent = (isUSStock ? 'US$' : '') + q.price.toFixed(2);
      if (q.prevClose != null) {
        const chg = q.price - q.prevClose;
        const chgPct = chg / q.prevClose * 100;
        const isUp = chg >= 0;
        const colorClass = chgColorClass(chg);
        if (priceEl) priceEl.className = 'dash-card-price ' + colorClass;
        if (codeEl) codeEl.className = 'dash-card-code ' + colorClass;
        if (nameEl) nameEl.className = 'dash-card-name ' + colorClass;
        if (chgEl) {
          chgEl.className = 'dash-card-chg ' + (isUp ? 'up-color' : 'dn-color');
          chgEl.textContent = `${isUp?'▲':'▼'}${Math.abs(chg).toFixed(2)} (${Math.abs(chgPct).toFixed(2)}%)`;
        }
      }
    });
  },

  // ── 定期重繪迷你K線（用已快取的歷史資料+最新報價，不額外發request）──
  // 跟 updateLivePrices() 分開頻率：文字每次刷新都更新，K線圖較耗運算，較低頻重繪即可
  refreshMiniCharts() {
    const dv = document.getElementById('dashboard-content');
    if (!dv || dv.style.display === 'none') return;
    if (this.isCompact()) return; // 精簡模式沒有K線圖，不用處理
    const isUS = APP.activeMarket === 'US';
    const indexCodes = isUS ? ['^GSPC','^IXIC','^DJI','^SOX'] : ['^TWII'];
    const stockCards = [
      ...indexCodes,
      ...APP.portfolio.map(s => s.code),
      ...APP.watchlist.filter(w => !APP.portfolio.some(s => s.code === w.code)).map(w => w.code),
    ];
    stockCards.forEach(code => {
      const cached = DATA.histCache[`${code}_1d`]?.data;
      if (!cached || cached.length < 3) return; // 還沒有快取資料，跳過（下次render時會補）
      const canvas = document.getElementById(`dash-canvas-${this._idOf(code)}`);
      if (!canvas) return;
      // 複製一份避免修改到共用快取，patch最後一根K線成最新報價後重繪
      const dataCopy = cached.map(d => ({ ...d }));
      CHART._patchCandleData(dataCopy, code);
      const prediction = this._drawMiniChart(canvas, dataCopy, code);
      // 趨勢徽章也一併更新（避免文字停留在舊的預測結果）
      const badgeEl = document.getElementById(`dash-badge-${this._idOf(code)}`);
      if (badgeEl && prediction) {
        const trendBadgeEl = badgeEl.querySelector('.dash-trend-badge');
        if (trendBadgeEl) {
          const tc = CHART._trendColor(prediction.trend);
          trendBadgeEl.style.color = tc;
          trendBadgeEl.textContent = `${prediction.trend.short} ${prediction.pctChange>=0?'+':''}${prediction.pctChange.toFixed(1)}%`;
        }
      }
    });
  },

  // ── 今日統計小字（成交量、最高、最低、勾選的均線）──────
  async _renderCardStats(id, data, isUSStock, code) {
    const el = document.getElementById(`dash-stats-${id}`);
    if (!el || !data?.length) return;
    const last = data[data.length - 1];
    const closes = data.map(d => d.c);
    const selectedMAs = (typeof CHART !== 'undefined' ? CHART.selectedMAs : null) || [5, 20, 60];
    const maParts = selectedMAs.map(period => {
      if (closes.length < period) return null;
      const slice = closes.slice(-period);
      const avg = slice.reduce((a,b) => a+b, 0) / period;
      return `MA${period} ${avg.toFixed(isUSStock?2:1)}`;
    }).filter(Boolean);
    // ★ 指數（例如加權指數）Yahoo 沒有提供成交量資料，顯示「—」而不是誤導性的「0」
    // ★ 修正：只有「今天」這一根可能因為交易所還沒彙總完成而是0，不代表整體沒有成交量資料
    // （之前誤判成「這檔完全沒有成交量資料」，但實際上過去的資料都是真的，只有當天可能還沒彙總好）
    const volDisplay = !last.v ? '彙總中' : (last.v >= 10000 ? (last.v/10000).toFixed(1)+'萬' : last.v.toLocaleString());
    const parts = [
      `量 ${volDisplay}`,
      `高 ${last.h.toFixed(isUSStock?2:1)}`,
      `低 ${last.l.toFixed(isUSStock?2:1)}`,
      ...maParts,
    ];
    el.innerHTML = parts.map(p => `<span class="dash-stat-item">${p}</span>`).join('');

    // ★ 本益比等基本面數字（只有台股上市股票有，非同步補上，不擋主要渲染）
    if (!isUSStock && code && !code.startsWith('^')) {
      try {
        const peData = await DATA.fetchPERatios();
        const pe = peData[code];
        if (pe?.pe != null) {
          const peSpan = `<span class="dash-stat-item">PE ${pe.pe.toFixed(1)}</span>`;
          el.innerHTML += peSpan;
        }
      } catch(e) { /* 靜默失敗，不影響其他資訊顯示 */ }
    }
  },

  // ── 卡片排序（依市場分開儲存）──────────────────────
  _orderKey() { return APP.activeMarket === 'US' ? 'ussa-dash-order' : 'twsa-dash-order'; },
  getOrder() {
    try { return JSON.parse(localStorage.getItem(this._orderKey()) || '[]'); }
    catch(e) { return []; }
  },
  saveOrder(codes) {
    localStorage.setItem(this._orderKey(), JSON.stringify(codes));
  },

  openReorderModal() {
    const stockCardsRaw = [
      ...APP.portfolio.map(s => ({ code:s.code, name:s.name, isWatch:false })),
      ...APP.watchlist
        .filter(w => !APP.portfolio.some(s => s.code === w.code))
        .map(w => ({ code:w.code, name:w.name, isWatch:true })),
    ];
    if (!stockCardsRaw.length) { showToast('尚無持股或自選股可排序'); return; }
    const order = this.getOrder();
    const sorted = order.length
      ? [...stockCardsRaw].sort((a, b) => {
          const ia = order.indexOf(a.code), ib = order.indexOf(b.code);
          if (ia === -1 && ib === -1) return 0;
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        })
      : stockCardsRaw;

    const list = document.getElementById('reorder-list');
    list.innerHTML = sorted.map(c => `
      <div class="reorder-item" draggable="true" data-code="${c.code}">
        <span class="reorder-handle">☰</span>
        <span class="reorder-code">${c.code}</span>
        <span class="reorder-name">${c.name}</span>
        <span class="reorder-tag">${c.isWatch ? '自選' : '持股'}</span>
      </div>`).join('');

    this._setupDragReorder(list);
    document.getElementById('reorder-modal').classList.add('show');
  },

  _setupDragReorder(list) {
    let dragEl = null;
    list.querySelectorAll('.reorder-item').forEach(item => {
      item.addEventListener('dragstart', () => {
        dragEl = item;
        setTimeout(() => item.classList.add('dragging'), 0);
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        list.querySelectorAll('.reorder-item').forEach(x => x.classList.remove('drag-over'));
        dragEl = null;
      });
      item.addEventListener('dragover', e => {
        e.preventDefault();
        if (item === dragEl) return;
        item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', e => {
        e.preventDefault();
        item.classList.remove('drag-over');
        if (!dragEl || item === dragEl) return;
        const items = [...list.querySelectorAll('.reorder-item')];
        const dragIdx = items.indexOf(dragEl);
        const dropIdx = items.indexOf(item);
        if (dragIdx < dropIdx) item.after(dragEl);
        else item.before(dragEl);
      });
    });
  },

  saveReorder() {
    const items = document.querySelectorAll('#reorder-list .reorder-item');
    const codes = Array.from(items).map(el => el.dataset.code);
    this.saveOrder(codes);
    closeModal('reorder-modal');
    showToast('排序已儲存');
    this.render();
  },
};

// ── ORDER module ──────────────────────────────────────
const ORDER = {
  suggestEntry: 0, suggestSL: 0, suggestTP: 0, score: 0,

  calcSingle() {
    const budget   = parseFloat(document.getElementById('budget')?.value) || 100000;
    const strategy = document.getElementById('strategy-select')?.value ?? 'auto';
    const price    = this.suggestEntry || APP.getActiveStock()?.price || 100;
    if (!price) return;
    let batches = 3;
    if (strategy === 'single') batches = 1;
    else if (strategy === 'batch2') batches = 2;
    else if (strategy === 'batch3') batches = 3;
    else if (strategy === 'batch4') batches = 4;
    else {
      if (budget < price * 200) batches = 1;
      else if (budget < price * 500 || this.score < 2) batches = 2;
      else if (this.score >= 3) batches = 4;
      else batches = 3;
    }
    const configs = {
      1: { ratios:[1],             offsets:[0] },
      2: { ratios:[0.6,0.4],       offsets:[0,-0.025] },
      3: { ratios:[0.4,0.35,0.25], offsets:[0,-0.025,-0.05] },
      4: { ratios:[0.3,0.25,0.25,0.2], offsets:[0,-0.02,-0.04,-0.06] },
    };
    const { ratios, offsets } = configs[batches];
    const tbody = document.getElementById('order-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    let totalCost = 0, totalShares = 0;
    ratios.forEach((ratio, i) => {
      const batchBudget = budget * ratio;
      const batchPrice  = +(price * (1 + offsets[i])).toFixed(2);
      const shares = Math.max(1, Math.floor(batchBudget / batchPrice));
      const cost = shares * batchPrice;
      const fee  = Math.max(20, Math.round(cost * 0.001425));
      totalCost += cost + fee; totalShares += shares;
      const sharesDisp = shares >= 1000 ? `${(shares/1000).toFixed(1)}張` : `${shares}股`;
      const costDisp = cost >= 10000 ? `${(cost/10000).toFixed(2)}萬` : `${cost.toFixed(0)}元`;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="td-batch">${batches>1?`第${i+1}批`:'進場'}<br><small style="color:var(--text-3);font-size:10px">預算${(budget*ratio/10000).toFixed(1)}萬</small></td>
        <td class="td-price">$${batchPrice}</td>
        <td class="td-shares">${sharesDisp}</td>
        <td class="td-amount">${costDisp}</td>
        <td class="td-fee" style="color:var(--text-3);font-size:11px">+${fee}</td>
        <td class="td-pct">${(ratio*100).toFixed(0)}%</td>`;
      tbody.appendChild(tr);
    });
    const footer = document.getElementById('order-footer');
    if (footer) {
      const remain = budget - totalCost;
      const totalDisp = totalCost >= 10000 ? `${(totalCost/10000).toFixed(2)}萬` : `${totalCost.toFixed(0)}元`;
      const remDisp = Math.abs(remain) >= 10000 ? `${(remain/10000).toFixed(2)}萬` : `${remain.toFixed(0)}元`;
      // 問題5: 掛單建議
      let orderHint = '';
      if (this.suggestEntry > 0 && totalShares > 0) {
        const isBuy = this.score >= 0.5;
        const isSell = this.score <= -0.5;
        if (isBuy || isSell) {
          const action = isBuy ? '限價買進' : '限價賣出';
          const color = isBuy ? 'var(--green-l)' : 'var(--red)';
          const entryDisp = `$${this.suggestEntry.toFixed(1)}`;
          const slDisp = `$${this.suggestSL.toFixed(1)}`;
          const tpDisp = `$${this.suggestTP.toFixed(1)}`;
          orderHint = `<div style="margin-top:8px;padding:8px 10px;background:var(--bg-3);border-radius:6px;border-left:3px solid ${color};font-size:11px;line-height:1.7">
            📋 掛單參考：<span style="color:${color};font-weight:700">${action}</span>
            <strong>${totalShares}股</strong> @ <strong>${entryDisp}</strong>
            &nbsp;｜&nbsp;停損 <span style="color:var(--red)">${slDisp}</span>
            &nbsp;｜&nbsp;停利 <span style="color:var(--green-l)">${tpDisp}</span>
          </div>`;
        }
      }
      footer.innerHTML = `<span>合計：<strong>${totalShares}股</strong>，含手續費 <strong>${totalDisp}</strong></span><span>剩餘：${remDisp}（${(remain/budget*100).toFixed(0)}%）</span>${orderHint}`;
    }
  },

  calcPortfolio() {
    const budgetEl = document.getElementById('portfolio-budget');
    if (!budgetEl) return;
    const totalBudget = parseFloat(budgetEl.value) || 0;
    if (!totalBudget || !APP.portfolio.length) return;
    const stocks = APP.portfolio.filter(s => s.price);
    if (!stocks.length) return;

    const scored = stocks.map(s => {
      let score = 0, hasAnalysis = false, reasons = [];
      const gainPct = (s.price - s.cost) / s.cost * 100;

      // ★ 用此股票自己的快取，不是 lastInd
      const cached = ANALYSIS._cache[s.code];
      const cachedInd = cached?.ind || null;
      if (cachedInd) {
        const ind = cachedInd;
        score = ANALYSIS._calcScore(ind);
        hasAnalysis = true;
        if (ind.rsi < 35) reasons.push(`RSI ${ind.rsi}超賣`);
        if (ind.rsi > 68) reasons.push(`RSI ${ind.rsi}超買`);
        if (ind.macdGolden) reasons.push('MACD黃金交叉');
        if (ind.macdDead)   reasons.push('MACD死亡交叉');
        if (ind.kdGolden)   reasons.push('KD黃金交叉');
        if (ind.kdDead)     reasons.push('KD死亡交叉');
        if (ind.maBull)     reasons.push('均線多頭排列');
        if (!ind.maBull)    reasons.push('均線空頭排列');
      } else {
        if (gainPct <= -8)  { score = -3; reasons.push(`虧損${gainPct.toFixed(1)}%嚴重`); }
        else if (gainPct <= -3) { score = -1; reasons.push(`虧損${gainPct.toFixed(1)}%`); }
        else if (gainPct >= 25) { score = -1; reasons.push(`獲利${gainPct.toFixed(1)}%已高`); }
        else if (gainPct >= 15) { score = 0.5; reasons.push(`獲利${gainPct.toFixed(1)}%`); }
        else                    { score = 1;   reasons.push('損益正常範圍'); }
      }

      // VIX 調整
      const vixAdj = VIX.score || 0;
      if (vixAdj > 0) reasons.push(`VIX${VIX.label}利多`);
      if (vixAdj < 0) reasons.push(`VIX${VIX.label}偏空`);
      score += vixAdj * 0.5;

      // 持股狀況調整
      if (gainPct <= -8)   { score -= 0.5; }
      if (gainPct >= 25)   { score -= 0.3; reasons.push('建議部分了結'); }

      return { ...s, score, gainPct, hasAnalysis, reasons };
    });

    const el = document.getElementById('portfolio-alloc-result');
    if (!el) return;

    const toBuy    = scored.filter(s => s.score > 1.5).sort((a,b) => b.score - a.score);
    const toWatch  = scored.filter(s => s.score >= -1 && s.score <= 1.5);
    const toReduce = scored.filter(s => s.score < -1);
    const totalScore = toBuy.reduce((a, s) => a + Math.max(0.1, s.score), 0);

    let html = '';

    // VIX 警示列
    if (VIX.label) {
      const vixColor = VIX.score > 0 ? 'var(--green-l)' : VIX.score < 0 ? 'var(--red)' : 'var(--amber)';
      html += `<div class="alloc-vix-tip">
        <span style="color:${vixColor};font-weight:600">${VIX.label} ${VIX.level}%</span>
        <span style="color:var(--text-2)"> — ${VIX.score > 0 ? '恐慌期，逆向佈局機會' : VIX.score < 0 ? '市場過熱，謹慎追高' : '市場平穩，技術訊號較可靠'}</span>
      </div>`;
    }

    if (toBuy.length === 0) {
      html += `<div class="alloc-empty">目前無明確買進訊號<br><small>建議保留現金觀察，等待更好的進場時機</small></div>`;
    } else {
      html += `<div class="alloc-decision-header">💰 預算 ${this._fmtMoney(totalBudget)} → 分配建議</div>`;
      toBuy.forEach(s => {
        const ratio = Math.max(0.1, s.score) / totalScore;
        const budget = totalBudget * ratio;
        const shares = Math.max(0, Math.floor(budget / s.price));
        const cost = shares * s.price;
        const fee = Math.max(20, Math.round(cost * 0.001425));
        const sharesDisp = shares >= 1000 ? `${(shares/1000).toFixed(1)}張` : `${shares}股`;
        const costDisp = this._fmtMoney(cost);
        const isBig = s.score >= 3;
        const action = isBig ? '積極買入' : '適量買入';
        const batchNote = isBig
          ? '建議分 <strong>2 批</strong> 進場（今 50%，低點加碼 50%）'
          : '建議 <strong>單次</strong> 進場';

        html += `<div class="alloc-decision-card buy">
          <div class="adc-header">
            <span class="adc-action buy">✅ ${action}</span>
            <span class="adc-code">${s.code} ${s.name}</span>
            <span class="adc-price">現價 $${s.price}</span>
            <span class="adc-gain ${s.gainPct>=0?'up-color':'dn-color'}">${s.gainPct>=0?'+':''}${s.gainPct.toFixed(1)}%</span>
          </div>
          <div class="adc-order">
            <div class="adc-order-main">買 <strong>${sharesDisp}</strong>，約 <strong>${costDisp}</strong>（含手續費 $${fee}）</div>
            <div class="adc-batch">${batchNote}</div>
          </div>
          <div class="adc-reasons">
            ${s.reasons.map(r => `<span class="adc-reason-tag">${r}</span>`).join('')}
            ${!s.hasAnalysis ? '<span class="adc-reason-tag warn">需技術分析</span>' : ''}
          </div>
        </div>`;
      });
    }

    if (toWatch.length > 0) {
      html += `<div class="alloc-section-title">⚪ 持有觀望</div>`;
      html += toWatch.map(s => `
        <div class="alloc-decision-card watch">
          <div class="adc-header">
            <span class="adc-action watch">⚪ 觀望</span>
            <span class="adc-code">${s.code} ${s.name}</span>
            <span class="adc-gain ${s.gainPct>=0?'up-color':'dn-color'}">${s.gainPct>=0?'+':''}${s.gainPct.toFixed(1)}%</span>
          </div>
          <div class="adc-reasons">${s.reasons.map(r => `<span class="adc-reason-tag">${r}</span>`).join('')}</div>
        </div>`).join('');
    }

    if (toReduce.length > 0) {
      html += `<div class="alloc-section-title">🟠 建議減碼</div>`;
      html += toReduce.map(s => {
        const sig = SIGNAL.quickEstimate(s);
        return `<div class="alloc-decision-card sell">
          <div class="adc-header">
            <span class="adc-action sell">${sig.short}</span>
            <span class="adc-code">${s.code} ${s.name}</span>
            <span class="adc-gain ${s.gainPct>=0?'up-color':'dn-color'}">${s.gainPct>=0?'+':''}${s.gainPct.toFixed(1)}%</span>
          </div>
          <div class="adc-reasons">${s.reasons.map(r => `<span class="adc-reason-tag warn">${r}</span>`).join('')}</div>
        </div>`;
      }).join('');
    }

    const usedBudget = toBuy.reduce((a, s) => {
      const ratio = Math.max(0.1, s.score) / (totalScore || 1);
      return a + Math.max(0, Math.floor((totalBudget * ratio) / s.price)) * s.price;
    }, 0);
    html += `<div class="alloc-footer">實際使用 ${this._fmtMoney(usedBudget)}，剩餘現金 <strong>${this._fmtMoney(totalBudget - usedBudget)}</strong></div>`;
    el.innerHTML = html;
  },

  _fmtMoney(n) {
    const abs = Math.abs(n);
    if (abs >= 1e6) return (n/1e4).toFixed(1)+'萬';
    if (abs >= 1e4) return (n/1e4).toFixed(2)+'萬';
    return n.toFixed(0)+'元';
  },
};

// ── PIE CHART ─────────────────────────────────────────
const PIE = {
  instance: null,
  miniInstance: null,

  render() {
    this._renderMain();
    this._renderMini();
  },

  _getData() {
    const stocks = APP.portfolio.filter(s => s.price && s.price > 0);
    if (!stocks.length) return null;
    const data = stocks.map(s => s.price * s.shares);
    const total = data.reduce((a, b) => a + b, 0);
    const colors = ['#E24B4A','#1D9E75','#378ADD','#EF9F27','#D4537E','#5DCAA5','#F09595','#9FE1CB','#FAC775','#B5D4F4','#A78BFA','#FB923C'];
    return { stocks, data, total, colors };
  },

  _renderMain() {
    const canvas = document.getElementById('pieChart');
    if (!canvas || !APP.portfolio.length) return;
    const d = this._getData();
    if (!d) return;
    const { stocks, data, total, colors } = d;
    const isDark = !document.body.classList.contains('light-mode');
    const legendColor = isDark ? 'rgba(230,237,243,0.85)' : 'rgba(36,41,47,0.85)';
    if (this.instance) { this.instance.destroy(); this.instance = null; }
    this.instance = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: stocks.map(s => `${s.code} ${s.name}`),
        datasets: [{ data, backgroundColor: colors.slice(0, stocks.length), borderWidth: 2, borderColor: 'var(--bg-1)' }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '55%',
        layout: { padding: { right: 20 } },
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: getComputedStyle(document.body).getPropertyValue('--text-1').trim() || '#e6edf3',
              font: { size: 12 }, padding: 12, boxWidth: 12,
              generateLabels: (chart) => {
                const c = getComputedStyle(document.body).getPropertyValue('--text-1').trim() || '#e6edf3';
                return stocks.map((s, i) => ({
                  text: `${s.code}  ${(data[i]/total*100).toFixed(1)}%`,
                  fillStyle: colors[i % colors.length],
                  strokeStyle: colors[i % colors.length],
                  fontColor: c,
                  hidden: false, index: i,
                }));
              },
            },
          },
          tooltip: { callbacks: { label: ctx => {
            const val = ctx.raw;
            const valDisp = val >= 10000 ? `${(val/10000).toFixed(1)}萬` : `${val.toFixed(0)}元`;
            return ` ${ctx.label}：${valDisp} (${(val/total*100).toFixed(1)}%)`;
          }}},
        },
        onClick: (e, els) => {
          if (!els.length) return;
          const s = stocks[els[0].index];
          if (s) APP.selectStock(s.code, APP.portfolio.indexOf(s), 'portfolio');
        },
      },
    });
  },

  // 迷你版：顯示在 sidebar 投資組合下方
  _renderMini() {
    const canvas = document.getElementById('pieChartMini');
    if (!canvas || !APP.portfolio.length) return;
    const d = this._getData();
    if (!d) return;
    const { stocks, data, total, colors } = d;
    if (this.miniInstance) { this.miniInstance.destroy(); this.miniInstance = null; }
    this.miniInstance = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: stocks.map(s => `${s.code} ${s.name}`),
        datasets: [{ data, backgroundColor: colors.slice(0, stocks.length), borderWidth: 1.5, borderColor: 'var(--bg-1)' }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '50%',
        plugins: {
          legend: {
            position: 'right',
            labels: {
              // 每次 render 動態取顏色，解決深色/淺色模式問題
              color: getComputedStyle(document.body).getPropertyValue('--text-1').trim() || '#e6edf3',
              font: { size: 10 }, padding: 6, boxWidth: 8,
              generateLabels: (chart) => {
                const c = getComputedStyle(document.body).getPropertyValue('--text-1').trim() || '#e6edf3';
                return stocks.map((s, i) => ({
                  text: `${s.code} ${(data[i]/total*100).toFixed(0)}%`,
                  fillStyle: colors[i % colors.length],
                  strokeStyle: colors[i % colors.length],
                  fontColor: c,
                  hidden: false, index: i,
                }));
              },
            },
          },
          tooltip: { callbacks: { label: ctx => {
            const val = ctx.raw;
            const valDisp = val >= 10000 ? `${(val/10000).toFixed(1)}萬` : `${val.toFixed(0)}元`;
            return ` ${(val/total*100).toFixed(1)}%  ${valDisp}`;
          }}},
        },
        onClick: (e, els) => {
          if (!els.length) return;
          const s = stocks[els[0].index];
          if (s) APP.selectStock(s.code, APP.portfolio.indexOf(s), 'portfolio');
        },
      },
    });
  },
};

// ── SYNC module（跨裝置雲端同步 - 全自動）─────────────
const SYNC = {
  API_BASE: 'https://api.jsonbin.io/v3',
  _timer: null,
  _dirty: false,
  _initialized: false,  // ★ 開啟時不允許上傳，直到 init 完成 10 秒後

  getConfig() {
    return {
      apiKey: APP.settings.jsonbinKey || '',
      binId:  APP.settings.jsonbinBin || '',
    };
  },

  // 標記資料已變更，3秒後自動上傳（debounce）
  markDirty() {
    if (!this._initialized) return; // ★ init 完成前不允許排程上傳
    this._dirty = true;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._autoUpload(), 3000);
  },

  async _autoUpload() {
    const { apiKey } = this.getConfig();
    if (!apiKey || !this._dirty) return;
    // ★ 保護：若 portfolio 是空的但有交易記錄，疑似資料遺失，不上傳避免覆蓋雲端有效資料
    if (APP.portfolio.length === 0 && TRADES.get().length > 0) {
      console.warn('[SYNC] 上傳取消：portfolio 為空但有交易記錄，疑似資料遺失');
      this._dirty = false;
      return;
    }
    this._dirty = false;
    const ok = await this.upload(true); // silent = true
    if (ok) this._updateStatus('已同步 ' + new Date().toLocaleTimeString('zh-TW', {hour:'2-digit',minute:'2-digit'}));
  },

  _pack() {
    return {
      portfolio:   APP._twPortfolio,
      watchlist:   APP._twWatchlist,
      usPortfolio: APP._usPortfolio,
      usWatchlist:  APP._usWatchlist,
      trades: TRADES.get(),
      goals: GOALS.get(),
      history: JSON.parse(localStorage.getItem('twsa-value-history') || '[]'),
      syncedAt: new Date().toISOString(),
    };
  },

  _unpack(data) {
    // ★ 修正：直接寫入 _twPortfolio/_usPortfolio，不透過 setter（避免市場判斷干擾）
    if (data.portfolio) {
      APP._twPortfolio = data.portfolio;
      localStorage.setItem('twsa-portfolio', JSON.stringify(data.portfolio));
    }
    if (data.watchlist) {
      APP._twWatchlist = data.watchlist;
      localStorage.setItem('twsa-watchlist', JSON.stringify(data.watchlist));
    }
    if (data.usPortfolio) {
      APP._usPortfolio = data.usPortfolio;
      localStorage.setItem('ussa-portfolio', JSON.stringify(data.usPortfolio));
    }
    if (data.usWatchlist) {
      APP._usWatchlist = data.usWatchlist;
      localStorage.setItem('ussa-watchlist', JSON.stringify(data.usWatchlist));
    }
    if (data.trades) localStorage.setItem('twsa-trades', JSON.stringify(data.trades));
    if (data.goals) localStorage.setItem('twsa-goals', JSON.stringify(data.goals));
    if (data.history) localStorage.setItem('twsa-value-history', JSON.stringify(data.history));
    this._dirty = false;
    clearTimeout(this._timer);
  },

  async upload(silent = false) {
    const { apiKey, binId } = this.getConfig();
    if (!apiKey) {
      if (!silent) showToast('請先在設定中填入 JSONBin API Key');
      return false;
    }
    const data = this._pack();
    try {
      let res;
      if (binId) {
        res = await fetch(`${this.API_BASE}/b/${binId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Master-Key': apiKey },
          body: JSON.stringify(data),
        });
      } else {
        res = await fetch(`${this.API_BASE}/b`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Master-Key': apiKey, 'X-Bin-Name': 'twsa-data', 'X-Bin-Private': 'true' },
          body: JSON.stringify(data),
        });
        if (res.ok) {
          const json = await res.json();
          const newId = json.metadata?.id;
          if (newId) {
            APP.settings.jsonbinBin = newId;
            localStorage.setItem('twsa-settings', JSON.stringify(APP.settings));
            const el = document.getElementById('jsonbin-bin');
            if (el) el.value = newId;
            if (!silent) showToast(`✅ 已建立雲端備份 (Bin ID: ${newId})`);
          }
        }
        return res.ok;
      }
      if (!silent && res.ok) showToast('✅ 已同步到雲端');
      return res.ok;
    } catch(e) {
      if (!silent) showToast(`同步失敗：${e.message}`);
      return false;
    }
  },

  // 智能連接：只需 API Key，自動找到 Bin ID
  async smartConnect(apiKey) {
    if (!apiKey) return false;
    try {
      // 搜尋已有的 bins
      const res = await fetch(`${this.API_BASE}/b?sortOrder=desc`, {
        headers: { 'X-Master-Key': apiKey },
      });
      if (!res.ok) { showToast(`API Key 無效（HTTP ${res.status}）`); return false; }
      const json = await res.json();
      const bins = json;
      // 找名為 twsa-data 的 bin
      const found = Array.isArray(bins) ? bins.find(b => b.snippetMeta?.name === 'twsa-data') : null;
      if (found) {
        APP.settings.jsonbinBin = found.id;
        APP.settings.jsonbinKey = apiKey;
        localStorage.setItem('twsa-settings', JSON.stringify(APP.settings));
        const el = document.getElementById('jsonbin-bin');
        if (el) el.value = found.id;
        showToast(`✅ 已自動找到同步資料，Bin ID: ${found.id}`);
        return true;
      } else {
        showToast('未找到現有資料，請先在電腦端上傳一次');
        return false;
      }
    } catch(e) {
      showToast(`連線失敗：${e.message}`);
      return false;
    }
  },

  // 自動下載：開啟時如果雲端比本機新則自動套用
  // autoDownloadOnStart 已移除：開啟時不自動下載，避免卡住畫面
  // 改用「強制下載」按鈕手動同步，或「自動搜尋資料」按鈕
  autoDownloadOnStart() {
    // 移除自動下載，改為靜默檢查是否有未上傳資料
    setTimeout(() => {
      const { apiKey } = this.getConfig();
      if (apiKey && this._dirty) this._autoUpload();
    }, 5000); // 5秒後再檢查，不影響開啟速度
  },

  async manualDownload() {
    const { apiKey, binId } = this.getConfig();
    if (!apiKey || !binId) { showToast('請先設定 API Key 和 Bin ID'); return; }
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${this.API_BASE}/b/${binId}/latest`, {
        headers: { 'X-Master-Key': apiKey },
        signal: ctrl.signal,
      });
      if (!res.ok) { showToast(`下載失敗：HTTP ${res.status}`); return; }
      const json = await res.json();
      const data = json.record;
      if (data?.portfolio) {
        this._unpack(data);
        APP.renderAll(); TRADES.render(); GOALS.updateDashboard();
        showToast(`✅ 已從雲端下載資料（${new Date(data.syncedAt).toLocaleString('zh-TW')}）`);
      }
    } catch(e) { showToast(`下載失敗：${e.message}`); }
  },

  _updateStatus(msg) {
    const el = document.getElementById('sync-status');
    if (el) { el.textContent = msg; el.style.color = 'var(--green-l)'; }
  },

  updateStatus() {
    const el = document.getElementById('sync-status');
    if (!el) return;
    const { apiKey, binId } = this.getConfig();
    if (apiKey && binId) {
      el.textContent = `✅ 自動同步中 (Bin: ...${binId.slice(-6)})`;
      el.style.color = 'var(--green-l)';
    } else if (apiKey) {
      el.textContent = '⚠️ 有 Key，首次上傳後自動建立 Bin';
      el.style.color = 'var(--amber)';
    } else {
      el.textContent = '未設定（設定 API Key 後自動同步）';
      el.style.color = 'var(--text-3)';
    }
  },
};


// ── 台股細分產業分類表（比 RECOMMEND.CANDIDATES 更細，專供產業集中度分析用）──
// 涵蓋常見台股，會持續視需要擴充；找不到的股票歸類「其他」
const SECTOR_MAP = {
  // 半導體上游（設計/製造）
  '2330':'晶圓代工', '2303':'晶圓代工', '5347':'晶圓代工', '3711':'封測',
  '2454':'IC設計', '3034':'IC設計', '2379':'IC設計', '6415':'IC設計', '3443':'IC設計', '2449':'封測', '8299':'IC設計',
  '2408':'記憶體', '3529':'記憶體', '2337':'記憶體',
  '2481':'功率半導體', '2436':'功率半導體', '8028':'功率半導體',
  // 被動元件
  '2327':'被動元件', '2492':'被動元件', '2375':'被動元件', '3027':'被動元件', '2493':'被動元件',
  // PCB/載板
  '2313':'PCB', '3037':'PCB', '2383':'PCB', '6274':'PCB',
  // 連接器/電源
  '6278':'連接器', '2308':'電源供應/電子零組件', '2404':'連接器',
  // 面板/光電
  '2409':'面板', '3481':'面板', '2354':'光電',
  // 網通/通信設備
  '2345':'網通設備', '3596':'網通設備',
  // AI伺服器/組裝
  '2382':'AI伺服器', '2317':'AI伺服器', '6669':'AI伺服器', '2356':'AI伺服器',
  // 金融
  '2882':'金融保險', '2881':'金融保險', '2891':'金融保險', '2886':'金融保險', '2884':'金融保險', '2891':'金融保險',
  // 電信
  '2412':'電信', '3045':'電信', '4904':'電信',
  // ETF
  '0050':'ETF', '0056':'ETF', '00878':'ETF', '006208':'ETF', '00919':'ETF', '00929':'ETF',
  // 傳產/其他
  '1301':'塑化', '1303':'塑化', '2002':'鋼鐵', '1216':'食品',
  // 美股
  'NVDA':'半導體(美股)', 'AMD':'半導體(美股)', 'ASML':'半導體(美股)', 'TSM':'半導體(美股)',
  'AAPL':'科技(美股)', 'MSFT':'科技(美股)', 'GOOGL':'科技(美股)', 'META':'科技(美股)', 'AMZN':'電商雲端(美股)',
  'TSLA':'電動車(美股)', 'SPY':'ETF(美股)', 'QQQ':'ETF(美股)',
};

function getStockSector(code) {
  if (SECTOR_MAP[code]) return SECTOR_MAP[code];
  const fromCandidates = RECOMMEND?.CANDIDATES?.find(c => c.code === code)?.sector;
  return fromCandidates || '其他';
}

// ── Screener module（全市場選股篩選器）─────────────────
// 掃描全部上市股票（不侷限於RECOMMEND.CANDIDATES這份手寫清單），
// 用當日快照資料（價格變動、本益比、殖利率、三大法人買賣超）做多條件篩選。
// ⚠️ 限制：只能用「當日快照」數據篩選，抓不到每支股票的歷史K線技術指標
// （1000+支股票逐一抓歷史資料量太大），所以RSI/均線交叉這類技術面條件做不到，
// 只能篩「今天的價格變動、估值、法人動向」這幾種批次資料涵蓋的條件。
const Screener = {
  _lastResults: [],

  // ── 評分邏輯（不用使用者設條件，程式自己判斷）─────────
  // 用三大法人買超強度、估值合理性、殖利率組成綜合分數，透明列出每項怎麼算的。
  // ⚠️ 這是用批次快照資料算的簡化評分，不是嚴謹的量化模型，僅供參考起點，不是投資建議。
  _scoreStock(code, s, pe, flow) {
    // 流動性門檻：成交量太低（<100張/日）直接排除，不好買賣、風險高
    if (s.volume < 100000) return null;

    let score = 0;
    const breakdown = [];

    // 1. 三大法人買超強度（滿分40）：外資+投信合計買超股數，用當日成交量正規化
    const netInst = (flow?.foreign ?? 0) + (flow?.trust ?? 0);
    const instRatio = netInst / (s.volume || 1); // 買超占當日成交量的比例
    // ★ 調整比例：原本 *100 太容易頂到滿分上限，很多股票並列同分沒有區分度，
    // 改成 *60（法人淨買超要接近成交量的2/3才會頂滿），拉開差異
    const instScore = Math.max(0, Math.min(40, instRatio * 60));
    if (instScore > 0) breakdown.push(`法人買超 +${instScore.toFixed(0)}分`);
    score += instScore;

    // 2. 估值合理性（滿分30）：本益比落在5~20之間給滿分，越極端扣越多；虧損股(PE無效)給0分
    let valScore = 0;
    if (pe?.pe != null && pe.pe > 0) {
      if (pe.pe >= 5 && pe.pe <= 20) valScore = 30;
      else if (pe.pe < 5) valScore = 15; // 太低有可能有隱藏風險，給一半
      else valScore = Math.max(0, 30 - (pe.pe - 20) * 1); // 超過20，每高1就扣1分
    }
    if (valScore > 0) breakdown.push(`估值合理 +${valScore.toFixed(0)}分`);
    score += valScore;

    // 3. 殖利率（滿分20）：殖利率越高分數越高，上限8%給滿分
    const yieldScore = pe?.yield != null ? Math.min(20, pe.yield / 8 * 20) : 0;
    if (yieldScore > 0) breakdown.push(`殖利率 +${yieldScore.toFixed(0)}分`);
    score += yieldScore;

    // 4. 今日不要漲太多（避免推薦已經噴出去、追高風險高的）：單日漲幅>7%扣分
    let momentumPenalty = 0;
    if (s.chgPct > 7) { momentumPenalty = Math.min(15, (s.chgPct - 7) * 2); score -= momentumPenalty; breakdown.push(`今日漲幅過大 -${momentumPenalty.toFixed(0)}分`); }

    return { score: Math.round(score), breakdown, netInst };
  },

  async autoRecommend() {
    const [snapshot, peData, inst] = await Promise.all([
      DATA.fetchMarketSnapshot(),
      DATA.fetchPERatios(),
      DATA.fetchInstitutional(),
    ]);
    const heldCodes = new Set(APP._twPortfolio.map(s => s.code));

    const results = [];
    for (const code of Object.keys(snapshot)) {
      if (heldCodes.has(code)) continue; // 已經持有的不用再推薦
      const s = snapshot[code];
      const pe = peData[code];
      const flow = inst?.byCode?.[code];
      const scored = this._scoreStock(code, s, pe, flow);
      if (!scored || scored.score <= 0) continue;
      results.push({
        code, name: s.name, close: s.close, chgPct: s.chgPct,
        pe: pe?.pe ?? null, yield: pe?.yield ?? null,
        foreignFlow: flow?.foreign ?? null, trustFlow: flow?.trust ?? null,
        sector: (typeof getStockSector === 'function') ? getStockSector(code) : '其他',
        score: scored.score, breakdown: scored.breakdown, netInst: scored.netInst,
      });
    }
    results.sort((a, b) => b.score - a.score || (b.netInst ?? 0) - (a.netInst ?? 0));
    this._lastResults = results;
    return results;
  },

  async run(filters) {
    const [snapshot, peData, inst] = await Promise.all([
      DATA.fetchMarketSnapshot(),
      DATA.fetchPERatios(),
      DATA.fetchInstitutional(),
    ]);

    const codes = Object.keys(snapshot);
    const results = [];
    for (const code of codes) {
      const s = snapshot[code];
      const pe = peData[code];
      const flow = inst?.byCode?.[code];

      if (filters.minPrice != null && s.close < filters.minPrice) continue;
      if (filters.maxPrice != null && s.close > filters.maxPrice) continue;
      if (filters.minChgPct != null && s.chgPct < filters.minChgPct) continue;
      if (filters.maxChgPct != null && s.chgPct > filters.maxChgPct) continue;
      if (filters.maxPE != null && (!pe?.pe || pe.pe > filters.maxPE)) continue;
      if (filters.minPE != null && (!pe?.pe || pe.pe < filters.minPE)) continue;
      if (filters.minYield != null && (!pe?.yield || pe.yield < filters.minYield)) continue;
      if (filters.foreignBuying && (!flow || flow.foreign <= 0)) continue;
      if (filters.trustBuying && (!flow || flow.trust <= 0)) continue;
      if (filters.minVolume != null && s.volume < filters.minVolume * 1000) continue; // 輸入單位是「張」

      results.push({
        code, name: s.name, close: s.close, chgPct: s.chgPct,
        pe: pe?.pe ?? null, yield: pe?.yield ?? null,
        foreignFlow: flow?.foreign ?? null, trustFlow: flow?.trust ?? null,
        sector: (typeof getStockSector === 'function') ? getStockSector(code) : '其他',
      });
    }

    // 排序：預設依三大法人合計買超由高到低
    results.sort((a, b) => (b.foreignFlow ?? 0) + (b.trustFlow ?? 0) - ((a.foreignFlow ?? 0) + (a.trustFlow ?? 0)));
    this._lastResults = results;
    return results;
  },

  async openModal() {
    const modal = document.getElementById('screener-modal');
    modal.classList.add('show');
    document.getElementById('screener-results').innerHTML = '<div class="empty-state">按上方「🤖 自動推薦」讓系統評分，或展開下方進階選項自己設條件</div>';
  },

  async runAutoRecommend() {
    const resultsEl = document.getElementById('screener-results');
    resultsEl.innerHTML = '<div class="empty-state">計算全市場評分中...</div>';
    const results = await this.autoRecommend();

    if (!results.length) {
      resultsEl.innerHTML = '<div class="empty-state">目前沒有評分>0的推薦標的</div>';
      return;
    }

    const fmtShares = n => n == null ? '—' : `${n>=0?'+':''}${(n/1000).toFixed(0)}張`;
    resultsEl.innerHTML = `
      <div class="form-note" style="margin-bottom:8px">⚠️ 這是用批次快照資料算的簡化評分（法人買超+估值+殖利率+動能），不是嚴謹量化模型，僅供參考起點，請自行判斷。排除你已持有的股票，顯示前30檔。</div>
      ${results.slice(0, 30).map(r => `
        <div class="screener-row" onclick="Screener.viewStock('${r.code}')">
          <div class="screener-row-main">
            <span class="screener-score">${r.score}分</span>
            <span class="screener-code">${r.code}</span>
            <span class="screener-name">${r.name}</span>
            <span class="screener-sector">${r.sector}</span>
          </div>
          <div class="screener-row-stats">
            <span class="${r.chgPct>=0?'up-color':'dn-color'}">${r.close} (${r.chgPct>=0?'+':''}${r.chgPct}%)</span>
            <span>PE ${r.pe ?? '—'}</span>
            <span>殖利率 ${r.yield ?? '—'}%</span>
            <span style="color:${(r.foreignFlow??0)>=0?'#E24B4A':'#1D9E75'}">外資${fmtShares(r.foreignFlow)}</span>
          </div>
          <div class="screener-breakdown">${r.breakdown.join('　')}</div>
        </div>`).join('')}
    `;
  },

  async runFromModal() {
    const el = id => document.getElementById(id).value.trim();
    const num = v => v === '' ? null : parseFloat(v);
    const filters = {
      minPrice: num(el('scr-min-price')),
      maxPrice: num(el('scr-max-price')),
      minChgPct: num(el('scr-min-chg')),
      maxChgPct: num(el('scr-max-chg')),
      minPE: num(el('scr-min-pe')),
      maxPE: num(el('scr-max-pe')),
      minYield: num(el('scr-min-yield')),
      foreignBuying: document.getElementById('scr-foreign-buying').checked,
      trustBuying: document.getElementById('scr-trust-buying').checked,
      minVolume: num(el('scr-min-volume')),
    };

    const resultsEl = document.getElementById('screener-results');
    resultsEl.innerHTML = '<div class="empty-state">掃描全市場中...</div>';
    const results = await this.run(filters);

    if (!results.length) {
      resultsEl.innerHTML = '<div class="empty-state">沒有符合條件的股票，試著放寬篩選條件</div>';
      return;
    }

    const fmtShares = n => n == null ? '—' : `${n>=0?'+':''}${(n/1000).toFixed(0)}張`;
    resultsEl.innerHTML = `
      <div class="form-note" style="margin-bottom:8px">找到 ${results.length} 檔符合條件，顯示前50檔（依三大法人買超排序）</div>
      ${results.slice(0, 50).map(r => `
        <div class="screener-row" onclick="Screener.viewStock('${r.code}')">
          <div class="screener-row-main">
            <span class="screener-code">${r.code}</span>
            <span class="screener-name">${r.name}</span>
            <span class="screener-sector">${r.sector}</span>
          </div>
          <div class="screener-row-stats">
            <span class="${r.chgPct>=0?'up-color':'dn-color'}">${r.close} (${r.chgPct>=0?'+':''}${r.chgPct}%)</span>
            <span>PE ${r.pe ?? '—'}</span>
            <span>殖利率 ${r.yield ?? '—'}%</span>
            <span style="color:${(r.foreignFlow??0)>=0?'#E24B4A':'#1D9E75'}">外資${fmtShares(r.foreignFlow)}</span>
          </div>
        </div>`).join('')}
    `;
  },

  viewStock(code) {
    closeModal('screener-modal');
    openWatchlistModal();
    setTimeout(() => {
      const codeInput = document.getElementById('w-code');
      if (codeInput) { codeInput.value = code; codeInput.dispatchEvent(new Event('input')); codeInput.focus(); }
    }, 50);
  },
};

// ── Backtest module（投資組合回測沙盒，台美股都支援）────
// ⚠️ 核心原則：完全重複使用 ANALYSIS._calcIndicators / _calcScore / SIGNAL.fromScore，
// 不另外寫一套邏輯——回測的是「現有系統的訊號」，不是另一個模型。
// ⚠️ 訊號在第N天收盤後才算得出來，成交一律用第N+1天開盤價，避免用到當天收盤那個
// 「訊號出現當下不可能拿到」的價格（偷看未來）。
// ⚠️ 樣本內測試限制：這是同一批用來調整訊號門檻的歷史資料，好看的回測結果不能
// 完全排除「湊巧貼合這段歷史」的可能，不是保證對未來同樣有效。
// ⚠️ VIX：無法取得逐日歷史VIX資料，回測中一律當作0（不調整），這跟即時系統會用
// 當下VIX微調不同，是已知的簡化，不是誤差。
// ── HistoricalAnalogUI（歷史相似情境比對的畫面呈現）─────
const HistoricalAnalogUI = {
  async toggle() {
    const body = document.getElementById('analog-body');
    const hint = document.getElementById('analog-toggle-hint');
    const isOpen = body.style.display !== 'none';
    if (isOpen) {
      body.style.display = 'none';
      hint.textContent = '點擊展開';
      return;
    }
    body.style.display = 'block';
    hint.textContent = '計算中...';
    body.innerHTML = '<div class="empty-state">分析歷史相似情境中...</div>';

    const symbol = APP.activeSymbol;
    if (!symbol) { body.innerHTML = '<div class="empty-state">請先選擇股票</div>'; hint.textContent='點擊展開'; return; }

    try {
      const candles = CHART.currentData?.length ? CHART.currentData : await DATA.fetchHistory(symbol, '2y');
      const result = HistoricalAnalog.find(candles);
      hint.textContent = '點擊收合';
      if (result.error) { body.innerHTML = `<div class="empty-state">${result.error}</div>`; return; }
      this._render(body, result);
    } catch(e) {
      body.innerHTML = '<div class="empty-state">計算失敗，稍後重試</div>';
      hint.textContent = '點擊展開';
    }
  },

  _render(body, r) {
    const color = r.avgReturn >= 0 ? '#E24B4A' : '#1D9E75';
    body.innerHTML = `
      <div class="form-note" style="margin-bottom:10px">⚠️ 找歷史上技術面組合（RSI/ADX/區間位置/量比/乖離）跟現在最相似的${r.sampleSize}個時間點，秀出「那之後${HistoricalAnalog.HORIZON_DAYS}個交易日實際發生了什麼」，是真實發生過的數字，不是模型推算的。樣本數少（從${r.totalCandidatesScanned ?? r.totalScanned}個候選日挑出來），歷史相似不代表未來會重演，僅供參考。</div>
      <div class="analog-summary">
        <div class="analog-summary-item"><span class="analog-summary-label">平均報酬</span><span class="analog-summary-num" style="color:${color}">${r.avgReturn>=0?'+':''}${r.avgReturn}%</span></div>
        <div class="analog-summary-item"><span class="analog-summary-label">正報酬比例</span><span class="analog-summary-num">${r.winRate}%</span></div>
        <div class="analog-summary-item"><span class="analog-summary-label">最佳情況</span><span class="analog-summary-num" style="color:#E24B4A">+${r.bestCase}%</span></div>
        <div class="analog-summary-item"><span class="analog-summary-label">最差情況</span><span class="analog-summary-num" style="color:#1D9E75">${r.worstCase}%</span></div>
      </div>
      <div class="analog-list">
        ${r.matches.map(m => `
          <div class="analog-row">
            <span class="analog-date">${m.date}</span>
            <span class="analog-dist" title="相似度距離，越小越像">相似度 ${(100 - Math.min(100, m.dist*100)).toFixed(0)}%</span>
            <span class="analog-pct" style="color:${m.pctChange>=0?'#E24B4A':'#1D9E75'}">${m.pctChange>=0?'+':''}${m.pctChange}%（${HistoricalAnalog.HORIZON_DAYS}日後）</span>
          </div>`).join('')}
      </div>
    `;
  },
};

const Backtest = {
  RANGE_OPTIONS: [
    { label: '近3個月', days: 63 },
    { label: '近6個月', days: 126 },
    { label: '近1年', days: 252 },
  ],
  LOOKBACK_BUFFER: 250, // 往前多抓的緩衝天數，讓MA240等長週期指標在回測起點就有效
  COOLDOWN_DAYS: 7, // ★ 冷卻期：某股票賣出後N個交易日內不能重新買進，減少訊號巴來巴去的頻繁進出

  // 台美股手續費/稅制差異：美股無交易手續費、無證交稅（實際上美股券商可能有其他費用，
  // 但這裡先用最單純的假設，避免引入我們不確定的規則）；台股沿用現有的費率邏輯
  _tradeCost(market, tradeValue, code) {
    if (market === 'US') return { fee: 0, tax: 0 };
    const isETF = /^00\d{2,4}$/.test(code);
    const taxRate = isETF ? 0.001 : 0.003;
    const fee = Math.max(20, Math.round(tradeValue * 0.001425));
    const tax = Math.round(tradeValue * taxRate);
    return { fee, tax };
  },

  async run(rangeDays, mode, market, useCooldown = true) {
    // mode: 'long' | 'short'　market: 'TW' | 'US'
    const portfolio = market === 'US' ? APP._usPortfolio : APP._twPortfolio;
    if (!portfolio || !portfolio.length) return null;

    const perStock = {};
    const skipped = []; // 記錄被排除的股票，之後要清楚告訴使用者
    for (const s of portfolio) {
      try {
        const data = await DATA.fetchHistory(s.code, '2y');
        // ★ 修正關鍵bug：如果抓取失敗，DATA.fetchHistory 會回傳「假資料」（只有60根K線）當保底，
        // 之前的判斷門檻(<60)沒有擋住這個，導致假資料混進來，把 minLen 拖到60，
        // 害整個回測（其他10支股票資料都是好的）被誤判成「資料不足」而失敗。
        // 改成要求至少200根K線（真實2年資料應該有~480+根，60根明顯是假資料的特徵），
        // 不夠的話直接把這支股票排除在這次回測之外，不要讓它拖累其他股票。
        if (!data || data.length < 200) { skipped.push(s.code); continue; }
        perStock[s.code] = { name: s.name, candles: data };
      } catch(e) { skipped.push(s.code); }
    }
    const codes = Object.keys(perStock);
    if (!codes.length) return null;
    if (skipped.length) console.warn(`[Backtest] 資料不足被排除的股票: ${skipped.join(', ')}`);

    const minLen = Math.min(...codes.map(c => perStock[c].candles.length));
    const startIdx = Math.max(this.LOOKBACK_BUFFER, minLen - rangeDays);
    if (startIdx >= minLen - 1) return null;

    const totalCapital = portfolio.reduce((sum, s) => sum + (s.price ?? s.cost) * s.shares, 0) || (market === 'US' ? 100000 : 1000000);
    const perStockBudget = totalCapital / codes.length;
    let cash = totalCapital;
    const positions = {};
    const trades = [];
    const equityCurve = [];
    const pendingOrders = {};
    const lastSellIdx = {}; // 記錄每支股票最近一次賣出是第幾天，供冷卻期判斷用

    codes.forEach(c => { positions[c] = { shares: 0, avgCost: 0 }; });

    for (let i = startIdx; i < minLen; i++) {
      // ★ 修正：整個模擬迴圈完全同步運算，1年份資料(250天×多支股票×2種模式)會
      // 鎖住主執行緒好幾秒甚至更久，瀏覽器會沒有回應。每處理20天就讓出一次主執行緒，
      // 讓畫面不會被鎖死、使用者還能看到「計算中」的提示持續在跳動。
      if ((i - startIdx) % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));

      const buySignalsToday = [];
      for (const code of codes) {
        const order = pendingOrders[code];
        if (!order) continue;
        const candles = perStock[code].candles;
        if (i >= candles.length) continue;
        const openPrice = candles[i].o;
        if (order === 'buy') {
          buySignalsToday.push({ code, openPrice, tier: pendingOrders[code + '_tier'] ?? 4 });
        } else if (order === 'sell') {
          const pos = positions[code];
          if (pos.shares > 0) {
            const proceeds = pos.shares * openPrice;
            const { fee, tax } = this._tradeCost(market, proceeds, code);
            const net = proceeds - fee - tax;
            cash += net;
            trades.push({ code, name: perStock[code].name, action: 'sell', date: this._fmtDate(candles[i].t), price: openPrice, shares: pos.shares, pnl: net - pos.shares * pos.avgCost });
            positions[code] = { shares: 0, avgCost: 0 };
            lastSellIdx[code] = i; // ★ 記錄賣出當天的索引，冷卻期從這天開始算
          }
        }
        delete pendingOrders[code];
        delete pendingOrders[code + '_tier'];
      }
      buySignalsToday.sort((a, b) => b.tier - a.tier);
      for (const buy of buySignalsToday) {
        const budget = Math.min(perStockBudget, cash);
        if (budget < buy.openPrice * (market === 'US' ? 1 : 10)) continue; // 台股至少湊得起零股/1股才進場的粗略門檻
        const { fee: feeEst } = this._tradeCost(market, budget, buy.code);
        // ★ 台股整張(1000股)為單位、不足1000股用零股概估；美股可買到1股
        let shares;
        if (market === 'US') {
          shares = Math.floor((budget - feeEst) / buy.openPrice);
        } else {
          const lot = Math.floor((budget - feeEst) / buy.openPrice / 1000) * 1000;
          shares = lot > 0 ? lot : Math.floor((budget - feeEst) / buy.openPrice); // 資金不夠買整張就買零股概估
        }
        if (shares <= 0) continue;
        const cost = shares * buy.openPrice;
        const { fee } = this._tradeCost(market, cost, buy.code);
        if (cost + fee > cash) continue;
        cash -= (cost + fee);
        positions[buy.code] = { shares, avgCost: buy.openPrice };
        trades.push({ code: buy.code, name: perStock[buy.code].name, action: 'buy', date: this._fmtDate(perStock[buy.code].candles[i].t), price: buy.openPrice, shares, pnl: null });
      }

      for (const code of codes) {
        const candles = perStock[code].candles;
        if (i >= candles.length) continue;
        const slice = candles.slice(0, i + 1);
        if (slice.length < 30) continue;
        let ind;
        try { ind = ANALYSIS._calcIndicators(slice); } catch(e) { continue; }
        const score = ANALYSIS._calcScore(ind);
        const pos = positions[code];
        const gainPct = pos.shares > 0 ? (ind.last.c - pos.avgCost) / pos.avgCost * 100 : 0;
        const supportBreak = ind.last.c < (ind.support || 0) * 0.98;
        const sig = SIGNAL.fromScore(score, gainPct, supportBreak, mode);

        // ★ 冷卻期：剛賣出這支股票沒多久，就算訊號又轉強也先不要馬上買回去，
        // 避免同一支股票短期內反覆進出（先前用「市場狀態修正」測試沒有明顯改善，
        // 改成直接針對「買賣過於頻繁」這個症狀下手）
        const daysSinceSell = lastSellIdx[code] != null ? i - lastSellIdx[code] : Infinity;
        const inCooldown = useCooldown && daysSinceSell < this.COOLDOWN_DAYS;

        if (pos.shares === 0 && sig.tier >= 4 && !inCooldown) {
          pendingOrders[code] = 'buy';
          pendingOrders[code + '_tier'] = sig.tier;
        } else if (pos.shares > 0 && sig.tier <= 2) {
          pendingOrders[code] = 'sell';
        }
      }

      let portValue = cash;
      codes.forEach(code => {
        const pos = positions[code];
        if (pos.shares > 0 && i < perStock[code].candles.length) {
          portValue += pos.shares * perStock[code].candles[i].c;
        }
      });
      equityCurve.push({ date: this._fmtDate(perStock[codes[0]].candles[i].t), value: portValue });
    }

    const buyHoldCurve = [];
    let bhCash = totalCapital;
    const bhShares = {};
    codes.forEach(code => {
      const startPrice = perStock[code].candles[startIdx].o;
      const budget = totalCapital / codes.length;
      const shares = market === 'US' ? Math.floor(budget / startPrice) : Math.floor(budget / startPrice);
      bhShares[code] = shares;
      bhCash -= shares * startPrice;
    });
    for (let i = startIdx; i < minLen; i++) {
      let v = bhCash;
      codes.forEach(code => { if (i < perStock[code].candles.length) v += bhShares[code] * perStock[code].candles[i].c; });
      buyHoldCurve.push({ date: this._fmtDate(perStock[codes[0]].candles[i].t), value: v });
    }

    const finalValue = equityCurve[equityCurve.length-1]?.value ?? totalCapital;
    const totalReturn = (finalValue - totalCapital) / totalCapital * 100;
    const bhFinal = buyHoldCurve[buyHoldCurve.length-1]?.value ?? totalCapital;
    const bhReturn = (bhFinal - totalCapital) / totalCapital * 100;
    const sellTrades = trades.filter(t => t.action === 'sell');
    const winTrades = sellTrades.filter(t => t.pnl > 0);
    const winRate = sellTrades.length ? (winTrades.length / sellTrades.length * 100) : null;
    let peak = totalCapital, maxDrawdown = 0;
    equityCurve.forEach(p => { peak = Math.max(peak, p.value); maxDrawdown = Math.max(maxDrawdown, (peak - p.value) / peak * 100); });

    return {
      mode, market, startDate: equityCurve[0]?.date, endDate: equityCurve[equityCurve.length-1]?.date,
      totalReturn, bhReturn, winRate, tradeCount: sellTrades.length,
      maxDrawdown, equityCurve, buyHoldCurve, trades, totalCapital, finalValue, skipped,
    };
  },

  _fmtDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  },

  toggle() {
    const bt = document.getElementById('backtest-content');
    const isShowing = bt.style.display !== 'none';
    if (isShowing) {
      showMainView('detail');
      if (!APP.activeSymbol && APP.portfolio.length) APP.selectStock(APP.portfolio[0].code, 0, 'portfolio');
    } else {
      showMainView('backtest');
      document.getElementById('bt-body').innerHTML = '<div class="empty-state">選擇市場、回測期間後按「開始回測」</div>';
    }
  },

  _setRange(idx) {
    document.querySelectorAll('.bt-range-btn').forEach(b => b.classList.toggle('active', b.dataset.idx === String(idx)));
  },

  _setMarket(m) {
    document.querySelectorAll('.bt-market-btn').forEach(b => b.classList.toggle('active', b.dataset.market === m));
  },

  async runFromUI() {
    const rangeIdx = parseInt(document.querySelector('.bt-range-btn.active')?.dataset.idx ?? '1');
    const rangeDays = this.RANGE_OPTIONS[rangeIdx].days;
    const market = document.querySelector('.bt-market-btn.active')?.dataset.market ?? 'TW';
    const useCooldown = document.getElementById('bt-use-cooldown')?.checked ?? true;
    const body = document.getElementById('bt-body');
    body.innerHTML = '<div class="empty-state">回測計算中，需要抓取每支持股的完整歷史資料，請稍候...</div>';

    // ★ 修正：兩個模式改成依序執行，不要用 Promise.all 並行——
    // 實測發現並行時，兩邊同時對同一批股票抓歷史資料，會互相干擾導致其中一個意外失敗
    // （共用的資料快取機制沒有處理好同時重複請求同一支股票的情況）
    const longResult = await this.run(rangeDays, 'long', market, useCooldown);
    const shortResult = await this.run(rangeDays, 'short', market, useCooldown);

    if (!longResult && !shortResult) {
      body.innerHTML = `<div class="empty-state">資料不足，無法回測（可能持股歷史資料不夠長，或目前沒有${market==='US'?'美股':'台股'}持股）</div>`;
      return;
    }
    this._renderResults(longResult, shortResult, market, useCooldown);
  },

  _renderResults(longResult, shortResult, market, useCooldown) {
    const body = document.getElementById('bt-body');
    const isUS = market === 'US';
    const cur = isUS ? '$' : 'NT$';
    const renderOne = (r, label) => {
      if (!r) return `<div class="empty-state">${label}：資料不足</div>`;
      const outperform = r.totalReturn - r.bhReturn;
      return `
        <div class="perf-card" style="margin-bottom:14px">
          <div class="perf-card-title">${label}（${r.startDate} ～ ${r.endDate}）</div>
          ${r.skipped?.length ? `<div class="form-note" style="margin-bottom:8px;color:#eab308">⚠️ ${r.skipped.join('、')} 這次資料抓取失敗，已排除在這次回測外（沒有用假資料湊數）</div>` : ''}
          <div class="perf-grid" style="margin-bottom:10px">
            <div class="perf-stat-row"><span class="perf-stat-name">訊號策略總報酬</span><span class="perf-stat-num" style="color:${r.totalReturn>=0?'#E24B4A':'#1D9E75'}">${r.totalReturn>=0?'+':''}${r.totalReturn.toFixed(1)}%</span></div>
            <div class="perf-stat-row"><span class="perf-stat-name">單純買進持有（對照組）</span><span class="perf-stat-num" style="color:${r.bhReturn>=0?'#E24B4A':'#1D9E75'}">${r.bhReturn>=0?'+':''}${r.bhReturn.toFixed(1)}%</span></div>
            <div class="perf-stat-row"><span class="perf-stat-name">超額報酬</span><span class="perf-stat-num" style="color:${outperform>=0?'#E24B4A':'#1D9E75'}">${outperform>=0?'+':''}${outperform.toFixed(1)}%</span></div>
            <div class="perf-stat-row"><span class="perf-stat-name">交易次數（完整買賣一輪）</span><span class="perf-stat-num">${r.tradeCount}</span></div>
            <div class="perf-stat-row"><span class="perf-stat-name">勝率</span><span class="perf-stat-num">${r.winRate!=null ? r.winRate.toFixed(0)+'%' : '—（無已平倉交易）'}</span></div>
            <div class="perf-stat-row"><span class="perf-stat-name">最大回撤</span><span class="perf-stat-num" style="color:#1D9E75">-${r.maxDrawdown.toFixed(1)}%</span></div>
          </div>
          <div class="perf-big-canvas-wrap" style="height:180px"><canvas id="bt-canvas-${label}"></canvas></div>
        </div>`;
    };

    body.innerHTML = `
      <div class="form-note" style="margin-bottom:14px">⚠️ 這是用你目前${isUS?'美股':'台股'}持股的歷史資料回測「現有買賣訊號邏輯」，不是另外訓練的模型。訊號在收盤後才算得出來，成交一律用「隔天開盤價」，避免用到不可能拿到的價格。這份資料也是調整訊號門檻時參考過的同一批歷史資料，好看的結果不能排除「湊巧貼合過去」，不保證對未來同樣有效。${isUS ? '美股假設無交易手續費、無交易稅（實際費用依券商而定，這裡是簡化假設）。' : '手續費、證交稅已計入。'}　${useCooldown ? `✅ 已套用${Backtest.COOLDOWN_DAYS}天冷卻期（賣出後短期內不重新買進）。` : '⬜ 未套用冷卻期（原始訊號邏輯）。'}</div>
      ${renderOne(longResult, '長線模式')}
      ${renderOne(shortResult, '短線模式')}
    `;

    if (longResult) this._drawEquityChart('bt-canvas-長線模式', longResult);
    if (shortResult) this._drawEquityChart('bt-canvas-短線模式', shortResult);
  },

  _drawEquityChart(canvasId, r) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const W = wrap.clientWidth || 600, H = 180;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0,0,W,H);

    const PAD = { l:56, r:12, t:10, b:20 };
    const chartW = W-PAD.l-PAD.r, chartH = H-PAD.t-PAD.b;
    const allVals = [...r.equityCurve.map(p=>p.value), ...r.buyHoldCurve.map(p=>p.value)];
    const minV = Math.min(...allVals), maxV = Math.max(...allVals);
    const range = (maxV-minV) || 1;
    const n = r.equityCurve.length;
    const xOf = i => PAD.l + (i/(n-1)) * chartW;
    const yOf = v => PAD.t + chartH - ((v-minV)/range) * chartH;

    const isDark = !document.body.classList.contains('light-mode');
    ctx.font = '11px sans-serif'; ctx.textAlign='right'; ctx.fillStyle = isDark?'#8b949e':'#57606a';
    [0,0.5,1].forEach(f => {
      const y = PAD.t + f*chartH;
      ctx.strokeStyle = isDark?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.1)';
      ctx.beginPath(); ctx.moveTo(PAD.l,y); ctx.lineTo(W-PAD.r,y); ctx.stroke();
      ctx.fillText(Math.round(maxV-f*range).toLocaleString(), PAD.l-6, y+4);
    });

    const drawLine = (curve, color) => {
      ctx.beginPath();
      curve.forEach((p,i) => { const x=xOf(i), y=yOf(p.value); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    };
    drawLine(r.buyHoldCurve, '#8b949e');
    drawLine(r.equityCurve, '#378ADD');
  },
};

const RECOMMEND = {
  CANDIDATES: [
    // ── 台股 ──
    { code:'0050',   name:'元大台灣50',     sector:'ETF',    type:'ETF',    risk:'低',   horizon:'長線', market:'TW', reason:'追蹤台灣前50大市值，長期持有最穩健，年化約8-12%。', logic:'定期定額，適合作為核心部位（建議佔比30-50%）。', shortNote:null },
    { code:'0056',   name:'元大高股息',     sector:'ETF',    type:'ETF',    risk:'低',   horizon:'長線', market:'TW', reason:'高股息策略，每年穩定配息，適合長期存股。', logic:'股息再投入複利效果佳。', shortNote:null },
    { code:'00878',  name:'國泰永續高股息', sector:'ETF',    type:'ETF',    risk:'低',   horizon:'長線', market:'TW', reason:'ESG+高股息雙重篩選，月月配息。', logic:'適合需要穩定現金流的長期投資人。', shortNote:null },
    { code:'006208', name:'富邦台50',       sector:'ETF',    type:'ETF',    risk:'低',   horizon:'長線', market:'TW', reason:'與0050相近但管理費更低。', logic:'低費用率讓長期複利效果更好。', shortNote:null },
    { code:'2330',   name:'台積電',         sector:'半導體',  type:'權值股', risk:'中',   horizon:'長線', market:'TW', reason:'全球最先進晶圓代工，AI/HPC需求持續驅動，護城河極深。', logic:'台股不可缺少的核心持股，長期向上。', shortNote:'逢大跌（跌幅>8%）為短線好買點，反彈快。' },
    { code:'2454',   name:'聯發科',         sector:'半導體',  type:'成長股', risk:'中',   horizon:'長短', market:'TW', reason:'手機AP+AI晶片雙引擎，AI on device最大受惠者。', logic:'有回檔即為好機會，技術面修正後往往快速反彈。', shortNote:'📌 短線機會：回檔10-15%後搭配KD低檔黃金交叉為進場訊號。' },
    { code:'2303',   name:'聯電',           sector:'半導體',  type:'存股',   risk:'中',   horizon:'長線', market:'TW', reason:'成熟製程需求穩定，車用/工業用晶片長期支撐。', logic:'殖利率佳，適合長期存股兼具成長潛力。', shortNote:null },
    { code:'2382',   name:'廣達',           sector:'電子',   type:'成長股', risk:'中',   horizon:'長短', market:'TW', reason:'AI伺服器最大受惠者之一，GB200訂單強勁。', logic:'AI基礎建設需求爆發，長期成長能見度高。', shortNote:'📌 短線機會：AI題材消息面回調時為買點，波段約10-20%。' },
    { code:'2317',   name:'鴻海',           sector:'電子',   type:'權值股', risk:'中',   horizon:'長短', market:'TW', reason:'積極布局電動車和AI伺服器，本益比低。', logic:'殖利率穩定，電動車轉型為長期催化劑。', shortNote:'📌 短線機會：法說會前後常有波段，回檔至季線附近為買點。' },
    { code:'2882',   name:'國泰金',         sector:'金融',   type:'存股',   risk:'低中', horizon:'長線', market:'TW', reason:'台灣最大壽險，股息穩定，利率上升環境有利。', logic:'長期存股，每年穩定配息。', shortNote:null },
    { code:'2412',   name:'中華電',         sector:'電信',   type:'存股',   risk:'低',   horizon:'長線', market:'TW', reason:'台灣最大電信，現金流穩定，殖利率4-5%。', logic:'景氣不佳時的避風港，防禦部位。', shortNote:null },
    // ── 美股 ──
    { code:'SPY',  name:'S&P 500 ETF',    sector:'ETF',    type:'ETF',    risk:'低',   horizon:'長線', market:'US', reason:'追蹤S&P500，美股最核心的長期持有標的，年化約10%。', logic:'定期定額，適合作為美股核心部位。', shortNote:null },
    { code:'QQQ',  name:'Nasdaq 100 ETF', sector:'ETF',    type:'ETF',    risk:'低中', horizon:'長線', market:'US', reason:'追蹤那斯達克100，科技股集中，長期成長性強。', logic:'科技偏重者首選，搭配SPY做多元配置。', shortNote:'📌 短線：市場情緒回落時波動大，可短線布局。' },
    { code:'AAPL', name:'Apple',          sector:'科技',   type:'權值股', risk:'低中', horizon:'長線', market:'US', reason:'全球市值最大公司，硬體+服務雙引擎，現金流穩定。', logic:'長期持有，Apple Intelligence帶動換機潮。', shortNote:null },
    { code:'NVDA', name:'NVIDIA',         sector:'半導體',  type:'成長股', risk:'中高', horizon:'長短', market:'US', reason:'AI GPU龍頭，資料中心需求爆發，護城河深厚。', logic:'AI浪潮核心受惠者，長期持有邏輯最強。', shortNote:'📌 短線：財報前後常有大波動，可波段操作。' },
    { code:'MSFT', name:'Microsoft',      sector:'科技',   type:'權值股', risk:'低中', horizon:'長線', market:'US', reason:'雲端Azure+Copilot AI雙驅動，獲利穩定成長。', logic:'最穩健的科技成長股，適合長期核心配置。', shortNote:null },
    { code:'AMZN', name:'Amazon',         sector:'電商/雲', type:'成長股', risk:'中',   horizon:'長線', market:'US', reason:'AWS雲端霸主+電商復甦，AI基礎建設大受惠。', logic:'多元業務護城河，長期成長確定性高。', shortNote:null },
    { code:'GOOGL',name:'Alphabet',       sector:'科技',   type:'成長股', risk:'中',   horizon:'長線', market:'US', reason:'搜尋+YouTube+雲端GCP，AI整合持續深化。', logic:'廣告收入穩健+雲端成長，本益比合理。', shortNote:null },
    { code:'META', name:'Meta',           sector:'科技',   type:'成長股', risk:'中',   horizon:'長短', market:'US', reason:'廣告收入強勁，AI推薦算法驅動用戶黏著度，元宇宙長期佈局。', logic:'短期廣告景氣+長期AI紅利。', shortNote:'📌 短線：廣告旺季（Q4）前布局，財報後常有大漲。' },
    { code:'TSLA', name:'Tesla',          sector:'電動車', type:'成長股', risk:'高',   horizon:'短線', market:'US', reason:'電動車+Robotaxi+能源儲存，願景大但波動極高。', logic:'高風險高報酬，適合短線波段操作。', shortNote:'📌 純短線：技術面突破或財報驅動，嚴設停損10%。' },
    { code:'BRK-B',name:'Berkshire B',    sector:'金融',   type:'價值股', risk:'低',   horizon:'長線', market:'US', reason:'巴菲特旗下多元持股，穩健價值投資標的。', logic:'波動低，長期複利，適合保守型美股配置。', shortNote:null },
  ],

  get activeCandidates() {
    return this.CANDIDATES.filter(c => c.market === APP.activeMarket);
  },

  run() {
    const el = document.getElementById('rec-result');
    if (!el) return;
    const portfolio = APP.portfolio;
    const goals = GOALS.get();
    const ownedCodes = new Set(portfolio.map(s => s.code));
    const filter = document.getElementById('rec-filter')?.value || 'all';

    const sectorMap = {};
    portfolio.forEach(s => {
      const match = this.activeCandidates.find(c => c.code === s.code);
      if (match) sectorMap[match.sector] = (sectorMap[match.sector]||0) + 1;
    });

    const scored = this.activeCandidates
      .filter(c => !ownedCodes.has(c.code))
      .filter(c => {
        if (filter === 'long')  return c.horizon === '長線' || c.horizon === '長短';
        if (filter === 'short') return c.horizon === '短線' || c.horizon === '長短';
        return true;
      })
      .map(c => {
        let score = 0;
        if (c.type === 'ETF') score += 3;
        if (c.risk === '低') score += 2;
        else if (c.risk === '低中') score += 1;
        if (!sectorMap[c.sector]) score += 2;
        if (goals.years >= 2 && (c.type==='ETF'||c.type==='存股')) score += 1;
        if (c.shortNote && filter !== 'long') score += 1;
        return { ...c, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    if (!scored.length) {
      el.innerHTML = '<div class="rec-card"><div class="rec-body">你已持有所有推薦標的！</div></div>';
      return;
    }

    // ★ 問題8：先顯示 loading，背景抓取所有推薦股票報價
    const missingCodes = scored.filter(c => !DATA.priceStore[c.code]?.price).map(c => c.code);
    if (missingCodes.length > 0) {
      el.innerHTML = `<div style="padding:16px;color:var(--text-3);font-size:12px;text-align:center">⏳ 正在抓取推薦股票報價（${scored.length} 檔）...</div>`;
      DATA.batchUpdate(missingCodes).then(() => this._renderCards(scored, goals, el));
    } else {
      this._renderCards(scored, goals, el);
    }
  },

  _renderCards(scored, goals, el) {
    const riskColor = { '低':'#1D9E75','低中':'#5DCAA5','中':'#EF9F27','中高':'#E24B4A','高':'#E24B4A' };
    const horizonLabel = { '長線':'長期', '短線':'短線', '長短':'長短' };
    const horizonCls = { '長線':'horizon-long','短線':'horizon-short','長短':'horizon-both' };
    const budget = parseFloat(document.getElementById('rec-budget')?.value) || 0;
    const budgetPerStock = budget > 0 ? budget / scored.length : 0;
    const isUS = APP.activeMarket === 'US';

    el.innerHTML = `
      <div class="rec-meta">根據你的目標（${(goals.target/10000).toFixed(0)}萬/${goals.years}年）與持股結構推薦：</div>
      ${scored.map((c, i) => {
        // ★ 從 priceStore 取最新報價
        const q = DATA.priceStore[c.code];
        const livePrice = q?.price || null;
        const chgPct = q?.chgPct ?? null;
        const priceDisplay = livePrice
          ? `${isUS ? '$' : 'NT$'}${livePrice.toLocaleString('zh-TW', {maximumFractionDigits:2})}`
          : '—';
        const chgDisplay = chgPct != null
          ? `<span class="${chgPct>=0?'up-color':'dn-color'}" style="font-size:11px"> ${chgPct>=0?'+':''}${chgPct.toFixed(2)}%</span>`
          : '';

        let orderHtml = '';
        if (budgetPerStock > 0 && livePrice) {
          // ★ 美股：預算是台幣，livePrice 是 USD，需換算後再算股數
          const livePriceTWD = isUS ? livePrice * (CURRENCY.usdRate || 31.5) : livePrice;
          const shares = Math.max(1, Math.floor(budgetPerStock / livePriceTWD));
          const costTWD = shares * livePriceTWD;
          const costUSD = isUS ? shares * livePrice : null;
          const fee = isUS ? 0 : Math.max(20, Math.round(costTWD * 0.001425));
          const sd = isUS ? `${shares}股` : (shares >= 1000 ? `${(shares/1000).toFixed(1)}張` : `${shares}股`);
          const costDisp = isUS
            ? `US$${costUSD.toFixed(0)} (≈${costTWD >= 10000 ? (costTWD/10000).toFixed(1)+'萬' : costTWD.toFixed(0)+'元'})`
            : (costTWD >= 10000 ? `${(costTWD/10000).toFixed(2)}萬` : `${costTWD.toFixed(0)}元`);
          const isBatch = c.horizon === '短線' || c.horizon === '長短';
          const feeText = fee > 0 ? `（含手續費 $${fee}）` : '';
          orderHtml = `<div class="rec-order">
            <span class="rec-order-tag">💰 下單參考</span>
            現價 ${priceDisplay} ✕ ${sd} ≈ ${costDisp}${feeText}
            ${isBatch ? '｜<strong>建議分2批</strong>進場' : '｜建議單次進場'}
          </div>`;
        } else if (budget > 0 && !livePrice) {
          orderHtml = `<div class="rec-order warn">⏳ 報價抓取中...</div>`;
        }

        // ★ 相關性標註：與現有持股同板塊 → 提示
        const ownedSectors = new Set(
          APP.portfolio.map(s => this.activeCandidates.find(x => x.code === s.code)?.sector).filter(Boolean)
        );
        const correlationWarn = ownedSectors.has(c.sector)
          ? `<div class="rec-corr-warn">⚠️ 與現有持股板塊相同（${c.sector}），相關性較高，請注意集中風險</div>`
          : '';

        return `
        <div class="rec-card">
          <div class="rec-card-header">
            <span class="rec-rank">#${i+1}</span>
            <span class="rec-code">${c.code}</span>
            <span class="rec-name">${c.name}</span>
            <span class="rec-sector">${c.sector}</span>
            <span class="rec-risk" style="color:${riskColor[c.risk]}">風險${c.risk}</span>
            <span class="rec-horizon ${horizonCls[c.horizon]}">${horizonLabel[c.horizon]}</span>
            <span style="font-weight:600;font-size:13px">${priceDisplay}${chgDisplay}</span>
          </div>
          <div class="rec-reason"><span class="rec-tag">推薦理由</span>${c.reason}</div>
          <div class="rec-logic"><span class="rec-tag">投資邏輯</span>${c.logic}</div>
          ${c.shortNote ? `<div class="rec-short-note">${c.shortNote}</div>` : ''}
          ${correlationWarn}
          ${orderHtml}
        </div>`;
      }).join('')}
      <div class="rec-disclaimer">⚠️ 以上為規則引擎參考建議，不構成投資建議，請自行判斷。</div>`;
  },
};

// ── APP module ────────────────────────────────────────
// ── Calendar module（財經行事曆：FOMC會議、台股法定財報截止日、美股個股財報日）──
// ── PriceAlert module（到價提醒：瀏覽器通知）──────────
const PriceAlert = {
  _key() { return 'stock-agent-alerts'; },
  getAll() {
    try { return JSON.parse(localStorage.getItem(this._key()) || '{}'); }
    catch(e) { return {}; }
  },
  save(alerts) { localStorage.setItem(this._key(), JSON.stringify(alerts)); },
  has(code) { const a = this.getAll(); return !!a[code]; },
  get(code) { return this.getAll()[code] || null; },

  set(code, { above, below }) {
    const alerts = this.getAll();
    if (above == null && below == null) { delete alerts[code]; }
    else { alerts[code] = { above: above ?? null, below: below ?? null, triggered: {} }; }
    this.save(alerts);
  },

  async requestPermission() {
    if (!('Notification' in window)) { showToast('此瀏覽器不支援通知功能'); return false; }
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') { showToast('通知權限已被封鎖，請至瀏覽器設定開啟'); return false; }
    const perm = await Notification.requestPermission();
    return perm === 'granted';
  },

  openModal(code, market) {
    const list = market === 'US' ? APP._usPortfolio : APP._twPortfolio;
    const s = list.find(x => x.code === code);
    if (!s) return;
    const modal = document.getElementById('alert-modal');
    modal._code = code; modal._market = market;
    document.getElementById('alert-stock-label').textContent = `${code} ${s.name}（現價 ${(market==='US'?'US$':'$')}${(s.price??s.cost).toFixed(2)}）`;
    const existing = this.get(code);
    document.getElementById('alert-above').value = existing?.above ?? '';
    document.getElementById('alert-below').value = existing?.below ?? '';
    modal.classList.add('show');
  },

  async saveFromModal() {
    const modal = document.getElementById('alert-modal');
    const code = modal._code;
    const above = parseFloat(document.getElementById('alert-above').value) || null;
    const below = parseFloat(document.getElementById('alert-below').value) || null;
    if ((above || below) && !(await this.requestPermission())) return;
    this.set(code, { above, below });
    closeModal('alert-modal');
    APP.renderStockList();
    showToast(above || below ? `${code} 到價提醒已設定` : `${code} 到價提醒已取消`);
  },

  // 每次報價更新後檢查是否觸價（在 APP.refreshPrices 完成後呼叫）
  checkAll() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const alerts = this.getAll();
    let changed = false;
    Object.keys(alerts).forEach(code => {
      const alert = alerts[code];
      const q = DATA.priceStore[code];
      if (!q?.price) return;
      const today = new Date().toISOString().slice(0, 10);
      if (alert.above != null && q.price >= alert.above && alert.triggered.above !== today) {
        new Notification(`📈 ${code} 已達到價提醒`, { body: `現價 ${q.price} 已突破 ${alert.above}` });
        alert.triggered.above = today; changed = true;
      }
      if (alert.below != null && q.price <= alert.below && alert.triggered.below !== today) {
        new Notification(`📉 ${code} 已達到價提醒`, { body: `現價 ${q.price} 已跌破 ${alert.below}` });
        alert.triggered.below = today; changed = true;
      }
    });
    if (changed) this.save(alerts);
  },
};

// ── ExDividend module（除權息日期：台股用TWSE官方公開資料，美股用Yahoo歷史股利估算下次）──
const ExDividend = {
  _cacheKey() { return 'twsa-exdiv-cache'; },

  // ROC(民國)日期字串轉西元 Date（例："1150814" → 2026-08-14）
  _rocToDate(rocStr) {
    if (!rocStr || rocStr.length < 6) return null;
    const roc = parseInt(rocStr.slice(0, -4));
    const md = rocStr.slice(-4);
    return `${roc + 1911}-${md.slice(0,2)}-${md.slice(2,4)}`;
  },

  async getTWUpcoming(codes) {
    if (!codes.length) return [];
    const cacheRaw = localStorage.getItem(this._cacheKey());
    if (cacheRaw) {
      try {
        const cache = JSON.parse(cacheRaw);
        if (Date.now() - cache.ts < 86400000) return cache.events.filter(e => codes.includes(e.code)); // 1天快取
      } catch(e) {}
    }
    try {
      const url = 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL';
      const res = await DATA._fetch(url);
      const json = await res.json();
      const today = new Date().toISOString().slice(0, 10);
      const events = (Array.isArray(json) ? json : [])
        .map(r => ({ code: r.Code, name: r.Name, date: this._rocToDate(r.Date), cashDividend: r.CashDividend }))
        .filter(e => e.date && e.date >= today);
      localStorage.setItem(this._cacheKey(), JSON.stringify({ ts: Date.now(), events }));
      return events.filter(e => codes.includes(e.code));
    } catch(e) { return []; }
  },

  // 美股：用過去一年配息紀錄，估算下次除息日（僅供參考，非官方確認日期）
  async getUSEstimate(code) {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${code}?interval=1d&range=1y&events=div`;
      const res = await DATA._fetch(url);
      const json = await res.json();
      const divs = json?.chart?.result?.[0]?.events?.dividends;
      if (!divs) return null;
      const dates = Object.values(divs).map(d => d.date * 1000).sort((a,b) => a - b);
      if (dates.length < 2) return null;
      // 用最近兩次間隔估算配息週期
      const interval = dates[dates.length-1] - dates[dates.length-2];
      const nextEst = new Date(dates[dates.length-1] + interval);
      if (nextEst < new Date()) return null;
      return { code, date: nextEst.toISOString().slice(0,10), estimated: true };
    } catch(e) { return null; }
  },

  async getUpcomingForPortfolio() {
    const twCodes = APP._twPortfolio.map(s => s.code);
    const usCodes = APP._usPortfolio.map(s => s.code);
    const [twEvents, ...usResults] = await Promise.all([
      this.getTWUpcoming(twCodes),
      ...usCodes.map(c => this.getUSEstimate(c)),
    ]);
    const usEvents = usResults.filter(Boolean);
    return [...twEvents, ...usEvents].sort((a,b) => a.date.localeCompare(b.date));
  },
};

const APP = {
  // 台股資料
  _twPortfolio: JSON.parse(localStorage.getItem('twsa-portfolio') || '[]'),
  _twWatchlist: JSON.parse(localStorage.getItem('twsa-watchlist') || '[]'),
  // 美股資料
  _usPortfolio: JSON.parse(localStorage.getItem('ussa-portfolio') || '[]'),
  _usWatchlist: JSON.parse(localStorage.getItem('ussa-watchlist') || '[]'),

  // 目前市場的 portfolio/watchlist（動態指向）
  get portfolio() { return this.activeMarket === 'US' ? this._usPortfolio : this._twPortfolio; },
  set portfolio(v) { if (this.activeMarket === 'US') this._usPortfolio = v; else this._twPortfolio = v; },
  get watchlist()  { return this.activeMarket === 'US' ? this._usWatchlist : this._twWatchlist; },
  set watchlist(v) { if (this.activeMarket === 'US') this._usWatchlist = v; else this._twWatchlist = v; },

  activeSymbol: '', activeIdx: -1, _source: 'portfolio',
  refreshTimer: null,
  settings: JSON.parse(localStorage.getItem('twsa-settings') || '{}'),

  save() {
    if (this.activeMarket === 'US') {
      localStorage.setItem('ussa-portfolio', JSON.stringify(this._usPortfolio));
      localStorage.setItem('ussa-watchlist', JSON.stringify(this._usWatchlist));
    } else {
      localStorage.setItem('twsa-portfolio', JSON.stringify(this._twPortfolio));
      localStorage.setItem('twsa-watchlist', JSON.stringify(this._twWatchlist));
    }
    SYNC.markDirty();
  },

  async init() {
    CHART.init();
    this._loadSettings();
    this._setupTabs();
    this._setupMainTabs();
    // 初始化市場切換 UI
    this._initMarketSwitch();
    this.portfolio.forEach(s => { s.price = s.price ?? s.cost; s.prevClose = s.prevClose ?? s.cost; });
    this.watchlist.forEach(s => { s.price = s.price ?? 0; s.prevClose = s.prevClose ?? 0; });
    this.renderAll();
    this.updateClock();
    this._updateMarketStatus();
    if (!this.portfolio.length) this._showEmptyPortfolio();
    if (!this.watchlist.length) this._showEmptyWatchlist();

    // Load USD rate + VIX
    await Promise.all([CURRENCY.fetchUSDRate(), VIX.fetch()]);
    // ★ 問題6修正：開網站時永遠強制更新報價（取得最新 prevClose），休市也要更新
    await this.refreshPrices(true);
    // 問題1修正：雲端同步改為非阻塞，不卡住 init 流程
    // 先顯示本機資料，背景同步雲端
    SYNC.autoDownloadOnStart(); // 不 await，背景執行
    if (this.portfolio.length > 0) this.selectStock(this.portfolio[0].code, 0, 'portfolio');
    // ★ 總覽頁為預設首頁，載入完成後渲染
    Dashboard.render();
    // 背景分析所有持股
    setTimeout(() => this._backgroundAnalyzeAll(), 500);
    // ★ 事後驗證過去的預測準確度（背景執行，不卡畫面），之後每小時再檢查一次
    setTimeout(() => PredictTrack.evaluate(), 15000);
    setInterval(() => PredictTrack.evaluate(), 3600000);
    // 除權息行事曆（背景載入，有1天快取）
    setTimeout(() => this._renderExDiv(), 2000);
    // 總覽頁迷你K線定期重繪（跟報價文字分開頻率，避免每8秒都重算預測線耗效能）
    setInterval(() => Dashboard.refreshMiniCharts(), 60000);
    // 三大法人買賣超（每日資料，開網站時抓一次，之後每小時檢查一次是否有新資料）
    setTimeout(() => DATA.fetchInstitutional(), 4000);
    setInterval(() => DATA.fetchInstitutional(), 3600000);
    // 產業類股排行（同時累積歷史，供未來輪動走勢圖用）
    setTimeout(() => DATA.fetchSectorRanking(), 5000);
    setInterval(() => DATA.fetchSectorRanking(), 3600000);
    // （市場狀態修正這個方向已用回測A/B測試過，沒有觀察到明顯改善，暫時不啟用，
    // REGIME模組保留在analysis.js裡但不主動呼叫，之後有需要可以再重新評估）

    // ★ 核心修正：init 完成後 12 秒才解鎖自動上傳
    // 確保 refreshPrices、renderAll 等所有初始化動作都不會觸發上傳
    // 避免「開啟時 portfolio 還是空的就上傳」覆蓋雲端資料
    setTimeout(() => {
      SYNC._initialized = true;
      console.log('[SYNC] 自動上傳已解鎖');
    }, 12000);

    // 開盤時每 8~12 秒隨機更新
    const scheduleRefresh = () => {
      const delay = (8 + Math.floor(Math.random() * 4)) * 1000; // 8~12秒
      this.refreshTimer = setTimeout(() => {
        const open = this.activeMarket === 'US' ? this.isUSMarketOpen() : this.isTWMarketOpen();
        if (open) this.refreshPrices();
        scheduleRefresh();
      }, delay);
    };
    scheduleRefresh();
    setInterval(() => this.updateClock(), 1000);
    setInterval(() => this._updateMarketStatus(), 60000);
    DATA.fetchIndexes();
    setInterval(() => DATA.fetchIndexes(), 120000);
    setInterval(() => CURRENCY.fetchUSDRate(), 3600000);
    setInterval(() => VIX.fetch(), 3600000); // VIX 每小時更新

    PIE.render();
    GOALS.updateDashboard();
    GOALS.recordSnapshot();
    TRADES.render();
    this._renderSignalOverview();
    SYNC.updateStatus();
    // 載入設定欄位
    const s = this.settings;
    if (s.jsonbinKey) { const el = document.getElementById('jsonbin-key'); if(el) el.value = s.jsonbinKey; }
    if (s.jsonbinBin) { const el = document.getElementById('jsonbin-bin'); if(el) el.value = s.jsonbinBin; }
  },

  _calcTotalValue() {
    return this.portfolio.reduce((sum, s) => sum + (s.price ?? s.cost) * s.shares, 0);
  },

  _showEmptyPortfolio() {
    const list = document.getElementById('stock-list');
    if (list) list.innerHTML = '<div class="empty-state">還沒有持股<br><small>點 ＋ 新增 開始追蹤</small></div>';
  },

  _showEmptyWatchlist() {
    const el = document.getElementById('watchlist');
    if (el) el.innerHTML = '<div class="empty-state">自選清單為空<br><small>點 ＋ 新增觀察標的</small></div>';
  },

  updateClock() {
    const el = document.getElementById('clock');
    if (el) el.textContent = new Date().toLocaleTimeString('zh-TW', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  },

  // 判斷台股是否開盤中（09:00–13:30，平日）
  isTWMarketOpen() {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const day = now.getDay();
    return day >= 1 && day <= 5
      && (h > 9 || (h === 9 && m >= 0))
      && (h < 13 || (h === 13 && m <= 30));
  },

  // 判斷美股是否開盤中（台灣時間 21:30–翌日 05:00，平日）
  isUSMarketOpen() {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const day = now.getDay(); // 0=日, 1=一, ..., 5=五, 6=六
    // 美股夏令：台灣時間 21:30–翌日04:00
    // 美股冬令：台灣時間 22:30–翌日05:00
    // 保守估計：21:30–05:00
    const afterOpen   = h > 21 || (h === 21 && m >= 30);
    const beforeClose = h < 5  || (h === 5  && m === 0);
    // 週一凌晨（h<5）對應的是週五晚上已收盤，不算開盤
    // 週六、週日完全不開
    if (day === 0 || day === 6) return false; // 週末
    if (day === 1 && beforeClose) return false; // 週一凌晨（週五已收）
    return afterOpen || beforeClose;
  },

  // 目前顯示的市場：'TW' or 'US'
  activeMarket: localStorage.getItem('stock-agent-market') || 'TW',

  switchMarket(market) {
    this.activeMarket = market;
    localStorage.setItem('stock-agent-market', market);
    // 更新切換按鈕狀態
    document.querySelectorAll('.market-switch-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.market === market);
    });
    // 切換 logo 文字
    const logoSpan = document.querySelector('.logo span');
    if (logoSpan) logoSpan.textContent = market === 'US' ? '🇺🇸 股票 Agent' : '🇹🇼 股票 Agent';
    // 切換大盤指數列
    const twBar = document.getElementById('tw-market-bar');
    const usBar = document.getElementById('us-market-bar');
    if (twBar) twBar.style.display = market === 'US' ? 'none' : '';
    if (usBar) usBar.style.display = market === 'US' ? '' : 'none';
    // ★ 完全重置選中狀態和K線
    this.activeSymbol = '';
    this.activeIdx = -1;
    CHART._currentLoadId = null;
    CHART.currentData = [];
    CHART.draw();
    // 重置右側顯示
    const nameEl = document.getElementById('chart-name');
    if (nameEl) nameEl.textContent = '請選擇股票';
    const priceEl = document.getElementById('chart-price');
    if (priceEl) { priceEl.textContent = '—'; priceEl.className = 'chart-price'; }
    const changeEl = document.getElementById('chart-change');
    if (changeEl) { changeEl.textContent = ''; changeEl.className = 'chart-change'; }
    const indRow = document.getElementById('ind-row');
    if (indRow) indRow.innerHTML = '';

    this.renderAll();
    this._updateMarketStatus();
    this.refreshPrices(true);
    if (market === 'US') DATA.fetchUSIndexes();
    // 若總覽頁正顯示，切換市場後重新渲染（不同市場持股不同）
    const dv = document.getElementById('dashboard-content');
    if (dv && dv.style.display !== 'none') Dashboard.render();
  },

  _updateMarketStatus() {
    const twOpen = this.isTWMarketOpen();
    const usOpen = this.isUSMarketOpen();
    const marketOpen = this.activeMarket === 'US' ? usOpen : twOpen;
    let label = '休市';
    if (marketOpen) label = this.activeMarket === 'US' ? '美股盤中' : '開盤中';
    // 台股 badge
    const el = document.getElementById('mkt-status');
    if (el) { el.textContent = label; el.className = marketOpen ? 'badge open' : 'badge closed'; }
    // 美股 badge（同步）
    const elUS = document.getElementById('mkt-status-us');
    if (elUS) { elUS.textContent = label; elUS.className = marketOpen ? 'badge open' : 'badge closed'; }
    const dot = document.getElementById('live-dot');
    if (dot) dot.style.opacity = marketOpen ? '1' : '0.3';
  },

  async refreshPrices(force = false) {
    const twOpen = this.isTWMarketOpen();
    const usOpen = this.isUSMarketOpen();
    const marketOpen = this.activeMarket === 'US' ? usOpen : twOpen;

    // ★ 問題1+2: 休市時不更新（手動強制除外）
    if (!force && !marketOpen) {
      this._updateMarketStatus();
      return;
    }

    const btn = document.querySelector('.icon-btn[onclick="refreshAll()"]');
    if (btn) btn.classList.add('spinning');

    const allCodes = [
      ...this.portfolio.map(s => s.code),
      ...this.watchlist.map(s => s.code),
    ];
    await DATA.batchUpdate(allCodes);

    // 從 priceStore 同步回 stock 物件
    [...this.portfolio, ...this.watchlist].forEach(s => {
      const q = DATA.priceStore[s.code];
      if (q?.price) {
        s.price     = q.price;
        s.prevClose = q.prevClose ?? s.prevClose;
      }
    });

    if (btn) btn.classList.remove('spinning');
    this.renderPortfolioSummary();
    this.renderStockList();
    this.renderWatchlist();
    this._updateMarketStatus();
    // ★ 右側大圖價格即時更新（不用重新 selectStock）
    if (this.activeSymbol) {
      const q = DATA.priceStore[this.activeSymbol];
      if (q?.price) {
        const priceEl = document.getElementById('chart-price');
        const chgForName = q.price - (q.prevClose ?? q.price);
        if (priceEl) { priceEl.textContent = q.price.toFixed(2); priceEl.className = 'chart-price ' + chgColorClass(chgForName); }
        const nameElLive = document.getElementById('chart-name');
        if (nameElLive) nameElLive.className = 'chart-stock-name ' + chgColorClass(chgForName);
        const changeEl = document.getElementById('chart-change');
        if (changeEl) {
          const chg = q.price - (q.prevClose ?? q.price);
          const chgPct = q.prevClose ? chg / q.prevClose * 100 : 0;
          const isUS = DATA.isUSCode(this.activeSymbol);
          const isOpen = isUS ? this.isUSMarketOpen() : this.isTWMarketOpen();
          const todayWeekday = new Date().getDay() >= 1 && new Date().getDay() <= 5;
          const showChg = isOpen || (!isUS && todayWeekday);
          if (!showChg) {
            changeEl.textContent = '+0.00 (休市)'; changeEl.className = 'chart-change neutral';
          } else if (Math.abs(chg) < 0.01) {
            changeEl.textContent = isMarketOpen ? '+0.00 (待成交)' : '+0.00 (休市)'; changeEl.className = 'chart-change neutral';
          } else {
            changeEl.textContent = `${chg>=0?'+':''}${chg.toFixed(2)} (${chgPct>=0?'+':''}${chgPct.toFixed(2)}%)`;
            changeEl.className = 'chart-change ' + (chg >= 0 ? 'up-color' : 'dn-color');
          }
        }
        // ★ 更新最後一根K線並重繪
        CHART._patchLastCandle(this.activeSymbol);
        CHART.draw();
      }
    }
    // ★ 問題3: 報價更新後不重繪圓餅圖（只有買賣操作才更新）
    GOALS.updateDashboard();
    GOALS.recordSnapshot();
    this._renderSignalOverview();
    // 總覽頁若正在顯示，只更新價格文字（不重抓K線，避免頻繁重繪）
    Dashboard.updateLivePrices();
    PriceAlert.checkAll();
    // ★ 問題3: 移除「報價已更新」toast
  },

  renderAll() {
    this.renderPortfolioSummary();
    this.renderStockList();
    this.renderWatchlist();
    PIE.render();
    const miniSection = document.getElementById('mini-pie-section');
    if (miniSection) miniSection.style.display = APP.portfolio.length > 1 ? 'block' : 'none';
    GOALS.updateDashboard();
    this._renderSignalOverview();
  },

  async _renderExDiv() {
    const section = document.getElementById('exdiv-section');
    const list = document.getElementById('exdiv-list');
    if (!section || !list) return;
    const events = await ExDividend.getUpcomingForPortfolio();
    if (!events.length) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    list.innerHTML = events.slice(0, 5).map(e => {
      const daysLeft = Math.ceil((new Date(e.date) - new Date()) / 86400000);
      return `<div class="exdiv-item">
        <span class="exdiv-code">${e.code}${e.estimated ? ' (估)' : ''}</span>
        <span class="exdiv-date">${e.date} · ${daysLeft<=0?'今天':daysLeft+'天後'}</span>
      </div>`;
    }).join('');
  },

  // ── 買賣訊號總覽（持股清單旁邊直觀顯示）─────────
  _renderSignalOverview() {
    const wrap = document.getElementById('signal-overview');
    if (!wrap || !this.portfolio.length) return;
    wrap.innerHTML = this.portfolio.map(s => {
      const sig = SIGNAL.quickEstimate(s);
      const gainPct = s.price ? (s.price - s.cost) / s.cost * 100 : 0;
      const gainDisp = gainPct >= 0 ? `+${gainPct.toFixed(1)}%` : `${gainPct.toFixed(1)}%`;
      const daysHeld = s.date ? Math.floor((Date.now() - new Date(s.date).getTime()) / 86400000) : null;
      const isUS = (s.market || APP.activeMarket) === 'US';
      const priceDisp = s.price ? (isUS ? `US$${s.price.toFixed(2)}` : s.price.toFixed(2)) : '—';
      return `
        <div class="sig-overview-item ${sig.cls}" onclick="APP.selectStock('${s.code}', ${this.portfolio.indexOf(s)}, 'portfolio')">
          <div class="soi-left">
            <div class="soi-code">${s.code}</div>
            <div class="soi-name">${s.name}</div>
          </div>
          <div class="soi-mid">
            <div class="soi-price">${priceDisp}</div>
            <div class="soi-gain ${gainPct>=0?'up-color':'dn-color'}">${gainDisp}</div>
          </div>
          <div class="soi-right">
            <div class="soi-signal-label ${sig.cls}">${sig.label}</div>
            <div class="soi-signal-short">${sig.short}</div>
            ${daysHeld !== null ? `<div class="soi-days">持有${daysHeld}天</div>` : ''}
          </div>
        </div>`;
    }).join('');
  },

  renderPortfolioSummary() {
    const isUS = this.activeMarket === 'US';
    const fx = isUS ? CURRENCY.toTWD(1) : 1;
    let totalVal = 0, totalCost = 0, dayPnl = 0, dayPnlUSD = 0;
    let hasDayData = false;
    this.portfolio.forEach(s => {
      const price = s.price ?? s.cost;
      const prev  = s.prevClose ?? s.cost;
      totalVal  += price * s.shares;   // USD or TWD（原幣）
      totalCost += s.cost  * s.shares; // 原幣
      dayPnlUSD += (price - prev) * s.shares; // 原幣
      dayPnl    += (price - prev) * s.shares * fx; // 換算台幣
      if (Math.abs(price - prev) > 0.01) hasDayData = true;
    });
    const pnlUSD = totalVal - totalCost; // 原幣損益
    const pnlTWD = pnlUSD * fx;          // 換算台幣損益
    const roi = totalCost > 0 ? pnlUSD / totalCost * 100 : 0;
    const dayPct = totalCost > 0 ? dayPnlUSD / totalCost * 100 : 0;

    // 格式化：原幣顯示
    const fmtOrig = n => {
      const abs = Math.abs(n);
      if (isUS) return `US$${Math.abs(n) >= 1000 ? (n/1000).toFixed(1)+'K' : n.toFixed(0)}`;
      if (abs >= 1e6) return (n/1e4).toFixed(1)+'萬';
      if (abs >= 1e4) return (n/1e4).toFixed(2)+'萬';
      return n.toFixed(0)+'元';
    };
    // 格式化：台幣換算
    const fmtTWD = n => {
      const abs = Math.abs(n);
      if (abs >= 1e6) return `≈${(n/1e4).toFixed(1)}萬`;
      if (abs >= 1e4) return `≈${(n/1e4).toFixed(2)}萬`;
      return `≈${n.toFixed(0)}元`;
    };
    const fmtV = isUS
      ? n => `${fmtOrig(n)} (${fmtTWD(n * fx)})`  // 損益：USD + 換算台幣
      : n => {
          const abs = Math.abs(n);
          if (abs >= 1e6) return (n/1e4).toFixed(1)+'萬';
          if (abs >= 1e4) return (n/1e4).toFixed(2)+'萬';
          return n.toFixed(0)+'元';
        };

    // 市值/成本顯示原幣
    setText('total-value', fmtOrig(totalVal), 'neutral');
    setText('total-cost', '成本 '+fmtOrig(totalCost), '');
    setText('total-value', fmtV(totalVal), 'neutral');
    setText('total-cost', '成本 '+fmtV(totalCost), '');
    setSignedText('total-pnl', pnlUSD, fmtV);
    setSignedText('total-pnl-pct', roi, v => v.toFixed(2)+'%', true);
    // 今天是否有開過盤（平日）
    const todayIsWeekday = new Date().getDay() >= 1 && new Date().getDay() <= 5;
    const marketOpen = this.activeMarket === 'US' ? this.isUSMarketOpen() : this.isTWMarketOpen();
    const shouldShowDayPnl = hasDayData && (marketOpen || todayIsWeekday);

    if (shouldShowDayPnl) {
      setSignedText('day-pnl', dayPnlUSD, fmtV);
      setSignedText('day-pnl-pct', dayPct, v => v.toFixed(2)+'%', true);
    } else {
      setText('day-pnl', '—', 'neutral');
      setText('day-pnl-pct', todayIsWeekday ? '待更新' : '休市', '');
    }
    setSignedText('total-roi', roi, v => v.toFixed(2)+'%', true);
    setText('stock-count', this.portfolio.length+' 檔持股', '');
  },

  renderStockList() {
    const list = document.getElementById('stock-list');
    if (!list) return;
    if (!this.portfolio.length) { this._showEmptyPortfolio(); return; }
    list.innerHTML = '';
    // ★ 套用總覽頁的自訂排序（若有設定），維持左右一致
    const order = (typeof Dashboard !== 'undefined') ? Dashboard.getOrder() : [];
    const orderedPortfolio = order.length
      ? [...this.portfolio].sort((a, b) => {
          const ia = order.indexOf(a.code), ib = order.indexOf(b.code);
          if (ia === -1 && ib === -1) return 0;
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        })
      : this.portfolio;
    orderedPortfolio.forEach((s) => {
      const i = this.portfolio.indexOf(s); // 保留原始索引供 selectStock/removeStock 等函式使用
      const price = s.price ?? s.cost;
      const prev  = s.prevClose ?? s.cost;
      const chg   = price - prev;
      const chgPct = prev ? chg / prev * 100 : 0;
      const isUS   = (s.market || APP.activeMarket) === 'US';
      const fx     = isUS ? CURRENCY.toTWD(1) : 1;
      const pnlOrig = (price - s.cost) * s.shares;        // 原幣損益
      const pnlTWD  = pnlOrig * fx;                        // 換算台幣
      const pnlPct  = (price - s.cost) / s.cost * 100;
      const isUp    = chg >= 0;
      const isActive = s.code === this.activeSymbol;
      const sharesDisplay = sharesDisp(s.shares, s.market || APP.activeMarket);

      // 損益：原幣 + 換算台幣
      const fmtPnl = (n, nTWD) => {
        const origStr = isUS
          ? `${n>=0?'+':''}US$${Math.abs(n).toFixed(0)}`
          : (Math.abs(n) >= 10000 ? `${n>=0?'+':''}${(n/10000).toFixed(2)}萬` : `${n>=0?'+':''}${n.toFixed(0)}元`);
        if (isUS) {
          const twdStr = Math.abs(nTWD) >= 10000
            ? `≈${nTWD>=0?'+':''}${(nTWD/10000).toFixed(1)}萬`
            : `≈${nTWD>=0?'+':''}${nTWD.toFixed(0)}元`;
          return `${origStr} (${twdStr})`;
        }
        return origStr;
      };
      const pnlDisplay = fmtPnl(pnlOrig, pnlTWD);

      // 均價顯示
      const costDisplay = isUS ? `均價US$${s.cost}` : `均價$${s.cost}`;

      // 今日漲跌換算台幣（美股才顯示換算）
      const chgTWD = chg * s.shares * fx;
      const chgTWDStr = Math.abs(chgTWD) >= 10000
        ? `≈${chgTWD>=0?'+':''}${(chgTWD/10000).toFixed(1)}萬`
        : `≈${chgTWD>=0?'+':''}${chgTWD.toFixed(0)}元`;
      const sig = SIGNAL.quickEstimate(s);
      const mode = this.getStockMode(s.code); // 長線 or 短線
      // 持有天數
      const daysHeld = s.date ? Math.floor((Date.now() - new Date(s.date).getTime()) / 86400000) : null;
      // 年化報酬
      const annualRoi = daysHeld && daysHeld > 7
        ? ((price/s.cost) ** (365/daysHeld) - 1) * 100
        : null;

      const div = document.createElement('div');
      div.className = 'stock-item' + (isActive ? ' active' : '');
      const nameColorClass = chgColorClass(chg);
      div.innerHTML = `
        <div class="si-main" data-code="${s.code}" data-idx="${i}">
          <div class="si-row1">
            <span class="si-code ${nameColorClass}">${s.code}</span>
            <span class="si-price ${nameColorClass}">
              ${price.toFixed(2)}
              ${Math.abs(price - s.cost) < 0.01 ? '<small style="font-size:9px;color:var(--text-3);font-weight:400"> 暫</small>' : ''}
            </span>
          </div>
          <div class="si-row2">
            <span class="si-name ${nameColorClass}">${s.name}</span>
            <span class="si-shares">${sharesDisplay}</span>
          </div>
          <div class="si-row3">
            <span class="si-cost" onclick="event.stopPropagation();openEditCostModal('${s.code}','${s.market||APP.activeMarket}')" title="點擊手動修改均價">${costDisplay} ✏️</span>
            <span class="${pnlOrig>=0?'up-color':'dn-color'}">${pnlDisplay}(${pnlPct>=0?'+':''}${pnlPct.toFixed(1)}%)</span>
          </div>
          <div class="si-row4">
            ${(() => {
              const isOpen = s.market === 'US' ? APP.isUSMarketOpen() : APP.isTWMarketOpen();
              const todayWeekday = new Date().getDay() >= 1 && new Date().getDay() <= 5;
              const showChg = isOpen || (s.market !== 'US' && todayWeekday);
              if (!showChg) return `<span style="color:var(--text-3);font-size:11px">休市</span>`;
              if (Math.abs(chg) > 0.01) return `<span class="${isUp?'up-color':'dn-color'}">${isUp?'▲':'▼'}${isUS ? `US$${Math.abs(chg).toFixed(2)}` : Math.abs(chg).toFixed(2)} (${Math.abs(chgPct).toFixed(2)}%)${isUS ? ` ${chgTWDStr}` : ''}</span>`;
              return `<span style="color:var(--text-3);font-size:11px">今日 ±0</span>`;
            })()}
            ${daysHeld !== null ? `<span class="si-days">${daysHeld}天${annualRoi!==null?` ${annualRoi>=0?'+':''}${annualRoi.toFixed(0)}%/年`:''}</span>` : ''}
          </div>
          <div style="margin-top:3px;display:flex;align-items:center;gap:5px;flex-wrap:wrap">
            <span class="si-signal-badge ${sig.cls}">${sig.short} ${sig.label}</span>
            <span class="mode-toggle-wrap">
              <button class="mode-btn ${mode==='long'?'active-long':''}" onclick="APP.setStockMode('${s.code}','long')" title="長線分析（6月日線）">長線</button>
              <button class="mode-btn ${mode==='short'?'active-short':''}" onclick="APP.setStockMode('${s.code}','short')" title="短線分析（1月日線）">短線</button>
            </span>
          </div>
        </div>
        <div class="si-actions">
          <button class="si-btn buy" onclick="openBuyModal('${s.code}', ${i})" title="加碼">＋</button>
          <button class="si-btn sell" onclick="openSellStockModal('${s.code}', ${i})" title="賣出">－</button>
          <button class="si-btn edit" onclick="editStockName('${s.code}', ${i})" title="編輯名稱">✎</button>
          <button class="si-btn ${PriceAlert.has(s.code)?'alert-active':''}" onclick="PriceAlert.openModal('${s.code}','${s.market||APP.activeMarket}')" title="到價提醒">🔔</button>
          <button class="si-btn del" onclick="APP.removeStock(${i})" title="移除">✕</button>
        </div>`;
      div.querySelector('.si-main').addEventListener('click', () => goToStock(s.code, i, 'portfolio'));
      list.appendChild(div);
    });
  },

  renderWatchlist() {
    const wrap = document.getElementById('watchlist');
    if (!wrap) return;
    if (!this.watchlist.length) { this._showEmptyWatchlist(); return; }
    wrap.innerHTML = '';
    this.watchlist.forEach((s, i) => {
      const price = s.price ?? 0;
      const prev  = s.prevClose ?? price;
      const chg   = price - prev;
      const chgPct = prev ? chg / prev * 100 : 0;
      const isUp  = chg >= 0;
      const sig = price > 0 ? SIGNAL.quickEstimate(s) : null;
      const mode = this.getStockMode(s.code);
      const div = document.createElement('div');
      div.className = 'watch-item';
      div.innerHTML = `
        <div class="wi-left" onclick="goToStock('${s.code}',${i},'watch')">
          <div class="wi-code ${chgColorClass(chg)}">${s.code}</div>
          <div class="wi-name ${chgColorClass(chg)}">${s.name}</div>
          ${sig ? `<div class="wi-signal ${sig.cls}">${sig.short} ${sig.label}</div>` : ''}
        </div>
        <div class="wi-right" onclick="goToStock('${s.code}',${i},'watch')">
          <div class="wi-price ${chgColorClass(chg)}">${price>0?price.toFixed(2):'—'}</div>
          <div class="wi-change">${(() => {
            const isOpen = s.market === 'US' ? APP.isUSMarketOpen() : APP.isTWMarketOpen();
            const todayWeekday = new Date().getDay() >= 1 && new Date().getDay() <= 5;
            const showChg = isOpen || (!( (s.market||'TW')==='US') && todayWeekday);
            if (!showChg) return '<span style="color:var(--text-3);font-size:10px">休市</span>';
            if (price > 0 && Math.abs(chg) > 0.001) return `<span class="${isUp?'up-color':'dn-color'}">${isUp?'+':''}${chgPct.toFixed(2)}%</span>`;
            return '';
          })()}</div>
        </div>
        <div class="wi-modes">
          <button class="mode-btn ${mode==='long'?'active':''}" onclick="APP.setStockMode('${s.code}','long');APP.renderWatchlist();" title="長線">長</button>
          <button class="mode-btn ${mode==='short'?'active':''}" onclick="APP.setStockMode('${s.code}','short');APP.renderWatchlist();" title="短線">短</button>
        </div>
        <button class="watch-del" onclick="APP.removeWatch(${i})">✕</button>`;
      wrap.appendChild(div);
    });
  },

  async selectStock(code, idx, source) {
    this.activeSymbol = code;
    this.activeIdx = idx;
    this._source = source;

    const s = source === 'portfolio' ? this.portfolio[idx] : this.watchlist[idx];
    if (s) {
      const price = s.price ?? 0;
      const prev  = s.prevClose ?? price;
      const chg = price - prev;
      const chgPct = prev ? chg/prev*100 : 0;
      const nameEl0 = document.getElementById('chart-name');
      if (nameEl0) { nameEl0.textContent = `${s.name} ${s.code}`; nameEl0.className = 'chart-stock-name ' + chgColorClass(chg); }
      const priceEl0 = document.getElementById('chart-price');
      if (priceEl0) { priceEl0.textContent = price > 0 ? price.toFixed(2) : '—'; priceEl0.className = 'chart-price ' + (price > 0 ? chgColorClass(chg) : ''); }
      const changeEl = document.getElementById('chart-change');
      const isMarketOpen = s.market === 'US' ? APP.isUSMarketOpen() : APP.isTWMarketOpen();
      const todayWeekday = new Date().getDay() >= 1 && new Date().getDay() <= 5;
      const showChg = isMarketOpen || (s.market !== 'US' && todayWeekday);
      if (!showChg) {
        changeEl.textContent = '+0.00 (休市)';
        changeEl.className = 'chart-change neutral';
      } else if (price > 0 && Math.abs(chg) < 0.01) {
        changeEl.textContent = isMarketOpen ? '+0.00 (待成交)' : '+0.00 (休市)';
        changeEl.className = 'chart-change neutral';
      } else {
        changeEl.textContent = price > 0 ? `${chg>=0?'+':''}${chg.toFixed(2)} (${chgPct>=0?'+':''}${chgPct.toFixed(2)}%)` : '';
        changeEl.className = 'chart-change ' + (chg >= 0 ? 'up-color' : 'dn-color');
      }
    }

    // ★ 問題1: 立刻更新 active 樣式，不重建整個清單
    document.querySelectorAll('#stock-list .stock-item').forEach(el => {
      const elCode = el.querySelector('.si-main')?.dataset.code;
      if (elCode === code) {
        el.classList.add('active');
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        el.classList.remove('active');
      }
    });

    // ★ 有快取 → 立刻更新整個分析面板（不等 K 線載入）
    const hasCached = !!ANALYSIS._cache[code];
    if (hasCached) {
      ANALYSIS.lastSymbol = code;
      ANALYSIS.lastInd = ANALYSIS._cache[code]?.ind || null;
      ANALYSIS.lastData = ANALYSIS._cache[code]?.candles || [];
      const ind = ANALYSIS.lastInd;
      const candles = ANALYSIS.lastData;
      if (ind) {
        ANALYSIS._updateIndicatorCards(ind);
        ANALYSIS._updateSignals(ind, candles);
        ANALYSIS._updatePatterns(ind, candles);
        ANALYSIS._updateSellEngine(ind);
        ANALYSIS._updateInfoGrid(ind);
        if (candles && candles.length) {
          CHART.drawMACD(candles);
          CHART.drawKD(candles);
        }
        ORDER.calcSingle();
      }
    } else {
      const sigAction = document.getElementById('sig-action');
      if (sigAction) { sigAction.textContent = '分析中...'; sigAction.style.color = 'var(--text-3)'; }
      const sigDesc = document.getElementById('sig-action-desc');
      if (sigDesc) sigDesc.innerHTML = '';
      const sellHint = document.getElementById('sig-sell-hint');
      if (sellHint) sellHint.style.display = 'none';
    }

    this.renderStockList();

    const activePeriod = document.querySelector('.period-btn.active')?.dataset.period ?? '1d';
    const requestedCode = code;
    await CHART.load(code, activePeriod);

    if (this.activeSymbol !== requestedCode) return;

    // ★ K 線載入後，重新取最新 quote（可能已從 K 線資料更新）
    const freshQuote = DATA.priceStore[code];
    if (freshQuote?.price) {
      const s2 = this.portfolio.find(x => x.code === code) || this.watchlist.find(x => x.code === code);
      if (s2) {
        s2.price = freshQuote.price;
        s2.prevClose = freshQuote.prevClose ?? s2.prevClose;
      }
      // 更新頂部大價格顯示
      const priceEl = document.getElementById('chart-price');
      const chg = freshQuote.price - (freshQuote.prevClose ?? freshQuote.price);
      const chgPct = freshQuote.prevClose ? chg / freshQuote.prevClose * 100 : 0;
      if (priceEl) { priceEl.textContent = freshQuote.price.toFixed(2); priceEl.className = 'chart-price ' + chgColorClass(chg); }
      const nameElFresh = document.getElementById('chart-name');
      if (nameElFresh) nameElFresh.className = 'chart-stock-name ' + chgColorClass(chg);
      const changeEl = document.getElementById('chart-change');
      if (changeEl) {
        if (Math.abs(chg) < 0.01) {
          changeEl.textContent = '+0.00 (休市)';
          changeEl.className = 'chart-change neutral';
        } else {
          changeEl.textContent = `${chg>=0?'+':''}${chg.toFixed(2)} (${chgPct>=0?'+':''}${chgPct.toFixed(2)}%)`;
          changeEl.className = 'chart-change ' + (chg >= 0 ? 'up-color' : 'dn-color');
        }
      }
    }

    ORDER.calcSingle();
    this.renderStockList();
  },

  getActiveStock() {
    if (!this.activeSymbol) return null;
    return this.portfolio.find(s => s.code === this.activeSymbol) ||
           this.watchlist.find(s => s.code === this.activeSymbol) || null;
  },

  // 每股分析模式：long（長線）或 short（短線），預設長線
  _stockModes: JSON.parse(localStorage.getItem('twsa-modes') || '{}'),

  getStockMode(code) {
    return this._stockModes[code] || 'long';
  },

  setStockMode(code, mode) {
    this._stockModes[code] = mode;
    localStorage.setItem('twsa-modes', JSON.stringify(this._stockModes));
    // 清除快取，強制重新分析
    delete ANALYSIS._cache[code];
    // 重新分析
    CHART.runAnalysisForSymbol(code, mode);
    // 更新按鈕狀態
    this.renderStockList();
    this._renderSignalOverview();
  },

  // 問題4: 開網頁後在背景依序分析所有持股和自選清單
  async _backgroundAnalyzeAll() {
    const all = [
      ...this.portfolio.map(s => ({ code: s.code, source: 'portfolio' })),
      ...this.watchlist.map(s => ({ code: s.code, source: 'watch' })),
    ];
    for (const item of all) {
      if (ANALYSIS._cache[item.code]) continue; // 已有快取就跳過
      const mode = this.getStockMode(item.code);
      const period = CHART.ANALYSIS_PERIODS[mode] || '6mo';
      try {
        const data = await DATA.fetchHistory(item.code, period);
        if (data.length >= 15) {
          const ind = ANALYSIS._calcIndicators(data);
          ANALYSIS._cache[item.code] = { ind, candles: data };
          // 問題2/4: 若此股票正在顯示，立刻更新下方分析面板
          if (item.code === this.activeSymbol) {
            ANALYSIS.lastSymbol = item.code;
            ANALYSIS.lastInd = ind;
            ANALYSIS.lastData = data;
            ANALYSIS._updateIndicatorCards(ind);
            ANALYSIS._updateSignals(ind, data);
            ANALYSIS._updatePatterns(ind, data);
            ANALYSIS._updateSellEngine(ind);
            ANALYSIS._updateInfoGrid(ind);
            CHART.drawMACD(data);
            CHART.drawKD(data);
          }
        }
      } catch(e) { /* 靜默失敗 */ }
      await new Promise(r => setTimeout(r, 800)); // 每支間隔 800ms 避免 API 限速
    }
    this.renderStockList();
    this._renderSignalOverview();
    showToast('所有持股分析完成');
  },

  removeStock(idx) {
    if (!confirm(`確定要移除 ${this.portfolio[idx]?.name}？`)) return;
    const s = this.portfolio.splice(idx, 1)[0];
    this.save(); this.renderAll();
    if (s.code === this.activeSymbol) { this.activeSymbol = ''; document.getElementById('chart-name').textContent = '請選擇股票'; }
    showToast(`已移除 ${s.name}`);
  },

  removeWatch(idx) {
    const s = this.watchlist.splice(idx, 1)[0];
    this.save(); this.renderWatchlist();
    showToast(`已移除 ${s.name}`);
  },

  _setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.tab-nav').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const pane = btn.dataset.tab;
        btn.closest('.card')?.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        document.getElementById(`pane-${pane}`)?.classList.add('active');
        if (pane === 'tech' && CHART.currentData.length) { CHART.drawMACD(CHART.currentData); CHART.drawKD(CHART.currentData); }
        if (pane === 'pie') { setTimeout(() => PIE.render(), 50); }
      });
    });
  },

  _setupMainTabs() {
    document.querySelectorAll('.main-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.main-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.main-tab-pane').forEach(p => p.classList.remove('active'));
        const target = document.getElementById(`mtab-${btn.dataset.mtab}`);
        if (target) target.classList.add('active');
        const mt = btn.dataset.mtab;
        if (mt === 'goal') GOALS.updateDashboard();
        if (mt === 'trades') TRADES.render();
        if (mt === 'signals') this._renderSignalOverview();
      });
    });
  },

  _initMarketSwitch() {
    document.querySelectorAll('.market-switch-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.market === this.activeMarket);
      btn.addEventListener('click', () => this.switchMarket(btn.dataset.market));
    });
    // 更新 logo 文字
    const logoSpan = document.querySelector('.logo span');
    if (logoSpan) logoSpan.textContent = this.activeMarket === 'US' ? '🇺🇸 股票 Agent' : '🇹🇼 股票 Agent';
    // 初始化大盤列顯示
    const twBar = document.getElementById('tw-market-bar');
    const usBar = document.getElementById('us-market-bar');
    if (twBar) twBar.style.display = this.activeMarket === 'US' ? 'none' : '';
    if (usBar) usBar.style.display = this.activeMarket === 'US' ? '' : 'none';
    // 美股模式時立即抓大盤
    if (this.activeMarket === 'US') DATA.fetchUSIndexes();
  },

  _loadSettings() {
    const s = this.settings;
    if (s.corsProxy) DATA.proxies[0] = s.corsProxy;
    if (s.darkMode === false) document.body.classList.add('light-mode');
    const toggle = document.getElementById('dark-mode-toggle');
    if (toggle) toggle.checked = s.darkMode !== false;
    if (s.goalTarget) {
      const g = GOALS.get();
      g.target = s.goalTarget; g.years = s.goalYears; GOALS.save(g);
    }
  },

  exportData() {
    const data = { portfolio:this.portfolio, watchlist:this.watchlist, trades:TRADES.get(), goals:GOALS.get(), history:JSON.parse(localStorage.getItem('twsa-value-history')||'[]'), exportedAt:new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `twsa-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click(); URL.revokeObjectURL(url);
    showToast('資料已匯出');
  },

  importData(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        if (data.portfolio) this.portfolio = data.portfolio;
        if (data.watchlist) this.watchlist = data.watchlist;
        if (data.trades) localStorage.setItem('twsa-trades', JSON.stringify(data.trades));
        if (data.goals) GOALS.save(data.goals);
        if (data.history) localStorage.setItem('twsa-value-history', JSON.stringify(data.history));
        this.save(); this.renderAll(); TRADES.render(); GOALS.updateDashboard();
        showToast('資料已匯入');
      } catch(err) { showToast('匯入失敗，請確認檔案格式'); }
    };
    reader.readAsText(file);
  },
};

// ── Global functions ──────────────────────────────────
async function refreshAll() {
  const btn = document.querySelector('.icon-btn[onclick="refreshAll()"]');
  if (btn) btn.classList.add('spinning');
  try {
    // ★ 修正：之前只更新價格文字，K線快取（20分鐘）不會被強制清掉，
    // 總覽/績效/日曆頁面也完全沒被處理到，點了跟沒點一樣。
    // 現在強制清空相關K線快取，並依目前所在的頁面做對應的完整刷新。
    const allCodes = [...new Set([...APP.portfolio.map(s=>s.code), ...APP.watchlist.map(s=>s.code)])];
    allCodes.forEach(code => { delete DATA.histCache[`${code}_1d`]; delete DATA.histCache[`${code}_mini`]; });

    await APP.refreshPrices(true);

    const dashVisible = document.getElementById('dashboard-content')?.style.display !== 'none';
    const perfVisible  = document.getElementById('performance-content')?.style.display !== 'none';
    const calVisible   = document.getElementById('calendar-page-content')?.style.display !== 'none';

    if (dashVisible) {
      await Dashboard.render();
    } else if (perfVisible) {
      await Performance.render();
    } else if (calVisible) {
      await TradeCalendar.render();
    } else if (APP.activeSymbol) {
      delete DATA.histCache[`${APP.activeSymbol}_${CHART.currentPeriod}`];
      await CHART.load(APP.activeSymbol, CHART.currentPeriod);
    }
    showToast('已重新整理');
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}
function openSettings() { document.getElementById('settings-modal')?.classList.add('show'); }
function runAnalysis() {
  const code = APP.activeSymbol;
  if (!code) { showToast('請先選擇股票'); return; }
  // ★ 重新分析用長短線模式對應的週期，不用 K 線顯示的資料
  // 這樣和長短線按鈕的分析完全一致
  const mode = APP.getStockMode(code);
  delete ANALYSIS._cache[code]; // 清除快取，強制重新分析
  CHART.runAnalysisForSymbol(code, mode);
  showToast(`重新分析中（${mode === 'short' ? '短線 1月' : '長線 6月'}日線）`);
}
function calcOrder() { ORDER.calcSingle(); }
function calcPortfolio() { ORDER.calcPortfolio(); }
function openAddModal() {
  const isUS = APP.activeMarket === 'US';
  // 標題
  const title = document.getElementById('add-modal-title');
  if (title) title.textContent = isUS ? '新增美股持股' : '新增持股';
  // 代號 placeholder
  const codeEl = document.getElementById('m-code');
  if (codeEl) codeEl.placeholder = isUS ? 'AAPL' : '2330';
  // 均價 label
  const costLabel = document.getElementById('m-cost-label');
  if (costLabel) costLabel.innerHTML = isUS ? '成交均價（USD/股）<span class="required">*</span>' : '成交均價（元/股）<span class="required">*</span>';
  // 說明
  const note = document.getElementById('add-modal-note');
  if (note) note.textContent = isUS
    ? '💡 輸入美股代號（如 AAPL、NVDA），支援零股。已持有相同代號→自動加權合併均價。'
    : '💡 股數填實際持有股數（零股支援）。已持有相同代號→自動加權合併均價。';
  document.getElementById('add-modal')?.classList.add('show');
}

function openWatchlistModal() { openWatchModal(); }

function openWatchModal() {
  const isUS = APP.activeMarket === 'US';
  const title = document.getElementById('watch-modal-title');
  if (title) title.textContent = isUS ? '新增美股自選' : '新增自選股';
  const codeEl = document.getElementById('w-code');
  if (codeEl) codeEl.placeholder = isUS ? 'TSLA' : '6505';
  document.getElementById('watch-modal')?.classList.add('show');
}
function openEditTrade(id) {
  const t = TRADES.getById(id);
  if (!t) return;
  const modal = document.getElementById('edit-trade-modal');
  modal._tradeId = id;
  document.getElementById('et-code').value   = t.code;
  document.getElementById('et-action').value = t.action === 'buy' ? '買進' : '賣出';
  document.getElementById('et-shares').value = t.shares;
  document.getElementById('et-price').value  = t.price;
  document.getElementById('et-date').value   = t.date || '';
  document.getElementById('et-fee').value    = t.fee || 0;
  const tIsUS = (t.market || 'TW') === 'US';
  const note = document.getElementById('et-note');
  if (note) note.textContent = tIsUS
    ? '⚠️ 修改後將重新計算美股持股均價，請確認數字正確。'
    : '⚠️ 修改後將重新計算持股均價，請確認數字正確。';
  modal.classList.add('show');
}

function saveEditTrade() {
  const modal = document.getElementById('edit-trade-modal');
  const id = modal._tradeId;
  const shares = parseFloat(document.getElementById('et-shares').value);
  const price  = parseFloat(document.getElementById('et-price').value);
  const date   = document.getElementById('et-date').value;
  const fee    = parseFloat(document.getElementById('et-fee').value) || 0;
  if (!shares || !price) { showToast('請填寫股數和價格'); return; }
  TRADES.update(id, { shares, price, date, fee });
  TRADES.recalcPortfolio();
  closeModal('edit-trade-modal');
  TRADES.render();
  APP.renderAll();
  PIE.render();
  showToast('交易紀錄已更新，持股重新計算完成');
}

function deleteTradeConfirm() {
  const modal = document.getElementById('edit-trade-modal');
  const id = modal._tradeId;
  const t = TRADES.getById(id);
  if (!t) return;
  if (!confirm(`確定刪除這筆交易？\n${t.action==='buy'?'買進':'賣出'} ${t.code} ${t.shares}股 @ $${t.price}`)) return;
  TRADES.delete(id);
  TRADES.recalcPortfolio();
  closeModal('edit-trade-modal');
  TRADES.render();
  APP.renderAll();
  PIE.render();
  showToast('交易已刪除，持股重新計算完成');
}

function openAddTradeModal() {
  const modal = document.getElementById('add-trade-modal');
  document.getElementById('at-market').value = APP.activeMarket;
  document.getElementById('at-action').value = 'buy';
  document.getElementById('at-code').value = '';
  document.getElementById('at-name').value = '';
  document.getElementById('at-shares').value = '';
  document.getElementById('at-price').value = '';
  document.getElementById('at-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('at-fee').value = 0;
  modal.classList.add('show');
}

function saveAddTrade() {
  const market = document.getElementById('at-market').value;
  const action = document.getElementById('at-action').value;
  const code   = document.getElementById('at-code').value.trim().toUpperCase();
  let name     = document.getElementById('at-name').value.trim();
  const shares = parseFloat(document.getElementById('at-shares').value);
  const price  = parseFloat(document.getElementById('at-price').value);
  const date   = document.getElementById('at-date').value;
  const fee    = parseFloat(document.getElementById('at-fee').value) || 0;

  if (!code || !shares || !price || !date) { showToast('請填寫代號、股數、成交價、日期'); return; }
  if (!name) name = code;

  TRADES.add({ date, code, name, action, shares, price, fee, market });
  TRADES.recalcPortfolio();
  closeModal('add-trade-modal');
  APP.renderAll();
  PIE.render();
  TRADES.render();
  showToast(`已新增交易：${action==='buy'?'買進':'賣出'} ${code} ${shares}股 @ ${price}`);
}

function openEditCostModal(code, market) {
  const list = market === 'US' ? APP._usPortfolio : APP._twPortfolio;
  const s = list.find(x => x.code === code);
  if (!s) return;
  const modal = document.getElementById('edit-cost-modal');
  modal._code = code;
  modal._market = market;
  document.getElementById('ec-code').value = code + '（' + s.name + '）';
  document.getElementById('ec-current').value = (market === 'US' ? 'US$' : '$') + s.cost;
  document.getElementById('ec-new-cost').value = s.cost;
  modal.classList.add('show');
}

function saveEditCost() {
  const modal = document.getElementById('edit-cost-modal');
  const code = modal._code, market = modal._market;
  const newCost = parseFloat(document.getElementById('ec-new-cost').value);
  if (!newCost || newCost <= 0) { showToast('請輸入有效均價'); return; }
  const list = market === 'US' ? APP._usPortfolio : APP._twPortfolio;
  const s = list.find(x => x.code === code);
  if (!s) return;
  s.cost = newCost;
  APP.save();
  APP.renderAll();
  PIE.render();
  closeModal('edit-cost-modal');
  showToast(`${code} 均價已更新為 ${market==='US'?'US$':'$'}${newCost}`);
}

// 側邊欄點擊股票：若目前不在個股詳細畫面，先切過去再選股
// 依漲跌方向回傳顏色class：漲=紅、跌=綠、平盤=不上色（維持預設白色）
function chgColorClass(chg) {
  if (chg == null || Math.abs(chg) < 0.001) return '';
  return chg > 0 ? 'up-color' : 'dn-color';
}

function goToStock(code, idx, source) {
  const detailEl = document.getElementById('detail-content');
  if (detailEl && detailEl.style.display === 'none') {
    showMainView('detail');
  }
  APP.selectStock(code, idx, source);
  setTimeout(() => CHART.draw(), 80);
}

function closeModal(id) { document.getElementById(id)?.classList.remove('show'); }
function runRecommend() { RECOMMEND.run(); }

function openBuyModal(code, idx) {
  const s = APP.portfolio[idx];
  if (!s) return;
  const isUS = APP.activeMarket === 'US';
  document.getElementById('buy-code').value = s.code;
  document.getElementById('buy-name').value = s.name;
  document.getElementById('buy-price').value = s.price?.toFixed(2) || s.cost;
  // 調整 label 和說明
  const priceLabel = document.getElementById('buy-price-label');
  if (priceLabel) priceLabel.innerHTML = isUS
    ? '成交價（USD/股）<span class="required">*</span>'
    : '成交價（元/股）<span class="required">*</span>';
  const note = document.getElementById('buy-modal-note');
  if (note) note.textContent = isUS
    ? '加碼後均價自動加權計算。美股一般無手續費，已自動記錄。'
    : '加碼後均價自動加權計算。手續費 0.1425%（最低$20）自動計入紀錄。';
  document.getElementById('buy-modal')?.classList.add('show');
  document.getElementById('buy-modal')._idx = idx;
}

function openSellStockModal(code, idx) {
  const s = APP.portfolio[idx];
  if (!s) return;
  const isUS = APP.activeMarket === 'US';
  document.getElementById('sell-code').value = s.code;
  document.getElementById('sell-name').value = s.name;
  document.getElementById('sell-price').value = s.price?.toFixed(2) || s.cost;
  document.getElementById('sell-max').textContent = `最多 ${s.shares} 股`;
  // 調整 label 和說明
  const priceLabel = document.getElementById('sell-price-label');
  if (priceLabel) priceLabel.innerHTML = isUS
    ? '賣出價格（USD/股）<span class="required">*</span>'
    : '賣出價格（元/股）<span class="required">*</span>';
  const note = document.getElementById('sell-modal-note');
  if (note) note.textContent = isUS
    ? '美股一般無交易稅，僅計算手續費（各券商不同，預設$0）。'
    : '⚠️ 手續費 0.1425%（最低$20）+ 交易稅（ETF 0.1%／個股 0.3%），自動計入紀錄。';
  document.getElementById('sell-modal')?.classList.add('show');
  document.getElementById('sell-modal')._idx = idx;
}

function addStock() {
  const code   = document.getElementById('m-code')?.value.trim().toUpperCase();
  let   name   = document.getElementById('m-name')?.value.trim();
  const shares = parseFloat(document.getElementById('m-shares')?.value);
  const cost   = parseFloat(document.getElementById('m-cost')?.value);
  const date   = document.getElementById('m-date')?.value || '';
  if (!code || !shares || !cost) { showToast('請填寫必填欄位（代號、股數、均價）'); return; }
  if (!name || name === code) name = code;
  const isUS = APP.activeMarket === 'US';
  const existing = APP.portfolio.find(s => s.code === code);
  if (existing) {
    const totalShares = existing.shares + shares;
    existing.cost = +((existing.cost * existing.shares + cost * shares) / totalShares).toFixed(4);
    existing.shares = +totalShares.toFixed(0);
  } else {
    APP.portfolio.push({ code, name, shares, cost, date, price: cost, prevClose: cost, market: isUS ? 'US' : 'TW' });
  }
  // 台股才計算手續費，美股預設0
  const fee = isUS ? 0 : Math.max(20, Math.round(cost * shares * 0.001425));
  TRADES.add({ date: date||new Date().toISOString().split('T')[0], code, name, action:'buy', shares, price:cost, fee, market: isUS ? 'US' : 'TW' });
  APP.save(); APP.renderAll(); PIE.render(); closeModal('add-modal');
  showToast(`已新增 ${name} (${code}) × ${shares}股`);
  ['m-code','m-name','m-shares','m-cost'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  DATA.fetchQuote(code).then(q => {
    const s = APP.portfolio.find(x => x.code === code);
    if (s && q.ok) {
      if (q.price) { s.price = q.price; s.prevClose = q.prevClose; }
      if (q.name && q.name !== code && (s.name === code || !s.name)) s.name = q.name;
      APP.save(); APP.renderAll(); PIE.render();
    }
  });
}

function confirmBuy() {
  const modal = document.getElementById('buy-modal');
  const idx = modal._idx;
  const s = APP.portfolio[idx];
  if (!s) return;
  const shares = parseFloat(document.getElementById('buy-shares')?.value);
  const price  = parseFloat(document.getElementById('buy-price')?.value);
  const date   = document.getElementById('buy-date')?.value || new Date().toISOString().split('T')[0];
  if (!shares || !price) { showToast('請填寫股數和價格'); return; }
  const totalShares = s.shares + shares;
  s.cost = +((s.cost * s.shares + price * shares) / totalShares).toFixed(4);
  s.shares = +totalShares.toFixed(0);
  const isUS = APP.activeMarket === 'US';
  const fee = isUS ? 0 : Math.max(20, Math.round(price * shares * 0.001425));
  TRADES.add({ date, code:s.code, name:s.name, action:'buy', shares, price, fee, market: isUS ? 'US' : 'TW' });
  APP.save(); APP.renderAll(); PIE.render(); closeModal('buy-modal');
  showToast(`${s.name} 加碼 ${shares}股 @ ${isUS?'$':'NT$'}${price}，新均價 ${isUS?'$':'NT$'}${s.cost.toFixed(2)}`);
}

// 台股證交稅：ETF(00開頭代碼) 0.1%，一般股票 0.3%
function isTWETF(code) {
  return /^00\d{2,4}$/.test(code);
}
function sellTaxRate(code) {
  return isTWETF(code) ? 0.001 : 0.003;
}

function confirmSell() {
  const modal = document.getElementById('sell-modal');
  const idx = modal._idx;
  const s = APP.portfolio[idx];
  if (!s) return;
  const shares = parseFloat(document.getElementById('sell-shares')?.value);
  const price  = parseFloat(document.getElementById('sell-price')?.value);
  const date   = document.getElementById('sell-date')?.value || new Date().toISOString().split('T')[0];
  if (!shares || !price) { showToast('請填寫股數和賣出價格'); return; }
  if (shares > s.shares) { showToast(`超過持股數量（最多 ${s.shares} 股）`); return; }
  const isUS = APP.activeMarket === 'US';
  const tradeValue = price * shares;
  const pnl = (price - s.cost) * shares;
  // 台股：手續費 0.1425% + 交易稅（ETF 0.1% / 一般股票 0.3%）；美股：無費用
  const sellTax = isUS ? 0 : Math.round(tradeValue * sellTaxRate(s.code));
  const fee     = isUS ? 0 : Math.max(20, Math.round(tradeValue * 0.001425));
  const totalFee = fee + sellTax;
  const currency = isUS ? 'USD' : 'NT$';
  const pnlDisplay = isUS
    ? `$${Math.abs(pnl).toFixed(2)} USD`
    : Math.abs(pnl) >= 10000 ? `${(Math.abs(pnl)/10000).toFixed(2)}萬` : `${Math.abs(pnl).toFixed(0)}元`;
  // 持有天數：用該股最早的買進紀錄日期估算（若有）
  const holdDays = s.date ? Math.floor((new Date(date) - new Date(s.date)) / 86400000) : null;
  TRADES.add({ date, code:s.code, name:s.name, action:'sell', shares, price, fee:totalFee, note:`損益${pnl>=0?'+':''}${pnlDisplay}`, market: isUS ? 'US' : 'TW', realizedPnl: pnl, holdDays });
  s.shares = +(s.shares - shares).toFixed(0);
  if (s.shares <= 0) { APP.portfolio.splice(idx, 1); if (APP.activeSymbol === s.code) APP.activeSymbol = ''; }
  APP.save(); APP.renderAll(); PIE.render(); closeModal('sell-modal'); TRADES.render();
  const feeText = totalFee > 0 ? `（稅費$${totalFee}）` : '';
  showToast(`${s.name} 賣出 ${shares}股 @ ${currency}${price}，${pnl>=0?'獲利':'虧損'}${pnlDisplay}${feeText}`);
}

function editStockName(code, idx) {
  const s = APP.portfolio[idx];
  if (!s) return;
  const newName = prompt(`編輯 ${code} 的顯示名稱：`, s.name);
  if (newName !== null && newName.trim()) {
    s.name = newName.trim();
    APP.save(); APP.renderAll();
    showToast(`已更新：${code} → ${s.name}`);
  }
}

function autoFetchStockName(code, targetId) {
  code = (code || '').trim().toUpperCase();
  const nameEl = document.getElementById(targetId);
  if (!nameEl) return;
  const isUS = APP.activeMarket === 'US';
  // 台股最少4碼才觸發，美股最少1碼
  const minLen = isUS ? 1 : 4;
  if (code.length < minLen) return;
  clearTimeout(_fetchNameTimer);
  _fetchNameTimer = setTimeout(async () => {
    nameEl.placeholder = '抓取中...';
    try {
      const q = await DATA.fetchQuote(code);
      if (q.ok && q.name && q.name !== code) {
        nameEl.placeholder = q.name;
        if (!nameEl.value || nameEl.value === code) nameEl.value = q.name;
      } else {
        nameEl.placeholder = isUS ? '請手動輸入公司名稱' : '請手動輸入名稱';
      }
    } catch(e) { nameEl.placeholder = '請手動輸入名稱'; }
  }, 700);
}

function addWatchlist() {
  const code = document.getElementById('w-code')?.value.trim();
  let name = document.getElementById('w-name')?.value.trim();
  if (!code) { showToast('請填寫股票代號'); return; }
  if (!name) name = code; // 允許空名稱，用代號暫代
  if (APP.watchlist.find(x => x.code === code)) { showToast('已存在於自選清單'); return; }
  APP.watchlist.push({ code, name, price:0, prevClose:0 });
  APP.save(); APP.renderWatchlist(); closeModal('watch-modal');
  showToast(`已加入自選：${name}`);
  document.getElementById('w-code').value = '';
  document.getElementById('w-name').value = '';
  DATA.fetchQuote(code).then(q => {
    const s = APP.watchlist.find(x => x.code === code);
    if (s && q.ok) {
      if (q.price) { s.price = q.price; s.prevClose = q.prevClose; }
      if (q.name && q.name !== code && (s.name === code || !s.name)) s.name = q.name;
      APP.save();
      APP.renderWatchlist();
    }
  });
}

function saveSettings() {
  const s = APP.settings;
  s.corsProxy   = document.getElementById('cors-proxy')?.value.trim();
  s.ejsService  = document.getElementById('ejs-service')?.value.trim();
  s.ejsTemplate = document.getElementById('ejs-template')?.value.trim();
  s.ejsPubkey   = document.getElementById('ejs-pubkey')?.value.trim();
  s.jsonbinKey  = document.getElementById('jsonbin-key')?.value.trim();
  s.jsonbinBin  = document.getElementById('jsonbin-bin')?.value.trim();
  const gTarget = parseFloat(document.getElementById('goal-target-input')?.value) * 10000;
  const gYears  = parseFloat(document.getElementById('goal-years-input')?.value);
  if (gTarget && gYears) {
    const g = GOALS.get();
    g.target = gTarget; g.years = gYears;
    if (!g.startDate) g.startDate = new Date().toISOString().split('T')[0];
    if (!g.initialValue) g.initialValue = APP._calcTotalValue();
    GOALS.save(g);
  }
  // 儲存現金
  saveCashSettings();
  localStorage.setItem('twsa-settings', JSON.stringify(s));
  if (s.corsProxy) DATA.proxies[0] = s.corsProxy;
  closeModal('settings-modal');
  GOALS.updateDashboard();
  SYNC.updateStatus();
  showToast('設定已儲存');
}

function saveCashSettings() {
  const cashTWD = parseFloat(document.getElementById('cash-twd-input')?.value) || 0;
  const cashUSD = parseFloat(document.getElementById('cash-usd-input')?.value) || 0;
  const g = GOALS.get();
  g.cashTWD = cashTWD; g.cashUSD = cashUSD;
  GOALS.save(g);
  GOALS.updateDashboard();
}

function toggleDarkMode(checked) {
  document.body.classList.toggle('light-mode', !checked);
  APP.settings.darkMode = checked;
  localStorage.setItem('twsa-settings', JSON.stringify(APP.settings));
  setTimeout(() => { if (CHART.currentData.length) CHART.draw(); PIE.render(); }, 100);
}

function renderSellSignals(result) {
  if (!result) return;
  const { signals, urgency, plan } = result;
  const badge = document.getElementById('sell-urgency-badge');
  if (badge) {
    const labels = { none:'無賣出訊號', watch:'觀察減碼', sell:'建議出場', urgent:'緊急減碼', emergency:'⚠ 緊急離場' };
    badge.textContent = labels[urgency] ?? urgency;
    badge.className = `sell-urgency-badge ${urgency}`;
  }
  const wrap = document.getElementById('sell-signals-wrap');
  if (wrap) {
    if (!signals.length) { wrap.innerHTML = '<div class="sell-signals-empty">目前無明顯賣出訊號，持有觀察</div>'; }
    else {
      const icons = { watch:'◎', sell:'▼', urgent:'!', emergency:'⚠' };
      wrap.innerHTML = signals.map(s => `
        <div class="sell-signal-item ${s.urgency}">
          <div class="ss-icon ${s.urgency}">${icons[s.urgency]??'•'}</div>
          <div class="ss-body"><div class="ss-label ${s.urgency}">${s.label}</div><div class="ss-desc">${s.desc}</div></div>
        </div>`).join('');
    }
  }
  const planWrap = document.getElementById('sell-plan-wrap');
  if (planWrap) {
    if (!plan) { planWrap.style.display = 'none'; return; }
    planWrap.style.display = 'block';
    const titleEl = document.getElementById('sell-plan-title');
    if (titleEl) { titleEl.textContent = plan.title; titleEl.className = `sell-plan-title ${plan.color}`; }
    const rowsEl = document.getElementById('sell-plan-rows');
    if (rowsEl) rowsEl.innerHTML = plan.rows.map(r => `<div class="sell-plan-row"><span class="spr-batch">${r.batch}</span><span class="spr-action">${r.action}</span><span class="spr-desc">${r.desc}</span></div>`).join('');
    const noteEl = document.getElementById('sell-plan-note');
    if (noteEl) noteEl.textContent = plan.note ?? '';
  }
}

function setNotification() {
  const email = document.getElementById('notify-email')?.value;
  const condition = document.getElementById('notify-condition')?.value;
  if (!email) { showToast('請輸入 Email'); return; }
  const stock = APP.getActiveStock();
  if (!stock) { showToast('請先選擇股票'); return; }
  const targetPrice = ORDER.suggestEntry || stock.price || 0;
  APP.notifyRules = APP.notifyRules || [];
  APP.notifyRules.push({ code:stock.code, name:stock.name, condition, targetPrice, triggered:false, createdAt:new Date().toISOString() });
  localStorage.setItem('twsa-notify-rules', JSON.stringify(APP.notifyRules));
  const fb = document.getElementById('notify-feedback');
  if (fb) { fb.textContent = `✓ ${stock.name} ${condition} $${targetPrice} 通知已設定`; setTimeout(() => { fb.textContent = ''; }, 5000); }
  showToast('通知規則已設定');
}

// ── Helpers ───────────────────────────────────────────
function setText(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (cls !== undefined) el.className = el.className.replace(/\b(up|dn|neutral)\b/g,'') + ' ' + cls;
}
function setSignedText(id, val, fmtFn) {
  const el = document.getElementById(id);
  if (!el) return;
  const isUp = val >= 0;
  el.textContent = (isUp ? '+' : '') + fmtFn(val);
  el.className = el.className.replace(/\b(up|dn|neutral)\b/g,'') + (isUp ? ' up' : ' dn');
}
let toastTimer = null;
// ── 股數顯示 helper（台股有「張」，美股只有「股」）──
function sharesDisp(n, market) {
  const isUS = (market || APP.activeMarket) === 'US';
  if (isUS) return `${n}股`;
  return n >= 1000 ? `${(n/1000).toFixed(n%1000===0?0:2)}張` : `${n}股`;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('show'); });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
});

window.addEventListener('DOMContentLoaded', () => {
  APP.init();
  const today = new Date().toISOString().split('T')[0];
  ['buy-date','sell-date'].forEach(id => { const el = document.getElementById(id); if (el) el.value = today; });
  // 載入已儲存的現金設定
  const g = GOALS.get();
  const cashTWD = document.getElementById('cash-twd-input');
  const cashUSD = document.getElementById('cash-usd-input');
  if (cashTWD && g.cashTWD) cashTWD.value = g.cashTWD;
  if (cashUSD && g.cashUSD) cashUSD.value = g.cashUSD;
});
window.addEventListener('resize', () => { if (CHART.currentData.length) CHART.draw(); });
