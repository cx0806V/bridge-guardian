"""桥体卫士 —— SQLite 数据层

统一数据结构与存储，替代早期 CSV 散落文件：
- samples  采样数据（时间、设备号、来源、应变值、序号）
- alarms   报警记录（含触发规则 rule 与可解释原因 reason、处理状态）
- settings 参数设置历史（阈值、采集周期）
- audit    审计记录（操作者、动作、详情）
- device_heartbeat 设备心跳/事件（beat 心跳 / offline 离线 / online 恢复）

时间格式统一为 YYYY-MM-DD HH:MM:SS；每次操作使用短连接 + 锁，保证与采样线程并发安全。
"""
import sqlite3
import threading
from datetime import datetime


SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,           -- 采样时间 YYYY-MM-DD HH:MM:SS
    device_id TEXT NOT NULL,    -- 设备标识
    source TEXT NOT NULL,       -- 数据来源 sim / serial
    value REAL NOT NULL,        -- 相对应变指标（无量纲，非工程微应变）
    seq INTEGER NOT NULL        -- 采样序号
);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);

CREATE TABLE IF NOT EXISTS alarms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    device_id TEXT NOT NULL,
    source TEXT NOT NULL,
    value REAL NOT NULL,        -- 触发时应变值
    threshold REAL NOT NULL,    -- 触发时阈值
    level TEXT NOT NULL,        -- 预警 / 报警 / 严重报警
    rule TEXT NOT NULL,         -- 触发规则
    reason TEXT NOT NULL,       -- 可解释原因
    status TEXT NOT NULL DEFAULT '未处理',
    acknowledged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alarms_ts ON alarms(ts);

CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    threshold REAL NOT NULL,
    interval REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
);

CREATE TABLE IF NOT EXISTS device_heartbeat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    device_id TEXT NOT NULL,
    source TEXT NOT NULL,
    event TEXT NOT NULL        -- beat(心跳) / offline(离线) / online(恢复)
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_ts ON device_heartbeat(ts);
"""


def now_str():
    """统一时间格式。"""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


class Database:
    def __init__(self, path):
        self.path = path
        self._lock = threading.RLock()
        self._init()

    # ---------- 底层 ----------
    def _init(self):
        with self._lock:
            conn = sqlite3.connect(self.path)
            try:
                conn.executescript(SCHEMA)
                conn.commit()
            finally:
                conn.close()

    def _query(self, sql, params=()):
        with self._lock:
            conn = sqlite3.connect(self.path)
            try:
                conn.row_factory = sqlite3.Row
                return [dict(r) for r in conn.execute(sql, params).fetchall()]
            finally:
                conn.close()

    def _execute(self, sql, params=()):
        with self._lock:
            conn = sqlite3.connect(self.path)
            try:
                cur = conn.execute(sql, params)
                conn.commit()
                return cur.lastrowid
            finally:
                conn.close()

    # ---------- samples ----------
    def insert_sample(self, ts, device_id, source, value, seq):
        return self._execute(
            "INSERT INTO samples(ts, device_id, source, value, seq) VALUES(?,?,?,?,?)",
            (ts, device_id, source, value, seq))

    def recent_samples(self, limit=60):
        return self._query(
            "SELECT * FROM samples ORDER BY id DESC LIMIT ?", (limit,))[::-1]

    def query_samples(self, start=None, end=None, limit=500):
        sql, params, conds = "SELECT * FROM samples", [], []
        if start:
            conds.append("ts >= ?"); params.append(start)
        if end:
            conds.append("ts <= ?"); params.append(end)
        if conds:
            sql += " WHERE " + " AND ".join(conds)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return self._query(sql, tuple(params))[::-1]

    def clear_samples(self):
        return self._execute("DELETE FROM samples")

    def count_samples(self):
        rows = self._query("SELECT COUNT(*) AS c FROM samples")
        return rows[0]["c"] if rows else 0

    # ---------- alarms ----------
    def insert_alarm(self, ts, device_id, source, value, threshold,
                     level, rule, reason, status="未处理"):
        return self._execute(
            "INSERT INTO alarms(ts, device_id, source, value, threshold, level, rule, reason, status) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (ts, device_id, source, value, threshold, level, rule, reason, status))

    def recent_alarms(self, limit=200):
        return self._query(
            "SELECT * FROM alarms ORDER BY id DESC LIMIT ?", (limit,))[::-1]

    def query_alarms(self, start=None, end=None, limit=500):
        sql, params, conds = "SELECT * FROM alarms", [], []
        if start:
            conds.append("ts >= ?"); params.append(start)
        if end:
            conds.append("ts <= ?"); params.append(end)
        if conds:
            sql += " WHERE " + " AND ".join(conds)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return self._query(sql, tuple(params))[::-1]

    def acknowledge_alarm(self, alarm_id):
        """标记报警已处理，返回受影响行数（0 表示 id 不存在）。"""
        with self._lock:
            conn = sqlite3.connect(self.path)
            try:
                cur = conn.execute(
                    "UPDATE alarms SET status='已处理', acknowledged_at=? WHERE id=?",
                    (now_str(), alarm_id))
                conn.commit()
                return cur.rowcount
            finally:
                conn.close()

    def clear_alarms(self):
        return self._execute("DELETE FROM alarms")

    def count_alarms(self):
        rows = self._query("SELECT COUNT(*) AS c FROM alarms")
        return rows[0]["c"] if rows else 0

    # ---------- settings ----------
    def add_setting(self, threshold, interval):
        return self._execute(
            "INSERT INTO settings(ts, threshold, interval) VALUES(?,?,?)",
            (now_str(), threshold, interval))

    def clear_settings(self):
        return self._execute("DELETE FROM settings")

    def latest_setting(self):
        rows = self._query("SELECT * FROM settings ORDER BY id DESC LIMIT 1")
        return rows[0] if rows else None

    # ---------- audit ----------
    def add_audit(self, actor, action, detail=""):
        return self._execute(
            "INSERT INTO audit(ts, actor, action, detail) VALUES(?,?,?,?)",
            (now_str(), actor, action, detail))

    def recent_audit(self, limit=100):
        return self._query(
            "SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,))[::-1]

    # ---------- device_heartbeat ----------
    def insert_heartbeat(self, ts, device_id, source, event):
        return self._execute(
            "INSERT INTO device_heartbeat(ts, device_id, source, event) VALUES(?,?,?,?)",
            (ts, device_id, source, event))

    def recent_heartbeats(self, limit=100):
        return self._query(
            "SELECT * FROM device_heartbeat ORDER BY id DESC LIMIT ?", (limit,))[::-1]

    def clear_heartbeats(self):
        return self._execute("DELETE FROM device_heartbeat")
