from flask import Flask, request, session, redirect, render_template, jsonify
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

# ---------- 禁止浏览器缓存：改完页面普通刷新就是最新版 ----------
@app.after_request
def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    return response


# ================= 采样模拟器（模拟传感器 + 数据落盘 + 报警判断） =================
class Simulator:
    def __init__(self):
        self.latest = {
            "strain": 0.0,                # 当前应变值
            "interval": SAMPLE_INTERVAL,  # 采集周期（大屏显示用）
            "threshold": THRESHOLD,       # 报警阈值（大屏显示用）
            "history": [],                # 实时曲线 [{"time","strain"}]，最多60点
            "alarms": [],                 # 当前报警 [{"time","strain","type"}]，最多200条
        }
        self.value = 80.0       # 模拟传感器当前读数
        self.alarming = False   # 边沿触发标志：防止持续超限刷屏

    def start(self):
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            # --- 模拟传感器：围绕80随机波动，2%概率冲高 ---
            self.value += random.uniform(-3, 3)
            if random.random() < 0.02:
                self.value = random.uniform(125, 150)
            self.value = round(max(50, min(180, self.value)), 2)

            now = datetime.now().strftime("%H:%M:%S")
            self.latest["strain"] = self.value

            # 实时曲线（保留最近60点）
            self.latest["history"].append({"time": now, "strain": self.value})
            if len(self.latest["history"]) > 60:
                self.latest["history"].pop(0)

            # 每个采样点全部落盘（历史数据比对的数据源）
            self._append_csv(CSV_DATA, ["时间", "应变值(με)"], [now, self.value])

            # --- 边沿触发：只在"由正常变超限"瞬间报一次 ---
            if self.value > THRESHOLD and not self.alarming:
                self.alarming = True
                alarm = {"time": now, "strain": self.value, "type": "超限报警"}
                self.latest["alarms"].append(alarm)
                if len(self.latest["alarms"]) > 200:
                    self.latest["alarms"].pop(0)
                self._append_csv(CSV_ALARM, ["时间", "应变值(με)", "类型"],
                                 [alarm["time"], alarm["strain"], alarm["type"]])
                print(f"[报警] {now} 应变 {self.value} με 超过阈值 {THRESHOLD} με")
            elif self.value <= THRESHOLD:
                self.alarming = False   # 回到安全区，下次越线可再报

            time.sleep(SAMPLE_INTERVAL)

    def _append_csv(self, path, header, row):
        """CSV追加写入：文件不存在则先写表头"""
        try:
            new_file = not os.path.exists(path)
            with open(path, "a", newline="", encoding="utf-8-sig") as f:
                w = csv.writer(f)
                if new_file:
                    w.writerow(header)
                w.writerow(row)
        except Exception as e:
            print("CSV写入失败:", e)


simulator = Simulator()


def read_csv_tail(path, limit=500):
    """读CSV最后limit行（去表头），供历史页面展示"""
    rows = []
    if os.path.exists(path):
        with open(path, newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))[1:]
    return rows[-limit:]


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
    return render_template("dashboard.html", user=session["user"])

@app.route("/history")
def history_page():
    """历史记录页：点击主画面入口进入，点返回回主画面"""
    if "user" not in session:
        return redirect("/login")
    return render_template("history.html")

# ================= 数据接口 =================
@app.route("/api/data")
def api_data():
    """大屏每秒轮询：返回数据快照（拷贝一份，避免与采样线程冲突）"""
    return jsonify({
        "strain": simulator.latest["strain"],
        "interval": simulator.latest["interval"],
        "threshold": simulator.latest["threshold"],
        "history": list(simulator.latest["history"]),
        "alarms": list(simulator.latest["alarms"]),
    })

@app.route("/api/clear_alarms")
def clear_alarms():
    """一键清除报警信息（CSV历史仍保留可查）"""
    simulator.latest["alarms"].clear()
    return jsonify({"ok": True})

@app.route("/api/clear_data")
def clear_data():
    """一键清除数据（CSV历史仍保留可查）"""
    simulator.latest["history"].clear()
    simulator.latest["strain"] = 0.0
    return jsonify({"ok": True})

@app.route("/api/history_alarms")
def history_alarms():
    """历史报警信息查看（读 alarm_log.csv 最后500条）"""
    return jsonify(read_csv_tail(CSV_ALARM))

@app.route("/api/history_data")
def history_data():
    """历史数据查看比对（读 data_log.csv 最后500条）"""
    return jsonify(read_csv_tail(CSV_DATA))


if __name__ == "__main__":
    simulator.start()   # 启动采样线程
    app.run(debug=False, host="0.0.0.0", port=5000)
