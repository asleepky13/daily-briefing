"""Market Minute: a 60-second stock-market recap built from free, keyless Yahoo Finance data (via yfinance).

One run = detect the NYSE session state, fetch quotes in two batched downloads, validate them, update a one-year
close history (streaks, week-to-date, year-to-date), rank mega-cap movers, match them to today's headlines, and
write the 60-second take from templates. If the fetch fails, the last good snapshot is kept and marked stale.
Every sentence is computed from the numbers; nothing is predicted or recommended.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

log = logging.getLogger("markets")

ET = ZoneInfo("America/New_York")  # Toronto keeps the same clock
DIR = Path(__file__).resolve().parent.parent / "data" / "markets"
RETENTION_DAYS = 90
MAX_TAKE = 6
MINUS = "−"


# ── session ─────────────────────────────────────────────────────────────────────────────
_CAL = None


def calendar():
    """NYSE calendar (holidays and early closes), loaded once."""
    global _CAL
    if _CAL is None:
        import exchange_calendars as xc
        _CAL = xc.get_calendar("XNYS")
    return _CAL


def fmt_clock(dt: datetime) -> str:
    """'9:30 AM' without platform-specific strftime flags."""
    et = dt.astimezone(ET)
    return f"{et.hour % 12 or 12}:{et.minute:02d} {'AM' if et.hour < 12 else 'PM'}"


def market_state(now: datetime, cal=None) -> dict:
    """Where the NYSE is relative to `now`.

    kind: premarket (session day, 4:00 AM to the open), open, after_close (session day, after the close),
          overnight (session day before 4:00 AM), closed (weekend or holiday).
    session: the latest session whose numbers the dashboard reports (today while open or after the close).
    """
    import pandas as pd

    cal = cal or calendar()
    now = now.astimezone(timezone.utc)
    et = now.astimezone(ET)
    day = pd.Timestamp(et.date())
    is_session = cal.is_session(day)
    early = False
    if is_session:
        open_, close = cal.session_open(day), cal.session_close(day)
        early = close.astimezone(ET).hour < 16
        if now >= close:
            kind = "after_close"
        elif now >= open_:
            kind = "open"
        else:
            kind = "premarket" if et.hour >= 4 else "overnight"
        session = day if kind in ("open", "after_close") else cal.previous_session(day)
    else:
        kind = "closed"
        session = cal.date_to_session(day, "previous")
    nxt = cal.next_open(pd.Timestamp(now)).to_pydatetime()
    next_label = f"{nxt.astimezone(ET).strftime('%a')} {fmt_clock(nxt)} ET"
    reason = "weekend" if et.weekday() >= 5 else ("holiday" if not is_session else "")
    labels = {
        "premarket": "Pre-market",
        "open": f"As of {fmt_clock(now - timedelta(minutes=15))} ET",
        "after_close": "Closing recap" + (f" (early close at {fmt_clock(cal.session_close(day))} ET)" if early else ""),
        "overnight": "Markets closed",
        "closed": "Markets closed",
    }
    note = f"Markets closed: next open {next_label}" if kind in ("overnight", "closed", "premarket", "after_close") else ""
    if kind == "closed" and reason == "holiday":
        note = f"Markets closed for a holiday: next open {next_label}"
    return {"kind": kind, "label": labels[kind], "note": note, "session": session.date().isoformat(),
            "early_close": early, "reason": reason, "next_open": nxt.isoformat()}


# ── fetch (batched yfinance, Stooq fallback) ──────────────────────────────────────────────
def _yf():
    import yfinance as yf
    yf.set_tz_cache_location(str(DIR.parent.parent / ".cache" / "yf"))  # private cache: avoids sqlite lock errors
    return yf


def _frame_to_series(df, tickers) -> dict[str, list[tuple[str, float]]]:
    """yfinance multi-ticker frame -> {ticker: [(iso date or datetime, close), ...]} without NaNs."""
    out = {}
    for t in tickers:
        try:
            col = df[t]["Close"] if len(tickers) > 1 or t in df.columns.get_level_values(0) else df["Close"]
        except (KeyError, TypeError):
            continue
        s = col.dropna()
        pts = [(ix.isoformat(), float(v)) for ix, v in s.items() if v > 0]
        if pts:
            out[t] = pts
    return out


def fetch_yahoo(tickers: list[str], period: str, interval: str) -> dict[str, list[tuple[str, float]]]:
    """One batched download for all tickers."""
    yf = _yf()
    df = yf.download(tickers, period=period, interval=interval, group_by="ticker", auto_adjust=False,
                     progress=False, threads=False)  # threads=False: yfinance's cache locks under parallel use
    return _frame_to_series(df, tickers) if df is not None and not df.empty else {}


STOOQ = "https://stooq.com/q/l/?s={}&f=sd2t2c&h&e=csv"
_STOOQ_INDEX = {"^GSPC": "^spx", "^DJI": "^dji", "^IXIC": "^ndq"}


def stooq_symbol(t: str) -> str | None:
    """Stooq covers US indices, stocks and ETFs; futures, FX, yields and crypto aren't mapped."""
    if t in _STOOQ_INDEX:
        return _STOOQ_INDEX[t]
    return None if re.search(r"[\^=]|-USD$|\.", t) else t.lower().replace("-", ".") + ".us"


