/* ============================================================================
 * 画质阶梯控制器（P2 契约 §3.2 + v1.2 澄清的 perf-core 实现）
 * ----------------------------------------------------------------------------
 * 职责：把「实测帧耗时」变成「画质档位」，并记住手动档位 / 目标帧率 / 刷新率。
 * 它自己不碰 three.js —— 只做判定与状态，具体动作（改像素比 / 重建 renderer /
 * 关雾气 / 降地形密度）由 scene.js 在 onChange 回调里执行。这样控制器可以
 * 脱离浏览器单独测试（见 .workbuddy/p2/perf-core/quality_unit.mjs）。
 *
 * 为什么这样设计（现场答辩要讲得出来）：
 *   ① 用最近 60 帧的**中位**帧耗时判定，不用瞬时值：一次 GC 或一次布局抖动就会
 *      让瞬时帧耗时翻两三倍；中位数对孤立尖峰免疫，判定才稳定。
 *   ② 降档快、升档慢（降档连续 2 个判定周期 ≈90 帧，升档要连续富余 8s）：
 *      降档是止损、升档是试探，慢升可以避免「升上去→卡→降回来」的振荡。
 *      这就是 1.35 / 0.62 两个系数离 1.0 都留出一段死区的意义（迟滞）。
 *   ③ 只有「按目标帧率满帧渲染」的帧才进降档窗口：空载时是我们自己把帧率压到
 *      min(30,target)，那时的帧耗时是**我们主动限帧**造成的，拿它判定会把一台
 *      正常设备误降档。空载帧单独用「空载预算」判一次（真正弱的机器空载也跟不上）。
 *   ④ 一次只降/升一档：相邻档位的代价差距很大（像素比 1.5→1.2、开→关 MSAA），
 *      跳档容易一次降过头，升档同理。
 *   ⑤ insufficient 的判据用「可用下限 fps」而不是「目标 fps」（v1.2 澄清）：
 *      需求书对办公机/集显的要求是「自适应降到能稳定 ≥40fps」，只有连 40fps
 *      （手机 30fps）都做不到才叫「性能不足」；40~60 之间要如实写「已到最低画质、
 *      达到了可用下限但没到目标」，不许静默、也不许把能用的机器判成不能用。
 * ==========================================================================*/

/** 档位顺序不可变：高 → 中 → 低 → 极低（契约 §3.2） */
export const TIERS = ['high', 'medium', 'low', 'ultraLow'];
export const TIER_LABELS = { high: '高', medium: '中', low: '低', ultraLow: '极低' };

/**
 * 四档代价从低到高：① 像素比 ② 抗锯齿（关它必须重建 renderer，因为 MSAA 是
 * 创建 WebGL context 时的属性）③ 雾气 + 主缆流光（半透明大面积 overdraw）
 * ④ 地形密度（33371 → 约 1/4 顶点）。
 * pixelRatio 这里是**桌面**上限；手机另有一套上限（MOBILE_PIXEL_RATIO_CAP）。
 */
export const TIER_PROFILE = {
  high:     { pixelRatio: 1.5, antialias: true,  mist: true,  cableFlow: true,  terrain: 'high' },
  medium:   { pixelRatio: 1.2, antialias: true,  mist: true,  cableFlow: true,  terrain: 'high' },
  low:      { pixelRatio: 1.0, antialias: false, mist: false, cableFlow: false, terrain: 'high' },
  ultraLow: { pixelRatio: 1.0, antialias: false, mist: false, cableFlow: false, terrain: 'low'  },
};

/**
 * 手机（含 iOS Safari）的像素比上限（契约 v1.2 澄清 1 最终值，需求书原文「屏幕像素比
 * 上限 2.0 且画质默认中档」）：
 *   · 手机上永不超过 2.0；默认档 medium=1.4 —— **等于 P1 旧实现 min(dpr,1.4)**，
 *     所以默认档零回退（不因为换档位反而多花像素/掉帧），想要更清晰由用户手动选「高」(2.0)。
 *   · 第一档降档仍有实际效果：1.4→1.2；极低档 1.0。
 *   · 有效像素比 = min(devicePixelRatio, 该上限)。
 */
export const MOBILE_PIXEL_RATIO_CAP = { high: 2.0, medium: 1.4, low: 1.2, ultraLow: 1.0 };

