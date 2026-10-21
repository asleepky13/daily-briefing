"""Market Minute: session detection, the 60-second take, movers, headline matching, validation, fallbacks.
All offline: market data is faked, the NYSE calendar ships with exchange_calendars."""
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from pipeline import market_minute as mm

ET = ZoneInfo("America/New_York")


def at(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=ET)


# ── market state ────────────────────────────────────────
def test_holiday_thanksgiving():
    s = mm.market_state(at(2026, 11, 26, 10))
    assert s["kind"] == "closed" and s["reason"] == "holiday"
    assert s["session"] == "2026-11-25"
    assert "holiday" in s["note"] and "Fri 9:30 AM ET" in s["note"]


def test_early_close_day_after_thanksgiving():
    s = mm.market_state(at(2026, 11, 27, 14))  # NYSE closes at 1:00 PM
    assert s["kind"] == "after_close" and s["early_close"]
    assert "early close at 1:00 PM ET" in s["label"]
    assert mm.market_state(at(2026, 11, 27, 12))["kind"] == "open"


def test_weekend():
    s = mm.market_state(at(2026, 10, 17, 12))  # Saturday
    assert s["kind"] == "closed" and s["reason"] == "weekend"
    assert s["session"] == "2026-10-16"
    assert s["note"] == "Markets closed: next open Mon 9:30 AM ET"


@pytest.mark.parametrize("hour,kind,session", [
    (2, "overnight", "2026-10-16"),   # Monday 2 AM: last session was Friday
    (6, "premarket", "2026-10-16"),
    (10, "open", "2026-10-19"),
    (14, "open", "2026-10-19"),
    (18, "after_close", "2026-10-19"),
    (22, "after_close", "2026-10-19"),
])
def test_the_six_daily_runs(hour, kind, session):
    s = mm.market_state(at(2026, 10, 19, hour))
    assert (s["kind"], s["session"]) == (kind, session)
    if kind == "open":
        assert s["label"].startswith("As of ") and s["label"].endswith(" ET")


# ── the 60-second take ──────────────────────────────────
@pytest.mark.parametrize("pct,word", [(0.1, "flat"), (-0.24, "flat"), (0.5, "slightly"), (-1.2, "solidly"), (1.5, "sharply"), (-3, "sharply")])
def test_magnitude(pct, word):
    assert mm.magnitude(pct) == word


@pytest.mark.parametrize("pct,live,verb", [(3.2, False, "surged"), (-4, False, "plunged"), (1.0, False, "rose solidly"),
                                           (-0.5, False, "fell slightly"), (0.1, False, "was little changed"), (5, True, "is surging")])
def test_stock_verb(pct, live, verb):
    assert mm.stock_verb(pct, live) == verb


def snap(kind="after_close", sp=0.8, streak=3, **over):
    s = {
        "state": {"kind": kind},
        "indices": [{"t": "^GSPC", "name": "S&P 500", "price": 7000.0, "pct": sp, "streak": streak},
                    {"t": "^IXIC", "name": "Nasdaq", "price": 24000.0, "pct": 1.4, "streak": 1},
                    {"t": "^DJI", "name": "Dow Jones", "price": 50000.0, "pct": -0.3, "streak": -1}],
        "futures": [{"t": "ES=F", "pct": -0.6}],
        "sectors": [{"name": "Tech", "pct": 1.9}, {"name": "Energy", "pct": 0.2}, {"name": "Utilities", "pct": -1.1}],
        "movers": {"gainers": [{"name": "Nvidia", "pct": 4.2}], "losers": [{"name": "Visa", "pct": -1.0}]},
        "macro": [{"t": "^VIX", "price": 15.0, "pct": -2.0, "chg": -0.3}, {"t": "^TNX", "price": 4.21, "pct": 1.5, "chg": 0.07},
                  {"t": "CL=F", "price": 80.0, "pct": 0.5, "chg": 0.4}],
    }
    s.update(over)
    return s


