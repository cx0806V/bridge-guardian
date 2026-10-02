#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桥体卫士 —— 零依赖浏览器验证工具（headless Edge + 原生 CDP）

为什么存在
----------
本项目要验收「大屏中央 3D 数字孪生场景」是否真的画出来了。本机没有
Playwright / Selenium / websocket-client，也没有 node/npm，所以这里用
**纯 Python 标准库**（socket / struct / base64 / zlib / json / subprocess /
urllib）手写了一个最小 Chrome DevTools Protocol 客户端，直接驱动本机
Microsoft Edge（Chromium 内核）的 headless 模式，完成：

  * 起一个临时 Flask 服务（随机端口 + 临时 SQLite，不污染 bridge.db）
  * 起 headless Edge（独立临时 profile + 软件 WebGL 开关）
  * 通过 HTTP /json/version、/json/list 拿页面级 WebSocket 调试地址
  * 自己做 WebSocket 握手与帧编解码（客户端帧强制加掩码）
  * 高层 API：goto / eval_js / wait_for / screenshot / console_logs /
    set_viewport / login
  * 截图后用标准库解析 PNG（IHDR + IDAT + 反滤波）统计像素，判断是否
    全黑 / 全空，不依赖 Pillow

重要诚实边界
------------
headless Chromium 的 WebGL **不是免费的**：默认情况下 GPU 被禁用，
WebGL 上下文可能拿不到或渲染出全黑画面。本工具用 `--probe` /
`--probe-matrix` 真刀真枪地探测开关组合，并把探测结果原样打印；
如果某个组合拿不到 WebGL，它会如实报告 `ok: false`，绝不假装成功。

用法（在仓库根目录执行）
------------------------
    # 自检：截图大屏（自动起服务 + 起浏览器 + 自动登录）
    python tests/browser_harness.py --url /dashboard --out .workbuddy/shots/x.png \
        --width 1920 --height 1080 --wait-ms 4000

    # WebGL 开关探测矩阵（找可用的软件光栅化组合）
    python tests/browser_harness.py --probe-matrix

    # 单次 WebGL 探测 + 截一张 WebGL 画布图
    python tests/browser_harness.py --probe --out .workbuddy/shots/webgl.png

    # 只分析一张已有 PNG（不需要浏览器）
    python tests/browser_harness.py --image-stats .workbuddy/shots/x.png --json

只有当依赖系统 `python`（3.x，本项目为 3.14）与 Edge 时才能跑；不需要 pip 安装。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

__all__ = [
    "WebSocketClient",
    "CDPSession",
    "Browser",
    "FlaskServer",
    "Page",
    "Harness",
    "png_stats",
    "JSEvalError",
    "CDPError",
]

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------- Edge 定位

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
]

# 与浏览器无关的稳定启动参数（可复现截图用）
BASE_BROWSER_ARGS = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-mode",
    "--disable-component-update",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars",
    "--disable-dev-shm-usage",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
]

# 关键：headless 下要让 WebGL 走 SwiftShader 软件光栅化。
# Chromium 128+ 起，软件 WebGL 回退需要显式 --enable-unsafe-swiftshader，
# 否则 getContext('webgl') 直接返回 null（并有 "SwiftShader is not allowed" 警告）。
DEFAULT_WEBGL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]

