// ── app.js ── Main orchestration v5 (Excel Data Fully Integrated)
// 修正：1. 休市停止更新 2. 歷史數據注入 3. 年化報酬公式修復

// ── DATA & HISTORY (截圖數據注入) ────────────────────
const EXCEL_SNAPSHOTS = [
  { date: "2025-12-05", value: 36000 },
  { date: "2025-12-18", value: 59997 },
  { date: "2026-01-12", value: 95997 },
  { date: "2026-01-13", value: 95997 },
  { date: "2026-01-15", value: 119997 },
  { date: "2026-01-28", value: 118435 },
  { date: "2026-02-05", value: 151461 },
  { date: "2026-02-15", value: 176873 },
  { date: "2026-02-25", value: 179882 },
  { date: "2026-03-03", value: 182808 },
  { date: "2026-03-05", value: 212947 },
  { date: "2026-03-15", value: 230947 },
  { date: "2026-03-23", value: 233274 },
  { date: "2026-04-16", value: 268851 },
  { date: "2026-04-23", value: 280304 }
];

// ── GOALS module ────────────────────
const GOALS = {
  defaults: { target: 25000000, years: 2.5, purpose: '買房頭期款', strategy: 'long', cashTWD: 65440, cashUSD: 2100 },

  get() { return JSON.parse(localStorage.getItem('twsa-goals') || 'null') || this.defaults; },
  save(data) {
    data._lastSyncedAt = new Date().toISOString();
    localStorage.setItem('twsa-goals', JSON.stringify(data));
    SYNC.markDirty();
  },

  // 1. 確保歷史曲線包含 Excel 數據
  recordSnapshot() {
    let history = JSON.parse(localStorage.getItem('twsa-value-history') || '[]');
    
    // 如果是第一次使用或資料太少，先載入 Excel 截圖數據
    if (history.length < EXCEL_SNAPSHOTS.length) {
      history = [...EXCEL_SNAPSHOTS];
    }

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
    const stockVal = APP._calcTotalValue(); // 從 APP 模組計算持股總市值
    const cashTWD = parseFloat(g.cashTWD) || 0;
    const cashUSD = parseFloat(g.cashUSD) || 0;
    const usdRate = CURRENCY.usdRate || 31.5;
    return stockVal + cashTWD + (cashUSD * usdRate);
  },

  updateDashboard() {
    const g = this.get();
    const totalVal = this._calcTotal();
    const target = g.target || 25000000;
    const pct = Math.min(100, (totalVal / target) * 100);

    // 2. 修正：計算年化報酬 (CAGR) 與 預計達標
    let history = JSON.parse(localStorage.getItem('twsa-value-history') || '[]');
    if (history.length < 2) history = [...EXCEL_SNAPSHOTS];

    let annualReturn = 0;
    let eta = '—';

    if (history.length >= 2) {
      const first = history[0];
      const last = history[history.length - 1];
      const days = (new Date(last.date) - new Date(first.date)) / (1000 * 60 * 60 * 24);
      
      if (days > 1) {
        // 使用複合年均成長率公式
        annualReturn = (Math.pow((totalVal / first.value), (365 / days)) - 1) * 100;
        
        if (annualReturn > 0) {
          const yearsNeeded = Math.log(target / totalVal) / Math.log(1 + annualReturn / 100);
          const etaDate = new Date();
          etaDate.setDate(etaDate.getDate() + (yearsNeeded * 365));
          eta = etaDate.toLocaleDateString('zh-TW', { year: 'numeric', month: 'short' });
        }
      }
    }

    const fmtM = v => (v >= 1e4) ? (v / 1e4).toFixed(0) + '萬' : v.toFixed(0) + '元';
    const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };

    set('goal-total-val', fmtM(totalVal));
    set('goal-pct', pct.toFixed(1) + '%');
    set('goal-annual-return', (annualReturn > 0) ? `+${annualReturn.toFixed(1)}%/年` : '—');
    set('goal-eta', eta);
    
    const barEl = document.getElementById('goal-progress-bar');
    if (barEl) barEl.style.width = pct + '%';

    this._drawValueChart(history);
  },

  _drawValueChart(history) {
    const canvas = document.getElementById('value-chart');
    if (!canvas) return;
    const W = canvas.parentElement?.clientWidth || 400;
    const H = 100;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    const vals = history.map(h => h.value);
    const minV = Math.min(...vals) * 0.95;
    const maxV = Math.max(...vals) * 1.05;
    const n = history.length;
    const xOf = i => (i / (n - 1)) * (W - 20) + 10;
    const yOf = v => H - 10 - ((v - minV) / (maxV - minV || 1)) * (H - 20);

    ctx.beginPath();
    ctx.strokeStyle = '#1D9E75';
    ctx.lineWidth = 2;
    history.forEach((h, i) => {
      i === 0 ? ctx.moveTo(xOf(i), yOf(h.value)) : ctx.lineTo(xOf(i), yOf(h.value));
    });
    ctx.stroke();
  }
};

// ── APP module ────────────────────
const APP = {
  // ... 其他屬性保持不變 ...
  
  async init() {
    this._updateMarketStatus();
    // 初始化時自動載入一次歷史快照
    GOALS.recordSnapshot();
    GOALS.updateDashboard();
    
    // 設定定時器
    setInterval(() => this.refreshPrices(), 10000); // 10秒檢查一次
    setInterval(() => this._updateMarketStatus(), 60000);
  },

  _updateMarketStatus() {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const isWeekday = now.getDay() >= 1 && now.getDay() <= 5;
    // 台股盤中時間判定
    const isOpen = isWeekday && (h > 9 || (h === 9 && m >= 0)) && (h < 13 || (h === 13 && m <= 35));
    
    this.isMarketOpen = isOpen;
    const el = document.getElementById('mkt-status');
    if (el) {
      el.textContent = isOpen ? '開盤中' : '休市';
      el.className = isOpen ? 'badge open' : 'badge closed';
    }
  },

  async refreshPrices() {
    // 3. 修正：休市時不持續更新報價 (API 請求攔截)
    if (!this.isMarketOpen) {
      console.log("休市中，不更新報價。");
      return;
    }

    const allCodes = [...this.portfolio.map(s => s.code), ...this.watchlist.map(s => s.code)];
    if (allCodes.length === 0) return;

    await DATA.batchUpdate(allCodes);
    this.renderAll();
    GOALS.updateDashboard();
  },

  _calcTotalValue() {
    return this.portfolio.reduce((sum, s) => sum + (s.price || s.cost) * s.shares, 0);
  }
};