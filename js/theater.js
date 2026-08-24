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
    const checkbox = document.getElementById('theater-mode-toggle');
    if (checkbox) checkbox.checked = !isShowing;
  },

  goTo(target) {
    this.toggleNavMenu(false);
    const checkbox = document.getElementById('theater-mode-toggle');
    if (checkbox) checkbox.checked = false; // 透過選單離開一定是離開劇場模式
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
    const btn = document.getElementById('theater-lock-btn');
    if (btn) btn.textContent = this._dragLocked ? '🔒 已鎖定' : '🔓 拖曳旋轉';
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

    // ★ 修正背景太空的問題：星星數量從800加到1800、放大size增加可見度，
    // 另外加一層更靠近、更亮的「近景星點」製造前後兩層的縱深差異，不是單一平面的星點。
    // 再加一顆極大、極淡的背景光暈球，模擬星雲氛圍，填補純黑背景的空洞感。
    const starGeo = new THREE.BufferGeometry();
    const starCount = 1800;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 12 + Math.random() * 22;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos((Math.random() * 2) - 1);
      starPositions[i*3]   = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i*3+1] = r * Math.cos(phi);
      starPositions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({ color: 0x9aa8ba, size: 0.06, transparent: true, opacity: 0.7 });
    this._stars = new THREE.Points(starGeo, starMat);
    this._scene.add(this._stars);

    // 遠景星雲光暈：一顆極大半徑、極低透明度的實心球，從內部包住整個場景，製造深邃感
    const nebulaGeo = new THREE.SphereGeometry(28, 16, 16);
    const nebulaMat = new THREE.MeshBasicMaterial({ color: 0x1a2540, transparent: true, opacity: 0.18, side: THREE.BackSide });
    this._nebula = new THREE.Mesh(nebulaGeo, nebulaMat);
    this._scene.add(this._nebula);

    this._camera = new THREE.PerspectiveCamera(48, w / h, 0.1, 100);
    // ★ 修正星系位置往上移：相機看向的目標點下移，畫面裡的星系相對就會往上移
    this._camera.position.set(0, 1.3, 9.5);
    this._camera.lookAt(0, -0.9, 0);

    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setSize(w, h);
    this._renderer.setPixelRatio(window.devicePixelRatio);
    container.innerHTML = '';
    container.appendChild(this._renderer.domElement);

    window.addEventListener('resize', () => this._onResize());
    this._setupDragControls(container);
    this._setupZoomControls(container);
  },

  // ★ 加入拖曳旋轉：Three.js r128的CDN沒有內建OrbitControls附加元件，用額外script載入
  // 有失敗風險，改成自己寫一個簡單可靠的拖曳處理——記錄滑鼠移動的角度差，轉動整個場景群組。
  // 放開滑鼠後恢復自動緩慢旋轉，讓使用者可以自己探索、也不會永遠停在使用者拖到的角度。
  _setupDragControls(container) {
    // ★ 記錄拖曳角度：從localStorage讀取上次的角度，沒有的話才用預設值，
    // 這樣重開網站不用每次重新拖成喜歡的樣子
    const saved = JSON.parse(localStorage.getItem('theater-rotation') || 'null');
    this._userRotX = saved?.x ?? 0.06;
    this._userRotY = saved?.y ?? 0;
    this._dragLocked = localStorage.getItem('theater-drag-locked') === 'true';
    let dragging = false, lastX = 0, lastY = 0;

    const saveRotation = () => {
      localStorage.setItem('theater-rotation', JSON.stringify({ x: this._userRotX, y: this._userRotY }));
    };

    container.style.cursor = this._dragLocked ? 'default' : 'grab';
    container.addEventListener('mousedown', (e) => {
      if (this._dragLocked) return; // ★ 鎖定時完全不響應拖曳
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      container.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging || this._dragLocked) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this._userRotY += dx * 0.005;
      this._userRotX = Math.max(-1.2, Math.min(1.2, this._userRotX + dy * 0.005));
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      container.style.cursor = this._dragLocked ? 'default' : 'grab';
      saveRotation();
    });
    // 手機觸控支援
    container.addEventListener('touchstart', (e) => {
      if (this._dragLocked) return;
      dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (!dragging || this._dragLocked) return;
      const dx = e.touches[0].clientX - lastX, dy = e.touches[0].clientY - lastY;
      lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      this._userRotY += dx * 0.005;
      this._userRotX = Math.max(-1.2, Math.min(1.2, this._userRotX + dy * 0.005));
    }, { passive: true });
    window.addEventListener('touchend', () => { if(dragging){ dragging = false; saveRotation(); } });
  },

  // ★ 拖曳鎖定開關：鎖定後滑鼠/觸控完全不會轉動視角，避免不小心滑到
  toggleDragLock() {
    this._dragLocked = !this._dragLocked;
    localStorage.setItem('theater-drag-locked', String(this._dragLocked));
    const container = document.getElementById('theater-stage');
    if (container) container.style.cursor = this._dragLocked ? 'default' : 'grab';
    const btn = document.getElementById('theater-lock-btn');
    if (btn) btn.textContent = this._dragLocked ? '🔒 已鎖定' : '🔓 拖曳旋轉';
  },

  // ★ 加入滾輪縮放：不用糾結星系該多大，讓使用者自己決定，記住上次的縮放程度
  _setupZoomControls(container) {
    const savedZoom = parseFloat(localStorage.getItem('theater-zoom') || '9.5');
    this._camera.position.z = savedZoom;
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      const newZ = Math.max(4, Math.min(20, this._camera.position.z + e.deltaY * 0.01));
      this._camera.position.z = newZ;
      localStorage.setItem('theater-zoom', String(newZ));
    }, { passive: false });
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
    const solidMesh = new THREE.Mesh(geo, solidMat);
    group.add(solidMesh);
    group.userData.solidMesh = solidMesh; // ★ 記下實心網格，供文字遮擋判定用

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
    this._occluders = []; // ★ 收集所有實心球體，供文字遮擋判定用

    // ★ 修正核心球體沒有反映大盤漲跌的問題：跟小球一樣的邏輯，加權指數漲用紅、跌用綠，
    // 幅度大小反映在自轉速度上（存進userData，動畫迴圈裡讀取）
    const twiiData = DATA.priceStore['^TWII'];
    const twiiChgPct = (twiiData?.price && twiiData?.prevClose) ? (twiiData.price - twiiData.prevClose) / twiiData.prevClose * 100 : 0;
    const coreColor = twiiChgPct >= 0 ? 0xd9534f : 0x3d9970;
    this._core = this._makeWireSphere(0.75, coreColor, 0.6, 3);
    this._core.userData.spinSpeed = 0.0008 + Math.min(0.0015, Math.abs(twiiChgPct) * 0.0003);
    this._scene.add(this._core);
    this._occluders.push(this._core.userData.solidMesh);

    // 只用台股持股（美股的軌道/產業分類邏輯之後可以再擴充）
    const portfolio = (APP._twPortfolio || []).filter(s => s.price);
    if (!portfolio.length) return;

    // ★ 大小改用持股權重，不用當日漲跌幅度：漲跌是每天隨機跳動的雜訊，用大小表達的話
    // 星系每天看起來都不一樣、抓不到重點；「這支股票/產業佔我多少身家」才是相對穩定、
    // 值得長期記住的資訊，更適合當作「這顆球該有多顯眼」的依據。
    // 漲跌幅度改用顏色鮮豔度表達，兩個維度分開，不互相搶。
    const totalVal = portfolio.reduce((s,x)=>s+(x.price??x.cost)*x.shares, 0) || 1;

    // 依產業分組
    const bySector = {};
    portfolio.forEach(s => {
      const sector = (typeof getStockSector === 'function') ? getStockSector(s.code) : '其他';
      if (!bySector[sector]) bySector[sector] = [];
      bySector[sector].push(s);
    });

    // ★ 修正相鄰軌道顏色太接近的問題：換一組刻意拉開色相差異的調色盤（借鑑常見的
    // 「定性色彩配置」設計原則），確保相鄰索引的顏色不會長得像
    const sectorColors = [0x4e79a7, 0xf28e2b, 0x59a14f, 0xb07aa1, 0xe15759, 0x76b7b2, 0xedc948, 0xff9da7, 0x9c755f, 0xbab0ac];
    const sectors = Object.entries(bySector);
    sectors.forEach(([sector, stocks], i) => {
      // ★ 修正軌道太集中的問題：每個產業各自一個遞增半徑，完全不重疊
      // ★ 修正軌道間距的問題：從0.5加大到0.68，讓每一圈之間的差距更明顯
      const orbitR = 1.7 + i * 0.68;
      // ★ 修正軌道視覺太亂的問題：傾斜角範圍縮小，讓所有軌道傾斜方向比較收斂
      const seed = sector.charCodeAt(0) + sector.length;
      // ★ 修正：這次改成拉大角度間隔（跟上次縮小的方向相反，找一個更適中的平衡點）
      const tiltX = ((seed % 7) - 3) * 0.14;
      const tiltZ = ((seed % 5) - 2) * 0.18;
      const color = sectorColors[i % sectorColors.length];

      const orbitHolder = new THREE.Group();
      orbitHolder.rotation.x = tiltX;
      orbitHolder.rotation.z = tiltZ;
      this._scene.add(orbitHolder);

      const pathPts = [];
      for (let a = 0; a <= 64; a++) { const t = (a / 64) * Math.PI * 2; pathPts.push(new THREE.Vector3(Math.cos(t) * orbitR, 0, Math.sin(t) * orbitR)); }
      // ★ 修正軌道要保留但改回全實線：拿掉之前的虛線輪替（使用者反映還是覺得亂），
      // 改成單純用顏色差異+更大間距做區分，維持「實心線」的乾淨視覺
      // ★ 軌道線依距離核心遠近做漸層：越近越清楚越粗(用疊線模擬粗細)，越遠越淡越細
      const distFactor = i / Math.max(1, sectors.length - 1); // 0(最近)~1(最遠)
      const orbitOpacity = 0.75 - distFactor * 0.5;
      const orbitMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: orbitOpacity });
      const orbitLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pathPts), orbitMat);
      orbitHolder.add(orbitLine);
      if (distFactor < 0.4) { // 只有比較靠近核心的幾圈疊線模擬加粗，越遠的維持單細線
        orbitHolder.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pathPts.map(p=>p.clone().multiplyScalar(1.012))), orbitMat));
      }

      // ★ 中球大小：這個產業佔投組總市值的比例
      const sectorVal = stocks.reduce((s,x)=>s+(x.price??x.cost)*x.shares, 0);
      const sectorWeight = sectorVal / totalVal;
      // ★ 同樣調整倍率，避免最大的產業(ETF 37.7%)太早頂到上限，要接近50%才頂滿
      const sphereSize = 0.28 + Math.min(0.35, sectorWeight * 0.75);

      const planetGroup = new THREE.Group();
      // ★ 修正中球長得太像的問題：每個產業用不同的切面細分數量(0/1/2輪流)，
      // 就算顏色接近，切面密度不同也能幫助分辨是哪一顆
      const detailLevel = i % 3;
      const industrySphere = this._makeWireSphere(sphereSize, color, 0.7, detailLevel);
      planetGroup.add(industrySphere);
      this._occluders.push(industrySphere.userData.solidMesh);

      const moonOrbitR = sphereSize + 0.32;
      // ★ 修正個股小球看不出跟哪個中球一起的問題：加寬環的帶狀寬度、提高透明度
      const ring = new THREE.Mesh(new THREE.RingGeometry(moonOrbitR - 0.02, moonOrbitR, 60), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.35 }));
      ring.rotation.x = Math.PI / 2;
      planetGroup.add(ring);

      const moons = stocks.map((s, j) => {
        const chgPct = s.price && s.prevClose ? (s.price - s.prevClose) / s.prevClose * 100 : 0;
        const isUp = chgPct >= 0;
        // ★ 漲跌幅度改用顏色鮮豔度表達：波動小(接近平盤)顏色偏灰濁，波動大顏色越鮮豔飽和，
        // 5%以上視為最大強度
        const intensity = Math.min(1, Math.abs(chgPct) / 5);
        const mutedColor = isUp ? new THREE.Color(0x8a5f5c) : new THREE.Color(0x4d6e63);
        const vividColor = isUp ? new THREE.Color(0xe0524f) : new THREE.Color(0x1d9e75);
        const moonColor = mutedColor.clone().lerp(vividColor, intensity);
        const moonColorDark = moonColor.clone().multiplyScalar(0.35);

        // ★ 小球大小：這支股票佔投組總市值的比例
        const stockVal = (s.price ?? s.cost) * s.shares;
        const stockWeight = stockVal / totalVal;
        // ★ 修正大小上限太容易頂到的問題：原本倍率1.3，9.6%的持股就已經跟37.7%的0050
        // 一樣大，完全看不出身家差距。改成0.28，要接近40%單一持股才會頂滿，
        // 讓實際常見的1~40%持股範圍都能有感的大小差異。
        const size = 0.045 + Math.min(0.11, stockWeight * 0.28);

        // ★ 修正小球太陽春的問題：改用八面體(稜角分明的幾何造型)取代純圓球
        const moonGeo = new THREE.OctahedronGeometry(size, 0);
        const moon = new THREE.Group();
        moon.add(new THREE.Mesh(moonGeo, new THREE.MeshBasicMaterial({ color: moonColorDark })));
        const moonEdges = new THREE.EdgesGeometry(moonGeo);
        moon.add(new THREE.LineSegments(moonEdges, new THREE.LineBasicMaterial({ color: moonColor })));
        moon.userData.spinSpeed = 0.01 + Math.random() * 0.015;

        const angle = (j / stocks.length) * Math.PI * 2;
        // ★ 小球公轉方向也各自獨立（用股票代號當種子，固定不變，不用Math.random避免每次重建就變）
        const moonSeed = s.code.charCodeAt(0) + s.code.charCodeAt(s.code.length-1);
        const moonDirection = (moonSeed % 2 === 0) ? 1 : -1;
        const speed = (0.012 + Math.min(0.03, Math.abs(chgPct) * 0.004)) * moonDirection;
        planetGroup.add(moon);
        const spokeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22 });
        const spoke = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(moonOrbitR,0,0)]), spokeMat);
        planetGroup.add(spoke);
        return { mesh: moon, spoke, angle, radius: moonOrbitR, speed, code: s.code, name: s.name, chgPct };
      });

      orbitHolder.add(planetGroup);
      // ★ 混合順逆時鐘方向：全部同方向轉太機械化，改成每個產業各自(用seed決定，
      // 固定不會每次重建就變來變去)決定順時鐘或逆時鐘公轉，看起來更自然、有生命感
      const direction = (seed % 2 === 0) ? 1 : -1;
      this._planetGroups.push({ group: planetGroup, orbitHolder, orbitR, angle: (i / sectors.length) * Math.PI * 2, speed: (0.0008 + i * 0.0001) * direction, moons, sector, solidMesh: industrySphere.userData.solidMesh });
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

  // ★ 重新設計成「日期轉軸」：整個橫屏寬度、實心白粗線，今天的日期時間在正中央並即時更新，
  // 左右各顯示14天(共28天)，事件疊在對應日期的刻度上。完全脫離3D場景，固定貼在畫面底部。
  _buildTimeRing() {
    if (typeof MacroEvents === 'undefined') return;
    const container = document.getElementById('theater-stage');
    if (!container) return;
    let svg = document.getElementById('theater-timering-svg');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'theater-timering-svg';
      svg.style.cssText = 'position:absolute; bottom:0; left:0; width:100%; height:150px; pointer-events:none;';
      container.appendChild(svg);
    }
    svg.innerHTML = '';

    const w = container.clientWidth || 900;
    // ★ 修正：照設計稿改回弧形（不是直線），整個橫屏寬度、實心白粗線
    const cx = w / 2, arcW = w - 40, y0 = 45, dip = 110; // ★ 修正弧度太淺看起來像直線的問題：下凹幅度大幅加深
    const pathD = `M ${cx-arcW/2} ${y0} Q ${cx} ${y0+dip} ${cx+arcW/2} ${y0}`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#e6edf3');
    path.setAttribute('stroke-width', '3');
    svg.appendChild(path);

    const pointOnArc = (t) => {
      const x1=cx-arcW/2, y1=y0, x2=cx, y2=y0+dip, x3=cx+arcW/2, y3=y0;
      const x = (1-t)*(1-t)*x1 + 2*(1-t)*t*x2 + t*t*x3;
      const y = (1-t)*(1-t)*y1 + 2*(1-t)*t*y2 + t*t*y3;
      return { x, y };
    };
    // ★ 修正方向：左邊是明天(未來)、右邊是昨天(過去)，中間是今天——
    // daysOffset正值(未來)對應t變小(往左)，負值(過去)對應t變大(往右)
    const DAY_RANGE = 14;
    const dayToT = (daysOffset) => 0.5 - (daysOffset / DAY_RANGE) * 0.5;

    for (let d = -DAY_RANGE; d <= DAY_RANGE; d++) {
      const pos = pointOnArc(dayToT(d));
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tick.setAttribute('x1', pos.x); tick.setAttribute('y1', pos.y-4);
      tick.setAttribute('x2', pos.x); tick.setAttribute('y2', pos.y+4);
      tick.setAttribute('stroke', '#e6edf3');
      tick.setAttribute('stroke-width', d===0 ? 2 : 1);
      tick.setAttribute('opacity', d===0 ? 1 : 0.35);
      svg.appendChild(tick);
    }

    // 今天：正中央，即時日期時間文字
    let todayLabel = document.getElementById('theater-today-label');
    if (!todayLabel) {
      todayLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      todayLabel.id = 'theater-today-label';
      todayLabel.setAttribute('text-anchor', 'middle');
      todayLabel.setAttribute('fill', '#e6edf3');
      todayLabel.setAttribute('font-size', '13');
      todayLabel.setAttribute('font-weight', '700');
    }
    svg.appendChild(todayLabel);
    const todayPos = pointOnArc(0.5);
    todayLabel.setAttribute('x', todayPos.x);
    todayLabel.setAttribute('y', todayPos.y - 14);
    this._updateTimeRingClock(todayLabel);

    // 事件：只有未來的資料(MacroEvents.getUpcoming只回傳未來)，全部會落在中間偏左（明天方向）
    const upcoming = MacroEvents.getUpcoming(DAY_RANGE);
    upcoming.forEach(ev => {
      const pos = pointOnArc(dayToT(ev.daysUntil));
      const proximity = 1 - (ev.daysUntil / DAY_RANGE);
      const r = 4 + proximity * 4;

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', pos.x); circle.setAttribute('cy', pos.y); circle.setAttribute('r', r);
      circle.setAttribute('fill', '#c4b5fd');
      circle.setAttribute('opacity', 0.6 + proximity*0.4);
      svg.appendChild(circle);

      const dateStr = ev.date ? ev.date.slice(5).replace('-', '/') : '';
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', pos.x); text.setAttribute('y', pos.y + r + 16);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', '#c4b5fd');
      text.setAttribute('font-size', '10');
      text.setAttribute('font-weight', '600');
      text.textContent = `${ev.label} ${dateStr}`;
      svg.appendChild(text);
    });

    // ★ 自動更新：每分鐘刷新一次中央的日期時間顯示，不用重建整個時間軸
    if (this._timeRingClockInterval) clearInterval(this._timeRingClockInterval);
    this._timeRingClockInterval = setInterval(() => {
      const label = document.getElementById('theater-today-label');
      if (label) this._updateTimeRingClock(label);
    }, 30000);
  },

  _updateTimeRingClock(el) {
    const now = new Date();
    const dateStr = `${now.getMonth()+1}/${now.getDate()}`;
    const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    el.textContent = `今天 ${dateStr} ${timeStr}`;
  },

  _updateLabels() {
    if (!this._camera || !this._renderer) return;
    const container = document.getElementById('theater-stage');
    if (!container) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (!this._raycaster) this._raycaster = new THREE.Raycaster();

    // ★ 修正球體中心文字消失的bug：之前檢查時會把「球體自己的實心網格」也算進遮擋物，
    // 但文字就在球心，射線必然先穿過自己的表面，等於每顆球都自己擋住自己的文字。
    // 改成呼叫時可以指定「排除某個網格」（自己），只讓「別的球」有機會擋住這個文字。
    const isOccluded = (worldPos, excludeMesh) => {
      if (!this._occluders || !this._occluders.length) return false;
      const dir = worldPos.clone().sub(this._camera.position).normalize();
      const distToTarget = this._camera.position.distanceTo(worldPos);
      this._raycaster.set(this._camera.position, dir);
      const testList = excludeMesh ? this._occluders.filter(m => m !== excludeMesh) : this._occluders;
      const hits = this._raycaster.intersectObjects(testList, false);
      return hits.length > 0 && hits[0].distance < distToTarget - 0.02;
    };

    const project = (obj3d, ownMesh) => {
      const vec = new THREE.Vector3();
      obj3d.getWorldPosition(vec);
      const worldPos = vec.clone();
      vec.project(this._camera);
      return { x: (vec.x * 0.5 + 0.5) * w, y: (-vec.y * 0.5 + 0.5) * h, behind: vec.z > 1, occluded: isOccluded(worldPos, ownMesh) };
    };

    if (this._coreLabelEl && this._core) {
      const p = project(this._core, this._core.userData.solidMesh);
      // ★ 真正找到字沒有置中的原因：這裡的transform會整個覆蓋掉CSS類別裡的translate(-50%,-50%)
      // （置中用的），不是合併疊加，是取代。改成同一個transform字串裡把兩個位移都寫進去。
      this._coreLabelEl.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
      this._coreLabelEl.style.display = (p.behind || p.occluded) ? 'none' : 'block';
    }
    this._planetGroups.forEach(p => {
      if (p.labelEl) {
        const pos = project(p.group, p.solidMesh);
        p.labelEl.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%, -50%)`;
        p.labelEl.style.display = (pos.behind || pos.occluded) ? 'none' : 'block';
      }
      p.moons.forEach(m => {
        if (!m.labelEl) return;
        const mpos = project(m.mesh);
        m.labelEl.style.transform = `translate(${mpos.x}px, ${mpos.y - 16}px) translate(-50%, -50%)`;
        m.labelEl.style.display = (mpos.behind || mpos.occluded) ? 'none' : 'block';
      });
    });
  },

  // ★ 判斷開盤狀態，只用來決定「目標速度」，不會像之前那樣拿去決定要不要設定位置
  // （那正是上次bug的根源：讓某個條件同時控制「動不動」和「有沒有初始化」兩件事）
  _isMarketOpen() {
    const now = new Date();
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
    const h = now.getHours(), m = now.getMinutes();
    const mins = h * 60 + m;
    return mins >= 9*60 && mins <= 13*60+30;
  },

  _animate() {
    this._animId = requestAnimationFrame(() => this._animate());
    if (!this._isActive || !this._renderer) return;

    // ★ 開盤收盤漸進加減速：不是瞬間切換，每一幀都往「目標速度」逼近一點點，
    // 收盤時逐漸放慢到10%速度（不是完全停止，避免重蹈上次「完全停掉」的bug覆轍），
    // 開盤時逐漸加速回100%
    const targetMul = this._isMarketOpen() ? 1 : 0.1;
    if (this._speedMul == null) this._speedMul = targetMul;
    this._speedMul += (targetMul - this._speedMul) * 0.003;

    if (this._core) this._core.rotation.y += (this._core.userData.spinSpeed || 0.0008) * this._speedMul;
    this._planetGroups.forEach(p => {
      p.angle += p.speed * this._speedMul;
      p.group.position.x = Math.cos(p.angle) * p.orbitR;
      p.group.position.z = Math.sin(p.angle) * p.orbitR;
      p.group.rotation.y += 0.002 * this._speedMul;
      p.moons.forEach(m => {
        m.angle += m.speed * this._speedMul;
        m.mesh.position.x = Math.cos(m.angle) * m.radius;
        m.mesh.position.z = Math.sin(m.angle) * m.radius;
        m.mesh.rotation.y += (m.mesh.userData.spinSpeed || 0.012) * this._speedMul;
        m.mesh.rotation.x += (m.mesh.userData.spinSpeed || 0.012) * 0.6 * this._speedMul;
      });
    });
    if (this._stars) this._stars.rotation.y += 0.00015 * this._speedMul;
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
    const W = (wrap.clientWidth || 320) - 44, H = 64; // ★ 修正溢出bug：扣掉面板左右內距(22px×2)
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
    const W = (wrap.clientWidth || 320) - 44, H = 64; // ★ 修正溢出bug：扣掉面板左右內距(22px×2)
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0,0,W,H);
    const entries = Object.entries(weights).sort((a,b)=>b[1]-a[1]);
    if (!entries.length) return;
    const colors = ['#5a8fc0','#6ea88a','#b08a5a','#9a7ab0','#c07a7a','#7ab0a8','#8899aa'];
    // ★ 修正圓餅圖偏左的bug：之前cx用H/2(只有32px)算橫向位置，畫布明明是寬的長方形，
    // 圓餅被擠在最左邊、右邊空一大片。改成用圓的半徑當左邊界，圓右邊留出空間放圖例文字。
    const rOuter = H/2 - 4, rInner = rOuter * 0.55;
    const cx = rOuter + 6, cy = H/2;
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
    // 用空出來的右側空間畫圖例（顏色色塊+產業名+百分比），前3大產業就好，避免太擠
    const legendX = cx + rOuter + 14;
    entries.slice(0, 3).forEach(([sector, w], i) => {
      const ly = 8 + i * 18;
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(legendX, ly, 8, 8);
      ctx.fillStyle = '#a5aebb';
      ctx.font = '10px sans-serif';
      ctx.fillText(`${sector} ${(w*100).toFixed(0)}%`, legendX + 13, ly + 8);
    });
  },

  _drawBarChart(canvasId, items) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const W = (wrap.clientWidth || 320) - 44, H = 64; // ★ 修正溢出bug：扣掉面板左右內距(22px×2)
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
