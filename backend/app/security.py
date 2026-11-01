# ---------------------------------------------------------------------------
# 鉴权：JWT Bearer 为主（企业模式），保留可选 Demo Token 兼容旧评测脚本
# FastAPI 依赖注入：get_current_user（登录即可）→ require_admin_user（管理员）
# ---------------------------------------------------------------------------
from __future__ import annotations

import time
from collections import defaultdict

from fastapi import Depends, HTTPException, Request

from app import users
from app.config import settings

_guarded_paths = {"/chat", "/chat/reset", "/auth/login", "/auth/register"}
_ip_usage: dict[str, list[float]] = defaultdict(list)


def _too_many(ip: str) -> bool:
    now = time.time()
    _ip_usage[ip] = [t for t in _ip_usage[ip] if now - t < 86400]
    if len(_ip_usage[ip]) >= max(settings.daily_ip_limit, 1):
        return True
    _ip_usage[ip].append(now)
    return False


async def demo_guard(request: Request, call_next):
    """全局中间件：按 IP 每日限流（含登录/注册接口，防刷防爆破）。"""
    if request.url.path in _guarded_paths and settings.daily_ip_limit > 0:
        ip = request.client.host if request.client else "unknown"
        if _too_many(ip):
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=429,
                                content={"detail": "今日调用次数已达上限，请明天再试"})
    return await call_next(request)


def _bearer_token(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录或凭证缺失",
                            headers={"WWW-Authenticate": "Bearer"})
    return auth[7:]


def get_current_user(request: Request) -> dict:
    """核心鉴权依赖：校验 JWT → 加载用户 → 校验状态仍为 active（服务端权威）。"""
    try:
        payload = users.decode_token(_bearer_token(request))
    except Exception:
        raise HTTPException(status_code=401, detail="凭证无效或已过期，请重新登录")
    user = users.get_user(payload.get("sub", ""))
    if not user:
        raise HTTPException(status_code=401, detail="账号不存在")
    if user["status"] != "active":
        raise HTTPException(status_code=403, detail="账号不可用（待审批或已停用）")
    return user


def require_admin_user(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] not in {"admin", "superadmin"}:
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def require_super_user(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "superadmin":
        raise HTTPException(status_code=403, detail="需要超级管理员权限")
    return user


def require_api_key(request: Request) -> str:
    """开放管理 API 鉴权：X-API-Key 与服务端 ADMIN_API_KEY 恒时比较。

    未配置 ADMIN_API_KEY 时整个 /open/v1/* 通道视为关闭（403），
    避免"忘了配密钥 = 裸奔"的静默事故。用 hmac.compare_digest 防时序侧信道。
    """
    import hmac as _hmac
    expected = settings.admin_api_key
    if not expected:
        raise HTTPException(status_code=403,
                            detail="开放 API 未启用（服务端未配置 ADMIN_API_KEY）")
    got = request.headers.get("X-API-Key", "")
    if not got or not _hmac.compare_digest(got, expected):
        raise HTTPException(status_code=401, detail="API Key 无效")
    return "openapi"


def demo_identity(request: Request) -> str:
    """兼容通道：设置 DEMO_TOKEN 时允许旧评测脚本以 X-Demo-Token 访问 /chat，
    身份记为 demo（与登录用户共用每 IP 限流池）。"""
    if settings.demo_token and request.headers.get("X-Demo-Token") == settings.demo_token:
        return "demo"
    raise HTTPException(status_code=401, detail="未登录或凭证缺失")
