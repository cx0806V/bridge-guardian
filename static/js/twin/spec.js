/* ============================================================================
 * 花江峡谷大桥 —— 数字孪生参数表（全部为公开设计参数，单位：米）
 * ----------------------------------------------------------------------------
 * 参数来源：贵州省交通规划勘察设计研究院《建在“地球裂缝”上的世界级高桥——
 *          花江峡谷大桥设计创新》（《桥梁》杂志 2024 年第 6 期，总第 122 期）：
 *          · 主桥：1420m 双塔单跨钢桁梁悬索桥，缆跨布置 245m + 1420m + 495m
 *          · 主缆垂跨比 1/10；主缆中心距 27m；考虑吊索及检修道布设全宽 30.5m
 *          · 桥面宽度 25.5m（双向 4 车道，设计速度 80km/h）
 *          · 桥位高程 1113m，桥面至水面 625m（世界第一高桥）
 *          · 加劲梁：板桁结合钢桁梁，主桁桁高 8m、桁宽 27m、标准节段 15.4m，
 *            带竖腹杆的华伦式（Warren）结构
 *          · 吊索：φ64mm 钢丝绳（端吊索 φ68mm），每一吊点 2 根，索夹骑跨式
 *          · 索鞍：锻焊结合式主索鞍 / 散索鞍
 *          · 锚碇：六枝岸隧道锚，安龙岸重力锚（最大高度 70.85m）
 *          · 抗风：中央稳定板 + 上/下水平导流板（下导流板兼作空中竞速跑道）
 *          · 桥旅融合：塔内观光电梯 + 塔顶观星水吧、桁梁内观光廊道与玻璃观光厅
 * 未公开/无法确证的细节（如塔柱精确收坡率、横梁道数、承台尺寸）按公开效果图
 * 与同类山区悬索桥的合理比例补全，并在代码注释中标注为“示意”，绝不冒充实测值。
 * ==========================================================================*/

/** 世界坐标约定（右手系，单位 m）：
 *    x ：沿桥轴，负 = 六枝岸（隧道锚 / 北），正 = 安龙岸（重力锚 / 南）
 *    y ：高程，0 = 主跨桥面（桥面板顶面），向上为正
 *    z ：横桥向，0 = 桥梁中线，两主缆位于 z = ±13.5（中心距 27m）
 */

export const SPAN = {
  sideNorth: 245,          // 六枝岸边跨（主缆水平投影）
  main: 1420,              // 主跨
  sideSouth: 495,          // 安龙岸边跨（主缆水平投影）
  total: 2160,             // 主缆总跨径（245 + 1420 + 495）
};

/** 塔位、索鞍、锚碇（x 坐标，m） */
export const X = {
  northTower: -SPAN.main / 2,          // -710
  southTower: SPAN.main / 2,           // +710
  northTowerLegNorth: -710,            // 塔柱中心线 = 索鞍中心线
  northAnchor: -SPAN.main / 2 - SPAN.sideNorth,   // -955 隧道锚
  southAnchor: SPAN.main / 2 + SPAN.sideSouth,    // +1205 重力锚
  midSpan: 0,
};

/** 竖向标高（y，m，相对桥面） */
export const Y = {
  deck: 0,                 // 桥面板顶面
  trussBottom: -8,         // 主桁下弦（桁高 8m）
  riverBed: -625,          // 水面（桥面至水面 625m）
  saddle: 170,             // 主索鞍中心（塔顶）—— 索鞍高出桥面 170m（示意，与
                           //   垂跨比 1/10 → 跨中主缆低于桥面 28m 的自洽几何一致）
  cableMid: 170 - SPAN.main * 0.1,  // = 28.0 跨中主缆高程（低于桥面 28m）
  towerBaseNorth: -70,     // 六枝岸塔柱底（落于峡谷陡壁基岩，示意）
  towerBaseSouth: -45,     // 安龙岸塔柱底（示意）
  southAnchorTop: -30,     // 重力锚顶面（示意；重力锚最大高度 70.85m）
  tunnelPortalDeck: 0,     // 六枝岸隧道口位于桥面标高
};

