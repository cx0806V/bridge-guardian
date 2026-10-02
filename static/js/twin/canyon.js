/* ============================================================================
 * 花江大峡谷地形 / 北盘江水面 / 峡谷雾气 —— 主题化 + 三档网格密度
 * ----------------------------------------------------------------------------
 * 说明（诚实边界）：花江大峡谷真实地形为深切近千米的喀斯特 V 形谷，两岸峭壁
 * 如门对峙。这里用“解析地形函数 + 确定性分形噪声”生成**示意性地形**，用于数字
 * 孪生场景的空间参照与比例表达；它不是测绘数据，不能用于工程量算。
 * 唯一严格对齐的尺度是：桥面（y=0）至水面（y=-625）为 625m，与公开参数一致。
 *
 * ----------------------------------------------------------------------------
 * 【P2 改动一：地形网格三档密度】（契约 §3.2 的 profile.terrain: 'high'|'mid'|'low'）
 *   档位   nx×nz      顶点数  三角形数  占高画质  单元尺寸(x×z)  视觉差异
 *   high   220×150    33371   66000     100%     8.2m × 13.3m    基线观感（= P1 原值）
 *   mid    150×102    15553   30600     46.6%    12.0m × 19.6m    山脊棱线变简，块面变大
 *   low    110×75      8436   16500     25.3%    16.4m × 26.7m    远山轮廓明显多边形化
 *   （顶点/三角形数是**从 geometry 实测读出**的：verts=position.count、
 *     tris=index.count/3，见 geometryInfo()，不许写死常量充数。）
 *
 *   flatShading 取舍：三档**都保留 flatShading = true**。理由：
 *     ① 顶点色是按世界坐标算的岩层条带，与网格密度无关，所以低密度下颜色图案
 *        仍然完整，只有「块面」变大 —— flatShading 把这种块面解释成刻意的
 *        低多边形岩体，而不是「糊掉的山」；
 *     ② 关掉 flatShading 走平滑法线时，粗网格的大三角形之间会出现大面积的
 *        平滑渐变，岩层台阶感消失、看起来像被抹平的橡皮泥，观感反而更差；
 *     ③ flatShading 在 three 里是片元着色器用 dFdx/dFdy 求面法线，不需要
 *        额外几何或属性，代价只有一点点片元开销。
 *     ④ 代价要说清：低密度下细粒噪声（fbm 0.011 尺度 ≈ 90m 波长）被 16~27m 的
 *        采样间距欠采样，会出现不规则「疙瘩」而不是连续岩纹 —— 这是低档位换
 *        帧率的真实代价，不是无损降级。
 *
 * 【P2 改动二：雾气可关】
 *   4 层半透明面片是「水平悬空的白纱 + 缓慢漂移」，关闭后由 FogExp2 深度雾
 *   补偿（theme.js applyFog：density ×1.75）。**差在哪**（如实说）：
 *     ① 深度雾只随「到相机的距离」变化，做不出「谷底浓、谷口淡」的竖直梯度；
 *     ② 没有缓慢漂移的动感，画面静止时少了一层「空气感」；
 *     ③ 面片能压住远山的细节让层次分开，深度雾是把所有远处物体整体推向雾色，
 *        远山之间的「前后关系」会变弱；
 *     ④ 好处是少 4 个半透明大面片的 overdraw（软件渲染下这 4 层很贵）。
 * ==========================================================================*/
import {
  PlaneGeometry, Mesh, Float32BufferAttribute, DoubleSide,
  MeshStandardMaterial, MeshBasicMaterial, Group, Color,
  AdditiveBlending, NormalBlending,
} from 'three';
import { makeNoise2D, fbm, smoothstep, clamp, col } from './geom.js';
import { getTheme, resolveTheme, DEFAULT_THEME } from './theme.js';
// getTheme 保留导入：供调用方/自测确认主题表可用（resolveTheme 是内部主路径）

/** 地形控制参数（nx/nz 为**高画质档**，与 P1 原值一致；其它档见 TERRAIN_DENSITIES） */
export const TERRAIN = {
  zHalf: 900,        // 网格 X 向半宽（1800m 跨度）
  xHalf: 1000,       // 网格 Z 向半长（2000m 跨度）
  nx: 220,           // 高画质档网格列数
  nz: 150,           // 高画质档网格行数
  waterY: -628,      // 水面高程（水面作为参照面，略低于河床基准 -625）
  benchZ: 96,        // 塔柱基础中心（横桥向，示意：塔柱落在谷壁开挖平台上）
};

