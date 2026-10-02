/* ============================================================================
 * 大屏接入入口（ES module）
 * ----------------------------------------------------------------------------
 * 职责：
 *   1) 通过 window.BridgeThree.load() 取得**本地** three.js（离线可用）
 *   2) 初始化花江峡谷大桥三维数字孪生场景 + HUD，并在窗口尺寸变化时同步
 *   3) 对外暴露 window.TwinScene，供模板内联脚本每秒推送风险等级与测点数值
 *   4) 任何失败都如实降级：WebGL 不可用 / 模块加载失败 → 显示离线提示并回退
 *      到原有的 2D 桥梁示意图（不静默假装成功）
 * ==========================================================================*/
(function () {
  'use strict';

  var container = document.getElementById('twinCanvas');
  var labelLayer = document.getElementById('twinLabels');
  var hudLayer = document.getElementById('twinHud');
  var fallback = document.getElementById('sceneFallback');
  var statusEl = document.getElementById('twinStatus');

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'twin-status' + (cls ? ' ' + cls : '');
  }
  function showFallback(reason) {
    if (fallback) fallback.hidden = false;
    if (container) container.style.display = 'none';
    setStatus('3D 场景不可用：' + reason, 'err');
    window.TWIN_3D_READY = false;
    window.TWIN_3D_ERROR = reason;
    if (window.console && console.warn) console.warn('[twin] 3D 场景降级：' + reason);
  }

  if (!container) { window.TWIN_3D_READY = false; return; }

  // WebGL 可用性探测：不可用时立刻降级，避免把黑屏当成“加载中”
  function webglOk() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return false;
      var lose = gl.getExtension && gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return true;
    } catch (e) { return false; }
  }
  if (!webglOk()) { showFallback('当前浏览器/显卡未启用 WebGL'); return; }

  if (!window.BridgeThree || typeof window.BridgeThree.load !== 'function') {
    showFallback('three.js 引导脚本未加载（/static/js/three-boot.js）');
    return;
  }

  setStatus('三维场景加载中…');
  var t0 = performance.now();

  /* ==========================================================================
   * P2 性能对象兜底（契约 §3.3 / §3.6）
   * --------------------------------------------------------------------------
   * api.perf 由 scene.js（perf-core）实现，是唯一真相；这里**只在它缺失时**补一个
   * 同字段名的兼容对象，数据同样来自真实测量源（three.js 每次 renderer.render 递增的
   * info.render.frame 计数 + renderer.info 的 draw calls / 三角形数），绝不写死常量。
   * 为什么要兜：角标、window.TWIN_PERF、/static/perf.html 三处都读这一个对象，
   * 任何环境下它缺失，整块验收工具就会变成一片「--」，现场没有第二次机会解释。
   * scene.js 一旦提供 api.perf，本垫片完全不生效，也不覆盖它的任何字段。
   * ========================================================================*/
  function isMobileGuess() {
    try {
      var ua = navigator.userAgent || '';
      var byUa = /Android|iPhone|iPad|iPod|Windows Phone|HarmonyOS|Mobile/i.test(ua);
      var coarse = !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches);
      var narrow = Math.min(window.innerWidth || 9999,
        (window.screen && screen.width) || 9999) <= 768;
      return byUa || (coarse && narrow);
    } catch (e) { return false; }
  }

  function fillDeviceInfo(perf) {
    if (!perf) return perf;
    var d = perf.device || (perf.device = {});
    d.ua = navigator.userAgent || '';
    d.mobile = isMobileGuess();
    d.screen = [window.screen ? screen.width : 0, window.screen ? screen.height : 0];
    d.dpr = window.devicePixelRatio || 1;
    d.cores = navigator.hardwareConcurrency || 0;
    d.memoryGB = navigator.deviceMemory || 0;
    return d;
  }

  function createFallbackPerf(api) {
    var canvasEl = api.renderer.domElement;
    var gl = null;
    try { gl = api.renderer.getContext(); } catch (e) { gl = null; }
    var attrs = (gl && typeof gl.getContextAttributes === 'function') ? gl.getContextAttributes() : null;
    var mobile = isMobileGuess();
    // localStorage 脏值一律回落默认（契约 §1 红线 3），任何异常都不许抛到启动链路
    function ls(key, allowed, dft) {
      try {
        var v = window.localStorage.getItem(key);
        return (v && allowed.indexOf(v) >= 0) ? v : dft;
      } catch (e) { return dft; }
    }
    var tierRaw = ls('twin.qualityTier', ['auto', 'high', 'medium', 'low', 'ultraLow'], 'auto');
    var p = {
      fps: 0, frameMs: 0, frameMsP95: 0, samples: 0,
      tier: tierRaw === 'auto' ? 'high' : tierRaw,
      tierLabel: '', auto: tierRaw === 'auto',
      targetFps: parseInt(ls('twin.targetFps', ['30', '60', '120'], mobile ? '30' : '60'), 10),
      refreshHz: 60,
      drawCalls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0,
      dpr: window.devicePixelRatio || 1, pixelRatio: 1,
      antialias: !!(attrs && attrs.antialias),
      canvas: [canvasEl.width, canvasEl.height], msaaSamples: 0,
      renders: 0, frames: 0, idle: false, interacting: false,
      visible: true, running: true,
      theme: ls('twin.theme', ['light', 'dark'], 'light'),
      insufficient: false,
      reason: '兼容垫片生效：api.perf 应由 scene.js（perf-core）提供，当前未检测到',
      reasons: [], device: {}, __shim: true,
    };
    var TIER_LABEL = { high: '高', medium: '中', low: '低', ultraLow: '极低' };
    p.tierLabel = TIER_LABEL[p.tier] || p.tier;

    var lastFrame = -1, lastT = 0, msWin = [], glRef = null, glFor = null;
    window.setInterval(function () {
      // ⚠ 不缓存 renderer/canvas：画质降档时 perf-core 会就地替换 api.renderer 与新 canvas
      var rend = api.renderer;
      if (!rend || !rend.info) return;
      var info = rend.info;
      var cv = rend.domElement;
      if (glFor !== rend) {
        glFor = rend;
        try { glRef = rend.getContext(); } catch (e) { glRef = null; }
        lastFrame = -1;
      }
      var now = performance.now();
      var f = (info.render && info.render.frame) || 0;
      // 页面隐藏时不统计（红线 5：后台不占用资源），只对齐基准避免恢复时出现巨大 dt
      if (document.hidden) { lastFrame = f; lastT = now; return; }
      if (lastFrame < 0) { lastFrame = f; lastT = now; return; }
      var dt = (now - lastT) / 1000;
      if (dt <= 0) return;
      var df = Math.max(0, f - lastFrame);
      p.fps = df / dt;                              // 真实推帧速率（不是显示器刷新率）
      p.frameMs = df > 0 ? (dt * 1000) / df : 0;
      msWin.push(p.frameMs);
      if (msWin.length > 40) msWin.shift();
      p.samples = msWin.length;
      var sorted = msWin.slice().sort(function (a, b) { return a - b; });
      p.frameMsP95 = sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : p.frameMs;
      p.drawCalls = info.render.calls || 0;
      p.triangles = info.render.triangles || 0;
      p.geometries = (info.memory && info.memory.geometries) || 0;
      p.textures = (info.memory && info.memory.textures) || 0;
      p.programs = (info.programs || []).length;
      p.renders = f;
      p.frames = f;
      p.pixelRatio = rend.getPixelRatio();
      p.canvas = [cv.width, cv.height];
      if (glRef && glRef.getParameter) {
        try { p.msaaSamples = glRef.getParameter(glRef.SAMPLES) || 0; } catch (e) { /* 忽略 */ }
      }
      if (api.state) {
        p.running = api.state.running !== false;
        p.visible = api.state.visible !== false;
      }
      lastFrame = f;
      lastT = now;
    }, 500);
    return p;
  }

  window.BridgeThree.load().then(function (mods) {
    return import('./scene.js').then(function (sceneMod) {
      var api = sceneMod.createTwinScene({
        THREE: mods.THREE,
        OrbitControls: mods.OrbitControls,
        container: container,
        labelLayer: labelLayer,
      });
      return import('./hud.js').then(function (hudMod) {
        var hud = hudMod.buildHud(api, hudLayer);
        return { api: api, hud: hud, mods: mods };
      });
    });
  }).then(function (r) {
    var api = r.api, mods = r.mods;
    var ms = Math.round(performance.now() - t0);

    // 尺寸同步：窗口变化（大屏整体缩放由模板的 fitScreen 负责，画布只需跟随 CSS 尺寸）
    var onResize = function () { api.resize(); };
    window.addEventListener('resize', onResize);
    window.setInterval(onResize, 1000);   // 投影切换分辨率兜底

    /* ---------- 性能对象（契约 §3.3 / §3.6）----------
       window.TWIN_PERF 必须与 api.perf **同一引用**（不得深拷贝）：
       角标、/static/perf.html、验证脚本读的都是这一个对象，
       任何拷贝都会让「屏幕上的数字」和「脚本读到的数字」分叉。 */
    var perf = (api.perf && typeof api.perf === 'object') ? api.perf : createFallbackPerf(api);
    if (!api.perf) api.perf = perf;
    window.TWIN_PERF = perf;
    fillDeviceInfo(perf);            // 补 device（UA/移动判定/screen/DPR/cores/deviceMemory）

    /* ---------- 可见性单闸门（契约 §3.6）----------
       shouldRun = 页面可见 && 画布在视口内 && 未被 pagehide 冻结。
       三个来源（visibilitychange / IntersectionObserver / pagehide-pageshow）只改各自的
       布尔量，最后统一由 applyActive() 调 api.setActive(on)：
       旧实现里 visibilitychange 直接 setVisible+start/stop、IntersectionObserver 只改
       setVisible，两套逻辑互相覆盖，会出现「切回前台仍然不渲染」的竞态。 */
    var inViewport = true;
    var pageFrozen = false;
    var lastActive = null;
    function shouldRun() { return !document.hidden && inViewport && !pageFrozen; }
    function applyActive(force) {
      var on = shouldRun();
      if (!force && on === lastActive) return;
      lastActive = on;
      if (typeof api.setActive === 'function') {
        api.setActive(on);          // perf-core 的单闸门：false → cancelAnimationFrame + clearInterval
      } else {
        // 兼容回退：scene.js 只有 setVisible/start/stop 时，自己组出同样的语义
        api.setVisible(on);
        if (on) { api.resize(); api.start(); } else { api.stop(); }
      }
      if (perf.__shim) perf.running = on;   // 垫片模式下把闸门状态如实反映给角标/自测页
      if (window.console && console.debug) {
        console.debug('[twin] 渲染闸门 → ' + (on ? '运行' : '暂停') + '（hidden=' + document.hidden +
          ' inViewport=' + inViewport + ' pagehide=' + pageFrozen + '）');
      }
    }
    document.addEventListener('visibilitychange', function () { applyActive(); });
    window.addEventListener('pagehide', function () { pageFrozen = true; applyActive(); });
    window.addEventListener('pageshow', function () { pageFrozen = false; applyActive(); });
    if (typeof IntersectionObserver !== 'undefined') {
      new IntersectionObserver(function (entries) {
        var e = entries[entries.length - 1];   // 只观察一个容器，取最后一条即可
        inViewport = !!e.isIntersecting;
        applyActive();
      }, { threshold: 0.02 }).observe(container);   // 阈值 0.02 保留（契约 §3.6）
    }
    applyActive(true);   // 首帧强制对齐一次：在后台标签里打开时不该偷偷启动渲染循环

    /* 诊断句柄（验证脚本 / 现场排障用，不参与业务逻辑）：
       闸门有三个输入，任何一个卡住都会表现为「切回前台不渲染」，
       把三个布尔量直接暴露出来，排障时不必再猜是哪一个卡住。 */
    window.TWIN_3D_GATE = function () {
      return {
        shouldRun: shouldRun(),
        inViewport: inViewport,
        pageFrozen: pageFrozen,
        documentHidden: !!document.hidden,
        lastActive: lastActive,
        blockedByHidden: !!(api.state && api.state.blockedByHidden),
        stateRunning: !!(api.state && api.state.running),
        perfRunning: perf.running,
        perfVisible: perf.visible,
        hasSetActive: typeof api.setActive === 'function',
      };
    };

    // 渲染循环若因异常停止，如实暴露（不静默把黑屏当成功）
    window.setInterval(function () {
      if (api.state.lastError && !api.state.stoppedByError) {
        api.state.stoppedByError = true;
        setStatus('三维渲染异常：' + api.state.lastError, 'err');
      }
    }, 2000);

    // 3D 已就绪：给场景容器打标记（CSS 据此压低伪 3D 地台/粒子的不透明度）
    var sceneBox = document.getElementById('scene');
    if (sceneBox) sceneBox.classList.add('twin-on');

    /* WebGL 上下文丢失（切换显卡/远程桌面/驱动异常）也要如实说明，而不是留一块黑屏。
       ⚠ P2 关键：画质降到 low/ultraLow 要关 MSAA，perf-core 会新建 WebGLRenderer + 新 canvas
       并**就地替换 api.renderer**（旧 canvas 随后才 dispose + forceContextLoss）。因此：
         · 每次都用 api.renderer.domElement 取"当前"画布，绝不缓存；
         · 旧画布的 contextlost 迟到事件必须忽略（比对 ev.target），否则降档瞬间状态条会被
           写成「WebGL 上下文丢失，正在等待恢复…」，看起来像挂了而实际新画布渲染正常；
         · 换 canvas 后要重新绑监听：优先 api.onRendererRebuilt，退化路径监听
           容器/窗口上的 twin:renderer-rebuilt 事件（perf-core 在 dispose 之前同步派发）。 */
    function bindCanvasDiag() {
      var el = api.renderer && api.renderer.domElement;
      if (!el || el.__twinDiagBound) return;
      el.__twinDiagBound = true;
      el.addEventListener('webglcontextlost', function (ev) {
        if (ev.target !== (api.renderer && api.renderer.domElement)) return;   // 旧画布的迟到事件
        ev.preventDefault();
        setStatus('WebGL 上下文丢失，正在等待恢复…', 'err');
      });
      el.addEventListener('webglcontextrestored', function () {
        if (el !== (api.renderer && api.renderer.domElement)) return;
        setStatus('WebGL 上下文已恢复');
      });
    }
    bindCanvasDiag();
    window.addEventListener('twin:renderer-rebuilt', bindCanvasDiag);
    if (typeof api.onRendererRebuilt === 'function') api.onRendererRebuilt(bindCanvasDiag);

    var s = api.stats;
    setStatus('花江峡谷大桥 · 主跨 ' + s.mainSpan + ' m · 桥高 625 m · ' +
      (mods.source === 'local' ? '本地 three.js' : 'CDN three.js') + ' · ' + ms + ' ms');
    if (mods.source !== 'local') setStatus('三维场景已加载（使用了 CDN 兜底 three.js）', 'warn');

    // 诊断/验证用句柄（测试与现场排障都靠它，避免只能“看图猜”）
    window.TwinScene = api;
    window.TWIN_3D_READY = true;
    window.TWIN_3D_INFO = {
      source: mods.source,
      revision: mods.revision || (mods.THREE && mods.THREE.REVISION),
      importMapMode: window.BridgeThree.importMapMode,
      fallbackUsed: !!window.BridgeThree.fallbackUsed,
      bootMs: ms,
      stats: s,
    };
  }).catch(function (err) {
    var msg = (err && (err.message || err)) || '未知错误';
    showFallback(String(msg).slice(0, 160));
  });
})();
