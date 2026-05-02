// ── app.js  ── Main orchestration, order calc, notifications

// ── ORDER module ──────────────────────────────────────────
const ORDER = {
  suggestEntry: 0,
  suggestSL: 0,
  suggestTP: 0,
  score: 0,

  calc() {
    const budget   = parseFloat(document.getElementById('budget')?.value) || 100000;
    const strategy = document.getElementById('strategy-select')?.value ?? 'auto';
    const price    = this.suggestEntry || APP.getActiveStock()?.price || 100;
    if (!price) return;

    const pricePerLot = price * 1000; // 1 張 = 1000 股

    // Determine batch count
    let batches = 3;
    if (strategy === 'single') batches = 1;
    else if (strategy === 'batch2') batches = 2;
    else if (strategy === 'batch3') batches = 3;
    else if (strategy === 'batch4') batches = 4;
    else {
      // auto: decide by budget & signal strength
      if (budget < pricePerLot * 2) batches = 1;
      else if (budget < pricePerLot * 4 || this.score < 2) batches = 2;
      else if (this.score >= 3) batches = 4;
      else batches = 3;
    }

    // Batch ratios and price offsets
    const configs = {
      1: { ratios: [1],                    offsets: [0] },
      2: { ratios: [0.6, 0.4],             offsets: [0, -0.025] },
      3: { ratios: [0.4, 0.35, 0.25],      offsets: [0, -0.025, -0.05] },
      4: { ratios: [0.3, 0.25, 0.25, 0.2], offsets: [0, -0.02, -0.04, -0.06] },
    };
    const { ratios, offsets } = configs[batches];

    const tbody = document.getElementById('order-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let totalCost = 0;
    let totalLots = 0;

    ratios.forEach((ratio, i) => {
      const batchBudget = budget * ratio;
      const batchPrice  = +(price * (1 + offsets[i])).toFixed(1);
      const lots        = Math.max(1, Math.floor(batchBudget / (batchPrice * 1000)));
      const cost        = lots * batchPrice * 1000;
      totalCost += cost;
      totalLots += lots;

      const batchLabel = batches > 1 ? `第 ${i+1} 批` : '進場';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="td-batch">${batchLabel}<br><small style="font-family:var(--font-sans);color:var(--text-3);font-size:10px">預算 ${(budget*ratio/10000).toFixed(1)}萬</small></td>
        <td class="td-price">$${batchPrice}</td>
        <td class="td-shares">${lots} 張</td>
        <td class="td-amount">${(cost/10000).toFixed(2)} 萬</td>
        <td class="td-pct">${(ratio*100).toFixed(0)}%</td>`;
      tbody.appendChild(tr);
    });

    const footer = document.getElementById('order-footer');
    if (footer) {
      const remain = budget - totalCost;
      footer.innerHTML = `
        <span>合計：<strong>${totalLots} 張</strong>，投入 <strong>${(totalCost/10000).toFixed(2)} 萬</strong></span>
        <span>剩餘現金：${(remain/10000).toFixed(2)} 萬（${(remain/budget*100).toFixed(0)}%）</span>`;
    }
  },
};

// ── APP module ────────────────────────────────────────────
const APP = {
  // Portfolio: array of { code, name, shares, cost, date, price, prevClose }
  portfolio: JSON.parse(localStorage.getItem('twsa-portfolio') || '[]'),
  watchlist: JSON.parse(localStorage.getItem('twsa-watchlist') || '[]'),
  activeSymbol: '',
  activeIdx: -1,
  refreshTimer: null,
  notifyRules: JSON.parse(localStorage.getItem('twsa-notify-rules') || '[]'),
  settings: JSON.parse(localStorage.getItem('twsa-settings') || '{}'),

  // ── Bootstrap ────────────────────────────────────────
  async init() {
    CHART.init();
    this._loadSettings();
    this._setupTabs();

    // Default demo data if empty
    if (this.portfolio.length === 0) {
      this.portfolio = [
        { code: '2330', name: '台積電',    shares: 2, cost: 898,  date: '2024-01-15' },
        { code: '0050', name: '元大台灣50', shares: 5, cost: 208,  date: '2024-03-01' },
        { code: '2454', name: '聯發科',    shares: 1, cost: 1380, date: '2024-06-10' },
      ];
      this.save();
    }
    if (this.watchlist.length === 0) {
      this.watchlist = [
        { code: '6505', name: '台塑化' },
        { code: '2317', name: '鴻海' },
        { code: '3008', name: '大立光' },
      ];
      this.save();
    }

    // Init prices to cost
    this.portfolio.forEach(s => {
      s.price     = s.price     ?? s.cost;
      s.prevClose = s.prevClose ?? s.cost;
    });
    this.watchlist.forEach(s => {
      s.price     = s.price     ?? 0;
      s.prevClose = s.prevClose ?? 0;
    });

    this.renderAll();
    this.updateClock();
    this._updateMarketStatus();

    // Fetch prices then render
    await this.refreshPrices();

    // Auto-select first stock
    if (this.portfolio.length > 0) {
      this.selectStock(this.portfolio[0].code, 0, 'portfolio');
    }

    // Auto-refresh every 60s
    this.refreshTimer = setInterval(() => this.refreshPrices(), 60000);
    setInterval(() => this.updateClock(), 1000);
    setInterval(() => this._checkNotifications(), 30000);

    // Fetch indexes
    DATA.fetchIndexes();
    setInterval(() => DATA.fetchIndexes(), 120000);
  },

  // ── Clock & market status ──────────────────────────────
  updateClock() {
    const now = new Date();
    document.getElementById('clock').textContent =
      now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  },

  _updateMarketStatus() {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const isWeekday = now.getDay() >= 1 && now.getDay() <= 5;
    const afterOpen = h > 9 || (h === 9 && m >= 0);
    const beforeClose = h < 13 || (h === 13 && m <= 30);
    const isOpen = isWeekday && afterOpen && beforeClose;
    const el = document.getElementById('mkt-status');
    if (el) {
      el.textContent = isOpen ? '市場開盤中' : '休市';
      el.className = isOpen ? 'badge' : 'badge closed';
    }
    const dot = document.getElementById('live-dot');
    if (dot) dot.style.opacity = isOpen ? '1' : '0.3';
  },

  // ── Refresh all prices ───────────────────────────────
  async refreshPrices() {
    const btn = document.querySelector('.icon-btn[onclick="refreshAll()"]');
    if (btn) btn.style.opacity = '0.5';

    // Mark items as loading
    document.querySelectorAll('.stock-item').forEach(el => el.classList.add('loading-price'));

    await DATA.updateAllPrices(this.portfolio, () => {
      this.renderPortfolioSummary();
      this.renderStockList();
    });
    await DATA.updateAllPrices(this.watchlist, () => {
      this.renderWatchlist();
    });

    document.querySelectorAll('.stock-item').forEach(el => el.classList.remove('loading-price'));
    if (btn) btn.style.opacity = '1';

    this._updateMarketStatus();
    this._checkNotifications();
    showToast('報價已更新');
  },

  // ── Render ───────────────────────────────────────────
  renderAll() {
    this.renderPortfolioSummary();
    this.renderStockList();
    this.renderWatchlist();
  },

  renderPortfolioSummary() {
    let totalVal = 0, totalCost = 0, dayPnl = 0;
    this.portfolio.forEach(s => {
      const price = s.price ?? s.cost;
      const prev  = s.prevClose ?? s.cost;
      totalVal  += price * s.shares * 1000;
      totalCost += s.cost  * s.shares * 1000;
      dayPnl    += (price - prev) * s.shares * 1000;
    });
    const pnl    = totalVal - totalCost;
    const roi    = totalCost > 0 ? pnl / totalCost * 100 : 0;
    const dayPct = totalCost > 0 ? dayPnl / totalCost * 100 : 0;

    const fmt = n => {
      const abs = Math.abs(n);
      if (abs >= 1e6) return (n / 1e4).toFixed(1) + '萬';
      return n.toFixed(0);
    };

    setText('total-value', (totalVal / 10000).toFixed(1) + '萬', 'neutral');
    setText('total-cost',  '成本 ' + (totalCost / 10000).toFixed(1) + '萬', '');
    setSignedText('total-pnl',     pnl,    fmt);
    setSignedText('total-pnl-pct', roi,    v => v.toFixed(2) + '%', true);
    setSignedText('day-pnl',       dayPnl, fmt);
    setSignedText('day-pnl-pct',   dayPct, v => v.toFixed(2) + '%', true);
    setSignedText('total-roi',     roi,    v => v.toFixed(2) + '%', true);
    setText('stock-count', this.portfolio.length + ' 檔持股', '');
  },

  renderStockList() {
    const list = document.getElementById('stock-list');
    if (!list) return;
    list.innerHTML = '';
    this.portfolio.forEach((s, i) => {
      const price = s.price ?? s.cost;
      const prev  = s.prevClose ?? s.cost;
      const chg   = price - prev;
      const chgPct = prev ? chg / prev * 100 : 0;
      const pnl    = (price - s.cost) * s.shares * 1000;
      const pnlPct = (price - s.cost) / s.cost * 100;
      const isUp   = chg >= 0;
      const barW   = Math.min(Math.abs(chgPct) / 3, 1) * 100;
      const isActive = s.code === this.activeSymbol;

      const div = document.createElement('div');
      div.className = 'stock-item' + (isActive ? ' active' : '');
      div.onclick = () => this.selectStock(s.code, i, 'portfolio');
      div.innerHTML = `
        <div class="si-row1">
          <span class="si-code">${s.code}</span>
          <span class="si-price ${isUp ? 'up-color' : 'dn-color'}">${price.toFixed(2)}</span>
        </div>
        <div class="si-row2">
          <span class="si-name">${s.name}</span>
          <span class="si-shares">${s.shares}張</span>
        </div>
        <div class="si-row3">
          <span class="${isUp ? 'up-color' : 'dn-color'}">${isUp ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)} (${Math.abs(chgPct).toFixed(2)}%)</span>
          <span style="color:${pnl >= 0 ? 'var(--red)' : 'var(--green-l)'}">損益 ${pnl >= 0 ? '+' : ''}${(pnl / 10000).toFixed(2)}萬</span>
        </div>
        <div class="si-bar-wrap">
          <div class="si-bar ${isUp ? 'bar-up' : 'bar-dn'}" style="width:${barW}%"></div>
        </div>`;
      list.appendChild(div);
    });
  },

  renderWatchlist() {
    const wrap = document.getElementById('watchlist');
    if (!wrap) return;
    wrap.innerHTML = '';
    this.watchlist.forEach((s, i) => {
      const price = s.price ?? 0;
      const prev  = s.prevClose ?? price;
      const chg   = price - prev;
      const chgPct = prev ? chg / prev * 100 : 0;
      const isUp  = chg >= 0;
      const div   = document.createElement('div');
      div.className = 'watch-item';
      div.innerHTML = `
        <div class="wi-left" onclick="APP.selectStock('${s.code}', ${i}, 'watch')">
          <div class="wi-code">${s.code}</div>
          <div class="wi-name">${s.name}</div>
        </div>
        <div class="wi-right" onclick="APP.selectStock('${s.code}', ${i}, 'watch')">
          <div class="wi-price ${isUp ? 'up-color' : 'dn-color'}">${price > 0 ? price.toFixed(2) : '—'}</div>
          <div class="wi-change ${isUp ? 'up-color' : 'dn-color'}">${price > 0 ? (isUp ? '+' : '') + chgPct.toFixed(2) + '%' : ''}</div>
        </div>
        <button class="watch-del" onclick="APP.removeWatch(${i})" title="移除">✕</button>`;
      wrap.appendChild(div);
    });
  },

  // ── Stock selection ──────────────────────────────────
  async selectStock(code, idx, source) {
    this.activeSymbol = code;
    this.activeIdx    = idx;
    this._source      = source;

    // Update chart header
    const s = source === 'portfolio' ? this.portfolio[idx] : this.watchlist[idx];
    if (s) {
      document.getElementById('chart-name').textContent = `${s.name} ${s.code}`;
      const price = s.price ?? 0;
      const prev  = s.prevClose ?? price;
      const chg   = price - prev;
      const chgPct = prev ? chg / prev * 100 : 0;
      document.getElementById('chart-price').textContent = price > 0 ? price.toFixed(2) : '—';
      const changeEl = document.getElementById('chart-change');
      changeEl.textContent = price > 0 ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)` : '';
      changeEl.className = 'chart-change ' + (chg >= 0 ? 'up-color' : 'dn-color');
    }

    this.renderStockList();

    // Load chart data
    const activePeriod = document.querySelector('.period-btn.active')?.dataset.period ?? '3mo';
    await CHART.load(code, activePeriod);

    if (document.getElementById('auto-analyze')?.checked !== false) {
      ORDER.calc();
    }
  },

  getActiveStock() {
    if (!this.activeSymbol) return null;
    return this.portfolio.find(s => s.code === this.activeSymbol) ||
           this.watchlist.find(s => s.code === this.activeSymbol) || null;
  },

  // ── Tabs ─────────────────────────────────────────────
  _setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        document.getElementById(`pane-${btn.dataset.tab}`)?.classList.add('active');
        if (btn.dataset.tab === 'tech' && CHART.currentData.length) {
          CHART.drawMACD(CHART.currentData);
          CHART.drawKD(CHART.currentData);
        }
      });
    });
  },

  // ── Add / remove portfolio ───────────────────────────
  save() {
    localStorage.setItem('twsa-portfolio', JSON.stringify(this.portfolio));
    localStorage.setItem('twsa-watchlist', JSON.stringify(this.watchlist));
  },

  // ── Notifications ────────────────────────────────────
  _checkNotifications() {
    const email = document.getElementById('notify-email')?.value;
    if (!email || !this.notifyRules.length) return;
    this.notifyRules.forEach((rule, idx) => {
      if (rule.triggered) return;
      const stock = this.portfolio.find(s => s.code === rule.code) ||
                    this.watchlist.find(s => s.code === rule.code);
      if (!stock) return;
      const price = stock.price ?? 0;
      let shouldTrigger = false;
      if (rule.condition === 'reach' && price <= rule.targetPrice) shouldTrigger = true;
      if (rule.condition === 'break-up' && price >= rule.targetPrice) shouldTrigger = true;
      if (rule.condition === 'break-down' && price <= rule.targetPrice) shouldTrigger = true;
      if (rule.condition === 'rsi-oversold') {
        // Would need ANALYSIS data - skip for now
      }
      if (shouldTrigger) {
        this._sendEmail(email, rule, stock, price);
        rule.triggered = true;
      }
    });
  },

  _sendEmail(toEmail, rule, stock, price) {
    const s = this.settings;
    if (!s.ejsService || !s.ejsTemplate || !s.ejsPubkey) {
      console.warn('[NOTIFY] EmailJS not configured');
      showToast('⚠ EmailJS 尚未設定，請至設定頁填入金鑰');
      return;
    }
    if (typeof emailjs === 'undefined') return;
    emailjs.init(s.ejsPubkey);
    emailjs.send(s.ejsService, s.ejsTemplate, {
      to_email:   toEmail,
      stock_code: stock.code,
      stock_name: stock.name,
      condition:  rule.condition,
      price:      price.toFixed(2),
      target:     rule.targetPrice,
      time:       new Date().toLocaleString('zh-TW'),
      suggest_entry: ORDER.suggestEntry,
      suggest_sl:    ORDER.suggestSL,
      suggest_tp:    ORDER.suggestTP,
    }).then(() => {
      showToast(`✉ 已發送通知 → ${toEmail}`);
    }).catch(err => {
      console.error('[EmailJS]', err);
      showToast('Email 發送失敗，請確認 EmailJS 設定');
    });
  },

  // ── Settings ─────────────────────────────────────────
  _loadSettings() {
    const s = this.settings;
    if (s.corsProxy) DATA.corsProxy = s.corsProxy;
    if (s.ejsService)  document.getElementById('ejs-service')?.setAttribute('value', s.ejsService);
    if (s.ejsTemplate) document.getElementById('ejs-template')?.setAttribute('value', s.ejsTemplate);
    if (s.ejsPubkey)   document.getElementById('ejs-pubkey')?.setAttribute('value', s.ejsPubkey);
    if (s.corsProxy)   document.getElementById('cors-proxy')?.setAttribute('value', s.corsProxy);
    if (s.darkMode === false) document.body.classList.add('light-mode');
    const toggle = document.getElementById('dark-mode-toggle');
    if (toggle) toggle.checked = s.darkMode !== false;
  },
};

