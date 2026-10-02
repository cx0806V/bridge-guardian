/* ============================================================================
 * 场景 HUD：视角预设 / 交互开关 / 结构信息 / 热点详情
 * 说明：HUD 用原生 DOM 实现（不引入任何 UI 框架），样式在 static/app.css 的
 *      “数字孪生场景”一节；所有数字都来自 spec.js 的公开设计参数或实际几何统计。
 * ==========================================================================*/
import { SPAN, X, Y, Z, GIRDER, CABLE, TOWER, FACT_SHEET, FIDELITY_NOTE } from './spec.js';

const fmt = (v, d) => (typeof v === 'number' ? v.toFixed(d === undefined ? 0 : d) : v);

export function buildHud(api, host) {
  const stats = api.stats;
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };

  /* ---------------- 左侧信息栏：桥型 / 关键参数 / 结构统计 ---------------- */
  const info = el('div', 'twin-hud twin-hud-info');
  const factRows = FACT_SHEET.slice(0, 6).map((r) =>
    '<div class="th-row"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>').join('');
  info.innerHTML =
    '<div class="th-head"><i></i>花江峡谷大桥 · 三维数字孪生<span class="th-mode" id="twinMode">实体</span></div>' +
    '<div class="th-rows">' + factRows + '</div>' +
    '<div class="th-stat">' +
      '<span>桁梁杆件 <b>' + stats.trussMembers + '</b></span>' +
      '<span>吊索 <b>' + stats.hangerCount + '</b> 根</span>' +
      '<span>节段 <b>' + stats.panels + '</b> 个</span>' +
      '<span>主缆总跨 <b>' + stats.cableSpan + '</b> m</span>' +
    '</div>' +
    '<div class="th-note">几何口径：主跨 ' + SPAN.main + 'm · 垂跨比 1/10 · 桁高 ' + GIRDER.depth +
      'm · 桁宽 ' + GIRDER.width + 'm · 节段 ' + GIRDER.panel + 'm · 桥面 ' + (Z.roadwayHalf * 2) +
      'm；塔柱收坡/横梁/锚碇体量与峡谷地形为示意补全。</div>';
  host.appendChild(info);

  /* ---------------- 右上交互区：视角预设 + 开关 ---------------- */
  const bar = el('div', 'twin-hud twin-hud-view');
  const presetWrap = el('div', 'th-presets');
  api.presets.forEach((p) => {
    const b = el('button', 'th-btn', p.label);
    b.type = 'button';
    b.title = p.note;
    b.dataset.preset = p.key;
    b.addEventListener('click', () => {
      api.applyPreset(p.key);
      markActive(p.key);
      setMode(p.note);
    });
    presetWrap.appendChild(b);
  });
  const zoomWrap = el('div', 'th-zooms');
  [['放大', 0.62], ['缩小', 1.7]].forEach(([label, k]) => {
    const b = el('button', 'th-btn th-btn-zoom', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      const dir = api.camera.position.clone().sub(api.controls.target);
      api.flyTo(api.controls.target.clone().add(dir.multiplyScalar(k)),
        api.controls.target.clone(), 0.5);
    });
    zoomWrap.appendChild(b);
  });
  const toggleWrap = el('div', 'th-toggles');
  function toggle(label, on, handler, title) {
    const b = el('button', 'th-btn th-toggle' + (on ? ' on' : ''), label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', () => {
      const now = handler(!b.classList.contains('on'));
      b.classList.toggle('on', !!now);
    });
    toggleWrap.appendChild(b);
    return b;
  }
  toggle('自动旋转', false, (v) => api.setAutoRotate(v));
  toggle('结构线框', false, (v) => {
    const on = api.setWireframe(v);
    setMode(on ? '线框' : '实体');
    return on;
  }, '显示构件边线，便于观察桁架与塔柱结构');
  let labelMode = 0;   // 0 全部 / 1 仅测点 / 2 关闭
  const labelBtn = toggle('测点标注', true, () => {
    labelMode = (labelMode + 1) % 3;
    api.setLabelMode(['all', 'sensor', 'off'][labelMode]);
    labelBtn.textContent = ['测点标注', '仅跨中', '标注关闭'][labelMode];
    return labelMode !== 2;
  });
  toggle('复位视角', false, () => { api.applyPreset('full'); markActive('full'); return false; });
  bar.appendChild(presetWrap);
  bar.appendChild(zoomWrap);
  bar.appendChild(toggleWrap);

  function markActive(key) {
    presetWrap.querySelectorAll('.th-btn').forEach((b) => {
      b.classList.toggle('on', b.dataset.preset === key);
    });
  }
  markActive('full');

  const modeTag = el('div', 'th-mode-tag', '拖拽旋转 · 滚轮缩放 · 右键平移 · 双击聚焦');
  bar.appendChild(modeTag);
  host.appendChild(bar);

  /* ---------------- 底部热点详情卡 ---------------- */
  const detail = el('div', 'twin-hud twin-hud-detail');
  detail.innerHTML = '<div class="td-none">点击场景中的测点标记查看该部位说明（双击可直接飞近观察）</div>';
  host.appendChild(detail);

  function showDetail(h) {
    if (!h) {
      detail.className = 'twin-hud twin-hud-detail';
      detail.innerHTML = '<div class="td-none">点击场景中的测点标记查看该部位说明（双击可直接飞近观察）</div>';
      return;
    }
    detail.className = 'twin-hud twin-hud-detail open';
    detail.innerHTML =
      '<div class="td-title"><b>' + h.label + '</b><span>' + h.code + '</span></div>' +
      '<div class="td-note">' + h.note + '</div>' +
      '<div class="td-pos">模型坐标 x=' + fmt(h.x, 1) + ' m · y=' + fmt(h.y, 1) + ' m · z=' + fmt(h.z, 1) + ' m</div>' +
      '<button class="th-btn td-close" type="button">收起</button>';
    detail.querySelector('.td-close').addEventListener('click', () => { api.select(null); showDetail(null); });
  }

  function setMode(text) {
    const t = document.getElementById('twinMode');
    if (t && text) t.textContent = text;
  }

  /* ---------------- 与场景联动 ---------------- */
  api.onSelect((h) => showDetail(h));
  api.onFocus((target, label) => {
    if (target && target.isVector3) {
      setMode('聚焦：' + (label && label.label ? label.label : label || ''));
    }
  });
  const wrap = el('div', 'twin-hud twin-hud-hint');
  wrap.innerHTML = '<span class="hk">鼠标</span>左键旋转 · 滚轮缩放 · 右键平移 · ' +
    '<span class="hk">双击</span>聚焦 · <span class="hk">单击测点</span>查看说明';
  host.appendChild(wrap);

  /* ---------------- P2 性能角标（新增，不改上面任何既有元素与行为） ----------------
     容错：角标构建失败绝不允许拖垮既有 HUD（现场演示时宁可没有角标，也不能没有工具条）。 */
  let perfBadge = null;
  try {
    perfBadge = buildPerfBadge(api, host);
  } catch (e) {
    if (window.console && console.warn) console.warn('[twin] 性能角标构建失败：' + e);
  }

  return {
    showDetail, setMode, markActive,
    elements: { info, bar, detail, wrap, perf: perfBadge ? perfBadge.root : null },
  };
}

