// ── app.js  ── Main orchestration v3
// 修正：零股、滾動、圓餅圖、直觀買賣訊號、目標追蹤現金/美金、資產曲線、短線推薦

// ── CURRENCY module ───────────────────────────────────
const CURRENCY = {
  usdRate: null,
  async fetchUSDRate() {
    try {
      const res = await DATA._fetchWithFallback('https://query1.finance.yahoo.com/v8/finance/chart/USDTWD=X?interval=1d&range=5d');
      const json = await res.json();
      const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) { this.usdRate = +price.toFixed(2); this._updateDisplay(); }
    } catch(e) { this.usdRate = 31.5; }
  },
  _updateDisplay() {
    const el = document.getElementById('usd-rate-display');
    if (el && this.usdRate) el.textContent = `1 USD = ${this.usdRate} TWD`;
  },
  toTWD(usd) { return usd * (this.usdRate || 31.5); },
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
    const stockVal = APP._calcTotalValue();
    const cashTWD = parseFloat(g.cashTWD) || 0;
    const cashUSD = parseFloat(g.cashUSD) || 0;
    return stockVal + cashTWD + CURRENCY.toTWD(cashUSD);
  },

  updateDashboard() {
    const g = this.get();
    const stockVal = APP._calcTotalValue();
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

    set('goal-stock-val', fmtM(stockVal));
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

    // 資產結構比例
    if (totalVal > 0) {
      const sp = (stockVal/totalVal*100).toFixed(0);
      const cp = ((cashTWD+cashUSDtw)/totalVal*100).toFixed(0);
      set('goal-stock-pct', sp + '%');
      set('goal-cash-pct', cp + '%');
      const stockBar = document.getElementById('goal-asset-stock-bar');
      const cashBar  = document.getElementById('goal-asset-cash-bar');
      if (stockBar) stockBar.style.width = sp + '%';
      if (cashBar)  cashBar.style.width  = cp + '%';
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
  add(trade) {
    const trades = this.get();
    trades.unshift({ ...trade, id: Date.now() });
    localStorage.setItem('twsa-trades', JSON.stringify(trades));
    SYNC.markDirty();
  },
  render() {
    const list = document.getElementById('trade-list');
    if (!list) return;
    const trades = this.get();
    if (!trades.length) { list.innerHTML = '<div class="empty-state">暫無交易紀錄</div>'; return; }
    list.innerHTML = trades.slice(0, 50).map(t => {
      const isBuy = t.action === 'buy';
      const total = t.shares * t.price;
      const fee = t.fee || 0;
      const totalDisplay = total >= 10000 ? `${(total/10000).toFixed(2)}萬` : `${total.toFixed(0)}元`;
      const sharesDisplay = t.shares >= 1000 ? `${(t.shares/1000).toFixed(t.shares%1000===0?0:2)}張` : `${t.shares}股`;
      return `<div class="trade-item">
        <div class="ti-left">
          <span class="ti-action ${isBuy?'buy':'sell'}">${isBuy?'買進':'賣出'}</span>
          <span class="ti-code">${t.code}</span>
          <span class="ti-name">${t.name}</span>
        </div>
        <div class="ti-mid">
          <span>${sharesDisplay} @ $${t.price}</span>
          <span class="ti-date">${t.date || '—'}</span>
        </div>
        <div class="ti-right">
          <span class="${isBuy?'dn-color':'up-color'}">${isBuy?'-':'+'}${totalDisplay}</span>
          ${fee ? `<span class="ti-fee">稅費 $${fee}</span>` : ''}
        </div>
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
  fromScore(score, gainPct, supportBreak) {
    // VIX 影響
    const vixAdj = VIX.score || 0;
    const adjusted = score + vixAdj * 0.5;

    if (supportBreak || gainPct <= -8) return this.LEVELS[0];
    if (adjusted <= -3 || gainPct >= 30) return this.LEVELS[1];
    if (adjusted <= -1.5) return this.LEVELS[2];
    if (adjusted < 1.5)   return this.LEVELS[3];
    if (adjusted < 3)     return this.LEVELS[4];
    if (adjusted < 4)     return this.LEVELS[5];
    return this.LEVELS[6];
  },

  // 快速估算（沒有技術分析時，純用損益%）
  quickEstimate(stock) {
    if (!stock.price) return { ...this.LEVELS[3], label:'待更新', short:'⚫ —' };

    // ★ 優先用此股票自己的快取分析結果（不被其他股票的 lastInd 污染）
    const cached = ANALYSIS._cache[stock.code];
    const cachedInd = cached?.ind || null;
    if (cachedInd) {
      const score = ANALYSIS._calcScore(cachedInd);
      const gainPct = (stock.price - stock.cost) / stock.cost * 100;
      const supportBreak = stock.price < (cachedInd.support || 0) * 0.98;
      return this.fromScore(score, gainPct, supportBreak);
    }

    // 當前選中股票但尚未分析完 → 顯示「分析中」
    if (APP.activeSymbol === stock.code) {
      return { ...this.LEVELS[3], label:'分析中', short:'⏳ —' };
    }

    // 其他股票無快取 → 純損益%估算，不顯示買進，避免誤導
    const gainPct = stock.cost ? (stock.price - stock.cost) / stock.cost * 100 : 0;
    if (gainPct <= -8)  return this.LEVELS[0];
    if (gainPct <= -5)  return this.LEVELS[2];
    if (gainPct >= 30)  return this.LEVELS[1];
    if (gainPct >= 20)  return this.LEVELS[2];
    return { ...this.LEVELS[3], label:'待分析', short:'⚪ —' };
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
      portfolio: APP.portfolio,
      watchlist: APP.watchlist,
      trades: TRADES.get(),
      goals: GOALS.get(),
      history: JSON.parse(localStorage.getItem('twsa-value-history') || '[]'),
      syncedAt: new Date().toISOString(),
    };
  },

  _unpack(data) {
    if (data.portfolio) APP.portfolio = data.portfolio;
    if (data.watchlist) APP.watchlist = data.watchlist;
    if (data.trades) localStorage.setItem('twsa-trades', JSON.stringify(data.trades));
    // 問題1: _unpack 不呼叫 GOALS.save（會 markDirty），直接寫 localStorage
    if (data.goals) localStorage.setItem('twsa-goals', JSON.stringify(data.goals));
    if (data.history) localStorage.setItem('twsa-value-history', JSON.stringify(data.history));
    // 直接存 portfolio/watchlist 到 localStorage，不透過 APP.save（會 markDirty）
    localStorage.setItem('twsa-portfolio', JSON.stringify(APP.portfolio));
    localStorage.setItem('twsa-watchlist', JSON.stringify(APP.watchlist));
    // 清除 dirty flag，避免下載後立刻又上傳
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


const RECOMMEND = {
  CANDIDATES: [
    // ETF
    { code:'0050',  name:'元大台灣50',     sector:'ETF',   type:'ETF',    risk:'低',   horizon:'長線', reason:'追蹤台灣前50大市值，長期持有最穩健，年化約8-12%。', logic:'定期定額，適合作為核心部位（建議佔比30-50%）。', shortNote:null },
    { code:'0056',  name:'元大高股息',     sector:'ETF',   type:'ETF',    risk:'低',   horizon:'長線', reason:'高股息策略，每年穩定配息，適合長期存股。', logic:'股息再投入複利效果佳。', shortNote:null },
    { code:'00878', name:'國泰永續高股息', sector:'ETF',   type:'ETF',    risk:'低',   horizon:'長線', reason:'ESG+高股息雙重篩選，月月配息。', logic:'適合需要穩定現金流的長期投資人。', shortNote:null },
    { code:'006208',name:'富邦台50',       sector:'ETF',   type:'ETF',    risk:'低',   horizon:'長線', reason:'與0050相近但管理費更低。', logic:'低費用率讓長期複利效果更好。', shortNote:null },
    // 半導體/科技（長+短）
    { code:'2330',  name:'台積電',         sector:'半導體', type:'權值股', risk:'中',   horizon:'長線', reason:'全球最先進晶圓代工，AI/HPC需求持續驅動，護城河極深。', logic:'台股不可缺少的核心持股，長期向上。', shortNote:'逢大跌（跌幅>8%）為短線好買點，反彈快。' },
    { code:'2454',  name:'聯發科',         sector:'半導體', type:'成長股', risk:'中',   horizon:'長短', reason:'手機AP+AI晶片雙引擎，AI on device最大受惠者。', logic:'有回檔即為好機會，技術面修正後往往快速反彈。', shortNote:'📌 短線機會：回檔10-15%後搭配KD低檔黃金交叉為進場訊號。' },
    { code:'2303',  name:'聯電',           sector:'半導體', type:'存股',   risk:'中',   horizon:'長線', reason:'成熟製程需求穩定，車用/工業用晶片長期支撐。', logic:'殖利率佳，適合長期存股兼具成長潛力。', shortNote:null },
    { code:'2382',  name:'廣達',           sector:'電子',  type:'成長股', risk:'中',   horizon:'長短', reason:'AI伺服器最大受惠者之一，GB200訂單強勁。', logic:'AI基礎建設需求爆發，長期成長能見度高。', shortNote:'📌 短線機會：AI題材消息面回調時為買點，波段約10-20%。' },
    { code:'3231',  name:'緯創',           sector:'電子',  type:'成長股', risk:'中高', horizon:'短線', reason:'AI伺服器ODM大廠，與鴻海並列雙雄。', logic:'波動較大，適合短線波段操作。', shortNote:'📌 純短線：消息面驅動，需嚴設停損8%，目標10-15%。' },
    { code:'2317',  name:'鴻海',           sector:'電子',  type:'權值股', risk:'中',   horizon:'長短', reason:'積極布局電動車和AI伺服器，本益比低。', logic:'殖利率穩定，電動車轉型為長期催化劑。', shortNote:'📌 短線機會：法說會前後常有波段，回檔至季線附近為買點。' },
    { code:'3034',  name:'聯詠',           sector:'半導體', type:'成長股', risk:'中高', horizon:'短線', reason:'面板驅動IC龍頭，AI PC帶動需求回升。', logic:'景氣復甦週期股，適合波段操作。', shortNote:'📌 純短線：底部放量突破時進場，目標波段15-20%。' },
    { code:'2379',  name:'瑞昱',           sector:'半導體', type:'成長股', risk:'中',   horizon:'長短', reason:'網通晶片+AI邊緣計算受惠，客戶群廣泛。', logic:'基本面穩健，回檔時長期布局機會。', shortNote:'📌 短線機會：網通題材發酵時跟隨，停損設5%。' },
    // 金融/民生
    { code:'2882',  name:'國泰金',         sector:'金融',  type:'存股',   risk:'低中', horizon:'長線', reason:'台灣最大壽險，股息穩定，利率上升環境有利。', logic:'長期存股，每年穩定配息。', shortNote:null },
    { code:'2881',  name:'富邦金',         sector:'金融',  type:'存股',   risk:'低中', horizon:'長線', reason:'獲利能力強的綜合金控，旗下富邦人壽+台北富邦銀行。', logic:'金融股防禦性強，適合穩定配置。', shortNote:null },
    { code:'2412',  name:'中華電',         sector:'電信',  type:'存股',   risk:'低',   horizon:'長線', reason:'台灣最大電信，現金流穩定，殖利率4-5%。', logic:'景氣不佳時的避風港，防禦部位。', shortNote:null },
  ],

  run() {
    const el = document.getElementById('rec-result');
    if (!el) return;
    const portfolio = APP.portfolio;
    const goals = GOALS.get();
    const ownedCodes = new Set(portfolio.map(s => s.code));
    const filter = document.getElementById('rec-filter')?.value || 'all';

    const sectorMap = {};
    portfolio.forEach(s => {
      const match = this.CANDIDATES.find(c => c.code === s.code);
      if (match) sectorMap[match.sector] = (sectorMap[match.sector]||0) + 1;
    });

    const scored = this.CANDIDATES
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

    const riskColor = { '低':'#1D9E75','低中':'#5DCAA5','中':'#EF9F27','中高':'#E24B4A','高':'#E24B4A' };
    const horizonLabel = { '長線':'長期', '短線':'短線', '長短':'長短' };
    const horizonCls = { '長線':'horizon-long','短線':'horizon-short','長短':'horizon-both' };
    const budget = parseFloat(document.getElementById('rec-budget')?.value) || 0;
    const budgetPerStock = budget > 0 ? budget / scored.length : 0;

    el.innerHTML = `
      <div class="rec-meta">根據你的目標（${(goals.target/10000).toFixed(0)}萬/${goals.years}年）與持股結構推薦：</div>
      ${scored.map((c, i) => {
        // 下單建議（若有填金額）
        let orderHtml = '';
        if (budgetPerStock > 0 && c.price) {
          const shares = Math.max(1, Math.floor(budgetPerStock / c.price));
          const cost = shares * c.price;
          const fee = Math.max(20, Math.round(cost * 0.001425));
          const sharesDisp = shares >= 1000 ? `${(shares/1000).toFixed(1)}張` : `${shares}股`;
          const costDisp = cost >= 10000 ? `${(cost/10000).toFixed(2)}萬` : `${cost.toFixed(0)}元`;
          const isBatch = c.horizon === '短線' || c.horizon === '長短';
          orderHtml = `<div class="rec-order">
            <span class="rec-order-tag">💰 下單參考</span>
            現價 $${c.price} ✕ ${sharesDisp} ≈ ${costDisp}（含手續費 $${fee}）
            ${isBatch ? '｜<strong>建議分2批</strong>進場' : '｜建議單次進場'}
          </div>`;
        } else if (budget > 0) {
          orderHtml = `<div class="rec-order warn">需要先取得此股票報價才能計算下單量</div>`;
        }
        return `
        <div class="rec-card">
          <div class="rec-card-header">
            <span class="rec-rank">#${i+1}</span>
            <span class="rec-code">${c.code}</span>
            <span class="rec-name">${c.name}</span>
            <span class="rec-sector">${c.sector}</span>
            <span class="rec-risk" style="color:${riskColor[c.risk]}">風險${c.risk}</span>
            <span class="rec-horizon ${horizonCls[c.horizon]}">${horizonLabel[c.horizon]}</span>
          </div>
          <div class="rec-reason"><span class="rec-tag">推薦理由</span>${c.reason}</div>
          <div class="rec-logic"><span class="rec-tag">投資邏輯</span>${c.logic}</div>
          ${c.shortNote ? `<div class="rec-short-note">${c.shortNote}</div>` : ''}
          ${orderHtml}
        </div>`;
      }).join('')}
      <div class="rec-disclaimer">⚠️ 以上為規則引擎參考建議，不構成投資建議，請自行判斷。</div>`;
  },
};

// ── APP module ────────────────────────────────────────
const APP = {
  portfolio: JSON.parse(localStorage.getItem('twsa-portfolio') || '[]'),
  watchlist: JSON.parse(localStorage.getItem('twsa-watchlist') || '[]'),
  activeSymbol: '', activeIdx: -1, _source: 'portfolio',
  refreshTimer: null,
  settings: JSON.parse(localStorage.getItem('twsa-settings') || '{}'),

  async init() {
    CHART.init();
    this._loadSettings();
    this._setupTabs();
    this._setupMainTabs();
    this.portfolio.forEach(s => { s.price = s.price ?? s.cost; s.prevClose = s.prevClose ?? s.cost; });
    this.watchlist.forEach(s => { s.price = s.price ?? 0; s.prevClose = s.prevClose ?? 0; });
    this.renderAll();
    this.updateClock();
    this._updateMarketStatus();
    if (!this.portfolio.length) this._showEmptyPortfolio();
    if (!this.watchlist.length) this._showEmptyWatchlist();

    // Load USD rate + VIX
    await Promise.all([CURRENCY.fetchUSDRate(), VIX.fetch()]);
    await this.refreshPrices();
    // 問題1修正：雲端同步改為非阻塞，不卡住 init 流程
    // 先顯示本機資料，背景同步雲端
    SYNC.autoDownloadOnStart(); // 不 await，背景執行
    if (this.portfolio.length > 0) this.selectStock(this.portfolio[0].code, 0, 'portfolio');
    // 背景分析所有持股
    setTimeout(() => this._backgroundAnalyzeAll(), 500);

    // ★ 核心修正：init 完成後 12 秒才解鎖自動上傳
    // 確保 refreshPrices、renderAll 等所有初始化動作都不會觸發上傳
    // 避免「開啟時 portfolio 還是空的就上傳」覆蓋雲端資料
    setTimeout(() => {
      SYNC._initialized = true;
      console.log('[SYNC] 自動上傳已解鎖');
    }, 12000);

    // ★ 問題1+2: 開盤時（台股或美股）每3分鐘更新
    this.refreshTimer = setInterval(() => {
      if (this.isTWMarketOpen() || this.isUSMarketOpen()) this.refreshPrices();
    }, 180000);
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
    if (s.finmindToken) { const el = document.getElementById('finmind-token'); if(el) el.value = s.finmindToken; }
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

  // 判斷美股是否開盤中（台灣時間 21:30–翌日 04:00，平日）
  isUSMarketOpen() {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const day = now.getDay();
    // 美股開盤（夏令 21:30–04:00, 冬令 22:30–05:00）
    // 保守估計 21:30–05:00 都算開盤
    const afterOpen  = h > 21 || (h === 21 && m >= 30);
    const beforeClose = h < 5 || (h === 5 && m === 0);
    // 美股週六不開（台灣週六 = 美股週五還在跑但收盤後）
    // 週日早上 05:00 前是週五晚上延伸，週一 21:30 起才是下一週
    const isUSWeekday = day >= 1 && day <= 5;
    return isUSWeekday && (afterOpen || beforeClose);
  },

  _updateMarketStatus() {
    const twOpen = this.isTWMarketOpen();
    const usOpen = this.isUSMarketOpen();
    const isOpen = twOpen || usOpen;
    // 同時顯示哪個市場開盤
    let label = '休市';
    if (twOpen && usOpen) label = '台股+美股';
    else if (twOpen)      label = '開盤中';
    else if (usOpen)      label = '美股盤中';
    const el = document.getElementById('mkt-status');
    if (el) { el.textContent = label; el.className = isOpen ? 'badge open' : 'badge closed'; }
    const dot = document.getElementById('live-dot');
    if (dot) dot.style.opacity = isOpen ? '1' : '0.3';
  },

  async refreshPrices(force = false) {
    const twOpen = this.isTWMarketOpen();
    const usOpen = this.isUSMarketOpen();

    // ★ 問題1+2: 休市時不更新（手動強制除外）
    if (!force && !twOpen && !usOpen) {
      this._updateMarketStatus();
      return;
    }

    // 分離台股 / 美股代碼
    const twCodes = [...this.portfolio, ...this.watchlist]
      .map(s => s.code).filter(c => !DATA.isUSCode(c));
    const usCodes = [...this.portfolio, ...this.watchlist]
      .map(s => s.code).filter(c => DATA.isUSCode(c));

    // 決定要更新哪些（休市的市場跳過，force 時全更新）
    const codesToUpdate = [
      ...(force || twOpen ? twCodes : []),
      ...(force || usOpen ? usCodes : []),
    ];

    if (!codesToUpdate.length) { this._updateMarketStatus(); return; }

    const btn = document.querySelector('.icon-btn[onclick="refreshAll()"]');
    if (btn) btn.classList.add('spinning');

    const allCodes = codesToUpdate;
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
    PIE.render();
    GOALS.updateDashboard();
    GOALS.recordSnapshot();
    this._renderSignalOverview();
    showToast('報價已更新');
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

  // ── 買賣訊號總覽（持股清單旁邊直觀顯示）─────────
  _renderSignalOverview() {
    const wrap = document.getElementById('signal-overview');
    if (!wrap || !this.portfolio.length) return;
    wrap.innerHTML = this.portfolio.map(s => {
      const sig = SIGNAL.quickEstimate(s);
      const gainPct = s.price ? (s.price - s.cost) / s.cost * 100 : 0;
      const gainDisp = gainPct >= 0 ? `+${gainPct.toFixed(1)}%` : `${gainPct.toFixed(1)}%`;
      const daysHeld = s.date ? Math.floor((Date.now() - new Date(s.date).getTime()) / 86400000) : null;
      return `
        <div class="sig-overview-item ${sig.cls}" onclick="APP.selectStock('${s.code}', ${this.portfolio.indexOf(s)}, 'portfolio')">
          <div class="soi-left">
            <div class="soi-code">${s.code}</div>
            <div class="soi-name">${s.name}</div>
          </div>
          <div class="soi-mid">
            <div class="soi-price">${s.price ? s.price.toFixed(2) : '—'}</div>
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
    let totalVal = 0, totalCost = 0, dayPnl = 0;
    let hasDayData = false;
    this.portfolio.forEach(s => {
      const price = s.price ?? s.cost;
      const prev  = s.prevClose ?? s.cost;
      totalVal  += price * s.shares;
      totalCost += s.cost  * s.shares;
      dayPnl    += (price - prev) * s.shares;
      if (Math.abs(price - prev) > 0.01) hasDayData = true;
    });
    const pnl = totalVal - totalCost;
    const roi = totalCost > 0 ? pnl / totalCost * 100 : 0;
    const dayPct = totalCost > 0 ? dayPnl / totalCost * 100 : 0;
    const fmtV = n => {
      const abs = Math.abs(n);
      if (abs >= 1e6) return (n/1e4).toFixed(1)+'萬';
      if (abs >= 1e4) return (n/1e4).toFixed(2)+'萬';
      return n.toFixed(0)+'元';
    };
    setText('total-value', fmtV(totalVal), 'neutral');
    setText('total-cost', '成本 '+fmtV(totalCost), '');
    setSignedText('total-pnl', pnl, fmtV);
    setSignedText('total-pnl-pct', roi, v => v.toFixed(2)+'%', true);
    if (hasDayData) {
      setSignedText('day-pnl', dayPnl, fmtV);
      setSignedText('day-pnl-pct', dayPct, v => v.toFixed(2)+'%', true);
    } else {
      setText('day-pnl', '—', 'neutral');
      setText('day-pnl-pct', '待更新', '');
    }
    setSignedText('total-roi', roi, v => v.toFixed(2)+'%', true);
    setText('stock-count', this.portfolio.length+' 檔持股', '');
  },

  renderStockList() {
    const list = document.getElementById('stock-list');
    if (!list) return;
    if (!this.portfolio.length) { this._showEmptyPortfolio(); return; }
    list.innerHTML = '';
    this.portfolio.forEach((s, i) => {
      const price = s.price ?? s.cost;
      const prev  = s.prevClose ?? s.cost;
      const chg   = price - prev;
      const chgPct = prev ? chg / prev * 100 : 0;
      const pnl    = (price - s.cost) * s.shares;
      const pnlPct = (price - s.cost) / s.cost * 100;
      const isUp   = chg >= 0;
      const isActive = s.code === this.activeSymbol;
      const sharesDisplay = s.shares >= 1000 ? `${(s.shares/1000).toFixed(s.shares%1000===0?0:2)}張` : `${s.shares}股`;
      const pnlDisplay = Math.abs(pnl) >= 10000 ? `${pnl>=0?'+':''}${(pnl/10000).toFixed(2)}萬` : `${pnl>=0?'+':''}${pnl.toFixed(0)}元`;
      const sig = SIGNAL.quickEstimate(s);
      const mode = this.getStockMode(s.code); // 長線 or 短線
      const isUS = DATA.isUSCode(s.code);
      const marketTag = isUS ? ' <small style="font-size:9px;color:var(--blue);background:rgba(55,138,221,0.15);padding:1px 5px;border-radius:3px;font-weight:500">US</small>' : '';
      // 持有天數
      const daysHeld = s.date ? Math.floor((Date.now() - new Date(s.date).getTime()) / 86400000) : null;
      // 年化報酬
      const annualRoi = daysHeld && daysHeld > 7
        ? ((price/s.cost) ** (365/daysHeld) - 1) * 100
        : null;

      const div = document.createElement('div');
      div.className = 'stock-item' + (isActive ? ' active' : '');
      div.innerHTML = `
        <div class="si-main" data-code="${s.code}" data-idx="${i}">
          <div class="si-row1">
            <span class="si-code">${s.code}${marketTag}</span>
            <span class="si-price ${isUp?'up-color':'dn-color'}">
              ${price.toFixed(2)}
              ${Math.abs(price - s.cost) < 0.01 ? '<small style="font-size:9px;color:var(--text-3);font-weight:400"> 暫</small>' : ''}
            </span>
          </div>
          <div class="si-row2">
            <span class="si-name">${s.name}</span>
            <span class="si-shares">${sharesDisplay}</span>
          </div>
          <div class="si-row3">
            <span class="si-cost">均價$${s.cost}</span>
            <span class="${pnl>=0?'up-color':'dn-color'}">${pnlDisplay}(${pnlPct>=0?'+':''}${pnlPct.toFixed(1)}%)</span>
          </div>
          <div class="si-row4">
            ${Math.abs(chg) > 0.01
              ? `<span class="${isUp?'up-color':'dn-color'}">${isUp?'▲':'▼'}${Math.abs(chg).toFixed(2)} (${Math.abs(chgPct).toFixed(2)}%)</span>`
              : `<span style="color:var(--text-3);font-size:11px">今日 ±0（休市或待更新）</span>`
            }
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
          <button class="si-btn del" onclick="APP.removeStock(${i})" title="移除">✕</button>
        </div>`;
      div.querySelector('.si-main').addEventListener('click', () => this.selectStock(s.code, i, 'portfolio'));
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
      const div = document.createElement('div');
      div.className = 'watch-item';
      div.innerHTML = `
        <div class="wi-left" onclick="APP.selectStock('${s.code}',${i},'watch')">
          <div class="wi-code">${s.code}</div>
          <div class="wi-name">${s.name}</div>
          ${sig ? `<div class="wi-signal ${sig.cls}">${sig.short} ${sig.label}</div>` : ''}
        </div>
        <div class="wi-right" onclick="APP.selectStock('${s.code}',${i},'watch')">
          <div class="wi-price ${isUp?'up-color':'dn-color'}">${price>0?price.toFixed(2):'—'}</div>
          <div class="wi-change ${isUp?'up-color':'dn-color'}">${price>0&&Math.abs(chg)>0.001?(isUp?'+':'')+chgPct.toFixed(2)+'%':''}</div>
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
      document.getElementById('chart-name').textContent = `${s.name} ${s.code}`;
      const price = s.price ?? 0;
      const prev  = s.prevClose ?? price;
      const chg = price - prev;
      const chgPct = prev ? chg/prev*100 : 0;
      document.getElementById('chart-price').textContent = price > 0 ? price.toFixed(2) : '—';
      const changeEl = document.getElementById('chart-change');
      // 若 price === prevClose（休市或尚未更新），顯示說明
      if (price > 0 && Math.abs(chg) < 0.01) {
        changeEl.textContent = '+0.00 (休市/待更新)';
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

    const activePeriod = document.querySelector('.period-btn.active')?.dataset.period ?? '3mo';
    const requestedCode = code;
    await CHART.load(code, activePeriod);

    if (this.activeSymbol !== requestedCode) return;

    // ★ K 線載入後，重新取最新 quote（可能已從 K 線資料更新）
    const freshQuote = DATA.cache[code];
    if (freshQuote?.ok && freshQuote.price) {
      const s2 = this.portfolio.find(x => x.code === code) || this.watchlist.find(x => x.code === code);
      if (s2) {
        s2.price = freshQuote.price;
        s2.prevClose = freshQuote.prevClose ?? s2.prevClose;
      }
      // 更新頂部大價格顯示
      const priceEl = document.getElementById('chart-price');
      if (priceEl) priceEl.textContent = freshQuote.price.toFixed(2);
      const chg = freshQuote.price - (freshQuote.prevClose ?? freshQuote.price);
      const chgPct = freshQuote.prevClose ? chg / freshQuote.prevClose * 100 : 0;
      const changeEl = document.getElementById('chart-change');
      if (changeEl) {
        if (Math.abs(chg) < 0.01) {
          changeEl.textContent = '+0.00 (休市/待更新)';
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
function refreshAll() { APP.refreshPrices(true); }
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
function openAddModal() { document.getElementById('add-modal')?.classList.add('show'); }
function openWatchlistModal() { document.getElementById('watch-modal')?.classList.add('show'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('show'); }
function runRecommend() { RECOMMEND.run(); }

function openBuyModal(code, idx) {
  const s = APP.portfolio[idx];
  if (!s) return;
  document.getElementById('buy-code').value = s.code;
  document.getElementById('buy-name').value = s.name;
  document.getElementById('buy-price').value = s.price?.toFixed(2) || s.cost;
  document.getElementById('buy-modal')?.classList.add('show');
  document.getElementById('buy-modal')._idx = idx;
}

function openSellStockModal(code, idx) {
  const s = APP.portfolio[idx];
  if (!s) return;
  document.getElementById('sell-code').value = s.code;
  document.getElementById('sell-name').value = s.name;
  document.getElementById('sell-price').value = s.price?.toFixed(2) || s.cost;
  document.getElementById('sell-max').textContent = `最多 ${s.shares} 股`;
  document.getElementById('sell-modal')?.classList.add('show');
  document.getElementById('sell-modal')._idx = idx;
}

function addStock() {
  const code   = document.getElementById('m-code')?.value.trim();
  let   name   = document.getElementById('m-name')?.value.trim();
  const shares = parseFloat(document.getElementById('m-shares')?.value);
  const cost   = parseFloat(document.getElementById('m-cost')?.value);
  const date   = document.getElementById('m-date')?.value || '';
  if (!code || !shares || !cost) { showToast('請填寫必填欄位（代號、股數、均價）'); return; }
  // 名稱若空白或跟代號一樣，先用代號暫代，等 fetchQuote 回來後自動更新
  if (!name || name === code) name = code;
  const existing = APP.portfolio.find(s => s.code === code);
  if (existing) {
    const totalShares = existing.shares + shares;
    existing.cost = +((existing.cost * existing.shares + cost * shares) / totalShares).toFixed(4);
    existing.shares = +totalShares.toFixed(0);
  } else {
    APP.portfolio.push({ code, name, shares, cost, date, price: cost, prevClose: cost });
  }
  const fee = Math.max(20, Math.round(cost * shares * 0.001425));
  TRADES.add({ date: date||new Date().toISOString().split('T')[0], code, name, action:'buy', shares, price:cost, fee });
  APP.save(); APP.renderAll(); closeModal('add-modal');
  showToast(`已新增 ${name} (${code}) × ${shares}股`);
  ['m-code','m-name','m-shares','m-cost'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  DATA.fetchQuote(code).then(q => {
    const s = APP.portfolio.find(x => x.code === code);
    if (s && q.ok) {
      if (q.price) { s.price = q.price; s.prevClose = q.prevClose; }
      // 自動更新股票名稱（若原本是暫代的代號）
      if (q.name && q.name !== code && (s.name === code || !s.name)) {
        s.name = q.name;
      }
      APP.save();
      APP.renderAll();
      PIE.render();
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
  const fee = Math.max(20, Math.round(price * shares * 0.001425));
  TRADES.add({ date, code:s.code, name:s.name, action:'buy', shares, price, fee });
  APP.save(); APP.renderAll(); closeModal('buy-modal');
  showToast(`${s.name} 加碼 ${shares}股 @ $${price}，新均價 $${s.cost.toFixed(2)}`);
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
  const tradeValue = price * shares;
  const pnl = (price - s.cost) * shares;
  const sellTax = Math.round(tradeValue * 0.003);
  const fee = Math.max(20, Math.round(tradeValue * 0.001425));
  const totalFee = fee + sellTax;
  const pnlDisplay = Math.abs(pnl) >= 10000 ? `${(pnl/10000).toFixed(2)}萬` : `${pnl.toFixed(0)}元`;
  TRADES.add({ date, code:s.code, name:s.name, action:'sell', shares, price, fee:totalFee, note:`損益${pnl>=0?'+':''}${pnlDisplay}` });
  s.shares = +(s.shares - shares).toFixed(0);
  if (s.shares <= 0) { APP.portfolio.splice(idx, 1); if (APP.activeSymbol === s.code) APP.activeSymbol = ''; }
  APP.save(); APP.renderAll(); closeModal('sell-modal'); TRADES.render();
  showToast(`${s.name} 賣出 ${shares}股 @ $${price}，${pnl>=0?'獲利':'虧損'}${pnlDisplay}（稅費$${totalFee}）`);
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
  code = (code || '').trim();
  const nameEl = document.getElementById(targetId);
  if (!nameEl || code.length < 4) return;
  clearTimeout(_fetchNameTimer);
  _fetchNameTimer = setTimeout(async () => {
    nameEl.placeholder = '抓取中...';
    try {
      const q = await DATA.fetchQuote(code);
      if (q.ok && q.name && q.name !== code) {
        nameEl.placeholder = q.name;
        if (!nameEl.value || nameEl.value === code) nameEl.value = q.name;
      } else {
        nameEl.placeholder = '請手動輸入名稱';
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
  s.corsProxy    = document.getElementById('cors-proxy')?.value.trim();
  s.finmindToken = document.getElementById('finmind-token')?.value.trim();
  s.ejsService   = document.getElementById('ejs-service')?.value.trim();
  s.ejsTemplate  = document.getElementById('ejs-template')?.value.trim();
  s.ejsPubkey    = document.getElementById('ejs-pubkey')?.value.trim();
  s.jsonbinKey   = document.getElementById('jsonbin-key')?.value.trim();
  s.jsonbinBin   = document.getElementById('jsonbin-bin')?.value.trim();
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