def test_take_closing_recap():
    take = mm.write_take(snap(), "2026-10-19")
    text = " ".join(take)
    assert 4 <= len(take) <= 6
    assert "solidly higher" in text and "third straight gain" in text
    assert "Nasdaq" in text and "Dow Jones" in text          # leader and laggard
    assert "Tech" in text and "Utilities" in text            # best and worst sector
    assert "Nvidia surged 4.20%" in text                     # biggest mega-cap mover, 3%+ is "surged"
    assert "10-year Treasury yield rose 7 basis points" in text  # 7 bp beats a 2% VIX and a 0.5% oil move


def test_take_streak_only_when_direction_matches():
    assert "straight" not in " ".join(mm.write_take(snap(streak=-3), "2026-10-19"))
    assert "straight" not in " ".join(mm.write_take(snap(streak=1), "2026-10-19"))


def test_take_premarket_leads_with_futures():
    take = mm.write_take(snap(kind="premarket"), "2026-10-19")
    assert take[0].startswith(("Futures point to a lower open", "S&P 500 futures are")) and "lower" in take[0]


def test_take_live_uses_present_tense():
    text = " ".join(mm.write_take(snap(kind="open"), "2026-10-19"))
    assert "is trading solidly higher" in text and "on track for its third straight gain" in text and "is surging" in text


def test_take_never_mentions_missing_data():
    bare = {"state": {"kind": "after_close"}, "indices": [{"t": "^GSPC", "name": "S&P 500", "price": 7000.0, "pct": 0.1, "streak": 0}]}
    take = mm.write_take(bare, "2026-10-19")
    text = " ".join(take).lower()
    assert take == ["The S&P 500 ended little changed at 7,000.00."] or take == ["A quiet session: the S&P 500 ended little changed."]
    for word in ("none", "nan", "missing", "unavailable", "n/a", "no data"):
        assert word not in text


def test_take_varies_by_date_but_is_stable():
    a = mm.write_take(snap(), "2026-10-19")
    assert a == mm.write_take(snap(), "2026-10-19")
    assert any(mm.write_take(snap(), f"2026-10-{d:02d}") != a for d in range(1, 15))


# ── mega-caps, movers, breadth ──────────────────────────
UNIVERSE = [{"t": "AAA", "name": "Alpha", "sector": "Tech", "shares": 1e9}, {"t": "BBB", "name": "Beta", "sector": "Energy", "shares": 1e9},
            {"t": "SML", "name": "Small", "sector": "Tech", "shares": 1e6}, {"t": "CCC", "name": "Gamma", "sector": "Utilities", "shares": 2e9}]
QUOTES = {"AAA": {"t": "AAA", "price": 300.0, "pct": 2.5}, "BBB": {"t": "BBB", "price": 250.0, "pct": -1.5},
          "SML": {"t": "SML", "price": 50.0, "pct": 9.0}, "CCC": {"t": "CCC", "price": 120.0, "pct": 0.0}}


def test_megacap_filter_uses_shares_times_price():
    rows = mm.megacap_quotes(UNIVERSE, QUOTES, 200e9)
    assert [r["t"] for r in rows] == ["AAA", "BBB", "CCC"]  # SML: $50M cap, out despite the 9% move
    assert rows[0]["cap"] == 300e9


def test_rank_movers_and_breadth():
    rows = mm.megacap_quotes(UNIVERSE, QUOTES, 200e9)
    movers = mm.rank_movers(rows, 5)
    assert [r["t"] for r in movers["gainers"]] == ["AAA"] and [r["t"] for r in movers["losers"]] == ["BBB"]
    assert mm.breadth(rows) == {"adv": 1, "dec": 1, "unch": 1}


# ── "why it moved" ──────────────────────────────────────
def item(title, ts="2026-10-19T12:00:00+00:00"):
    return {"title": title, "url": f"https://x.test/{abs(hash(title))}", "source": "Wire", "published_at": ts}


def test_matcher_company_name_and_dollar_ticker():
    news = [item("Nvidia shares jump on new chip orders"), item("Markets wrap: $AMZN rallies", "2026-10-19T13:00:00+00:00")]
    assert mm.match_headline("NVDA", "Nvidia", news)["title"].startswith("Nvidia")
    assert mm.match_headline("AMZN", "Amazon", news)["title"].startswith("Markets wrap")


