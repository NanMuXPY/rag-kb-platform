# ---------------------------------------------------------------------------
# 会话存储：进程内内存 + 简单过期清理
# v2 小改进：定期清理超 24h 未活跃的会话，防长驻进程内存缓慢膨胀
# ---------------------------------------------------------------------------
from __future__ import annotations

import threading
import time

_TTL_SECONDS = 24 * 3600
_CLEANUP_INTERVAL = 3600
_lock = threading.Lock()
_sessions: dict[str, dict] = {}   # session_id -> {"history": [...], "ts": float}


def get_history(session_id: str) -> list[dict] | None:
    with _lock:
        item = _sessions.get(session_id)
        if item is None:
            return None
        item["ts"] = time.time()
        return list(item["history"])


def put_history(session_id: str, history: list[dict]) -> None:
    with _lock:
        _sessions[session_id] = {"history": list(history), "ts": time.time()}


def drop_session(session_id: str) -> bool:
    with _lock:
        return _sessions.pop(session_id, None) is not None


def _cleanup_loop():
    while True:
        time.sleep(_CLEANUP_INTERVAL)
        cutoff = time.time() - _TTL_SECONDS
        with _lock:
            for sid in [s for s, v in _sessions.items() if v["ts"] < cutoff]:
                _sessions.pop(sid, None)


threading.Thread(target=_cleanup_loop, daemon=True).start()
