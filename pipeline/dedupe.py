"""URL canonicalization, exact-duplicate merging, and near-duplicate headline clustering."""
from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from rapidfuzz import fuzz, process

_TRACKING = {"fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "ocid", "cmpid", "ref", "ref_src",
             "taid", "guccounter", "guce_referrer", "guce_referrer_sig", "smid", "mod", "rss", "oc"}
_TOKEN = re.compile(r"[a-z0-9$%]+")


def canonicalize_url(url: str) -> str:
    """Lower-case scheme/host, drop www., tracking params, fragments, AMP paths and trailing slashes."""
    parts = urlsplit(url.strip())
    host = parts.netloc.lower().removeprefix("www.").removeprefix("amp.")
    path = re.sub(r"/amp(/|$)", "/", parts.path)
    path = re.sub(r"\.amp(\.html?)?$", r"\1", path)
    path = path.rstrip("/") or "/"
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in _TRACKING and k.lower() != "amp"]
    return urlunsplit(("https" if parts.scheme in ("http", "https") else parts.scheme, host, path,
                       urlencode(sorted(query)), ""))


def _also(item: dict) -> dict:
    return {"source": item["source"], "url": item["url"]}


def merge_exact(items: list[dict]) -> list[dict]:
    """Collapse items sharing a canonical URL; the earliest copy survives and absorbs other sources."""
    by_url: dict[str, dict] = {}
    for it in sorted(items, key=lambda i: i["published_at"]):
        first = by_url.get(it["canonical_url"])
        if first is None:
            by_url[it["canonical_url"]] = it
        elif it["source"] != first["source"] and all(a["source"] != it["source"] for a in first["also_covered_by"]):
            first["also_covered_by"].append(_also(it))
    return list(by_url.values())


def normalize_title(title: str) -> str:
    """Lower-case token string used for similarity."""
    return " ".join(_TOKEN.findall(title.lower()))


def _similar(a: str, b: str, **_) -> float:
    """token_set_ratio, but plain ratio when either title is short (token_set calls 'Fed' ≈ 'Fed hikes rates')."""
    if min(a.count(" "), b.count(" ")) < 3:
        return fuzz.ratio(a, b)
    return fuzz.token_set_ratio(a, b)


_STOP = set("""a an the and or of to in on for at by with from as is are was were be been it its this that after over
into new says say said will would could can may up out about than more most not no but has have had amid against how why
what who when where which their his her they we you our your report reports live updates update""".split())
_YEAR = re.compile(r"(19|20)\d\d")


def name_words(title: str) -> set[str]:
    """Words capitalized mid-headline (Gemini, Aitchison, Paramount). Title-Case headlines are skipped: there
    every word is capitalized, so capitals say nothing."""
    words = re.findall(r"[A-Za-z][\w'’-]*", title)
    caps = [w for w in words[1:] if w[0].isupper()]
    if len(words) < 3 or len(caps) > 0.6 * (len(words) - 1):
        return set()
    return {m for w in caps for m in _TOKEN.findall(w.lower()) if len(m) > 1 and m not in _STOP}


def content_tokens(title: str) -> frozenset[str]:
    """Meaningful title words: no stopwords or single letters (digits kept, so 'Gemini 4' keeps its 4)."""
    return frozenset(w for w in _TOKEN.findall(title.lower()) if w.isdigit() or (len(w) > 1 and w not in _STOP))


class StoryMatcher:
    """Decides whether two headlines report the same story.

    Two routes to a match:
      1. near-identical wording (rapidfuzz token-set ≥ threshold), or
      2. same entities, different wording: they share ≥3 "anchor" words (rare today, a name, or containing a digit)
         including ≥1 strong one (a name, or a word ≤4 headlines use), and the shared words carry ≥50% of the shorter
         headline's rarity weight. Names count even when common: a big story repeats its names everywhere.
         Route 2 requires different publishers, which keeps boilerplate (SEC filings, fund notices) apart.
    Rarity is measured against all headlines in the run (inverse document frequency).
    """

    def __init__(self, titles: list[str], threshold: float = 85):
        self.threshold = threshold
        docs = [content_tokens(t) for t in titles]
        n = max(len(docs), 1)
        self.df = Counter(w for d in docs for w in d)
        self.idf = {w: math.log((n + 1) / c) for w, c in self.df.items()}
        self.names = set().union(*(name_words(t) for t in titles)) if titles else set()

    def anchors(self, toks: frozenset[str]) -> set[str]:
        return {w for w in toks if (self.df[w] <= 6 or w in self.names or any(c.isdigit() for c in w))
                and not _YEAR.fullmatch(w)}

    def same(self, a: dict, b: dict, ka: str, kb: str, ta: frozenset[str], tb: frozenset[str]) -> bool:
        """a/b items, ka/kb normalized titles, ta/tb content tokens."""
        if _similar(ka, kb) >= self.threshold:
            return True
        if a["source"] == b["source"]:
            return False
        shared = ta & tb
        anchors = self.anchors(shared)
        if len(anchors) < 3 or not any((self.df[w] <= 4 or w in self.names) and w.isalpha() and len(w) >= 4
                                       for w in shared):
            return False
        weight = lambda ws: sum(self.idf.get(w, 0) for w in ws)
        return weight(shared) >= 0.5 * min(weight(ta), weight(tb))


