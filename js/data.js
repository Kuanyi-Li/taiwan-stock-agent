// ── data.js v4 ── 集中式批次報價架構
//
// 核心原則：
// 1. 全域 priceStore：所有 UI 只讀 cache，不直接打 API
// 2. TWSE 批次請求：一次抓所有股票（一個 request 解決）
// 3. rate-limit queue：每次請求間隔 >= 1800ms（TWSE 限制 5秒3次）
// 4. setInterval 集中控制，render / 切換股票不觸發 fetch
// 5. TWSE 優先，Yahoo v8 備援，都走同一個 queue

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
  // { code: { price, prevClose, open, high, low, volume, name, chg, chgPct, ts, source } }
  priceStore: {},

  _setPrice(code, fields) {
    this.priceStore[code] = { ...(this.priceStore[code] ?? {}), ...fields, ts: Date.now() };
  },

  // ── CORS Proxy ────────────────────────────────────────
  proxies: [
    'https://corsproxy.io/?',
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

  // ── TWSE 批次報價（主力）─────────────────────────────
  // 一次請求涵蓋所有股票，嚴格遵守 rate limit
  async _twseBatch(codes) {
    // 每個代號先試 tse_（上市），上櫃用 otc_
    // 混合時：先全部送 tse_，回來後沒資料的補送 otc_
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
      const priceRaw = item.z !== '-' ? parseFloat(item.z) : null;
      const prevClose = parseFloat(item.y) || 0;
      const price = priceRaw ?? prevClose; // 無成交用昨收
      if (!price) return;
      const chg    = +(price - prevClose).toFixed(2);
      const chgPct = +(prevClose > 0 ? chg / prevClose * 100 : 0).toFixed(2);
      this._setPrice(code, {
        price:    +price.toFixed(2),
        prevClose: +prevClose.toFixed(2),
        open:     +(parseFloat(item.o) || prevClose).toFixed(2),
        high:     +(parseFloat(item.h) || price).toFixed(2),
        low:      +(parseFloat(item.l) || price).toFixed(2),
        volume:   parseInt(item.v) || 0,
        name:     item.n || code,
        chg, chgPct,
        noTrade: priceRaw === null, // 標記尚未成交
        source:  'twse',
      });
      found.add(code);
    });

    // 回傳沒有資料的代號（可能是上櫃，再補送 otc_）
    return codes.filter(c => !found.has(c));
  },

  // 上櫃補送
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
        chg, chgPct, noTrade: priceRaw === null, source: 'tpex',
      });
    });
  },

  // ── Yahoo 備援（走 queue，一次一支）─────────────────
  async _yahooFallback(code) {
    const sym = isNaN(parseInt(code)) ? code : code + '.TW';
    // v7 quote
    try {
      const res = await this._fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${sym}` +
        `&fields=regularMarketPrice,regularMarketPreviousClose,regularMarketOpen,` +
        `regularMarketDayHigh,regularMarketDayLow,regularMarketVolume,shortName`
      );
      const q = (await res.json())?.quoteResponse?.result?.[0];
      if (q?.regularMarketPrice != null) {
        const p = +parseFloat(q.regularMarketPrice).toFixed(2);
        const pc = +parseFloat(q.regularMarketPreviousClose ?? p).toFixed(2);
        this._setPrice(code, {
          price: p, prevClose: pc,
          open:   +(q.regularMarketOpen ?? pc).toFixed(2),
          high:   +(q.regularMarketDayHigh ?? p).toFixed(2),
          low:    +(q.regularMarketDayLow  ?? p).toFixed(2),
          volume: q.regularMarketVolume ?? 0,
          name:   q.shortName ?? code,
          chg:    +(p - pc).toFixed(2),
          chgPct: +(pc > 0 ? (p - pc) / pc * 100 : 0).toFixed(2),
          source: 'yahoo',
        });
        return true;
      }
    } catch(e) { /* try v8 */ }
    // v8 chart fallback
    try {
      const res = await this._fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`
      );
      const meta = (await res.json())?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        const p  = +parseFloat(meta.regularMarketPrice).toFixed(2);
        const pc = +parseFloat(meta.previousClose ?? p).toFixed(2);
        this._setPrice(code, {
          price: p, prevClose: pc,
          open:   +(meta.regularMarketOpen ?? pc).toFixed(2),
          high:   +(meta.regularMarketDayHigh ?? p).toFixed(2),
          low:    +(meta.regularMarketDayLow  ?? p).toFixed(2),
          volume: meta.regularMarketVolume ?? 0,
          name:   meta.shortName ?? code,
          chg:    +(p - pc).toFixed(2),
          chgPct: +(pc > 0 ? (p - pc) / pc * 100 : 0).toFixed(2),
          source: 'yahoo-v8',
        });
        return true;
      }
    } catch(e) { /* silent */ }
    return false;
  },

  // ── 主要更新入口（由 APP 的 setInterval 集中呼叫）────
  // ★ 這是唯一應該觸發 API 請求的地方
  async batchUpdate(codes) {
    if (!codes?.length) return;
    const unique = [...new Set(codes)];
    await this._enqueue(async () => {
      let missing = [];
      try {
        missing = await this._twseBatch(unique);
        console.log(`[DATA] TWSE batch: ${unique.length - missing.length} updated, ${missing.length} missing`);
      } catch(e) {
        console.warn('[DATA] TWSE failed:', e.message);
        missing = unique; // 全部當 missing 送 Yahoo
      }
      // 上櫃補送（一次 request）
      if (missing.length > 0) {
        await new Promise(r => setTimeout(r, this.MIN_INTERVAL));
        this._lastReqTime = Date.now();
        try {
          await this._tpexBatch(missing);
          missing = missing.filter(c => !this.priceStore[c]?.price);
        } catch(e) { /* continue */ }
      }
      // 還剩沒有的 → Yahoo 備援（每支走 queue，受 rate limit 控制）
      for (const code of missing) {
        await this._enqueue(() => this._yahooFallback(code));
      }
    });
  },

  // ── 舊介面相容：updateAllPrices ──────────────────────
  // 呼叫 batchUpdate，完成後同步回 stock 物件
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

  // ── 舊介面相容：fetchQuote（只讀 store）──────────────
  async fetchQuote(symbol) {
    const q = this.priceStore[symbol];
    if (q?.price) return { ...q, ok: true };
    return { price: null, prevClose: null, ok: false };
  },

  // ── K 線資料（走 queue）──────────────────────────────
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
        // ★ K 線成功後順便更新 priceStore（最後一根 = 最新收盤）
        if (candles.length >= 1 && period === '3mo') {
          const last = candles[candles.length - 1];
          const prev = candles.length >= 2 ? candles[candles.length - 2].c : last.c;
          const existing = this.priceStore[symbol];
          // 只在沒有盤中報價時才用 K 線補（避免覆蓋即時 TWSE 資料）
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

  // ── 大盤指數（獨立，不走 queue）─────────────────────
  async fetchIndexes() {
    try {
      // 用 TWSE 抓大盤指數
      const res = await this._fetch(
        'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0'
      );
      const json  = await res.json();
      const item  = json?.msgArray?.[0];
      if (item) {
        const price = parseFloat(item.z !== '-' ? item.z : item.y) || 0;
        const prev  = parseFloat(item.y) || price;
        const chg   = price - prev;
        const pct   = prev > 0 ? chg / prev * 100 : 0;
        const sign  = chg >= 0 ? '+' : '';
        const el = document.getElementById('taiex-badge');
        if (el) {
          el.textContent = `加權 ${price.toLocaleString('zh-TW', {maximumFractionDigits:0})} (${sign}${pct.toFixed(2)}%)`;
          el.className = `index-chip ${chg >= 0 ? 'up' : 'dn'}`;
        }
        return;
      }
    } catch(e) { /* fallback to Yahoo */ }
    // Yahoo fallback for indexes
    try {
      const res = await this._fetch(
        'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=5d'
      );
      const meta  = (await res.json())?.chart?.result?.[0]?.meta ?? {};
      const price = meta.regularMarketPrice ?? 0;
      const prev  = meta.previousClose ?? price;
      const chg   = price - prev;
      const pct   = prev > 0 ? chg / prev * 100 : 0;
      const sign  = chg >= 0 ? '+' : '';
      const el = document.getElementById('taiex-badge');
      if (el) {
        el.textContent = `加權 ${price.toLocaleString('zh-TW', {maximumFractionDigits:0})} (${sign}${pct.toFixed(2)}%)`;
        el.className = `index-chip ${chg >= 0 ? 'up' : 'dn'}`;
      }
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
