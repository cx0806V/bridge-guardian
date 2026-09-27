"""数据库层单元测试：增删查、报警确认行数、参数历史、审计。"""
import os
import tempfile

import db


def _make_db():
    path = os.path.join(tempfile.gettempdir(), "test_db_crud.db")
    if os.path.exists(path):
        os.remove(path)
    return db.Database(path), path


def test_sample_crud():
    d, path = _make_db()
    d.insert_sample("2026-01-01 00:00:00", "SIM-01", "sim", 80.0, 1)
    d.insert_sample("2026-01-01 00:00:01", "SIM-01", "sim", 130.0, 2)
    assert d.count_samples() == 2
    rows = d.recent_samples(5)
    assert rows[0]["value"] == 80.0
    assert len(d.query_samples("2026-01-01 00:00:00", "2026-01-01 00:00:00")) == 1
    os.remove(path)


def test_alarm_ack_rowcount():
    d, path = _make_db()
    aid = d.insert_alarm("2026-01-01 00:00:01", "SIM-01", "sim", 130.0, 120.0,
                         "报警", "阈值超限", "reason")
    assert d.acknowledge_alarm(aid) == 1           # 存在的 id 影响 1 行
    assert d.acknowledge_alarm(99999) == 0         # 不存在的 id 影响 0 行
    assert d.recent_alarms(1)[0]["status"] == "已处理"
    os.remove(path)


def test_settings_and_audit():
    d, path = _make_db()
    d.add_setting(120, 1)
    assert d.latest_setting()["threshold"] == 120.0
    d.add_audit("admin", "clear_data", "清除采样数据")
    assert len(d.recent_audit(5)) == 1
    os.remove(path)
