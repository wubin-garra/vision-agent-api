import json
from typing import Any, Optional


def format_geo_context(
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
) -> str:
    if latitude is None or longitude is None:
        return "拍摄位置：未提供"
    return f"拍摄位置：纬度 {latitude:.6f}，经度 {longitude:.6f}"


def format_insight_context(insight: dict[str, Any]) -> str:
    return json.dumps(insight, ensure_ascii=False, indent=2)


def format_followup_history(followups: list[dict[str, Any]]) -> str:
    if not followups:
        return "（无历史追问）"

    lines: list[str] = []
    for index, item in enumerate(followups, start=1):
        question = item.get("question", "")
        answer = item.get("answer", "")
        structured = item.get("structured_answer")
        if structured and isinstance(structured, dict) and structured.get("summary"):
            answer = structured["summary"]
        lines.append(f"Q{index}: {question}\nA{index}: {answer}")
    return "\n\n".join(lines)


def build_analyze_user_text(
    *,
    locale: str,
    caption: str,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
) -> str:
    return (
        f"Locale: {locale}\n"
        f"{format_geo_context(latitude, longitude)}\n\n"
        f"图片视觉描述（由视觉模型生成）：\n{caption}\n\n"
        "请基于以上描述输出结构化 JSON 洞察。只输出 JSON。"
    )


def build_followup_user_text(
    *,
    locale: str,
    caption: str,
    insight: dict[str, Any],
    followup_history: list[dict[str, Any]],
    question: str,
    agent_id: str,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
) -> str:
    return (
        f"Locale: {locale}\n"
        f"Agent: {agent_id}\n"
        f"{format_geo_context(latitude, longitude)}\n\n"
        f"【图片视觉描述】\n{caption}\n\n"
        f"【已有洞察】\n{format_insight_context(insight)}\n\n"
        f"【历史追问】\n{format_followup_history(followup_history)}\n\n"
        f"【当前问题】\n{question}\n\n"
        "只输出 JSON。"
    )
