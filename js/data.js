// ── data.js  ── Yahoo Finance data fetcher ─────────────
// Uses corsproxy.io to bypass CORS for GitHub Pages

const DATA = {
  corsProxy: 'https://corsproxy.io/?',
  cache: {},           // { symbol: { price, prevClose, info, ts } }
  histCache: {},       // { "symbol_period": { data, ts } }
  CACHE_TTL: 60000,    // 1 min for price
  HIST_TTL: 300000,    // 5 min for history

  // ── Build Yahoo Finance URL ──────────────────────────
  yUrl(path) {
    return `${this.corsProxy}${encodeURIComponent('https://query1.finance.yahoo.com' + path)}`;
  },

  // ── Fetch current quote ──────────────────────────────
  async fetchQuote(symbol) {
    const now = Date.now();
    const c = this.cache[symbol];
    if (c && now - c.ts < this.CACHE_TTL) return c;

    // Taiwan stocks need .TW suffix
    const ySymbol = this._toYahooSymbol(symbol);
    try {
      const url = this.yUrl(`/v8/finance/chart/${ySymbol}?interval=1d&range=5d`);
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
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
        marketCap: meta.marketCap ?? null,
        name: meta.shortName ?? meta.longName ?? symbol,
        currency: meta.currency ?? 'TWD',
        ts: now,
        ok: true,
      };
      this.cache[symbol] = data;
      return data;
    } catch (e) {
      console.warn('[DATA] fetchQuote failed:', symbol, e.message);
      // Return cached stale if available
      if (c) return { ...c, stale: true };
      return { price: null, prevClose: null, ok: false, error: e.message };
    }
  },

  // ── Fetch historical OHLCV ───────────────────────────
  async fetchHistory(symbol, period = '3mo', interval = '1d') {
    const key = `${symbol}_${period}_${interval}`;
    const now = Date.now();
    const c = this.histCache[key];
    if (c && now - c.ts < this.HIST_TTL) return c.data;

    const ySymbol = this._toYahooSymbol(symbol);
    try {
      const url = this.yUrl(`/v8/finance/chart/${ySymbol}?interval=${interval}&range=${period}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error('No data');

      const ts = result.timestamp ?? [];
      const ohlcv = result.indicators?.quote?.[0] ?? {};
      const opens = ohlcv.open ?? [];
      const highs = ohlcv.high ?? [];
      const lows = ohlcv.low ?? [];
      const closes = ohlcv.close ?? [];
      const volumes = ohlcv.volume ?? [];

      const candles = [];
      for (let i = 0; i < ts.length; i++) {
        if (closes[i] == null) continue;
        candles.push({
          t: ts[i] * 1000,
          o: +((opens[i] ?? closes[i])).toFixed(2),
          h: +((highs[i] ?? closes[i])).toFixed(2),
          l: +((lows[i] ?? closes[i])).toFixed(2),
          c: +closes[i].toFixed(2),
          v: volumes[i] ?? 0,
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

  // ── Fetch index data (TAIEX = ^TWII, TPEx = ^TWO) ───
  async fetchIndexes() {
    const indexes = [
      { sym: '^TWII', id: 'taiex-badge', prefix: '加權指數' },
      { sym: '^TWO',  id: 'tpex-badge',  prefix: '櫃買指數' },
    ];
    for (const idx of indexes) {
      try {
        const url = this.yUrl(`/v8/finance/chart/${idx.sym}?interval=1d&range=5d`);
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
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
          el.textContent = `${idx.prefix} ${price.toLocaleString('zh-TW',{maximumFractionDigits:2})} (${sign}${pct.toFixed(2)}%)`;
          el.style.color = chg >= 0 ? 'var(--red)' : 'var(--green-l)';
        }
      } catch (e) {
        console.warn('[DATA] index fetch failed:', idx.sym);
      }
    }
  },

  // ── Batch update all portfolio prices ────────────────
  async updateAllPrices(stocks, onUpdate) {
    const promises = stocks.map(async (s) => {
      const q = await this.fetchQuote(s.code);
      if (q.ok && q.price) {
        s.price = q.price;
        s.prevClose = q.prevClose ?? s.prevClose;
        s.high = q.high;
        s.low = q.low;
        s.volume = q.volume;
        s.marketName = q.name;
      }
      if (onUpdate) onUpdate(s);
    });
    await Promise.allSettled(promises);
  },

  // ── Convert TW stock code to Yahoo symbol ────────────
  _toYahooSymbol(code) {
    // Already has suffix
    if (code.includes('.')) return code;
    // Indices
    if (code.startsWith('^')) return code;
    // ETF & stocks: 4-digit → .TW, some .TWO for OTC
    const num = parseInt(code);
    if (!isNaN(num)) {
      // OTC stocks are typically 4-digit starting with 6xxx or 8xxx or some others
      // Simple heuristic: try .TW first (covers most TSE listed)
      return code + '.TW';
    }
    return code;
  },

  // ── Fallback mock candles when API fails ─────────────
  _mockCandles(symbol, period) {
    const counts = { '1d': 48, '1wk': 35, '1mo': 22, '3mo': 65, '6mo': 130, '1y': 250 };
    const n = counts[period] ?? 60;
    const base = (this.cache[symbol]?.price ?? 100);
    const data = [];
    let price = base * (0.9 + Math.random() * 0.1);
    const now = Date.now();
    for (let i = n - 1; i >= 0; i--) {
      const o = price;
      const range = o * 0.025;
      const h = o + Math.random() * range;
      const l = o - Math.random() * range;
      const c = l + (h - l) * Math.random();
      data.push({
        t: now - i * 86400000,
        o: +o.toFixed(2), h: +h.toFixed(2),
        l: +l.toFixed(2), c: +c.toFixed(2),
        v: Math.floor(100000 + Math.random() * 500000),
      });
      price = c;
    }
    return data;
  },
};
