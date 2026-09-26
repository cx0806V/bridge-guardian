from flask import Flask, request, session, redirect, render_template, jsonify, Response
import threading, time, random, csv, os
from datetime import datetime

app = Flask(__name__)
app.secret_key = "bridge-guardian-secret"
app.config["TEMPLATES_AUTO_RELOAD"] = True   # 模板改动立即生效，不用重启

# ---------- 全局配置（集中管理，方便后期调整） ----------
USERNAME = "admin"            # 登录账号
PASSWORD = "123456"           # 登录密码
THRESHOLD = 120               # 报警阈值（单位 με）
SAMPLE_INTERVAL = 1           # 数据采集周期（秒）
CSV_ALARM = "alarm_log.csv"   # 历史报警落盘文件（历史报警查看的数据源）
CSV_DATA = "data_log.csv"     # 全部采样数据落盘文件（历史数据比对的数据源）
CSV_CONFIG = "config_log.csv" # 参数设置变更记录文件

# ---------- 禁止浏览器缓存：改完页面普通刷新就是最新版 ----------
@app.after_request
def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    return response


# ================= 采样模拟器（模拟传感器 + 数据落盘 + 报警判断） =================
class Simulator:
    def __init__(self):
        self.lock = threading.RLock()  # 保护内存状态与 CSV 文件的并发访问
        self.latest = {
            "strain": 0.0,                # 当前应变值
            "interval": SAMPLE_INTERVAL,  # 采集周期（大屏显示用）
            "threshold": THRESHOLD,       # 报警阈值（大屏显示用）
            "history": [],                # 实时曲线 [{"time","strain"}]，最多60点
            "alarms": [],                 # 当前报警 [{"time","strain","type"}]，最多200条
            "last_sample_time": "--",    # 最后一次采样时间
            "sample_count": 0,            # 本次运行累计采样次数
            "sensor_status": "模拟运行中", # 当前数据源运行状态
        }
        self.value = 80.0       # 模拟传感器当前读数
        self.alarming = False   # 边沿触发标志：防止持续超限刷屏

    def start(self):
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            with self.lock:
                # 模拟传感器：围绕80随机波动，2%概率冲高
                self.value += random.uniform(-3, 3)
                if random.random() < 0.02:
                    self.value = random.uniform(125, 150)
                self.value = round(max(50, min(180, self.value)), 2)

                sample_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")  # 本次采样完整时间
                self.latest["strain"] = self.value
                self.latest["last_sample_time"] = sample_time
                self.latest["sample_count"] += 1

                # 实时曲线保留最近60个采样点
                self.latest["history"].append({"time": sample_time, "strain": self.value})
                if len(self.latest["history"]) > 60:
                    self.latest["history"].pop(0)

                # 每个采样点全部落盘，供历史数据比对使用
                self._append_csv(CSV_DATA, ["时间", "应变值(με)"], [sample_time, self.value])

                current_threshold = self.latest["threshold"]  # 当前生效的报警阈值
                # 边沿触发：只在由正常变为超限的瞬间记录一次报警
                if self.value > current_threshold and not self.alarming:
                    self.alarming = True
                    alarm = {
                        "id": self.latest["sample_count"],
                        "time": sample_time,
                        "strain": self.value,
                        "type": self._get_alarm_level(self.value, current_threshold),
                        "status": "未处理",
                    }
                    self.latest["alarms"].append(alarm)
                    if len(self.latest["alarms"]) > 200:
                        self.latest["alarms"].pop(0)
                    self._append_csv(CSV_ALARM, ["时间", "应变值(με)", "等级", "处理状态"],
                                     [alarm["time"], alarm["strain"], alarm["type"], alarm["status"]])
                    print(f"[报警] {sample_time} 应变 {self.value} με 超过阈值 {current_threshold} με")
                elif self.value <= current_threshold:
                    self.alarming = False  # 回到安全区后，下次越线可再次报警

                current_interval = self.latest["interval"]  # 当前生效的采集周期
            time.sleep(current_interval)

    @staticmethod
    def _get_alarm_level(strain_value, threshold_value):
        """按超限幅度返回报警等级。"""
        if strain_value >= threshold_value * 1.2:
            return "严重报警"
        if strain_value >= threshold_value * 1.1:
            return "报警"
        return "预警"

    def _append_csv(self, path, header, row):
        """CSV追加写入：文件不存在则先写表头"""
        try:
            with self.lock:
                new_file = not os.path.exists(path)
                with open(path, "a", newline="", encoding="utf-8-sig") as f:
                    writer = csv.writer(f)
                    if new_file:
                        writer.writerow(header)
                    writer.writerow(row)
        except Exception as e:
            print("CSV写入失败:", e)

    def clear_data(self):
        """清除实时数据及其 CSV 历史记录"""
        with self.lock:
            self.latest["history"].clear()
            self.latest["strain"] = 0.0
            self.latest["last_sample_time"] = "--"
            self.latest["sample_count"] = 0
            with open(CSV_DATA, "w", newline="", encoding="utf-8-sig") as f:
                csv.writer(f).writerow(["时间", "应变值(με)"])

    def clear_alarms(self):
        """清除当前报警及其 CSV 历史记录"""
        with self.lock:
            self.latest["alarms"].clear()
            with open(CSV_ALARM, "w", newline="", encoding="utf-8-sig") as f:
                csv.writer(f).writerow(["时间", "应变值(με)", "等级", "处理状态"])

    def update_settings(self, threshold_value, interval_value):
        """更新报警阈值和采集周期，并记录设置变更。"""
        with self.lock:
            self.latest["threshold"] = threshold_value
            self.latest["interval"] = interval_value
            change_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            self._append_csv(CSV_CONFIG, ["时间", "报警阈值(με)", "采集周期(秒)"],
                             [change_time, threshold_value, interval_value])

    def acknowledge_alarm(self, alarm_id):
        """将指定的当前报警标记为已处理。"""
        with self.lock:
            for alarm in self.latest["alarms"]:
                if alarm["id"] == alarm_id:
                    alarm["status"] = "已处理"
                    return True
        return False


