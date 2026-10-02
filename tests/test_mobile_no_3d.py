"""手机端取消 3D 界面（桌面端不做修改）的回归守卫。

改动口径（用户确认）：
  · 手机端访问 /dashboard → 自动转到 /trend（实时趋势）；
  · 手机端抽屉里隐藏「3D 监测」菜单项；
  · 桌面端【一行都不改】：/dashboard 仍是 3D 数字孪生页，菜单六项齐全，3D 加载链路不变。

两层实现分别守卫：
  ① 服务端：app.py 的 dashboard 视图按 User-Agent 判断（真实手机 302，不发 3D 页面）；
  ② 客户端：static/js/mobile-redirect.js 按视口宽度兜底（≤768px 时 location.replace）。
"""

import re
from pathlib import Path

import app

ROOT = Path(__file__).resolve().parent.parent

# 真实世界 User-Agent 样本（判断口径只看 UA，不看其它头）
DESKTOP_UAS = [
    # Windows Edge（本机实测 154.0.4258.37）
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/154.0.0.0 Safari/537.36 Edg/154.0.4258.37",
    # macOS Safari
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/17.4 Safari/605.1.15",
    # Linux Chrome
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36",
    # 无 UA（curl / 探针 / 部分内嵌浏览器）：不当作手机，保持桌面行为
    "",
]

MOBILE_UAS = [
    # iPhone Safari（iOS 17）
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    # Android Chrome
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Mobile Safari/537.36",
    # Android WebView / 微信内置浏览器
    "Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A.220624.014; wv) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36",
    # iPad（iPadOS 13+ 默认请求桌面站点，但 iPadOS 12 及部分内嵌浏览器仍报 iPad）
    "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/12.1 Mobile/15E148 Safari/604.1",
    # 功能机 / 老浏览器
    "Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/52.0.2743.116 Mobile Safari/537.36 Edge/15.15254",
]


def _get(client, path, ua=None):
    headers = {"User-Agent": ua} if ua is not None else None
    return client.get(path, headers=headers, follow_redirects=False)


# ---------------- ① 服务端 UA 判断 ----------------

def test_mobile_ua_redirects_dashboard_to_trend(authed_client):
    """真实手机 User-Agent → /dashboard 必须 302 到 /trend（不下发 3D 页面）。"""
    for ua in MOBILE_UAS:
        r = _get(authed_client, "/dashboard", ua)
        assert r.status_code == 302, f"手机 UA 未重定向：{ua!r} → {r.status_code}"
        assert r.headers["Location"].endswith("/trend"), \
            f"手机 UA 重定向目标应为 /trend，实际 {r.headers['Location']!r}"


def test_desktop_ua_keeps_dashboard_3d_page(authed_client):
    """桌面端（含无 UA 的探针）必须原样拿到 3D 页面：200 + 完整 3D 加载链路。"""
    for ua in DESKTOP_UAS:
        r = _get(authed_client, "/dashboard", ua)
        assert r.status_code == 200, f"桌面 UA 被误伤：{ua!r} → {r.status_code}"
        body = r.get_data(as_text=True)
        assert 'id="twinCanvas"' in body, f"桌面端 3D 容器丢失（UA={ua!r}）"
        assert "/static/js/three-boot.js" in body and "/static/js/twin/mount.js" in body, \
            f"桌面端 3D 加载链路丢失（UA={ua!r}）"


def test_mobile_ua_does_not_affect_other_pages(authed_client):
    """手机端只改 /dashboard 这一页：其余页面（含 /trend 自身）不受影响，不产生跳转环。"""
    for path in ("/trend", "/alarms", "/device", "/history", "/settings"):
        r = _get(authed_client, path, MOBILE_UAS[0])
        assert r.status_code == 200, f"{path} 被手机端 UA 误伤 → {r.status_code}"


def test_unauthenticated_mobile_still_goes_to_login(client):
    """未登录的手机端：鉴权口径不变（302 → /login），不能先跳到 /trend 泄露路由。"""
    r = _get(client, "/dashboard", MOBILE_UAS[0])
    assert r.status_code == 302
    assert "/login" in r.headers["Location"]


def test_breakpoint_matches_shell_and_app_css():
    """手机端断点必须与共享骨架同值（768px），三处口径一致：app.py / _shell.html / dashboard.html。

    说明：static/app.css 的 `@media (max-width: 760px)` 是旧大屏版式的遗留档位
    （.mobile-nav / #bigscreen 时代），与 P1 之后的 .sh-* 骨架无关 ——
    它既没有 .sh-side/.sh-nav-item 规则，也不再作用于这些页面，所以这里不与之耦合。
    """
    assert app.MOBILE_BREAKPOINT_PX == 768
    shell = (ROOT / "templates" / "_shell.html").read_text(encoding="utf-8")
    assert "var MOBILE_W = 768;" in shell, "_shell.html 的移动端断点不是 768"
    assert "@media (max-width: 768px)" in shell, "_shell.html 缺少 ≤768px 手机档"
    dash = (ROOT / "templates" / "dashboard.html").read_text(encoding="utf-8")
    assert "window.innerWidth <= 768" in dash, "dashboard.html 的窄屏判断不再是 768"


