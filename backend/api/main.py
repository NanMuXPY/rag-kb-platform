# ---------------------------------------------------------------------------
# FastAPI 入口：/auth 认证 + /chat 多轮对话 + /admin 管理接口 + 防护中间件
# 企业模式：注册→审批→登录；JWT 鉴权；知识库管理限管理员
# ---------------------------------------------------------------------------
from __future__ import annotations

from uuid import uuid4

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from typing import Optional

from app import documents, sessions, users, workspace
from app.config import settings
from app.engine import get_engine
from app.knowledge import index_status, start_rebuild
from app.security import demo_guard, get_current_user, require_admin_user, require_super_user

app = FastAPI(title="Adaptive RAG Knowledge Base", version="2.1.0")

_allowed = settings.allowed_origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.middleware("http")(demo_guard)


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, description="用户问题")
    session_id: Optional[str] = Field(None, description="多轮会话 ID，空则新建")


class ChatResponse(BaseModel):
    session_id: str
    answer: str
    sources: list
    steps: list
    trace: list
    route: str


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=2, max_length=32)
    password: str = Field(..., min_length=1, max_length=72)
    display_name: Optional[str] = Field(None, max_length=32)


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=32)
    password: str = Field(..., min_length=1, max_length=72)


@app.on_event("startup")
def startup():
    users.init_db()
    workspace.init_workspace()  # 多知识库工作区（迁移 admin→superadmin）
    get_engine()     # 预热：建/加载向量库 + 编译图


@app.get("/")
def root():
    return {
        "service": "adaptive-rag-kb",
        "version": "2.1.0",
        "status": "ok",
        "docs": "/docs",
        "auth": "/auth/login, /auth/register",
        "chat": "POST /chat",
        "admin": "/admin/users, /admin/documents",
    }


