# ---------------------------------------------------------------------------
# 知识库：加载 → 切块 → Chroma 向量库 → retriever；旁路重建（原子切换 + 进程自愈）
#
# v2 保留旧版验证过的核心机制：
#   - chromadb PersistentClient 按路径单例，原地重建会撞 sqlite readonly
#     → 旁路目录建新库 → 原子改名 → os._exit 让容器 restart 拉起加载新库
#   - 切块 800/120，中文友好分隔符
#
# v2.3（规模与格式加固）：
#   1. 建库扫描支持 md/txt/pdf/docx（原来只扫 *.md，Word/PDF 丢进目录也不生效）
#   2. 抽不出文字的文件进 skipped 报告，不再"静默成功"
#   3. embedding 从串行小批量改为"多批并发 + 指数退避"，万级文档入库不再是几小时
#   4. 重建过程上报 phase/进度，长任务不再是黑盒
# ---------------------------------------------------------------------------
from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from langchain_community.vectorstores import Chroma
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import settings
from app.extract import SUPPORTED_EXTS, extract_bytes, extract_path
from app.llm import embeddings

_SPLITTER_SEPARATORS = ["\n\n", "\n", "。", "！", "？", "；", "，", " ", ""]

_scan_report: dict = {"skipped": [], "by_format": {}}


# ---------------------------------------------------------------------------
# 抽取
# ---------------------------------------------------------------------------
def _walk_supported(root) -> list[str]:
    """递归收集支持格式的文件（跳过隐藏文件与 .versions/.trash 备份区）。"""
    out: list[str] = []
    if not os.path.isdir(root):
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith((".", "_"))]
        for name in filenames:
            if name.startswith("."):
                continue
            if os.path.splitext(name)[1].lower() in SUPPORTED_EXTS:
                out.append(os.path.join(dirpath, name))
    return sorted(out)


def load_documents() -> list:
    """加载内置语料（data/ 下 md/txt/pdf/docx）。

    v2.2：自传文件不再由目录扫描兜底——改走工作区 DB 的 approved 清单
    （见 _load_workspace_docs），避免「待审批文件被重建误索引」。
    v2.3：扫描范围从 *.md 扩到全部支持格式；抽不出文字的文件记入 skipped。
    """
    documents: list = []
    skipped: list[dict] = []
    by_format: dict[str, int] = {}

    for path in _walk_supported(settings.data_dir):
        ext = os.path.splitext(path)[1].lower()
        result = extract_path(path)
        if not result.text.strip():
            skipped.append({
                "file": os.path.relpath(path, settings.data_dir).replace("\\", "/"),
                "reason": result.note or "空文本",
                "needs_ocr": result.needs_ocr,
            })
            continue
        by_format[ext] = by_format.get(ext, 0) + 1
        documents.append(Document(
            page_content=result.text,
            metadata={"source": path.replace("\\", "/"),
                      "format": ext.lstrip("."),
                      "pages": result.pages},
        ))

    _scan_report["skipped"] = skipped
    _scan_report["by_format"] = by_format
    if skipped:
        print(f"[kb] skipped {len(skipped)} files without text: "
              f"{[s['file'] for s in skipped][:5]}")
    if not documents:
        raise RuntimeError(f"未在 {settings.data_dir} 下找到可解析文档（{sorted(SUPPORTED_EXTS)}）")
    return documents


def _load_workspace_docs() -> list:
    """已批准的自传文件 → Document（kb_id 按库标记），供增量/重建共用。"""
    from app.workspace import list_files
    docs: list = []
    try:
        approved = [f for kb in list_kbs_safe() for f in list_files(kb["id"])
                    if f["status"] == "approved"]
    except Exception:
        return docs
    for f in approved:
        if not os.path.isfile(f["path"]):
            continue
        result = extract_path(f["path"])
        if result.text.strip():
            docs.append(Document(page_content=result.text, metadata={
                "source": str(f["path"]).replace("\\", "/"),
                "kb_id": str(f["kb_id"])}))
    return docs


def list_kbs_safe() -> list:
    try:
        from app.workspace import list_kbs
        return list_kbs()
    except Exception:
        return []


def split_documents(documents: list) -> list:
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=settings.chunk_size,
        chunk_overlap=settings.chunk_overlap,
        separators=_SPLITTER_SEPARATORS,
    )
    return [c for c in splitter.split_documents(documents) if c.page_content.strip()]


