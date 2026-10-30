# ---------------------------------------------------------------------------
# 多知识库工作区：知识库 / 成员权限 / 文件（版本备份+回收站）/ 审计日志
# 权限模型（两级）：
#   平台级 users.role: superadmin（超管·跨全库）> admin > user
#   库级 kb_members.role: kb_admin（审批+成员管理）> editor（上传·待审批）> viewer（只读+下载）
# 数据安全三闸：覆盖留版本备份、删除进回收站（可恢复）、全操作审计流水
# ---------------------------------------------------------------------------
from __future__ import annotations

import os
import secrets
import shutil
import sqlite3
import time

from app.users import _connect, _db_lock
from app.knowledge import DEFAULT_KB  # 向量库中默认库的标记（与迁移保持一致）

DEFAULT_KB_ID = 1

KB_ROLES = ("viewer", "editor", "kb_admin")   # 低 → 高


# ---------------------------------------------------------------------------
# 建表与迁移（users.db 同库复用，单文件好备份）
# ---------------------------------------------------------------------------
def init_workspace() -> None:
    with _db_lock, _connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS kbs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT UNIQUE NOT NULL,
                description TEXT DEFAULT '',
                created_by  TEXT NOT NULL,
                created_at  REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS kb_members (
                kb_id    INTEGER NOT NULL,
                username TEXT NOT NULL,
                role     TEXT NOT NULL,
                granted_by TEXT,
                granted_at REAL,
                PRIMARY KEY (kb_id, username)
            );
            CREATE TABLE IF NOT EXISTS kb_files (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                kb_id      INTEGER NOT NULL,
                name       TEXT NOT NULL,
                path       TEXT NOT NULL,
                size       INTEGER DEFAULT 0,
                uploader   TEXT NOT NULL,
                status     TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|deleted
                version    INTEGER DEFAULT 1,
                chunks     INTEGER DEFAULT 0,
                uploaded_at REAL NOT NULL,
                reviewed_by TEXT,
                reviewed_at REAL
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                ts      REAL NOT NULL,
                username TEXT NOT NULL,
                action  TEXT NOT NULL,
                kb_id   INTEGER,
                target  TEXT DEFAULT '',
                detail  TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
        """)
        # 默认知识库（内置语料 171 chunks 所在，全员可读）
        if not conn.execute("SELECT 1 FROM kbs WHERE id=?", (DEFAULT_KB_ID,)).fetchone():
            conn.execute(
                "INSERT INTO kbs(id, name, description, created_by, created_at)"
                " VALUES(?,?,?,?,?)",
                (DEFAULT_KB_ID, "产品通用知识库", "内置语料：企业微信 / 腾讯会议 / 云服务器 / 对象存储 / 小程序",
                 "system", time.time()))
        # 历史升级：admin → superadmin（首个超管）
        if not conn.execute(
                "SELECT 1 FROM users WHERE role='superadmin'").fetchone():
            conn.execute("UPDATE users SET role='superadmin' WHERE role='admin'")


# ---------------------------------------------------------------------------
# 审计日志
# ---------------------------------------------------------------------------
def audit(username: str, action: str, kb_id: int | None = None,
          target: str = "", detail: str = "") -> None:
    with _db_lock, _connect() as conn:
        conn.execute(
            "INSERT INTO audit_log(ts, username, action, kb_id, target, detail)"
            " VALUES(?,?,?,?,?,?)",
            (time.time(), username, action, kb_id, target[:200], detail[:500]))


def list_audit(limit: int = 200, action: str = "", username: str = "") -> list[dict]:
    q = "SELECT * FROM audit_log WHERE 1=1"
    args: list = []
    if action:
        q += " AND action=?"; args.append(action)
    if username:
        q += " AND username=?"; args.append(username)
    q += " ORDER BY ts DESC LIMIT ?"; args.append(min(limit, 1000))
    with _connect() as conn:
        rows = conn.execute(q, args).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# 权限判定
# ---------------------------------------------------------------------------
def is_super(user: dict) -> bool:
    return user["role"] in {"superadmin", "admin"}


def kb_role(user: dict, kb_id: int) -> str | None:
    """返回用户在某库的生效角色；无权限返回 None。默认库对全体 active 用户可读。"""
    if is_super(user):
        return "super"
    with _connect() as conn:
        row = conn.execute(
            "SELECT role FROM kb_members WHERE kb_id=? AND username=?",
            (kb_id, user["username"])).fetchone()
    if row:
        return row["role"]
    if kb_id == DEFAULT_KB_ID:
        return "viewer"
    return None


def readable_kb_ids(user: dict) -> list[str]:
    """检索范围（向量库 kb_id 字符串）：默认库 + 我是成员的库（超管为全部库）。
    默认库的向量标记是 'default'（历史迁移约定），其余库用数字 id。"""
    with _connect() as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM kbs").fetchall()]
    if is_super(user):
        raw = ids
    else:
        with _connect() as conn:
            mine = {r["kb_id"] for r in conn.execute(
                "SELECT kb_id FROM kb_members WHERE username=?",
                (user["username"],)).fetchall()}
        raw = sorted({DEFAULT_KB_ID} | mine)
    return [str(DEFAULT_KB) if i == DEFAULT_KB_ID else str(i) for i in raw]


# ---------------------------------------------------------------------------
# 知识库管理
# ---------------------------------------------------------------------------
def create_kb(name: str, description: str, creator: str) -> dict:
    with _db_lock, _connect() as conn:
        if conn.execute("SELECT 1 FROM kbs WHERE name=?", (name,)).fetchone():
            raise ValueError("同名知识库已存在")
        cur = conn.execute(
            "INSERT INTO kbs(name, description, created_by, created_at) VALUES(?,?,?,?)",
            (name, description, creator, time.time()))
        kb_id = cur.lastrowid
        conn.execute(
            "INSERT INTO kb_members(kb_id, username, role, granted_by, granted_at)"
            " VALUES(?,?,?,?,?)", (kb_id, creator, "kb_admin", creator, time.time()))
    audit(creator, "kb.create", kb_id, name, description)
    return get_kb(kb_id)


def get_kb(kb_id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM kbs WHERE id=?", (kb_id,)).fetchone()
        return dict(row) if row else None


def list_kbs() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT k.*, (SELECT COUNT(*) FROM kb_files f WHERE f.kb_id=k.id"
            " AND f.status='approved') AS file_count FROM kbs k ORDER BY k.id").fetchall()
        return [dict(r) for r in rows]


def delete_kb(kb_id: int, actor: str) -> bool:
    if kb_id == DEFAULT_KB_ID:
        raise ValueError("默认知识库不可删除")
    with _db_lock, _connect() as conn:
        cur = conn.execute("DELETE FROM kbs WHERE id=?", (kb_id,))
        conn.execute("DELETE FROM kb_members WHERE kb_id=?", (kb_id,))
        conn.execute("UPDATE kb_files SET status='deleted' WHERE kb_id=?", (kb_id,))
    if cur.rowcount:
        audit(actor, "kb.delete", kb_id, "", "级联隐藏文件")
    return bool(cur.rowcount)


# ---------------------------------------------------------------------------
# 成员管理
# ---------------------------------------------------------------------------
def set_member(kb_id: int, username: str, role: str, actor: str) -> dict:
    assert role in KB_ROLES
    with _db_lock, _connect() as conn:
        if not conn.execute("SELECT 1 FROM kbs WHERE id=?", (kb_id,)).fetchone():
            raise ValueError("知识库不存在")
        conn.execute(
            "INSERT INTO kb_members(kb_id, username, role, granted_by, granted_at)"
            " VALUES(?,?,?,?,?) ON CONFLICT(kb_id, username)"
            " DO UPDATE SET role=excluded.role, granted_by=excluded.granted_by,"
            " granted_at=excluded.granted_at",
            (kb_id, username, role, actor, time.time()))
    audit(actor, "member.set", kb_id, username, role)
    return {"kb_id": kb_id, "username": username, "role": role}


def remove_member(kb_id: int, username: str, actor: str) -> bool:
    with _db_lock, _connect() as conn:
        cur = conn.execute(
            "DELETE FROM kb_members WHERE kb_id=? AND username=? AND role!='kb_admin'",
            (kb_id, username))
    if cur.rowcount:
        audit(actor, "member.remove", kb_id, username)
    return bool(cur.rowcount)


def list_members(kb_id: int) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT username, role, granted_by, granted_at FROM kb_members"
            " WHERE kb_id=? ORDER BY role, username", (kb_id,)).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# 文件：上传（版本备份）→ 审批 → 下载 / 回收站删除
# ---------------------------------------------------------------------------
ALLOWED_FILE_EXTS = {".md", ".txt", ".pdf", ".docx"}
MAX_FILE_MB = 20


def _kb_dir(kb_id: int) -> "os.PathLike":
    d = os.path.join(str(settings_files_dir()), str(kb_id))
    os.makedirs(d, exist_ok=True)
    return d


def settings_files_dir():
    from app.config import settings
    return settings.files_dir


def _unique_name(dirpath: str, name: str) -> str:
    return f"{secrets.token_hex(4)}_{name}"


def save_file(kb_id: int, filename: str, data: bytes, uploader: dict) -> dict:
    """保存上传文件。editor → pending 待审批；kb_admin/平台管理员 → 直接入库。
    同名文件覆盖时旧版移入 .versions/ 备份（数据安全闸 1）。"""
    from app.config import settings
    name = os.path.basename(filename or "")
    ext = os.path.splitext(name)[1].lower()
    if ext not in ALLOWED_FILE_EXTS:
        raise ValueError(f"不支持的文件类型 {ext}（仅 md/txt/pdf/docx）")
    if len(data) > MAX_FILE_MB * 1024 * 1024:
        raise ValueError(f"文件超过 {MAX_FILE_MB}MB 上限")

    role = kb_role(uploader, kb_id)
    if role not in {"editor", "kb_admin", "super"}:
        raise PermissionError("只读权限，如需上传请联系知识库管理员")

    # 先验抽取：抽不出文字的文件（扫描件/损坏/加密）当场拒收，
    # 避免"上传成功 → 审批通过 → 0 chunk 入库"的静默失败。
    from app.extract import extract_bytes
    probe = extract_bytes(data, name)
    if not probe.text.strip():
        raise ValueError(f"未能从《{name}》提取文字：{probe.note or '内容为空'}")

    direct = role in {"kb_admin", "super"}
    status = "approved" if direct else "pending"

    with _db_lock, _connect() as conn:
        prev = conn.execute(
            "SELECT * FROM kb_files WHERE kb_id=? AND name=? AND status IN"
            " ('approved','pending')", (kb_id, name)).fetchone()
        if prev:  # 覆盖：旧版备份
            vdir = os.path.join(str(settings_files_dir()), str(kb_id), ".versions", name)
            os.makedirs(vdir, exist_ok=True)
            if os.path.isfile(prev["path"]):
                shutil.copy2(prev["path"], os.path.join(
                    vdir, f"v{prev['version']}_{name}"))
            new_version = prev["version"] + 1
            conn.execute("UPDATE kb_files SET status='deleted' WHERE id=?",
                         (prev["id"],))
            if prev["status"] == "approved":
                from app.knowledge import remove_file_from_index
                remove_file_from_index(prev["path"])
        else:
            new_version = 1

        stored = os.path.join(_kb_dir(kb_id), _unique_name(_kb_dir(kb_id), name))
        with open(stored, "wb") as f:
            f.write(data)
        cur = conn.execute(
            "INSERT INTO kb_files(kb_id, name, path, size, uploader, status,"
            " version, uploaded_at) VALUES(?,?,?,?,?,?,?,?)",
            (kb_id, name, stored, len(data), uploader["username"], status,
             new_version, time.time()))
        fid = cur.lastrowid

    audit(uploader["username"], "file.upload", kb_id, name,
          f"{len(data)}B v{new_version} status={status}")
    file = get_file(fid)
    if direct:
        from app.knowledge import add_file_to_index
        file["chunks"] = add_file_to_index(file["path"], kb_id)
        _set_chunks(fid, file["chunks"])
    return file


def _set_chunks(fid: int, chunks: int) -> None:
    with _db_lock, _connect() as conn:
        conn.execute("UPDATE kb_files SET chunks=? WHERE id=?", (chunks, fid))


def get_file(fid: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM kb_files WHERE id=?", (fid,)).fetchone()
        return dict(row) if row else None


def list_files(kb_id: int, include_pending: bool = True) -> list[dict]:
    q = ("SELECT id, kb_id, name, path, size, uploader, status, version, chunks,"
         " uploaded_at, reviewed_by FROM kb_files WHERE kb_id=? AND status!='deleted'")
    if not include_pending:
        q += " AND status='approved'"
    q += " ORDER BY uploaded_at DESC"
    with _connect() as conn:
        return [dict(r) for r in conn.execute(q, (kb_id,)).fetchall()]


def file_versions(kb_id: int, name: str) -> list[dict]:
    vdir = os.path.join(str(settings_files_dir()), str(kb_id), ".versions", name)
    out = []
    if os.path.isdir(vdir):
        for fn in sorted(os.listdir(vdir)):
            p = os.path.join(vdir, fn)
            out.append({"file": fn, "size": os.path.getsize(p)})
    return out


def approve_file(fid: int, reviewer: dict, approve: bool) -> dict:
    file = get_file(fid)
    if not file or file["status"] != "pending":
        raise ValueError("文件不存在或不在待审批状态")
    role = kb_role(reviewer, file["kb_id"])
    if role not in {"kb_admin", "super"}:
        raise PermissionError("需要知识库管理员权限")
    from app.knowledge import add_file_to_index, remove_file_from_index
    if approve:
        chunks = add_file_to_index(file["path"], file["kb_id"])
        with _db_lock, _connect() as conn:
            conn.execute(
                "UPDATE kb_files SET status='approved', reviewed_by=?,"
                " reviewed_at=?, chunks=? WHERE id=?",
                (reviewer["username"], time.time(), chunks, fid))
        audit(reviewer["username"], "file.approve", file["kb_id"],
              file["name"], f"chunks={chunks}")
    else:
        remove_file_from_index(file["path"])
        with _db_lock, _connect() as conn:
            conn.execute(
                "UPDATE kb_files SET status='rejected', reviewed_by=?,"
                " reviewed_at=? WHERE id=?", (reviewer["username"], time.time(), fid))
        audit(reviewer["username"], "file.reject", file["kb_id"], file["name"])
    return get_file(fid)


def delete_file(fid: int, actor: dict) -> dict:
    """删除进回收站（数据安全闸 2）：移出索引与列表，磁盘文件移入 .trash/。"""
    file = get_file(fid)
    if not file or file["status"] == "deleted":
        raise ValueError("文件不存在")
    role = kb_role(actor, file["kb_id"])
    if role not in {"kb_admin", "super"}:
        raise PermissionError("需要知识库管理员权限")
    from app.knowledge import remove_file_from_index
    remove_file_from_index(file["path"])
    trash = os.path.join(str(settings_files_dir()), str(file["kb_id"]), ".trash")
    os.makedirs(trash, exist_ok=True)
    if os.path.isfile(file["path"]):
        shutil.move(file["path"], os.path.join(
            trash, f"{time.strftime('%Y%m%d%H%M%S')}_{file['name']}"))
    with _db_lock, _connect() as conn:
        conn.execute("UPDATE kb_files SET status='deleted' WHERE id=?", (fid,))
    audit(actor["username"], "file.delete", file["kb_id"], file["name"],
          "moved to .trash")
    return {"ok": True, "deleted": file["name"], "recoverable": True}


def touch_download(file: dict, actor: dict) -> None:
    audit(actor["username"], "file.download", file["kb_id"], file["name"])
