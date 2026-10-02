/* ============================================================================
 * 花江峡谷大桥 3D 精细模型（three.js 程序化建模，无外部模型文件）
 * ----------------------------------------------------------------------------
 * 结构层次（全部由 spec.js 的公开设计参数驱动，可逐项核对）：
 *   ① 主梁：板桁结合钢桁梁 —— 带竖腹杆的华伦式（Warren）主桁，桁高 8m / 桁宽 27m
 *      / 标准节段 15.4m；含横梁、下平联、正交异性桥面板、行车道（25.5m，双向 4
 *      车道）、检修道、护栏；桥旅融合设施：桁内观光廊道 + 玻璃观光厅、下水平导流
 *      板（兼空中竞速跑道）、上水平导流板、中央稳定板
 *   ② 主缆：1420m 主跨（垂跨比 1/10，跨中低于桥面 28m）+ 245m / 495m 边跨背索；
 *      吊索按吊点布置（每吊点 2 根，φ64mm，骑跨式索夹，主跨间距 15.4m）
 *   ③ 桥塔：“门”形塔 + 层叠横梁；塔顶主索鞍（锻焊结合式）、塔顶观星水吧、
 *      塔内观光电梯、承台与桩基
 *   ④ 锚碇：六枝岸隧道锚 / 安龙岸重力锚（最大高度 70.85m）
 *   ⑤ 监测热点：跨中测点、四分点、塔顶、主缆跨中、两处锚碇（可点选 / 双击聚焦）
 *
 * 精度声明：见 spec.js 的 FIDELITY_NOTE —— 主跨、缆跨、垂跨比、桁高桁宽、节段
 * 长度、桥面宽度、桥高为公开设计参数；塔柱收坡率、横梁道数、承台与锚碇体量、峡谷
 * 地形为按公开效果图与同类桥比例的示意补全，不作为工程测量依据。
 * ==========================================================================*/
import {
  Group, Mesh, InstancedMesh, Matrix4, Vector3, Quaternion, Color,
  CylinderGeometry, SphereGeometry, RingGeometry, TubeGeometry, CatmullRomCurve3,
  MeshBasicMaterial, DynamicDrawUsage,
} from 'three';
import {
  boxBeamMatrix, boxMatrix, boxAt, mergeMatrices, UNIT_BOX, Catenary, col,
} from './geom.js';
import { SPAN, X, Y, Z, GIRDER, CABLE, TOWER, ANCHOR, HOTSPOTS } from './spec.js';
import { groundAt } from './canyon.js';

const HANGER_GEO = (() => {
  const g = new CylinderGeometry(1, 1, 1, 6, 1, false);
  g.translate(0, 0.5, 0);          // 原点移到底端：便于按吊索长度在 y 方向缩放
  return g;
})();

/**
 * 构建整桥模型。
 * @param {object} THREE three.js 命名空间
 * @param {object} m createMaterials() 的返回值
 */
