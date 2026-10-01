"""Async feed fetching: retries, per-domain rate limit, robots.txt, ETag/Last-Modified cache."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote_plus, urlsplit
from urllib.robotparser import RobotFileParser

import httpx

log = logging.getLogger("fetch")

TIMEOUT = 10.0
RETRIES = 3
MIN_DOMAIN_INTERVAL = 1.0  # seconds between requests to the same host
CACHE_DIR = Path(".cache/http")


@dataclass
class FetchResult:
    """Outcome of fetching one configured feed."""
    feed: dict
    section: str
    body: bytes | None = None
    status: int | None = None
    error: str | None = None
    from_cache: bool = False
    elapsed: float = 0.0
    items: list = field(default_factory=list)  # filled by parse stage

    @property
    def ok(self) -> bool:
        return self.body is not None and self.error is None


def gnews_url(query: str) -> str:
    """Build a Google News RSS search URL (Canadian English edition)."""
    return f"https://news.google.com/rss/search?q={quote_plus(query)}&hl=en-CA&gl=CA&ceid=CA:en"


def expand_feeds(config: dict) -> list[tuple[str, dict]]:
    """Return (section_key, feed) pairs for enabled sections, with region placeholders and Google News queries resolved."""
    region = config.get("region", {})
    out = []
    for key, sec in config["sections"].items():
        if not sec.get("enabled", True):
            continue
        for feed in sec.get("feeds", []):
            f = dict(feed)
            f["name"] = f["name"].format(**region)
            if "query" in f:
                f["url"] = gnews_url(f["query"].format(**region))
                f.setdefault("type", "rss")
            out.append((key, f))
    return out


class _Cache:
    """ETag/Last-Modified cache. Bodies are kept so a 304 still yields items still inside the recency window."""

    def __init__(self, root: Path = CACHE_DIR):
        self.root = root
        self.meta_path = root / "meta.json"
        try:
            self.meta: dict = json.loads(self.meta_path.read_text("utf-8"))
        except (OSError, ValueError):
            self.meta = {}

    def _body_path(self, url: str) -> Path:
        return self.root / (hashlib.sha1(url.encode()).hexdigest() + ".bin")

    def headers(self, url: str) -> dict:
        m = self.meta.get(url, {})
        if not self._body_path(url).exists():
            return {}
        h = {}
        if m.get("etag"):
            h["If-None-Match"] = m["etag"]
        if m.get("last_modified"):
            h["If-Modified-Since"] = m["last_modified"]
        return h

    def body(self, url: str) -> bytes | None:
        try:
            return self._body_path(url).read_bytes()
        except OSError:
            return None

    def store(self, url: str, resp: httpx.Response) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self._body_path(url).write_bytes(resp.content)
        self.meta[url] = {"etag": resp.headers.get("etag"), "last_modified": resp.headers.get("last-modified")}

    def save(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.meta_path.write_text(json.dumps(self.meta, indent=1), "utf-8")


class Fetcher:
    """Shared HTTP client with per-domain politeness."""

    def __init__(self, user_agent: str, use_cache: bool = True):
        self.client = httpx.AsyncClient(
            timeout=TIMEOUT, follow_redirects=True,
            headers={"User-Agent": user_agent, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5"},
        )
        self.user_agent = user_agent
        self.cache = _Cache() if use_cache else None
        self._locks: dict[str, asyncio.Lock] = {}
        self._last: dict[str, float] = {}
        self._robots: dict[str, RobotFileParser | None] = {}

    async def _polite(self, host: str):
        """Hold the host lock and wait so requests to one host are ≥ MIN_DOMAIN_INTERVAL apart."""
        lock = self._locks.setdefault(host, asyncio.Lock())
        await lock.acquire()
        wait = self._last.get(host, 0) + MIN_DOMAIN_INTERVAL - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        return lock

    async def get(self, url: str, headers: dict | None = None) -> httpx.Response:
        """GET with retries and exponential backoff (1s, 2s, 4s) on network errors and 5xx/429."""
        host = urlsplit(url).netloc
        for attempt in range(RETRIES + 1):
            lock = await self._polite(host)
            try:
                resp = await self.client.get(url, headers=headers or {})
            except httpx.HTTPError as e:
                resp, err = None, e
            finally:
                self._last[host] = time.monotonic()
                lock.release()
            if resp is not None and resp.status_code < 500 and resp.status_code != 429:
                return resp
            if attempt == RETRIES:
                if resp is not None:
                    return resp
                raise err
            await asyncio.sleep(2 ** attempt)
        raise RuntimeError("unreachable")

    async def allowed(self, url: str) -> bool:
        """Check robots.txt (used for HTML scraping). Missing/unreadable robots.txt means allowed."""
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            rp = None
            try:
                r = await self.get(origin + "/robots.txt")
                if r.status_code == 200:
                    rp = RobotFileParser()
                    rp.parse(r.text.splitlines())
            except httpx.HTTPError:
                pass
            self._robots[origin] = rp
        rp = self._robots[origin]
        return rp is None or rp.can_fetch(self.user_agent, url)

    async def fetch_feed(self, section: str, feed: dict) -> FetchResult:
        """Fetch one feed. Never raises: errors are recorded on the result."""
        res = FetchResult(feed=feed, section=section)
        url = feed["url"]
        t0 = time.monotonic()
        try:
            if feed.get("type") == "html" and not await self.allowed(url):
                res.error = "blocked by robots.txt"
                return res
            resp = await self.get(url, self.cache.headers(url) if self.cache else None)
            res.status = resp.status_code
            if resp.status_code == 304 and self.cache and (cached := self.cache.body(url)) is not None:
                res.body, res.from_cache = cached, True
            elif resp.status_code == 200:
                res.body = resp.content
                if self.cache:
                    self.cache.store(url, resp)
            else:
                res.error = f"HTTP {resp.status_code}"
        except Exception as e:  # noqa: BLE001 - one feed must never stop the run
            res.error = f"{type(e).__name__}: {e}"[:200]
        finally:
            res.elapsed = round(time.monotonic() - t0, 2)
        if res.error:
            log.warning("feed_failed name=%r error=%r", feed["name"], res.error)
        return res

    async def close(self) -> None:
        await self.client.aclose()
        if self.cache:
            self.cache.save()


async def fetch_all(config: dict, use_cache: bool = True) -> list[FetchResult]:
    """Fetch every enabled feed concurrently."""
    fetcher = Fetcher(config.get("user_agent", "DailyBriefingBot/1.0"), use_cache)
    try:
        return await asyncio.gather(*(fetcher.fetch_feed(s, f) for s, f in expand_feeds(config)))
    finally:
        await fetcher.close()
