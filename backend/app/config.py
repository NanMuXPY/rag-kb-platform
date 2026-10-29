# ---------------------------------------------------------------------------
# 集中配置：所有环境变量在此读取一次，其余模块只 import settings
# v2 重写要点：告别散落各处的 os.getenv，配置可测试、可审计
# ---------------------------------------------------------------------------
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

# 项目根 = backend/ 的上一级；.env 放项目根
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_PROJECT_ROOT / ".env", override=True)


def _read_key(*names: str) -> str:
    """按优先级读取 API Key，取第一个非空值。"""
    for name in names:
        value = (os.getenv(name) or "").strip()
        if value and not value.startswith("sk-你的"):
            return value
    return ""


@dataclass(frozen=True)
class Settings:
    # ----- LLM（OpenAI 兼容协议：百炼 / TokenHub 混元均可） -----
    llm_api_key: str = field(default_factory=lambda: _read_key(
        "HUNYUAN_API_KEY", "TOKENHUB_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"
    ))
    llm_base_url: str = field(default_factory=lambda: (
        os.getenv("OPENAI_API_BASE", "https://dashscope.aliyuncs.com/compatible-mode/v1").rstrip("/")
    ))
    llm_model: str = field(default_factory=lambda: os.getenv("LLM_MODEL", "qwen-plus"))

    # ----- Embedding（可与 LLM 不同服务商，互不绑定） -----
    embed_api_key: str = field(default_factory=lambda: _read_key(
        "EMBEDDING_API_KEY", "DASHSCOPE_API_KEY", "OPENAI_API_KEY"
    ) or _read_key("HUNYUAN_API_KEY", "TOKENHUB_API_KEY", "DEEPSEEK_API_KEY"))
    embed_base_url: str = field(default_factory=lambda: (
        os.getenv("EMBEDDING_API_BASE", "https://dashscope.aliyuncs.com/compatible-mode/v1").rstrip("/")
    ))
    embed_model: str = field(default_factory=lambda: os.getenv("EMBEDDING_MODEL", "text-embedding-v4"))
    # 百炼单请求硬上限 10 条，务必与 batch 对齐
    embed_batch_size: int = field(default_factory=lambda: int(os.getenv("EMBEDDING_BATCH_SIZE", "10")))

    # ----- 知识库 -----
    data_dir: Path = field(default_factory=lambda: _PROJECT_ROOT / os.getenv("DATA_DIR", "data"))
    persist_dir: Path = field(default_factory=lambda: _PROJECT_ROOT / os.getenv("PERSISTANT_STORAGE_DIR", "db_md"))
    upload_dir: Path = field(default_factory=lambda: _PROJECT_ROOT / os.getenv("UPLOAD_DIR", "data/uploads"))
    chunk_size: int = 800
    chunk_overlap: int = 120
    retriever_k: int = 4
    # 检索策略：plain（原始相似度）/ dedup（同文档去重）/ mmr（最大边际相关）
    retriever_mode: str = field(default_factory=lambda: os.getenv("RETRIEVER_MODE", "plain").strip().lower())
    # dedup 与 mmr 的候选池大小（先多取再筛）
    retriever_fetch_k: int = field(default_factory=lambda: int(os.getenv("RETRIEVER_FETCH_K", "12")))
    # MMR 相关性与多样性权衡：1.0 只看相关性，0.0 只看多样性
    mmr_lambda: float = field(default_factory=lambda: float(os.getenv("MMR_LAMBDA", "0.5")))
    rebuild_vectorstore: bool = field(default_factory=lambda: (
        os.getenv("REBUILD_VECTORSTORE", "False").lower() == "true"
    ))

    # ----- 图质量闸门 -----
    regeneration_threshold: int = field(default_factory=lambda: int(os.getenv("REGENERATION_THRESHOLD", "5")))
    re_retrieval_threshold: int = field(default_factory=lambda: int(os.getenv("RERETREVIAL_THRESHOLD", "3")))

    # ----- 服务 -----
    host: str = field(default_factory=lambda: os.getenv("API_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(os.getenv("API_PORT", "14052")))
    debug: bool = field(default_factory=lambda: os.getenv("DEBUG", "False").lower() == "true")

    # ----- 公网防护（全部可选，不设置则零影响） -----
    demo_token: str = field(default_factory=lambda: os.getenv("DEMO_TOKEN", "").strip())
    admin_token: str = field(default_factory=lambda: (
        os.getenv("ADMIN_TOKEN", "").strip() or os.getenv("DEMO_TOKEN", "").strip()
    ))
    daily_ip_limit: int = field(default_factory=lambda: int(os.getenv("DAILY_IP_LIMIT", "0") or 0))
    allowed_origins: list[str] = field(default_factory=lambda: [
        o.strip() for o in os.getenv("DEMO_ALLOWED_ORIGINS", "").split(",") if o.strip()
    ])

    # ----- 用户认证（SQLite + JWT + 审批制） -----
    user_db: Path = field(default_factory=lambda: (
        _PROJECT_ROOT / os.getenv("DATA_DIR", "data") / "users.db"))
    seed_admin_user: str = field(default_factory=lambda: os.getenv("SEED_ADMIN_USER", "admin").strip())
    seed_admin_password: str = field(default_factory=lambda: os.getenv("SEED_ADMIN_PASSWORD", "admin123"))
    # 多知识库文件存储：默认与向量库同卷（持久化），避开 data/ 的建库扫描范围
    files_dir: Path = field(default_factory=lambda: (
        _PROJECT_ROOT / os.getenv("KB_FILES_DIR", "kb_files")))

    # ----- 结构化输出方法：按服务商自动选择，可显式覆盖 -----
    structured_method: str = field(default_factory=lambda: os.getenv("LLM_STRUCTURED_METHOD", "").strip().lower())

    def resolve_structured_method(self) -> str:
        """百炼走 function_calling；混元复杂 prompt 易 502 改 json_schema。"""
        if self.structured_method in {"function_calling", "json_schema", "json_mode"}:
            return self.structured_method
        base = self.llm_base_url.lower()
        if "tokenhub" in base or "hunyuan" in base or self.llm_model.lower().startswith("hy"):
            return "json_schema"
        return "function_calling"

    def validate(self) -> None:
        problems = []
        if not self.llm_api_key:
            problems.append("缺少 LLM API Key（OPENAI_API_KEY 等）")
        if not self.embed_api_key:
            problems.append("缺少 Embedding API Key（EMBEDDING_API_KEY 等）")
        if not self.data_dir.is_dir():
            problems.append(f"知识库目录不存在: {self.data_dir}")
        if len(self.seed_admin_password) < 6:
            problems.append("SEED_ADMIN_PASSWORD 至少 6 位")
        if problems:
            raise RuntimeError("环境配置错误：\n  - " + "\n  - ".join(problems))


settings = Settings()
