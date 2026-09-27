# 桥体卫士 —— 桥梁结构健康监测系统

面向桥梁应变监测场景的 Flask Web 系统，支持**模拟 / 真实硬件（ESP32 + HX711）双模式数据源**，
实现传感器采集、实时大屏、多规则可解释报警、处置闭环与历史追溯。

> 用途声明：硬件端用于**缩尺桥梁模型的受载变化模拟**，输出相对应变（με），
> 并非经工程级标定的真实桥梁应变监测设备。

## 功能特性

- **双模式数据源**：`DATA_SOURCE=sim|serial` 一键切换；串口模式下设备在线状态、最近心跳、异常原因如实显示，断线即「离线」，绝不伪造。
- **实时大屏**：风险等级、当前应变值、阈值仪表、实时曲线、设备健康度、报警分级统计、报警队列与处置闭环。
- **可解释报警**：5 类规则引擎（阈值超限 / 变化率突变 / 持续超限 / 短时波动 / 基线偏移），每条报警带「触发规则 + 触发值 + 原因」。
- **数据可靠**：统一数据结构（时间/设备号/来源/状态/审计），SQLite 存储，保留 CSV 导出与旧 CSV 一键导入。
- **安全与工程化**：密钥走环境变量、统一鉴权、写接口保护、依赖清单、测试与现场手册。

## 系统架构

```
硬件层（ESP32+HX711）→ 采集层（DataSource 抽象）→ 规则引擎（5 类规则）
  → 数据层（SQLite）→ 服务层（Flask+统一鉴权）→ 展示层（大屏）
```

## 目录结构

```
app.py                Flask 主服务（路由 + 采集服务 + API）
config.py             集中配置（环境变量 / .env）
db.py                 SQLite 数据层（samples/alarms/settings/audit）
rules.py              报警规则引擎（5 类可解释规则）
datasource.py         数据源抽象（模拟 / 串口）
migrate.py            旧 CSV 一键导入 SQLite
firmware/main.py      ESP32 MicroPython 固件
firmware/README.md    接线 / 烧录 / 标定文档
templates/            前端页面（登录 / 大屏 / 设置 / 历史）
tests/                pytest 测试套件
```

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置（可选）

```bash
cp .env.example .env   # 修改账号密码、数据源、串口等
```

默认账号 `admin / 123456`（正式使用请通过 `.env` 修改）。

### 3. 模拟模式运行

```bash
python app.py          # 默认 DATA_SOURCE=sim
# 浏览器访问 http://127.0.0.1:5000
```

### 4. 真实硬件模式运行

1. 按 `firmware/README.md` 完成接线、烧录、标定。
2. `.env` 设置：
   ```
   DATA_SOURCE=serial
   SERIAL_PORT=COM3
   SERIAL_BAUD=115200
   ```
3. `python app.py` 启动，大屏设备健康度显示「设备在线」。

## 数据管理

- **旧数据迁移**：`python migrate.py`（先 `--dry-run` 预览；`--reset` 全新导入）。
- **存储**：SQLite（`bridge.db`，默认，可经 `DB_PATH` 修改）。
- **导出**：历史页/API 支持按时间筛选导出 CSV。

## 测试

```bash
python -m pytest tests/ -v
```

## 答辩口径

系统为「缩尺桥梁模型受载变化模拟」的完整工程闭环：真实传感器采集 → 本地 OLED/LED/蜂鸣器提示 →
串口上传 → 规则引擎分级报警 → 大屏展示与处置 → SQLite 历史追溯与 CSV 导出。
所有功能均有源码、硬件与测试证据支撑，不使用无法佐证的概念。
