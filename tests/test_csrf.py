"""CSRF 防护测试：已登录状态变更接口缺 token 返回 403，带 token 通过。"""
import app


def test_post_without_csrf_rejected(authed_client):
    """已登录但无 CSRF 头 → 状态变更接口返回 403。"""
    assert authed_client.post("/api/clear_alarms").status_code == 403
    assert authed_client.post("/api/clear_data").status_code == 403
    assert authed_client.post("/api/settings",
                              json={"threshold": 130, "interval": 1}).status_code == 403


def test_post_with_csrf_ok(authed_client, csrf_headers):
    """带正确 CSRF 头 → 状态变更接口正常返回 200。"""
    r = authed_client.post("/api/clear_alarms", headers=csrf_headers)
    assert r.status_code == 200
    r = authed_client.post("/api/clear_data", headers=csrf_headers)
    assert r.status_code == 200


def test_post_with_wrong_csrf_rejected(authed_client):
    """错误 token 同样被拒绝（403）。"""
    r = authed_client.post("/api/clear_alarms", headers={"X-CSRF-Token": "wrong"})
    assert r.status_code == 403


def test_login_exempt_from_csrf(client):
    """登录接口豁免 CSRF（登录前无 token）。"""
    r = client.post("/login", data={"username": "admin", "password": "123456"})
    assert r.status_code == 302