def test_matcher_no_false_matches_for_short_tickers():
    news = [item("F-35 jets and T-bills: what to watch"), item("Ford recalls trucks"), item("Grade F for the T stock index")]
    assert mm.match_headline("F", "Ford Motor", news) is None   # 'Ford' alone isn't 'Ford Motor'; bare F never matches
    assert mm.match_headline("T", "AT&T", news) is None
    assert mm.match_headline("F", "Ford Motor", [item("Ford Motor beats estimates")]) is not None
    assert mm.match_headline("T", "AT&T", [item("Deal news (NYSE: T) closes")]) is not None


def test_matcher_ignores_company_mentioned_late_in_title():
    assert mm.match_headline("AMZN", "Amazon", [item("3M jumps on expanded data center deal with Amazon Web Services")]) is None
    assert mm.match_headline("AMZN", "Amazon", [item("3M Jumps On Expanded Amazon Data Center Deal; Earnings On Tap")]) is None
    assert mm.match_headline("TSLA", "Tesla", [item("SpaceX, Tesla earnings to test Musk's AI spending")]) is not None


def test_matcher_aliases_and_none_when_nothing():
    assert mm.match_headline("GOOGL", "Alphabet", [item("Google unveils new AI model")], ["Google"]) is not None
    assert mm.match_headline("AAPL", "Apple", [item("Oil prices climb")]) is None


# ── validation and history math ─────────────────────────
def test_validate_drops_null_stale_and_absurd():
    assert mm.validate("^GSPC", "index", [("2026-10-16", 7000.0)], "2026-10-19") is None                       # one price
    assert mm.validate("^GSPC", "index", [("2026-10-15", 7000.0), ("2026-10-16", 7010.0)], "2026-10-19") is None  # stale
    assert mm.validate("XLK", "sector", [("2026-10-16", 100.0), ("2026-10-19", 140.0)], "2026-10-19") is None    # +40%
    assert mm.validate("BTC-USD", "macro", [("2026-10-17", 80000.0), ("2026-10-18", 81000.0)], "2026-10-19") is not None  # 24/7
    q = mm.validate("^GSPC", "index", [("2026-10-16", 7000.0), ("2026-10-19", 7070.0)], "2026-10-19")
    assert q["pct"] == pytest.approx(1.0) and q["chg"] == pytest.approx(70.0)


def test_streak_wtd_ytd():
    hist = {"2025-12-31": 100.0, "2026-10-14": 105.0, "2026-10-15": 106.0, "2026-10-16": 107.0}
    assert mm.streak(hist, ("2026-10-19", 108.0)) == 4
    assert mm.streak(hist, ("2026-10-19", 106.5)) == -1
    assert mm.period_change(hist, 108.0, "2026-10-19", "wtd") == pytest.approx(0.93, abs=0.01)  # vs Fri 107
    assert mm.period_change(hist, 108.0, "2026-10-19", "ytd") == pytest.approx(8.0)


# ── fallbacks ───────────────────────────────────────────
CFG = {"markets": {"enabled": True, "indices": [{"t": "^GSPC", "name": "S&P 500"}, {"t": "^IXIC", "name": "Nasdaq"}],
                   "futures": [], "sectors": [], "macro": [], "megacaps": [], "magnificent7": []}}


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(mm, "DIR", tmp_path)
    monkeypatch.setattr(mm, "fetch_stooq", lambda *a, **k: {})  # no network in tests


def boom(*_a, **_k):
    raise ConnectionError("rate limited")


def test_fallback_keeps_last_good_snapshot(isolated):
    previous = {"generated_at": "2026-10-19T20:05+00:00", "status": "ok", "take": ["The S&P 500 closed slightly higher."]}
    s = mm.build(CFG, at(2026, 10, 19, 18), [], fetch=boom, previous=previous)
    assert s["status"] == "stale" and s["take"] == previous["take"]
    assert s["stale_note"] == "Market data as of Oct 19, 4:05 PM ET: refresh failed"


def test_fallback_without_previous_returns_nothing(isolated):
    assert mm.build(CFG, at(2026, 10, 19, 18), [], fetch=boom) is None


