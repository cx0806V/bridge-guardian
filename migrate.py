"""桥体卫士 —— 旧 CSV 数据迁移脚本

将早期 CSV 落盘文件导入 SQLite：
  data_log.csv   -> samples（采样数据）
  alarm_log.csv  -> alarms（自动识别旧版 3 列「类型」表头）
  config_log.csv -> settings（参数历史）

用法：
    python migrate.py            # 迁移默认文件名（追加模式）
    python migrate.py --dry-run  # 仅预览统计，不写入
    python migrate.py --reset    # 迁移前清空 samples/alarms/settings（谨慎）

时间处理说明：旧数据存在仅「HH:MM:SS」的残缺时间戳，无法恢复真实日期；
迁移时以当日日期补全，并在报告中标明数量。
历史报警的触发阈值未随旧 CSV 记录，迁移时以当前默认阈值填充。
"""
import argparse
import csv
import os
from datetime import datetime

from config import Config
from db import Database


def normalize_time(raw, fallback_date):
    """归一化时间戳：完整日期时间直接保留；仅有时分秒则用 fallback_date 补全日期。"""
    raw = (raw or "").strip()
    if not raw:
        return None
    if len(raw) >= 16:  # YYYY-MM-DD HH:MM:SS
        return raw[:19]
    return f"{fallback_date} {raw}"


def _read_rows(path):
    """读取 CSV 数据行（跳过表头），返回 (header, rows)。"""
    if not os.path.exists(path):
        return None, []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        rows = [r for r in reader if r and r[0].strip()]
    return header, rows


def import_samples(db, path, fallback_date):
    _, rows = _read_rows(path)
    seq = db.count_samples()
    count, partial = 0, 0
    for row in rows:
        ts = normalize_time(row[0], fallback_date)
        try:
            value = float(row[1])
        except (ValueError, IndexError):
            continue
        if ts is None:
            continue
        if len(row[0].strip()) < 16:
            partial += 1
        seq += 1
        db.insert_sample(ts, "LEGACY", "csv", value, seq)
        count += 1
    return count, partial


def import_alarms(db, path, fallback_date):
    _, rows = _read_rows(path)
    count, partial = 0, 0
    for row in rows:
        ts = normalize_time(row[0], fallback_date)
        try:
            value = float(row[1])
        except (ValueError, IndexError):
            continue
        if ts is None:
            continue
        if len(row[0].strip()) < 16:
            partial += 1
        level = row[2] if len(row) > 2 and row[2].strip() else "报警"
        status = row[3] if len(row) > 3 and row[3].strip() else "未处理"
        db.insert_alarm(ts, "LEGACY", "csv", value, Config.THRESHOLD,
                        level, "历史导入", "历史数据导入（旧版记录）", status)
        count += 1
    return count, partial


def import_settings(db, path, fallback_date):
    _, rows = _read_rows(path)
    count = 0
    for row in rows:
        ts = normalize_time(row[0], fallback_date)
        try:
            threshold = float(row[1])
            interval = float(row[2])
        except (ValueError, IndexError):
            continue
        if ts is None:
            continue
        db.add_setting_at(ts, threshold, interval)
        count += 1
    return count


def main():
    parser = argparse.ArgumentParser(description="旧 CSV 数据迁移到 SQLite")
    parser.add_argument("--dry-run", action="store_true", help="仅预览，不写入")
    parser.add_argument("--reset", action="store_true", help="迁移前清空 samples/alarms/settings")
    args = parser.parse_args()

    fallback_date = datetime.now().strftime("%Y-%m-%d")

    if args.dry_run:
        for path, name in [("data_log.csv", "采样数据"), ("alarm_log.csv", "报警"), ("config_log.csv", "设置")]:
            header, rows = _read_rows(path)
            print(f"[预览] {name}({path}): 表头={header}, 数据行={len(rows)}")
        print("未写入（--dry-run）。")
        return

    db = Database(Config.DB_PATH)

    if args.reset:
        db.clear_samples()
        db.clear_alarms()
        db.clear_settings()
        print("已清空 samples / alarms / settings。")

    n_data, p_data = import_samples(db, "data_log.csv", fallback_date)
    n_alarm, p_alarm = import_alarms(db, "alarm_log.csv", fallback_date)
    n_setting = import_settings(db, "config_log.csv", fallback_date)

    print("=" * 40)
    print(f"采样数据导入：{n_data} 条（残缺时间戳 {p_data} 条，已用当日日期补全）")
    print(f"报警导入：{n_alarm} 条（残缺时间戳 {p_alarm} 条）")
    print(f"参数设置导入：{n_setting} 条")
    print("=" * 40)
    print("说明：历史报警触发阈值未随旧 CSV 记录，已用当前默认阈值填充。")


if __name__ == "__main__":
    main()
