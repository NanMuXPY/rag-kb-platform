#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
实验建库脚本：用指定切块参数构建一份独立向量库（E2 切块对比用）

用法：
    .venv\\Scripts\\python.exe eval\\build_index.py --chunk-size 500 --out db_e2_500
    .venv\\Scripts\\python.exe eval\\build_index.py --chunk-size 1000 --overlap 150 --out db_e2_1000

说明：
    - 语料与生产重建一致（内置 data/**/*.md + 已批准自传文件），保证可比
    - overlap 默认取 chunk_size 的 15%（800→120，与生产一致）
    - 输出目录会被先清空，避免旧数据干扰
"""
import argparse
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from langchain_community.vectorstores import Chroma  # noqa: E402
from langchain_text_splitters import RecursiveCharacterTextSplitter  # noqa: E402

from app.knowledge import (  # noqa: E402
    DEFAULT_KB,
    _load_workspace_docs,
    _SPLITTER_SEPARATORS,
    load_documents,
)
from app.llm import embeddings  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunk-size", type=int, required=True)
    ap.add_argument("--overlap", type=int, default=0, help="默认取 chunk_size 的 15%")
    ap.add_argument("--out", required=True, help="实验向量库目录（相对项目根）")
    args = ap.parse_args()

    overlap = args.overlap or int(args.chunk_size * 0.15)
    out = Path(args.out)
    out = out if out.is_absolute() else ROOT / args.out

    print(f"[build] chunk_size={args.chunk_size} overlap={overlap} -> {out}", flush=True)

    docs = load_documents() + _load_workspace_docs()
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=args.chunk_size,
        chunk_overlap=overlap,
        separators=_SPLITTER_SEPARATORS,
    )
    chunks = [c for c in splitter.split_documents(docs) if c.page_content.strip()]
    for c in chunks:
        c.metadata.setdefault("kb_id", DEFAULT_KB)
    print(f"[build] {len(docs)} documents -> {len(chunks)} chunks", flush=True)

    shutil.rmtree(out, ignore_errors=True)
    t0 = time.time()
    db = Chroma.from_documents(documents=chunks, embedding=embeddings(),
                               persist_directory=str(out))
    print(f"[build] done in {time.time() - t0:.1f}s, chunks in store: {db._collection.count()}",
          flush=True)


if __name__ == "__main__":
    main()
