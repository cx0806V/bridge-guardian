"""「两页铺满」改动的真机证据脚本（alarms / device）。

用途：验证 /alarms 与 /device 在 1680~2560 宽度下
  ① 内容纵向铺满（视口底部的空白 ≤ 阈值）、
  ② 字号确实按 --pg-s 放大且不小于基线、
  ③ 卡片/环形图/表格真的渲染出来、
  ④ 没有横向溢出。

依赖：本仓库 tests/browser_harness.py（零依赖 headless Edge + 临时端口 Flask + 临时 SQLite）。
命令行等价于多次调用 browser_harness.py，但把所有断言集中成一份可复现报告。

用法（仓库根目录）：
    python tests/check_pages_fill.py                 # 默认三档视口 + 截图
    python tests/check_pages_fill.py --json out.json # 另存 JSON 报告
退出码：0 全部通过；1 有断言失败（报告里逐条列出）；2 运行异常。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser_harness import Harness  # noqa: E402

# 视口：① 用户截图那台（1680×1003 逻辑宽）② 常见 1080p ③ 答辩大屏
VIEWPORTS = [(1680, 1003), (1920, 1080), (2560, 1440)]
# 边界/回归视口：手机（走 app.css 原口径，不允许被缩放污染）、1366×768 小笔记本、以及
# 侧栏收起态（内容区更宽，--pg-s 仍按窗口宽算，因此左列 clamp 不应把表格挤坏）。
EDGE_VIEWPORTS = [(390, 844), (1366, 768)]

# 不该被本次改动影响的其它 shell 页面
OTHER_PAGES = ["/dashboard", "/history", "/settings", "/trend"]

# 量尺：一次 JS 调用取回所有要看的数（避免多次往返）。
MEASURE_JS = r"""
(() => {
  const de = document.documentElement;
  const page = document.querySelector('.sh-page');
  const cards = Array.from(page ? page.querySelectorAll('.card') : []);
  const px = (el, prop) => el ? parseFloat(getComputedStyle(el)[prop]) : null;
  const gapBottom = (el) => el ? Math.round(de.clientHeight - el.getBoundingClientRect().bottom) : null;
  return {
    vw: de.clientWidth,
    vh: de.clientHeight,
    hscroll: de.scrollWidth - de.clientWidth,
    docH: de.scrollHeight,
    pageH: page ? Math.round(page.getBoundingClientRect().height) : null,
    pageW: page ? Math.round(page.getBoundingClientRect().width) : null,
    pageMaxW: page ? getComputedStyle(page).maxWidth : null,
    pgS: page ? getComputedStyle(page).getPropertyValue('--pg-s').trim() : null,
    bodyFont: px(document.body, 'fontSize'),
    /* ⚠️ getComputedStyle 取自定义属性拿到的是「token 流」，不是算好的数
       （反正 calc() 也是原样返回），所以缩放要看「已经算出来的效果」：
       卡内边距、栅格间距、表格行内边距、页面内的正文字号。 */
    textFont: px(document.querySelector('.pa-sub, .dv-sub, .dv-reason'), 'fontSize'),
    tableFont: px(document.querySelector('.data-table'), 'fontSize'),
    gridGap: (() => { const g = page && page.querySelector('.pa-stats, .dv-stats');
      return g ? getComputedStyle(g).gap : null; })(),
    statPad: px(document.querySelector('.pa-stat, .dv-stat'), 'paddingTop'),
    thPad: px(document.querySelector('.data-table th'), 'paddingTop'),
    statCount: cards.length,
    cardTops: cards.map(c => Math.round(c.getBoundingClientRect().top)),
    cardBottoms: cards.map(c => Math.round(c.getBoundingClientRect().bottom)),
    lastCardGap: cards.length ? gapBottom(cards[cards.length - 1]) : null,
    lastElGap: gapBottom(page ? page.lastElementChild : null),
    donutCanvas: !!document.querySelector('#donut canvas'),
    donutW: (() => { const c = document.querySelector('#donut canvas'); return c ? c.width : null; })(),
    alarmRows: document.querySelectorAll('#alarmTable tr').length,
    donutSize: (() => {
      const d = document.getElementById('donut');
      return d ? [Math.round(d.getBoundingClientRect().width), Math.round(d.getBoundingClientRect().height)] : null;
    })(),
    panelH: (() => { const p = document.querySelector('.dv-3col'); return p ? Math.round(p.getBoundingClientRect().height) : null; })(),
    kvH: (() => { const k = document.querySelector('.dv-3col .dv-kv'); return k ? Math.round(k.getBoundingClientRect().height) : null; })(),
    /* 环形图图例是否被卡片右边界裁掉（实测 1680 宽下「严重报警 0」曾溢出）：
       逐个条目比较右边界与卡片内容区右边界，允许 1px 取整误差。 */
    legendOverflow: (() => {
      const card = document.querySelector('#donut') && document.querySelector('#donut').closest('.card');
      if (!card) return null;
      const cs = getComputedStyle(card);
      const limit = card.getBoundingClientRect().right - parseFloat(cs.paddingRight || 0) + 1;
      return Array.from(card.querySelectorAll('.dl-item')).map(i => Math.round(i.getBoundingClientRect().right - limit));
    })(),
    statValueFont: px(document.querySelector('.pa-stat .m-num, .pa-stat .pending-num, .dv-stat-v'), 'fontSize'),
    thPadTop: px(document.querySelector('.data-table th'), 'paddingTop'),
    pageMinH: page ? getComputedStyle(page).minHeight : null
  };
})()
"""


def measure(page, url: str, vp: tuple[int, int], shot: str | None) -> dict:
    # 先设视口再导航：让页面按目标宽度首屏渲染，避免「按旧宽度布局后再触发 resize」
    # 掩盖 --pg-s / 布局的真实表现。
    page.set_viewport(vp[0], vp[1])
    page.goto(url)
    page.wait_for("!!document.querySelector('.sh-page')", timeout=20)
    if url == "/alarms":
        page.wait_for("!!document.querySelector('#donut canvas')", timeout=20)
    import time
    time.sleep(1.6)                       # 等 1Hz 轮询 + ECharts 收敛
    data = page.eval_js(MEASURE_JS)
    data["viewport"] = list(vp)
    data["url"] = url
    if shot:
        data["shot"] = page.screenshot(shot, settle=0.4)["path"]
    return data


def judge(d: dict) -> list[str]:
    """桌面档（≥769px）的判定。阈值刻意留松：铺不满 / 放太小 / 溢出才算失败。"""
    fails = []
    tag = f"{d['url']} @{d['viewport'][0]}x{d['viewport'][1]}"
    if d["hscroll"] > 1:
        fails.append(f"{tag}: 横向溢出 {d['hscroll']}px")
    # 纵向不许被撑出滚动条（「铺满」不能变成「变高」）
    if d["docH"] > d["vh"] + 4:
        fails.append(f"{tag}: 页面被撑高，文档高 {d['docH']}px > 视口 {d['vh']}px（多 {d['docH'] - d['vh']}px）")
    if d["lastElGap"] is None:
        fails.append(f"{tag}: 没找到 .sh-page 子元素")
    elif d["lastElGap"] > 260:
        fails.append(f"{tag}: 纵向没铺满，页面最后一个元素下方空 {d['lastElGap']}px（阈值 260）")
    elif d["lastElGap"] < -20:
        fails.append(f"{tag}: .sh-page 内容溢出到视口外 {-d['lastElGap']}px")
    if d["bodyFont"] < 12.5:
        fails.append(f"{tag}: body 字号 {d['bodyFont']} < 12.5（侧栏/顶栏基线被误伤）")
    # --pg-s = clamp(1, (vw − 1440)/1152 + 1, 1.25)：1440→1.0、1680→1.208、1920→1.25、更宽仍 1.25
    exp = min(1.25, max(1.0, 1 + (d["vw"] - 1440) / 1152))
    # textFont 量的元素可能落在 --fs-sm(12px) 或 --fs-md(13px) 两条口径上（.pa-sub 是 sm、
    # .dv-reason 是 md，取决于哪个先出现在文档里）→ 按「观测缩放」判定：
    # 实测字号 ÷ 12 或 ÷13 都应落在期望缩放附近，而不是硬绑某一条口径。
    if d["textFont"] is None:
        fails.append(f"{tag}: 没测到页面正文字号")
    else:
        obs = min(abs(d["textFont"] / 12 - exp), abs(d["textFont"] / 13 - exp))
        if obs > 0.03:
            fails.append(f"{tag}: 页面小字 {d['textFont']}px 反推出的缩放 {d['textFont'] / 12:.3f} / "
                         f"{d['textFont'] / 13:.3f} 都不等于期望 {exp:.3f}（--pg-s 没生效？）")
    if d["statPad"] is not None and d["statPad"] < 15:
        fails.append(f"{tag}: 卡片内边距 {d['statPad']}px < 15px（calc 缩放退化成 0？）")
    try:
        got = float(d["pgS"] or 0)
    except ValueError:
        got = -1   # token 流（calc 原文）说明这个自定义属性没算出数，属正常现象，不再据此判失败
    if got > 0 and abs(got - exp) > 0.03:
        fails.append(f"{tag}: --pg-s={d['pgS']}（期望≈{exp:.3f}）")
    if d["url"] == "/alarms":
        if not d["donutCanvas"]:
            fails.append(f"{tag}: 环形图 canvas 没渲染")
        elif not d["donutW"] or d["donutW"] < 140:
            fails.append(f"{tag}: 环形图 canvas 宽 {d['donutW']}px 偏小")
        if d["alarmRows"] < 1:
            fails.append(f"{tag}: 处置队列表格没有行")
        if d["statValueFont"] and d["statValueFont"] < 28:
            fails.append(f"{tag}: 指标卡数字 {d['statValueFont']}px 偏小")
    if d["url"] == "/device":
        # 4 张采集参数卡 + 3 张面板卡（离线横幅 .dv-note 是 .card 之外的块，不计入）
        if d["statCount"] != 7:
            fails.append(f"{tag}: 卡片数 {d['statCount']}（期望 7 = 4 指标 + 3 面板）")
        if d["statValueFont"] and d["statValueFont"] < 28:
            fails.append(f"{tag}: 采集参数数字 {d['statValueFont']}px 偏小")
        # 键值行不许被拉成大片空白。自然行高约 53px×缩放；面板被拉高后行高会相应变大，
        # 但必须与面板高度成比例（旧的失控值：2560 宽下 209px/行，4 行数据飘在 934px 卡片里）。
        if d["kvH"] is not None and d["panelH"]:
            natural = 53 * exp
            limit = max(75, min(0.15 * d["panelH"], 2.2 * natural))
            if d["kvH"] > limit:
                fails.append(f"{tag}: 键值行高 {d['kvH']}px 被拉散（面板 {d['panelH']}px，上限 {limit:.0f}px）")
    if d["url"] == "/alarms" and d["donutSize"]:
        # 基线与「改动前的 150px」比，不按视口缩放（环是宽度受限的，缩放不适用）。
        # 左列窄时环会略小于 150px 的等比目标，因为图例（最长「严重报警 + 两位数」）必须完整可见：
        # 实测 1680 宽下 环 164 + 间距 17 + 图例 109 = 290 = 卡片内容宽，空间已用满。
        if d["donutSize"][0] < 150:
            fails.append(f"{tag}: 环形图 {d['donutSize'][0]}px 小于改动前基线 150px")
    if d["url"] == "/alarms" and d["legendOverflow"]:
        worst = max(d["legendOverflow"])
        if worst > 2:
            fails.append(f"{tag}: 图例被卡片右边界裁掉 {worst}px（逐条溢出量 {d['legendOverflow']}）")
    return fails


def judge_mobile(d: dict) -> list[str]:
    """手机档（≤768px）的判定：这一档刻意「不铺满」——单列堆叠、可滚动、--pg-s 钉死为 1。
    只验证不被缩放污染 + 不横向溢出 + 图表照常渲染。"""
    fails = []
    tag = f"{d['url']} @{d['viewport'][0]}x{d['viewport'][1]}（手机档）"
    if d["hscroll"] > 1:
        fails.append(f"{tag}: 横向溢出 {d['hscroll']}px")
    if abs(d["bodyFont"] - 13) > 0.2:
        fails.append(f"{tag}: body 字号 {d['bodyFont']} ≠ 13（手机档应回到 app.css 口径）")
    if d["statPad"] is not None and d["statPad"] < 13:
        fails.append(f"{tag}: 卡片内边距 {d['statPad']}px < 13px")
    if d["url"] == "/alarms":
        if not d["donutCanvas"]:
            fails.append(f"{tag}: 环形图 canvas 没渲染")
        if not d["alarmRows"]:
            fails.append(f"{tag}: 处置队列表格没有行")
    else:
        if d["statCount"] != 7:
            fails.append(f"{tag}: 卡片数 {d['statCount']}（期望 7）")
    return fails


def use_workspace_temp() -> str:
    """把 tempfile 的临时目录挪到仓库内 .workbuddy/tmp，并替换 mkdtemp 实现。

    两个原因（都是宿主环境问题，不是被测页面问题）：
      1) browser_harness 用 tempfile 放 Flask 日志、临时 SQLite 与 Edge 的
         --user-data-dir；受限沙箱下系统 TEMP 目录不可写（PermissionError）。
      2) 即便指到仓库内，沙箱仍拒绝写入「tempfile.mkdtemp() 刚建出来的目录」
         （实测：同一路径下 os.makedirs 建的目录可写，mkdtemp 建的一律 EACCES），
         所以这里用 os.makedirs + 自增序号实现一个等价替身。
    这样既满足沙箱，也方便事后翻日志。
    """
    tmp = os.path.abspath(os.path.join(".workbuddy", "tmp"))
    os.makedirs(tmp, exist_ok=True)
    import itertools
    import tempfile as _tf

    _tf.tempdir = tmp
    counter = itertools.count(1)

    def _mkdtemp(prefix="tmp", suffix="", dir=None):
        base = dir or _tf.tempdir or os.getcwd()
        path = os.path.join(base, f"{prefix}{next(counter):03d}{suffix}")
        os.makedirs(path, exist_ok=True)
        return path

    _tf.mkdtemp = _mkdtemp          # browser_harness 在运行时调用，替身即时生效
    return tmp


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", dest="json_out", default=None)
    ap.add_argument("--shots", default=os.path.join(".workbuddy", "shots"))
    ap.add_argument("--no-shots", action="store_true")
    ap.add_argument("--only", default="", help="只测某个 url，如 /alarms")
    ap.add_argument("--base-url", default=None,
                    help="用已在跑的服务（如 http://127.0.0.1:5000）而不是自己起临时 Flask 服务")
    args = ap.parse_args()

    print("tempdir:", use_workspace_temp())
    urls = ["/alarms", "/device"]
    if args.only:
        urls = [u for u in urls if u == args.only] or [args.only]

    report = {"viewports": VIEWPORTS, "edge_viewports": EDGE_VIEWPORTS,
              "other_pages": OTHER_PAGES, "results": [], "fails": []}
    try:
        with Harness(width=VIEWPORTS[0][0], height=VIEWPORTS[0][1], base_url=args.base_url,
                     url_path="/login", verbose=False) as h:
            h.page.login(h.username, h.password)
            for vp in VIEWPORTS + EDGE_VIEWPORTS:
                for url in urls:
                    shot = None
                    if not args.no_shots:
                        shot = os.path.join(args.shots, f"{url.strip('/')}_{vp[0]}x{vp[1]}.png")
                    d = measure(h.page, url, vp, shot)
                    fails = judge_mobile(d) if vp[0] <= 768 else judge(d)
                    d["fails"] = fails
                    report["results"].append(d)
                    report["fails"].extend(fails)
                    print(f"[{'FAIL' if fails else ' OK '}] {url} @{vp[0]}x{vp[1]}  "
                          f"pageH={d['pageH']} 内容底部空={d['lastElGap']}（末卡={d['lastCardGap']}）  "
                          f"正文={d['textFont']} 卡片内边距={d['statPad']} 表格行距={d['thPad']}  "
                          f"栅格间距={d['gridGap']} hscroll={d['hscroll']}")
                    for f in fails:
                        print("        -", f)
            # 回归：其它 shell 页面在本改动下必须与改动前同口径（.sh-page 只在这两页被覆盖）。
            # /dashboard 没有 .sh-page（它是 3D 大屏骨架），单独放宽等待条件。
            for url in OTHER_PAGES:
                h.page.set_viewport(1680, 1003)
                h.page.goto(url)
                h.page.wait_for("document.readyState === 'complete' && !!document.querySelector('.sh-content')",
                                timeout=30)
                time.sleep(1.2)
                d = h.page.eval_js(MEASURE_JS)
                page_maxw = d.get("pageMaxW")
                fails = []
                if d["hscroll"] > 1:
                    fails.append(f"{url} @1680: 横向溢出 {d['hscroll']}px")
                if page_maxw is not None and page_maxw != "1440px":
                    fails.append(f"{url} @1680: .sh-page max-width={page_maxw}（应为 1440px，说明覆盖泄漏到其它页）")
                if d["bodyFont"] < 12.5:
                    fails.append(f"{url} @1680: body 字号 {d['bodyFont']} 被改小")
                report["other_results"] = report.get("other_results", []) + [
                    {"url": url, "maxW": page_maxw, "hscroll": d["hscroll"], "fails": fails}]
                report["fails"].extend(fails)
                print(f"[{'FAIL' if fails else ' OK '}] {url} @1680x1003 回归  "
                      f"maxWidth={page_maxw} hscroll={d['hscroll']} body={d['bodyFont']}")
                for f in fails:
                    print("        -", f)
            report["console_errors"] = [
                {"level": e.get("level"), "text": str(e.get("text", ""))[:200]}
                for e in h.page.console_errors()
            ]
    except Exception:
        traceback.print_exc()
        print("HARNESS ERROR")
        return 2

    if args.json_out:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_out)), exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
        print("report:", os.path.abspath(args.json_out))
    errs = [e for e in report.get("console_errors", []) if e.get("level") == "error"]
    if errs:
        print(f"console errors: {len(errs)}（前 3 条）")
        for e in errs[:3]:
            print("   ", e["text"])
    print("RESULT:", "PASS" if not report["fails"] else f"FAIL ({len(report['fails'])})")
    return 0 if not report["fails"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
