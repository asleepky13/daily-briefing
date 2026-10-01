"""Parse RSS/Atom (feedparser) and HTML (selectolax) into normalized story items."""
from __future__ import annotations

import base64
import calendar
import hashlib
import html
import logging
import re
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlsplit

import feedparser
from selectolax.parser import HTMLParser

from pipeline.dedupe import canonicalize_url

log = logging.getLogger("parse")

SNIPPET_MAX = 300
_WS = re.compile(r"\s+")
_GNEWS_URL = re.compile(rb"https?://[\x21-\x7e]+")
_URL_DATE = re.compile(r"/(20\d\d)/(\d\d)/(\d\d)/")


def clean_text(raw: str | None, limit: int = SNIPPET_MAX) -> str:
    """Strip HTML tags/entities, collapse whitespace, and truncate on a word boundary."""
    if not raw:
        return ""
    text = HTMLParser(raw).text(separator=" ") if "<" in raw else raw
    text = _WS.sub(" ", html.unescape(text)).strip()
    if len(text) > limit:
        text = text[: limit - 1].rsplit(" ", 1)[0].rstrip(",;:.-") + "…"
    return text


def resolve_gnews(url: str) -> str:
    """Decode a Google News article link to the publisher URL when the URL is embedded in the token.

    Newer tokens are opaque and need a JS round-trip; those are returned unchanged.
    """
    parts = urlsplit(url)
    if parts.netloc != "news.google.com" or "/articles/" not in parts.path:
        return url
    token = parts.path.rsplit("/", 1)[-1]
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
    except (ValueError, TypeError):
        return url
    m = _GNEWS_URL.search(raw)
    return m.group(0).decode("ascii", "ignore") if m else url


def _sane(dt: datetime | None, now: datetime) -> datetime | None:
    """Reject dates far in the future or absurdly old (garbage in feeds)."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt if datetime(2000, 1, 1, tzinfo=timezone.utc) < dt < now + timedelta(days=1) else None


def parse_date_text(text: str | None) -> datetime | None:
    """Parse an RFC 2822 or ISO 8601 date string; None if unparseable."""
    if not text:
        return None
    text = text.strip()
    try:
        return parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        pass
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def make_item(*, title: str, url: str, source: str, section: str, published: datetime | None,
              summary: str, now: datetime) -> dict:
    """Build the normalized item dict used everywhere downstream."""
    pub = _sane(published, now)
    canonical = canonicalize_url(url)
    return {
        "id": hashlib.sha1(canonical.encode()).hexdigest()[:12],
        "title": clean_text(title, 400),
        "url": url,
        "canonical_url": canonical,
        "source": source,
        "section": section,
        "feed_section": section,
        "published_at": (pub or now).isoformat(timespec="seconds"),
        "date_estimated": pub is None,
        "summary": clean_text(summary),
        "matched_keywords": [],
        "topic_tags": [],
        "ai_summary": None,
        "cluster_id": None,
        "also_covered_by": [],
        "from_dedicated_feed": False,
    }


def parse_feed(body: bytes, *, source: str, section: str, now: datetime) -> list[dict]:
    """Parse an RSS or Atom document. Raises ValueError if nothing usable came out."""
    parsed = feedparser.parse(body)
    if not parsed.entries:
        reason = getattr(parsed, "bozo_exception", None) or "no entries"
        raise ValueError(f"unparseable feed: {reason}")
    items = []
    for e in parsed.entries:
        title, link = e.get("title"), e.get("link")
        if not title or not link:
            continue
        struct = e.get("published_parsed") or e.get("updated_parsed")
        published = datetime.fromtimestamp(calendar.timegm(struct), timezone.utc) if struct else None
        src = source
        if "news.google.com" in link:
            link = resolve_gnews(link)
            publisher = (e.get("source") or {}).get("title")
            if publisher:
                src = publisher
                title = re.sub(rf"\s+-\s+{re.escape(publisher)}\s*$", "", title)
        summary = e.get("summary") or e.get("description") or ""
        if clean_text(summary) == clean_text(title):  # Google News repeats the title as summary
            summary = ""
        items.append(make_item(title=title, url=link, source=src, section=section,
                               published=published, summary=summary, now=now))
    return items


def parse_html(body: bytes, *, base_url: str, selectors: dict, source: str, section: str,
               now: datetime) -> list[dict]:
    """Scrape headline cards from a feedless page using configured CSS selectors."""
    tree = HTMLParser(body)
    items = []
    for node in tree.css(selectors["container"]):
        t = node.css_first(selectors.get("title", "a"))
        a = node.css_first(selectors.get("link", "a"))
        href = a.attributes.get("href") if a else None
        if not t or not href:
            continue
        d = node.css_first(selectors["date"]) if selectors.get("date") else None
        date_text = (d.attributes.get("datetime") or d.text()) if d else None
        s = node.css_first(selectors["summary"]) if selectors.get("summary") else None
        url = urljoin(base_url, href)
        published = parse_date_text(date_text)
        if published is None and (m := _URL_DATE.search(url)):  # /2026/09/30/ in the link
            published = datetime(*map(int, m.groups()), 12, tzinfo=timezone.utc)
        items.append(make_item(title=t.text(), url=url, source=source, section=section,
                               published=published, summary=s.text() if s else "", now=now))
    if not items:
        raise ValueError("no items matched the configured selectors")
    return items


def parse_result(res, now: datetime) -> None:
    """Fill res.items from res.body. Parse errors are recorded on the result, never raised."""
    if not res.ok:
        return
    feed = res.feed
    try:
        if feed.get("type") == "html":
            res.items = parse_html(res.body, base_url=feed["url"], selectors=feed["selectors"],
                                   source=feed["name"], section=res.section, now=now)
        else:
            res.items = parse_feed(res.body, source=feed["name"], section=res.section, now=now)
        for it in res.items:
            it["from_dedicated_feed"] = feed.get("require_keyword_match", True) is False
    except Exception as e:  # noqa: BLE001 - isolate per feed
        res.error = f"parse: {e}"[:200]
        res.items = []
        log.warning("parse_failed name=%r error=%r", feed["name"], res.error)