/* ============================================================================
 * P2 性能角标（契约 §3.5）：实时指标 + 手动档位（目标帧率 / 画质）+ 主题开关
 * ----------------------------------------------------------------------------
 * 三条设计理由（现场答辩要讲得出来）：
 *   ① 数字只有一个来源：api.perf（=== window.TWIN_PERF，同一引用，契约 §3.3）。
 *      本文件**不做任何二次统计**，屏幕上写的帧率就是渲染循环真实的推帧速率。
 *   ② 样式自带：app.css（平台基线）与 templates/dashboard.html（Lead 的全屏修复）
 *      都不归本文件所有。角标若依赖外部追加 CSS，任何一方漏了就退化成一坨裸 DOM，
 *      演示现场没有第二次机会。因此这里注入 <style id="twinPerfStyle">，
 *      选择器一律以 .twin-hud.twin-perf 起头，位置数值与契约 §3.5 + Lead 的集成
 *      口径逐字一致（桌面 right:10px/bottom:78px；≤768px bottom:66px+safe-area，
 *      展开态 left/right 10px、max-height 52%、可滚动），别人用更高特异性即可收口。
 *   ③ 根元素自己就是定位盒（不再套内层 wrapper）：这样 Lead 写的
 *      `body.view-3d-only .hero-canvas .twin-perf.open{left/right/max-height/overflow}`
 *      会直接作用在角标上而不会打空。
 *      折叠态根元素 pointer-events:none、只有 chip/按钮/链接 auto（不吞画布拖拽，
 *      这是既有铁律）；展开态才放开根元素——否则触屏没法滚动面板。
 * ==========================================================================*/

