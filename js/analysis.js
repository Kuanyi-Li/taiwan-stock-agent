// ── analysis.js  ── Technical analysis & AI signal engine

const ANALYSIS = {
  lastData: [],
  lastSymbol: '',

  // ── Entry point ───────────────────────────────────────
  run(candles, symbol) {
    if (!candles || candles.length < 15) {
      document.getElementById('reasoning-text').textContent = '資料點不足，無法進行完整分析（至少需要 15 根 K 線）';
      return;
    }
    this.lastData = candles;
    if (symbol) this.lastSymbol = symbol;

    const ind = this._calcIndicators(candles);
    this._updateIndicatorCards(ind);
    this._updateSignals(ind, candles);
    this._updatePatterns(ind, candles);
    CHART.drawMACD(candles);
    CHART.drawKD(candles);
    ORDER.calc();
  },

  // ── Calculate all indicators ──────────────────────────
  _calcIndicators(data) {
    const closes = data.map(d => d.c);
    const n = closes.length;
    const last = data[n - 1];
    const prev = data[n - 2] ?? last;

    // RSI(14)
    const rsi = this._rsi(closes, 14);

    // MACD
    const ema12 = this._ema(closes, 12);
    const ema26 = this._ema(closes, 26);
    const macdVal = +(ema12[n-1] - ema26[n-1]).toFixed(3);
    const macdArr = closes.slice(25).map((_, i) => ema12[i+25] - ema26[i+25]);
    const sigArr  = this._ema(macdArr, 9);
    const signal  = sigArr[sigArr.length - 1];
    const hist    = macdArr[macdArr.length - 1] - signal;
    const prevHist = macdArr.length > 10 ? macdArr[macdArr.length-2] - sigArr[sigArr.length-2] : 0;
    const macdGolden = hist > 0 && prevHist <= 0;
    const macdDead   = hist < 0 && prevHist >= 0;

    // KD(9,3,3)
    const { K, D } = this._kd(data, 9);
    const kdGolden = K > D && this._kd_prev(data, 9).K <= this._kd_prev(data, 9).D;
    const kdDead   = K < D && this._kd_prev(data, 9).K >= this._kd_prev(data, 9).D;

    // Bollinger Bands(20,2)
    const slice20 = closes.slice(-20);
    const mean = slice20.reduce((a, b) => a + b) / 20;
    const std  = Math.sqrt(slice20.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
    const bbUp  = +(mean + 2 * std).toFixed(2);
    const bbDn  = +(mean - 2 * std).toFixed(2);
    const bbMid = +mean.toFixed(2);
    const bbPos = last.c > bbUp ? 'overbought' : last.c < bbDn ? 'oversold' : 'normal';

    // MA positions
    const ma5  = closes.slice(-5).reduce((a,b)=>a+b)/5;
    const ma20 = closes.slice(-20).reduce((a,b)=>a+b)/20;
    const ma60 = n >= 60 ? closes.slice(-60).reduce((a,b)=>a+b)/60 : null;
    const maBull = ma5 > ma20 && (ma60 === null || ma20 > ma60);

    // Volume surge
    const avgVol = data.slice(-10, -1).reduce((a, d) => a + d.v, 0) / 9;
    const volRatio = last.v / (avgVol || 1);
    const volSurge = volRatio > 1.5;

    // Trend
    const trend = last.c > ma20 ? 'up' : last.c < ma20 ? 'down' : 'flat';

    // Price change
    const chg = +(last.c - prev.c).toFixed(2);
    const chgPct = +((chg / prev.c) * 100).toFixed(2);

    // Support / Resistance
    const recent = data.slice(-20);
    const support = +Math.min(...recent.map(d => d.l)).toFixed(2);
    const resistance = +Math.max(...recent.map(d => d.h)).toFixed(2);

    return {
      rsi, macdVal, macdGolden, macdDead, hist,
      K: +K.toFixed(2), D: +D.toFixed(2), kdGolden, kdDead,
      bbUp, bbDn, bbMid, bbPos, maBull, ma5: +ma5.toFixed(2), ma20: +ma20.toFixed(2), ma60: ma60 ? +ma60.toFixed(2) : null,
      volRatio: +volRatio.toFixed(2), volSurge, trend,
      last, chg, chgPct, support, resistance,
    };
  },

  // ── Update indicator cards ────────────────────────────
  _updateIndicatorCards(ind) {
    const row = document.getElementById('ind-row');
    if (!row) return;

    const items = [
      {
        name: 'RSI(14)',
        value: ind.rsi.toFixed(1),
        signal: ind.rsi > 70 ? { label: '超買', cls: 'bull' } : ind.rsi < 30 ? { label: '超賣', cls: 'bear' } : { label: '中性', cls: 'neu' },
        color: ind.rsi > 70 ? 'var(--red)' : ind.rsi < 30 ? 'var(--green-l)' : 'var(--text-1)',
      },
      {
        name: 'MACD',
        value: (ind.hist >= 0 ? '+' : '') + ind.hist.toFixed(3),
        signal: ind.macdGolden ? { label: '黃金交叉', cls: 'bull' } : ind.macdDead ? { label: '死亡交叉', cls: 'bear' } : { label: '觀察中', cls: 'neu' },
        color: ind.hist >= 0 ? 'var(--red)' : 'var(--green-l)',
      },
      {
        name: 'KD(9)',
        value: `K${ind.K} D${ind.D}`,
        signal: ind.kdGolden ? { label: 'K 穿 D↑', cls: 'bull' } : ind.kdDead ? { label: 'K 穿 D↓', cls: 'bear' } : { label: `K${ind.K>ind.D?'>':'<'}D`, cls: 'neu' },
        color: ind.K > ind.D ? 'var(--red)' : 'var(--green-l)',
      },
      {
        name: '布林帶(20)',
        value: ind.bbPos === 'overbought' ? '超買區' : ind.bbPos === 'oversold' ? '超賣區' : '帶內',
        signal: ind.bbPos === 'oversold' ? { label: '近下軌', cls: 'bear' } : ind.bbPos === 'overbought' ? { label: '近上軌', cls: 'bull' } : { label: `中軌${ind.bbMid}`, cls: 'neu' },
        color: ind.bbPos === 'overbought' ? 'var(--red)' : ind.bbPos === 'oversold' ? 'var(--green-l)' : 'var(--text-1)',
      },
      {
        name: '均線排列',
        value: ind.maBull ? '多頭' : '空頭',
        signal: ind.maBull ? { label: `5>${ind.ma5}`, cls: 'bull' } : { label: `5<${ind.ma5}`, cls: 'bear' },
        color: ind.maBull ? 'var(--red)' : 'var(--green-l)',
      },
      {
        name: '量比',
        value: ind.volRatio.toFixed(2) + 'x',
        signal: ind.volSurge ? { label: '放量', cls: 'bull' } : { label: '縮量', cls: 'neu' },
        color: ind.volSurge ? 'var(--amber)' : 'var(--text-1)',
      },
    ];

    row.innerHTML = items.map(it => `
      <div class="ind-card">
        <div class="ind-name">${it.name}</div>
        <div class="ind-value" style="color:${it.color}">${it.value}</div>
        <span class="ind-signal ${it.signal.cls}">${it.signal.label}</span>
      </div>`).join('');
  },

  // ── Compute buy/sell/hold score & update signals ──────
  _updateSignals(ind, data) {
    let score = 0; // -5 (strong sell) to +5 (strong buy)

    if (ind.rsi < 30) score += 2;
    else if (ind.rsi < 45) score += 1;
    else if (ind.rsi > 70) score -= 2;
    else if (ind.rsi > 60) score -= 1;

    if (ind.macdGolden) score += 2;
    else if (ind.macdDead) score -= 2;
    else if (ind.hist > 0) score += 1;
    else score -= 1;

    if (ind.kdGolden) score += 1.5;
    else if (ind.kdDead) score -= 1.5;

    if (ind.bbPos === 'oversold') score += 1;
    else if (ind.bbPos === 'overbought') score -= 1;

    if (ind.maBull) score += 1;
    else score -= 1;

    if (ind.volSurge && ind.chg > 0) score += 0.5;

    // Clamp
    score = Math.max(-5, Math.min(5, score));
    const pct = Math.round(((score + 5) / 10) * 100);
    const confidence = score >= 3 ? '強烈買進' : score >= 1.5 ? '偏多' : score <= -3 ? '強烈賣出' : score <= -1.5 ? '偏空' : '中性觀望';
    const confClass  = score >= 2 ? 'high' : score <= -2 ? 'low' : 'mid';

    // Action
    const action = score >= 2 ? '買進' : score >= 1 ? '觀察買' : score <= -2 ? '賣出' : score <= -1 ? '觀察賣' : '持有';
    const actionDesc = score >= 2 ? '多項技術指標同步看多' : score >= 1 ? '偏多但未確認，建議小量試單' : score <= -2 ? '多項指標轉空，注意風險' : score <= -1 ? '偏空，考慮減碼' : '技術面中性，等待方向確認';

    // Entry price suggestion: 1-3% below current or at support
    const curPrice = ind.last.c;
    const entryPct = score >= 2 ? 0.99 : score >= 1 ? 0.975 : 0.97;
    const suggestEntry = +(curPrice * entryPct).toFixed(1);
    const entryDesc = `支撐 ${ind.support}，進場區間 ${(curPrice * 0.96).toFixed(1)}~${(curPrice * 1.002).toFixed(1)}`;

    // TP / SL
    const tpMulti = score >= 2 ? 1.12 : 1.08;
    const slMulti = 0.94;
    const tp = +(curPrice * tpMulti).toFixed(1);
    const sl = +(curPrice * slMulti).toFixed(1);
    const tpDesc = `目標 +${((tpMulti-1)*100).toFixed(0)}%，壓力 ${ind.resistance}`;
    const slDesc = `嚴格停損 -6%`;

    // Update DOM
    document.getElementById('sig-action').textContent = action;
    document.getElementById('sig-action-desc').textContent = actionDesc;
    document.getElementById('sig-entry').textContent = `$${suggestEntry}`;
    document.getElementById('sig-entry-desc').textContent = entryDesc;
    document.getElementById('sig-tp').textContent = `$${tp}`;
    document.getElementById('sig-tp-desc').textContent = tpDesc;
    document.getElementById('sig-sl').textContent = `$${sl}`;
    document.getElementById('sig-sl-desc').textContent = slDesc;

    const chip = document.getElementById('conf-chip');
    chip.textContent = `${confidence} ${pct}%`;
    chip.className = `confidence-chip ${confClass}`;

    document.getElementById('meter-bar').style.width = pct + '%';
    document.getElementById('meter-bar').style.background =
      score >= 2 ? 'var(--red)' : score <= -2 ? 'var(--green-l)' : 'var(--amber)';
    document.getElementById('meter-value').textContent = `${pct}% / 100`;

    // Update info grid
    this._updateInfoGrid(ind);

    // Store for ORDER calc
    ORDER.suggestEntry = suggestEntry;
    ORDER.suggestSL = sl;
    ORDER.suggestTP = tp;
    ORDER.score = score;
  },

  // ── Pattern matching ──────────────────────────────────
  _updatePatterns(ind, data) {
    const patterns = [];
    const n = data.length;

    // Double bottom check
    if (ind.rsi < 40 && ind.bbPos === 'oversold') patterns.push({ label: '雙底型態', strength: 'strong' });
    // Hammer candlestick
    const last = data[n-1];
    const bodySize = Math.abs(last.c - last.o);
    const lowerWick = Math.min(last.o, last.c) - last.l;
    if (lowerWick > bodySize * 2 && last.c > last.o) patterns.push({ label: '錘形反轉', strength: 'strong' });
    // Golden cross
    if (ind.macdGolden) patterns.push({ label: 'MACD 黃金交叉', strength: 'strong' });
    if (ind.kdGolden) patterns.push({ label: 'KD 黃金交叉', strength: 'match' });
    // Volume surge with up close
    if (ind.volSurge && last.c > last.o) patterns.push({ label: '量增價漲', strength: 'match' });
    // MA bullish alignment
    if (ind.maBull) patterns.push({ label: '均線多頭排列', strength: 'match' });
    // BB oversold
    if (ind.bbPos === 'oversold') patterns.push({ label: '布林帶下軌支撐', strength: 'match' });
    // Rising from support
    if (ind.last.c > ind.support * 1.02 && ind.last.c < ind.support * 1.05) {
      patterns.push({ label: '近期支撐反彈', strength: 'match' });
    }
    // Neutral patterns
    const neutrals = ['波動收斂', '籌碼集中', '底部放量', '月線支撐', '季線扣抵'];
    neutrals.slice(0, 3 - patterns.filter(p => p.strength !== 'neutral').length).forEach(p => {
      patterns.push({ label: p, strength: 'neutral' });
    });

    const tagsEl = document.getElementById('pattern-tags');
    tagsEl.innerHTML = patterns.map(p =>
      `<span class="ptag ${p.strength}">${p.label}</span>`
    ).join('');

    // AI Reasoning
    const strongPatterns = patterns.filter(p => p.strength === 'strong').map(p => p.label);
    const matchPatterns  = patterns.filter(p => p.strength === 'match').map(p => p.label);
    let reason = '';
    if (strongPatterns.length) reason += `偵測到強訊號：${strongPatterns.join('、')}；`;
    if (matchPatterns.length)  reason += `輔助訊號：${matchPatterns.join('、')}；`;
    reason += `RSI(14) 目前 ${ind.rsi.toFixed(1)}，`;
    reason += `MACD 柱狀 ${ind.hist >= 0 ? '正值（多頭動能）' : '負值（空頭動能）'}，`;
    reason += `KD ${ind.K > ind.D ? 'K 在 D 上方，偏多' : 'K 在 D 下方，偏空'}。`;
    reason += `均線${ind.maBull ? '多頭排列，趨勢向上' : '空頭排列，注意風險'}。`;
    if (ind.volSurge) reason += `今日成交量為均量 ${ind.volRatio.toFixed(1)} 倍，屬放量行為。`;
    reason += `建議進場參考支撐 $${ind.support}，壓力 $${ind.resistance}。`;

    document.getElementById('reasoning-text').textContent = reason;
  },

  // ── Info grid ─────────────────────────────────────────
  _updateInfoGrid(ind) {
    const grid = document.getElementById('info-grid');
    if (!grid) return;
    const items = [
      { label: '當前價格', value: ind.last.c.toFixed(2) },
      { label: '今日漲跌', value: (ind.chg >= 0 ? '+' : '') + ind.chg + ' (' + (ind.chgPct >= 0 ? '+' : '') + ind.chgPct + '%)' },
      { label: '今日最高', value: ind.last.h.toFixed(2) },
      { label: '今日最低', value: ind.last.l.toFixed(2) },
      { label: 'MA5', value: ind.ma5.toFixed(2) },
      { label: 'MA20', value: ind.ma20.toFixed(2) },
      { label: 'MA60', value: ind.ma60 ? ind.ma60.toFixed(2) : '—' },
      { label: 'RSI(14)', value: ind.rsi.toFixed(1) },
      { label: 'KD K值', value: ind.K },
      { label: 'KD D值', value: ind.D },
      { label: '布林上軌', value: ind.bbUp },
      { label: '布林下軌', value: ind.bbDn },
      { label: '近20日支撐', value: ind.support },
      { label: '近20日壓力', value: ind.resistance },
      { label: '量比（今/均）', value: ind.volRatio + 'x' },
    ];
    grid.innerHTML = items.map(it => `
      <div class="info-item">
        <div class="info-label">${it.label}</div>
        <div class="info-value">${it.value}</div>
      </div>`).join('');
  },

  // ── Math helpers ──────────────────────────────────────
  _ema(arr, period) {
    const k = 2 / (period + 1);
    const res = new Array(arr.length).fill(0);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += arr[i];
    res[period - 1] = sum / period;
    for (let i = period; i < arr.length; i++) {
      res[i] = arr[i] * k + res[i-1] * (1 - k);
    }
    return res;
  },

  _rsi(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return +((100 - 100 / (1 + rs)).toFixed(1));
  },

  _kd(data, period = 9) {
    const n = data.length;
    if (n < period) return { K: 50, D: 50 };
    let K = 50, D = 50;
    for (let i = period - 1; i < n; i++) {
      const slice = data.slice(i - period + 1, i + 1);
      const high = Math.max(...slice.map(x => x.h));
      const low  = Math.min(...slice.map(x => x.l));
      const rsv = high === low ? 50 : (data[i].c - low) / (high - low) * 100;
      K = 2/3 * K + 1/3 * rsv;
      D = 2/3 * D + 1/3 * K;
    }
    return { K, D };
  },

  _kd_prev(data, period = 9) {
    return this._kd(data.slice(0, -1), period);
  },
};
