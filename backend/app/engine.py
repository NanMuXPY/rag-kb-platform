# ---------------------------------------------------------------------------
# RAG 引擎：LangGraph 自适应拓扑 + 节点实现（v2 单文件内聚）
#
# 拓扑：
#   入口路由 ─┬─ casual_convo → chitchat → END          （闲聊，无需证据）
#            └─ vectorstore → rewrite → retrieve → grade ─┬─ 不相关 → rewrite（环）
#                                                        └─ generate → 质检 ─┬─ not supported → generate（环）
#                                                                            ├─ not useful → rewrite（环）
#                                                                            └─ useful → END
#
# v2 相对旧版的实质改进：
#   1. 重试计数放进 GraphState（旧版用类属性，并发请求会串计数）
#   2. 闲聊独立节点：旧版 E1 双闸会误拒「你好」（闲聊路径无检索文档触发硬拒）
#   3. 每节点记录耗时到 trace，汇报演示可直接展示链路
#   4. 多轮历史用结构化消息而非拼接字符串
# ---------------------------------------------------------------------------
from __future__ import annotations

import time
from typing import TypedDict

from langchain_core.prompts import ChatPromptTemplate
from langgraph.graph import END, StateGraph

from app.chains import (
    REFUSAL_REPLY,
    build_answer_grader,
    build_doc_grader,
    build_generator,
    build_hallucination_grader,
    build_question_rewriter,
    build_router,
)
from app.config import settings
from app.guard import verify_citations
from app.knowledge import load_or_build_retriever
from app.llm import chat_llm


class GraphState(TypedDict):
    question: str
    generation: str
    documents: list
    chat_history: list[dict]   # [{"role": "user"|"assistant", "content": str}]
    retries: dict              # {"regeneration": int, "re_retrieval": int}
    trace: list[dict]          # [{"node": str, "ms": int, "note": str}]
    route: str                 # "vectorstore" | "casual_convo"
    kb_ids: list               # 允许检索的知识库 id（字符串，权限过滤）


def _trace(state: dict, node: str, t0: float, note: str = "") -> dict:
    entry = {"node": node, "ms": int((time.perf_counter() - t0) * 1000)}
    if note:
        entry["note"] = note
    return {"trace": state.get("trace", []) + [entry]}


def _history_text(chat_history: list[dict], max_turns: int = 6) -> str:
    """取最近若干轮，拼成生成/改写时可读的历史文本。"""
    recent = [m for m in (chat_history or []) if m.get("role") in {"user", "assistant"}]
    recent = recent[-(max_turns * 2):]
    if not recent:
        return "（无）"
    role_map = {"user": "用户", "assistant": "客服"}
    return "\n".join(f"{role_map[m['role']]}：{m['content']}" for m in recent)


