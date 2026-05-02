// ── news.js  ── 新聞情緒 + 市場恐慌指標 + 賣出建議引擎 ──────

const NEWS = {
  cache: {},          // symbol → { items, ts }
  marketCache: null,
  CACHE_TTL: 300000,  // 5 min

  // ─── RSS sources via CORS proxy ──────────────────────
  RSS_SOURCES: [
    {
      name: '鉅亨網',
      url: 'https://news.cnyes.com/rss/tw_stock',
      bias: 0,
    },
    {
      name: 'Yahoo股市',
      url: 'https://tw.stock.yahoo.com/rss',
      bias: 0,
    },
  ],

  // Keyword sentiment dictionary (Traditional Chinese)
  SENTIMENT: {
    very_positive: ['大漲', '突破', '創高', '獲利', '暴漲', '強勢', '爆量', '大買超', '利多', '業績亮眼', '超預期', '法人買超', '外資買超', '買超', '上修', '擴產', 'AI需求', '訂單滿載'],
    positive: ['上漲', '拉升', '看好', '買進', '增持', '回升', '反彈', '轉強', '成長', '受惠', '聯盟', '合作', '新訂單', '出貨', '季增', '年增', '展望佳'],
    negative: ['下跌', '下修', '獲利了結', '調節', '賣壓', '修正', '跌破', '利空', '賣出', '降評', '庫存', '砍單', '需求疲弱', '衰退', '季減', '年減'],
    very_negative: ['暴跌', '崩盤', '重挫', '大賣超', '熔斷', '恐慌', '拋售', '腰斬', '大幅下修', '外資大賣', '法人賣超', '爆量下跌', '跌停', '財報地雷', '倒閉', '違約'],
  },

  // Market fear indicators keywords
  FEAR_KEYWORDS: {
    extreme_fear: ['崩盤', '熔斷', '股災', '金融危機', '恐慌性拋售', '系統性風險', '流動性危機', '雷曼', '黑天鵝'],
    high_fear: ['重挫', '大跌', '資金外逃', '避險', '美債殖利率', '升息', '通膨失控', '衰退疑慮', '地緣風險'],
    moderate_fear: ['修正', '獲利了結', '觀望', '量縮', '外資賣超', '法人調節'],
  },

  // ─── Fetch Google News RSS for a stock ───────────────
  async fetchStockNews(code, name) {
    const now = Date.now();
    const key = `${code}_${name}`;
    if (this.cache[key] && now - this.cache[key].ts < this.CACHE_TTL) {
      return this.cache[key].items;
    }

    const queries = [
      `${name} 股票`,
      `${code} 台股`,
    ];
    const items = [];

    for (const q of queries) {
      try {
        const encoded = encodeURIComponent(q);
        const rssUrl = `https://news.google.com/rss/search?q=${encoded}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
        const proxyUrl = `${DATA.corsProxy}${encodeURIComponent(rssUrl)}`;
        const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(7000) });
        if (!res.ok) continue;
        const text = await res.text();
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'application/xml');
        const entries = xml.querySelectorAll('item');
        entries.forEach(item => {
          const title = item.querySelector('title')?.textContent?.replace(/<[^>]*>/g, '') ?? '';
          const link  = item.querySelector('link')?.textContent ?? '';
          const pubDate = item.querySelector('pubDate')?.textContent ?? '';
          const source = item.querySelector('source')?.textContent ?? '未知來源';
          if (title && link) {
            items.push({ title, link, pubDate: new Date(pubDate), source });
          }
        });
        if (items.length >= 12) break;
      } catch (e) {
        console.warn('[NEWS] fetch failed:', e.message);
      }
    }

    // Deduplicate by title
    const seen = new Set();
    const unique = items.filter(i => {
      if (seen.has(i.title)) return false;
      seen.add(i.title); return true;
    }).slice(0, 15);

    this.cache[key] = { items: unique, ts: now };
    return unique;
  },

  // ─── Fetch market-wide fear news ──────────────────────
  async fetchMarketNews() {
    const now = Date.now();
    if (this.marketCache && now - this.marketCache.ts < this.CACHE_TTL) {
      return this.marketCache.items;
    }
    const queries = ['台股 大盤', '股市 外資', '美股 道瓊'];
    const items = [];
    for (const q of queries) {
      try {
        const encoded = encodeURIComponent(q);
        const rssUrl = `https://news.google.com/rss/search?q=${encoded}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
        const proxyUrl = `${DATA.corsProxy}${encodeURIComponent(rssUrl)}`;
        const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(7000) });
        if (!res.ok) continue;
        const text = await res.text();
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'application/xml');
        xml.querySelectorAll('item').forEach(item => {
          const title   = item.querySelector('title')?.textContent?.replace(/<[^>]*>/g, '') ?? '';
          const pubDate = item.querySelector('pubDate')?.textContent ?? '';
          const source  = item.querySelector('source')?.textContent ?? '未知';
          const link    = item.querySelector('link')?.textContent ?? '';
          if (title) items.push({ title, pubDate: new Date(pubDate), source, link });
        });
      } catch (e) {}
    }
    const seen = new Set();
    const unique = items.filter(i => { if (seen.has(i.title)) return false; seen.add(i.title); return true; }).slice(0, 20);
    this.marketCache = { items: unique, ts: now };
    return unique;
  },

  // ─── Score sentiment for a news list ──────────────────
  scoreSentiment(items) {
    if (!items.length) return { score: 0, label: '無資料', counts: {} };
    let total = 0;
    const counts = { very_positive: 0, positive: 0, neutral: 0, negative: 0, very_negative: 0 };
    items.forEach(item => {
      const text = item.title;
      let s = 0;
      this.SENTIMENT.very_positive.forEach(kw => { if (text.includes(kw)) s += 2; });
      this.SENTIMENT.positive.forEach(kw     => { if (text.includes(kw)) s += 1; });
      this.SENTIMENT.negative.forEach(kw     => { if (text.includes(kw)) s -= 1; });
      this.SENTIMENT.very_negative.forEach(kw => { if (text.includes(kw)) s -= 2; });
      total += s;
      if (s >= 2) counts.very_positive++;
      else if (s > 0) counts.positive++;
      else if (s < -1) counts.very_negative++;
      else if (s < 0) counts.negative++;
      else counts.neutral++;
    });
    const avg = total / items.length;
    const label = avg > 1.5 ? '極度樂觀' : avg > 0.5 ? '偏多' : avg < -1.5 ? '極度悲觀' : avg < -0.5 ? '偏空' : '中性';
    return { score: +avg.toFixed(2), label, counts, total };
  },

  // ─── Market fear index ────────────────────────────────
  calcFearIndex(marketItems) {
    if (!marketItems.length) return { level: 50, label: '無資料', tier: 'neutral' };
    let fearScore = 0;
    let greedScore = 0;
    marketItems.forEach(item => {
      const text = item.title;
      this.FEAR_KEYWORDS.extreme_fear.forEach(kw => { if (text.includes(kw)) fearScore += 3; });
      this.FEAR_KEYWORDS.high_fear.forEach(kw    => { if (text.includes(kw)) fearScore += 2; });
      this.FEAR_KEYWORDS.moderate_fear.forEach(kw => { if (text.includes(kw)) fearScore += 1; });
      this.SENTIMENT.very_positive.forEach(kw => { if (text.includes(kw)) greedScore += 2; });
      this.SENTIMENT.positive.forEach(kw     => { if (text.includes(kw)) greedScore += 1; });
    });
    // Normalize to 0-100 (0=extreme fear, 100=extreme greed)
    const raw = greedScore - fearScore;
    const max = Math.max(marketItems.length * 2, 1);
    let level = Math.round(50 + (raw / max) * 50);
    level = Math.max(0, Math.min(100, level));
    const tier = level <= 20 ? 'extreme_fear' : level <= 40 ? 'fear' : level <= 60 ? 'neutral' : level <= 80 ? 'greed' : 'extreme_greed';
    const labels = { extreme_fear: '極度恐慌', fear: '恐慌', neutral: '中性', greed: '貪婪', extreme_greed: '極度貪婪' };
    return { level, label: labels[tier], tier };
  },

  // ─── Annotate each news with sentiment ───────────────
  annotateNews(items) {
    return items.map(item => {
      const text = item.title;
      let s = 0;
      this.SENTIMENT.very_positive.forEach(kw => { if (text.includes(kw)) s += 2; });
      this.SENTIMENT.positive.forEach(kw     => { if (text.includes(kw)) s += 1; });
      this.SENTIMENT.negative.forEach(kw     => { if (text.includes(kw)) s -= 1; });
      this.SENTIMENT.very_negative.forEach(kw => { if (text.includes(kw)) s -= 2; });
      return { ...item, sentiment: s };
    });
  },
};

