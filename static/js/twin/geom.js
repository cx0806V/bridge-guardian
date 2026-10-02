/* ============================================================================
 * 几何工具：二维/三维梁段、实例化合并、缆索曲线采样、确定性噪声
 * 说明：three.js 核心包不包含 BufferGeometryUtils，这里自实现最小可用的合并器，
 *      避免额外下载 examples/jsm 依赖（离线演示优先保证依赖面最小）。
 * ==========================================================================*/
import {
  BufferGeometry, BufferAttribute, Float32BufferAttribute,
  BoxGeometry, CylinderGeometry, SphereGeometry,
  Matrix3, Matrix4, Quaternion, Vector3, Euler, Color, Curve,
} from 'three';

const _up = new Vector3(0, 1, 0);
const _dir = new Vector3();
const _q = new Quaternion();
const _m = new Matrix4();
const _scale = new Vector3();

/** 沿任意方向的矩形截面梁段（杆件）矩阵 */
export function beamMatrix(ax, ay, az, bx, by, bz, thick) {
  _dir.set(bx - ax, by - ay, bz - az);
  const len = _dir.length() || 1e-6;
  _dir.divideScalar(len);
  _q.setFromUnitVectors(_up, _dir);
  _scale.set(thick, len, thick);
  return _m.compose(new Vector3(ax, ay, az), _q, _scale).clone();
}

/** 截面为 (tx, tz) 的矩形梁（可分别控制两个方向厚度） */
export function boxBeamMatrix(ax, ay, az, bx, by, bz, tx, tz) {
  _dir.set(bx - ax, by - ay, bz - az);
  const len = _dir.length() || 1e-6;
  _dir.divideScalar(len);
  _q.setFromUnitVectors(_up, _dir);
  _scale.set(tx, len, tz);
  return _m.compose(new Vector3(ax, ay, az), _q, _scale).clone();
}

/** 轴对齐盒体的矩阵（cx/cy/cz 为中心，sx/sy/sz 为尺寸） */
export function boxMatrix(cx, cy, cz, sx, sy, sz) {
  _q.identity();
  return _m.compose(new Vector3(cx, cy, cz), _q, _scale.set(sx, sy, sz)).clone();
}

/** 绕 z 轴旋转的盒体矩阵（用于横梁等有坡度的构件） */
export function boxMatrixRot(cx, cy, cz, sx, sy, sz, euler) {
  _q.setFromEuler(euler);
  return _m.compose(new Vector3(cx, cy, cz), _q, _scale.set(sx, sy, sz)).clone();
}

/** 圆柱/圆管沿任意方向的矩阵（单位高度圆柱，需给出 rpm 半径） */
export function tubeMatrix(ax, ay, az, bx, by, bz, radius) {
  _dir.set(bx - ax, by - ay, bz - az);
  const len = _dir.length() || 1e-6;
  _dir.divideScalar(len);
  _q.setFromUnitVectors(_up, _dir);
  return _m.compose(new Vector3(ax, ay, az), _q, _scale.set(radius, len, radius)).clone();
}

