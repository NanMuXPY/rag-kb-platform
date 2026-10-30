# ---------------------------------------------------------------------------
# 混合检索：向量召回 + BM25 关键词召回，RRF 融合（E4）
#
# 为什么需要：向量检索对"专有名词 / 接口名 / 错误码 / 产品名"这类低频实体不敏感，
# 而 BM25 恰好擅长精确词命中。两者互补，用 RRF（Reciprocal Rank Fusion）融合：
#   score(doc) = Σ 1 / (k + rank_i(doc))，k 取 60（业界常用经验值）
# 中文分词不引第三方词典，直接用字符二元组（bigram）：对产品文档这种短语密集语料够用。
#
# v2.3（规模加固）——解决"chunk 一变就全量内存重建，提问被卡住"：
#   1. 分词缓存落盘（按 chunk id 存 token），重启不必重算
#   2. 内容变更只递增 revision，由后台线程重建，读取方永远拿旧索引继续服务
#   3. 索引对象整体替换（copy-on-write），读写不互相阻塞
#   4. 超过 BM25_MAX_CHUNKS 自动降级为纯向量，并把原因写进状态接口（不再静默变慢）
# ---------------------------------------------------------------------------
from __future__ import annotations

import math
import os
import pickle
import re
import threading
import time
from functools import lru_cache

from langchain_core.documents import Document

from app.config import settings

_WORD = re.compile(r"[A-Za-z0-9_.\-]+")
_CJK = re.compile(r"[\u4e00-\u9fff]+")
_RRF_K = 60

_lock = threading.RLock()
_state: dict = {
    "revision": 0,          # 内容版本号：knowledge 每次增删 +1
    "built_revision": -1,   # 当前索引对应的版本号
    "groups": {},           # {kb_id: {"index": BM25Okapi, "docs": [...]}}（按库分区）
    "count": 0,
    "kb_count": 0,
    "mode": "init",         # init / building / ready / disabled / error
    "building": False,
    "built_at": None,
    "error": None,
    "build_seconds": None,
}


def tokenize(text: str) -> list[str]:
    """英文/数字按词切，中文按二元组切（无需 jieba，离线可用）。"""
    text = text or ""
    tokens = [w.lower() for w in _WORD.findall(text)]
    for seg in _CJK.findall(text):
        if len(seg) == 1:
            tokens.append(seg)
        else:
            tokens.extend(seg[i:i + 2] for i in range(len(seg) - 1))
    return tokens


# ---------------------------------------------------------------------------
# 分词缓存：{chunk_id: tokens}，落盘到向量库旁边
# ---------------------------------------------------------------------------
def _cache_path(db) -> str:
    persist = getattr(db, "_persist_directory", None) or getattr(
        db, "persist_directory", None) or str(settings.persist_dir)
    return str(persist).rstrip("/\\") + ".bm25.pkl"


@lru_cache(maxsize=4)
def _load_token_cache(path: str, count: int) -> dict:
    if not settings.bm25_cache:
        return {}
    try:
        with open(path, "rb") as f:
            payload = pickle.load(f)
        if isinstance(payload, dict) and payload.get("count") == count:
            return payload.get("tokens") or {}
    except Exception:
        pass
    return {}


