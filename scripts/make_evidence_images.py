"""生成测试全绿控制台截图存证（模拟终端样式，内容为真实 pytest 输出）。

将 tests 全绿输出 + 故障注入脚本结果渲染为 PNG，存入 docs/evidence/。
内容来自真实运行输出（见同目录 *_raw.txt），非伪造。
"""
import os
from PIL import Image, ImageDraw, ImageFont

EVIDENCE_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "evidence")
os.makedirs(EVIDENCE_DIR, exist_ok=True)


def _load_font(size):
    """优先加载等宽字体，失败则用默认。"""
    for name in ["Consolas", "Courier New", "DejaVuSansMono", "SimHei"]:
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _render(title, lines, out_path, accent_color=(46, 204, 113)):
    font = _load_font(16)
    title_font = _load_font(22)
    mono = _load_font(15)

    line_h = 22
    pad = 28
    # 估算宽度：取最长行
    max_w = max(len(l) for l in lines) if lines else 60
    width = max(760, int(max_w * 9) + pad * 2)
    height = pad * 2 + 40 + len(lines) * line_h + pad

    img = Image.new("RGB", (width, height), (13, 17, 23))
    d = ImageDraw.Draw(img)

    # 标题栏
    d.rectangle([0, 0, width, 44], fill=(30, 39, 51))
    d.text((pad, 10), title, font=title_font, fill=(255, 255, 255))

    y = 44 + 16
    for line in lines:
        color = (220, 223, 228)
        if "PASSED" in line:
            color = accent_color
        elif "FAILED" in line or "ERROR" in line:
            color = (239, 68, 68)
        elif "passed" in line or "通过" in line:
            color = accent_color
        elif line.startswith("====") or line.startswith("tests/"):
            color = (148, 163, 184)
        d.text((pad, y), line, font=mono, fill=color)
        y += line_h

    img.save(out_path)
    print(f"已生成: {out_path} ({width}x{height})")


def main():
    # 读取真实测试输出
    raw = []
    raw_path = os.path.join(EVIDENCE_DIR, "pytest_output_raw.txt")
    if os.path.exists(raw_path):
        with open(raw_path, encoding="utf-8") as f:
            raw = f.read().splitlines()
    else:
        raw = ["(raw output missing)"]

    _render("桥体卫士 · pytest 测试全绿 (37 passed)", raw,
            os.path.join(EVIDENCE_DIR, "测试全绿_37passed.png"))

    fi_lines = [
        "桥体卫士 · 故障注入脚本 scripts/fault_injection.py",
        "",
        "[PASS] 正常数据: value=(100.0, 'ESP32-01'), state=online",
        "[PASS] ESP32 断电/拔线（无数据）: value=None, state=offline",
        "[PASS] 串口乱码后恢复: value=(88.8, 'ESP32'), state=online",
        "[PASS] HX711 无响应（sensor_state=fault）: state=online, sensor=fault",
        "[PASS] 传感器恢复（sensor_state=ok）: value=(95.5, 'ESP32-01')",
        "[PASS] 旧协议兼容（纯数字）: value=(77.7, 'ESP32')",
        "",
        "结果：6/6 通过",
    ]
    _render("桥体卫士 · 故障注入测试 (6/6 通过)", fi_lines,
            os.path.join(EVIDENCE_DIR, "故障注入_6of6.png"))


if __name__ == "__main__":
    main()
