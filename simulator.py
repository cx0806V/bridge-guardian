import random
import time

print("===============================")
print("  Bridge Guardian  传感模拟器")
print("===============================")
print("正在模拟应变传感器数据...\n")

count = 0


try:
    while True:
        strain = random.uniform(100.0, 150.0)
        count = count + 1
        print(f"第 {count} 次采样 | 应变值: {strain:.2f} με")
        time.sleep(1)
except KeyboardInterrupt:
   print("\n✅ 模拟器已安全停止。") 