const PERF_CSS = [
  '/* P2 性能角标（由 hud.js 注入；只作用于 .twin-hud.twin-perf，不碰 app.css / dashboard.html） */',
  '.twin-hud.twin-perf{',
  '  position:absolute; inset:auto; top:auto; left:auto; right:10px; bottom:78px;',
  '  display:flex; flex-direction:column; gap:6px; align-items:stretch;',
  '  width:max-content; max-width:min(320px, calc(100vw - 20px));',
  '  font-size:12px; line-height:1.4; color:var(--text, #1f2937);',
  '  pointer-events:none; overflow:visible; z-index:4; }',
  '.twin-hud.twin-perf.open{',
  '  width:min(320px, calc(100vw - 20px)); max-height:min(52%, 420px); overflow:hidden;',
  '  pointer-events:none; }',
  '/* ⚠ 契约 §3.5 铁律（task-7 缺陷修复）：根元素**任何状态**都是 pointer-events:none，',
  '   面板与非交互子元素一律 none，只有 chip / button / a 恢复 auto。',
  '   曾经的写法是展开态给根元素/面板 auto（为的是触屏能滚动面板），实测后果：',
  '   手机 390×844 展开后 elementFromPoint(198,507) 从 CANVAS 变成 DIV.tp-row ——',
  '   面板盖住的画布中部整块失去交互（单击选不中测点、拖拽起手被吃掉），用户会以为 3D 卡死。',
  '   取舍（task-7 要求 B）：面板内容高于限高时不再靠手势滚动，改用面板头部的',
  '   「▾ 更多指标 / ▴ 回到顶部」按钮做程序化滚动（button 是 auto，仍可点）；',
  '   这样既不吞画布事件，最后几行也一定看得到。 */',
  '.twin-hud.twin-perf.open .tp-chip{ width:max-content; align-self:flex-end; }',
  '/* 折叠态 chip：`60fps · 中 · 15.9ms` + 状态点 + 展开箭头 */',
  '.twin-hud.twin-perf .tp-chip{',
  '  pointer-events:auto; flex:0 0 auto; display:inline-flex; align-items:center; gap:6px;',
  '  font:inherit; font-size:12px; cursor:pointer; padding:6px 10px; border-radius:999px;',
  '  background:rgba(255,255,255,.94); border:1px solid var(--border, #e5e8eb);',
  '  color:var(--text, #1f2937); box-shadow:0 1px 3px rgba(16,24,40,.10);',
  '  backdrop-filter:blur(6px); font-variant-numeric:tabular-nums; white-space:nowrap; }',
  '.twin-hud.twin-perf .tp-chip:hover{ border-color:var(--accent-border, rgba(22,163,74,.34));',
  '  color:var(--accent, #16a34a); }',
  '.twin-hud.twin-perf .tp-dot{ width:8px; height:8px; border-radius:50%;',
  '  background:var(--ok, #15803d); flex:0 0 auto; }',
  '/* 空载降频用青色：静止时按 idleFps 渲染是设计行为，不是故障，不能误报成红色 */',
  '.twin-hud.twin-perf .tp-dot.idle{ background:#0891b2; }',
  '.twin-hud.twin-perf .tp-dot.warn{ background:var(--warn, #b45309); }',
  '.twin-hud.twin-perf .tp-dot.bad{ background:var(--crit, #be123c); }',
  '.twin-hud.twin-perf .tp-chip-text{ font-weight:700; }',
  '.twin-hud.twin-perf .tp-caret{ color:var(--muted, #6b7280); font-size:10px; transition:transform .15s; }',
  '.twin-hud.twin-perf.open .tp-caret{ transform:rotate(180deg); }',
  '/* 展开面板：面板内部滚动（程序化），chip 固定在盒子底部 ——',
  '   实测教训一：把滚动放在根元素上时，内容一超高 chip 就被滚出可视区',
  '   （chip.top 979 > 盒底 954），等于「展开了就收不回去」，所以滚动放在面板上。',
  '   实测教训二（task-7）：面板一旦吃指针事件就会吞掉画布交互，',
  '   因此面板 pointer-events:none，滚动只能由头部按钮程序化驱动。 */',
  '.twin-hud.twin-perf .tp-panel{',
  '  pointer-events:none; display:none; width:100%; padding:0 9px 9px; border-radius:10px;',
  '  background:rgba(255,255,255,.95); border:1px solid var(--border, #e5e8eb);',
  '  box-shadow:0 6px 18px rgba(16,24,40,.16); backdrop-filter:blur(6px); }',
  '.twin-hud.twin-perf.open .tp-panel{',
  '  display:block; flex:1 1 auto; min-height:0; overflow:hidden; }',
  '/* 头部必须 sticky：面板靠程序化滚动翻页，头部一滚走，「更多指标 / 收起」就再也点不到',
  '   （实测踩坑：点一次「更多指标」后 scrollTop 直接到底，收起按钮跑到面板顶上 -352px，',
  '   既回不去也收不起）。sticky + 不透明底色保证这两个按钮任何滚动位置都可点。 */',
  '.twin-hud.twin-perf .tp-head{ position:sticky; top:0; z-index:2; background:#fff;',
  '  display:flex; align-items:center; gap:6px; padding:8px 0 6px; margin-bottom:2px;',
  '  font-size:11.5px; font-weight:700; color:var(--text-strong, #111827); }',
  '.twin-hud.twin-perf.theme-dark .tp-head{ background:#18181a; }',
  '.twin-hud.twin-perf .tp-note{ font-weight:400; font-size:10.5px; color:var(--muted, #6b7280); }',
  '/* 「更多指标」是面板唯一能滚动的入口（面板本体 pe:none，见上），所以它必须可点 */',
  '.twin-hud.twin-perf .tp-more{ margin-left:auto; }',
  '.twin-hud.twin-perf .tp-more[hidden]{ display:none; }',
  '.twin-hud.twin-perf .tp-close{ margin-left:4px; }',
  '.twin-hud.twin-perf .tp-row{ display:flex; justify-content:space-between; gap:10px; padding:1px 0; }',
  '.twin-hud.twin-perf .tp-k{ color:var(--muted, #6b7280); font-size:11px; }',
  '.twin-hud.twin-perf .tp-v{ font-variant-numeric:tabular-nums; font-weight:600; }',
  '.twin-hud.twin-perf .tp-group{ display:flex; align-items:center; gap:4px; flex-wrap:wrap; margin-top:7px; }',
  '.twin-hud.twin-perf .tp-glabel{ min-width:52px; font-size:11px; color:var(--muted, #6b7280); }',
  '.twin-hud.twin-perf .tp-btn{',
  '  pointer-events:auto; font:inherit; font-size:11.5px; cursor:pointer; padding:4px 8px; border-radius:7px;',
  '  background:#fff; border:1px solid var(--border, #e5e8eb); color:var(--text, #1f2937); }',
  '.twin-hud.twin-perf .tp-btn:hover{ border-color:var(--accent-border, rgba(22,163,74,.34));',
  '  color:var(--accent, #16a34a); }',
  '.twin-hud.twin-perf .tp-btn.on{ background:var(--accent, #16a34a); border-color:var(--accent, #16a34a);',
  '  color:#fff; font-weight:700; }',
  '.twin-hud.twin-perf .tp-btn[disabled]{ opacity:.42; cursor:not-allowed; }',
  '.twin-hud.twin-perf .tp-warn{',
  '  margin-top:7px; padding:5px 7px; border-radius:7px; font-size:11.5px; font-weight:700;',
  '  color:var(--crit, #be123c); background:#fff1f2; border:1px solid rgba(190,18,60,.30); }',
  '.twin-hud.twin-perf .tp-warn[hidden]{ display:none; }',
  '.twin-hud.twin-perf .tp-reason{ margin-top:6px; font-size:11px; color:var(--muted, #6b7280);',
  '  line-height:1.45; word-break:break-word; }',
  '.twin-hud.twin-perf .tp-reason .tp-reason-v{ font-style:normal; color:var(--text, #1f2937); }',
  '.twin-hud.twin-perf .tp-link{ pointer-events:auto; display:inline-block; margin-top:7px;',
  '  font-size:11.5px; color:var(--accent, #16a34a); }',
  '/* 深色皮肤：由 perf.theme 驱动的 .theme-dark 类，保证开了深色开关仍然可读、不黑屏 */',
  '.twin-hud.twin-perf.theme-dark .tp-chip,',
  '.twin-hud.twin-perf.theme-dark .tp-panel{',
  '  background:rgba(24,24,26,.94); border-color:rgba(224,185,123,.30); color:#e5e7eb; }',
  '.twin-hud.twin-perf.theme-dark .tp-chip-text,',
  '.twin-hud.twin-perf.theme-dark .tp-v,',
  '.twin-hud.twin-perf.theme-dark .tp-head,',
  '.twin-hud.twin-perf.theme-dark .tp-reason .tp-reason-v{ color:#f3f4f6; }',
  '.twin-hud.twin-perf.theme-dark .tp-btn{ background:#1b1b1d; border-color:rgba(224,185,123,.28);',
  '  color:#e5e7eb; }',
  '.twin-hud.twin-perf.theme-dark .tp-warn{ background:rgba(190,18,60,.18); color:#fda4af; }',
  '/* ≤768px：折叠态锚点在左下工具条之上（契约 §3.5 / Lead 集成口径 66px）；',
  '   展开态抬到 128px —— 实测（390×844）工具条占 8~52px、状态条占 58~111px，',
  '   66px 会把满宽面板压进状态条那条带；128px 且限高 ≤300px 时四块',
  '   （信息卡 / 跨中读数 / 状态条 / 工具条）全避开，min(52%,300px) 仍满足',
  '   契约「max-height 52%」的上限要求。 */',
  '@media (max-width:768px){',
  '  .twin-hud.twin-perf{ bottom:66px; bottom:calc(66px + env(safe-area-inset-bottom, 0px)); }',
  '  .twin-hud.twin-perf.open{',
  '    left:10px; right:10px; width:auto; max-width:none; overflow:hidden;',
  '    bottom:128px; bottom:calc(128px + env(safe-area-inset-bottom, 0px));',
  '    max-height:min(52%, 300px); }',
  '  .twin-hud.twin-perf .tp-btn{ min-height:36px; padding:7px 10px; font-size:12.5px; }',
  '  .twin-hud.twin-perf .tp-chip{ min-height:36px; justify-content:flex-end; }',
  '}',
].join('\n');

