"""Recency filter, keyword rule language, and best-fit section assignment.

Rule grammar (case-insensitive, whole-word):
    expr   := or
    or     := and ("OR" and)*
    and    := unary (["AND"] unary)*      # adjacent terms are an implicit AND
    unary  := "NOT" unary | "(" or ")" | term
    term   := word | "quoted phrase" | re:"regex" | re:regex-to-next-AND/OR/end
"""
from __future__ import annotations

import re
from collections import Counter
from datetime import datetime, timedelta

Match = tuple[bool, set[str]]

_RE_TAIL = re.compile(r"\s+(?:AND|OR)\s+")


class RuleError(ValueError):
    """Raised for malformed keyword rules."""


def _term_pattern(text: str) -> re.Pattern:
    words = [re.escape(w) for w in text.split()]
    return re.compile(r"(?<!\w)" + r"\s+".join(words) + r"(?!\w)", re.IGNORECASE)


def tokenize(rule: str) -> list[tuple[str, str]]:
    """Split a rule into (kind, value) tokens: op, lpar, rpar, term, regex."""
    toks, i, n = [], 0, len(rule)
    while i < n:
        c = rule[i]
        if c.isspace():
            i += 1
        elif c in "()":
            toks.append(("lpar" if c == "(" else "rpar", c))
            i += 1
        elif c == '"':
            j = rule.find('"', i + 1)
            if j == -1:
                raise RuleError(f"unclosed quote in: {rule}")
            toks.append(("term", rule[i + 1:j]))
            i = j + 1
        elif rule.startswith("re:", i):
            i += 3
            if i < n and rule[i] == '"':
                j = rule.find('"', i + 1)
                if j == -1:
                    raise RuleError(f"unclosed regex quote in: {rule}")
                pat, i = rule[i + 1:j], j + 1
            else:
                m = _RE_TAIL.search(rule, i)
                j = m.start() if m else n
                pat, i = rule[i:j].strip(), j
            toks.append(("regex", pat))
        else:
            j = i
            while j < n and not rule[j].isspace() and rule[j] not in '()"':
                j += 1
            word = rule[i:j]
            toks.append(("op", word) if word in ("AND", "OR", "NOT") else ("term", word))
            i = j
    return toks


class Rule:
    """A compiled keyword rule. Call .match(text) -> (matched?, matched keyword labels)."""

    def __init__(self, source: str):
        self.source = source
        self._toks = tokenize(source)
        self._pos = 0
        if not self._toks:
            raise RuleError("empty rule")
        self._tree = self._or()
        if self._pos != len(self._toks):
            raise RuleError(f"unexpected {self._toks[self._pos][1]!r} in: {source}")

    def _peek(self):
        return self._toks[self._pos] if self._pos < len(self._toks) else (None, None)

    def _or(self):
        node = self._and()
        while self._peek() == ("op", "OR"):
            self._pos += 1
            node = ("or", node, self._and())
        return node

    def _and(self):
        node = self._unary()
        while True:
            kind, val = self._peek()
            if (kind, val) == ("op", "AND"):
                self._pos += 1
            elif kind not in ("term", "regex", "lpar") and (kind, val) != ("op", "NOT"):
                return node
            node = ("and", node, self._unary())

    def _unary(self):
        kind, val = self._peek()
        if kind is None:
            raise RuleError(f"rule ends too early: {self.source}")
        self._pos += 1
        if (kind, val) == ("op", "NOT"):
            return ("not", self._unary())
        if kind == "lpar":
            node = self._or()
            if self._peek()[0] != "rpar":
                raise RuleError(f"missing ')' in: {self.source}")
            self._pos += 1
            return node
        if kind == "term":
            return ("term", val.lower(), _term_pattern(val))
        if kind == "regex":
            try:
                return ("regex", val, re.compile(val, re.IGNORECASE))
            except re.error as e:
                raise RuleError(f"bad regex {val!r}: {e}") from e
        raise RuleError(f"unexpected {val!r} in: {self.source}")

    def match(self, text: str) -> Match:
        return self._eval(self._tree, text)

    def leaves(self) -> list[tuple[str, re.Pattern]]:
        """Positive terms as (label, pattern); terms under NOT are excluded. Regex labels read 're:<pattern>'."""
        out, stack = [], [self._tree]
        while stack:
            node = stack.pop()
            if node[0] == "term":
                out.append((node[1], node[2]))
            elif node[0] == "regex":
                out.append(("re:" + node[1], node[2]))
            elif node[0] in ("and", "or"):
                stack += [node[2], node[1]]
        return out

    def _eval(self, node, text: str) -> Match:
        op = node[0]
        if op == "term":
            return (True, {node[1]}) if node[2].search(text) else (False, set())
        if op == "regex":
            m = node[2].search(text)
            return (True, {m.group(0).lower()}) if m else (False, set())
        if op == "not":
            ok, _ = self._eval(node[1], text)
            return (not ok, set())
        lo, lk = self._eval(node[1], text)
        if op == "and":
            if not lo:
                return (False, set())
            ro, rk = self._eval(node[2], text)
            return (True, lk | rk) if ro else (False, set())
        ro, rk = self._eval(node[2], text)
        return (lo or ro, (lk if lo else set()) | (rk if ro else set()))


