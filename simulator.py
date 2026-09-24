import random
import time
import csv
import threading

# ===== 数据共享区（Flask 从这里读数据）=====
latest = {
    "strain": 0.0,          # 当前应变值
    "count": 0,             # 采样次数
    "alarm_active": False,  # 是否处于报警状态
    "record_type": "",      # 最近一条记录类型
    "history": [],          # 最近 60 条 [时间, 应变值]
    "alarms": []            # 报警记录 [时间, 应变值, 类型]
}

count = 0
alarm_count = 0
warn_streak = 0
CONFIRM_TIMES = 3
alarm_active = False

overrun_times = []
WINDOW_SECONDS = 60
WINDOW_LIMIT = 10
CSV_FILE = "strain_data.csv"

def sampler():
    """采样线程：每秒采一次，保留你原来的报警逻辑"""
    global count, alarm_count, warn_streak, alarm_active, overrun_times
    while True:
        strain = random.uniform(100.0, 150.0)
        # 演示用：约 8% 概率强制冲高，方便录屏时快速触发报警
        if random.random() < 0.08:
            strain = random.uniform(125.0, 150.0)
        count += 1
        record_type = ""
        now = time.time()

        if strain > 120.0:
            warn_streak += 1
            overrun_times.append(now)
            overrun_times = [t for t in overrun_times if now - t <= WINDOW_SECONDS]
            print(f"超限！{warn_streak}/{CONFIRM_TIMES}次 | 60秒窗口内：{len(overrun_times)}次")
            if len(overrun_times) >= WINDOW_LIMIT and not alarm_active:
                print(f"频繁超限报警：{WINDOW_SECONDS}秒内超限{len(overrun_times)}次！")
                record_type = "频繁超限报警"
                alarm_active = True
            if warn_streak >= CONFIRM_TIMES and not alarm_active:
                print(f"确认报警：连续{CONFIRM_TIMES}次超限！当前：{strain:.2f}με")
                record_type = "确认报警"
                alarm_count += 1
                alarm_active = True
        else:
            warn_streak = 0
            alarm_active = False

        # 更新共享数据（大屏每秒读这里）
        t_str = time.strftime("%H:%M:%S")
        latest["strain"] = round(strain, 2)
        latest["count"] = count
        latest["alarm_active"] = alarm_active
        latest["record_type"] = record_type
        latest["history"].append([t_str, round(strain, 2)])
        if len(latest["history"]) > 60:
            latest["history"].pop(0)
        if record_type:
            latest["alarms"].append([t_str, round(strain, 2), record_type])
            if len(latest["alarms"]) > 20:
                latest["alarms"].pop(0)

        # 每次采样写入 CSV（保留你原来的数据落盘）
        with open(CSV_FILE, "a", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            if f.tell() == 0:
                writer.writerow(["序号", "时间", "应变值", "报警类型"])
            writer.writerow([count, t_str, f"{strain:.2f}", record_type])

        time.sleep(1)

def start_sampler():
    """供 app.py 调用：后台线程启动采样"""
    t = threading.Thread(target=sampler, daemon=True)
    t.start()