# 探测矩阵：每个条目是 (名称, 额外参数)。--probe-matrix 会逐个真实启动浏览器。
PROBE_MATRIX = [
    ("headless=new bare", ["--headless=new"]),
    ("headless=new +unsafe-swiftshader",
     ["--headless=new", "--enable-unsafe-swiftshader"]),
    ("headless=new +angle=swiftshader +unsafe",
     ["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
    ("headless=new +use-gl=angle +angle=swiftshader +unsafe",
     ["--headless=new", "--use-gl=angle", "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader"]),
    ("headless=new +angle=swiftshader +unsafe +in-process-gpu",
     ["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
      "--in-process-gpu"]),
    ("headless=new +angle=swiftshader-webgl +unsafe",
     ["--headless=new", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader"]),
    ("headless (legacy switch) +angle=swiftshader +unsafe",
     ["--headless", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
    ("headless=new +angle=swiftshader +unsafe +disable-gpu",
     ["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
      "--disable-gpu"]),
]

# 在 about:blank 上探测 WebGL：拿上下文信息 + 真清屏 + 真读回像素
JS_WEBGL_PROBE = r"""
(() => {
  const out = { ok: false };
  try {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 200;
    // 关键：**不**插入 DOM。插入会污染待验证页面的截图与 canvas 计数；
    // 离屏 canvas 同样可以 getContext / clear / readPixels。
    let gl = null;
    try { gl = c.getContext('webgl2'); } catch (e) { out.webgl2Error = String(e); }
    if (!gl) { try { gl = c.getContext('webgl'); } catch (e) { out.webgl1Error = String(e); } }
    if (!gl) { out.error = 'getContext("webgl2"/"webgl") returned null'; return out; }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.ok = true;
    out.api = String(gl.getParameter(gl.VERSION) || '').indexOf('2.0') >= 0 ? 'webgl2' : 'webgl1';
    out.version = String(gl.getParameter(gl.VERSION));
    out.vendor = String(gl.getParameter(gl.VENDOR));
    out.renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
                              : gl.getParameter(gl.RENDERER));
    out.unmaskedVendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : null;
    out.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    out.contextLost = gl.isContextLost();
    out.contextAttributes = gl.getContextAttributes ? gl.getContextAttributes() : null;
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0.2, 0.6, 0.9, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const px = new Uint8Array(4);
    gl.readPixels(160, 100, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out.centerPixel = Array.from(px);
    out.pixelMatchesClearColor = Math.abs(px[0] - 51) <= 2 && Math.abs(px[1] - 153) <= 2 &&
                                 Math.abs(px[2] - 229) <= 2;
    return out;
  } catch (e) { out.error = String(e); return out; }
})()
"""

# 探测矩阵用的「全屏 WebGL 画布」页面：clear 成固定颜色，验证截图里真有 WebGL 像素
JS_WEBGL_FILL = r"""
(() => {
  document.documentElement.style.margin = '0';
  document.body.style.margin = '0';
  const c = document.createElement('canvas');
  c.width = window.innerWidth || 800;
  c.height = window.innerHeight || 600;
  c.id = 'webgl-probe';
  c.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647';
  document.body.appendChild(c);
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) { return { ok: false, error: 'no webgl context' }; }
  gl.viewport(0, 0, c.width, c.height);
  gl.clearColor(0.2, 0.6, 0.9, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { ok: true, width: c.width, height: c.height };
})()
"""


# =============================================================== 基础工具

def free_port() -> int:
    """向系统要一个当前空闲的 TCP 端口。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def find_edge(explicit: str | None = None) -> str:
    """定位 msedge.exe；找不到就抛错（不猜、不静默降级）。"""
    candidates = ([explicit] if explicit else []) + EDGE_CANDIDATES
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    raise FileNotFoundError(
        "找不到 msedge.exe，请用 --edge-path 指定。已尝试：" + repr(candidates))


def _http_json(url: str, method: str = "GET", timeout: float = 5.0):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else None


# =============================================================== WebSocket

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class CDPError(RuntimeError):
    """CDP 协议层错误（命令返回 error 字段）。"""


class JSEvalError(RuntimeError):
    """Runtime.evaluate 里 JS 抛异常。"""


class WebSocketClient:
    """极简 WebSocket 客户端（RFC 6455 子集）：只处理我们需要的场景。

    * 客户端 → 服务端：强制加掩码（协议要求，不加 Chrome 会直接断开）
    * 服务端 → 客户端：支持文本帧、二进制帧、分片（continuation）、
      ping/pong、close
    * 不做 permessage-deflate 协商（Chrome DevTools 端点默认也不压缩）
    """

    def __init__(self, url: str, timeout: float = 15.0):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ("ws", "wss"):
            raise ValueError(f"不支持的 WebSocket scheme: {url!r}")
        if parsed.scheme == "wss":
            raise ValueError("本项目只需要 ws://（DevTools 本地端点）")
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 80
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        self.url = url
        self.host = host
        self.port = port
        self._buf = bytearray()
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        handshake = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        self.sock.sendall(handshake.encode("ascii"))
        # 读取握手响应（到 \r\n\r\n 为止）
        deadline = time.monotonic() + timeout
        while b"\r\n\r\n" not in self._buf:
            if time.monotonic() > deadline:
                raise TimeoutError("WebSocket 握手超时")
            self.sock.settimeout(max(0.1, deadline - time.monotonic()))
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("WebSocket 握手期间连接被关闭")
            self._buf += chunk
        head, _, rest = bytes(self._buf).partition(b"\r\n\r\n")
        self._buf = bytearray(rest)
        lines = head.decode("latin-1").split("\r\n")
        status = lines[0]
        if "101" not in status:
            raise ConnectionError(f"WebSocket 握手失败：{status!r}")
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        expect = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        got = headers.get("sec-websocket-accept", "")
        if got != expect:
            raise ConnectionError(
                f"WebSocket Sec-WebSocket-Accept 不匹配：got={got!r} expect={expect!r}")
        self.closed = False

    # ---------------- 底层收发 ----------------

    def _read_exact(self, n: int, deadline: float) -> bytes:
        while len(self._buf) < n:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"等待 {n} 字节超时（已缓冲 {len(self._buf)} 字节）")
            self.sock.settimeout(max(0.05, min(remaining, 5.0)))
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                continue
            except OSError as exc:  # 连接被对端重置
                raise ConnectionError(f"WebSocket 读取失败：{exc}") from exc
            if not chunk:
                raise ConnectionError("WebSocket 连接被对端关闭")
            self._buf += chunk
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    def _send_frame(self, opcode: int, payload: bytes = b"") -> None:
        header = bytearray()
        header.append(0x80 | opcode)          # FIN=1
        mask_bit = 0x80                        # 客户端必须加掩码
        length = len(payload)
        if length < 126:
            header.append(mask_bit | length)
        elif length < 65536:
            header.append(mask_bit | 126)
            header += struct.pack(">H", length)
        else:
            header.append(mask_bit | 127)
            header += struct.pack(">Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def _recv_frame(self, deadline: float):
        b1, b2 = self._read_exact(2, deadline)
        fin = bool(b1 & 0x80)
        opcode = b1 & 0x0F
        masked = bool(b2 & 0x80)
        length = b2 & 0x7F
        if length == 126:
            (length,) = struct.unpack(">H", self._read_exact(2, deadline))
        elif length == 127:
            (length,) = struct.unpack(">Q", self._read_exact(8, deadline))
        mask = self._read_exact(4, deadline) if masked else b""
        payload = self._read_exact(length, deadline) if length else b""
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return fin, opcode, payload

    def recv_message(self, deadline: float):
        """返回 (opcode, bytes)；超时抛 TimeoutError；close 帧返回 (8, payload)。"""
        fragments = bytearray()
        frag_opcode = None
        while True:
            fin, opcode, payload = self._recv_frame(deadline)
            if opcode == 0x8:                     # close
                self.closed = True
                self._send_frame(0x8, payload[:2])
                return 0x8, bytes(payload)
            if opcode == 0x9:                     # ping → pong
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:                     # pong
                continue
            if opcode in (0x1, 0x2):
                frag_opcode = opcode
                fragments = bytearray(payload)
            elif opcode == 0x0:
                fragments += payload
            else:
                raise CDPError(f"未知 WebSocket opcode: {opcode}")
            if fin:
                return frag_opcode, bytes(fragments)

    def close(self) -> None:
        if getattr(self, "closed", True):
            try:
                self.sock.close()
            except OSError:
                pass
            return
        try:
            self._send_frame(0x8, struct.pack(">H", 1000))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass
        self.closed = True


# =============================================================== CDP 会话

class CDPSession:
    """在一条页面级 WebSocket 上做 JSON-RPC：call() 发命令，事件进 self.events。"""

    def __init__(self, ws_url: str, timeout: float = 20.0):
        self.ws_url = ws_url
        self.ws = WebSocketClient(ws_url, timeout=timeout)
        self._next_id = 1
        self.events: list[dict] = []
        self.event_sink = None    # 可选回调：fn(event_dict)
        self.default_timeout = timeout

    # ---- 内部 ----

    def _handle(self, msg: dict) -> None:
        self.events.append(msg)
        if self.event_sink is not None:
            try:
                self.event_sink(msg)
            except Exception:                      # 事件回调不允许拖垮会话
                pass

    def pump(self, timeout: float = 0.1) -> None:
        """在 timeout 内尽量多地读入消息（用于等待事件/超时推进）。"""
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            try:
                opcode, data = self.ws.recv_message(deadline)
            except TimeoutError:
                return
            if opcode == 0x8:
                raise ConnectionError("DevTools WebSocket 被对端关闭")
            if opcode != 0x1:
                continue
            try:
                self._handle(json.loads(data.decode("utf-8")))
            except json.JSONDecodeError:
                continue

    def call(self, method: str, params: dict | None = None, timeout: float | None = None):
        """发一条 CDP 命令并等它的响应；期间收到的事件会正常入队。"""
        msg_id = self._next_id
        self._next_id += 1
        payload = {"id": msg_id, "method": method, "params": params or {}}
        self.ws.send_text(json.dumps(payload, ensure_ascii=False))
        deadline = time.monotonic() + (timeout or self.default_timeout)
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError(f"CDP 命令超时：{method}")
            try:
                opcode, data = self.ws.recv_message(deadline)
            except TimeoutError:
                raise TimeoutError(f"CDP 命令超时：{method}") from None
            if opcode == 0x8:
                raise ConnectionError(f"CDP 连接在等待 {method} 时被关闭")
            if opcode != 0x1:
                continue
            msg = json.loads(data.decode("utf-8"))
            if msg.get("id") == msg_id:
                if "error" in msg:
                    err = msg["error"]
                    raise CDPError(f"{method} 失败：{err.get('message')}（{err}）")
                return msg.get("result", {})
            if "method" in msg:
                self._handle(msg)

    # ---- 事件查询 ----

    def events_since(self, index: int, method: str | None = None) -> list[dict]:
        found = self.events[index:]
        if method is not None:
            found = [e for e in found if e.get("method") == method]
        return found

    def wait_event(self, method: str, timeout: float = 10.0, since: int | None = None):
        start = len(self.events) if since is None else since
        deadline = time.monotonic() + timeout
        while True:
            for ev in self.events[start:]:
                if ev.get("method") == method:
                    return ev
            if time.monotonic() > deadline:
                return None
            self.pump(0.05)

    def close(self) -> None:
        self.ws.close()


# =============================================================== 浏览器进程

class Browser:
    """启动/关闭一个独立的 headless Edge 实例，并连上它的页面 target。"""

    def __init__(self, edge_path: str | None = None, width: int = 1920, height: int = 1080,
                 webgl_args: list[str] | None = None, extra_args: list[str] | None = None,
                 headless: bool = True, device_scale_factor: float = 1.0,
                 debug_port: int | None = None, startup_timeout: float = 40.0,
                 verbose: bool = False):
        self.edge_path = find_edge(edge_path)
        self.width = width
        self.height = height
        self.webgl_args = DEFAULT_WEBGL_ARGS if webgl_args is None else list(webgl_args)
        self.extra_args = list(extra_args or [])
        self.headless = headless
        self.device_scale_factor = device_scale_factor
        self.debug_port = debug_port or free_port()
        self.startup_timeout = startup_timeout
        self.verbose = verbose
        self.proc: subprocess.Popen | None = None
        self.profile_dir: str | None = None
        self.session: CDPSession | None = None
        self.log_path: str | None = None

    # ---- 启动 ----

    def _build_args(self, initial_url: str = "about:blank") -> list[str]:
        args = [self.edge_path]
        if self.headless:
            # 注意：headless 开关由 webgl_args/extra_args 里显式给出时不要重复
            if not any(a.startswith("--headless") for a in (self.webgl_args + self.extra_args)):
                args.append("--headless=new")
        args += self.webgl_args
        args += BASE_BROWSER_ARGS
        args += [
            f"--remote-debugging-port={self.debug_port}",
            f"--user-data-dir={self.profile_dir}",
            f"--window-size={self.width},{self.height}",
            f"--force-device-scale-factor={self.device_scale_factor}",
            "--remote-allow-origins=*",
            "--disable-popup-blocking",
            "--disable-prompt-on-repost",
        ]
        args += self.extra_args
        args.append(initial_url)
        return args

    def start(self, initial_url: str = "about:blank") -> "Browser":
        self.profile_dir = tempfile.mkdtemp(prefix="bg-edge-profile-")
        log_fd, self.log_path = tempfile.mkstemp(prefix="bg-edge-", suffix=".log")
        args = self._build_args(initial_url)
        if self.verbose:
            print("[harness] 启动浏览器：" + " ".join(args), file=sys.stderr)
        creationflags = 0
        if os.name == "nt":
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.proc = subprocess.Popen(
            args, stdout=log_fd, stderr=subprocess.STDOUT,
            creationflags=creationflags)
        os.close(log_fd)
        self._wait_for_devtools()
        return self

    def _wait_for_devtools(self) -> None:
        version_url = f"http://127.0.0.1:{self.debug_port}/json/version"
        deadline = time.monotonic() + self.startup_timeout
        last_err = None
        while time.monotonic() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                raise RuntimeError(
                    f"浏览器进程提前退出（code={self.proc.returncode}）。"
                    f"日志尾部：{self._log_tail()}")
            try:
                info = _http_json(version_url, timeout=2.0)
                if info:
                    self.version_info = info
                    return
            except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as exc:
                last_err = exc
            time.sleep(0.2)
        raise TimeoutError(
            f"等待 DevTools 端口 {self.debug_port} 超时（last={last_err!r}）。"
            f"日志尾部：{self._log_tail()}")

    def _log_tail(self, limit: int = 1500) -> str:
        if not self.log_path or not os.path.isfile(self.log_path):
            return "<无日志>"
        try:
            with open(self.log_path, "r", encoding="utf-8", errors="replace") as fh:
                data = fh.read()
        except OSError:
            return "<日志不可读>"
        return data[-limit:]

    # ---- target ----

    def page_targets(self) -> list[dict]:
        try:
            targets = _http_json(f"http://127.0.0.1:{self.debug_port}/json/list", timeout=5.0)
        except (urllib.error.URLError, OSError, ValueError):
            return []
        return [t for t in (targets or []) if t.get("type") == "page"]

    def new_page(self) -> str:
        """返回一个页面 target 的 webSocketDebuggerUrl。

        优先复用已存在的 about:blank 页面；没有就用 PUT /json/new 新建
        （Chrome/Edge 111+ 要求该端点用 PUT，GET 会返回 405）。
        """
        targets = self.page_targets()
        if targets:
            return targets[0]["webSocketDebuggerUrl"]
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.debug_port}/json/new?about:blank", method="PUT")
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            info = json.loads(resp.read().decode("utf-8"))
        return info["webSocketDebuggerUrl"]

    def connect_page(self) -> CDPSession:
        self.session = CDPSession(self.new_page())
        return self.session

    # ---- 关闭 ----

    def stop(self) -> None:
        if self.session is not None:
            try:
                self.session.close()
            except Exception:
                pass
            self.session = None
        if self.proc is not None:
            pid = self.proc.pid
            try:
                self.proc.terminate()
                self.proc.wait(timeout=5)
            except Exception:
                pass
            if os.name == "nt":
                # Edge 会派生一堆子进程，必须连子进程一起收掉，否则端口/profile 不释放
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                               capture_output=True, check=False)
            else:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            self.proc = None
        if self.profile_dir:
            shutil.rmtree(self.profile_dir, ignore_errors=True)
            self.profile_dir = None


# =============================================================== Flask 服务

SERVE_SCRIPT_TEMPLATE = """
import sys
sys.path.insert(0, {repo!r})
from app import app, simulator
simulator.start()          # 真正跑采集线程（与原 python app.py 行为一致）
app.run(host={host!r}, port={port}, debug=False, use_reloader=False, threaded=True)
"""


class FlaskServer:
    """用子进程起 Flask 应用：随机端口 + 临时 SQLite，绝不污染 bridge.db。"""

    def __init__(self, port: int | None = None, host: str = "127.0.0.1",
                 db_path: str | None = None, extra_env: dict | None = None,
                 ready_timeout: float = 40.0, verbose: bool = False,
                 username: str = "admin", password: str = "123456"):
        self.host = host
        self.port = port or free_port()
        self.tmpdir = tempfile.mkdtemp(prefix="bg-flask-")
        self.db_path = db_path or os.path.join(self.tmpdir, "harness.db")
        self.extra_env = dict(extra_env or {})
        self.username = username
        self.password = password
        self.ready_timeout = ready_timeout
        self.verbose = verbose
        self.proc: subprocess.Popen | None = None
        self.log_path = os.path.join(self.tmpdir, "flask.log")
        self.repo_root = REPO_ROOT

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def start(self) -> "FlaskServer":
        env = dict(os.environ)
        env.update({
            "DB_PATH": self.db_path,
            "DATA_SOURCE": "sim",
            "PYTHONUNBUFFERED": "1",
            "PYTHONIOENCODING": "utf-8",
            # 认证参数显式钉死，避免宿主机环境变量（如 APP_PASSWORD）导致登录行为漂移
            "APP_USERNAME": self.username,
            "APP_PASSWORD": self.password,
            "APP_PASSWORD_HASH": "",
            "SECRET_KEY": "harness-fixed-secret-key-for-reproducible-runs",
        })
        env.update(self.extra_env)
        script = SERVE_SCRIPT_TEMPLATE.format(
            repo=self.repo_root, host=self.host, port=self.port)
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        log_fd = open(self.log_path, "wb")
        try:
            self.proc = subprocess.Popen(
                [sys.executable, "-c", script],
                cwd=self.repo_root, env=env,
                stdout=log_fd, stderr=subprocess.STDOUT,
                creationflags=creationflags)
        finally:
            log_fd.close()
        self._wait_ready()
        return self

    def _wait_ready(self) -> None:
        url = self.base_url + "/login"
        deadline = time.monotonic() + self.ready_timeout
        last_err = None
        while time.monotonic() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                raise RuntimeError(
                    f"Flask 子进程提前退出（code={self.proc.returncode}）。"
                    f"日志尾部：{self.log_tail()}")
            try:
                with urllib.request.urlopen(url, timeout=2.0) as resp:
                    if resp.status == 200:
                        return
            except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
                last_err = exc
            time.sleep(0.25)
        raise TimeoutError(f"等待 Flask 就绪超时（{url}，last={last_err!r}）。"
                           f"日志尾部：{self.log_tail()}")

    def log_tail(self, limit: int = 2000) -> str:
        if not os.path.isfile(self.log_path):
            return "<无日志>"
        try:
            with open(self.log_path, "r", encoding="utf-8", errors="replace") as fh:
                return fh.read()[-limit:]
        except OSError:
            return "<日志不可读>"

    def stop(self) -> None:
        if self.proc is not None:
            pid = self.proc.pid
            try:
                self.proc.terminate()
                self.proc.wait(timeout=5)
            except Exception:
                pass
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                               capture_output=True, check=False)
            else:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            self.proc = None
        shutil.rmtree(self.tmpdir, ignore_errors=True)


# =============================================================== 页面 API

class Page:
    """面向测试的高层页面操作。"""

    def __init__(self, session: CDPSession, base_url: str, verbose: bool = False):
        self.session = session
        self.base_url = base_url.rstrip("/")
        self.verbose = verbose
        self.console_messages: list[dict] = []
        self.network_errors: list[dict] = []
        self._requests: dict[str, str] = {}
        session.event_sink = self._on_event
        self.setup()

    # ---- 事件收集 ----

    def _on_event(self, msg: dict) -> None:
        method = msg.get("method")
        params = msg.get("params", {}) or {}
        if method == "Runtime.consoleAPICalled":
            args = []
            for a in params.get("args", []) or []:
                if a.get("value") is not None:
                    args.append(a["value"] if isinstance(a["value"], str)
                                else json.dumps(a["value"], ensure_ascii=False))
                else:
                    args.append(a.get("description") or a.get("type") or "<unknown>")
            self.console_messages.append({
                "kind": "console",
                "level": params.get("type", "log"),
                "text": " ".join(args),
                "ts": params.get("timestamp"),
            })
        elif method == "Runtime.exceptionThrown":
            det = params.get("exceptionDetails", {}) or {}
            exc = det.get("exception", {}) or {}
            text = det.get("text") or ""
            desc = exc.get("description") or ""
            self.console_messages.append({
                "kind": "exception",
                "level": "error",
                "text": (text + (" " + desc if desc else "")).strip(),
                "url": det.get("url"),
                "line": det.get("lineNumber"),
                "column": det.get("columnNumber"),
                "ts": det.get("timestamp"),
            })
        elif method == "Log.entryAdded":
            entry = params.get("entry", {}) or {}
            if entry.get("level") in ("error", "warning"):
                self.console_messages.append({
                    "kind": "log",
                    "level": entry.get("level"),
                    "text": entry.get("text", ""),
                    "url": entry.get("url"),
                    "line": entry.get("lineNumber"),
                    "source": entry.get("source"),
                })
        elif method == "Network.requestWillBeSent":
            self._requests[params.get("requestId")] = params.get("request", {}).get("url", "")
        elif method == "Network.responseReceived":
            resp = params.get("response", {}) or {}
            if int(resp.get("status", 0) or 0) >= 400:
                self.network_errors.append({
                    "kind": "response",
                    "url": resp.get("url"),
                    "status": resp.get("status"),
                    "type": params.get("type"),
                })
        elif method == "Network.loadingFailed":
            self.network_errors.append({
                "kind": "loadingFailed",
                "url": self._requests.get(params.get("requestId"), "?"),
                "errorText": params.get("errorText"),
                "type": params.get("type"),
                "canceled": params.get("canceled"),
            })

    def console_logs(self, level: str | None = None) -> list[dict]:
        """返回收集到的控制台消息 / 未捕获异常（可只取某个级别）。"""
        if level is None:
            return list(self.console_messages)
        return [m for m in self.console_messages if m.get("level") == level]

    def console_errors(self) -> list[dict]:
        return [m for m in self.console_messages
                if m.get("level") in ("error", "assert", "warning")]

    # ---- 域初始化 ----

    def setup(self) -> None:
        self.session.call("Page.enable")
        self.session.call("Runtime.enable")
        try:
            self.session.call("Log.enable")
        except CDPError:
            pass
        try:
            self.session.call("Network.enable")
        except CDPError:
            pass

    def set_viewport(self, width: int, height: int, device_scale_factor: float = 1.0) -> dict:
        """设置布局视口（也决定 Page.captureScreenshot 的输出尺寸）。"""
        result = self.session.call("Emulation.setDeviceMetricsOverride", {
            "width": int(width),
            "height": int(height),
            "deviceScaleFactor": float(device_scale_factor),
            "mobile": False,
            "screenWidth": int(width),
            "screenHeight": int(height),
        })
        return result

    # ---- 导航 ----

    def goto(self, url: str, timeout: float = 30.0, wait_load: bool = True) -> dict:
        full = url if url.startswith(("http://", "https://", "about:", "data:")) \
            else self.base_url + ("" if url.startswith("/") else "/") + url
        since = len(self.session.events)
        self.session.call("Page.navigate", {"url": full}, timeout=timeout)
        if wait_load:
            ev = self.session.wait_event("Page.loadEventFired", timeout=timeout, since=since)
            if ev is None:
                # 退化路径：轮询 readyState（有些导航不产生 loadEventFired）
                self.wait_for("document.readyState === 'complete'", timeout=timeout)
        return {"url": full}

    def wait_for(self, expr: str, timeout: float = 15.0, poll: float = 0.2,
                 label: str | None = None):
        """轮询等待 JS 表达式为真；返回最后一次的原始值。"""
        deadline = time.monotonic() + timeout
        last = None
        last_err = None
        while True:
            try:
                last = self.eval_js(f"!!({expr})")
                if last:
                    return last
            except (JSEvalError, CDPError, ConnectionError, TimeoutError) as exc:
                last_err = exc
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"wait_for 超时（{timeout}s）：{label or expr}"
                    + (f"；最后一次错误：{last_err}" if last_err else "")
                    + f"；最后一次取值：{last!r}")
            time.sleep(poll)

    # ---- 求值 ----

    def eval_js(self, expr: str, await_promise: bool = False, timeout: float = 30.0):
        """执行 JS 表达式并返回 JSON 化的值；JS 抛异常时抛 JSEvalError。"""
        result = self.session.call("Runtime.evaluate", {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": await_promise,
            "userGesture": True,
            "timeout": int(timeout * 1000),
        }, timeout=timeout + 5)
        if result.get("exceptionDetails"):
            det = result["exceptionDetails"]
            exc = det.get("exception", {}) or {}
            raise JSEvalError(
                f"JS 异常：{det.get('text')} {exc.get('description', '')}".strip())
        remote = result.get("result", {}) or {}
        if remote.get("type") == "undefined":
            return None
        if "value" in remote:
            return remote["value"]
        # 非 JSON 可序列化对象（如 DOM 节点）——退化为 description
        return remote.get("description")

    # ---- 截图 ----

    def screenshot(self, path: str, width: int | None = None, height: int | None = None,
                   device_scale_factor: float = 1.0, full_page: bool = False,
                   settle: float = 0.0) -> dict:
        if width and height:
            self.set_viewport(width, height, device_scale_factor)
            time.sleep(max(settle, 0.25))     # 让布局/图表跟上新视口
        elif settle > 0:
            time.sleep(settle)
        params = {"format": "png", "fromSurface": True, "optimizeForSpeed": False}
        if full_page:
            metrics = self.session.call("Page.getLayoutMetrics")
            css = metrics.get("cssContentSize") or metrics.get("contentSize") or {}
            params["captureBeyondViewport"] = True
            params["clip"] = {
                "x": 0, "y": 0,
                "width": float(css.get("width", 1920)),
                "height": float(css.get("height", 1080)),
                "scale": 1,
            }
        else:
            params["captureBeyondViewport"] = False
        result = self.session.call("Page.captureScreenshot", params, timeout=60)
        data = base64.b64decode(result["data"])
        out_path = os.path.abspath(path)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as fh:
            fh.write(data)
        return {"path": out_path, "bytes": len(data)}

    # ---- 登录 ----

    def login(self, username: str = "admin", password: str = "123456",
              timeout: float = 20.0) -> dict:
        """走真实登录表单：goto /login → 填 DOM → submit → 等离开登录页（已登录）。

        判定口径：登录成功后**不再要求**必定停在 /dashboard ——
        手机端（≤768px 视口 / 手机 UA）访问 /dashboard 会转到 /trend（手机端取消 3D 界面），
        所以这里只要求「离开 /login 且落到一个已登录页面」，返回真实落点供调用方断言。
        """
        self.goto("/login", timeout=timeout)
        self.wait_for("!!document.querySelector('form input[name=username]')", timeout=timeout)
        script = (
            "(() => {"
            "  const f = document.querySelector('form');"
            "  const u = f.querySelector('input[name=username]');"
            "  const p = f.querySelector('input[name=password]');"
            f" u.value = {json.dumps(username)};"
            f" p.value = {json.dumps(password)};"
            "  f.submit();"
            "  return true;"
            "})()"
        )
        self.eval_js(script)
        try:
            self.wait_for("location.pathname !== '/login'", timeout=timeout)
        except TimeoutError:
            body = self.eval_js("document.body.innerText.slice(0,200)")
            raise RuntimeError(
                f"登录失败：仍停在 /login；页面文本 {body!r}") from None
        path = self.eval_js("location.pathname")
        if path not in ("/dashboard", "/trend"):
            body = self.eval_js("document.body.innerText.slice(0,200)")
            raise RuntimeError(
                f"登录后落点异常：{path!r}；页面文本 {body!r}")
        return {"path": path, "user": username}

    # ---- 端点/资源 ----

    def webgl_info(self) -> dict:
        """在页面里探测 WebGL：返回渲染器信息 + 真读回像素。"""
        return self.eval_js(JS_WEBGL_PROBE)


# =============================================================== 编排入口

class Harness:
    """一把梭：起 Flask + 起 headless Edge + 连页面；也可只连已有服务。"""

    def __init__(self, width: int = 1920, height: int = 1080, device_scale_factor: float = 1.0,
                 base_url: str | None = None, url_path: str = "/dashboard",
                 username: str = "admin", password: str = "123456",
                 edge_path: str | None = None, webgl_args: list[str] | None = None,
                 extra_args: list[str] | None = None, server_env: dict | None = None,
                 verbose: bool = False, startup_timeout: float = 40.0):
        self.width = width
        self.height = height
        self.device_scale_factor = device_scale_factor
        self.url_path = url_path
        self.username = username
        self.password = password
        self.verbose = verbose
        self._external_base = base_url
        self.edge_path = edge_path
        self.webgl_args = webgl_args
        self.extra_args = extra_args
        self.server_env = server_env
        self.startup_timeout = startup_timeout
        self.server: FlaskServer | None = None
        self.browser: Browser | None = None
        self.page: Page | None = None
        self.base_url: str | None = None

    def __enter__(self) -> "Harness":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()

    def start(self, need_page: bool = True) -> "Harness":
        if self._external_base:
            self.base_url = self._external_base.rstrip("/")
        else:
            self.server = FlaskServer(extra_env=self.server_env, verbose=self.verbose,
                                      ready_timeout=self.startup_timeout,
                                      username=self.username, password=self.password).start()
            self.base_url = self.server.base_url
        if need_page:
            self.browser = Browser(
                edge_path=self.edge_path, width=self.width, height=self.height,
                webgl_args=self.webgl_args, extra_args=self.extra_args,
                device_scale_factor=self.device_scale_factor,
                startup_timeout=self.startup_timeout, verbose=self.verbose).start()
            session = self.browser.connect_page()
            self.page = Page(session, self.base_url, verbose=self.verbose)
            self.page.set_viewport(self.width, self.height, self.device_scale_factor)
        return self

    def stop(self) -> None:
        if self.browser is not None:
            self.browser.stop()
            self.browser = None
        if self.server is not None:
            self.server.stop()
            self.server = None


# =============================================================== PNG 分析

def _unfilter(ftype: int, line: bytearray, prev: bytes, bpp: int) -> None:
    """按 PNG 规范复原一行扫描线（就地修改 line）。"""
    n = len(line)
    if ftype == 0:
        return
    if ftype == 1:                                  # Sub
        for i in range(bpp, n):
            line[i] = (line[i] + line[i - bpp]) & 0xFF
        return
    if ftype == 2:                                  # Up
        for i in range(n):
            line[i] = (line[i] + prev[i]) & 0xFF
        return
    if ftype == 3:                                  # Average
        for i in range(n):
            a = line[i - bpp] if i >= bpp else 0
            line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        return
    if ftype == 4:                                  # Paeth
        for i in range(n):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            p = a + b - c
            pa = p - a if p >= a else a - p
            pb = p - b if p >= b else b - p
            pc = p - c if p >= c else c - p
            if pa <= pb and pa <= pc:
                pr = a
            elif pb <= pc:
                pr = b
            else:
                pr = c
            line[i] = (line[i] + pr) & 0xFF
        return
    raise ValueError(f"未知 PNG 行滤波类型：{ftype}")


def png_stats(path: str, sample_step: int = 1) -> dict:
    """纯标准库解析 PNG：尺寸、字节数、亮度均值/方差、非黑像素比例、颜色数。

    用来证明截图「不是全黑 / 全空」，避免依赖 Pillow。
    """
    with open(path, "rb") as fh:
        raw = fh.read()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} 不是 PNG 文件")
    pos = 8
    idat = bytearray()
    ihdr = None
    while pos + 8 <= len(raw):
        (length,) = struct.unpack(">I", raw[pos:pos + 4])
        ctype = raw[pos + 4:pos + 8]
        data = raw[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", data)
        elif ctype == b"IDAT":
            idat += data
        elif ctype == b"IEND":
            break
        pos += 12 + length
    if ihdr is None:
        raise ValueError(f"{path} 缺少 IHDR")
    width, height, bitdepth, colortype, _comp, _filt, interlace = ihdr
    if bitdepth != 8:
        raise ValueError(f"只支持 8bit PNG，实际 {bitdepth}")
    if interlace != 0:
        raise ValueError("不支持隔行扫描 PNG")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(colortype)
    if channels is None:
        raise ValueError(f"不支持的 color type：{colortype}")
    bpp = channels
    stride = width * channels
    pixels = zlib.decompress(bytes(idat))
    expected = height * (stride + 1)
    if len(pixels) < expected:
        raise ValueError(f"IDAT 数据不足：{len(pixels)} < {expected}")

    prev = bytes(stride)
    off = 0
    n = 0
    nonblack = 0
    lum_sum = 0.0
    lum_sq = 0.0
    lum_min = 255.0
    lum_max = 0.0
    color_hist: dict[tuple, int] = {}
    hist_sampled = 0
    for y in range(height):
        ftype = pixels[off]
        off += 1
        line = bytearray(pixels[off:off + stride])
        off += stride
        _unfilter(ftype, line, prev, bpp)
        prev = bytes(line)
        if y % sample_step:
            continue
        # 统计：每像素亮度（BT.601）与颜色直方图（抽样）
        for x in range(0, width, 1 if channels > 1 else 1):
            i = x * channels
            if channels == 1 or channels == 2:
                r = g = b = line[i]
            else:
                r, g, b = line[i], line[i + 1], line[i + 2]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            lum_sum += lum
            lum_sq += lum * lum
            n += 1
            if lum > 8:
                nonblack += 1
            if lum_min > lum:
                lum_min = lum
            if lum_max < lum:
                lum_max = lum
            if (x + y) % 7 == 0:
                key = (r >> 3, g >> 3, b >> 3)
                color_hist[key] = color_hist.get(key, 0) + 1
                hist_sampled += 1
    mean = lum_sum / n if n else 0.0
    var = (lum_sq / n - mean * mean) if n else 0.0
    std = var ** 0.5 if var > 0 else 0.0
    top = max(color_hist.items(), key=lambda kv: kv[1]) if color_hist else ((0, 0, 0), 0)
    top_share = (top[1] / hist_sampled) if hist_sampled else 0.0
    top_rgb8 = [c * 8 + 4 for c in top[0]]
    top_lum = 0.299 * top_rgb8[0] + 0.587 * top_rgb8[1] + 0.114 * top_rgb8[2]
    nb_ratio = (nonblack / n) if n else 0.0
    # 「全黑/全空」判定：几乎全部像素接近纯黑，或者整幅图只有 1-2 种颜色且都是黑的。
    # 注意：单色但明亮的图（例如 WebGL 只 clear 成一种颜色）不算 blank，只算 uniform。
    blank = nb_ratio < 0.001 or (len(color_hist) <= 2 and top_lum < 8)
    uniform = len(color_hist) <= 2
    return {
        "path": os.path.abspath(path),
        "bytes": len(raw),
        "width": width,
        "height": height,
        "color_type": colortype,
        "pixels_analyzed": n,
        "lum_mean": round(mean, 3),
        "lum_std": round(std, 3),
        "lum_min": round(lum_min, 1),
        "lum_max": round(lum_max, 1),
        "nonblack_ratio": round(nb_ratio, 6),
        "distinct_colors_sampled": len(color_hist),
        "top_color_rgb8": top_rgb8,
        "top_color_share": round(top_share, 4),
        "looks_blank": blank,
        "looks_uniform": uniform,
    }


# =============================================================== CLI

def _print_console(page: Page) -> None:
    logs = page.console_logs()
    print(f"[harness] 控制台消息 {len(logs)} 条：")
    for item in logs:
        loc = ""
        if item.get("url"):
            loc = f" @ {item['url']}:{item.get('line')}"
        print(f"  - [{item.get('level')}/{item.get('kind')}] {item.get('text')}{loc}")
    net = page.network_errors
    print(f"[harness] 网络错误 {len(net)} 条：")
    for item in net:
        print(f"  - [{item.get('kind')}] {item.get('url')} "
              f"{item.get('status') or item.get('errorText')}")


def _run_harness(args) -> int:
    """主流程：起服务 + 起浏览器 + 可选登录 + 断言 + 截图 + 报告。"""
    started = time.monotonic()
    report: dict = {"ok": False, "mode": "harness"}
    exit_code = 0
    webgl_args = None
    if args.webgl_args is not None:
        webgl_args = [a for a in args.webgl_args.split(",") if a]
    elif args.no_webgl_args:
        webgl_args = []

    page: Page | None = None
    harness = Harness(
        width=args.width, height=args.height,
        device_scale_factor=args.device_scale_factor,
        base_url=args.base_url, url_path=args.url,
        username=args.username, password=args.password,
        edge_path=args.edge_path, webgl_args=webgl_args,
        extra_args=args.extra_arg, verbose=args.verbose,
        startup_timeout=args.timeout)
    try:
        harness.start()
        page = harness.page
        assert page is not None
        report["base_url"] = harness.base_url
        report["edge"] = {
            "path": harness.browser.edge_path if harness.browser else None,
            "version": (harness.browser.version_info.get("Browser")
                        if harness.browser and hasattr(harness.browser, "version_info") else None),
            "webgl_args": (harness.browser.webgl_args if harness.browser else None),
        }
        if args.login:
            login_info = page.login(args.username, args.password)
            print(f"[harness] 登录成功：{login_info}")
            report["login"] = login_info

        page.goto(args.url)
        page.wait_for("document.readyState === 'complete'", timeout=args.timeout)
        if args.wait_for:
            for expr in args.wait_for:
                page.wait_for(expr, timeout=args.timeout)
                print(f"[harness] wait-for 通过：{expr}")
        if args.wait_ms:
            time.sleep(args.wait_ms / 1000.0)

        final_path = page.eval_js("location.pathname")
        want_path = urllib.parse.urlsplit(args.url).path or "/"
        if final_path == "/login" and want_path != "/login":
            print(f"[harness] 警告：请求 {args.url} 但最终停在 /login —— "
                  f"未登录或登录失败，截到的是登录页，不是目标页面！")
        report["url"] = page.eval_js("location.href")
        report["title"] = page.eval_js("document.title")
        report["viewport"] = {
            "innerWidth": page.eval_js("window.innerWidth"),
            "innerHeight": page.eval_js("window.innerHeight"),
            "devicePixelRatio": page.eval_js("window.devicePixelRatio"),
        }
        if args.webgl:
            report["webgl"] = page.webgl_info()
            print("[harness] WebGL：" + json.dumps(report["webgl"], ensure_ascii=False))

        evals = []
        for expr in (args.eval or []):
            try:
                value = page.eval_js(expr, await_promise=bool(getattr(args, "eval_async", False)))
                evals.append({"expr": expr, "value": value})
                print(f"[harness] eval_js({expr}) => {json.dumps(value, ensure_ascii=False)}")
            except (JSEvalError, CDPError) as exc:
                evals.append({"expr": expr, "error": str(exc)})
                print(f"[harness] eval_js({expr}) 失败：{exc}")
                exit_code = 1
        report["evals"] = evals

        asserts = []
        for expr in (args.assert_expr or []):
            try:
                value = page.eval_js(f"!!({expr})")
                ok = bool(value)
                asserts.append({"expr": expr, "ok": ok, "value": value})
                print(f"[harness] assert({expr}) => {ok}")
                if not ok:
                    exit_code = 1
            except (JSEvalError, CDPError) as exc:
                asserts.append({"expr": expr, "ok": False, "error": str(exc)})
                print(f"[harness] assert({expr}) 异常：{exc}")
                exit_code = 1
        report["asserts"] = asserts

        if args.out:
            shot = page.screenshot(args.out, args.width, args.height,
                                   args.device_scale_factor, full_page=args.full_page)
            stats = png_stats(shot["path"])
            shot.update({k: stats[k] for k in
                         ("width", "height", "lum_mean", "lum_std", "nonblack_ratio",
                          "distinct_colors_sampled", "looks_blank")})
            report["screenshot"] = shot
            print(f"[harness] 截图：{shot['path']}")
            print(f"[harness]   字节={shot['bytes']} 尺寸={shot['width']}x{shot['height']} "
                  f"亮度std={shot['lum_std']} 非黑比例={shot['nonblack_ratio']} "
                  f"抽样颜色数={shot['distinct_colors_sampled']} 全黑={shot['looks_blank']}")
            if shot["looks_blank"]:
                print("[harness] 警告：截图接近全黑/全空，请检查 WebGL 开关与渲染逻辑")
                exit_code = max(exit_code, 1)
        else:
            report["screenshot"] = None

        _print_console(page)
        report["console"] = page.console_logs()
        report["network_errors"] = page.network_errors
        hard_console_errors = [m for m in page.console_logs()
                               if m.get("kind") == "exception" or m.get("level") == "error"]
        report["hard_console_error_count"] = len(hard_console_errors)
        if hard_console_errors and args.strict_console:
            exit_code = max(exit_code, 2)
            print(f"[harness] --strict-console：{len(hard_console_errors)} 条控制台错误 ⇒ 失败")
        if page.network_errors and args.strict_console:
            exit_code = max(exit_code, 2)
        report["ok"] = exit_code == 0
    except Exception as exc:                     # noqa: BLE001 —— CLI 顶层兜底
        report["ok"] = False
        report["error"] = f"{type(exc).__name__}: {exc}"
        print(f"[harness] 失败：{report['error']}", file=sys.stderr)
        if page is not None:
            _print_console(page)
            report["console"] = page.console_logs()
            report["network_errors"] = page.network_errors
        exit_code = 1
    finally:
        # 断言失败是正常的测试结果，不必倒 Flask 日志；只有真异常才附上服务端日志。
        if (harness.server is not None and report.get("error")
                and harness.server.proc is not None):
            tail = harness.server.log_tail(800)
            if tail.strip():
                print("[harness] Flask 日志尾部：\n" + tail)
        harness.stop()
    report["elapsed_ms"] = int((time.monotonic() - started) * 1000)
    if args.json_report:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_report)), exist_ok=True)
        with open(args.json_report, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
        print(f"[harness] 报告：{os.path.abspath(args.json_report)}")
    print(f"[harness] 结束：exit={exit_code} 用时 {report['elapsed_ms']}ms")
    return exit_code


def _run_probe(args) -> int:
    """单次 WebGL 探测：拿上下文信息 + 全屏 WebGL 画布 + 截图统计像素。"""
    webgl_args = DEFAULT_WEBGL_ARGS if args.webgl_args is None \
        else [a for a in args.webgl_args.split(",") if a]
    result = _probe_once(webgl_args + list(args.extra_arg or []), args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.json_report:
        with open(args.json_report, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
    return 0 if result.get("webgl", {}).get("ok") and result.get("screenshot_ok") else 1


def _probe_once(flags: list[str], args) -> dict:
    """用给定参数启动一次浏览器，返回 WebGL 与像素证据。"""
    out: dict = {"flags": flags}
    headless_flag = any(f.startswith("--headless") for f in flags)
    other_flags = [f for f in flags if not f.startswith("--headless")]
    browser = Browser(edge_path=args.edge_path, width=args.width, height=args.height,
                      webgl_args=([] if headless_flag else ["--headless=new"]) + other_flags,
                      extra_args=[f for f in flags if f.startswith("--headless")],
                      startup_timeout=args.timeout, verbose=args.verbose)
    try:
        browser.start()
        out["browser_version"] = browser.version_info.get("Browser")
        session = browser.connect_page()
        page = Page(session, "about:blank")
        page.set_viewport(args.width, args.height, args.device_scale_factor)
        page.goto("about:blank")
        out["webgl"] = page.webgl_info()
        fill = page.eval_js(JS_WEBGL_FILL)
        out["fill"] = fill
        time.sleep(0.3)
        probe_png = args.out or os.path.join(tempfile.gettempdir(), "bg-probe.png")
        page.screenshot(probe_png)
        stats = png_stats(probe_png)
        out["screenshot"] = {k: stats[k] for k in
                             ("path", "bytes", "width", "height", "lum_mean", "lum_std",
                              "nonblack_ratio", "distinct_colors_sampled",
                              "top_color_rgb8", "top_color_share", "looks_blank")}
        # WebGL clearColor(0.2,0.6,0.9) ⇒ RGB(51,153,229)；判定主色是否接近之
        top = stats["top_color_rgb8"]
        out["screenshot_ok"] = (not stats["looks_blank"]
                                and abs(top[0] - 51) <= 12
                                and abs(top[1] - 153) <= 12
                                and abs(top[2] - 229) <= 12)
        out["console"] = page.console_logs()
    except Exception as exc:                      # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
        out["screenshot_ok"] = False
    finally:
        browser.stop()
    return out


def _run_probe_matrix(args) -> int:
    """逐个真实启动浏览器，跑 PROBE_MATRIX，打印可复制的证据表。"""
    rows = []
    for name, flags in PROBE_MATRIX:
        print(f"[probe-matrix] 正在测试：{name} …", flush=True)
        result = _probe_once(flags, args)
        gl = result.get("webgl", {}) or {}
        row = {
            "name": name,
            "flags": flags,
            "webgl_ok": bool(gl.get("ok")),
            "renderer": gl.get("renderer"),
            "version": gl.get("version"),
            "pixel_matches": gl.get("pixelMatchesClearColor"),
            "screenshot_ok": bool(result.get("screenshot_ok")),
            "top_color": (result.get("screenshot") or {}).get("top_color_rgb8"),
            "nonblack_ratio": (result.get("screenshot") or {}).get("nonblack_ratio"),
            "error": gl.get("error") or result.get("error"),
        }
        rows.append(row)
        print("    => " + json.dumps(row, ensure_ascii=False), flush=True)
    print("\n[probe-matrix] 汇总：")
    print(f"{'webgl':6} {'shot':5} {'renderer':38} name")
    for row in rows:
        print(f"{str(row['webgl_ok']):6} {str(row['screenshot_ok']):5} "
              f"{str(row['renderer'])[:38]:38} {row['name']}")
    if args.json_report:
        with open(args.json_report, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False, indent=2)
        print(f"[probe-matrix] 报告：{os.path.abspath(args.json_report)}")
    return 0 if any(r["webgl_ok"] and r["screenshot_ok"] for r in rows) else 1


def _serve_main(argv: list[str]) -> int:
    """内部子命令：以随机端口跑 Flask（供 --serve 手动调试用）。"""
    parser = argparse.ArgumentParser(prog="browser_harness.py --serve")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--db", default=None)
    args = parser.parse_args(argv)
    env_db = args.db or os.environ.get("DB_PATH")
    if env_db:
        os.environ["DB_PATH"] = env_db
    sys.path.insert(0, REPO_ROOT)
    from app import app, simulator          # noqa: PLC0415
    simulator.start()
    app.run(host=args.host, port=args.port, debug=False, use_reloader=False, threaded=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="桥体卫士 —— 零依赖 headless Edge + CDP 截图/断言工具（纯标准库）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
               "  python tests/browser_harness.py --url /dashboard "
               "--out .workbuddy/shots/dash.png --width 1920 --height 1080 --wait-ms 4000\n"
               "  python tests/browser_harness.py --probe-matrix\n")
    p.add_argument("--url", default="/dashboard", help="要打开的相对路径或绝对 URL")
    p.add_argument("--out", default=None, help="截图输出路径（.png）")
    p.add_argument("--width", type=int, default=1920)
    p.add_argument("--height", type=int, default=1080)
    p.add_argument("--device-scale-factor", type=float, default=1.0)
    p.add_argument("--wait-ms", type=int, default=0, help="导航后额外等待毫秒数（等渲染）")
    p.add_argument("--wait-for", action="append", default=[],
                   help="等待某个 JS 表达式为真（可重复）")
    p.add_argument("--eval", action="append", default=[],
                   help="执行 JS 表达式并打印 JSON 结果（可重复）")
    p.add_argument("--eval-async", action="store_true",
                   help="--eval 的表达式返回 Promise 时等待其 resolve（awaitPromise=true）；"
                        "受限环境里页面定时器可能被 CDP 冻结，用它可以拿到\"页面自己跑一段时间后\"的真实状态")
    p.add_argument("--assert", dest="assert_expr", action="append", default=[],
                   help="断言 JS 表达式为真，否者退出码非 0（可重复）")
    p.add_argument("--login", action="store_true", default=True,
                   help="先走登录表单（默认开启）")
    p.add_argument("--no-login", dest="login", action="store_false")
    p.add_argument("--username", default="admin")
    p.add_argument("--password", default="123456")
    p.add_argument("--base-url", default=None,
                   help="使用已有服务（给了就不再自己起 Flask）")
    p.add_argument("--edge-path", default=None)
    p.add_argument("--webgl-args", default=None,
                   help="逗号分隔的额外浏览器参数（覆盖默认软件 WebGL 组合）")
    p.add_argument("--no-webgl-args", action="store_true", help="不加任何软件 WebGL 参数")
    p.add_argument("--extra-arg", action="append", default=[],
                   help="追加给浏览器的原始参数（可重复）")
    p.add_argument("--webgl", action="store_true", help="打印页面内 WebGL 探测结果")
    p.add_argument("--full-page", action="store_true")
    p.add_argument("--strict-console", "--fail-on-console-error", dest="strict_console",
                   action="store_true",
                   help="页面有控制台错误/资源 4xx-5xx 时退出码为 2")
    p.add_argument("--timeout", type=float, default=40.0, help="各类等待超时（秒）")
    p.add_argument("--json-report", default=None, help="把结果写成 JSON 报告")
    p.add_argument("--probe", action="store_true", help="只做一次 WebGL 探测 + 截图")
    p.add_argument("--probe-matrix", action="store_true", help="跑 WebGL 开关组合矩阵")
    p.add_argument("--image-stats", default=None, help="只分析已有 PNG（不需要浏览器）")
    p.add_argument("--json", action="store_true", help="--image-stats 时输出 JSON")
    p.add_argument("--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    # Windows 下 stdout 被管道重定向时会退回本地编码（cp936），中文证据会乱码；
    # 统一成 UTF-8，保证重定向到文件后的日志可直接被 UTF-8 工具读取。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--serve" in argv:
        return _serve_main(argv)
    args = build_parser().parse_args(argv)

    if args.image_stats:
        stats = png_stats(args.image_stats)
        if args.json:
            print(json.dumps(stats, ensure_ascii=False, indent=2))
        else:
            for k, v in stats.items():
                print(f"{k}: {v}")
        return 0 if not stats["looks_blank"] else 1
    if args.probe_matrix:
        return _run_probe_matrix(args)
    if args.probe:
        return _run_probe(args)
    if not args.out and not args.eval and not args.assert_expr:
        print("[harness] 什么都没做：请给 --out 截图，或 --eval/--assert。"
              "（--help 看用法）", file=sys.stderr)
        return 2
    return _run_harness(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
