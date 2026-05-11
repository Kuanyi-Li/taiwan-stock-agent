// ── analysis.js  ── Technical analysis, AI signals, sell engine (v2)

const ANALYSIS = {
  lastData: [],
  lastSymbol: '',
  lastInd: null,
  // ★ 每支股票各自快取分析結果，解決多股票訊號衝突問題
  _cache: {},      // { code: { ind, candles } }

  run(candles, symbol) {
    if (!candles || candles.length < 15) {
      const el = document.getElementById('reasoning-text');
      if (el) el.textContent = '資料點不足，無法進行完整分析（至少需要 15 根 K 線）';
      return;
    }
    // Race condition guard：只有當前 activeSymbol 才更新 UI
    if (symbol && APP.activeSymbol && symbol !== APP.activeSymbol) return;

    this.lastData = candles;
    if (symbol) this.lastSymbol = symbol;

    const ind = this._calcIndicators(candles);
    this.lastInd = ind;
    // ★ 每股快取 ind + candles，切換股票時立刻用
    if (symbol) this._cache[symbol] = { ind, candles };
    this._updateIndicatorCards(ind);
    this._updateSignals(ind, candles);
    this._updatePatterns(ind, candles);
    this._updateSellEngine(ind);
    this._updateInfoGrid(ind);   // 問題4: 確保個股資訊 tab 更新
    CHART.drawMACD(candles);
    CHART.drawKD(candles);
    ORDER.calcPortfolio();
    // 分析完成後重新渲染持股清單和訊號總覽，確保訊號一致
    APP.renderStockList();
    APP._renderSignalOverview();
  },

  _calcIndicators(data) {
    const closes = data.map(d => d.c);
    const highs  = data.map(d => d.h);
    const lows   = data.map(d => d.l);
    const vols   = data.map(d => d.v);
    const n = closes.length;
    const last = data[n - 1];
    const prev = data[n - 2] ?? last;

    // ── RSI(14) ──
    const rsi = this._rsi(closes, 14);

    // ── MACD(12,26,9) ──
    const ema12 = this._ema(closes, 12);
    const ema26 = this._ema(closes, 26);
    const macdVal  = +(ema12[n-1] - ema26[n-1]).toFixed(3);
    const macdArr  = closes.slice(25).map((_, i) => ema12[i+25] - ema26[i+25]);
    const sigArr   = this._ema(macdArr, 9);
    const signal   = sigArr[sigArr.length - 1];
    const hist     = macdArr[macdArr.length - 1] - signal;
    const prevHist = macdArr.length > 2 ? macdArr[macdArr.length-2] - sigArr[sigArr.length-2] : 0;
    const macdGolden = hist > 0 && prevHist <= 0;
    const macdDead   = hist < 0 && prevHist >= 0;
    const macdLevel  = +macdVal.toFixed(2);

    // ── KD(9,3,3) ──
    const { K, D } = this._kd(data, 9);
    const prev_kd  = this._kd(data.slice(0, -1), 9);
    const kdGolden = K > D && prev_kd.K <= prev_kd.D;
    const kdDead   = K < D && prev_kd.K >= prev_kd.D;

    // ── 隨機RSI Fast(3,3,14,14) ──
    const rsiArr14 = this._rsiArr(closes, 14);
    const stochRsiK = this._stochRsi(rsiArr14, 14, 3);
    const stochRsiSig = this._ema(stochRsiK, 3);
    const srsiK = +stochRsiK[stochRsiK.length-1]?.toFixed(2) ?? 50;
    const srsiD = +stochRsiSig[stochRsiSig.length-1]?.toFixed(2) ?? 50;
    const srsiSignal = srsiK > 80 ? 'sell' : srsiK < 20 ? 'buy' : 'neutral';

    // ── 布林帶(20,2) ──
    const slice20 = closes.slice(-20);
    const bbMean  = slice20.reduce((a,b)=>a+b)/20;
    const bbStd   = Math.sqrt(slice20.reduce((a,b)=>a+(b-bbMean)**2,0)/20);
    const bbUp    = +(bbMean + 2*bbStd).toFixed(2);
    const bbDn    = +(bbMean - 2*bbStd).toFixed(2);
    const bbMid   = +bbMean.toFixed(2);
    const bbPos   = last.c > bbUp ? 'overbought' : last.c < bbDn ? 'oversold' : 'normal';

    // ── 移動平均線 SMA / EMA ──
    const sma   = p => n>=p ? +(closes.slice(-p).reduce((a,b)=>a+b)/p).toFixed(2) : null;
    const emaAt = p => n>=p ? +(this._ema(closes,p)[n-1]).toFixed(2) : null;
    const ma5   = sma(5);  const ma10  = sma(10);
    const ma20v = sma(20); const ma30  = sma(30);
    const ma50  = sma(50); const ma60v = sma(60);
    const ma100 = sma(100);const ma200 = sma(200);
    const ema10 = emaAt(10); const ema20 = emaAt(20);
    const ema30 = emaAt(30); const ema50 = emaAt(50);
    const ema100= emaAt(100);const ema200= emaAt(200);
    const maBull = ma5 && ma20v && ma5 > ma20v && (ma60v === null || ma20v > ma60v);

    // ── 赫爾移動平均線 Hull MA(9) ──
    const hullMA = this._hull(closes, 9);

    // ── VWMA(20) ──
    const vwma20 = this._vwma(data, 20);

    // ── 一目均衡表 Ichimoku(9,26,52) ──
    const ichimoku = this._ichimoku(data, 9, 26, 52);

    // ── CCI(20) ──
    const cci = this._cci(data, 20);
    const cciSignal = cci < -100 ? 'buy' : cci > 100 ? 'sell' : 'neutral';

    // ── ADX(14) ──
    const { adx, plusDI, minusDI } = this._adx(data, 14);
    const adxSignal = (plusDI > minusDI && adx > 20) ? 'buy' : (plusDI < minusDI && adx > 20) ? 'sell' : 'neutral';

    // ── 動量震盪 AO (Awesome Oscillator) ──
    const ao = this._ao(data);
    const aoPrev = this._ao(data.slice(0,-1));
    const aoSignal = (ao > 0 && ao > aoPrev) ? 'buy' : (ao < 0 && ao < aoPrev) ? 'sell' : 'neutral';

    // ── 動量(10) ──
    const momentum10 = n >= 11 ? +(last.c - closes[n-11]).toFixed(2) : 0;
    const momSignal  = momentum10 > 0 ? 'buy' : momentum10 < 0 ? 'sell' : 'neutral';

    // ── 威廉指標 %R(14) ──
    const willR = this._willR(data, 14);
    const willRSignal = willR < -80 ? 'buy' : willR > -20 ? 'sell' : 'neutral';

    // ── 牛熊力度（Bull Bear Power） ──
    const ema13 = this._ema(closes, 13);
    const bbPower = +(last.c - ema13[n-1]).toFixed(2);
    const bbpSignal = bbPower > 0 ? 'buy' : bbPower < 0 ? 'sell' : 'neutral';

    // ── 終極震盪指標 UO(7,14,28) ──
    const uo = this._uo(data, 7, 14, 28);
    const uoSignal = uo > 70 ? 'buy' : uo < 30 ? 'sell' : 'neutral';

    // ── OBV ──
    const obv = this._obv(data);
    const obvSig = obv > 0 ? 'buy' : 'sell';

    // ── ATR(14) ──
    const atr = this._atr(data, 14);

    // ── 量比 ──
    const avgVol  = data.slice(-10,-1).reduce((a,d)=>a+d.v,0)/9;
    const volRatio= +(last.v/(avgVol||1)).toFixed(2);
    const volSurge= volRatio > 1.5;

    const trend = last.c > ma20v ? 'up' : last.c < ma20v ? 'down' : 'flat';
    const chg    = +(last.c - prev.c).toFixed(2);
    const chgPct = +((chg/prev.c)*100).toFixed(2);

    const recent    = data.slice(-20);
    const support   = +Math.min(...recent.map(d=>d.l)).toFixed(2);
    const resistance= +Math.max(...recent.map(d=>d.h)).toFixed(2);

    return {
      // 震盪指標
      rsi, srsiK, srsiD, srsiSignal,
      cci, cciSignal,
      adx, plusDI, minusDI, adxSignal,
      ao: +ao.toFixed(2), aoSignal,
      momentum10, momSignal,
      macdVal, macdGolden, macdDead, hist, macdLevel,
      willR: +willR.toFixed(2), willRSignal,
      bbPower, bbpSignal,
      uo: +uo.toFixed(2), uoSignal,
      // KD
      K: +K.toFixed(2), D: +D.toFixed(2), kdGolden, kdDead,
      // 布林帶
      bbUp, bbDn, bbMid, bbPos,
      // 移動平均線
      ma5, ma10, ma20: ma20v, ma30, ma50, ma60: ma60v, ma100, ma200,
      ema10, ema20, ema30, ema50, ema100, ema200,
      hullMA: hullMA ? +hullMA.toFixed(2) : null,
      vwma20: vwma20 ? +vwma20.toFixed(2) : null,
      ichimoku,
      maBull,
      // 其他
      obv, obvSig, atr: +atr.toFixed(2),
      volRatio, volSurge, trend,
      last, chg, chgPct, support, resistance,
    };
  },

  _calcScore(ind) {
    let score = 0;

    // ── 震盪指標 ──
    // RSI(14)
    if (ind.rsi < 30) score += 2; else if (ind.rsi < 45) score += 1;
    else if (ind.rsi > 70) score -= 2; else if (ind.rsi > 60) score -= 1;
    // 隨機RSI Fast
    if (ind.srsiSignal === 'buy') score += 1;
    else if (ind.srsiSignal === 'sell') score -= 1;
    // CCI(20)
    if (ind.cciSignal === 'buy') score += 1;
    else if (ind.cciSignal === 'sell') score -= 1;
    // ADX(14)
    if (ind.adxSignal === 'buy') score += 1;
    else if (ind.adxSignal === 'sell') score -= 1;
    // AO
    if (ind.aoSignal === 'buy') score += 0.5;
    else if (ind.aoSignal === 'sell') score -= 0.5;
    // 動量(10)
    if (ind.momSignal === 'buy') score += 0.5;
    else if (ind.momSignal === 'sell') score -= 0.5;
    // MACD
    if (ind.macdGolden) score += 2; else if (ind.macdDead) score -= 2;
    else if (ind.hist > 0) score += 1; else score -= 1;
    // 威廉指標
    if (ind.willRSignal === 'buy') score += 1;
    else if (ind.willRSignal === 'sell') score -= 1;
    // 牛熊力度
    if (ind.bbpSignal === 'buy') score += 0.5;
    else if (ind.bbpSignal === 'sell') score -= 0.5;
    // 終極震盪
    if (ind.uoSignal === 'buy') score += 1;
    else if (ind.uoSignal === 'sell') score -= 1;
    // KD
    if (ind.kdGolden) score += 1.5; else if (ind.kdDead) score -= 1.5;
    // 布林帶
    if (ind.bbPos === 'oversold') score += 1;
    else if (ind.bbPos === 'overbought') score -= 1;

    // ── 移動平均線 ──
    const p = ind.last.c;
    // EMA/SMA 各自判斷（與現價比較）
    const maChecks = [
      ind.ema10, ind.ema20, ind.ema30, ind.ema50, ind.ema100, ind.ema200,
      ind.ma10,  ind.ma20,  ind.ma30,  ind.ma50,  ind.ma100,  ind.ma200,
      ind.hullMA, ind.vwma20,
    ];
    maChecks.forEach(ma => {
      if (ma == null) return;
      if (p > ma) score += 0.15;
      else score -= 0.15;
    });
    // 一目均衡表（Ichimoku）
    if (ind.ichimoku) {
      const ich = ind.ichimoku;
      if (p > ich.conversionLine && p > ich.baseLine) score += 0.5;
      else if (p < ich.conversionLine && p < ich.baseLine) score -= 0.5;
    }
    // 均線排列（MA5>MA20 多頭）
    if (ind.maBull) score += 0.5; else score -= 0.5;

    // ── 量價 ──
    if (ind.volSurge && ind.chg > 0) score += 0.5;
    else if (ind.volSurge && ind.chg < 0) score -= 0.5;

    return Math.max(-5, Math.min(5, score));
  },

  _updateIndicatorCards(ind) {
    const p = ind.last.c;
    const fmt = v => v != null ? v.toLocaleString('zh-TW', {maximumFractionDigits:2}) : '—';

    // 顯示分析週期說明
    const symbol = this.lastSymbol || (typeof APP !== 'undefined' ? APP.activeSymbol : '');
    const mode = (typeof APP !== 'undefined' && symbol) ? APP.getStockMode(symbol) : 'long';
    const periodLabel = mode === 'short' ? '短線模式（1月日線）' : '長線模式（1年日線）';
    const labelEl = document.getElementById('analysis-period-label');
    if (labelEl) labelEl.textContent = `📊 分析基於：${periodLabel}`;

    // ── 震盪指標清單 ──
    const oscillators = [
      { name:'相對強弱指標 RSI(14)',     value: fmt(ind.rsi),        signal: ind.rsi<30?'buy':ind.rsi>70?'sell':'neutral' },
      { name:'隨機%K(14,3,3)',           value: fmt(ind.K),          signal: ind.kdGolden?'buy':ind.kdDead?'sell':'neutral' },
      { name:'CCI(20)',                  value: fmt(ind.cci),        signal: ind.cciSignal },
      { name:'平均趨向指標 ADX(14)',      value: fmt(ind.adx),        signal: ind.adxSignal },
      { name:'動量震盪指標 AO',           value: fmt(ind.ao),         signal: ind.aoSignal },
      { name:'動量(10)',                  value: fmt(ind.momentum10), signal: ind.momSignal },
      { name:'MACD Level(12,26)',        value: fmt(ind.macdLevel),  signal: ind.macdGolden?'buy':ind.macdDead?'sell':ind.hist>0?'buy':'sell' },
      { name:'隨機RSI Fast(3,3,14,14)',  value: fmt(ind.srsiK),      signal: ind.srsiSignal },
      { name:'威廉指標(14)',              value: fmt(ind.willR),      signal: ind.willRSignal },
      { name:'牛熊力度指標',              value: fmt(ind.bbPower),    signal: ind.bbpSignal },
      { name:'終極震盪指標(7,14,28)',     value: fmt(ind.uo),         signal: ind.uoSignal },
    ];

    // ── 移動平均線清單 ──
    const maList = [
      { name:'指數移動平均線(10)',  value: fmt(ind.ema10),  ma: ind.ema10 },
      { name:'簡單移動平均線(10)',  value: fmt(ind.ma10),   ma: ind.ma10 },
      { name:'指數移動平均線(20)',  value: fmt(ind.ema20),  ma: ind.ema20 },
      { name:'簡單移動平均線(20)',  value: fmt(ind.ma20),   ma: ind.ma20 },
      { name:'指數移動平均線(30)',  value: fmt(ind.ema30),  ma: ind.ema30 },
      { name:'簡單移動平均線(30)',  value: fmt(ind.ma30),   ma: ind.ma30 },
      { name:'指數移動平均線(50)',  value: fmt(ind.ema50),  ma: ind.ema50 },
      { name:'簡單移動平均線(50)',  value: fmt(ind.ma50),   ma: ind.ma50 },
      { name:'指數移動平均線(100)', value: fmt(ind.ema100), ma: ind.ema100 },
      { name:'簡單移動平均線(100)', value: fmt(ind.ma100),  ma: ind.ma100 },
      { name:'指數移動平均線(200)', value: fmt(ind.ema200), ma: ind.ema200 },
      { name:'簡單移動平均線(200)', value: fmt(ind.ma200),  ma: ind.ma200 },
      { name:'一目均衡表基準線(9,26,52)', value: ind.ichimoku ? fmt(ind.ichimoku.baseLine) : '—', ma: ind.ichimoku?.baseLine },
      { name:'成交量加權移動均線(20)',     value: fmt(ind.vwma20), ma: ind.vwma20 },
      { name:'赫爾移動平均線(9)',          value: fmt(ind.hullMA), ma: ind.hullMA },
    ].map(m => ({ ...m, signal: m.ma != null ? (p > m.ma ? 'buy' : 'sell') : 'neutral' }));

    // ── 計算買/中/賣數量 ──
    const count = arr => arr.reduce((a, x) => {
      a[x.signal] = (a[x.signal]||0)+1; return a;
    }, { buy:0, neutral:0, sell:0 });

    const oscCount  = count(oscillators);
    const maCount   = count(maList);
    const allCount  = {
      buy:     (oscCount.buy||0)     + (maCount.buy||0),
      neutral: (oscCount.neutral||0) + (maCount.neutral||0),
      sell:    (oscCount.sell||0)    + (maCount.sell||0),
    };

    const summarySignal = sig => {
      const net = sig.buy - sig.sell;
      if (net >= 3)  return { label:'強力買入', cls:'strong-buy' };
      if (net >= 1)  return { label:'買入',     cls:'buy' };
      if (net <= -3) return { label:'強力賣出', cls:'strong-sell' };
      if (net <= -1) return { label:'賣出',     cls:'sell' };
      return { label:'中立', cls:'neutral' };
    };

    const oscSum  = summarySignal(oscCount);
    const maSum   = summarySignal(maCount);
    const allSum  = summarySignal(allCount);

    const sigLabel = { buy:'買入', sell:'賣出', neutral:'中立' };
    const sigCls   = { buy:'ind-buy', sell:'ind-sell', neutral:'ind-neu' };

    const renderRow = (name, value, signal) => `
      <div class="ind-table-row">
        <span class="ind-table-name">${name}</span>
        <span class="ind-table-value">${value}</span>
        <span class="ind-table-sig ${sigCls[signal]}">${sigLabel[signal]}</span>
      </div>`;

    const dialColor = cls => ({
      'strong-buy':'#1D9E75','buy':'#5DCAA5',
      'neutral':'#888',
      'sell':'#D4537E','strong-sell':'#E24B4A'
    })[cls] || '#888';

    const renderDial = (title, sum, cnt) => {
      const total = (cnt.buy||0)+(cnt.neutral||0)+(cnt.sell||0);
      const color = dialColor(sum.cls);

      // net score: buy - sell，範圍 -total ~ +total
      // needlePct: 0=全賣(左), 0.5=中立(頂), 1=全買(右)
      const net = (cnt.buy||0) - (cnt.sell||0);
      const needlePct = total > 0 ? (net / total + 1) / 2 : 0.5;

      // 弧和指針都用 needlePct，確保對齊
      const r = 45, cx = 60, cy = 60;
      const halfCirc = Math.PI * r; // ~141.4
      const dash = needlePct * halfCirc;

      // 指針終點
      const angleRad = Math.PI * (1 - needlePct);
      const nx = +(cx + r * Math.cos(angleRad)).toFixed(1);
      const ny = +(cy - r * Math.sin(angleRad)).toFixed(1);

      return `
        <div class="dial-wrap">
          <div class="dial-title">${title}</div>
          <svg viewBox="0 0 120 68" width="150" height="85">
            <path d="M 15,60 A 45,45 0 0,1 105,60"
              fill="none" stroke="var(--bg-3)" stroke-width="8" stroke-linecap="round"/>
            <path d="M 15,60 A 45,45 0 0,1 105,60"
              fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
              stroke-dasharray="${dash.toFixed(1)} ${halfCirc.toFixed(1)}"
              stroke-dashoffset="0"/>
            <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}"
              stroke="var(--text-1)" stroke-width="2.5" stroke-linecap="round"/>
            <circle cx="${cx}" cy="${cy}" r="4" fill="var(--text-1)"/>
          </svg>
          <div class="dial-label" style="color:${color}">${sum.label}</div>
          <div class="dial-counts">
            <span class="dn-color">賣${cnt.sell||0}</span>
            <span style="color:var(--text-3)">中${cnt.neutral||0}</span>
            <span class="up-color">買${cnt.buy||0}</span>
          </div>
        </div>`;
    };

    const row = document.getElementById('ind-row');
    if (!row) return;

    row.innerHTML = `
      <!-- 儀錶板 -->
      <div class="ind-dials">
        ${renderDial('震盪指標', oscSum, oscCount)}
        ${renderDial('匯總', allSum, allCount)}
        ${renderDial('移動平均線', maSum, maCount)}
      </div>

      <!-- 指標明細兩欄 -->
      <div class="ind-tables">
        <div class="ind-table-col">
          <div class="ind-table-header">
            <span>震盪指標</span>
            <span>數值</span>
            <span>動作</span>
          </div>
          ${oscillators.map(o => renderRow(o.name, o.value, o.signal)).join('')}
        </div>
        <div class="ind-table-col">
          <div class="ind-table-header">
            <span>移動平均線</span>
            <span>數值</span>
            <span>動作</span>
          </div>
          ${maList.map(m => renderRow(m.name, m.value, m.signal)).join('')}
        </div>
      </div>`;
  },

  _updateSignals(ind, data) {
    const score = this._calcScore(ind);
    const vixAdj = (typeof VIX !== 'undefined' ? VIX.score : 0) || 0;
    const adjScore = score + vixAdj * 0.5;
    const pct = Math.round(((adjScore + 5) / 10) * 100);

    // 取得長短線模式
    const symbol = this.lastSymbol || (typeof APP !== 'undefined' ? APP.activeSymbol : '');
    const mode = (typeof APP !== 'undefined' && symbol) ? APP.getStockMode(symbol) : 'long';
    const isLong = mode === 'long';

    // ★ 問題11: 用 SIGNAL.fromScore 確保左右側一致
    const stock = APP.getActiveStock();
    const gainPct = stock ? (ind.last.c - stock.cost) / stock.cost * 100 : 0;
    const supportBreak = ind.last.c < (ind.support || 0) * 0.98;
    const sigLevel = SIGNAL.fromScore(adjScore, gainPct, supportBreak, mode);

    // action 直接用 SIGNAL level 的 label，確保左右一致
    let action, confidence, confClass;
    if (isLong) {
      action     = sigLevel.label;
      confidence = adjScore >= 3 ? '強力做多' : adjScore >= 1 ? '長線偏多' : adjScore <= -3 ? '留意風險' : '長線持有';
      confClass  = adjScore >= 2 ? 'high' : adjScore <= -3 ? 'low' : 'mid';
    } else {
      action     = sigLevel.label;
      confidence = adjScore >= 3 ? '強烈買進' : adjScore >= 1.5 ? '偏多' : adjScore <= -3 ? '強烈賣出' : adjScore <= -1.5 ? '偏空' : '中性觀望';
      confClass  = adjScore >= 2 ? 'high' : adjScore <= -2 ? 'low' : 'mid';
    }

    // 建構詳細原因清單
    const bullReasons = [], bearReasons = [];
    if (ind.rsi < 30) bullReasons.push(`RSI ${ind.rsi} 超賣`);
    else if (ind.rsi < 45) bullReasons.push(`RSI ${ind.rsi} 偏低`);
    else if (ind.rsi > 70) bearReasons.push(`RSI ${ind.rsi} 超買`);
    else if (ind.rsi > 60) bearReasons.push(`RSI ${ind.rsi} 偏高`);
    if (ind.macdGolden) bullReasons.push('MACD 黃金交叉');
    else if (ind.macdDead) bearReasons.push('MACD 死亡交叉');
    else if (ind.hist > 0) bullReasons.push('MACD 柱狀正值');
    else bearReasons.push('MACD 柱狀負值');
    if (ind.kdGolden) bullReasons.push('KD 黃金交叉');
    else if (ind.kdDead) bearReasons.push('KD 死亡交叉');
    if (ind.bbPos === 'oversold') bullReasons.push('布林下軌支撐');
    else if (ind.bbPos === 'overbought') bearReasons.push('布林上軌壓力');
    if (ind.maBull) bullReasons.push(`均線多頭（MA5 ${ind.ma5} > MA20 ${ind.ma20}）`);
    else bearReasons.push(`均線空頭（MA5 ${ind.ma5} < MA20 ${ind.ma20}）`);
    if (ind.volSurge && ind.chg > 0) bullReasons.push(`放量上漲（量比 ${ind.volRatio}x）`);
    else if (ind.volSurge && ind.chg < 0) bearReasons.push(`放量下跌（量比 ${ind.volRatio}x）`);
    if (typeof VIX !== 'undefined' && VIX.label) {
      if (vixAdj > 0) bullReasons.push(`市場恐慌（VIX ${VIX.level}%）逆向機會`);
      else if (vixAdj < 0) bearReasons.push(`市場過熱（VIX ${VIX.level}%）注意回調`);
    }
    // 持股損益
    if (stock) {
      const gainPct = (ind.last.c - stock.cost) / stock.cost * 100;
      if (isLong) {
        // 長線：除非跌很深，否則不提賣出
        if (gainPct >= 80) bullReasons.push(`長線已獲利 +${gainPct.toFixed(1)}%，可考慮部分了結`);
        else if (gainPct > 0) bullReasons.push(`持有獲利 +${gainPct.toFixed(1)}%，繼續持有`);
        else if (gainPct <= -15) bearReasons.push(`虧損 ${gainPct.toFixed(1)}%，評估基本面是否改變`);
        else if (gainPct < 0) bearReasons.push(`目前小幅虧損 ${gainPct.toFixed(1)}%，長線持有`);
      } else {
        if (gainPct >= 20) bearReasons.push(`已獲利 +${gainPct.toFixed(1)}%，建議部分了結`);
        else if (gainPct <= -6) bearReasons.push(`虧損 ${gainPct.toFixed(1)}%，接近停損`);
        else if (gainPct > 0) bullReasons.push(`持有獲利 +${gainPct.toFixed(1)}%`);
      }
    }

    const reasonHtml = `
      <div class="sig-reasons">
        ${bullReasons.length ? `<div class="sig-reason-group bull">${bullReasons.map(r=>`<span class="sr-tag bull">↑ ${r}</span>`).join('')}</div>` : ''}
        ${bearReasons.length ? `<div class="sig-reason-group bear">${bearReasons.map(r=>`<span class="sr-tag bear">↓ ${r}</span>`).join('')}</div>` : ''}
      </div>`;

    const curPrice = ind.last.c;

    // ★ 問題6: 長線進場/停損/目標價範圍更寬
    let suggestEntry, tp, sl;
    if (isLong) {
      suggestEntry = +(curPrice * 0.97).toFixed(1);   // 長線可以等回檔3%再買
      tp = +(curPrice * 1.30).toFixed(1);              // 長線目標+30%
      sl = +(curPrice * 0.85).toFixed(1);              // 長線停損-15%
    } else {
      const entryPct = adjScore >= 2 ? 0.99 : adjScore >= 1 ? 0.975 : 0.97;
      suggestEntry = +(curPrice * entryPct).toFixed(1);
      tp = +(curPrice * (adjScore >= 2 ? 1.12 : 1.08)).toFixed(1);
      sl = +(curPrice * 0.94).toFixed(1);
    }

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const setHTML = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML = val; };

    const actionColors = {
      '買進加碼': 'var(--green-l)',
      '買進':     'var(--green-l)',
      '觀察買':   'var(--green-l)',
      '賣出':     'var(--red)',
      '觀察賣':   'var(--red-l)',
      '考慮減碼': 'var(--amber)',
      '持有':     'var(--amber)',
    };
    const actionEl = document.getElementById('sig-action');
    if (actionEl) {
      actionEl.textContent = action;
      actionEl.style.color = actionColors[action] || 'var(--amber)';
    }
    setHTML('sig-action-desc', reasonHtml);
    set('sig-entry', `$${suggestEntry}`);
    if (isLong) {
      set('sig-entry-desc', `長線可分批佈局，支撐 ${ind.support}`);
      set('sig-tp', `$${tp}`);
      set('sig-tp-desc', `長線目標+30%，壓力 ${ind.resistance}`);
      set('sig-sl', `$${sl}`);
      set('sig-sl-desc', '長線停損 -15%（基本面未改變則無需停損）');
    } else {
      set('sig-entry-desc', `支撐${ind.support}，進場區間 ${(curPrice*0.96).toFixed(1)}~${(curPrice*1.002).toFixed(1)}`);
      set('sig-tp', `$${tp}`);
      set('sig-tp-desc', `目標+${((tp/curPrice-1)*100).toFixed(0)}%，壓力${ind.resistance}`);
      set('sig-sl', `$${sl}`);
      set('sig-sl-desc', '嚴格停損 -6%');
    }

    const chip = document.getElementById('conf-chip');
    if (chip) {
      const modeLabel = isLong ? '長線' : '短線';
      chip.textContent = `${confidence} ${pct}% ｜${modeLabel}`;
      chip.className = `confidence-chip ${confClass}`;
    }
    const bar = document.getElementById('meter-bar');
    if (bar) {
      const barColor = adjScore >= 3 ? '#E24B4A' : adjScore >= 1 ? '#1D9E75' : adjScore <= -3 ? '#378ADD' : adjScore <= -1 ? '#D4537E' : '#EF9F27';
      const barPct = Math.max(5, Math.min(100, pct));
      bar.style.cssText = `width:${barPct}%;background:${barColor};height:100%;border-radius:99px;transition:width 0.6s ease;opacity:1;min-width:8px;`;
    }
    const mv = document.getElementById('meter-value');
    if (mv) mv.textContent = `${pct}% / 100`;

    this._updateInfoGrid(ind);
    ORDER.suggestEntry = suggestEntry;
    ORDER.suggestSL = sl;
    ORDER.suggestTP = tp;
    ORDER.score = adjScore;
  },

  _updateSellEngine(ind) {
    const stock = APP.getActiveStock();
    const currentPrice = ind.last.c;
    const result = SELL.evaluate({ techInd: ind, stock, currentPrice });
    if (result) {
      // 整併到下單建議 tab 的賣出區塊
      renderSellSignals(result);
      // 同時更新下單建議中的整合賣出提示
      const mergedEl = document.getElementById('sig-sell-hint');
      if (mergedEl) {
        if (result.urgency === 'none') {
          mergedEl.style.display = 'none';
        } else {
          const urgLabels = { watch:'◎ 觀察減碼', sell:'▼ 建議出場', urgent:'⚠ 緊急減碼', emergency:'🔴 緊急離場' };
          const urgColors = { watch:'var(--blue)', sell:'var(--amber)', urgent:'var(--red)', emergency:'var(--red)' };
          const topSignal = result.signals[0];
          mergedEl.style.display = 'block';
          mergedEl.innerHTML = `<span style="color:${urgColors[result.urgency]};font-weight:600">${urgLabels[result.urgency]}</span>${topSignal ? `：${topSignal.label} — ${topSignal.desc}` : ''}`;
        }
      }
    }
  },

  _updatePatterns(ind, data) {
    const patterns = [];
    const n = data.length;
    const last = data[n-1];
    const bodySize = Math.abs(last.c - last.o);
    const lowerWick = Math.min(last.o, last.c) - last.l;
    if (lowerWick > bodySize * 2 && last.c > last.o) patterns.push({ label:'錘形反轉', strength:'strong' });
    if (ind.rsi < 40 && ind.bbPos === 'oversold') patterns.push({ label:'雙底型態', strength:'strong' });
    if (ind.macdGolden) patterns.push({ label:'MACD黃金交叉', strength:'strong' });
    if (ind.kdGolden) patterns.push({ label:'KD黃金交叉', strength:'match' });
    if (ind.volSurge && last.c > last.o) patterns.push({ label:'量增價漲', strength:'match' });
    if (ind.maBull) patterns.push({ label:'均線多頭排列', strength:'match' });
    if (ind.bbPos === 'oversold') patterns.push({ label:'布林帶下軌支撐', strength:'match' });
    if (ind.last.c > ind.support * 1.02 && ind.last.c < ind.support * 1.05) patterns.push({ label:'近期支撐反彈', strength:'match' });
    ['波動收斂','籌碼集中','底部放量'].forEach(p => patterns.push({ label:p, strength:'neutral' }));

    const tagsEl = document.getElementById('pattern-tags');
    if (tagsEl) tagsEl.innerHTML = patterns.map(p => `<span class="ptag ${p.strength}">${p.label}</span>`).join('');

    const strongP = patterns.filter(p=>p.strength==='strong').map(p=>p.label);
    const matchP  = patterns.filter(p=>p.strength==='match').map(p=>p.label);
    let reason = '';
    if (strongP.length) reason += `偵測到強訊號：${strongP.join('、')}；`;
    if (matchP.length)  reason += `輔助訊號：${matchP.join('、')}；`;
    reason += `RSI(14) ${ind.rsi.toFixed(1)}，MACD柱狀${ind.hist>=0?'正值（多頭動能）':'負值（空頭動能）'}，`;
    reason += `KD ${ind.K>ind.D?'K在D上方偏多':'K在D下方偏空'}。`;
    reason += `均線${ind.maBull?'多頭排列，趨勢向上':'空頭排列，注意風險'}。`;
    if (ind.volSurge) reason += `成交量為均量${ind.volRatio.toFixed(1)}倍，屬放量行為。`;
    reason += `進場參考支撐$${ind.support}，壓力$${ind.resistance}。`;
    const rt = document.getElementById('reasoning-text');
    if (rt) rt.textContent = reason;
  },

  _updateInfoGrid(ind) {
    const grid = document.getElementById('info-grid');
    if (!grid || !ind) return;
    // 問題4: 清除"選擇股票後顯示"的預設文字，直接填入資料
    const items = [
      { label:'當前價格', value:ind.last.c.toFixed(2) },
      { label:'今日漲跌', value:(ind.chg>=0?'+':'')+ind.chg+' ('+(ind.chgPct>=0?'+':'')+ind.chgPct+'%)' },
      { label:'今日最高', value:ind.last.h.toFixed(2) },
      { label:'今日最低', value:ind.last.l.toFixed(2) },
      { label:'MA5', value:ind.ma5.toFixed(2) },
      { label:'MA20', value:ind.ma20.toFixed(2) },
      { label:'MA60', value:ind.ma60?ind.ma60.toFixed(2):'—' },
      { label:'RSI(14)', value:ind.rsi.toFixed(1) },
      { label:'KD K值', value:ind.K },
      { label:'KD D值', value:ind.D },
      { label:'布林上軌', value:ind.bbUp },
      { label:'布林下軌', value:ind.bbDn },
      { label:'近20日支撐', value:ind.support },
      { label:'近20日壓力', value:ind.resistance },
      { label:'量比', value:ind.volRatio+'x' },
    ];
    grid.innerHTML = items.map(it => `<div class="info-item"><div class="info-label">${it.label}</div><div class="info-value">${it.value}</div></div>`).join('');
  },

  // ── Math helpers ──
  _ema(arr, period) {
    const k = 2 / (period + 1);
    const res = new Array(arr.length).fill(0);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += arr[i];
    res[period - 1] = sum / period;
    for (let i = period; i < arr.length; i++) res[i] = arr[i] * k + res[i-1] * (1-k);
    return res;
  },

  _rsi(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const d = closes[i] - closes[i-1];
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
};

