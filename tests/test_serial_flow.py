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
