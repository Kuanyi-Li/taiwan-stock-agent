// ── chart.js  ── Canvas K-line renderer (v2)

const CHART = {
  currentData: [],
  currentPeriod: '3mo',
  currentType: 'candle',
  chartInstance: null,
  macdInstance: null,
  kdInstance: null,

  init() {
    const tabs = document.getElementById('period-tabs');
    if (tabs) {
      tabs.addEventListener('click', e => {
        const btn = e.target.closest('.period-btn');
        if (!btn) return;
        tabs.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentPeriod = btn.dataset.period;
        if (APP.activeSymbol) CHART.load(APP.activeSymbol, this.currentPeriod);
      });
    }
    const typeToggle = document.querySelectorAll('.type-btn');
    typeToggle.forEach(btn => {
      btn.addEventListener('click', () => {
        typeToggle.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentType = btn.dataset.type;
        if (this.currentData.length) this.draw();
      });
    });
  },

  async load(symbol, period) {
    this.currentPeriod = period;
    const loadEl = document.getElementById('chart-loading');
    if (loadEl) loadEl.style.display = 'flex';
    const data = await DATA.fetchHistory(symbol, period);
    if (loadEl) loadEl.style.display = 'none';
    this.currentData = data;
    this.draw();
    if (data.length >= 15) ANALYSIS.run(data, symbol);
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
    const H = 280;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const isDark = !document.body.classList.contains('light-mode');
    const clr = {
      up: '#E24B4A', dn: '#1D9E75', grid: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      text: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)',
      ma5:'#EF9F27', ma20:'#378ADD', ma60:'#D4537E',
    };

    const data = this.currentData;
    const n = data.length;
    const PAD = { l:6, r:52, t:16, b:28 };
    const chartW = W - PAD.l - PAD.r;
    const barW = Math.max(1, Math.min(12, Math.floor(chartW / n) - 1));
    const gap = (chartW - barW * n) / (n - 1 || 1);

    const closes = data.map(d => d.c);
    const ma5 = this._ma(closes, 5);
    const ma20 = this._ma(closes, 20);
    const ma60 = this._ma(closes, 60);

    const allPrices = data.flatMap(d => [d.h, d.l]);
    const minP = Math.min(...allPrices) * 0.998;
    const maxP = Math.max(...allPrices) * 1.002;
    const priceRange = maxP - minP || 1;

    const xOf = i => PAD.l + i * (barW + gap) + barW / 2;
    const yOf = p => PAD.t + (1 - (p - minP) / priceRange) * (H - PAD.t - PAD.b);

    // Grid lines
    ctx.strokeStyle = clr.grid; ctx.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(r => {
      const y = PAD.t + r * (H - PAD.t - PAD.b);
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
      const p = maxP - r * priceRange;
      ctx.fillStyle = clr.text; ctx.font = '10px monospace';
      ctx.textAlign = 'left'; ctx.fillText(p.toFixed(1), W - PAD.r + 3, y + 3);
    });

    if (this.currentType === 'line') {
      // Line chart
      ctx.beginPath(); ctx.strokeStyle = clr.up; ctx.lineWidth = 1.5;
      data.forEach((d, i) => {
        const x = xOf(i), y = yOf(d.c);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    } else {
      // Candles
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

    // MA lines
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
    drawMA(ma5, clr.ma5); drawMA(ma20, clr.ma20); drawMA(ma60, clr.ma60);

    // X-axis dates
    ctx.fillStyle = clr.text; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    const step = Math.ceil(n / 6);
    for (let i = 0; i < n; i += step) {
      const d = data[i];
      const label = new Date(d.t).toLocaleDateString('zh-TW', { month:'2-digit', day:'2-digit' });
      ctx.fillText(label, xOf(i), H - 6);
    }

    // Crosshair on hover
    this._setupCrosshair(canvas, data, xOf, yOf, PAD, W, H, barW, gap);
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

    const data = this.currentData;
    const n = data.length;
    const PAD = { l:6, r:52, t:4, b:4 };
    const chartW = W - PAD.l - PAD.r;
    const barW = Math.max(1, Math.min(12, Math.floor(chartW / n) - 1));
    const gap = (chartW - barW * n) / (n - 1 || 1);
    const maxV = Math.max(...data.map(d => d.v)) || 1;

    const isDark = !document.body.classList.contains('light-mode');
    data.forEach((d, i) => {
      const x = PAD.l + i * (barW + gap);
      const isUp = d.c >= d.o;
      ctx.fillStyle = isUp ? 'rgba(226,75,74,0.55)' : 'rgba(29,158,117,0.55)';
      const bh = Math.max(1, (d.v / maxV) * (H - PAD.t - PAD.b));
      ctx.fillRect(x, H - PAD.b - bh, barW, bh);
    });
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
    const start = 25;

    const isDark = !document.body.classList.contains('light-mode');
    const grid = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    const textC = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)';

    const PAD = { l:6, r:52, t:14, b:20 };
    const chartW = W - PAD.l - PAD.r;
    const visN = hists.length;
    const barW = Math.max(1, Math.floor(chartW / visN) - 1);
    const gap = (chartW - barW * visN) / (visN - 1 || 1);
    const absMax = Math.max(...hists.map(Math.abs), 0.001) * 1.1;
    const mid = PAD.t + (H - PAD.t - PAD.b) / 2;
    const yOf = v => mid - (v / absMax) * ((H - PAD.t - PAD.b) / 2);

    // Grid
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.l, mid); ctx.lineTo(W - PAD.r, mid); ctx.stroke();
    ctx.fillStyle = textC; ctx.font = '9px monospace'; ctx.textAlign = 'left';
    ctx.fillText('MACD', W - PAD.r + 3, PAD.t + 8);

    // Histogram bars
    hists.forEach((h, i) => {
      const x = PAD.l + i * (barW + gap);
      const y = yOf(h);
      const bh = Math.abs(y - mid);
      ctx.fillStyle = h >= 0 ? 'rgba(226,75,74,0.7)' : 'rgba(29,158,117,0.7)';
      ctx.fillRect(x, Math.min(y, mid), barW, Math.max(1, bh));
    });

    // MACD & Signal lines
    const xOf = i => PAD.l + i * (barW + gap) + barW / 2;
    const drawLine = (arr, color) => {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      arr.forEach((v, i) => { i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)); });
      ctx.stroke();
    };
    drawLine(macdArr, '#378ADD');
    drawLine(sigArr, '#EF9F27');
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
      const low = Math.min(...slice.map(x => x.l));
      const rsv = high === low ? 50 : (data[i].c - low) / (high - low) * 100;
      K = 2/3 * K + 1/3 * rsv;
      D = 2/3 * D + 1/3 * K;
      Ks.push(K); Ds.push(D);
    }

    const PAD = { l:6, r:52, t:14, b:20 };
    const chartW = W - PAD.l - PAD.r;
    const n = Ks.length;
    const barW = Math.max(1, Math.floor(chartW / n) - 1);
    const gap = (chartW - barW * n) / (n - 1 || 1);
    const yOf = v => PAD.t + (1 - v / 100) * (H - PAD.t - PAD.b);
    const xOf = i => PAD.l + i * (barW + gap) + barW / 2;

    // Grid lines at 20/50/80
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
    drawLine(Ks, '#E24B4A');
    drawLine(Ds, '#378ADD');
  },

  _setupCrosshair(canvas, data, xOf, yOf, PAD, W, H, barW, gap) {
    const tt = document.getElementById('chart-tt');
    const cv = document.getElementById('cv');
    const ch = document.getElementById('ch');
    canvas.onmousemove = e => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const n = data.length;
      const chartW = W - PAD.l - PAD.r;
      const idx = Math.max(0, Math.min(n - 1, Math.round((mx - PAD.l) / (chartW / n))));
      const d = data[idx];
      const x = xOf(idx); const y = yOf(d.c);
      if (cv) { cv.style.left = x + 'px'; cv.style.opacity = '1'; }
      if (ch) { ch.style.top = y + 'px'; ch.style.opacity = '1'; }
      if (tt) {
        const date = new Date(d.t).toLocaleDateString('zh-TW');
        const chg = d.c - d.o;
        tt.innerHTML = `<span>${date}</span> 開${d.o} 高${d.h} 低${d.l} <b>收${d.c}</b> <span style="color:${chg>=0?'#E24B4A':'#1D9E75'}">${chg>=0?'▲':'▼'}${Math.abs(chg).toFixed(2)}</span>`;
        tt.style.opacity = '1';
      }
    };
    canvas.onmouseleave = () => {
      if (cv) cv.style.opacity = '0';
      if (ch) ch.style.opacity = '0';
      if (tt) tt.style.opacity = '0';
    };
  },

  _ma(arr, period) {
    return arr.map((_, i) => {
      if (i < period - 1) return null;
      return arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b) / period;
    });
  },
};
