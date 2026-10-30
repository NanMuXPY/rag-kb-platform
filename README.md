# 技术支持知识库 v2 · 自适应 RAG

企业内部技术支持知识库（腾讯云 AI Coding 作业 · 方向二 AI 应用创新）。
基于 LangGraph 的自适应 RAG：路由 → 问句改写 → 向量检索 → 文档打分 → 生成 → 幻觉/有用性质检 → 重试。

> v1 位于 `D:/WORK/cxl/项目一/任务四项目代码-初始版/`，本目录为前后端全部重写的 v2 版本。
> E0→E1 实验验证过的核心资产（prompt、拒答双闸、切块参数、批大小）原样继承。

## 企业文档中台（v2.2）：多知识库 · 分组权限 · 审批 · 审计

- **多知识库**：默认「产品通用知识库」全员可读；可创建任意私有库，默认隔离、按成员授权。
- **两级权限**：平台级 `superadmin`（超管·跨全库）> `admin` > `user`；库级 `kb_admin`（审批+成员管理）> `editor`（上传·需审批）> `viewer`（只读+下载）。检索按用户可见库集合过滤（Chroma kb_id 元数据 + $in），文件下载逐请求校验权限。
- **审批流**：editor 上传 → `pending` → 库管理员批准后增量入向量库（无需全量重建）；拒绝不入库。
- **数据安全三闸**：①同名覆盖自动存旧版本（`.versions/`）；②删除进回收站（`.trash/`，可恢复）；③全操作审计流水（注册/登录/上传/审批/下载/授权/删除/跨库搜索，记录谁·何时·哪个库·哪个文件）。
- **超管特权**：跨库语义搜索（返回命中 chunk + 所属知识库 + 原文件名）、创建/删除知识库。
- **文件类型**（v2.4）：md / txt / pdf / docx / **xlsx** / **pptx** 统一走 `app/extract.py` 抽取后索引，原始文件均可下载（≤20MB）；扫描件可开 OCR，`.xls/.ppt` 旧格式提示另存。

## 加固与评测口径（v2.3 / v2.4）

- **v2.3**（`docs/v2.3-加固说明.md`）：统一抽取（md/txt/pdf/docx + 扫描件 OCR）、建库多格式 + 跳过报告、
  BM25 按库分区 + 后台重建、并发入库、重建进度。
- **v2.4**（`docs/v2.4-说明.md`）：xlsx/pptx 入库；拒答评测改三态（pass/partial/fail）并修掉两处
  substring 误伤；prompt 增加规则 10「术语不可替换」（名字相近但不同的功能不得互相顶替）。

## 企业版（v2.1）：账号 · 审批 · 角色权限

- **注册审批制**：员工注册后为 `pending`，管理员在「用户管理」面板批准（`active`）后才能登录；可停用/恢复/删除/设为管理员。
- **认证**：JWT（HS256，12h 过期），密码 PBKDF2-SHA256（20 万次迭代）加盐哈希；用户库 SQLite（`data/users.db`，随 data 卷持久化）。
- **权限**：`/chat` 需登录；`/admin/*`（用户管理 + 知识库管理）仅管理员；停用账号的 token **立即失效**（服务端逐请求校验状态）。
- **防爆破**：登录连续失败 5 次锁定 15 分钟；登录/注册接口共享每 IP 每日限流。
- **种子管理员**：首次启动自动创建（`SEED_ADMIN_USER` / `SEED_ADMIN_PASSWORD`，生产务必改密）。
- **兼容通道**：设置 `DEMO_TOKEN` 时旧评测脚本仍可用 `X-Demo-Token` 访问 `/chat`（身份记为 demo，与登录用户会话隔离）。
- **设计依据**：auth-implementation-patterns skill（密码哈希/token 过期/限速/安全事件日志/服务端权威校验）。

## 与 v1 的差异（重写要点）

| 维度 | v1 | v2 |
|---|---|---|
| 配置 | os.getenv 散落各文件 | `app/config.py` 集中 dataclass |
| 图状态 | message_history 拼字符串 | 结构化 chat_history + trace（每节点耗时） |
| 重试计数 | Nodes 类属性（并发不安全） | GraphState 内计数（线程安全） |
| 闲聊 | 被 E1 双闸误拒 | 独立 chitchat 节点，友好引导回正题 |
| 自传文档 | 上传复制两份，容器重建会丢扫描副本 | uploads 卷即唯一事实源 |
| 前端 | LobeChat 风格 v3 | 全新设计：引用+链路时间线一等公民 |
| 评测 | eval/ | 接口协议兼容，脚本原样可用 |

## 目录结构

```
rag-kb-v2/
├── backend/
│   ├── app/            # config / llm / chains / guard / knowledge / engine / documents / sessions / security / users
│   ├── api/main.py     # FastAPI：/chat /admin/*（协议与 v1 兼容）
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/           # index.html + app.css + app.js（无构建，nginx 托管）
├── deploy/nginx.conf
├── data/               # 内置语料 6 大主题 39 篇 → 185 chunks（800/120）
├── eval/               # eval_set.jsonl 30 题 + eval_set_hard.jsonl 10 题 + grading.py 判分口径
├── docker-compose.yaml # backend + nginx:alpine，宿主 8080
└── .env                # 百炼 Key（勿提交）
```

## 本地运行

```bash
cd backend
uvicorn api.main:app --host 127.0.0.1 --port 14052
# 首次启动自动建向量库（185 chunks），之后加载已有库
```

前端开发预览：直接打开 `frontend/index.html`（自动回退直连 127.0.0.1:14052）。

## 服务器部署（47.94.2.5:8080）

```bash
# 本地打包上传（排除本地产物）
# 服务器上：
cd /opt/rag-kb-v2
docker compose up -d --build
# 回滚：停 v2 容器 → 重新 up 旧版 /opt/ragkb 部署目录
```

环境变量见 `.env.example`；公网防护三开关：`DEMO_TOKEN` / `DAILY_IP_LIMIT` / `ADMIN_TOKEN`。

## 质量闸门（E1 双闸 + E6/E7 生成规则 + v2.4 拒答三态评测）

- **G1 硬闸**：检索打分后零文档 → 不调 LLM 直接拒答（E0 实测零文档时 3/11 概率纯编造）
- **G2 引用白名单**：答案中「参考：X」必须命中本次检索文档，全伪造则降级拒答
- **旁路重建**：上传/删除后新库建于临时目录 → 原子改名 → 进程自愈重启，服务不中断
