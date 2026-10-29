#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
两轮实验结果对比。

用法：
    .venv\\Scripts\\python.exe eval\\compare.py E0 E1

输出：指标并排对比 + 状态翻转的题（从错到对 / 从对到错）。
"""
import json
import sys
from pathlib import Path

RESULT_DIR = Path(__file__).resolve().parent / "results"


def load(tag):
    p = RESULT_DIR / f"{tag}.json"
    if not p.exists():
        raise SystemExit(f"找不到 {p}，先跑 eval/run_eval.py --tag {tag}")
    return json.loads(p.read_text(encoding="utf-8"))


def verdict(r):
    """单题是否通过：可答题看命中且事实齐全，应拒答题看是否正确拒答。"""
    if r.get("error"):
        return False
    if r["should_refuse"]:
        return bool(r.get("refuse_ok"))
    return bool(r.get("hit")) and (r.get("must_ok") is not False)


def main():
    if len(sys.argv) < 3:
        raise SystemExit("用法: compare.py <基线tag> <对照tag>")
    a_tag, b_tag = sys.argv[1], sys.argv[2]
    A, B = load(a_tag), load(b_tag)
    sa, sb = A["summary"], B["summary"]

    rows = [
        ("recall@4", "recall@4", "pct"),
        ("MRR", "mrr", "num"),
        ("must_contain", "must_contain_rate", "pct"),
        ("拒答准确率", "refuse_acc", "pct"),
        ("引用率", "cite_rate", "pct"),
        ("标识符幻觉数", "bad_ident_count", "int"),
        ("P50", "p50", "sec"),
        ("P95", "p95", "sec"),
        ("失败题", "failed", "int"),
    ]

    def fmt(v, kind):
        if v is None:
            return "—"
        if kind == "pct":
            return f"{v * 100:.1f}%"
        if kind == "sec":
            return f"{v:.1f}s"
        if kind == "num":
            return f"{v:.3f}"
        return str(v)

    print(f"\n{a_tag}  →  {b_tag}")
    print("-" * 52)
    print(f"{'指标':<16}{a_tag:>12}{b_tag:>14}{'变化':>12}")
    print("-" * 52)
    for label, key, kind in rows:
        va, vb = sa.get(key), sb.get(key)
        line = f"{label:<16}{fmt(va, kind):>12}{fmt(vb, kind):>14}"
        if isinstance(va, (int, float)) and isinstance(vb, (int, float)) and kind != "int":
            d = vb - va
            if kind == "pct":
                line += f"{d * 100:>+11.1f}pt"
            elif kind == "sec":
                line += f"{d:>+11.1f}s"
            else:
                line += f"{d:>+11.3f}"
        elif kind == "int" and isinstance(va, int) and isinstance(vb, int):
            line += f"{vb - va:>+11d}"
        print(line)
    print("-" * 52)

    # 状态翻转
    ra = {r["id"]: r for r in A["records"]}
    rb = {r["id"]: r for r in B["records"]}
    flip_up = [i for i in ra if i in rb and not verdict(ra[i]) and verdict(rb[i])]
    flip_dn = [i for i in ra if i in rb and verdict(ra[i]) and not verdict(rb[i])]

    if flip_up:
        print(f"\n由错转对（{len(flip_up)}）：")
        for i in flip_up:
            print(f"  {i} [{rb[i]['type']}] {rb[i]['question'][:34]}")
    if flip_dn:
        print(f"\n由对转错（{len(flip_dn)}）—— 必须逐条看，可能是闸门误伤：")
        for i in flip_dn:
            print(f"  {i} [{rb[i]['type']}] {rb[i]['question'][:34]}")
    if not flip_up and not flip_dn:
        print("\n无状态翻转。")
    print()


if __name__ == "__main__":
    main()