/** 把若干矩阵合并进一个 BufferGeometry（仅合并 position/normal/uv，足够本项目使用） */
export function mergeMatrices(baseGeometry, matrices) {
  const src = baseGeometry.index ? baseGeometry.toNonIndexed() : baseGeometry;
  const pos = src.getAttribute('position');
  const nor = src.getAttribute('normal');
  const uv = src.getAttribute('uv');
  const per = pos.count;
  const total = per * matrices.length;

  const P = new Float32Array(total * 3);
  const N = nor ? new Float32Array(total * 3) : null;
  const U = uv ? new Float32Array(total * 2) : null;
  const m3 = new Matrix3();
  const nm = new Matrix3();
  const v = new Vector3();

  for (let i = 0; i < matrices.length; i++) {
    const m = matrices[i];
    // three r160 的 Matrix4 没有 getNormalMatrix()：取左上 3×3 到 Matrix3，
    // 再用静态 Matrix3.getNormalMatrix() 求逆转置（项目矩阵只有旋转+正缩放，等价于旋转法线）
    m3.setFromMatrix4(m);
    nm.getNormalMatrix(m3);   // Matrix3 实例方法：写入 m3 的逆转置
    for (let j = 0; j < per; j++) {
      const o = (i * per + j);
      v.set(pos.getX(j), pos.getY(j), pos.getZ(j)).applyMatrix4(m);
      P[o * 3] = v.x; P[o * 3 + 1] = v.y; P[o * 3 + 2] = v.z;
      if (N) {
        v.set(nor.getX(j), nor.getY(j), nor.getZ(j)).applyMatrix3(nm).normalize();
        N[o * 3] = v.x; N[o * 3 + 1] = v.y; N[o * 3 + 2] = v.z;
      }
      if (U) { U[o * 2] = uv.getX(j); U[o * 2 + 1] = uv.getY(j); }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(P, 3));
  if (N) g.setAttribute('normal', new Float32BufferAttribute(N, 3));
  if (U) g.setAttribute('uv', new Float32BufferAttribute(U, 2));
  g.computeBoundingSphere();
  return g;
}

/** 单位盒（中心在原点，1×1×1）——所有杆件共用同一 base 几何 */
export const UNIT_BOX = new BoxGeometry(1, 1, 1);
/** 单位圆柱（中心在原点，高 1，半径 1，径向 10 段） */
export const UNIT_CYL = new CylinderGeometry(1, 1, 1, 10, 1, false);
/** 低面数球（索夹、节点球） */
export const UNIT_SPHERE = new SphereGeometry(1, 12, 8);

/* --------------------------------------------------------------------------
 * 几何工厂：把「矩阵」直接变成可交给 Mesh 的 BufferGeometry
 * 命名约定（避免与上面的 *Matrix 混淆）：
 *   boxAt(...)  → 轴对齐盒几何      boxMatrix(...)  → 轴对齐盒矩阵
 *   beamAt(...) → 任意方向梁几何    boxBeamMatrix(...) → 任意方向梁矩阵
 * 说明：这些工厂每次调用都新建几何体，只用于“唯一构件”（桥面板、锚碇体等）；
 *      大量重复构件一律走 InstancedMesh + *Matrix，避免几何体爆炸。
 * ------------------------------------------------------------------------*/
const _tmpMatrix = new Matrix4();

/** 轴对齐盒几何（cx/cy/cz 为中心，sx/sy/sz 为尺寸） */
export function boxAt(cx, cy, cz, sx, sy, sz) {
  const g = UNIT_BOX.clone();
  g.applyMatrix4(_tmpMatrix.compose(new Vector3(cx, cy, cz), new Quaternion(), new Vector3(sx, sy, sz)));
  return g;
}

/** 任意方向矩形截面梁几何 */
export function beamAt(ax, ay, az, bx, by, bz, tx, tz) {
  const g = UNIT_BOX.clone();
  g.applyMatrix4(boxBeamMatrix(ax, ay, az, bx, by, bz, tx, tz));
  return g;
}

/** 沿任意方向的圆柱几何（ax..bz 两端点，radius 半径） */
export function tubeAt(ax, ay, az, bx, by, bz, radius) {
  const g = UNIT_CYL.clone();
  g.applyMatrix4(tubeMatrix(ax, ay, az, bx, by, bz, radius));
  return g;
}

/** 抛物线主缆曲线：给定两端点与垂度，返回按参数 t 取点的采样器 */
export class Catenary {
  /**
   * @param {number[]} a 起点 [x,y,z]
   * @param {number[]} b 终点 [x,y,z]
   * @param {number} sag 垂度（跨中相对两端连线的下沉量，单位 m）
   * @param {number} samples 采样点数
   */
  constructor(a, b, sag, samples = 96) {
    this.a = a; this.b = b; this.sag = sag;
    this.samples = samples;
    this.points = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      this.points.push(this.at(t));
    }
  }
  at(t) {
    const { a, b, sag } = this;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t);
    const z = a[2] + (b[2] - a[2]) * t;
    return [x, y, z];
  }
  /** 世界坐标 x 位置处的高程（用于吊索下料长度） */
  yAtX(x) {
    const { a, b, sag } = this;
    const t = (x - a[0]) / (b[0] - a[0]);
    return this.at(Math.max(0, Math.min(1, t)))[1];
  }
  /** 弧长（数值积分） */
  length() {
    let L = 0;
    for (let i = 1; i < this.points.length; i++) {
      const p = this.points[i - 1], q = this.points[i];
      L += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    }
    return L;
  }
}

/** 确定性伪随机（同一 seed 每次刷新结果一致，避免画面抖动） */
export function makeRandom(seed) {
  let s = seed >>> 0 || 1;
  return function rand() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** 二维值噪声（确定性、无需贴图，用于峡谷岩层与细节起伏） */
export function makeNoise2D(seed) {
  const rand = makeRandom(seed);
  const size = 256;
  const perm = new Uint8Array(size);
  for (let i = 0; i < size; i++) perm[i] = i;
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  const grad = new Float32Array(size * 2);
  for (let i = 0; i < size; i++) {
    const a = rand() * Math.PI * 2;
    grad[i * 2] = Math.cos(a); grad[i * 2 + 1] = Math.sin(a);
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const hash = (i, j) => perm[(perm[i & 255] + (j & 255)) & 255];
  function dot(ix, iy, x, y) {
    const g = hash(ix, iy) * 2;
    return grad[g] * (x - ix) + grad[g + 1] * (y - iy);
  }
  return function noise(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = fade(x - x0), fy = fade(y - y0);
    const n00 = dot(x0, y0, x, y);
    const n10 = dot(x0 + 1, y0, x, y);
    const n01 = dot(x0, y0 + 1, x, y);
    const n11 = dot(x0 + 1, y0 + 1, x, y);
    const nx0 = n00 + (n10 - n00) * fx;
    const nx1 = n01 + (n11 - n01) * fx;
    return nx0 + (nx1 - nx0) * fy;
  };
}

/** 分形噪声（多层叠加，用于岩层纹理） */
export function fbm(noise, x, y, octaves = 4, lac = 2.03, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= gain; freq *= lac;
  }
  return sum / (norm || 1);
}

export function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 颜色工具：hex → THREE.Color（带缓存，避免每帧新建对象） */
const colorCache = new Map();
export function col(hex) {
  let c = colorCache.get(hex);
  if (!c) { c = new Color(hex); colorCache.set(hex, c); }
  return c;
}

export { Euler, Vector3, Matrix4, Quaternion, BoxGeometry, CylinderGeometry, SphereGeometry };