def fetch_stooq(tickers: list[str], history: dict, user_agent: str) -> dict[str, list[tuple[str, float]]]:
    """Latest close per ticker; the previous close comes from stored history (so only history-tracked symbols get a %)."""
    out = {}
    with httpx.Client(timeout=10, headers={"User-Agent": user_agent}) as client:
        for t in tickers:
            sym, past = stooq_symbol(t), history.get(t)
            if not sym or not past:
                continue
            try:
                row = client.get(STOOQ.format(sym)).text.strip().splitlines()[-1].split(",")
                d, close = row[1], float(row[3])
                prev = [(k, v) for k, v in sorted(past.items()) if k < d]
                if prev and close > 0:
                    out[t] = [prev[-1], (d, close)]
            except (httpx.HTTPError, ValueError, IndexError):
                continue
    return out


# ── validation ───────────────────────────────────────────────────────────────────────────
def validate(t: str, kind: str, pts: list[tuple[str, float]], session: str) -> dict | None:
    """Quote from a close series, or None (logged) if null, stale or absurd."""
    pts = [(d, v) for d, v in pts if v and v > 0]
    if len(pts) < 2:
        log.warning("quote_dropped t=%s reason=missing", t)
        return None
    (d0, prev), (d1, last) = pts[-2], pts[-1]
    if kind in ("index", "sector", "stock") and d1[:10] < session:
        log.warning("quote_dropped t=%s reason=stale last=%s session=%s", t, d1[:10], session)
        return None
    pct = (last - prev) / prev * 100
    if kind in ("index", "sector") and abs(pct) > 25:
        log.warning("quote_dropped t=%s reason=absurd pct=%.1f", t, pct)
        return None
    return {"t": t, "price": round(last, 4), "prev": round(prev, 4), "chg": round(last - prev, 4),
            "pct": round(pct, 3), "date": d1[:10], "closes": [round(v, 4) for _, v in pts[-6:]]}


# ── history: one year of daily closes for indices and sectors ───────────────────────────
def load_json(path: Path, default):
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return default


def update_history(history: dict, series: dict, session: str, today: date) -> dict:
    """Merge completed-session closes (on or before `session`) and drop anything older than a year."""
    cutoff = (today - timedelta(days=366)).isoformat()
    for t, pts in series.items():
        h = history.setdefault(t, {})
        for d, v in pts:
            if d[:10] <= session:
                h[d[:10]] = round(v, 4)
        for d in [d for d in h if d < cutoff]:
            del h[d]
    return history


def period_change(history: dict, price: float, session: str, kind: str) -> float | None:
    """Week-to-date ('wtd') or year-to-date ('ytd') % change, from the last close before the period started."""
    s = date.fromisoformat(session)
    start = (s - timedelta(days=s.weekday())).isoformat() if kind == "wtd" else f"{s.year}-01-01"
    before = [v for d, v in sorted(history.items()) if d < start]
    return round((price - before[-1]) / before[-1] * 100, 2) if before else None


def streak(history: dict, live: tuple[str, float] | None = None) -> int:
    """Consecutive up (+n) or down (-n) closes ending at the latest one (optionally today's live price)."""
    pts = sorted(history.items())
    if live and (not pts or live[0] > pts[-1][0]):
        pts.append(live)
    n = 0
    for (_, a), (_, b) in zip(reversed(pts[:-1]), reversed(pts[1:])):
        step = 1 if b > a else -1 if b < a else 0
        if step == 0 or (n and (step > 0) != (n > 0)):
            break
        n += step
    return n


