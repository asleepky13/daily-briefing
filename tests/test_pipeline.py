"""Tests for parsing, keyword rules, URL canonicalization, clustering, recency, and the DST guard."""
import base64
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from pipeline.dedupe import canonicalize_url, cluster, merge_exact
from pipeline.filter import Rule, RuleError, assign_sections, recent
from pipeline.main import should_run
from pipeline.parse import clean_text, make_item, parse_feed, parse_html, resolve_gnews

FIX = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 9, 30, 15, 0, tzinfo=timezone.utc)


def load(name: str) -> bytes:
    return (FIX / name).read_bytes()


def item(title, url="https://e.com/x", source="A", published=NOW, summary="", section="finance"):
    return make_item(title=title, url=url, source=source, section=section, published=published, summary=summary, now=NOW)


# ── parsing ─────────────────────────────────────────────
def test_rss():
    items = parse_feed(load("rss.xml"), source="Wire", section="finance", now=NOW)
    assert len(items) == 2  # item without a link is skipped
    a = items[0]
    assert a["published_at"] == "2026-09-30T12:00:00+00:00" and not a["date_estimated"]
    assert a["summary"] == "The merger creates the largest widget maker & ends a long bidding war."
    assert a["canonical_url"] == "https://example.com/news/acme-globex"
    assert items[1]["published_at"] == "2026-09-30T13:30:00+00:00"  # -0400 normalized to UTC


def test_atom():
    (a,) = parse_feed(load("atom.xml"), source="Atom", section="tech", now=NOW)
    assert a["title"] == "Startup raised $40 million in Series B funding"
    assert a["summary"] == "Investors piled in."
    assert a["canonical_url"] == "https://example.org/startup-series-b"


def test_malformed_xml_raises():
    with pytest.raises(ValueError):
        parse_feed(load("malformed.xml"), source="Bad", section="tech", now=NOW)


def test_missing_garbage_and_future_dates_fall_back_to_now():
    items = parse_feed(load("nodate.xml"), source="N", section="local", now=NOW)
    assert len(items) == 3
    for it in items:
        assert it["date_estimated"] and it["published_at"] == NOW.isoformat()


def test_html_scraper_and_url_date():
    html = b"""<ul><article><h2><a href="/local/2026/09/29/story/">Council votes on budget</a></h2><p>Snippet here</p></article>
               <article><h2>No link here</h2></article></ul>"""
    (a,) = parse_html(html, base_url="https://news.example/", selectors={"container": "article", "title": "h2", "link": "h2 a",
                      "date": "time", "summary": "p"}, source="X", section="local", now=NOW)
    assert a["url"] == "https://news.example/local/2026/09/29/story/"
    assert a["published_at"].startswith("2026-09-29") and not a["date_estimated"]
    assert a["summary"] == "Snippet here"


def test_clean_text_truncates_on_word_boundary():
    out = clean_text("word " * 100)
    assert len(out) <= 300 and out.endswith("…") and not out.endswith(" …")


def test_resolve_gnews_embedded_url():
    token = base64.urlsafe_b64encode(b"\x08\x13\x22\x1bhttps://www.reuters.com/a-b/\xd2\x01\x00").decode().rstrip("=")
    assert resolve_gnews(f"https://news.google.com/rss/articles/{token}?oc=5") == "https://www.reuters.com/a-b/"
    opaque = "https://news.google.com/rss/articles/AU_yqLxyz?oc=5"
    assert resolve_gnews(opaque) == opaque


# ── keyword rules ───────────────────────────────────────
@pytest.mark.parametrize("rule,text,ok", [
    ('"series a" OR "series b"', "Acme closes Series B round", True),
    ('"series a" OR "series b"', "Acme closes series c", False),
    ("acquisition AND (tech OR software)", "Software acquisition announced", True),
    ("acquisition AND (tech OR software)", "Grocery acquisition announced", False),
    ("merger AND NOT opinion", "Opinion: why the merger fails", False),
    ("merger AND NOT opinion", "Merger approved", True),
    ("merger", "Emergency declared", False),           # word boundary
    ("ai", "Said the chair", False),
    ("ai", "New AI model", True),
    (r"re:raised \$\d+", "Startup raised $50 million", True),
    (r're:"raised \$\d+" AND startup', "Startup raised $50", True),
    ("bank of canada", "BANK  OF\nCANADA holds", True),  # case + flexible whitespace
    ("s&p 500", "S&P 500 hits record", True),
    ("NOT opinion", "Plain news", True),
    ("rate cut", "Fed signals rate cut", True),
])
def test_rules(rule, text, ok):
    assert Rule(rule).match(text)[0] is ok