// ── Global functions (called from HTML) ───────────────────

function refreshAll() { APP.refreshPrices(); }
function openSettings() { document.getElementById('settings-modal').classList.add('show'); }
function runAnalysis() {
  if (CHART.currentData.length) ANALYSIS.run(CHART.currentData, APP.activeSymbol);
  else showToast('請先選擇股票');
}

function openAddModal() {
  // Set default date to today
  const today = new Date().toISOString().split('T')[0];
  const dateEl = document.getElementById('m-date');
  if (dateEl) dateEl.value = today;
  document.getElementById('add-modal').classList.add('show');
}
function openWatchlistModal() { document.getElementById('watch-modal').classList.add('show'); }

function closeModal(id) { document.getElementById(id)?.classList.remove('show'); }

function addStock() {
  const code   = document.getElementById('m-code')?.value.trim();
  const name   = document.getElementById('m-name')?.value.trim();
  const shares = parseInt(document.getElementById('m-shares')?.value) || 1;
  const cost   = parseFloat(document.getElementById('m-cost')?.value);
  const date   = document.getElementById('m-date')?.value;
  if (!code || !name || !cost) { showToast('請填寫必填欄位'); return; }
  APP.portfolio.push({ code, name, shares, cost, date: date || '', price: cost, prevClose: cost });
  APP.save();
  APP.renderAll();
  closeModal('add-modal');
  showToast(`已新增 ${name} (${code})`);
  // Fetch real price
  DATA.fetchQuote(code).then(q => {
    const s = APP.portfolio.find(x => x.code === code);
    if (s && q.ok && q.price) { s.price = q.price; s.prevClose = q.prevClose; APP.renderAll(); }
  });
  ['m-code','m-name','m-shares','m-cost'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

function addWatchlist() {
  const code = document.getElementById('w-code')?.value.trim();
  const name = document.getElementById('w-name')?.value.trim();
  if (!code || !name) { showToast('請填寫代號與名稱'); return; }
  if (APP.watchlist.find(x => x.code === code)) { showToast('已存在於自選清單'); return; }
  APP.watchlist.push({ code, name, price: 0, prevClose: 0 });
  APP.save();
  APP.renderWatchlist();
  closeModal('watch-modal');
  showToast(`已加入自選：${name}`);
  document.getElementById('w-code').value = '';
  document.getElementById('w-name').value = '';
  DATA.fetchQuote(code).then(q => {
    const s = APP.watchlist.find(x => x.code === code);
    if (s && q.ok && q.price) { s.price = q.price; s.prevClose = q.prevClose; APP.renderWatchlist(); }
  });
}

APP.removeWatch = function(idx) {
  const s = this.watchlist[idx];
  this.watchlist.splice(idx, 1);
  this.save();
  this.renderWatchlist();
  showToast(`已移除 ${s.name}`);
};

function saveSettings() {
  const s = APP.settings;
  s.ejsService  = document.getElementById('ejs-service')?.value.trim();
  s.ejsTemplate = document.getElementById('ejs-template')?.value.trim();
  s.ejsPubkey   = document.getElementById('ejs-pubkey')?.value.trim();
  s.corsProxy   = document.getElementById('cors-proxy')?.value.trim();
  localStorage.setItem('twsa-settings', JSON.stringify(s));
  if (s.corsProxy) DATA.corsProxy = s.corsProxy;
  closeModal('settings-modal');
  showToast('設定已儲存');
}

function toggleDarkMode(checked) {
  document.body.classList.toggle('light-mode', !checked);
  APP.settings.darkMode = checked;
  localStorage.setItem('twsa-settings', JSON.stringify(APP.settings));
}

function setNotification() {
  const email     = document.getElementById('notify-email')?.value;
  const condition = document.getElementById('notify-condition')?.value;
  if (!email) { showToast('請輸入 Email'); return; }
  const targetPrice = ORDER.suggestEntry || APP.getActiveStock()?.price || 0;
  const stock = APP.getActiveStock();
  if (!stock) { showToast('請先選擇股票'); return; }
  APP.notifyRules.push({
    code: stock.code, name: stock.name,
    condition, targetPrice, triggered: false,
    createdAt: new Date().toISOString(),
  });
  localStorage.setItem('twsa-notify-rules', JSON.stringify(APP.notifyRules));
  const fb = document.getElementById('notify-feedback');
  if (fb) {
    fb.textContent = `✓ 已設定：${stock.name} ${condition} $${targetPrice}，通知 ${email}`;
    setTimeout(() => { fb.textContent = ''; }, 5000);
  }
  showToast('通知規則已設定');
}

// ── Helpers ───────────────────────────────────────────────
function setText(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (cls !== undefined) el.className = el.className.replace(/\b(up|dn|neutral)\b/g, '') + ' ' + cls;
}

function setSignedText(id, val, fmtFn, isPct = false) {
  const el = document.getElementById(id);
  if (!el) return;
  const isUp = val >= 0;
  el.textContent = (isUp ? '+' : '') + fmtFn(val);
  el.className = el.className.replace(/\b(up|dn|neutral)\b/g, '') + (isUp ? ' up' : ' dn');
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ── Modal overlay click to close ─────────────────────────
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('show');
  });
});