/**
 * 三档地形密度（字段名 `density`，取值与 quality.js 的 profile.terrain 完全一致，
 * perf-core 直接透传即可）：
 *   'high'  100% 高画质/中画质档（契约 §3.2：high 与 medium 都用 'high'）
 *   'mid'   约 1/2 顶点（预留档位，阶梯里暂未使用，供手动/后续调档）
 *   'low'   约 1/4 顶点（ultraLow 档，契约 §3.2）
 */
export const TERRAIN_DENSITIES = {
  high: { nx: 220, nz: 150 },
  mid: { nx: 150, nz: 102 },
  low: { nx: 110, nz: 75 },
};

/** 非法/缺省档位 → 'high'（localStorage 脏值不许把地形搞崩，契约 §1.3） */
export function resolveDensity(density) {
  const name = Object.prototype.hasOwnProperty.call(TERRAIN_DENSITIES, density) ? density : 'high';
  return { name, nx: TERRAIN_DENSITIES[name].nx, nz: TERRAIN_DENSITIES[name].nz };
}

/** 实测几何信息（顶点/三角形从 geometry 读，不写死） */
function geometryInfo(geo, d) {
  const pos = geo && geo.getAttribute ? geo.getAttribute('position') : null;
  const verts = pos ? pos.count : 0;
  const tris = geo && geo.index ? geo.index.count / 3 : verts / 3;
  return {
    density: d.name, nx: d.nx, nz: d.nz, verts, tris,
    cells: d.nx * d.nz,
    facet: [(TERRAIN.zHalf * 2) / d.nx, (TERRAIN.xHalf * 2) / d.nz],
    flatShading: true,
  };
}

/** 默认高度场（模块级共享，避免各处重复构建噪声表） */
let _defaultField = null;
export function groundAt(x, z) {
  if (!_defaultField) _defaultField = makeHeightField();
  return _defaultField(x, z);
}

/**
 * 地形高程函数（给定世界 x/z 返回 y）。
 * 形态：河谷沿桥轴（x 方向）展开，两岸谷壁沿横桥向（z 方向）抬升；叠加喀斯特
 * 岩层台阶与分形细节；两塔柱下方各有一处开挖平台（bench），使塔柱真正“落在岩体上”。
 * 谷底基准 -625m 与“桥面至水面 625m”严格一致。
 */
