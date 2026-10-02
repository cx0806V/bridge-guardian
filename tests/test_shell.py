"""P1 骨架与页面迁移回归测试（新增守卫，不改任何既有用例）。

固定在 CI 里，防止后续改动把「搬家」做回去：

  ① 六个一级菜单路由 + 三条新页面路由都必须 200（未登录仍被鉴权拦住）；
  ② 每页都套同一套共享骨架（_shell.html 宏），侧栏/导航只有一处定义；
  ③ 搬家后的 id 必须出现在正确页面，且首页不再残留它们；
  ④ 首页 3D 容器 id 链一个都不许丢（twinStage > twinCanvas + twinLabels + twinHud + twinStatus
     + sceneFallback + sceneLabel）；
  ⑤ 已删除的全屏装饰动效节点不得回到模板里；
  ⑥ 无障碍属性：主导航 aria-label / 当前项 aria-current / 汉堡 aria-expanded ；
  ⑦ 模拟水印文案与单位口径文案存在（诚实边界不许被改掉）。
"""
import re

import pytest

# 页面 → 必须存在的关键 id（搬家后的归属）
PAGE_IDS = {
    "/dashboard": [
        "twinStage", "twinCanvas", "twinLabels", "twinHud", "twinStatus",
        "sceneFallback", "sceneLabel", "simStrip", "demoBanner", "scenarioBar",
        "scenarioCurrent", "strainNum", "thresholdShow", "rateShow", "riskLabel",
        "msRisk", "linkState", "metricStrip", "fsBtn", "connectionStatus", "footLast",
    ],
    "/trend": [
        "chart", "trendSpan", "chartConn", "gauge", "gaugeValue", "gaugeThreshold",
        "miniChart", "miniSpan", "miniCount",
    ],
    "/alarms": [
        "alarmTicker", "tickerTrack", "alarmTable", "alarmDetail", "connectionStatus",
        "donut", "donutWarn", "donutAlarm", "donutCrit", "heroAck", "heroTotal",
        "pendingNum", "cntWarn", "cntAlarm", "cntCrit", "footLast", "footDot",
    ],
    "/device": [
        "healthDevice", "healthSource", "healthState", "healthTimeout", "healthHeartbeat",
        "healthError", "uptimeNum", "sampleCount", "sensorStatus", "sourceBadge",
        "connLight", "uptimeShow", "heroSamples", "heroUptime", "intervalShow",
        "lastSampleTime", "footClock", "footSource", "footLast",
    ],
    "/history": [
        "startTime", "endTime", "tabAlarm", "tabData", "alarmSection", "dataSection",
        "histAlarmTable", "histChart", "avgAll", "maxAll", "minAll", "overCount",
        "overCountLabel", "compare", "historyMessage",
    ],
    "/settings": [
        "settingsForm", "threshold", "interval", "auditList", "message",
        "btnClearData", "btnClearAlarms",
    ],
    "/login": ["username", "password"],
}

# 首页必须【不再】出现的 id：搬走了就必须真的搬干净
DASHBOARD_MUST_NOT = [
    "chart", "gauge", "miniChart", "trendSpan", "chartConn", "gaugeValue",
    "gaugeThreshold", "miniSpan", "miniCount", "donut", "donutWarn", "donutAlarm",
    "donutCrit", "alarmTicker", "tickerTrack", "alarmTable", "alarmDetail",
    "pendingNum", "cntWarn", "cntAlarm", "cntCrit", "heroAck", "heroTotal",
    "healthDevice", "healthSource", "healthState", "healthTimeout", "healthHeartbeat",
    "healthError", "uptimeNum", "sampleCount", "sensorStatus", "heroSamples",
    "heroUptime", "intervalShow", "lastSampleTime",
]

# P1 要求删除的全屏装饰动效（DOM 节点不许回来）
DECOR_NODES = ["particles", "scan-beam", "grid-lines", "crit-glow"]

NAV_HREFS = ["/dashboard", "/trend", "/alarms", "/history", "/device", "/settings"]


def _html(client, path):
    r = client.get(path)
    assert r.status_code == 200, f"{path} 返回 {r.status_code}"
    return r.get_data(as_text=True)


