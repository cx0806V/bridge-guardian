import random
import time

count = 0
alarm_count = 0

try:
    print("桥梁结构健康监测模拟器启动...")
    while True:
        strain = random.uniform(100.0, 150.0)
        count = count + 1
        print(f"第 {count} 次采样 | 应变值: {strain:.2f} με")
        # 异常检测：应变值超过安全阈值报警
        if strain > 145.0:
            print("警告: 应变值超限! 当前值:", f"{strain:.2f}με")
            alarm_count += 1
        time.sleep(1)
except KeyboardInterrupt:
    print("\n 模拟器已安全停止。")
    if count > 0:
        rate = alarm_count / count * 100
        print(f"本次运行共报警 {alarm_count} 次")
        print(f"采样 {count} 次，报警率 {rate:.1f}%")
    else:
        print("本次运行没有采集任何数据。")