# ---------------------------------------------------------------------------
# 并发 embedding：把"串行 10 条一批"换成"N 批并行 + 退避重试"
# ---------------------------------------------------------------------------
def embed_texts(texts: list[str]) -> list[list[float]]:
    emb = embeddings()
    batch = max(1, settings.embed_batch_size)
    batches = [texts[i:i + batch] for i in range(0, len(texts), batch)]
    if not batches:
        return []
    workers = max(1, min(settings.embed_concurrency, len(batches)))
    out: list[list[float] | None] = [None] * len(batches)

    def run(index: int, chunk: list[str]) -> None:
        last: Exception | None = None
        for attempt in range(4):
            try:
                out[index] = emb.embed_documents(chunk)
                return
            except Exception as exc:      # 429/超时/网络抖动一律退避重试
                last = exc
                time.sleep(1.2 * (2 ** attempt))
        raise RuntimeError(f"embedding 失败（{len(chunk)} 条）：{type(last).__name__}: {last}")

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(lambda pair: run(*pair), enumerate(batches)))
    return [vec for group in out for vec in (group or [])]


def _chunk_id(chunk, ordinal: int) -> str:
    src = str((chunk.metadata or {}).get("source", ""))
    raw = f"{src}|{ordinal}|{chunk.page_content[:80]}"
    return hashlib.md5(raw.encode("utf-8", errors="ignore")).hexdigest()


def add_chunks(db: Chroma, chunks: list, progress=None) -> int:
    """切块写入向量库：分窗口算向量（控内存），每窗口一次 add。"""
    if not chunks:
        return 0
    window = max(1, settings.embed_concurrency * settings.embed_batch_size * 5)
    total = 0
    for start in range(0, len(chunks), window):
        part = chunks[start:start + window]
        texts = [c.page_content for c in part]
        vectors = embed_texts(texts)
        db._collection.add(
            ids=[_chunk_id(c, start + i) for i, c in enumerate(part)],
            documents=texts,
            metadatas=[c.metadata or {} for c in part],
            embeddings=vectors,
        )
        total += len(part)
        if progress:
            progress(total, len(chunks))
    return total


def build_vectorstore(persist_dir: str | os.PathLike, chunks: list, progress=None) -> Chroma:
    db = Chroma(
        collection_name="langchain",
        embedding_function=embeddings(),
        persist_directory=str(persist_dir),
    )
    add_chunks(db, chunks, progress=progress)
    return db


DEFAULT_KB = "default"  # 内置语料所属知识库的向量库标记


def _ensure_kb_metadata(db: Chroma) -> None:
    """一次性迁移：给所有缺 kb_id 的 chunk 补 default 标记（权限过滤检索的前提）。"""
    try:
        sample = db._collection.get(limit=1, include=["metadatas"])
        metas = sample.get("metadatas") or []
        if metas and all(isinstance(m, dict) and "kb_id" in m for m in metas):
            return
        all_ids = db._collection.get(include=[])["ids"]
        if all_ids:
            metas = [{"kb_id": DEFAULT_KB} for _ in all_ids]
            db._collection.update(ids=all_ids, metadatas=metas)
            print(f"[kb] migrated {len(all_ids)} chunks with kb_id={DEFAULT_KB}")
    except Exception as exc:
        print(f"[kb] kb_id migration skipped: {exc}")


_db: Chroma | None = None


def get_db() -> Chroma | None:
    return _db


def load_or_build_retriever():
    """有库加载，无库或 REBUILD=True 时重建。返回带权限过滤能力的 Chroma 实例。"""
    global _db
    persist = str(settings.persist_dir)
    db_exists = os.path.isdir(persist) and any(os.scandir(persist))

    if db_exists and settings.rebuild_vectorstore:
        shutil.rmtree(persist, ignore_errors=True)
        db_exists = False

    if db_exists:
        print(f"[kb] loading existing vectorstore: {persist}")
        db = Chroma(persist_directory=persist, embedding_function=embeddings())
    else:
        print(f"[kb] building vectorstore from {settings.data_dir} ...")
        docs = load_documents() + _load_workspace_docs()
        chunks = split_documents(docs)
        for c in chunks:
            c.metadata.setdefault("kb_id", DEFAULT_KB)
        print(f"[kb] {len(docs)} documents -> {len(chunks)} chunks")
        db = build_vectorstore(persist, chunks)
        print(f"[kb] persisted at {persist}")

    _ensure_kb_metadata(db)
    _db = db
    print(f"[kb] chunks in store: {db._collection.count()}")
    return db


# ---------------------------------------------------------------------------
# 文件级增量索引：批准上传 → 入库；删除/拒绝 → 移出（无需全量重建）
# ---------------------------------------------------------------------------
def _extract_text(path: str) -> str:
    """兼容旧调用：只取文本，失败抛 ValueError（附原因）。"""
    result = extract_path(path)
    if not result.text.strip():
        raise ValueError(result.note or "未能从文件中提取到文字")
    return result.text


