# DESIGN.md — 企业内部技术支持知识库 · 作业汇报

场景：课程研究报告 / 答辩（学术风 · 兜底宝蓝白底）
受众：任课教师 + 同组同学（技术评审）
篇幅：18 页 / 4 章

## ① 画布与安全区

- 1280 × 720
- 顶条高 68px（全宽，深蓝）
- 内容区左右 padding 60px，内容顶边 96px，内容区高约 562px（y 96–658）
- 页脚固定在 y 670–700（高 50px 容器），左右 60px，字号 14px

## ② 配色

| 槽位 | Hex | 用途 |
|---|---|---|
| 主色 | `#1E4FA8` | 顶条、编号块、强调、表头 |
| 辅色 | `#3D7BD9` / `#E8EFF8` | 图表第二序列 / 浅蓝底条、卡片底 |
| 强调色 | `#D9534F` | 关键差异、异常值、风险（≤3%） |
| 数据黄 | `#FFC107` | 极少使用，核心金句底 |
| 正文色 | `#1A2230` / `#4A5568` / `#8B97A8` | 主 / 副 / 辅助 |
| 底色 | `#FFFFFF` | ≥60% |
| 辅底 | `#F7F9FC` | 表格表头底、结论条底 |
| 线 | `#D6DCE5` | 卡片描边、表格分隔 |

## ③ 字体与字号

- 中文：Microsoft YaHei；西文/数字：Arial
- 封面主标 64 / 封面副标 24；章节扉页大号数字 160
- 页主标 36（顶条白字）；章节标识 16（顶条右侧）
- KPI 巨数字 72；卡片小标 24；正文 19（lineHeight 1.55）；表格 16；脚注/页码 14

## ④ 视觉母题

顶条 + 右侧「NN · Section」章标识 + 贯通页脚（左：标题｜右：04 / 18）。内容页顶部统一"kicker 横幅"：浅蓝底 `#E8EFF8` + 左侧 4px 主色竖条 + 一句话论断。

## ⑤ 配图清单

无位图。全部使用流程链 / 表格 / 矩阵 / KPI 数字构成，符合学术风「克制、规整」要求。

---

## 逐页字段

| # | title | type | role | rhythm | layout | visual | visual_role | density | anti_pattern |
|---|---|---|---|---|---|---|---|---|---|
| 01 | 企业内部技术支持知识库 | cover | hero | peak | 封面：主标 + 英文副标 + 信息层 | — | anchor | 文字约 60 / 留白 45% | 禁止出现任何指标数字 |
| 02 | 目录 | catalog | supporting | valley | 四章清单 | — | — | 文字约 60 | 禁止统计块/阅读顺序条 |
| 03 | 01 问题与定位 | section | transition | transition | 章节扉页 | — | — | 文字 40 | 禁止四卡预览 |
| 04 | 知识库质量决定自助率，而质量卡在治理 | content | supporting | valley | KPI 三联数 + 依据带 | 4 组数据 | evidence | 约 200 字 | 禁止只摆数字不给判断 |
| 05 | 五类对手，最难打的是员工已经在用的那个 | content | supporting | valley | 竞品表 + 定位判断 | 5 行表 | evidence | 约 240 字 | 禁止罗列厂商名不排序 |
| 06 | 治理四件套在开源 RAG 平台集体空白 | content | hero | peak | 能力矩阵表（8×6） | 矩阵表 | anchor | 约 260 字 | 禁止等宽卡片横排 |
| 07 | 02 系统设计 | section | transition | transition | 章节扉页 | — | — | 文字 40 | 禁止导语段落 |
| 08 | 六节点自适应图 + 三道物理闸 | content | hero | peak | 流程链 + 闸门标注 | 流程图 | anchor | 约 220 字 | 禁止把三道闸画成并列卡 |
| 09 | 权限下沉到检索层：查不到，而不是查完再过滤 | content | supporting | valley | 左权限矩阵 / 右审批流 | 3×3 矩阵 | evidence | 约 250 字 | 禁止 5:5 等分 |
| 10 | 03 实验与结果 | section | transition | transition | 章节扉页 | — | — | 文字 40 | 禁止看点列表 |
| 11 | 先造尺子：40 题评测 + 两轮重复 + 归一化复核 | content | supporting | valley | 四块方法说明 | 4 条细线行 | evidence | 约 240 字 | 禁止只讲"我们做了评测" |
| 12 | 拒答 80%→93.3%，幻觉 17→2，P95 58→17s | content | hero | peak | KPI 三联 + 演进表 | 表格 | anchor | 约 200 字 | 禁止无波动区间的单点结论 |
| 13 | 三个反直觉结论 | content | supporting | valley | 三栏（非等宽） | 三组数据 | evidence | 约 230 字 | 禁止写成"三大优化" |
| 14 | 04 讨论与展望 | section | transition | transition | 章节扉页 | — | — | 文字 40 | 禁止本章结论条 |
| 15 | 三个排障故事：现象 / 根因 / 一句话结论 | content | supporting | valley | 三行细线清单 | 细线行组 | evidence | 约 250 字 | 禁止写成故障流水账 |
| 16 | 七项差距，自己先说 | content | supporting | valley | 7 行表 | 表格 | evidence | 约 230 字 | 禁止隐藏短板 |
| 17 | 下一步：P0 补解析，P3 才谈规模 | content | supporting | valley | 左路线 / 右成本 | 路线表 | evidence | 约 220 字 | 禁止 50:50 等分 |
| 18 | 结束 | ending | hero | peak | 封底 | — | anchor | 文字 30 | 禁止塞致谢进内容页 |
