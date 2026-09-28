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
import secrets
import threading
import time
import csv
from datetime import datetime

from config import Config
from db import Database, now_str
from rules import RuleEngine
from datasource import SimulatedSource, SerialSource, UNIT

app = Flask(__name__)
app.secret_key = Config.SECRET_KEY
app.config["TEMPLATES_AUTO_RELOAD"] = True   # 模板改动立即生效，不用重启

# Session Cookie 加固：HttpOnly + SameSite=Lax；Secure 仅在有 HTTPS 时开启
app.config["SESSION_COOKIE_HTTPONLY"] = Config.SESSION_COOKIE_HTTPONLY
app.config["SESSION_COOKIE_SAMESITE"] = Config.SESSION_COOKIE_SAMESITE
app.config["SESSION_COOKIE_SECURE"] = Config.SESSION_COOKIE_SECURE

# ---------- 全局配置（从环境变量 / .env 集中读取，不硬编码密钥） ----------
USERNAME = Config.USERNAME        # 登录账号
THRESHOLD = Config.THRESHOLD      # 报警阈值（相对应变指标，无量纲）
SAMPLE_INTERVAL = Config.SAMPLE_INTERVAL  # 数据采集周期（秒）

# ---------- 采集参数 ----------
HISTORY_LIMIT = 60                # 实时曲线保留点数
ALARM_CACHE_LIMIT = 200           # 大屏报警缓存条数

# 模拟模式可控场景（与 datasource.SimulatedSource 保持一致）
SCENARIOS = ("normal", "warn", "alarm", "critical", "offline", "recover")
SCENARIO_LABELS = {
    "normal": "正常运行", "warn": "预警", "alarm": "报警",
    "critical": "严重报警", "offline": "设备离线", "recover": "设备恢复",
}


# ---------- 禁止浏览器缓存：改完页面普通刷新就是最新版 ----------
@app.after_request
def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    return response


# ---------- CSRF 防护（基于 Session 的同步令牌校验）----------
def _csrf_token():
    """获取或创建 session 中的 CSRF token。"""
    token = session.get(Config.CSRF_TOKEN_NAME)
    if not token:
        token = secrets.token_hex(16)
        session[Config.CSRF_TOKEN_NAME] = token
    return token