// ── Start ─────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => APP.init());
window.addEventListener('resize', () => { if (CHART.currentData.length) CHART.draw(); });

// ── NEWS & SELL integration ────────────────────────────────

// News tab switching
document.querySelectorAll('.news-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.news-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.news-pane').forEach(p => p.classList.remove('active'));
    document.getElementById(`npane-${tab.dataset.ntab}`)?.classList.add('active');
  });
});

// ── Fear gauge canvas ──────────────────────────────────────
function drawFearGauge(level) {
  const canvas = document.getElementById('fearGauge');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = 160, H = 90;
  canvas.width = W * (window.devicePixelRatio || 1);
  canvas.height = H * (window.devicePixelRatio || 1);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2, cy = H - 10, r = 64;
  // Gradient arc background
  const gradient = [
    [0,  0.2,  '#1D9E75'],
    [0.2,0.4,  '#5DCAA5'],
    [0.4,0.6,  '#888780'],
    [0.6,0.8,  '#F0997B'],
    [0.8,1.0,  '#E24B4A'],
  ];
  gradient.forEach(([from, to, color]) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI + from * Math.PI, Math.PI + to * Math.PI);
    ctx.lineWidth = 14;
    ctx.strokeStyle = color;
    ctx.lineCap = 'butt';
    ctx.stroke();
  });

  // Needle
  const angle = Math.PI + (level / 100) * Math.PI;
  const nx = cx + (r - 14) * Math.cos(angle);
  const ny = cy + (r - 14) * Math.sin(angle);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(nx, ny);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();

  // Value
  const fearEl = document.getElementById('fear-value');
  const labelEl = document.getElementById('fear-label');
  if (fearEl) {
    fearEl.textContent = level;
    fearEl.style.color = level < 30 ? 'var(--green-l)' : level > 70 ? 'var(--red)' : 'var(--amber)';
  }
  if (labelEl) labelEl.textContent = level < 20 ? '極度恐慌' : level < 40 ? '恐慌' : level < 60 ? '中性' : level < 80 ? '貪婪' : '極度貪婪';
}