/** 横桥向（z，m） */
export const Z = {
  half: 13.5,              // 主缆 / 主桁中心线（27m 中心距）
  roadwayHalf: 12.75,      // 桥面宽度 25.5m → 行车道半宽
  deckHalf: 15.25,         // 结构全宽 30.5m（含检修道/吊索布设空间）
  walkwayHalf: 14.4,       // 检修道中心（示意）
};

/** 主梁（板桁结合钢桁梁） */
export const GIRDER = {
  panel: 15.4,             // 标准节段长度
  panelsPerSpan: Math.round(SPAN.main / 15.4),  // 1420 / 15.4 = 92（整数节段）
  depth: 8,                // 主桁桁高
  width: 27,               // 主桁桁宽（两主桁中心距）
  chord: 0.85,             // 弦杆截面（示意，方钢管）
  diagonal: 0.62,          // 斜腹杆 / 竖腹杆截面（示意）
  floorBeam: 0.9,          // 横梁高度（示意）
  deckSlab: 0.42,          // 正交异性钢桥面板厚（含铺装，示意）
  railH: 1.15,             // 护栏高（示意）
  lanes: 4,                // 双向 4 车道
};

/** 主缆 */
export const CABLE = {
  sag: SPAN.main * 0.1,    // 垂度 142m（垂跨比 1/10）
  radius: 0.42,            // 主缆半径（217 股 × 91 丝 φ5.7 的等效圆，示意）
  strands: 217,            // 通长索股数（仅用于信息展示）
  backstayPairs: 4,        // 边缆背索 4 对
  hangerRadius: 0.032,     // φ64mm 吊索
  endHangerRadius: 0.034,  // φ68mm 端吊索
  clampR: 0.55,            // 索夹外径（示意）
  clampH: 1.7,             // 索夹高度（示意）
  hangerDx: 7.7,           // 每一吊点 2 根吊索（骑跨式索夹）横向间距的一半
};

/** 桥塔（“门”形，层叠横梁，融入峡谷岩层地貌） */
export const TOWER = {
  // 塔柱基础中心（横桥向）：真实桥塔的两根塔柱沿纵桥向分列主跨两侧、间距很小，
  // 而主缆中心距 27m 远小于峡谷跨度，因此本项目把两根塔柱的基础分别布置在峡谷两岸
  // 的开挖平台上（与该值一致，见 canyon.js 的 BENCH_Y=-72），塔柱横梁跨谷相连。
  benchZ: 96,
  north: {
    key: 'north', name: '六枝岸桥塔', code: 'N',
    x: X.northTower,
    legTop: Y.saddle - 6,          // 塔柱顶（索鞍之下）
    legBase: Y.towerBaseNorth,
    totalHeight: Y.saddle - Y.towerBaseNorth,   // ≈ 240m（示意；与公开效果图比例一致）
    baseHalfZ: 13.5,               // 塔柱中心距（与主缆中心距一致）
  },
  south: {
    key: 'south', name: '安龙岸桥塔', code: 'S',
    x: X.southTower,
    legTop: Y.saddle - 6,
    legBase: Y.towerBaseSouth,
    totalHeight: Y.saddle - Y.towerBaseSouth,   // ≈ 215m（示意）
    baseHalfZ: 13.5,
    // 桥旅融合：塔顶观星水吧（两层，总面积 230m²）+ 观光电梯
    skyBar: true,
  },
  legSectionBase: { x: 9.0, z: 7.2 },   // 塔柱底截面（示意）
  legSectionTop: { x: 6.4, z: 5.6 },    // 塔柱顶截面（示意，收坡）
  crossBeams: 4,                         // 层叠横梁道数（示意）
  crossBeamD: 4.2,                       // 横梁高度（示意）
};

/** 锚碇 */
export const ANCHOR = {
  north: {
    key: 'north', name: '六枝岸隧道锚', code: 'TA',
    x: X.northAnchor, y: -55, type: 'tunnel',
  },
  south: {
    key: 'south', name: '安龙岸重力锚', code: 'GA',
    x: X.southAnchor, y: Y.southAnchorTop, type: 'gravity',
    height: 70.85,          // 公开参数：最大高度 70.85m
  },
};