def cluster(items: list[dict], threshold: float = 85) -> list[dict]:
    """Group near-duplicate headlines. Returns one lead item per cluster with `also_covered_by` filled.

    Single-linkage: an item joins a cluster if it matches ANY member (see StoryMatcher). The lead is the member
    with the most keyword hits, then one with a snippet, then the earliest. Other members become "Also covered by".
    """
    # ponytail: O(n·members) worst case, pruned by an anchor-word index; fine for a few thousand items/day.
    matcher = StoryMatcher([i["title"] for i in items], threshold)
    groups: list[list[dict]] = []
    members: list[dict] = []      # every item placed so far
    keys: list[str] = []          # its normalized title (for rapidfuzz)
    key_group: list[int] = []     # its group index
    toks: list[frozenset[str]] = []
    by_anchor: dict[str, set[int]] = {}
    for it in sorted(items, key=lambda i: (-len(i["matched_keywords"]), i["published_at"])):
        key, tk = normalize_title(it["title"]), content_tokens(it["title"])
        gi = None
        hit = process.extractOne(key, keys, scorer=_similar, score_cutoff=threshold) if keys else None
        if hit:
            gi = key_group[hit[2]]
        else:
            for m in sorted({m for w in matcher.anchors(tk) for m in by_anchor.get(w, ())}):
                if matcher.same(it, members[m], key, keys[m], tk, toks[m]):
                    gi = key_group[m]
                    break
        if gi is None:
            gi = len(groups)
            groups.append([])
        groups[gi].append(it)
        idx = len(keys)
        members.append(it)
        keys.append(key)
        key_group.append(gi)
        toks.append(tk)
        for w in matcher.anchors(tk):
            by_anchor.setdefault(w, set()).add(idx)

    out = []
    for group in groups:
        lead = max(group, key=lambda m: (len(m["matched_keywords"]), bool(m["summary"]), -group.index(m)))
        cid = hashlib.sha1(lead["canonical_url"].encode()).hexdigest()[:10]
        seen = {lead["source"]} | {a["source"] for a in lead["also_covered_by"]}
        for m in group:
            m["cluster_id"] = cid
            if m is lead:
                continue
            for cand in [_also(m), *m["also_covered_by"]]:
                if cand["source"] not in seen:
                    seen.add(cand["source"])
                    lead["also_covered_by"].append(cand)
            lead["topic_tags"] = sorted(set(lead["topic_tags"]) | set(m["topic_tags"]))
        lead["cluster_size"] = len(group)
        out.append(lead)
    return out


def link_previous(stories: list[dict], previous: list[dict], threshold: float = 85) -> None:
    """Tag each story with how its coverage changed since the previous briefing (`trend`).

    breaking: not in the previous briefing and already ≥3 outlets.   new: not in it, fewer outlets.
    rising:   in it, and ≥2 more outlets now.                         ongoing: in it, coverage steady.
    `days` counts consecutive briefings the story has appeared in. With no previous briefing, trend is None.
    """
    if not previous:
        for s in stories:
            s["trend"] = None
        return
    matcher = StoryMatcher([s["title"] for s in stories] + [p["title"] for p in previous], threshold)
    keys = [normalize_title(p["title"]) for p in previous]
    toks = [content_tokens(p["title"]) for p in previous]
    by_anchor: dict[str, set[int]] = {}
    for i, tk in enumerate(toks):
        for w in matcher.anchors(tk):
            by_anchor.setdefault(w, set()).add(i)
    for s in stories:
        key, tk = normalize_title(s["title"]), content_tokens(s["title"])
        hit = process.extractOne(key, keys, scorer=_similar, score_cutoff=threshold)
        match = previous[hit[2]] if hit else None
        if match is None:
            for i in sorted({i for w in matcher.anchors(tk) for i in by_anchor.get(w, ())}):
                # source=None lifts the same-publisher guard: an outlet's follow-up today continues its story
                if matcher.same(s, {**previous[i], "source": None}, key, keys[i], tk, toks[i]):
                    match = previous[i]
                    break
        outlets = 1 + len(s["also_covered_by"])
        if match is None:
            s["trend"] = {"state": "breaking" if outlets >= 3 else "new", "prev_outlets": None, "days": 1}
            continue
        prev_outlets = 1 + len(match.get("also_covered_by", []))
        days = ((match.get("trend") or {}).get("days") or 1) + 1
        state = "rising" if outlets - prev_outlets >= 2 else "ongoing"
        s["trend"] = {"state": state, "prev_outlets": prev_outlets, "days": days}
