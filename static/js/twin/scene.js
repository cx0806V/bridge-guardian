/* ============================================================================
 * 数字孪生场景控制器：渲染器 / 相机 / 主题 / 交互 / 风险联动 / 性能闸门
 * ----------------------------------------------------------------------------
 * 交互能力（“可操控”的具体口径，P2 一条都没删）：
 *   · 左键拖拽 = 轨道旋转；滚轮 = 缩放；右键拖拽 = 平移；触屏单指旋转、双指缩放平移
 *   · 双击任意位置 = 以该点为中心平滑飞行（聚焦）
 *   · 单击结构测点 = 弹出该热点说明；点击空白处取消
 *   · 预设视角：全桥 / 跨中 / 桥塔 / 峡谷 / 桥面 / 复位；支持自动旋转
 *   · 视角模式：实体 / 线框（结构透视）
 * 数据联动（与大屏其余面板同源，数据来自 /api/data）：
 *   · 风险等级 → 全场主题色 + 测点扩散环节奏 + 吊索按荷载着色（增量上传）
 *
 * 主题（P2）：浅色为默认、深色可切；主题数据/环境贴图/光照/雾/材质全部由
 *   theme.js（look-canyon）提供，本文件只按契约 §3.1 的签名调用。
 *
 * ============================ P2 性能改动摘要（为什么这么改）================
 * 改前（Lead 实测基线，headless Edge + SwiftShader 软件渲染）暴露出四个问题：
 *   ① TARGET_FPS 写死 30，且限帧写成 `now - lastTick < frameInterval * 0.7`：
 *      那个 ×0.7 会让实际帧率比目标高 43%，"限帧"根本没限住，也说不清目标是多少。
 *   ② 空载降载用 `state.frames % 3` 抽帧到 ~10fps：动画看起来像幻灯片，
 *      而且用户一拖拽也会被抽帧（手感发涩）。
 *   ③ 每 6 帧无条件重算 256 根吊索颜色 + 整块上传：6s 里每个 mesh 上传 25 次颜色缓冲，
 *      而颜色根本没变。
 *   ④ antialias=true + setPixelRatio(min(dpr,1.4)) 恒定：没有任何自适应能力。
 * 现在：
 *   · 目标帧率可配置（30/60/120，默认桌面 min(60,刷新率)、手机 min(30,刷新率)），
 *     硬间隔限帧（删掉 ×0.7），rAF 时间戳优先接入；
 *   · 交互中满帧；真正静止 600ms 后才降到 min(30,target)，动画一律按真实 dt 推进；
 *   · 吊索着色只在「风险等级变化 / 荷载跨过 5% 量化台阶 / 主题色收敛」时调用，
 *     bridge.applyRisk 内部再逐实例比色，颜色真的变了才上传；
 *   · 画质阶梯（quality.js）按最近 60 帧中位帧耗时自动升降档：像素比 → 关 AA
 *     （重建 renderer）→ 关雾气/流光 → 降地形密度，一次一档、升档更保守；
 *   · 双驱动保留（rAF 主 + setInterval(1000/24) 兜底），兜底只在 rAF 停了 >400ms
 *     时才推帧，保证不重复渲染；
 *   · api.setActive(on) 是唯一可见性闸门：false 时 rAF 与 interval 都停，恢复立刻渲染一帧。
 * ==========================================================================*/
import {
  Scene, PerspectiveCamera, WebGLRenderer, Color, Group, Vector3,
  Raycaster, Vector2, MathUtils, LineSegments, LineBasicMaterial,
  ACESFilmicToneMapping, SRGBColorSpace,
} from 'three';
import { createMaterials } from './materials.js';
import { buildBridge } from './bridge.js';
import { memberEdges } from './lines.js';
import { FACT_SHEET, FIDELITY_NOTE, HOTSPOTS } from './spec.js';
import { createQualityController, STORAGE_KEYS, medianOf, pixelRatioCap,
         assessRefreshEstimate } from './quality.js';
/* theme.js / canyon.js 用「命名空间导入」而不是逐个命名导入：
   这两个文件由 look-canyon 并行实现、可能分阶段落地，命名导入一旦缺一个导出就会
   让整个模块解析失败（浏览器直接 404/语法错误 → 整块 3D 降级）。命名空间导入 +
   运行时特性探测可以细粒度降级，同时在契约要求的 5 个函数缺失时**明确报错**（不静默）。 */
import * as themeMod from './theme.js';
import * as canyonMod from './canyon.js';

const RISK_KEY = { 0: 'normal', 1: 'warn', 2: 'alarm', 3: 'crit', 4: 'offline' };
const CANVAS_LABEL = '花江峡谷大桥三维数字孪生场景（可旋转、缩放、平移）';

/* ---- P2 帧率/空载/双驱动的全部阈值（都在这里，便于现场解释） ---- */
const IDLE_AFTER_MS = 600;             // 真正静止 600ms → 空载降载（契约 §4.2）
const LABEL_MIN_INTERVAL_MS = 100;     // 空载/被限帧挡下时，标签跟随间隔上限（≤100ms）
const FALLBACK_GAP_MS = 400;           // 兜底 tick 只在 rAF 停了 >400ms 时推帧（契约 §4.3）
const FALLBACK_INTERVAL_MS = 1000 / 24;// 兜底驱动周期
const WHEEL_WINDOW_MS = 400;           // 刚滚过滚轮算交互（契约 §4.2）
const POINTER_MOVE_WINDOW_MS = 200;    // 刚移动过指针算交互（契约 §4.2）
const REFRESH_SAMPLES = 120;           // 刷新率估算：rAF 间隔样本数（契约 §4.1）
const REFRESH_TIMEOUT_MS = 3000;       // 估算最长等待时间（headless 下 rAF 被饿死，必须能超时回落）
// 置信度判据（样本数 / 中位间隔上限 / IQR 离散度）在 quality.js 的 assessRefreshEstimate 里，可单测
const RISK_LOAD_STEPS = 20;            // 荷载 5% 量化台阶（契约 §3.4）
const CAM_NEAR = 3;                    // near 保持 3：minDistance=25 时最近景仍然不被切
const CAM_FAR = 40000;                 // far 保持 40000：1500m 级山谷 + 远景山脊
const MIN_MAX_DISTANCE = 6200;         // 改前的 maxDistance；窄高视口下必须能放宽（见 widenMaxDistance）
const MAX_DISTANCE_SLACK = 1.2;        // 需求距离 ×1.2 留出「还能再拉远一点」的余量

/**
 * 预设视角定义。
 * 关键点：大屏中央的 3D 舞台是非常扁的宽幅（1920 设计稿下实测约 978×311，
 * 宽高比 3.1:1），如果把机位写成固定坐标，换到别的宽高比就会把主跨截断。
 * 因此这里只定义「看哪个部位、从哪个方向看、要让多大范围入画」，
 * 真正的距离由 fitDistance() 按当前画布宽高比实时算出。
 */
function viewPresets() {
  return [
    { key: 'full', label: '全桥', target: [20, 20, 0], dir: [0, 0.062, -1], spanW: 2750, spanH: 720, note: '主跨 1420m 全景（谷内平视）' },
    { key: 'span', label: '主跨', target: [0, 30, 0], dir: [0, 0.05, -1], spanW: 1800, spanH: 600, note: '跨中主缆低于桥面 28m' },
    { key: 'tower', label: '桥塔', target: [-710, 40, 0], dir: [-1, 0.06, 0.42], spanW: 700, spanH: 430, note: '塔顶索鞍 + 观星水吧' },
    { key: 'canyon', label: '峡谷', target: [40, -60, 0], dir: [-0.3, -0.62, -1], spanW: 2100, spanH: 1180, note: '谷底仰视：桥面至水面 625m' },
    { key: 'deck', label: '桥面', target: [60, 6, 0], dir: [-0.66, 0.03, -1], spanW: 900, spanH: 260, note: '钢桁梁与行车道' },
  ];
}

/** 移动端判定：默认目标帧率（桌面 60 / 手机 30）与初始画质档都用它 */
function detectMobile() {
  try {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua)) return true;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches) {
      const sw = (typeof screen !== 'undefined' && Math.min(screen.width, screen.height)) || 0;
      if (sw && sw <= 820) return true;   // 触屏笔记本的 coarse 指针不算手机
    }
  } catch (e) { /* 探测失败按桌面处理 */ }
  return false;
}

