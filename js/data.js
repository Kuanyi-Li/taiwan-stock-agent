// ── data.js v5 ── 台股 TWSE + 美股 Yahoo 批次架構
//
// 核心原則：
// 1. 台股：TWSE 批次（主） → TPEX 補送（上櫃）→ 不用 Yahoo
// 2. 美股：Yahoo v7 一次批次呼叫所有美股代碼
// 3. 台股/美股 自動判斷：全字母代碼 = 美股，數字代碼 = 台股
// 4. 休市時不更新（由 APP 控制）
// 5. K線歷史：Yahoo（台股加 .TW，美股直接）
// 6. rate-limit queue：每次請求間隔 >= 1800ms

const DATA = {

  // ── Rate-limit Queue ──────────────────────────────────
  _queue: [],
  _queueBusy: false,
  _lastReqTime: 0,
  MIN_INTERVAL: 1800,
  MAX_INTERVAL: 3200, // 隨機上限

  // 隨機間隔：1800~3200ms，避免固定頻率被識別為機器人
  _randomInterval() {
    return this.MIN_INTERVAL + Math.floor(Math.random() * (this.MAX_INTERVAL - this.MIN_INTERVAL));
  },

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
      const interval = this._randomInterval();
      const wait = Math.max(0, interval - (Date.now() - this._lastReqTime));
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

  // ── 判斷台股 / 美股 ───────────────────────────────────
  // 全字母（1–5位）= 美股；否則台股
  isUSCode(code) {
    return /^[A-Za-z]{1,5}$/.test(code);
  },

  // ── CORS Proxy ────────────────────────────────────────
  proxies: [
    'https://flat-resonance-0773.s51511830-74e.workers.dev/?url=',
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.org/?',
  ],
  _proxyIdx: 0,

  async _fetch(url) {
    for (let i = 0; i < this.proxies.length; i++) {
      const idx = (this._proxyIdx + i) % this.proxies.length;
      try {
        const res = await fetch(
          this.proxies[idx] + encodeURIComponent(url),
          { signal: AbortSignal.timeout(9000) }
        );
        if (res.ok) { this._proxyIdx = idx; return res; }
      } catch(e) { /* try next */ }
    }
    throw new Error('All proxies failed');
  },

  // 舊介面相容
  async _fetchWithFallback(url) { return this._fetch(url); },

  // ── 台股報價（Yahoo spark 批次，一次呼叫全部）────────
  async _twseBatch(codes) {
    if (!codes.length) return [];
    const symbols = codes.map(c => c + '.TW').join(',');
    try {
      const res = await this._fetch(
        `https://query2.finance.yahoo.com/v7/finance/spark?symbols=${symbols}&range=1d&interval=1d&_=${Date.now()}`
      );
      const json = await res.json();
      const results = json?.spark?.result ?? [];
      const found = new Set();
      results.forEach(item => {
        const meta = item?.response?.[0]?.meta;
        if (!meta?.regularMarketPrice) return;
        const code = item.symbol.replace('.TW', '');
        const price = +meta.regularMarketPrice.toFixed(2);
        const prev  = +(meta.chartPreviousClose ?? meta.regularMarketPrice).toFixed(2);
        const chg   = +(price - prev).toFixed(2);
        const chgPct= +(prev > 0 ? chg/prev*100 : 0).toFixed(2);
        this._setPrice(code, {
          price, prevClose: prev,
          high:   +(meta.regularMarketDayHigh ?? price).toFixed(2),
          low:    +(meta.regularMarketDayLow  ?? price).toFixed(2),
          volume: meta.regularMarketVolume ?? 0,
          name:   meta.shortName ?? code,
          chg, chgPct,
          noTrade: false,
          source: 'yahoo-spark', market: 'TW',
        });
        found.add(code);
      });
      console.log(`[DATA] Yahoo spark TW: ${found.size}/${codes.length} updated`);
      return codes.filter(c => !found.has(c));
    } catch(e) {
      console.warn('[DATA] Yahoo spark TW failed:', e.message);
      return codes;
    }
  },

  // ── TPEX 上櫃（同樣用 Yahoo spark）──────────────────
  async _tpexBatch(codes) {
    if (!codes.length) return;
    await this._twseBatch(codes); // 上櫃在 Yahoo 也是 .TW
  },

  // ── 美股報價（Yahoo spark 批次）─────────────────────
  async _yahooUSBatch(codes) {
    if (!codes.length) return;
    const symbols = codes.join(',');
    try {
      const res = await this._fetch(
        `https://query2.finance.yahoo.com/v7/finance/spark?symbols=${symbols}&range=1d&interval=1d&_=${Date.now()}`
      );
      const json = await res.json();
      const results = json?.spark?.result ?? [];
      results.forEach(item => {
        const meta = item?.response?.[0]?.meta;
        if (!meta?.regularMarketPrice) return;
        const code = item.symbol;
        const p  = +meta.regularMarketPrice.toFixed(2);
        const pc = +(meta.chartPreviousClose ?? p).toFixed(2);
        this._setPrice(code, {
          price: p, prevClose: pc,
          high:   +(meta.regularMarketDayHigh ?? p).toFixed(2),
          low:    +(meta.regularMarketDayLow  ?? p).toFixed(2),
          volume: meta.regularMarketVolume ?? 0,
          name:   meta.shortName ?? code,
          chg:    +(p - pc).toFixed(2),
          chgPct: +(pc > 0 ? (p-pc)/pc*100 : 0).toFixed(2),
          currency: meta.currency || 'USD',
          source: 'yahoo-spark', market: 'US',
        });
      });
      console.log(`[DATA] Yahoo spark US: ${results.length}/${codes.length} updated`);
    } catch(e) {
      console.warn('[DATA] Yahoo spark US failed:', e.message);
    }
  },

  // ── 主要更新入口 ──────────────────────────────────────
  async batchUpdate(codes) {
    if (!codes?.length) return;
    const unique = [...new Set(codes)];

    const twCodes = unique.filter(c => !this.isUSCode(c));
    const usCodes = unique.filter(c => this.isUSCode(c));

    await this._enqueue(async () => {
      // ── 台股：TWSE → TPEX（不走 Yahoo）──
      if (twCodes.length > 0) {
        let missing = [];
        try {
          missing = await this._twseBatch(twCodes);
          console.log(`[DATA] TWSE: ${twCodes.length - missing.length} ok, ${missing.length} missing`);
        } catch(e) {
          console.warn('[DATA] TWSE failed:', e.message);
          missing = twCodes;
        }
        if (missing.length > 0) {
          await new Promise(r => setTimeout(r, this.MIN_INTERVAL));
          this._lastReqTime = Date.now();
          try { await this._tpexBatch(missing); } catch(e) { /* silent */ }
        }
      }

      // ── 美股：Yahoo 一次批次 ──
      if (usCodes.length > 0) {
        if (twCodes.length > 0) {
          await new Promise(r => setTimeout(r, this.MIN_INTERVAL));
          this._lastReqTime = Date.now();
        }
        await this._yahooUSBatch(usCodes);
      }
    });
  },

  // ── 舊介面相容 ────────────────────────────────────────
  async updateAllPrices(stocks, onUpdate) {
    if (!stocks?.length) return;
    await this.batchUpdate(stocks.map(s => s.code));
    stocks.forEach(s => {
      const q = this.priceStore[s.code];
      if (q?.price) {
        s.price     = q.price;
        s.prevClose = q.prevClose ?? s.prevClose;
        s.high      = q.high;
        s.low       = q.low;
        s.volume    = q.volume;
        if (q.name && q.name !== s.code) s.marketName = q.name;
      }
      if (onUpdate) onUpdate(s);
    });
  },

  async fetchQuote(symbol) {
    const q = this.priceStore[symbol];
    if (q?.price) return { ...q, ok: true };
    await this.batchUpdate([symbol]);
    const q2 = this.priceStore[symbol];
    if (q2?.price) return { ...q2, ok: true };
    return { price: null, prevClose: null, ok: false };
  },

  // ── K 線歷史資料 ──────────────────────────────────────
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
      // 台股加 .TW，美股直接用代碼
      const sym = this.isUSCode(symbol) ? symbol : symbol + '.TW';
      try {
        const res = await this._fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`
        );
        const json   = await res.json();
        const result = json?.chart?.result?.[0];
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
        // K線載入後同步補報價（避免覆蓋即時資料）
        if (candles.length >= 1) {
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
              market: this.isUSCode(symbol) ? 'US' : 'TW',
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

  // ── 美股大盤指數（Yahoo 一次批次）────────────────────
  async fetchUSIndexes() {
    try {
      const res = await this._fetch(
        'https://query1.finance.yahoo.com/v7/finance/quote?symbols=%5EGSPC,%5EIXIC,%5EDJI' +
        '&fields=regularMarketPrice,regularMarketPreviousClose,shortName'
      );
      const results = (await res.json())?.quoteResponse?.result ?? [];
      const map  = { '^GSPC':'sp500-badge', '^IXIC':'nasdaq-badge', '^DJI':'dow-badge' };
      const name = { '^GSPC':'S&P500', '^IXIC':'NASDAQ', '^DJI':'DOW' };
      const isUSOpen = typeof APP !== 'undefined' ? APP.isUSMarketOpen() : false;
      results.forEach(q => {
        const elId = map[q.symbol];
        if (!elId) return;
        const p   = parseFloat(q.regularMarketPrice);
        const pc  = parseFloat(q.regularMarketPreviousClose ?? p);
        const chg = p - pc;
        const pct = pc > 0 ? chg / pc * 100 : 0;
        const sign = chg >= 0 ? '+' : '';
        const priceStr = p.toLocaleString('en-US', {maximumFractionDigits:2});
        const disp = isUSOpen
          ? `${name[q.symbol]} ${priceStr} (${sign}${pct.toFixed(2)}%)`
          : `${name[q.symbol]} ${priceStr}`;
        const el = document.getElementById(elId);
        if (el) { el.textContent = disp; el.className = isUSOpen ? `index-chip ${chg >= 0 ? 'up' : 'dn'}` : 'index-chip'; }
      });
    } catch(e) { console.warn('[DATA] fetchUSIndexes failed:', e.message); }
  },

  // ── 大盤指數（Yahoo spark 批次）─────────────────────
  async fetchIndexes() {
    try {
      const isTWOpen = typeof APP !== 'undefined' ? APP.isTWMarketOpen() : false;
      const res = await this._fetch(
        `https://query2.finance.yahoo.com/v7/finance/spark?symbols=%5ETWII,%5ETWOII&range=1d&interval=1d&_=${Date.now()}`
      );
      const json = await res.json();
      const results = json?.spark?.result ?? [];
      const badges = { '^TWII': 'taiex-badge', '^TWOII': 'tpex-badge' };
      const labels = { '^TWII': '加權', '^TWOII': '櫃買' };
      results.forEach(item => {
        const meta = item?.response?.[0]?.meta;
        if (!meta?.regularMarketPrice) return;
        const sym   = item.symbol;
        const price = meta.regularMarketPrice;
        const prev  = meta.chartPreviousClose ?? price;
        const chg   = price - prev;
        const pct   = prev > 0 ? chg / prev * 100 : 0;
        const sign  = chg >= 0 ? '+' : '';
        const priceStr = price.toLocaleString('zh-TW', {maximumFractionDigits:2});
        const disp = isTWOpen
          ? `${labels[sym]} ${priceStr} (${sign}${pct.toFixed(2)}%)`
          : `${labels[sym]} ${priceStr}`;
        const cls = isTWOpen ? `index-chip ${chg >= 0 ? 'up' : 'dn'}` : 'index-chip';
        const el = document.getElementById(badges[sym]);
        if (el) { el.textContent = disp; el.className = cls; }
      });
    } catch(e) { /* silent */ }
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
    console.warn('[DATA] mock candles for', symbol);
    const n = { '5m':78,'15m':40,'60m':30,'1d':22,'1wk':30,'1mo':45,'3mo':65,'6mo':130,'1y':250 }[period] ?? 60;
    const base = this.priceStore[symbol]?.price ?? 100;
    let price = base * 0.92;
    const now = Date.now();
    const step = ['5m','15m','60m'].includes(period) ? 60000 * parseInt(period) : 86400000;
    return Array.from({ length: n }, (_, i) => {
      const o = price, r = o * 0.02;
      const h = o + Math.random() * r, l = o - Math.random() * r, c = l + (h - l) * Math.random();
      price = c;
      return { t: now - (n-1-i)*step, o:+o.toFixed(2), h:+h.toFixed(2), l:+l.toFixed(2), c:+c.toFixed(2), v: Math.floor(1e5+Math.random()*5e5) };
    });
  },
};
