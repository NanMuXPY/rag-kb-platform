# ---------------------------------------------------------------------------
# FastAPI 入口：/auth 认证 + /chat 多轮对话 + /admin 管理接口 + 防护中间件
# 企业模式：注册→审批→登录；JWT 鉴权；知识库管理限管理员
# ---------------------------------------------------------------------------
from __future__ import annotations

import json
from uuid import uuid4

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from typing import Optional

from app import documents, sessions, users, workspace
from app.config import settings
from app.engine import get_engine
from app.knowledge import index_status, start_rebuild
from app.security import demo_guard, get_current_user, require_admin_user, require_super_user

app = FastAPI(title="Adaptive RAG Knowledge Base", version="2.1.0",
              # 自带 Swagger/Redoc 关闭：接口目录由前端「控制台 → 接口」面板消费 /openapi.json，
              # 两个入口并存会出现两份不同步的真相。
              docs_url=None, redoc_url=None)

_allowed = settings.allowed_origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.middleware("http")(demo_guard)


@app.middleware("http")
async def gate_schema(request: Request, call_next):
    """接口清单（openapi.json）要求登录后可见。

    未登录就能枚举全部端点，等于把后台的功能地图交给任何能访问到 8080 的人；
    前端接口面板本来就带 JWT 取，加这一层不影响它。
    """
    # 预检请求不带 Authorization，必须放行给 CORSMiddleware：
    # 若在这里回 401，浏览器会判定 CORS 预检失败，前端永远读不到接口清单。
    if request.method == "OPTIONS":
        return await call_next(request)
    if request.url.path.rstrip("/") in ("/openapi.json", "/docs", "/redoc"):
        try:
            get_current_user(request)
        except HTTPException as exc:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return await call_next(request)


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


@app.post("/chat/stream")
def chat_stream(req: ChatRequest, request: Request):
    """SSE 流式问答：事件类型 step / token / reset / final / error。

    与非流式 /chat 共用同一张图和同一个 _pack，结果结构一致。区别只在于时序：
    路由与检索阶段（约 2–5s）只发 step 事件，前端据此显示「正在检索资料」；
    进入生成节点后逐 token 推送，首字通常在 5s 内出现。

    G2 引用校验必须等全文生成完才能做，所以 final 里的 answer 可能与已推送的 token
    有极小差异（引用行被重写成规范文档名）。**前端收到 final 后应以它覆盖显示内容。**
    """
    if settings.demo_token and request.headers.get("X-Demo-Token") == settings.demo_token:
        identity = "demo"
        kb_ids = None
    else:
        user = get_current_user(request)
        identity = user["username"]
        kb_ids = workspace.readable_kb_ids(user)

    session_id = req.session_id or str(uuid4())
    scoped = f"{identity}:{session_id}"
    history = sessions.get_history(scoped) or []

    def event_stream():
        def emit(payload: dict) -> str:
            return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

        try:
            for ev in get_engine().ask_stream(req.question, history, kb_ids):
                if ev.get("type") == "final":
                    sessions.put_history(scoped, ev.get("chat_history") or [])
                    payload = {k: v for k, v in ev.items() if k != "chat_history"}
                    payload["session_id"] = session_id
                else:
                    payload = ev
                yield emit(payload)
        except ValueError as exc:
            yield emit({"type": "error", "detail": str(exc)})
        except Exception as exc:
            yield emit({"type": "error", "detail": f"{type(exc).__name__}: {exc}"})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",      # 反代不缓冲，否则要等全部吐完才到浏览器
        },
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