/** 各档在该设备上允许的像素比上限（手机走手机表，桌面走 TIER_PROFILE） */
export function pixelRatioCap(tier, isMobile) {
  const t = TIERS.indexOf(tier) >= 0 ? tier : 'high';
  if (isMobile) {
    const m = MOBILE_PIXEL_RATIO_CAP[t];
    if (typeof m === 'number') return m;
  }
  return TIER_PROFILE[t].pixelRatio;
}

/** 默认目标帧率：桌面 min(60,刷新率)、手机 min(30,刷新率)（契约 §4.1） */
export const DEFAULT_TARGET_FPS = { desktop: 60, mobile: 30 };
/**
 * 默认档位：桌面「高」、手机「中」。
 * 依据：需求书要求手机「屏幕像素比上限 2.0 **且画质默认中档**」，而手机中档上限
 * 1.4 正好等于 P1 旧实现 min(dpr,1.4) —— 默认档零回退；想要更清晰由用户手动选「高」(2.0)。
 */
export const DEFAULT_TIER = { desktop: 'high', mobile: 'medium' };
/** 可用下限 fps（契约 v1.2 澄清 2）：低于它才算「性能不足」 */
export const ACCEPT_FPS = { desktop: 40, mobile: 30 };
export const FPS_OPTIONS = [30, 60, 120];
export const UPGRADE_HOLD_MS = 8000;        // 连续富余 8s 才升一档
export const DOWNGRADE_FACTOR = 1.35;       // 中位帧耗时 > 预算×1.35 才算超标
export const UPGRADE_FACTOR = 0.62;         // 中位帧耗时 < 预算×0.62 才算富余
export const WINDOW = 60;                   // 滑动窗口帧数
export const MIN_SAMPLES = 45;              // 窗口至少这么多帧才决策（一个判定周期）
export const ULTRA_LOW_PATIENCE_MS = 5000;  // 极低档仍不达标持续 5s → insufficient

/** localStorage 键名（契约 §3.2：非法值一律回落默认，不抛异常） */
export const STORAGE_KEYS = {
  tier: 'twin.qualityTier',
  targetFps: 'twin.targetFps',
  theme: 'twin.theme',
};

/** 刷新率估算的归一化候选（契约 §4.1） */
export const REFRESH_HZ_CHOICES = [30, 50, 60, 75, 90, 120, 144, 165, 240];
const MAX_REASONS = 20;

/* ---- 刷新率估算的置信度判据（P2-F 缺陷 2）--------------------------------
 * 为什么需要：rAF 间隔中位数在「页面本身跑不动 / 后台被节流」的环境里会被拉得很长
 * （实测 headless 软件渲染下 250~600ms），`snapRefreshHz()` 会把它估成 30Hz，
 * 于是 setRefreshHz 把用户**手选的 120fps 悄悄钳成 30fps** —— 而「弱机/重页面」
 * 恰恰是用户最需要手动选 120 的场景（实测 390×844 点「120」→ targetFps 变成 30）。
 * 判据三条同时满足才算「置信」：
 *   ① 样本数 ≥ REFRESH_MIN_SAMPLES；② 中位间隔 ≤ REFRESH_MAX_INTERVAL_MS（真实显示器 ≥22Hz，
 *   间隔大于 45ms 一定是被节流/饿死）；③ IQR 离散度 ≤ REFRESH_IQR_LIMIT（稳定）。
 * 不置信时：refreshHz 记 60（契约「样本不足或异常 → 60」）并**不动手选目标**，
 * reason 里如实写「仅参考」，绝不静默吃掉用户设置。
 */
export const REFRESH_MIN_SAMPLES = 10;
export const REFRESH_MAX_INTERVAL_MS = 45;
export const REFRESH_IQR_LIMIT = 0.25;

