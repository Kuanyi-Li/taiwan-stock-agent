// ── chart.js  ── K-line + Volume + MACD + KD renderer ──

const CHART = {
  mainCtx: null,
  volCtx: null,
  macdChart: null,
  kdChart: null,
  currentData: [],
  chartType: 'candle',   // 'candle' | 'line'
  hoveredIdx: -1,

  // ── Init ─────────────────────────────────────────────
  init() {
    this.mainCtx = document.getElementById('mainChart').getContext('2d');
    this.volCtx  = document.getElementById('volChart').getContext('2d');
    this._setupEvents();
    this._setupPeriodTabs();
    this._setupTypeTabs();
  },

  // ── Load data & render ────────────────────────────────
  // 分析週期（長線/短線按鈕用）
  ANALYSIS_PERIODS: {
    long:  '1y',   // 長線：1年日線（~252根）
    short: '1mo',  // 短線：1個月日線（~22根）
  },

  _loadingSymbol: null, // 追蹤正在載入的股票，防止 race condition

  async load(symbol, period = '3mo') {
    // ★ 問題12修正：記錄本次載入目標，防止 race condition
    this._loadingSymbol = symbol;

    let interval = '1d';
    if (period === '1d') interval = '15m';
    else if (period === '1wk') interval = '60m';

    const candles = await DATA.fetchHistory(symbol, period, interval);

    // 若已切換到其他股票，丟棄此次結果
    if (this._loadingSymbol !== symbol) {
      console.log(`[CHART] race condition: discard ${symbol}, current=${this._loadingSymbol}`);
      return;
    }

    this.currentData = candles;
    this.draw();
    // 分析只跑分析用週期資料（不跟顯示週期混用）
    if (!ANALYSIS._cache[symbol]) {
      ANALYSIS.run(candles, symbol);
    }
  },

  // ── Main draw ─────────────────────────────────────────
  draw() {
    this._drawMain();
    this._drawVolume();
  },

  _drawMain() {
    const canvas = document.getElementById('mainChart');
    const wrap = document.getElementById('candle-wrap');
    const data = this.currentData;
    if (!data.length || !wrap) return;

    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight || 320;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const isDark = !document.body.classList.contains('light-mode');
    const PAD = { l: 58, r: 12, t: 18, b: 28 };
    const CW = W - PAD.l - PAD.r;
    const CH = H - PAD.t - PAD.b;
    const n = data.length;

    // Price range
    const highs  = data.map(d => d.h);
    const lows   = data.map(d => d.l);
    let maxP = Math.max(...highs);
    let minP = Math.min(...lows);
    const pad = (maxP - minP) * 0.08;
    maxP += pad; minP -= pad;
    const pY = p => PAD.t + CH * (1 - (p - minP) / (maxP - minP));

    // Candle width
    const cw = Math.max(2, Math.floor(CW / n * 0.72));
    const xAt = i => PAD.l + (i + 0.5) * (CW / n);

    // Grid
    const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    const textColor = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
    ctx.font = `10px IBM Plex Mono, monospace`;
    for (let i = 0; i <= 5; i++) {
      const y = PAD.t + CH * (i / 5);
      const price = maxP - (maxP - minP) * (i / 5);
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
      ctx.fillStyle = textColor;
      ctx.textAlign = 'right';
      ctx.fillText(price.toFixed(1), PAD.l - 4, y + 4);
    }

    // MA lines
    const maConfigs = [
      { period: 5,  color: '#EF9F27' },
      { period: 20, color: '#378ADD' },
      { period: 60, color: '#D4537E' },
    ];
    for (const ma of maConfigs) {
      if (data.length < ma.period) continue;
      ctx.beginPath();
      ctx.strokeStyle = ma.color;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.8;
      let started = false;
      for (let i = ma.period - 1; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < ma.period; j++) sum += data[i - j].c;
        const avg = sum / ma.period;
        const x = xAt(i), y = pY(avg);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Bollinger Bands (20,2)
    if (data.length >= 20) {
      ctx.beginPath();
      ctx.strokeStyle = isDark ? 'rgba(127,119,221,0.35)' : 'rgba(83,74,183,0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      let started = false;
      for (let i = 19; i < n; i++) {
        const slice = data.slice(i - 19, i + 1).map(d => d.c);
        const mean = slice.reduce((a, b) => a + b) / 20;
        const std  = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
        const upper = mean + 2 * std;
        const x = xAt(i), y = pY(upper);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.beginPath(); started = false;
      for (let i = 19; i < n; i++) {
        const slice = data.slice(i - 19, i + 1).map(d => d.c);
        const mean = slice.reduce((a, b) => a + b) / 20;
        const std  = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
        const lower = mean - 2 * std;
        const x = xAt(i), y = pY(lower);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Candles or Line
    if (this.chartType === 'candle') {
      for (let i = 0; i < n; i++) {
        const d = data[i];
        const x = xAt(i);
        const isUp = d.c >= d.o;
        const color = isUp ? '#E24B4A' : '#5DCAA5';
        const bodyTop    = pY(Math.max(d.o, d.c));
        const bodyBottom = pY(Math.min(d.o, d.c));
        const bodyH      = Math.max(1.5, bodyBottom - bodyTop);

        // Highlight hovered
        if (i === this.hoveredIdx) {
          ctx.fillStyle = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';
          ctx.fillRect(x - CW / n / 2, PAD.t, CW / n, CH);
        }

        // Wick
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, pY(d.h));
        ctx.lineTo(x, pY(d.l));
        ctx.stroke();

        // Body
        ctx.fillStyle = color;
        ctx.fillRect(x - cw / 2, bodyTop, cw, bodyH);
      }
    } else {
      // Line chart
      ctx.beginPath();
      ctx.strokeStyle = '#378ADD'; ctx.lineWidth = 1.8;
      for (let i = 0; i < n; i++) {
        const x = xAt(i), y = pY(data[i].c);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      // Area fill
      ctx.lineTo(xAt(n - 1), H - PAD.b);
      ctx.lineTo(xAt(0), H - PAD.b);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, PAD.t, 0, H - PAD.b);
      grad.addColorStop(0, 'rgba(55,138,221,0.18)');
      grad.addColorStop(1, 'rgba(55,138,221,0)');
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // X axis labels
    const labelStep = Math.max(1, Math.ceil(n / 7));
    for (let i = 0; i < n; i += labelStep) {
      const d = data[i];
      const x = xAt(i);
      const date = new Date(d.t);
      const label = `${date.getMonth() + 1}/${date.getDate()}`;
      ctx.fillStyle = textColor; ctx.textAlign = 'center'; ctx.font = '10px IBM Plex Mono,monospace';
      ctx.fillText(label, x, H - PAD.b + 14);
    }

    // Price line at last close
    if (data.length) {
      const lastC = data[data.length - 1].c;
      const prevC = data.length > 1 ? data[data.length - 2].c : lastC;
      const lineColor = lastC >= prevC ? '#E24B4A' : '#5DCAA5';
      ctx.strokeStyle = lineColor + '88';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD.l, pY(lastC));
      ctx.lineTo(W - PAD.r, pY(lastC));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = lineColor;
      ctx.textAlign = 'left'; ctx.font = '10px IBM Plex Mono,monospace';
      ctx.fillText(lastC.toFixed(1), W - PAD.r + 2, pY(lastC) + 4);
    }
  },

  _drawVolume() {
    const canvas = document.getElementById('volChart');
    const wrap   = document.getElementById('volChart').parentElement;
    const data = this.currentData;
    if (!data.length) return;

    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth;
    const H = 80;
    canvas.width  = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const isDark = !document.body.classList.contains('light-mode');
    const PAD = { l: 58, r: 12, t: 6, b: 18 };
    const CW = W - PAD.l - PAD.r;
    const CH = H - PAD.t - PAD.b;
    const n = data.length;
    const maxV = Math.max(...data.map(d => d.v));
    const cw = Math.max(2, Math.floor(CW / n * 0.72));
    const xAt = i => PAD.l + (i + 0.5) * (CW / n);
    const textColor = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)';

    ctx.fillStyle = textColor;
    ctx.font = '9px IBM Plex Mono,monospace';
    ctx.textAlign = 'right';
    ctx.fillText('量', PAD.l - 4, PAD.t + 10);

    for (let i = 0; i < n; i++) {
      const d = data[i];
      const x = xAt(i);
      const barH = (d.v / maxV) * CH;
      const isUp = d.c >= d.o;
      ctx.fillStyle = isUp ? 'rgba(226,75,74,0.55)' : 'rgba(93,202,165,0.55)';
      ctx.fillRect(x - cw / 2, H - PAD.b - barH, cw, barH);
    }

    // Vol label
    const lastV = data[data.length - 1]?.v ?? 0;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'left'; ctx.font = '9px IBM Plex Mono,monospace';
    ctx.fillText((lastV / 1000).toFixed(0) + 'K', PAD.l + 2, H - PAD.b + 12);
  },

  // ── Setup mouse events for tooltip & crosshair ────────
  _setupEvents() {
    const canvas = document.getElementById('mainChart');
    const tt = document.getElementById('chart-tt');
    const cv = document.getElementById('cv');
    const ch = document.getElementById('ch');

    canvas.addEventListener('mousemove', (e) => {
      const wrap = canvas.parentElement;
      const rect = wrap.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const W = wrap.clientWidth;
      const PAD = { l: 58, r: 12, t: 18, b: 28 };
      const CW = W - PAD.l - PAD.r;
      const n = this.currentData.length;
      const idx = Math.floor((mx - PAD.l) / (CW / n));

      if (idx >= 0 && idx < n) {
        this.hoveredIdx = idx;
        const d = this.currentData[idx];
        const date = new Date(d.t);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
        const isUp = d.c >= d.o;
        const chgColor = isUp ? 'var(--red)' : 'var(--green-l)';
        const chg = (d.c - d.o).toFixed(2);
        const chgPct = ((d.c - d.o) / d.o * 100).toFixed(2);

        tt.style.display = 'block';
        const ttX = mx + 14 > W - 160 ? mx - 155 : mx + 14;
        tt.style.left = ttX + 'px';
        tt.style.top = '10px';
        tt.innerHTML = `
          <div class="tt-row"><span class="tt-label">${dateStr}</span></div>
          <div class="tt-row"><span class="tt-label">開</span><span>${d.o.toFixed(2)}</span></div>
          <div class="tt-row"><span class="tt-label">高</span><span style="color:var(--red)">${d.h.toFixed(2)}</span></div>
          <div class="tt-row"><span class="tt-label">低</span><span style="color:var(--green-l)">${d.l.toFixed(2)}</span></div>
          <div class="tt-row"><span class="tt-label">收</span><span style="color:${chgColor};font-weight:500">${d.c.toFixed(2)}</span></div>
          <div class="tt-row"><span class="tt-label">漲跌</span><span style="color:${chgColor}">${chg >= 0 ? '+' : ''}${chg} (${chgPct >= 0 ? '+' : ''}${chgPct}%)</span></div>
          <div class="tt-row"><span class="tt-label">量</span><span>${(d.v/1000).toFixed(0)}K</span></div>`;

        // Crosshair
        cv.style.display = 'block';
        ch.style.display = 'block';
        cv.style.left = mx + 'px';
        ch.style.top = my + 'px';

        this.draw(); // redraw with highlight
      }
    });

    canvas.addEventListener('mouseleave', () => {
      tt.style.display = 'none';
      cv.style.display = 'none';
      ch.style.display = 'none';
      this.hoveredIdx = -1;
      this.draw();
    });
  },

  // ── Period tabs ───────────────────────────────────────
  _setupPeriodTabs() {
    document.getElementById('period-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.period-btn');
      if (!btn) return;
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const period = btn.dataset.period;
      const sym = APP.activeSymbol;
      if (sym) CHART.load(sym, period);
    });
  },

  // ── Chart type toggle ─────────────────────────────────
  _setupTypeTabs() {
    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.chartType = btn.dataset.type;
        this.draw();
      });
    });
  },

  // ── Draw MACD chart (Chart.js) ────────────────────────
  drawMACD(data) {
    const canvas = document.getElementById('macdChart');
    if (!canvas) return;
    if (this.macdChart) { this.macdChart.destroy(); this.macdChart = null; }
    if (!data.length) return;

    const closes = data.map(d => d.c);
    const n = closes.length;
    const isDark = !document.body.classList.contains('light-mode');
    const gc = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const tc = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';

    // Compute EMA
    const ema = (arr, p) => {
      const k = 2 / (p + 1);
      const res = [];
      let prev = arr.slice(0, p).reduce((a, b) => a + b) / p;
      res.push(prev);
      for (let i = p; i < arr.length; i++) {
        prev = arr[i] * k + prev * (1 - k);
        res.push(prev);
      }
      return { values: res, startIdx: p - 1 };
    };

    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const startIdx = Math.max(ema12.startIdx, ema26.startIdx);
    const macdLine = [];
    for (let i = startIdx; i < n; i++) {
      const e12 = ema12.values[i - ema12.startIdx];
      const e26 = ema26.values[i - ema26.startIdx];
      macdLine.push(+(e12 - e26).toFixed(3));
    }

    const sigLine = ema(macdLine, 9).values;
    const histLine = macdLine.slice(8).map((v, i) => +(v - sigLine[i]).toFixed(3));
    const labels = data.slice(startIdx + 8).map(d => {
      const dt = new Date(d.t);
      return `${dt.getMonth()+1}/${dt.getDate()}`;
    });

    this.macdChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'line', label: 'MACD',
            data: macdLine.slice(8), borderColor: '#378ADD', borderWidth: 1.5,
            pointRadius: 0, tension: 0.2, order: 0,
          },
          {
            type: 'line', label: 'Signal',
            data: sigLine, borderColor: '#EF9F27', borderWidth: 1.2,
            pointRadius: 0, tension: 0.2, order: 1,
          },
          {
            label: 'Hist',
            data: histLine,
            backgroundColor: histLine.map(v => v >= 0 ? 'rgba(226,75,74,0.6)' : 'rgba(93,202,165,0.6)'),
            order: 2,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { font: { size: 9 }, color: tc, maxRotation: 0, maxTicksLimit: 8 }, grid: { color: gc } },
          y: { ticks: { font: { size: 9 }, color: tc, maxTicksLimit: 5 }, grid: { color: gc } },
        },
      },
    });
  },

  // ── Draw KD chart ─────────────────────────────────────
  drawKD(data) {
    const canvas = document.getElementById('kdChart');
    if (!canvas) return;
    if (this.kdChart) { this.kdChart.destroy(); this.kdChart = null; }
    if (data.length < 9) return;

    const isDark = !document.body.classList.contains('light-mode');
    const gc = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const tc = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
    const n = data.length;

    // RSV (9-period)
    const kArr = [], dArr = [];
    let K = 50, D = 50;
    for (let i = 8; i < n; i++) {
      const slice = data.slice(i - 8, i + 1);
      const high = Math.max(...slice.map(x => x.h));
      const low  = Math.min(...slice.map(x => x.l));
      const rsv = high === low ? 50 : (data[i].c - low) / (high - low) * 100;
      K = 2/3 * K + 1/3 * rsv;
      D = 2/3 * D + 1/3 * K;
      kArr.push(+K.toFixed(2));
      dArr.push(+D.toFixed(2));
    }
    const labels = data.slice(8).map(d => {
      const dt = new Date(d.t);
      return `${dt.getMonth()+1}/${dt.getDate()}`;
    });

    this.kdChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'K', data: kArr, borderColor: '#EF9F27', borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
          { label: 'D', data: dArr, borderColor: '#7F77DD', borderWidth: 1.2, pointRadius: 0, tension: 0.2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { font: { size: 9 }, color: tc, maxTicksLimit: 8 }, grid: { color: gc } },
          y: { min: 0, max: 100, ticks: { font: { size: 9 }, color: tc }, grid: { color: gc } },
        },
      },
    });
  },
};
