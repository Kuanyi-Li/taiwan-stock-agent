// ── chart.js  ── Canvas K-line renderer v3
// 新增：滑鼠滾輪縮放、拖曳平移

const CHART = {
  currentData: [],
  currentPeriod: '1d',
  currentType: 'candle',
  showPredict: true,
  predictDays: 15,
  // Zoom/pan state
  zoomStart: 0,    // 顯示起始 index（0 = 最舊）
  zoomEnd: 0,      // 顯示結束 index
  isDragging: false,
  dragStartX: 0,
  dragStartZoom: { start: 0, end: 0 },

  init() {
    const tabs = document.getElementById('period-tabs');
    if (tabs) {
      tabs.addEventListener('click', e => {
        const btn = e.target.closest('.period-btn');
        if (!btn) return;
        tabs.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentPeriod = btn.dataset.period;
        if (APP.activeSymbol) this.load(APP.activeSymbol, this.currentPeriod);
      });
    }
    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentType = btn.dataset.type;
        if (this.currentData.length) this.draw();
      });
    });
    // Zoom reset button
    const resetBtn = document.getElementById('zoom-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => { this._resetZoom(); this.draw(); });
  },

  // 分析週期設定（專業角度）
  // 長線：6月日線（~125根），足以計算 MA60、長期趨勢、支撐壓力
  // 短線：1月日線（~22根），著重近期 RSI、MACD 動能、KD 超買超賣
  ANALYSIS_PERIODS: {
    long:  '2y',
    short: '3mo',
  },

  async load(symbol, period) {
    this.currentPeriod = period;
    this._loadToken = symbol; // ★ 記錄本次載入請求的股票，防止競速覆蓋
    const loadEl = document.getElementById('chart-loading');
    if (loadEl) loadEl.style.display = 'flex';
    const data = await DATA.fetchHistory(symbol, period);
    if (loadEl) loadEl.style.display = 'none';

    // ★ 若載入期間使用者已切換到別支股票，這份較慢回來的資料不套用
    if (this._loadToken !== symbol || APP.activeSymbol !== symbol) return;

    this.currentData = data;

    // ★ 用即時報價更新最後一根K線的 close/high/low，讓K線和報價一致
    this._patchLastCandle(symbol);

    this._resetZoom();
    this.draw();

    // ★ 技術分析完全不跟 K 線顯示週期走
    // 只有在「此股票還沒有快取」時才自動拉資料分析
    // 長線/短線切換由 runAnalysisForSymbol() 處理
    if (!ANALYSIS._cache[symbol]) {
      this._runAnalysis(symbol);
    }
  },

  // 用即時報價更新顯示K線的最後一根
  _patchLastCandle(symbol) {
    const lenBefore = this.currentData.length;
    this._patchCandleData(this.currentData, symbol);
    const grew = this.currentData.length - lenBefore;
    if (grew > 0) {
      // ★ 修正：補上「今天」這根會讓陣列變長，如果縮放範圍（zoomEnd）沒有跟著調整，
      // 新增的這根會落在可視範圍外，造成K線圖視覺上斷層、不連續。
      // 只有當原本的可視範圍已經包含「最後一根」時才跟著往後延伸，
      // 如果使用者手動往回拉看歷史資料，不要打斷他正在看的位置。
      const wasShowingLatest = this.zoomEnd >= lenBefore - 1;
      this.zoomEnd += grew;
      if (wasShowingLatest) {
        // 維持原本可視根數，一起往後移動，讓新的一根出現在最右邊
        this.zoomStart += grew;
      }
    }
  },

  // 用指定模式的資料分析（外部呼叫）
  async runAnalysisForSymbol(symbol, mode) {
    const period = this.ANALYSIS_PERIODS[mode] || this.ANALYSIS_PERIODS.long;
    const loadEl = document.getElementById('chart-loading');
    if (loadEl) loadEl.style.display = 'flex';
    const data = await DATA.fetchHistory(symbol, period);
    if (loadEl) loadEl.style.display = 'none';
    if (data.length >= 15 && APP.activeSymbol === symbol) {
      ANALYSIS.run(data, symbol);
    }
  },

  // 內部自動分析（預設長線）
  _runAnalysis(symbol) {
    const mode = APP.getStockMode(symbol);
    const period = this.ANALYSIS_PERIODS[mode] || this.ANALYSIS_PERIODS.long;
    DATA.fetchHistory(symbol, period).then(data => {
      if (data.length < 15) {
        if (APP.activeSymbol === symbol) {
          const sigAction = document.getElementById('sig-action');
          if (sigAction) { sigAction.textContent = '資料不足'; sigAction.style.color = 'var(--text-3)'; }
        }
        return;
      }
      // ★ 用即時報價修正最後一根K線，避免Yahoo快照偏差影響指標計算
      this._patchCandleData(data, symbol);

      if (APP.activeSymbol === symbol) {
        ANALYSIS.run(data, symbol);
      } else {
        try {
          const ind = ANALYSIS._calcIndicators(data);
          ANALYSIS._cache[symbol] = { ind, candles: data };
        } catch(e) { /* silent */ }
      }
    }).catch(() => {
      if (APP.activeSymbol !== symbol) return;
      const sigAction = document.getElementById('sig-action');
      if (sigAction) { sigAction.textContent = '分析失敗，請重試'; sigAction.style.color = 'var(--red)'; }
    });
  },

  // 用即時報價修正資料陣列的最後一根K線（實際邏輯統一在 DATA._patchToday，這裡只是轉呼叫）
  _patchCandleData(data, symbol) {
    DATA._patchToday(data, symbol);
  },

  _resetZoom() {
    const n = this.currentData.length;
    // ★ 1日週期抓了較長歷史（供MA20/MA60計算），預設顯示最近約60個交易日（近3個月）
    // 更早的資料仍在 currentData 中，可拖曳/縮放查看，MA也會用得到完整歷史
    if (this.currentPeriod === '1d' && n > 60) {
      this.zoomStart = n - 60;
      this.zoomEnd = n - 1;
    } else {
      this.zoomStart = 0;
      this.zoomEnd = n - 1;
    }
  },

  _visibleData() {
    const n = this.currentData.length;
    if (!n) return [];
    const s = Math.max(0, Math.min(n-2, this.zoomStart));
    const e = Math.max(s+1, Math.min(n-1, this.zoomEnd));
    return this.currentData.slice(s, e + 1);
  },

  // ── 共用：趨勢預測核心引擎（近中期回歸+ADX/RSI/位階修正）──
  // 供主圖與總覽小圖表共用，確保兩邊邏輯完全一致
  // opts: { nearLookback, midLookback, hlLookback, zScore }
  _predictEngine(data, days, symbol, opts = {}) {
    const nearLB = opts.nearLookback ?? 10;
    const midLB  = opts.midLookback  ?? 40;
    const hlLB   = opts.hlLookback   ?? 40;
    const z      = opts.zScore ?? 1.3;
    if (data.length < 15) return null;

    const regress = lookback => {
      const nn = Math.min(lookback, data.length);
      const slice = data.slice(-nn);
      const closes = slice.map(d => d.c);
      const vols = slice.map(d => Math.max(1, d.v || 1));
      let sw = 0, swx = 0, swy = 0;
      for (let i = 0; i < nn; i++) { sw += vols[i]; swx += vols[i]*i; swy += vols[i]*closes[i]; }
      const xBar = swx/sw, yBar = swy/sw;
      let num = 0, den = 0;
      for (let i = 0; i < nn; i++) { num += vols[i]*(i-xBar)*(closes[i]-yBar); den += vols[i]*(i-xBar)**2; }
      const slope = den ? num/den : 0;
      const intercept = yBar - slope*xBar;
      const resid = closes.map((c,i) => c - (intercept + slope*i));
      const variance = resid.reduce((a,b) => a + b*b, 0) / Math.max(1, nn-2);
      return { slope, xBar, den, variance, n: nn };
    };

    const near = regress(nearLB);
    const mid  = regress(midLB);
    if (!near || !mid || mid.n < 15) return null;

    let slope = near.slope * 0.6 + mid.slope * 0.4;

    // ★ 優先用直接傳入的指標（避免依賴全域快取的時機差導致總覽/詳細頁不一致）
    // 若沒有傳入，才 fallback 查詢快取
    const ind = opts.ind !== undefined
      ? opts.ind
      : ANALYSIS._cache[symbol || (typeof APP !== 'undefined' ? APP.activeSymbol : '')]?.ind;
    const adx = ind?.adx;
    if (adx != null) {
      if (adx < 20) slope *= 0.35;
      else if (adx < 25) slope *= 0.7;
    }

    const rsi = ind?.rsi;
    if (rsi != null) {
      if (rsi > 75) slope *= 0.5;
      else if (rsi > 70) slope *= 0.75;
      else if (rsi < 25) slope *= 0.5;
      else if (rsi < 30) slope *= 0.75;
    }

    const hlWindow = data.slice(-hlLB);
    const hi = Math.max(...hlWindow.map(d => d.h));
    const lo = Math.min(...hlWindow.map(d => d.l));
    const rangeHL = hi - lo || 1;
    const lastClose = data[data.length-1].c;
    const posInRange = (lastClose - lo) / rangeHL;
    if (slope > 0 && posInRange > 0.85) slope *= 0.5;
    else if (slope < 0 && posInRange < 0.15) slope *= 0.5;

    // ★ 費城半導體指數(SOX)連動修正：SOX與台灣半導體權值股高度正相關，
    // 若SOX近期動能明顯，對台股半導體個股的斜率做小幅同向修正（權重15%，避免喧賓奪主）
    const semiSet = this.SEMI_TICKERS || (this.SEMI_TICKERS = new Set(['2330','2454','3711','2303','3034','2408','5347','8299','3443','2449','6415']));
    if (symbol && semiSet.has(symbol)) {
      const soxData = DATA.histCache?.['^SOX_1d']?.data;
      if (soxData && soxData.length >= 12) {
        DATA._patchToday(soxData, '^SOX'); // 確保費半資料也跟即時報價同步，不然連動修正會用到舊資料
        const soxRecent = soxData.slice(-10);
        const soxChgPct = (soxRecent[soxRecent.length-1].c - soxRecent[0].c) / soxRecent[0].c * 100;
        // SOX 10日變動% 轉換成類似量級的斜率修正，加權15%混入
        const soxSlopeEquiv = (soxChgPct / 100 * lastClose) / 10;
        slope = slope * 0.85 + soxSlopeEquiv * 0.15;
      }
    }

    // ★ 依過去預測準確度自動調整：方向常猜錯就收斂斜率，區間常沒包到就加寬信賴帶
    const adj = (typeof PredictTrack !== 'undefined') ? PredictTrack.getAdjustment(symbol) : { slopeMul: 1, zMul: 1 };
    slope *= adj.slopeMul;
    const zAdj = z * adj.zMul;

    const s = Math.sqrt(near.variance * 0.6 + mid.variance * 0.4);
    const { n, xBar, den } = mid;
    const lastIdx = n - 1;

    const points = [];
    for (let d = 1; d <= days; d++) {
      const priceMid = lastClose + slope * d;
      const x0 = lastIdx + d;
      const se = s * Math.sqrt(1 + 1/n + ((x0-xBar)**2)/(den||1));
      const band = se * zAdj;
      points.push({ day: d, mid: priceMid, upper: priceMid+band, lower: priceMid-band });
    }

    // 偏多/偏空程度分級：用預測終點相對現價的變化幅度%判斷
    const pctChange = (slope * days) / lastClose * 100;
    const trend = this._classifyTrend(pctChange);

    // ★ 記錄本次預測，供日後回測評估準確度（節流：同股票每天只記一次）
    if (typeof PredictTrack !== 'undefined' && symbol) {
      PredictTrack.record(symbol, { lastClose, mid: points[points.length-1].mid, upper: points[points.length-1].upper, lower: points[points.length-1].lower, horizonDays: days, anchorTs: data[data.length-1].t });
    }

    return { slope, stdErr: s, points, pctChange, trend, adjustment: adj };
  },

  // 趨勢分級（供主圖與總覽小圖表共用）
  _classifyTrend(pctChange) {
    if (pctChange >= 8)  return { label:'強力偏多', short:'⇈ 強力偏多', dir:'up',   level:3 };
    if (pctChange >= 3)  return { label:'偏多趨勢外推', short:'↗ 偏多', dir:'up',   level:2 };
    if (pctChange >= 0.5) return { label:'微幅偏多', short:'↗ 微幅偏多', dir:'up',   level:1 };
    if (pctChange > -0.5) return { label:'盤整外推', short:'→ 盤整', dir:'flat', level:0 };
    if (pctChange > -3)  return { label:'微幅偏空', short:'↘ 微幅偏空', dir:'down', level:1 };
    if (pctChange > -8)  return { label:'偏空趨勢外推', short:'↘ 偏空', dir:'down', level:2 };
    return { label:'強力偏空', short:'⇊ 強力偏空', dir:'down', level:3 };
  },

  // 趨勢配色：偏多=紅色系、偏空=綠色系（同台股紅漲綠跌慣例），盤整=灰色
  // 深色主題下，強度越高顏色要越亮越飽和（不是越深），否則深色在深底色上反而不顯眼
  _trendColor(trend) {
    const reds   = ['#c98a89', '#E24B4A', '#ff5c5c']; // 微幅偏多／偏多／強力偏多（由淡到最鮮豔）
    const greens = ['#7fae9d', '#1D9E75', '#2ee88f']; // 微幅偏空／偏空／強力偏空（由淡到最鮮豔）
    if (trend.dir === 'flat') return '#9ca3af';
    const idx = Math.min(2, Math.max(0, trend.level - 1));
    return trend.dir === 'up' ? reds[idx] : greens[idx];
  },

  // ── 技術面統計外推預測（非真實預測，僅供參考）──────
  // v2：近中期雙窗口迴歸 + ADX/RSI 動能修正 + 位階修正 + 標準預測區間公式
  _computePrediction(days, symbol) {
    // ★ 指標優先用快取（已算過就不重算，效能較好），沒有才即時算，跟總覽小圖用同一套判斷順序
    let ind;
    try {
      ind = ANALYSIS._cache[symbol]?.ind ?? ANALYSIS._calcIndicators(this.currentData);
    } catch(e) { ind = null; }
    return this._predictEngine(this.currentData, days, symbol, { nearLookback:10, midLookback:40, hlLookback:40, zScore:1.3, ind });
  },

  draw() {
    this._drawMain();
    this._drawVol();
  },

  _drawMain() {
    const canvas = document.getElementById('mainChart');
    if (!canvas || !this.currentData.length) return;
    const wrap = document.getElementById('candle-wrap');
    const W = wrap.clientWidth || 600;
    const H = 420;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const isDark = !document.body.classList.contains('light-mode');
    const clr = {
      up:'#E24B4A', dn:'#1D9E75',
      grid: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      text: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)',
      ma5:'#EF9F27', ma20:'#378ADD', ma60:'#D4537E',
    };

    const data = this._visibleData();
    if (!data.length) return;
    const n = data.length;
    const allCloses = this.currentData.map(d => d.c);
    const ma5  = this._ma(allCloses, 5);
    const ma20 = this._ma(allCloses, 20);
    const ma60 = this._ma(allCloses, 60);
    // Map to visible slice
    const visStart = this.zoomStart;
    const ma5v  = ma5.slice(visStart, visStart + n);
    const ma20v = ma20.slice(visStart, visStart + n);
    const ma60v = ma60.slice(visStart, visStart + n);

    // 只有在檢視最新資料（未拉到過去）時才顯示預測延伸
    const showingLatest = (visStart + n) >= this.currentData.length;
    const predictActive = this.showPredict && showingLatest;
    const prediction = predictActive ? this._computePrediction(this.predictDays, APP.activeSymbol) : null;
    const extraBars = prediction ? this.predictDays : 0;
    const totalBars = n + extraBars;
    const discEl = document.getElementById('predict-disclaimer');
    if (discEl) discEl.style.display = prediction ? 'block' : 'none';
    const accEl = document.getElementById('predict-accuracy');
    if (accEl) {
      if (prediction) {
        const adj = prediction.adjustment;
        if (adj && adj.sampleCount >= 5) {
          const dirPct = adj.directionAccuracy != null ? (adj.directionAccuracy * 100).toFixed(0) + '%' : '—';
          const hitPct = (adj.bandHitRate * 100).toFixed(0) + '%';
          const adjusted = adj.slopeMul !== 1 || adj.zMul !== 1;
          const scope = adj.basedOnSymbol ? '此股' : '全市場';
          accEl.textContent = `📊 近期預測準確度（${scope}，${adj.sampleCount}次）：方向正確率 ${dirPct}｜區間命中率 ${hitPct}${adjusted ? '｜已依此自動微調預測強度' : ''}`;
          accEl.style.display = 'block';
        } else {
          accEl.textContent = `📊 預測準確度統計中（樣本 ${adj?.sampleCount ?? 0}/5次，累積足夠後會顯示並自動微調）`;
          accEl.style.display = 'block';
        }
      } else {
        accEl.style.display = 'none';
      }
    }

    const PAD = { l:6, r:56, t:16, b:28 };
    const chartW = W - PAD.l - PAD.r;
    // ★ 固定間距比例（間距=K線寬度20%），撐滿整個圖表寬度，避免留白
    const gapRatio = 0.2;
    const barW = Math.max(1, Math.min(40, chartW / (totalBars * (1 + gapRatio))));
    const gap = barW * gapRatio;

    const allPrices = data.flatMap(d => [d.h, d.l]);
    if (prediction) {
      prediction.points.forEach(p => { allPrices.push(p.upper, p.lower); });
    }
    const minP = Math.min(...allPrices) * 0.998;
    const maxP = Math.max(...allPrices) * 1.002;
    const priceRange = maxP - minP || 1;

    const xOf = i => PAD.l + i * (barW + gap) + barW / 2;
    const yOf = p => PAD.t + (1 - (p - minP) / priceRange) * (H - PAD.t - PAD.b);

    // Grid - 水平線 + 垂直線
    ctx.strokeStyle = clr.grid; ctx.lineWidth = 1;
    // 水平格線
    [0.25, 0.5, 0.75].forEach(r => {
      const y = PAD.t + r * (H - PAD.t - PAD.b);
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
      const p = maxP - r * priceRange;
      ctx.fillStyle = clr.text; ctx.font = '10px monospace';
      ctx.textAlign = 'left'; ctx.fillText(p.toFixed(1), W - PAD.r + 3, y + 3);
    });
    // 垂直格線（與 X 軸日期對齊）
    const vStep = Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i += vStep) {
      const x = xOf(i);
      ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, H - PAD.b); ctx.stroke();
    }

    if (this.currentType === 'line') {
      ctx.beginPath(); ctx.strokeStyle = clr.up; ctx.lineWidth = 1.5;
      data.forEach((d, i) => { const x = xOf(i), y = yOf(d.c); i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y); });
      ctx.stroke();
    } else {
      data.forEach((d, i) => {
        const x = xOf(i);
        const isUp = d.c >= d.o;
        const col = isUp ? clr.up : clr.dn;
        const oy = yOf(d.o), cy = yOf(d.c), hy = yOf(d.h), ly = yOf(d.l);
        ctx.strokeStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, ly); ctx.stroke();
        const top = Math.min(oy, cy), bodyH = Math.max(1, Math.abs(cy - oy));
        ctx.fillStyle = isUp ? col : col;
        ctx.fillRect(x - barW/2, top, barW, bodyH);
        if (!isUp) { ctx.strokeRect(x - barW/2, top, barW, bodyH); }
      });
    }

    const drawMA = (ma, color) => {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      let started = false;
      ma.forEach((v, i) => {
        if (!v) return;
        const x = xOf(i), y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    drawMA(ma5v, clr.ma5); drawMA(ma20v, clr.ma20); drawMA(ma60v, clr.ma60);

    // ── 均價水平線（若持有此股票）──────────────────────
    const activeSym = (typeof APP !== 'undefined') ? APP.activeSymbol : null;
    const heldStock = activeSym
      ? [...APP._twPortfolio, ...APP._usPortfolio].find(s => s.code === activeSym)
      : null;
    if (heldStock?.cost && heldStock.cost >= minP && heldStock.cost <= maxP) {
      const costY = yOf(heldStock.cost);
      ctx.beginPath();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#eab308'; ctx.lineWidth = 1.3;
      ctx.moveTo(PAD.l, costY); ctx.lineTo(PAD.l + chartW, costY);
      ctx.stroke();
      ctx.setLineDash([]);
      // 標籤
      const costLabel = `均價 ${heldStock.cost.toFixed(heldStock.cost < 10 ? 3 : 2)}`;
      ctx.font = 'bold 11px sans-serif';
      const lw = ctx.measureText(costLabel).width;
      ctx.fillStyle = 'rgba(13,17,23,0.85)';
      ctx.fillRect(PAD.l + 2, costY - 15, lw + 8, 16);
      ctx.fillStyle = '#eab308';
      ctx.textAlign = 'left';
      ctx.fillText(costLabel, PAD.l + 6, costY - 3);
    }

    // ── 每筆成交價格標記（買=▲紅、賣=▼綠，只標在可視K線範圍內的交易）──
    if (typeof TRADES !== 'undefined' && activeSym) {
      const trades = TRADES.get().filter(t => t.code === activeSym);
      const visStartTs = data[0]?.t, visEndTs = data[data.length-1]?.t;
      trades.forEach(t => {
        const tTs = new Date(t.date).getTime();
        if (!visStartTs || tTs < visStartTs || tTs > visEndTs + 86400000) return;
        // 找最接近的K線索引
        let closestI = 0, minDiff = Infinity;
        data.forEach((d, i) => { const diff = Math.abs(d.t - tTs); if (diff < minDiff) { minDiff = diff; closestI = i; } });
        if (t.price < minP || t.price > maxP) return;
        const x = xOf(closestI), y = yOf(t.price);
        const isBuy = t.action === 'buy';
        ctx.fillStyle = isBuy ? '#E24B4A' : '#1D9E75';
        ctx.beginPath();
        if (isBuy) { ctx.moveTo(x, y+7); ctx.lineTo(x-5, y+15); ctx.lineTo(x+5, y+15); }
        else { ctx.moveTo(x, y-7); ctx.lineTo(x-5, y-15); ctx.lineTo(x+5, y-15); }
        ctx.closePath();
        ctx.fill();
      });
    }

    // ── 預測延伸線（技術面統計外推，非真實預測）──────
    if (prediction) {
      const trend = prediction.trend;
      const predColor = this._trendColor(trend);
      const lastX = xOf(n - 1), lastY = yOf(data[n-1].c);

      // 信賴區間陰影（顏色隨偏多/偏空/盤整而變）
      const fillAlpha = (isDark ? 0.08 : 0.06) + trend.level * 0.04;
      const rgbMap = { up:[226,75,74], down:[29,158,117], flat:[156,163,175] };
      const rgb = rgbMap[trend.dir];
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      prediction.points.forEach((p, i) => ctx.lineTo(xOf(n + i), yOf(p.upper)));
      for (let i = prediction.points.length - 1; i >= 0; i--) {
        ctx.lineTo(xOf(n + i), yOf(prediction.points[i].lower));
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${fillAlpha})`;
      ctx.fill();

      // 中線虛線
      ctx.beginPath();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = predColor; ctx.lineWidth = 2;
      ctx.moveTo(lastX, lastY);
      prediction.points.forEach((p, i) => ctx.lineTo(xOf(n + i), yOf(p.mid)));
      ctx.stroke();
      ctx.setLineDash([]);

      // 上下界細虛線
      ctx.beginPath(); ctx.setLineDash([2, 3]); ctx.strokeStyle = predColor; ctx.lineWidth = 0.8; ctx.globalAlpha = 0.6;
      ctx.moveTo(lastX, lastY);
      prediction.points.forEach((p, i) => ctx.lineTo(xOf(n + i), yOf(p.upper)));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      prediction.points.forEach((p, i) => ctx.lineTo(xOf(n + i), yOf(p.lower)));
      ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;

      // 標籤（依偏多/偏空程度分級，大字體+底色背景，清楚易讀）
      const lastP = prediction.points[prediction.points.length - 1];
      const labelText = `${trend.short}  ${prediction.pctChange >= 0 ? '+' : ''}${prediction.pctChange.toFixed(1)}%`;
      const labelX = xOf(n) + 4, labelY = yOf(lastP.mid);
      ctx.font = 'bold 17px sans-serif';
      const textW = ctx.measureText(labelText).width;
      ctx.fillStyle = isDark ? 'rgba(13,17,23,0.85)' : 'rgba(255,255,255,0.9)';
      ctx.fillRect(labelX - 4, labelY - 20, textW + 10, 26);
      ctx.strokeStyle = predColor; ctx.lineWidth = 1;
      ctx.strokeRect(labelX - 4, labelY - 20, textW + 10, 26);
      ctx.fillStyle = predColor; ctx.textAlign = 'left';
      ctx.fillText(labelText, labelX, labelY + 1);

      // 分隔虛線標示「今天」
      ctx.beginPath(); ctx.setLineDash([2, 2]); ctx.strokeStyle = clr.grid; ctx.lineWidth = 1;
      ctx.moveTo(lastX, PAD.t); ctx.lineTo(lastX, H - PAD.b);
      ctx.stroke(); ctx.setLineDash([]);
    }

    // 垂直格線（問題7）
    const step = Math.max(1, Math.ceil(n / 6));
    ctx.strokeStyle = clr.grid; ctx.lineWidth = 0.5; ctx.setLineDash([2, 3]);
    for (let i = 0; i < n; i += step) {
      const x = xOf(i);
      ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, H - PAD.b - 12); ctx.stroke();
    }
    ctx.setLineDash([]);

    // X axis labels - 根據資料密度自動決定格式
    ctx.fillStyle = clr.text; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    // 判斷是否需要顯示時間：intraday (資料間隔 < 2小時) 或高度縮放 (每格 < 2天)
    const timeSpanMs = data.length > 1 ? data[1].t - data[0].t : 86400000;
    const isIntraday = timeSpanMs < 2 * 3600 * 1000;        // 2小時以內
    const isHourly   = timeSpanMs < 8 * 3600 * 1000;        // 8小時以內
    const visSpanDays = (data[data.length-1].t - data[0].t) / 86400000;
    const showTime = isIntraday || isHourly || visSpanDays < 5; // 縮放後顯示範圍 < 5天

    for (let i = 0; i < n; i += step) {
      const dt = new Date(data[i].t);
      let label;
      if (showTime && isIntraday) {
        // 純時間：HH:MM
        label = dt.toLocaleTimeString('zh-TW', { hour:'2-digit', minute:'2-digit', hour12:false });
      } else if (showTime && isHourly) {
        // 日+時：DD HH:MM
        label = `${dt.getMonth()+1}/${dt.getDate()} ${dt.getHours().toString().padStart(2,'0')}:${dt.getMinutes().toString().padStart(2,'0')}`;
      } else if (showTime && visSpanDays < 5) {
        // 日+時（顯示範圍少於5天）
        label = `${dt.getMonth()+1}/${dt.getDate()} ${dt.getHours().toString().padStart(2,'0')}:${dt.getMinutes().toString().padStart(2,'0')}`;
      } else {
        // 一般日期：MM/DD
        label = dt.toLocaleDateString('zh-TW', { month:'2-digit', day:'2-digit' });
      }
      ctx.fillText(label, xOf(i), H - 6);
    }

    // Zoom indicator
    if (this.zoomStart > 0 || this.zoomEnd < this.currentData.length - 1) {
      const totalN = this.currentData.length;
      const zoomPct = ((this.zoomEnd - this.zoomStart + 1) / totalN * 100).toFixed(0);
      ctx.fillStyle = 'rgba(239,159,39,0.8)'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(`顯示 ${zoomPct}%`, W - PAD.r - 2, PAD.t + 12);
    }

    this._setupInteraction(canvas, data, xOf, yOf, PAD, W, H, barW, gap, timeSpanMs);
  },

  _drawVol() {
    const canvas = document.getElementById('volChart');
    if (!canvas || !this.currentData.length) return;
    const wrap = document.getElementById('candle-wrap');
    const W = wrap.clientWidth || 600;
    const H = 56;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const data = this._visibleData();
    if (!data.length) return;
    const n = data.length;

    // ★ 與主圖對齊：若有預測延伸，總bar數要一致，成交量才不會超出真實K線範圍
    const visStart = this.zoomStart;
    const showingLatest = (visStart + n) >= this.currentData.length;
    const predictActive = this.showPredict && showingLatest && this.currentData.length >= 15;
    const totalBars = predictActive ? n + this.predictDays : n;

    const PAD = { l:6, r:56, t:4, b:4 };
    const chartW = W - PAD.l - PAD.r;
    const gapRatio = 0.2;
    const barW = Math.max(1, Math.min(40, chartW / (totalBars * (1 + gapRatio))));
    const gap = barW * gapRatio;
    const maxV = Math.max(...data.map(d => d.v)) || 1;

    data.forEach((d, i) => {
      const x = PAD.l + i * (barW + gap);
      const isUp = d.c >= d.o;
      ctx.fillStyle = isUp ? 'rgba(226,75,74,0.55)' : 'rgba(29,158,117,0.55)';
      const bh = Math.max(1, (d.v / maxV) * (H - PAD.t - PAD.b));
      ctx.fillRect(x, H - PAD.b - bh, barW, bh);
    });
  },

  _setupInteraction(canvas, data, xOf, yOf, PAD, W, H, barW, gap, timeSpanMs = 86400000) {
    const tt = document.getElementById('chart-tt');
    const cv = document.getElementById('cv');
    const ch = document.getElementById('ch');
    const n = data.length;

    // ★ 與繪圖用的 xOf 完全同公式反推，避免十字準星偏移
    // xOf(i) = PAD.l + i*(barW+gap) + barW/2
    const getIdx = mx => Math.max(0, Math.min(n-1, Math.round((mx - PAD.l - barW/2) / (barW + gap))));

    // Crosshair
    canvas.onmousemove = e => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      if (this.isDragging) {
        const dx = mx - this.dragStartX;
        const totalN = this.currentData.length;
        const visN = this.dragStartZoom.end - this.dragStartZoom.start + 1;
        const shift = Math.round(-dx / (W / visN));
        let ns = this.dragStartZoom.start + shift;
        let ne = this.dragStartZoom.end + shift;
        if (ns < 0) { ne -= ns; ns = 0; }
        if (ne >= totalN) { ns -= (ne - totalN + 1); ne = totalN - 1; }
        this.zoomStart = Math.max(0, ns);
        this.zoomEnd   = Math.min(totalN - 1, ne);
        this.draw(); return;
      }
      const idx = getIdx(mx);
      const d = data[idx];
      const x = xOf(idx); const y = yOf(d.c);
      if (cv) { cv.style.left = x + 'px'; cv.style.opacity = '1'; }
      if (ch) { ch.style.top = y + 'px'; ch.style.opacity = '1'; }
      if (tt) {
        const dt = new Date(d.t);
        const showT = timeSpanMs < 8 * 3600 * 1000;
        const dateStr = showT
          ? dt.toLocaleDateString('zh-TW') + ' ' + dt.toLocaleTimeString('zh-TW', { hour:'2-digit', minute:'2-digit', hour12:false })
          : dt.toLocaleDateString('zh-TW');
        const chg = d.c - d.o;
        tt.innerHTML = `<span>${dateStr}</span> 開${d.o} 高${d.h} 低${d.l} <b>收${d.c}</b> <span style="color:${chg>=0?'#E24B4A':'#1D9E75'}">${chg>=0?'▲':'▼'}${Math.abs(chg).toFixed(2)}</span>`;
        tt.style.opacity = '1';
      }
    };

    canvas.onmouseleave = () => {
      if (cv) cv.style.opacity = '0';
      if (ch) ch.style.opacity = '0';
      if (tt) tt.style.opacity = '0';
      this.isDragging = false;
    };

    canvas.onmousedown = e => {
      this.isDragging = true;
      this.dragStartX = e.clientX - canvas.getBoundingClientRect().left;
      this.dragStartZoom = { start: this.zoomStart, end: this.zoomEnd };
      canvas.style.cursor = 'grabbing';
    };

    canvas.onmouseup = () => { this.isDragging = false; canvas.style.cursor = 'crosshair'; };

    // Wheel zoom - 滾輪向上 = 放大（看更細），向下 = 縮小（看更廣）
    canvas.onwheel = e => {
      e.preventDefault();
      const totalN = this.currentData.length;
      const visN = this.zoomEnd - this.zoomStart + 1;
      // ★ 滾輪改為平移日期（不縮放），往下滾=看更早，往上滾=看更晚
      const panAmount = Math.max(1, Math.round(visN * 0.15));
      const dir = e.deltaY > 0 ? -1 : 1; // 向下滾動看更早的資料
      let ns = this.zoomStart + dir * panAmount;
      let ne = this.zoomEnd   + dir * panAmount;
      if (ns < 0) { ne -= ns; ns = 0; }
      if (ne > totalN - 1) { ns -= (ne - (totalN - 1)); ne = totalN - 1; }
      this.zoomStart = Math.max(0, ns);
      this.zoomEnd   = Math.min(totalN - 1, ne);
      this.draw();
    };
    canvas.style.cursor = 'crosshair';
  },

  drawMACD(data) {
    const canvas = document.getElementById('macdChart');
    if (!canvas || !data.length) return;
    const W = canvas.parentElement?.clientWidth || 500;
    const H = 140;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const closes = data.map(d => d.c);
    const n = closes.length;
    const ema12 = ANALYSIS._ema(closes, 12);
    const ema26 = ANALYSIS._ema(closes, 26);
    const macdArr = closes.slice(25).map((_, i) => ema12[i+25] - ema26[i+25]);
    const sigArr = ANALYSIS._ema(macdArr, 9);
    const hists = macdArr.map((v, i) => v - (sigArr[i] || 0));

    const isDark = !document.body.classList.contains('light-mode');
    const grid = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    const textC = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)';
    const PAD = { l:6, r:56, t:14, b:20 };
    const chartW = W - PAD.l - PAD.r;
    const visN = hists.length;
    const barW = Math.max(1, Math.floor(chartW / visN) - 1);
    const gap = (chartW - barW * visN) / (visN - 1 || 1);
    const absMax = Math.max(...hists.map(Math.abs), 0.001) * 1.1;
    const mid = PAD.t + (H - PAD.t - PAD.b) / 2;
    const yOf = v => mid - (v / absMax) * ((H - PAD.t - PAD.b) / 2);

    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.l, mid); ctx.lineTo(W - PAD.r, mid); ctx.stroke();
    ctx.fillStyle = textC; ctx.font = '9px monospace'; ctx.textAlign = 'left';
    ctx.fillText('MACD', W - PAD.r + 3, PAD.t + 8);

    hists.forEach((h, i) => {
      const x = PAD.l + i * (barW + gap);
      ctx.fillStyle = h >= 0 ? 'rgba(226,75,74,0.7)' : 'rgba(29,158,117,0.7)';
      ctx.fillRect(x, Math.min(yOf(h), mid), barW, Math.max(1, Math.abs(yOf(h) - mid)));
    });

    const xOf = i => PAD.l + i * (barW + gap) + barW / 2;
    const drawLine = (arr, color) => {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      arr.forEach((v, i) => { i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)); });
      ctx.stroke();
    };
    drawLine(macdArr, '#378ADD'); drawLine(sigArr, '#EF9F27');
  },

  drawKD(data) {
    const canvas = document.getElementById('kdChart');
    if (!canvas || !data.length) return;
    const W = canvas.parentElement?.clientWidth || 500;
    const H = 110;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const isDark = !document.body.classList.contains('light-mode');
    const grid = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    const textC = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)';
    const period = 9;
    const Ks = [], Ds = [];
    let K = 50, D = 50;
    for (let i = period - 1; i < data.length; i++) {
      const slice = data.slice(i - period + 1, i + 1);
      const high = Math.max(...slice.map(x => x.h));
      const low  = Math.min(...slice.map(x => x.l));
      const rsv = high === low ? 50 : (data[i].c - low) / (high - low) * 100;
      K = 2/3 * K + 1/3 * rsv; D = 2/3 * D + 1/3 * K;
      Ks.push(K); Ds.push(D);
    }
    const PAD = { l:6, r:56, t:14, b:20 };
    const chartW = W - PAD.l - PAD.r;
    const n = Ks.length;
    const barW = Math.max(1, Math.floor(chartW / n) - 1);
    const gap = (chartW - barW * n) / (n - 1 || 1);
    const yOf = v => PAD.t + (1 - v / 100) * (H - PAD.t - PAD.b);
    const xOf = i => PAD.l + i * (barW + gap) + barW / 2;

    [20, 50, 80].forEach(v => {
      ctx.strokeStyle = grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD.l, yOf(v)); ctx.lineTo(W - PAD.r, yOf(v)); ctx.stroke();
      ctx.fillStyle = textC; ctx.font = '9px monospace'; ctx.textAlign = 'left';
      ctx.fillText(v, W - PAD.r + 3, yOf(v) + 3);
    });
    ctx.fillStyle = textC; ctx.fillText('KD', W - PAD.r + 3, PAD.t + 8);

    const drawLine = (arr, color) => {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.4;
      arr.forEach((v, i) => { i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)); });
      ctx.stroke();
    };
    drawLine(Ks, '#E24B4A'); drawLine(Ds, '#378ADD');
  },

  _ma(arr, period) {
    return arr.map((_, i) => {
      if (i < period - 1) return null;
      return arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b) / period;
    });
  },
};

// ── PredictTrack ──────────────────────────────────────
// 記錄每次預測，事後（時間到了）用實際股價驗證準確度，
// 準確度不佳時自動調整下次預測的信心強度（斜率倍率）與區間寬度（z倍率）
const PredictTrack = {
  _key(market) { return market === 'US' ? 'ussa-predict-track' : 'twsa-predict-track'; },
  _market() { return (typeof APP !== 'undefined' && APP.activeMarket === 'US') ? 'US' : 'TW'; },

  get() {
    try { return JSON.parse(localStorage.getItem(this._key(this._market())) || '[]'); }
    catch(e) { return []; }
  },
  save(arr) {
    localStorage.setItem(this._key(this._market()), JSON.stringify(arr.slice(-300))); // 最多留300筆
  },

  // 記錄一次新預測（同股票同天同天期只記一次，避免重複灌爆）
  record(symbol, pred) {
    const today = new Date().toISOString().slice(0, 10);
    const list = this.get();
    const exists = list.some(e => e.symbol === symbol && e.recordDate === today && e.horizonDays === pred.horizonDays);
    if (exists) return;
    list.push({
      symbol, recordDate: today,
      anchorTs: pred.anchorTs, horizonDays: pred.horizonDays,
      lastClose: pred.lastClose, predMid: pred.mid, predUpper: pred.upper, predLower: pred.lower,
      evaluated: false, actual: null, hit: null, directionCorrect: null,
    });
    this.save(list);
  },

  // 事後驗證：找出已過預測期限的記錄，用最新資料比對實際結果
  async evaluate() {
    const list = this.get();
    const pending = list.filter(e => !e.evaluated);
    if (!pending.length) return;
    const bySymbol = {};
    pending.forEach(e => { (bySymbol[e.symbol] ||= []).push(e); });

    // ★ 限制每次最多處理幾檔股票，避免累積大量待驗證紀錄時一次塞爆共用請求佇列
    // （曾發生跟總覽頁同時搶佇列，導致總覽頁載入變超慢的問題）
    const MAX_SYMBOLS_PER_RUN = 4;
    const symbols = Object.keys(bySymbol).slice(0, MAX_SYMBOLS_PER_RUN);

    for (const symbol of symbols) {
      try {
        const data = await DATA.fetchHistory(symbol, '1d');
        const dayKey = ts => new Date(ts).toDateString();
        bySymbol[symbol].forEach(e => {
          const anchorIdx = data.findIndex(d => dayKey(d.t) === dayKey(e.anchorTs));
          if (anchorIdx === -1) return; // 資料視窗已滑出（太舊），先跳過
          const targetIdx = anchorIdx + e.horizonDays;
          if (targetIdx >= data.length) return; // 還沒到預測期限
          const actual = data[targetIdx].c;
          e.actual = actual;
          const predDir = e.predMid > e.lastClose ? 1 : e.predMid < e.lastClose ? -1 : 0;
          const actualDir = actual > e.lastClose ? 1 : actual < e.lastClose ? -1 : 0;
          e.directionCorrect = predDir === 0 ? null : (predDir === actualDir);
          e.hit = actual >= e.predLower && actual <= e.predUpper;
          e.evaluated = true;
        });
        await new Promise(r => setTimeout(r, 300)); // 節流，避免同時大量請求
      } catch(err) { /* 靜默跳過失敗的股票 */ }
    }
    this.save(list);
  },

  // 準確度統計（symbol=null 表示全市場合併統計）
  getStats(symbol) {
    const list = this.get().filter(e => e.evaluated && (!symbol || e.symbol === symbol));
    if (!list.length) return null;
    const dirList = list.filter(e => e.directionCorrect !== null);
    const dirAcc = dirList.length ? dirList.filter(e => e.directionCorrect).length / dirList.length : null;
    const hitRate = list.filter(e => e.hit).length / list.length;
    return { count: list.length, directionAccuracy: dirAcc, bandHitRate: hitRate };
  },

  // 依過去準確度自動調整：方向常猜錯→收斂斜率信心；區間命中率太低→加寬區間
  getAdjustment(symbol) {
    let stats = symbol ? this.getStats(symbol) : null;
    let basedOnSymbol = !!stats && stats.count >= 5;
    if (!basedOnSymbol) stats = this.getStats(null); // 個股樣本不夠，退回看全市場整體
    if (!stats || stats.count < 5) return { slopeMul: 1, zMul: 1, sampleCount: stats?.count ?? 0, basedOnSymbol: false };

    let slopeMul = 1, zMul = 1;
    if (stats.directionAccuracy != null) {
      if (stats.directionAccuracy < 0.40) slopeMul = 0.4;
      else if (stats.directionAccuracy < 0.50) slopeMul = 0.65;
      else if (stats.directionAccuracy > 0.65) slopeMul = 1.15;
    }
    if (stats.bandHitRate < 0.5) zMul = 1.5;
    else if (stats.bandHitRate < 0.65) zMul = 1.25;
    else if (stats.bandHitRate > 0.92) zMul = 0.9;

    return { slopeMul, zMul, sampleCount: stats.count, directionAccuracy: stats.directionAccuracy, bandHitRate: stats.bandHitRate, basedOnSymbol };
  },
};
