# 桥体卫士 —— ESP32 采集终端固件（MicroPython）
#
# 功能：HX711 称重/压力传感器采集 → 本地 OLED 显示 + LED/蜂鸣器报警 → 串口输出
# 协议：每行一个 JSON 对象，例如 {"v": 123.45, "id": "ESP32-01"}，与 Flask 串口数据源对接
#
# 烧录：刷入 MicroPython 固件后，将本文件保存为 main.py 上传到 ESP32 即可开机自运行。
# 依赖：OLED 需要 SSD1306 驱动（MicroPython 官方 ssd1306.py，随固件库提供）。
#
# 说明：本终端只做「受载变化模拟」的采集与本地提示，数值为相对应变（με），
#       并非经工程级标定的真实桥梁应变监测结果。

from machine import Pin, I2C
import time
import json

# ================= 引脚配置（按实际接线修改） =================
PIN_DT = 21            # HX711 数据线 DT
PIN_SCK = 22           # HX711 时钟线 SCK
PIN_BUZZER = 26        # 有源蜂鸣器（高电平响）
PIN_LED_GREEN = 14     # 绿色 LED（正常）
PIN_LED_RED = 27       # 红色 LED（报警）
OLED_SDA = 4           # OLED I2C SDA（0.96 寸 SSD1306）
OLED_SCL = 5           # OLED I2C SCL

# ================= 标定与阈值（标定后填入） =================
OFFSET = 0             # 零点偏移：空载时的原始读数
SCALE = 1.0            # 标定系数：应变值 = (原始读数 - OFFSET) / SCALE
THRESHOLD = 120.0      # 本地报警阈值（με），与 Flask 侧默认一致

DEVICE_ID = "ESP32-01"     # 设备标识
SAMPLE_INTERVAL = 1.0      # 采样周期（秒）

# ================= 初始化 =================
dt = Pin(PIN_DT, Pin.IN)
sck = Pin(PIN_SCK, Pin.OUT, value=0)
buzzer = Pin(PIN_BUZZER, Pin.OUT, value=0)
led_green = Pin(PIN_LED_GREEN, Pin.OUT, value=0)
led_red = Pin(PIN_LED_RED, Pin.OUT, value=0)

# OLED（可选，未接或驱动缺失时自动降级）
oled = None
try:
    from ssd1306 import SSD1306_I2C
    i2c = I2C(0, scl=Pin(OLED_SCL), sda=Pin(OLED_SDA), freq=400000)
    oled = SSD1306_I2C(128, 64, i2c)
except Exception:
    oled = None


# ================= HX711 读取（24 位，增益 128） =================
def hx711_read():
    """读取一次 HX711 原始读数（带符号 24 位）。"""
    while dt.value() == 1:   # 等待数据就绪（DT 拉低）
        pass
    value = 0
    for _ in range(24):
        sck.value(1)
        value = (value << 1) | dt.value()
        sck.value(0)
    sck.value(1)             # 第 25 个脉冲：通道 A 增益 128
    sck.value(0)
    if value & 0x800000:     # 符号扩展
        value -= 0x1000000
    return value


def read_strain():
    """多次采样去极值平均，转为相对应变值（με）。"""
    samples = [hx711_read() for _ in range(8)]
    samples.sort()
    avg = sum(samples[2:-2]) / 4
    return round((avg - OFFSET) / SCALE, 2)


def display(value, alarming):
    """OLED 显示当前值、状态与设备标识。"""
    if oled is None:
        return
    oled.fill(0)
    oled.text("Bridge Guardian", 0, 0)
    oled.text("Strain: %.1f ue" % value, 0, 20)
    oled.text("State: %s" % ("ALARM" if alarming else "OK"), 0, 38)
    oled.text("ID: %s" % DEVICE_ID, 0, 54)
    oled.show()


# ================= 主循环 =================
def main():
    print("ESP32 Bridge Guardian started, id=%s" % DEVICE_ID)
    led_green.value(1)
    while True:
        try:
            strain = read_strain()
        except Exception:
            strain = None

        if strain is not None:
            alarming = strain > THRESHOLD
            led_red.value(1 if alarming else 0)
            led_green.value(0 if alarming else 1)
            if alarming:
                buzzer.value(1)
                time.sleep(0.15)
                buzzer.value(0)
            display(strain, alarming)
            # 串口输出 JSON，供 Flask SerialSource 解析
            print(json.dumps({"v": strain, "id": DEVICE_ID}))
        time.sleep(SAMPLE_INTERVAL)


main()
