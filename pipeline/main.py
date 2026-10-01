"""Run the whole pipeline.

    python -m pipeline.main               # full run: fetch, write data/, render public/
    python -m pipeline.main --dry-run     # fetch + process, print results, write nothing
    python -m pipeline.main --render-only # rebuild public/ from existing data/
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml
from dotenv import load_dotenv

from pipeline import build, integrations, markets
from pipeline.dedupe import cluster, link_previous, merge_exact
from pipeline.fetch import FetchResult, fetch_all
from pipeline.filter import apply_source_rules, assign_sections, compile_sections, keyword_report, recent
from pipeline.parse import parse_result
from pipeline.summarize import build_sections

log = logging.getLogger("main")



def load_config(path: Path = build.ROOT / "config.yaml") -> dict:
    return yaml.safe_load(path.read_text("utf-8"))


def is_due(scheduled: bool, now: datetime, every_hours: float, data_dir: Path = build.DATA) -> bool:
    """The workflow fires hourly (GitHub drops some scheduled runs); a scheduled run proceeds only once the
    latest briefing is `every_hours` old, minus 15 minutes of slack for cron jitter. Manual runs always proceed."""
    if not scheduled:
        return True
    try:
        index = json.loads((data_dir / "index.json").read_text("utf-8"))
        last = datetime.fromisoformat(index["dates"][0]["generated_at"])
    except (OSError, ValueError, KeyError, IndexError):
        return True  # no usable history: build one
    return (now - last).total_seconds() >= every_hours * 3600 - 15 * 60


def health_table(results: list[FetchResult]) -> str:
    """Fixed-width feed health table for the Actions log."""
    rows = [("STATUS", "SECTION", "FEED", "ITEMS", "NEWEST (UTC)", "SECS", "NOTE")]
    for r in sorted(results, key=lambda r: (r.ok, r.section, r.feed["name"])):
        newest = max((i["published_at"] for i in r.items if not i["date_estimated"]), default="")
        note = r.error or ("304 cached" if r.from_cache else "")
        rows.append(("OK" if r.ok else "DEAD", r.section, r.feed["name"][:38], str(len(r.items)),
                     newest[:16].replace("T", " "), f"{r.elapsed:.1f}", note[:60]))
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    return "\n".join("  ".join(c.ljust(w) for c, w in zip(row, widths)) for row in rows)


def _gh_output(**kv: str) -> None:
    if path := os.environ.get("GITHUB_OUTPUT"):
        with open(path, "a", encoding="utf-8") as f:
            f.writelines(f"{k}={v}\n" for k, v in kv.items())


def _gh_summary(text: str) -> None:
    if path := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(path, "a", encoding="utf-8") as f:
            f.write(text + "\n")


def run(config: dict, *, dry_run: bool, use_cache: bool = True) -> int:
    """Fetch → parse → filter → dedupe → rank → write. Returns a process exit code."""
    now = datetime.now(timezone.utc).replace(microsecond=0)
    tz = config["site"].get("timezone", "America/Toronto")
    compiled = compile_sections(config)

    results = asyncio.run(fetch_all(config, use_cache=use_cache and not dry_run))
    for r in results:
        parse_result(r, now)
    print(health_table(results), flush=True)

    today = now.astimezone(ZoneInfo(tz)).date()
    fetched = [i for r in results for i in r.items]
    fresh = recent(apply_source_rules(fetched, config.get("sources")), now, config.get("recency_hours", 26))
    matched = assign_sections(fresh, compiled)
    unique = merge_exact(matched)
    stories = cluster(unique, config.get("similarity_threshold", 85))
    link_previous(stories, build.previous_stories(today), config.get("similarity_threshold", 85))
    sections = build_sections(stories, config, compiled, now)
    kept = sum(s["count"] for s in sections.values())

    ok = sum(r.ok for r in results)
    stats = {"feeds_ok": ok, "feeds_total": len(results), "scanned": len(fetched), "recent": len(fresh),
             "matched": len(matched), "deduped": len(matched) - len(stories), "kept": kept, "ai_calls": 0}
    summary = " ".join(f"{k}={v}" for k, v in stats.items())
    log.info("run_summary %s", summary)
    _gh_summary(f"### Daily Briefing run\n\n`{summary}`\n\n```\n{health_table(results)}\n```")

    if kept == 0:
        log.error("zero_items: keeping the previous site. Check the feed health table above.")
        return 1

    for sec in sections.values():  # internal routing fields; the site never reads them
        for s in sec["items"]:
            s.pop("feed_section", None)
            s.pop("from_dedicated_feed", None)
    day = {
        "date": today.isoformat(),
        "generated_at": now.isoformat(),
        "stats": stats,
        "health": [{"name": r.feed["name"], "section": r.section, "ok": r.ok, "items": len(r.items),
                    "error": r.error} for r in results],
        "sections": sections,
        "keywords": keyword_report(fresh, compiled, matched),
        "markets": markets.snapshot(config),
    }
    if dry_run:
        for sec in sections.values():
            print(f"\n== {sec['name']} ({sec['count']}) ==")
            for s in sec["items"][: config.get("top_n", 5)]:
                also = f"  [+{len(s['also_covered_by'])}]" if s["also_covered_by"] else ""
                print(f"  {s['score']:5.1f}  {s['title'][:90]} — {s['source']}{also}")
        print("\nDry run: nothing written.")
        return 0

    build.write_day(day)
    index = build.update_index(datetime.fromisoformat(day["date"]).date(), config.get("retention_days", 90))
    build.render_site(config)
    log.info("written date=%s archive_days=%d", day["date"], len(index["dates"]))
    for name, status in integrations.run_all(day, config).items():
        log.info("integration name=%s status=%s", name, status)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Daily Briefing pipeline")
    p.add_argument("--dry-run", action="store_true", help="fetch and process, write nothing")
    p.add_argument("--render-only", action="store_true", help="rebuild public/ from data/ without fetching")
    p.add_argument("--no-cache", action="store_true", help="ignore the ETag/Last-Modified cache")
    p.add_argument("--scheduled", action="store_true", default=os.environ.get("GITHUB_EVENT_NAME") == "schedule",
                   help="skip unless the last briefing is `update_every_hours` old (set automatically on cron runs)")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s level=%(levelname)s stage=%(name)s %(message)s")
    load_dotenv()
    config = load_config()

    if args.render_only:
        build.render_site(config)
        return 0
    every = config.get("update_every_hours", 4)
    if not is_due(args.scheduled, datetime.now(timezone.utc), every):
        log.info("skip: the latest briefing is less than %s hours old", every)
        _gh_output(skipped="true")
        return 0
    _gh_output(skipped="false")
    return run(config, dry_run=args.dry_run, use_cache=not args.no_cache)


if __name__ == "__main__":
    sys.exit(main())
