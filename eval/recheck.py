#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
结果后校验：对已保存的评测结果做口径修正，不重新调用模型（零 API 成本）

修正项：
    must_contain 归一化比对 —— 去掉空格/全角空格后再判断子串。
    场景：答案写「5 GB」而预期关键字是「5GB」，原始严格比对会误判为缺事实。

用法：
    .venv\\Scripts\\python.exe eval\\recheck.py E2-500 E2-800 E2-1000
"""
import json
import re
import sys
from pathlib import Path

RESULT_DIR = Path(__file__).resolve().parent / "results"
EVAL_FILE = Path(__file__).resolve().parent / "eval_set.jsonl"


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
        print(f"  recall@4 {s['recall@4']:.1%} / MRR {s['mrr']:.3f} / 拒答 {s['refuse_acc']} "
              f"/ 幻觉 {s['bad_ident_count']} / P50 {s['p50']}s / P95 {s['p95']}s")


if __name__ == "__main__":
    main()