@app.before_request
def csrf_protect():
    """对状态变更方法（POST/PUT/PATCH/DELETE）强制校验 CSRF token。

    采用基于 Session 的同步令牌校验（Synchronizer Token Pattern）：登录后后端在
    session 中生成 token，前端读取后经 X-CSRF-Token 头回传，后端与 session 中的
    值做常量时间比对。登录接口与未登录请求豁免（登录前无可信 token，
    未登录请求交给 login_required 返回 401）。
    """
    if request.method not in ("POST", "PUT", "PATCH", "DELETE"):
        return None
    # 登录接口豁免：登录前的 POST 不校验 CSRF
    if request.path == "/login":
        return None
    # 未登录请求豁免 CSRF，交给 login_required 返回 401（保持原有语义）
    if "user" not in session:
        return None
    token = request.headers.get(Config.CSRF_HEADER)
    expected = session.get(Config.CSRF_TOKEN_NAME)
    if not token or not expected or not secrets.compare_digest(token, expected):
        if request.path.startswith("/api/"):
            return jsonify({"error": "CSRF 校验失败，请刷新页面后重试"}), 403
        return "CSRF 校验失败", 403
    return None


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
        self.source = Config.DATA_SOURCE       # 数据来源 sim / serial

        # 启动时恢复最近一次有效设置
        setting = self.db.latest_setting()
        threshold = setting["threshold"] if setting else THRESHOLD
        interval = setting["interval"] if setting else SAMPLE_INTERVAL

        self.engine = RuleEngine(threshold=threshold)  # 规则引擎
        self.data_source = self._build_source()        # 数据源（模拟/串口）
        self.data_source.start()
        self.device_id = self.data_source.device_id
        self._was_online = None   # 设备在线状态边沿检测基准（None 表示尚未确定）
        self._start_time = time.time()   # 系统启动时刻（计算运行时长）
        self._prev_strain = None         # 上一次采样值（计算变化率）
        self.latest = {
            "strain": 0.0,                # 当前应变值
            "rate": None,                 # 当前变化率（με/采样周期）
            "interval": interval,         # 采集周期（大屏显示用）
            "threshold": threshold,       # 报警阈值（大屏显示用）
            "history": [],                # 实时曲线 [{"time","strain"}]，最多60点
            "alarms": [],                 # 报警缓存（含 rule/reason），最多200条
            "last_sample_time": "--",     # 最后一次采样时间
            "sample_count": self.db.count_samples(),  # 累计采样次数（含历史）
            "sensor_status": self.data_source.status_text(),  # 数据源运行状态
            "device_health": self.data_source.health(),        # 设备健康度
        }

    def _build_source(self):
        """根据配置构建数据源（模拟 / 串口）。"""
        if Config.DATA_SOURCE == "serial":
            return SerialSource(Config.SERIAL_PORT, Config.SERIAL_BAUD)
        return SimulatedSource()

    def current_scenario(self):
        """返回当前模拟场景名（仅模拟模式有意义，串口模式返回 None）。"""
        src = self.data_source
        if isinstance(src, SimulatedSource):
            return src.scenario
        return None

    def set_scenario(self, actor, name):
        """切换模拟场景（仅模拟模式有效），写入审计。串口模式拒绝切换。"""
        src = self.data_source
        if not isinstance(src, SimulatedSource):
            return False, "真实串口模式下不可切换模拟场景"
        if name not in SCENARIOS:
            return False, f"未知场景 {name!r}"
        with self.lock:
            ok = src.set_scenario(name)
            if ok:
                self.db.add_audit(actor, "set_scenario",
                                  f"模拟场景切换为 {SCENARIO_LABELS.get(name, name)}")
                # 场景切换会影响规则引擎状态，重置避免残留滞回/边沿状态
                self.engine.reset()
        return ok, ""

    def start(self):
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            with self.lock:
                sample = self.data_source.read_sample()
                # 刷新设备状态、记录心跳、检测离线/恢复边沿
                self._update_device_state(sample)
                if sample is not None:
                    self._process_sample(sample[0], sample[1])
                current_interval = self.latest["interval"]
            time.sleep(current_interval)

    def _update_device_state(self, sample):
        """刷新设备状态，记录心跳，检测离线/恢复边沿并生成可解释报警。"""
        self.device_id = self.data_source.device_id
        self.latest["sensor_status"] = self.data_source.status_text()
        health = self.data_source.health()
        self.latest["device_health"] = health
        if self.source != "serial":
            return  # 模拟模式始终在线，无心跳/离线概念

        is_online = health.get("state") == "online"
        # 收到数据即记录一次心跳
        if sample is not None:
            self.db.insert_heartbeat(now_str(), self.device_id, self.source, "beat")
        # 离线/恢复边沿检测
        if self._was_online is None:
            self._was_online = is_online  # 首次确定基准，不触发报警
        elif is_online and not self._was_online:
            self._record_device_event("设备恢复", "预警", "设备已恢复在线", "已恢复")
            self._was_online = True
        elif not is_online and self._was_online:
            reason = health.get("last_error") or "心跳超时"
            self._record_device_event("设备离线", "严重报警", f"设备失去连接：{reason}", "未处理")
            self._was_online = False

    def _record_device_event(self, rule, level, reason, status):
        """记录设备事件（离线/恢复）为可解释报警，并写入心跳事件表。"""
        ts = now_str()
        event = "offline" if rule == "设备离线" else "online"
        self.db.insert_heartbeat(ts, self.device_id, self.source, event)
        alarm_id = self.db.insert_alarm(
            ts, self.device_id, self.source, 0.0,
            self.latest["threshold"], level, rule, reason, status)
        alarm = {
            "id": alarm_id,
            "time": ts,
            "strain": 0.0,
            "type": level,
            "rule": rule,
            "reason": reason,
            "status": status,
        }
        self.latest["alarms"].append(alarm)
        if len(self.latest["alarms"]) > ALARM_CACHE_LIMIT:
            self.latest["alarms"].pop(0)
        print(f"[设备事件] {ts} {rule}: {reason}")

    def _process_sample(self, value, device_id):
        """处理一个采样点：更新状态、落盘 SQLite、规则评估。"""
        ts = now_str()
        self.latest["strain"] = value
        # 变化率：相邻采样点差值（首次采样无前值记为 None）
        self.latest["rate"] = round(value - self._prev_strain, 2) if self._prev_strain is not None else None
        self._prev_strain = value
        self.latest["last_sample_time"] = ts
        self.latest["sample_count"] += 1
        seq = self.latest["sample_count"]

        # 实时曲线保留最近 N 个采样点
        self.latest["history"].append({"time": ts, "strain": value})
        if len(self.latest["history"]) > HISTORY_LIMIT:
            self.latest["history"].pop(0)

        # 每个采样点落盘 SQLite，供历史数据比对使用
        self.db.insert_sample(ts, device_id, self.source, value, seq)

        # 规则引擎评估（可能产生多条报警，每条可解释）
        triggered = self.engine.evaluate(ts, value)
        for item in triggered:
            alarm_id = self.db.insert_alarm(
                ts, device_id, self.source, value,
                self.latest["threshold"], item["level"],
                item["rule"], item["reason"])
            alarm = {
                "id": alarm_id,
                "time": ts,
                "strain": value,
                "type": item["level"],
                "rule": item["rule"],
                "reason": item["reason"],
                "status": "未处理",
            }
            self.latest["alarms"].append(alarm)
            if len(self.latest["alarms"]) > ALARM_CACHE_LIMIT:
                self.latest["alarms"].pop(0)
            print(f"[报警] {ts} {item['rule']}: {item['reason']}")

    # ---------- 数据/报警操作（含审计） ----------
    def clear_data(self, actor):
        """清除实时数据与 SQLite 采样记录。"""
        with self.lock:
            self.latest["history"].clear()
            self.latest["strain"] = 0.0
            self.latest["last_sample_time"] = "--"
            self.latest["sample_count"] = 0
            self.db.clear_samples()
            self.db.clear_heartbeats()
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
        if request.form.get("username") == USERNAME and Config.verify_password(request.form.get("password", "")):
            session.clear()
            session["user"] = request.form["username"]
            _csrf_token()  # 登录成功后立即建立 CSRF token
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
                           threshold=simulator.latest["threshold"],
                           csrf_token=_csrf_token(), unit=UNIT)


