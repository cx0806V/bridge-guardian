/* ============================================================================
 * 材质与调色板：主题化材质（浅色/深色）+ 统一风险五色 + 随风险等级整体换色
 * ----------------------------------------------------------------------------
 * 设计（P2 之后）：
 *   · 每套主题的材质参数（颜色/金属度/粗糙度/透明度/混合模式/环境反射强度）
 *     统一放在 theme.js 的 MATERIAL_THEMES 表里，本文件只负责「建材质 + 应用配方」，
 *     避免同一组数字在 scene.js / canyon.js / materials.js 三处各写一遍。
 *   · 风险五色由 theme.js 的 riskColors(theme) 给：浅色专版 #15803d/#b45309/
 *     #c2410c/#be123c/#6b7280，深色专版沿用 P1 的香槟金一族。
 *     ⚠ RISK_COLORS 的**对象引用永远不变**，setTheme 只原地改它的属性值 ——
 *       scene.js 的 wireMat 与模板脚本都持有这个引用，换引用会静默断链。
 *   · 所有颜色以 THREE.Color 保存，切换风险等级时对「受控材质」做颜色插值，
 *     不重建材质（重建会造成闪烁与 GC 抖动）。
 *   · 每个材质带 userData.recipe（配方键）与 userData.tintRole（受主题色影响的角色），
 *     这两个标记会被 Material.clone() 一起复制（three 的 copy() 走 JSON 深拷贝
 *     userData），所以 bridge.js 里 clone 出来的测点环也能被主题同步认领。
 * ==========================================================================*/
import {
  MATERIAL_THEMES, derivePalette, applyTintToMaterial, applyRecipeToMaterial,
  riskColors, getTheme, normalizeThemeName, setActiveRisk, DEFAULT_THEME,
} from './theme.js';

/** 风险等级 → 主题色（初始值 = 浅色专版；setTheme 时**原地**更新属性值） */
export const RISK_COLORS = riskColors(DEFAULT_THEME);

/** 主题色的「亮版/暗版」派生系数（深色主题的兼容常量；实际系数按 descriptor.tint 走） */
const LIGHTEN = 1.45;
const DARKEN = 0.55;

/**
 * 颜色是否已足够接近目标（阈值 1/255，肉眼不可分辨）。
 * 注意：three r160 的 THREE.Color **没有** distanceTo / distanceToSquared（那是 Vector3 的 API），
 * 只有 equals()，所以这里逐分量比较。
 */
function closeEnough(a, b) {
  return Math.abs(a.r - b.r) < 1 / 255 && Math.abs(a.g - b.g) < 1 / 255 && Math.abs(a.b - b.b) < 1 / 255;
}

/**
 * 创建全部材质。
 * @param {object} THREE three.js 命名空间
 * @param {string} [themeName='light'] 初始主题（第二参可选；缺省浅色，契约 §3.1）
 * @returns {object} mat 集合与调色板控制器
 */