export function createTwinScene(opts) {
  const THREE = opts.THREE;
  const OrbitControls = opts.OrbitControls;
  const container = opts.container;
  const labelLayer = opts.labelLayer || null;

  function warn(msg) {
    if (typeof console !== 'undefined' && console.warn) console.warn('[twin] ' + msg);
  }

  /* ======================================================================
   * 0. 契约自检 + 主题名 + 设备判定
   * ====================================================================*/
  // 契约 §3.1 的 5 个函数是硬依赖：缺任何一个都直接给出可诊断的错误，
  // 交给 mount.js 的失败通道如实展示（不静默、不留黑屏）。
  const themeFns = {
    getTheme: themeMod.getTheme,
    riskColors: themeMod.riskColors,
    buildEnvironment: themeMod.buildEnvironment,
    applySceneTheme: themeMod.applySceneTheme,
    applyMaterialTheme: themeMod.applyMaterialTheme,
  };
  const missingThemeFns = Object.keys(themeFns).filter((k) => typeof themeFns[k] !== 'function');
  if (missingThemeFns.length) {
    throw new Error('theme.js 缺少契约 §3.1 要求的导出：' + missingThemeFns.join(', '));
  }
  const THEME_NAMES = (themeMod.THEME_NAMES && themeMod.THEME_NAMES.length)
    ? themeMod.THEME_NAMES : ['light', 'dark'];
  const DEFAULT_THEME = themeMod.DEFAULT_THEME || 'light';

  function normalizeTheme(name) {
    if (typeof themeMod.normalizeThemeName === 'function') {
      try { return themeMod.normalizeThemeName(name); } catch (e) { /* 落到下面自己判 */ }
    }
    return THEME_NAMES.indexOf(name) >= 0 ? name : DEFAULT_THEME;
  }
  function readStoredTheme() {
    let v = null;
    try { v = window.localStorage ? window.localStorage.getItem(STORAGE_KEYS.theme) : null; } catch (e) { v = null; }
    return normalizeTheme(v);   // 非法值（脏值/null）一律回落默认主题
  }
  function writeStoredTheme(name) {
    try { if (window.localStorage) window.localStorage.setItem(STORAGE_KEYS.theme, name); } catch (e) { /* 隐私模式忽略 */ }
  }

  let themeName = readStoredTheme();
  const isMobile = detectMobile();

  /* ======================================================================
   * 1. 场景 / 相机 / 画质控制器 / 渲染器
   * ====================================================================*/
  const scene = new Scene();
  // near=3 / far=40000：全桥约 2160m 长、山脊在 ±1000m 外，far 必须大；
  // near 不能随便调大（minDistance=25 时会把近景切掉），7500m 处的深度精度见报告。
  const camera = new PerspectiveCamera(45, 16 / 9, CAM_NEAR, CAM_FAR);

  // 画质控制器先建：渲染器的 antialias 与像素比都要按它的初始档位来。
  let profileHandler = null;
  const quality = createQualityController({
    isMobile: isMobile,
    onChange: function (info) { if (profileHandler) profileHandler(info); },
  });

  const device = {
    ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
    mobile: isMobile,
    screen: [
      (typeof screen !== 'undefined' && screen.width) || 0,
      (typeof screen !== 'undefined' && screen.height) || 0,
    ],
    dpr: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
    cores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0,
    memoryGB: (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0,
  };

  let initialClear = 0xf2f5f7;   // 浅色主题的底色；拿不到 descriptor 时也别让首帧是黑的
  try {
    const d0 = themeFns.getTheme(themeName);
    if (d0 && typeof d0.clear === 'number') initialClear = d0.clear;
  } catch (e) { warn('getTheme 失败，clearColor 用兜底值：' + ((e && e.message) || e)); }

  let renderer = null;
  let canvasEl = null;
  let currentAntialias = !!quality.profile.antialias;
  let currentW = 0;
  let currentH = 0;
  let lastW = -1;
  let lastH = -1;
  let lastPr = -1;
  let lastAspect = 0;

  function containerSize() {
    return {
      w: Math.max(80, container.clientWidth | 0),
      h: Math.max(80, container.clientHeight | 0),
    };
  }

  /**
   * 画质档的像素比上限：桌面走 TIER_PROFILE（≤1.5/1.2/1.0），手机走
   * MOBILE_PIXEL_RATIO_CAP（≤2.0/1.4/1.2/1.0，契约 v1.2 澄清 1 —— 需求书要求
   * 「手机像素比上限 2.0 且默认中档」，其中中档 1.4 = P1 旧值，默认档零回退）。
   * 设备 DPR 更低时不强行放大（省 GPU）；改前是恒定 min(dpr,1.4)，没有任何自适应。
   */
  function effectivePixelRatio() {
    const cap = pixelRatioCap(quality.tier, isMobile);
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return Math.max(0.5, Math.min(dpr, cap));
  }

  /** 实际像素比 + 被哪一层钳住（devicePixelRatio / 档位上限 / 手机 2.0 天花板），供 perf 与原因文案 */
  function pixelRatioInfo() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const cap = pixelRatioCap(quality.tier, isMobile);
    const used = Math.max(0.5, Math.min(dpr, cap));
    let clamp;
    if (dpr <= cap) clamp = 'devicePixelRatio ' + dpr + ' 更低，档位上限 ' + cap + ' 未生效';
    else if (isMobile) clamp = '手机档位上限 ' + cap + '（天花板 2.0）钳住';
    else clamp = '档位上限 ' + cap + ' 钳住';
    return { dpr: dpr, cap: cap, used: used, clamp: clamp };
  }

  /**
   * 建一个 WebGLRenderer。
   * ⚠ 抗锯齿（MSAA）是 **创建 WebGL context 时** 的属性，运行时改不了 —— 这就是
   *   画质阶梯降 AA 必须重建 renderer 的根本原因（见 rebuildRenderer）。
   */
  function createRenderer(antialias) {
    const r = new WebGLRenderer({ antialias: !!antialias, powerPreference: 'high-performance' });
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    if ('outputColorSpace' in r) r.outputColorSpace = SRGBColorSpace;
    r.setClearColor(initialClear, 1);
    r.setPixelRatio(effectivePixelRatio());
    const box = containerSize();
    currentW = box.w; currentH = box.h;
    r.setSize(box.w, box.h, false);       // updateStyle=false：尺寸交给 CSS（.twin-canvas canvas{width:100%}）
    r.domElement.setAttribute('aria-label', CANVAS_LABEL);
    r.domElement.style.touchAction = 'none';
    return r;
  }

  renderer = createRenderer(currentAntialias);
  canvasEl = renderer.domElement;
  container.appendChild(canvasEl);

  /* ======================================================================
   * 2. 材质 / 环境 / 地形 / 桥体 / 线框
   * ====================================================================*/
  const matCtl = createMaterials(THREE);
  const mats = matCtl.mats;
  /* ⚠ envMapIntensity / concrete.roughness 不再在这里写死：
     它们由 theme.js 的 applyMaterialTheme → matCtl.setTheme 按当前主题 descriptor 设置
     （深色主题的 0.15 混凝土反射放到浅色主题下会让岩体发灰）。 */

  const heightAt = canyonMod.makeHeightField();
  const terrainDensityOpts = { density: quality.profile.terrain, theme: themeName };
  const canyon = canyonMod.createCanyon(THREE, heightAt, terrainDensityOpts);
  const river = canyonMod.createRiver(THREE, { theme: themeName });
  const mist = canyonMod.createMist(THREE, heightAt, { theme: themeName, enabled: quality.profile.mist });
  mist.visible = true;                      // 真实状态由 applyTierProfile → applyMist 统一管理
  let mistEnabled = true;
  let cableFlowEnabled = true;
  scene.add(canyon, river, mist);

  const bridge = buildBridge(THREE, matCtl);
  scene.add(bridge.root);

  // 线框结构层（“结构透视”模式用；预先构建，切换时只改可见性）
  const wireRoot = new Group();
  wireRoot.name = 'wireframe';
  /* ⚠ 不透明度/混合模式现在由 theme.js 的 wireframeTheme(THREE, themeName) 决定：
     深色主题是 AdditiveBlending + 0.62（暗背景上亮线），浅色主题是 NormalBlending +
     不透明的深色描边（白底上可读）。这里只给一个中间态初值，applyTheme 会立刻覆盖。
     经验教训：早期把不透明度压到 0.28，「结构线框」开关几乎看不出变化（用户反馈"点了没反应"）；
     而 WebGL 的 linewidth 在多数驱动上被钳成 1px 加不粗，只能靠颜色/混合模式做扎实。 */
  const wireMat = new LineBasicMaterial({
    color: new Color('#334155'), transparent: true, opacity: 0.62, depthWrite: false,
  });
  wireRoot.visible = false;
  scene.add(wireRoot);

  /* ======================================================================
   * 3. 主题接线（契约 §3.1；主题数据全在 theme.js）
   * ====================================================================*/
  let lightGroup = null;

  function applyWireTheme() {
    if (typeof themeMod.wireframeTheme === 'function') {
      try {
        const style = themeMod.wireframeTheme(THREE, themeName);
        if (style) {
          Object.assign(wireMat, style);
          // blending / transparent 变化必须让材质重编译，否则线框看起来还是旧的混合状态
          wireMat.needsUpdate = true;
        }
      } catch (e) { warn('wireframeTheme 失败：' + ((e && e.message) || e)); }
    }
    const rc = themeFns.riskColors(themeName) || {};
    // 线框用**当前风险等级**的主题专色（浅色主题给的是深色描边；五档各不相同）。
    // ⚠ 这里必须读 state.risk，而不是固定用 normal —— 早期写成 rc.normal 导致线框
    //   五档切换时颜色永远不变（自测 F5 抓到）。
    wireMat.color.set(rc[state.risk] || rc.normal || '#334155');
  }

  /**
   * 应用主题：材质级 + 场景级（clearColor / 曝光 / 雾 / 光照组替换+dispose / env RT 重建+dispose）。
   * 换主题与「关 AA 重建 renderer」共用这一条路径 —— 因为 PMREM 环境贴图是绑在
   * 具体 renderer 上的，换了 renderer 就必须重建，否则金属件反光会全黑。
   * 切换主题**不重建几何**（契约 §3.3 setTheme）。
   */
  function applyTheme(name) {
    try { themeFns.applyMaterialTheme(matCtl, name, scene); }
    catch (e) { warn('applyMaterialTheme 失败（继续用现有材质）：' + ((e && e.message) || e)); }
    try {
      const g = themeFns.applySceneTheme({
        THREE: THREE, scene: scene, renderer: renderer, name: name,
        matCtl: matCtl, mist: !!quality.profile.mist,
      });
      if (g && g.parent !== scene) scene.add(g);      // theme.js 没挂进去时兜底
      lightGroup = g || lightGroup;
    } catch (e) {
      warn('applySceneTheme 失败，启用兜底环境贴图：' + ((e && e.message) || e));
      try {
        const handle = themeFns.buildEnvironment(THREE, renderer, name);
        scene.userData.twinEnv = handle;
        scene.environment = (handle && handle.texture) ? handle.texture : handle;
      } catch (e2) { warn('buildEnvironment 兜底也失败：' + ((e2 && e2.message) || e2)); }
    }
    scene.background = null;   // 背景交给 clearColor（与页面底色衔接），不把 env 当天空盒
    applyWireTheme();
  }

  /** 雾气开关（低/极低档关雾气）：canyon.js 负责真实可见性，theme.js 负责雾浓度补偿 */
  function applyMist(on) {
    mistEnabled = !!on;
    if (typeof canyonMod.setMistEnabled === 'function') {
      try { canyonMod.setMistEnabled(mist, mistEnabled); }
      catch (e) { warn('setMistEnabled 失败：' + ((e && e.message) || e)); }
    }
    // 兜底：组与每层都置成目标状态。这样「真实可见层数」在测量里就是 0，
    // 不会出现「组已隐藏但 4 层 children.visible 仍为 true」的歧义读数。
    if (mist.visible !== mistEnabled) mist.visible = mistEnabled;
    mist.children.forEach((l) => { if (l.visible !== mistEnabled) l.visible = mistEnabled; });
    if (typeof themeMod.applyFog === 'function') {
      try { themeMod.applyFog(THREE, scene, themeName, { mist: mistEnabled }); }
      catch (e) { warn('applyFog 失败：' + ((e && e.message) || e)); }
    }
  }

  /** 主缆流光（低/极低档关闭：同路径发光管的 overdraw 在软件渲染下很贵） */
  function applyCableFlow(on) {
    cableFlowEnabled = !!on;
    bridge.cableMeshes.forEach((c) => { if (c.flow) c.flow.visible = cableFlowEnabled; });
  }

  /* ---- 地形密度三档（契约 §3.4b）：look-canyon 的实测顶点数，用实测值复验 ---- */
  const TERRAIN_DENSITY = {
    high: { nx: (canyonMod.TERRAIN && canyonMod.TERRAIN.nx) || 220, nz: (canyonMod.TERRAIN && canyonMod.TERRAIN.nz) || 150 },
    mid: { nx: 150, nz: 102 },
    low: { nx: 110, nz: 75 },
  };
  let terrainKind = null;   // null = 还没核对过实际密度

  function terrainVerts() {
    const g = canyon.geometry;
    return (g && g.attributes && g.attributes.position) ? g.attributes.position.count : 0;
  }

  /**
   * 切换地形密度。优先用 canyon.js 的 setCanyonDensity（同一个 mesh 换 geometry，
   * 不会让 scene.getObjectByName('canyon') 的引用失效）；look-canyon 的 density 参数
   * 还没落地时回退到现存签名 createCanyon(THREE, heightAt, {nx,nz})（契约 §3.4b 允许）。
   * 全程 try/catch：换密度失败只 warn，绝不让画面变黑。
   */
  function setTerrainDensity(kind) {
    const want = TERRAIN_DENSITY[kind] ? kind : 'high';
    if (want === terrainKind) return null;
    const target = TERRAIN_DENSITY[want];
    const targetVerts = (target.nx + 1) * (target.nz + 1);
    const have = terrainVerts();
    // 用真实顶点数核对：createCanyon 的 density 若已生效就不用再动（也不产生闪帧）
    if (have && Math.abs(have - targetVerts) <= Math.max(8, targetVerts * 0.03)) {
      terrainKind = want;
      return { kind: want, verts: have, rebuilt: false, via: 'already' };
    }
    try {
      if (typeof canyonMod.setCanyonDensity === 'function') {
        const info = canyonMod.setCanyonDensity(THREE, canyon, heightAt, want, themeName);
        terrainKind = want;
        return { kind: want, verts: terrainVerts(), rebuilt: true, via: 'setCanyonDensity', info: info || null };
      }
      const next = canyonMod.createCanyon(THREE, heightAt, { nx: target.nx, nz: target.nz, theme: themeName });
      const oldGeo = canyon.geometry;
      canyon.geometry = next.geometry;             // 同一个 mesh：外部引用不失效、不闪一帧
      if (oldGeo && oldGeo !== next.geometry && oldGeo.dispose) oldGeo.dispose();
      if (canyon.geometry.computeBoundingSphere) canyon.geometry.computeBoundingSphere();
      terrainKind = want;
      return { kind: want, verts: terrainVerts(), rebuilt: true, via: 'createCanyon(nx,nz)' };
    } catch (e) {
      warn('切换地形密度失败（保持原密度，不影响渲染）：' + ((e && e.message) || e));
      return null;
    }
  }

  /* ======================================================================
   * 4. 相机控制 / 取景（含窄高视口的 maxDistance 修复）
   * ====================================================================*/
  let controls = null;
  function makeControls(canvas) {
    const c = new OrbitControls(camera, canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.075;
    c.rotateSpeed = 0.72;
    c.zoomSpeed = 1.05;
    c.panSpeed = 0.9;
    c.screenSpacePanning = true;
    c.minDistance = 25;
    c.maxDistance = MIN_MAX_DISTANCE;
    c.maxPolarAngle = Math.PI * 0.495;   // 不允许钻到地面以下
    c.minPolarAngle = 0.05;
    c.touches = { ONE: 1 /* ROTATE */, TWO: 2 /* DOLLY_PAN */ };
    return c;
  }
  controls = makeControls(canvasEl);

  const presets = viewPresets();
  const flight = { active: false, t: 0, dur: 1, fromPos: new Vector3(), toPos: new Vector3(), fromTgt: new Vector3(), toTgt: new Vector3() };

  /**
   * 按当前画布宽高比算出「要让 spanW × spanH 入画」所需的相机距离。
   * 取水平/垂直两个方向所需距离的较大者，再乘 1.04 留边。
   */
  function fitDistance(spanW, spanH) {
    const vFov = camera.fov * Math.PI / 180;
    const aspect = Math.max(0.4, camera.aspect || 1);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const dV = (spanH / 2) / Math.tan(vFov / 2);
    const dH = (spanW / 2) / Math.tan(hFov / 2);
    return Math.max(dV, dH) * 1.04;
  }

  /**
   * 按取景需求放宽 OrbitControls.maxDistance（至少保留改前的 6200）。
   * 为什么必须动态放宽：手机竖屏全屏的宽高比只有 ~0.46，fitDistance(2750,720) ≈ 7500m，
   * 而 maxDistance 写死 6200 → OrbitControls.update() 会把相机钳回 6200，
   * 主跨直接被截断（用户反馈「手机全屏后显示很奇怪」的直接原因之一）。
   * 只放宽、不缩回：用户自己拉远过的视角不该被下一次 resize 又钳回来。
   */
  function widenMaxDistance(dist) {
    const want = Math.max(MIN_MAX_DISTANCE, dist * MAX_DISTANCE_SLACK);
    if (controls.maxDistance < want) controls.maxDistance = want;
    return controls.maxDistance;
  }

  // 当前取景状态：记住「上一次应用的预设」与「用户是否手动动过相机」
  const view = { preset: 'full', userMoved: false };
  function markUserMoved() { view.userMoved = true; }

  /** 预设 → 相机坐标（每次点击都按当前宽高比重新计算，窄屏也不会截断主跨） */
  function presetCamera(p) {
    const dist = fitDistance(p.spanW, p.spanH);
    widenMaxDistance(dist);
    const dir = new Vector3(p.dir[0], p.dir[1], p.dir[2]).normalize();
    const target = new Vector3(p.target[0], p.target[1], p.target[2]);
    return { pos: target.clone().add(dir.multiplyScalar(dist)), target, dist };
  }

  function applyPreset(key, instant) {
    const p = presets.find((x) => x.key === key) || presets[0];
    const c = presetCamera(p);
    view.preset = p.key;
    view.userMoved = false;
    flyTo(c.pos, c.target, instant ? 0 : 1.15);
    return p;
  }

  /**
   * 尺寸/宽高比变化后重新取景：
   *   · 用户没手动动过相机 → 按新宽高比重算预设距离（窄屏也不截断主跨）；
   *   · 用户动过 → 尊重用户视角，但 maxDistance 仍按当前预设需求放宽
   *     （否则用户在全屏里想拉远看全桥会被 6200 钳住，Lead 明确要求覆盖这种情况）。
   */
  function refitIfUntouched() {
    const p = presets.find((x) => x.key === view.preset) || presets[0];
    const need = fitDistance(p.spanW, p.spanH);
    widenMaxDistance(need);
    if (view.userMoved || flight.active) return false;
    const c = presetCamera(p);
    camera.position.copy(c.pos);
    controls.target.copy(c.target);
    camera.lookAt(c.target);
    controls.update();
    return true;
  }

  /**
   * 实测校验：任何路径下都按「当前预设的取景需求」放宽 maxDistance，并检查相机距离是否
   * 真的被钳住（任何来源），被钳住就再放宽一次并把真实数字写进原因（HUD 直接读）。
   * Lead 要求「不要只改常量」—— 这就是运行时校验。
   */
  function ensureDistanceWithinRange() {
    const p = presets.find((x) => x.key === view.preset) || presets[0];
    widenMaxDistance(fitDistance(p.spanW, p.spanH));
    const dist = camera.position.distanceTo(controls.target);
    if (dist > controls.maxDistance) {
      controls.maxDistance = dist * MAX_DISTANCE_SLACK;
      const text = '相机距离 ' + dist.toFixed(0) + 'm 超过 maxDistance，已放宽到 ' +
        controls.maxDistance.toFixed(0) + 'm（避免主跨被截断）';
      quality.note(text);
      perf.reason = text;
      warn(text);
    }
    return controls.maxDistance;
  }

  function flyTo(pos, target, dur) {
    if (dur <= 0) {
      camera.position.copy(pos);
      controls.target.copy(target);
      camera.lookAt(target);
      controls.update();
      flight.active = false;
      return;
    }
    flight.active = true; flight.t = 0; flight.dur = dur;
    flight.fromPos.copy(camera.position); flight.toPos.copy(pos);
    flight.fromTgt.copy(controls.target); flight.toTgt.copy(target);
    controls.enabled = false;
  }

  function updateFlight(dt) {
    if (!flight.active) return false;
    // 用真实 dt 推进（不按帧数抽帧）：限帧/空载时飞行不会变慢或变快
    flight.t = Math.min(1, flight.t + dt / flight.dur);
    const t = flight.t;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;   // easeInOutCubic
    camera.position.lerpVectors(flight.fromPos, flight.toPos, e);
    controls.target.lerpVectors(flight.fromTgt, flight.toTgt, e);
    camera.lookAt(controls.target);
    if (t >= 1) { flight.active = false; controls.enabled = true; }
    return true;
  }

  /**
   * 初始取景 = 「全桥」预设（谷内平视、横桥向），距离按画布宽高比实时计算：
   * 保证 1420m 主跨、两座 240m 级桥塔与谷底江面同时入画，且主跨约占 3/4 画幅。
   */
  function fitInitial() {
    const c = presetCamera(presets[0]);
    camera.position.copy(c.pos);
    controls.target.copy(c.target);
    camera.lookAt(c.target);
    controls.update();
    ensureDistanceWithinRange();
    return bridge.stats;
  }

  /* ======================================================================
   * 5. 测点浮动标签（HTML 叠加层，文字始终清晰）
   * ====================================================================*/
  const labelNodes = [];
  if (labelLayer) {
    HOTSPOTS.forEach((h) => {
      const el = document.createElement('div');
      el.className = 'twin-hotspot-label';
      el.dataset.key = h.key;
      el.innerHTML = '<b>' + h.label + '</b><span>' + h.code + '</span>';
      labelLayer.appendChild(el);
      labelNodes.push({ el, pos: new Vector3(h.x, h.y, h.z), hotspot: h });
    });
  }
  const labelState = { visible: true, onlySensor: false };

  /* ======================================================================
   * 6. 拾取（单击选中热点 / 双击聚焦）+ 画布事件（换 canvas 时可整体重挂）
   * ====================================================================*/
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const pick = { selected: null, hover: null };
  const listeners = { select: [], focus: [] };
  const rebuiltHandlers = [];      // api.onRendererRebuilt(fn) 注册的回调

  function toNdc(ev) {
    const r = canvasEl.getBoundingClientRect();
    ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    return ndc;
  }

  /**
   * 拾取（P2-F 修复）：先射线精确命中，未命中时用**屏幕空间半径兜底**。
   *
   * 为什么必须兜底：拾取球是 `SphereGeometry(1,8,6)` + `scale 3.2` → 世界半径 3.2m，
   * 在手机竖屏「全桥」视角（相机 3434m、画布高 388 CSS px、垂直 FOV 45°）下
   * 投影半径 ≈ 3.2/(2×3434×tan22.5°)×388 ≈ **0.44 px**（桌面 2217m/1490px ≈ 1.1px）。
   * 也就是说手机上「不是像素级精确命中就一定打空」；而测点标签是
   * `pointer-events:none` 的 HTML 叠加层，用户看得到标签却点不到 —— 红线要求
   * 「单击结构测点 = 弹说明」必须可用，所以在 CPU 侧补一层屏幕空间判定。
   *
   * 设计取舍：
   *   · 纯 CPU 投影判断：**零额外 draw call / 三角形**，不改几何、不改 app.css；
   *   · 不放开标签的 pointer-events：标签若吃指针，会连带吞掉画布上的拖拽起手；
   *   · 阈值 30 CSS px：覆盖「点标签」（标签在锚点上方 16px）与手指误差，
   *     而全桥视角下相邻测点的屏幕间距 >40px，不会互相抢；
   *   · 只在射线未命中时生效，近距离（测点占屏大）仍以射线为准，行为不变。
   */
  const PICK_SCREEN_RADIUS_PX = 30;
  const _pickV = new Vector3();
  const _pickHit = { hotspot: null, distPx: 0 };

  function pickByScreenRadius(ev) {
    const r = canvasEl.getBoundingClientRect();
    if (!r.width || !r.height) { _pickHit.hotspot = null; _pickHit.distPx = 0; return null; }
    const px = ev.clientX - r.left;
    const py = ev.clientY - r.top;
    let best = null;
    let bestD2 = PICK_SCREEN_RADIUS_PX * PICK_SCREEN_RADIUS_PX;
    for (let i = 0; i < bridge.hotspots.length; i++) {
      const h = bridge.hotspots[i].userData.hotspot;
      if (!h) continue;
      _pickV.set(h.x, h.y, h.z).project(camera);
      if (_pickV.z > 1) continue;                       // 相机背后 / 远裁剪外
      const sx = (_pickV.x * 0.5 + 0.5) * r.width;
      const sy = (-_pickV.y * 0.5 + 0.5) * r.height;
      const dx = sx - px, dy = sy - py;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) { bestD2 = d2; best = h; }      // 最近者优先
    }
    _pickHit.hotspot = best;
    _pickHit.distPx = best ? Math.sqrt(bestD2) : 0;
    return best;
  }

  function pickAt(ev) {
    raycaster.setFromCamera(toNdc(ev), camera);
    const hits = raycaster.intersectObjects(bridge.hotspots, false);
    if (hits.length) {
      const h = hits[0].object.userData.hotspot;
      perf.lastPick = { key: h ? h.key : null, mode: 'ray', distPx: 0 };
      return h;
    }
    const byScreen = pickByScreenRadius(ev);
    perf.lastPick = byScreen
      ? { key: byScreen.key, mode: 'screen', distPx: Math.round(_pickHit.distPx) }
      : { key: null, mode: 'none', distPx: null };
    return byScreen;
  }

  function select(hotspot) {
    pick.selected = hotspot || null;
    state.selected = pick.selected;
    labelNodes.forEach((n) => {
      n.el.classList.toggle('sel', !!(hotspot && n.hotspot.key === hotspot.key));
    });
    listeners.select.forEach((fn) => fn(pick.selected));
  }

  let clickTimer = null;
  let canvasHandlers = [];
  function unbindCanvas() {
    canvasHandlers.forEach((h) => h.el.removeEventListener(h.type, h.fn, h.opt));
    canvasHandlers = [];
  }
  /** 把全部指针/滚轮/点击监听挂到给定 canvas 上（换 renderer 时整体重挂，不遗漏） */
  function bindCanvas(canvas) {
    const add = (type, fn, opt) => {
      canvas.addEventListener(type, fn, opt);
      canvasHandlers.push({ el: canvas, type: type, fn: fn, opt: opt });
    };
    const touch = () => { lastInteractAt = performance.now(); };
    // 用户一旦拖拽/滚轮操作相机，就标记为「已手动操作」：此后窗口尺寸变化不再强行重设视角
    add('pointerdown', () => {
      markUserMoved(); pointerDown = true; touch();
      canvas.style.cursor = 'grabbing';
    });
    add('pointerup', () => {
      pointerDown = false;
      canvas.style.cursor = pick.hover ? 'pointer' : 'grab';
    });
    add('pointercancel', () => { pointerDown = false; });
    add('pointerleave', () => { pointerDown = false; });
    add('pointermove', (ev) => {
      lastPointerMoveAt = performance.now(); touch();
      const h = pickAt(ev);
      const isHot = !!h;
      if (isHot !== !!pick.hover) {
        pick.hover = h;
        canvas.style.cursor = isHot ? 'pointer' : 'grab';
      }
    });
    add('wheel', () => { markUserMoved(); lastWheelAt = performance.now(); touch(); }, { passive: true });
    add('click', (ev) => {
      // 单击选中；若 260ms 内出现双击则撤销选中，交给双击聚焦逻辑
      const h = pickAt(ev);
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        select(h);
        if (h) listeners.focus.forEach((fn) => fn(h, 'select'));
      }, 260);
    });
    add('dblclick', (ev) => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      // 双击测点 → 聚焦该测点；双击其它位置 → 以射线与桥面平面的交点为中心。
      // 走同一个 pickAt：手机上命中球只有 ~0.44px，射线会打空，必须吃屏幕空间兜底，
      // 否则「双击测点聚焦」在手机上会变成「随便找个桥面点聚焦」。
      const h = pickAt(ev);
      let target, label;
      if (h) {
        target = new Vector3(h.x, h.y, h.z);
        label = h.label;
        select(h);
      } else {
        raycaster.setFromCamera(toNdc(ev), camera);
        const t = -raycaster.ray.origin.y / (raycaster.ray.direction.y || 1e-6);
        target = raycaster.ray.at(Math.max(0, Math.min(6000, t)), new Vector3());
        label = '自由焦点';
      }
      const dist = Math.max(140, Math.min(900, camera.position.distanceTo(target) * 0.55));
      const dir = camera.position.clone().sub(target).normalize();
      flyTo(target.clone().add(dir.multiplyScalar(dist)).add(new Vector3(0, dist * 0.22, 0)), target, 0.95);
      listeners.focus.forEach((fn) => fn(target, label));
    });
  }
  bindCanvas(canvasEl);

  /* ======================================================================
   * 7. 逐帧状态 / 风险联动 / 标签
   * ====================================================================*/
  const state = {
    risk: 'normal',
    load: 0.35,
    strain: null,
    threshold: 120,
    pulse: 0,
    selected: null,
    autoRotate: false,
    wireframe: false,
    running: false,          // 双驱动是否活着（start/stop 维护）
    visible: true,           // 可见性闸门（setActive 维护）
    frames: 0,
    fps: 0,
    camMoved: false,         // 上一帧 controls.update() 是否真的动了相机（阻尼余量）
    paletteMoving: false,    // 主题色是否还在插值
    theme: themeName,
    refreshEstimate: null,   // 刷新率估算的原始证据（{hz, samples, medianMs}）
    lastError: null,
    errors: 0,
  };

  // 缓存全部测点 Group 便于动画
  const hotspotGroups = [];
  bridge.groups.hotspot.children.forEach((g) => hotspotGroups.push(g));

  function setRisk(key) {
    if (RISK_KEY[key] !== undefined) key = RISK_KEY[key];
    const palette = themeFns.riskColors(themeName) || {};
    if (!palette[key]) key = 'normal';
    state.risk = key;
    if (matCtl && typeof matCtl.setPalette === 'function') {
      try { matCtl.setPalette(key); } catch (e) { warn('setPalette 失败：' + ((e && e.message) || e)); }
    }
    applyWireTheme();                      // 线框用当前主题的风险色（浅色主题是深色描边）
    // 测点环半径基准：风险越高越小（节奏越快，由 pulse 驱动）
    const scale = key === 'offline' ? 0.55 : (key === 'crit' ? 0.85 : 1.0);
    hotspotGroups.forEach((g) => { g.userData.scaleBase = scale; });
    lastRiskKey = null;                    // 风险变了 → 下一帧必须重算吊索着色
  }

  function setData(d) {
    if (!d) return;
    // 离线时模板会传 strain:null —— 如实清零，避免 3D 沿用离线前的受力着色
    if (d.strain === null || d.strain === undefined) {
      state.strain = null;
      state.load = 0;
    } else if (typeof d.strain === 'number') {
      state.strain = d.strain;
      const r = d.strain / (state.threshold || 120);
      state.load = Math.max(0, Math.min(1, r));
    }
    if (typeof d.threshold === 'number') state.threshold = d.threshold;
    if (d.riskKey) setRisk(d.riskKey);
  }

  function setLabelMode(mode) {
    labelState.onlySensor = mode === 'sensor';
    labelState.visible = mode !== 'off';
    updateLabels();
  }

  const _v = new Vector3();
  function updateLabels() {
    if (!labelLayer) return;
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    labelNodes.forEach((n) => {
      const showAll = labelState.visible && !labelState.onlySensor;
      const showSensor = labelState.visible && n.hotspot.key === 'midspan';
      if (!showAll && !showSensor) { n.el.classList.add('hide'); return; }
      _v.copy(n.pos).project(camera);
      if (_v.z > 1) { n.el.classList.add('hide'); return; }
      const x = (_v.x * 0.5 + 0.5) * w;
      const y = (-_v.y * 0.5 + 0.5) * h;
      const inset = x > 8 && x < w - 8 && y > 8 && y < h - 8;
      n.el.classList.toggle('hide', !inset);
      if (!inset) return;
      n.el.style.transform = 'translate(-50%,-50%) translate(' + x.toFixed(1) + 'px,' +
        (y - 16).toFixed(1) + 'px)';   // 上移 16px，避免标签压住测点标记
      // 距离越远越小；上下限控制在可读区间，避免远处文字糊成一团
      const dist = camera.position.distanceTo(n.pos);
      const s = MathUtils.clamp(1100 / Math.max(300, dist), 0.85, 1.2);
      n.el.style.setProperty('--lbl-scale', s.toFixed(3));
    });
  }

  /**
   * 构建线框结构层：按每根杆件的真实变换矩阵生成 12 条棱的线段。
   * （不用 EdgesGeometry：它只处理单个几何体，对 InstancedMesh 会把所有实例的边
   *   都画在原点，看起来是一团乱线。）
   */
  function buildWireframe() {
    if (wireRoot.children.length) return wireRoot.children.length;
    const mm = bridge.memberMatrices || {};
    const batches = [mm.chord, mm.vertical, mm.diagonal, mm.floor, mm.lateral, mm.hangers];
    let count = 0;
    batches.forEach((mats2) => {
      if (!mats2 || !mats2.length) return;
      const seg = new LineSegments(memberEdges(mats2), wireMat);
      seg.renderOrder = 2;      // 画在其它半透明件（主缆流光等）之后，不被盖住
      wireRoot.add(seg);
      count += mats2.length;
    });
    return count;   // 参与线框的杆件数量（供 HUD 展示）
  }

  /* ======================================================================
   * 8. 吊索着色闸门（契约 §3.4：只在风险变化 / 荷载跨 5% 台阶 / 主题色收敛时调用）
   * ====================================================================*/
  let lastRiskKey = null;
  let riskMovingPrev = false;
  function maybeApplyRisk(moving) {
    const load = Math.max(0, Math.min(1, state.load));
    const step = Math.round(load * RISK_LOAD_STEPS);
    const key = state.risk + '|' + step + '|' + themeName;
    const justSettled = riskMovingPrev && !moving;   // 主题色刚好收敛 → 再上一次色（保证最终色与主题一致）
    riskMovingPrev = moving;
    if (key === lastRiskKey && !justSettled) return 0;
    lastRiskKey = key;
    try { return bridge.applyRisk(state.risk, { load: step / RISK_LOAD_STEPS }); }
    catch (e) { warn('applyRisk 失败：' + ((e && e.message) || e)); return 0; }
  }

  /* ======================================================================
   * 9. api.perf（同一引用永不替换；计数器每帧累加，其余字段每秒刷新）
   * ====================================================================*/
  const perf = {
    fps: 0, frameMs: 0, frameMsP95: 0, samples: 0,
    tier: 'high', tierLabel: '高', auto: true, targetFps: 60, refreshHz: 60,
    drawCalls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0,
    dpr: device.dpr, pixelRatio: 1, antialias: currentAntialias, canvas: [0, 0], msaaSamples: 0,
    pixelRatioCap: pixelRatioCap(quality.tier, isMobile), pixelRatioClamp: '',
    renders: 0, frames: 0, idle: false, interacting: false,
    visible: true, running: false, theme: themeName,
    insufficient: false, reason: '',
    degraded: false,                   // 附加诊断字段：已到最低画质、达到可用下限但未达目标（v1.2）
    reasons: quality.reasons,          // 与 quality 控制器同一个数组（就地更新）
    device: device,
    maxDistance: MIN_MAX_DISTANCE,     // 附加诊断字段（非契约字段，供测量/排障）
    /* 拾取诊断（P2-F，非契约字段）：最近一次拾取走的哪条路径、屏幕距离多少。
       验收脚本可以用 mode==='screen' 证明「屏幕空间兜底」真的生效（而不是碰巧射线命中）。 */
    lastPick: null,
    pickRadiusPx: PICK_SCREEN_RADIUS_PX,
  };

  const dispTimes = [];   // 最近 60 帧真实间隔（含空载帧），只用于显示 p50/p95
  let perfAt = 0;
  let perfRenders = 0;

  function readMsaaSamples() {
    try {
      const gl = renderer.getContext();
      return (gl && gl.getParameter) ? gl.getParameter(gl.SAMPLES) : 0;
    } catch (e) { return 0; }
  }
  function readAntialias() {
    try {
      const a = renderer.getContextAttributes ? renderer.getContextAttributes() : null;
      return !!(a && a.antialias);
    } catch (e) { return currentAntialias; }
  }
  function updatePerfBufferFields() {
    const pr = pixelRatioInfo();
    perf.canvas = [canvasEl.width, canvasEl.height];
    perf.pixelRatio = renderer.getPixelRatio();       // 实际使用的值（已含 dpr 与档位上限两层钳制）
    perf.pixelRatioCap = pr.cap;                      // 当前档位允许的上限
    perf.pixelRatioClamp = pr.clamp;                  // 被哪一层钳住（人话）
    perf.dpr = pr.dpr;
    perf.msaaSamples = readMsaaSamples();
    perf.antialias = readAntialias();
    perf.maxDistance = Math.round(controls ? controls.maxDistance : 0);
  }
  /** 档位/主题变化时立刻刷新一次（不然 HUD 要等最多 1s 才看到） */
  function updatePerfNow() {
    perf.tier = quality.tier;
    perf.tierLabel = quality.tierLabel;
    perf.auto = quality.auto;
    perf.targetFps = quality.targetFps;
    perf.refreshHz = quality.refreshHz;
    perf.insufficient = quality.insufficient;
    perf.degraded = quality.degraded;
    perf.reason = quality.reason;
    perf.theme = themeName;
    perf.running = state.running;
    perf.visible = state.visible;
    perf.frames = state.frames;
    perf.samples = quality.snapshot().samples;
    updatePerfBufferFields();
  }
  /** 每秒刷新一次真实数字（drawCalls/三角形数来自 renderer.info，不是常量） */
  function refreshPerf(now) {
    if (!perfAt) { perfAt = now; perfRenders = perf.renders; return; }
    const elapsed = (now - perfAt) / 1000;
    if (elapsed < 1) return;
    const d = perf.renders - perfRenders;
    perf.fps = Math.round((d / elapsed) * 10) / 10;   // 真实测得：窗口内 renderer.render 次数 / 真实秒数
    perfRenders = perf.renders;
    perfAt = now;
    if (dispTimes.length) {
      const sorted = dispTimes.slice().sort((a, b) => a - b);
      perf.frameMs = Math.round(medianOf(sorted, sorted.length) * 10) / 10;
      const i95 = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
      perf.frameMsP95 = Math.round(sorted[i95] * 10) / 10;
    }
    const info = renderer.info;
    perf.drawCalls = info.render.calls;
    perf.triangles = info.render.triangles;
    perf.geometries = info.memory.geometries;
    perf.textures = info.memory.textures;
    perf.programs = (info.programs || []).length;
    updatePerfBufferFields();
    perf.samples = quality.snapshot().samples;
    perf.tier = quality.tier;
    perf.tierLabel = quality.tierLabel;
    perf.auto = quality.auto;
    perf.targetFps = quality.targetFps;
    perf.refreshHz = quality.refreshHz;
    perf.insufficient = quality.insufficient;
    perf.degraded = quality.degraded;
    perf.reason = quality.reason;
    perf.theme = themeName;
    perf.idle = idleNow;
    perf.interacting = interactingNow;
    perf.visible = state.visible;
    perf.running = state.running;
    perf.frames = state.frames;
    state.fps = perf.fps;
  }

  /* ======================================================================
   * 10. 主循环：硬间隔限帧 + 交互感知空载 + 双驱动不重复推帧
   * ====================================================================*/
  let rafId = null;
  let intervalId = null;
  let lastTick = 0;            // 上一次真正渲染的时间（rAF 时间戳优先，兜底用 performance.now）
  let lastRafTick = 0;         // 上一次 rAF 回调时间（兜底是否推帧的判据）
  let lastInteractAt = 0;      // 最近一次「交互」时间（空载判定）
  let lastWheelAt = -1e9;
  let lastPointerMoveAt = -1e9;
  let pointerDown = false;
  let lastLabelAt = 0;
  let idleNow = false;
  let interactingNow = false;

  /** 当前生效的帧间隔：交互中按目标帧率，真正静止后按 min(30,target) */
  function frameIntervalMs() {
    const full = 1000 / quality.targetFps;
    const idle = 1000 / Math.min(30, quality.targetFps);
    return idleNow ? Math.max(full, idle) : full;
  }

  /**
   * 渲染一帧。两套驱动（rAF / setInterval）共用它，所以限帧逻辑只有一份：
   *   · 硬间隔 `now - lastTick < frameInterval - 0.5` —— 删掉了改前的 ×0.7
   *     （那个系数会让实际帧率比目标高 43%，"限帧"没限住）；
   *   · 0.5ms 容差：rAF 时间戳是帧开始时间，和 interval 的 performance.now() 会有
   *     亚毫秒差，不留容差会在 60Hz 上每隔几帧漏掉一次 16.6ms 的节拍。
   */
  function renderFrame(ts) {
    /* 双闸门：running（双驱动是否活着）+ visible（可见性闸门）。
       visible 这一条是**冗余防御**（正常路径 setActive(false) 会同时把两者置 false）：
       它把「不可见就一帧都不许渲染」变成渲染入口处的硬不变量，任何绕过 setActive 的
       路径（例如旧调用方先 setVisible(false) 又误调 start()）都不可能偷偷渲染。
       ui-hud 实测过隐藏后 2.5s 窗口 `renders` 仍 +1：那一帧是**测量口径**造成的
       （checker 先读 before、再派发 visibilitychange，中间那一帧在 stop() 生效前就画完了），
       不是循环没停；这条闸门让「隐藏后 0 帧」在代码层面无歧义。 */
    if (!state.running || !state.visible) return;
    const now = (typeof ts === 'number' && ts > 0) ? ts : performance.now();

    // ① 交互感知（契约 §4.2）：飞行 / 自动旋转 / 主题色插值 / 相机阻尼余量 /
    //    指针按下 / 刚滚轮 / 刚移动指针。命中就满帧，任何一项为真都不许抽帧。
    interactingNow = !!(flight.active || state.autoRotate || state.paletteMoving || pointerDown ||
      (now - lastWheelAt) < WHEEL_WINDOW_MS || (now - lastPointerMoveAt) < POINTER_MOVE_WINDOW_MS ||
      state.camMoved);
    if (interactingNow) lastInteractAt = now;
    idleNow = !interactingNow && (now - lastInteractAt) >= IDLE_AFTER_MS;

    const interval = frameIntervalMs();
    if (lastTick && now - lastTick < interval - 0.5) {
      // 被限帧挡下的帧：只做最省的标签跟随（≤100ms 一次），不跑 controls、不渲染
      if (now - lastLabelAt >= LABEL_MIN_INTERVAL_MS) { updateLabels(); lastLabelAt = now; }
      return;
    }
    const rawGap = lastTick ? Math.max(0, now - lastTick) : 0;
    const dtMs = rawGap > 0 ? rawGap : interval;
    const dt = Math.min(0.12, dtMs / 1000);     // 动画用 dt 限幅，避免长卡顿后动画瞬移
    lastTick = now;
    state.frames += 1;

    // ② 相机飞行 / 阻尼（camMoved 接到空载判定上：阻尼余量期间必须满帧，否则手感发涩）
    //    ⚠ 把真实 dt 传给 OrbitControls.update()：vendor r160 的自动旋转角度在
    //    deltaTime=null 时按「每帧固定角度」算（隐含 60fps），空载限到 30fps 后自动旋转
    //    会慢一半、更慢的机器上更慢。传 dt 后自动旋转与帧率无关。
    updateFlight(dt);
    let camMoved = false;
    if (!flight.active) camMoved = controls.update(dt) === true;
    state.camMoved = camMoved;

    // ③ 主题色插值（每秒一次数据刷新造成的换色要平滑过渡；按真实 dt 推进）
    let moving = false;
    if (matCtl && typeof matCtl.lerpPalette === 'function') {
      try { moving = !!matCtl.lerpPalette(Math.min(1, dt * 3.2)); }
      catch (e) { moving = false; }
    }
    state.paletteMoving = moving;
    if (camMoved || moving) lastInteractAt = now;   // 阻尼/换色期间不判空载

    // ④ 测点脉冲（风险等级越高越快；离线冻结）—— 一律按真实 dt 推进，与帧率无关
    const isOffline = state.risk === 'offline';
    const rate = isOffline ? 0
      : (state.risk === 'crit' ? 1.9 : state.risk === 'alarm' ? 1.25 : state.risk === 'warn' ? 0.85 : 0.6);
    if (!isOffline) state.pulse = (state.pulse + dt * rate) % 1;
    hotspotGroups.forEach((g) => {
      const base = (g.userData.scaleBase || 1);
      const rings = g.userData.rings || [];
      rings.forEach((ring) => {
        const phase = (state.pulse + ring.userData.phase) % 1;
        ring.scale.setScalar((3.2 + phase * 12) * base);
        ring.material.opacity = (1 - phase) * 0.5 * (isOffline ? 0.15 : 1);
        ring.quaternion.copy(camera.quaternion);   // 环永远面向相机
      });
      const core = g.userData.core;
      if (core) {
        const k = 1.5 + Math.sin(state.pulse * Math.PI * 6) * 0.18;
        core.scale.setScalar(k * base);
      }
      const stem = g.userData.stem;
      if (stem) stem.scale.set(1, 7.5 * base, 1);
    });

    // ⑤ 主缆流光呼吸（低画质档整层隐藏，连 opacity 都不用算）
    if (cableFlowEnabled) {
      const flowOp = isOffline ? 0.15 : 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(now / 900));
      bridge.cableMeshes.forEach((c) => { if (c.flow) c.flow.material.opacity = flowOp; });
    }
    // ⑥ 吊索按荷载着色：走闸门，不再每 6 帧无条件重算 + 整块上传
    maybeApplyRisk(moving);

    // ⑦ 水面 / 雾缓慢漂移（用绝对时间，天然与帧率无关）
    river.position.x = Math.sin(now / 9000) * 30;
    if (mistEnabled) {
      mist.children.forEach((l) => { l.position.x = Math.sin(now / (14000 * l.userData.drift)) * 90; });
    }

    // ⑧ 自动旋转
    controls.autoRotate = !!(state.autoRotate && !flight.active);
    controls.autoRotateSpeed = 0.42;

    // ⑨ 渲染
    try {
      renderer.render(scene, camera);
      perf.renders += 1;
      updateLabels();
      lastLabelAt = now;
      state.errors = 0;
    } catch (err) {
      // 渲染异常不能静默：记一次并停止循环，交由 mount.js 的失败通道如实暴露
      state.lastError = String((err && err.message) || err);
      state.errors = (state.errors || 0) + 1;
      if (window.console && console.error) console.error('[twin] 渲染失败：' + state.lastError);
      stop();
      return;
    }

    // ⑩ 帧率采样 → 画质阶梯（放在渲染之后：档位变化可能重建 renderer，
    //    必须在"这一帧已经画完"之后做，避免把新 context 用到一半）
    dispTimes.push(dtMs);
    if (dispTimes.length > 60) dispTimes.shift();
    quality.pushFrame(Math.min(5000, dtMs), { interacting: !idleNow });

    refreshPerf(now);
  }

  /**
   * 估算刷新率：采集 rAF 间隔（最多 120 个）→ `assessRefreshEstimate()` 判置信度 → 交给控制器。
   * ⚠ 置信度必须传下去（P2-F 缺陷 2）：headless/弱机/重页面里 rAF 被节流（实测间隔 250~600ms），
   *   中位数会把刷新率估成 30Hz，进而把用户手选的 120fps 悄悄钳成 30fps。现在：
   *   · 置信 → 按契约用刷新率钳制手选目标（正常 60Hz 环境点 120 → 60，带中文原因）；
   *   · 不置信 → refreshHz 记 60、**手选目标保留**、reason 写明「仅参考」。
   */
  let hzDone = false;
  let hzFirst = 0;
  let hzLast = 0;
  const hzSamples = [];
  function sampleRefresh(ts) {
    if (hzDone || !ts) return;
    if (!hzFirst) { hzFirst = ts; hzLast = ts; return; }
    hzSamples.push(ts - hzLast);
    hzLast = ts;
    const elapsed = ts - hzFirst;
    if (hzSamples.length >= REFRESH_SAMPLES || elapsed >= REFRESH_TIMEOUT_MS) {
      hzDone = true;
      const est = assessRefreshEstimate(hzSamples);
      state.refreshEstimate = est;      // 原始证据（n / 中位 / p25 / p75 / IQR / 是否置信）
      quality.setRefreshHz(est.hz, est);
    }
  }

  function rafLoop(ts) {
    rafId = requestAnimationFrame(rafLoop);
    const t = (typeof ts === 'number' && ts > 0) ? ts : performance.now();
    lastRafTick = t;
    sampleRefresh(t);
    renderFrame(t);
  }

  /** 兜底驱动：rAF 停了 >400ms 才推帧，正常时直接返回（双驱动不重复推帧） */
  function fallbackTick() {
    const now = performance.now();
    if (now - lastRafTick <= FALLBACK_GAP_MS) return;
    renderFrame(now);
  }

  function start() {
    if (rafId !== null || intervalId !== null) return false;
    // 后台标签页不许偷偷跑渲染（红线 5）：可见性由 setActive 单闸门控制，
    // 这里再兜一道，防止旧调用方（mount.js 老版本）用 start() 绕开闸门。
    if (typeof document !== 'undefined' && document.hidden) {
      state.blockedByHidden = true;
      return false;
    }
    state.blockedByHidden = false;
    state.running = true;
    lastTick = 0;                    // 下一帧立即渲染（恢复可视不闪黑）
    lastRafTick = performance.now();
    lastInteractAt = performance.now();   // 刚恢复先按满帧跑，600ms 后才允许进空载
    lastLabelAt = 0;
    rafId = requestAnimationFrame(rafLoop);
    intervalId = window.setInterval(fallbackTick, FALLBACK_INTERVAL_MS);
    renderFrame(performance.now());  // 立刻渲染一帧
    perf.running = true;
    return true;
  }

  function stop() {
    state.running = false;
    idleNow = false;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    if (intervalId !== null) { window.clearInterval(intervalId); intervalId = null; }
    lastTick = 0;
    perf.running = false;
    return true;
  }

  /** 可见性单闸门（契约 §3.3/§4.4）：false 完全停止，true 立刻渲染一帧 */
  function setActive(on) {
    const want = !!on;
    state.visible = want;
    perf.visible = want;
    if (want) start(); else stop();
    return want;
  }
  /** 兼容旧调用方：语义等同 setActive（滚出视口/页面隐藏都要完全停） */
  function setVisible(v) { return setActive(v); }

  /** 停下时的单帧渲染（档位/主题变化后让用户立刻看到新画面） */
  function renderStandalone() {
    if (!state.visible) return false;
    try {
      renderer.render(scene, camera);
      perf.renders += 1;
      updateLabels();
      return true;
    } catch (e) {
      state.lastError = String((e && e.message) || e);
      return false;
    }
  }

  /* ======================================================================
   * 11. 画质档位 → 实际动作（含关 AA 重建 renderer）
   * ====================================================================*/
  function dispatchRendererRebuilt(retiredCanvas, retiredRenderer) {
    const detail = {
      canvas: canvasEl, renderer: renderer, controls: controls,
      retiredCanvas: retiredCanvas, retiredRenderer: retiredRenderer,
      antialias: currentAntialias,
    };
    rebuiltHandlers.slice().forEach((fn) => {
      try { fn(detail); } catch (e) { warn('onRendererRebuilt 回调异常：' + ((e && e.message) || e)); }
    });
    try { container.dispatchEvent(new CustomEvent('twin:renderer-rebuilt', { detail: detail })); }
    catch (e) { /* 老浏览器没有 CustomEvent 构造器：忽略 */ }
    try { window.dispatchEvent(new CustomEvent('twin:renderer-rebuilt', { detail: detail })); }
    catch (e) { /* 同上 */ }
  }

  /**
   * 重建 renderer（画质阶梯关/开抗锯齿时唯一正确的做法）。
   * 顺序很关键（每一步都踩过坑）：
   *   ① 先建新 renderer + 新 canvas，就地替换 DOM 里的旧 canvas（同一个 #twinCanvas 容器，
   *      `.twin-canvas canvas` 的元素选择器样式自动继承；同一时刻只有一个 canvas）；
   *   ② 切换 renderer/canvasEl 引用，重建 OrbitControls（vendor r160 没有 connect()，
   *      构造函数里直接绑 domElement 的监听，dispose() 只解绑当前 domElement）；
   *   ③ 旧 canvas 解绑、新 canvas 重挂全部指针/滚轮/点击监听；
   *   ④ 重跑主题（PMREM 环境贴图绑在 renderer 上，必须重建）；
   *   ⑤ 先派发 'twin:renderer-rebuilt'（让 mount.js 有机会解绑 contextlost 监听），
   *      **最后**才 dispose + forceContextLoss 旧 renderer —— 而且只用局部变量
   *      oldRenderer，绝不碰 renderer，否则会把刚建好的新 context 弄丢。
   */
  function rebuildRenderer(antialias) {
    const oldRenderer = renderer;
    const oldCanvas = canvasEl;
    let next = null;
    try {
      next = createRenderer(antialias);
    } catch (err) {
      // 新 context 拿不到（显存/驱动异常）：保留原 renderer 继续用，如实记录，不黑屏
      state.lastError = '切换抗锯齿失败（保留原渲染器）：' + ((err && err.message) || err);
      warn(state.lastError);
      return false;
    }
    try {
      const parent = oldCanvas.parentNode;
      oldCanvas.__twinRetired = true;               // 给 mount.js 的 contextlost 监听一个判据
      oldCanvas.setAttribute('data-twin-retired', '1');
      if (parent) parent.replaceChild(next.domElement, oldCanvas);
      else container.appendChild(next.domElement);
    } catch (e) {
      warn('替换 canvas 失败：' + ((e && e.message) || e));
      if (!next.domElement.parentNode) container.appendChild(next.domElement);
    }

    renderer = next;
    canvasEl = next.domElement;
    currentAntialias = !!antialias;

    // OrbitControls：搬运配置与当前观察点，用户视角不能因为降档而跳变
    const keepTarget = controls ? controls.target.clone() : new Vector3();
    const keepAutoRotate = !!(controls && controls.autoRotate);
    const keepEnabled = !controls || controls.enabled;
    const keepMaxDistance = controls ? controls.maxDistance : MIN_MAX_DISTANCE;
    if (controls && typeof controls.dispose === 'function') {
      try { controls.dispose(); } catch (e) { /* 旧 canvas 即将销毁，解绑失败无影响 */ }
    }
    controls = makeControls(canvasEl);
    controls.target.copy(keepTarget);
    controls.autoRotate = keepAutoRotate;
    controls.enabled = keepEnabled;
    controls.maxDistance = Math.max(MIN_MAX_DISTANCE, keepMaxDistance);
    camera.lookAt(controls.target);

    unbindCanvas();
    bindCanvas(canvasEl);

    applyTheme(themeName);      // 新 renderer → 重建 env RT / clearColor / 光照

    dispatchRendererRebuilt(oldCanvas, oldRenderer);

    // ⚠ 旧 renderer 的销毁只作用于 oldRenderer 这个局部变量
    try { oldRenderer.dispose(); } catch (e) { /* 已销毁 */ }
    try { if (typeof oldRenderer.forceContextLoss === 'function') oldRenderer.forceContextLoss(); }
    catch (e) { /* 没有该扩展（老驱动）：靠 GC */ }
    return true;
  }

  function applyTierProfile(info) {
    const p = (info && info.profile) || quality.profile;
    let structural = false;
    // ① 抗锯齿（必须重建 renderer）
    if (!!p.antialias !== currentAntialias) {
      if (rebuildRenderer(!!p.antialias)) structural = true;
    }
    // ② 像素比（只需 setPixelRatio + setSize，绘制缓冲会随之重建）
    if (Math.abs(effectivePixelRatio() - lastPr) > 1e-6) structural = true;
    // ③ 雾气 / 主缆流光
    if (!!p.mist !== mistEnabled) applyMist(!!p.mist);
    if (!!p.cableFlow !== cableFlowEnabled) applyCableFlow(!!p.cableFlow);
    // ④ 地形密度（三档，实测顶点数复验）
    const wantTerrain = (p.terrain === 'low') ? 'low' : 'high';
    if (wantTerrain !== terrainKind) setTerrainDensity(wantTerrain);
    // ⑤ 尺寸同步：只有结构性变化才强制重建绘制缓冲（避免每秒白白重建 3.5M 像素的缓冲）
    resize(structural);
    if (!state.running) renderStandalone();
    updatePerfNow();
    // ⑥ 把「实际生效的像素比 / 被哪一层钳住」补进同一条档位变化原因（HUD 直接显示人话）
    //    契约 v1.2 澄清 1 要求 reason 文案带真实数字；只在刚生成的那条原因后面补，不新增条目。
    const pr = pixelRatioInfo();
    if (info && info.reason && quality.reason === info.reason) {
      quality.annotateLast('；实际像素比 ' + pr.used + '（' + pr.clamp + '）');
      perf.reason = quality.reason;
    }
    return { structural: structural, profile: p, pixelRatio: pr };
  }

  /* ======================================================================
   * 12. 自适应尺寸（同值短路：three 的 setSize 会无条件重写 canvas.width/height）
   * ====================================================================*/
  function resize(force) {
    const box = containerSize();
    const w = box.w, h = box.h;
    const pr = effectivePixelRatio();
    currentW = w; currentH = h;
    // ⚠ 同值短路是必须的：mount.js 每秒兜底调一次 resize()，而 setSize() 会**无条件**
    //   重写 canvas.width/height（没有同值判断），全屏 + MSAA 时约 50MB 级缓冲每秒重建一次，
    //   表现为周期性卡顿。尺寸/像素比没变就不碰 GL 资源。
    if (force || w !== lastW || h !== lastH || Math.abs(pr - lastPr) > 1e-6) {
      lastW = w; lastH = h; lastPr = pr;
      renderer.setPixelRatio(pr);
      renderer.setSize(w, h, false);
    }
    const aspect = w / h;
    const changed = Math.abs(aspect - lastAspect) > 0.02;
    lastAspect = aspect;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    // 宽高比明显变化（投影切换分辨率、窄屏回退布局、全屏铺满、手机竖屏全屏 aspect≈0.46）
    // → 先按新宽高比重算取景需求并放宽 maxDistance，再（用户没动过相机时）重设机位
    if (changed) refitIfUntouched();
    ensureDistanceWithinRange();
    updateLabels();
    updatePerfBufferFields();
  }

  const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(container);

  /* ======================================================================
   * 13. 对外 API（保留改前全部字段，按契约 §3.3 追加）
   * ====================================================================*/
  const api = {
    THREE: THREE, scene: scene, camera: camera, bridge: bridge, stats: bridge.stats,
    presets: presets, state: state, perf: perf, quality: quality,
    start: start, stop: stop, resize: resize, setVisible: setVisible, setActive: setActive,
    setRisk: setRisk, setData: setData, setLabelMode: setLabelMode,
    applyPreset: applyPreset, flyTo: flyTo, select: select,
    onSelect(fn) { listeners.select.push(fn); },
    onFocus(fn) { listeners.focus.push(fn); },
    /** 换 canvas（关/开抗锯齿）时回调，返回退订函数（契约 v1.1 §3.3） */
    onRendererRebuilt(fn) {
      if (typeof fn !== 'function') return function () {};
      rebuiltHandlers.push(fn);
      return function () {
        const i = rebuiltHandlers.indexOf(fn);
        if (i >= 0) rebuiltHandlers.splice(i, 1);
      };
    },
    setWireframe(on) {
      state.wireframe = !!on;
      if (on) { buildWireframe(); wireRoot.visible = true; }
      else wireRoot.visible = false;
      return state.wireframe;
    },
    setAutoRotate(on) { state.autoRotate = !!on; return state.autoRotate; },
    /** 30/60/120；超刷新率上限钳到刷新率；写 localStorage */
    setTargetFps(n) { return quality.setTargetFps(n, { manual: true }); },
    /** 'auto'|'high'|'medium'|'low'|'ultraLow'；写 localStorage */
    setQualityTier(nameOrAuto) { return quality.setTier(nameOrAuto, { manual: true }); },
    /** 'light'|'dark'：切主题不重建几何（env RT / 光照 / 材质原地更新） */
    setTheme(name) {
      const next = normalizeTheme(name);
      if (next === themeName) return themeName;
      themeName = next;
      state.theme = next;
      writeStoredTheme(next);
      applyTheme(next);
      setRisk(state.risk);        // 线框/测点颜色随主题重设（theme 的风险五色是专版）
      if (!state.running) renderStandalone();
      updatePerfNow();
      return themeName;
    },
    getRefreshHz() { return quality.refreshHz; },
    /** 取景自检：宽高比变化后重算（用户手动动过相机则不重设机位） */
    refit() { return refitIfUntouched(); },
    hotspots: HOTSPOTS,
    factSheet: FACT_SHEET,
    fidelityNote: FIDELITY_NOTE,
    dispose() {
      stop();
      if (ro) ro.disconnect();
      unbindCanvas();
      if (controls && typeof controls.dispose === 'function') {
        try { controls.dispose(); } catch (e) { /* 忽略 */ }
      }
      // 释放几何 / 材质 / 贴图（Set 去重：UNIT_BOX 这类共享几何只释放一次）
      const geos = new Set();
      const mats2 = new Set();
      scene.traverse((o) => {
        if (o.geometry && o.geometry.dispose) geos.add(o.geometry);
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => { if (x) mats2.add(x); });
        else if (m) mats2.add(m);
      });
      geos.forEach((g) => { try { g.dispose(); } catch (e) { /* 忽略 */ } });
      mats2.forEach((m) => {
        try {
          ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap']
            .forEach((k) => { if (m[k] && m[k].dispose) m[k].dispose(); });
          m.dispose();
        } catch (e) { /* 忽略 */ }
      });
      try {
        if (typeof themeMod.disposeEnvironment === 'function') themeMod.disposeEnvironment(scene);
      } catch (e) { warn('disposeEnvironment 失败：' + ((e && e.message) || e)); }
      try { renderer.dispose(); } catch (e) { /* 忽略 */ }
      try { if (renderer.forceContextLoss) renderer.forceContextLoss(); } catch (e) { /* 忽略 */ }
      if (canvasEl && canvasEl.parentNode) canvasEl.parentNode.removeChild(canvasEl);
    },
  };
  // api.renderer / api.controls 是**就地更新**的可读属性（契约 v1.1）：低档换 canvas 后
  // 旧引用作废，调用方每次读 api.renderer 都能拿到当前对象，不需要自己记住重建时机。
  Object.defineProperty(api, 'renderer', {
    get: function () { return renderer; }, enumerable: true, configurable: true,
  });
  Object.defineProperty(api, 'controls', {
    get: function () { return controls; }, enumerable: true, configurable: true,
  });

  /* ======================================================================
   * 14. 启动：主题 → 画质档 → 尺寸/取景 → 风险 → 首帧
   * ====================================================================*/
  applyTheme(themeName);
  profileHandler = applyTierProfile;
  applyTierProfile({ tier: quality.tier, profile: quality.profile, reason: '初始化画质档' });
  resize();
  fitInitial();
  setRisk('normal');
  updatePerfNow();
  // 起始就把「真实生效状态」写成一条人话原因（HUD 初始不显示空白）：
  // 像素比被哪一层钳住、AA/雾气/地形密度、以及首次出画的绘制缓冲尺寸。
  const bootPr = pixelRatioInfo();
  quality.note('启动画质档「' + quality.tierLabel + '」' + (quality.auto ? '（自动）' : '（手动）') +
    '：目标 ' + quality.targetFps + 'fps / 刷新率 ' + quality.refreshHz + 'Hz，像素比 ' + bootPr.used +
    '（' + bootPr.clamp + '），抗锯齿 ' + (readAntialias() ? '开' : '关') + '，雾气 ' +
    (mistEnabled ? '开' : '关') + '，地形密度 ' + (terrainKind || quality.profile.terrain) +
    '，画布 ' + canvasEl.width + '×' + canvasEl.height);
  perf.reason = quality.reason;
  renderStandalone();      // 首帧立刻出画（mount.js 随后 start() 接管循环）
  return api;
}