export function makeHeightField(seed = 20240607) {
  const noise = makeNoise2D(seed);
  const H = 625;         // 桥面至水面 625m（公开参数）→ 河床基准高程 -625
  const BENCH_Y = -72;   // 塔柱基础平台高程（示意，落在谷壁开挖平台上）

  // 塔柱平台：每座桥塔的两根塔柱分列峡谷两岸（横桥向 z=±benchZ），
  // 因此在两个塔位各放一对「沿桥向拉长、向峡谷一侧自然过渡」的岩台；
  // x 方向拉长是为了让岩台与谷壁连成一体，而不是孤立的土墩。
  const benches = [
    { x: -710, z: -(TERRAIN.benchZ - 22), y: BENCH_Y, hx: 140, hz: 80 },
    { x: -710, z: (TERRAIN.benchZ - 22), y: BENCH_Y, hx: 140, hz: 80 },
    { x: 710, z: -(TERRAIN.benchZ - 22), y: BENCH_Y, hx: 140, hz: 80 },
    { x: 710, z: (TERRAIN.benchZ - 22), y: BENCH_Y, hx: 140, hz: 80 },
  ];

  // 峡谷横断面基准：花江大峡谷是「两壁近乎直立、深近千米」的深切河谷。
  // 这里用「窄河槽 + 井壁式陡升 + 顶层渐缓」的幂函数逼近：
  //   · |z| ≈ 0~50  河槽底部（水面 y=-628 覆盖河床）
  //   · |z| ≈ 50~96 井壁陡升段（塔柱基础 z=±96 恰好落在井壁顶缘 y≈-72 附近）
  //   · |z| >  200  井壁转为台地/山脊（自然高于桥面）
  // 取「井壁幂函数」与「饱和型山体抬升」的较小值：近处由井壁控制（陡），
  // 远处由山体控制（缓），避免同一幂函数在 1km 外把地形抬到上千米。
  function base(az) {
    const wall = -648 + 3.4 * Math.pow(Math.max(0, az), 1.28);
    const mountain = -648 + 1250 * (1 - Math.exp(-Math.max(0, az) / 620));
    return Math.min(wall, mountain);
  }

  /** 山体大尺度起伏（谷壁之外）——让峡谷两岸是峰峦而非一块平台 */
  function massif(x, z) {
    return fbm(noise, x * 0.00058 + 3.7, z * 0.00058 - 8.2, 4) * 165;
  }

  return function heightAt(x, z) {
    const az = Math.abs(z);

    // ① 基础峡谷断面
    let h = base(az);

    // ② 岩层台阶（喀斯特层理：竖向正弦调制，层叠岩壁）
    const wallness = smoothstep(50, 200, az);
    const strata = Math.sin(h * 0.055) * 5.5 + Math.sin(h * 0.017 + 1.7) * 12.0;

    // ③ 分形细节：谷壁粗糙、台地平缓
    const detail = fbm(noise, x * 0.0022, z * 0.0022, 5) * (24 * wallness + 9);
    const fine = fbm(noise, x * 0.011, z * 0.011, 3) * (7 * wallness + 2.5);

    // ④ 沿桥向起伏 + 山体收口（峡谷两侧山体在桥台附近抬升，使桥“跨谷而过”）
    const along = fbm(noise, x * 0.0011 + 11.3, z * 0.0006 - 4.1, 3);
    const mtn = smoothstep(700, 1000, Math.abs(x)) * 420;
    // 桥轴上的垭口：避免地形把主跨与塔顶挡住
    const notch = 1 - smoothstep(60, 300, az);

    // ⑤ 河道下切：靠近桥梁中线处下切，形成 V 形河床（水面 -628 恰好覆盖）
    const chan = smoothstep(90, 0, az) * 32;

    // ⑥ 山体大尺度起伏：谷壁（|z|<200）内不叠加，避免破坏塔柱基础平台
    const relief = massif(x, z) * smoothstep(150, 420, az);

    // ⑦ 桥台/锚碇平台：桥面两端（|x| 接近锚碇位置）岩体抬到接近桥面标高，
    //    使引桥真正“进山”、主缆后端锚入岩体，而不是悬在半空；
    //    平台只抬到锚碇附近，再往外回落到山脊标高，避免出现孤立高台
    const outward = smoothstep(1150, 1400, Math.abs(x));
    const abut = (1 - outward) * smoothstep(880, 1180, Math.abs(x)) * (215 - base(az));

    h += strata * wallness + detail + fine + along * 44 * (1 - wallness) + mtn * notch - chan + abut + relief;

    // ⑦ 塔柱基础平台：局部把岩体抬到 BENCH_Y，供塔柱/承台落地
    for (let i = 0; i < benches.length; i++) {
      const b = benches[i];
      const d = Math.hypot((x - b.x) / b.hx, (z - b.z) / b.hz);
      const w = 1 - smoothstep(0.9, 3.2, d);
      if (w > 0) h = h * (1 - w) + b.y * w;
    }

    // ⑦ 山脊封顶（软限制）：主跨两侧地形最高约 +260m（自然高于桥面，形成“峡谷中跨桥”），
    //    远端继续抬升为山体；桥轴上的垭口保证不遮挡塔顶（+170）与主缆
    const cap = 260 + fbm(noise, x * 0.0016, z * 0.0016, 3) * 110 + mtn * 1.1;
    if (h > cap) h = cap - (h - cap) * 0.2;   // 软压缩而非硬截断，避免平台断崖
    return h;
  };
}

/* ------------------------------------------------------------ 顶点色（主题化） */
const _tmpColor = new Color();

/**
 * 单点顶点色：按「高程 + 岩层条带 + 近水压暗」在主题给的五色之间插值。
 * 与 P1 的算法逐行一致，只是把五个色值与近水压暗系数改成从 descriptor.terrain 取 ——
 * 所以切主题时**只需重算顶点色**，不用重建几何（33k 顶点 <5ms，无闪烁）。
 */
function terrainColorAt(x, y, theme, out) {
  const T = theme.terrain;
  // 高程归一化（-625 → 250）
  const t = clamp((y + 625) / 875, 0, 1);
  // 岩层条带：竖向正弦 → 冷暖交替
  const band = Math.sin(y * 0.055 + Math.sin(x * 0.004) * 1.2);
  const bandMix = clamp(0.5 + 0.5 * band, 0, 1);

  out.copy(col(T.cLow)).lerp(col(T.cMid), smoothstep(0, 0.35, t));
  out.lerp(col(T.cHigh), smoothstep(0.3, 0.72, t));
  out.lerp(col(T.cTop), smoothstep(0.7, 1.0, t));
  out.lerp(col(T.cWarm), bandMix * 0.22 * smoothstep(0.15, 0.5, t));

  // 谷底近水区压暗（湿岩/阴影），增加纵深；浅色主题系数减半，避免谷底发黑
  const nearWater = 1 - smoothstep(0, 55, y + 625);
  out.multiplyScalar(1 - nearWater * (T.nearWaterDarken === undefined ? 0.35 : T.nearWaterDarken));
  return out;
}

