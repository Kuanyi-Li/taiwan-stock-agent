// ── data.js  ── Yahoo Finance fetcher (v2)
// Supports multi-interval K-lines (5m/15m/60m/1d/1wk/1mo/3mo/6mo/1y)
 
const DATA = {
  proxies: [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url=',
  ],
  activeProxy: 0,
  cache: {},
  histCache: {},
  CACHE_TTL: 60000,
  HIST_TTL: 300000,
 
  get corsProxy() { return this.proxies[this.activeProxy]; },
 
  yUrl(path) {
    return `${this.corsProxy}${encodeURIComponent('https://query1.finance.yahoo.com' + path)}`;
  },
 
  async _fetchWithFallback(url, opts = {}) {
    for (let p = 0; p < this.proxies.length; p++) {
      const idx = (this.activeProxy + p) % this.proxies.length;
      const proxyUrl = this.proxies[idx] + encodeURIComponent(url.replace(/^https?:\/\/query1\.finance\.yahoo\.com/, 'https://query1.finance.yahoo.com'));
      try {
        const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(9000), ...opts });
        if (res.ok) { this.activeProxy = idx; return res; }
      } catch (e) { /* try next */ }
    }
    throw new Error('All proxies failed');
  },
 
  async fetchQuote(symbol) {
    const now = Date.now();
    const c = this.cache[symbol];
    if (c && now - c.ts < this.CACHE_TTL) return c;
    const ySymbol = this._toYahooSymbol(symbol);
    try {
      const res = await this._fetchWithFallback(`https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=1d&range=5d`);
      const json = await res.json();
      const q = json?.chart?.result?.[0];
      if (!q) throw new Error('No data');
      const meta = q.meta;
      const price = meta.regularMarketPrice ?? meta.previousClose;
      const prevClose = meta.previousClose ?? price;
      const data = {
        price: +price.toFixed(2),
        prevClose: +prevClose.toFixed(2),
        open: +(meta.regularMarketOpen ?? prevClose).toFixed(2),
        high: +(meta.regularMarketDayHigh ?? price).toFixed(2),
        low: +(meta.regularMarketDayLow ?? price).toFixed(2),
        volume: meta.regularMarketVolume ?? 0,
        name: meta.shortName ?? meta.longName ?? symbol,
        currency: meta.currency ?? 'TWD',
        ts: now, ok: true,
      };
      this.cache[symbol] = data;
      return data;
    } catch (e) {
      console.warn('[DATA] fetchQuote failed:', symbol, e.message);
      if (c) return { ...c, stale: true };
      return { price: null, prevClose: null, ok: false, error: e.message };
    }
  },
 
  // period: '5m','15m','60m','1d','5d','1wk','1mo','3mo','6mo','1y'
  // maps to Yahoo interval + range
  _periodToParams(period) {
    const map = {
      '5m':  { interval: '5m',  range: '5d' },
      '15m': { interval: '15m', range: '5d' },
      '60m': { interval: '60m', range: '1mo' },
      '1d':  { interval: '1d',  range: '1mo' },
      '1wk': { interval: '1d',  range: '3mo' },
      '1mo': { interval: '1d',  range: '6mo' },
      '3mo': { interval: '1d',  range: '1y' },
      '6mo': { interval: '1wk', range: '2y' },
      '1y':  { interval: '1wk', range: '5y' },
    };
    return map[period] ?? { interval: '1d', range: '3mo' };
  },
 
  async fetchHistory(symbol, period = '3mo') {
    const { interval, range } = this._periodToParams(period);
    const key = `${symbol}_${period}`;
    const now = Date.now();
    const c = this.histCache[key];
    // Intraday shorter TTL
    const ttl = ['5m','15m','60m'].includes(period) ? 60000 : this.HIST_TTL;
    if (c && now - c.ts < ttl) return c.data;
    const ySymbol = this._toYahooSymbol(symbol);
    try {
      const res = await this._fetchWithFallback(`https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=${interval}&range=${range}`);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error('No data');
      const ts = result.timestamp ?? [];
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
      return candles;
    } catch (e) {
      console.warn('[DATA] fetchHistory failed:', symbol, e.message);
      if (c) return c.data;
      return this._mockCandles(symbol, period);
    }
  },
 
  async fetchIndexes() {
    const indexes = [
      { sym: '^TWII', id: 'taiex-badge', prefix: '加權' },
      { sym: '^TWO',  id: 'tpex-badge',  prefix: '櫃買' },
    ];
    for (const idx of indexes) {
      try {
        const res = await this._fetchWithFallback(`https://query1.finance.yahoo.com/v8/finance/chart/${idx.sym}?interval=1d&range=5d`);
        const json = await res.json();
        const meta = json?.chart?.result?.[0]?.meta;
        if (!meta) continue;
        const price = meta.regularMarketPrice ?? 0;
        const prev = meta.previousClose ?? price;
        const chg = price - prev;
        const pct = (chg / prev * 100);
        const sign = chg >= 0 ? '+' : '';
        const el = document.getElementById(idx.id);
        if (el) {
          el.textContent = `${idx.prefix} ${price.toLocaleString('zh-TW',{maximumFractionDigits:0})} (${sign}${pct.toFixed(2)}%)`;
          el.className = `index-chip ${chg >= 0 ? 'up' : 'dn'}`;
        }
      } catch(e) {}
    }
  },
 
  async updateAllPrices(stocks, onUpdate) {
    const promises = stocks.map(async s => {
      const q = await this.fetchQuote(s.code);
      if (q.ok && q.price) {
        s.price = q.price;
        s.prevClose = q.prevClose ?? s.prevClose;
        s.high = q.high; s.low = q.low;
        s.volume = q.volume;
        s.marketName = q.name;
      }
      if (onUpdate) onUpdate(s);
    });
    await Promise.allSettled(promises);
  },
 
  _toYahooSymbol(code) {
    if (code.includes('.') || code.startsWith('^')) return code;
    if (!isNaN(parseInt(code))) return code + '.TW';
    return code;
  },
 
  _mockCandles(symbol, period) {
    const counts = { '5m':78,'15m':40,'60m':30,'1d':22,'1wk':30,'1mo':45,'3mo':65,'6mo':130,'1y':250 };
    const n = counts[period] ?? 60;
    const base = this.cache[symbol]?.price ?? 100;
    const data = [];
    let price = base * 0.92;
    const now = Date.now();
    const stepMs = ['5m','15m','60m'].includes(period) ? 60000*parseInt(period) : 86400000;
    for (let i = n-1; i >= 0; i--) {
      const o = price;
      const range = o * 0.02;
      const h = o + Math.random()*range;
      const l = o - Math.random()*range;
      const c = l + (h-l)*Math.random();
      data.push({ t: now-i*stepMs, o:+o.toFixed(2), h:+h.toFixed(2), l:+l.toFixed(2), c:+c.toFixed(2), v:Math.floor(100000+Math.random()*500000) });
      price = c;
    }
    return data;
  },
};
