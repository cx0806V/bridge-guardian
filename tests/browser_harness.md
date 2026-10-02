# tests/browser_harness.py —— 零依赖 headless Edge 截图/断言工具

**定位**：本机没有 Playwright / Selenium / websocket-client，也没有 node/npm。
这份工具用**纯 Python 标准库**手写了一个最小 Chrome DevTools Protocol（CDP）
客户端，直接驱动本机 Microsoft Edge（Chromium 内核）的 headless 模式，用来
**真实地**验证大屏页面（尤其是中央 3D 数字孪生场景）到底渲染出了什么。

它是「3D 效果是否真的画出来了」的唯一可信手段：其余任何"我改了代码，
应该没问题"的说法都不算证据。

---

## 1. 依赖与环境

| 项 | 值 |
| --- | --- |
| Python | 系统 `python`（本机 3.14.7），**不需要 pip 安装任何东西** |
| 用到的标准库 | `socket` `struct` `base64` `hashlib` `zlib` `json` `subprocess` `urllib` `tempfile` `argparse` |
| 浏览器 | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（实测 154.0.4258.37） |
| 服务端 | 项目自身 Flask 应用（子进程方式拉起，随机端口 + 临时 SQLite） |

没有对 `requirements.txt` 做任何改动；没有依赖 Pillow —— PNG 像素统计是
本文件用 `zlib` + 反滤波手写实现的（见 `png_stats()`）。

---

## 2. 快速开始

在**仓库根目录**执行（命令已在 PowerShell 与 cmd 下实测）：

```powershell
# 最常用：截 1920x1080 大屏 + 打印控制台错误 + 解析 PNG 像素统计
python tests/browser_harness.py --url /dashboard --out .workbuddy/shots/x.png `
    --width 1920 --height 1080 --wait-ms 4000
```

```powershell
# 完整自检（登录 → 等 echarts 就绪 → JSON 断言 → WebGL 探测 → 截图 → 报告）
python tests/browser_harness.py --url /dashboard `
    --out .workbuddy/shots/harness_selfcheck.png `
    --width 1920 --height 1080 --wait-ms 4000 --webgl `
    --wait-for "!!window.echarts" `
    --eval "document.querySelectorAll('canvas').length" `
    --eval "!!window.echarts" `
    --eval "document.title" `
    --assert "document.querySelectorAll('canvas').length > 0" `
    --json-report .workbuddy/shots/harness_selfcheck.json
```

```powershell
# WebGL 开关探测矩阵（逐个真实启动浏览器，8 个组合，约 2 分钟）
python tests/browser_harness.py --probe-matrix --json-report .workbuddy/shots/webgl_probe_matrix.json

# 只分析一张已有 PNG（不需要浏览器，约 3 秒 / 1920x1080）
python tests/browser_harness.py --image-stats .workbuddy/shots/x.png --json
```

**WebGL 探测 3D 场景是否真的在画**（等 three.js 渲染出 canvas 后再截图）：

```powershell
python tests/browser_harness.py --url /dashboard --out .workbuddy/shots/twin.png `
    --width 1920 --height 1080 --wait-ms 6000 `
    --wait-for "!!document.querySelector('canvas#twin, #twin-canvas, .twin-scene canvas')" `
    --eval "Array.from(document.querySelectorAll('canvas')).map(c=>({id:c.id,w:c.width,h:c.height}))" `
    --eval "!!(window.BridgeThree && window.BridgeThree.status)" `
    --eval "window.BridgeThree ? window.BridgeThree.status : null"
```

---

## 3. CLI 参数