/**
 * 生成地形几何（顶点高程 + 顶点色 + 法线）。
 * ⚠ 采样/写入的镜像约定与 P1 完全一致：采样用 z = -posZ，写回用 posZ（原始值），
 *   即「地形是采样场的 Z 镜像」。别顺手“修”成一致 —— 那会整体镜像地形轮廓，
 *   塔柱基础平台与谷壁的相对位置会变，属于破坏性改动。
 */
function buildTerrainGeometry(THREE, heightAt, nx, nz, theme) {
  const geo = new PlaneGeometry(TERRAIN.zHalf * 2, TERRAIN.xHalf * 2, nx, nz);
  geo.rotateX(-Math.PI / 2);   // 平面转为水平面：局部 (X,0,Z) 对应世界 (x,y,z)

  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = -pos.getZ(i);        // 旋转后 z 取反，让 x/z 对应桥轴/横桥向
    const y = heightAt(x, z);
    pos.setY(i, y);
    pos.setZ(i, -z);

    terrainColorAt(x, y, theme, _tmpColor);
    colors[i * 3] = _tmpColor.r; colors[i * 3 + 1] = _tmpColor.g; colors[i * 3 + 2] = _tmpColor.b;
  }
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** 地形材质（顶点色 + flatShading；颜色/粗糙度/环境强度由主题写） */
function buildTerrainMaterial(THREE, theme) {
  const m = new MeshStandardMaterial({
    vertexColors: true, metalness: theme.terrain.metalness, roughness: theme.terrain.roughness,
    flatShading: theme.terrain.flatShading !== false,
  });
  m.envMapIntensity = theme.terrain.envIntensity === undefined ? 1.0 : theme.terrain.envIntensity;
  return m;
}

/**
 * 生成峡谷网格。
 * @param {object} THREE three 命名空间
 * @param {function} heightAt 高程函数（缺省用模块共享的 groundAt）
 * @param {object} [opts]
 *   · density: 'high'|'mid'|'low'（默认 'high'，与 quality.js 的 profile.terrain 同值）
 *   · nx / nz: 显式覆盖网格密度（优先级高于 density，P1 兼容用法）
 *   · theme: 'light'|'dark' 或 descriptor（默认 'light'）
 *   · name: mesh 名称（默认 'canyon'；measure.py 按名字查找，别改）
 * @returns {Mesh} 地形网格（userData.density / userData.info / userData.applyTheme）
 */
export function createCanyon(THREE, heightAt, opts = {}) {
  const d = (opts.nx || opts.nz)
    ? { name: opts.density || 'custom', nx: opts.nx || TERRAIN.nx, nz: opts.nz || TERRAIN.nz }
    : resolveDensity(opts.density);
  const theme = resolveTheme(opts.theme === undefined ? DEFAULT_THEME : opts.theme);
  const fn = typeof heightAt === 'function' ? heightAt : groundAt;
  const geo = buildTerrainGeometry(THREE, fn, d.nx, d.nz, theme);
  const mat = buildTerrainMaterial(THREE, theme);
  const mesh = new Mesh(geo, mat);
  mesh.name = opts.name || 'canyon';
  mesh.receiveShadow = false;
  mesh.userData.density = d.name;
  mesh.userData.info = geometryInfo(geo, d);
  mesh.userData.theme = theme.name;
  // 主题钩子：theme.js 的 applySceneTheme 会遍历调用（切主题不重建几何）
  mesh.userData.applyTheme = (t) => applyCanyonTheme(mesh, t);
  return mesh;
}

/**
 * 原地应用地形主题：重算顶点色 + 刷材质参数。**不重建几何、不换材质引用**。
 * 33k 顶点重算约 2~4ms（一次主题切换只跑一次），比重建几何（几十 ms + 显存抖动）安全得多。
 */
