// ── data.js v6 ── FinMind + TWSE 集中式架構
//
// 架構：
// 1. 全域 priceStore：所有 UI 只讀
// 2. 台股：TWSE 批次（盤中）+ FinMind（收盤後/歷史）
// 3. 美股：Yahoo Finance v8 chart（直接打，有 CORS）
// 4. rate-limit queue：TWSE 5秒3次限制
// 5. 休市時不主動更新（由 APP 判斷）

const DATA = {

  // FinMind token（從設定讀取）
  get finmindToken() { return APP?.settings?.finmindToken || ''; },

  // ── Rate-limit Queue ──────────────────────────────────
  _queue: [],
  _queueBusy: false,
  _lastReqTime: 0,
  MIN_INTERVAL: 1800,

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

  // ── Fetch with proxy for TWSE, direct for others ─────
  // mis.twse.com.tw 需要 Referer/Origin header 才允許跨域，用 proxy 繞過
  // Yahoo Finance 有正確的 CORS header，直接打
  proxies: [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.org/?',
  ],
  _proxyIdx: 0,

  async _fetch(url, opts = {}) {
    const isTWSE = url.includes('mis.twse.com.tw');
    if (isTWSE) {
      // TWSE 需要 proxy
      for (let i = 0; i < this.proxies.length; i++) {
        const idx = (this._proxyIdx + i) % this.proxies.length;
        const proxyUrl = this.proxies[idx] + encodeURIComponent(url);
        try {
          const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000), ...opts });
          if (res.ok) { this._proxyIdx = idx; return res; }
        } catch(e) { /* try next proxy */ }
      }
      throw new Error('TWSE: all proxies failed');
    }
    // 非 TWSE 直接打（Yahoo Finance 等）
    const res = await fetch(url, { signal: AbortSignal.timeout(9000), ...opts });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  },

  // ── 判斷是否為美股 ────────────────────────────────────
  _isUSStock(code) {
    // 純英文字母 = 美股（AAPL, TSLA, NVDA...），數字 = 台股
    return /^[A-Za-z]+$/.test(code);
  },

  // ── 主要更新入口 ──────────────────────────────────────
  async batchUpdate(codes) {
    if (!codes?.length) return;
    const unique = [...new Set(codes)];
    const twCodes = unique.filter(c => !this._isUSStock(c));
    const usCodes = unique.filter(c => this._isUSStock(c));

    // 台股：TWSE 批次
    if (twCodes.length > 0) {
      await this._enqueue(async () => {
        let missing = [];
        try {
          missing = await this._twseBatch(twCodes);
          console.log(`[DATA] TWSE: ${twCodes.length - missing.length} OK, ${missing.length} missing`);
        } catch(e) {
          console.warn('[DATA] TWSE failed:', e.message);
          missing = twCodes;
        }
        // 上櫃補送
        if (missing.length > 0) {
          await this._enqueue(() => this._tpexBatch(missing));
          const stillMissing = missing.filter(c => !this.priceStore[c]?.price);
          if (stillMissing.length > 0) console.warn('[DATA] missing:', stillMissing);
        }
      });
    }

    // 美股：Yahoo 直接打（不走 queue，不受 TWSE rate limit）
    if (usCodes.length > 0) {
      await Promise.allSettled(usCodes.map(c => this._fetchUSQuote(c)));
    }
  },

  // ── TWSE 批次（上市）────────────────────────────────
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
        source: 'twse',
      });
      found.add(code);
    });
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
        chg, chgPct, noTrade: priceRaw === null, source: 'tpex',
      });
    });
  },

  // ── 美股報價（Yahoo Finance，直接打）─────────────────
  async _fetchUSQuote(code) {
    try {
      const res = await this._fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${code}?interval=1d&range=5d`
      );
      const meta = (await res.json())?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) throw new Error('No price');
      const price    = +parseFloat(meta.regularMarketPrice).toFixed(2);
      const prevClose = +parseFloat(meta.previousClose ?? price).toFixed(2);
      this._setPrice(code, {
        price, prevClose,
        open:    +(meta.regularMarketOpen ?? prevClose).toFixed(2),
        high:    +(meta.regularMarketDayHigh ?? price).toFixed(2),
        low:     +(meta.regularMarketDayLow  ?? price).toFixed(2),
        volume:  meta.regularMarketVolume ?? 0,
        name:    meta.shortName ?? code,
        chg:     +(price - prevClose).toFixed(2),
        chgPct:  +(prevClose > 0 ? (price-prevClose)/prevClose*100 : 0).toFixed(2),
        currency: meta.currency ?? 'USD',
        source:  'yahoo-us',
      });
      console.log(`[DATA] US ${code}: $${price}`);
    } catch(e) {
      console.warn('[DATA] US quote failed:', code, e.message);
    }
  },

  // ── FinMind 技術指標（走 queue，需要 token）─────────
  // 用於增強技術分析
  async fetchFinMindIndicators(stockId, startDate) {
    const token = this.finmindToken;
    if (!token) return null;
    try {
      const datasets = [
        'TaiwanStockTechnicalIndicators',  // RSI, MACD, KD...
        'TaiwanStockMomentumTables',        // 動能指標
      ];
      const results = {};
      for (const dataset of datasets) {
        const url = `https://api.finmindtrade.com/api/v4/data?dataset=${dataset}&data_id=${stockId}&start_date=${startDate}&token=${token}`;
        const res = await this._fetch(url);
        const json = await res.json();
        if (json.status === 200 && json.data?.length) {
          results[dataset] = json.data;
        }
      }
      return results;
    } catch(e) {
      console.warn('[FinMind] indicators failed:', e.message);
      return null;
    }
  },

  // ── FinMind 台股歷史 K 線（備援，有 token 才用）──────
  async fetchFinMindHistory(stockId, startDate, endDate) {
    const token = this.finmindToken;
    if (!token) return null;
    try {
      const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${stockId}&start_date=${startDate}&end_date=${endDate}&token=${token}`;
      const res = await this._fetch(url);
      const json = await res.json();
      if (json.status !== 200 || !json.data?.length) return null;
      return json.data.map(d => ({
        t: new Date(d.date).getTime(),
        o: +d.open.toFixed(2),
        h: +d.max.toFixed(2),
        l: +d.min.toFixed(2),
        c: +d.close.toFixed(2),
        v: d.Trading_Volume || 0,
      }));
    } catch(e) {
      console.warn('[FinMind] history failed:', e.message);
      return null;
    }
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
        s.high = q.high; s.low = q.low; s.volume = q.volume;
        if (q.name && q.name !== s.code) s.marketName = q.name;
      }
      if (onUpdate) onUpdate(s);
    });
  },

  async fetchQuote(symbol) {
    const q = this.priceStore[symbol];
    if (q?.price) return { ...q, ok: true };
    // 若 store 沒有，試著抓一次
    if (this._isUSStock(symbol)) {
      await this._fetchUSQuote(symbol);
    } else {
      await this._enqueue(() => this._twseBatch([symbol]));
    }
    const q2 = this.priceStore[symbol];
    return q2?.price ? { ...q2, ok: true } : { price: null, ok: false };
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
      // 美股和 ETF 直接用 Yahoo
      const sym = this._isUSStock(symbol) ? symbol : symbol + '.TW';
      try {
        const res = await this._fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`
        );
        const result = (await res.json())?.chart?.result?.[0];
        if (!result) throw new Error('No data');
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
        // K 線資料更新 priceStore
        if (candles.length >= 1 && period === '3mo') {
          const last = candles[candles.length - 1];
          const prev = candles.length >= 2 ? candles[candles.length - 2].c : last.c;
          const existing = this.priceStore[symbol];
          if (!existing?.price || existing?.source === 'candle') {
            this._setPrice(symbol, {
              price: last.c, prevClose: prev,
              open: last.o, high: last.h, low: last.l, volume: last.v,
              chg:    +(last.c - prev).toFixed(2),
              chgPct: +(prev > 0 ? (last.c-prev)/prev*100 : 0).toFixed(2),
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

  // ── 大盤指數 ─────────────────────────────────────────
  async fetchIndexes() {
    try {
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
          el.textContent = `加權 ${price.toLocaleString('zh-TW',{maximumFractionDigits:0})} (${chg>=0?'+':''}${pct.toFixed(2)}%)`;
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
      '1y':  { interval:'1d',  range:'2y'  },
    })[period] ?? { interval:'1d', range:'1y' };
  },

  _mockCandles(symbol, period) {
    console.warn('[DATA] mock candles for', symbol);
    const n = { '5m':78,'15m':40,'60m':30,'1d':22,'1wk':30,'1mo':45,'3mo':65,'6mo':130,'1y':250 }[period] ?? 60;
    const base = this.priceStore[symbol]?.price ?? 100;
    let price = base * 0.92;
    const now = Date.now();
    const step = ['5m','15m','60m'].includes(period) ? 60000*parseInt(period) : 86400000;
    return Array.from({ length: n }, (_, i) => {
      const o = price, r = o * 0.02;
      const h = o+Math.random()*r, l = o-Math.random()*r, c = l+(h-l)*Math.random();
      price = c;
      return { t:now-(n-1-i)*step, o:+o.toFixed(2), h:+h.toFixed(2), l:+l.toFixed(2), c:+c.toFixed(2), v:Math.floor(1e5+Math.random()*5e5) };
    });
  },
};
