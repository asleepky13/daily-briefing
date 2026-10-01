"""Check every feed in config.yaml: HTTP status, item count, newest item date. Exits 1 if any feed is dead.

    python scripts/validate_feeds.py
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.fetch import fetch_all  # noqa: E402
from pipeline.main import health_table, load_config  # noqa: E402
from pipeline.parse import parse_result  # noqa: E402


def main() -> int:
    config = load_config()
    now = datetime.now(timezone.utc)
    results = asyncio.run(fetch_all(config, use_cache=False))
    for r in results:
        parse_result(r, now)
        if r.ok and not r.items:
            r.error = "no items"
    print(health_table(results))
    dead = [r.feed["name"] for r in results if not r.ok]
    stale = [r.feed["name"] for r in results if r.ok and all(
        i["date_estimated"] or (now - datetime.fromisoformat(i["published_at"])).days >= 7 for i in r.items)]
    print(f"\n{len(results) - len(dead)}/{len(results)} feeds OK.")
    if stale:
        print("No dated item in the last 7 days (possibly stale): " + ", ".join(stale))
    if dead:
        print("DEAD: " + ", ".join(dead))
    return 1 if dead else 0


if __name__ == "__main__":
    sys.exit(main())
