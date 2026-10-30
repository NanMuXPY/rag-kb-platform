"""拒答判定与"泄漏"判定的统一口径（v2.4）。

起因（q020 复核）：v2.3 及之前的判分把「不能 / 不在 / 建议您 / 知识库 / 人工」当成
拒答标记做 substring 匹配，被正常回答里的同字片段命中——

    q020 回答「…当您不在会议中时，被指定的成员将优先成为主持人…」
    → 命中 "不在" → 判为"已拒答"，实际它把「指定主持人」的 10 位上限安到了
      「联席主持人」上，是一条真幻觉。

改成三段式口径，比"过/不过"更能说明问题：

    pass     首句就在说"资料未覆盖/请转人工"，且没有泄漏
    partial  首句先给了结论，后面才补"资料未包含具体步骤"——最危险的一种，
             用户往往只读到第一句
    fail     通篇没拒答，或命中了禁答内容

另：must_not_regex 给单题留"禁答正则"的口子，用于拦"编数字"这类文案黑名单
覆盖不到的形态。
"""
import re

# 命中即算拒答：这些短语本身就在说"资料里没有"
HARD_REFUSE = [
    r"无法(确定|查询|提供|代为|帮您|直接|确认|判断|核实)",
    r"无法(代|帮|替)(您|你)",          # q030：模型写「无法代您重新提交」而不是「无法代为」
    r"没有.{0,6}(账号|权限)",           # q025/q030：「没有您的腾讯云账号登录权限」
    r"资料(中|里)?(未|没有)(包含|提供|说明|明确|给出|收录|提及)",
    r"资料不足",
    r"(未|没有)(涵盖|收录)(该|相关|具体)",
    r"不在(本)?知识库",
    r"知识库(中|里)?(没有|未|暂无|不含)",
    r"没有(找到)?相关(的)?(资料|文档|说明|内容)",
    r"当前资料.{0,8}(未|没有)",
    # q027：模型常写成「根据当前知识库资料，未提供……」，中间隔着逗号，
    # 上面的"资料中未…"匹配不到，这里单独兜一层
    r"未(提供|说明|明确|给出|收录|提及|记载|列出|覆盖)",
    r"(知识库|资料)[，,、]?.{0,6}(未|没有|无法)(提供|包含|说明|记载|收录|覆盖)",
]

# 礼貌性转人工话术：出现在首句算 pass，只在后段出现算 partial
SOFT_REFUSE = [
    r"(建议|请)(您)?(通过|联系|咨询|前往|使用).{0,14}(官方|人工|客服|支持渠道|帮助中心)",
    r"转人工",
]

_SENT = re.compile(r"[。！？；\n]")
_HEAD_LIMIT = 80


def _hits(patterns, text):
    return [p for p in patterns if re.search(p, text)]


def head_clause(answer: str) -> str:
    """答案的第一句（最长 80 字），用来判断"用户第一眼看到什么"。"""
    text = (answer or "").strip()
    m = _SENT.search(text)
    if m and m.start() <= _HEAD_LIMIT:
        return text[: m.start() + 1]
    return text[:_HEAD_LIMIT]


def said_refuse(answer: str) -> bool:
    """通篇是否存在"资料未覆盖、请转人工"的表述。"""
    text = answer or ""
    return bool(_hits(HARD_REFUSE, text) or _hits(SOFT_REFUSE, text))


def leaked(answer: str, item: dict) -> list:
    """拒答题的泄漏判定：命中文案黑名单或禁答正则，都算泄漏。"""
    text = answer or ""
    out = [k for k in (item.get("must_not_contain") or []) if k in text]
    for pat in item.get("must_not_regex") or []:
        if re.search(pat, text):
            out.append(f"regex:{pat}")
    return out


def grade_refusal(answer: str, item: dict) -> str:
    """返回 pass / partial / fail。"""
    text = (answer or "").strip()
    if not text:
        return "fail"
    if leaked(text, item):
        return "fail"
    head = head_clause(text)
    if _hits(HARD_REFUSE, head) or _hits(SOFT_REFUSE, head):
        return "pass"
    if said_refuse(text):
        return "partial"
    return "fail"


def refuse_ok(answer: str, item: dict) -> bool:
    """严格口径：只有 pass 算通过。"""
    return grade_refusal(answer, item) == "pass"
