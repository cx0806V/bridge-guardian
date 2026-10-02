/* ============================================================================
 * 构件线 Extract：把「单位盒 + 变换矩阵」形式的杆件批量转成线框线段
 * ----------------------------------------------------------------------------
 * 用途：HUD 的「结构线框」模式。three.js 的 EdgesGeometry 只处理单个几何体，
 * 对 InstancedMesh 会把所有实例的边都画在原点，看起来是一团乱线；这里的做法是按
 * 每根杆件自身的变换矩阵，把它 12 条棱（单位盒 → 实际尺寸）逐条算成世界坐标线段。
 * 代价：1 根杆件 12 段 × 2 端点，本项目约 2900 根杆件 → 约 7 万个顶点，可接受。
 * ==========================================================================*/
import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';

/** 单位盒（中心在原点，1×1×1）的 8 个角点 */
const CORNERS = [
  [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
];
/** 12 条棱（角点索引对） */
const EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * 由杆件矩阵集合生成线框几何。
 * @param {Array} matrices 每个元素为 THREE.Matrix4（与 InstancedMesh 用的是同一批）
 * @returns {BufferGeometry} 仅含 position 的线段几何（配合 LineSegments 使用）
 */
export function memberEdges(matrices) {
  const n = matrices.length;
  const positions = new Float32Array(n * EDGES.length * 2 * 3);
  const v = new Vector3();
  let p = 0;
  for (let i = 0; i < n; i++) {
    const m = matrices[i];
    // 8 个角点变换到世界坐标
    const wc = [];
    for (let c = 0; c < 8; c++) {
      const k = CORNERS[c];
      v.set(k[0], k[1], k[2]).applyMatrix4(m);
      wc.push(v.x, v.y, v.z);
    }
    for (let e = 0; e < EDGES.length; e++) {
      const a = EDGES[e][0], b = EDGES[e][1];
      positions[p++] = wc[a * 3]; positions[p++] = wc[a * 3 + 1]; positions[p++] = wc[a * 3 + 2];
      positions[p++] = wc[b * 3]; positions[p++] = wc[b * 3 + 1]; positions[p++] = wc[b * 3 + 2];
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.computeBoundingSphere();
  return g;
}
