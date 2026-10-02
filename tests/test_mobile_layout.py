"""手机端布局回归：文字不许互相压住（/device 面板卡漏出、顶栏标题溢出）。

背景（实测复现，2026-09-30）：
  手机端 /device 上「系统运行」卡片的键值行会漏到卡片外面，压住紧随其后的
  「口径说明」与页脚，视觉上就是「两段文字叠在一起」。根因有两个，都属于 CSS 层：
    ① 桌面的面板限高规则写成 `.dv-stack > .dv-3col`（0,2,0），
       手机档若只写 `.dv-3col`（0,1,0）永远赢不了 → max-height 仍然生效，
       卡片被夹到比内容还矮，而卡片 overflow:visible，内容直接漏出去；
    ② 移动端 `.sh-title` 没有溢出处理，长标题被挤成 3 行把顶栏撑高，压住下方内容
       （`.sh-subtitle` 早就有 nowrap+ellipsis，只有标题漏了）。

本文件分两层守卫：
  · 纯 Python：断言模板里手机档规则的选择器与属性（快、无需浏览器）；
  · 真浏览器几何：跑 headless Edge 逐视口量「可见文本盒是否互相压住」（慢，但只有它能
    证明「真的没压住」——纯文本断言拦不住特异性这类坑）。
  浏览器用例在拿不到浏览器时自动 skip，不让 CI 变红。
"""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
DEVICE = ROOT / "templates" / "device.html"
SHELL = ROOT / "templates" / "_shell.html"

# 判定「压住」的通用探针：只看真正可见（checkVisibility）的叶子文本盒
OVERLAP_JS = r"""
(() => {
  const vis = el => { try { return el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}); }
                      catch (e) { const s = getComputedStyle(el);
                        return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0; } };
  const boxes = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.sh-side')) continue;                 /* 抽屉默认在屏外，不算 */
    if (Array.from(el.children).some(c => c.nodeType === 1)) continue;
    const txt = Array.from(el.childNodes).filter(n => n.nodeType === 3)
                  .map(n => n.textContent.trim()).join('').trim();
    if (!txt) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 6 || !vis(el)) continue;
    boxes.push({el, txt: txt.slice(0, 18), r});
  }
  const hits = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    if (a.el.parentElement === b.el.parentElement) {           /* 同一容器内正常上下排列 */
      const s = a.r.top <= b.r.top ? [a, b] : [b, a];
      if (s[1].r.top >= s[0].r.bottom - 1) continue; }
    const ox = Math.max(0, Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left));
    const oy = Math.max(0, Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top));
    if (ox < 4 || oy < 4 || oy / Math.min(a.r.height, b.r.height) < 0.25) continue;
    hits.push(a.txt + ' ⨯ ' + b.txt + ' (' + Math.round(oy) + 'px)');
  }
  const ti = document.querySelector('.sh-title');
  return {n: hits.length, hits: hits.slice(0, 6),
          titleH: ti ? Math.round(ti.getBoundingClientRect().height) : null,
          titleText: ti ? ti.textContent : null};
})()
"""

# 卡片内容是否漏出卡片（.dv-3col 被限高时就是这样把文字压到页脚上的）
CARD_SPILL_JS = r"""
(() => {
  const col = document.querySelector('.dv-3col');
  if (!col) return {missing: true};
  const cr = col.getBoundingClientRect();
  let deepest = cr.top;
  for (const c of col.querySelectorAll('.card')) {
    const r = c.getBoundingClientRect();
    deepest = Math.max(deepest, r.bottom);
  }
  const sibs = [];
  let n = col.nextElementSibling;
  while (n) { const r = n.getBoundingClientRect(); sibs.push({cls: n.className.toString().slice(0,20),
    top: Math.round(r.top)}); n = n.nextElementSibling; }
  const cs = getComputedStyle(col);
  return {colH: Math.round(cr.height), deepestCardBottom: Math.round(deepest),
          colBottom: Math.round(cr.bottom), minH: cs.minHeight, maxH: cs.maxHeight,
          spill: Math.round(deepest - cr.bottom), sibs};
})()
"""


# ---------------- ① 模板层：手机档规则必须真的能赢 ----------------

def _mobile_block(src: str) -> str:
    m = re.search(r"@media \(max-width: 768px\), print \{(.*?)\n  \}", src, re.S)
    assert m, "device.html 缺少「手机端与打印」媒体查询块"
    return m.group(1)


def test_device_mobile_block_neutralises_panel_height():
    """手机档必须在【同特异性】选择器上解除面板限高，否则卡片内容会漏出压住页脚。"""
    src = DEVICE.read_text(encoding="utf-8")
    block = _mobile_block(src)
    compact = re.sub(r"\s+", " ", block)
    assert ".dv-stack > .dv-3col { min-height: auto; max-height: none; }" in compact, \
        "手机档未用 `.dv-stack > .dv-3col`（与桌面规则同特异性）解除面板限高"
    # 桌面规则的选择器必须是这个形状 —— 手机档改错选择器就会静默失效
    assert ".dv-stack > .dv-3col { flex-grow: 1; flex-shrink: 1; flex-basis: auto;" in re.sub(r"\s+", " ", src), \
        "桌面 .dv-stack > .dv-3col 规则变了：手机档的选择器要同步改"
    # 旧写法（.dv-3col 单类）会让 min-height:0 变成死代码，禁止回退
    assert ".dv-3col { min-height: 0; }" not in compact, \
        "手机档又写回了特异性不足的 `.dv-3col { min-height: 0 }`（永远不生效）"