@pytest.mark.parametrize("path", sorted(PAGE_IDS))
def test_page_renders(authed_client, path):
    """七页都必须能渲染（页面路由存在且模板无语法错误）。"""
    _html(authed_client, path)


@pytest.mark.parametrize("path", sorted(PAGE_IDS))
def test_page_key_ids(authed_client, path):
    body = _html(authed_client, path)
    missing = [i for i in PAGE_IDS[path] if f'id="{i}"' not in body]
    assert not missing, f"{path} 缺少关键 id：{missing}"


@pytest.mark.parametrize("path", [p for p in sorted(PAGE_IDS) if p != "/login"])
def test_page_uses_shared_shell(authed_client, path):
    """除登录页外，每页都必须套共享骨架：同一份侧栏 + 顶栏（不是各写一遍菜单）。"""
    body = _html(authed_client, path)
    assert 'class="sh-layout"' in body, f"{path} 未使用共享骨架 .sh-layout"
    assert body.count('id="sSide"') == 1, f"{path} 侧栏必须恰好 1 个"
    assert body.count('class="sh-nav"') == 1, f"{path} 主导航必须恰好 1 个"
    assert body.count('id="sBurger"') >= 1, f"{path} 缺少移动端汉堡按钮"
    for href in NAV_HREFS:
        assert f'href="{href}"' in body, f"{path} 侧栏缺少菜单项 {href}"


@pytest.mark.parametrize("path", [p for p in sorted(PAGE_IDS) if p != "/login"])
def test_nav_accessibility(authed_client, path):
    body = _html(authed_client, path)
    assert 'aria-label="主导航"' in body, f"{path} 主导航缺少 aria-label"
    assert body.count('aria-current="page"') == 1, f"{path} 当前项必须恰好一个 aria-current"
    assert 'aria-expanded=' in body, f"{path} 汉堡按钮缺少 aria-expanded"


def test_dashboard_has_no_moved_ids(authed_client):
    """首页是 3D 独占：已搬家的 id 一个都不许残留。"""
    body = _html(authed_client, "/dashboard")
    leftover = [i for i in DASHBOARD_MUST_NOT if f'id="{i}"' in body]
    assert not leftover, f"/dashboard 仍残留已搬家的 id：{leftover}"


def test_dashboard_keeps_3d_id_chain(authed_client):
    """3D 容器 id 链一个都不能改名（mount.js 用 getElementById 直接取）。"""
    body = _html(authed_client, "/dashboard")
    for i in ["twinStage", "twinCanvas", "twinLabels", "twinHud", "twinStatus",
              "sceneFallback", "sceneLabel"]:
        assert f'id="{i}"' in body, f"3D 容器 id 丢失：{i}"
    # three.js 引导必须仍是本地加载链路（不得改成 CDN 首选）
    assert "/static/js/three-boot.js" in body
    assert "/static/js/twin/mount.js" in body
    assert "cdn.jsdelivr" not in body and "unpkg.com" not in body


@pytest.mark.parametrize("path", sorted(PAGE_IDS))
def test_no_decorative_fx_nodes(authed_client, path):
    """P1 删除的全屏装饰动效节点不得回到模板。"""
    body = _html(authed_client, path)
    hits = [n for n in DECOR_NODES if f'class="{n}' in body or f' {n}"' in body]
    assert not hits, f"{path} 仍含装饰动效节点：{hits}"


def test_honesty_text_present(authed_client):
    """诚实边界：模拟水印 + 单位口径 + 非工程微应变说明，不许被删。

    注意：模板里有「不声称工程级精度」这类否定式声明，是红线要求的写法，
    所以这里只禁止「声称工程级精度 / 实测微应变」这类【肯定式】表述。
    """
    dash = _html(authed_client, "/dashboard")
    assert "模拟演示 · 非真实硬件数据 · 缩尺模型受载变化模拟" in dash
    assert "非工程微应变" in dash
    assert "声称工程级精度" not in dash.replace("不声称工程级精度", "")
    assert "实测微应变" not in dash


def test_login_still_uses_real_form(authed_client):
    body = _html(authed_client, "/login")
    assert 'action="/login"' in body and 'method="POST"' in body


