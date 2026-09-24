from flask import Flask, render_template, request, redirect, session, jsonify
import simulator

app = Flask(__name__)
app.secret_key = "bridge-guardian-secret"

# 演示用账号（答辩前可以换成数据库存储）
USERS = {"admin": "123456"}

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username")
        password = request.form.get("password")
        if USERS.get(username) == password:
            session["user"] = username
            return redirect("/dashboard")
        return render_template("login.html", error="账号或密码错误")
    return render_template("login.html")

@app.route("/dashboard")
def dashboard():
    if "user" not in session:
        return redirect("/login")
    return render_template("dashboard.html", user=session["user"])

@app.route("/api/data")
def api_data():
    """大屏每秒轮询这个接口拿最新数据"""
    return jsonify(simulator.latest)

@app.route("/logout")
def logout():
    session.clear()
    return redirect("/login")

if __name__ == "__main__":
    simulator.start_sampler()   # 启动采样线程
    app.run(debug=False, host="0.0.0.0", port=5000)