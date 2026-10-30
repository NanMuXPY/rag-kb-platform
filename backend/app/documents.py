# ---------------------------------------------------------------------------
# 文档管理：上传（md/txt/pdf/docx → 归一化 md）→ 列表 → 删除
# v2：uploads 目录即建库数据源之一（knowledge.load_documents 会一并加载），
#     无需副本；上传目录挂持久卷即可在容器重建后保全自传文档
# v2.3：解析统一走 app.extract（与建库/审批同一条通路，避免三套逻辑三种坑）
# ---------------------------------------------------------------------------
from __future__ import annotations

import os
import re
import time

from app.config import settings
from app.extract import SUPPORTED_EXTS, extract_bytes
from app.knowledge import index_status

MAX_UPLOAD_MB = 5
ALLOWED_EXTS = {e.lstrip(".") for e in SUPPORTED_EXTS}


def sanitize_name(filename: str) -> str:
    name = os.path.basename(filename or "").strip()
    name = re.sub(r'[\\/:*?"<>|\s]+', "_", name)
    if not name or name.startswith("."):
        raise ValueError("文件名不合法")
    if len(name) > 80:
        stem, dot, ext = name.rpartition(".")
        name = stem[:70] + dot + ext if dot else name[:80]
    return name


def save_upload(filename: str, data: bytes) -> dict:
    name = sanitize_name(filename)
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in ALLOWED_EXTS:
        raise ValueError(f"仅支持 {'、'.join(sorted(ALLOWED_EXTS))} 格式，收到 .{ext or '(无扩展名)'}")
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise ValueError(f"文件超过 {MAX_UPLOAD_MB}MB 上限")

    result = extract_bytes(data, name)
    text = (result.text or "").strip()
    if len(text) < 20:
        hint = result.note or "正文过短"
        raise ValueError(f"解析后正文为空或过短：{hint}")

    md_name = name.rsplit(".", 1)[0] + ".md"
    content = (
        f"# {name}\n\n> 上传于 {time.strftime('%Y-%m-%d %H:%M')}，来源：{name}"
        f"（{ext}，{result.chars} 字）\n\n{text}\n"
    )

    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    (settings.upload_dir / md_name).write_text(content, encoding="utf-8")

    return {"name": md_name, "original": name, "chars": len(text),
            "saved_to": ["uploads"], "extract": result.as_dict()}


def delete_upload(md_name: str) -> bool:
    """删除自传文档（仅限 uploads 范围，防路径穿越）。"""
    if "/" in md_name or "\\" in md_name or ".." in md_name:
        raise ValueError("文件名不合法")
    if not md_name.endswith(".md"):
        md_name += ".md"
    p = settings.upload_dir / md_name
    if p.is_file():
        p.unlink()
        return True
    return False


def list_documents() -> dict:
    builtin: list[dict] = []
    exts = SUPPORTED_EXTS
    for sub in sorted(os.listdir(settings.data_dir)) if settings.data_dir.is_dir() else []:
        sub_path = settings.data_dir / sub
        if sub == "user_uploads" or not sub_path.is_dir():
            continue
        files = [f for f in sorted(os.listdir(sub_path))
                 if os.path.splitext(f)[1].lower() in exts and not f.startswith(".")]
        if files:
            builtin.append({"group": sub, "files": files, "count": len(files)})

    uploaded: list[dict] = []
    if settings.upload_dir.is_dir():
        for f in sorted(os.listdir(settings.upload_dir)):
            p = settings.upload_dir / f
            if os.path.splitext(f)[1].lower() in exts and p.is_file():
                uploaded.append({
                    "name": f,
                    "size_kb": round(p.stat().st_size / 1024, 1),
                    "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(p.stat().st_mtime)),
                })
    return {"builtin": builtin, "uploaded": uploaded, "state": index_status()}