| 参数 | 说明 |
| --- | --- |
| `--url` | 相对路径（自动拼 base_url）或绝对 URL，默认 `/dashboard` |
| `--out` | 截图输出路径（png）；不给就不截图 |
| `--width/--height` | 视口尺寸，同时决定截图分辨率，默认 1920x1080 |
| `--device-scale-factor` | DPR，默认 1.0 |
| `--wait-ms` | 导航完成后额外等待毫秒（等图表/3D 渲染收敛） |
| `--wait-for EXPR` | 轮询等待 JS 表达式为真，可重复；超时即失败 |
| `--eval EXPR` | 执行并打印 JSON 值，可重复 |
| `--assert EXPR` | 断言为真，否则退出码 1，可重复 |
| `--login / --no-login` | 是否先走真实登录表单，默认 `--login` |
| `--username/--password` | 默认 `admin` / `123456`（与 `config.py` 默认一致） |
| `--base-url` | 用已有服务（给了就不再自己起 Flask） |
| `--webgl` | 在页面里探测 WebGL 并打印渲染器信息 |
| `--webgl-args A,B` | 覆盖默认软件 WebGL 参数（逗号分隔） |
| `--no-webgl-args` | 不加软件光栅化参数（走真 GPU 路径，见第 5 节） |
| `--extra-arg` | 追加任意浏览器参数，可重复 |
| `--strict-console`（别名 `--fail-on-console-error`） | 有控制台错误 / 资源 4xx-5xx 时退出码 2 |
| `--full-page` | 整页截图（用 `Page.getLayoutMetrics` 的 clip） |
| `--json-report PATH` | 落一份完整 JSON 报告（含 WebGL / eval / 断言 / 控制台 / 像素统计） |
| `--probe` / `--probe-matrix` | WebGL 单次探测 / 开关组合矩阵 |
| `--image-stats PATH` `--json` | 只做 PNG 像素分析 |
| `--timeout` | 各类等待超时，默认 40s |
| `--serve --port N` | 内部子命令：用随机端口跑 Flask，方便手工调试 |

### 退出码语义（诚实优先）

| 码 | 含义 |
| --- | --- |
| `0` | 成功：截图写出且非全黑、所有 `--assert` 通过、无致命异常 |
| `1` | 真失败：登录失败、导航/wait-for 超时、JS 求值异常、断言为假、截图全黑 |
| `2` | 用法错误（没给任何动作），或 `--strict-console` 下存在控制台/网络错误 |
| `130` | Ctrl+C |

**默认不因控制台错误而失败**：改造期页面常有既存报错，截图证据本身仍然有效；
要"零报错"卡口就加 `--strict-console`。控制台错误与网络错误始终会被完整打印。

---

## 4. 作为 Python 库使用

```python
import sys, os
sys.path.insert(0, os.path.abspath("tests"))
from browser_harness import Harness, png_stats

with Harness(width=1920, height=1080, url_path="/dashboard") as h:
    h.page.login("admin", "123456")          # 走真实表单
    h.page.goto("/dashboard")
    h.page.wait_for("!!window.echarts", timeout=15)
    print(h.page.eval_js("document.querySelectorAll('canvas').length"))
    print(h.page.console_logs())             # console/异常全量
    print(png_stats(h.page.screenshot(".workbuddy/shots/x.png")["path"]))
```

高层 API（`Page`）：

| 方法 | 说明 |
| --- | --- |
| `goto(url, timeout=30)` | 等待 `Page.loadEventFired`，退化路径轮询 `readyState` |
| `eval_js(expr, await_promise=False)` | `Runtime.evaluate` + `returnByValue`，返回 JSON 值；JS 抛异常抛 `JSEvalError` |
| `wait_for(expr, timeout, poll=0.2)` | 轮询 `!!(expr)`，超时抛 `TimeoutError`（带最后一次取值） |
| `screenshot(path, w, h, dsf, full_page=False)` | `Page.captureScreenshot`，返回 `{path, bytes}` |
| `set_viewport(w, h, dsf=1.0)` | `Emulation.setDeviceMetricsOverride`（同时决定截图尺寸） |
| `console_logs(level=None)` / `console_errors()` | `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` + `Log.entryAdded` |
| `network_errors` | `Network.loadingFailed` + 状态码 ≥400 的响应 |
| `login(user, pwd)` | 填 DOM 后 `form.submit()`，等落到 `/dashboard`，失败带页面文本 |
| `webgl_info()` | 离屏探测 WebGL：渲染器 + 真 clear + 真 `readPixels` 回读 |

底层组件也可单独用：`WebSocketClient`（RFC6455 子集，客户端帧强制加掩码）、
`CDPSession`（JSON-RPC + 事件队列）、`Browser`（启动/连接/收进程树）、
`FlaskServer`（随机端口 + 临时 DB）。

---

## 5. headless 下的 WebGL：实测结论（重要）

### 5.1 结论

**本机 headless Edge 的 WebGL 完全可用**，而且不只是软件路径可用 ——
不加任何特殊开关时它用的是真显卡（Intel UHD Graphics / D3D11）。
`--probe-matrix` 实测 8/8 组合全部 `webgl_ok=true` 且截图主色正确。

默认参数采用**确定性优先**的软件光栅化组合：

```
--headless=new --use-angle=swiftshader --enable-unsafe-swiftshader
```