def test_rule_reports_matched_keywords():
    ok, kws = Rule(r'ipo OR merger OR re:raised \$\d+').match("Startup raised $5 before IPO")
    assert ok and kws == {"ipo", "raised $5"}


@pytest.mark.parametrize("bad", ['"open', "(a OR b", "a OR", "", "re:(", ")"])
def test_bad_rules(bad):
    with pytest.raises(RuleError):
        Rule(bad)


def test_best_fit_section_and_cross_links():
    compiled = {
        "finance": {"keywords": [Rule("acquisition OR ipo")], "exclude": [], "priority": {"acquisition"}},
        "tech": {"keywords": [Rule("software")], "exclude": [Rule("opinion")], "priority": set()},
    }
    it = item("Software giant makes acquisition", section="tech")
    (out,) = assign_sections([it], compiled)
    assert out["section"] == "finance"  # priority weight 3 beats tech's 1 + own-feed 2
    assert out["topic_tags"] == ["finance", "tech"]
    assert assign_sections([item("Unrelated gardening news")], compiled) == []
    dedicated = item("Unrelated gardening news", section="tech")
    dedicated["from_dedicated_feed"] = True
    assert assign_sections([dedicated], compiled)[0]["section"] == "tech"


# ── canonicalization & dedupe ───────────────────────────
@pytest.mark.parametrize("raw,canon", [
    ("https://www.Example.com/a/?utm_source=x&id=2&fbclid=abc", "https://example.com/a?id=2"),
    ("http://example.com/story/amp/", "https://example.com/story"),
    ("https://amp.example.com/story.amp.html#top", "https://example.com/story.html"),
    ("https://example.com/", "https://example.com/"),
    ("https://example.com/p?b=2&a=1", "https://example.com/p?a=1&b=2"),
])
def test_canonicalize(raw, canon):
    assert canonicalize_url(raw) == canon


def test_exact_duplicates_merge():
    a = item("Story", url="https://e.com/s?utm_source=a", source="A")
    b = item("Story", url="https://www.e.com/s/", source="B", published=NOW + timedelta(minutes=5))
    (m,) = merge_exact([b, a])
    assert m["source"] == "A" and m["also_covered_by"] == [{"source": "B", "url": "https://www.e.com/s/"}]


def test_near_duplicate_clustering():
    items = [
        item("Fed raises interest rates by a quarter point", url="https://a.com/1", source="A"),
        item("Fed raises interest rates by quarter point, signals more", url="https://b.com/2", source="B"),
        item("Apple unveils new iPhone at September event", url="https://c.com/3", source="C"),
        item("Fed", url="https://d.com/4", source="D"),  # short title must not swallow/merge
    ]
    out = cluster(items, threshold=85)
    assert len(out) == 3
    fed = next(s for s in out if s["cluster_size"] == 2)
    assert [a["source"] for a in fed["also_covered_by"]] == ["B"]
    assert len({i["cluster_id"] for i in items}) == 3


# ── recency & schedule ──────────────────────────────────
def test_recency_window():
    fresh = item("new", published=NOW - timedelta(hours=25))
    stale = item("old", published=NOW - timedelta(hours=27))
    assert recent([fresh, stale], NOW, 26) == [fresh]


@pytest.mark.parametrize("schedule,now,ok", [
    ("30 11 * * *", datetime(2026, 7, 1, 11, 30, tzinfo=timezone.utc), True),   # EDT: 7:30
    ("30 12 * * *", datetime(2026, 7, 1, 12, 30, tzinfo=timezone.utc), False),  # EDT: 8:30
    ("30 11 * * *", datetime(2026, 1, 5, 11, 30, tzinfo=timezone.utc), False),  # EST: 6:30
    ("30 12 * * *", datetime(2026, 1, 5, 12, 45, tzinfo=timezone.utc), True),   # EST: 7:45 (late cron still runs)
    (None, datetime(2026, 1, 5, 3, 0, tzinfo=timezone.utc), True),              # manual run
])
def test_dst_guard(schedule, now, ok):
    assert should_run(schedule, now, "America/Toronto") is ok


