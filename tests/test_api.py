"""API 端到端测试：快照结构、参数校验、报警确认、导出。"""
import app


def test_data_snapshot_fields(authed_client):
    d = authed_client.get("/api/data").get_json()
    for key in ["strain", "threshold", "interval", "history", "alarms",
                "sensor_status", "device_id", "source", "device_health"]:
        assert key in d, f"缺少字段 {key}"


def test_settings_roundtrip(authed_client, csrf_headers):
    r = authed_client.post("/api/settings", json={"threshold": 130, "interval": 0.5},
                           headers=csrf_headers)
    assert r.status_code == 200
    d = authed_client.get("/api/settings").get_json()
    assert d["threshold"] == 130
    # 恢复默认，避免影响其他用例
    authed_client.post("/api/settings", json={"threshold": 120, "interval": 1},
                       headers=csrf_headers)


def test_settings_invalid(authed_client, csrf_headers):
    assert authed_client.post("/api/settings", json={"threshold": 999, "interval": 1},
                              headers=csrf_headers).status_code == 400
    assert authed_client.post("/api/settings", json={"threshold": 120, "interval": 0},
                              headers=csrf_headers).status_code == 400


def test_ack_alarm(authed_client, csrf_headers):
    sim = app.simulator
    aid = sim.db.insert_alarm("2026-01-01 00:00:00", "SIM-01", "sim", 130.0, 120.0,
                              "报警", "阈值超限", "reason")
    r = authed_client.post(f"/api/acknowledge_alarm/{aid}", headers=csrf_headers)
    assert r.status_code == 200
    assert authed_client.post("/api/acknowledge_alarm/99999",
                              headers=csrf_headers).status_code == 404


def test_export_csv(authed_client):
    r = authed_client.get("/api/export/data")
    assert r.status_code == 200
    assert "text/csv" in r.headers.get("Content-Type", "")
    assert r.get_data(as_text=True).startswith("\ufeff时间,应变指标")


def test_history_empty_ok(authed_client):
    assert authed_client.get("/api/history_data").status_code == 200
    assert authed_client.get("/api/history_alarms").status_code == 200


def test_data_snapshot_has_unit_and_sim_flag(authed_client):
    """数据快照应包含单位口径与模拟标识，供前端标注水印。"""
    d = authed_client.get("/api/data").get_json()
    assert "unit" in d and d["unit"]
    assert "is_simulated" in d
    assert "scenario" in d


def test_scenario_switch_and_csrf(authed_client, csrf_headers):
    """模拟场景可切换，且缺 CSRF 头时被拒（403）。"""
    # 无 CSRF 头 → 403
    assert authed_client.post("/api/scenario", json={"scenario": "alarm"}).status_code == 403
    # 带 CSRF 头 → 切换成功
    r = authed_client.post("/api/scenario", json={"scenario": "alarm"}, headers=csrf_headers)
    assert r.status_code == 200
    assert authed_client.get("/api/scenario").get_json()["current"] == "alarm"
    # 恢复默认
    authed_client.post("/api/scenario", json={"scenario": "normal"}, headers=csrf_headers)


def test_scenario_invalid_rejected(authed_client, csrf_headers):
    assert authed_client.post("/api/scenario", json={"scenario": "bogus"},
                              headers=csrf_headers).status_code == 400
