"""桥体卫士 —— 数据源抽象层

统一「模拟 / 串口」两种数据来源，供采集服务（Simulator）调用。

DataSource 接口：
- start()        启动数据源（串口模式开启读线程）
- read_sample()  返回 (value, device_id) 或 None（本次无新数据）
- status_text()  状态文本（在线/离线/模拟运行中）
- health()       健康度 dict（状态/心跳/超时计数/最近错误）
- close()        释放资源

设计要点：
- 模拟模式：SimulatedSource 围绕 80 随机波动，始终"在线"
- 串口模式：SerialSource 用独立读线程接收 ESP32 数据，维护心跳/超时；
  断线如实返回「离线」，绝不伪造在线或数据
"""
import json
import queue
import random
import threading
import time

try:
    import serial  # pyserial（仅串口模式需要）
except ImportError:
    serial = None

from db import now_str

# 相对应变指标：无量纲，非工程微应变(με)。仅用于展示与报警判断，不参与物理换算。
UNIT = "相对应变指标"


class DataSource:
    """数据源抽象接口。"""
    device_id = "UNKNOWN"

    def start(self):
        pass

    def read_sample(self):
        raise NotImplementedError

    def status_text(self):
        raise NotImplementedError

    def health(self):
        raise NotImplementedError

    def close(self):
        pass


class SimulatedSource(DataSource):
    """模拟数据源：支持可控场景（正常/预警/报警/严重/离线/恢复），可一键复现。

    场景说明（与演示剧本对应）：
    - normal  正常运行：围绕 80 小幅波动
    - warn    预警：稳在 108~115（阈值 120 的 0.9~0.96，接近但未越线）
    - alarm   报警：稳在 132~140（超过阈值 120，落入「报警」分级）
    - critical 严重报警：稳在 148~160（超过阈值 1.2 倍，落入「严重报警」）
    - offline 设备离线：read_sample 返回 None，健康度如实离线（不伪造数据）
    - recover 设备恢复：从离线切回 normal 前的过渡，恢复在线

    模拟数据明确标注为「模拟」，绝不伪装成真实硬件数据。
    """

    device_id = "SIM-01"

    def __init__(self):
        self.value = 80.0
        self.scenario = "normal"   # 当前场景
        self._lock = threading.Lock()

    def set_scenario(self, name):
        """切换可控场景（由 /api/scenario 调用，写入审计）。"""
        valid = {"normal", "warn", "alarm", "critical", "offline", "recover"}
        if name not in valid:
            return False
        with self._lock:
            self.scenario = name
            # 切到 offline 立即置离线；切到 recover 视为恢复在线
            if name == "recover":
                self.scenario = "normal"
        return True

    def read_sample(self):
        with self._lock:
            s = self.scenario
        if s == "offline":
            return None  # 设备离线：无新数据，健康度走离线路径
        if s == "normal":
            self.value += random.uniform(-3, 3)
            self.value = round(max(50, min(110, self.value)), 2)
        elif s == "warn":
            self.value = round(random.uniform(108, 115), 2)
        elif s == "alarm":
            self.value = round(random.uniform(132, 140), 2)
        elif s == "critical":
            self.value = round(random.uniform(148, 160), 2)
        return self.value, self.device_id

    def status_text(self):
        if self.scenario == "offline":
            return "模拟离线"
        return "模拟运行中"

    def health(self):
        offline = self.scenario == "offline"
        return {
            "state": "offline" if offline else "online",
            "text": "模拟离线" if offline else "模拟运行中",
            "device_id": self.device_id,
            "last_heartbeat": "--",
            "timeout_count": 0,
            "last_error": "模拟场景：设备离线（演示用）" if offline else "",
        }