export function createMaterials(THREE, themeName) {
  const theme = normalizeThemeName(themeName === undefined || themeName === null ? DEFAULT_THEME : themeName);
  const {
    MeshStandardMaterial, MeshPhysicalMaterial, LineBasicMaterial,
    MeshBasicMaterial, Color, DoubleSide,
  } = THREE;

  // 受主题色影响的材质统一登记，便于整体换色
  const tinted = [];
  function tint(material, role) {
    material.userData.tintRole = role;        // 'accent' | 'bright' | 'dim' → 'color' | 'emissive'
    tinted.push(material);
    return material;
  }
  // 登记配方键：主题切换时按这个键从 MATERIAL_THEMES 取参数
  function make(key, material) {
    material.userData.recipe = key;
    return material;
  }

  /* ---- 结构钢：主桁杆件（浅色主题 = 深灰对比主体；深色主题 = 亮灰金属） ---- */
  const steel = tint(make('steel', new MeshStandardMaterial({})), 'emissive');

  /* ---- 桁架描边（数字孪生高亮骨架，随风险等级变色） ---- */
  const edge = tint(make('edge', new MeshBasicMaterial({ transparent: true })), 'color');

  /* ---- 桥面板 ---- */
  const deckPlate = tint(make('deckPlate', new MeshStandardMaterial({})), 'emissive');

  /* ---- 行车道 ---- */
  const road = make('road', new MeshStandardMaterial({}));
  const laneMark = make('laneMark', new MeshBasicMaterial({ transparent: true }));
  const laneGlow = tint(make('laneGlow', new MeshBasicMaterial({ transparent: true })), 'color');
  const railGlow = tint(make('railGlow', new MeshBasicMaterial({ transparent: true })), 'color');

  /* ---- 主缆 / 吊索：金属索体（吊索实例颜色按相对荷载由 bridge.applyRisk 着色） ---- */
  const cable = tint(make('cable', new MeshStandardMaterial({})), 'emissive');

  /* ---- 缆索能量流光（叠加在同路径上的发光管） ---- */
  /* ⚠ 混合模式随主题变：深色 = AdditiveBlending（发光）；浅色 = NormalBlending。
     白底上加法混合等于消失（dst + src 被钳到纯白），这是用户需求里的硬约束。 */
  const cableFlow = tint(make('cableFlow', new MeshBasicMaterial({
    transparent: true, depthWrite: false,
  })), 'color');

  /* ---- 索夹 / 索鞍 ---- */
  const clamp = tint(make('clamp', new MeshStandardMaterial({})), 'emissive');

  /* ---- 混凝土（桥塔 / 锚碇 / 承台）：浅色主题 = 中性灰大块体量 ---- */
  const concrete = make('concrete', new MeshStandardMaterial({}));
  const concreteEdge = tint(make('concreteEdge', new MeshBasicMaterial({ transparent: true })), 'color');

  /* ---- 玻璃（观光厅 / 塔顶观星水吧 / 观光电梯） ----
     透光件：透明 + 双面；传输入射(transmission)=0，靠 opacity 叠加表现「玻璃感」。
     浅色主题把 envMapIntensity 压到 0.55、粗糙度升到 0.14（见 theme.js 注释）：
     浅色环境贴图平均亮度约为深色版的 7 倍，不压会变成一块白玻璃。 */
  const glass = tint(make('glass', new MeshPhysicalMaterial({
    transparent: true, side: DoubleSide, transmission: 0,
  })), 'emissive');
  const glassEdge = tint(make('glassEdge', new MeshBasicMaterial({ transparent: true })), 'color');

  /* ---- 测点标记（随风险等级变色，最醒目的元素） ---- */
  const sensor = tint(make('sensor', new MeshBasicMaterial({ transparent: true })), 'color');
  /* 测点光环：深色 = 加法混合发光环；浅色 = 普通混合的深色环（白底上加法会消失） */
  const sensorHalo = tint(make('sensorHalo', new MeshBasicMaterial({
    transparent: true, depthWrite: false, side: DoubleSide,
  })), 'color');

  /* ---- 岩体（峡谷；实际地形顶点色由 canyon.js 直接写进几何属性） ---- */
  const rock = make('rock', new MeshStandardMaterial({ flatShading: true }));
  const rockEdge = tint(make('rockEdge', new MeshBasicMaterial({ transparent: true })), 'color');

  /* ---- 水面（canyon.js 的 river 用主题 descriptor.water，这里是兼容保留的材质） ---- */
  const water = make('water', new MeshStandardMaterial({ transparent: true }));

  /* ---- 雾 / 云气（canyon.js 的 mist 用主题 descriptor.mist，这里是兼容保留） ---- */
  const mist = make('mist', new MeshStandardMaterial({ transparent: true, depthWrite: false, side: DoubleSide }));

  /* ---- 通用发光点（塔顶航空障碍灯等） ---- */
  const beacon = tint(make('beacon', new MeshBasicMaterial({ transparent: true })), 'color');

  const mats = {
    steel, edge, deckPlate, road, laneMark, laneGlow, railGlow,
    cable, cableFlow, clamp, concrete, concreteEdge, glass, glassEdge,
    sensor, sensorHalo, rock, rockEdge, water, mist, beacon,
  };
  const all = Object.keys(mats).map((k) => mats[k]);

  /** 受控调色板：当前值（accent/bright/dim）+ 目标值（target*），由 lerpPalette 逐帧逼近 */
  const seed = derivePalette(THREE, theme, 'normal');
  const PALETTE = {
    accent: seed.accent.clone(), bright: seed.bright.clone(), dim: seed.dim.clone(),
    target: seed.accent.clone(), targetBright: seed.bright.clone(), targetDim: seed.dim.clone(),
    key: 'normal', theme,
  };

  /** 依据风险等级设置主题色（带插值 tween，由 scene.js 每帧调用） */
  function setPalette(key, opts) {
    const k = RISK_COLORS[key] ? key : 'normal';
    PALETTE.key = k;
    setActiveRisk(k);                       // theme.js 记录当前风险等级（供克隆材质同步）
    const next = derivePalette(THREE, PALETTE.theme, k);
    PALETTE.target.copy(next.accent);
    PALETTE.targetBright.copy(next.bright);
    PALETTE.targetDim.copy(next.dim);
    if (opts && opts.snap) {                // 切主题时直接对齐，不放 0.3s 过渡动画
      PALETTE.accent.copy(next.accent);
      PALETTE.bright.copy(next.bright);
      PALETTE.dim.copy(next.dim);
      applyPalette();
    }
    return k;
  }

  /**
   * 每帧向目标色逼近（k 由调用方按 dt 缩放，通常 0.05~0.2）。
   * ⚠ 修掉一个 P1 的潜在缺陷：原实现只在「本帧还没收敛」时才 applyPalette()，
   *   于是收敛的那一帧（例如 k=1 直接到位）材质不会被刷——风险色会永久差 1/255。
   *   现在只要有任何分量发生变化就刷材质；返回值仍然是「是否还在运动中」，
   *   调用方（scene.js 的空载判定）语义不变。
   */
  function lerpPalette(k) {
    if (!PALETTE.target) return false;
    const pairs = [
      [PALETTE.accent, PALETTE.target],
      [PALETTE.bright, PALETTE.targetBright],
      [PALETTE.dim, PALETTE.targetDim],
    ];
    let changed = false, moving = false;
    for (let i = 0; i < pairs.length; i++) {
      const cur = pairs[i][0], tgt = pairs[i][1];
      if (cur.equals(tgt)) continue;
      changed = true;
      cur.lerp(tgt, k);
      if (closeEnough(cur, tgt)) cur.copy(tgt); else moving = true;
    }
    if (changed) applyPalette();
    return moving;
  }

  /** 把所有受控材质的颜色刷成当前 PALETTE（原地改，不换材质、不换引用） */
  function applyPalette() {
    for (let i = 0; i < tinted.length; i++) applyTintToMaterial(tinted[i], PALETTE);
  }

  /** 为发光材质登记发光系数（在 builder 中按材质语义设置；显式覆盖配方值） */
  function emissiveScale(material, scale) {
    material.userData.emissiveScale = scale;
    if (material.emissive) material.emissive.copy(PALETTE.accent).multiplyScalar(scale);
    return material;
  }

  /**
   * 认领一个「不在本集合里、但带着主题标记」的材质 —— 典型来源是
   * bridge.js 的 `mats.sensorHalo.clone()`（每个测点环一份，因为每环的
   * 不透明度是逐帧独立写的，不能共享材质）。
   * 幂等：重复认领不会重复入册。认领后它会跟着风险色一起变（修复了 P1 里
   * 克隆材质永远停在初始色、不随风险等级联动的问题）。
   */
  function adopt(material) {
    if (!material || !material.userData || !material.userData.tintRole) return false;
    if (tinted.indexOf(material) >= 0) return false;
    tinted.push(material);
    applyRecipeToMaterial(material, PALETTE.theme, THREE);
    applyTintToMaterial(material, PALETTE);
    return true;
  }

  /**
   * 切换主题（浅色/深色）。原地更新，**不重建材质、不重建几何**：
   *   ① 风险五色原地更新属性值（RISK_COLORS 引用不变 → scene.js 的 wireMat 等自动跟上）
   *   ② 每个材质按 MATERIAL_THEMES[theme] 重排（颜色/金属度/粗糙度/透明度/混合模式/
   *      环境反射强度），只对 program 相关的改动置 needsUpdate
   *   ③ 主题色按**当前风险等级**重算并立即对齐（避免切主题时出现半深半浅的中间态）
   * @returns {string} 生效的主题名
   */
  function setTheme(name) {
    const t = getTheme(name);
    PALETTE.theme = t.name;
    const rc = riskColors(t.name);
    const keys = Object.keys(RISK_COLORS);
    for (let i = 0; i < keys.length; i++) {
      if (rc[keys[i]]) RISK_COLORS[keys[i]] = rc[keys[i]];   // ← 原地改属性，不换对象
    }
    for (let i = 0; i < all.length; i++) applyRecipeToMaterial(all[i], t.name, THREE);
    setPalette(PALETTE.key || 'normal', { snap: true });
    return t.name;
  }

  // 初始主题：建材质时就把配方与主题色写进去（默认浅色 → 不改任何调用点也是浅色）
  for (let i = 0; i < all.length; i++) applyRecipeToMaterial(all[i], theme, THREE);
  applyPalette();

  return {
    mats, setPalette, lerpPalette, applyPalette, emissiveScale, tinted, PALETTE,
    /* P2 扩展（契约之外的新增项，均为附加导出，不改变既有语义） */
    setTheme, adopt, all, themeName: theme, THREE,
  };
}

/* 兼容导出：供报告/自测复算派生色（P1 的常量语义，保留名字） */
export { LIGHTEN, DARKEN, MATERIAL_THEMES };
