"""鉴权测试：未登录 API 返回 401、页面重定向、登录流程。"""
import app


def test_unauth_api_401(client):
    assert client.get("/api/data").status_code == 401
    assert client.post("/api/clear_alarms").status_code == 401
    assert client.post("/api/clear_data").status_code == 401
    assert client.get("/api/export/alarms").status_code == 401


def test_unauth_page_redirect(client):
    r = client.get("/dashboard", follow_redirects=False)
    assert r.status_code == 302
    assert "/login" in r.headers.get("Location", "")


def test_login_success(client):
    r = client.post("/login", data={"username": "admin", "password": "123456"},
                    follow_redirects=False)
    assert r.status_code == 302
    assert client.get("/api/data").status_code == 200


def test_login_fail(client):
    r = client.post("/login", data={"username": "admin", "password": "wrong"})
    assert "用户名或密码错误" in r.get_data(as_text=True)


def test_authed_pages(client):
    client.post("/login", data={"username": "admin", "password": "123456"})
    assert client.get("/dashboard").status_code == 200
    assert client.get("/settings").status_code == 200
    assert client.get("/history").status_code == 200