/** 分位数（线性插值；纯函数，便于单测） */
function quantile(sorted, p) {
  const n = sorted.length;
  if (!n) return 0;
  const i = (n - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * 评估一串 rAF 间隔样本 → 刷新率估算 + 置信度（场景侧只负责采样，判据在这里，可单测）。
 * @param {number[]} samples rAF 间隔（ms）
 * @returns {{n:number, hz:number, confident:boolean, medianMs:number, p25Ms:number,
 *            p75Ms:number, iqrRatio:number, reason:string}}
 */
export function assessRefreshEstimate(samples) {
  const arr = (samples || []).filter((v) => isFinite(v) && v > 0);
  const out = { n: arr.length, hz: 60, confident: false, medianMs: 0, p25Ms: 0, p75Ms: 0,
                iqrRatio: 0, reason: '' };
  if (!arr.length) {
    out.reason = '无 rAF 样本';
    return out;
  }
  const s = arr.slice().sort((a, b) => a - b);
  out.medianMs = quantile(s, 0.5);
  out.p25Ms = quantile(s, 0.25);
  out.p75Ms = quantile(s, 0.75);
  out.iqrRatio = out.medianMs > 0 ? (out.p75Ms - out.p25Ms) / out.medianMs : 0;
  out.hz = snapRefreshHz(1000 / out.medianMs);
  const enoughSamples = out.n >= REFRESH_MIN_SAMPLES;
  const plausible = out.medianMs <= REFRESH_MAX_INTERVAL_MS;
  const stable = out.iqrRatio <= REFRESH_IQR_LIMIT;
  out.confident = enoughSamples && plausible && stable;
  if (!out.confident) {
    out.reason = '样本 ' + out.n + ' 个' + (enoughSamples ? '' : '（< ' + REFRESH_MIN_SAMPLES + '）') +
      '，中位间隔 ' + out.medianMs.toFixed(1) + 'ms' +
      (plausible ? '' : '（> ' + REFRESH_MAX_INTERVAL_MS + 'ms，被节流/饿死）') +
      '，IQR 离散度 ' + (out.iqrRatio * 100).toFixed(0) + '%' +
      (stable ? '' : '（> ' + (REFRESH_IQR_LIMIT * 100) + '%）');
  }
  return out;
}

/** 把任意刷新率估算值归一到最近的候选值；非法值 → 60 */
export function snapRefreshHz(hz) {
  const v = Number(hz);
  if (!isFinite(v) || v <= 0) return 60;
  let best = 60;
  let bestD = Infinity;
  for (let i = 0; i < REFRESH_HZ_CHOICES.length; i++) {
    const d = Math.abs(REFRESH_HZ_CHOICES[i] - v);
    if (d < bestD) { bestD = d; best = REFRESH_HZ_CHOICES[i]; }
  }
  return best;
}

/** 中位数（不修改入参；count 为有效样本数） */
export function medianOf(list, count) {
  const n = Math.max(0, Math.min(count === undefined ? list.length : count, list.length));
  if (!n) return 0;
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(list[i]);
  arr.sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/** 安全取 localStorage：隐私模式/无 window 时返回 null，绝不抛异常 */
function resolveStorage(explicit) {
  if (explicit) return explicit;
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch (e) {
    return null;   // Safari 隐私模式下访问 localStorage 会抛 SecurityError
  }
}
function readRaw(storage, key) {
  if (!storage) return null;
  try { return storage.getItem(key); } catch (e) { return null; }
}
function writeRaw(storage, key, value) {
  if (!storage) return false;
  try { storage.setItem(key, value); return true; } catch (e) { return false; }
}

/**
 * 创建画质控制器。
 * @param {object} opts { storage, isMobile, onChange, now? }
 *   onChange(info) 在「档位变化 / 手动改档 / insufficient|degraded 翻转」时同步调用，
 *   info = { tier, prevTier, profile, pixelRatioCap, targetFps, refreshHz, auto, reason, insufficient, degraded }。
 *   now 仅用于测试注入时钟（默认 Date.now），生产不传。
 * @returns 契约 §3.2 要求的那个对象（tier/tierIndex/auto/... 用 getter 暴露实时值）
 */
export function createQualityController(opts) {
  const o = opts || {};
  const storage = resolveStorage(o.storage);
  const isMobile = !!o.isMobile;
  const onChange = typeof o.onChange === 'function' ? o.onChange : function () {};
  const nowFn = typeof o.now === 'function' ? o.now : function () { return Date.now(); };

  /* ---------------- 持久化状态：脏值必须能兜住 ---------------- */
  let refreshHz = 60;
  let targetFps = DEFAULT_TARGET_FPS[isMobile ? 'mobile' : 'desktop'];
  let targetManual = false;        // 用户手动指定过目标帧率（不再跟随刷新率默认值）
  let auto = true;
  let tierIndex = TIERS.indexOf(DEFAULT_TIER[isMobile ? 'mobile' : 'desktop']);
  let insufficient = false;
  let degraded = false;            // 已到最低画质、达到可用下限但未达目标（不算 insufficient）

  const storedTier = readRaw(storage, STORAGE_KEYS.tier);
  if (storedTier && TIERS.indexOf(storedTier) >= 0) {
    tierIndex = TIERS.indexOf(storedTier);
    auto = false;
  }   // 'auto' 或任何非法值（null/''/乱填）都回落默认：自动 + 高档

  const storedFps = readRaw(storage, STORAGE_KEYS.targetFps);
  if (storedFps !== null && storedFps !== undefined && storedFps !== '') {
    const n = Number(storedFps);
    if (FPS_OPTIONS.indexOf(n) >= 0) { targetFps = n; targetManual = true; }
  }

  /* ---------------- 判定用的两个滑动窗口 ---------------- */
  // 主窗口：只装「满帧渲染」的帧耗时（见文件头 ③）
  const win = new Float64Array(WINDOW);
  let winCount = 0;
  let winIdx = 0;
  let cycleFrames = 0;       // 本判定周期已累积的满帧样本数
  let totalFullFrames = 0;   // 满帧样本总数（用于把「连续 N 帧」写成真实数字）
  let downStreak = 0;        // 连续超标判定周期数（=2 才降档）
  let downFrom = -1;         // 本轮连续超标的起始样本序号
  let upSince = 0;           // 连续富余的起点（时间戳）
  let ultraSince = 0;        // 已在极低档且不达标起点（时间戳）

  // 空载窗口：空载帧单独判（见文件头 ③）
  const idleWin = new Float64Array(WINDOW);
  let idleWinCount = 0;
  let idleWinIdx = 0;
  let idleSlowStreak = 0;    // 连续「空载也超标」帧数

  const reasons = [];
  let lastReason = '';
  /* 刷新率估算的置信度（P2-F 缺陷 2）：null = 还没估过；
     只有 confident === true 时，刷新率才被用来钳制**手选**的目标帧率。 */
  let refreshConfident = null;
  let refreshEstimate = null;

  function idleFps() { return Math.min(30, targetFps); }
  function budgetMs() { return 1000 / targetFps; }
  function idleBudgetMs() { return 1000 / idleFps(); }
  function tierName() { return TIERS[tierIndex]; }
  function profile() { return TIER_PROFILE[tierName()]; }
  function capNow() { return pixelRatioCap(tierName(), isMobile); }
  function acceptFps() { return ACCEPT_FPS[isMobile ? 'mobile' : 'desktop']; }

  function pushReason(text) {
    lastReason = text;
    reasons.push({ t: nowFn(), text: text });
    if (reasons.length > MAX_REASONS) reasons.splice(0, reasons.length - MAX_REASONS);
  }

  function notify(prevTier, reason) {
    try {
      onChange({
        tier: tierName(), prevTier: prevTier, profile: profile(),
        pixelRatioCap: capNow(), targetFps: targetFps, refreshHz: refreshHz, auto: auto,
        reason: reason || lastReason, insufficient: insufficient, degraded: degraded,
      });
    } catch (e) {
      // 回调是宿主代码（scene.js），它抛异常不能污染控制器状态机
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[twin-quality] onChange 回调异常：' + ((e && e.message) || e));
      }
    }
  }

  /** 换档后旧样本不再代表新档位的代价，清窗重测（避免用旧档的耗时连续误判） */
  function clearWindow() {
    winCount = 0; winIdx = 0; cycleFrames = 0; downStreak = 0; downFrom = -1; upSince = 0;
    idleWinCount = 0; idleWinIdx = 0; idleSlowStreak = 0;
  }

  /** 档位差异文案（像素比用**该设备**的上限，手机端标注天花板 2.0） */
  function deltaText(fromTier, toTier) {
    const fp = TIER_PROFILE[fromTier];
    const tp = TIER_PROFILE[toTier];
    const fa = pixelRatioCap(fromTier, isMobile);
    const ta = pixelRatioCap(toTier, isMobile);
    const delta = [];
    if (fa !== ta) delta.push('像素比上限 ' + fa + '→' + ta + (isMobile ? '（手机档位上限，天花板 2.0）' : ''));
    if (fp.antialias !== tp.antialias) delta.push('抗锯齿 ' + (tp.antialias ? '开' : '关'));
    if (fp.mist !== tp.mist) delta.push('雾气 ' + (tp.mist ? '开' : '关'));
    if (fp.cableFlow !== tp.cableFlow) delta.push('主缆流光 ' + (tp.cableFlow ? '开' : '关'));
    if (fp.terrain !== tp.terrain) delta.push('地形密度 ' + (tp.terrain === 'low' ? '低（约 1/4 顶点）' : '高'));
    return delta.join('，');
  }

  function doDowngrade(medianMs, budget, frames, source) {
    if (tierIndex >= TIERS.length - 1) return false;
    const from = tierName();
    tierIndex += 1;
    const to = tierName();
    const text = '中位帧耗时 ' + medianMs.toFixed(1) + 'ms > 预算 ' + budget.toFixed(1) +
      'ms（' + targetFps + 'fps）×' + DOWNGRADE_FACTOR + '，' + source + '连续 ' + frames + ' 帧 → ' +
      TIER_LABELS[from] + ' → ' + TIER_LABELS[to] + '（' + deltaText(from, to) + '）';
    pushReason(text);
    clearWindow();
    ultraSince = 0;
    degraded = false;
    notify(from, text);
    return true;
  }

  function doUpgrade(medianMs, budget, heldMs) {
    if (tierIndex <= 0) return false;
    const from = tierName();
    tierIndex -= 1;
    const to = tierName();
    const text = '中位帧耗时 ' + medianMs.toFixed(1) + 'ms < 预算 ' + budget.toFixed(1) +
      'ms（' + targetFps + 'fps）×' + UPGRADE_FACTOR + '，连续富余 ' + (heldMs / 1000).toFixed(1) +
      's（阈值 ' + (UPGRADE_HOLD_MS / 1000) + 's）→ ' + TIER_LABELS[from] + ' → ' + TIER_LABELS[to] +
      '（' + deltaText(from, to) + '）';
    pushReason(text);
    clearWindow();
    ultraSince = 0;
    insufficient = false;
    degraded = false;
    notify(from, text);
    return true;
  }

  /**
   * 极低档的「到底行不行」判定（v1.2）：
   *   中位 fps < 可用下限 → insufficient=true（如实提示性能不足）
   *   可用下限 ≤ 中位 fps < 目标 → 不算不足，但 reason 如实写清楚两条线
   *   ≥ 目标 → 恢复正常
   * 用 5s 耐心计时，避免一次抖动就下结论。
   */
  function checkUltraLow(medianMs, now) {
    if (tierName() !== 'ultraLow' || !(medianMs > 0)) return;
    const accept = acceptFps();
    const fps = 1000 / medianMs;
    if (fps < accept) {
      if (!ultraSince) ultraSince = now;
      if (!insufficient && now - ultraSince >= ULTRA_LOW_PATIENCE_MS) {
        insufficient = true;
        degraded = false;
        pushReason('已在极低档（像素比上限 ' + capNow() + ' / 抗锯齿关 / 雾气关 / 地形密度低）仍不达标：中位 ' +
          fps.toFixed(1) + 'fps < ' + (isMobile ? '手机' : '桌面') + '可用下限 ' + accept + 'fps' +
          '（中位帧耗时 ' + medianMs.toFixed(1) + 'ms，目标 ' + targetFps + 'fps），持续 ' +
          ((now - ultraSince) / 1000).toFixed(1) + 's → 当前设备性能不足，已降为最低画质');
        notify(tierName(), lastReason);
      }
      return;
    }
    ultraSince = 0;
    if (fps < targetFps) {
      if (!degraded) {
        degraded = true;
        pushReason('已降为最低画质：实测 ' + fps.toFixed(1) + 'fps（达到' + (isMobile ? '手机' : '桌面') +
          '可用下限 ' + accept + 'fps，未达目标 ' + targetFps + 'fps；中位帧耗时 ' + medianMs.toFixed(1) +
          'ms / 预算 ' + budgetMs().toFixed(1) + 'ms，像素比上限 ' + capNow() + '）');
        notify(tierName(), lastReason);
      }
      return;
    }
    if (degraded) { degraded = false; notify(tierName(), lastReason); }
  }

  /** 一个判定周期结束：用窗口**中位**帧耗时决定降/升（两者互斥，一次只动一档） */
  function evaluate() {
    const medianMs = medianOf(win, winCount);
    const budget = budgetMs();
    const over = medianMs > budget * DOWNGRADE_FACTOR;
    const under = medianMs < budget * UPGRADE_FACTOR;
    const now = nowFn();

    checkUltraLow(medianMs, now);

    if (over) {
      // 「连续 N 帧」要写真实数字：本轮连续超标的起点 = 本判定周期开始时的样本序号
      // （evaluate() 由 pushFrame 在每个完整周期末尾调用，此刻 cycleFrames 已归零）
      if (downStreak === 0) downFrom = Math.max(0, totalFullFrames - MIN_SAMPLES);
      downStreak += 1;
      upSince = 0;
      if (downStreak >= 2) {
        const frames = Math.max(MIN_SAMPLES, totalFullFrames - Math.max(0, downFrom));
        doDowngrade(medianMs, budget, frames, '');
      }
    } else if (under) {
      downStreak = 0; downFrom = -1;
      if (tierIndex > 0) {
        if (!upSince) upSince = now;
        else if (now - upSince >= UPGRADE_HOLD_MS) doUpgrade(medianMs, budget, now - upSince);
      }
    } else {
      // 落在 1.35× 与 0.62× 之间的死区：两边计时都清零（迟滞）
      downStreak = 0; downFrom = -1; upSince = 0;
    }
  }

  /* ---------------- 契约要求的公开方法 ---------------- */

  function setTier(nameOrAuto, options) {
    const manual = !!(options && options.manual);
    if (nameOrAuto === 'auto') {
      const wasAuto = auto;
      auto = true;
      if (manual) writeRaw(storage, STORAGE_KEYS.tier, 'auto');
      if (!wasAuto) {
        pushReason('恢复自动画质（当前 ' + TIER_LABELS[tierName()] + '，目标 ' + targetFps +
          'fps，预算 ' + budgetMs().toFixed(1) + 'ms/帧，像素比上限 ' + capNow() + '）');
        clearWindow();
        notify(tierName(), lastReason);
      }
      return tierName();
    }
    const idx = TIERS.indexOf(nameOrAuto);
    if (idx < 0) return tierName();          // 非法档位名：忽略，不抛异常
    auto = false;
    if (manual) writeRaw(storage, STORAGE_KEYS.tier, nameOrAuto);
    if (idx !== tierIndex) {
      const from = tierName();
      tierIndex = idx;
      const tp = TIER_PROFILE[nameOrAuto];
      const text = '手动选择画质 → ' + TIER_LABELS[nameOrAuto] + '（像素比上限 ' + capNow() +
        (isMobile ? '，手机天花板 2.0' : '') + '，抗锯齿 ' + (tp.antialias ? '开' : '关') +
        '，雾气 ' + (tp.mist ? '开' : '关') + '，地形密度 ' + (tp.terrain === 'low' ? '低（约 1/4 顶点）' : '高') + '）';
      pushReason(text);
      clearWindow();
      ultraSince = 0;
      if (tierName() !== 'ultraLow') { insufficient = false; degraded = false; }
      notify(from, text);
    }
    return tierName();
  }

  function setTargetFps(n, options) {
    const v = Number(n);
    if (FPS_OPTIONS.indexOf(v) < 0) return targetFps;   // 只接受 30/60/120
    const manual = !!(options && options.manual);
    if (manual) {
      targetManual = true;
      writeRaw(storage, STORAGE_KEYS.targetFps, String(v));
    }
    let eff = v;
    let clampNote = '';
    /* ⚠ 只有「置信的」刷新率估算才有资格钳制手选目标（P2-F 缺陷 2）：
       否则 headless/弱机/重页面里估算出的 30Hz 会把用户手选的 120fps 悄悄吃掉。
       refreshConfident === null（还没估过）同样不钳，等估算落地后再按置信与否决定。 */
    if (v > refreshHz && refreshConfident === true) {
      eff = refreshHz;
      clampNote = '目标帧率 ' + v + 'fps 超过（置信的）刷新率 ' + refreshHz + 'Hz → 钳到 ' + eff + 'fps；';
    } else if (v > refreshHz) {
      clampNote = '刷新率估算不置信，' + v + 'fps 保留不钳；';
    }
    targetFps = eff;
    clearWindow();
    pushReason(clampNote + '目标帧率改为 ' + eff + 'fps（预算 ' + budgetMs().toFixed(1) +
      'ms/帧，空载上限 ' + idleFps() + 'fps，可用下限 ' + acceptFps() + 'fps）');
    return eff;
  }

  /**
   * scene.js 估出刷新率后调用。第二个参数是**置信度**（可选，缺省视为置信，兼容契约单参签名）：
   *   setRefreshHz(hz, { confident, n, medianMs, p25Ms, p75Ms, iqrRatio })
   * 不置信时：refreshHz 记 60（契约「样本不足或异常 → 60」）、**不钳手选目标**、reason 写明「仅参考」。
   * 置信时才按契约钳制：n > refreshHz → 钳到刷新率并写明原因。
   */
  function setRefreshHz(hz, o2) {
    const info = o2 || {};
    const confident = info.confident === undefined ? true : !!info.confident;
    const measuredHz = Number(hz);
    refreshEstimate = {
      hz: confident ? snapRefreshHz(measuredHz) : 60,
      measuredHz: isFinite(measuredHz) && measuredHz > 0 ? Number(measuredHz.toFixed(1)) : 0,
      confident: confident,
      n: info.n === undefined ? null : Number(info.n),
      medianMs: info.medianMs === undefined ? null : Number(Number(info.medianMs).toFixed(1)),
      p25Ms: info.p25Ms === undefined ? null : Number(Number(info.p25Ms).toFixed(1)),
      p75Ms: info.p75Ms === undefined ? null : Number(Number(info.p75Ms).toFixed(1)),
      iqrRatio: info.iqrRatio === undefined ? null : Number(Number(info.iqrRatio).toFixed(3)),
    };
    if (!confident) {
      refreshConfident = false;
      const prev = refreshHz;
      const keptManual = targetManual ? targetFps : null;
      refreshHz = 60;
      if (!targetManual) {
        // 没手选过就按默认值跟 60Hz 上限（桌面 60 / 手机 30）
        targetFps = Math.min(DEFAULT_TARGET_FPS[isMobile ? 'mobile' : 'desktop'], 60);
      }
      pushReason('刷新率估算置信度不足（' + (info.reason || ('样本 ' + refreshEstimate.n + ' 个')) +
        '）→ 仅参考：refreshHz 记 60Hz' +
        (keptManual ? '，手选目标 ' + keptManual + 'fps 保持不变（不被吃掉）' : ''));
      if (prev !== 60) clearWindow();
      return refreshHz;
    }
    refreshConfident = true;
    const snapped = snapRefreshHz(measuredHz);
    const prev = refreshHz;
    refreshHz = snapped;
    if (!targetManual) {
      // 默认目标帧率跟随刷新率（桌面 60 / 手机 30 为上限）
      targetFps = Math.min(DEFAULT_TARGET_FPS[isMobile ? 'mobile' : 'desktop'], snapped);
    } else if (targetFps > snapped) {
      targetFps = snapped;
      pushReason('（置信的）刷新率估算 ' + snapped + 'Hz 低于已选目标帧率，钳到 ' + snapped + 'fps');
    }
    if (prev !== snapped) clearWindow();
    return snapped;
  }

  function reset(reason) {
    clearWindow();
    ultraSince = 0;
    if (reason) pushReason(String(reason));
    return snapshot();
  }

  /** 追加一条「带真实数字」的原因（scene.js 用来写实际生效的像素比/画布等） */
  function note(text) {
    if (text === undefined || text === null || text === '') return lastReason;
    pushReason(String(text));
    return lastReason;
  }

  /**
   * 给「刚生成的那条原因」补一段后缀（scene.js 用来补「实际像素比 / 被哪一层钳住」）。
   * 为什么不新开一条：HUD 的「最近档位变化」只显示一行，把数字补在同一行才读得通。
   */
  function annotateLast(suffix) {
    if (!suffix || !reasons.length) return lastReason;
    const last = reasons[reasons.length - 1];
    const text = String(last.text);
    if (text.indexOf(String(suffix)) >= 0) return lastReason;
    last.text = text + String(suffix);
    if (lastReason === text) lastReason = last.text;
    return lastReason;
  }

  function snapshot() {
    const medianMs = medianOf(win, winCount);
    const idleMedian = medianOf(idleWin, idleWinCount);
    return {
      tier: tierName(),
      tierLabel: TIER_LABELS[tierName()],
      tierIndex: tierIndex,
      auto: auto,
      manual: !auto,
      targetFps: targetFps,
      refreshHz: refreshHz,
      refreshConfident: refreshConfident,
      refreshEstimate: refreshEstimate,
      profile: profile(),
      pixelRatioCap: capNow(),
      mobilePixelRatioCap: MOBILE_PIXEL_RATIO_CAP[tierName()],
      isMobile: isMobile,
      budgetMs: Number(budgetMs().toFixed(2)),
      idleFps: idleFps(),
      idleBudgetMs: Number(idleBudgetMs().toFixed(2)),
      acceptFps: acceptFps(),
      medianFrameMs: Number(medianMs.toFixed(2)),
      medianFps: medianMs > 0 ? Number((1000 / medianMs).toFixed(1)) : 0,
      idleMedianFrameMs: Number(idleMedian.toFixed(2)),
      samples: winCount,
      idleSamples: idleWinCount,
      totalFullFrames: totalFullFrames,
      downStreak: downStreak,
      upgradeHoldMs: upSince ? Math.max(0, nowFn() - upSince) : 0,
      insufficient: insufficient,
      degraded: degraded,
      reason: lastReason,
    };
  }

  /**
   * 每渲染一帧调用一次。
   * @param {number} dtMs 本帧与上一帧的真实间隔（ms）
   * @param {object} o2 { interacting } —— 该帧是否按目标帧率满帧渲染
   */
  function pushFrame(dtMs, o2) {
    const dt = Number(dtMs);
    if (!isFinite(dt) || dt <= 0) return;
    // 手动选档 = 关闭自动（契约 §3.2）：此时不再做任何升降档/不达标判定。
    // ⚠ 这条是实测踩出来的坑：headless 软件渲染下空载帧耗时天然超标，即使角标显示
    //   「手动·高」，阶梯仍会在后台偷偷把档位降到 low（关掉 AA、换掉 canvas），
    //   与「手动选档」的语义直接矛盾。
    if (!auto) return;
    const interacting = !!(o2 && o2.interacting);
    if (interacting) {
      win[winIdx] = dt;
      winIdx = (winIdx + 1) % WINDOW;
      if (winCount < WINDOW) winCount += 1;
      totalFullFrames += 1;
      cycleFrames += 1;
      if (winCount >= MIN_SAMPLES && cycleFrames >= MIN_SAMPLES) {
        cycleFrames = 0;
        evaluate();
      }
      return;
    }
    // 空载帧：我们主动把帧率压到 min(30,target)，用「空载预算」单独判弱机
    idleWin[idleWinIdx] = dt;
    idleWinIdx = (idleWinIdx + 1) % WINDOW;
    if (idleWinCount < WINDOW) idleWinCount += 1;
    const idleSlow = dt > idleBudgetMs() * DOWNGRADE_FACTOR;
    if (idleSlow) idleSlowStreak += 1;
    else idleSlowStreak = 0;
    if (idleSlowStreak >= 2 * MIN_SAMPLES) {
      const med = medianOf(idleWin, idleWinCount);
      const frames = idleSlowStreak;
      const now = nowFn();
      idleSlowStreak = 0;
      idleWinCount = 0; idleWinIdx = 0;
      if (tierIndex < TIERS.length - 1) {
        doDowngrade(med, idleBudgetMs(), frames, '空载（' + idleFps() + 'fps）中位帧耗时超标，');
      } else {
        // 已在极低档：空载都跑不到 min(30,target) → 连可用下限都够不上，
        // 但要按 5s 耐心下结论（这里不用 idle 数据判 degraded：空载上限本身就低于目标帧率）
        if (!ultraSince) ultraSince = now;
        if (!insufficient && now - ultraSince >= ULTRA_LOW_PATIENCE_MS) {
          insufficient = true;
          pushReason('已在极低档仍不达标：空载中位帧耗时 ' + med.toFixed(1) + 'ms > 空载预算 ' +
            idleBudgetMs().toFixed(1) + 'ms（' + idleFps() + 'fps 上限都达不到，低于可用下限 ' +
            acceptFps() + 'fps；目标 ' + targetFps + 'fps）持续 ' +
            ((now - ultraSince) / 1000).toFixed(1) + 's → 当前设备性能不足，已降为最低画质');
          notify(tierName(), lastReason);
        }
      }
    }
  }

  const ctl = {
    setTier: setTier,
    setTargetFps: setTargetFps,
    setRefreshHz: setRefreshHz,
    pushFrame: pushFrame,
    reset: reset,
    note: note,
    annotateLast: annotateLast,
    snapshot: snapshot,
    reasons: reasons,          // 就地变更的同一个数组（HUD / api.perf.reasons 直接读）
  };

  // tier/tierIndex/auto/... 用 getter 暴露**实时值**：ui-hud 每秒读 api.perf 时
  // 拿到的永远是最新档位，不需要 scene.js 手动同步一遍。
  Object.defineProperties(ctl, {
    tier: { get: tierName, enumerable: true },
    tierIndex: { get: function () { return tierIndex; }, enumerable: true },
    tierLabel: { get: function () { return TIER_LABELS[tierName()]; }, enumerable: true },
    auto: { get: function () { return auto; }, enumerable: true },
    targetFps: { get: function () { return targetFps; }, enumerable: true },
    profile: { get: profile, enumerable: true },
    refreshHz: { get: function () { return refreshHz; }, enumerable: true },
    refreshConfident: { get: function () { return refreshConfident; }, enumerable: true },
    insufficient: { get: function () { return insufficient; }, enumerable: true },
    degraded: { get: function () { return degraded; }, enumerable: true },
    reason: { get: function () { return lastReason; }, enumerable: true },
    pixelRatioCap: { get: capNow, enumerable: true },
    storage: { get: function () { return storage; }, enumerable: false },
  });

  return ctl;
}