/** 峡谷地形控制点（示意；花江大峡谷深切近千米、两岸峭壁如门对峙） */
export const CANYON = {
  width: 1500,             // 峡谷净宽量级（x 方向跨度按桥轴展开）
  depth: 625,              // 桥面至水面
  zRange: 900,             // 展示范围内横桥向半宽
  xRange: 1000,            // 展示范围内沿桥向半长
};

/** 场景中可点选的监测/结构热点（点击或双击聚焦） */
export const HOTSPOTS = [
  { key: 'midspan', label: '跨中测点', code: 'SG-01', x: 0, y: 0, z: 0,
    note: '主跨跨中挠度/应变监测点 · 光纤光栅智慧索股与桥面测点同源' },
  { key: 'quarter', label: '四分点测点', code: 'SG-02', x: -355, y: 0, z: 0,
    note: 'L/4 断面监测点（示意布点）' },
  { key: 'towerN', label: '六枝岸桥塔', code: 'T-N', x: X.northTower, y: Y.saddle, z: 0,
    note: '塔顶索鞍 + 塔顶观星水吧（示意）' },
  { key: 'towerS', label: '安龙岸桥塔', code: 'T-S', x: X.southTower, y: Y.saddle, z: 0,
    note: '塔顶索鞍 + 观光电梯 + 塔顶观星水吧' },
  { key: 'cableMid', label: '主缆跨中', code: 'MC-01', x: 0, y: Y.cableMid, z: Z.half,
    note: '主缆温度/湿度/应力应变智慧索股（217 股通长索股）' },
  { key: 'anchorN', label: '六枝岸隧道锚', code: 'TA-N', x: ANCHOR.north.x, y: ANCHOR.north.y, z: 0,
    note: '隧道锚（主缆外偏 2°，隧道从隧道锚中间穿过）' },
  { key: 'anchorS', label: '安龙岸重力锚', code: 'GA-S', x: ANCHOR.south.x, y: ANCHOR.south.y, z: 0,
    note: '重力锚（最大高度 70.85m，外侧设攀岩场地）' },
];

/** 真实参数摘要（用于 HUD 展示，避免把示意数据当成实测数据） */
export const FACT_SHEET = [
  ['桥型', '双塔单跨钢桁梁悬索桥'],
  ['主跨', '1420 m'],
  ['缆跨布置', '245 + 1420 + 495 m（主缆总跨 2160 m）'],
  ['主缆垂跨比', '1 / 10'],
  ['主缆中心距', '27 m（结构全宽 30.5 m）'],
  ['桥面宽度', '25.5 m · 双向 4 车道 · 设计速度 80 km/h'],
  ['桥面至水面', '625 m（世界第一高桥）'],
  ['加劲梁', '板桁结合钢桁梁 · 主桁高 8 m / 桁宽 27 m · 节段 15.4 m'],
  ['吊索', 'φ64 mm 钢丝绳（端吊索 φ68 mm）· 每吊点 2 根'],
  ['索鞍', '锻焊结合式主索鞍 / 散索鞍'],
  ['锚碇', '六枝岸隧道锚 · 安龙岸重力锚（高 70.85 m）'],
  ['抗风措施', '中央稳定板 + 上/下水平导流板（下导流板兼作空中竞速跑道）'],
  ['桥旅融合', '塔顶观星水吧 230 m² · 塔内观光电梯 · 桁梁内玻璃观光厅'],
];

/** 模型精度声明：哪些是公开实测参数，哪些是示意补全 */
export const FIDELITY_NOTE =
  '几何口径：主跨/缆跨/垂跨比/桁高桁宽/节段长度/桥面宽度/桥高为公开设计参数；' +
  '塔柱截面收坡、横梁道数、承台、锚碇体量、峡谷具体地形为按公开效果图与同类桥比例补全的示意模型，' +
  '不作为工程测量依据。';