const PERF_TIER_LABEL = { high: '高', medium: '中', low: '低', ultraLow: '极低' };
const PERF_TIER_BTNS = [['auto', '自动'], ['high', '高'], ['medium', '中'], ['low', '低'], ['ultraLow', '极低']];
const PERF_FPS_BTNS = [30, 60, 120];
const PERF_THEME_BTNS = [['light', '浅色'], ['dark', '深色']];

function perfNum(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
function perfFixed(v, d) { const n = perfNum(v); return n === null ? '--' : n.toFixed(d); }
function perfInt(v) { const n = perfNum(v); return n === null ? '--' : String(Math.round(n)); }
function perfGroup(v) {
  const n = perfNum(v);
  if (n === null) return '--';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function ensurePerfStyle() {
  if (document.getElementById('twinPerfStyle')) return;
  const s = document.createElement('style');
  s.id = 'twinPerfStyle';
  s.textContent = PERF_CSS;
  document.head.appendChild(s);
}
function perfNode(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

/**
 * 构建性能角标。
 * 数据读取顺序：api.perf → window.TWIN_PERF（两者本应同一引用；任取其一都能工作，
 * 因为 mount.js 会把 window.TWIN_PERF 指向 api.perf）。
 */
function buildPerfBadge(api, host) {
  ensurePerfStyle();

  const root = perfNode('div', 'twin-hud twin-perf');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', '实时性能角标');

  /* ---- 展开面板 ---- */
  const panel = perfNode('div', 'tp-panel');
  panel.id = 'twinPerfPanel';
  const head = perfNode('div', 'tp-head');
  head.appendChild(perfNode('b', '', '实时性能'));
  head.appendChild(perfNode('span', 'tp-note', '每秒刷新'));
  /* 面板本体 pointer-events:none（不吞画布交互），内容溢出时靠这个按钮程序化滚动 */
  const moreBtn = perfNode('button', 'tp-btn tp-more', '▾ 更多指标');
  moreBtn.type = 'button';
  moreBtn.hidden = true;
  head.appendChild(moreBtn);
  const closeBtn = perfNode('button', 'tp-btn tp-close', '收起');
  closeBtn.type = 'button';
  head.appendChild(closeBtn);
  panel.appendChild(head);

  /* ---- 指标行（字段名严格对齐契约 §3.3） ---- */
  const rowsBox = perfNode('div', 'tp-rows');
  const cells = {};
  const ROWS = [
    ['fps', 'FPS', (p) => (perfNum(p.fps) === null ? '--' : String(Math.round(p.fps)))],
    ['frameMs', '帧耗时 p50', (p) => perfFixed(p.frameMs, 1) + (perfNum(p.frameMs) === null ? '' : ' ms')],
    ['frameMsP95', '帧耗时 p95', (p) => perfFixed(p.frameMsP95, 1) + (perfNum(p.frameMsP95) === null ? '' : ' ms')],
    ['drawCalls', 'draw calls', (p) => perfInt(p.drawCalls)],
    ['triangles', '三角形数', (p) => perfGroup(p.triangles)],
    ['tier', '画质档', (p) => {
      const name = PERF_TIER_LABEL[p.tier] || (typeof p.tier === 'string' && p.tier ? p.tier : '--');
      const mark = p.auto === true ? '自动' : (p.auto === false ? '手动' : '');
      return mark ? name + '（' + mark + '）' : name;
    }],
    ['pixelRatio', '像素比', (p) => perfFixed(p.pixelRatio === undefined ? p.dpr : p.pixelRatio, 2) +
      (perfNum(p.dpr) !== null && perfNum(p.pixelRatio) !== null && Math.abs(p.dpr - p.pixelRatio) > 0.01
        ? '（屏幕 ' + perfFixed(p.dpr, 2) + '）' : '')],
    ['antialias', '抗锯齿', (p) => (p.antialias === true ? '开' : (p.antialias === false ? '关' : '--'))],
    ['msaaSamples', 'MSAA 采样', (p) => {
      const n = perfNum(p.msaaSamples);
      return n === null ? '--' : (n > 0 ? n + '×' : '关闭');
    }],
    ['theme', '主题', (p) => (p.theme === 'dark' ? '深色' : (p.theme === 'light' ? '浅色' : '--'))],
    ['canvas', '画布后备像素', (p) => (Array.isArray(p.canvas) && p.canvas.length === 2
      ? Math.round(p.canvas[0]) + '×' + Math.round(p.canvas[1]) : '--')],
    ['running', '运行状态', (p) => {
      if (p.running === false || p.visible === false) return '已暂停（后台/离屏）';
      if (p.idle === true) return '渲染中 · 空载降频';
      if (p.interacting === true) return '渲染中 · 交互满帧';
      return '渲染中';
    }],
    ['renders', '累计渲染帧', (p) => perfGroup(p.renders) + (perfNum(p.targetFps) !== null
      ? ' · 目标 ' + Math.round(p.targetFps) + 'fps' : '')],
  ];
  ROWS.forEach((def) => {
    const row = perfNode('div', 'tp-row');
    row.appendChild(perfNode('span', 'tp-k', def[1]));
    const v = perfNode('b', 'tp-v', '--');
    v.dataset.k = def[0];
    row.appendChild(v);
    rowsBox.appendChild(row);
    cells[def[0]] = { node: v, fmt: def[2] };
  });
  panel.appendChild(rowsBox);

  /* ---- 按钮组：只调 api，不碰 localStorage（持久化归 scene.js，契约 §3.2/§3.3） ---- */
  function makeGroup(label, items, attr, onPick) {
    const g = perfNode('div', 'tp-group');
    g.appendChild(perfNode('span', 'tp-glabel', label));
    const btns = [];
    items.forEach((it) => {
      const b = perfNode('button', 'tp-btn', it[1]);
      b.type = 'button';
      b.dataset[attr] = it[0];
      b.addEventListener('click', () => {
        try { onPick(it[0], b); } catch (e) {
          if (window.console && console.warn) console.warn('[twin] 档位切换失败：' + e);
        }
        tick();                                   // 立刻回显，不等下一次 1s 心跳
      });
      g.appendChild(b);
      btns.push(b);
    });
    panel.appendChild(g);
    return btns;
  }
  const fpsBtns = makeGroup('目标帧率', PERF_FPS_BTNS.map((n) => [String(n), String(n)]), 'fps', (v) => {
    if (typeof api.setTargetFps !== 'function') return;
    api.setTargetFps(parseInt(v, 10));            // 30/60/120；超刷新率由 scene.js 钳到刷新率
  });
  const tierBtns = makeGroup('画质档位', PERF_TIER_BTNS, 'tier', (v) => {
    if (typeof api.setQualityTier !== 'function') return;
    api.setQualityTier(v);                        // 'auto'|'high'|'medium'|'low'|'ultraLow'
  });
  const themeBtns = makeGroup('界面主题', PERF_THEME_BTNS, 'theme', (v) => {
    if (typeof api.setTheme !== 'function') return;
    api.setTheme(v);                              // 'light'|'dark'；切换不重建几何
  });

  /* ---- 醒目提示 + 最近档位变化原因 ----
     文案只在真的 insufficient 时才写进 DOM（见 tick）：外部验收脚本常用 textContent
     正则判「有没有出现性能不足提示」，若常驻文案就会永远判真。 */
  const warn = perfNode('div', 'tp-warn', '');
  warn.hidden = true;
  panel.appendChild(warn);

  const reason = perfNode('div', 'tp-reason');
  reason.appendChild(perfNode('span', 'tp-reason-k', '最近档位变化：'));
  const reasonVal = perfNode('i', 'tp-reason-v', '—');
  reason.appendChild(reasonVal);
  panel.appendChild(reason);

  /* ---- 自测链接（离线页面，同源静态文件） ---- */
  const link = perfNode('a', 'tp-link', '性能自测（真机跑分 · 导出 JSON）');
  link.href = '/static/perf.html';
  link.target = '_blank';
  link.rel = 'noopener';
  panel.appendChild(link);

  /* ---- 折叠态 chip ---- */
  const chip = perfNode('button', 'tp-chip');
  chip.type = 'button';
  chip.setAttribute('aria-expanded', 'false');
  chip.setAttribute('aria-controls', 'twinPerfPanel');
  const dot = perfNode('i', 'tp-dot');
  const chipText = perfNode('b', 'tp-chip-text', '-- fps · -- · -- ms');
  const caret = perfNode('span', 'tp-caret', '▾');
  chip.appendChild(dot);
  chip.appendChild(chipText);
  chip.appendChild(caret);

  /* 面板在 DOM 里排在 chip 之前：根元素用 bottom 锚定、内容自上而下排，
     盒子变高时自动向上生长，chip 永远贴在工具条上方不会掉出屏幕。 */
  root.appendChild(panel);
  root.appendChild(chip);
  host.appendChild(root);

  /* ---- 展开 / 折叠 ---- */
  let open = false;

  /**
   * 内容是否真的溢出（task-7 要求 B 的判据），以及翻页按钮的文案。
   * 取舍说明：面板 pointer-events:none 时不能靠手势滚动，所以这里**不**把 auto 还给面板
   * （那会重新吞掉画布交互，手机 390×844 实测 elementFromPoint 从 CANVAS 变 DIV.tp-row），
   * 而是用一个真实按钮（auto，仍可点）程序化滚动 —— 既不挡交互，最后几行也一定看得到。
   */
  function syncMore() {
    const clipped = panel.scrollHeight > panel.clientHeight + 2;
    moreBtn.hidden = !clipped || !open;
    if (!clipped) return;
    const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 4;
    const label = atBottom ? '▴ 回到顶部' : '▾ 更多指标';
    if (moreBtn.textContent !== label) moreBtn.textContent = label;
  }
  moreBtn.addEventListener('click', () => {
    const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 4;
    panel.scrollTop = atBottom ? 0 : panel.scrollHeight;
    syncMore();
  });

  function setOpen(v) {
    open = !!v;
    root.classList.toggle('open', open);
    chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    chip.title = open ? '收起性能角标' : '展开性能角标：实时指标 / 目标帧率 / 画质 / 主题';
    if (open) {
      panel.scrollTop = 0;     // 每次展开都从顶部开始，配 syncMore() 的文案一致
      tick();                  // 展开瞬间就给最新数字，不用等下一次心跳
      syncMore();              // display:none→block 后必须重新量一次 scrollHeight
    }
  }
  chip.addEventListener('click', () => setOpen(!open));
  closeBtn.addEventListener('click', () => setOpen(false));
  setOpen(false);

  /* ---- 每秒从 api.perf 取值刷新（不做任何二次统计） ---- */
  function perfRef() {
    try { return (api && api.perf) || window.TWIN_PERF || null; } catch (e) { return null; }
  }

  let timer = null;
  function tick() {
    if (timer === null) return;                    // 已销毁
    if (!root.isConnected) { window.clearInterval(timer); timer = null; return; }
    const p = perfRef();
    if (!p) {
      chipText.textContent = '-- fps · -- · -- ms';
      dot.className = 'tp-dot';
      return;
    }
    const fps = perfNum(p.fps);
    const target = perfNum(p.targetFps) || 60;
    const tierName = PERF_TIER_LABEL[p.tier] || (typeof p.tier === 'string' && p.tier ? p.tier : '--');

    /* 折叠态一行：契约 §3.5 要求 `60fps · 中 · 15.9ms` */
    chipText.textContent = (fps === null ? '--' : String(Math.round(fps))) + 'fps · ' + tierName +
      (p.auto === false ? '·手动' : '') + ' · ' + perfFixed(p.frameMs, 1) + 'ms';

    /* 状态点四态：达标 / 空载 / 偏低 / 不足。
       空载降频单独一档（青色）——静止时按 idleFps 渲染是契约 §4.2 的设计行为，
       如果这里报红，现场会误判成设备不合格。 */
    let st = 'ok';
    if (p.insufficient === true) st = 'bad';
    else if (fps === null) st = '';
    else if (p.idle === true && fps < target * 0.9) st = 'idle';
    else if (fps >= target * 0.9) st = 'ok';
    else if (fps >= target * 0.6) st = 'warn';
    else st = 'bad';
    dot.className = 'tp-dot' + (st ? ' ' + st : '');
    chip.title = (open ? '收起性能角标' : '展开性能角标：实时指标 / 目标帧率 / 画质 / 主题') +
      '｜当前 ' + (fps === null ? '--' : Math.round(fps)) + 'fps / 目标 ' + Math.round(target) + 'fps' +
      (p.idle === true ? '（静止空载，按 idleFps 渲染）' : '');

    /* 指标行 */
    Object.keys(cells).forEach((k) => {
      let txt;
      try { txt = cells[k].fmt(p); } catch (e) { txt = '--'; }
      if (cells[k].node.textContent !== txt) cells[k].node.textContent = txt;
    });

    /* 按钮高亮：严格按 api.perf 的当前状态，不按点击过什么（避免"点了没生效却亮着"） */
    const canFps = typeof api.setTargetFps === 'function';
    fpsBtns.forEach((b) => {
      const v = parseInt(b.dataset.fps, 10);
      b.classList.toggle('on', perfNum(p.targetFps) !== null && Math.round(target) === v);
      b.disabled = !canFps;
      b.title = canFps ? ('目标帧率 ' + v + 'fps（超过屏幕刷新率会被钳到刷新率）')
        : 'scene.js 尚未提供 api.setTargetFps';
    });
    const canTier = typeof api.setQualityTier === 'function';
    tierBtns.forEach((b) => {
      const v = b.dataset.tier;
      const on = v === 'auto' ? p.auto === true : (p.auto === false && p.tier === v);
      b.classList.toggle('on', !!on);
      b.disabled = !canTier;
      b.title = canTier ? '画质档位：' + b.textContent + (v === 'auto' ? '（自动升降档）' : '（手动，关闭自动升降档）')
        : 'scene.js 尚未提供 api.setQualityTier';
    });
    const canTheme = typeof api.setTheme === 'function';
    themeBtns.forEach((b) => {
      b.classList.toggle('on', b.dataset.theme === p.theme);
      b.disabled = !canTheme;
      b.title = canTheme ? '界面主题：' + b.textContent : 'scene.js 尚未提供 api.setTheme';
    });

    /* insufficient 提示 + 最近档位变化原因（契约 §3.5） */
    const insuff = p.insufficient === true;
    warn.hidden = !insuff;
    if (insuff && !warn.textContent) warn.textContent = '当前设备性能不足，已降为最低画质';
    else if (!insuff && warn.textContent) warn.textContent = '';
    let rs = '';
    if (p.reason) rs = String(p.reason);
    else if (Array.isArray(p.reasons) && p.reasons.length) {
      const last = p.reasons[p.reasons.length - 1];
      rs = String((last && (last.text || last.reason)) || '');
    }
    if (reasonVal.textContent !== (rs || '—')) reasonVal.textContent = rs || '—';

    /* 主题皮肤：深色开关切到 dark 时角标自身也要跟着变，否则白底卡片在暗场里刺眼 */
    root.classList.toggle('theme-dark', p.theme === 'dark');

    syncMore();   // 行文案变化可能改变内容高度（数字变长/换行），翻页按钮要跟着出现或消失
  }

  /* 1s 心跳；页面隐藏时跳过——此时渲染循环已停，写 DOM 只会白耗电 */
  timer = window.setInterval(() => { if (!document.hidden) tick(); }, 1000);

  /* 回到前台立刻补一次：心跳在隐藏期间是跳过的，若等满 1s，角标会短暂地
     继续显示隐藏前的旧状态（实测隐藏期间它还写着「渲染中 · 空载降频」，与事实不符）。
     延后 150ms 是因为 mount.js 的闸门监听注册在本文件之后，先让 api.setActive(true) 生效。 */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) window.setTimeout(tick, 150);
  });

  tick();

  /* 诊断/验证句柄（测试脚本用它判断角标是否真的挂上了；不参与业务逻辑） */
  window.TWIN_PERF_HUD = {
    root,
    tick,
    setOpen,
    isOpen() { return open; },
    panel, chip,
  };

  return { root, tick, setOpen, panel, chip };
}
