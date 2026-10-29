# ---------------------------------------------------------------------------
# 模型工厂：ChatOpenAI / OpenAIEmbeddings / 结构化输出
# v2 关键经验沉淀：
#   - 百炼 embedding batch 硬上限 10（整批 400 的坑）
#   - check_embedding_ctx_length 必须关（tiktoken 会把 token id 数组发给服务端）
#   - 结构化输出方法按服务商自动选择
# ---------------------------------------------------------------------------
from __future__ import annotations

from functools import lru_cache

from langchain_core.output_parsers import StrOutputParser
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from pydantic import BaseModel

from app.config import settings


@lru_cache(maxsize=1)
def chat_llm(temperature: float = 0.0) -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.llm_model,
        temperature=temperature,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
    )


@lru_cache(maxsize=1)
def embeddings() -> OpenAIEmbeddings:
    return OpenAIEmbeddings(
        api_key=settings.embed_api_key,
        base_url=settings.embed_base_url,
        model=settings.embed_model,
        chunk_size=settings.embed_batch_size,      # 必须与服务商单请求上限对齐
        check_embedding_ctx_length=False,          # 关闭 tiktoken 预分词
        model_kwargs={"encoding_format": "float"},
    )


def structured(llm: ChatOpenAI, schema: type[BaseModel]):
    """带方法自适应的结构化输出。"""
    return llm.with_structured_output(schema, method=settings.resolve_structured_method())


def simple_chain(prompt, llm: ChatOpenAI | None = None):
    """prompt -> llm -> text 的最简链。"""
    return (prompt | (llm or chat_llm()) | StrOutputParser())