def test_build_with_good_data(isolated):
    def fake(tickers, period, interval):
        return {"^GSPC": [("2026-10-16", 7000.0), ("2026-10-19", 7056.0)], "^IXIC": [("2026-10-16", 24000.0), ("2026-10-19", 23900.0)]}
    s = mm.build(CFG, at(2026, 10, 19, 18), [], fetch=fake)
    assert s["status"] == "ok" and [i["t"] for i in s["indices"]] == ["^GSPC", "^IXIC"]
    assert s["take"][0].startswith(("The S&P 500 closed", "Stocks were up", "It was a green session"))
    mm.save(s, datetime(2026, 10, 19).date())
    assert (mm.DIR / "latest.json").exists() and (mm.DIR / "2026-10-19.json").exists() and (mm.DIR / "history.json").exists()


# ── partial answers from Yahoo ──────────────────────────
CFG2 = {"markets": {"enabled": True, "indices": [{"t": "^GSPC", "name": "S&P 500"}, {"t": "^IXIC", "name": "Nasdaq"}],
                    "futures": [], "sectors": [{"t": "XLK", "name": "Tech"}, {"t": "XLE", "name": "Energy"}], "macro": [],
                    "megacaps": [{"t": "AAA", "name": "Alpha", "sector": "Tech", "shares": 1e9}], "magnificent7": []}}
GOOD = {"^GSPC": [("2026-10-19", 7000.0), ("2026-10-20", 7056.0)], "^IXIC": [("2026-10-19", 24000.0), ("2026-10-20", 23900.0)],
        "XLK": [("2026-10-19", 100.0), ("2026-10-20", 101.0)], "XLE": [("2026-10-19", 90.0), ("2026-10-20", 89.0)],
        "AAA": [("2026-10-19", 300.0), ("2026-10-20", 309.0)]}


def test_retry_fills_a_partial_batch(isolated):
    calls = []
    def flaky(tickers, period, interval):
        calls.append(list(tickers))
        if len(calls) == 1:
            return {t: GOOD[t] for t in ("^GSPC", "^IXIC")}  # rate-limited after the indexes
        return {t: GOOD[t] for t in tickers if t in GOOD}
    s = mm.build(CFG2, at(2026, 10, 20, 18), [], fetch=flaky, retry_pause=0)
    assert len(calls) == 2 and set(calls[1]) == {"XLK", "XLE", "AAA"}
    assert [x["name"] for x in s["sectors"]] == ["Tech", "Energy"] and s["movers"]["gainers"][0]["t"] == "AAA"
    assert "partial_note" not in s


def test_carry_over_same_session_only(isolated):
    only_idx = lambda tickers, period, interval: {t: GOOD[t] for t in tickers if t.startswith("^")}
    good = mm.build(CFG2, at(2026, 10, 20, 18), [], fetch=lambda t, p, i: {k: GOOD[k] for k in t if k in GOOD}, retry_pause=0)
    good["generated_at"] = "2026-10-20T22:20+00:00"
    s = mm.build(CFG2, at(2026, 10, 20, 20), [], fetch=only_idx, previous=good, retry_pause=0)
    assert s["sectors"] == good["sectors"] and s["movers"] == good["movers"]
    assert s["partial_note"] == "Sectors, mega-cap movers as of 6:20 PM ET: this refresh only partly loaded"
    assert "Tech" in " ".join(s["take"])                       # the take still covers sectors
    good["state"]["session"] = "2026-10-19"                    # a different session: nothing carried
    s2 = mm.build(CFG2, at(2026, 10, 20, 20), [], fetch=only_idx, previous=good, retry_pause=0)
    assert s2["sectors"] == [] and "partial_note" not in s2


def test_partial_run_never_overwrites_a_complete_recap(isolated):
    full = mm.build(CFG2, at(2026, 10, 20, 18), [], fetch=lambda t, p, i: {k: GOOD[k] for k in t if k in GOOD}, retry_pause=0)
    mm.save(full, datetime(2026, 10, 20).date())
    thin = mm.build(CFG2, at(2026, 10, 20, 20), [], fetch=lambda t, p, i: {k: GOOD[k] for k in t if k.startswith("^")}, retry_pause=0)
    mm.save(thin, datetime(2026, 10, 20).date())
    import json
    saved = json.loads((mm.DIR / "2026-10-20.json").read_text("utf-8"))
    assert len(saved["sectors"]) == 2 and saved["movers"]["gainers"]
