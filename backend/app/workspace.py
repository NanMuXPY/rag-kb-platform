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
from app.extract import SUPPORTED_EXTS
from app.knowledge import DEFAULT_KB  # 向量库中默认库的标记（与迁移保持一致）

DEFAULT_KB_ID = 1

KB_ROLES = ("viewer", "editor", "kb_admin")   # 低 → 高

# 数据分级：public 公开 / internal 内部 / confidential 机密
KB_LEVELS = ("public", "internal", "confidential")
# 库状态：active 启用 / archived 归档（归档后不参与检索，但保留审计与文件）
KB_STATUS = ("active", "archived")


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
            CREATE TABLE IF NOT EXISTS kb_groups (
                kb_id    INTEGER NOT NULL,
                grp      TEXT NOT NULL,
                role     TEXT NOT NULL,
                granted_by TEXT,
                granted_at REAL,
                PRIMARY KEY (kb_id, grp)
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

        # 迁移 v3.1：知识库标准元信息（编码/归属部门/数据分级/负责人/状态）
        # 库数量上来后，「名称 + 描述」不足以治理：找不到归谁管、什么密级、还用不用
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(kbs)").fetchall()}
        for col, ddl in (
            ("code",     "ALTER TABLE kbs ADD COLUMN code TEXT NOT NULL DEFAULT ''"),
            ("dept",     "ALTER TABLE kbs ADD COLUMN dept TEXT NOT NULL DEFAULT ''"),
            ("level",    "ALTER TABLE kbs ADD COLUMN level TEXT NOT NULL DEFAULT 'internal'"),
            ("owner",    "ALTER TABLE kbs ADD COLUMN owner TEXT NOT NULL DEFAULT ''"),
            ("status",   "ALTER TABLE kbs ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"),
            ("updated_at", "ALTER TABLE kbs ADD COLUMN updated_at REAL NOT NULL DEFAULT 0"),
        ):
            if col not in cols:
                conn.execute(ddl)
        # 回填：历史库无编码，按 id 生成 KB-000x；负责人默认创建者；更新时间取创建时间
        conn.execute(
            "UPDATE kbs SET code='KB-'||substr('0000'||id, -4) WHERE code=''")
        conn.execute("UPDATE kbs SET owner=created_by WHERE owner=''")
        conn.execute("UPDATE kbs SET updated_at=created_at WHERE updated_at=0")


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
    """返回用户在某库的生效角色；无权限返回 None。默认库对全体 active 用户可读。
    生效优先级：平台管理员 > 个人成员授权 > 分组授权 > 默认库可读。"""
    if is_super(user):
        return "super"
    with _connect() as conn:
        row = conn.execute(
            "SELECT role FROM kb_members WHERE kb_id=? AND username=?",
            (kb_id, user["username"])).fetchone()
    if row:
        return row["role"]
    grp = (user.get("group") or "").strip()
    if grp:
        with _connect() as conn:
            row = conn.execute(
                "SELECT role FROM kb_groups WHERE kb_id=? AND grp=?",
                (kb_id, grp)).fetchone()
        if row:
            return row["role"]
    if kb_id == DEFAULT_KB_ID:
        return "viewer"
    return None


def readable_kb_ids(user: dict) -> list[str]:
    """检索范围（向量库 kb_id 字符串）：默认库 + 我是成员的库 + 我所在分组被授权的库
    （超管为全部库）。**归档库不参与检索**——这是归档与删除的区别：留档可查、不进问答。
    默认库的向量标记是 'default'（历史迁移约定），其余库用数字 id。"""
    with _connect() as conn:
        ids = [r["id"] for r in conn.execute(
            "SELECT id FROM kbs WHERE status='active'").fetchall()]
    if is_super(user):
        raw = ids
    else:
        with _connect() as conn:
            mine = {r["kb_id"] for r in conn.execute(
                "SELECT kb_id FROM kb_members WHERE username=?",
                (user["username"],)).fetchall()}
            grp = (user.get("group") or "").strip()
            if grp:
                mine |= {r["kb_id"] for r in conn.execute(
                    "SELECT kb_id FROM kb_groups WHERE grp=?",
                    (grp,)).fetchall()}
        raw = sorted({DEFAULT_KB_ID} | (mine & set(ids)))
    return [str(DEFAULT_KB) if i == DEFAULT_KB_ID else str(i) for i in raw]


# ---------------------------------------------------------------------------
# 知识库管理
# ---------------------------------------------------------------------------
def create_kb(name: str, description: str, creator: str,
              dept: str = "", level: str = "internal",
              owner: str = "", code: str = "") -> dict:
    """新建知识库。编码缺省按 id 生成 KB-000x；负责人缺省为创建者。"""
    if level not in KB_LEVELS:
        raise ValueError(f"数据分级只能是 {KB_LEVELS}")
    now = time.time()
    with _db_lock, _connect() as conn:
        if conn.execute("SELECT 1 FROM kbs WHERE name=?", (name,)).fetchone():
            raise ValueError("同名知识库已存在")
        cur = conn.execute(
            "INSERT INTO kbs(name, description, created_by, created_at,"
            " dept, level, owner, status, updated_at)"
            " VALUES(?,?,?,?,?,?,?,'active',?)",
            (name, description, creator, now, dept, level, owner or creator, now))
        kb_id = cur.lastrowid
        # 编码：未指定则按 id 生成，生成后回写
        final_code = code.strip() or f"KB-{kb_id:04d}"
        if conn.execute("SELECT 1 FROM kbs WHERE code=? AND id<>?",
                        (final_code, kb_id)).fetchone():
            raise ValueError(f"知识库编码「{final_code}」已被占用")
        conn.execute("UPDATE kbs SET code=? WHERE id=?", (final_code, kb_id))
        conn.execute(
            "INSERT INTO kb_members(kb_id, username, role, granted_by, granted_at)"
            " VALUES(?,?,?,?,?)", (kb_id, creator, "kb_admin", creator, now))
    audit(creator, "kb.create", kb_id, name, f"{dept} / {level}")
    return get_kb(kb_id)


def update_kb_meta(kb_id: int, actor: str, **fields) -> dict:
    """更新知识库元信息（部门/分级/负责人/状态/描述）。只接受白名单字段。"""
    allowed = {"dept", "level", "owner", "status", "description", "name"}
    patch = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if not patch:
        raise ValueError("没有可更新的字段")
    if "level" in patch and patch["level"] not in KB_LEVELS:
        raise ValueError(f"数据分级只能是 {KB_LEVELS}")
    if "status" in patch and patch["status"] not in KB_STATUS:
        raise ValueError(f"库状态只能是 {KB_STATUS}")
    if kb_id == DEFAULT_KB_ID and patch.get("status") == "archived":
        raise ValueError("默认知识库不可归档")
    sets = ", ".join(f"{k}=?" for k in patch)
    with _db_lock, _connect() as conn:
        if not conn.execute("SELECT 1 FROM kbs WHERE id=?", (kb_id,)).fetchone():
            raise ValueError("知识库不存在")
        if "name" in patch and conn.execute(
                "SELECT 1 FROM kbs WHERE name=? AND id<>?", (patch["name"], kb_id)).fetchone():
            raise ValueError("同名知识库已存在")
        conn.execute(f"UPDATE kbs SET {sets}, updated_at=? WHERE id=?",
                     (*patch.values(), time.time(), kb_id))
    audit(actor, "kb.update", kb_id, get_kb(kb_id)["name"],
          " ".join(f"{k}={v}" for k, v in patch.items()))
    return get_kb(kb_id)


def get_kb(kb_id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM kbs WHERE id=?", (kb_id,)).fetchone()
        return dict(row) if row else None


def list_kbs(include_archived: bool = True) -> list[dict]:
    """知识库列表 + 治理用的统计列（文档数/待审数/成员数/分组数）。
    列表页要一次拿全，避免前端 N+1 请求。"""
    where = "" if include_archived else " WHERE k.status='active'"
    with _connect() as conn:
        rows = conn.execute(
            "SELECT k.*,"
            " (SELECT COUNT(*) FROM kb_files f WHERE f.kb_id=k.id AND f.status='approved') AS file_count,"
            " (SELECT COUNT(*) FROM kb_files f WHERE f.kb_id=k.id AND f.status='pending')  AS pending_count,"
            " (SELECT COUNT(*) FROM kb_members m WHERE m.kb_id=k.id)                      AS member_count,"
            " (SELECT COUNT(*) FROM kb_groups g WHERE g.kb_id=k.id)                       AS group_count"
            f" FROM kbs k{where} ORDER BY k.id").fetchall()
        return [dict(r) for r in rows]


def delete_kb(kb_id: int, actor: str) -> bool:
    if kb_id == DEFAULT_KB_ID:
        raise ValueError("默认知识库不可删除")
    with _db_lock, _connect() as conn:
        cur = conn.execute("DELETE FROM kbs WHERE id=?", (kb_id,))
        conn.execute("DELETE FROM kb_members WHERE kb_id=?", (kb_id,))
        conn.execute("DELETE FROM kb_groups WHERE kb_id=?", (kb_id,))
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
# 分组授权：知识库 → 部门/团队（该分组内所有用户自动获得访问权）
# ---------------------------------------------------------------------------
def set_group_grant(kb_id: int, grp: str, role: str, actor: str) -> dict:
    assert role in KB_ROLES
    grp = (grp or "").strip()[:32]
    if not grp:
        raise ValueError("分组名不能为空")
    # 校验分组真实存在：否则会产生孤儿授权，而权限矩阵按「已有分组」取列，看不见它（静默失真）
    from app.users import list_groups
    known = {(g["group"] or "").strip() for g in list_groups()}
    if grp not in known:
        raise ValueError(f"分组「{grp}」不存在，请先在用户管理中创建该分组的成员")
    with _db_lock, _connect() as conn:
        if not conn.execute("SELECT 1 FROM kbs WHERE id=?", (kb_id,)).fetchone():
            raise ValueError("知识库不存在")
        conn.execute(
            "INSERT INTO kb_groups(kb_id, grp, role, granted_by, granted_at)"
            " VALUES(?,?,?,?,?) ON CONFLICT(kb_id, grp)"
            " DO UPDATE SET role=excluded.role, granted_by=excluded.granted_by,"
            " granted_at=excluded.granted_at",
            (kb_id, grp, role, actor, time.time()))
    audit(actor, "group.grant", kb_id, grp, role)
    return {"kb_id": kb_id, "group": grp, "role": role}


def remove_group_grant(kb_id: int, grp: str, actor: str) -> bool:
    with _db_lock, _connect() as conn:
        cur = conn.execute(
            "DELETE FROM kb_groups WHERE kb_id=? AND grp=?",
            (kb_id, (grp or "").strip()))
    if cur.rowcount:
        audit(actor, "group.revoke", kb_id, grp)
    return bool(cur.rowcount)


def list_group_grants(kb_id: int) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT grp, role, granted_by, granted_at FROM kb_groups"
            " WHERE kb_id=? ORDER BY grp", (kb_id,)).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# 文件：上传（版本备份）→ 审批 → 下载 / 回收站删除
# ---------------------------------------------------------------------------
ALLOWED_FILE_EXTS = SUPPORTED_EXTS          # 与抽取层共用一份白名单，避免两处漂移
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
        raise ValueError(f"不支持的文件类型 {ext}（仅 {'/'.join(sorted(ALLOWED_FILE_EXTS))}）")
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


def all_group_grants() -> list[dict]:
    """全部分组授权（供权限矩阵视图一次取全，避免按库循环 N+1）。"""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT kb_id, grp, role, granted_by, granted_at"
            " FROM kb_groups ORDER BY kb_id, grp").fetchall()
        return [dict(r) for r in rows]


def touch_kb(kb_id: int) -> None:
    """标记知识库「最后更新」。文件增删审批都算维护动作——否则领导会误判没人维护。"""
    with _db_lock, _connect() as conn:
        conn.execute("UPDATE kbs SET updated_at=? WHERE id=?", (time.time(), kb_id))


def candidate_users(kb_id: int) -> list[dict]:
    """可加入本库的候选人（尚未直接授权者）。供库管理员选人——容器里没有系统管理员权限。"""
    from app.users import list_users
    with _connect() as conn:
        have = {r["username"] for r in conn.execute(
            "SELECT username FROM kb_members WHERE kb_id=?", (kb_id,)).fetchall()}
    out = []
    for u in list_users():
        if u["username"] in have or u["status"] != "active":
            continue
        out.append({"username": u["username"],
                    "display_name": u.get("display_name") or u["username"],
                    "group": u.get("group") or ""})
    return out