@app.post("/admin/users/{username}/group")
def admin_group(username: str, group: str = "", admin: dict = Depends(require_admin_user)):
    try:
        return users.set_group(username, group, admin["username"])
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


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
def my_kbs(q: str = "", dept: str = "", level: str = "", status: str = "",
           user: dict = Depends(get_current_user)):
    """我的可见知识库（含默认库），带我在每个库的角色与治理统计列。
    支持按名称/编码模糊搜索与部门、分级、状态过滤——库多了以后前端不再全量拉取后自己筛。"""
    out = []
    lv = level.strip()
    st = status.strip()
    for kb in workspace.list_kbs(include_archived=True):
        role = workspace.kb_role(user, kb["id"])
        if not role:
            continue
        if lv and kb.get("level") != lv:
            continue
        if st and kb.get("status") != st:
            continue
        if dept and kb.get("dept") != dept:
            continue
        if q:
            kw = q.strip().lower()
            hay = f"{kb.get('name','')} {kb.get('code','')} {kb.get('description','')}".lower()
            if kw not in hay:
                continue
        out.append({**kb, "my_role": role})
    return out


class KbCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)
    description: str = Field("", max_length=200)
    dept: str = Field("", max_length=32)
    level: str = Field("internal", max_length=16)
    owner: str = Field("", max_length=32)
    code: str = Field("", max_length=24)


class KbMetaRequest(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=50)
    description: str | None = Field(None, max_length=200)
    dept: str | None = Field(None, max_length=32)
    level: str | None = Field(None, max_length=16)
    owner: str | None = Field(None, max_length=32)
    status: str | None = Field(None, max_length=16)


@app.post("/admin/kbs")
def admin_create_kb(req: KbCreateRequest, admin: dict = Depends(require_admin_user)):
    try:
        return workspace.create_kb(req.name, req.description, admin["username"],
                                   dept=req.dept, level=req.level,
                                   owner=req.owner, code=req.code)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.patch("/admin/kbs/{kb_id}")