def test_device_print_also_neutralised():
    """打印与手机端共用同一条媒体查询：打印稿上同样不能被夹住（否则纸上也重叠）。"""
    src = DEVICE.read_text(encoding="utf-8")
    assert "@media (max-width: 768px), print {" in src, "手机档/打印媒体查询被拆开了"
    block = _mobile_block(src)
    assert "max-height: none" in block and "min-height: auto" in block


def test_mobile_topbar_title_single_line_rule_present():
    """移动端顶栏标题必须收敛成单行省略号，否则标题换行撑高顶栏、压住页面内容。"""
    src = SHELL.read_text(encoding="utf-8")
    m = re.search(r"@media \(max-width: 768px\) \{(.*?)\n\}", src, re.S)
    assert m, "_shell.html 缺少 ≤768px 手机档"
    block = re.sub(r"\s+", " ", m.group(1))
    # 标题/副标题：单行 + 省略号 + 可收缩（min-width:0 缺一不可，见模板注释）
    rule = re.search(r"\.sh-title, \.sh-subtitle \{ ([^}]*)\}", block)
    assert rule, "手机档缺少 .sh-title/.sh-subtitle 的收敛规则"
    for prop in ("white-space: nowrap", "overflow: hidden", "text-overflow: ellipsis", "min-width: 0"):
        assert prop in rule.group(1), f"手机档标题收敛规则缺少 `{prop}`：{rule.group(1)}"
    # 顶栏右侧整栏必须参与收缩，否则它会锁死宽度把标题压成「设…」
    side = re.search(r"\.sh-topbar-side \{ ([^}]*)\}", block)
    assert side, "手机档缺少 .sh-topbar-side 收缩规则"
    assert "min-width: 0" in side.group(1) and "flex: 0 1 auto" in side.group(1), \
        f"手机档顶栏侧区未参与收缩：{side.group(1)}"
    # 桌面档不许出现这些（桌面顶栏保持原样）
    desktop_part = src.split("@media (max-width: 768px)")[0]
    assert ".sh-title, .sh-subtitle { white-space" not in desktop_part, \
        "单行收敛规则漏到了桌面作用域"
    assert ".sh-topbar-side { flex: 0 1 auto" not in desktop_part, \
        "顶栏侧区收缩规则漏到了桌面作用域"


# ---------------- ② 真浏览器几何：真的没压住 ----------------
# 复用同一个浏览器会话（模块级 fixture）：一个 headless Edge 覆盖全部视口，
# 避免每个用例都重启浏览器 + Flask（那样 8 个用例要跑两分钟）。

@pytest.fixture(scope="module")
def browser():
    """拿一个已登录的 headless Edge 会话；拿不到浏览器就整组 skip。"""
    import sys
    sys.path.insert(0, str(ROOT / "tests"))
    h = None
    try:
        from browser_harness import Harness
        h = Harness(width=390, height=844, url_path="/login", verbose=False)
        h.start()
        h.page.login(h.username, h.password)
    except Exception as exc:                       # pragma: no cover
        if h is not None:
            h.stop()
        pytest.skip(f"拿不到 headless 浏览器，跳过几何用例：{exc}")
    try:
        yield h
    finally:
        h.stop()


def _open(h, path, viewport):
    import time
    h.page.set_viewport(*viewport)
    h.page.goto(path)
    h.page.wait_for("document.readyState === 'complete'", timeout=25)
    time.sleep(0.9)


@pytest.mark.parametrize("viewport", [(320, 568), (360, 640), (390, 700), (390, 844),
                                      (412, 915), (430, 932), (440, 979)])
def test_device_mobile_no_text_overlap(browser, viewport):
    """手机端 /device 在任何常见视口都不许出现文字互相压住（含卡片内容漏出）。"""
    _open(browser, "/device", viewport)
    spill = browser.page.eval_js(CARD_SPILL_JS)
    assert not spill.get("missing"), "页面缺少 .dv-3col"
    assert spill["spill"] <= 0, (
        f"{viewport} 面板卡内容漏出容器 {spill['spill']}px（会压住页脚）：{spill}")
    assert spill["maxH"] == "none", f"{viewport} 手机端 .dv-3col 仍被限高：{spill['maxH']}"
    d = browser.page.eval_js(OVERLAP_JS)
    assert d["n"] == 0, f"{viewport} 出现文字互相压住：{d['hits']}"


def test_mobile_topbar_title_stays_single_line(browser):
    """手机端顶栏标题必须单行（约 20px 高）；换行会撑高顶栏并压住内容。"""
    _open(browser, "/device", (390, 844))
    d = browser.page.eval_js(OVERLAP_JS)
    assert d["titleText"] == "设备与数据源"
    assert d["titleH"] is not None and d["titleH"] <= 26, \
        f"顶栏标题被挤成多行：高 {d['titleH']}px（应 ≤26px）"
    assert d["n"] == 0, f"手机端顶栏附近出现文字重叠：{d['hits']}"


def test_other_pages_have_no_text_overlap(browser):
    """同一套顶栏规则改了，其它页手机端也必须保持零重叠（防止修一页坏一页）。"""
    for path in ("/trend", "/alarms", "/history", "/settings"):
        _open(browser, path, (390, 844))
        d = browser.page.eval_js(OVERLAP_JS)
        assert d["n"] == 0, f"{path} @390 出现文字重叠：{d['hits']}"
