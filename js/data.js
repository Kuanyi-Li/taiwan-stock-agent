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
      const newIsPlaceholder = !!fields.noTrade;
      const oldIsPlaceholder = !!existing.noTrade;
      // ★ 修正閃爍bug：新資料如果只是「無成交」佔位符、但舊資料是真正的資料，
      // 不該讓佔位符蓋掉真資料——之前的判斷方向反了，導致每次自動刷新
      // 都會先被佔位符蓋掉、Yahoo補價才追上來蓋回正確值，一直重複閃爍。
      if (newIsPlaceholder && !oldIsPlaceholder) {
        return; // 拒絕：舊的是真資料，新的只是佔位符，不要覆蓋
      }
      if (!newIsPlaceholder || oldIsPlaceholder) {
        // 新資料是真的（不管舊的是什麼），或兩邊都只是佔位符 → 正常比較優先序
        // 來源優先序：twse/tpex > yahoo-spark/yahoo-us > yahoo-tw-fallback > twse-prev
        const rank = s => s==='twse'||s==='tpex' ? 4 : s==='yahoo-spark'||s==='yahoo-us' ? 3 : s==='yahoo-tw-fallback' ? 2 : s==='twse-prev' ? 0 : 1;
        const newRank = rank(fields.source);
        const oldRank = rank(existing.source);
        const newTs   = Date.now();
        const oldTs   = existing.ts || 0;
        // 舊資料來源優先序更高，且不超過 30 秒前 → 不覆蓋
        if (oldRank > newRank && (newTs - oldTs) < 30000) return;
      }
    }
    this.priceStore[code] = { ...(existing ?? {}), ...fields, ts: Date.now() };
    // ★ 每次收到「真正即時、而且今天真的有成交」的報價，才記錄今天的開高低收。
    // 不能用K線補的、收盤延續的、或 noTrade（今天還沒真正成交，只是延續昨收當佔位符）的資料，
    // 不然像冷門股常常整天沒成交，會把昨天的收盤價誤記成「今天」的資料，
    // 導致今天這根K線變成昨天的複製品。
    if (fields.price && fields.source !== 'candle' && fields.source !== 'twse-prev' && !fields.noTrade) {
      this._trackOwnDayCandle(code, fields.price, fields.open, fields.high, fields.low);
    }
  },

  // 用「本地時區」日期字串（YYYY-MM-DD），不要用 toISOString()（那是UTC，
  // 台灣是UTC+8，半夜0:00~8:00這段時間toISOString會誤判成前一天）
  _localDateStr(d) {
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  },

  // ── 自己追蹤的當日開高低收（獨立於 Yahoo 歷史K線之外的第二來源）──
  _ownDayKey() { return 'stock-agent-owntrack'; },
  _ownDayCache: null,
  _loadOwnDayCache() {
    if (this._ownDayCache) return this._ownDayCache;
    try { this._ownDayCache = JSON.parse(localStorage.getItem(this._ownDayKey()) || '{}'); }
    catch(e) { this._ownDayCache = {}; }
    return this._ownDayCache;
  },
  _saveOwnDayCache() {
    try { localStorage.setItem(this._ownDayKey(), JSON.stringify(this._ownDayCache)); } catch(e) {}
  },
  // ★ 資料版本標記：每次追蹤邏輯有重大修正（例如這次修正noTrade污染問題），
  // 就把這個數字加1，讓舊版本寫入的追蹤資料自動失效、強制重新開始追蹤，
  // 避免用到修正之前可能已經被污染的舊資料。
  _OWN_TRACK_VERSION: 2,
  _trackOwnDayCandle(code, price, open, high, low) {
    const cache = this._loadOwnDayCache();
    const today = this._localDateStr(new Date());
    if (!cache[code]) cache[code] = {};
    const byDate = cache[code];
    const existing = byDate[today];
    if (!existing || existing._v !== this._OWN_TRACK_VERSION) {
      // 沒有資料，或是舊版本寫的（可能被污染）→ 直接重新開始，不要跟舊資料合併
      byDate[today] = { open: open ?? price, high: high ?? price, low: low ?? price, close: price, _v: this._OWN_TRACK_VERSION };
    } else {
      existing.close = price;
      existing.high = high != null ? Math.max(existing.high, high) : Math.max(existing.high, price);
      existing.low  = low  != null ? Math.min(existing.low,  low)  : Math.min(existing.low,  price);
    }
    // 只保留最近7天，避免localStorage無限長大
    const dates = Object.keys(byDate).sort();
    if (dates.length > 7) dates.slice(0, dates.length - 7).forEach(d => delete byDate[d]);
    this._saveOwnDayCache();
  },
  // 取得某symbol「我們自己觀察到」指定日期（預設今天）的開高低收（如果有的話）
  getOwnDayCandle(code, dateStr) {
    const cache = this._loadOwnDayCache();
    const date = dateStr || this._localDateStr(new Date());
    const rec = cache[code]?.[date];
    // 舊版本寫入、還沒被新資料覆蓋掉的紀錄，視為不存在（避免用到可能污染的資料）
    if (rec && rec._v !== this._OWN_TRACK_VERSION) return null;
    return rec || null;
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
  // ★ 改成同時查「上市(tse_)+上櫃(otc_)」，不再是「先猜上市，查不到才回頭查上櫃」。
  // 之前的做法對上櫃股票（例如3357）要多等一輪額外的網路請求+固定間隔延遲，
  // 才能拿到正確報價，這是「休市/卡在昨收好一陣子」的根本原因。
  async _twseBatch(codes) {
    if (!codes.length) return [];
    // ★ 用 %7C 直接串接，避免 encodeURIComponent 雙重編碼；每檔同時查 tse_ 和 otc_ 兩種前綴
    const exCh = codes.map(c => `tse_${c}.tw%7Cotc_${c}.tw`).join('%7C');
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
        if (!code) return; // 沒有真的匹配到（例如查tse_但其實是上櫃股，這個前綴不會有結果）
        const priceRaw  = item.z && item.z !== '-' ? parseFloat(item.z) : null;
        const prevClose = parseFloat(item.y) || 0;
        const exSource = item.ex === 'otc' ? 'tpex' : 'twse'; // 記錄實際是從哪個市場查到的

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
          source: exSource, market: 'TW',
        });
        found.add(code);
      });

      // ★ 不管 TWSE/TPEX 有沒有值，都用 Yahoo spark 補（確保即時）
      // noTrade 的優先補，有值的非同步更新
      if (noTradeCodes.length > 0) {
        this._yahooTWFallback(noTradeCodes);
      }
      // 有值的也補 Yahoo，避免 TWSE/TPEX 有 session 問題時落後
      const hasTradeCodes = [...found].filter(c => !noTradeCodes.includes(c));
      if (hasTradeCodes.length > 0) {
        this._yahooTWFallback(hasTradeCodes);
      }

      console.log(`[DATA] TWSE+TPEX: ${found.size - noTradeCodes.length} realtime, ${noTradeCodes.length} yahoo fallback, ${codes.length - found.size} missing`);
      return codes.filter(c => !found.has(c));
    } catch(e) {
      console.warn('[DATA] TWSE+TPEX failed:', e.message);
      return codes;
    }
  },

  // ── Yahoo spark 補台股即時價（TWSE z='-' 時使用）────
  async _yahooTWFallback(codes) {
    if (!codes.length) return;
    // ★ 修正：之前寫死全部用 .TW（上市），上櫃股票（.TWO）查不到會被靜默跳過，
    // 導致上櫃股票的報價一直卡在TWSE給的舊佔位符。
    // 優先用已知的後綴快取（fetchHistory時建立的），沒有快取的先試 .TW。
    const suffixOf = c => this._twSuffixCache[c] || '.TW';
    const symbols = codes.map(c => c + suffixOf(c)).join(',');
    const gotCodes = new Set();
    try {
      const res = await this._fetch(
        `https://query2.finance.yahoo.com/v7/finance/spark?symbols=${symbols}&range=1d&interval=1d&_=${Date.now()}`
      );
      const results = (await res.json())?.spark?.result ?? [];
      results.forEach(item => {
        const meta = item?.response?.[0]?.meta;
        const code = item.symbol.replace('.TWO', '').replace('.TW', '');
        if (!meta?.regularMarketPrice) return; // 這個後綴查不到，留給下面重試 .TWO
        gotCodes.add(code);
        this._twSuffixCache[code] = suffixOf(code); // 記住這個後綴是對的
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
      console.log(`[DATA] Yahoo TW fallback: ${gotCodes.size}/${codes.length} updated`);

      // ★ 沒查到的（可能是後綴猜錯），用另一個後綴重試一次
      const missed = codes.filter(c => !gotCodes.has(c));
      if (missed.length) {
        const retrySymbols = missed.map(c => c + (suffixOf(c) === '.TW' ? '.TWO' : '.TW')).join(',');
        try {
          const res2 = await this._fetch(
            `https://query2.finance.yahoo.com/v7/finance/spark?symbols=${retrySymbols}&range=1d&interval=1d&_=${Date.now()}`
          );
          const results2 = (await res2.json())?.spark?.result ?? [];
          results2.forEach(item => {
            const meta = item?.response?.[0]?.meta;
            if (!meta?.regularMarketPrice) return;
            const code = item.symbol.replace('.TWO', '').replace('.TW', '');
            const usedSuffix = item.symbol.includes('.TWO') ? '.TWO' : '.TW';
            this._twSuffixCache[code] = usedSuffix; // 記住正確的後綴，下次不用再猜
            gotCodes.add(code);
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
          if (results2.length) console.log(`[DATA] Yahoo TW fallback retry(另一後綴): ${results2.length}/${missed.length} updated`);
        } catch(e) { /* 重試失敗就算了，保留原本的佔位資料 */ }
      }

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
      const noTradeCodes = []; // ★ z='-' 的上櫃股票，一樣需要 Yahoo 補價（之前這裡完全沒補，是3357一直卡住的真正原因）
      (json?.msgArray ?? []).forEach(item => {
        const code = item.c;
        if (!code) return;
        const priceRaw  = item.z && item.z !== '-' ? parseFloat(item.z) : null;
        const prevClose = parseFloat(item.y) || 0;
        const price     = priceRaw ?? prevClose;
        if (!price) return;
        if (priceRaw === null) noTradeCodes.push(code);
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
      // ★ 補上：上市股(_twseBatch)本來就有這段，上櫃股(_tpexBatch)之前漏掉了
      if (noTradeCodes.length > 0) {
        this._yahooTWFallback(noTradeCodes);
      }
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
      // ── 台股：TWSE+TPEX 合併查詢（一次涵蓋上市+上櫃，不用先猜再重試）──
      if (twCodes.length > 0) {
        let missing = [];
        try {
          missing = await this._twseBatch(twCodes);
        } catch(e) {
          console.warn('[DATA] TWSE+TPEX failed:', e.message);
          missing = twCodes;
        }
        // 真的完全查不到的（例如代碼打錯、已下市），直接用 Yahoo 補，不用再重查一次 TWSE/TPEX
        if (missing.length > 0) {
          this._yahooTWFallback(missing);
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
  _twSuffixCache: {}, // symbol -> '.TW' or '.TWO'（記住上市/上櫃判斷結果）
  HIST_TTL: 1200000, // 20分鐘（日線資料歷史部分很少變動，最新一根另有機制單獨即時更新）

  // ★ 統一的「今天K線」補丁邏輯（唯一真實來源，所有地方都透過這裡取得一致的結果）
  // Yahoo 的日線歷史資料常常還沒把「今天」這一列加進去（尤其盤中查詢），
  // 若放著不管，最後一根K線會停在前一個交易日，連帶影響預測線等所有依賴K線的判斷。
  // 這裡用即時報價自己更新/補上今天這一根，確保任何呼叫 fetchHistory 的地方拿到的都是同步的資料。
  //
  // ★ 新架構（比之前更可靠）：
  // Yahoo 的歷史K線常常「今天」還沒補上，就算補上也可能欄位缺漏（例如close是null）。
  // 與其被動修補一份不可靠的資料，不如反過來：
  // 1. 「今天」這根，主要用我們自己整天追蹤到的完整開高低收（_trackOwnDayCandle）直接建構，
  //    這份資料保證跟畫面上顯示的即時報價同步（因為本來就是同一份報價累積來的）。
  // 2. 一旦 Yahoo 收盤後補上「今天」這天、而且是有效資料（close不是null），
  //    改用 Yahoo 的官方數字（更準確，因為是交易所正式數據，不只是我們抽樣觀察到的）。
  // 3. 只有台股會主動「補一根全新的」，且要先確認已經開盤過；
  //    美股/指數因為Yahoo K線用美東時間標記、跟台灣日曆比對容易時區誤判，維持保守不補。
  //
  // ★ 修正後的優先序（這是關鍵）：我們自己觀察到的即時報價「永遠優先」，
  // Yahoo的歷史資料只在我們完全沒有自己的追蹤資料時才當備援，
  // 不是「Yahoo一有資料就採信、蓋掉我們的」——即使Yahoo的close不是null，
  // 也可能因為它自己的資料處理時序問題而跟即時報價對不上，這種狀況也要以我們自己的為準。
  // 只有台股會主動處理（美股/指數因為Yahoo K線用美東時間標記、跟台灣日曆比對容易時區誤判，維持原樣不動）。
  _patchToday(candles, symbol) {
    if (!candles?.length) return candles;
    const isIndex = symbol.startsWith('^');
    const isUS = isIndex || this.isUSCode(symbol);
    if (isUS) return candles;

    const now = new Date();
    const todayStr = this._localDateStr(now);
    const weekday = now.getDay();
    if (weekday === 0 || weekday === 6) return candles; // 週末不處理
    const h = now.getHours(), m = now.getMinutes();
    const twMarketOpenedToday = h > 9 || (h === 9 && m >= 0); // 開盤前不算「今天已經有資料」
    if (!twMarketOpenedToday) return candles;

    const own = this.getOwnDayCandle(symbol, todayStr);
    if (!own) return candles; // 我們自己完全沒有追蹤到資料（例如今天第一次抓、還沒收到任何即時報價），維持Yahoo原樣當備援

    const last = candles[candles.length - 1];
    const lastDateStr = this._localDateStr(new Date(last.t));
    const o = +own.open.toFixed(2), h2 = +own.high.toFixed(2), l2 = +own.low.toFixed(2), c = +own.close.toFixed(2);

    if (lastDateStr === todayStr) {
      // 不管這根原本是Yahoo給的還是我們之前補的，只要我們有自己的追蹤資料，一律用自己的覆蓋（自己的優先）
      last.o = o; last.h = Math.max(h2, last.h); last.l = Math.min(l2, last.l); last.c = c;
      return candles;
    }

    // Yahoo還沒有「今天」這筆，我們自己補一根上去
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (todayMidnight <= last.t) return candles; // 理論上不會發生
    candles.push({ t: todayMidnight, o, h: Math.max(h2,o,c), l: Math.min(l2,o,c), c, v: this.priceStore[symbol]?.volume ?? 0 });
    return candles;
  },

  async fetchHistory(symbol, period = '3mo') {
    const { interval, range } = this._periodToParams(period);
    const key = `${symbol}_${period}`;
    const now = Date.now();
    const cached = this.histCache[key];
    const ttl = ['5m','15m','60m'].includes(period) ? 15000 : this.HIST_TTL;
    if (cached && now - cached.ts < ttl) {
      // ★ 就算走快取，也要重新同步一次「今天」這根，確保任何呼叫端拿到的都是最新的
      if (interval === '1d') this._patchToday(cached.data, symbol);
      return cached.data;
    }

    return this._enqueue(async () => {
      // 台股：上市用 .TW，上櫃用 .TWO；美股/指數(^開頭)直接用代碼
      // 記住已確認的正確後綴，避免每次都要試錯
      const isIndex = symbol.startsWith('^');
      const isUS = isIndex || this.isUSCode(symbol);
      const cachedSuffix = this._twSuffixCache[symbol];
      const knownTPEX = this.priceStore[symbol]?.source === 'tpex';
      const suffixesToTry = isUS ? [''] :
        cachedSuffix ? [cachedSuffix] :
        knownTPEX ? ['.TWO', '.TW'] : ['.TW', '.TWO'];

      let candles = null, lastErr = null;
      for (const suffix of suffixesToTry) {
        try {
          const sym = symbol + suffix;
          const res = await this._fetch(
            `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}&_=${Date.now()}`
          );
          const json   = await res.json();
          const result = json?.chart?.result?.[0];
          if (!result || !result.timestamp?.length) throw new Error('No chart data');
          const ts    = result.timestamp;
          const ohlcv = result.indicators?.quote?.[0] ?? {};
          const adjcloseArr = result.indicators?.adjclose?.[0]?.adjclose ?? [];
          const arr = [];
          // ★ 資料破損防護：Yahoo 偶爾對 open/high/low 回傳 0（而非 null），
          // ?? 運算子不會攔到 0，需另外判斷，否則會出現 o=h=l=0 的異常K線
          const validOrClose = (v, closeVal) => (v == null || v === 0) ? closeVal : v;
          for (let i = 0; i < ts.length; i++) {
            let closeVal = ohlcv.close?.[i];
            // ★ 修正：Yahoo偶爾只有close是null，但open/high/low/volume都有效資料
            // （實測發現過這種情況），之前整根丟棄會導致該交易日完全消失、
            // K線出現「跳過一天」的斷層，連帶影響預測線判斷。
            // 保底優先序：我們自己整天觀察到的實際報價（最可靠，是真正觀察值不是代用欄位）
            // → adjclose → high → open，全部都無效才真的丟棄。
            if (closeVal == null || closeVal === 0) {
              const dateStr = this._localDateStr(new Date(ts[i] * 1000));
              const own = this.getOwnDayCandle(symbol, dateStr);
              closeVal = own?.close || adjcloseArr[i] || ohlcv.high?.[i] || ohlcv.open?.[i] || null;
            }
            if (closeVal == null || closeVal === 0) continue; // 真的完全沒資料才丟棄
            const o = validOrClose(ohlcv.open?.[i], closeVal);
            const h = validOrClose(ohlcv.high?.[i], closeVal);
            const l = validOrClose(ohlcv.low?.[i],  closeVal);
            arr.push({
              t: ts[i] * 1000,
              o: +o.toFixed(2),
              h: +Math.max(h, o, closeVal).toFixed(2), // 確保 high 不小於 open/close
              l: +Math.min(l, o, closeVal).toFixed(2), // 確保 low 不大於 open/close
              c: +closeVal.toFixed(2),
              v: ohlcv.volume?.[i] ?? 0,
            });
          }
          if (!arr.length) throw new Error('Empty candles');
          candles = arr;
          // ★ 交叉確認：就算Yahoo資料看起來正常，也跟我們自己觀察到的今日收盤價對一下，
          // 差距明顯的話在console留個警告，方便日後排查類似的資料異常
          const lastCandle = candles[candles.length - 1];
          const ownToday = this.getOwnDayCandle(symbol);
          if (ownToday?.close && lastCandle) {
            const diffPct = Math.abs(lastCandle.c - ownToday.close) / ownToday.close * 100;
            if (diffPct > 3) {
              console.warn(`[DATA] ${symbol} 歷史K線最後一根(${lastCandle.c}) 跟自我追蹤收盤價(${ownToday.close}) 差距 ${diffPct.toFixed(1)}%，可能有資料異常`);
            }
          }
          if (!isUS) this._twSuffixCache[symbol] = suffix; // 記住成功的後綴
          break;
        } catch(e) { lastErr = e; }
      }

      if (!candles) {
        console.warn('[DATA] fetchHistory failed:', symbol, lastErr?.message);
        if (cached) return cached.data;
        return this._mockCandles(symbol, period);
      }

      // K線載入後同步補報價（避免覆蓋即時資料）
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
          market: isUS ? 'US' : 'TW',
        });
      }
      // ★ 用（可能更即時的）priceStore 資料同步/補上「今天」這根K線，確保跟即時報價一致
      if (interval === '1d') this._patchToday(candles, symbol);
      this.histCache[key] = { data: candles, ts: now };
      console.log(`[DATA] ${symbol}/${period}: ${candles.length} candles`);
      return candles;
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
        // ★ 同步寫回 priceStore，讓總覽頁的指數卡片也能拿到最新報價
        this._setPrice(sym, { price: p, prevClose: pc, chg, chgPct: pct, source: 'yahoo-spark', market: 'US' });
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
          // ★ 同步寫回 priceStore（用 ^TWII 當 key，跟總覽頁指數卡片一致）
          this._setPrice('^TWII', { price, prevClose: prev, chg, chgPct: pct, source: 'twse', market: 'TW' });
        } else if (item.ex === 'otc') {
          const el = document.getElementById('tpex-badge');
          if (el) { el.textContent = `櫃買 ${disp}`; el.className = cls; }
          this._setPrice('^TWOII', { price, prevClose: prev, chg, chgPct: pct, source: 'twse', market: 'TW' });
        }
      });
    } catch(e) { /* silent */ }
  },

  // ── Helpers ───────────────────────────────────────────
  _periodToParams(period) {
    return ({
      '5m':  { interval:'5m',  range:'5d'  },
      'mini':{ interval:'1d',  range:'1mo' },
      '15m': { interval:'15m', range:'5d'  },
      '60m': { interval:'60m', range:'1mo' },
      '1d':  { interval:'1d',  range:'1y'  },
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
