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
    this._scene.fog = new THREE.Fog(0x000000, 8, 22);

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
    this._camera.position.set(0, 1.8, 10.5);
    this._camera.lookAt(0, -0.9, 0);

    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setSize(w, h);
    this._renderer.setPixelRatio(window.devicePixelRatio);
    container.innerHTML = '';
    container.appendChild(this._renderer.domElement);

    window.addEventListener('resize', () => this._onResize());
    this._setupDragControls(container);
  },

  // ★ 加入拖曳旋轉：Three.js r128的CDN沒有內建OrbitControls附加元件，用額外script載入
  // 有失敗風險，改成自己寫一個簡單可靠的拖曳處理——記錄滑鼠移動的角度差，轉動整個場景群組。
  // 放開滑鼠後恢復自動緩慢旋轉，讓使用者可以自己探索、也不會永遠停在使用者拖到的角度。
  _setupDragControls(container) {
    this._userRotX = 0.06; // 跟原本_animate裡固定的0.06一致，當作初始角度
    this._userRotY = 0;
    let dragging = false, lastX = 0, lastY = 0;

    container.style.cursor = 'grab';
    container.addEventListener('mousedown', (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      container.style.cursor = 'grabbing';
      this._dragIdleTimer && clearTimeout(this._dragIdleTimer);
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this._userRotY += dx * 0.005;
      this._userRotX = Math.max(-1.2, Math.min(1.2, this._userRotX + dy * 0.005));
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      container.style.cursor = 'grab';
    });
    // 手機觸控支援
    container.addEventListener('touchstart', (e) => {
      dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const dx = e.touches[0].clientX - lastX, dy = e.touches[0].clientY - lastY;
      lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      this._userRotY += dx * 0.005;
      this._userRotX = Math.max(-1.2, Math.min(1.2, this._userRotX + dy * 0.005));
    }, { passive: true });
    window.addEventListener('touchend', () => { dragging = false; });
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
  // ★ 改用測地線（Icosahedron細分）幾何取代原本的經緯線框，搭配黑色實心不透明底座，
  // 線框疊在球體表面上，做出參考圖那種「實心暗色球體+多面切割紋理」的科技感質感。
  _makeWireSphere(radius, color, opacity, detail = 2) {
    const group = new THREE.Group();
    const geo = new THREE.IcosahedronGeometry(radius, detail);

    const solidMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    group.add(new THREE.Mesh(geo, solidMat));

    const edges = new THREE.EdgesGeometry(geo);
    const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, opacity + 0.3) });
    const wireframe = new THREE.LineSegments(edges, lineMat);
    wireframe.scale.setScalar(1.003); // 微幅放大避免線框跟實心表面打架(z-fighting)
    group.add(wireframe);
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
    this._core = this._makeWireSphere(1.0, coreColor, 0.6, 3);
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
      // ★ 修正軌道太集中的問題：之前用 i%3 只有3種半徑輪流用，9個產業會有3個共用同一個半徑、
      // 疊在一起很雜亂。改成每個產業各自一個遞增半徑，完全不重疊。
      const orbitR = 2.3 + i * 0.42;
      // ★ 修正軌道視覺太亂的問題：之前的傾斜角範圍太極端，縮小到原本的一半，
      // 讓所有軌道傾斜方向比較收斂、不會到處亂穿插
      const seed = sector.charCodeAt(0) + sector.length;
      const tiltX = ((seed % 7) - 3) * 0.075;
      const tiltZ = ((seed % 5) - 2) * 0.1;
      const color = sectorColors[i % sectorColors.length];

      const orbitHolder = new THREE.Group();
      orbitHolder.rotation.x = tiltX;
      orbitHolder.rotation.z = tiltZ;
      this._scene.add(orbitHolder);

      const pathPts = [];
      for (let a = 0; a <= 64; a++) { const t = (a / 64) * Math.PI * 2; pathPts.push(new THREE.Vector3(Math.cos(t) * orbitR, 0, Math.sin(t) * orbitR)); }
      // ★ 修正軌道變兩條線的問題：拿掉之前的疊線技巧（在畫面上反而變成兩條線很亂），
      // 改回單線，用更高的不透明度讓線本身夠清楚就好，同時整體降低到更輔助性的視覺角色
      const orbitMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.38 });
      orbitHolder.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pathPts), orbitMat));

      const planetGroup = new THREE.Group();
      planetGroup.add(this._makeWireSphere(0.4, color, 0.7, 1));

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
        const moonColorDark = isUp ? 0x6b2c2b : 0x0f4a37; // 實心底用更暗的同色調，邊線用亮色，做出切面寶石感
        const size = 0.055 + Math.min(0.09, Math.abs(chgPct) * 0.016);
        // ★ 修正小球太陽春的問題：改用八面體(稜角分明的幾何造型)取代純圓球，
        // 呼應大中球「切面線框」的視覺語言但更簡約，層級上明顯比大中球小一號、更精緻。
        // 不加拖尾效果(太繽紛)，改用緩慢自轉讓稜角隨轉動呈現不同角度，增加科技感細節。
        const moonGeo = new THREE.OctahedronGeometry(size, 0);
        const moon = new THREE.Group();
        moon.add(new THREE.Mesh(moonGeo, new THREE.MeshBasicMaterial({ color: moonColorDark })));
        const moonEdges = new THREE.EdgesGeometry(moonGeo);
        moon.add(new THREE.LineSegments(moonEdges, new THREE.LineBasicMaterial({ color: moonColor })));
        moon.userData.spinSpeed = 0.01 + Math.random() * 0.015;

        const angle = (j / stocks.length) * Math.PI * 2;
        // 公轉速度反映活躍度：漲跌幅度越大轉越快（量比資料要另外抓，先用漲跌幅度概估活躍度）
        const speed = 0.012 + Math.min(0.03, Math.abs(chgPct) * 0.004);
        planetGroup.add(moon);
        // 輻射細線連到中心，視覺上明確連結「這顆球屬於這個環」（配合整體降噪，透明度略降）
        const spokeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22 });
        const spoke = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(moonOrbitR,0,0)]), spokeMat);
        planetGroup.add(spoke);
        return { mesh: moon, spoke, angle, radius: moonOrbitR, speed, code: s.code, name: s.name, chgPct };
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
        moonLabel.innerHTML = `${m.name || m.code}<br>${m.chgPct>=0?'+':''}${m.chgPct.toFixed(1)}%`;
        moonLabel.style.color = m.chgPct >= 0 ? '#e0524f' : '#1d9e75';
        labelLayer.appendChild(moonLabel);
        m.labelEl = moonLabel;
      });
    });
  },

  // ★ 補上最早設計稿就有、但一直沒做的「時間環」：環繞在星系外圍的淡淡光點，
  // 提示還有幾天到重大事件（FOMC/CPI/PCE等），只做氛圍提示，不能點進去查明細
  // （查明細要透過導覽選單進日曆頁，這裡刻意保持極簡）。
  // ★ 重新設計時間環：不再是完整一圈環繞整個星系（畫面到處都是很亂），
  // 改成一個超大半徑的弧形，整體位置壓低、往後推，只有靠近相機這一小段弧線會露出在
  // 畫面下半部，像地平線一樣。事件也改成只顯示14天內（太遠的不顯示），
  // 沿著這段可見弧線由中間（今天）往兩側展開，天數越少的事件離中心越近、越亮越大。
  _buildTimeRing() {
    if (!this._scene || typeof MacroEvents === 'undefined') return;
    if (this._timeRingGroup) { this._scene.remove(this._timeRingGroup); }
    this._timeRingGroup = new THREE.Group();

    const ringR = 9;
    const arcHalfAngle = 0.5; // 弧線只畫一個有限角度範圍，不是完整360度
    const arcPts = [];
    for (let a = -40; a <= 40; a++) { const t = (a/40) * arcHalfAngle; arcPts.push(new THREE.Vector3(Math.sin(t)*ringR, 0, Math.cos(t)*ringR)); }
    const ringMat = new THREE.LineBasicMaterial({ color: 0x6b7684, transparent: true, opacity: 0.5 });
    this._timeRingGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPts), ringMat));

    const DAY_WINDOW = 14; // 只顯示14天內的事件，太遠的直接不顯示
    const upcoming = MacroEvents.getUpcoming(DAY_WINDOW);
    this._timeRingDots = [];
    upcoming.forEach(ev => {
      // 天數映射到弧線角度：0天=正中間（離相機最近），DAY_WINDOW天=弧線兩端
      const side = ev.daysUntil % 2 === 0 ? 1 : -1; // 用奇偶簡單分散到弧線左右兩側，避免全部疊在同一側
      const t = (ev.daysUntil / DAY_WINDOW) * arcHalfAngle * side;
      const x = Math.sin(t) * ringR, z = Math.cos(t) * ringR;
      const proximity = 1 - (ev.daysUntil / DAY_WINDOW); // 0~1，越接近今天越大越亮
      const dotSize = 0.05 + proximity * 0.1;
      const dotOpacity = 0.55 + proximity * 0.45;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(dotSize, 14, 14), new THREE.MeshBasicMaterial({ color: 0xc4b5fd, transparent: true, opacity: dotOpacity }));
      dot.position.set(x, 0, z);
      this._timeRingGroup.add(dot);
      this._timeRingDots.push({ mesh: dot, ev });
    });

    // 把整個弧形群組壓低、往後推，讓它只在畫面下半部露出一小段，配合輕微傾斜營造地平線感
    this._timeRingGroup.position.set(0, -7.3, -1.5);
    this._timeRingGroup.rotation.x = 1.15;
    this._scene.add(this._timeRingGroup);
    this._buildTimeRingLabels();
  },

  // ★ 補上時間環沒有標記日期的問題：用跟球體/小球同一套HTML標籤機制，顯示「事件名稱+日期」
  _buildTimeRingLabels() {
    const labelLayer = document.getElementById('theater-label-layer');
    if (!labelLayer || !this._timeRingDots) return;
    this._timeRingDots.forEach(d => {
      const label = document.createElement('div');
      label.className = 'theater-3d-label theater-3d-label-event';
      const dateStr = d.ev.date ? d.ev.date.slice(5).replace('-', '/') : '';
      label.innerHTML = `${d.ev.label}<br>${dateStr}（${d.ev.daysUntil}天後）`;
      labelLayer.appendChild(label);
      d.labelEl = label;
    });
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
      // ★ 真正找到字沒有置中的原因：這裡的transform會整個覆蓋掉CSS類別裡的translate(-50%,-50%)
      // （置中用的），不是合併疊加，是取代。改成同一個transform字串裡把兩個位移都寫進去。
      this._coreLabelEl.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
      this._coreLabelEl.style.display = p.behind ? 'none' : 'block';
    }
    this._planetGroups.forEach(p => {
      if (p.labelEl) {
        const pos = project(p.group);
        p.labelEl.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%, -50%)`;
        p.labelEl.style.display = pos.behind ? 'none' : 'block';
      }
      p.moons.forEach(m => {
        if (!m.labelEl) return;
        const mpos = project(m.mesh);
        m.labelEl.style.transform = `translate(${mpos.x}px, ${mpos.y - 16}px) translate(-50%, -50%)`;
        m.labelEl.style.display = mpos.behind ? 'none' : 'block';
      });
    });
    if (this._timeRingDots) {
      this._timeRingDots.forEach(d => {
        if (!d.labelEl) return;
        const pos = project(d.mesh);
        d.labelEl.style.transform = `translate(${pos.x}px, ${pos.y - 18}px) translate(-50%, -50%)`;
        d.labelEl.style.display = pos.behind ? 'none' : 'block';
      });
    }
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
        m.mesh.rotation.y += m.mesh.userData.spinSpeed || 0.012;
        m.mesh.rotation.x += (m.mesh.userData.spinSpeed || 0.012) * 0.6;
      });
    });
    if (this._stars) this._stars.rotation.y += 0.00015;
    if (this._scene) {
      this._scene.rotation.x = this._userRotX ?? 0.06;
      this._scene.rotation.y = this._userRotY ?? 0;
    }
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
      const portfolio = APP.portfolio;
      const totalVal = portfolio.reduce((s,x)=>s+(x.price??x.cost)*x.shares,0);
      const totalCost = portfolio.reduce((s,x)=>s+x.cost*x.shares,0);
      const gainPct = totalCost ? ((totalVal-totalCost)/totalCost*100) : 0;
      const todayPnl = portfolio.reduce((s,x)=> s + ((x.price ?? x.cost) - (x.prevClose ?? x.cost)) * x.shares, 0);
      this._setPanelContent('asset', [
        `未實現損益 ${gainPct>=0?'+':''}${gainPct.toFixed(1)}%`,
        `今日損益 ${todayPnl>=0?'+':''}${Math.round(todayPnl).toLocaleString()}`,
      ]);
      // ★ 圖表：淨值走勢小型折線圖，複用績效頁已經在存的歷史資料，不用另外抓
      const history = JSON.parse(localStorage.getItem('twsa-value-history') || '[]');
      this._drawSparkline('theater-panel-asset-chart', history.slice(-30).map(h => h.value ?? h.v ?? h));
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
      // ★ 圖表：產業集中度小型圓餅圖
      this._drawDonut('theater-panel-sector-chart', weights);
    } catch(e) { this._setPanelContent('sector', ['資料載入中']); }
  },

  async _renderFlowPanel() {
    try {
      const inst = await DATA.fetchInstitutional();
      const twStocks = (APP._twPortfolio || []).map(s => s.code);
      const perStockFlow = twStocks.map(code => ({ code, val: inst?.byCode?.[code]?.foreign ?? 0 })).filter(x => x.val !== 0);
      let netForeign = 0;
      perStockFlow.forEach(x => netForeign += x.val);
      const flowText = `持股外資合計 ${netForeign>=0?'+':''}${(netForeign/1000).toFixed(0)}張`;

      const upcoming = MacroEvents.getUpcoming(14);
      const eventText = upcoming.length ? `${upcoming[0].label} ${upcoming[0].daysUntil}天後` : '近期無重大事件';

      this._setPanelContent('flow', [flowText, eventText]);
      // ★ 圖表：法人買賣超橫向長條圖，顯示持股裡買超力道前幾名
      this._drawBarChart('theater-panel-flow-chart', perStockFlow);
    } catch(e) { this._setPanelContent('flow', ['資料載入中']); }
  },

  // ── 面板圖表繪製（簡易canvas，跟現有績效頁圖表同一套配色邏輯）──────
  _drawSparkline(canvasId, values) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !values.length) return;
    const wrap = canvas.parentElement;
    const W = wrap.clientWidth || 240, H = 64;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0,0,W,H);
    const min = Math.min(...values), max = Math.max(...values);
    const range = (max-min) || 1;
    const PAD = 4;
    ctx.beginPath();
    values.forEach((v,i) => {
      const x = PAD + (i/(values.length-1||1)) * (W-PAD*2);
      const y = H - PAD - ((v-min)/range) * (H-PAD*2);
      i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    });
    const trendUp = values[values.length-1] >= values[0];
    ctx.strokeStyle = trendUp ? '#e0524f' : '#1d9e75';
    ctx.lineWidth = 1.8;
    ctx.stroke();
  },

  _drawDonut(canvasId, weights) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const W = wrap.clientWidth || 240, H = 64;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0,0,W,H);
    const entries = Object.entries(weights).sort((a,b)=>b[1]-a[1]);
    if (!entries.length) return;
    const colors = ['#5a8fc0','#6ea88a','#b08a5a','#9a7ab0','#c07a7a','#7ab0a8','#8899aa'];
    const cx = H/2, cy = H/2, rOuter = H/2 - 4, rInner = rOuter * 0.55;
    let startAngle = -Math.PI/2;
    entries.forEach(([sector, w], i) => {
      const angle = w * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, rOuter, startAngle, startAngle+angle);
      ctx.arc(cx, cy, rInner, startAngle+angle, startAngle, true);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
      startAngle += angle;
    });
  },

  _drawBarChart(canvasId, items) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const W = wrap.clientWidth || 240, H = 64;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0,0,W,H);
    if (!items.length) return;
    const top = [...items].sort((a,b)=>Math.abs(b.val)-Math.abs(a.val)).slice(0,4);
    const maxAbs = Math.max(...top.map(x=>Math.abs(x.val))) || 1;
    const barH = (H-6) / top.length - 3;
    top.forEach((item, i) => {
      const y = 3 + i*(barH+3);
      const w = Math.abs(item.val)/maxAbs * (W*0.6);
      ctx.fillStyle = item.val >= 0 ? '#e0524f' : '#1d9e75';
      ctx.fillRect(W*0.2, y, item.val>=0 ? w : 0, barH);
      if (item.val < 0) ctx.fillRect(W*0.2-w, y, w, barH);
      ctx.fillStyle = '#a5aebb';
      ctx.font = '9px sans-serif';
      ctx.fillText(item.code, 2, y+barH-1);
    });
  },
};

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('theater-nav-wrap');
  if (wrap && !wrap.contains(e.target)) Theater.toggleNavMenu(false);
});