def _save_token_cache(path: str, count: int, tokens: dict) -> None:
    if not settings.bm25_cache:
        return
    tmp = f"{path}.tmp"
    try:
        with open(tmp, "wb") as f:
            pickle.dump({"version": 3, "count": count, "tokens": tokens}, f,
                        protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(tmp, path)
    except Exception as exc:
        print(f"[bm25] cache write skipped: {exc}")


# ---------------------------------------------------------------------------
# 构建
# ---------------------------------------------------------------------------
def _build(db, revision: int) -> None:
    """全量取 chunk → 复用缓存分词 → 构建 BM25 → 原子替换。"""
    from rank_bm25 import BM25Okapi

    t0 = time.perf_counter()
    global _state
    with _lock:
        _state["mode"] = "building"
        _state["building"] = True

    data = db._collection.get(include=["documents", "metadatas"])
    ids = data.get("ids") or []
    texts = data.get("documents") or []
    metas = data.get("metadatas") or []
    count = len(ids)

    if count > settings.bm25_max_chunks:
        with _lock:
            _state.update({
                "mode": "disabled", "building": False, "groups": {},
                "count": count, "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "error": f"chunks={count} > BM25_MAX_CHUNKS={settings.bm25_max_chunks}，"
                         "关键词通道已降级为纯向量；请迁移到 ES/OpenSearch",
            })
        print(f"[bm25] disabled: {count} chunks exceed threshold")
        return

    cache_file = _cache_path(db)
    tokens_cache = _load_token_cache(cache_file, count)
    new_tokens: dict = {}
    # 按 kb_id 分区建索引：查询时只算有权限的那几个库，库多时不会越查越慢
    buckets: dict[str, tuple[list[list[str]], list[Document]]] = {}

    for cid, text, meta in zip(ids, texts, metas):
        meta = meta or {}
        toks = tokens_cache.get(cid)
        if toks is None:
            toks = tokenize(text or "")
        new_tokens[cid] = toks
        key = str(meta.get("kb_id", "default"))
        corpus, bucket_docs = buckets.setdefault(key, ([], []))
        corpus.append(toks)
        bucket_docs.append(Document(page_content=text or "", metadata=meta))

    groups: dict[str, dict] = {}
    for key, (corpus, bucket_docs) in buckets.items():
        groups[key] = {"index": BM25Okapi(corpus) if corpus else None, "docs": bucket_docs}
    elapsed = round(time.perf_counter() - t0, 2)

    with _lock:                       # 整体替换：读取方要么看到旧索引，要么看到新索引
        _state.update({
            "groups": groups,
            "count": len(new_tokens),
            "kb_count": len(groups),
            "mode": "ready" if groups else "empty",
            "building": False,
            "built_revision": revision,
            "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "error": None,
            "build_seconds": elapsed,
        })
    _save_token_cache(cache_file, count, new_tokens)
    print(f"[bm25] built {len(new_tokens)} chunks / {len(groups)} kbs in {elapsed}s (rev={revision})")


def _rebuild_loop(db, revision: int) -> None:
    """后台重建线程：期间拿旧索引继续服务，不会被内容变更卡住。"""
    try:
        _build(db, revision)
    except Exception as exc:
        with _lock:
            _state.update({"mode": "error", "building": False,
                           "error": f"{type(exc).__name__}: {exc}"})
        print(f"[bm25] build failed: {exc}")
    finally:
        # 构建期间又发生了变更：再排一次，保证最终追平（否则要等下一次提问才补）
        with _lock:
            pending = _state["revision"] != revision
        if pending:
            _schedule(db, _state["revision"])


def _schedule(db, revision: int) -> None:
    with _lock:
        if _state["building"]:
            return
        _state["building"] = True
    threading.Thread(target=_rebuild_loop, args=(db, revision), daemon=True).start()


def _ensure_index(db) -> None:
    """保证索引跟进最新 revision：冷启动同步建一次，之后一律后台重建。"""
    with _lock:
        revision = _state["revision"]
        if _state["mode"] == "disabled":
            return
        if _state["built_revision"] == revision and not _state["building"]:
            return
        cold = _state["built_revision"] < 0 and not _state["building"]
    if cold:
        _rebuild_loop(db, revision)      # 冷启动：这一次必须等到索引可用
    else:
        _schedule(db, revision)          # 内容变更：后台跟进，旧索引继续服务


def notify_changed() -> None:
    """内容变更通知：递增 revision 并立刻在后台重建（不阻塞调用方）。"""
    with _lock:
        _state["revision"] += 1
        revision = _state["revision"]
        if _state["mode"] == "disabled":   # 变少后可能重新落回阈值内，允许再评估
            _state["mode"] = "init"
            _state["built_revision"] = -1
    print(f"[bm25] content changed -> rev={revision} (background rebuild)")
    try:
        from app.knowledge import get_db
        db = get_db()
        if db is not None:
            _schedule(db, revision)
    except Exception:
        pass


def invalidate() -> None:
    """清空缓存文件（全量重建切换新库后调用）。"""
    try:
        from app.knowledge import get_db
        db = get_db()
        if db is not None:
            p = _cache_path(db)
            if os.path.exists(p):
                os.remove(p)
    except Exception:
        pass


def keyword_status() -> dict:
    with _lock:
        return {
            "mode": _state["mode"],
            "chunks": _state["count"],
            "kbs": _state["kb_count"],
            "revision": _state["revision"],
            "built_revision": _state["built_revision"],
            "building": _state["building"],
            "built_at": _state["built_at"],
            "build_seconds": _state["build_seconds"],
            "max_chunks": settings.bm25_max_chunks,
            "error": _state["error"],
        }


def bm25_search(db, query: str, k: int, kb_ids: list[str]) -> list[Document]:
    _ensure_index(db)
    with _lock:                       # 只拷贝引用，构建期间的写入不影响本次搜索
        groups = _state["groups"]
    if not groups:
        return []
    tokens = tokenize(query)
    if not tokens:
        return []
    uniq = set(tokens)
    scored: list[tuple[float, Document]] = []
    for kb in {str(x) for x in kb_ids}:          # 只算有权限的库：库多也不拖慢
        group = groups.get(kb)
        if not group or group["index"] is None:
            continue
        index = group["index"]
        scores = index.get_scores(tokens)
        # 注意：语料很小时 BM25 的 IDF 会被钳成负数（N≈1 时 df≈N），
        # 不能按 score>0 过滤，否则整个通道静默返回空——改判"是否真有词重叠"。
        for i in sorted(range(len(scores)), key=lambda j: scores[j], reverse=True):
            if not any(t in index.doc_freqs[i] for t in uniq):
                continue
            scored.append((scores[i], group["docs"][i]))
            if len(scored) >= k * 4:             # 每个库只取前 4k 个候选，控制开销
                break
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [doc for _, doc in scored[:k]]


def _key_of(doc: Document) -> tuple:
    return (str((doc.metadata or {}).get("source", "")), (doc.page_content or "")[:80])


def rrf_fuse(lists: list[list[Document]], k: int) -> list[Document]:
    """倒数排名融合：任一路排得靠前都会得分，避免单一通道误判。"""
    scores: dict[tuple, float] = {}
    store: dict[tuple, Document] = {}
    for ranked in lists:
        for rank, doc in enumerate(ranked, 1):
            key = _key_of(doc)
            scores[key] = scores.get(key, 0.0) + 1.0 / (_RRF_K + rank)
            store.setdefault(key, doc)
    ordered = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    return [store[key] for key, _ in ordered[:k]]


def hybrid_search(db, query: str, k: int, kb_ids: list[str],
                  fetch_k: int = 12) -> list[Document]:
    """向量 + BM25 混合检索，多库时按库分配配额。

    为什么多库要分配额（v2.4 线上验收发现）：把一份 5KB 的 Excel 传进一个新建的库，
    再问表里的内容，top-8 全被默认库（185 chunk）占满，新库的切片一个都没进来——
    用户的心智是"我刚传的，你应该知道"，而全局 top-k 只会让大库吃掉全部名额。
    做法：多库时每库各取 per 个候选（向量 + BM25 各一份），再用同一套 RRF 合并；
    只算一次 embedding，避免 N 次向量化。
    """
    kb_ids = [str(x) for x in kb_ids]
    if not kb_ids:
        vector_hits = db.similarity_search(query, k=fetch_k)
        keyword_hits = bm25_search(db, query, fetch_k, [])
        return rrf_fuse([vector_hits, keyword_hits], k)

    if len(kb_ids) == 1:
        where = {"kb_id": {"$in": kb_ids}}
        vector_hits = db.similarity_search(query, k=fetch_k, filter=where)
        keyword_hits = bm25_search(db, query, fetch_k, kb_ids)
        return rrf_fuse([vector_hits, keyword_hits], k)

    per = max(2, min(fetch_k, math.ceil(k * 2 / len(kb_ids))))
    try:
        vec = db.embeddings.embed_query(query)
        search = lambda kb: db.similarity_search_by_vector(vec, k=per, filter={"kb_id": kb})
    except AttributeError:                      # 老版本包装没有 embeddings 属性，退回文本查询
        search = lambda kb: db.similarity_search(query, k=per, filter={"kb_id": kb})

    lists: list[list[Document]] = []
    for kb in kb_ids:
        lists.append(search(kb))
        lists.append(bm25_search(db, query, per, [kb]))
    return rrf_fuse(lists, k)
