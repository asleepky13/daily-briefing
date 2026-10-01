"""Write daily JSON, maintain the archive index, and render the static site into public/."""
from __future__ import annotations

import json
import logging
import re
import shutil
from datetime import date, datetime, timedelta
from email.utils import format_datetime
from html import escape
from pathlib import Path
from urllib.parse import quote

log = logging.getLogger("build")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SITE = ROOT / "site"
PUBLIC = ROOT / "public"
_DAY_FILE = re.compile(r"^\d{4}-\d{2}-\d{2}\.json$")


def write_day(day: dict, data_dir: Path = DATA) -> Path:
    """Write data/YYYY-MM-DD.json."""
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / f"{day['date']}.json"
    path.write_text(json.dumps(day, ensure_ascii=False, separators=(",", ":")), "utf-8")
    return path


def previous_stories(today: date, data_dir: Path = DATA) -> list[dict]:
    """Stories from the most recent briefing before `today` (for day-over-day coverage trends)."""
    earlier = sorted(p for p in data_dir.glob("*.json") if _DAY_FILE.match(p.name) and p.stem < today.isoformat())
    if not earlier:
        return []
    day = json.loads(earlier[-1].read_text("utf-8"))
    return [s for sec in day["sections"].values() for s in sec["items"]]


def update_index(today: date, retention_days: int, data_dir: Path = DATA) -> dict:
    """Prune day files older than retention, then rebuild index.json and the archive search index."""
    cutoff = today - timedelta(days=retention_days)
    days, search = [], []
    for path in sorted(data_dir.glob("*.json"), reverse=True):
        if not _DAY_FILE.match(path.name):
            continue
        d = date.fromisoformat(path.stem)
        if d < cutoff:
            path.unlink()
            log.info("pruned file=%s", path.name)
            continue
        day = json.loads(path.read_text("utf-8"))
        # per-section volume (before the display cap) and keyword counts feed the 7-day trend charts
        days.append({"date": day["date"], "generated_at": day["generated_at"], "kept": day["stats"]["kept"],
                     "scanned": day["stats"]["scanned"],
                     "sections": {k: {"count": s["count"], "matched": s.get("matched", s["count"]),
                                      "keywords": dict(s.get("keyword_counts", []))}
                                  for k, s in day["sections"].items()}})
        for key, sec in day["sections"].items():
            search += [[day["date"], key, s["title"], s["url"], s["source"]] for s in sec["items"]]
    index = {"latest": days[0]["date"] if days else None, "dates": days}
    (data_dir / "index.json").write_text(json.dumps(index, separators=(",", ":")), "utf-8")
    (data_dir / "search.json").write_text(json.dumps(search, ensure_ascii=False, separators=(",", ":")), "utf-8")
    return index


# Chinese characters the UI itself uses; config `sign:` values are added at build time.
UI_CJK = "每日簡報今日檔案收藏調校新星期一二三四五六年月號"


def _nav(sections: dict, root: str, archive: bool, current: str) -> str:
    """Bilingual signboard navigation. Archive pages switch sections via ?s= on the same permalink."""
    links = [("", "Today" if not archive else "Overview", "今日")]
    links += [(k, v["name"], v.get("sign", "")) for k, v in sections.items()]
    out = []
    for key, name, zh in links:
        href = (f"./?s={key}" if key else "./") if archive else (f"{root}{key}/" if key else root)
        cur = ' aria-current="page"' if key == current else ""
        sign = f'<span class="zh" lang="zh-Hant" aria-hidden="true">{escape(zh)}</span>' if zh else ""
        out.append(f'<li><a href="{escape(href)}" data-key="{key}"{cur}>{sign}<span>{escape(name)}</span></a></li>')
    extra = [("archive/", "Archive", "檔案", "archive"), ("saved/", "Saved", "收藏", "saved")]
    for path, name, zh, key in extra:
        href = ("../../" + path) if archive else root + path
        cur = ' aria-current="page"' if current == key else ""
        out.append(f'<li><a href="{href}" data-key="{key}"{cur}><span class="zh" lang="zh-Hant" aria-hidden="true">{zh}</span>'
                   f'<span>{name}</span></a></li>')
    return "\n".join(out)


