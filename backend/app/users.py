# ---------------------------------------------------------------------------
# 用户与认证：SQLite + PBKDF2 密码哈希 + JWT
# 审批制：注册 → pending → 管理员批准（active）→ 可登录；可停用/改角色
# 设计依据 auth-implementation-patterns skill：
#   密码绝不明文存储 / token 必须带过期 / 登录接口限速防爆破 / 安全事件留日志
# ---------------------------------------------------------------------------
from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

import jwt

from app.config import settings

log = logging.getLogger("auth")

_PASSWORD_MIN = 8
_TOKEN_TTL_SECONDS = 12 * 3600
_LOGIN_MAX_FAILS = 5
_LOGIN_LOCK_SECONDS = 900  # 连续失败 5 次锁 15 分钟
_USERNAME_RE = re.compile(r"^[A-Za-z0-9_\u4e00-\u9fa5.@-]{2,32}$")

_db_lock = threading.Lock()


# ---------------------------------------------------------------------------
# 数据库
# ---------------------------------------------------------------------------
def _db_path() -> Path:
    settings.user_db.parent.mkdir(parents=True, exist_ok=True)
    return settings.user_db


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    with _db_lock, _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                display_name  TEXT DEFAULT '',
                role          TEXT NOT NULL DEFAULT 'user',   -- user | admin
                status        TEXT NOT NULL DEFAULT 'pending',-- pending | active | disabled
                created_at    REAL NOT NULL,
                reviewed_at   REAL,
                reviewed_by   TEXT,
                last_login_at REAL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY, value TEXT NOT NULL
            )
        """)
        # 迁移：v2.6 起用户可归属「分组」（部门/团队），老库无此列则补
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
        if "grp" not in cols:
            # 列名用 grp，避开 SQL 关键字 group
            conn.execute("ALTER TABLE users ADD COLUMN grp TEXT NOT NULL DEFAULT ''")
        # JWT 密钥：首次生成并落库，重启与多进程共享同一密钥
        row = conn.execute("SELECT value FROM meta WHERE key='jwt_secret'").fetchone()
        if not row:
            conn.execute("INSERT INTO meta(key, value) VALUES('jwt_secret', ?)",
                         (secrets.token_urlsafe(48),))
        # 播种管理员：仅当库里还没有任何管理员/超管时
        admin_cnt = conn.execute(
            "SELECT COUNT(*) FROM users WHERE role IN ('admin','superadmin')"
        ).fetchone()[0]
        if admin_cnt == 0 and settings.seed_admin_user:
            conn.execute(
                "INSERT INTO users(username, password_hash, display_name, role,"
                " status, created_at, reviewed_at, reviewed_by) VALUES(?,?,?,?,?,?,?,?)",
                (settings.seed_admin_user, hash_password(settings.seed_admin_password),
                 "管理员", "admin", "active", time.time(), time.time(), "system"))
            log.warning("已播种管理员账号 %s（请尽快修改默认密码）", settings.seed_admin_user)


def _jwt_secret() -> str:
    with _connect() as conn:
        return conn.execute("SELECT value FROM meta WHERE key='jwt_secret'").fetchone()["value"]


# ---------------------------------------------------------------------------
# 密码：PBKDF2-HMAC-SHA256（标准库实现，格式自描述便于将来升级算法）
# ---------------------------------------------------------------------------
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return f"pbkdf2_sha256$200000${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt_hex, digest_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, AttributeError):
        return False


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------
def validate_registration(username: str, password: str) -> str | None:
    if not _USERNAME_RE.match(username or ""):
        return "用户名需 2-32 位，可为中文、字母、数字、_ - . @"
    if not password or len(password) < _PASSWORD_MIN:
        return f"密码至少 {_PASSWORD_MIN} 位"
    if len(password) > 72:
        return "密码过长"
    if password in {"12345678", "password", "password1", "admin12345"}:
        return "密码过于常见"
    return None


# ---------------------------------------------------------------------------
# 用户操作
# ---------------------------------------------------------------------------
def _row_to_user(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"], "username": row["username"],
        "display_name": row["display_name"], "role": row["role"],
        "status": row["status"], "group": row["grp"] if "grp" in row.keys() else "",
        "created_at": row["created_at"],
        "reviewed_at": row["reviewed_at"], "reviewed_by": row["reviewed_by"],
        "last_login_at": row["last_login_at"],
    }


def create_user(username: str, password: str, display_name: str = "") -> dict:
    with _db_lock, _connect() as conn:
        exists = conn.execute(
            "SELECT 1 FROM users WHERE username=?", (username,)).fetchone()
        if exists:
            raise ValueError("该用户名已被注册")
        conn.execute(
            "INSERT INTO users(username, password_hash, display_name, created_at)"
            " VALUES(?,?,?,?)",
            (username, hash_password(password), display_name or username, time.time()))
    log.info("注册请求：%s（待审批）", username)
    return get_user(username)


def get_user(username: str) -> dict | None:
    """公开视图：不含 password_hash。"""
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        return _row_to_user(row) if row else None


def _get_user_row(username: str) -> sqlite3.Row | None:
    """内部视图：含 password_hash，仅供 login/verify 使用。"""
    with _connect() as conn:
        return conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()


def list_users() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM users ORDER BY created_at DESC").fetchall()
        return [_row_to_user(r) for r in rows]


def set_status(username: str, status: str, reviewer: str) -> dict:
    assert status in {"pending", "active", "disabled"}
    with _db_lock, _connect() as conn:
        cur = conn.execute(
            "UPDATE users SET status=?, reviewed_at=?, reviewed_by=? WHERE username=?",
            (status, time.time(), reviewer, username))
        if cur.rowcount == 0:
            raise ValueError("用户不存在")
    log.info("账号 %s 状态 → %s（操作人 %s）", username, status, reviewer)
    return get_user(username)


def set_role(username: str, role: str, reviewer: str) -> dict:
    assert role in {"user", "admin"}
    with _db_lock, _connect() as conn:
        cur = conn.execute("UPDATE users SET role=? WHERE username=?", (role, username))
        if cur.rowcount == 0:
            raise ValueError("用户不存在")
        # 防锁死：不能移除最后一个管理员的 admin 角色
        if role != "admin":
            cnt = conn.execute(
                "SELECT COUNT(*) FROM users WHERE role='admin' AND status='active'"
            ).fetchone()[0]
            if cnt == 0:
                raise ValueError("不能移除最后一个管理员")
    log.info("账号 %s 角色 → %s（操作人 %s）", username, role, reviewer)
    return get_user(username)


def set_group(username: str, group: str, reviewer: str) -> dict:
    """设置用户分组（部门/团队标签），空串表示无分组。"""
    group = (group or "").strip()[:32]
    with _db_lock, _connect() as conn:
        cur = conn.execute("UPDATE users SET grp=? WHERE username=?", (group, username))
        if cur.rowcount == 0:
            raise ValueError("用户不存在")
    log.info("账号 %s 分组 → %s（操作人 %s）", username, group or "(空)", reviewer)
    return get_user(username)


def batch_set_group(usernames: list[str], group: str, reviewer: str) -> dict:
    """批量设置分组：逐个执行，返回每个用户的成功/失败结果。"""
    results = []
    for name in usernames:
        try:
            user = set_group(name, group, reviewer)
            results.append({"username": name, "ok": True, "group": user["group"]})
        except (ValueError, AssertionError) as exc:
            results.append({"username": name, "ok": False, "error": str(exc)})
    return {"group": (group or "").strip()[:32], "results": results}


def delete_user(username: str, reviewer: str) -> bool:
    if username == reviewer:
        raise ValueError("不能删除自己的账号")
    with _db_lock, _connect() as conn:
        cur = conn.execute("DELETE FROM users WHERE username=?", (username,))
        if cur.rowcount:
            log.info("账号 %s 已删除（操作人 %s）", username, reviewer)
        return bool(cur.rowcount)


def touch_last_login(username: str) -> None:
    with _db_lock, _connect() as conn:
        conn.execute("UPDATE users SET last_login_at=? WHERE username=?",
                     (time.time(), username))


# ---------------------------------------------------------------------------
# 登录限速：按「用户名+IP」计数，连续失败锁定，防爆破
# ---------------------------------------------------------------------------
_fails: dict[str, list[float]] = {}


def _login_locked(key: str) -> bool:
    now = time.time()
    _fails[key] = [t for t in _fails.get(key, []) if now - t < _LOGIN_LOCK_SECONDS]
    return len(_fails[key]) >= _LOGIN_MAX_FAILS


def _record_fail(key: str) -> None:
    _fails.setdefault(key, []).append(time.time())


def _clear_fails(key: str) -> None:
    _fails.pop(key, None)


def login(username: str, password: str, client_ip: str) -> dict:
    """登录成功返回 {user, token}；失败抛 ValueError（含锁定与等待审批提示）。"""
    key = f"{username}|{client_ip}"
    if _login_locked(key):
        log.warning("登录锁定触发：%s（%s）", username, client_ip)
        raise PermissionError("失败次数过多，账号已临时锁定 15 分钟")

    row = _get_user_row(username)
    user = _row_to_user(row) if row else None
    if not user or not verify_password(password, row["password_hash"]):
        _record_fail(key)
        raise ValueError("用户名或密码错误")
    if user["status"] == "pending":
        raise PermissionError("账号待管理员审批，批准后即可登录")
    if user["status"] == "disabled":
        raise PermissionError("账号已被停用，请联系管理员")

    _clear_fails(key)
    touch_last_login(username)
    token = issue_token(username, user["role"])
    log.info("登录成功：%s（%s）", username, client_ip)
    return {"user": {k: v for k, v in user.items() if k != "password_hash"},
            "token": token}


# ---------------------------------------------------------------------------
# JWT（HS256，12 小时过期；密钥持久化于 meta 表，重启不失效）
# ---------------------------------------------------------------------------
def issue_token(username: str, role: str) -> str:
    now = int(time.time())
    payload = {"sub": username, "role": role,
               "iat": now, "exp": now + _TOKEN_TTL_SECONDS}
    return jwt.encode(payload, _jwt_secret(), algorithm="HS256")


def decode_token(token: str) -> dict:
    payload = jwt.decode(token, _jwt_secret(), algorithms=["HS256"])
    return payload
