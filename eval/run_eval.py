#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
评测跑分脚本（v2 移植版，E0 基线 / E1-E5 对照实验共用）

用法：
    .venv\\Scripts\\python.exe eval\\run_eval.py --tag E2-800
    .venv\\Scripts\\python.exe eval\\run_eval.py --tag E2-500 --persist db_e2_500
    .venv\\Scripts\\python.exe eval\\run_eval.py --tag smoke --limit 5

v2 与 v1 的差异：
    - 入口改为 app.engine.get_engine().ask()（v1 是 modules.rag_app.ask）
    - 语料目录改为 data/（v2 语料按产品分子目录，不再有 data/md）
    - 新增 --persist：指定实验用向量库目录（.env 的 override=True 会压掉
      PERSISTANT_STORAGE_DIR 环境变量，故此处直接改 settings）

指标：
    recall@4        可答题中，正确文档出现在 sources 的比例
    MRR             正确文档排名倒数的均值
    must_contain    答案必须包含的关键事实命中率
    refuse_acc      应拒答题中，正确表达"无法确定/转人工"且未泄露禁止内容的比例
    cite_rate       可答题中，返回了 sources 的比例
    id_halluc       答案里的标识符/状态码在全库找不到的比例（代理校验，非严格 context 校验）
    P50/P95         端到端延迟
