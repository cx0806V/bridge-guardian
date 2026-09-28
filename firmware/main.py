# 桥体卫士 —— ESP32 采集终端固件（MicroPython）
#
# 功能：HX711 称重/压力传感器采集 → 本地 OLED 显示 + LED/蜂鸣器报警 → 串口输出
# 协议：每行一个 JSON 对象（新版 schema_version=2，兼容旧版 {"v":..,"id":..}），与 Flask SerialSource 对接
#
# 烧录：刷入 MicroPython 固件后，将本文件保存为 main.py 上传到 ESP32 即可开机自运行。
# 依赖：OLED 需要 SSD1306 驱动（MicroPython 官方 ssd1306.py，随固件库提供）。
#
# 说明：本终端只做「受载变化模拟」的采集与本地提示，输出为相对应变指标（无量纲），
#       并非经工程级标定的真实桥梁应变监测结果。
#
# 单位口径：calibrated_value 为相对应变指标（无量纲），不声称微应变(με)精度；
#           raw_value 为 HX711 原始 ADC 读数，仅透出供追溯，不参与报警判断。

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

# ================= 协议与标定常量 =================
SCHEMA_VERSION = 2          # 串口协议版本
DEVICE_ID = "ESP32-01"      # 设备标识
SAMPLE_INTERVAL = 1.0       # 采样周期（秒）

# ---- 标定（标定流程见 docs/标定与实测记录模板.md，标定后填入）----
OFFSET = 0                 # 零点偏移：空载时的原始 ADC 读数（去皮基准）
SCALE = 1.0                # 标定系数：指标值 = (原始读数 - OFFSET) / SCALE
CALIBRATION_VERSION = 0    # 标定系数版本号（每次重新标定 +1，便于追溯）
TARED = False              # 是否已去皮（启动自检/空载标定后置 True）

THRESHOLD = 120.0          # 本地报警阈值（相对应变指标），与 Flask 侧默认一致

# ---- 滤波与容错 ----
FILTER_WINDOW = 8          # 中值/均值滤波窗口（采样点数）
FILTER_DROP = 2            # 去极值：排序后两端各丢弃的点数
CONSECUTIVE_ERROR_LIMIT = 5  # 连续异常读数计数阈值（超过判传感器故障）

# ---- 可读错误码 ----
ERR_NONE = 0               # 正常
ERR_HX711_TIMEOUT = 1      # HX711 无响应（未接 / 接线异常）
ERR_HX711_FAULT = 2        # 连续异常读数超过阈值
ERR_CALIBRATION = 3        # 未标定（CALIBRATION_VERSION==0 或未去皮）

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


# ================= 启动自检 =================
def self_test():
    """上电自检：依次点亮 LED、蜂鸣器短鸣、OLED 显示自检画面、HX711 探测。

    返回 (ok: bool, err_code: int)。自检通过才进入主循环，否则红灯常亮并输出错误码。
    """
    led_green.value(1)
    time.sleep(0.1)
    led_red.value(1)
    time.sleep(0.1)
    led_red.value(0)
    led_green.value(0)
    # 蜂鸣器短鸣确认可用
    buzzer.value(1)
    time.sleep(0.08)
    buzzer.value(0)
    if oled is not None:
        oled.fill(0)
        oled.text("Self test...", 0, 0)
        oled.show()
    # HX711 探测：连续多次读取，能读到值即认为传感器通路正常
    ok_reads = 0
    for _ in range(FILTER_WINDOW):
        if hx711_read() is not None:
            ok_reads += 1
    if ok_reads == 0:
        return False, ERR_HX711_TIMEOUT
    return True, ERR_NONE


# ================= HX711 读取（24 位，增益 128） =================
def hx711_read(timeout_ms=100):
    """读取一次 HX711 原始读数（带符号 24 位），超时返回 None。"""
    start = time.ticks_ms()
    while dt.value() == 1:   # 等待数据就绪（DT 拉低）
        if time.ticks_diff(time.ticks_ms(), start) > timeout_ms:
            return None      # 超时：传感器未接 / 接线异常，避免死循环卡死
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


