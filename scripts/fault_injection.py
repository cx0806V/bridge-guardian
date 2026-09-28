#!/usr/bin/env python3
"""桥体卫士 —— 故障注入测试脚本（无硬件也能跑，用于验证故障处理逻辑）

用途：在不依赖真实 ESP32 的情况下，对 SerialSource 的故障处理逻辑做可复现验证。
     通过 mock pyserial 注入不同字节流，验证「拔线 / HX711 无响应 / 乱码 / 恢复」四类场景。

真实硬件故障注入（拔 USB、拔 DT/SCK 线）仍需现场执行并记录到 docs/标定与实测记录模板.md，
本脚本验证的是「软件侧对故障的诚实处理」，二者互补，不可相互替代。

运行：python scripts/fault_injection.py
"""
import json
import sys
import time
from unittest import mock

sys.path.insert(0, ".")  # 允许从项目根目录 import
from datasource import SerialSource


def _run_case(name, lines, expect_last_value, expect_state, expect_meta_sensor=None,
              offline_after=1000):
    """注入一组串口行，验证读到的值、健康度状态与元信息。"""
    fake = mock.MagicMock()
    idx = {"i": 0}

    def _readline(_size=-1):
        if idx["i"] < len(lines):
            data = lines[idx["i"]]
            idx["i"] += 1
            return data
        time.sleep(0.03)  # 模拟真实 pyserial 超时阻塞，避免读线程空转导致 timeout_count 飙升
        return b""

    fake.readline.side_effect = _readline
    with mock.patch("datasource.serial.Serial", return_value=fake):
        src = SerialSource("COM_TEST", 115200, read_timeout=0.03, offline_after=offline_after)
        src.start()
        time.sleep(0.4)
        sample = src.read_sample()
        health = src.health()
        src.close()

    ok_value = (sample is not None and sample[0] == expect_last_value) if expect_last_value is not None \
        else (sample is None)
    ok_state = health["state"] == expect_state
    ok_meta = True
    if expect_meta_sensor is not None:
        ok_meta = src.meta.get("sensor_state") == expect_meta_sensor

    status = "PASS" if (ok_value and ok_state and ok_meta) else "FAIL"
    print(f"[{status}] {name}: value={sample}, state={health['state']}, "
          f"error={health['last_error'] or '无'}")
    return status == "PASS"


def main():
    results = []

    # 1. 正常数据 → 在线，读到值
    results.append(_run_case(
        "正常数据", [b'{"v": 100.0, "id": "ESP32-01"}\n'], 100.0, "online"))

    # 2. 拔线（无任何数据）→ 离线，无新数据（不沿用旧值）
    results.append(_run_case(
        "ESP32 断电/拔线（无数据）", [], None, "offline", offline_after=3))

    # 3. 串口乱码（非 JSON/非数字）→ 无效行被丢弃，读到后续有效值
    results.append(_run_case(
        "串口乱码后恢复", [b"@@garbage@@\n", b"not-json\n", b'{"v": 88.8}\n'], 88.8, "online"))

    # 4. HX711 无响应（固件输出 sensor_state=fault）→ 无 calibrated_value，状态 fault
    fault_payload = {
        "schema_version": 2, "seq": 1, "device_ts": int(time.time()),
        "raw_value": None, "calibrated_value": None, "unit": "相对应变指标",
        "calibration_version": 1, "sensor_state": "fault",
        "error_code": 1, "id": "ESP32-01",
    }
    results.append(_run_case(
        "HX711 无响应（sensor_state=fault）",
        [(json.dumps(fault_payload) + "\n").encode("utf-8")],
        None, "online", expect_meta_sensor="fault"))

    # 5. 传感器恢复（恢复正常输出）→ 读到值，sensor_state=ok
    recover_payload = {
        "schema_version": 2, "seq": 2, "device_ts": int(time.time()),
        "raw_value": 8123456, "calibrated_value": 95.5, "unit": "相对应变指标",
        "calibration_version": 1, "sensor_state": "ok",
        "error_code": 0, "id": "ESP32-01",
    }
    results.append(_run_case(
        "传感器恢复（sensor_state=ok）",
        [(json.dumps(recover_payload) + "\n").encode("utf-8")],
        95.5, "online", expect_meta_sensor="ok"))

    # 6. 旧协议兼容（纯数字）
    results.append(_run_case(
        "旧协议兼容（纯数字）", [b"77.7\n"], 77.7, "online"))

    passed = sum(results)
    total = len(results)
    print(f"\n结果：{passed}/{total} 通过")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