// ── Render news list ───────────────────────────────────────
function renderNewsList(items, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div class="news-empty">暫無新聞資料（可能受 CORS 限制）</div>';
    return;
  }
  const annotated = NEWS.annotateNews(items);
  el.innerHTML = annotated.map(item => {
    const s = item.sentiment;
    const dotCls = s >= 2 ? 'dot-very-pos' : s > 0 ? 'dot-pos' : s < -1 ? 'dot-very-neg' : s < 0 ? 'dot-neg' : 'dot-neu';
    const timeAgo = item.pubDate ? _timeAgo(item.pubDate) : '';
    return `<a class="news-item" href="${item.link}" target="_blank" rel="noopener">
      <div class="news-sentiment-dot ${dotCls}"></div>
      <div class="news-body">
        <div class="news-title">${item.title}</div>
        <div class="news-meta">
          <span class="news-source">${item.source ?? ''}</span>
          <span>${timeAgo}</span>
        </div>
      </div>
    </a>`;
  }).join('');
}

function _timeAgo(date) {
  const diff = (Date.now() - new Date(date).getTime()) / 1000;
  if (diff < 60) return '剛剛';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小時前';
  return Math.floor(diff / 86400) + ' 天前';
}

// ── Render sentiment bars ──────────────────────────────────
function renderSentimentBars(counts, total) {
  const el = document.getElementById('sentiment-bars');
  if (!el) return;
  const items = [
    { label: '極樂觀', cls: 'sb-very-pos', key: 'very_positive' },
    { label: '偏多',   cls: 'sb-pos',      key: 'positive' },
    { label: '中性',   cls: 'sb-neu',      key: 'neutral' },
    { label: '偏空',   cls: 'sb-neg',      key: 'negative' },
    { label: '極悲觀', cls: 'sb-very-neg', key: 'very_negative' },
  ];
  const max = Math.max(...Object.values(counts), 1);
  el.innerHTML = items.map(it => {
    const n = counts[it.key] || 0;
    const w = Math.round((n / max) * 100);
    return `<div class="sb-row">
      <span class="sb-label">${it.label}</span>
      <div class="sb-bar-wrap"><div class="sb-bar ${it.cls}" style="width:${w}%"></div></div>
      <span class="sb-count">${n}</span>
    </div>`;
  }).join('');
}