def _render(template: str, out: Path, *, root: str, view: str, section: str, day: str, title: str,
            sections: dict, archive: bool, site_title: str, latest: str, cjk: str) -> None:
    feeds = "\n".join(f'<link rel="alternate" type="application/rss+xml" title="{escape(site_title)}: {escape(s["name"])}" '
                      f'href="{root}feeds/{k}.xml">' for k, s in sections.items())
    subs = {"ROOT": root, "VIEW": view, "SECTION": section, "DATE": day, "LATEST": latest, "CJK": quote(cjk),
            "TITLE": escape(title), "SITE_TITLE": escape(site_title), "FEEDS": feeds,
            "NAV": _nav(sections, root, archive, section or ("" if view == "home" else view))}
    html = re.sub(r"\{\{(\w+)\}\}", lambda m: subs[m.group(1)], template)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, "utf-8")


def _rss(config: dict, key: str, sec: dict, day: dict) -> str:
    base = config["site"]["base_url"].rstrip("/") + "/"
    items = []
    for s in sec["items"]:
        pub = format_datetime(datetime.fromisoformat(s["published_at"]))
        items.append(f"<item><title>{escape(s['title'])}</title><link>{escape(s['url'])}</link>"
                     f"<guid isPermaLink=\"false\">{s['id']}</guid><pubDate>{pub}</pubDate>"
                     f"<source url=\"{escape(base)}\">{escape(s['source'])}</source>"
                     f"<description>{escape(s['summary'])}</description></item>")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>'
            f"<title>{escape(config['site']['title'])}: {escape(sec['name'])}</title>"
            f"<link>{escape(base + key + '/')}</link>"
            f"<description>{escape(sec['name'])} headlines collected {day['date']}</description>"
            f"<lastBuildDate>{format_datetime(datetime.fromisoformat(day['generated_at']))}</lastBuildDate>"
            + "".join(items) + "</channel></rss>\n")


def render_site(config: dict, data_dir: Path = DATA, site_dir: Path = SITE, out_dir: Path = PUBLIC) -> None:
    """Render every page and feed into out_dir (deployed to GitHub Pages)."""
    if out_dir.exists():
        shutil.rmtree(out_dir)
    shutil.copytree(site_dir / "assets", out_dir / "assets")
    shutil.copytree(data_dir, out_dir / "data")
    for name in ("sw.js", "manifest.webmanifest"):  # service worker must sit at the site root to control it
        shutil.copy(site_dir / name, out_dir / name)
    (out_dir / ".nojekyll").write_text("")
    template = (site_dir / "index.html").read_text("utf-8")
    title = config["site"]["title"]
    sections = {k: v for k, v in config["sections"].items() if v.get("enabled", True)}
    index = json.loads((data_dir / "index.json").read_text("utf-8"))
    cjk = "".join(sorted(set(UI_CJK + "".join(s.get("sign", "") for s in sections.values()))))
    common = dict(sections=sections, site_title=title, latest=index["latest"] or "", cjk=cjk)

    pages = [(out_dir, "./", "home", "", title), (out_dir / "archive", "../", "archive", "", f"Archive · {title}"),
             (out_dir / "saved", "../", "saved", "", f"Saved · {title}"),
             (out_dir / "tuning", "../", "tuning", "", f"Keyword tuning · {title}")]
    pages += [(out_dir / k, "../", "section", k, f"{s['name']} · {title}") for k, s in sections.items()]
    for folder, root, view, key, page_title in pages:
        _render(template, folder / "index.html", root=root, view=view, section=key, day="", title=page_title,
                archive=False, **common)
    for entry in index["dates"]:
        _render(template, out_dir / "archive" / entry["date"] / "index.html", root="../../", view="home",
                section="", day=entry["date"], title=f"{entry['date']} · {title}", archive=True, **common)

    if index["latest"]:
        day = json.loads((data_dir / f"{index['latest']}.json").read_text("utf-8"))
        (out_dir / "feeds").mkdir(exist_ok=True)
        for key, sec in day["sections"].items():
            (out_dir / "feeds" / f"{key}.xml").write_text(_rss(config, key, sec, day), "utf-8")
    log.info("site_rendered out=%s pages=%d", out_dir, len(pages) + len(index["dates"]))