simulator = Simulator()


def read_csv_tail(path, limit=500):
    """仅读取 CSV 文件尾部，避免历史文件增长后占用过多内存。"""
    if not os.path.exists(path):
        return []

    with open(path, "rb") as file_handle:
        file_handle.seek(0, os.SEEK_END)
        file_position = file_handle.tell()
        chunks = []  # 从文件尾部向前读取的字节块
        newline_count = 0  # 已读取的换行符数量

        while file_position > 0 and newline_count <= limit:
            chunk_size = min(4096, file_position)
            file_position -= chunk_size
            file_handle.seek(file_position)
            chunk = file_handle.read(chunk_size)
            chunks.append(chunk)
            newline_count += chunk.count(b"\n")

    text = b"".join(reversed(chunks)).decode("utf-8-sig")
    lines = text.splitlines()
    if file_position > 0:
        lines = lines[1:]  # 丢弃从文件中间开始的首个不完整行

    rows = list(csv.reader(lines))
    if rows and rows[0] and rows[0][0] == "时间":
        rows.pop(0)  # 小文件时尾部内容包含 CSV 表头
    return rows[-limit:]


def filter_history_rows(rows, query_args):
    """按开始和结束时间筛选已读取的历史记录。"""
    start_time = query_args.get("start", "")  # 前端传入的开始时间
    end_time = query_args.get("end", "")  # 前端传入的结束时间
    if len(start_time) == 16:
        start_time += ":00"  # datetime-local 未填写秒时从该分钟开始筛选
    if len(end_time) == 16:
        end_time += ":59"  # datetime-local 未填写秒时包含该分钟全部数据
    return [
        row for row in rows
        if row and (not start_time or row[0] >= start_time) and (not end_time or row[0] <= end_time)
    ]


# ================= 页面路由 =================
@app.route("/")
def index():
    return redirect("/dashboard")

@app.route("/login", methods=["GET", "POST"])
def login():
    error = ""
    if request.method == "POST":
        if request.form.get("username") == USERNAME and request.form.get("password") == PASSWORD:
            session["user"] = request.form["username"]
            return redirect("/dashboard")
        error = "用户名或密码错误"
    return render_template("login.html", error=error)

@app.route("/logout")
def logout():
    session.clear()
    return redirect("/login")

@app.route("/dashboard")
def dashboard():
    if "user" not in session:
        return redirect("/login")
    return render_template("dashboard.html", user=session["user"], threshold=simulator.latest["threshold"])

@app.route("/settings")
def settings_page():
    """系统设置页，用于调整报警阈值和采集周期。"""
    if "user" not in session:
        return redirect("/login")
    return render_template("settings.html")