// ── Render market chips ────────────────────────────────────
function renderMarketChips(fearIndex, stockSentiment, marketSentiment) {
  const el = document.getElementById('mkt-chips');
  if (!el) return;
  const chips = [];

  // VIX proxy: derived from fear level
  const vix = Math.round(10 + (100 - fearIndex.level) * 0.4);
  chips.push({ label: `VIX 估算 ${vix}`, cls: vix > 30 ? 'warn' : vix > 20 ? 'neu' : 'bull' });

  // Foreign investor direction (derived from market news)
  const mktScore = marketSentiment?.score ?? 0;
  chips.push({ label: `外資方向：${mktScore > 0.3 ? '買超' : mktScore < -0.3 ? '賣超' : '觀望'}`, cls: mktScore > 0.3 ? 'bull' : mktScore < -0.3 ? 'bear' : 'neu' });

  // Institutional direction
  chips.push({ label: `法人：${fearIndex.level > 55 ? '偏多' : fearIndex.level < 40 ? '偏空' : '中性'}`, cls: fearIndex.level > 55 ? 'bull' : fearIndex.level < 40 ? 'bear' : 'neu' });

  // News trend
  const sScore = stockSentiment?.score ?? 0;
  chips.push({ label: `個股新聞：${stockSentiment?.label ?? '無資料'}`, cls: sScore > 0.5 ? 'bull' : sScore < -0.5 ? 'bear' : 'neu' });

  // Overall market
  chips.push({ label: `市場情緒：${fearIndex.label}`, cls: fearIndex.level < 35 ? 'bear' : fearIndex.level > 65 ? 'bull' : fearIndex.level < 45 ? 'warn' : 'neu' });

  el.innerHTML = chips.map(c => `<span class="mkt-chip ${c.cls}">${c.label}</span>`).join('');
}