@app.get("/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# 认证
# ---------------------------------------------------------------------------
@app.post("/auth/register")
def register(req: RegisterRequest):
    problem = users.validate_registration(req.username, req.password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    try:
        user = users.create_user(req.username, req.password, req.display_name or "")
        workspace.audit(req.username, "auth.register", detail="待审批")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "message": "注册成功，等待管理员审批后即可登录",
            "username": user["username"]}


@app.post("/auth/login")
def login(req: LoginRequest, request: Request):
    ip = request.client.host if request.client else "unknown"
    try:
        result = users.login(req.username, req.password, ip)
        workspace.audit(req.username, "auth.login", detail=ip)
    except PermissionError as exc:
        workspace.audit(req.username, "auth.login_denied", detail=ip)
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        workspace.audit(req.username, "auth.login_failed", detail=ip)
        raise HTTPException(status_code=401, detail=str(exc))
    return result


@app.get("/auth/me")
def me(user: dict = Depends(get_current_user)):
    return {k: v for k, v in user.items() if k != "password_hash"}


# ---------------------------------------------------------------------------
# 对话（登录用户；兼容 DEMO_TOKEN 旧评测通道）
# ---------------------------------------------------------------------------
@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest, request: Request):
    if settings.demo_token and request.headers.get("X-Demo-Token") == settings.demo_token:
        identity = "demo"          # 旧评测脚本兼容通道
        kb_ids = None              # demo 通道：默认库
    else:
        user = get_current_user(request)  # 企业模式：JWT
        identity = user["username"]
        kb_ids = workspace.readable_kb_ids(user)  # 权限边界：仅可见知识库

    session_id = req.session_id or str(uuid4())
    scoped = f"{identity}:{session_id}"  # 会话按用户隔离
    history = sessions.get_history(scoped) or []

    try:
        result = get_engine().ask(req.question, history, kb_ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")

    sessions.put_history(scoped, result["chat_history"])

    return ChatResponse(
        session_id=session_id,
        answer=result["answer"],
        sources=result["sources"],
        steps=result["steps"],
        trace=result["trace"],
        route=result["route"],
    )


@app.post("/chat/reset")
def reset_chat(session_id: Optional[str] = None, request: Request = None):
    if session_id and request is not None:
        try:
            identity = get_current_user(request)["username"]
        except HTTPException:
            identity = "demo" if settings.demo_token else ""
        if identity:
            sessions.drop_session(f"{identity}:{session_id}")
    return {"ok": True, "session_id": session_id}


# ---------------------------------------------------------------------------
# 用户管理（管理员）
# ---------------------------------------------------------------------------
@app.get("/admin/users")
def admin_users(_: dict = Depends(require_admin_user)):
    return users.list_users()


@app.post("/admin/users/{username}/approve")
def admin_approve(username: str, admin: dict = Depends(require_admin_user)):
    try:
        return users.set_status(username, "active", admin["username"])
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/admin/users/{username}/reject")
def admin_reject(username: str, admin: dict = Depends(require_admin_user)):
    try:
        return users.set_status(username, "disabled", admin["username"])
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/admin/users/{username}/disable")
def admin_disable(username: str, admin: dict = Depends(require_admin_user)):
    try:
        return users.set_status(username, "disabled", admin["username"])
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/admin/users/{username}/enable")
def admin_enable(username: str, admin: dict = Depends(require_admin_user)):
    try:
        return users.set_status(username, "active", admin["username"])
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/admin/users/{username}/role")
def admin_role(username: str, role: str, admin: dict = Depends(require_admin_user)):
    try:
        return users.set_role(username, role, admin["username"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/admin/users/{username}")
def admin_delete_user(username: str, admin: dict = Depends(require_admin_user)):
    try:
        removed = users.delete_user(username, admin["username"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not removed:
        raise HTTPException(status_code=404, detail="用户不存在")
    return {"ok": True, "deleted": username}


# ---------------------------------------------------------------------------
# 知识库管理（管理员）
# ---------------------------------------------------------------------------
@app.get("/admin/documents")
def admin_documents(_: dict = Depends(require_admin_user)):
    return documents.list_documents()


@app.post("/admin/upload")
async def admin_upload(file: UploadFile = File(...), _: dict = Depends(require_admin_user)):
    data = await file.read()
    try:
        result = documents.save_upload(file.filename, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"解析失败 {type(exc).__name__}: {exc}")
    return {"ok": True, **result, "rebuild": start_rebuild()}


@app.delete("/admin/documents/{name}")
def admin_delete_document(name: str, _: dict = Depends(require_admin_user)):
    try:
        removed = documents.delete_upload(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not removed:
        raise HTTPException(status_code=404, detail="未找到该文档（内置语料不可删除）")
    return {"ok": True, "deleted": name, "rebuild": start_rebuild()}


@app.post("/admin/rebuild")
def admin_rebuild(_: dict = Depends(require_admin_user)):
    return start_rebuild()


@app.get("/admin/index-status")
def admin_index(_: dict = Depends(require_admin_user)):
    return index_status()


# ---------------------------------------------------------------------------
# 多知识库工作区：列表 / 文件 / 上传审批 / 下载 / 成员 / 审计 / 跨库搜索
# ---------------------------------------------------------------------------
@app.get("/kbs")
def my_kbs(user: dict = Depends(get_current_user)):
    """我的可见知识库（含默认库），带我在每个库的角色。"""
    out = []
    for kb in workspace.list_kbs():
        role = workspace.kb_role(user, kb["id"])
        if role:
            out.append({**kb, "my_role": role})
    return out


class KbCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)
    description: str = Field("", max_length=200)


@app.post("/admin/kbs")
def admin_create_kb(req: KbCreateRequest, admin: dict = Depends(require_admin_user)):
    try:
        return workspace.create_kb(req.name, req.description, admin["username"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/admin/kbs/{kb_id}")
def admin_delete_kb(kb_id: int, admin: dict = Depends(require_admin_user)):
    try:
        removed = workspace.delete_kb(kb_id, admin["username"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not removed:
        raise HTTPException(status_code=404, detail="知识库不存在")
    return {"ok": True}


@app.get("/kbs/{kb_id}/files")
def kb_files(kb_id: int, user: dict = Depends(get_current_user)):
    role = workspace.kb_role(user, kb_id)
    if not role:
        raise HTTPException(status_code=403, detail="无权访问该知识库")
    include_pending = role in {"kb_admin", "super"}
    files = workspace.list_files(kb_id, include_pending)
    if role == "viewer":
        files = [f for f in files if f["status"] == "approved"]
    return {"my_role": role, "files": files}


@app.post("/kbs/{kb_id}/upload")
async def kb_upload(kb_id: int, file: UploadFile = File(...),
                    user: dict = Depends(get_current_user)):
    data = await file.read()
    try:
        result = workspace.save_file(kb_id, file.filename, data, user)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result


@app.get("/kbs/{kb_id}/files/{fid}/download")
def kb_download(kb_id: int, fid: int, user: dict = Depends(get_current_user)):
    role = workspace.kb_role(user, kb_id)
    if not role:
        raise HTTPException(status_code=403, detail="无权访问该知识库")
    file = workspace.get_file(fid)
    if not file or file["kb_id"] != kb_id or file["status"] == "deleted":
        raise HTTPException(status_code=404, detail="文件不存在")
    if file["status"] != "approved" and role not in {"kb_admin", "super"}:
        raise HTTPException(status_code=403, detail="文件未通过审批")
    import os as _os
    if not _os.path.isfile(file["path"]):
        raise HTTPException(status_code=404, detail="文件已丢失（可能被清理）")
    workspace.touch_download(file, user)
    return FileResponse(file["path"], filename=file["name"])


@app.post("/files/{fid}/approve")
def file_approve(fid: int, user: dict = Depends(get_current_user)):
    try:
        return workspace.approve_file(fid, user, approve=True)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/files/{fid}/reject")
def file_reject(fid: int, user: dict = Depends(get_current_user)):
    try:
        return workspace.approve_file(fid, user, approve=False)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/files/{fid}")
def file_delete(fid: int, user: dict = Depends(get_current_user)):
    try:
        return workspace.delete_file(fid, user)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/kbs/{kb_id}/members")
def kb_members(kb_id: int, user: dict = Depends(get_current_user)):
    role = workspace.kb_role(user, kb_id)
    if role not in {"kb_admin", "super"}:
        raise HTTPException(status_code=403, detail="需要知识库管理员权限")
    return workspace.list_members(kb_id)


class MemberRequest(BaseModel):
    username: str
    role: str


@app.post("/kbs/{kb_id}/members")
def kb_set_member(kb_id: int, req: MemberRequest,
                  user: dict = Depends(get_current_user)):
    role = workspace.kb_role(user, kb_id)
    if role not in {"kb_admin", "super"}:
        raise HTTPException(status_code=403, detail="需要知识库管理员权限")
    if not users.get_user(req.username):
        raise HTTPException(status_code=404, detail="该用户不存在")
    try:
        return workspace.set_member(kb_id, req.username, req.role, user["username"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/kbs/{kb_id}/members/{username}")
def kb_remove_member(kb_id: int, username: str,
                     user: dict = Depends(get_current_user)):
    role = workspace.kb_role(user, kb_id)
    if role not in {"kb_admin", "super"}:
        raise HTTPException(status_code=403, detail="需要知识库管理员权限")
    if not workspace.remove_member(kb_id, username, user["username"]):
        raise HTTPException(status_code=404, detail="成员不存在或为库管理员")
    return {"ok": True}


@app.get("/admin/audit")
def admin_audit(limit: int = 200, action: str = "", username: str = "",
                _: dict = Depends(require_admin_user)):
    return workspace.list_audit(limit=limit, action=action, username=username)


@app.get("/admin/search")
def super_search(q: str, _: dict = Depends(require_super_user)):
    """超管跨库搜索：全库语义检索，返回命中 chunk 及所属知识库。"""
    if not q.strip():
        raise HTTPException(status_code=400, detail="缺少查询 q")
    db = get_engine().db
    docs = db.similarity_search(q.strip(), k=10)
    kb_names = {kb["id"]: kb["name"] for kb in workspace.list_kbs()}
    path2name = {f["path"]: f["name"] for kb in workspace.list_kbs()
                 for f in workspace.list_files(kb["id"])}
    out = []
    for d in docs:
        meta = d.metadata or {}
        full_path = str(meta.get("source", ""))
        kb_id = str(meta.get("kb_id", "default"))
        try:
            kbn = kb_names.get(int(kb_id), kb_names.get(kb_id, "产品通用知识库"))
        except ValueError:
            kbn = "产品通用知识库"
        fname = path2name.get(full_path) or full_path.replace("\\", "/").rsplit("/", 1)[-1]
        out.append({
            "kb": kbn,
            "source": fname,
            "preview": d.page_content[:160],
        })
    workspace.audit(_["username"], "search.cross", target=q[:50])
    return {"results": out}


def main():
    import uvicorn
    uvicorn.run("api.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()
