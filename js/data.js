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
  MIN_INTERVAL: 800,
  MAX_INTERVAL: 1500, // 隨機上限

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
    const existing = this.priceStore[code];
    if (existing) {
      // 來源優先序：twse/tpex > yahoo-spark/yahoo-us > yahoo-tw-fallback > twse-prev
      const rank = s => s==='twse'||s==='tpex' ? 4 : s==='yahoo-spark'||s==='yahoo-us' ? 3 : s==='yahoo-tw-fallback' ? 2 : s==='twse-prev' ? 0 : 1;
      const newRank = rank(fields.source);
      const oldRank = rank(existing.source);
      const newTs   = Date.now();
      const oldTs   = existing.ts || 0;
      // 舊資料來源優先序更高，且不超過 30 秒前 → 不覆蓋
      if (oldRank > newRank && (newTs - oldTs) < 30000) return;
    }
    this.priceStore[code] = { ...(existing ?? {}), ...fields, ts: Date.now() };
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

  // ── 台股報價（TWSE 批次，即時）─────────────────────
  async _twseBatch(codes) {
    if (!codes.length) return [];
    // ★ 用 %7C 直接串接，避免 encodeURIComponent 雙重編碼
    const exCh = codes.map(c => `tse_${c}.tw`).join('%7C');
    try {
      const res = await this._fetch(
        `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&_=${Date.now()}`
      );
      const json  = await res.json();
      const items = json?.msgArray ?? [];
      const found = new Set();
      const noTradeCodes = []; // z='-' 的股票，需要 Yahoo 補價

      items.forEach(item => {
        const code = item.c;
        if (!code) return;
        const priceRaw  = item.z && item.z !== '-' ? parseFloat(item.z) : null;
        const prevClose = parseFloat(item.y) || 0;

        if (priceRaw === null) {
          // z='-'，加入待補清單
          noTradeCodes.push(code);
          // ★ 只有在沒有即時報價時才用昨收（避免覆蓋 Yahoo 即時價）
          const existing = this.priceStore[code];
          if (!existing || existing.source === 'twse-prev') {
            this._setPrice(code, {
              price: prevClose, prevClose,
              open: prevClose, high: prevClose, low: prevClose,
              name: item.n || code, volume: 0,
              chg: 0, chgPct: 0, noTrade: true,
              source: 'twse-prev', market: 'TW',
            });
          }
          found.add(code);
          return;
        }

        const chg    = +(priceRaw - prevClose).toFixed(2);
        const chgPct = +(prevClose > 0 ? chg / prevClose * 100 : 0).toFixed(2);
        this._setPrice(code, {
          price:     +priceRaw.toFixed(2),
          prevClose: +prevClose.toFixed(2),
          open:      +(parseFloat(item.o) || prevClose).toFixed(2),
          high:      +(parseFloat(item.h) || priceRaw).toFixed(2),
          low:       +(parseFloat(item.l) || priceRaw).toFixed(2),
          volume:    parseInt(item.v) || 0,
          name:      item.n || code,
          chg, chgPct, noTrade: false,
          source: 'twse', market: 'TW',
        });
        found.add(code);
      });

      // ★ 不管 TWSE 有沒有值，都用 Yahoo spark 補（確保即時）
      // noTrade 的優先補，有值的非同步更新
      if (noTradeCodes.length > 0) {
        this._yahooTWFallback(noTradeCodes);
      }
      // 有 TWSE 值的也補 Yahoo，避免 TWSE 有 session 問題時落後
      const hasTradeCodes = [...found].filter(c => !noTradeCodes.includes(c));
      if (hasTradeCodes.length > 0) {
        this._yahooTWFallback(hasTradeCodes);
      }

      console.log(`[DATA] TWSE: ${found.size - noTradeCodes.length} realtime, ${noTradeCodes.length} yahoo fallback, ${codes.length - found.size} missing`);
      return codes.filter(c => !found.has(c));
    } catch(e) {
      console.warn('[DATA] TWSE failed:', e.message);
      return codes;
    }
  },

  // ── Yahoo spark 補台股即時價（TWSE z='-' 時使用）────
  async _yahooTWFallback(codes) {
    if (!codes.length) return;
    const symbols = codes.map(c => c + '.TW').join(',');
    try {
      const res = await this._fetch(
        `https://query2.finance.yahoo.com/v7/finance/spark?symbols=${symbols}&range=1d&interval=1d&_=${Date.now()}`
      );
      const results = (await res.json())?.spark?.result ?? [];
      results.forEach(item => {
        const meta = item?.response?.[0]?.meta;
        if (!meta?.regularMarketPrice) return;
        const code = item.symbol.replace('.TW', '');
        const price = +meta.regularMarketPrice.toFixed(2);
        const prev  = +(meta.chartPreviousClose ?? price).toFixed(2);
        const chg   = +(price - prev).toFixed(2);
        const chgPct= +(prev > 0 ? chg/prev*100 : 0).toFixed(2);
        this._setPrice(code, {
          price, prevClose: prev,
          high: +(meta.regularMarketDayHigh ?? price).toFixed(2),
          low:  +(meta.regularMarketDayLow  ?? price).toFixed(2),
          volume: meta.regularMarketVolume ?? 0,
          name: meta.shortName ?? code,
          chg, chgPct, noTrade: false,
          source: 'yahoo-tw-fallback', market: 'TW',
        });
      });
      console.log(`[DATA] Yahoo TW fallback: ${results.length}/${codes.length} updated`);

      // ★ 同步回 APP portfolio 並重新渲染
      if (typeof APP !== 'undefined') {
        [...APP._twPortfolio, ...APP._twWatchlist].forEach(s => {
          const q = this.priceStore[s.code];
          if (q?.price && codes.includes(s.code)) {
            s.price     = q.price;
            s.prevClose = q.prevClose ?? s.prevClose;
          }
        });
        APP.renderPortfolioSummary();
        APP.renderStockList();
        APP.renderWatchlist();
        // 更新右側大圖
        if (APP.activeSymbol && codes.includes(APP.activeSymbol)) {
          const q = this.priceStore[APP.activeSymbol];
          if (q?.price) {
            const priceEl = document.getElementById('chart-price');
            if (priceEl) priceEl.textContent = q.price.toFixed(2);
            const chg = q.price - (q.prevClose ?? q.price);
            const chgPct = q.prevClose ? chg / q.prevClose * 100 : 0;
            const changeEl = document.getElementById('chart-change');
            if (changeEl && Math.abs(chg) > 0.01) {
              changeEl.textContent = `${chg>=0?'+':''}${chg.toFixed(2)} (${chgPct>=0?'+':''}${chgPct.toFixed(2)}%)`;
              changeEl.className = 'chart-change ' + (chg >= 0 ? 'up-color' : 'dn-color');
            }
          }
        }
      }
    } catch(e) {
      console.warn('[DATA] Yahoo TW fallback failed:', e.message);
    }
  },

  // ── TPEX 上櫃補送 ────────────────────────────────────
  async _tpexBatch(codes) {
    if (!codes.length) return;
    const exCh = codes.map(c => `otc_${c}.tw`).join('%7C');
    try {
      const res = await this._fetch(
        `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&_=${Date.now()}`
      );
      const json = await res.json();
      (json?.msgArray ?? []).forEach(item => {
        const code = item.c;
        if (!code) return;
        const priceRaw  = item.z && item.z !== '-' ? parseFloat(item.z) : null;
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
          chg, chgPct, noTrade: priceRaw === null,
          source: 'tpex', market: 'TW',
        });
      });
    } catch(e) { /* silent */ }
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
          `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}&_=${Date.now()}`
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
      const isUSOpen = typeof APP !== 'undefined' ? APP.isUSMarketOpen() : false;
      const url = 'https://query2.finance.yahoo.com/v7/finance/spark?symbols=%5EGSPC,%5EIXIC,%5EDJI&range=1d&interval=1d&_=' + Date.now();
      // 直接呼叫，不走 queue
      const proxyUrl = (this.proxies[this._proxyIdx] || this.proxies[0]) + encodeURIComponent(url);
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(9000) });
      const results = (await res.json())?.spark?.result ?? [];
      const map  = { '^GSPC':'sp500-badge', '^IXIC':'nasdaq-badge', '^DJI':'dow-badge' };
      const name = { '^GSPC':'S&P500', '^IXIC':'NASDAQ', '^DJI':'DOW' };
      results.forEach(item => {
        const meta = item?.response?.[0]?.meta;
        if (!meta?.regularMarketPrice) return;
        const sym  = item.symbol;
        const p    = meta.regularMarketPrice;
        const pc   = meta.chartPreviousClose ?? p;
        const chg  = p - pc;
        const pct  = pc > 0 ? chg / pc * 100 : 0;
        const sign = chg >= 0 ? '+' : '';
        const priceStr = p.toLocaleString('en-US', {maximumFractionDigits:2});
        const disp = isUSOpen
          ? `${name[sym]} ${priceStr} (${sign}${pct.toFixed(2)}%)`
          : `${name[sym]} ${priceStr}`;
        const el = document.getElementById(map[sym]);
        if (el) { el.textContent = disp; el.className = isUSOpen ? `index-chip ${chg >= 0 ? 'up' : 'dn'}` : 'index-chip'; }
      });
    } catch(e) { console.warn('[DATA] fetchUSIndexes failed:', e.message); }
  },

  // ── 大盤指數（TWSE 透過 Worker）─────────────────────
  async fetchIndexes() {
    try {
      const isTWOpen = typeof APP !== 'undefined' ? APP.isTWMarketOpen() : false;
      const res = await this._fetch(
        `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw%7Cotc_o00.tw&json=1&delay=0&_=${Date.now()}`
      );
      const json  = await res.json();
      const items = json?.msgArray ?? [];
      items.forEach(item => {
        const priceRaw = item.z && item.z !== '-' ? parseFloat(item.z) : null;
        const price = priceRaw ?? parseFloat(item.y) ?? 0;
        const prev  = parseFloat(item.y) || price;
        const chg   = price - prev;
        const pct   = prev > 0 ? chg / prev * 100 : 0;
        const sign  = chg >= 0 ? '+' : '';
        const priceStr = price.toLocaleString('zh-TW', {maximumFractionDigits:2});
        const disp = isTWOpen
          ? `${priceStr} (${sign}${pct.toFixed(2)}%)`
          : `${priceStr}`;
        const cls = isTWOpen ? `index-chip ${chg >= 0 ? 'up' : 'dn'}` : 'index-chip';
        if (item.ex === 'tse') {
          const el = document.getElementById('taiex-badge');
          if (el) { el.textContent = `加權 ${disp}`; el.className = cls; }
        } else if (item.ex === 'otc') {
          const el = document.getElementById('tpex-badge');
          if (el) { el.textContent = `櫃買 ${disp}`; el.className = cls; }
        }
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
      '2y':  { interval:'1d',  range:'2y'  },
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
