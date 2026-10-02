#!/usr/bin/env python3
"""桥体卫士 —— 标定采样记录工具

用途：读串口上 ESP32 输出的 JSON 行，抽取 raw_value / calibrated_value /
      sensor_state / error_code，按 CSV 打印或落盘，并在结束时给出该档位的
      raw 平均值与标准差 —— 直接对应 `docs/标定与实测记录模板.md`
      「标定结果记录」表所需的「raw 平均 / raw 标准差」两列。

它只做记录与统计，不参与报警判断，也不改写固件常量。

用法（Windows）：
    python scripts/calib_log.py --port COM3                       # 连续打印，Ctrl+C 结束
    python scripts/calib_log.py --port COM3 --tag 空载 --count 5
    python scripts/calib_log.py --port COM3 --tag L2_100g --count 5 --csv .workbuddy/calib.csv
    python scripts/calib_log.py --url loop:// --count 3           # 自检（无硬件）

退出码：0 = 已按要求读满样本；2 = 超时/串口打不开/无有效样本。
"""
import argparse
import json
import statistics
import sys
import time

try:
    import serial
except ImportError:  # pragma: no cover - 环境缺 pyserial 时给出明确指引
    print("未安装 pyserial：python -m pip install -r requirements.txt", file=sys.stderr)
    raise SystemExit(2)

FIELDS = ("tag", "idx", "iso_time", "raw_value", "calibrated_value",
          "sensor_state", "error_code", "calibration_version", "seq", "device_id")


def build_parser():
    p = argparse.ArgumentParser(
        description="桥体卫士标定采样记录（读串口 JSON → CSV + raw 统计）")
    p.add_argument("--port", help="串口号，如 COM3")
    p.add_argument("--url", help="pyserial URL 形式（自检用 loop://），与 --port 二选一")
    p.add_argument("--baud", type=int, default=115200, help="波特率，默认 115200")
    p.add_argument("--tag", default="", help="本次档位标签，如「空载」「L2_100g」")
    p.add_argument("--count", type=int, default=0, help="读取样本数；0=不限（Ctrl+C 结束）")
    p.add_argument("--timeout", type=float, default=3.0, help="单行读取超时（秒），默认 3.0")
    p.add_argument("--max-timeouts", type=int, default=5,
                   help="连续超时次数上限，超过判定断线并以退出码 2 结束，默认 5")
    p.add_argument("--csv", help="CSV 输出路径（不存在则写表头，存在则追加）")
    p.add_argument("--quiet", action="store_true", help="只输出 CSV 行，不打印进度说明")
    return p


def open_port(args):
    """按 --url / --port 打开串口；失败抛异常由调用方处理。"""
    if args.url:
        return serial.serial_for_url(args.url, baudrate=args.baud, timeout=args.timeout)
    return serial.Serial(args.port, args.baud, timeout=args.timeout)


def parse_line(text):
    """解析一行 JSON；非法行/缺少可辨识字段返回 None（与 SerialSource 同口径）。"""
    try:
        obj = json.loads(text)
    except ValueError:
        return None
    if not isinstance(obj, dict):
        return None
    if "calibrated_value" not in obj and "v" not in obj and "raw_value" not in obj:
        return None
    value = obj.get("calibrated_value", obj.get("v"))
    return {
        "raw_value": obj.get("raw_value"),
        "calibrated_value": value,
        "sensor_state": obj.get("sensor_state"),
        "error_code": obj.get("error_code"),
        "calibration_version": obj.get("calibration_version"),
        "seq": obj.get("seq"),
        "device_id": obj.get("id"),
    }


def fmt(value):
    return "" if value is None else value


def main(argv=None):
    args = build_parser().parse_args(argv)
    if not args.port and not args.url:
        print("必须给出 --port COMx（或自检用 --url loop://）", file=sys.stderr)
        return 2

    try:
        port = open_port(args)
    except Exception as exc:
        print("串口打开失败：%s" % exc, file=sys.stderr)
        print("排查：是否被 app.py / 串口监视器占用；设备管理器里是否有该 COM 口", file=sys.stderr)
        return 2

    csv_file = None
    if args.csv:
        import os
        new_file = (not os.path.exists(args.csv)) or os.path.getsize(args.csv) == 0
        csv_file = open(args.csv, "a", encoding="utf-8")
        if new_file:
            csv_file.write(",".join(FIELDS) + "\n")
            csv_file.flush()

    raws, values, timeouts, idx, skipped = [], [], 0, 0, 0
    if not args.quiet:
        print("已连接 %s@%d；标签=%s；目标样本=%s" % (
            args.url or args.port, args.baud, args.tag or "(未命名)",
            args.count or "不限（Ctrl+C 结束）"), file=sys.stderr)

    try:
        while args.count == 0 or idx < args.count:
            raw = port.readline()
            if not raw:
                timeouts += 1
                if timeouts >= args.max_timeouts:
                    print("连续 %d 次超时，判定无数据（设备未运行 / 端口不对 / 波特率不符）"
                          % timeouts, file=sys.stderr)
                    return 2
                continue
            timeouts = 0
            text = raw.decode("utf-8", errors="ignore").strip()
            row = parse_line(text)
            if row is None:
                skipped += 1
                continue

            idx += 1
            iso = time.strftime("%Y-%m-%d %H:%M:%S")
            line = [args.tag, idx, iso, fmt(row["raw_value"]), fmt(row["calibrated_value"]),
                    fmt(row["sensor_state"]), fmt(row["error_code"]),
                    fmt(row["calibration_version"]), fmt(row["seq"]), fmt(row["device_id"])]
            print(",".join(str(x) for x in line))
            if csv_file:
                csv_file.write(",".join(str(x) for x in line) + "\n")
                csv_file.flush()
            if isinstance(row["raw_value"], (int, float)):
                raws.append(float(row["raw_value"]))
            if isinstance(row["calibrated_value"], (int, float)):
                values.append(float(row["calibrated_value"]))
    except KeyboardInterrupt:
        if not args.quiet:
            print("", file=sys.stderr)
    finally:
        if csv_file:
            csv_file.close()
        try:
            port.close()
        except Exception:
            pass

    if not raws:
        print("没有读到有效样本（丢弃非法行 %d 条）" % skipped, file=sys.stderr)
        return 2

    print("", file=sys.stderr)
    print("标签=%s 有效样本=%d 丢弃非法行=%d" % (args.tag or "(未命名)", len(raws), skipped),
          file=sys.stderr)
    print("raw_value：平均 %.1f 标准差 %s 最小 %.0f 最大 %.0f" % (
        statistics.fmean(raws),
        ("%.2f" % statistics.stdev(raws)) if len(raws) > 1 else "N/A（样本<2）",
        min(raws), max(raws)), file=sys.stderr)
    if values:
        print("calibrated_value：平均 %.2f 标准差 %s" % (
            statistics.fmean(values),
            ("%.3f" % statistics.stdev(values)) if len(values) > 1 else "N/A（样本<2）"),
            file=sys.stderr)
    print("把上面的「平均 / 标准差」抄进 docs/标定与实测记录模板.md 对应档位。", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