理由：`--enable-unsafe-swiftshader` 是 Chromium 128+ 放开软件 WebGL 回退的
必需开关；显式走 SwiftShader 后结果**不依赖宿主机显卡/驱动/远程桌面状态**，
换机器复现时更稳。代价是渲染慢，但单帧截图无所谓。

### 5.2 实测矩阵（`--probe-matrix`，800x600，`webgl_probe_matrix.json` 有完整 JSON）

| WebGL | 截图 | ANGLE renderer | 参数组合 |
| --- | --- | --- | --- |
| true | true | `ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0, D3D11)` | `--headless=new`（裸开关，走真 GPU） |
| true | true | 同上（Intel D3D11） | `--headless=new --enable-unsafe-swiftshader` |
| true | true | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` | **`--headless=new --use-angle=swiftshader --enable-unsafe-swiftshader`（默认）** |
| true | true | SwiftShader | `+ --use-gl=angle` |
| true | true | SwiftShader | `+ --in-process-gpu` |
| true | true | SwiftShader | `--use-angle=swiftshader-webgl` |
| true | true | SwiftShader | `--headless`（旧开关） |
| true | true | SwiftShader | `+ --disable-gpu` |

判定口径不是"看开关是否被接受"，而是三件事同时成立：
1. `gl.getParameter(VERSION)` 返回 `WebGL 2.0 (OpenGL ES 3.0 Chromium)`；
2. 离屏 canvas `clearColor(0.2,0.6,0.9)` 后 `readPixels` 回读中心像素 ≈ `[51,153,230]`；
3. 截图中该像素区域主色 ≈ `RGB(51,153,229)`（矩阵里实测 `[52,156,228]`，
   8bit 量化误差内），即 **WebGL 的内容真的进了 PNG**。

### 5.3 不确定性 / 限制

* **不要假设换台机器也一样**。若宿主机是虚拟机 / 远程桌面 / 无 GPU 驱动，
  裸 `--headless=new` 可能拿不到 WebGL；默认组合（SwiftShader）才是保底路径。
  换机器务必先跑一次 `--probe-matrix`。
* SwiftShader 是软件光栅化，**帧率远低于真机**。截图（单帧）没问题，
  但不要用它评估流畅度；更不要用 headless 帧率当作性能证据。
* `--disable-gpu` 在实测中**没有**破坏 SwiftShader 路径，但它不影响结论，
  默认不加。
* WebGL 上下文可能因驱动原因丢失（`contextLost`）；`--webgl` 会把该字段打出来。
* 本工具的 WebGL 探测**故意不往 DOM 里插 canvas**（离屏 canvas 一样能
  `getContext`/`clear`/`readPixels`）。插进 DOM 会污染被测页面的
  canvas 计数与截图内容 —— 早期版本踩过这个坑，`--eval` 数出来 5 个而不是 4 个。

---

## 6. 已发现的既存问题（与本次工具无关，如实记录）

在**未登录无关、纯页面加载**路径上，控制台稳定出现：

| 级别 | 内容 | 判定 |
| --- | --- | --- |
| error | `Failed to load resource: 404 (NOT FOUND) @ /favicon.ico` | 既存：应用没有 favicon 路由，浏览器默认请求 |
| warning | `<meta name="apple-mobile-web-app-capable"> is deprecated. Please include <meta name="mobile-web-app-capable">` | 既存：`templates/dashboard.html` 的老式 meta |
| warning | `[.WebGL-...] GL Driver Message (OpenGL, Performance, ...): GPU stall due to ReadPixels` | **本工具自身**触发（WebGL 探测里的 `readPixels`），不是应用缺陷 |

用 `--strict-console` 卡"零错误"时，前两条需要先被业务侧修掉
（favicon + 新式 meta），否则该模式会一直红。

### 6.1 工具抓到真实 3D 缺陷的一次实例（2026-09-29 09:37，中间态）

`templates/dashboard.html` sha256=`88D4E7C4…F284D` 时，工具一次性抓到：

```
eval_js(window.BridgeThree ? window.BridgeThree.status : null)
  => {"ready": true, "source": "local", "error": null}          # three.js 本地模块加载 OK
eval_js(document.querySelectorAll('#twinCanvas canvas').length) => 1   # canvas 建出来了
eval_js(document.getElementById('twinStatus').textContent)
  => "3D 场景不可用：nm.getNormalMatrix is not a function"        # 场景代码自己崩了
