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
    """模拟数据源：围绕 80 随机波动，2% 概率冲高。"""

    device_id = "SIM-01"

    def __init__(self):
        self.value = 80.0

    def read_sample(self):
        self.value += random.uniform(-3, 3)
        if random.random() < 0.02:
            self.value = random.uniform(125, 150)
        self.value = round(max(50, min(180, self.value)), 2)
        return self.value, self.device_id

    def status_text(self):
        return "模拟运行中"

    def health(self):
        return {
            "state": "online",
            "text": "模拟运行中",
            "device_id": self.device_id,
            "last_heartbeat": "--",
            "timeout_count": 0,
            "last_error": "",
        }


class SerialSource(DataSource):
    """串口数据源：独立读线程接收 ESP32 数据。

    协议：每行一条记录，支持 JSON（{"v": 123.45, "id": "ESP32-01"}）或纯数字。
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
        try:
            obj = json.loads(text)
            if isinstance(obj, dict):
                self.device_id = obj.get("id", self.device_id)
                return float(obj["v"])
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
        }

    def close(self):
        self._running = False
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:
                pass
