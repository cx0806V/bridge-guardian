"""规则引擎单元测试：5 类规则触发 + reason 可解释性 + 边沿防刷屏。"""
import rules


def _has(out, rule_name):
    return any(a["rule"] == rule_name for a in out)


def test_threshold_edge():
    r = rules.RuleEngine(threshold=120)
    assert _has(r.evaluate("t", 150), "阈值超限")


def test_threshold_no_duplicate():
    """连续超限期间「阈值超限」只触发一次（边沿触发，不刷屏）。"""
    r = rules.RuleEngine(threshold=120)
    out = []
    for i in range(6):
        out += r.evaluate(f"t{i}", 150)
    assert sum(1 for a in out if a["rule"] == "阈值超限") == 1


def test_rate_change():
    r = rules.RuleEngine(threshold=120, rate_limit=10)
    r.evaluate("t", 80)
    assert _has(r.evaluate("t", 100), "变化率突变")  # Δ=20


def test_duration_over():
    r = rules.RuleEngine(threshold=120, duration_points=5)
    out = []
    for i in range(5):
        out += r.evaluate(f"t{i}", 150)
    assert _has(out, "持续超限")


def test_volatility():
    r = rules.RuleEngine(volatility_window=10, volatility_limit=30)
    out = []
    for i, v in enumerate([80, 130] * 5):  # 峰谷差 50
        out += r.evaluate(f"t{i}", v)
    assert _has(out, "短时波动")


def test_baseline_drift():
    r = rules.RuleEngine(baseline_window=30, drift_limit=20)
    out = []
    for i, v in enumerate([80] * 15 + [110] * 15):  # 漂移 +30
        out += r.evaluate(f"t{i}", v)
    assert _has(out, "基线偏移")


def test_reason_present_and_readable():
    r = rules.RuleEngine(threshold=120)
    out = r.evaluate("t", 150)
    assert out and out[0]["reason"].strip()


def test_level_grading():
    r = rules.RuleEngine(threshold=120)
    assert r.evaluate("t", 130)[0]["level"] == "预警"       # 120*1.1=132 未到
    r.reset()
    assert r.evaluate("t", 140)[0]["level"] == "报警"       # 132~144
    r.reset()
    assert r.evaluate("t", 150)[0]["level"] == "严重报警"    # >=144
