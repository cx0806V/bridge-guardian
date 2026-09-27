"""桥体卫士 —— 桥梁结构健康监测系统（Flask 后端）

架构分层：
  数据源层（模拟/串口）→ 采集层（Simulator）→ 规则引擎（rules）→ 数据层（SQLite）
  → 服务层（Flask + 统一鉴权）→ 展示层（大屏）

数据可靠性要点：
  - 统一数据结构：时间格式 YYYY-MM-DD HH:MM:SS、设备标识、数据来源、报警状态、审计记录
  - 存储：SQLite（samples/alarms/settings/audit），保留 CSV 导出
  - 报警可解释：每条报警带 rule（触发规则）与 reason（触发值 + 阈值）
"""
from flask import Flask, request, session, redirect, render_template, jsonify, Response, url_for
from functools import wraps
import io
import threading
import time
import random
import csv
from datetime import datetime

from config import Config
from db import Database, now_str
from rules import RuleEngine

app = Flask(__name__)
app.secret_key = Config.SECRET_KEY
app.config["TEMPLATES_AUTO_RELOAD"] = True   # 模板改动立即生效，不用重启

# ---------- 全局配置（从环境变量 / .env 集中读取，不硬编码密钥） ----------
USERNAME = Config.USERNAME        # 登录账号
PASSWORD = Config.PASSWORD        # 登录密码
THRESHOLD = Config.THRESHOLD      # 报警阈值（单位 με）
SAMPLE_INTERVAL = Config.SAMPLE_INTERVAL  # 数据采集周期（秒）

# ---------- 设备与数据源标识（串口模式由固件上报，模拟模式用固定值） ----------
DEVICE_ID = "SIM-01"              # 模拟设备标识
SOURCE = "sim"                    # 数据来源

HISTORY_LIMIT = 60                # 实时曲线保留点数
ALARM_CACHE_LIMIT = 200           # 大屏报警缓存条数


# ---------- 禁止浏览器缓存：改完页面普通刷新就是最新版 ----------
@app.after_request
def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def login_required(view):
    """统一鉴权：未登录时 API 返回 401 JSON，页面重定向到登录页。"""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if "user" not in session:
            if request.path.startswith("/api/"):
                return jsonify({"error": "未登录或会话已过期"}), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapped


# ================= 采集与数据服务 =================
class Simulator:
    """采集服务：模拟传感器生成数据，规则引擎评估，SQLite 落盘。

    模拟模式保留原有随机波动行为；串口模式在 P3 以 DataSource 抽象接入，
    本类的报警判断、存储、状态维护逻辑保持通用。
    """

    def __init__(self):
        self.lock = threading.RLock()          # 保护内存状态与数据库并发访问
        self.db = Database(Config.DB_PATH)     # SQLite 数据层
        self.device_id = DEVICE_ID
        self.source = SOURCE

        # 启动时恢复最近一次有效设置
        setting = self.db.latest_setting()
        threshold = setting["threshold"] if setting else THRESHOLD
        interval = setting["interval"] if setting else SAMPLE_INTERVAL

        self.engine = RuleEngine(threshold=threshold)  # 规则引擎
        self.latest = {
            "strain": 0.0,                # 当前应变值
            "interval": interval,         # 采集周期（大屏显示用）
            "threshold": threshold,       # 报警阈值（大屏显示用）
            "history": [],                # 实时曲线 [{"time","strain"}]，最多60点
            "alarms": [],                 # 报警缓存（含 rule/reason），最多200条
            "last_sample_time": "--",     # 最后一次采样时间
            "sample_count": self.db.count_samples(),  # 累计采样次数（含历史）
            "sensor_status": "模拟运行中",  # 数据源运行状态
        }
        self.value = 80.0                 # 模拟传感器当前读数

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

                ts = now_str()
                self.latest["strain"] = self.value
                self.latest["last_sample_time"] = ts
                self.latest["sample_count"] += 1
                seq = self.latest["sample_count"]

                # 实时曲线保留最近 N 个采样点
                self.latest["history"].append({"time": ts, "strain": self.value})
                if len(self.latest["history"]) > HISTORY_LIMIT:
                    self.latest["history"].pop(0)

                # 每个采样点落盘 SQLite，供历史数据比对使用
                self.db.insert_sample(ts, self.device_id, self.source, self.value, seq)

                # 规则引擎评估（可能产生多条报警，每条可解释）
                triggered = self.engine.evaluate(ts, self.value)
                for item in triggered:
                    alarm_id = self.db.insert_alarm(
                        ts, self.device_id, self.source, self.value,
                        self.latest["threshold"], item["level"],
                        item["rule"], item["reason"])
                    alarm = {
                        "id": alarm_id,
                        "time": ts,
                        "strain": self.value,
                        "type": item["level"],
                        "rule": item["rule"],
                        "reason": item["reason"],
                        "status": "未处理",
                    }
                    self.latest["alarms"].append(alarm)
                    if len(self.latest["alarms"]) > ALARM_CACHE_LIMIT:
                        self.latest["alarms"].pop(0)
                    print(f"[报警] {ts} {item['rule']}: {item['reason']}")

                current_interval = self.latest["interval"]
            time.sleep(current_interval)

    # ---------- 数据/报警操作（含审计） ----------
    def clear_data(self, actor):
        """清除实时数据与 SQLite 采样记录。"""
        with self.lock:
            self.latest["history"].clear()
            self.latest["strain"] = 0.0
            self.latest["last_sample_time"] = "--"
            self.latest["sample_count"] = 0
            self.db.clear_samples()
            self.db.add_audit(actor, "clear_data", "清除全部采样数据")
            self.engine.reset()

    def clear_alarms(self, actor):
        """清除报警缓存与 SQLite 报警记录。"""
        with self.lock:
            self.latest["alarms"].clear()
            self.db.clear_alarms()
            self.db.add_audit(actor, "clear_alarms", "清除全部报警记录")

    def update_settings(self, actor, threshold_value, interval_value):
        """更新报警阈值与采集周期，并写入参数历史与审计。"""
        with self.lock:
            self.latest["threshold"] = threshold_value
            self.latest["interval"] = interval_value
            self.engine.set_threshold(threshold_value)
            self.db.add_setting(threshold_value, interval_value)
            self.db.add_audit(actor, "update_settings",
                              f"阈值={threshold_value} με，周期={interval_value} 秒")

    def acknowledge_alarm(self, actor, alarm_id):
        """将指定报警标记为已处理（按数据库主键精确匹配，避免歧义）。"""
        with self.lock:
            updated = self.db.acknowledge_alarm(alarm_id)
            if not updated:
                return False
            for alarm in self.latest["alarms"]:
                if alarm["id"] == alarm_id:
                    alarm["status"] = "已处理"
                    break
            self.db.add_audit(actor, "acknowledge_alarm", f"报警 #{alarm_id} 已处理")
            return True