@app.route("/history")
def history_page():
    """历史记录页：点击主画面入口进入，点返回回主画面"""
    if "user" not in session:
        return redirect("/login")
    return render_template("history.html", threshold=simulator.latest["threshold"])

# ================= 数据接口 =================
@app.route("/api/data")
def api_data():
    """大屏每秒轮询：返回数据快照（拷贝一份，避免与采样线程冲突）"""
    with simulator.lock:
        data_snapshot = {
            "strain": simulator.latest["strain"],
            "interval": simulator.latest["interval"],
            "threshold": simulator.latest["threshold"],
            "history": list(simulator.latest["history"]),
            "alarms": list(simulator.latest["alarms"]),
            "last_sample_time": simulator.latest["last_sample_time"],
            "sample_count": simulator.latest["sample_count"],
            "sensor_status": simulator.latest["sensor_status"],
        }
    return jsonify(data_snapshot)

@app.route("/api/clear_alarms", methods=["POST"])
def clear_alarms():
    """一键清除当前报警与 CSV 历史报警"""
    simulator.clear_alarms()
    return jsonify({"ok": True})

@app.route("/api/clear_data", methods=["POST"])
def clear_data():
    """一键清除当前数据与 CSV 历史数据"""
    simulator.clear_data()
    return jsonify({"ok": True})

@app.route("/api/settings", methods=["GET", "POST"])
def settings():
    """读取或保存监测参数。"""
    if request.method == "GET":
        with simulator.lock:
            return jsonify({"threshold": simulator.latest["threshold"], "interval": simulator.latest["interval"]})

    try:
        threshold_value = float(request.json["threshold"])
        interval_value = float(request.json["interval"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "请输入有效的阈值和采集周期。"}), 400

    if not 1 <= threshold_value <= 200 or not 0.1 <= interval_value <= 60:
        return jsonify({"error": "阈值范围为 1-200，采集周期范围为 0.1-60 秒。"}), 400

    simulator.update_settings(threshold_value, interval_value)
    return jsonify({"ok": True})

@app.route("/api/acknowledge_alarm/<int:alarm_id>", methods=["POST"])
def acknowledge_alarm(alarm_id):
    """确认处理主画面中的单条报警。"""
    if simulator.acknowledge_alarm(alarm_id):
        return jsonify({"ok": True})
    return jsonify({"error": "报警不存在或已被清除。"}), 404

@app.route("/api/history_alarms")
def history_alarms():
    """历史报警信息查看（读 alarm_log.csv 最后500条）"""
    try:
        with simulator.lock:
            rows = filter_history_rows(read_csv_tail(CSV_ALARM), request.args)
        return jsonify(rows)
    except (OSError, UnicodeError, csv.Error) as error:
        return jsonify({"error": f"读取历史报警失败：{error}"}), 500

@app.route("/api/history_data")
def history_data():
    """历史数据查看比对（读 data_log.csv 最后500条）"""
    try:
        with simulator.lock:
            rows = filter_history_rows(read_csv_tail(CSV_DATA), request.args)
        return jsonify(rows)
    except (OSError, UnicodeError, csv.Error) as error:
        return jsonify({"error": f"读取历史数据失败：{error}"}), 500

@app.route("/api/export/<record_type>")
def export_history(record_type):
    """导出筛选后的历史报警或监测数据 CSV 文件。"""
    file_map = {
        "alarms": (CSV_ALARM, ["时间", "应变值(με)", "等级", "处理状态"]),
        "data": (CSV_DATA, ["时间", "应变值(με)"]),
    }
    if record_type not in file_map:
        return jsonify({"error": "不支持的导出类型。"}), 404

    path, header = file_map[record_type]
    with simulator.lock:
        rows = filter_history_rows(read_csv_tail(path), request.args)
    output_lines = [header] + rows
    text_rows = []
    for row in output_lines:
        text_rows.append(",".join(f'"{str(value).replace(chr(34), chr(34) * 2)}"' for value in row))
    response = Response("\ufeff" + "\n".join(text_rows), mimetype="text/csv")
    response.headers["Content-Disposition"] = f"attachment; filename={record_type}_history.csv"
    return response


if __name__ == "__main__":
    simulator.start()   # 启动采样线程
    app.run(debug=False, host="0.0.0.0", port=5000)