export function buildBridge(THREE, m) {
  const mats = m.mats;
  const root = new Group();
  root.name = 'huajiang-bridge';

  /**
   * 构造 Mesh 的统一入口：显式拦截「把 Matrix4 当几何体」这类错误。
   * 教训：three.js 的 Mesh 对非几何体不会立刻报错（updateMorphTargets 里才炸），
   * 报错信息完全看不出真正原因，所以这里提前校验并给出可诊断的信息。
   */
  function mesh(geometry, material, name) {
    if (!geometry || geometry.isBufferGeometry !== true) {
      const got = geometry ? (geometry.constructor ? geometry.constructor.name : typeof geometry) : String(geometry);
      throw new TypeError('buildBridge: ' + (name || 'mesh') + ' 需要 BufferGeometry，实际收到 ' + got +
        '（提示：*Matrix 系列返回矩阵，请改用 boxAt/beamAt/tubeAt 或 mergeMatrices）');
    }
    const mm = new Mesh(geometry, material);
    if (name) mm.name = name;
    return mm;
  }

  const groups = {};
  ['truss', 'deck', 'cable', 'tower', 'anchor', 'hotspot'].forEach((k) => {
    groups[k] = new Group(); groups[k].name = k; root.add(groups[k]);
  });

  // ---------- 缆索曲线（同时用于几何与标注） ----------
  const cableMain = new Catenary([X.northTower, Y.saddle, 0], [X.southTower, Y.saddle, 0], CABLE.sag, 140);
  const backstayN = new Catenary([X.northAnchor, ANCHOR.north.y, 0], [X.northTower, Y.saddle, 0], 3.5, 26);
  const backstayS = new Catenary([X.southTower, Y.saddle, 0], [X.southAnchor, ANCHOR.south.y, 0], 3.5, 26);

  /* ======================================================================
   * ① 钢桁梁：节点 → 杆件
   * ====================================================================*/
  const DECK_X0 = X.northAnchor;      // -955（六枝岸，隧道锚）
  const DECK_X1 = X.southAnchor;      // +1205（安龙岸，重力锚）
  const SPANS = [
    { x0: DECK_X0, x1: X.northTower, panels: 16 },
    { x0: X.northTower, x1: X.southTower, panels: GIRDER.panelsPerSpan },
    { x0: X.southTower, x1: DECK_X1, panels: 32 },
  ];
  const NODES = [];
  SPANS.forEach((sp) => {
    const dx = (sp.x1 - sp.x0) / sp.panels;
    for (let i = 0; i < sp.panels; i++) NODES.push(sp.x0 + i * dx);
  });
  NODES.push(DECK_X1);

  const ZT = Z.half, ZB = Y.trussBottom, CH = GIRDER.chord, DG = GIRDER.diagonal;
  /** 水平杆件（上/下弦、横梁、平联）——截面两向可分别指定 */
  const hBeam = (ax, ay, az, bx, by, bz, tx, tz) => boxBeamMatrix(ax, ay, az, bx, by, bz, tx, tz);

  const chordM = [], vertM = [], diagM = [], floorM = [], braceM = [];
  for (let i = 0; i < NODES.length - 1; i++) {
    const a = NODES[i], b = NODES[i + 1];
    for (const zz of [ZT, -ZT]) {
      chordM.push(hBeam(a, Y.deck - CH / 2, zz, b, Y.deck - CH / 2, zz, CH * 0.95, CH));  // 上弦
      chordM.push(hBeam(a, ZB + CH / 2, zz, b, ZB + CH / 2, zz, CH * 1.05, CH));          // 下弦
      if (i % 2 === 0) diagM.push(hBeam(a, ZB + CH, zz, b, Y.deck - CH, zz, DG, DG));     // 华伦式斜腹杆
      else diagM.push(hBeam(a, Y.deck - CH, zz, b, ZB + CH, zz, DG, DG));
    }
    const y = ZB + CH * 0.5;
    braceM.push(hBeam(a, y, -ZT, b, y, ZT, 0.38, 0.38));   // 下平联（交叉）
    braceM.push(hBeam(a, y, ZT, b, y, -ZT, 0.38, 0.38));
  }
  NODES.forEach((x) => {
    for (const zz of [ZT, -ZT]) vertM.push(hBeam(x, ZB + CH, zz, x, Y.deck - CH, zz, DG, DG));  // 竖腹杆
    floorM.push(hBeam(x, ZB + CH * 0.6, -ZT, x, ZB + CH * 0.6, ZT, GIRDER.floorBeam * 0.7, GIRDER.floorBeam)); // 横梁
  });

  function addInstanced(geometry, material, matrices, name) {
    const im = new InstancedMesh(geometry, material, matrices.length);
    for (let i = 0; i < matrices.length; i++) im.setMatrixAt(i, matrices[i]);
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = true;   // 启用视锥剔除：整桥 1900+ 实例，剔除可显著降低每帧绘制量
    im.name = name;
    im.userData.matrices = matrices;   // 供“结构线框”模式按真实位置画构件边线
    groups.truss.add(im);
    return im;
  }
  addInstanced(UNIT_BOX, mats.steel, chordM, 'truss-chord');
  addInstanced(UNIT_BOX, mats.steel, vertM, 'truss-vertical');
  addInstanced(UNIT_BOX, mats.steel, diagM, 'truss-diagonal');
  addInstanced(UNIT_BOX, mats.steel, floorM, 'truss-floorbeam');
  addInstanced(UNIT_BOX, mats.steel, braceM, 'truss-lateral');

  // 桁架描边（数字孪生青蓝骨架）：上下弦各一条贯通薄壳
  const edgeM = [];
  for (const zz of [ZT, -ZT]) {
    edgeM.push(boxMatrix((NODES[0] + NODES[NODES.length - 1]) / 2, Y.deck - CH * 0.5, zz,
      NODES[NODES.length - 1] - NODES[0], CH * 0.34, CH * 1.2));
    edgeM.push(boxMatrix((NODES[0] + NODES[NODES.length - 1]) / 2, ZB + CH * 0.5, zz,
      NODES[NODES.length - 1] - NODES[0], CH * 0.34, CH * 1.2));
  }
  groups.truss.add(mesh(mergeMatrices(UNIT_BOX, edgeM), mats.edge));

  /* ======================================================================
   * ② 桥面系与桥旅融合设施
   * ====================================================================*/
  const deckLen = DECK_X1 - DECK_X0;
  const deckMid = (DECK_X0 + DECK_X1) / 2;
  const addDeck = (geo, mat, name) => {
    const mm = mesh(geo, mat, name); groups.deck.add(mm); return mm;
  };

  addDeck(boxAt(deckMid, Y.deck - GIRDER.deckSlab / 2, 0, deckLen, GIRDER.deckSlab, Z.deckHalf * 2),
    mats.deckPlate, 'deck-slab');                                    // 结构全宽 30.5m
  addDeck(boxAt(deckMid, Y.deck + 0.006, 0, deckLen, 0.02, Z.roadwayHalf * 2),
    mats.road, 'deck-road');                                         // 行车道 25.5m
  addDeck(boxAt(deckMid, Y.deck + 0.03, Z.roadwayHalf - 0.35, deckLen, 0.02, 0.3),
    mats.laneGlow, 'deck-edge-pos');
  addDeck(boxAt(deckMid, Y.deck + 0.03, -Z.roadwayHalf + 0.35, deckLen, 0.02, 0.3),
    mats.laneGlow, 'deck-edge-neg');

  // 车道标线（4 车道 → 3 条分道线 + 两侧边线）
  const markM = [];
  [-Z.roadwayHalf / 2, 0, Z.roadwayHalf / 2].forEach((zz) => {
    for (let x = DECK_X0 + 8; x < DECK_X1 - 8; x += 30) markM.push(boxMatrix(x, Y.deck + 0.03, zz, 9, 0.02, 0.22));
  });
  groups.deck.add(mesh(mergeMatrices(UNIT_BOX, markM), mats.laneMark));

  // 检修道（两侧）
  const walkM = [];
  [Z.walkwayHalf, -Z.walkwayHalf].forEach((zz) => walkM.push(boxMatrix(deckMid, Y.deck + 0.08, zz, deckLen, 0.16, 1.7)));
  groups.deck.add(mesh(mergeMatrices(UNIT_BOX, walkM), mats.deckPlate));

  // 护栏：立柱 + 三道横杆
  const postM = [], railM = [];
  [Z.deckHalf - 0.25, -(Z.deckHalf - 0.25)].forEach((zz) => {
    for (let x = DECK_X0 + 2; x <= DECK_X1 - 2; x += GIRDER.panel / 2) {
      postM.push(boxMatrix(x, Y.deck + GIRDER.railH / 2, zz, 0.16, GIRDER.railH, 0.16));
    }
    [0.45, 0.8, GIRDER.railH].forEach((h) => railM.push(boxMatrix(deckMid, Y.deck + h, zz, deckLen, 0.09, 0.09)));
  });
  groups.deck.add(mesh(mergeMatrices(UNIT_BOX, postM), mats.steel));
  groups.deck.add(mesh(mergeMatrices(UNIT_BOX, railM), mats.railGlow));

  // 抗风措施：中央稳定板 + 上/下水平导流板（下导流板兼空中竞速跑道）
  addDeck(boxAt(deckMid, ZB / 2, 0, deckLen, -ZB * 0.86, 0.5), mats.edge, 'center-stabilizer');
  addDeck(boxAt(deckMid, ZB - 0.3, 0, deckLen, 0.35, 9.0), mats.deckPlate, 'guide-plate-lower');
  addDeck(boxAt(deckMid, Y.deck - 0.95, 0, deckLen, 0.3, 21.0), mats.deckPlate, 'guide-plate-upper');
  addDeck(boxAt(deckMid, ZB - 0.52, 0, deckLen, 0.06, 0.6), mats.laneGlow, 'racing-lane');

  // 桁内观光廊道 + 玻璃观光厅
  const tourM = [];
  [ZT - 1.6, -(ZT - 1.6)].forEach((zz) => tourM.push(boxMatrix(deckMid, ZB + 1.2, zz, deckLen, 0.2, 2.6)));
  groups.deck.add(mesh(mergeMatrices(UNIT_BOX, tourM), mats.deckPlate));
  const observatory = addDeck(boxAt(X.midSpan, ZB + 2.6, 0, 34, 3.6, 19), mats.glass, 'glass-observatory');
  groups.deck.add(mesh(boxAt(X.midSpan, ZB + 4.5, 0, 35, 0.3, 20), mats.glassEdge));

  /* ======================================================================
   * ③ 主缆 / 背索 / 吊索 / 索夹
   * ====================================================================*/
  const cableMeshes = [];
  function addCable(cat, zz, radius, name) {
    const pts = [];
    for (let i = 0; i <= cat.samples; i++) {
      const p = cat.at(i / cat.samples);
      pts.push(new Vector3(p[0], p[1], zz));
    }
    const curve = new CatmullRomCurve3(pts);
    const tube = mesh(new TubeGeometry(curve, cat.samples, radius, 10, false), mats.cable);
    tube.name = name;
    groups.cable.add(tube);
    // 受力流光：同路径细发光管（数字孪生“能量流动”暗示）
    const flow = mesh(new TubeGeometry(curve, Math.max(28, Math.round(cat.samples / 2)), radius * 0.5, 8, false), mats.cableFlow);
    flow.name = name + '-flow';
    groups.cable.add(flow);
    cableMeshes.push({ tube, flow, curve, cat });
  }
  [Z.half, -Z.half].forEach((zz) => {
    addCable(cableMain, zz, CABLE.radius, 'main-cable');
    addCable(backstayN, zz, CABLE.radius * 0.94, 'backstay-north');
    addCable(backstayS, zz, CABLE.radius * 0.94, 'backstay-south');
  });

  /** 索夹（骑跨式，一只夹持两根吊索） */
  const clampM = [];
  const hangers = { pos: [], neg: [] };

  /**
   * 布置吊索：沿给定区段按吊点间距生成，每一吊点 2 根（z=±13.5）。
   * @param {number} x0,x1 区段
   * @param {number} nPanels 节段数
   * @param {(x:number)=>number} cableY 该处主缆高程
   */
  function layoutHangers(x0, x1, nPanels, cableY) {
    const dx = (x1 - x0) / nPanels;
    for (let i = 1; i < nPanels; i++) {
      const x = x0 + i * dx;
      const yTop = cableY(x);
      const yBot = Y.deck - 0.45;
      const len = yTop - yBot;
      if (len < 3) continue;                       // 主缆已接近桥面处不设吊索
      [Z.half, -Z.half].forEach((zz) => {
        (zz > 0 ? hangers.pos : hangers.neg).push({ x, z: zz, yTop, yBot, len });
      });
      [Z.half, -Z.half].forEach((zz) => {
        clampM.push(boxMatrix(x, yTop - CABLE.clampH * 0.15, zz, CABLE.clampH, CABLE.clampH, CABLE.clampR * 2));
      });
    }
  }
  layoutHangers(X.northTower, X.southTower, GIRDER.panelsPerSpan, (x) => cableMain.yAtX(x));
  layoutHangers(DECK_X0, X.northTower, 16, (x) => backstayN.yAtX(x));
  layoutHangers(X.southTower, DECK_X1, 32, (x) => backstayS.yAtX(x));
  groups.cable.add(mesh(mergeMatrices(UNIT_BOX, clampM), mats.clamp));

  function makeHangers(list, name) {
    const im = new InstancedMesh(HANGER_GEO, mats.cable, Math.max(1, list.length));
    const mat = new Matrix4();
    const white = new Color(1, 1, 1);
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      mat.makeScale(CABLE.hangerRadius, h.len, CABLE.hangerRadius);
      mat.setPosition(h.x, h.yBot, h.z);
      im.setMatrixAt(i, mat);
      im.setColorAt(i, white);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) { im.instanceColor.setUsage(DynamicDrawUsage); im.instanceColor.needsUpdate = true; }
    im.frustumCulled = true;
    im.name = name;
    return im;
  }
  const hangerMeshes = {
    pos: makeHangers(hangers.pos, 'hangers-pos'),
    neg: makeHangers(hangers.neg, 'hangers-neg'),
  };
  groups.cable.add(hangerMeshes.pos, hangerMeshes.neg);

  /* ======================================================================
   * ④ 桥塔
   * ====================================================================*/
  const SB = TOWER.legSectionBase, ST = TOWER.legSectionTop;

  function buildTower(cfg) {
    const g = new Group(); g.name = 'tower-' + cfg.key;
    // 真实桥塔是两根塔柱（一根在主跨侧、一根在边跨侧），各自落在自己的基础上；
    // 由于主缆中心距 27m 远小于峡谷跨度，本项目把两根塔柱的基础分别布置在峡谷两岸的
    // 开挖平台上（spec.js 的 CANYON.benchZ），因此塔柱沿横桥向（z）落在 ±BENCH_Z。
    const BENCH_Z = TOWER.benchZ;
    const halfSpacing = 6;      // 塔柱截面半宽方向上的基础范围（示意）
    const ground = Math.min(
      groundAt(cfg.x, BENCH_Z - halfSpacing),
      groundAt(cfg.x, BENCH_Z + halfSpacing),
      groundAt(cfg.x, -(BENCH_Z - halfSpacing)),
      groundAt(cfg.x, -(BENCH_Z + halfSpacing)));
    const legBase = Math.round(Math.min(cfg.legBase, ground - 6));
    const legTop = cfg.legTop;
    const SEG = 30;

    // 塔柱：分 30 段折线逼近收坡，形成连续锥面
    const legM = [];
    for (const side of [1, -1]) {
      for (let i = 0; i < SEG; i++) {
        const t0 = i / SEG, t1 = (i + 1) / SEG;
        const y0 = legBase + (legTop - legBase) * t0;
        const y1 = legBase + (legTop - legBase) * t1;
        const s0 = SB.x + (ST.x - SB.x) * t0, d0 = SB.z + (ST.z - SB.z) * t0;
        const s1 = SB.x + (ST.x - SB.x) * t1, d1 = SB.z + (ST.z - SB.z) * t1;
        // 塔柱沿 z 方向收坡：基础侧稍向内（±BENCH_Z → 塔顶略收）
        const z0 = side * (BENCH_Z - t0 * 4);
        const z1 = side * (BENCH_Z - t1 * 4);
        legM.push(segMatrix(y0, y1, z0, z1, (s0 + s1) / 2, (d0 + d1) / 2));
      }
    }
    function segMatrix(y0, y1, z0, z1, sx, sz) {
      const dy = y1 - y0, dz = z1 - z0;
      const len = Math.hypot(dy, dz) || 1;
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(0, dy / len, dz / len));
      return new Matrix4().compose(new Vector3(cfg.x, (y0 + y1) / 2, (z0 + z1) / 2), q, new Vector3(sx, len, sz));
    }
    const legs = new InstancedMesh(UNIT_BOX, mats.concrete, legM.length);
    legM.forEach((mm, i) => legs.setMatrixAt(i, mm));
    legs.instanceMatrix.needsUpdate = true;
    legs.frustumCulled = true;
    legs.name = 'tower-legs';
    g.add(legs);

    // 塔柱四角竖线（数字孪生描边）
    const cornerM = [];
    for (const side of [1, -1]) {
      for (const ox of [0.5, -0.5]) {
        cornerM.push(boxBeamMatrix(
          cfg.x + ox * SB.x * 0.98, legBase + 1, side * (BENCH_Z - SB.z * 0.42),
          cfg.x + ox * ST.x * 0.98, legTop - 1, side * (BENCH_Z - 4 + ST.z * 0.42), 0.55, 0.55));
      }
    }
    g.add(mesh(mergeMatrices(UNIT_BOX, cornerM), mats.concreteEdge));

    // 层叠横梁（“山峦重叠入云端”的造型语言）：
    // 与真实桥塔一致，横梁连接两根塔柱；下横梁刻意避开桥面桁梁的通行净空。
    const beamYs = cfg.skyBar ? [-19, 46, 104, 146] : [-19, 40, 92, 132];
    const cbM = [];
    beamYs.forEach((y, i) => {
      const t = (y - legBase) / (legTop - legBase);
      const zz = BENCH_Z - t * 4;
      const sx = SB.x * 0.55;
      const h = i === 0 ? TOWER.crossBeamD * 1.3 : TOWER.crossBeamD;
      cbM.push(boxMatrix(cfg.x, y, 0, sx, h, zz * 2 + SB.z * 0.5));
      if (i > 0) cbM.push(boxMatrix(cfg.x, y - h * 0.72, 0, sx * 1.12, h * 0.45, zz * 2 + SB.z * 0.2));
    });
    g.add(mesh(mergeMatrices(UNIT_BOX, cbM), mats.concrete));

    // 塔顶主索鞍（锻焊结合式）+ 鞍座
    const saddleM = [];
    for (const side of [1, -1]) {
      const zz = side * Z.half;
      saddleM.push(boxMatrix(cfg.x, Y.saddle - 4.6, zz, 5.6, 6.6, 2.8));   // 鞍体
      saddleM.push(boxMatrix(cfg.x, Y.saddle + 0.55, zz, 6.4, 1.1, 3.4));  // 盖板
    }
    g.add(mesh(mergeMatrices(UNIT_BOX, saddleM), mats.clamp));
    g.add(mesh(boxAt(cfg.x, Y.saddle - 1.2, 0, 4.4, 2.6, Z.half * 2 + 5.0), mats.concrete));

    // 塔顶观星水吧（两层，总面积 230m²）+ 观光电梯
    if (cfg.skyBar) {
      const bar = mesh(boxAt(cfg.x, Y.saddle + 5.6, 0, 14.5, 5.8, 16.2), mats.glass);
      bar.name = 'sky-bar';
      g.add(bar);
      g.add(mesh(boxAt(cfg.x, Y.saddle + 8.7, 0, 15.6, 0.5, 17.4), mats.concrete));
      g.add(mesh(boxAt(cfg.x, Y.saddle + 2.4, 0, 15.3, 0.45, 17.1), mats.concrete));
      g.add(mesh(boxAt(cfg.x - 7.8, (legBase + Y.saddle) / 2, BENCH_Z - 2 + 5.4,
        4.4, Y.saddle - legBase, 4.4), mats.glass));
    }
    // 塔顶航空障碍灯 + 避雷针
    const beacon = mesh(new SphereGeometry(1.6, 8, 6), mats.beacon);
    beacon.position.set(cfg.x, Y.saddle + 10.2, 0);
    beacon.name = 'beacon';
    g.add(beacon);
    g.add(mesh(boxAt(cfg.x, Y.saddle + 13.4, 0, 0.5, 6.4, 0.5), mats.clamp));

    // 承台 + 桩基群（落在峡谷两岸的开挖平台 BENCH_Z 上，桩基插入岩体）
    const foundM = [];
    for (const side of [1, -1]) {
      const zz = side * BENCH_Z;
      foundM.push(boxMatrix(cfg.x, legBase - 3.6, zz, SB.x + 5.0, 7.2, SB.z + 4.3));
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          if (i === 0 && j === 0) continue;
          foundM.push(boxMatrix(cfg.x + i * 4.3, legBase - 3.6 - 9, zz + j * 3.7, 2.2, 18, 2.2));
        }
      }
    }
    g.add(mesh(mergeMatrices(UNIT_BOX, foundM), mats.concrete));
    return { group: g, legBase, legTop, ground };
  }
  const towerN = buildTower(TOWER.north);
  const towerS = buildTower(TOWER.south);
  groups.tower.add(towerN.group);
  groups.tower.add(towerS.group);

  /* ======================================================================
   * ⑤ 锚碇
   * ====================================================================*/
  function buildAnchor(cfg) {
    const g = new Group(); g.name = 'anchor-' + cfg.key;
    const bodyM = [];
    if (cfg.type === 'tunnel') {
      // 隧道锚：洞门 + 锚塞体（示意）
      bodyM.push(boxMatrix(cfg.x, cfg.y + 14, 0, 26, 38, 34));
      bodyM.push(boxMatrix(cfg.x - 24, cfg.y + 6, 0, 36, 24, 26));
    } else {
      // 重力锚：最大高度 70.85m（公开参数）
      bodyM.push(boxMatrix(cfg.x, cfg.y + cfg.height / 2, 0, 62, cfg.height, 52));
      bodyM.push(boxMatrix(cfg.x + 18, cfg.y + cfg.height * 0.34, 0, 44, cfg.height * 0.68, 46));
    }
    g.add(mesh(mergeMatrices(UNIT_BOX, bodyM), mats.concrete));
    // 散索鞍（主缆散开锚固）
    const spreadM = [];
    [1, -1].forEach((side) => spreadM.push(boxMatrix(cfg.x + 6, cfg.y + 26, side * 7.0, 8.0, 8.0, 7.2)));
    g.add(mesh(mergeMatrices(UNIT_BOX, spreadM), mats.clamp));
    return g;
  }
  groups.anchor.add(buildAnchor(ANCHOR.north));
  groups.anchor.add(buildAnchor(ANCHOR.south));

  /* ======================================================================
   * ⑥ 监测热点（可点选 / 双击聚焦）
   * ====================================================================*/
  const hotspots = [];
  const hitMaterial = new MeshBasicMaterial({ visible: false });
  HOTSPOTS.forEach((h) => {
    const g = new Group();
    g.name = 'hotspot-' + h.key;
    g.position.set(h.x, h.y, h.z);
    g.userData.hotspot = h;

    const rings = [];
    for (let i = 0; i < 3; i++) {
      const ring = mesh(new RingGeometry(1, 1.18, 40), mats.sensorHalo.clone());
      ring.userData.phase = i / 3;
      rings.push(ring);
      g.add(ring);
    }
    const core = mesh(new SphereGeometry(1, 12, 10), mats.sensor);
    g.add(core);
    const stem = mesh(new CylinderGeometry(0.14, 0.14, 1, 6), mats.sensor);
    stem.position.y = 0.5;
    g.add(stem);

    const hit = mesh(new SphereGeometry(1, 8, 6), hitMaterial);
    hit.userData.hotspot = h;
    hit.userData.group = g;
    hit.scale.setScalar(3.2);
    g.add(hit);
    hotspots.push(hit);

    g.userData.rings = rings;
    g.userData.core = core;
    g.userData.stem = stem;
    groups.hotspot.add(g);
  });

  /* ======================================================================
   * 统计信息（全部来自上面真实构建的几何，供 HUD 展示）
   * ====================================================================*/
  const allHangers = hangers.pos.concat(hangers.neg);
  const stats = {
    mainSpan: SPAN.main,
    cableSpan: SPAN.total,
    deckLength: Math.round(deckLen),
    panels: NODES.length - 1,
    mainPanels: GIRDER.panelsPerSpan,
    trussMembers: chordM.length + vertM.length + diagM.length + floorM.length + braceM.length,
    hangerCount: allHangers.length,
    hangerMin: allHangers.length ? Math.min.apply(null, allHangers.map((h) => h.len)) : 0,
    hangerMax: allHangers.length ? Math.max.apply(null, allHangers.map((h) => h.len)) : 0,
    cableLength: cableMain.length() + backstayN.length() + backstayS.length(),
    towerN: Math.round(towerN.legTop - towerN.legBase),
    towerS: Math.round(towerS.legTop - towerS.legBase),
    towerGroundN: Math.round(towerN.ground),
    towerGroundS: Math.round(towerS.ground),
    bridgeHeight: 625,
    deckX0: DECK_X0,
    deckX1: DECK_X1,
    saddleY: Y.saddle,
    cableMidY: Y.cableMid,
  };

  /* ======================================================================
   * 风险联动：吊索按位置着色 —— **增量更新**（P2 契约 §3.4）
   * --------------------------------------------------------------------
   * 改前的问题（Lead 实测基线）：scene.js 每 6 帧就整块重算 256 根吊索的颜色并
   * 无条件置 instanceColor.needsUpdate=true，于是 6s 里每个 mesh 上传了 25 次完整
   * 颜色缓冲（256×3 float），而这一秒内的颜色其实根本没变。
   *
   * 现在三道闸门（越往后越省）：
   *   ① scene.js 只在「风险等级变化 / 荷载跨过 5% 量化台阶 / 主题色变化」时调用；
   *   ② 本函数对每个实例**读回现有颜色**逐分量比较（阈值 1/255，肉眼不可分辨）；
   *   ③ 只有至少一个实例真的变色，才置 needsUpdate=true（= 一次 GPU 上传）。
   * 这样稳定工况下 instanceColor 上传次数为 0，风险切换时才上传一次。
   *
   * stats 口径（契约 v1.1 冻结）：
   *   calls            = 被调用的次数
   *   uploads          = 置过 needsUpdate 的次数（≈ GPU 上传次数）
   *   instancesTouched = 真正写入 setColorAt 的实例数
   *   instancesScanned = 逐个比较过的实例数（只读不写）
   *   lastKey          = 最近一次的「风险|荷载量化台阶」键，供测量脚本核对
   * ====================================================================*/
  const tmpColor = new Color();
  const riskStats = { calls: 0, uploads: 0, instancesTouched: 0, instancesScanned: 0, lastKey: '' };

  function applyRisk(risk, opts) {
    const loadRaw = (opts && typeof opts.load === 'number') ? opts.load : 0;
    const load = Math.max(0, Math.min(1, loadRaw));
    const step = Math.round(load * 20);                    // 5% 量化台阶
    riskStats.calls += 1;
    riskStats.lastKey = String(risk) + '|' + step;
    const base = col(m.PALETTE.accent.getHex());           // 主题色（随风险等级与浅/深主题变）
    let changedTotal = 0;
    const meshes = [hangerMeshes.pos, hangerMeshes.neg];
    for (let mi = 0; mi < meshes.length; mi++) {
      const im = meshes[mi];
      const attr = im.instanceColor;
      if (!attr) continue;                                 // 没有颜色缓冲（理论上不会）就跳过
      const arr = attr.array;
      const n = im.count;
      let dirty = false;
      for (let i = 0; i < n; i++) {
        // 越靠近跨中的吊索受力越大，颜色越亮（仅视觉表达，非实测内力）
        const s = 0.55 + 0.45 * Math.sin(Math.PI * (i / Math.max(1, n - 1)));
        tmpColor.copy(base).multiplyScalar(0.5 + 0.9 * s * (0.45 + 0.55 * load));
        riskStats.instancesScanned += 1;
        const o = i * 3;
        if (Math.abs(arr[o] - tmpColor.r) < 1 / 255 &&
            Math.abs(arr[o + 1] - tmpColor.g) < 1 / 255 &&
            Math.abs(arr[o + 2] - tmpColor.b) < 1 / 255) continue;   // 颜色没变：不写、不上传
        im.setColorAt(i, tmpColor);
        riskStats.instancesTouched += 1;
        changedTotal += 1;
        dirty = true;
      }
      if (dirty) { attr.needsUpdate = true; riskStats.uploads += 1; }
    }
    return changedTotal;
  }
  applyRisk.stats = riskStats;

  return {
    root, groups, stats, hotspots, observatory,
    hangerMeshes, cableMeshes,
    curves: { cableMain, backstayN, backstayS },
    applyRisk,
    nodes: NODES,
    /** 供“结构线框”模式使用的杆件矩阵（节点/杆件真实位置，非原点堆叠） */
    memberMatrices: {
      chord: chordM, vertical: vertM, diagonal: diagM, floor: floorM, lateral: braceM,
      // 吊索是竖直圆柱：底端在 yBot、高度 len，直接按轴对齐盒的等效矩阵给出
      hangers: hangers.pos.map((h) => boxMatrix(h.x, h.yBot + h.len / 2, h.z,
        CABLE.hangerRadius * 1.4, h.len, CABLE.hangerRadius * 1.4)),
    },
  };
}
