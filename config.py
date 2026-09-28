"""桥体卫士 —— 集中配置模块

设计约定：
1. 密钥、账号走环境变量 / .env，不硬编码进源码。
2. DATA_SOURCE 决定模拟 / 真实串口两种数据来源。
3. 所有可调参数集中于此，便于答辩讲解与现场切换。

依赖说明：python-dotenv 为可选增强；未安装时自动降级为直接读取系统环境变量。
"""
import hashlib
import hmac
import os
import secrets

try:
    from dotenv import load_dotenv
    load_dotenv()  # 加载项目根目录 .env（不存在则静默跳过）
except ImportError:
    pass  # 未安装 python-dotenv：直接使用系统环境变量或默认值


def _env(key, default):
    """读取环境变量；空字符串视为未设置，返回默认值。"""
    value = os.getenv(key)
    return value if value not in (None, "") else default


class Config:
    # ---- 安全 ----
    # 未设置 SECRET_KEY 时随机生成（每次重启 session 失效，需重新登录；比赛演示可接受）
    SECRET_KEY = _env("SECRET_KEY", "") or secrets.token_hex(32)
    USERNAME = _env("APP_USERNAME", "admin")
    # 密码默认值仅供本地演示；正式/答辩务必用环境变量覆盖为强口令。
    # 存储：PASSWORD_HASH 为 SHA-256 十六进制摘要（可选，见下），否则回退到明文 PASSWORD。
    # 注：SHA-256 为校赛演示级别；正式部署建议升级为 PBKDF2/bcrypt/argon2 等带盐慢哈希。
    PASSWORD = _env("APP_PASSWORD", "123456")
    PASSWORD_HASH = _env("APP_PASSWORD_HASH", "")

    # ---- Session / CSRF ----
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = _env("SESSION_COOKIE_SECURE", "0") == "1"  # 无 HTTPS 环境默认关闭
    CSRF_TOKEN_NAME = "csrf_token"       # session 中存放 CSRF token 的键
    CSRF_HEADER = "X-CSRF-Token"         # 前端 fetch 携带的请求头

    # ---- 数据源 ----
    DATA_SOURCE = _env("DATA_SOURCE", "sim").strip().lower()  # sim | serial
    SERIAL_PORT = _env("SERIAL_PORT", "")       # 如 COM3 / /dev/ttyUSB0
    SERIAL_BAUD = int(_env("SERIAL_BAUD", "115200"))

    # ---- 采集与报警 ----
    # 单位口径（答辩红线）：输出为「相对应变指标」，无量纲，未经工程级标定，
    # 不声称微应变(με)精度。此处阈值仅为报警判断的数值边界，不是物理微应变。
    THRESHOLD = float(_env("THRESHOLD", "120"))            # 报警阈值（相对应变指标，无量纲）
    SAMPLE_INTERVAL = float(_env("SAMPLE_INTERVAL", "1"))  # 采集周期（秒）

    # ---- 存储 ----
    DB_PATH = _env("DB_PATH", "bridge.db")

    @classmethod
    def verify_password(cls, password):
        """校验登录密码：优先与 PASSWORD_HASH 比对，否则回退明文 PASSWORD。

        采用常量时间比较（hmac.compare_digest）降低时序侧信道风险。
        """
        if cls.PASSWORD_HASH:
            return hmac.compare_digest(
                hashlib.sha256(password.encode("utf-8")).hexdigest(),
                cls.PASSWORD_HASH.lower())
        return hmac.compare_digest(password, cls.PASSWORD)

    @classmethod
    def validate(cls):
        """启动前校验配置合法性，返回错误列表（空列表表示通过）。"""
        errors = []
        if cls.DATA_SOURCE not in ("sim", "serial"):
            errors.append(f"DATA_SOURCE 必须为 sim 或 serial，当前为 {cls.DATA_SOURCE!r}")
        if not 1 <= cls.THRESHOLD <= 200:
            errors.append(f"THRESHOLD 必须在 1-200 之间，当前为 {cls.THRESHOLD}")
        if not 0.1 <= cls.SAMPLE_INTERVAL <= 60:
            errors.append(f"SAMPLE_INTERVAL 必须在 0.1-60 之间，当前为 {cls.SAMPLE_INTERVAL}")
        if cls.DATA_SOURCE == "serial" and not cls.SERIAL_PORT:
            errors.append("DATA_SOURCE=serial 但未设置 SERIAL_PORT")
        return errors