# ── mega-caps: universe, movers, breadth, "why it moved" ────────────────────────────────
def megacap_quotes(universe: list[dict], quotes: dict, min_cap: float) -> list[dict]:
    """Mega-caps with a valid quote and market cap (shares x price) at or above the threshold."""
    out = []
    for c in universe:
        q = quotes.get(c["t"])
        if not q:
            continue
        cap = float(c.get("shares", 0)) * q["price"]
        if cap >= min_cap:
            out.append({**q, "name": c["name"], "sector": c.get("sector", ""), "cap": round(cap)})
    return out


def rank_movers(rows: list[dict], n: int) -> dict:
    ranked = sorted(rows, key=lambda r: r["pct"], reverse=True)
    return {"gainers": [r for r in ranked if r["pct"] > 0][:n],
            "losers": [r for r in reversed(ranked) if r["pct"] < 0][:n]}


def breadth(rows: list[dict]) -> dict:
    return {"adv": sum(r["pct"] > 0 for r in rows), "dec": sum(r["pct"] < 0 for r in rows),
            "unch": sum(r["pct"] == 0 for r in rows)}


def match_headline(ticker: str, name: str, items: list[dict], aliases: list[str] = ()) -> dict | None:
    """Best headline about this company, or None. Never guesses.

    Matches the company name (or a configured alias) as a whole, case-sensitive word, '$TICKER', or an exchange
    tag like '(NASDAQ: AAPL)'. A bare ticker is never matched, so 'F' and 'T' can't hit ordinary words. The match
    must start in the title's first 3 words, where a headline's subject sits: '3M jumps on Amazon deal' is about 3M.
    """
    t = re.escape(ticker.replace("-", "."))
    pats = [re.compile(rf"(?<![\w$])\${t}(?![\w])"), re.compile(rf"\((?:NYSE|NASDAQ|Nasdaq|NasdaqGS|NYSEArca)\s*:\s*{t}\)")]
    pats += [re.compile(rf"(?<![\w&]){re.escape(n)}(?!\w)") for n in [name, *aliases] if len(n) >= 3]
    hits = []
    for it in items:
        words = it["title"].split()
        lead = len(" ".join(words[:3]))  # a match must begin inside the first three words
        if any((m := p.search(it["title"])) and m.start() < lead for p in pats):
            hits.append(it)
    if not hits:
        return None
    best = max(hits, key=lambda it: it["published_at"])
    return {"title": best["title"], "url": best["url"], "source": best["source"]}


# ── the 60-second take ──────────────────────────────────────────────────────────────────
ORD = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"]


def magnitude(pct: float) -> str:
    """Thresholds from the brief: <0.25% flat, <0.75% slightly, <1.5% solidly, else sharply."""
    a = abs(pct)
    return "flat" if a < 0.25 else "slightly" if a < 0.75 else "solidly" if a < 1.5 else "sharply"


def stock_verb(pct: float, live: bool) -> str:
    """>= 3% is surged/plunged; smaller moves get a magnitude word."""
    if abs(pct) >= 3:
        return ("is surging" if live else "surged") if pct > 0 else ("is plunging" if live else "plunged")
    m = magnitude(pct)
    if m == "flat":
        return "is little changed" if live else "was little changed"
    return f"is {m} {'higher' if pct > 0 else 'lower'}" if live else f"{'rose' if pct > 0 else 'fell'} {m}"


def ordinal(n: int) -> str:
    return ORD[n] if n < len(ORD) else f"{n}th"


def _pick(seed: str, key: str, options: list[str]) -> str:
    """Deterministic by date: the same day always reads the same, different days read differently."""
    return options[int(hashlib.md5(f"{seed}:{key}".encode()).hexdigest(), 16) % len(options)]


def p(x: float) -> str:
    return f"{abs(x):.2f}%"