simulator = Simulator()


# ---------- CSV 导出辅助 ----------
def _csv_response(header, rows, filename):
    """将表头 + 行数据导出为带 BOM 的 CSV 下载（Excel 中文不乱码）。"""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows(rows)
    response = Response("\ufeff" + buf.getvalue(), mimetype="text/csv")
    response.headers["Content-Disposition"] = f"attachment; filename={filename}"
    return response


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
@login_required
def dashboard():
    return render_template("dashboard.html", user=session["user"],
                           threshold=simulator.latest["threshold"])


@app.route("/settings")
@login_required
def settings_page():
    """系统设置页，用于调整报警阈值和采集周期。"""
    return render_template("settings.html")


@app.route("/history")
@login_required
def history_page():
    """历史记录页：点击主画面入口进入，点返回回主画面"""
    return render_template("history.html", threshold=simulator.latest["threshold"])


# ================= 数据接口 =================
@app.route("/api/data")
@login_required
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
            "device_id": simulator.device_id,
            "source": simulator.source,
        }
    return jsonify(data_snapshot)


@app.route("/api/clear_alarms", methods=["POST"])
@login_required
def clear_alarms():
    """一键清除报警（含 SQLite 历史），写入审计。"""
    simulator.clear_alarms(session["user"])
    return jsonify({"ok": True})


@app.route("/api/clear_data", methods=["POST"])
@login_required
def clear_data():
    """一键清除数据（含 SQLite 历史），写入审计。"""
    simulator.clear_data(session["user"])
    return jsonify({"ok": True})


@app.route("/api/settings", methods=["GET", "POST"])
@login_required
def settings():
    """读取或保存监测参数。"""
    if request.method == "GET":
        with simulator.lock:
            return jsonify({"threshold": simulator.latest["threshold"],
                            "interval": simulator.latest["interval"]})

    try:
        threshold_value = float(request.json["threshold"])
        interval_value = float(request.json["interval"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "请输入有效的阈值和采集周期。"}), 400

    if not 1 <= threshold_value <= 200 or not 0.1 <= interval_value <= 60:
        return jsonify({"error": "阈值范围为 1-200，采集周期范围为 0.1-60 秒。"}), 400

    simulator.update_settings(session["user"], threshold_value, interval_value)
    return jsonify({"ok": True})


@app.route("/api/acknowledge_alarm/<int:alarm_id>", methods=["POST"])
@login_required
def acknowledge_alarm(alarm_id):
    """确认处理主画面中的单条报警。"""
    if simulator.acknowledge_alarm(session["user"], alarm_id):
        return jsonify({"ok": True})
    return jsonify({"error": "报警不存在或已被清除。"}), 404


@app.route("/api/history_alarms")
@login_required
def history_alarms():
    """历史报警查询（从 SQLite 读取，支持 start/end 时间筛选）。"""
    rows = simulator.db.query_alarms(request.args.get("start"), request.args.get("end"))
    return jsonify(rows)


@app.route("/api/history_data")
@login_required
def history_data():
    """历史数据查询（从 SQLite 读取，支持 start/end 时间筛选）。"""
    rows = simulator.db.query_samples(request.args.get("start"), request.args.get("end"))
    return jsonify(rows)


@app.route("/api/export/<record_type>")
@login_required
def export_history(record_type):
    """导出筛选后的历史报警或监测数据 CSV 文件（从 SQLite 生成）。"""
    start = request.args.get("start")
    end = request.args.get("end")
    if record_type == "alarms":
        rows = simulator.db.query_alarms(start, end)
        header = ["时间", "应变值(με)", "等级", "规则", "原因", "处理状态"]
        data = [[r["ts"], r["value"], r["level"], r["rule"], r["reason"], r["status"]] for r in rows]
        return _csv_response(header, data, "alarms_history.csv")
    if record_type == "data":
        rows = simulator.db.query_samples(start, end)
        header = ["时间", "应变值(με)"]
        data = [[r["ts"], r["value"]] for r in rows]
        return _csv_response(header, data, "data_history.csv")
    return jsonify({"error": "不支持的导出类型。"}), 404


if __name__ == "__main__":
    simulator.start()   # 启动采样线程
    app.run(debug=False, host="0.0.0.0", port=5000)
