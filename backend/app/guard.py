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

# 模型可能把提示词里的占位符原样抄出来（「参考：<文档名>」），
# 这类不是伪造引用，而是没填文档名 —— 静默丢弃该行，不能因此把正确答案降级成拒答。
_PLACEHOLDER_NAMES = {
    "文档名", "文档名称", "文件名", "名称", "资料名", "来源", "文档", "资料",
    "xxx", "xxxx", "x", "sourcename", "filename", "docname", "未知",
}


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


def loose_name(name: str) -> str:
    """宽松形式：去前缀序号、去标点空格、小写。

    必要性：模型常把文档**标题**当文档名引用（如「云服务器出网超时：内网 DNS 失效排查」），
    而白名单里是**文件名**（「03-云服务器出网超时内网DNS失效」）。严格比对会把正确答案判成伪造引用。
    """
    s = normalize_doc_name(name).lower()
    s = re.sub(r"^[\d_\-—\s]+", "", s)
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "", s)
    return s


def _match(cited: str, stems: set[str]) -> bool:
    if not cited:
        return False
    if any(cited in s or s in cited for s in stems):
        return True
    lc = loose_name(cited)
    if len(lc) < 4:
        return False
    for s in stems:
        ls = loose_name(s)
        if len(ls) < 4:
            continue
        if lc in ls or ls in lc:
            return True
    return False


# 引用行可能列多个文档：参考：文档A、文档B（也可能用逗号/分号/斜杠分隔）
_CITE_SPLIT = re.compile(r"[、,，;；/|]+|和|及")


def verify_citations(generation: str, documents) -> str:
    """G2 引用白名单校验。

    - 全部引用无法命中 → 判定伪造引用，整体降级为拒答话术
    - 部分命中 → 保留命中的引用行，删掉编造的
    - 没有引用行 → 原样返回（由 prompt 约束，不做惩罚）
    - 只有占位符（「参考：<文档名>」）→ 裁掉引用行、保留答案，不降级
    """
    stems = doc_stems(documents)
    hits = list(_CITE_RE.finditer(generation or ""))
    if not hits or not stems:
        return generation

    kept: list[str] = []
    dropped = 0
    holder = 0
    for m in hits:
        names = [n for n in _CITE_SPLIT.split(m.group(1)) if n.strip()]
        matched = False
        has_placeholder = False
        for raw in names:
            cited = normalize_doc_name(raw)
            if not cited:
                continue
            if cited.lower() in _PLACEHOLDER_NAMES:
                has_placeholder = True
                continue
            if _match(cited, stems):
                matched = True
        if matched:
            kept.append(m.group(0).strip())
        elif has_placeholder:
            holder += 1          # 占位符没填：不算伪造，只是没写名字
        elif names:
            dropped += 1

    # 只有占位符、没有任何真实引用 → 保留答案正文，只是没有引用行
    if not kept and holder and not dropped:
        return generation[: hits[0].start()].rstrip()

    if not kept:
        return REFUSAL_REPLY
    if dropped:
        head = generation[: hits[0].start()].rstrip()
        return head + "\n\n" + "\n".join(kept)
    return generation
