// ── app.js  ── Main orchestration v2
// Handles: portfolio, watchlist, trades, goals, cross-stock orders,
//          pie chart, target dashboard, notifications, Claude AI rec

// ── GOALS module ──────────────────────────────────────
const GOALS = {
  defaults: { target: 3000000, years: 2.5, purpose: '買房頭期款', strategy: 'long' },

  get() {
    return JSON.parse(localStorage.getItem('twsa-goals') || 'null') || this.defaults;
  },

  save(data) {
    localStorage.setItem('twsa-goals', JSON.stringify(data));
  },

  // ── Update target dashboard ──
  updateDashboard() {
    const g = this.get();
    const totalVal = APP._calcTotalValue();
    const target = g.target;
    const diff = target - totalVal;
    const pct = Math.min(100, totalVal / target * 100);
    const startDate = g.startDate ? new Date(g.startDate) : new Date(Date.now() - 365 * 86400000);
    const monthsPassed = (Date.now() - startDate.getTime()) / (30.44 * 86400000);
    const initialVal = g.initialValue || totalVal * 0.8;
    const annualReturn = monthsPassed > 0.5
      ? ((totalVal / initialVal) ** (12 / monthsPassed) - 1) * 100
      : 0;
    const yearsNeeded = annualReturn > 0
      ? Math.log(target / totalVal) / Math.log(1 + annualReturn / 100)
      : null;
    const eta = yearsNeeded !== null
      ? new Date(Date.now() + yearsNeeded * 365 * 86400000).toLocaleDateString('zh-TW', { year:'numeric', month:'short' })
      : '—';
    const requiredAnnual = totalVal > 0
      ? (((target / totalVal) ** (1 / g.years)) - 1) * 100
      : 0;

    const fmtM = v => v >= 1e6 ? (v/1e4).toFixed(0)+'萬' : v >= 1e4 ? (v/1e4).toFixed(1)+'萬' : v.toFixed(0);

    const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
    const setW = (id, w) => { const el = document.getElementById(id); if(el) el.style.width = w; };

    set('goal-current-val', fmtM(totalVal));
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
  },
};

