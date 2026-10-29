# ---------------------------------------------------------------------------
# 输出守卫（E1 双闸的可复用封装）
#   G1 闸：无证据不调模型 —— 在 graph.generate 内执行
#   G2 闸：引用白名单 —— 「参考：X」必须命中本次检索文档，防伪造引用
# E0 实测依据：零文档时模型 3/11 概率编造完整步骤与引用；引用伪造 3/11 条
# ---------------------------------------------------------------------------
from __future__ import annotations

import re

from app.chains import REFUSAL_REPLY

# 引用行形如：参考：<对象存储 简单上传_腾讯云_e0699b1374.md>
_CITE_RE = re.compile(r"参考\s*[:：]\s*[<《]?([^>\n》]+)[>》]?")


def normalize_doc_name(name: str) -> str:
    """文档名归一化：去路径、去 .md、去哈希后缀、去空白与书名号括号。"""
    name = (name or "").strip().strip("<>《》[]()（）")
    name = name.replace("\\\\", "/").replace("\\", "/").split("/")[-1]
    name = re.sub(r"\.md$", "", name, flags=re.I)
    name = re.sub(r"_[0-9a-f]{6,}$", "", name, flags=re.I)
    return re.sub(r"\s+", "", name)


def doc_stems(documents) -> set[str]:
    stems = set()
    for d in documents:
        src = (getattr(d, "metadata", {}) or {}).get("source", "")
        stem = normalize_doc_name(str(src).rsplit("/", 1)[-1].rsplit("\\", 1)[-1])
        if stem:
            stems.add(stem)
    return stems


def verify_citations(generation: str, documents) -> str:
    """G2 引用白名单校验。

    - 全部引用无法命中 → 判定伪造引用，整体降级为拒答话术
    - 部分命中 → 保留命中的引用行，删掉编造的
    - 没有引用行 → 原样返回（由 prompt 约束，不做惩罚）
    """
    stems = doc_stems(documents)
    hits = list(_CITE_RE.finditer(generation or ""))
    if not hits or not stems:
        return generation

    kept: list[str] = []
    dropped = 0
    for m in hits:
        cited = normalize_doc_name(m.group(1))
        if cited and any(cited in s or s in cited for s in stems):
            kept.append(m.group(0).strip())
        else:
            dropped += 1

    if not kept:
        return REFUSAL_REPLY
    if dropped:
        head = generation[: hits[0].start()].rstrip()
        return head + "\n\n" + "\n".join(kept)
    return generation
