import random
import time

count = 0
alarm_count = 0
warn_streak =0
CONFIRM_TIMES =3

overrun_times = []
WINDOW_SECONDS = 60
WINDOW_LIMIT = 10

try:
    print("桥梁结构健康监测模拟器启动...")
    while True:
        strain = random.uniform(100.0, 150.0)
        count = count + 1
        print(f"第 {count} 次采样 | 应变值: {strain:.2f} με")
        # 异常检测：应变值超过安全阈值报警
        if strain > 120.0:
            warn_streak += 1
            now =time.time()
            overrun_times.append(now)
            overrun_times = [t for t in overrun_times if now - t <= WINDOW_SECONDS]
            print(f" 超限{warn_streak}/{CONFIRM_TIMES} 次 | 60秒窗口内： {len(overrun_times)}次")
            if len(overrun_times) >= WINDOW_LIMIT:
                print(f"频繁超限报警： {WINDOW_SECONDS}秒内超限{len(overrun_times)}次！")
            if warn_streak >= CONFIRM_TIMES:
                print(f"确认报警： 连续{CONFIRM_TIMES}次超限！ 当前：{strain:.2f}με")
                alarm_count += 1
        else:
            warn_streak = 0  # 数据恢复正常，连续计数清零
        time.sleep(1)
except KeyboardInterrupt:
    print("\n 模拟器已安全停止。")
    if count > 0:
        rate = alarm_count / count * 100
        print(f"本次运行共报警 {alarm_count} 次")
        print(f"采样 {count} 次，报警率 {rate:.1f}%")
    else:
        print("本次运行没有采集任何数据。")