// ─── SELL module — 賣出建議引擎 ───────────────────────────
const SELL = {
  // Main entry: combine tech + sentiment + market fear
  evaluate({ techInd, sentimentScore, fearIndex, stock, currentPrice }) {
    if (!techInd || !currentPrice) return null;

    const signals = [];
    let urgency = 'none';  // none | watch | sell | urgent | emergency

    // ── 1. Profit Taking (獲利了結) ──────────────────────
    if (stock) {
      const gainPct = (currentPrice - stock.cost) / stock.cost * 100;
      if (gainPct >= 20) {
        signals.push({ type: 'profit', label: `已獲利 +${gainPct.toFixed(1)}%`, desc: '達 20% 獲利目標，建議分批了結', urgency: 'sell' });
        urgency = this._escalate(urgency, 'sell');
      }
      if (gainPct >= 30) {
        signals.push({ type: 'profit_high', label: `獲利 +${gainPct.toFixed(1)}% 超高`, desc: '建議至少出清 50% 倉位，保留獲利', urgency: 'sell' });
        urgency = this._escalate(urgency, 'sell');
      }
      // Loss stop
      const lossPct = gainPct;
      if (lossPct <= -6) {
        signals.push({ type: 'stoploss', label: `虧損 ${lossPct.toFixed(1)}%`, desc: '已觸及停損線，建議執行停損', urgency: 'urgent' });
        urgency = this._escalate(urgency, 'urgent');
      }
    }

    // ── 2. Technical overbought exit ──────────────────────
    if (techInd.rsi > 80) {
      signals.push({ type: 'rsi_extreme', label: `RSI 超買 ${techInd.rsi}`, desc: 'RSI 超過 80 極端超買，短線回壓風險高', urgency: 'sell' });
      urgency = this._escalate(urgency, 'sell');
    } else if (techInd.rsi > 72) {
      signals.push({ type: 'rsi_overbought', label: `RSI ${techInd.rsi} 超買`, desc: 'RSI 進入超買區，建議輕倉', urgency: 'watch' });
      urgency = this._escalate(urgency, 'watch');
    }

    if (techInd.macdDead) {
      signals.push({ type: 'macd_dead', label: 'MACD 死亡交叉', desc: '動能轉弱，建議減碼', urgency: 'sell' });
      urgency = this._escalate(urgency, 'sell');
    }
    if (techInd.kdDead && techInd.K > 80) {
      signals.push({ type: 'kd_dead_high', label: `KD 高檔死亡交叉 K=${techInd.K}`, desc: '高檔 KD 死叉，回檔機率高', urgency: 'sell' });
      urgency = this._escalate(urgency, 'sell');
    }
    if (techInd.bbPos === 'overbought' && techInd.rsi > 65) {
      signals.push({ type: 'bb_overbought', label: '布林帶上軌超買', desc: '價格觸及布林上軌，動能衰竭風險', urgency: 'watch' });
      urgency = this._escalate(urgency, 'watch');
    }

    // ── 3. Breakdown signals ──────────────────────────────
    if (currentPrice < techInd.ma20 * 0.97 && !techInd.maBull) {
      signals.push({ type: 'ma_break', label: '跌破 MA20 且空頭排列', desc: '均線系統轉空，中線趨勢向下', urgency: 'sell' });
      urgency = this._escalate(urgency, 'sell');
    }
    if (currentPrice < techInd.support * 0.98) {
      signals.push({ type: 'support_break', label: '跌破近期支撐', desc: `跌破支撐 $${techInd.support}，下檔無明顯撐', urgency: 'urgent' });
      urgency = this._escalate(urgency, 'urgent');
    }

    // ── 4. Volume distribution signal ────────────────────
    if (techInd.volSurge && techInd.chg < 0) {
      signals.push({ type: 'vol_dist', label: '爆量下跌（主力出貨）', desc: '量增價跌為出貨訊號，當心主力倒貨', urgency: 'urgent' });
      urgency = this._escalate(urgency, 'urgent');
    }

    // ── 5. News sentiment negative ─────────────────────
    if (sentimentScore !== null) {
      if (sentimentScore <= -1.5) {
        signals.push({ type: 'news_bad', label: `新聞情緒極度悲觀 (${sentimentScore})`, desc: '近期負面新聞密集，市場看法轉空', urgency: 'sell' });
        urgency = this._escalate(urgency, 'sell');
      } else if (sentimentScore <= -0.8) {
        signals.push({ type: 'news_neg', label: `新聞情緒偏空 (${sentimentScore})`, desc: '負面報導增加，注意下行風險', urgency: 'watch' });
        urgency = this._escalate(urgency, 'watch');
      }
    }

    // ── 6. Market crash early warning (大崩盤前緊急離場) ───
    if (fearIndex !== null) {
      if (fearIndex.level <= 15) {
        signals.push({
          type: 'market_crash',
          label: '⚠ 市場極度恐慌 — 緊急離場警示',
          desc: `恐慌指數 ${fearIndex.level}/100（${fearIndex.label}）。新聞出現大量崩盤、熔斷、金融危機字眼，建議立即評估是否清倉轉現金或短債避險。`,
          urgency: 'emergency',
        });
        urgency = 'emergency';
      } else if (fearIndex.level <= 25) {
        signals.push({
          type: 'market_fear_high',
          label: '市場高度恐慌 — 考慮大幅減碼',
          desc: `恐慌指數 ${fearIndex.level}/100，市場情緒嚴重惡化，建議先出清高風險部位`,
          urgency: 'urgent',
        });
        urgency = this._escalate(urgency, 'urgent');
      } else if (fearIndex.level <= 35) {
        signals.push({
          type: 'market_fear_mod',
          label: `市場偏向恐慌 (${fearIndex.level}/100)`,
          desc: '大盤情緒偏空，注意系統性風險，提高現金比例',
          urgency: 'sell',
        });
        urgency = this._escalate(urgency, 'sell');
      }
    }

    // ── 7. Multiple signals convergence ──────────────────
    const sellSignalCount = signals.filter(s => ['sell','urgent','emergency'].includes(s.urgency)).length;
    if (sellSignalCount >= 4 && urgency !== 'emergency') {
      urgency = 'urgent';
      signals.push({
        type: 'convergence',
        label: `${sellSignalCount} 項賣出訊號同時觸發`,
        desc: '多空指標全面轉空，強烈建議執行出場計畫',
        urgency: 'urgent',
      });
    }

    // ── Build sell plan ───────────────────────────────────
    const plan = this._buildSellPlan(urgency, currentPrice, stock, techInd);

    return { signals, urgency, plan };
  },

  _escalate(current, next) {
    const order = ['none', 'watch', 'sell', 'urgent', 'emergency'];
    return order.indexOf(next) > order.indexOf(current) ? next : current;
  },

  _buildSellPlan(urgency, price, stock, techInd) {
    if (urgency === 'none') return null;
    const shares = stock?.shares ?? 1;
    const gainPct = stock ? ((price - stock.cost) / stock.cost * 100) : 0;

    if (urgency === 'emergency') {
      return {
        title: '⚠ 緊急離場計畫',
        color: 'emergency',
        rows: [
          { batch: '立即執行', action: '全部出清', desc: '市場系統性風險，清倉轉現金/短債' },
        ],
        note: `若持有 ${shares} 張，按市價立即賣出，勿等待更好價格`,
      };
    }
    if (urgency === 'urgent') {
      return {
        title: '緊急減碼計畫',
        color: 'urgent',
        rows: [
          { batch: '今日盤中', action: `先出 ${Math.ceil(shares * 0.5)} 張（50%）`, desc: `建議賣價 $${(price * 0.995).toFixed(1)} 附近` },
          { batch: '明日開盤', action: `再視情況出 ${Math.ceil(shares * 0.3)} 張`, desc: '若繼續下跌則全出' },
          { batch: '剩餘部位', action: `${Math.floor(shares * 0.2)} 張設停損`, desc: `停損線 $${techInd?.support?.toFixed(1) ?? (price * 0.94).toFixed(1)}` },
        ],
        note: `已獲利 ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%，優先保護獲利`,
      };
    }
    if (urgency === 'sell') {
      const firstBatch = gainPct >= 20 ? Math.ceil(shares * 0.4) : Math.ceil(shares * 0.25);
      return {
        title: '分批獲利了結計畫',
        color: 'sell',
        rows: [
          { batch: '第一批', action: `出 ${firstBatch} 張（${Math.round(firstBatch/shares*100)}%）`, desc: `目標 $${(price * 1.005).toFixed(1)}，鎖住部分獲利` },
          { batch: '第二批', action: `出 ${Math.ceil(shares * 0.3)} 張`, desc: `若跌破 MA20 $${techInd?.ma20?.toFixed(1) ?? '--'} 執行` },
          { batch: '剩餘部位', action: '持有觀察', desc: `停利設在 $${(price * 1.06).toFixed(1)}，停損 $${techInd?.support?.toFixed(1) ?? '--'}` },
        ],
        note: `建議先實現 ${gainPct >= 0 ? gainPct.toFixed(1) + '%' : '部分'} 獲利，剩餘讓利潤奔跑`,
      };
    }
    // watch
    return {
      title: '觀察減碼提示',
      color: 'watch',
      rows: [
        { batch: '密切觀察', action: '不動', desc: '設定警示價，若觸發立刻執行賣出' },
        { batch: '觸發條件', action: `跌破 $${(price * 0.97).toFixed(1)} 開始出`, desc: '勿讓獲利回吐超過 10%' },
      ],
      note: '目前尚未到強賣訊號，保持警戒',
    };
  },
};
