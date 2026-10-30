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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from grading import grade_refusal  # noqa: E402


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
        if total:
            print(f"  严格口径 must_contain  {strict}/{total} = {strict / total:.1%}")
            print(f"  归一化口径 must_contain {fixed}/{total} = {fixed / total:.1%}")
        if detail:
            print(f"  仅因空格被误判：{', '.join(detail)}")

        # 拒答复算：三段式口径（pass / partial / fail），见 eval/grading.py
        ref = [r for r in recs if r["should_refuse"]]
        old_ok = sum(1 for r in ref if r.get("refuse_ok"))
        grades = {}
        for r in ref:
            item = items.get(r["id"], r)
            grades[r["id"]] = grade_refusal(r.get("answer") or "", item)
        cnt = {g: sum(1 for v in grades.values() if v == g) for g in ("pass", "partial", "fail")}
        bad = [i for i, g in grades.items() if g != "pass"]
        print(f"  拒答 旧口径 {old_ok}/{len(ref)}  新口径 pass {cnt['pass']} / partial {cnt['partial']}"
              f" / fail {cnt['fail']}" + (f"   未通过：{', '.join(bad)}" if bad else ""))

        print(f"  recall@4 {s['recall@4']:.1%} / MRR {s['mrr']:.3f} / 幻觉 {s['bad_ident_count']} "
              f"/ P50 {s['p50']}s / P95 {s['p95']}s")


if __name__ == "__main__":
    main()
