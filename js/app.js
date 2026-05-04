// ── GOALS module 修正版 ──────────────────────────────────
const GOALS = {
  defaults: { target: 25000000, years: 2.5, purpose: '買房頭期款', strategy: 'long', cashTWD: 40405, cashUSD: 2100 },

  get() { return JSON.parse(localStorage.getItem('twsa-goals') || 'null') || this.defaults; },
  save(data) {
    data._lastSyncedAt = new Date().toISOString();
    localStorage.setItem('twsa-goals', JSON.stringify(data));
    SYNC.markDirty();
  },

  // 1. 修改資產快照：整合 Excel 資料與即時市值
  recordSnapshot() {
    const history = JSON.parse(localStorage.getItem('twsa-value-history') || '[]');
    const today = new Date().toISOString().split('T')[0];
    const totalVal = this._calcTotal();
    
    // 如果今天還沒紀錄，則存入
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
    const totalVal = this._calcTotal();
    const target = g.target || 25000000;
    const diff = target - totalVal;
    const pct = Math.min(100, (totalVal / target) * 100);

    // 2. 修正：計算年化報酬 (CAGR) 與預計達標日
    const history = JSON.parse(localStorage.getItem('twsa-value-history') || '[]');
    let annualReturn = 0;
    let eta = '—';

    if (history.length >= 2) {
      const first = history[0];
      const last = history[history.length - 1];
      const days = (new Date(last.date) - new Date(first.date)) / (86400000);
      
      if (days > 7 && first.value > 0) {
        // 使用複利公式計算年化報酬
        annualReturn = (Math.pow((last.value / first.value), (365 / days)) - 1) * 100;
        
        // 計算預計達標時間 (Logarithmic Growth)
        if (annualReturn > 0 && target > last.value) {
          const yearsNeeded = Math.log(target / last.value) / Math.log(1 + annualReturn / 100);
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
    set('goal-annual-return', annualReturn !== 0 ? (annualReturn > 0 ? '+' : '') + annualReturn.toFixed(1) + '%/年' : '—');
    set('goal-eta', eta);
    
    // 更新進度條
    const barEl = document.getElementById('goal-progress-bar');
    if (barEl) {
      barEl.style.width = pct + '%';
      barEl.style.background = pct >= 100 ? '#1D9E75' : '#EF9F27';
    }

    this._drawValueChart();
  },
  
  // 圖表繪製保持原邏輯，資料來源已在快取中更新
  _drawValueChart() { /* ... 同原始代碼 ... */ }
};

// ── APP.refreshPrices 修正版 ─────────────────────────────
APP.refreshPrices = async function() {
    // 3. 修改：休市時不持續更新報價
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const isWeekday = now.getDay() >= 1 && now.getDay() <= 5;
    const isOpen = isWeekday && (h > 9 || (h === 9 && m >= 0)) && (h < 13 || (h === 13 && m <= 30));

    if (!isOpen) {
        console.log("[APP] 休市中，暫停 API 請求");
        this._updateMarketStatus();
        return; 
    }

    const btn = document.querySelector('.icon-btn[onclick="refreshAll()"]');
    if (btn) btn.classList.add('spinning');

    const allCodes = [...this.portfolio.map(s => s.code), ...this.watchlist.map(s => s.code)];
    await DATA.batchUpdate(allCodes);

    [...this.portfolio, ...this.watchlist].forEach(s => {
      const q = DATA.priceStore[s.code];
      if (q?.price) { s.price = q.price; s.prevClose = q.prevClose ?? s.prevClose; }
    });

    if (btn) btn.classList.remove('spinning');
    this.renderAll();
    showToast('報價已更新');
};