export function applyCanyonTheme(mesh, themeRef) {
  if (!mesh || !mesh.geometry) return null;
  const theme = resolveTheme(themeRef === undefined ? mesh.userData.theme || DEFAULT_THEME : themeRef);
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  const colorAttr = geo.getAttribute('color');
  if (pos && colorAttr) {
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      terrainColorAt(x, y, theme, _tmpColor);
      colorAttr.setXYZ(i, _tmpColor.r, _tmpColor.g, _tmpColor.b);
    }
    colorAttr.needsUpdate = true;
  }
  const m = mesh.material;
  if (m) {
    m.metalness = theme.terrain.metalness;
    m.roughness = theme.terrain.roughness;
    if ('envMapIntensity' in m) {
      m.envMapIntensity = theme.terrain.envIntensity === undefined ? 1.0 : theme.terrain.envIntensity;
    }
    const flat = theme.terrain.flatShading !== false;
    if (m.flatShading !== flat) { m.flatShading = flat; m.needsUpdate = true; }
  }
  mesh.userData.theme = theme.name;
  return mesh;
}

/**
 * 切换地形密度：**在同一个 mesh 对象上换 geometry**，并 dispose 旧几何。
 * 对调用方最省事：不用 scene.remove/add、`scene.getObjectByName('canyon')` 的引用不失效、
 * 不会闪一帧；旧顶点缓冲立刻释放（不 dispose 的话每切一档就泄漏一份 GPU 缓冲）。
 * @returns {{density,nx,nz,verts,tris,cells,facet}} 实测几何信息
 */
export function setCanyonDensity(THREE, mesh, heightAt, density, themeRef) {
  if (!mesh) return null;
  const d = resolveDensity(density);
  const theme = resolveTheme(
    themeRef === undefined ? (mesh.userData.theme || DEFAULT_THEME) : themeRef);
  const fn = typeof heightAt === 'function' ? heightAt : groundAt;
  const old = mesh.geometry;
  const next = buildTerrainGeometry(THREE, fn, d.nx, d.nz, theme);
  mesh.geometry = next;
  if (old && old !== next && typeof old.dispose === 'function') old.dispose();
  mesh.userData.density = d.name;
  mesh.userData.info = geometryInfo(next, d);
  mesh.userData.theme = theme.name;
  return mesh.userData.info;
}

/* ------------------------------------------------------------------ 水面 */
/**
 * 北盘江水面（河床最深段），带缓慢流动的细波纹。
 * 浅色主题 = 中灰蓝 + 低粗糙度，主要映环境贴图的亮地平线（浅色反光）；
 * 深色主题 = P1 的近黑金属水面（映香槟金地平线）。
 */
export function createRiver(THREE, opts = {}) {
  const theme = resolveTheme(opts.theme === undefined ? DEFAULT_THEME : opts.theme);
  const w = TERRAIN.zHalf * 2, d = TERRAIN.xHalf * 2;
  const geo = new PlaneGeometry(w, d, 24, 24);
  geo.rotateX(-Math.PI / 2);
  const mat = new MeshStandardMaterial({ transparent: true, fog: true });
  const mesh = new Mesh(geo, mat);
  mesh.position.y = TERRAIN.waterY;
  mesh.name = opts.name || 'river';
  applyRiverTheme(mesh, theme);
  mesh.userData.applyTheme = (t) => applyRiverTheme(mesh, t);
  return mesh;
}

/** 原地应用水面主题（颜色/金属度/粗糙度/自发光/不透明度/环境强度） */
export function applyRiverTheme(mesh, themeRef) {
  if (!mesh) return null;
  const theme = resolveTheme(themeRef === undefined ? mesh.userData.theme || DEFAULT_THEME : themeRef);
  const w = theme.water, m = mesh.material;
  if (m) {
    m.color.set(w.color);
    m.metalness = w.metalness;
    m.roughness = w.roughness;
    if (m.emissive) m.emissive.set(w.emissive);
    m.opacity = w.opacity;
    m.transparent = w.opacity < 1;
    if ('envMapIntensity' in m) m.envMapIntensity = w.envIntensity === undefined ? 1.0 : w.envIntensity;
  }
  mesh.userData.theme = theme.name;
  return mesh;
}

/* ------------------------------------------------------------------ 雾气 */
/**
 * 4 层水平雾气面片（越靠谷底越浓）。低画质档由 perf-core 调 setMistEnabled(false) 关闭，
 * 并用 FogExp2 加浓补偿（theme.js applyFog）。
 * 层参数导出供报告/自测引用（层数、透明度、高度都是可核对的事实）。
 */
