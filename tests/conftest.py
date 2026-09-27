"""pytest 全局配置：设置临时数据库、导入 app、提供 client fixture。"""
import os
import sys
import tempfile
from pathlib import Path

import pytest

# 将项目根目录加入 sys.path，便于 import app/rules/db
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 必须在导入 app 前设置临时数据库，避免污染真实 bridge.db
_TMP_DB = os.path.join(tempfile.gettempdir(), "test_bridge_pytest.db")
if os.path.exists(_TMP_DB):
    os.remove(_TMP_DB)
os.environ.setdefault("DATA_SOURCE", "sim")
os.environ["DB_PATH"] = _TMP_DB

import app  # noqa: E402  环境变量设置后再导入


@pytest.fixture()
def client():
    app.app.config["TESTING"] = True
    with app.app.test_client() as c:
        yield c


@pytest.fixture()
def authed_client(client):
    client.post("/login", data={"username": "admin", "password": "123456"})
    return client
