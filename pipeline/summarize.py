"""Ranking, Top-N, and the non-AI "What matters today" block. No LLMs, no paid APIs."""
from __future__ import annotations

from collections import Counter
from datetime import datetime

from pipeline.filter import keyword_weight


def score(item: dict, now: datetime, window_hours: float, priority: set[str]) -> float:
    """Coverage (other outlets) + keyword weight + recency (0..3, newest highest) + 2 if breaking/rising."""
    age_h = (now - datetime.fromisoformat(item["published_at"])).total_seconds() / 3600
    recency = 3 * max(0.0, 1 - age_h / window_hours)
    coverage = 3 * len(item["also_covered_by"])
    momentum = 2 if (item.get("trend") or {}).get("state") in ("breaking", "rising") else 0
    return round(coverage + keyword_weight(item["matched_keywords"], priority) + recency + momentum, 2)


def build_sections(stories: list[dict], config: dict, compiled: dict, now: datetime) -> dict[str, dict]:
    """Rank stories per section, cap to max_items, pick Top-N, and write the What-matters block."""
    window = config.get("recency_hours", 26)
    cap = config.get("max_items_per_section", 40)
    top_n = config.get("top_n", 5)
    out = {}
    for key, rules in compiled.items():
        items = [s for s in stories if s["section"] == key]
        for s in items:
            s["score"] = score(s, now, window, rules["priority"])
        items.sort(key=lambda s: s["published_at"], reverse=True)  # tie-break: newest first
        items.sort(key=lambda s: s["score"], reverse=True)
        matched = len(items)
        all_kw = Counter(k for s in items for k in s["matched_keywords"])
        items = items[:cap]
        kw = Counter(k for s in items for k in s["matched_keywords"])
        out[key] = {
            "name": config["sections"][key]["name"],
            "count": len(items),
            "matched": matched,
            "keyword_counts": all_kw.most_common(20),
            "top": [s["id"] for s in items[:top_n]],
            "what_matters": {
                "clusters": [{"id": s["id"], "title": s["title"], "sources": 1 + len(s["also_covered_by"])}
                             for s in items[:6]],
                "keywords": [{"keyword": k, "count": c} for k, c in kw.most_common(10)],
            },
            "items": items,
        }
    return out


def digest_text(day: dict, markdown: bool = True) -> str:
    """Top-N per section as Markdown (Slack/Notion) or plain text (email)."""
    lines = [f"{'# ' if markdown else ''}Daily Briefing — {day['date']}", ""]
    for sec in day["sections"].values():
        lines.append(f"{'## ' if markdown else ''}{sec['name']}")
        by_id = {s["id"]: s for s in sec["items"]}
        for sid in sec["top"]:
            s = by_id[sid]
            lines.append(f"- [{s['title']}]({s['url']}) — {s['source']}" if markdown
                         else f"- {s['title']} ({s['source']})\n  {s['url']}")
        if not sec["top"]:
            lines.append("- No stories today.")
        lines.append("")
    return "\n".join(lines)
