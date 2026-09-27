"""设备心跳与离线报警测试：心跳表、设备事件报警、离线/恢复边沿检测。"""
import os
import tempfile

import app
import db


class _FakeSource:
    """模拟串口数据源，用于离线/恢复边沿检测。"""
    device_id = "ESP32"

    def __init__(self, online, error=""):
        self._online = online
        self._error = error

    def status_text(self):
        return "设备在线" if self._online else "设备离线"

    def health(self):
        return {
            "state": "online" if self._online else "offline",
            "text": self.status_text(),
            "device_id": self.device_id,
            "last_heartbeat": "2026-01-01 00:00:00",
            "timeout_count": 0,
            "last_error": self._error,
        }


def test_heartbeat_table_crud():
    path = os.path.join(tempfile.gettempdir(), "test_heartbeat.db")
    if os.path.exists(path):
        os.remove(path)
    d = db.Database(path)
    d.insert_heartbeat("2026-01-01 00:00:00", "ESP32", "serial", "beat")
    d.insert_heartbeat("2026-01-01 00:00:01", "ESP32", "serial", "offline")
    assert len(d.recent_heartbeats(10)) == 2
    d.clear_heartbeats()
    assert len(d.recent_heartbeats(10)) == 0
    os.remove(path)


def test_device_event_records_alarm():
    sim = app.simulator
    sim._record_device_event("设备离线", "严重报警", "设备失去连接", "未处理")
    assert any(a["rule"] == "设备离线" for a in sim.latest["alarms"])


def test_offline_online_transition():
    sim = app.simulator
    orig_source, orig_was, orig_src = sim.data_source, sim._was_online, sim.source
    try:
        sim.source = "serial"
        sim._was_online = None
        # 初始在线：仅建立基准，不触发
        sim.data_source = _FakeSource(True)
        sim._update_device_state(None)
        assert sim._was_online is True
        # 变离线：触发「设备离线」
        sim.data_source = _FakeSource(False, "串口断开")
        sim._update_device_state(None)
        assert any(a["rule"] == "设备离线" for a in sim.latest["alarms"])
        # 恢复在线：触发「设备恢复」
        sim.data_source = _FakeSource(True)
        sim._update_device_state(None)
        assert any(a["rule"] == "设备恢复" for a in sim.latest["alarms"])
    finally:
        sim.source, sim.data_source, sim._was_online = orig_src, orig_source, orig_was