class SerialSource(DataSource):
    """串口数据源：独立读线程接收 ESP32 数据。

    协议：每行一条记录，支持新版 JSON 与旧版兼容（见 _parse）：
      新版（推荐）：
        {"schema_version": 2, "seq": 1234, "device_ts": 1727400000,
         "raw_value": 8342112, "calibrated_value": 87.42, "unit": "相对应变指标",
         "calibration_version": 3, "sensor_state": "ok", "id": "ESP32-01"}
      旧版（兼容）：
        {"v": 123.45, "id": "ESP32-01"}  或  纯数字 "123.45"
    健康度：心跳时间戳 + 连续超时计数 + 最近错误。
    """

    def __init__(self, port, baud=115200, read_timeout=0.5, offline_after=10):
        self.port = port
        self.baud = baud
        self.read_timeout = read_timeout
        self.offline_after = offline_after
        self.device_id = "ESP32"

        self._ser = None
        self._queue = queue.Queue(maxsize=200)
        self._thread = None
        self._running = False
        self.last_heartbeat = None
        self.timeout_count = 0
        self.last_error = ""
        self.last_value = None
        # 设备元信息（来自新版协议字段，供健康度/展示透出）
        self.meta = {
            "raw_value": None,
            "unit": UNIT,
            "calibration_version": None,
            "sensor_state": None,
            "seq": None,
            "device_ts": None,
        }

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    def _open(self):
        if serial is None:
            self.last_error = "未安装 pyserial，无法使用串口模式"
            return False
        try:
            self._ser = serial.Serial(self.port, self.baud, timeout=self.read_timeout)
            self.last_error = ""
            return True
        except Exception as e:
            self.last_error = f"串口打开失败：{e}"
            self._ser = None
            return False

    def _read_loop(self):
        while self._running:
            if self._ser is None:
                if not self._open():
                    time.sleep(2)   # 打开失败，稍后重试
                    self.timeout_count += 1
                    continue
            try:
                raw = self._ser.readline()
            except Exception as e:
                self.last_error = f"串口读取失败：{e}"
                self._ser = None
                self.timeout_count += 1
                continue
            if not raw:
                self.timeout_count += 1   # 超时无数据
                continue
            self.timeout_count = 0
            self.last_heartbeat = now_str()
            text = raw.decode("utf-8", errors="ignore").strip()
            value = self._parse(text)
            if value is not None:
                self.last_value = value
                self._queue.put((value, self.device_id))

    def _parse(self, text):
        """解析一行数据，返回应变指标数值或 None（无效行忽略）。

        兼容旧协议（{"v":..} / 纯数字）与新协议（calibrated_value + 元字段）。
        优先使用 calibrated_value（已标定的相对应变指标）；
        旧协议 v 视为已标定值直接使用；raw_value 仅透出，不参与报警判断。
        """
        try:
            obj = json.loads(text)
            if isinstance(obj, dict):
                # 设备标识（新旧一致）
                self.device_id = obj.get("id", self.device_id)
                # 元字段透出（新版协议）
                self.meta["raw_value"] = obj.get("raw_value")
                self.meta["unit"] = obj.get("unit", UNIT)
                self.meta["calibration_version"] = obj.get("calibration_version")
                self.meta["sensor_state"] = obj.get("sensor_state")
                self.meta["seq"] = obj.get("seq")
                self.meta["device_ts"] = obj.get("device_ts")
                # 取值：优先 calibrated_value，其次旧协议 v
                if "calibrated_value" in obj:
                    return float(obj["calibrated_value"])
                if "v" in obj:
                    return float(obj["v"])
                return None
            return float(obj)
        except (ValueError, KeyError, TypeError):
            try:
                return float(text)
            except ValueError:
                return None

    def read_sample(self):
        """非阻塞取最新一条数据，无新数据返回 None。"""
        sample = None
        while True:
            try:
                sample = self._queue.get_nowait()
            except queue.Empty:
                break
        return sample

    def status_text(self):
        if self._ser is None and self.last_heartbeat is None:
            return "设备未连接"
        if self.timeout_count >= self.offline_after:
            return "设备离线"
        return "设备在线"

    def health(self):
        if self.last_heartbeat is None:
            state, text = "offline", "设备未连接"   # 从未收到数据
        elif self.timeout_count >= self.offline_after:
            state, text = "offline", "设备离线"     # 超时离线
        else:
            state, text = "online", "设备在线"
        return {
            "state": state,
            "text": text,
            "device_id": self.device_id,
            "last_heartbeat": self.last_heartbeat or "--",
            "timeout_count": self.timeout_count,
            "last_error": self.last_error,
            "meta": dict(self.meta),  # 固件元信息（raw_value/unit/标定版本/传感器状态等）
        }

    def close(self):
        self._running = False
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:
                pass
