# ---------------------------------------------------------------------------
# 知识库：加载 → 切块 → Chroma 向量库 → retriever；旁路重建（原子切换 + 进程自愈）
# v2 保留旧版验证过的核心机制：
#   - chromadb PersistentClient 按路径单例，原地重建会撞 sqlite readonly
#     → 旁路目录建新库 → 原子改名 → os._exit 让容器 restart 拉起加载新库
#   - 切块 800/120，中文友好分隔符
# ---------------------------------------------------------------------------
from __future__ import annotations

import json
import os
import shutil
import threading
import time

from langchain_community.document_loaders import DirectoryLoader, TextLoader
from langchain_community.vectorstores import Chroma
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import settings
from app.llm import embeddings

_SPLITTER_SEPARATORS = ["\n\n", "\n", "。", "！", "？", "；", "，", " ", ""]


def load_documents() -> list:
    """加载内置语料（data/ 下 md 文件）。

    v2.2：自传文件不再由目录扫描兜底——改走工作区 DB 的 approved 清单
    （见 _load_workspace_docs），避免「待审批文件被重建误索引」。
    """
    documents: list = []
    if settings.data_dir.is_dir():
        loaded = DirectoryLoader(
            str(settings.data_dir),
            glob="**/*.md",  # pathlib 语义：** 递归匹配子目录（语料按产品分目录存放）
            loader_cls=TextLoader,
            loader_kwargs={"encoding": "utf-8", "autodetect_encoding": True},
            show_progress=False,
        ).load()
        documents.extend(d for d in loaded if d.page_content.strip())
    if not documents:
        raise RuntimeError(f"未在 {settings.data_dir} 下找到 .md 文档")
    return documents


def _load_workspace_docs() -> list:
    """已批准的自传文件 → Document（kb_id 按库标记），供增量/重建共用。"""
    from langchain_core.documents import Document
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
        try:
            text = _extract_text(f["path"]).strip()
        except Exception:
            continue
        if text:
            docs.append(Document(page_content=text, metadata={
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


def build_vectorstore(persist_dir: str | os.PathLike, chunks: list) -> Chroma:
    return Chroma.from_documents(
        documents=chunks,
        embedding=embeddings(),
        persist_directory=str(persist_dir),
    )


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
    ext = os.path.splitext(path)[1].lower()
    if ext in {".md", ".txt"}:
        return open(path, encoding="utf-8", errors="ignore").read()
    if ext == ".pdf":
        from pypdf import PdfReader
        return "\n\n".join((p.extract_text() or "") for p in PdfReader(path).pages)
    if ext == ".docx":
        import docx
        return "\n\n".join(p.text for p in docx.Document(path).paragraphs)
    raise ValueError(f"不支持的索引类型: {ext}")


def add_file_to_index(path: str, kb_id: int) -> int:
    """把单个已批准文件切块入库（kb_id 元数据用于权限过滤）。"""
    text = _extract_text(path).strip()
    if not text:
        return 0
    from langchain_core.documents import Document
    doc = Document(page_content=text, metadata={
        "source": str(path).replace("\\", "/"), "kb_id": str(kb_id)})
    db = _db or get_db()
    chunks = [c for c in split_documents([doc]) if c.page_content.strip()]
    if chunks:
        db.add_documents(chunks)
    return len(chunks)


def remove_file_from_index(path: str) -> int:
    """按 source 路径移出该文件全部 chunk。"""
    db = _db or get_db()
    norm = str(path).replace("\\", "/")
    found = db._collection.get(where={"source": norm}, include=[])
    ids = found.get("ids") or []
    if ids:
        db._collection.delete(ids=ids)
    return len(ids)


# ---------------------------------------------------------------------------
# 索引状态（进程内 + 持久文件：进程自愈重启后可恢复）
# ---------------------------------------------------------------------------
_state = {"building": False, "chunks": None, "built_at": None, "error": None}
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
    return dict(_state)


def _do_rebuild():
    """旁路重建：全程不触碰旧库，问答服务不中断；成功后进程自愈。"""
    try:
        persist = str(settings.persist_dir)
        tmp = persist.rstrip("/\\") + "_rebuild"
        old = persist.rstrip("/\\") + "_old"

        docs = load_documents() + _load_workspace_docs()
        chunks = split_documents(docs)

        shutil.rmtree(tmp, ignore_errors=True)
        db = Chroma(persist_directory=tmp, embedding_function=embeddings())
        db.add_documents(chunks)
        count = db._collection.count()
        if not count:
            raise RuntimeError("重建后向量为空，放弃切换")

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
        }
        _save_state(final)
        _state.update(final)
        print(f"[kb] rebuilt to side dir: {count} chunks, restarting process ...")
        os._exit(0)  # 容器 restart 策略拉起新进程加载新库
    except Exception as exc:
        err = {"building": False, "chunks": None, "built_at": None,
               "error": f"{type(exc).__name__}: {exc}"}
        _save_state(err)
        _state.update(err)
        print(f"[kb] rebuild FAILED: {exc}")


def start_rebuild() -> dict:
    with _lock:
        if _state["building"]:
            return {"started": False, "reason": "重建已在进行中"}
        _state["building"] = True
        _state["error"] = None
    threading.Thread(target=_do_rebuild, daemon=True).start()
    return {"started": True}