// ── SELL module ──────────────────────────────────────────
const SELL = {
  evaluate({ techInd, stock, currentPrice }) {
    if (!techInd || !currentPrice) return null;
    const signals = [];
    let urgency = 'none';

    // ★ 問題6: 取得長短線模式
    const isLong = (typeof APP !== 'undefined' && stock)
      ? APP.getStockMode(stock.code) === 'long'
      : true;

    if (stock) {
      const gainPct = (currentPrice - stock.cost) / stock.cost * 100;
      if (isLong) {
        // ★ 長線：基本抱到老，獲利門檻極高才建議了結
        if (gainPct >= 100) {
          signals.push({ label:`長線獲利+${gainPct.toFixed(1)}%`, desc:'已翻倍，可考慮分批了結部分（非強制）', urgency:'watch' });
          urgency = this._esc(urgency, 'watch');
        }
        // 長線停損：-15%
        if (gainPct <= -15) {
          signals.push({ label:`虧損${gainPct.toFixed(1)}%已達長線停損`, desc:'評估基本面是否改變，若無變化可繼續持有', urgency:'sell' });
          urgency = this._esc(urgency, 'sell');
        }
      } else {
        // 短線：20%/30% 了結，-6% 停損
        if (gainPct >= 30) {
          signals.push({ label:`獲利+${gainPct.toFixed(1)}%超高`, desc:'建議至少出清50%倉位，保留獲利', urgency:'sell' });
          urgency = this._esc(urgency, 'sell');
        } else if (gainPct >= 20) {
          signals.push({ label:`已獲利+${gainPct.toFixed(1)}%`, desc:'達20%目標，建議分批了結', urgency:'sell' });
          urgency = this._esc(urgency, 'sell');
        }
        if (gainPct <= -6) {
          signals.push({ label:`虧損${gainPct.toFixed(1)}%`, desc:'已觸及停損線，建議執行停損', urgency:'urgent' });
          urgency = this._esc(urgency, 'urgent');
        }
      }
    }

    // ★ 問題6: 技術指標部分，長線門檻更高
    if (isLong) {
      // 長線：只有極端超買+多個訊號同時才提示
      if (techInd.rsi > 85) { signals.push({ label:`RSI極端超買${techInd.rsi}`, desc:'長線可考慮少量減碼', urgency:'watch' }); urgency = this._esc(urgency,'watch'); }
      if (techInd.macdDead && techInd.rsi > 65) { signals.push({ label:'MACD死叉+高RSI', desc:'短期動能轉弱，長線持有不動', urgency:'watch' }); urgency = this._esc(urgency,'watch'); }
      if (currentPrice < techInd.support * 0.93) { signals.push({ label:'大幅跌破支撐7%', desc:`長線警示，支撐$${techInd.support}，評估基本面`, urgency:'sell' }); urgency = this._esc(urgency,'sell'); }
    } else {
      // 短線：原本的技術指標邏輯
      if (techInd.rsi > 80) { signals.push({ label:`RSI超買${techInd.rsi}`, desc:'極端超買，回壓風險高', urgency:'sell' }); urgency = this._esc(urgency,'sell'); }
      else if (techInd.rsi > 72) { signals.push({ label:`RSI${techInd.rsi}超買區`, desc:'RSI進入超買，建議輕倉', urgency:'watch' }); urgency = this._esc(urgency,'watch'); }
      if (techInd.macdDead) { signals.push({ label:'MACD死亡交叉', desc:'動能轉弱，建議減碼', urgency:'sell' }); urgency = this._esc(urgency,'sell'); }
      if (techInd.kdDead && techInd.K > 80) { signals.push({ label:`KD高檔死叉K=${techInd.K}`, desc:'高檔死叉，回檔機率高', urgency:'sell' }); urgency = this._esc(urgency,'sell'); }
      if (currentPrice < techInd.ma20 * 0.97 && !techInd.maBull) { signals.push({ label:'跌破MA20且空頭排列', desc:'中線趨勢向下', urgency:'sell' }); urgency = this._esc(urgency,'sell'); }
      if (currentPrice < techInd.support * 0.98) { signals.push({ label:'跌破近期支撐', desc:`跌破支撐$${techInd.support}`, urgency:'urgent' }); urgency = this._esc(urgency,'urgent'); }
      if (techInd.volSurge && techInd.chg < 0) { signals.push({ label:'爆量下跌（主力出貨）', desc:'量增價跌為出貨訊號', urgency:'urgent' }); urgency = this._esc(urgency,'urgent'); }
    }

    const plan = this._buildPlan(urgency, currentPrice, stock, techInd, isLong);
    return { signals, urgency, plan };
  },

  _esc(cur, next) {
    const o = ['none','watch','sell','urgent','emergency'];
    return o.indexOf(next) > o.indexOf(cur) ? next : cur;
  },

  _buildPlan(urgency, price, stock, ind, isLong = false) {
    if (urgency === 'none') return null;
    const shares = stock?.shares ?? 1;
    const gainPct = stock ? ((price - stock.cost) / stock.cost * 100) : 0;
    const isUS = (typeof APP !== 'undefined') ? APP.activeMarket === 'US' : false;
    const sd = n => (isUS || n < 1000) ? `${Math.ceil(n)}股` : `${(n/1000).toFixed(n%1000===0?0:1)}張`;

    // ★ 問題6: 長線模式建議更保守，傾向持有
    if (isLong) {
      if (urgency === 'watch') return {
        title:'長線觀察提示', color:'watch',
        rows:[{ batch:'目前操作', action:'繼續持有', desc:'長線定義：基本面未改變就不賣' }],
        note:'短期技術面波動不影響長線邏輯',
      };
      if (urgency === 'sell') return {
        title:'長線減碼評估', color:'sell',
        rows:[
          { batch:'第一步', action:'確認基本面', desc:'是否有重大負面消息或業績惡化？' },
          { batch:'若有問題', action:`考慮出${sd(shares*0.3)}（30%）`, desc:'先降低部位，觀察後續' },
          { batch:'若無問題', action:'繼續持有', desc:`停損線設 $${(price*0.85).toFixed(1)}（-15%）` },
        ],
        note:'長線投資人：短期回檔是機會，非威脅',
      };
      if (urgency === 'urgent') return {
        title:'長線停損警示', color:'urgent',
        rows:[
          { batch:'評估基本面', action:'先確認是否有重大變化', desc:'若基本面不變，可以繼續持有' },
          { batch:'若基本面惡化', action:`出${sd(shares*0.5)}（50%）`, desc:'先降低風險' },
          { batch:'剩餘', action:`${sd(shares*0.5)}繼續觀察`, desc:`跌破 $${ind?.support?.toFixed(1)??'—'} 再考慮全出` },
        ],
        note:'長線停損設 -15%，短期虧損不代表長期虧損',
      };
    }

    // 短線邏輯（原本）
    if (urgency === 'urgent') return {
      title:'緊急減碼計畫', color:'urgent',
      rows:[
        { batch:'今日盤中', action:`先出${sd(shares*0.5)}（50%）`, desc:`建議賣價$${(price*0.995).toFixed(1)}附近` },
        { batch:'明日開盤', action:`再視情況出${sd(shares*0.3)}`, desc:'若繼續下跌則全出' },
        { batch:'剩餘部位', action:`${sd(shares*0.2)}設停損`, desc:`停損線$${ind?.support?.toFixed(1)??'—'}` },
      ],
      note:`已獲利${gainPct>=0?'+':''}${gainPct.toFixed(1)}%，優先保護獲利`,
    };
    if (urgency === 'sell') {
      const firstPct = gainPct >= 20 ? 0.4 : 0.25;
      return {
        title:'分批獲利了結計畫', color:'sell',
        rows:[
          { batch:'第一批', action:`出${sd(shares*firstPct)}（${Math.round(firstPct*100)}%）`, desc:'鎖住部分獲利' },
          { batch:'第二批', action:`出${sd(shares*0.3)}`, desc:`跌破MA20$${ind?.ma20?.toFixed(1)??'—'}執行` },
          { batch:'剩餘部位', action:'持有觀察', desc:`停損$${ind?.support?.toFixed(1)??'—'}` },
        ],
        note:`建議先實現${gainPct>=0?gainPct.toFixed(1)+'%':'部分'}獲利`,
      };
    }
    return {
      title:'觀察減碼提示', color:'watch',
      rows:[{ batch:'密切觀察', action:'不動', desc:`跌破$${(price*0.97).toFixed(1)}開始出` }],
      note:'目前尚未到強賣訊號，保持警戒',
    };
  },
};