def admin_update_kb(kb_id: int, req: KbMetaRequest,
                    admin: dict = Depends(require_admin_user)):
    """更新知识库元信息（部门/分级/负责人/状态/描述/名称）。"""
    try:
        return workspace.update_kb_meta(kb_id, admin["username"], **req.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/admin/kb-matrix")
def kb_matrix(admin: dict = Depends(require_admin_user)):
    """权限矩阵：每个知识库 × 每个分组的授权关系，一次性返回给矩阵视图。
    行=知识库，列=分组；单元格=角色或空。附带各部门人数，便于判断「授权是否覆盖全员」。"""
    kbs = workspace.list_kbs(include_archived=True)
    groups = users.list_groups()          # [{group, total, active}]
    grants = workspace.all_group_grants()  # [{kb_id, grp, role}]
    cell = {}
    for g in grants:
        cell.setdefault(g["kb_id"], {})[g["grp"]] = g["role"]
    rows = []
    for kb in kbs:
        rows.append({
            "kb_id": kb["id"], "name": kb["name"], "code": kb.get("code", ""),
            "dept": kb.get("dept", ""), "level": kb.get("level", "internal"),
            "status": kb.get("status", "active"),
            "grants": cell.get(kb["id"], {}),
        })
    return {"groups": groups, "rows": rows}


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
    # 可见性规则（与 kb_download 的放行规则一一对应）：
    #   库管理员/super —— 全部，含别人的待审批（否则没法审批）
    #   其他人        —— 已入库的 + 自己上传的（含自己那份待审批/已驳回）
    # 只给 approved 会让「编辑传完文件，列表里查无此件」，与「上传者可下载自己未入库文件」互相矛盾。
    files = workspace.list_files(kb_id, include_pending=True)
    if role not in {"kb_admin", "super"}:
        me = user["username"]
        files = [f for f in files if f["status"] == "approved" or f["uploader"] == me]
    return {"my_role": role, "files": files}


@app.post("/kbs/{kb_id}/upload")
async def kb_upload(kb_id: int, file: UploadFile = File(...),
                    user: dict = Depends(get_current_user)):
    data = await file.read()
    try:
        result = workspace.save_file(kb_id, file.filename, data, user)
        workspace.touch_kb(kb_id)          # 传文件 = 库在维护，喂给列表「最后更新」
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
    # 未入库文件：库管理员可看，上传者本人也可看（否则传完 pdf 自己都打不开核对）
    if (file["status"] != "approved"
            and role not in {"kb_admin", "super"}
            and file["uploader"] != user["username"]):
        raise HTTPException(status_code=403, detail="文件未通过审批")
    import os as _os
    if not _os.path.isfile(file["path"]):
        raise HTTPException(status_code=404, detail="文件已丢失（可能被清理）")
    workspace.touch_download(file, user)
    return FileResponse(file["path"], filename=file["name"])


@app.post("/files/{fid}/approve")
def file_approve(fid: int, user: dict = Depends(get_current_user)):
    try:
        out = workspace.approve_file(fid, user, approve=True)
        workspace.touch_kb(out["kb_id"])
        return out
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/files/{fid}/reject")
def file_reject(fid: int, user: dict = Depends(get_current_user)):
    try:
        out = workspace.approve_file(fid, user, approve=False)
        workspace.touch_kb(out["kb_id"])
        return out
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/files/{fid}")
def file_delete(fid: int, user: dict = Depends(get_current_user)):
    try:
        pre = workspace.get_file(fid)
        out = workspace.delete_file(fid, user)
        if pre:
            workspace.touch_kb(pre["kb_id"])
        return out
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/kbs/{kb_id}/candidate-users")
def kb_candidate_users(kb_id: int, user: dict = Depends(get_current_user)):
    """可加入本库的候选人。库管理员即可调用——不需要系统管理员权限。"""
    role = workspace.kb_role(user, kb_id)
    if role not in {"kb_admin", "super"}:
        raise HTTPException(status_code=403, detail="需要知识库管理员权限")
    return {"users": workspace.candidate_users(kb_id)}


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


# ---- 分组授权：整个部门/团队一次性拿到访问权 ----
@app.get("/kbs/{kb_id}/groups")
def kb_groups(kb_id: int, user: dict = Depends(get_current_user)):
    role = workspace.kb_role(user, kb_id)
    if role not in {"kb_admin", "super"}:
        raise HTTPException(status_code=403, detail="需要知识库管理员权限")
    return workspace.list_group_grants(kb_id)


class GroupGrantRequest(BaseModel):
    group: str
    role: str


@app.post("/kbs/{kb_id}/groups")
def kb_grant_group(kb_id: int, req: GroupGrantRequest,
                   user: dict = Depends(get_current_user)):
    role = workspace.kb_role(user, kb_id)
    if role not in {"kb_admin", "super"}:
        raise HTTPException(status_code=403, detail="需要知识库管理员权限")
    try:
        return workspace.set_group_grant(kb_id, req.group, req.role,
                                         user["username"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/kbs/{kb_id}/groups/{group}")
def kb_revoke_group(kb_id: int, group: str,
                    user: dict = Depends(get_current_user)):
    role = workspace.kb_role(user, kb_id)
    if role not in {"kb_admin", "super"}:
        raise HTTPException(status_code=403, detail="需要知识库管理员权限")
    if not workspace.remove_group_grant(kb_id, group, user["username"]):
        raise HTTPException(status_code=404, detail="该分组未被授权")
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


# ---------------------------------------------------------------------------
# 开放管理 API（/open/v1/*）：供外部程序调用 —— 机器人、脚本、其他模型/Agent
# 鉴权：X-API-Key 请求头 = 服务端 ADMIN_API_KEY（未配置则整个通道关闭）
# 能力：用户列表/创建、批量审批·停用·改角色·设分组、分组统计、无会话问答
# ---------------------------------------------------------------------------
from app.security import require_api_key


class OpenUserCreate(BaseModel):
    username: str = Field(..., min_length=2, max_length=32)
    password: str = Field(..., min_length=8, max_length=72)
    display_name: str = Field("", max_length=32)
    group: str = Field("", max_length=32)
    auto_approve: bool = Field(True, description="true=创建即激活，免审批")


class OpenBatchRequest(BaseModel):
    usernames: list[str] = Field(..., min_length=1, max_length=500)
    action: str = Field(..., description="approve|disable|enable|set_role|set_group|delete")
    value: str = Field("", description="set_role→user/admin；set_group→分组名")


class OpenChatRequest(BaseModel):
    question: str = Field(..., min_length=1)
    kb_ids: Optional[list[int]] = Field(None, description="限定检索的知识库，空则默认库")


@app.get("/open/v1/users")
def open_users(group: str = "", status: str = "", key: str = Depends(require_api_key)):
    out = users.list_users()
    if group:
        out = [u for u in out if u["group"] == group]
    if status:
        out = [u for u in out if u["status"] == status]
    return {"total": len(out), "users": out}


@app.get("/open/v1/groups")
def open_groups(key: str = Depends(require_api_key)):
    """分组统计：每个分组多少人、多少激活，便于外部系统做看板。"""
    counts: dict[str, dict] = {}
    for u in users.list_users():
        g = u["group"] or "(未分组)"
        c = counts.setdefault(g, {"group": u["group"], "total": 0, "active": 0})
        c["total"] += 1
        c["active"] += u["status"] == "active"
    return {"groups": list(counts.values())}


@app.post("/open/v1/users")
def open_create_user(req: OpenUserCreate, key: str = Depends(require_api_key)):
    problem = users.validate_registration(req.username, req.password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    try:
        user = users.create_user(req.username, req.password, req.display_name or "")
        if req.group:
            user = users.set_group(req.username, req.group, "openapi")
        if req.auto_approve:
            user = users.set_status(req.username, "active", "openapi")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    workspace.audit(key, "open.user_create", target=req.username,
                    detail=f"group={req.group} auto_approve={req.auto_approve}")
    return user


@app.post("/open/v1/users/batch")
def open_batch(req: OpenBatchRequest, key: str = Depends(require_api_key)):
    """批量账号操作：一次请求对多个用户执行同一动作，逐个返回结果不中断。"""
    actions = {"approve", "disable", "enable", "set_role", "set_group", "delete"}
    if req.action not in actions:
        raise HTTPException(status_code=400,
                            detail=f"action 必须是 {'/'.join(sorted(actions))}")
    results = []
    for name in req.usernames:
        try:
            if req.action == "approve":
                users.set_status(name, "active", "openapi")
            elif req.action == "disable":
                users.set_status(name, "disabled", "openapi")
            elif req.action == "enable":
                users.set_status(name, "active", "openapi")
            elif req.action == "set_role":
                users.set_role(name, req.value, "openapi")
            elif req.action == "set_group":
                users.set_group(name, req.value, "openapi")
            elif req.action == "delete":
                users.delete_user(name, "openapi")
            results.append({"username": name, "ok": True})
        except (ValueError, AssertionError) as exc:
            results.append({"username": name, "ok": False, "error": str(exc)})
    ok = sum(1 for r in results if r["ok"])
    workspace.audit(key, f"open.batch_{req.action}",
                    detail=f"{ok}/{len(results)} 成功 value={req.value!r}")
    return {"action": req.action, "total": len(results), "succeeded": ok, "results": results}


@app.post("/open/v1/chat")
def open_chat(req: OpenChatRequest, key: str = Depends(require_api_key)):
    """无会话问答：给外部模型/机器人一次性的知识库查询入口（不占用户会话）。"""
    try:
        result = get_engine().ask(req.question, [], req.kb_ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")
    workspace.audit(key, "open.chat", target=req.question[:50])
    return {"answer": result["answer"], "sources": result["sources"],
            "route": result["route"]}


def main():
    import uvicorn
    uvicorn.run("api.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()