def compile_sections(config: dict) -> dict[str, dict]:
    """Compile keyword/exclude rules for each enabled section."""
    out = {}
    for key, sec in config["sections"].items():
        if not sec.get("enabled", True):
            continue
        out[key] = {
            "keywords": [Rule(r) for r in sec.get("keywords", [])],
            "exclude": [Rule(r) for r in sec.get("exclude", [])],
            "priority": {p.lower() for p in sec.get("priority", [])},
        }
    return out


def section_match(rules: dict, text: str) -> set[str] | None:
    """Matched keywords if `text` belongs in a section, else None."""
    if any(r.match(text)[0] for r in rules["exclude"]):
        return None
    hits, any_ok = set(), False
    for r in rules["keywords"]:
        ok, kw = r.match(text)
        if ok:
            any_ok, hits = True, hits | kw
    return hits if any_ok else None


def keyword_weight(keywords: list[str], priority: set[str]) -> int:
    """Priority keywords count 3, others 1."""
    return sum(3 if k in priority else 1 for k in keywords)


def recent(items: list[dict], now: datetime, hours: float) -> list[dict]:
    """Keep items published within the last `hours`."""
    cutoff = now - timedelta(hours=hours)
    return [it for it in items if datetime.fromisoformat(it["published_at"]) >= cutoff]


def assign_sections(items: list[dict], compiled: dict[str, dict]) -> list[dict]:
    """Match every item against every section; keep it in its best-fit section only.

    Score per section = keyword weight, +2 if it came from that section's feed.
    Items from `require_keyword_match: false` feeds always qualify for their own section.
    `topic_tags` lists every section that matched, for cross-links.
    """
    kept = []
    for it in items:
        text = f"{it['title']} {it['summary']}"
        candidates = {}
        for key, rules in compiled.items():
            hits = section_match(rules, text)
            own = key == it["feed_section"]
            if hits is None and own and it["from_dedicated_feed"] and not any(r.match(text)[0] for r in rules["exclude"]):
                hits = set()
            if hits is not None:
                candidates[key] = (keyword_weight(sorted(hits), rules["priority"]) + (2 if own else 0), hits)
        if not candidates:
            continue
        best = max(candidates, key=lambda k: candidates[k][0])
        it["section"] = best
        it["matched_keywords"] = sorted(candidates[best][1])
        it["topic_tags"] = sorted(candidates)
        kept.append(it)
    return kept


_DOMAIN = re.compile(r"^(?:[a-z0-9-]+\.)+[a-z]{2,}$", re.IGNORECASE)
_TLDS = {"com", "ca", "org", "net", "co", "uk", "gc", "gov", "news", "info", "io", "us"}


def pretty_source(name: str) -> str:
    """'toronto.citynews.ca' -> 'Citynews', 'MiltonToday.ca' -> 'MiltonToday'. Non-domain names are returned unchanged."""
    if not _DOMAIN.match(name):
        return name
    labels = [x for x in name.split(".") if x.lower() not in _TLDS | {"www"}]
    if not labels:
        return name
    label = labels[-1]
    return label if any(c.isupper() for c in label) else label.capitalize()  # keep "MiltonToday" as written


def apply_source_rules(items: list[dict], rules: dict | None) -> list[dict]:
    """Rename publishers (config `sources.rename`, then domain prettifying) and drop blocked ones."""
    rules = rules or {}
    rename = {k.lower(): v for k, v in (rules.get("rename") or {}).items()}
    block = {b.lower() for b in rules.get("block") or []}
    out = []
    for it in items:
        raw = it["source"]
        name = rename.get(raw.lower()) or pretty_source(raw)
        if raw.lower() in block or name.lower() in block:
            continue
        it["source"] = name
        out.append(it)
    return out


def keyword_report(items: list[dict], compiled: dict[str, dict], kept: list[dict]) -> dict[str, dict]:
    """Per-section keyword diagnostics for the tuning page.

    hits:     items (all fresh items, any section) mentioning each keyword
    kept:     keyword counts among items that ended up in the section
    sole:     items kept on that keyword alone (the usual source of noise)
    excluded: items that matched the section but were dropped by an exclude rule, by exclude term, with examples
    unused:   keywords nothing mentioned today
    """
    report = {}
    for key, rules in compiled.items():
        leaves = list(dict.fromkeys(l for r in rules["keywords"] for l in r.leaves()))
        hits: Counter = Counter()
        excluded: dict[str, list[str]] = {}
        for it in items:
            text = f"{it['title']} {it['summary']}"
            for label, pat in leaves:
                if pat.search(text):
                    hits[label] += 1
            if any(r.match(text)[0] for r in rules["keywords"]):
                for r in rules["exclude"]:
                    ok, terms = r.match(text)
                    for term in terms if ok else ():
                        excluded.setdefault(term, []).append(it["title"])
        mine = [it for it in kept if it["section"] == key]
        kept_kw = Counter(k for it in mine for k in it["matched_keywords"])
        sole = Counter(it["matched_keywords"][0] for it in mine if len(it["matched_keywords"]) == 1)
        report[key] = {
            "hits": hits.most_common(30),
            "kept": kept_kw.most_common(30),
            "sole": sole.most_common(15),
            "excluded": sorted(({"term": t, "count": len(v), "examples": v[:3]} for t, v in excluded.items()),
                               key=lambda e: -e["count"]),
            "unused": [label for label, _ in leaves if not hits[label]],
        }
    return report
