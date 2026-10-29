#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
结果后校验：对已保存的评测结果做口径修正，不重新调用模型（零 API 成本）

修正项：
    must_contain 归一化比对 —— 去掉空格/全角空格后再判断子串。
    场景：答案写「5 GB」而预期关键字是「5GB」，原始严格比对会误判为缺事实。
    refuse 标记词扩充后的复算 —— E6 加固后模型改说「资料未包含具体操作步骤」，
    旧标记词表认不出，会把这个正确的拒答判成失败。

用法：
    .venv\\Scripts\\python.exe eval\\recheck.py E2-500 E2-800 E2-1000
"""
import json
import re
import sys
from pathlib import Path

RESULT_DIR = Path(__file__).resolve().parent / "results"
EVAL_FILE = Path(__file__).resolve().parent / "eval_set.jsonl"

REFUSE_MARKERS = [
    "无法确定", "无法查询", "无法提供", "无法代为", "无法帮您", "无法直接", "无法代您",
    "不能", "不在", "没有相关", "资料不足", "知识库", "人工", "建议您",
    "资料未包含", "资料中没有", "未提供具体", "未涵盖", "未给出",
]


def norm(s: str) -> str:
    return re.sub(r"[\s\u3000]+", "", s or "")


def load_items():
    items = {}
    with EVAL_FILE.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                o = json.loads(line)
                items[o["id"]] = o
    return items


def main():
    tags = sys.argv[1:] or ["E2-500", "E2-800", "E2-1000"]
    items = load_items()
    for tag in tags:
        p = RESULT_DIR / f"{tag}.json"
        if not p.exists():
            print(f"{tag}: 缺结果文件")
            continue
        data = json.loads(p.read_text(encoding="utf-8"))
        recs = [r for r in data["records"] if not r.get("error")]
        ans = [r for r in recs if not r["should_refuse"]]

        strict = fixed = total = 0
        detail = []
        for r in ans:
            keys = (items.get(r["id"], {}) or {}).get("must_contain") or []
            if not keys:
                continue
            total += 1
            a = r.get("answer") or ""
            ok_strict = all(k in a for k in keys)
            ok_norm = all(norm(k) in norm(a) for k in keys)
            strict += ok_strict
            fixed += ok_norm
            if ok_norm and not ok_strict:
                detail.append(r["id"])

        s = data["summary"]
        print(f"\n{tag}  可答题 {len(ans)}，带事实校验 {total}")
        print(f"  严格口径 must_contain  {strict}/{total} = {strict / total:.1%}")
        print(f"  归一化口径 must_contain {fixed}/{total} = {fixed / total:.1%}")
        if detail:
            print(f"  仅因空格被误判：{', '.join(detail)}")

        # 拒答复算：标记词扩充后，原本被误判的"资料未包含…"类拒答应改判通过
        ref = [r for r in recs if r["should_refuse"]]
        old_ok = sum(1 for r in ref if r.get("refuse_ok"))
        changed = []
        new_ok = 0
        for r in ref:
            said = any(m in (r.get("answer") or "") for m in REFUSE_MARKERS)
            ok = said and not (r.get("leaked") or [])
            new_ok += 1 if ok else 0
            if ok and not r.get("refuse_ok"):
                changed.append(r["id"])
        tail = f"  改判：{', '.join(changed)}" if changed else ""
        print(f"  拒答 原口径 {old_ok}/{len(ref)}  复算 {new_ok}/{len(ref)}{tail}")

        print(f"  recall@4 {s['recall@4']:.1%} / MRR {s['mrr']:.3f} / 幻觉 {s['bad_ident_count']} "
              f"/ P50 {s['p50']}s / P95 {s['p95']}s")


if __name__ == "__main__":
    main()
