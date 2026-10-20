"""Rebuild the mega-cap list in config.yaml from current market caps.

    python scripts/refresh_megacaps.py           # refresh if the list is 28+ days old
    python scripts/refresh_megacaps.py --force   # refresh now

S&P 500 members come from Wikipedia's constituents table; market cap = shares outstanding x price (yfinance).
Only the text between the two `mega-caps` marker comments in config.yaml is rewritten, so the rest of the
file (and its comments) stays exactly as you wrote it.
"""
from __future__ import annotations

import re
import sys
from datetime import date
from pathlib import Path

import httpx
import yaml
from selectolax.parser import HTMLParser

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config.yaml"
START = "  # --- mega-caps: rebuilt monthly by scripts/refresh_megacaps.py; edit freely, the next refresh rewrites this block ---"
END = "  # --- end mega-caps ---"
WIKI = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"


def sp500(user_agent: str) -> list[dict]:
    """[{t, name, sector}] for every S&P 500 member (Yahoo-style tickers: BRK.B -> BRK-B)."""
    html = httpx.get(WIKI, headers={"User-Agent": user_agent}, timeout=30).text
    rows = HTMLParser(html).css_first("table#constituents").css("tbody tr")
    out = []
    for tr in rows:
        cells = [td.text(strip=True) for td in tr.css("td")]
        if len(cells) >= 3:
            out.append({"t": cells[0].replace(".", "-"), "name": cells[1], "sector": cells[2]})
    return out


def render_block(rows: list[dict], refreshed: str) -> str:
    def q(s: str) -> str:
        return '"' + s.replace('"', "'") + '"'
    lines = [START, f'  megacaps_refreshed: "{refreshed}"', "  megacaps:"]
    lines += [f"    - {{ t: {r['t']}, name: {q(r['name'])}, sector: {q(r['sector'])}, shares: {r['shares']:.4g} }}" for r in rows]
    return "\n".join(lines + [END])


def main(force: bool = False) -> int:
    text = CONFIG.read_text("utf-8")
    cfg = yaml.safe_load(text)
    m = cfg.get("markets") or {}
    last = m.get("megacaps_refreshed")
    if not force and last and (date.today() - date.fromisoformat(str(last))).days < 28:
        print(f"Mega-cap list refreshed {last}; nothing to do.")
        return 0
    import yfinance as yf  # imported late: only needed when actually refreshing

    yf.set_tz_cache_location(str(ROOT / ".cache" / "yf"))
    floor = float(m.get("megacap_min_cap", 200e9))
    members = sp500(cfg.get("user_agent", "DailyBriefingBot/1.0"))
    # ponytail: one fast_info call per member (~500, once a month); a paid bulk-quote API would do it in one call
    kept = []
    for row in members:
        try:
            fi = yf.Ticker(row["t"]).fast_info
            shares, price = fi["shares"], fi["last_price"]
            if shares and price and shares * price >= floor:
                kept.append({**row, "name": clean_name(row["name"]), "shares": float(shares), "cap": shares * price})
        except Exception as e:  # noqa: BLE001 - one bad ticker must not stop the refresh
            print(f"skip {row['t']}: {type(e).__name__}")
    if len(kept) < 5:
        print("Too few mega-caps found; keeping the existing list.")
        return 1
    kept.sort(key=lambda r: -r["cap"])
    block = render_block(kept, date.today().isoformat())
    pattern = re.compile(re.escape(START) + r".*?" + re.escape(END), re.S)
    if not pattern.search(text):
        print("Marker comments not found in config.yaml; nothing written.")
        return 1
    CONFIG.write_text(pattern.sub(lambda _: block, text), "utf-8", newline="\n")
    print(f"Wrote {len(kept)} mega-caps (>= ${floor / 1e9:.0f}B).")
    return 0


_SUFFIX = re.compile(r"(?:,?\s+(?:Inc\.?|Incorporated|Corporation|Corp\.?|Company|Co\.?|Ltd\.?|plc|PLC|N\.V\.|Holdings?|Group|"
                     r"Class [A-C])|\s*\(Class [A-C]\))$")


def clean_name(name: str) -> str:
    """'Apple Inc.' -> 'Apple', 'Alphabet Inc. (Class A)' -> 'Alphabet'."""
    prev = None
    while prev != name:
        prev, name = name, _SUFFIX.sub("", name).strip()
        name = re.sub(r"\s*\(The\)$", "", name).rstrip(" &")  # 'Home Depot (The)', 'Merck & Co.'
        if m := re.fullmatch(r"(.+?) \(([^)]+)\)", name):  # 'Lilly (Eli)' -> 'Eli Lilly'
            name = f"{m[2]} {m[1]}"
    return name


if __name__ == "__main__":
    sys.exit(main(force="--force" in sys.argv))