class RAGEngine:
    """进程内单例：编译一次图，全部请求复用。"""

    def __init__(self):
        settings.validate()
        self.db = load_or_build_retriever()  # v2.2: Chroma 实例（检索时按 kb_id 过滤）
        self.router = build_router()
        self.doc_grader = build_doc_grader()
        self.generator = build_generator()
        self.hallucination_grader = build_hallucination_grader()
        self.answer_grader = build_answer_grader()
        self.rewriter = build_question_rewriter()
        self._chitchat_chain = self._build_chitchat()
        self.graph = self._build_graph()

    # ----- 闲聊链：仅应对寒暄与题外话，明确不承诺知识能力 -----
    @staticmethod
    def _build_chitchat():
        system = """你是腾讯云产品技术支持知识库的客服助手。当前用户输入被识别为寒暄或与
知识库无关的闲聊。请简短友好地回应（1-3 句），并在结尾自然地引导用户提出关于企业微信、
腾讯会议、腾讯云服务器、腾讯云对象存储或微信小程序的技术问题。
不要编造任何产品功能、价格或操作步骤；若用户看似在问技术问题，请提示其补充具体产品与场景。"""
        prompt = ChatPromptTemplate.from_messages([("system", system), ("human", "{question}")])
        return prompt | chat_llm()

    # ----- 图 -----
    def _build_graph(self):
        g = StateGraph(GraphState)
        g.add_node("start", self._node_start)
        g.add_node("rewrite", self._node_rewrite)
        g.add_node("retrieve", self._node_retrieve)
        g.add_node("grade_documents", self._node_grade_documents)
        g.add_node("generate", self._node_generate)
        g.add_node("chitchat", self._node_chitchat)

        g.set_entry_point("start")
        g.add_conditional_edges(
            "start",
            lambda state: state["route"],
            {"vectorstore": "rewrite", "casual_convo": "chitchat"},
        )
        g.add_edge("chitchat", END)
        g.add_edge("rewrite", "retrieve")
        g.add_edge("retrieve", "grade_documents")
        g.add_conditional_edges(
            "grade_documents",
            self._decide_to_generate,
            {"rewrite": "rewrite", "generate": "generate"},
        )
        g.add_conditional_edges(
            "generate",
            self._grade_generation,
            {
                "not supported": "generate",
                "useful": END,
                "not useful": "rewrite",
            },
        )
        return g.compile()

    # ----- 节点与条件边 -----
    def _node_start(self, state: GraphState):
        """入口节点：路由 + 用户消息入历史 + 重试计数归零。"""
        t0 = time.perf_counter()
        question = state["question"]
        decision = self.router.invoke({"question": question})
        route = decision.datasource
        chat_history = list(state.get("chat_history") or []) + [
            {"role": "user", "content": question}
        ]
        out = {
            "route": route,
            "chat_history": chat_history,
            "retries": {"regeneration": 0, "re_retrieval": 0},
        }
        out.update(_trace(state, "route", t0, route))
        return out

    def _node_rewrite(self, state: GraphState):
        t0 = time.perf_counter()
        rewritten = self.rewriter.invoke({
            "question": state["question"],
            "chat_history": _history_text(state.get("chat_history") or []),
        })
        # re_retrieval 计数放节点里（条件边不能更新状态）：每过一次 rewrite 记一次
        retries = dict(state.get("retries") or {})
        retries["re_retrieval"] = retries.get("re_retrieval", 0) + 1
        out = {"question": rewritten, "retries": retries}
        out.update(_trace(state, "rewrite", t0, str(rewritten)[:40]))
        return out

    def _node_retrieve(self, state: GraphState):
        t0 = time.perf_counter()
        kb_ids = [str(k) for k in (state.get("kb_ids") or ["default"])]
        where = {"kb_id": {"$in": kb_ids}}  # 权限边界：只检索可见知识库
        k = settings.retriever_k
        mode = settings.retriever_mode

        if mode == "hybrid":
            # 向量 + BM25 双通道，RRF 融合：救回专有名词/接口名这类精确词
            from app.retrieval import hybrid_search
            documents = hybrid_search(self.db, state["question"], k, kb_ids,
                                      fetch_k=max(settings.retriever_fetch_k, k))
        elif mode == "mmr":
            # 最大边际相关：先取 fetch_k 候选，再兼顾相关性与多样性选出 k 条
            documents = self.db.max_marginal_relevance_search(
                state["question"], k=k, fetch_k=settings.retriever_fetch_k,
                lambda_mult=settings.mmr_lambda, filter=where,
            )
        elif mode == "dedup":
            # 同文档去重：多取候选，每篇文档只留 rank 最高的 1 条，再补足 k 条
            candidates = self.db.similarity_search(
                state["question"], k=max(settings.retriever_fetch_k, k), filter=where)
            documents, seen = [], set()
            for d in candidates:
                src = str((d.metadata or {}).get("source", ""))
                if src in seen:
                    continue
                seen.add(src)
                documents.append(d)
                if len(documents) >= k:
                    break
        else:
            documents = self.db.similarity_search(state["question"], k=k, filter=where)

        out = {"documents": documents}
        out.update(_trace(state, "retrieve", t0, f"{len(documents)} docs@kb{kb_ids}/{mode}"))
        return out

    def _node_grade_documents(self, state: GraphState):
        t0 = time.perf_counter()
        filtered = []
        for d in state["documents"]:
            grade = self.doc_grader.invoke({
                "document": d.page_content, "question": state["question"],
            })
            if grade.binary_score == "yes":
                filtered.append(d)
        out = {"documents": filtered}
        out.update(_trace(state, "grade_documents", t0, f"{len(filtered)}/{len(state['documents'])} relevant"))
        return out

    def _node_generate(self, state: GraphState):
        t0 = time.perf_counter()
        documents = state.get("documents") or []

        # G1 硬闸：无证据不调模型（E0 实测零文档时 3/11 概率纯编造）
        if not documents:
            return {
                "generation": REFUSAL_REPLY,
                **_trace(state, "generate", t0, "G1 hard refusal, LLM skipped"),
            }

        context = "\n\n---\n\n".join(
            f"【资料 {i + 1}】（来源：{(d.metadata or {}).get('source', 'unknown')}）\n{d.page_content}"
            for i, d in enumerate(documents)
        )
        context += f"\n\n【对话历史】\n{_history_text(state.get('chat_history') or [])}"

        answer = self.generator.invoke({"context": context, "question": state["question"]}).content
        # G2 引用白名单
        answer = verify_citations(answer, documents)

        retries = dict(state.get("retries") or {})
        retries["regeneration"] = retries.get("regeneration", 0) + 1
        out = {"generation": answer, "retries": retries}
        out.update(_trace(state, "generate", t0, f"{len(answer)} chars"))
        return out

    def _node_chitchat(self, state: GraphState):
        t0 = time.perf_counter()
        answer = self._chitchat_chain.invoke({"question": state["question"]}).content
        out = {"generation": answer}
        out.update(_trace(state, "chitchat", t0))
        return out

    def _decide_to_generate(self, state: GraphState):
        if not state["documents"]:
            re_retrieval = (state.get("retries") or {}).get("re_retrieval", 0)
            if re_retrieval < settings.re_retrieval_threshold:
                return "rewrite"
            return "generate"  # 重试用尽，交给 G1 硬闸拒答
        return "generate"

    def _grade_generation(self, state: GraphState):
        documents = state.get("documents") or []
        generation = state.get("generation") or ""
        retries = state.get("retries") or {}

        # 拒答话术直通，避免「拒答→not useful→回炉→再拒答」空转
        if not documents and generation == REFUSAL_REPLY:
            return "useful"

        grounded = self.hallucination_grader.invoke({
            "documents": "\n\n".join(d.page_content for d in documents),
            "generation": generation,
        }).binary_score == "yes"

        if grounded or retries.get("regeneration", 0) > settings.regeneration_threshold:
            addresses = self.answer_grader.invoke({
                "question": state["question"], "generation": generation,
            }).binary_score == "yes"
            if addresses:
                return "useful"
            # 逃逸条件：任一重试额度用尽即放行，防止图空转（recursion limit 兜底）
            if retries.get("regeneration", 0) > settings.regeneration_threshold \
                    or retries.get("re_retrieval", 0) > settings.re_retrieval_threshold:
                return "useful"
            return "not useful"
        return "not supported"

    # ----- 对外入口 -----
    def ask(self, question: str, chat_history: list[dict] | None = None,
            kb_ids: list | None = None) -> dict:
        final: dict = {}
        inputs = {
            "question": question,
            "generation": "",
            "documents": [],
            "chat_history": chat_history or [],
            "retries": {"regeneration": 0, "re_retrieval": 0},
            "trace": [],
            "route": "",
            "kb_ids": kb_ids or ["default"],
        }
        for step in self.graph.stream(inputs, config={"recursion_limit": 50}):
            for _node, state in step.items():
                if isinstance(state, dict):
                    final.update(state)

        answer = (final.get("generation") or "").strip()
        documents = final.get("documents") or []
        history = final.get("chat_history") or (chat_history or [])
        if answer:
            history = history + [{"role": "assistant", "content": answer}]

        sources, seen = [], set()
        for d in documents:
            meta = getattr(d, "metadata", {}) or {}
            path = str(meta.get("source", ""))
            name = path.replace("\\", "/").rsplit("/", 1)[-1] if path else "unknown"
            if name in seen:
                continue
            seen.add(name)
            sources.append({"source": name, "path": path,
                            "kb_id": meta.get("kb_id", ""),
                            "preview": (getattr(d, "page_content", "") or "")[:120]})

        return {
            "answer": answer,
            "chat_history": history,
            "sources": sources,
            "steps": [t["node"] for t in final.get("trace", [])],
            "trace": final.get("trace", []),
            "route": final.get("route", ""),
        }


_engine: RAGEngine | None = None


def get_engine() -> RAGEngine:
    global _engine
    if _engine is None:
        _engine = RAGEngine()
    return _engine