def write_take(snap: dict, seed: str) -> list[str]:
    """4-6 factual sentences from the snapshot. A sentence whose inputs are missing is skipped, never mentioned."""
    kind = snap["state"]["kind"]
    live = kind == "open"
    out = []
    idx = {i["t"]: i for i in snap.get("indices", [])}
    fut = {f["t"]: f for f in snap.get("futures", [])}
    sp, es = idx.get("^GSPC"), fut.get("ES=F")

    def futures_line():
        if not es:
            return None
        m = magnitude(es["pct"])
        if m == "flat":
            return _pick(seed, "fut", ["Futures point to a flat open, with S&P 500 futures little changed.",
                                        "S&P 500 futures are little changed, pointing to a quiet open."])
        d = "higher" if es["pct"] > 0 else "lower"
        return _pick(seed, "fut", [f"Futures point to a {d} open: S&P 500 futures are {m} {'up' if es['pct'] > 0 else 'down'}, {p(es['pct'])}.",
                                   f"S&P 500 futures are {m} {d}, {p(es['pct'])}, pointing to a {d} open."])

    if kind == "premarket" and (line := futures_line()):
        out.append(line)
    if sp:
        m, up = magnitude(sp["pct"]), sp["pct"] > 0
        st = sp.get("streak", 0)
        streak_txt = ""
        if abs(st) >= 2 and (st > 0) == up and m != "flat":
            word = f"{ordinal(abs(st))} straight {'gain' if up else 'loss'}"
            streak_txt = f", on track for its {word}" if live else f", its {word}"
        if m == "flat":
            move = "is little changed" if live else "ended little changed"
            out.append(_pick(seed, "dir", [f"The S&P 500 {move} at {sp['price']:,.2f}.",
                                           f"A quiet session{' so far' if live else ''}: the S&P 500 {move}."]))
        else:
            d = "higher" if up else "lower"
            move = f"is trading {m} {d}" if live else f"closed {m} {d}"
            out.append(_pick(seed, "dir", [
                f"The S&P 500 {move}, {'up' if up else 'down'} {p(sp['pct'])}{streak_txt}.",
                f"Stocks {'are' if live else 'were'} {'up' if up else 'down'} as the S&P 500 {move} ({p(sp['pct'])}){streak_txt}.",
                f"It {'is' if live else 'was'} a {'green' if up else 'red'} session{' so far' if live else ''}: the S&P 500 {move}, {p(sp['pct'])}{streak_txt}.",
            ]))
    if len(idx) >= 2:
        ranked = sorted(idx.values(), key=lambda i: i["pct"], reverse=True)
        lead, lag = ranked[0], ranked[-1]
        if lead["pct"] != lag["pct"]:
            sg = lambda x: f"{'+' if x >= 0 else MINUS}{p(x)}"
            out.append(_pick(seed, "idx", [
                f"The {lead['name']} led the major indexes ({sg(lead['pct'])}) while the {lag['name']} lagged ({sg(lag['pct'])}).",
                f"Among the majors, the {lead['name']} did best at {sg(lead['pct'])} and the {lag['name']} trailed at {sg(lag['pct'])}.",
                f"Leading: the {lead['name']}, {sg(lead['pct'])}. Lagging: the {lag['name']}, {sg(lag['pct'])}.",
            ]))
    secs = snap.get("sectors", [])
    if len(secs) >= 2:
        best, worst = secs[0], secs[-1]
        sg = lambda x: f"{'+' if x >= 0 else MINUS}{p(x)}"
        out.append(_pick(seed, "sec", [
            f"{best['name']} was the top sector ({sg(best['pct'])}) and {worst['name']} the weakest ({sg(worst['pct'])}).",
            f"By sector, {best['name']} led at {sg(best['pct'])} while {worst['name']} lagged at {sg(worst['pct'])}.",
            f"{best['name']} stocks outperformed ({sg(best['pct'])}); {worst['name']} underperformed ({sg(worst['pct'])}).",
        ]))
    movers = snap.get("movers", {})
    pool = movers.get("gainers", []) + movers.get("losers", [])
    if pool:
        top = max(pool, key=lambda r: abs(r["pct"]))
        v = stock_verb(top["pct"], live)
        amount = "" if "little changed" in v else f" {p(top['pct'])}"
        out.append(_pick(seed, "mega", [
            f"Among the giants, {top['name']} {v}{amount}.",
            f"The biggest mega-cap move: {top['name']}, which {v}{amount}.",
            f"{top['name']} {v}{amount}, the largest move among mega-caps.",
        ]))
    macro = {m["t"]: m for m in snap.get("macro", [])}
    went = lambda x: ("is up" if x > 0 else "is down") if live else ("rose" if x > 0 else "fell")
    cands = []  # (how notable, sentence): VIX moves of 5%, 5 bp in the 10-year and 2% in oil count as equally notable
    if (v := macro.get("^VIX")):
        cands.append((abs(v["pct"]) / 5, f"The VIX, Wall Street's fear gauge, {went(v['pct'])} {p(v['pct'])} at {v['price']:.2f}."))
    if (y := macro.get("^TNX")):
        bps = round(y["chg"] * 100)
        cands.append((abs(bps) / 5, f"The 10-year Treasury yield {went(bps)} {abs(bps)} basis points at {y['price']:.2f}%."
                      if bps else f"The 10-year Treasury yield {'is' if live else 'was'} unchanged at {y['price']:.2f}%."))
    if (o := macro.get("CL=F")):
        cands.append((abs(o["pct"]) / 2, f"WTI crude {went(o['pct'])} {p(o['pct'])} at ${o['price']:.2f} a barrel."))
    if cands:
        out.append(max(cands, key=lambda c: c[0])[1])
    if kind in ("closed", "overnight") and (line := futures_line()):
        out.append(line)
    return out[:MAX_TAKE]


