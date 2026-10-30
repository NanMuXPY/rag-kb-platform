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
    name = re.sub(r"^[0-9a-f]{6,}_", "", name, flags=re.I)   # 上传时加的随机前缀（780a7c84_xxx.xlsx）
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
    return _best_stem(cited, stems) is not None


def _best_stem(cited: str, stems: set[str]) -> str | None:
    """返回与引用最贴合的白名单文档名，用于把引用行改写成规范形态。"""
    if not cited:
        return None
    cands = [s for s in stems if cited in s or s in cited]
    if not cands:
        lc = loose_name(cited)
        if len(lc) < 4:
            return None
        cands = [s for s in stems if len(loose_name(s)) >= 4
                 and (lc in loose_name(s) or loose_name(s) in lc)]
    if not cands:
        return None
    return max(cands, key=len)


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
        bests: set[str] = set()
        has_placeholder = False
        for raw in names:
            cited = normalize_doc_name(raw)
            if not cited:
                continue
            if cited.lower() in _PLACEHOLDER_NAMES:
                has_placeholder = True
                continue
            stem = _best_stem(cited, stems)
            if stem:
                bests.add(stem)
        if bests:
            # 统一改写成白名单里的文档名：模型常把整条路径（/app/backend/db/kb_files/4/xxx.xlsx）
            # 或带哈希后缀的文件名抄进「参考」，对用户没有意义
            kept.append("参考：" + "、".join(sorted(bests)))
        elif has_placeholder:
            holder += 1          # 占位符没填：不算伪造，只是没写名字
        elif names:
            dropped += 1

    # 只有占位符、没有任何真实引用 → 保留答案正文，只是没有引用行
    if not kept and holder and not dropped:
        return generation[: hits[0].start()].rstrip()

    if not kept:
        return REFUSAL_REPLY

    # 无论是否删过伪造引用，都按白名单重写引用行（顺带把整条路径/哈希后缀归一化）
    head = generation[: hits[0].start()].rstrip()
    tail = generation[hits[-1].end():].strip()
    out = head + "\n\n" + "\n".join(kept)
    return out + ("\n\n" + tail if tail else "")
