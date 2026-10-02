# docs/evidence —— 证据索引

> 用途：答辩现场被要求「拿证据」时按本表指认文件；**同时避免误引用历史快照**。
> 红线：本目录只放**真实运行输出**渲染的图，不做美化、不改数字。

| 文件 | 内容 | 记录时间 | 状态 |
|---|---|---|---|
| `测试全绿_101passed.png` | 本机普通终端 `python -m pytest tests/ -q` → **101 passed in 17.14s**（0 skipped） | 2026-09-30 | ✅ **当前 —— 讲稿 / PPT 引用这一张** |
| `测试全绿_37passed.png` | P3 阶段 pytest 全绿（37 passed in 3.32s） | 2026-09-28 | ⚠️ 历史快照，已被上一张取代 |
| `pytest_output_raw.txt` | 生成上一张图所用的原始 pytest 输出（37 passed） | 2026-09-28 | ⚠️ 历史；重生成 PNG 前需先刷新 |
| `故障注入_6of6.png` | `python scripts/fault_injection.py` → 6/6 通过 | 2026-09-28 | ✅ 当前（脚本未改，复跑应仍 6/6） |
| `screen_normal.png` / `screen_critical.png` / `screen_alarm_detail.png` / `screen_offline.png` / `screen_mobile_history.png` / `screen_serial_offline.png` | 大屏与手机端各状态实拍 | 2026-09-28 | ✅ 当前 |

## 重新生成测试证据（三步，数字自动取真实值）

```powershell
# 0) 前置：生成脚本需要 Pillow（2026-09-30 实测本机系统 Python 未安装；只有这个脚本需要，跑 app 不需要）
python -m pip install pillow

# 1) 刷新原始输出（在你自己的终端跑，确认 0 skipped）
python -m pytest tests/ -v 2>&1 | Out-File -Encoding utf8 docs\evidence\pytest_output_raw.txt

# 2) 重新渲染 PNG：数量从原始输出里解析，文件名自动带上真实数字
python scripts\make_evidence_images.py
```

> `scripts/make_evidence_images.py` 已改为**从原始输出解析 passed 数量**（不再写死），
> 因此套件增长后重跑不会产生「图上是旧数字」的问题；读取时用 `utf-8-sig`，兼容 PowerShell 写出的 BOM。