def read_filtered():
    """多次采样 → 排序去极值 → 平均，返回 (raw_avg, indicator) 或 (None, None)。

    raw_avg 为原始 ADC 均值（透出）；indicator 为相对应变指标（无量纲）。
    读取异常（超时）返回 None，由调用方累计连续异常计数。
    """
    samples = []
    for _ in range(FILTER_WINDOW):
        raw = hx711_read()
        if raw is None:
            return None, None   # 读取异常
        samples.append(raw)
    samples.sort()
    keep = samples[FILTER_DROP:-FILTER_DROP] if FILTER_DROP else samples
    raw_avg = sum(keep) / len(keep)
    indicator = round((raw_avg - OFFSET) / SCALE, 2)
    return raw_avg, indicator


def display(value, alarming, err_code):
    """OLED 显示当前值、状态、错误码与设备标识（value 为 None 表示传感器异常）。"""
    if oled is None:
        return
    oled.fill(0)
    oled.text("Bridge Guardian", 0, 0)
    if value is None:
        oled.text("Indicator: SENS ERR", 0, 20)
        oled.text("State: FAULT", 0, 38)
    else:
        oled.text("Indicator: %.1f" % value, 0, 20)
        oled.text("State: %s" % ("ALARM" if alarming else "OK"), 0, 38)
    oled.text("Err:%d ID:%s" % (err_code, DEVICE_ID), 0, 54)
    oled.show()


# ================= 主循环 =================
def main():
    print("ESP32 Bridge Guardian started, id=%s schema=%d cal_ver=%d" % (
        DEVICE_ID, SCHEMA_VERSION, CALIBRATION_VERSION))

    # 启动自检
    ok, err = self_test()
    if not ok:
        led_red.value(1)
        if oled is not None:
            oled.fill(0)
            oled.text("SELF-TEST FAIL", 0, 0)
            oled.text("Err:%d" % err, 0, 20)
            oled.text("Check HX711", 0, 38)
            oled.show()
        # 自检失败也持续输出错误码（不输出伪造数据），便于上位机诊断
        while True:
            print(json.dumps({
                "schema_version": SCHEMA_VERSION, "seq": 0,
                "device_ts": int(time.time()), "raw_value": None,
                "calibrated_value": None, "unit": "相对应变指标",
                "calibration_version": CALIBRATION_VERSION,
                "sensor_state": "fault", "error_code": err, "id": DEVICE_ID,
            }))
            time.sleep(SAMPLE_INTERVAL)
        return

    led_green.value(1)
    seq = 0
    consecutive_errors = 0

    while True:
        try:
            raw_avg, indicator = read_filtered()
        except Exception:
            raw_avg, indicator = None, None

        if raw_avg is None:
            # 传感器读取异常：累计连续异常计数，红灯提示，不输出伪造数据
            consecutive_errors += 1
            led_red.value(1)
            led_green.value(0)
            err = ERR_HX711_FAULT if consecutive_errors >= CONSECUTIVE_ERROR_LIMIT else ERR_HX711_TIMEOUT
            display(None, False, err)
            print(json.dumps({
                "schema_version": SCHEMA_VERSION, "seq": seq,
                "device_ts": int(time.time()), "raw_value": None,
                "calibrated_value": None, "unit": "相对应变指标",
                "calibration_version": CALIBRATION_VERSION,
                "sensor_state": "fault", "error_code": err,
                "consecutive_errors": consecutive_errors, "id": DEVICE_ID,
            }))
            time.sleep(SAMPLE_INTERVAL)
            continue

        # 恢复正常读数：清零连续异常计数
        consecutive_errors = 0
        seq += 1
        alarming = indicator > THRESHOLD
        led_red.value(1 if alarming else 0)
        led_green.value(0 if alarming else 1)
        if alarming:
            buzzer.value(1)
            time.sleep(0.15)
            buzzer.value(0)
        display(indicator, alarming, ERR_NONE)

        # 未标定警示：CALIBRATION_VERSION==0 时状态标 uncalibrated，但仍输出读数（数值仅供参考）
        sensor_state = "ok"
        if CALIBRATION_VERSION == 0:
            sensor_state = "uncalibrated"

        # 串口输出新版 JSON（含原始 ADC + 标定值 + 单位 + 标定版本 + 传感器状态 + 错误码）
        print(json.dumps({
            "schema_version": SCHEMA_VERSION, "seq": seq,
            "device_ts": int(time.time()), "raw_value": round(raw_avg),
            "calibrated_value": indicator, "unit": "相对应变指标",
            "calibration_version": CALIBRATION_VERSION,
            "sensor_state": sensor_state, "error_code": ERR_NONE,
            "id": DEVICE_ID,
        }))
        time.sleep(SAMPLE_INTERVAL)


main()
