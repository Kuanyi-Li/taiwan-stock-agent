// ── data.js  ── TWSE Batch Version (Stable v1)

const DATA = {
  // ===== CONFIG =====
  BATCH_TTL: 5000,     // 5秒 cache
  CHUNK_SIZE: 10,      // 每批最多10檔
  RATE_DELAY: 2000,    // 每批間隔（避免被ban）

  // ===== CACHE =====
  batchCache: {
    data: {},
    ts: 0
  },

  // ===== MAIN BATCH FETCH =====
  async fetchBatchQuotes(symbols) {
    const results = {};

    for (let i = 0; i < symbols.length; i += this.CHUNK_SIZE) {
      const chunk = symbols.slice(i, i + this.CHUNK_SIZE);

      const ex_ch = chunk
        .map(code => `tse_${code}.tw`)
        .join('|');

      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex_ch}`;

      try {
        const res = await fetch(url);
        const json = await res.json();

        if (!json.msgArray) continue;

        json.msgArray.forEach(item => {
          results[item.c] = {
            price: parseFloat(item.z) || null,
            prevClose: parseFloat(item.y) || null,
            open: parseFloat(item.o) || null,
            high: parseFloat(item.h) || null,
            low: parseFloat(item.l) || null,
            volume: parseInt(item.v) || 0,
            name: item.n,
            ts: Date.now(),
            ok: true
          };
        });

      } catch (e) {
        console.warn('[TWSE] batch error:', e);
      }

      // ✅ 避免超過 TWSE 限制
      await new Promise(r => setTimeout(r, this.RATE_DELAY));
    }

    return results;
  },

  // ===== CACHE LAYER =====
  async getBatch(symbols) {
    const now = Date.now();

    // ✅ cache 命中
    if (now - this.batchCache.ts < this.BATCH_TTL) {
      return this.batchCache.data;
    }

    const data = await this.fetchBatchQuotes(symbols);

    // 更新 cache
    this.batchCache = {
      data,
      ts: now
    };

    return data;
  },

  // ===== UPDATE ALL STOCKS =====
  async updateAllPrices(stocks, onUpdate) {
    if (!stocks || stocks.length === 0) return;

    const codes = stocks.map(s => s.code);

    const batchData = await this.getBatch(codes);

    stocks.forEach(s => {
      const q = batchData[s.code];

      if (q && q.ok) {
        s.price = q.price;
        s.prevClose = q.prevClose;
        s.open = q.open;
        s.high = q.high;
        s.low = q.low;
        s.volume = q.volume;
        s.marketName = q.name;
      }

      if (onUpdate) onUpdate(s);
    });
  },

  // ===== INDEX（可選，簡化版）=====
  async fetchIndexes() {
    try {
      const url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw";
      const res = await fetch(url);
      const json = await res.json();

      const idx = json.msgArray?.[0];
      if (!idx) return;

      const price = parseFloat(idx.z);
      const prev = parseFloat(idx.y);

      const chg = price - prev;
      const pct = (chg / prev * 100).toFixed(2);

      const el = document.getElementById('taiex-badge');
      if (el) {
        el.textContent = `加權 ${price} (${chg >= 0 ? '+' : ''}${pct}%)`;
        el.className = `index-chip ${chg >= 0 ? 'up' : 'dn'}`;
      }

    } catch (e) {
      console.warn('[TWSE] index error', e);
    }
  }
};