def test_new_routes_require_login(client):
    """三条新页面路由必须和既有页面一样受 login_required 保护。"""
    for path in ("/trend", "/alarms", "/device"):
        r = client.get(path)
        assert r.status_code == 302, f"{path} 未登录应 302 到登录页，实际 {r.status_code}"


def test_existing_routes_unchanged(authed_client):
    """既有路由路径不许变（只许新增）。"""
    for path in ("/dashboard", "/history", "/settings"):
        assert authed_client.get(path).status_code == 200
    for path in ("/api/data", "/api/settings", "/api/audit", "/api/history_data",
                 "/api/history_alarms", "/api/scenario", "/api/export/data",
                 "/api/export/alarms"):
        assert authed_client.get(path).status_code == 200, f"{path} 不可用"


def test_templates_import_shell_macro():
    """侧栏菜单只能有一处定义：页面必须 import 宏，禁止复制粘贴菜单 HTML。"""
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent / "templates"
    shell = (root / "_shell.html").read_text(encoding="utf-8")
    # 宏声明允许带 Jinja 空白控制符（{%- macro ... -%} / {% macro ... %}）
    assert re.search(r"\{%-?\s*macro shell_sidebar\(active\)\s*-?%\}", shell), "缺少 shell_sidebar 宏"
    assert re.search(r"\{%-?\s*macro shell_topbar\(title, subtitle, active\)\s*-?%\}", shell), \
        "缺少 shell_topbar 宏"
    assert re.search(r"\{%-?\s*macro shell_head\(\)\s*-?%\}", shell), "缺少 shell_head 宏（骨架样式）"
    assert re.search(r"\{%-?\s*macro shell_scripts\(\)\s*-?%\}", shell), "缺少 shell_scripts 宏（骨架行为）"
    # 六个菜单条目只在 _shell.html 的 nav_items 宏里定义一次（页面里不许再写菜单 HTML）
    nav_block = re.search(r"\{%-?\s*macro nav_items\(active\)\s*-?%\}(.*?)\{%-?\s*endmacro\s*-?%\}",
                          shell, re.S)
    assert nav_block, "找不到 nav_items 宏（六个一级菜单的唯一来源）"
    nav_src = nav_block.group(1)
    tuples = re.findall(r"\(\s*'([a-z]+)'\s*,\s*'(/[a-z]+)'\s*,\s*'([^']+)'", nav_src)
    assert len(tuples) == 6, f"nav_items 里应恰好 6 个菜单项，实际 {len(tuples)} 个"
    assert tuples == [("dashboard", "/dashboard", "3D 监测"),
                      ("trend", "/trend", "实时趋势"),
                      ("alarms", "/alarms", "报警中心"),
                      ("history", "/history", "历史与导出"),
                      ("device", "/device", "设备与数据源"),
                      ("settings", "/settings", "系统设置")], f"菜单条目定义不一致：{tuples}"
    # 页面侧：必须 import 宏，且不许复制菜单 / 侧栏 / 顶栏 HTML
    for name in ["dashboard.html", "trend.html", "alarms.html", "device.html",
                 "history.html", "settings.html"]:
        src = (root / name).read_text(encoding="utf-8")
        assert '{% import "_shell.html" as shell %}' in src \
            or '{%- import "_shell.html" as shell -%}' in src, f"{name} 未 import 共享骨架宏"
        assert 'class="sh-nav-item' not in src, f"{name} 复制了菜单条目 HTML（应改用宏）"
        assert 'aria-label="主导航"' not in src, f"{name} 复制了主导航 HTML（应改用宏）"


def test_app_py_has_new_page_routes():
    """app.py 的改动只应是新增页面路由（3 条）。"""
    from pathlib import Path
    src = (Path(__file__).resolve().parent.parent / "app.py").read_text(encoding="utf-8")
    for route, fn in (('/trend', "trend_page"), ('/alarms', "alarms_page"), ('/device', "device_page")):
        assert f'@app.route("{route}")' in src, f"缺少新页面路由 {route}"
        assert f"def {fn}(" in src, f"缺少视图函数 {fn}"
    assert src.count('@app.route("/dashboard")') == 1