// ── TRADES module ──────────────────────────────────────
const TRADES = {
  get() {
    return JSON.parse(localStorage.getItem('twsa-trades') || '[]');
  },

  add(trade) {
    // trade: { date, code, name, action:'buy'|'sell', shares, price, fee }
    const trades = this.get();
    trades.unshift({ ...trade, id: Date.now() });
    localStorage.setItem('twsa-trades', JSON.stringify(trades));
  },

  render() {
    const list = document.getElementById('trade-list');
    if (!list) return;
    const trades = this.get();
    if (!trades.length) {
      list.innerHTML = '<div class="empty-state">暫無交易紀錄</div>';
      return;
    }
    list.innerHTML = trades.slice(0, 50).map(t => {
      const isBuy = t.action === 'buy';
      const total = t.shares * t.price;  // shares = 股數
      const fee = t.fee || 0;
      const totalDisplay = total >= 10000
        ? `${(total/10000).toFixed(2)}萬`
        : `${total.toFixed(0)}元`;
      // 顯示：若 shares >= 1000 才顯示張數
      const sharesDisplay = t.shares >= 1000
        ? `${(t.shares/1000).toFixed(t.shares%1000===0?0:2)}張`
        : `${t.shares}股`;
      return `
        <div class="trade-item">
          <div class="ti-left">
            <span class="ti-action ${isBuy ? 'buy' : 'sell'}">${isBuy ? '買進' : '賣出'}</span>
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

// ── ORDER module ──────────────────────────────────────
const ORDER = {
  suggestEntry: 0,
  suggestSL: 0,
  suggestTP: 0,
  score: 0,

  // Calculate per-stock order (for AI suggestion panel)
  calcSingle() {
    const budget   = parseFloat(document.getElementById('budget')?.value) || 100000;
    const strategy = document.getElementById('strategy-select')?.value ?? 'auto';
    const price    = this.suggestEntry || APP.getActiveStock()?.price || 100;
    if (!price) return;

    // 每次建議買多少股：以預算直接除以股價，不乘1000
    let batches = 3;
    if (strategy === 'single') batches = 1;
    else if (strategy === 'batch2') batches = 2;
    else if (strategy === 'batch3') batches = 3;
    else if (strategy === 'batch4') batches = 4;
    else {
      // 自動：依預算和訊號強度決定批次
      if (budget < price * 200) batches = 1;        // 預算不足買200股
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
    const FEE_RATE = 0.001425;
    ratios.forEach((ratio, i) => {
      const batchBudget = budget * ratio;
      const batchPrice  = +(price * (1 + offsets[i])).toFixed(2);
      const shares = Math.max(1, Math.floor(batchBudget / batchPrice));  // 股數
      const cost = shares * batchPrice;
      const fee  = Math.max(20, Math.round(cost * FEE_RATE));
      totalCost += cost + fee; totalShares += shares;
      // 顯示：張/股
      const sharesDisp = shares >= 1000
        ? `${(shares/1000).toFixed(shares%1000===0?0:1)}張${shares%1000>0?`${shares%1000}股`:''}`
        : `${shares}股`;
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
      footer.innerHTML = `<span>合計：<strong>${totalShares}股</strong>，含手續費 <strong>${totalDisp}</strong></span><span>剩餘：${remDisp}（${(remain/budget*100).toFixed(0)}%）</span>`;
    }
  },

  // Cross-portfolio allocation
  calcPortfolio() {
    const budgetEl = document.getElementById('portfolio-budget');
    if (!budgetEl) return;
    const totalBudget = parseFloat(budgetEl.value) || 0;
    if (!totalBudget || !APP.portfolio.length) return;

    // Score each stock
    const stocks = APP.portfolio.filter(s => s.price);
    if (!stocks.length) return;

    const scored = stocks.map(s => {
      // Use cached analysis data or estimate
      const cacheKey = s.code;
      const ind = (ANALYSIS.lastSymbol === s.code && ANALYSIS.lastInd) ? ANALYSIS.lastInd : null;
      const score = ind ? ANALYSIS._calcScore(ind) : 0;
      const price = s.price;
      const gainPct = (price - s.cost) / s.cost * 100;
      // Adjust: don't buy if already down a lot (might be in trouble)
      const adj = gainPct < -8 ? score - 1 : gainPct > 20 ? score - 0.5 : score;
      return { ...s, score: adj, gainPct };
    });

    // Only allocate to positive-score stocks
    const eligible = scored.filter(s => s.score > 0);
    if (!eligible.length) {
      const el = document.getElementById('portfolio-alloc-result');
      if (el) el.innerHTML = '<div class="alloc-empty">目前各股技術評分均偏空，建議保留現金觀察</div>';
      return;
    }

    const totalScore = eligible.reduce((a, s) => a + Math.max(0.1, s.score), 0);
    const allocs = eligible.map(s => {
      const ratio = Math.max(0.1, s.score) / totalScore;
      const budget = totalBudget * ratio;
      const shares = Math.max(0, Math.floor(budget / s.price));  // 股數，不是張數
      const cost = shares * s.price;
      const fee = Math.max(20, Math.round(cost * 0.001425));
      const batches = s.score >= 3 ? '建議分2批' : '建議單次';
      const sharesDisp = shares >= 1000
        ? `${(shares/1000).toFixed(1)}張`
        : `${shares}股`;
      const costDisp = cost >= 10000 ? `${(cost/10000).toFixed(2)}萬` : `${cost.toFixed(0)}元`;
      return { ...s, ratio, budget, shares, cost, fee, batches, sharesDisp, costDisp };
    });

    const el = document.getElementById('portfolio-alloc-result');
    if (!el) return;
    let html = `<div class="alloc-header">預算 ${(totalBudget/10000).toFixed(1)}萬 → 分配建議</div>`;
    allocs.forEach(a => {
      const barW = (a.ratio * 100).toFixed(0);
      html += `
        <div class="alloc-item">
          <div class="alloc-stock">
            <span class="alloc-code">${a.code}</span>
            <span class="alloc-name">${a.name}</span>
            <span class="alloc-score score-${a.score>=2?'pos':a.score<0?'neg':'neu'}">${a.score>=0?'+':''}${a.score.toFixed(1)}分</span>
          </div>
          <div class="alloc-bar-wrap"><div class="alloc-bar" style="width:${barW}%"></div></div>
          <div class="alloc-detail">
            ${a.shares>0 ? `買${a.sharesDisp}，約${a.costDisp}，手續費$${a.fee}` : '預算不足購買1股'}
            <span class="alloc-strategy">${a.batches}</span>
          </div>
        </div>`;
    });
    const used = allocs.reduce((a, s) => a + s.cost + s.fee, 0);
    const usedDisp = used >= 10000 ? `${(used/10000).toFixed(2)}萬` : `${used.toFixed(0)}元`;
    const remDisp = (totalBudget-used) >= 10000 ? `${((totalBudget-used)/10000).toFixed(2)}萬` : `${(totalBudget-used).toFixed(0)}元`;
    html += `<div class="alloc-footer">已分配${usedDisp}，剩餘${remDisp}現金</div>`;
    el.innerHTML = html;
  },
};

// ── PIE CHART ─────────────────────────────────────────
const PIE = {
  instance: null,

  render() {
    const canvas = document.getElementById('pieChart');
    if (!canvas || !APP.portfolio.length) return;
    const stocks = APP.portfolio.filter(s => s.price);
    const labels = stocks.map(s => `${s.code} ${s.name}`);
    const data = stocks.map(s => s.price * s.shares);   // shares = 股數
    const colors = ['#E24B4A','#1D9E75','#378ADD','#EF9F27','#D4537E','#5DCAA5','#F09595','#9FE1CB','#FAC775','#B5D4F4'];

    if (this.instance) { this.instance.destroy(); this.instance = null; }
    this.instance = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data, backgroundColor: colors.slice(0, stocks.length), borderWidth: 2, borderColor: 'var(--bg-1)' }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: 'rgba(255,255,255,0.6)', font: { size: 11 }, padding: 10, boxWidth: 10 },
          },
          tooltip: {
            callbacks: {
              label: ctx => {
                const val = ctx.raw;
                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                const valDisp = val >= 10000 ? `${(val/10000).toFixed(1)}萬` : `${val.toFixed(0)}元`;
                return ` ${valDisp} (${(val/total*100).toFixed(1)}%)`;
              }
            }
          }
        },
        onClick: (e, els) => {
          if (!els.length) return;
          const idx = els[0].index;
          const s = stocks[idx];
          if (s) APP.selectStock(s.code, APP.portfolio.indexOf(s), 'portfolio');
        },
      },
    });
  },
};

// ── RECOMMEND module（純規則引擎，無需 API）─────────────
const RECOMMEND = {
  // 候選股票資料庫：涵蓋 ETF、權值股、各產業龍頭
  CANDIDATES: [
    // ETF
    { code:'0050', name:'元大台灣50',     sector:'ETF',   type:'ETF',    risk:'低', reason:'追蹤台灣前50大市值公司，長期持有最穩健的選擇，年化報酬約8-12%。', logic:'定期定額買入，適合作為投資組合核心部位（建議佔比30-50%）。' },
    { code:'0056', name:'元大高股息',     sector:'ETF',   type:'ETF',    risk:'低', reason:'高股息策略，每年穩定配息，適合長期存股。', logic:'股息再投入複利效果佳，適合保守型長期持有。' },
    { code:'00878',name:'國泰永續高股息', sector:'ETF',   type:'ETF',    risk:'低', reason:'ESG + 高股息雙重篩選，成分股品質較高，月月配息。', logic:'適合需要穩定現金流的長期投資人。' },
    { code:'006208',name:'富邦台50',      sector:'ETF',   type:'ETF',    risk:'低', reason:'與0050相近但管理費更低，適合長期持有。', logic:'低費用率讓長期複利效果更好。' },
    // 半導體
    { code:'2330', name:'台積電',         sector:'半導體', type:'權值股', risk:'中', reason:'全球最先進晶圓代工廠，AI/HPC需求持續驅動成長，護城河極深。', logic:'長期持有跟著台灣科技產業成長，是台股不可缺少的核心持股。' },
    { code:'2454', name:'聯發科',         sector:'半導體', type:'權值股', risk:'中', reason:'手機AP + AI晶片雙引擎，中低階市場龍頭，受惠AI終端普及。', logic:'AI on device趨勢受惠股，中長期成長動能明確。' },
    { code:'2303', name:'聯電',           sector:'半導體', type:'權值股', risk:'中', reason:'成熟製程需求穩定，車用/工業用晶片長期需求支撐。', logic:'殖利率佳，適合長期存股兼具成長潛力。' },
    // 電子製造
    { code:'2317', name:'鴻海',           sector:'電子',  type:'權值股', risk:'中', reason:'全球最大電子代工廠，積極布局電動車（MIH平台）和AI伺服器。', logic:'本益比低、殖利率穩定，電動車轉型是長期催化劑。' },
    { code:'2382', name:'廣達',           sector:'電子',  type:'成長股', risk:'中', reason:'AI伺服器最大受惠者之一，輝達合作夥伴，GB200訂單強勁。', logic:'AI基礎建設需求爆發，長期成長能見度高。' },
    { code:'3231', name:'緯創',           sector:'電子',  type:'成長股', risk:'中高', reason:'AI伺服器ODM大廠，與鴻海並列AI伺服器雙雄。', logic:'受惠AI資本支出超週期，但波動較大需分批布局。' },
    // 金融
    { code:'2882', name:'國泰金',         sector:'金融',  type:'存股',   risk:'低中', reason:'台灣最大壽險公司，股息穩定，利率上升環境有利。', logic:'長期存股標的，每年穩定配息，適合保守型投資人。' },
    { code:'2881', name:'富邦金',         sector:'金融',  type:'存股',   risk:'低中', reason:'獲利能力強的綜合金控，旗下富邦人壽、台北富邦銀行。', logic:'金融股防禦性強，適合作為組合中的穩定配置。' },
    // 傳產/民生
    { code:'1301', name:'台塑',           sector:'石化',  type:'存股',   risk:'低中', reason:'台灣石化龍頭，股息穩定，景氣復甦受惠股。', logic:'高殖利率存股，低本益比，適合保守型長期持有。' },
    { code:'2412', name:'中華電',         sector:'電信',  type:'存股',   risk:'低', reason:'台灣最大電信公司，現金流穩定，殖利率4-5%，防禦性強。', logic:'景氣不佳時的避風港，適合作為組合中的防禦部位。' },
  ],

  run() {
    const el = document.getElementById('rec-result');
    if (!el) return;

    const portfolio = APP.portfolio;
    const goals = GOALS.get();
    const ownedCodes = new Set(portfolio.map(s => s.code));
    const totalVal = APP._calcTotalValue();

    // 分析現有持股結構
    const sectorMap = {};
    portfolio.forEach(s => {
      const match = this.CANDIDATES.find(c => c.code === s.code);
      if (match) sectorMap[match.sector] = (sectorMap[match.sector] || 0) + 1;
    });

    // 評分：依據分散化、風險、目標
    const scored = this.CANDIDATES
      .filter(c => !ownedCodes.has(c.code))
      .map(c => {
        let score = 0;
        // ETF 基礎分數高（長期投資首選）
        if (c.type === 'ETF') score += 3;
        // 低風險加分
        if (c.risk === '低') score += 2;
        else if (c.risk === '低中') score += 1;
        // 分散化：未有的產業加分
        if (!sectorMap[c.sector]) score += 2;
        // 長期目標適合加分
        if (goals.years >= 2 && (c.type === 'ETF' || c.type === '存股')) score += 1;
        // 成長目標且偏積極加分
        if (c.type === '成長股' && goals.target > 2000000) score += 1;
        return { ...c, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (!scored.length) {
      el.innerHTML = '<div class="rec-card"><div class="rec-body">你已持有所有推薦標的，投資組合相當完整！</div></div>';
      return;
    }

    const riskColor = { '低':'#1D9E75', '低中':'#5DCAA5', '中':'#EF9F27', '中高':'#E24B4A', '高':'#E24B4A' };

    el.innerHTML = `
      <div style="font-size:11px;color:var(--text-3);margin-bottom:12px;padding:8px 10px;background:var(--bg-2);border-radius:6px;line-height:1.6">
        📊 根據你的投資目標（${(goals.target/10000).toFixed(0)}萬 / ${goals.years}年）與現有持股結構，以下是建議補強的標的：
      </div>
      ${scored.map((c, i) => `
        <div class="rec-card">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span style="font-size:11px;font-weight:700;background:var(--bg-3);border-radius:4px;padding:2px 7px;color:var(--text-3)">#${i+1}</span>
            <span style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:var(--text-1)">${c.code}</span>
            <span style="font-size:13px;font-weight:600">${c.name}</span>
            <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg-3);color:var(--text-2)">${c.sector}</span>
            <span style="font-size:10px;padding:2px 6px;border-radius:4px;color:${riskColor[c.risk]};background:${riskColor[c.risk]}22">風險${c.risk}</span>
          </div>
          <div style="font-size:12px;color:var(--text-2);line-height:1.7;margin-bottom:6px">
            <span style="color:var(--text-3)">推薦理由：</span>${c.reason}
          </div>
          <div style="font-size:12px;color:var(--text-2);line-height:1.7">
            <span style="color:var(--text-3)">投資邏輯：</span>${c.logic}
          </div>
        </div>`).join('')}
      <div style="font-size:11px;color:var(--text-3);margin-top:8px;padding:8px 10px;background:var(--bg-2);border-radius:6px;line-height:1.6">
        ⚠️ 以上為規則引擎根據長期投資原則產生的參考建議，不構成投資建議。投資前請自行研究，股票市場有風險。
      </div>`;
  },
};

// ── APP module ────────────────────────────────────────
const APP = {
  portfolio: JSON.parse(localStorage.getItem('twsa-portfolio') || '[]'),
  watchlist: JSON.parse(localStorage.getItem('twsa-watchlist') || '[]'),
  activeSymbol: '',
  activeIdx: -1,
  _source: 'portfolio',
  refreshTimer: null,
  settings: JSON.parse(localStorage.getItem('twsa-settings') || '{}'),

  async init() {
    CHART.init();
    this._loadSettings();
    this._setupTabs();
    this._setupMainTabs();

    // Init prices
    this.portfolio.forEach(s => { s.price = s.price ?? s.cost; s.prevClose = s.prevClose ?? s.cost; });
    this.watchlist.forEach(s => { s.price = s.price ?? 0; s.prevClose = s.prevClose ?? 0; });

    this.renderAll();
    this.updateClock();
    this._updateMarketStatus();

    // Empty states
    if (this.portfolio.length === 0) this._showEmptyPortfolio();
    if (this.watchlist.length === 0) this._showEmptyWatchlist();

    await this.refreshPrices();

    if (this.portfolio.length > 0) this.selectStock(this.portfolio[0].code, 0, 'portfolio');

    this.refreshTimer = setInterval(() => this.refreshPrices(), 60000);
    setInterval(() => this.updateClock(), 1000);
    setInterval(() => this._updateMarketStatus(), 60000);

    DATA.fetchIndexes();
    setInterval(() => DATA.fetchIndexes(), 120000);

    PIE.render();
    GOALS.updateDashboard();
    TRADES.render();
  },

  _calcTotalValue() {
    // shares = 股數（零股單位），不是張數
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
    if (el) el.textContent = new Date().toLocaleTimeString('zh-TW', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false });
  },

  _updateMarketStatus() {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const isWeekday = now.getDay() >= 1 && now.getDay() <= 5;
    const isOpen = isWeekday && (h > 9 || (h === 9 && m >= 0)) && (h < 13 || (h === 13 && m <= 30));
    const el = document.getElementById('mkt-status');
    if (el) { el.textContent = isOpen ? '開盤中' : '休市'; el.className = isOpen ? 'badge open' : 'badge closed'; }
    const dot = document.getElementById('live-dot');
    if (dot) dot.style.opacity = isOpen ? '1' : '0.3';
  },

  async refreshPrices() {
    const btn = document.querySelector('.icon-btn[data-action="refresh"]');
    if (btn) { btn.classList.add('spinning'); }
    document.querySelectorAll('.stock-item').forEach(el => el.classList.add('loading-price'));

    await DATA.updateAllPrices(this.portfolio, () => { this.renderPortfolioSummary(); this.renderStockList(); });
    await DATA.updateAllPrices(this.watchlist, () => { this.renderWatchlist(); });

    document.querySelectorAll('.stock-item').forEach(el => el.classList.remove('loading-price'));
    if (btn) btn.classList.remove('spinning');
    this._updateMarketStatus();
    PIE.render();
    GOALS.updateDashboard();
    showToast('報價已更新');
  },

  renderAll() {
    this.renderPortfolioSummary();
    this.renderStockList();
    this.renderWatchlist();
    PIE.render();
    GOALS.updateDashboard();
  },

  renderPortfolioSummary() {
    let totalVal = 0, totalCost = 0, dayPnl = 0;
    this.portfolio.forEach(s => {
      const price = s.price ?? s.cost;
      const prev  = s.prevClose ?? s.cost;
      totalVal  += price * s.shares;       // shares = 股數
      totalCost += s.cost  * s.shares;
      dayPnl    += (price - prev) * s.shares;
    });
    const pnl = totalVal - totalCost;
    const roi = totalCost > 0 ? pnl / totalCost * 100 : 0;
    const dayPct = totalCost > 0 ? dayPnl / totalCost * 100 : 0;
    const fmtVal = n => {
      const abs = Math.abs(n);
      if (abs >= 1e6) return (n/1e4).toFixed(1)+'萬';
      if (abs >= 1e4) return (n/1e4).toFixed(2)+'萬';
      return n.toFixed(0)+'元';
    };

    setText('total-value', fmtVal(totalVal), 'neutral');
    setText('total-cost', '成本 '+fmtVal(totalCost), '');
    setSignedText('total-pnl', pnl, fmtVal);
    setSignedText('total-pnl-pct', roi, v => v.toFixed(2)+'%', true);
    setSignedText('day-pnl', dayPnl, fmtVal);
    setSignedText('day-pnl-pct', dayPct, v => v.toFixed(2)+'%', true);
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
      const pnl    = (price - s.cost) * s.shares;   // shares = 股數
      const pnlPct = (price - s.cost) / s.cost * 100;
      const isUp   = chg >= 0;
      const isActive = s.code === this.activeSymbol;
      // 顯示單位：若 shares >= 1000 才顯示張數，否則顯示股數
      const sharesDisplay = s.shares >= 1000
        ? `${(s.shares/1000).toFixed(s.shares%1000===0?0:2)}張`
        : `${s.shares}股`;
      const pnlDisplay = Math.abs(pnl) >= 10000
        ? `${pnl>=0?'+':''}${(pnl/10000).toFixed(2)}萬`
        : `${pnl>=0?'+':''}${pnl.toFixed(0)}元`;

      const div = document.createElement('div');
      div.className = 'stock-item' + (isActive ? ' active' : '');
      div.innerHTML = `
        <div class="si-main" data-code="${s.code}" data-idx="${i}">
          <div class="si-row1">
            <span class="si-code">${s.code}</span>
            <span class="si-price ${isUp?'up-color':'dn-color'}">${price.toFixed(2)}</span>
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
            <span class="${isUp?'up-color':'dn-color'}">${isUp?'▲':'▼'}${Math.abs(chg).toFixed(2)} (${Math.abs(chgPct).toFixed(2)}%)</span>
          </div>
        </div>
        <div class="si-actions">
          <button class="si-btn buy" onclick="openBuyModal('${s.code}', ${i})" title="加碼">＋</button>
          <button class="si-btn sell" onclick="openSellStockModal('${s.code}', ${i})" title="賣出">－</button>
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
      const div = document.createElement('div');
      div.className = 'watch-item';
      div.innerHTML = `
        <div class="wi-left" onclick="APP.selectStock('${s.code}',${i},'watch')">
          <div class="wi-code">${s.code}</div>
          <div class="wi-name">${s.name}</div>
        </div>
        <div class="wi-right" onclick="APP.selectStock('${s.code}',${i},'watch')">
          <div class="wi-price ${isUp?'up-color':'dn-color'}">${price>0?price.toFixed(2):'—'}</div>
          <div class="wi-change ${isUp?'up-color':'dn-color'}">${price>0?(isUp?'+':'')+chgPct.toFixed(2)+'%':''}</div>
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
      changeEl.textContent = price > 0 ? `${chg>=0?'+':''}${chg.toFixed(2)} (${chgPct>=0?'+':''}${chgPct.toFixed(2)}%)` : '';
      changeEl.className = 'chart-change ' + (chg >= 0 ? 'up-color' : 'dn-color');
    }
    this.renderStockList();
    const activePeriod = document.querySelector('.period-btn.active')?.dataset.period ?? '3mo';
    await CHART.load(code, activePeriod);
    ORDER.calcSingle();
  },

  getActiveStock() {
    if (!this.activeSymbol) return null;
    return this.portfolio.find(s => s.code === this.activeSymbol) ||
           this.watchlist.find(s => s.code === this.activeSymbol) || null;
  },

  save() {
    localStorage.setItem('twsa-portfolio', JSON.stringify(this.portfolio));
    localStorage.setItem('twsa-watchlist', JSON.stringify(this.watchlist));
  },

  removeStock(idx) {
    if (!confirm(`確定要移除 ${this.portfolio[idx]?.name}？`)) return;
    const s = this.portfolio.splice(idx, 1)[0];
    this.save();
    this.renderAll();
    if (s.code === this.activeSymbol) { this.activeSymbol = ''; document.getElementById('chart-name').textContent = '請選擇股票'; }
    showToast(`已移除 ${s.name}`);
  },

  removeWatch(idx) {
    const s = this.watchlist.splice(idx, 1)[0];
    this.save();
    this.renderWatchlist();
    showToast(`已移除 ${s.name}`);
  },

  _setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const panel = btn.closest('.card')?.querySelector('.tab-btn.active')?.dataset.tab;
        btn.closest('.tab-nav').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const pane = btn.dataset.tab;
        btn.closest('.card')?.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        document.getElementById(`pane-${pane}`)?.classList.add('active');
        if (pane === 'tech' && CHART.currentData.length) { CHART.drawMACD(CHART.currentData); CHART.drawKD(CHART.currentData); }
        if (pane === 'pie') PIE.render();
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
        if (btn.dataset.mtab === 'goal') GOALS.updateDashboard();
        if (btn.dataset.mtab === 'trades') TRADES.render();
        if (btn.dataset.mtab === 'recommend') { /* just show */ }
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
    const data = {
      portfolio: this.portfolio,
      watchlist: this.watchlist,
      trades: TRADES.get(),
      goals: GOALS.get(),
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
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
        this.save();
        this.renderAll();
        TRADES.render();
        GOALS.updateDashboard();
        showToast('資料已匯入');
      } catch(err) { showToast('匯入失敗，請確認檔案格式'); }
    };
    reader.readAsText(file);
  },
};

// ── Global functions ──────────────────────────────────

function refreshAll() { APP.refreshPrices(); }
function openSettings() { document.getElementById('settings-modal')?.classList.add('show'); }
function runAnalysis() { if (CHART.currentData.length) ANALYSIS.run(CHART.currentData, APP.activeSymbol); else showToast('請先選擇股票'); }
function calcOrder() { ORDER.calcSingle(); }
function calcPortfolio() { ORDER.calcPortfolio(); }

function openAddModal() {
  document.getElementById('add-modal')?.classList.add('show');
}

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

function openWatchlistModal() { document.getElementById('watch-modal')?.classList.add('show'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('show'); }

function addStock() {
  const code   = document.getElementById('m-code')?.value.trim();
  const name   = document.getElementById('m-name')?.value.trim();
  const shares = parseFloat(document.getElementById('m-shares')?.value);  // 股數（支援零股）
  const cost   = parseFloat(document.getElementById('m-cost')?.value);
  const date   = document.getElementById('m-date')?.value || '';
  if (!code || !name || !shares || !cost) { showToast('請填寫必填欄位'); return; }

  // 若已存在同代號 → 加權平均成本合併
  const existing = APP.portfolio.find(s => s.code === code);
  if (existing) {
    const totalShares = existing.shares + shares;
    existing.cost = +((existing.cost * existing.shares + cost * shares) / totalShares).toFixed(4);
    existing.shares = +totalShares.toFixed(0);
  } else {
    APP.portfolio.push({ code, name, shares, cost, date, price: cost, prevClose: cost });
  }

  // 手續費：零股也適用，以實際金額計算
  const tradeValue = cost * shares;
  const fee = Math.max(20, Math.round(tradeValue * 0.001425)); // 最低手續費 $20
  TRADES.add({ date: date || new Date().toISOString().split('T')[0], code, name, action:'buy', shares, price: cost, fee });

  APP.save(); APP.renderAll(); closeModal('add-modal');
  showToast(`已新增 ${name} (${code}) × ${shares}股`);
  ['m-code','m-name','m-shares','m-cost'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  DATA.fetchQuote(code).then(q => {
    const s = APP.portfolio.find(x => x.code === code);
    if (s && q.ok && q.price) { s.price = q.price; s.prevClose = q.prevClose; APP.renderAll(); PIE.render(); }
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
  TRADES.add({ date, code: s.code, name: s.name, action:'buy', shares, price, fee });

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
  const sellTax = Math.round(tradeValue * 0.003);   // 交易稅 0.3%
  const fee = Math.max(20, Math.round(tradeValue * 0.001425));
  const totalFee = fee + sellTax;

  const pnlDisplay = Math.abs(pnl) >= 10000
    ? `${(pnl/10000).toFixed(2)}萬`
    : `${pnl.toFixed(0)}元`;

  TRADES.add({ date, code: s.code, name: s.name, action:'sell', shares, price, fee: totalFee,
    note: `損益${pnl>=0?'+':''}${pnlDisplay}` });

  s.shares = +(s.shares - shares).toFixed(0);
  if (s.shares <= 0) {
    APP.portfolio.splice(idx, 1);
    if (APP.activeSymbol === s.code) APP.activeSymbol = '';
  }
  APP.save(); APP.renderAll(); closeModal('sell-modal');
  TRADES.render();
  showToast(`${s.name} 賣出 ${shares}股 @ $${price}，${pnl>=0?'獲利':'虧損'}${pnlDisplay}（稅費$${totalFee}）`);
}

function addWatchlist() {
  const code = document.getElementById('w-code')?.value.trim();
  const name = document.getElementById('w-name')?.value.trim();
  if (!code || !name) { showToast('請填寫代號與名稱'); return; }
  if (APP.watchlist.find(x => x.code === code)) { showToast('已存在於自選清單'); return; }
  APP.watchlist.push({ code, name, price: 0, prevClose: 0 });
  APP.save(); APP.renderWatchlist(); closeModal('watch-modal');
  showToast(`已加入自選：${name}`);
  document.getElementById('w-code').value = '';
  document.getElementById('w-name').value = '';
  DATA.fetchQuote(code).then(q => {
    const s = APP.watchlist.find(x => x.code === code);
    if (s && q.ok && q.price) { s.price = q.price; s.prevClose = q.prevClose; APP.renderWatchlist(); }
  });
}

function saveSettings() {
  const s = APP.settings;
  s.corsProxy   = document.getElementById('cors-proxy')?.value.trim();
  s.ejsService  = document.getElementById('ejs-service')?.value.trim();
  s.ejsTemplate = document.getElementById('ejs-template')?.value.trim();
  s.ejsPubkey   = document.getElementById('ejs-pubkey')?.value.trim();
  // Goals
  const gTarget = parseFloat(document.getElementById('goal-target-input')?.value) * 10000;
  const gYears  = parseFloat(document.getElementById('goal-years-input')?.value);
  if (gTarget && gYears) {
    const g = GOALS.get();
    g.target = gTarget; g.years = gYears;
    if (!g.startDate) g.startDate = new Date().toISOString().split('T')[0];
    if (!g.initialValue) g.initialValue = APP._calcTotalValue();
    GOALS.save(g);
  }
  localStorage.setItem('twsa-settings', JSON.stringify(s));
  if (s.corsProxy) DATA.proxies[0] = s.corsProxy;
  closeModal('settings-modal');
  GOALS.updateDashboard();
  showToast('設定已儲存');
}

function toggleDarkMode(checked) {
  document.body.classList.toggle('light-mode', !checked);
  APP.settings.darkMode = checked;
  localStorage.setItem('twsa-settings', JSON.stringify(APP.settings));
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

// ── Helpers ───────────────────────────────────────────
function setText(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (cls !== undefined) el.className = el.className.replace(/\b(up|dn|neutral)\b/g, '') + ' ' + cls;
}
function setSignedText(id, val, fmtFn, isPct = false) {
  const el = document.getElementById(id);
  if (!el) return;
  const isUp = val >= 0;
  el.textContent = (isUp ? '+' : '') + fmtFn(val);
  el.className = el.className.replace(/\b(up|dn|neutral)\b/g, '') + (isUp ? ' up' : ' dn');
}
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── Modal overlay close ───────────────────────────────
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('show'); });
});

// ── Keyboard shortcuts ────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
});

// ── Boot ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => APP.init());
window.addEventListener('resize', () => { if (CHART.currentData.length) CHART.draw(); });