# ── build one snapshot ─────────────────────────────────────────────────────────────────
def _spark(pts: list[tuple[str, float]], n: int = 60) -> list[float]:
    vals = [v for _, v in pts]
    step = max(1, len(vals) // n)
    out = vals[::step]
    if vals and out[-1] != vals[-1]:
        out.append(vals[-1])
    return [round(v, 2) for v in out]


def build(config: dict, now: datetime, headlines: list[dict], fetch=fetch_yahoo, previous: dict | None = None) -> dict | None:
    """Fetch, validate and assemble the Market Minute. On failure returns the previous snapshot marked stale (or None)."""
    m = config.get("markets") or {}
    if not m.get("enabled", True):
        return None
    state = market_state(now)
    session = state["session"]
    groups = {"index": m.get("indices", []), "future": m.get("futures", []), "sector": m.get("sectors", []),
              "macro": m.get("macro", []), "canada": m.get("canada", []) if m.get("canada_enabled") else []}
    universe = m.get("megacaps", [])
    mag7 = m.get("magnificent7", [])
    stock_syms = list(dict.fromkeys([c["t"] for c in universe] + mag7))
    all_syms = list(dict.fromkeys([s["t"] for g in groups.values() for s in g] + stock_syms))
    history = load_json(DIR / "history.json", {})
    tracked = [s["t"] for s in groups["index"] + groups["sector"]]

    try:
        daily = fetch(all_syms, "1y" if len(history) < len(tracked) else "10d", "1d")
    except Exception as e:  # noqa: BLE001 - network or Yahoo change: fall through to Stooq / last good
        log.warning("yahoo_failed error=%r", f"{type(e).__name__}: {e}"[:160])
        daily = {}
    missing = [t for t in all_syms if t not in daily]
    if missing:
        daily.update(fetch_stooq(missing, history, config.get("user_agent", "DailyBriefingBot/1.0")))
    intraday = {}
    if state["kind"] == "open" and daily:
        try:
            intraday = fetch([s["t"] for s in groups["index"]], "1d", "5m")
        except Exception as e:  # noqa: BLE001 - sparklines fall back to 5-day
            log.warning("intraday_failed error=%r", str(e)[:120])

    kinds = {s["t"]: k for k, g in groups.items() for s in g} | {t: "stock" for t in stock_syms}
    quotes = {}
    for t, pts in daily.items():
        if (q := validate(t, kinds.get(t, "stock"), pts, session)):
            quotes[t] = q
    names = {s["t"]: s["name"] for g in groups.values() for s in g}

    if sum(s["t"] in quotes for s in groups["index"]) < 2:
        if previous:
            when = previous.get("generated_at", "")
            stale_time = datetime.fromisoformat(when).astimezone(ET) if when else None
            note = f"Market data as of {stale_time.strftime('%b')} {stale_time.day}, {fmt_clock(stale_time)} ET: refresh failed" if stale_time else "Market data refresh failed"
            log.error("markets_stale: kept the last good snapshot")
            return {**previous, "status": "stale", "stale_note": note}
        log.error("markets_failed: no data and no previous snapshot")
        return None

    history = update_history(history, {t: daily[t] for t in tracked if t in daily}, session, now.astimezone(ET).date())
    fetched_at = now.astimezone(timezone.utc).isoformat(timespec="minutes")

    def as_of(t: str) -> str:
        if t in intraday:
            return intraday[t][-1][0]
        if state["kind"] == "open":
            return (now - timedelta(minutes=15)).isoformat(timespec="minutes")
        return quotes[t]["date"]

    def row(t: str, kind: str) -> dict:
        q = quotes[t]
        r = {**{k: q[k] for k in ("t", "price", "chg", "pct", "closes")}, "name": names.get(t, t), "as_of": as_of(t)}
        if kind in ("index", "sector"):
            h = history.get(t, {})
            r["wtd"] = period_change(h, q["price"], session, "wtd")
            r["ytd"] = period_change(h, q["price"], session, "ytd")
            r["streak"] = streak(h, (q["date"], q["price"]))
        if kind == "index":
            r["spark"] = _spark(intraday[t]) if t in intraday else [round(v, 2) for v in q["closes"][-6:]]
            r["spark_kind"] = "intraday" if t in intraday else "5-day"
        return r

    snap = {"generated_at": fetched_at, "state": state, "status": "ok", "delayed_note": "Delayed ~15 min",
            "indices": [row(s["t"], "index") for s in groups["index"] if s["t"] in quotes],
            "futures": [row(s["t"], "future") for s in groups["future"] if s["t"] in quotes],
            "macro": [row(s["t"], "macro") | ({"kind": "yield", "bps": round(quotes[s["t"]]["chg"] * 100)} if s.get("kind") == "yield" else {})
                      for s in groups["macro"] if s["t"] in quotes],
            "canada": [row(s["t"], "canada") for s in groups["canada"] if s["t"] in quotes] or None}
    sp_pct = quotes["^GSPC"]["pct"] if "^GSPC" in quotes else 0.0
    snap["sectors"] = sorted(({**row(s["t"], "sector"), "rel": round(quotes[s["t"]]["pct"] - sp_pct, 2)}
                              for s in groups["sector"] if s["t"] in quotes), key=lambda r: r["pct"], reverse=True)
    megas = megacap_quotes(universe, quotes, float(m.get("megacap_min_cap", 200e9)))
    movers = rank_movers(megas, int(m.get("movers_count", 5)))
    aliases = m.get("aliases") or {}
    for r in movers["gainers"] + movers["losers"]:
        r["why"] = match_headline(r["t"], r["name"], headlines, aliases.get(r["t"], []))
        r.pop("closes", None)
    snap["movers"] = movers
    by_t = {r["t"]: r for r in megas}
    snap["mag7"] = [{"t": t, "pct": quotes[t]["pct"], "price": quotes[t]["price"]} for t in mag7 if t in quotes]
    snap["breadth"] = breadth(megas)
    snap["universe_size"] = len(by_t)
    snap["min_cap"] = float(m.get("megacap_min_cap", 200e9))
    snap["take"] = write_take(snap, session)
    snap["_history"] = history  # stripped by save()
    return snap


def header_board(snap: dict | None) -> list[dict]:
    """The small market strip in the site header, from the same snapshot."""
    if not snap:
        return []
    pick = [("^GSPC", "S&P 500"), ("^IXIC", "Nasdaq"), ("^DJI", "Dow"), ("CL=F", "Oil (WTI)"), ("BTC-USD", "Bitcoin")]
    rows = {r["t"]: r for r in snap.get("indices", []) + snap.get("macro", [])}
    return [{"name": n, "price": rows[t]["price"], "change_pct": round(rows[t]["pct"], 2), "closes": rows[t]["closes"],
             "as_of": rows[t]["as_of"]} for t, n in pick if t in rows]


def save(snap: dict | None, today: date) -> None:
    """latest.json every run; a dated closing recap per session; history.json; 90-day pruning of recaps."""
    if not snap:
        return
    DIR.mkdir(parents=True, exist_ok=True)
    history = snap.pop("_history", None)
    if history is not None:
        (DIR / "history.json").write_text(json.dumps(history, separators=(",", ":")), "utf-8")
    body = json.dumps(snap, ensure_ascii=False, separators=(",", ":"))
    (DIR / "latest.json").write_text(body, "utf-8")
    recap = DIR / f"{snap['state']['session']}.json"
    # the after-close run is the edition of record; any later run fills the gap if that one was missed
    if snap.get("status") == "ok" and snap["state"]["kind"] != "open" and (snap["state"]["kind"] == "after_close" or not recap.exists()):
        recap.write_text(body, "utf-8")
    cutoff = (today - timedelta(days=RETENTION_DAYS)).isoformat()
    for f in DIR.glob("20??-??-??.json"):
        if f.stem < cutoff:
            f.unlink()
