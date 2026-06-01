// ── chart.js  ── Canvas K-line renderer v3
// 新增：滑鼠滾輪縮放、拖曳平移

const CHART = {
  currentData: [],
  currentPeriod: '3mo',
  currentType: 'candle',
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
    const loadEl = document.getElementById('chart-loading');
    if (loadEl) loadEl.style.display = 'flex';
    const data = await DATA.fetchHistory(symbol, period);
    if (loadEl) loadEl.style.display = 'none';
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
    this.zoomStart = 0;
    this.zoomEnd = n - 1;
  },

  _visibleData() {
    const n = this.currentData.length;
    if (!n) return [];
    const s = Math.max(0, Math.min(n-2, this.zoomStart));
    const e = Math.max(s+1, Math.min(n-1, this.zoomEnd));
    return this.currentData.slice(s, e + 1);
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
    const H = 300;
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

    const PAD = { l:6, r:56, t:16, b:28 };
    const chartW = W - PAD.l - PAD.r;
    const barW = Math.max(1, Math.min(16, Math.floor(chartW / n) - 1));
    const gap = Math.max(0, (chartW - barW * n) / Math.max(1, n - 1));

    const allPrices = data.flatMap(d => [d.h, d.l]);
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
    const PAD = { l:6, r:56, t:4, b:4 };
    const chartW = W - PAD.l - PAD.r;
    const barW = Math.max(1, Math.min(16, Math.floor(chartW / n) - 1));
    const gap = Math.max(0, (chartW - barW * n) / Math.max(1, n - 1));
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

    const getIdx = mx => Math.max(0, Math.min(n-1, Math.round((mx - PAD.l) / ((W - PAD.l - PAD.r) / Math.max(1, n-1)))));

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
      // deltaY > 0 = 滾輪向下 = 縮小（顯示更多）
      // deltaY < 0 = 滾輪向上 = 放大（顯示更少）
      const zoomIn = e.deltaY < 0;
      const zoomFactor = 0.15;
      const change = Math.max(1, Math.round(visN * zoomFactor));
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const ratio = mx / W;

      let ns, ne;
      if (zoomIn) {
        // 放大：縮小顯示範圍
        ns = this.zoomStart + Math.round(change * ratio);
        ne = this.zoomEnd   - Math.round(change * (1 - ratio));
      } else {
        // 縮小：擴大顯示範圍
        ns = this.zoomStart - Math.round(change * ratio);
        ne = this.zoomEnd   + Math.round(change * (1 - ratio));
      }
      if (ne - ns < 5) { if (zoomIn) { ns = ne - 5; } else { ne = ns + 5; } }
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
