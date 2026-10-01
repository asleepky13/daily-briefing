"""Previous-close market snapshot: Yahoo Finance chart API (indexes, commodities, crypto) and Bank of Canada (FX).

Both are free and keyless. Yahoo's endpoint is unofficial and may change; every symbol fails independently.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import httpx

log = logging.getLogger("markets")

YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/{}"
BOC = "https://www.bankofcanada.ca/valet/observations/{}/json"


async def _yahoo(client: httpx.AsyncClient, name: str, symbol: str) -> dict:
    r = await client.get(YAHOO.format(symbol), params={"range": "7d", "interval": "1d"})
    r.raise_for_status()
    res = r.json()["chart"]["result"][0]
    closes = [c for c in res["indicators"]["quote"][0]["close"] if c is not None]
    if len(closes) < 2:
        raise ValueError("not enough closes")
    meta = res["meta"]
    return {"name": name, "symbol": symbol, "price": closes[-1], "prev": closes[-2], "closes": closes[-6:],
            "currency": meta.get("currency"),
            "as_of": datetime.fromtimestamp(meta["regularMarketTime"], timezone.utc).isoformat(timespec="minutes")}


async def _boc(client: httpx.AsyncClient, name: str, series: str) -> dict:
    r = await client.get(BOC.format(series), params={"recent": 6})
    r.raise_for_status()
    obs = r.json()["observations"]  # newest first
    closes = [float(o[series]["v"]) for o in reversed(obs)]
    if len(closes) < 2:
        raise ValueError("not enough observations")
    return {"name": name, "symbol": series, "price": closes[-1], "prev": closes[-2], "closes": closes,
            "currency": "CAD", "as_of": obs[0]["d"]}


async def _snapshot(symbols: list[dict], user_agent: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=10, headers={"User-Agent": user_agent}) as client:
        async def one(s: dict) -> dict | None:
            try:
                q = await (_boc(client, s["name"], s["boc"]) if "boc" in s else _yahoo(client, s["name"], s["yahoo"]))
                q["change_pct"] = round((q["price"] - q["prev"]) / q["prev"] * 100, 2)
                return q
            except Exception as e:  # noqa: BLE001 - one quote must not break the run
                log.warning("quote_failed name=%r error=%r", s.get("name"), f"{type(e).__name__}: {e}"[:120])
                return None
        return [q for q in await asyncio.gather(*(one(s) for s in symbols)) if q]


def snapshot(config: dict) -> list[dict]:
    """Fetch the configured quotes; [] when disabled or everything fails."""
    m = config.get("markets") or {}
    if not m.get("enabled"):
        return []
    return asyncio.run(_snapshot(m.get("symbols", []), config.get("user_agent", "DailyBriefingBot/1.0")))