console: [warning/console] [twin] 3D 场景降级：nm.getNormalMatrix is not a function
eval_js(getComputedStyle(document.getElementById('sceneFallback')).display) => "flex"
```

即：**three.js 与 WebGL 都没问题（`--webgl` 同一时刻返回 WebGL 2.0 + 像素回读正确），
是场景代码调用了非矩阵对象上的 `getNormalMatrix`**。注意页面回退文案写的是
"当前环境不支持 WebGL"，与实际原因不符 —— 这类"看起来像环境问题、其实是代码问题"
的误判，只有真浏览器探测才能拆穿。

（写工具时该文件仍在被 Lead 改动，属正常中间态；此处仅作为能力示例记录。）

---

## 7. 实现要点（踩过的坑）

1. **客户端 WebSocket 帧必须加掩码**（RFC6455），否则 Chrome 直接断连。
   服务端帧不加掩码，`recv_message()` 两种情况都处理。
2. 页面级调试地址要自己拼：`GET /json/version` → `GET /json/list` 取
   `type=="page"` 的 `webSocketDebuggerUrl`；没有页面 target 时用
   **`PUT /json/new?about:blank`**（Chrome/Edge 111+ 对 `GET` 返回 405）。
3. 握手时**不要**发 `Origin` 头，否则需要额外的 `--remote-allow-origins`
   （本工具仍加了该参数以备不测）。
4. 截图尺寸由 `Emulation.setDeviceMetricsOverride` 决定，与 `--window-size`
   双保险；改视口后必须留 ~0.3s 让 ECharts/布局收敛再截。
5. Edge 在 Windows 上会派生许多子进程，关闭时用 `taskkill /F /T /PID` 收进程树，
   否则临时 profile 目录删不掉、调试端口不释放。
6. 登录走真实表单（`/login` 的 `username` / `password` 字段），登录接口豁免 CSRF；
   登录后 `session["user"]` 建立，后续 `/api/*` 用同一 profile 的会话 Cookie。
7. `FlaskServer` 用 `-c` 内联脚本 `import app; simulator.start(); app.run(...)`：
   既真正跑采集线程（与原 `python app.py` 行为一致），又能自定义随机端口，
   并通过 `DB_PATH` 指向临时目录 —— **绝不碰 `bridge.db`**。
8. 认证类环境变量（`APP_USERNAME/APP_PASSWORD/APP_PASSWORD_HASH/SECRET_KEY`）
   被显式钉死，避免宿主机环境导致登录行为漂移。
9. PNG 像素统计纯标准库：`IHDR` + `IDAT` → `zlib.decompress` → 逐行反滤波
   （None/Sub/Up/Average/Paeth）→ 亮度均值/标准差/非黑比例/抽样颜色数。
   1920x1080 约 3-4 秒。
   "全黑/全空"判定 = 非黑像素比例 < 0.1% **或**（抽样颜色 ≤2 种且主色是黑的）；
   单色但明亮的图只算 `looks_uniform`，不算 blank。
10. Windows 下 Python 输出被管道重定向时会退回 cp936，中文日志会乱码；
    `main()` 里把 stdout/stderr 强制 `reconfigure(encoding="utf-8")`。

---

## 8. 证据文件（本工具自检产物）

| 文件 | 内容 |
| --- | --- |
| `.workbuddy/shots/harness_selfcheck.png` | 1920x1080 大屏截图（改造前基线） |
| `.workbuddy/shots/harness_selfcheck.json` | 同次运行的完整 JSON 报告 |
| `.workbuddy/shots/harness_selfcheck.log` | 同次运行的 stdout（含控制台错误清单） |
| `.workbuddy/shots/webgl_probe_matrix.json` | 8 组 WebGL 开关实测结果 |
| `.workbuddy/shots/positive_waitfor.log` | `--wait-for` / canvas 明细正向用例 |
| `.workbuddy/shots/negative_assert.log` | `--assert` 失败 ⇒ exit 1 |
| `.workbuddy/shots/negative_waitfor.log` | `--wait-for` 超时 ⇒ exit 1（并显示未登录 302） |
| `.workbuddy/shots/check_no_db_pollution.log` | 跑完整流程前后 `bridge.db` 的 mtime_ns+大小+sha256 完全一致 |
| `.workbuddy/shots/_twin_state_probe.png/.log` | 3D 场景中间态快照（抓到第 6.1 节的缺陷） |
| `.workbuddy/shots/check_lib_api.log` | 第 4 节「作为库使用」代码片段的真实运行输出 |

单次完整自检耗时约 **14 秒**（起服务 ~2s + 起浏览器 ~3s + 登录导航 ~3s +
等待 4s + PNG 分析 ~3s）。
