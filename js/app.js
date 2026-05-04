// ── app.js v4 ── 修正更新頻率、目標追蹤、JSONBin 紀錄
const APP = {
  portfolio: [],
  watchlist: [],
  activeSymbol: null,
  refreshTimer: null,
  _isInitialLoad: true,

  async init() {
    console.log("[APP] 初始化...");
    // 1. 啟動即時更新 (包含重新整理時)
    await this.refreshPrices(true);
    this._isInitialLoad = false;
    
    // 2. 調降更新頻率：設定為 60 秒檢查一次
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      // 只有在開盤時間才進行自動更新
      if (DATA.isMarketOpen()) {
        this.refreshPrices(false); 
      }
    }, 60000); 
  },

  async refreshPrices(isActionOrInitial = false) {
    const allCodes = [...new Set([...this.portfolio.map(s => s.code), ...this.watchlist.map(s => s.code)])];
    
    // 呼叫 DATA 更新
    // isActionOrInitial 為 true 時，DATA 內部會無視冷卻時間強制抓取
    await DATA.batchUpdate(allCodes, isActionOrInitial);

    this.renderPortfolioSummary();
    this.renderStockList();
    
    // 修改 2: 報價更新後圓餅圖不用更新，只有有買賣操作(isActionOrInitial)或初次載入時才更新
    if (isActionOrInitial && typeof PIE !== 'undefined') {
      PIE.render();
    }
    
    // 修改 4: 報價已更新通知已移除
    // showToast('報價已更新'); <- 刪除
  },

  renderPortfolioSummary() {
    // 渲染總資產等資訊...
    GOALS.updateDashboard();
  },

  renderStockList() { /* 渲染清單邏輯 */ }
};

// 修改 3: 修正年化報酬與預計達標
const GOALS = {
  get() { 
    return JSON.parse(localStorage.getItem('twsa-goals') || '{"initialValue":0, "startDate":null}'); 
  },
  _calcTotal() {
    // 這裡應包含：現金(TWD/USD) + 股票市值
    const stockMV = APP.portfolio.reduce((sum, s) => sum + (DATA.priceStore[s.code]?.price || 0) * s.shares, 0);
    const cash = parseFloat(localStorage.getItem('twsa-cash-twd') || 0);
    return stockMV + cash;
  },
  updateDashboard() {
    const g = this.get();
    const totalVal = this._calcTotal();
    const initialVal = g.initialValue || totalVal; // 避免除以零
    const startDate = g.startDate ? new Date(g.startDate) : new Date();
    
    // 計算經過年份
    const yearsPassed = (Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    
    // 年化報酬修正
    let annualReturn = 0;
    if (yearsPassed > 0.01) { 
      annualReturn = ((totalVal / initialVal) ** (1 / yearsPassed) - 1) * 100;
    }

    // 預計達標日期 (目標 2500 萬)
    const target = 25000000;
    let eta = '-';
    if (annualReturn > 0 && totalVal < target) {
      const yearsLeft = Math.log(target / totalVal) / Math.log(1 + (annualReturn / 100));
      const targetDate = new Date();
      targetDate.setFullYear(targetDate.getFullYear() + Math.floor(yearsLeft));
      targetDate.setMonth(targetDate.getMonth() + Math.round((yearsLeft % 1) * 12));
      eta = targetDate.getFullYear() + '年' + (targetDate.getMonth() + 1) + '月';
    }

    const elRet = document.getElementById('goal-annual-return');
    const elEta = document.getElementById('goal-eta');
    if (elRet) elRet.textContent = annualReturn.toFixed(2) + '%';
    if (elEta) elEta.textContent = eta;
  }
};

// 修改 5: JSONBin 紀錄檔擴充
const SYNC = {
  _pack() {
    const stockMarketValue = APP.portfolio.reduce((sum, s) => sum + (DATA.priceStore[s.code]?.price || 0) * s.shares, 0);
    const history = JSON.parse(localStorage.getItem('twsa-value-history') || '[]');
    const today = new Date().toISOString().split('T')[0];
    
    const entry = { 
      date: today, 
      total: GOALS._calcTotal(), 
      stockMarketValue: stockMarketValue 
    };
    
    // 更新歷史紀錄
    if (history.length > 0 && history[history.length - 1].date === today) {
      history[history.length - 1] = entry;
    } else {
      history.push(entry);
    }
    localStorage.setItem('twsa-value-history', JSON.stringify(history));

    return {
      portfolio: APP.portfolio,
      history: history,
      syncedAt: new Date().toISOString()
    };
  }
};