// ── ANALYSIS Math Helpers ────────────────────────────────
Object.assign(ANALYSIS, {
  _rsi(closes, period = 14) {
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[closes.length - period - 1 + i] - closes[closes.length - period - 2 + i];
      if (d >= 0) gains += d; else losses -= d;
    }
    const avgG = gains / period, avgL = losses / period;
    return avgL === 0 ? 100 : +Math.max(0, Math.min(100, 100 - 100 / (1 + avgG / avgL))).toFixed(2);
  },

  _rsiArr(closes, period) {
    const arr = [];
    for (let i = period + 1; i <= closes.length; i++) {
      arr.push(this._rsi(closes.slice(0, i), period));
    }
    return arr;
  },

  _stochRsi(rsiArr, period, smooth) {
    const result = [];
    for (let i = period - 1; i < rsiArr.length; i++) {
      const slice = rsiArr.slice(i - period + 1, i + 1);
      const lo = Math.min(...slice), hi = Math.max(...slice);
      result.push(hi === lo ? 50 : ((rsiArr[i] - lo) / (hi - lo)) * 100);
    }
    return result;
  },

  _ema(arr, period) {
    const k = 2 / (period + 1);
    const out = [arr[0]];
    for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i-1] * (1-k));
    return out;
  },

  _kd(data, period = 9) {
    let K = 50, D = 50;
    for (let i = Math.max(0, data.length - period * 3); i < data.length; i++) {
      const slice = data.slice(Math.max(0, i - period + 1), i + 1);
      const hi = Math.max(...slice.map(d => d.h));
      const lo = Math.min(...slice.map(d => d.l));
      const rsv = hi === lo ? 50 : (data[i].c - lo) / (hi - lo) * 100;
      K = 2/3 * K + 1/3 * rsv;
      D = 2/3 * D + 1/3 * K;
    }
    return { K, D };
  },

  _cci(data, period) {
    const n = data.length;
    if (n < period) return 0;
    const slice = data.slice(-period);
    const tp = slice.map(d => (d.h + d.l + d.c) / 3);
    const mean = tp.reduce((a, b) => a + b) / period;
    const md = tp.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    return md === 0 ? 0 : +((tp[tp.length-1] - mean) / (0.015 * md)).toFixed(2);
  },

  _adx(data, period) {
    const n = data.length;
    if (n < period + 1) return { adx: 0, plusDI: 0, minusDI: 0 };
    const trs = [], pdms = [], mdms = [];
    for (let i = 1; i < n; i++) {
      const h = data[i].h, l = data[i].l, pc = data[i-1].c;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
      pdms.push(Math.max(data[i].h - data[i-1].h, 0));
      mdms.push(Math.max(data[i-1].l - data[i].l, 0));
    }
    const smooth = arr => {
      let s = arr.slice(0, period).reduce((a, b) => a + b);
      const out = [s];
      for (let i = period; i < arr.length; i++) { s = s - s/period + arr[i]; out.push(s); }
      return out;
    };
    const atr14 = smooth(trs), pdm14 = smooth(pdms), mdm14 = smooth(mdms);
    const last = atr14.length - 1;
    const plusDI  = atr14[last] === 0 ? 0 : +(pdm14[last] / atr14[last] * 100).toFixed(2);
    const minusDI = atr14[last] === 0 ? 0 : +(mdm14[last] / atr14[last] * 100).toFixed(2);
    const dx = plusDI + minusDI === 0 ? 0 : Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    return { adx: +dx.toFixed(2), plusDI, minusDI };
  },

  _ao(data) {
    const n = data.length;
    if (n < 34) return 0;
    const mid = data.map(d => (d.h + d.l) / 2);
    const sma5  = mid.slice(-5).reduce((a,b)=>a+b)/5;
    const sma34 = mid.slice(-34).reduce((a,b)=>a+b)/34;
    return +(sma5 - sma34).toFixed(4);
  },

  _willR(data, period) {
    const n = data.length;
    if (n < period) return -50;
    const slice = data.slice(-period);
    const hi = Math.max(...slice.map(d => d.h));
    const lo = Math.min(...slice.map(d => d.l));
    return hi === lo ? -50 : +((hi - data[n-1].c) / (hi - lo) * -100).toFixed(2);
  },

  _uo(data, p1, p2, p3) {
    const n = data.length;
    if (n < p3 + 1) return 50;
    const bp = [], tr = [];
    for (let i = 1; i < n; i++) {
      const pc = data[i-1].c;
      bp.push(data[i].c - Math.min(data[i].l, pc));
      tr.push(Math.max(data[i].h, pc) - Math.min(data[i].l, pc));
    }
    const avg = p => {
      const bpS = bp.slice(-p).reduce((a,b)=>a+b,0);
      const trS = tr.slice(-p).reduce((a,b)=>a+b,0);
      return trS === 0 ? 0 : bpS / trS;
    };
    return +((4*avg(p1) + 2*avg(p2) + avg(p3)) / 7 * 100).toFixed(2);
  },

  _obv(data) {
    let obv = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i].c > data[i-1].c) obv += data[i].v;
      else if (data[i].c < data[i-1].c) obv -= data[i].v;
    }
    return obv;
  },

  _atr(data, period) {
    const n = data.length;
    if (n < 2) return 0;
    const trs = [];
    for (let i = 1; i < n; i++) {
      const pc = data[i-1].c;
      trs.push(Math.max(data[i].h - data[i].l, Math.abs(data[i].h - pc), Math.abs(data[i].l - pc)));
    }
    return trs.slice(-period).reduce((a,b)=>a+b,0) / Math.min(period, trs.length);
  },

  _hull(closes, period) {
    const n = closes.length;
    if (n < period) return null;
    const wma = (arr, p) => {
      const slice = arr.slice(-p);
      let num = 0, den = 0;
      slice.forEach((v, i) => { num += v*(i+1); den += i+1; });
      return num / den;
    };
    const half = Math.floor(period/2);
    return 2 * wma(closes, half) - wma(closes, period);
  },

  _vwma(data, period) {
    const slice = data.slice(-period);
    if (slice.length < period) return null;
    const num = slice.reduce((a, d) => a + d.c * d.v, 0);
    const den = slice.reduce((a, d) => a + d.v, 0);
    return den === 0 ? null : num / den;
  },

  _ichimoku(data, conv, base) {
    const n = data.length;
    if (n < base) return null;
    const midpoint = (p) => {
      const slice = data.slice(-p);
      return (Math.max(...slice.map(d=>d.h)) + Math.min(...slice.map(d=>d.l))) / 2;
    };
    return {
      conversionLine: +midpoint(conv).toFixed(2),
      baseLine:       +midpoint(base).toFixed(2),
    };
  },
});
