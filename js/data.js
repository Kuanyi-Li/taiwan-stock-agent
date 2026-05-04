// ── data.js v5 ── 集中式批次報價架構（修正版）
//
// 修正三個問題（v19 → v20）：
// 1. 移除 Proxy：TWSE 直接打，不經 proxy
// 2. 移除 Yahoo fallback：避免拖垮 queue
// 3. TPEX 補送改走 queue，不手動 sleep + 改時間
//
// 架構：
// - 全域 priceStore：所有 UI 只讀 cache
// - TWSE 批次：一次 request 所有股票
// - rate-limit queue：每次 >= 1800ms
// - setInterval 集中控制，render/切換股票不觸發 fetch

const DATA = {

  // ── Rate-limit Queue ──────────────────────────────────
  _queue: [],
  _queueBusy: false,
  _lastReqTime: 0,
  MIN_INTERVAL: 1800, // ms：TWSE 5秒3次 → 每次至少 1700ms，留 100ms 緩衝

  async _enqueue(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      if (!this._queueBusy) this._drainQueue();
    });
  },

  async _drainQueue() {
    this._queueBusy = true;
    while (this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift();
      const wait = Math.max(0, this.MIN_INTERVAL - (Date.now() - this._lastReqTime));
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this._lastReqTime = Date.now();
      try { resolve(await fn()); } catch(e) { reject(e); }
    }
    this._queueBusy = false;
  },

  // ── 全域 PriceStore ───────────────────────────────────
  priceStore: {},

  _setPrice(code, fields) {
    this.priceStore[code] = { ...(this.priceStore[code] ?? {}), ...fields, ts: Date.now() };
  },

  // ── ❌ 移除 Proxy，直接 fetch ─────────────────────────
  // TWSE 支援直接從瀏覽器打（CORS 允許），不需要 proxy
  // Yahoo K 線也用同樣的直接 fetch（有 CORS header）
  async _fetch(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  },

  // ── TWSE 批次報價（主力）─────────────────────────────
  async _twseBatch(codes) {
    const exCh = codes.map(c => `tse_${c}.tw`).join('|');
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`;
    const res = await this._fetch(url);
    const json = await res.json();
    const items = json?.msgArray ?? [];
    const found = new Set();

    items.forEach(item => {
      const code = item.c;
      if (!code) return;
      // z = 成交價；盤前或無成交時為 "-"
      const priceRaw  = item.z !== '-' ? parseFloat(item.z) : null;
      const prevClose = parseFloat(item.y) || 0;
      const price     = priceRaw ?? prevClose; // 無成交用昨收暫代
      if (!price) return;
      const chg    = +(price - prevClose).toFixed(2);
      const chgPct = +(prevClose > 0 ? chg / prevClose * 100 : 0).toFixed(2);
      this._setPrice(code, {
        price:     +price.toFixed(2),
        prevClose: +prevClose.toFixed(2),
        open:      +(parseFloat(item.o) || prevClose).toFixed(2),
        high:      +(parseFloat(item.h) || price).toFixed(2),
        low:       +(parseFloat(item.l) || price).toFixed(2),
        volume:    parseInt(item.v) || 0,
        name:      item.n || code,
        chg, chgPct,
        noTrade:   priceRaw === null,
        source:    'twse',
      });
      found.add(code);
    });

    // 回傳沒有資料的代號（可能是上櫃，讓 caller 補送 otc_）
    return codes.filter(c => !found.has(c));
  },

  // ── TPEX 補送（上櫃）────────────────────────────────
  async _tpexBatch(codes) {
    if (!codes.length) return;
    const exCh = codes.map(c => `otc_${c}.tw`).join('|');
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`;
    const res = await this._fetch(url);
    const json = await res.json();
    (json?.msgArray ?? []).forEach(item => {
      const code = item.c;
      if (!code) return;
      const priceRaw  = item.z !== '-' ? parseFloat(item.z) : null;
      const prevClose = parseFloat(item.y) || 0;
      const price     = priceRaw ?? prevClose;
      if (!price) return;
      const chg    = +(price - prevClose).toFixed(2);
      const chgPct = +(prevClose > 0 ? chg / prevClose * 100 : 0).toFixed(2);
      this._setPrice(code, {
        price: +price.toFixed(2), prevClose: +prevClose.toFixed(2),
        open:  +(parseFloat(item.o) || prevClose).toFixed(2),
        high:  +(parseFloat(item.h) || price).toFixed(2),
        low:   +(parseFloat(item.l) || price).toFixed(2),
        volume: parseInt(item.v) || 0,
        name:  item.n || code,
        chg, chgPct,
        noTrade: priceRaw === null,
        source: 'tpex',
      });
    });
  },

  // ── 主要更新入口（由 APP setInterval 集中呼叫）────────
  async batchUpdate(codes) {
    if (!codes?.length) return;
    const unique = [...new Set(codes)];

    await this._enqueue(async () => {
      let missing = [];
      try {
        missing = await this._twseBatch(unique);
        console.log(`[DATA] TWSE: ${unique.length - missing.length}筆成功, ${missing.length}筆未找到`);
      } catch(e) {
        console.warn('[DATA] TWSE batch failed:', e.message);
        missing = unique;
      }

      // ★ 修正3：TPEX 補送改走 queue，不手動 sleep
      if (missing.length > 0) {
        console.log('[DATA] TPEX fallback for:', missing);
        // 直接進 queue，由 queue 控制間隔，不手動動 _lastReqTime
        await this._enqueue(() => this._tpexBatch(missing));
        // ❌ 移除 Yahoo fallback：missing 就記 log，不再打 Yahoo
        const stillMissing = missing.filter(c => !this.priceStore[c]?.price);
        if (stillMissing.length > 0) {
          console.warn('[DATA] 找不到報價（非上市/上櫃或代號錯誤）:', stillMissing);
        }
      }
    });
  },

  // ── 舊介面相容：updateAllPrices ──────────────────────
  async updateAllPrices(stocks, onUpdate) {
    if (!stocks?.length) return;
    await this.batchUpdate(stocks.map(s => s.code));
    stocks.forEach(s => {
      const q = this.priceStore[s.code];
      if (q?.price) {
        s.price     = q.price;
        s.prevClose = q.prevClose ?? s.prevClose;
        s.high = q.high; s.low = q.low; s.volume = q.volume;
        if (q.name && q.name !== s.code) s.marketName = q.name;
      }
      if (onUpdate) onUpdate(s);
    });
  },

  // ── 舊介面相容：fetchQuote（只讀 store，不打 API）────
  async fetchQuote(symbol) {
    const q = this.priceStore[symbol];
    if (q?.price) return { ...q, ok: true };
    return { price: null, prevClose: null, ok: false };
  },

  // ── K 線資料（走 queue）──────────────────────────────
  // Yahoo v8 chart 有 CORS header，直接打
  histCache: {},
  HIST_TTL: 120000,

  async fetchHistory(symbol, period = '3mo') {
    const { interval, range } = this._periodToParams(period);
    const key = `${symbol}_${period}`;
    const now = Date.now();
    const cached = this.histCache[key];
    const ttl = ['5m','15m','60m'].includes(period) ? 15000 : this.HIST_TTL;
    if (cached && now - cached.ts < ttl) return cached.data;

    return this._enqueue(async () => {
      const sym = isNaN(parseInt(symbol)) ? symbol : symbol + '.TW';
      try {
        const res = await this._fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`
        );
        const result = (await res.json())?.chart?.result?.[0];
        if (!result) throw new Error('No chart data');
        const ts    = result.timestamp ?? [];
        const ohlcv = result.indicators?.quote?.[0] ?? {};
        const candles = [];
        for (let i = 0; i < ts.length; i++) {
          if (ohlcv.close?.[i] == null) continue;
          candles.push({
            t: ts[i] * 1000,
            o: +((ohlcv.open?.[i]   ?? ohlcv.close[i])).toFixed(2),
            h: +((ohlcv.high?.[i]   ?? ohlcv.close[i])).toFixed(2),
            l: +((ohlcv.low?.[i]    ?? ohlcv.close[i])).toFixed(2),
            c: +ohlcv.close[i].toFixed(2),
            v: ohlcv.volume?.[i] ?? 0,
          });
        }
        this.histCache[key] = { data: candles, ts: now };
        // K 線成功後順便更新 store（最後一根 = 最新收盤）
        // 只在沒有即時 TWSE 報價時才用（避免覆蓋盤中資料）
        if (candles.length >= 1 && period === '3mo') {
          const last = candles[candles.length - 1];
          const prev = candles.length >= 2 ? candles[candles.length - 2].c : last.c;
          const existing = this.priceStore[symbol];
          if (!existing?.price || existing?.source === 'candle') {
            this._setPrice(symbol, {
              price: last.c, prevClose: prev,
              open: last.o, high: last.h, low: last.l, volume: last.v,
              chg:    +(last.c - prev).toFixed(2),
              chgPct: +(prev > 0 ? (last.c - prev) / prev * 100 : 0).toFixed(2),
              source: 'candle',
            });
          }
        }
        console.log(`[DATA] ${symbol}/${period}: ${candles.length} candles`);
        return candles;
      } catch(e) {
        console.warn('[DATA] fetchHistory failed:', symbol, e.message);
        if (cached) return cached.data;
        return this._mockCandles(symbol, period);
      }
    });
  },

  // ── 大盤指數（不走 queue，獨立 fetch，避免卡住報價更新）─
  async fetchIndexes() {
    try {
      // 直接打 TWSE，不進 queue（指數更新不需要跟報價搶 rate limit）
      const res = await this._fetch(
        'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0'
      );
      const item = (await res.json())?.msgArray?.[0];
      if (item) {
        const price = parseFloat(item.z !== '-' ? item.z : item.y) || 0;
        const prev  = parseFloat(item.y) || price;
        const chg   = price - prev;
        const pct   = prev > 0 ? chg / prev * 100 : 0;
        const el = document.getElementById('taiex-badge');
        if (el) {
          el.textContent = `加權 ${price.toLocaleString('zh-TW', {maximumFractionDigits:0})} (${chg>=0?'+':''}${pct.toFixed(2)}%)`;
          el.className = `index-chip ${chg >= 0 ? 'up' : 'dn'}`;
        }
      }
    } catch(e) { console.warn('[DATA] fetchIndexes failed:', e.message); }
  },

  // ── Helpers ───────────────────────────────────────────
  _periodToParams(period) {
    return ({
      '5m':  { interval:'5m',  range:'5d'  },
      '15m': { interval:'15m', range:'5d'  },
      '60m': { interval:'60m', range:'1mo' },
      '1d':  { interval:'1d',  range:'1mo' },
      '1wk': { interval:'1d',  range:'3mo' },
      '1mo': { interval:'1d',  range:'6mo' },
      '3mo': { interval:'1d',  range:'1y'  },
      '6mo': { interval:'1wk', range:'2y'  },
      '1y':  { interval:'1wk', range:'2y'  },
    })[period] ?? { interval:'1d', range:'1y' };
  },

  _mockCandles(symbol, period) {
    console.warn('[DATA] using mock candles for', symbol);
    const n = { '5m':78,'15m':40,'60m':30,'1d':22,'1wk':30,'1mo':45,'3mo':65,'6mo':130,'1y':250 }[period] ?? 60;
    const base = this.priceStore[symbol]?.price ?? 100;
    let price = base * 0.92;
    const now = Date.now();
    const step = ['5m','15m','60m'].includes(period) ? 60000 * parseInt(period) : 86400000;
    return Array.from({ length: n }, (_, i) => {
      const o = price, r = o * 0.02;
      const h = o + Math.random() * r, l = o - Math.random() * r, c = l + (h-l) * Math.random();
      price = c;
      return { t: now-(n-1-i)*step, o:+o.toFixed(2), h:+h.toFixed(2), l:+l.toFixed(2), c:+c.toFixed(2), v:Math.floor(1e5+Math.random()*5e5) };
    });
  },
};
