// ── data.js v5 ── 智慧頻率與休市偵測
const DATA = {
  priceStore: {},
  _lastBatchUpdateTime: 0,

  // 修改 1: 判斷休市
  isMarketOpen() {
    const now = new Date();
    const day = now.getDay(); 
    if (day === 0 || day === 6) return false; // 週末休市
    const hour = now.getHours();
    const min = now.getMinutes();
    const time = hour * 100 + min;
    return time >= 900 && time <= 1335; // 台股交易時間
  },

  async batchUpdate(codes, force = false) {
    const now = Date.now();
    // 修改 1: 休市時不更新 (除非是剛開網頁 force=true)
    if (!force && !this.isMarketOpen()) {
      console.log("[DATA] 休市期間，跳過定時更新");
      return;
    }

    // 調降頻率的冷卻時間 (例如 30 秒內不重複抓取)
    if (!force && (now - this._lastBatchUpdateTime < 30000)) return;

    this._lastBatchUpdateTime = now;
    console.log("[DATA] 正在從 API 獲取最新報價...", codes);
    
    // 這裡封裝原本的 fetch 邏輯...
    // fetch(...).then(...)
  }
};