// ── Render sell signals ────────────────────────────────────
function renderSellSignals(result) {
  if (!result) return;
  const { signals, urgency, plan } = result;

  const badge = document.getElementById('sell-urgency-badge');
  if (badge) {
    const labels = { none: '無賣出訊號', watch: '觀察減碼', sell: '建議出場', urgent: '緊急減碼', emergency: '⚠ 緊急離場' };
    badge.textContent = labels[urgency] ?? urgency;
    badge.className = `sell-urgency-badge ${urgency}`;
  }

  const banner = document.getElementById('emergency-banner');
  if (banner) banner.style.display = urgency === 'emergency' ? 'flex' : 'none';

  const wrap = document.getElementById('sell-signals-wrap');
  if (wrap) {
    if (!signals.length) {
      wrap.innerHTML = '<div class="sell-signals-empty">目前無明顯賣出訊號，持有觀察</div>';
    } else {
      const icons = { watch: '◎', sell: '▼', urgent: '!', emergency: '⚠' };
      wrap.innerHTML = signals.map(s => `
        <div class="sell-signal-item ${s.urgency}">
          <div class="ss-icon ${s.urgency}">${icons[s.urgency] ?? '•'}</div>
          <div class="ss-body">
            <div class="ss-label ${s.urgency}">${s.label}</div>
            <div class="ss-desc">${s.desc}</div>
          </div>
        </div>`).join('');
    }
  }

  const planWrap = document.getElementById('sell-plan-wrap');
  if (planWrap) {
    if (!plan) { planWrap.style.display = 'none'; return; }
    planWrap.style.display = 'block';
    const titleEl = document.getElementById('sell-plan-title');
    if (titleEl) { titleEl.textContent = plan.title; titleEl.className = `sell-plan-title ${plan.color}`; }
    const rowsEl = document.getElementById('sell-plan-rows');
    if (rowsEl) {
      rowsEl.innerHTML = plan.rows.map(r => `
        <div class="sell-plan-row">
          <span class="spr-batch">${r.batch}</span>
          <span class="spr-action">${r.action}</span>
          <span class="spr-desc">${r.desc}</span>
        </div>`).join('');
    }
    const noteEl = document.getElementById('sell-plan-note');
    if (noteEl) noteEl.textContent = plan.note ?? '';
  }
}

