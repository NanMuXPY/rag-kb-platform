# ---------------------------------------------------------------------------
# 混合检索：向量召回 + BM25 关键词召回，RRF 融合（E4）
#
# 为什么需要：向量检索对"专有名词 / 接口名 / 错误码 / 产品名"这类低频实体不敏感，
# 而 BM25 恰好擅长精确词命中。两者互补，用 RRF（Reciprocal Rank Fusion）融合：
#   score(doc) = Σ 1 / (k + rank_i(doc))，k 取 60（业界常用经验值）
# 中文分词不引第三方词典，直接用字符二元组（bigram）：对产品文档这种短语密集语料够用。
# ---------------------------------------------------------------------------
from __future__ import annotations

import re
from functools import lru_cache

from langchain_core.documents import Document
from rank_bm25 import BM25Okapi

_WORD = re.compile(r"[A-Za-z0-9_.\-]+")
_CJK = re.compile(r"[\u4e00-\u9fff]+")
_RRF_K = 60

_cache: dict = {"key": None, "bm25": None, "docs": [], "kb_ids": []}


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


def _build_index(db) -> None:
    """从 Chroma 拉全量 chunk 建 BM25 索引；按 chunk 数与库版本做失效判断。"""
    data = db._collection.get(include=["documents", "metadatas"])
    docs: list[Document] = []
    kb_ids: list[str] = []
    for text, meta in zip(data.get("documents") or [], data.get("metadatas") or []):
        if not text:
            continue
        docs.append(Document(page_content=text, metadata=meta or {}))
        kb_ids.append(str((meta or {}).get("kb_id", "default")))
    corpus = [tokenize(d.page_content) for d in docs]
    _cache.update({
        "key": (db._collection.count(), len(docs)),
        "bm25": BM25Okapi(corpus) if corpus else None,
        "docs": docs,
        "kb_ids": kb_ids,
    })


def _ensure_index(db):
    key = (db._collection.count(),)
    if _cache["key"] is None or _cache["key"][0] != key[0] or _cache["bm25"] is None:
        _build_index(db)


def bm25_search(db, query: str, k: int, kb_ids: list[str]) -> list[Document]:
    _ensure_index(db)
    bm25 = _cache["bm25"]
    if bm25 is None:
        return []
    scores = bm25.get_scores(tokenize(query))
    allow = {str(x) for x in kb_ids}
    ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    out = []
    for i in ranked:
        if scores[i] <= 0:
            break
        if _cache["kb_ids"][i] not in allow:
            continue
        out.append(_cache["docs"][i])
        if len(out) >= k:
            break
    return out


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
    where = {"kb_id": {"$in": [str(x) for x in kb_ids]}}
    vector_hits = db.similarity_search(query, k=fetch_k, filter=where)
    keyword_hits = bm25_search(db, query, fetch_k, kb_ids)
    return rrf_fuse([vector_hits, keyword_hits], k)
