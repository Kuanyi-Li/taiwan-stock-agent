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
    this._patchCandleData(this.currentData, symbol);
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

  // 用即時報價修正資料陣列的最後一根K線
  _patchCandleData(data, symbol) {
    if (!data.length) return;
    const q = DATA.priceStore[symbol];
    if (!q?.price || q.source === 'twse-prev') return;
    const last = data[data.length - 1];
    const d = new Date(last.t);
    const now = new Date();
    const isToday = d.getFullYear() === now.getFullYear() &&
                    d.getMonth() === now.getMonth() &&
                    d.getDate() === now.getDate();
    if (!isToday) return;
    last.c = q.price;
    if (q.high && q.high > last.h) last.h = q.high;
    if (q.low  && q.low  < last.l) last.l = q.low;
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

    const ind = ANALYSIS._cache[symbol || (typeof APP !== 'undefined' ? APP.activeSymbol : '')]?.ind;
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

    const s = Math.sqrt(near.variance * 0.6 + mid.variance * 0.4);
    const { n, xBar, den } = mid;
    const lastIdx = n - 1;

    const points = [];
    for (let d = 1; d <= days; d++) {
      const priceMid = lastClose + slope * d;
      const x0 = lastIdx + d;
      const se = s * Math.sqrt(1 + 1/n + ((x0-xBar)**2)/(den||1));
      const band = se * z;
      points.push({ day: d, mid: priceMid, upper: priceMid+band, lower: priceMid-band });
    }

    // 偏多/偏空程度分級：用預測終點相對現價的變化幅度%判斷
    const pctChange = (slope * days) / lastClose * 100;
    const trend = this._classifyTrend(pctChange);

    return { slope, stdErr: s, points, pctChange, trend };
  },

  // 趨勢分級（供主圖與總覽小圖表共用）
  _classifyTrend(pctChange) {
    if (pctChange >= 8)  return { label:'強力偏多', short:'⇈偏多', dir:'up',   level:3 };
    if (pctChange >= 3)  return { label:'偏多趨勢外推', short:'↗偏多', dir:'up',   level:2 };
    if (pctChange >= 0.5) return { label:'微幅偏多', short:'↗微多', dir:'up',   level:1 };
    if (pctChange > -0.5) return { label:'盤整外推', short:'→盤整', dir:'flat', level:0 };
    if (pctChange > -3)  return { label:'微幅偏空', short:'↘微空', dir:'down', level:1 };
    if (pctChange > -8)  return { label:'偏空趨勢外推', short:'↘偏空', dir:'down', level:2 };
    return { label:'強力偏空', short:'⇊偏空', dir:'down', level:3 };
  },

  // ── 技術面統計外推預測（非真實預測，僅供參考）──────
  // v2：近中期雙窗口迴歸 + ADX/RSI 動能修正 + 位階修正 + 標準預測區間公式
  _computePrediction(days, symbol) {
    return this._predictEngine(this.currentData, days, symbol, { nearLookback:10, midLookback:40, hlLookback:40, zScore:1.3 });
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

    // ── 預測延伸線（技術面統計外推，非真實預測）──────
    if (prediction) {
      const predColor = isDark ? '#a78bfa' : '#7c3aed';
      const lastX = xOf(n - 1), lastY = yOf(data[n-1].c);

      // 信賴區間灰紫色陰影
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      prediction.points.forEach((p, i) => ctx.lineTo(xOf(n + i), yOf(p.upper)));
      for (let i = prediction.points.length - 1; i >= 0; i--) {
        ctx.lineTo(xOf(n + i), yOf(prediction.points[i].lower));
      }
      ctx.closePath();
      ctx.fillStyle = isDark ? 'rgba(167,139,250,0.12)' : 'rgba(124,58,237,0.10)';
      ctx.fill();

      // 中線虛線
      ctx.beginPath();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = predColor; ctx.lineWidth = 1.5;
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

      // 標籤（依偏多/偏空程度分級顯示，顏色隨強度加深）
      const lastP = prediction.points[prediction.points.length - 1];
      const trend = prediction.trend;
      const trendColors = {
        up:   ['#c4b5fd', '#a78bfa', '#7c3aed'],   // 微多/偏多/強力偏多
        down: ['#c4b5fd', '#a78bfa', '#7c3aed'],
        flat: ['#9ca3af'],
      };
      const trendColor = trend.dir === 'flat' ? trendColors.flat[0] : trendColors[trend.dir][Math.min(2, trend.level - 1)];
      ctx.fillStyle = trendColor; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(`${trend.short} (${prediction.pctChange >= 0 ? '+' : ''}${prediction.pctChange.toFixed(1)}%)`, xOf(n) + 2, yOf(lastP.mid) - 4);

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