"""
import argparse
import json
import re
import statistics
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

EVAL_FILE = ROOT / "eval" / "eval_set.jsonl"
RESULT_DIR = ROOT / "eval" / "results"

# 表达"答不出/转人工"的标记词
REFUSE_MARKERS = [
    "无法确定", "无法查询", "无法提供", "无法代为", "无法帮您", "无法直接", "无法代您",
    "不能", "不在", "没有相关", "资料不足", "知识库", "人工", "建议您",
    # E6 补：模型按"操作步骤硬约束"回复时用的是这几种表述，旧标记词认不出来
    "资料未包含", "资料中没有", "未提供具体", "未涵盖", "未给出",
]

STOPWORDS = {
    "the", "and", "for", "with", "this", "that", "http", "https", "www",
    "api", "sdk", "json", "true", "false", "null", "cos", "cvm", "ssm",
}


def load_items(path: Path):
    items = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                items.append(json.loads(line))
    return items


def build_corpus_text() -> str:
    """全库文本，用于标识符代理校验（v2：data/ 下按产品分目录，需 rglob）。"""
    buf = []
    for p in (ROOT / "data").rglob("*.md"):
        try:
            buf.append(p.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            pass
    return "\n".join(buf)


def extract_identifiers(answer: str):
    """抽取英文标识符 + HTTP 状态码，用于幻觉检测。"""
    head = re.split(r"参考\s*[:：]", answer)[0]
    idents = re.findall(r"[A-Za-z_][A-Za-z0-9_./\-]{2,}", head)
    codes = re.findall(r"(?<![\d.])[1-5]\d{2}(?![\d.])", head)
    kept = []
    for i in idents:
        if i.lower() in STOPWORDS:
            continue
        if re.search(r"\.[a-z]{2,4}$", i, re.I):
            continue
        if re.search(r"[0-9a-f]{8,}", i.lower()):
            continue
        kept.append(i)
    return kept, codes


def call_ask(engine, question, retries=3):
    """带指数退避的单次问答，返回 (result, error)。"""
    delay = 5
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            return engine.ask(question), None
        except Exception as exc:  # 429 / 超时 / 网络
            last_err = f"{type(exc).__name__}: {exc}"
            if attempt < retries:
                time.sleep(delay)
                delay *= 3
    return None, last_err


def pin_persist_dir(persist: str | None):
    """.env 用 override=True 加载，环境变量压不过它 —— 直接改 settings。"""
    if not persist:
        return
    from app import config as app_config
    p = Path(persist)
    p = p if p.is_absolute() else ROOT / persist
    object.__setattr__(app_config.settings, "persist_dir", p)
    print(f"[persist] 使用实验向量库: {p}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="E0", help="实验轮次标记，如 E0/E1")
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 条，0 为全部")
    ap.add_argument("--sleep", type=float, default=1.0, help="每题之间的间隔秒数，防限流")
    ap.add_argument("--file", default=str(EVAL_FILE))
    ap.add_argument("--persist", default="", help="实验用向量库目录（默认用 .env 的 db_md）")
    args = ap.parse_args()

    pin_persist_dir(args.persist)

    items = load_items(Path(args.file))
    if args.limit:
        items = items[: args.limit]

    print(f"[{args.tag}] 共 {len(items)} 题，开始跑分 ...", flush=True)
    corpus = build_corpus_text().lower()

    # 预热：先建图/建库，避免第一题把冷启动算进延迟
    t0 = time.time()
    from app.engine import get_engine
    engine = get_engine()
    print(f"[{args.tag}] 冷启动 {time.time() - t0:.1f}s，进入逐题评测\n", flush=True)

    records = []
    for idx, item in enumerate(items, 1):
        t = time.time()
        result, err = call_ask(engine, item["question"])
        cost = time.time() - t

        rec = {
            "id": item["id"], "type": item["type"], "question": item["question"],
            "should_refuse": item["should_refuse"], "latency": round(cost, 2),
        }

        if err:
            rec.update({"error": err, "answer": "", "sources": []})
            print(f"  {item['id']} [{item['type']}] FAILED {cost:5.1f}s  {err[:80]}", flush=True)
            records.append(rec)
            time.sleep(args.sleep)
            continue

        answer = result.get("answer") or ""
        sources = result.get("sources") or []
        src_names = [str(s.get("source", "")) if isinstance(s, dict) else str(s) for s in sources]

        # --- 检索指标 ---
        exp = item.get("expected_docs") or []
        rank = 0
        for i, name in enumerate(src_names, 1):
            if any(e in name for e in exp):
                rank = i
                break
        rec["rank"] = rank
        rec["hit"] = bool(rank)

        # --- 事实包含 ---
        must = item.get("must_contain") or []
        rec["must_hit"] = [k for k in must if k in answer]
        rec["must_ok"] = all(k in answer for k in must) if must else None

        # --- 拒答判定 ---
        leaked = [k for k in (item.get("must_not_contain") or []) if k in answer]
        rec["leaked"] = leaked
        said_refuse = any(m in answer for m in REFUSE_MARKERS)
        if item["should_refuse"]:
            rec["refuse_ok"] = said_refuse and not leaked
        else:
            rec["refuse_ok"] = None

        # --- 引用 ---
        rec["cite"] = len(src_names) > 0

        # --- 标识符幻觉（全库代理校验）---
        idents, codes = extract_identifiers(answer)
        bad_ids = [i for i in idents if i.lower() not in corpus]
        bad_codes = [c for c in codes if c not in corpus]
        rec["bad_idents"] = bad_ids
        rec["bad_codes"] = bad_codes
        rec["answer"] = answer
        rec["sources"] = src_names
        rec["steps"] = result.get("steps") or []

        flag = "OK " if (rec["hit"] or rec["refuse_ok"]) else "!! "
        extra = f"rank={rank}" if rank else ("refuse_ok" if rec["refuse_ok"] else "MISS")
        print(f"  {flag}{item['id']} [{item['type']:5s}] {cost:5.1f}s  {extra}"
              f"{'  幻觉:' + ','.join(bad_ids + bad_codes) if (bad_ids or bad_codes) else ''}",
              flush=True)
        records.append(rec)
        time.sleep(args.sleep)

    # ---------- 汇总 ----------
    answered = [r for r in records if not r.get("error")]
    answerable = [r for r in answered if not r["should_refuse"]]
    refusable = [r for r in answered if r["should_refuse"]]

    recall = sum(1 for r in answerable if r["hit"]) / len(answerable) if answerable else 0
    mrr = (sum(1 / r["rank"] for r in answerable if r["rank"]) / len(answerable)) if answerable else 0
    cite = sum(1 for r in answerable if r["cite"]) / len(answerable) if answerable else 0
    must_ok = [r for r in answerable if r["must_ok"] is not None]
    must_rate = (sum(1 for r in must_ok if r["must_ok"]) / len(must_ok)) if must_ok else 0
    refuse_acc = (sum(1 for r in refusable if r["refuse_ok"]) / len(refusable)) if refusable else None

    total_ids = sum(len(r.get("bad_idents", [])) + len(r.get("bad_codes", [])) for r in answered)
    lat = [r["latency"] for r in answered]
    p50 = statistics.median(lat) if lat else 0
    p95 = statistics.quantiles(lat, n=20)[-1] if len(lat) >= 20 else (max(lat) if lat else 0)

    summary = {
        "tag": args.tag,
        "persist": args.persist or "db_md",
        "total": len(items),
        "failed": len(records) - len(answered),
        "recall@4": round(recall, 4),
        "mrr": round(mrr, 4),
        "must_contain_rate": round(must_rate, 4),
        "refuse_acc": round(refuse_acc, 4) if refuse_acc is not None else None,
        "cite_rate": round(cite, 4),
        "bad_ident_count": total_ids,
        "p50": round(p50, 2),
        "p95": round(p95, 2),
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    out = RESULT_DIR / f"{args.tag}.json"
    out.write_text(json.dumps({"summary": summary, "records": records},
                              ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n" + "=" * 56)
    print(f"  {args.tag} 汇总   （{summary['time']}）")
    print("=" * 56)
    print(f"  题数 / 失败      {summary['total']} / {summary['failed']}")
    print(f"  recall@4         {summary['recall@4']:.1%}")
    print(f"  MRR              {summary['mrr']:.3f}")
    print(f"  must_contain     {summary['must_contain_rate']:.1%}")
    print(f"  拒答准确率       {('%.1f%%' % (summary['refuse_acc'] * 100)) if summary['refuse_acc'] is not None else '—（本次无拒答题）'}")
    print(f"  引用率           {summary['cite_rate']:.1%}")
    print(f"  标识符幻觉数     {summary['bad_ident_count']}")
    print(f"  延迟 P50 / P95   {summary['p50']}s / {summary['p95']}s")
    print("=" * 56)
    print(f"  明细已写入 {out}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n中断")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