@app.route("/settings")
@login_required
def settings_page():
    """系统设置页，用于调整报警阈值和采集周期。"""
    return render_template("settings.html", csrf_token=_csrf_token(), unit=UNIT)


@app.route("/history")
@login_required
def history_page():
    """历史记录页：点击主画面入口进入，点返回回主画面"""
    return render_template("history.html", threshold=simulator.latest["threshold"],
                           csrf_token=_csrf_token(), unit=UNIT)


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
            "unit": UNIT,                       # 单位口径：相对应变指标（无量纲）
            "is_simulated": simulator.source == "sim",   # 是否模拟（前端据此标注水印）
            "scenario": simulator.current_scenario(),     # 当前模拟场景（仅 sim 模式）
            "device_health": simulator.latest.get("device_health"),
            "rate": simulator.latest.get("rate"),
            "uptime": int(time.time() - simulator._start_time),
        }
    return jsonify(data_snapshot)


@app.route("/api/audit")
@login_required
def api_audit():
    """最近操作审计记录（供设置页展示变更追溯）。"""
    return jsonify(simulator.db.recent_audit(50))


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


@app.route("/api/scenario", methods=["GET", "POST"])
@login_required
def scenario():
    """模拟模式可控场景：GET 返回当前场景与可选场景，POST 切换场景。

    仅 DATA_SOURCE=sim 时可用；串口模式下切换会被拒绝（诚实边界：真实模式不伪造数据）。
    """
    if request.method == "GET":
        return jsonify({
            "current": simulator.current_scenario(),
            "is_simulated": simulator.source == "sim",
            "scenarios": [{"key": k, "label": SCENARIO_LABELS[k]} for k in SCENARIOS],
        })
    name = request.json.get("scenario") if request.json else None
    if not name:
        return jsonify({"error": "缺少 scenario 字段"}), 400
    ok, err = simulator.set_scenario(session["user"], name)
    if not ok:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True, "scenario": name})


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
        header = ["时间", "应变指标", "等级", "规则", "原因", "处理状态"]
        data = [[r["ts"], r["value"], r["level"], r["rule"], r["reason"], r["status"]] for r in rows]
        return _csv_response(header, data, "alarms_history.csv")
    if record_type == "data":
        rows = simulator.db.query_samples(start, end)
        header = ["时间", "应变指标(相对应变，无量纲)"]
        data = [[r["ts"], r["value"]] for r in rows]
        return _csv_response(header, data, "data_history.csv")
    return jsonify({"error": "不支持的导出类型。"}), 404


if __name__ == "__main__":
    simulator.start()   # 启动采样线程
    app.run(debug=False, host="0.0.0.0", port=5000)