# ---------------- ② 客户端兜底（视口宽度） ----------------

def test_dashboard_loads_client_side_mobile_guard(authed_client):
    """3D 页必须引入客户端兜底脚本，且必须排在 three-boot.js 之前（先跳走再加载 3D）。"""
    body = _get(authed_client, "/dashboard", DESKTOP_UAS[0]).get_data(as_text=True)
    assert "/static/js/mobile-redirect.js" in body, "3D 页未引入手机端兜底跳转脚本"
    assert body.index("/static/js/mobile-redirect.js") < body.index("/static/js/three-boot.js"), \
        "兜底脚本必须排在 three-boot.js 之前，否则手机会先开始下载 three.js"


def test_mobile_guard_is_a_synchronous_script_tag(authed_client):
    """兜底脚本的 <script> 标签必须是同步的：带 defer / async / type=module 都会晚于 3D 加载。"""
    body = _get(authed_client, "/dashboard", DESKTOP_UAS[0]).get_data(as_text=True)
    tags = re.findall(r"<script[^>]*mobile-redirect\.js[^>]*>", body)
    assert len(tags) == 1, f"应有且仅有一个兜底脚本标签，实际 {tags}"
    tag = tags[0]
    assert "defer" not in tag and "async" not in tag and "module" not in tag, \
        f"兜底脚本必须是同步脚本，否则手机会先下载 three.js：{tag}"
    # 且必须位于 <head> 内（早于 <body> 解析）
    assert body.index(tag) < body.index("<body"), "兜底脚本必须放在 <head> 里"


def test_mobile_redirect_js_is_served_and_matches_app_breakpoint(authed_client):
    """兜底脚本必须能被静态路由取到（200），且断点/目标页与服务端口径一致。"""
    r = authed_client.get("/static/js/mobile-redirect.js")
    assert r.status_code == 200, f"mobile-redirect.js 不可访问：{r.status_code}"
    src = r.get_data(as_text=True)
    assert f"MOBILE_BREAKPOINT_PX = {app.MOBILE_BREAKPOINT_PX}" in src, \
        "客户端断点与 app.py 的 MOBILE_BREAKPOINT_PX 不一致"
    assert "innerWidth > MOBILE_BREAKPOINT_PX" in src, "缺少「桌面端直接 return」的判断"
    assert "TREND_PATH = '/trend'" in src and "location.replace(TREND_PATH)" in src, \
        "缺少跳转 /trend 的动作（或目标路径不是 /trend）"


def test_no_redirect_when_breakpoint_removed_from_client_script():
    """脚本里 768 与 /trend 必须成对出现（防止以后只改一处）。"""
    src = (ROOT / "static" / "js" / "mobile-redirect.js").read_text(encoding="utf-8")
    assert src.count("768") >= 1 and "/trend" in src
    assert "window.location.pathname !== '/dashboard'" in src, "缺少防跳转环的前置判断"


# ---------------- ③ 手机端抽屉隐藏「3D 监测」入口（桌面端不变） ----------------

def test_nav_dashboard_item_carries_mobile_hide_flag(authed_client):
    """六项菜单仍全部渲染（桌面端不变），但「3D 监测」多了手机端隐藏标记。"""
    for path in ("/dashboard", "/trend"):
        body = _get(authed_client, path, DESKTOP_UAS[0]).get_data(as_text=True)
        assert body.count('class="sh-nav-item') == 6, f"{path} 菜单条目数不再是 6"
        assert body.count('data-mobile-hide="1"') == 1, \
            f"{path} 应恰好有一个手机端隐藏的菜单项"
        m = re.search(r'<a class="sh-nav-item[^>]*data-mobile-hide="1"[^>]*>', body)
        assert m, f"{path} 找不到带手机端隐藏标记的菜单项"
        assert 'href="/dashboard"' in m.group(0), "手机端隐藏的应是「3D 监测」(/dashboard)"
        for href in ("/trend", "/alarms", "/history", "/device", "/settings"):
            assert f'href="{href}"' in body, f"{path} 桌面端菜单项 {href} 丢失"


def test_mobile_hide_rule_only_inside_mobile_media_query(authed_client):
    """隐藏规则必须收紧在 ≤768px 的媒体查询内 —— 桌面端绝不能被隐藏。"""
    body = _get(authed_client, "/trend", DESKTOP_UAS[0]).get_data(as_text=True)
    rule = ".sh-side .sh-nav-item[data-mobile-hide] { display: none; }"
    assert rule in body, "缺少手机端菜单隐藏规则"
    # 定位规则位置，并确认它落在手机档媒体查询块内（其后最近的 @media 声明是 768px）
    pos = body.index(rule)
    before = body[:pos]
    last_media = before.rfind("@media")
    assert last_media != -1, "隐藏规则不在任何媒体查询内（会隐藏桌面端菜单）"
    mq = before[last_media:last_media + 60]
    assert "max-width: 768px" in mq, f"隐藏规则所在的媒体查询不是手机档：{mq!r}"