// ── Main news refresh ──────────────────────────────────────
async function refreshNews() {
  const btn = document.getElementById('news-refresh-btn');
  if (btn) { btn.textContent = '更新中...'; btn.disabled = true; }

  const stock = APP.getActiveStock();

  try {
    // Fetch market news (always)
    const marketItems = await NEWS.fetchMarketNews();
    renderNewsList(marketItems, 'market-news-list');
    const marketSentiment = NEWS.scoreSentiment(marketItems);
    const fearIndex = NEWS.calcFearIndex(marketItems);

    // Draw fear gauge
    drawFearGauge(fearIndex.level);
    renderSentimentBars(marketSentiment.counts, marketItems.length);

    // Stock news
    let stockSentiment = null;
    if (stock) {
      const stockItems = await NEWS.fetchStockNews(stock.code, stock.name);
      renderNewsList(stockItems, 'stock-news-list');
      stockSentiment = NEWS.scoreSentiment(stockItems);

      const summaryEl = document.getElementById('stock-sentiment-summary');
      if (summaryEl) {
        summaryEl.style.display = 'flex';
        const sColor = stockSentiment.score > 0.5 ? 'var(--red)' : stockSentiment.score < -0.5 ? 'var(--green-l)' : 'var(--amber)';
        summaryEl.innerHTML = `
          <div class="nss-score" style="color:${sColor}">${stockSentiment.score > 0 ? '+' : ''}${stockSentiment.score}</div>
          <span class="nss-sep">|</span>
          <div class="nss-label">情緒：<strong>${stockSentiment.label}</strong>（${Object.values(stockSentiment.counts).reduce((a,b)=>a+b,0)} 則新聞）</div>`;
      }

      // Run sell evaluation
      const techInd = ANALYSIS.lastData.length ? ANALYSIS._calcIndicators(ANALYSIS.lastData) : null;
      const sellResult = SELL.evaluate({
        techInd,
        sentimentScore: stockSentiment.score,
        fearIndex,
        stock,
        currentPrice: stock.price ?? 0,
      });
      renderSellSignals(sellResult);

      // Auto-trigger email if emergency
      if (sellResult?.urgency === 'emergency') {
        const email = document.getElementById('notify-email')?.value;
        if (email) {
          APP._sendEmail(email, { condition: '緊急離場', targetPrice: stock.price }, stock, stock.price);
        }
      }
    }

    renderMarketChips(fearIndex, stockSentiment, marketSentiment);
  } catch (e) {
    console.error('[NEWS] refreshNews error:', e);
    showToast('新聞載入失敗（CORS 限制）');
  }

  if (btn) { btn.textContent = '更新'; btn.disabled = false; }
}

// Hook into APP.selectStock to trigger news refresh
const _origSelectStock = APP.selectStock.bind(APP);
APP.selectStock = async function(code, idx, source) {
  await _origSelectStock(code, idx, source);
  refreshNews();
};

// ── App init hook ──────────────────────────────────────────
const _origInit = APP.init.bind(APP);
APP.init = async function() {
  await _origInit();
  // Initial market news load
  setTimeout(() => refreshNews(), 2000);
  // Refresh news every 10 min
  setInterval(() => refreshNews(), 600000);
  // Initial fear gauge placeholder
  drawFearGauge(50);
};

function calcOrder() { ORDER.calc(); }
