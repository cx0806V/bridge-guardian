"""串口数据链路自测：SerialSource 读线程 → JSON 解析 → 队列 → read_sample 全流程。

用 mock 模拟 pyserial.Serial，无需真实硬件即可验证串口数据链路。
"""
import time
from unittest import mock

from datasource import SerialSource


def test_serial_full_flow():
    fake_serial = mock.MagicMock()
    # 第一次 readline 返回 JSON，后续返回空（模拟无数据超时）
    fake_serial.readline.side_effect = [b'{"v": 123.45, "id": "ESP32-01"}\n'] + [b""] * 200

    with mock.patch("datasource.serial.Serial", return_value=fake_serial):
        src = SerialSource("COM1", 115200, read_timeout=0.05, offline_after=10)
        src.start()
        time.sleep(0.3)  # 等待读线程处理数据

        sample = src.read_sample()
        assert sample is not None
        assert sample[0] == 123.45
        assert sample[1] == "ESP32-01"      # 解析出设备标识
        assert src.last_heartbeat is not None  # 心跳已更新
        src.close()


def test_serial_plain_number_flow():
    fake_serial = mock.MagicMock()
    fake_serial.readline.side_effect = [b"99.9\n"] + [b""] * 200

    with mock.patch("datasource.serial.Serial", return_value=fake_serial):
        src = SerialSource("COM1", 115200, read_timeout=0.05)
        src.start()
        time.sleep(0.3)
        sample = src.read_sample()
        assert sample is not None and sample[0] == 99.9
        src.close()


def test_serial_invalid_line_ignored():
    fake_serial = mock.MagicMock()
    fake_serial.readline.side_effect = [b"hello-not-json\n", b'{"v": 50.0}\n'] + [b""] * 200

    with mock.patch("datasource.serial.Serial", return_value=fake_serial):
        src = SerialSource("COM1", 115200, read_timeout=0.05)
        src.start()
        time.sleep(0.3)
        sample = src.read_sample()  # 无效行被忽略，读到有效 JSON
        assert sample is not None and sample[0] == 50.0
        src.close()


def test_serial_new_schema_fields():
    """新版协议：解析 calibrated_value + 元字段（raw_value/unit/标定版本/传感器状态）。"""
    payload = {
        "schema_version": 2, "seq": 12, "device_ts": 1727400000,
        "raw_value": 8342112, "calibrated_value": 87.42, "unit": "相对应变指标",
        "calibration_version": 3, "sensor_state": "ok", "id": "ESP32-01",
    }
    line = (__import__("json").dumps(payload) + "\n").encode("utf-8")
    fake_serial = mock.MagicMock()
    fake_serial.readline.side_effect = [line] + [b""] * 200

    with mock.patch("datasource.serial.Serial", return_value=fake_serial):
        src = SerialSource("COM1", 115200, read_timeout=0.05)
        src.start()
        time.sleep(0.3)
        sample = src.read_sample()
        assert sample is not None and sample[0] == 87.42  # calibrated_value 优先
        assert sample[1] == "ESP32-01"
        assert src.meta["raw_value"] == 8342112
        assert src.meta["calibration_version"] == 3
        assert src.meta["sensor_state"] == "ok"
        assert src.meta["seq"] == 12
        src.close()


def test_simulated_scenario_state_machine():
    """模拟源场景状态机：正常→报警→离线→恢复可切换，离线不返回数据。"""
    from datasource import SimulatedSource
    src = SimulatedSource()
    assert src.scenario == "normal"
    # 报警场景：值稳定在高位区间
    src.set_scenario("alarm")
    for _ in range(5):
        v, _ = src.read_sample()
        assert 132 <= v <= 140
    # 离线场景：不返回数据，健康度离线
    src.set_scenario("offline")
    assert src.read_sample() is None
    assert src.health()["state"] == "offline"
    # 恢复：回到 normal，返回数据
    src.set_scenario("recover")
    assert src.scenario == "normal"
    assert src.read_sample() is not None
    assert src.health()["state"] == "online"
    # 非法场景被拒绝
    assert src.set_scenario("bogus") is False
