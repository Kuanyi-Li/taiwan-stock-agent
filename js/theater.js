// ── theater.js ── 劇場模式：3D視覺化總覽（MVP，只做總覽頁）
// ⚠️ 設計原則：劇場模式是「外加」的呈現方式，不是取代——所有專業排版功能都完整保留，
// 使用者可以隨時透過切換按鈕或導覽選單回到專業排版。這裡不重新設計任何資料邏輯，
// 全部呼叫既有的 DATA/APP/GOALS/Performance 等模組，確保兩邊看到的數字永遠一致。
const Theater = {
  _scene: null, _camera: null, _renderer: null, _animId: null,
  _core: null, _planetGroups: [],
  _panelIntervals: [],
  _isActive: false,

  toggle() {
    const isShowing = document.getElementById('theater-content')?.style.display !== 'none';
    showMainView(isShowing ? 'dashboard' : 'theater');
  },

  goTo(target) {
    this.toggleNavMenu(false);
    if (target === 'screener') { Screener.openModal(); return; }
    if (target === 'backtest') { showMainView('backtest'); return; }
    if (target === 'detail') {
      showMainView('detail');
      if (!APP.activeSymbol && APP.portfolio.length) APP.selectStock(APP.portfolio[0].code, 0, 'portfolio');
      return;
    }
    if (target === 'calendar') { TradeCalendar.toggle(); return; }
    showMainView(target);
  },

  toggleNavMenu(forceState) {
    const menu = document.getElementById('theater-nav-menu');
    if (!menu) return;
    const show = forceState != null ? forceState : !menu.classList.contains('show');
    menu.classList.toggle('show', show);
  },

  // ── 進入/離開劇場模式的生命週期 ──────────────────────
  onEnter() {
    this._isActive = true;
    if (!this._scene) this._initScene();
    this._buildSystem();
    this._startPanels();
    if (!this._animId) this._animate();
  },

  onExit() {
    this._isActive = false;
    this._panelIntervals.forEach(id => clearInterval(id));
    this._panelIntervals = [];
    if (this._animId) { cancelAnimationFrame(this._animId); this._animId = null; }
  },

  // ── 3D場景初始化（只做一次）──────────────────────────
  _initScene() {
    const container = document.getElementById('theater-stage');
    if (!container || typeof THREE === 'undefined') return;
    const w = container.clientWidth || 900, h = container.clientHeight || 600;

    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x000000);
    this._scene.fog = new THREE.Fog(0x000000, 7, 17);

    // ★ 修正科技感不夠強的問題：加入背景星空粒子，純黑底配上球體線框太空、缺乏縱深感，
    // 灑一片遠景星點能明顯增加「身處太空」的沉浸感
    const starGeo = new THREE.BufferGeometry();
    const starCount = 800;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 12 + Math.random() * 18;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos((Math.random() * 2) - 1);
      starPositions[i*3]   = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i*3+1] = r * Math.cos(phi);
      starPositions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({ color: 0x8899aa, size: 0.045, transparent: true, opacity: 0.55 });
    this._stars = new THREE.Points(starGeo, starMat);
    this._scene.add(this._stars);

    this._camera = new THREE.PerspectiveCamera(48, w / h, 0.1, 100);
    // ★ 修正星系位置往上移：相機看向的目標點下移，畫面裡的星系相對就會往上移
    this._camera.position.set(0, 1.4, 8.2);
    this._camera.lookAt(0, -0.9, 0);

    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setSize(w, h);
    this._renderer.setPixelRatio(window.devicePixelRatio);
    container.innerHTML = '';
    container.appendChild(this._renderer.domElement);

    window.addEventListener('resize', () => this._onResize());
  },

  _onResize() {
    const container = document.getElementById('theater-stage');
    if (!container || !this._camera || !this._renderer) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(w, h);
  },

  // ★ 修正線條太細的問題：Three.js的linewidth在大多數瀏覽器/顯卡上會被忽略（WebGL已知限制），
  // 改用「同一條線疊兩次、半徑微調」的方式模擬粗線條效果，這個做法在所有瀏覽器都可靠。
  // 同時提高透明度、加亮顏色、加密經緯線數量，讓球體視覺上更扎實。
  _makeWireSphere(radius, color, opacity, latCount = 6, lonCount = 8) {
    const group = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, opacity + 0.25) });
    const addThickLine = (pts) => {
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
      // 疊一條極微幅放大的線模擬粗細感
      const ptsOuter = pts.map(p => p.clone().multiplyScalar(1.006));
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ptsOuter), mat));
    };
    for (let i = 1; i < latCount + 1; i++) {
      const phi = (i / (latCount + 1)) * Math.PI;
      const r = Math.sin(phi) * radius, y = Math.cos(phi) * radius;
      const pts = [];
      for (let a = 0; a <= 48; a++) { const t = (a / 48) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(t) * r, y, Math.sin(t) * r)); }
      addThickLine(pts);
    }
    for (let i = 0; i < lonCount; i++) {
      const rotY = (i / lonCount) * Math.PI;
      const pts = [];
      for (let a = 0; a <= 48; a++) { const t = (a / 48) * Math.PI * 2; pts.push(new THREE.Vector3(Math.sin(t) * radius, Math.cos(t) * radius, 0)); }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
      line.rotation.y = rotY;
      group.add(line);
      const lineOuter = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(p=>p.clone().multiplyScalar(1.006))), mat);
      lineOuter.rotation.y = rotY;
      group.add(lineOuter);
    }
    return group;
  },

  // ── 用真實持股資料建立星系（每次進入劇場模式重新建立，反映最新持股）──
  _buildSystem() {
    if (!this._scene) return;
    // 清掉舊的星系物件，避免重複疊加
    this._planetGroups.forEach(p => this._scene.remove(p.orbitHolder));
    this._planetGroups = [];
    if (this._core) this._scene.remove(this._core);

    // ★ 修正核心球體沒有反映大盤漲跌的問題：跟小球一樣的邏輯，加權指數漲用紅、跌用綠，
    // 幅度大小反映在自轉速度上（存進userData，動畫迴圈裡讀取）
    const twiiData = DATA.priceStore['^TWII'];
    const twiiChgPct = (twiiData?.price && twiiData?.prevClose) ? (twiiData.price - twiiData.prevClose) / twiiData.prevClose * 100 : 0;
    const coreColor = twiiChgPct >= 0 ? 0xd9534f : 0x3d9970;
    this._core = this._makeWireSphere(1.0, coreColor, 0.6, 5, 6);
    this._core.userData.spinSpeed = 0.0008 + Math.min(0.0015, Math.abs(twiiChgPct) * 0.0003);
    this._scene.add(this._core);

    // 只用台股持股（美股的軌道/產業分類邏輯之後可以再擴充）
    const portfolio = (APP._twPortfolio || []).filter(s => s.price);
    if (!portfolio.length) return;

    // 依產業分組
    const bySector = {};
    portfolio.forEach(s => {
      const sector = (typeof getStockSector === 'function') ? getStockSector(s.code) : '其他';
      if (!bySector[sector]) bySector[sector] = [];
      bySector[sector].push(s);
    });

    const sectorColors = [0x5a8fc0, 0x6ea88a, 0xb08a5a, 0x9a7ab0, 0xc07a7a, 0x7ab0a8];
    const sectors = Object.entries(bySector);
    sectors.forEach(([sector, stocks], i) => {
      const orbitR = 2.6 + (i % 3) * 0.75;
      // 每個產業給它自己的隨機但固定的軌道傾斜角（用sector名稱字串長度當簡單的偽隨機種子，
      // 這樣同一個產業每次重建星系時傾斜角度會維持一致，不會每次進入劇場模式都跳動）
      const seed = sector.charCodeAt(0) + sector.length;
      const tiltX = ((seed % 7) - 3) * 0.15;
      const tiltZ = ((seed % 5) - 2) * 0.2;
      const color = sectorColors[i % sectorColors.length];

      const orbitHolder = new THREE.Group();
      orbitHolder.rotation.x = tiltX;
      orbitHolder.rotation.z = tiltZ;
      this._scene.add(orbitHolder);

      const pathPts = [];
      for (let a = 0; a <= 64; a++) { const t = (a / 64) * Math.PI * 2; pathPts.push(new THREE.Vector3(Math.cos(t) * orbitR, 0, Math.sin(t) * orbitR)); }
      // ★ 修正軌道太細的問題：跟球體線框一樣用「疊兩層微幅放大」模擬粗線條，並提高透明度
      const orbitMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
      orbitHolder.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pathPts), orbitMat));
      orbitHolder.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pathPts.map(p=>p.clone().multiplyScalar(1.008))), orbitMat));

      const planetGroup = new THREE.Group();
      planetGroup.add(this._makeWireSphere(0.4, color, 0.7, 3, 4));

      const moonOrbitR = 0.72;
      // ★ 修正個股小球看不出跟哪個中球一起的問題：加寬環的帶狀寬度、提高透明度，
      // 讓「這幾顆小球共用同一個環」這件事更明顯，環的顏色也跟母球顏色一致方便辨認歸屬
      const ring = new THREE.Mesh(new THREE.RingGeometry(moonOrbitR - 0.02, moonOrbitR, 60), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.35 }));
      ring.rotation.x = Math.PI / 2;
      planetGroup.add(ring);

      const moons = stocks.map((s, j) => {
        const chgPct = s.price && s.prevClose ? (s.price - s.prevClose) / s.prevClose * 100 : 0;
        const isUp = chgPct >= 0;
        const moonColor = isUp ? 0xe0524f : 0x1d9e75;
        const size = 0.05 + Math.min(0.08, Math.abs(chgPct) * 0.015);
        const moon = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 16), new THREE.MeshBasicMaterial({ color: moonColor }));
        const angle = (j / stocks.length) * Math.PI * 2;
        // 公轉速度反映活躍度：漲跌幅度越大轉越快（量比資料要另外抓，先用漲跌幅度概估活躍度）
        const speed = 0.012 + Math.min(0.03, Math.abs(chgPct) * 0.004);
        planetGroup.add(moon);
        // ★ 修正歸屬不明顯的問題：加一條從中心到小球的輻射細線，視覺上明確連結「這顆球屬於這個環」
        const spokeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3 });
        const spoke = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(moonOrbitR,0,0)]), spokeMat);
        planetGroup.add(spoke);
        return { mesh: moon, spoke, angle, radius: moonOrbitR, speed, code: s.code, chgPct };
      });

      orbitHolder.add(planetGroup);
      this._planetGroups.push({ group: planetGroup, orbitHolder, orbitR, angle: (i / sectors.length) * Math.PI * 2, speed: 0.0008 + i * 0.0001, moons, sector });
    });
    this._buildLabels();
    this._buildTimeRing();
  },

  // ★ 修正球體上完全沒有字的問題：Three.js畫文字很麻煩(要用貼圖或額外的文字幾何體)，
  // 改用HTML標籤浮在3D物體對應的螢幕座標上，動畫迴圈裡持續更新位置，做法簡單可靠。
  _buildLabels() {
    const container = document.getElementById('theater-stage');
    if (!container) return;
    let labelLayer = document.getElementById('theater-label-layer');
    if (!labelLayer) {
      labelLayer = document.createElement('div');
      labelLayer.id = 'theater-label-layer';
      labelLayer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
      container.style.position = 'relative';
      container.appendChild(labelLayer);
    }
    labelLayer.innerHTML = '';

    const coreLabel = document.createElement('div');
    coreLabel.className = 'theater-3d-label theater-3d-label-core';
    coreLabel.textContent = '加權指數';
    labelLayer.appendChild(coreLabel);
    this._coreLabelEl = coreLabel;

    this._planetGroups.forEach(p => {
      const label = document.createElement('div');
      label.className = 'theater-3d-label';
      label.textContent = p.sector;
      labelLayer.appendChild(label);
      p.labelEl = label;

      // ★ 修正小球沒有代號跟漲跌幅的問題：每顆小球加一個緊貼在旁邊的小標籤
      p.moons.forEach(m => {
        const moonLabel = document.createElement('div');
        moonLabel.className = 'theater-3d-label theater-3d-label-moon';
        moonLabel.innerHTML = `${m.code}<br>${m.chgPct>=0?'+':''}${m.chgPct.toFixed(1)}%`;
        moonLabel.style.color = m.chgPct >= 0 ? '#e0524f' : '#1d9e75';
        labelLayer.appendChild(moonLabel);
        m.labelEl = moonLabel;
      });
    });
  },

  // ★ 補上最早設計稿就有、但一直沒做的「時間環」：環繞在星系外圍的淡淡光點，
  // 提示還有幾天到重大事件（FOMC/CPI/PCE等），只做氛圍提示，不能點進去查明細
  // （查明細要透過導覽選單進日曆頁，這裡刻意保持極簡）。
  _buildTimeRing() {
    if (!this._scene || typeof MacroEvents === 'undefined') return;
    if (this._timeRingGroup) { this._scene.remove(this._timeRingGroup); }
    this._timeRingGroup = new THREE.Group();

    const ringR = 4.6;
    const ringPts = [];
    for (let a = 0; a <= 80; a++) { const t = (a/80)*Math.PI*2; ringPts.push(new THREE.Vector3(Math.cos(t)*ringR, 0, Math.sin(t)*ringR)); }
    this._timeRingGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), new THREE.LineBasicMaterial({ color: 0x555f6b, transparent: true, opacity: 0.25 })));

    const upcoming = MacroEvents.getUpcoming(30); // 顯示未來30天內的事件
    upcoming.forEach(ev => {
      // 用「還有幾天」決定這個事件標在環上的角度位置（0天=環的起點，30天=繞完一整圈）
      const t = (ev.daysUntil / 30) * Math.PI * 2;
      const x = Math.cos(t) * ringR, z = Math.sin(t) * ringR;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), new THREE.MeshBasicMaterial({ color: 0xa78bfa }));
      dot.position.set(x, 0, z);
      this._timeRingGroup.add(dot);
      dot.userData.eventLabel = `${ev.label} ${ev.daysUntil}天後`;
    });

    this._timeRingGroup.rotation.x = 0.35; // 給時間環一個跟主星系不同的傾斜角，視覺上區分成獨立的一層
    this._scene.add(this._timeRingGroup);
  },

  _updateLabels() {
    if (!this._camera || !this._renderer) return;
    const container = document.getElementById('theater-stage');
    if (!container) return;
    const w = container.clientWidth, h = container.clientHeight;

    const project = (obj3d) => {
      const vec = new THREE.Vector3();
      obj3d.getWorldPosition(vec);
      vec.project(this._camera);
      return { x: (vec.x * 0.5 + 0.5) * w, y: (-vec.y * 0.5 + 0.5) * h, behind: vec.z > 1 };
    };

    if (this._coreLabelEl && this._core) {
      const p = project(this._core);
      this._coreLabelEl.style.transform = `translate(${p.x}px, ${p.y}px)`;
      this._coreLabelEl.style.display = p.behind ? 'none' : 'block';
    }
    this._planetGroups.forEach(p => {
      if (p.labelEl) {
        // ★ 修正字要在球體正中心的問題：拿掉之前的-24偏移，直接投影球心座標
        const pos = project(p.group);
        p.labelEl.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
        p.labelEl.style.display = pos.behind ? 'none' : 'block';
      }
      p.moons.forEach(m => {
        if (!m.labelEl) return;
        const mpos = project(m.mesh);
        m.labelEl.style.transform = `translate(${mpos.x}px, ${mpos.y - 16}px)`;
        m.labelEl.style.display = mpos.behind ? 'none' : 'block';
      });
    });
  },

  _animate() {
    this._animId = requestAnimationFrame(() => this._animate());
    if (!this._isActive || !this._renderer) return;
    if (this._core) this._core.rotation.y += (this._core.userData.spinSpeed || 0.0008);
    this._planetGroups.forEach(p => {
      p.angle += p.speed;
      p.group.position.x = Math.cos(p.angle) * p.orbitR;
      p.group.position.z = Math.sin(p.angle) * p.orbitR;
      p.group.rotation.y += 0.002;
      p.moons.forEach(m => {
        m.angle += m.speed;
        m.mesh.position.x = Math.cos(m.angle) * m.radius;
        m.mesh.position.z = Math.sin(m.angle) * m.radius;
      });
    });
    if (this._stars) this._stars.rotation.y += 0.00015;
    if (this._scene) this._scene.rotation.x = 0.06;
    this._renderer.render(this._scene, this._camera);
    this._updateLabels();
  },

  // ── 衛星面板：接真實資料，每個面板2-3則輪播 ──────────────
  async _startPanels() {
    this._panelIntervals.forEach(id => clearInterval(id));
    this._panelIntervals = [];

    await this._renderAssetPanel();
    await this._renderSectorPanel();
    await this._renderFlowPanel();

    ['asset', 'sector', 'flow'].forEach(key => {
      const panel = document.getElementById(`theater-panel-${key}`);
      if (!panel) return;
      let paused = false;
      panel.addEventListener('mouseenter', () => paused = true);
      panel.addEventListener('mouseleave', () => paused = false);
      const idx = { current: 0 };
      const id = setInterval(() => {
        if (paused || !this._isActive) return;
        idx.current++;
        this._rotatePanel(key, idx.current);
      }, 4000);
      this._panelIntervals.push(id);
      panel._idxState = idx;
    });
  },

  _setPanelContent(key, items) {
    const el = document.getElementById(`theater-panel-${key}`);
    if (el) el._items = items;
    const contentEl = document.getElementById(`theater-panel-${key}-content`);
    const dotsEl = document.getElementById(`theater-panel-${key}-dots`);
    if (contentEl && items.length) contentEl.textContent = items[0];
    if (dotsEl) dotsEl.innerHTML = items.map((_, i) => `<span class="theater-dot ${i===0?'active':''}"></span>`).join('');
  },

  _rotatePanel(key, tick) {
    const el = document.getElementById(`theater-panel-${key}`);
    const items = el?._items;
    if (!items || !items.length) return;
    const idx = tick % items.length;
    const contentEl = document.getElementById(`theater-panel-${key}-content`);
    if (contentEl) contentEl.textContent = items[idx];
    const dots = document.querySelectorAll(`#theater-panel-${key}-dots .theater-dot`);
    dots.forEach((d, i) => d.classList.toggle('active', i === idx));
  },

  async _renderAssetPanel() {
    try {
      const g = GOALS.get();
      const portfolio = APP.portfolio;
      const totalVal = portfolio.reduce((s,x)=>s+(x.price??x.cost)*x.shares,0);
      const totalCost = portfolio.reduce((s,x)=>s+x.cost*x.shares,0);
      const gainPct = totalCost ? ((totalVal-totalCost)/totalCost*100) : 0;
      const todayPnl = portfolio.reduce((s,x)=> s + ((x.price ?? x.cost) - (x.prevClose ?? x.cost)) * x.shares, 0);
      this._setPanelContent('asset', [
        `未實現損益 ${gainPct>=0?'+':''}${gainPct.toFixed(1)}%`,
        `今日損益 ${todayPnl>=0?'+':''}${Math.round(todayPnl).toLocaleString()}`,
      ]);
    } catch(e) { this._setPanelContent('asset', ['資料載入中']); }
  },

  async _renderSectorPanel() {
    try {
      const weights = calcSectorWeights('ALL');
      const top = Object.entries(weights).sort((a,b)=>b[1]-a[1])[0];
      const sectorText = top ? `最大持股產業：${top[0]} ${(top[1]*100).toFixed(0)}%` : '尚無持股';

      const ranking = await DATA.fetchSectorRanking();
      const topSector = ranking?.[0];
      const rankText = topSector ? `今日類股冠軍：${topSector.name} ${topSector.chgPct>=0?'+':''}${topSector.chgPct}%` : '載入中';

      this._setPanelContent('sector', [sectorText, rankText]);
    } catch(e) { this._setPanelContent('sector', ['資料載入中']); }
  },

  async _renderFlowPanel() {
    try {
      const inst = await DATA.fetchInstitutional();
      const twStocks = (APP._twPortfolio || []).map(s => s.code);
      let netForeign = 0;
      twStocks.forEach(code => { netForeign += inst?.byCode?.[code]?.foreign ?? 0; });
      const flowText = `持股外資合計 ${netForeign>=0?'+':''}${(netForeign/1000).toFixed(0)}張`;

      const upcoming = MacroEvents.getUpcoming(14);
      const eventText = upcoming.length ? `${upcoming[0].label} ${upcoming[0].daysUntil}天後` : '近期無重大事件';

      this._setPanelContent('flow', [flowText, eventText]);
    } catch(e) { this._setPanelContent('flow', ['資料載入中']); }
  },
};

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('theater-nav-wrap');
  if (wrap && !wrap.contains(e.target)) Theater.toggleNavMenu(false);
});