def add_file_to_index(path: str, kb_id: int) -> int:
    """把单个已批准文件切块入库（kb_id 元数据用于权限过滤）。

    抽不出文字时抛 ValueError 并说明原因——扫描件不能"批准了但 0 chunk"。
    """
    result = extract_path(path)
    text = result.text.strip()
    if not text:
        raise ValueError(result.note or "未能从文件中提取到文字（疑似扫描件或空文件）")
    doc = Document(page_content=text, metadata={
        "source": str(path).replace("\\", "/"), "kb_id": str(kb_id),
        "format": os.path.splitext(str(path))[1].lstrip(".").lower(),
    })
    db = _db or get_db()
    chunks = [c for c in split_documents([doc]) if c.page_content.strip()]
    if not chunks:
        return 0
    added = add_chunks(db, chunks)
    _notify_index_changed()
    return added


def remove_file_from_index(path: str) -> int:
    """按 source 路径移出该文件全部 chunk。"""
    db = _db or get_db()
    norm = str(path).replace("\\", "/")
    found = db._collection.get(where={"source": norm}, include=[])
    ids = found.get("ids") or []
    if ids:
        db._collection.delete(ids=ids)
        _notify_index_changed()
    return len(ids)


def _notify_index_changed() -> None:
    """通知关键词检索层索引已变（触发后台增量重建，不阻塞当前请求）。"""
    try:
        from app.retrieval import notify_changed
        notify_changed()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 索引状态（进程内 + 持久文件：进程自愈重启后可恢复）
# ---------------------------------------------------------------------------
_state = {
    "building": False, "chunks": None, "built_at": None, "error": None,
    "progress": None, "skipped": [], "by_format": {},
}
_lock = threading.Lock()
_state_file = settings.upload_dir / ".index_state.json"


def _load_state():
    try:
        with open(_state_file, encoding="utf-8") as f:
            _state.update(json.load(f))
    except Exception:
        pass


def _save_state(d: dict):
    try:
        settings.upload_dir.mkdir(parents=True, exist_ok=True)
        with open(_state_file, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False)
    except Exception:
        pass


_load_state()


def index_status() -> dict:
    out = dict(_state)
    try:
        from app.retrieval import keyword_status
        out["keyword_index"] = keyword_status()
    except Exception:
        out["keyword_index"] = {"mode": "unknown"}
    return out


def _set_progress(**kw):
    with _lock:
        _state["progress"] = {**(_state.get("progress") or {}), **kw}


def _do_rebuild():
    """旁路重建：全程不触碰旧库，问答服务不中断；成功后进程自愈。"""
    t0 = time.perf_counter()
    try:
        persist = str(settings.persist_dir)
        tmp = persist.rstrip("/\\") + "_rebuild"
        old = persist.rstrip("/\\") + "_old"

        _set_progress(phase="extract", docs=0, total=0, chunks=0, started_at=time.strftime("%H:%M:%S"))
        docs = load_documents() + _load_workspace_docs()
        _set_progress(phase="split", docs=len(docs), total=len(docs))
        chunks = split_documents(docs)
        for c in chunks:
            c.metadata.setdefault("kb_id", DEFAULT_KB)
        print(f"[kb] {len(docs)} docs -> {len(chunks)} chunks")
        _set_progress(phase="embed", chunks=0, total_chunks=len(chunks))

        def on_progress(done: int, total: int):
            _set_progress(chunks=done, pct=round(done * 100 / max(1, total)))

        shutil.rmtree(tmp, ignore_errors=True)
        db = build_vectorstore(tmp, chunks, progress=on_progress)
        count = db._collection.count()
        if not count:
            raise RuntimeError("重建后向量为空，放弃切换")

        _set_progress(phase="swap", pct=100)
        if os.path.isdir(old):
            shutil.rmtree(old, ignore_errors=True)
        os.rename(persist, old)
        os.rename(tmp, persist)
        shutil.rmtree(old, ignore_errors=True)

        final = {
            "building": False,
            "chunks": count,
            "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "error": None,
            "skipped": _scan_report.get("skipped") or [],
            "by_format": _scan_report.get("by_format") or {},
            "progress": {**( _state.get("progress") or {}), "phase": "done",
                         "elapsed": round(time.perf_counter() - t0, 1)},
        }
        _save_state(final)
        _state.update(final)
        print(f"[kb] rebuilt to side dir: {count} chunks in "
              f"{time.perf_counter() - t0:.1f}s, restarting process ...")
        os._exit(0)  # 容器 restart 策略拉起新进程加载新库
    except Exception as exc:
        err = {"building": False, "chunks": None, "built_at": None,
               "error": f"{type(exc).__name__}: {exc}",
               "progress": {**(_state.get("progress") or {}), "phase": "failed"}}
        _save_state({**_state, **err})
        _state.update(err)
        print(f"[kb] rebuild FAILED: {exc}")


def start_rebuild() -> dict:
    with _lock:
        if _state["building"]:
            return {"started": False, "reason": "重建已在进行中",
                    "progress": _state.get("progress")}
        _state["building"] = True
        _state["error"] = None
        _state["progress"] = {"phase": "queued", "pct": 0}
    threading.Thread(target=_do_rebuild, daemon=True).start()
    return {"started": True}