export const MIST_LAYERS = [
  { y: -430, opacity: 0.05, size: 1500 },
  { y: -250, opacity: 0.045, size: 1700 },
  { y: -90, opacity: 0.04, size: 1900 },
  { y: 60, opacity: 0.03, size: 2000 },
];

/** 峡谷雾气：多层水平半透明面片（越靠谷底越浓），营造 625m 纵深 */
export function createMist(THREE, heightAt, opts = {}) {
  const theme = resolveTheme(opts.theme === undefined ? DEFAULT_THEME : opts.theme);
  const group = new Group();
  group.name = opts.name || 'mist';
  MIST_LAYERS.forEach((l, i) => {
    const geo = new PlaneGeometry(l.size, l.size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    // 每层独立材质：不透明度逐层不同（共享材质会把所有层刷成同一个值）
    const m = new MeshStandardMaterial({
      transparent: true, blending: NormalBlending, depthWrite: false, side: DoubleSide, fog: true,
    });
    const mesh = new Mesh(geo, m);
    mesh.position.set(0, l.y, 0);
    mesh.userData.drift = 0.4 + i * 0.25;   // scene.js 按它算漂移速度，别改键名
    mesh.userData.baseX = 0;
    mesh.userData.baseOpacity = l.opacity;
    mesh.userData.layerY = l.y;
    group.add(mesh);
  });
  applyMistTheme(group, theme);
  setMistEnabled(group, opts.enabled !== false);
  group.userData.applyTheme = (t) => applyMistTheme(group, t);
  return group;
}

/**
 * 原地应用雾气主题。
 *   · 浅色：白色半透明（NormalBlending）+ 自发光 0.5 —— 面片「自亮」不受光照方向影响，
 *     否则水平面片只有被主光照到才亮，背光侧会发灰，在白底上像脏雾。
 *   · 深色：P1 的暖白 + AdditiveBlending，观感不变。
 * opacityScale 是主题级的浓度系数（浅色 1.6：白底上 5% 的白纱几乎看不见，需要抬一档）。
 */
export function applyMistTheme(group, themeRef) {
  if (!group) return null;
  const theme = resolveTheme(themeRef === undefined ? group.userData.theme || DEFAULT_THEME : themeRef);
  const t = theme.mist;
  const additive = t.blending === 'additive';
  group.children.forEach((mesh, i) => {
    const m = mesh.material;
    if (!m) return;
    const base = mesh.userData.baseOpacity === undefined
      ? (MIST_LAYERS[i] ? MIST_LAYERS[i].opacity : 0.04) : mesh.userData.baseOpacity;
    m.color.set(t.color);
    m.opacity = base * (t.opacityScale === undefined ? 1 : t.opacityScale);
    if (m.emissive) m.emissive.set(t.emissive === undefined ? 0x000000 : t.emissive);
    if ('emissiveIntensity' in m) m.emissiveIntensity = t.emissiveIntensity === undefined ? 1 : t.emissiveIntensity;
    const blending = additive ? AdditiveBlending : NormalBlending;
    if (m.blending !== blending) { m.blending = blending; m.needsUpdate = true; }
    m.depthWrite = false;
    m.transparent = true;
  });
  group.userData.theme = theme.name;
  group.userData.blending = t.blending;
  return group;
}

/**
 * 开关雾气面片（低画质档 profile.mist=false）。用 group.visible 整体关闭：
 * 4 个面片一次全停，不用逐层改材质（也便于 measure.py 读 groupVisible 复核）。
 * ⚠ 关掉以后纵深靠 FogExp2 补偿，差在哪见本文件头部说明。
 */
export function setMistEnabled(group, on) {
  if (!group) return false;
  group.visible = !!on;
  group.userData.enabled = !!on;
  return group.visible;
}

/** 雾气当前状态（自测/报告用：层数、可见层数、各层不透明度、混合模式、是否启用） */
export function mistState(group) {
  if (!group) return null;
  const layers = [];
  let visible = 0;
  group.children.forEach((m) => {
    if (m.visible) visible++;
    layers.push({
      y: m.userData.layerY,
      opacity: m.material ? +m.material.opacity.toFixed(4) : null,
      blending: m.material && m.material.blending === AdditiveBlending ? 'additive'
        : (m.material && m.material.blending === NormalBlending ? 'normal' : String(m.material && m.material.blending)),
      color: m.material && m.material.color ? '#' + m.material.color.getHexString() : null,
    });
  });
  return {
    layers: group.children.length, visibleLayers: visible,
    groupVisible: group.visible, enabled: group.userData.enabled !== false,
    theme: group.userData.theme || null, list: layers,
  };
}
