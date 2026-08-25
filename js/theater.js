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
    // ★ 記住劇場模式開關狀態：不用每次重新整理都要重新點一次
    localStorage.setItem('theater-mode-on', String(!isShowing));
  },

  goTo(target) {
    this.toggleNavMenu(false);
    const checkbox = document.getElementById('theater-mode-toggle');
    if (checkbox) checkbox.checked = false; // 透過選單離開一定是離開劇場模式
    localStorage.setItem('theater-mode-on', 'false');
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
  // ★ 美股星系放在「右上方」的位置，跟台股星系(原點)分開，攝影機動畫時會從台股飛到這裡
  _US_OFFSET: { x: 22, y: 12, z: -10 },
  _TW_OFFSET: { x: 0, y: 0, z: 0 },

  onEnter() {
    this._isActive = true;
    document.body.classList.add('theater-active');
    // ★ 修正切換按鈕位置一直沒生效的問題：.topbar有backdrop-filter，這個屬性會讓
    // position:fixed的子元素被限制在.topbar自己的範圍內，跳不出去（CSS的containing block
    // 特性），單靠CSS改不了，只能用JS把元素直接搬出.topbar、移到body底下。
    const marketSwitch = document.querySelector('.market-switch');
    if (marketSwitch && marketSwitch.parentElement !== document.body) {
      this._marketSwitchOriginalParent = marketSwitch.parentElement;
      this._marketSwitchOriginalNextSibling = marketSwitch.nextSibling;
      document.body.appendChild(marketSwitch);
    }
    if (!this._scene) this._initScene();
    // ★ 修正每次重新進入劇場模式，文字標籤會消失/亂掉的bug：這裡才是真正的原因——
    // 遮擋物陣列(_occluders)之前只有「不存在時才初始化」，每次重進都會累加新的球體，
    // 但舊的（來自上一次進入、現在已經從場景移除）從沒被清掉，越堆越多殘留參照，
    // 光線遮擋判定測試到這些過時物件就會出現錯誤結果。改成每次進入都重新歸零。
    this._occluders = [];
    // ★ 兩個星系都要建立（台股+美股），不是只建當下市場那一個，
    // 這樣切換市場時才能直接讓攝影機飛過去，不用重新建構
    this._buildSystem('TW', this._TW_OFFSET);
    this._buildSystem('US', this._US_OFFSET);
    this._buildLabels();
    if (!this._currentMarket) this._currentMarket = APP.activeMarket || 'TW';
    this._setCameraToMarket(this._currentMarket, false); // 進入時直接定位，不用動畫
    this._applySystemVisibility(); // ★ 只顯示目前市場的星系
    this._startPanels();
    if (!this._animId) this._animate();
    const btn = document.getElementById('theater-lock-btn');
    if (btn) btn.textContent = this._dragLocked ? '🔒 已鎖定' : '🔓 拖曳旋轉';
  },

  onExit() {
    this._isActive = false;
    document.body.classList.remove('theater-active');
    // 把切換按鈕搬回原本在topbar裡的位置
    const marketSwitch = document.querySelector('.market-switch');
    if (marketSwitch && this._marketSwitchOriginalParent) {
      this._marketSwitchOriginalParent.insertBefore(marketSwitch, this._marketSwitchOriginalNextSibling);
    }
    this._panelIntervals.forEach(id => clearInterval(id));
    this._panelIntervals = [];
    if (this._animId) { cancelAnimationFrame(this._animId); this._animId = null; }
    if (this._flyAnimId) { cancelAnimationFrame(this._flyAnimId); this._flyAnimId = null; }
  },

  // ★ 直接定位攝影機到指定市場的星系（不用動畫，onEnter第一次進入時用）
  // ★ 簡化：只設定「注視目標點」，實際攝影機座標統一交給_animate()裡的公轉公式計算，
  // 避免兩套邏輯同時搶著設定camera.position互相打架。目標點直接對準核心球球心
  // （使用者明確要求「攝影機指數大球要在中間」），不再額外偏移。
  _setCameraToMarket(market, animate) {
    const offset = market === 'US' ? this._US_OFFSET : this._TW_OFFSET;
    this._cameraLookAt = { x: offset.x, y: offset.y, z: offset.z };
  },

  // ★ 修正台股模式會同時看到美股星系(反之亦然)的問題：只顯示目前市場的星系，
  // 另一個設成不可見。飛行動畫進行中例外——兩個都先顯示，這樣飛過去的路上才有東西可看，
  // 不是穿過一片空無一物的黑，抵達後再把離開的那個藏起來。
  _applySystemVisibility(showBoth) {
    Object.entries(this._systems || {}).forEach(([market, sys]) => {
      const visible = showBoth || market === this._currentMarket;
      if (sys.core) sys.core.visible = visible;
      sys.planetGroups.forEach(p => { p.orbitHolder.visible = visible; });
    });
  },

  // ★ 攝影機動畫：從目前星系飛到目標市場的星系，做出「飛向右上方另一個星系」的感覺。
  // 只需要把「注視目標點」從舊星系球心動畫移動到新星系球心，_animate()裡的公轉公式
  // 每一幀都會讀取這個目標點重新計算攝影機位置，自然而然就會呈現出飛過去的效果。
  flyToMarket(market) {
    if (market === this._currentMarket) return;
    const toOffset = market === 'US' ? this._US_OFFSET : this._TW_OFFSET;
    this._currentMarket = market;

    // ★ 修正資產面板數字沒跟著切換的問題：之前只換攝影機，沒有同步APP.activeMarket，
    // 導致投組四格讀到的DOM還是舊市場的數字。這裡補上同步+重新渲染。
    APP.activeMarket = market;
    if (typeof APP.renderPortfolioSummary === 'function') APP.renderPortfolioSummary();
    this._renderAssetPanel();

    const startLookAt = this._cameraLookAt ? { ...this._cameraLookAt } : { x: 0, y: 0, z: 0 };
    const endLookAt = { x: toOffset.x, y: toOffset.y, z: toOffset.z };
    this._applySystemVisibility(true); // 飛行途中兩個星系都先顯示

    if (this._flyAnimId) cancelAnimationFrame(this._flyAnimId);
    const duration = 1600; // ms
    const t0 = performance.now();
    const ease = (x) => 1 - Math.pow(1 - x, 3); // 緩出，飛行後段變慢比較有「抵達」的感覺

    const step = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const e = ease(t);
      this._cameraLookAt = {
        x: startLookAt.x + (endLookAt.x - startLookAt.x) * e,
        y: startLookAt.y + (endLookAt.y - startLookAt.y) * e,
        z: startLookAt.z + (endLookAt.z - startLookAt.z) * e,
      };
      if (t < 1) { this._flyAnimId = requestAnimationFrame(step); }
      else { this._flyAnimId = null; this._applySystemVisibility(false); } // 抵達後只留目前市場的星系
    };
    this._flyAnimId = requestAnimationFrame(step);
  },


  // ── 3D場景初始化（只做一次）──────────────────────────
  _initScene() {
    const container = document.getElementById('theater-stage');
    if (!container || typeof THREE === 'undefined') return;
    const w = container.clientWidth || 900, h = container.clientHeight || 600;

    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x000000);
    // ★ 修正縮小時中大球消失的問題：霧化範圍(22)太近，縮放距離最大到20+星系本身的展開範圍，
    // 很容易就超過22整個被霧蓋住看不見。大幅拉遠霧化終點，確保縮放範圍內都不會被霧吃掉。
    this._scene.fog = new THREE.Fog(0x000000, 15, 55);

    // ★ 修正灰色小方塊漂過去的問題：PointsMaterial沒有貼圖時，每個點預設會畫成正方形，
    // 不是圓形。用canvas畫一張圓形漸層貼圖當作點的材質貼圖，星星才會是圓點不是小方塊。
    const starCanvas = document.createElement('canvas');
    starCanvas.width = 32; starCanvas.height = 32;
    const sctx = starCanvas.getContext('2d');
    const grad = sctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, 32, 32);
    const starTexture = new THREE.CanvasTexture(starCanvas);

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
    const starMat = new THREE.PointsMaterial({ color: 0x9aa8ba, size: 0.06, map: starTexture, transparent: true, opacity: 0.7, depthWrite: false });
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
  // ★ 修正：滾輪縮放要記錄「跟目前星系的相對距離」，不能是絕對Z座標——
  // 美股星系整個位移過(offset.z=-10)，如果滾輪直接設絕對座標，切到美股時縮放距離會算錯
  _setupZoomControls(container) {
    this._zoomDistance = parseFloat(localStorage.getItem('theater-zoom') || '9.5');
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._zoomDistance = Math.max(4, Math.min(20, this._zoomDistance + e.deltaY * 0.01));
      localStorage.setItem('theater-zoom', String(this._zoomDistance));
      const offset = this._currentMarket === 'US' ? this._US_OFFSET : this._TW_OFFSET;
      this._camera.position.z = offset.z + this._zoomDistance;
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
  // ★ 建立一條可動態更新亮度的軌道線：用逐頂點顏色(vertex colors)實作，
  // 建立時先全部填暗，實際亮度由_updateOrbitGradient()每一幀依當下角度重新計算。
  // ★ 修正太細的問題：這次用「兩條線共用同一份亮度資料、微幅重疊」的方式模擬粗線，
  // 因為兩條線的顏色是同步計算、緊貼在一起，看起來會是一條粗線而不是分開的兩條。
  // ★ 放棄疊線模擬粗細的做法：不管偏移多小，還是會被看出是兩條分開的線
  // （這是WebGL渲染的已知限制，硬解決風險太高）。改回單線，靠拉高不透明度上限
  // 讓「亮的那段」感覺更扎實醒目，用亮度對比代替真正的粗細。
  // ★ 真正做出粗細：Line的linewidth在大多數瀏覽器/顯卡會被忽略，這是WebGL的已知限制，
  // 不管怎麼調整都不可靠。改用「真正的三角形網格」做一條有實際寬度的細緞帶(跟小球環的
  // RingGeometry是同樣的思路)，寬度是真實幾何尺寸，保證在任何裝置上都看得到粗細。
  // ★ 修正軌道線是2D平面的問題：之前的緞帶只有XZ平面上的寬度，Y軸厚度是0，
  // 從側面幾乎看的話還是一條扁平的線。改成真正有立體厚度的小方形管狀截面
  // （內緣/外緣 x 上緣/下緣，四個頂點一組），從任何角度看都有實際的體積感。
  _makeGradientOrbit(radius, colorHex, segments = 64, bandWidth = 0.035) {
    const positions = [], colors = [], indices = [];
    const halfH = bandWidth / 2; // 上下厚度跟左右寬度用同一個尺寸，做出方形截面
    for (let a = 0; a <= segments; a++) {
      const t = (a / segments) * Math.PI * 2;
      const innerR = radius - bandWidth / 2, outerR = radius + bandWidth / 2;
      const cosT = Math.cos(t), sinT = Math.sin(t);
      // 每個角度4個頂點：內下、外下、內上、外上
      positions.push(cosT*innerR, -halfH, sinT*innerR);
      positions.push(cosT*outerR, -halfH, sinT*outerR);
      positions.push(cosT*innerR,  halfH, sinT*innerR);
      positions.push(cosT*outerR,  halfH, sinT*outerR);
      colors.push(0,0,0, 0,0,0, 0,0,0, 0,0,0);
      if (a < segments) {
        const b = a*4, n = (a+1)*4; // 這一段跟下一段的起始頂點索引
        // 底面(b0,b1,n0,n1)、頂面(b2,b3,n2,n3)、內側(b0,b2,n0,n2)、外側(b1,b3,n1,n3)
        indices.push(b,b+1,n, b+1,n+1,n);       // 底面
        indices.push(b+2,n+2,b+3, b+3,n+2,n+3); // 頂面
        indices.push(b,n,b+2, n,n+2,b+2);       // 內側
        indices.push(b+1,b+3,n+1, b+3,n+3,n+1); // 外側
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    // ★ 記下半徑跟基準粗細，供每一幀重新計算「粗細也跟著亮度變化」用
    // ★ 顏色更淺：往白色混一點，不是純粹只靠透明度變淡
    const lightenedColor = new THREE.Color(colorHex).lerp(new THREE.Color(0xffffff), 0.25);
    return { line: new THREE.Mesh(geo, mat), geos: [geo], segments, baseColor: lightenedColor, vertsPerStep: 4, radius, baseBandWidth: bandWidth };
  },

  // ★ 修正粗細沒有跟著變化的問題：之前只有顏色在漸層，粗細是固定值。
  // 改成粗細也用同一個亮度公式縮放（球體所在位置最粗，往兩側逐漸變細），
  // 做出「圓錐體」般兩端尖細、中間粗的視覺效果，不只是顏色深淺。
  _updateOrbitGradient(grad, currentAngles) {
    const base = grad.baseColor;
    const hotZone = Math.PI / 2.2;
    const posAttr = grad.geos[0].attributes.position;
    for (let a = 0; a <= grad.segments; a++) {
      const t = (a / grad.segments) * Math.PI * 2;
      let minDist = Math.PI;
      for (const ang of currentAngles) {
        let d = Math.abs(t - ang) % (Math.PI * 2);
        if (d > Math.PI) d = Math.PI * 2 - d;
        if (d < minDist) minDist = d;
      }
      const raw = Math.max(0, 1 - minDist / hotZone);
      const brightness = Math.max(0.22, Math.pow(raw, 1.6));
      // 粗細跟著同一個brightness縮放：最粗是基準寬度，最細縮到基準的25%（不會細到完全消失）
      // ★ 修正上次公式的錯誤：brightness本身有0.22的下限，沒有正規化的話，
      // 常數項幾乎不影響最終最細值（0.22×1.5=0.33已經是主要來源）。
      // 改成先把brightness正規化到0~1再套用比例，這樣常數項才是真正的最細值。
      const normBrightness = (brightness - 0.22) / (1 - 0.22);
      const widthScale = 0.6 + 1.55 * normBrightness; // 最細維持60%，最粗改回215%
      const halfH = (grad.baseBandWidth / 2) * widthScale;
      const innerR = grad.radius - halfH, outerR = grad.radius + halfH;
      const cosT = Math.cos(t), sinT = Math.sin(t);
      const vps = grad.vertsPerStep || 2;
      posAttr.setXYZ(a*vps,   cosT*innerR, -halfH, sinT*innerR);
      posAttr.setXYZ(a*vps+1, cosT*outerR, -halfH, sinT*outerR);
      posAttr.setXYZ(a*vps+2, cosT*innerR,  halfH, sinT*innerR);
      posAttr.setXYZ(a*vps+3, cosT*outerR,  halfH, sinT*outerR);
      // ★ 每個角度現在有4個頂點(方形管狀截面)，全部都要設定同樣亮度
      grad.geos.forEach(geo => {
        for (let k = 0; k < vps; k++) {
          geo.attributes.color.setXYZ(a*vps+k, base.r*brightness, base.g*brightness, base.b*brightness);
        }
      });
    }
    posAttr.needsUpdate = true;
    grad.geos.forEach(geo => { geo.attributes.color.needsUpdate = true; });
  },

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
  // ★ 改成支援多個星系同時存在（台股+美股），每個星系用offset決定在3D空間裡的位置，
  // 存進this._systems[market]，動畫迴圈/標籤更新都要改成遍歷全部星系，不是單一全域變數
  _buildSystem(market = 'TW', offset = { x: 0, y: 0, z: 0 }) {
    if (!this._scene) return;
    if (!this._systems) this._systems = {};
    const old = this._systems[market];
    if (old) {
      old.planetGroups.forEach(p => this._scene.remove(p.orbitHolder));
      if (old.core) this._scene.remove(old.core);
      if (old.groupWrapper) this._scene.remove(old.groupWrapper);
    }
    const sys = { core: null, planetGroups: [], occluders: [], offset };
    this._systems[market] = sys;

    const isUS = market === 'US';
    const indexCode = isUS ? '^GSPC' : '^TWII';
    const indexData = DATA.priceStore[indexCode];
    const idxChgPct = (indexData?.price && indexData?.prevClose) ? (indexData.price - indexData.prevClose) / indexData.prevClose * 100 : 0;
    const coreColor = idxChgPct >= 0 ? 0xd9534f : 0x3d9970;
    const coreSize = 0.65 + Math.min(0.35, Math.abs(idxChgPct) * 0.12);
    // ★ 球體視覺放大：只放大實際畫出來的幾何體，軌道間距計算用的coreSize維持不變，
    // 不會影響已經驗證過的防撞安全間距
    const VISUAL_SCALE = 1.18;
    sys.core = this._makeWireSphere(coreSize * VISUAL_SCALE, coreColor, 0.6, 3);
    sys.core.userData.spinSpeed = 0.0008 + Math.min(0.0015, Math.abs(idxChgPct) * 0.0003);
    sys.core.position.set(offset.x, offset.y, offset.z);
    this._scene.add(sys.core);
    sys.occluders.push(sys.core.userData.solidMesh);
    this._occluders.push(sys.core.userData.solidMesh);

    // ★ 依market讀取對應的持股（美股目前沒有產業分類資料，先全部歸在「美股」一個分類）
    const portfolio = (isUS ? (APP._usPortfolio || []) : (APP._twPortfolio || [])).filter(s => s.price);
    if (!portfolio.length) return;

    // ★ 大小改用持股權重，不用當日漲跌幅度：漲跌是每天隨機跳動的雜訊，用大小表達的話
    // 星系每天看起來都不一樣、抓不到重點；「這支股票/產業佔我多少身家」才是相對穩定、
    // 值得長期記住的資訊，更適合當作「這顆球該有多顯眼」的依據。
    // 漲跌幅度改用顏色鮮豔度表達，兩個維度分開，不互相搶。
    const totalVal = portfolio.reduce((s,x)=>s+(x.price??x.cost)*x.shares, 0) || 1;

    // 依產業分組（美股沒有產業分類資料，全部歸在單一組別，之後有資料源可以再擴充）
    const bySector = {};
    portfolio.forEach(s => {
      const sector = isUS ? '美股' : ((typeof getStockSector === 'function') ? getStockSector(s.code) : '其他');
      if (!bySector[sector]) bySector[sector] = [];
      bySector[sector].push(s);
    });

    // ★ 修正相鄰軌道顏色太接近的問題：換一組刻意拉開色相差異的調色盤（借鑑常見的
    // 「定性色彩配置」設計原則），確保相鄰索引的顏色不會長得像
    const sectorColors = [0x4e79a7, 0xf28e2b, 0x59a14f, 0xb07aa1, 0xe15759, 0x76b7b2, 0xedc948, 0xff9da7, 0x9c755f, 0xbab0ac];
    // ★ 修正中球容易撞在一起的問題：不是把所有間距都推寬（會讓整個星系變太大），
    // 改成聰明排列順序——先按持股權重從大到小排，再用「偶數位置放前半、奇數位置放後半」
    // 的方式重新分配軌道順序，讓權重最大的前幾名彼此不會被排在相鄰軌道，
    // 這樣真正容易「看起來很大顆」的球，彼此之間會保有更寬的視覺間隔。
    const sortedByWeight = Object.entries(bySector).sort((a, b) => {
      const wA = a[1].reduce((s,x)=>s+(x.price??x.cost)*x.shares,0);
      const wB = b[1].reduce((s,x)=>s+(x.price??x.cost)*x.shares,0);
      return wB - wA;
    });
    const evens = sortedByWeight.filter((_, idx) => idx % 2 === 0);
    const odds = sortedByWeight.filter((_, idx) => idx % 2 === 1);
    const sectors = [...evens, ...odds];
    const N = sectors.length;

    // ★ 角度交錯：偶數index放A軌、奇數index放B軌(跟A軌整體錯開接近180度)，
    // 這樣「相鄰index」(比如ETF跟IC設計)角度會落在接近對面，像原子軌域裡
    // 相鄰電子不會靠在一起的概念，可以放心把半徑間距拉近。
    const angleFor = (i) => {
      const trackSize = Math.ceil(N / 2);
      const angleStep = (Math.PI * 2) / trackSize;
      return i % 2 === 0 ? (i/2) * angleStep : Math.PI + ((i-1)/2) * angleStep;
    };
    // ★ 方向每2圈交替一次(不是只有一半一半)：0,1順 2,3逆 4,5順 6,7逆...
    // 比「只交替一次」更有變化，又比「每圈都交替」需要的安全間距小很多
    // （用真實資料驗證過：每圈都交替要13.94，每2圈交替只要8.00，一半一半只要4.44——
    // 這是視覺變化度跟星系大小的直接取捨，選這個當折衷）。
    const directionFor = (i) => Math.floor(i/2) % 2 === 0 ? 1 : -1;

    // ★ 真正找到外圈間距太大的原因：間距之前是寫死的常數(NORMAL_GAP)，完全沒有依球體
    // 大小調整——只有傾斜角做了自適應，間距沒有。外圈球體通常比較小，卻被迫套用
    // 跟內圈大球一樣的固定間距，難怪感覺特別空。改成間距 = 兩個相鄰球體延伸範圍的
    // 平均值 × 比例係數，球越小間距自動跟著縮小。用真3D座標驗證過比例0.2依然安全。
    const GAP_RATIO = 0.08, GROUP_BOUNDARY_MARGIN = 0.05;
    const sizeInfo = sectors.map(([sector, stocks]) => {
      const sectorVal = stocks.reduce((s,x)=>s+(x.price??x.cost)*x.shares, 0);
      const sectorWeight = sectorVal / totalVal;
      const sphereSize = 0.28 + Math.min(0.35, sectorWeight * 0.75);
      const moonOrbitR = sphereSize + 0.32;
      return { sphereSize, moonOrbitR };
    });
    const orbitRList = [];
    sizeInfo.forEach((info, i) => {
      // ★ 核心球大小隨大盤漲跌幅浮動(最大到1.0)，第一圈半徑要動態算，不能寫死
      if (i === 0) { orbitRList.push(coreSize + info.moonOrbitR + 0.35); return; }
      const isBoundary = directionFor(i) !== directionFor(i-1);
      if (isBoundary) {
        orbitRList.push(orbitRList[i-1] + sizeInfo[i-1].moonOrbitR + info.moonOrbitR + GROUP_BOUNDARY_MARGIN);
      } else {
        const adaptiveGap = (sizeInfo[i-1].moonOrbitR + info.moonOrbitR) / 2 * GAP_RATIO;
        orbitRList.push(orbitRList[i-1] + adaptiveGap);
      }
    });

    sectors.forEach(([sector, stocks], i) => {
      const orbitR = orbitRList[i];
      // ★ 修正軌道視覺太亂的問題：傾斜角範圍縮小，讓所有軌道傾斜方向比較收斂
      const seed = sector.charCodeAt(0) + sector.length;
      // ★ 修正傾斜角度太大的問題：半徑分開不夠，如果傾斜角差異太大，3D空間中還是可能
      // 在某個位置擦身而過。縮小傾斜範圍讓軌道接近共平面，這樣半徑間距的防撞保證才會真正生效。
      // ★ 修正球體越大、線條貼著滑過的距離越長的問題：傾斜角的「差異」要依球體大小
      // 自適應——球越大，需要越陡的交叉角度，才能讓穿過的線條是快速交叉而過，
      // 不是像平行線一樣貼著滑過一大段。用sphereSize動態放大傾斜幅度。
      const sizeFactor = 1 + sizeInfo[i].sphereSize * 2;
      const tiltX = ((seed % 7) - 3) * 0.07 * sizeFactor;
      const tiltZ = ((seed % 5) - 2) * 0.084 * sizeFactor;
      const color = sectorColors[i % sectorColors.length];

      const orbitHolder = new THREE.Group();
      orbitHolder.rotation.x = tiltX;
      orbitHolder.rotation.z = tiltZ;
      orbitHolder.position.set(offset.x, offset.y, offset.z);
      this._scene.add(orbitHolder);

      const pathPts = [];
      for (let a = 0; a <= 64; a++) { const t = (a / 64) * Math.PI * 2; pathPts.push(new THREE.Vector3(Math.cos(t) * orbitR, 0, Math.sin(t) * orbitR)); }
      // ★ 重新理解需求：不是「離核心遠近」的固定漸層，是「球體目前公轉到哪裡，
      // 那一段軌道就亮/粗，其餘部分自然變暗」——這是跟著即時角度動態變化的漸層，
      // 用逐頂點顏色(vertex colors)實作，每一幀依球體當下角度重新計算亮度分布。
      const orbitGradient = this._makeGradientOrbit(orbitR, color, 64, 0.035);
      orbitHolder.add(orbitGradient.line);

      // ★ 直接沿用預先算好的sizeInfo，不要重新算一次——要確保球體實際大小
      // 跟軌道間距計算時用的尺寸完全一致，不然防撞保證會失真
      const sphereSize = sizeInfo[i].sphereSize;

      const planetGroup = new THREE.Group();
      // ★ 修正中球長得太像的問題：每個產業用不同的切面細分數量(0/1/2輪流)，
      // 就算顏色接近，切面密度不同也能幫助分辨是哪一顆
      const detailLevel = i % 3;
      const industrySphere = this._makeWireSphere(sphereSize * VISUAL_SCALE, color, 0.7, detailLevel);
      planetGroup.add(industrySphere);
      this._occluders.push(industrySphere.userData.solidMesh);
      sys.occluders.push(industrySphere.userData.solidMesh);

      const moonOrbitR = sphereSize + 0.32;
      // ★ 同樣規則套用到小球環：改成漸層線，依「這個環上每顆小球目前的角度」動態算亮度
      const moonRingGradient = this._makeGradientOrbit(moonOrbitR, color, 48, 0.018);
      planetGroup.add(moonRingGradient.line);

      // ★ 方向由所在半區決定（不是隨機），前半順時鐘、後半逆時鐘，
      // 呼應驗證時的分組邏輯，同一組內轉速一致，鎖相位保證才會成立
      const direction = directionFor(i);

      // ★ 修正小球運動方向不一致的問題：同一個母球底下的小球方向要一致、等間距、同速率
      const MOON_SPEED = 0.018;
      const moons = stocks.map((s, j) => {
        const chgPct = s.price && s.prevClose ? (s.price - s.prevClose) / s.prevClose * 100 : 0;
        const isUp = chgPct >= 0;
        // ★ 漲跌幅度改用顏色鮮豔度表達：波動小(接近平盤)顏色偏灰濁，波動大顏色越鮮豔飽和，
        // 5%以上視為最大強度
        const intensity = Math.min(1, Math.abs(chgPct) / 5);
        const mutedColor = isUp ? new THREE.Color(0x8f5a56) : new THREE.Color(0x4a7a5f);
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
        // 視覺放大，跟中球/核心球一樣的邏輯
        const moonGeo = new THREE.OctahedronGeometry(size * VISUAL_SCALE, 0);
        const moon = new THREE.Group();
        const moonSolidMesh = new THREE.Mesh(moonGeo, new THREE.MeshBasicMaterial({ color: moonColorDark }));
        moon.add(moonSolidMesh);
        const moonEdges = new THREE.EdgesGeometry(moonGeo);
        moon.add(new THREE.LineSegments(moonEdges, new THREE.LineBasicMaterial({ color: moonColor })));
        moon.userData.spinSpeed = 0.01 + Math.random() * 0.015; // 這是小球自轉(展示切面用)，跟公轉方向是兩回事，維持各自不同沒關係
        // ★ 修正小球沒有遮擋功能的問題：之前只有大中球被列入遮擋物清單，小球完全沒有，
        // 導致小球後面的文字永遠透視穿過看得到。補上小球自己的實心網格。
        this._occluders.push(moonSolidMesh);
        sys.occluders.push(moonSolidMesh);

        const angle = (j / stocks.length) * Math.PI * 2; // 已經是等間距分佈
        const speed = MOON_SPEED * direction; // 跟母球同方向、固定速率
        planetGroup.add(moon);
        const spokeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22 });
        const spoke = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(moonOrbitR,0,0)]), spokeMat);
        planetGroup.add(spoke);
        return { mesh: moon, solidMesh: moonSolidMesh, spoke, angle, radius: moonOrbitR, speed, code: s.code, name: s.name, chgPct };
      });

      orbitHolder.add(planetGroup);
      // ★ 同一方向組內轉速要一致，相對角度差才會鎖死不變——這正是驗證時的假設，
      // 不能再用之前的 i*0.0001 遞增差異
      sys.planetGroups.push({ group: planetGroup, orbitHolder, orbitR, angle: angleFor(i), speed: 0.001 * direction, moons, sector, solidMesh: industrySphere.userData.solidMesh, orbitGradient, moonRingGradient });
    });
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

    // ★ 遍歷全部星系（台股+美股）分別建立標籤，不再只處理單一全域星系
    Object.entries(this._systems || {}).forEach(([market, sys]) => {
      const coreLabel = document.createElement('div');
      coreLabel.className = 'theater-3d-label theater-3d-label-core';
      coreLabel.textContent = market === 'US' ? 'S&P 500' : '加權指數';
      labelLayer.appendChild(coreLabel);
      sys.coreLabelEl = coreLabel;

      sys.planetGroups.forEach(p => {
        const label = document.createElement('div');
        label.className = 'theater-3d-label';
        label.textContent = p.sector;
        // ★ 修正字級沒有真正跟著滾輪縮放的問題：之前用「世界座標半徑」算字級，
        // 但球體在螢幕上的實際大小會隨鏡頭縮放(this._zoomDistance)即時改變，
        // 兩者沒有真正綁在一起。改成字級/最大寬度都移到_updateLabels()裡，
        // 每一幀用「螢幕投影後的實際像素大小」重新計算，才會真正跟著滾輪縮放同步。
        label.style.overflow = 'hidden';
        label.style.textOverflow = 'ellipsis';
        label.style.whiteSpace = 'nowrap';
        labelLayer.appendChild(label);
        p.labelEl = label;

        // ★ 修正小球沒有代號跟漲跌幅的問題+改成名字在上、漲幅在下：
        // 拆成兩個獨立的標籤元素，各自定位在小球的上方跟下方
        p.moons.forEach(m => {
          const nameLabel = document.createElement('div');
          nameLabel.className = 'theater-3d-label theater-3d-label-moon';
          nameLabel.textContent = m.name || m.code;
          nameLabel.style.color = m.chgPct >= 0 ? '#e0524f' : '#1d9e75';
          nameLabel.style.textShadow = '0 0 1.2px #fff, 0 0 1.2px #fff';
          labelLayer.appendChild(nameLabel);
          m.nameLabelEl = nameLabel;

          const pctLabel = document.createElement('div');
          pctLabel.className = 'theater-3d-label theater-3d-label-moon';
          pctLabel.textContent = `${m.chgPct>=0?'+':''}${m.chgPct.toFixed(1)}%`;
          pctLabel.style.color = m.chgPct >= 0 ? '#e0524f' : '#1d9e75';
          pctLabel.style.textShadow = '0 0 1.2px #fff, 0 0 1.2px #fff';
          labelLayer.appendChild(pctLabel);
          m.pctLabelEl = pctLabel;
        });
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
      svg.style.cssText = 'position:absolute; bottom:15px; left:0; width:100%; height:150px; pointer-events:none;';
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
    path.setAttribute('stroke-width', '5');
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
      // ★ 加入碼表感：每7天(一週)一個長刻度，其餘是短刻度，模擬碼表錶面的分段感
      const isWeekMark = d % 7 === 0;
      const tickLen = d === 0 ? 10 : (isWeekMark ? 7 : 4);
      tick.setAttribute('x1', pos.x); tick.setAttribute('y1', pos.y-tickLen);
      tick.setAttribute('x2', pos.x); tick.setAttribute('y2', pos.y+tickLen);
      tick.setAttribute('stroke', '#e6edf3');
      tick.setAttribute('stroke-width', d===0 ? 4 : (isWeekMark ? 2.5 : 1.5));
      tick.setAttribute('opacity', d===0 ? 1 : (isWeekMark ? 0.7 : 0.35));
      svg.appendChild(tick);
    }
    // 今天位置額外加一個實心圓點，強化碼表指針感
    const todayDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const todayCirclePos = pointOnArc(0.5);
    todayDot.setAttribute('cx', todayCirclePos.x); todayDot.setAttribute('cy', todayCirclePos.y);
    todayDot.setAttribute('r', '5');
    todayDot.setAttribute('fill', '#e6edf3');
    svg.appendChild(todayDot);

    // 今天：正中央，即時日期時間文字（字體大幅加大，一眼就要看得清楚）
    let todayLabel = document.getElementById('theater-today-label');
    if (!todayLabel) {
      todayLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      todayLabel.id = 'theater-today-label';
      todayLabel.setAttribute('text-anchor', 'middle');
      todayLabel.setAttribute('fill', '#e6edf3');
      todayLabel.setAttribute('font-family', 'monospace'); // 等寬字體強化碼表/儀表數字感
    }
    todayLabel.setAttribute('font-size', '26');
    todayLabel.setAttribute('font-weight', '700');
    svg.appendChild(todayLabel);
    const todayPos = pointOnArc(0.5);
    todayLabel.setAttribute('x', todayPos.x);
    todayLabel.setAttribute('y', todayPos.y - 22);
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
      text.setAttribute('x', pos.x); text.setAttribute('y', pos.y + r + 20);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', '#c4b5fd');
      text.setAttribute('font-size', '14');
      text.setAttribute('font-weight', '700');
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
    const isOccludedByRay = (worldPos, excludeMesh) => {
      if (!this._occluders || !this._occluders.length) return false;
      const dir = worldPos.clone().sub(this._camera.position).normalize();
      const distToTarget = this._camera.position.distanceTo(worldPos);
      this._raycaster.set(this._camera.position, dir);
      const testList = excludeMesh ? this._occluders.filter(m => m !== excludeMesh) : this._occluders;
      const hits = this._raycaster.intersectObjects(testList, false);
      return hits.length > 0 && hits[0].distance < distToTarget - 0.02;
    };

    const projectPoint = (worldPos) => {
      const vec = worldPos.clone();
      vec.project(this._camera);
      return { x: (vec.x*0.5+0.5)*w, y: (-vec.y*0.5+0.5)*h, behind: vec.z > 1 };
    };

    // ★ 重新設計遮擋判定：之前只測試「精準光線是否穿過正中心那一個點」，
    // 兩個球體只要沒有精準對齊中心（螢幕上明明已經疊在一起了），判定還是說「沒遮擋」，
    // 導致文字疊字、小球飄過去文字卻不消失。改成額外加一層「螢幕空間範圍重疊」判定：
    // 只要有任何一個更靠近鏡頭的球體/小球，投影後的螢幕位置夠接近這段文字，
    // 不管有沒有精準對齊中心，都算被遮擋。這樣才符合「肉眼看起來重疊了」的直覺。
    const gatherOccluderCandidates = () => {
      const list = [];
      Object.values(this._systems || {}).forEach(sys => {
        if (!sys.core || !sys.core.visible) return;
        const coreWorldPos = new THREE.Vector3();
        sys.core.getWorldPosition(coreWorldPos);
        const coreDist = this._camera.position.distanceTo(coreWorldPos);
        const coreScreenR = this._core === sys.core ? 0 : 0; // 佔位，實際半徑下面用geometry算
        const coreRadius = sys.core.userData.solidMesh?.geometry?.parameters?.radius || 0.3;
        list.push({ worldPos: coreWorldPos, dist: coreDist, screenPos: projectPoint(coreWorldPos), radius: coreRadius });
        sys.planetGroups.forEach(p => {
          const pWorldPos = new THREE.Vector3();
          p.group.getWorldPosition(pWorldPos);
          const pDist = this._camera.position.distanceTo(pWorldPos);
          const pRadius = p.solidMesh?.geometry?.parameters?.radius || 0.2;
          list.push({ worldPos: pWorldPos, dist: pDist, screenPos: projectPoint(pWorldPos), radius: pRadius });
          p.moons.forEach(m => {
            const mWorldPos = new THREE.Vector3();
            m.mesh.getWorldPosition(mWorldPos);
            const mDist = this._camera.position.distanceTo(mWorldPos);
            const mRadius = m.solidMesh?.geometry?.parameters?.radius || 0.05;
            list.push({ worldPos: mWorldPos, dist: mDist, screenPos: projectPoint(mWorldPos), radius: mRadius });
          });
        });
      });
      return list;
    };
    const occluderCandidates = gatherOccluderCandidates();

    // targetDist: 這段文字對應的球體離鏡頭多遠(用來判斷誰在誰前面)
    // targetScreenPos: 這段文字的螢幕座標
    // excludeWorldPos: 排除自己這顆球(不要自己跟自己比對)
    const isOccludedByProximity = (targetScreenPos, targetDist, excludeWorldPos) => {
      for (const c of occluderCandidates) {
        if (excludeWorldPos && c.worldPos.equals(excludeWorldPos)) continue;
        if (c.dist >= targetDist - 0.01) continue; // 必須比目標更靠近鏡頭，才有資格「擋住」
        const dx = c.screenPos.x - targetScreenPos.x, dy = c.screenPos.y - targetScreenPos.y;
        const screenDist = Math.sqrt(dx*dx + dy*dy);
        // 用這顆遮擋候選球自己的世界半徑，換算成大概的螢幕像素半徑當判定門檻
        const projR = projectedRadiusPx(c.worldPos, c.radius);
        if (screenDist < projR * 1.1) return true; // 留一點餘裕(1.1倍)，比精準邊緣再寬鬆一點
      }
      return false;
    };

    const projectedRadiusPx = (worldCenter, worldRadius) => {
      const edge = worldCenter.clone().add(new THREE.Vector3(worldRadius, 0, 0));
      const vC = worldCenter.clone().project(this._camera);
      const vE = edge.project(this._camera);
      const pxC = { x: (vC.x*0.5+0.5)*w, y: (-vC.y*0.5+0.5)*h };
      const pxE = { x: (vE.x*0.5+0.5)*w, y: (-vE.y*0.5+0.5)*h };
      return Math.sqrt((pxE.x-pxC.x)**2 + (pxE.y-pxC.y)**2);
    };

    const project = (obj3d, ownMesh) => {
      const vec = new THREE.Vector3();
      obj3d.getWorldPosition(vec);
      const worldPos = vec.clone();
      const screenPos = projectPoint(worldPos);
      const dist = this._camera.position.distanceTo(worldPos);
      const occluded = isOccludedByRay(worldPos, ownMesh) || isOccludedByProximity(screenPos, dist, worldPos);
      return { x: screenPos.x, y: screenPos.y, behind: screenPos.behind, occluded, worldPos };
    };

    // ★ 修正字級沒有真正跟著滾輪縮放的問題：算出球體「螢幕投影後的實際像素半徑」，
    // 不是用世界座標半徑——這樣不管鏡頭拉近拉遠，字級都會跟著球體實際看起來多大來調整，
    // 才是真正的「跟著滾輪縮放同步」。（跟上面的projectedRadiusPx是同一件事，直接沿用）
    const projectedPixelRadius = projectedRadiusPx;

    // ★ 遍歷全部星系（台股+美股）分別更新標籤位置/遮擋判定；不可見的星系直接隱藏標籤跳過計算
    Object.values(this._systems || {}).forEach(sys => {
      if (sys.core && !sys.core.visible) {
        if (sys.coreLabelEl) sys.coreLabelEl.style.display = 'none';
        sys.planetGroups.forEach(p => {
          if (p.labelEl) p.labelEl.style.display = 'none';
          p.moons.forEach(m => {
            if (m.nameLabelEl) m.nameLabelEl.style.display = 'none';
            if (m.pctLabelEl) m.pctLabelEl.style.display = 'none';
          });
        });
        return;
      }
      if (sys.coreLabelEl && sys.core) {
        const p = project(sys.core, sys.core.userData.solidMesh);
        sys.coreLabelEl.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
        sys.coreLabelEl.style.display = (p.behind || p.occluded) ? 'none' : 'block';
      }
      sys.planetGroups.forEach(p => {
        if (p.labelEl) {
          const pos = project(p.group, p.solidMesh);
          p.labelEl.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%, -50%)`;
          p.labelEl.style.display = (pos.behind || pos.occluded) ? 'none' : 'block';
          // ★ 修正字級跟著公轉位置亂跳的問題：之前用「當下離鏡頭多遠」算，球體公轉移動時
          // 忽近忽遠，字級也跟著一直變動，感覺像沒有真的對應球體大小。改成主要看
          // 「球體本身世界座標大小」（穩定、不會因為公轉位置改變），縮放等級只當一個
          // 全體一致的整體倍率（zoomDistance越小=鏡頭越近=全部字一起放大），
          // 這樣同一顆球的字級才會穩定，不同球之間的相對大小也才會真正反映球體大小。
          const sphereRadius = p.solidMesh?.geometry?.parameters?.radius || 0.3;
          const zoomFactor = 9.5 / (this._zoomDistance ?? 9.5); // 用預設縮放距離當基準
          const maxWidthPx = sphereRadius * 260 * zoomFactor;
          const idealFontPx = Math.max(8, Math.min(40, Math.round(sphereRadius * 55 * zoomFactor)));
          // ★ 修正長產業名稱被省略號截斷的問題：不要截斷，改成依文字長度動態縮小字級，
          // 讓完整文字剛好塞進球體的可視寬度內。中文字大約跟字級等寬，用文字長度概估寬度，
          // 算出來的字級如果比「理想字級」小，就用縮小過的，確保完整顯示不被裁切。
          const textLen = p.sector.length;
          const estWidthPerChar = 0.95; // 中文字寬度約略等於字級本身
          const fitFontPx = Math.floor(maxWidthPx / (textLen * estWidthPerChar));
          const fontPx = Math.max(6, Math.min(idealFontPx, fitFontPx));
          p.labelEl.style.fontSize = `${fontPx}px`;
          p.labelEl.style.maxWidth = `${Math.round(maxWidthPx)}px`;
          // 字級已經算過會剛好塞進去，這裡不再需要省略號截斷保險
          p.labelEl.style.overflow = 'visible';
          p.labelEl.style.textOverflow = 'clip';
        }
        p.moons.forEach(m => {
          if (!m.nameLabelEl || !m.pctLabelEl) return;
          const mpos = project(m.mesh, m.solidMesh);
          const visible = !(mpos.behind || mpos.occluded);
          // ★ 名字在上方、漲幅在下方，不是都堆疊在同一側
          m.nameLabelEl.style.transform = `translate(${mpos.x}px, ${mpos.y - 14}px) translate(-50%, -50%)`;
          m.nameLabelEl.style.display = visible ? 'block' : 'none';
          m.pctLabelEl.style.transform = `translate(${mpos.x}px, ${mpos.y + 14}px) translate(-50%, -50%)`;
          m.pctLabelEl.style.display = visible ? 'block' : 'none';
        });
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

    // ★ 遍歷全部星系（台股+美股），各自的核心球自轉、公轉、漸層更新都要跑一遍
    Object.values(this._systems || {}).forEach(sys => {
      if (sys.core) sys.core.rotation.y += (sys.core.userData.spinSpeed || 0.0008) * this._speedMul;
      sys.planetGroups.forEach(p => {
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
        // ★ 依目前角度更新軌道漸層：中球軌道用中球自己的角度；小球環用「這個環上全部小球」的角度
        if (p.orbitGradient) this._updateOrbitGradient(p.orbitGradient, [p.angle]);
        if (p.moonRingGradient) this._updateOrbitGradient(p.moonRingGradient, p.moons.map(m => m.angle));
      });
    });
    if (this._stars) this._stars.rotation.y += 0.00015 * this._speedMul;
    // ★ 修正拖曳旋轉繞錯中心點的問題：之前是「轉整個場景」，但場景永遠繞著世界原點
    // （台股星系的位置）轉，美股星系位移過，繞錯的點轉就會偏移、看起來歪掉。
    // 改成「攝影機繞著目前鎖定的星系球心公轉」，不管看哪個星系都會正確繞著它自己轉。
    // 飛行動畫進行中(_flyAnimId存在)時跳過，避免跟飛行動畫互相打架搶著設定攝影機位置。
    if (this._cameraLookAt) {
      const target = this._cameraLookAt;
      const radius = this._zoomDistance ?? 9.5;
      const polar = this._userRotX ?? 0.06;
      const azimuth = this._userRotY ?? 0;
      this._camera.position.x = target.x + radius * Math.sin(azimuth) * Math.cos(polar);
      this._camera.position.y = target.y + radius * Math.sin(polar);
      this._camera.position.z = target.z + radius * Math.cos(azimuth) * Math.cos(polar);
      this._camera.lookAt(target.x, target.y, target.z);
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
        // ★ 資產表現面板改成切換DOM結構（投組四格↔淨值圖），不是純文字輪播
        if (key === 'asset' && this._applyAssetState) {
          this._applyAssetState(idx.current);
          const dots = document.querySelectorAll('#theater-panel-asset-dots .theater-dot');
          dots.forEach((d, i) => d.classList.toggle('active', i === idx.current % 2));
        } else {
          this._rotatePanel(key, idx.current);
        }
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
      const contentEl = document.getElementById('theater-panel-asset-content');
      const chartEl = document.getElementById('theater-panel-asset-chart');
      if (!contentEl || !chartEl) return;

      // ★ 改用一般模式「投資組合」區塊完全一樣的四格數字，直接讀取那些DOM元素的
      // 現成內容（不自己重算），保證兩邊數字永遠一致，不會有兩套邏輯算出不同數字的風險
      const readVal = (id) => document.getElementById(id)?.textContent ?? '—';
      this._assetGridHTML = `
        <div class="theater-portfolio-grid">
          <div><div class="tpg-label">總市值</div><div class="tpg-value">${readVal('total-value')}</div></div>
          <div><div class="tpg-label">未實現損益</div><div class="tpg-value">${readVal('total-pnl')}</div></div>
          <div><div class="tpg-label">今日損益</div><div class="tpg-value">${readVal('day-pnl')}</div></div>
          <div><div class="tpg-label">報酬率</div><div class="tpg-value">${readVal('total-roi')}</div></div>
        </div>`;

      // ★ 圖表：淨值走勢小型折線圖，複用績效頁已經在存的歷史資料，不用另外抓
      const history = JSON.parse(localStorage.getItem('twsa-value-history') || '[]');
      this._drawSparkline('theater-panel-asset-chart', history.slice(-30).map(h => h.value ?? h.v ?? h));

      // 兩個畫面交替：投組四格 ↔ 淨值走勢圖，用同一套輪播機制但這次切的是DOM結構不是純文字
      this._assetRotateState = this._assetRotateState ?? 0;
      const applyAssetState = (idx) => {
        const showGrid = idx % 2 === 0;
        contentEl.innerHTML = showGrid ? this._assetGridHTML : '';
        chartEl.style.display = showGrid ? 'none' : 'block';
      };
      applyAssetState(0);
      this._applyAssetState = applyAssetState; // 存起來供輪播計時器呼叫
      const dotsEl = document.getElementById('theater-panel-asset-dots');
      if (dotsEl) dotsEl.innerHTML = `<span class="theater-dot active"></span><span class="theater-dot"></span>`;
    } catch(e) { /* 靜默失敗，維持上一次畫面即可 */ }
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
