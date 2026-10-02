# 桥体卫士 —— ESP32 采集终端（硬件闭环）

本文档说明 ESP32 + HX711 采集终端的接线、烧录、标定，以及与 Flask 后端的串口对接。

> 用途声明：本终端用于**缩尺桥梁模型的受载变化模拟**，输出为相对应变指标（无量纲），
> 并非经工程级标定的真实桥梁应变监测设备。

## 1. 硬件清单

| 器件 | 数量 | 说明 |
|---|---|---|
| ESP32 开发板（Type-C / CH340 USB 转串口） | 1 | 主控，USB 串口直连电脑（设备管理器显示 `USB-SERIAL CH340`，需装 CH341SER 驱动） |
| HX711 模块 | 1 | 24 位 ADC 称重/压力采集 |
| 称重/压力传感器 | 1 | 四线制；本项目采用 **1 kg 圆形**（配支架散件），200g 条形亦可 |
| 0.96" OLED（SSD1306，I2C） | 1 | 本地显示当前值/状态 |
| 有源蜂鸣器模块（高电平触发） | 1 | 超限本地声光报警 |
| 红色/绿色 LED 模块（板载限流电阻） | 各 1 | 状态指示，不需外接电阻 |
| 面包板 + 跳线 + Type-C 数据线 | — | 供电与连线；LED/蜂鸣器为模块，电源模块不使用（见 `docs/硬件载入步骤.md` 3.2） |

## 2. 接线表（对应 `main.py` 顶部引脚常量）

| 信号 | ESP32 GPIO | 说明 |
|---|---|---|
| HX711 DT | 21 | 数据线 |
| HX711 SCK | 22 | 时钟线 |
| HX711 VCC / GND | 3V3 / GND | 供电 |
| 传感器 E+/E-/A+/A- | HX711 对应端 | 四线制：E+/E- 激励，A+/A- 信号 |
| OLED SDA / SCL | 4 / 5 | I2C |
| OLED VCC / GND | 3V3 / GND | 供电 |
| 有源蜂鸣器 + | 26 | 高电平响 |
| 红色 LED 模块（板载电阻） | 27 | 报警指示 |
| 绿色 LED 模块（板载电阻） | 14 | 正常指示 |

> 引脚可在 `main.py` 顶部常量中按实际接线修改。

## 3. 烧录步骤

1. **刷入 MicroPython 固件**（一次即可，已刷过可跳过）：
   ```bash
   # 固件：ESP32_GENERIC-20260824-v1.29.0.bin（页面 https://micropython.org/download/ESP32_GENERIC/）
   python -m esptool --chip esp32 --port COM3 erase-flash
   python -m esptool --chip esp32 --port COM3 --baud 460800 write-flash 0x1000 ESP32_GENERIC-20260824-v1.29.0.bin
   ```
   > 工具安装：`python -m pip install esptool mpremote`。
   > esptool **v5 起命令名用连字符**（`erase-flash` / `write-flash`），v4 及更早用下划线（`erase_flash` / `write_flash`）；
   > ESP32 的写入偏移是 **0x1000**（不是 0x0）。烧录前需按住 BOOT 再点 EN 进入下载模式。
2. **上传代码**（推荐 `mpremote`；Thonny 亦可）：
   ```bash
   python -m mpremote connect COM3 fs cp firmware/main.py :main.py
   # ssd1306.py（OLED 驱动，未接 OLED 可跳过）——国内直连 GitHub Raw 常被重置，用镜像下载后上传：
   #   https://cdn.jsdelivr.net/gh/micropython/micropython-lib@master/micropython/drivers/display/ssd1306/ssd1306.py
   python -m mpremote connect COM3 fs cp ssd1306.py :ssd1306.py
   python -m mpremote connect COM3 reset
   ```
3. 复位 ESP32，OLED 应显示 `Bridge Guardian`，串口监视器每 1 秒输出一行 JSON。

## 4. 标定流程

标定的完整可复现流程（空载 + ≥3 档载荷 × 每档 ≥5 次）见 `docs/标定与实测记录模板.md`。这里给出概要：

1. **零点标定**：传感器空载（无受力），稳定后取原始读数填入 `OFFSET`（去皮基准）。
2. **比例标定**：施加已知载荷（如 100g 砝码），多档加载线性拟合得 `SCALE`。
3. 将 `OFFSET`、`SCALE` 填入 `main.py`，`CALIBRATION_VERSION` +1，重新上传。

> 相对应变指标与载荷的换算关系由缩尺桥梁模型的力学假设决定，答辩口径为
> 「受载变化模拟」，标定仅为让数值随载荷单调、稳定变化；**不声称微应变精度**。

## 5. 与 Flask 串口对接

1. 修改 `.env`（或系统环境变量）：
   ```
   DATA_SOURCE=serial
   SERIAL_PORT=COM3
   SERIAL_BAUD=115200
   ```
2. 安装依赖并启动：
   ```bash
   pip install -r requirements.txt
   python app.py
   ```
3. 大屏「设备健康度」应显示「设备在线」+ 心跳时间；拔掉 USB 或断电后显示「设备离线」，
   系统不会伪造在线状态或数据。

## 6. 数据协议

固件每秒经串口输出一行 JSON（与 `datasource.SerialSource` 解析一致）。

**新版协议（schema_version=2，推荐）：**
```json
{"schema_version": 2, "seq": 123, "device_ts": 1727400000,
 "raw_value": 8342112, "calibrated_value": 87.42, "unit": "相对应变指标",
 "calibration_version": 1, "sensor_state": "ok", "error_code": 0,
 "id": "ESP32-01"}
```
- `schema_version`：协议版本（保证演进兼容）
- `seq`：采样序号；`device_ts`：设备时间戳
- `raw_value`：HX711 原始 ADC 读数（无量纲计数，仅透出/追溯）
- `calibrated_value`：相对应变指标（无量纲，参与报警判断）
- `unit`：单位口径（固定「相对应变指标」）
- `calibration_version`：标定系数版本号
- `sensor_state`：`ok` / `uncalibrated` / `fault`；`error_code`：可读错误码（0 正常 / 1 无响应 / 2 连续异常 / 3 未标定）
- `id`：设备标识

**旧版协议（兼容）：**
```json
{"v": 123.45, "id": "ESP32-01"}
```
- `v`：视为已标定的相对应变指标（等价新版 `calibrated_value`）
- 纯数字一行 `123.45` 也兼容