# ── entity-aware clustering, velocity, sources, keyword report ──
from pipeline.dedupe import link_previous  # noqa: E402
from pipeline.filter import apply_source_rules, compile_sections, keyword_report, pretty_source  # noqa: E402

FILLER = ["Heat wave grips southern Europe", "Raptors sign veteran guard", "Museum reopens after renovation",
          "Airline adds routes to Lisbon", "Bakery chain expands downtown", "Orchestra names new conductor",
          "Library extends weekend hours", "Wildfire smoke drifts east", "Transit fares frozen for winter",
          "Hospital opens new cancer wing", "School board approves calendar", "Bridge repairs close lanes"]


def _day(*titles_sources):
    return [item(t, url=f"https://{s.lower().replace(' ', '')}.com/{i}", source=s) for i, (t, s) in enumerate(titles_sources)]


def test_entity_match_groups_differently_worded_headlines():
    items = _day(("Google rolls out Gemini 4 Argon, its most advanced AI model", "CNBC"),
                 ("Google releases Gemini 4 Argon, called its most powerful model yet", "TechCrunch"),
                 ("Google announces Gemini 4 Argon AI model, but you can't use it yet", "Ars Technica"),
                 *[(t, "Filler") for t in FILLER])
    out = cluster(items)
    gem = next(s for s in out if "Gemini" in s["title"])
    assert gem["cluster_size"] == 3
    assert {a["source"] for a in gem["also_covered_by"]} | {gem["source"]} == {"CNBC", "TechCrunch", "Ars Technica"}


def test_same_source_boilerplate_stays_separate():
    items = _day(("8-K - Blackstone Private Credit Fund (0001803498) (Filer)", "SEC EDGAR"),
                 ("8-K - Manulife Private Credit Fund (0001988280) (Filer)", "SEC EDGAR"),
                 *[(t, "Filler") for t in FILLER])
    assert len(cluster(items)) == 2 + len(FILLER)


def test_link_previous_states():
    prev = _day(("Senate blocks data centre electricity bill", "Reuters"),
                ("Swiss glaciers suffer record ice loss", "BBC"), *[(t, "Filler") for t in FILLER])
    prev[1]["trend"] = {"state": "ongoing", "days": 2}
    today = _day(("US Senate rejects bill targeting AI data centre electricity costs", "Al Jazeera"),
                 ("Swiss glaciers suffer record ice loss", "NPR"),
                 ("Brand new merger shocks markets", "AP"))
    today[0]["also_covered_by"] = [{"source": s, "url": "u"} for s in ("AP", "BBC", "CBC")]
    today[2]["also_covered_by"] = [{"source": s, "url": "u"} for s in ("CNBC", "Reuters")]
    link_previous(today, prev)
    assert today[0]["trend"] == {"state": "rising", "prev_outlets": 1, "days": 2}
    assert today[1]["trend"] == {"state": "ongoing", "prev_outlets": 1, "days": 3}
    assert today[2]["trend"]["state"] == "breaking"
    link_previous(today, [])
    assert today[0]["trend"] is None


def test_source_rules():
    items = [item("a", source="reuters.com"), item("b", source="toronto.citynews.ca"), item("c", source="wsws.org"),
             item("d", source="CBC")]
    out = apply_source_rules(items, {"rename": {"Reuters.com": "Reuters", "wsws.org": "WSWS"}, "block": ["wsws"]})
    assert [i["source"] for i in out] == ["Reuters", "Citynews", "CBC"]
    assert pretty_source("pm.gc.ca") == "Pm" and pretty_source("AP News") == "AP News"


def test_keyword_report():
    cfg = {"sections": {"tech": {"keywords": ["launch OR breach", r"re:raised \$\d+"], "exclude": ["deal"]}}}
    compiled = compile_sections(cfg)
    items = [item("Company launch event", section="tech"), item("Huge launch deal today", section="tech"),
             item("Data breach and launch", section="tech")]
    kept = assign_sections(items, compiled)
    rep = keyword_report(items, compiled, kept)["tech"]
    assert dict(rep["hits"]) == {"launch": 3, "breach": 1}
    assert rep["sole"] == [("launch", 1)]
    assert rep["excluded"][0]["term"] == "deal" and rep["excluded"][0]["count"] == 1
    assert rep["unused"] == [r"re:raised \$\d+"]
