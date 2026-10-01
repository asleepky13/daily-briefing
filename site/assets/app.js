/* Daily Briefing client: renders data/*.json, filters, search, saved stories, shortcuts, exports. No dependencies. */
(() => {
  "use strict";
  const body = document.body;
  const ROOT = body.dataset.root;
  const VIEW = body.dataset.view;
  const params = new URLSearchParams(location.search);
  const SECTION = body.dataset.section || params.get("s") || "";
  const DATE = body.dataset.date;
  const LATEST = body.dataset.latest;
  const main = document.getElementById("main");
  const TZ = "America/Toronto";
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── helpers ──────────────────────────────────────────
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
  const fmtExact = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const fmtDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(d + "T00:00:00Z"));
  const fmtDayZh = (d) => new Intl.DateTimeFormat("zh-HK", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date(d + "T00:00:00Z"));
  const ago = (iso, ref = Date.now()) => {
    const m = Math.max(0, Math.round((ref - new Date(iso)) / 60000));
    if (m < 60) return `${m}m ago`;
    if (m < 60 * 48) return `${Math.round(m / 60)}h ago`;
    return `${Math.round(m / 1440)}d ago`;
  };
  const getJSON = async (path) => {
    const r = await fetch(ROOT + path, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  };
  const toast = (msg) => {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
  };
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: feature degrades silently */ } },
  };
  const signFor = (key) => document.querySelector(`.mast nav a[data-key="${CSS.escape(key)}"] .zh`)?.textContent || "";

  // ── theme ────────────────────────────────────────────
  const themeBtn = document.getElementById("theme");
  const currentTheme = () => document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const labelTheme = () => themeBtn.setAttribute("aria-label", `Switch to ${currentTheme() === "dark" ? "light" : "dark"} theme`);
  const toggleTheme = () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch { /* ignore */ }
    labelTheme();
  };
  themeBtn.addEventListener("click", toggleTheme);
  labelTheme();

  // ── saved stories & "new since last visit" ───────────
  const saved = store.get("saved", {});
  const lastSeen = store.get("lastSeen", null); // generated_at of the last briefing viewed
  const isNew = (s) => !DATE && lastSeen && s.published_at > lastSeen;

  // ── reading streak: consecutive Toronto days with a visit ──
  const ymd = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(date);
  const streak = (() => {
    // calendar math on the date string, so DST's 23/25-hour days can't skip or repeat a day
    const today = ymd(new Date()), yesterday = new Date(Date.parse(today) - 864e5).toISOString().slice(0, 10);
    const s = store.get("streak", { last: null, count: 0, best: 0 });
    if (s.last !== today) {
      s.count = s.last === yesterday ? s.count + 1 : 1;
      s.last = today;
      s.best = Math.max(s.best || 0, s.count);
      s.grew = true;
      store.set("streak", { last: s.last, count: s.count, best: s.best });
    }
    return s;
  })();
  {
    const el = document.getElementById("streak");
    el.innerHTML = `<span aria-hidden="true">${streak.count}</span>` +
      `<span class="vh">Reading streak: ${streak.count} day${streak.count === 1 ? "" : "s"} in a row</span>`;
    el.title = `${streak.count}-day reading streak (best ${streak.best}). Open the briefing tomorrow to keep it going.`;
    el.classList.toggle("grew", !!streak.grew && streak.count > 1);
    el.style.setProperty("--heat", Math.min(streak.count, 30) / 30); // full brightness at a 30-day streak
    el.hidden = false;
  }

  // ── the Walled City: a seeded skyline whose lights follow the streak ──
  // Each window draws its own random number once (fixed seed), and is lit when it falls under the streak's share,
  // so a longer streak only ever adds lights: the same windows stay on day after day.
  const SIGNS = [ // hanging signboards the Walled City was known for, switched on at these streak days
    { day: 1, zh: "牙科", en: "Dentist" }, { day: 3, zh: "冰室", en: "Ice café" }, { day: 7, zh: "押", en: "Pawnshop" },
    { day: 14, zh: "茶餐廳", en: "Teahouse" }, { day: 21, zh: "酒家", en: "Restaurant" },
  ];
  const FULL_CITY = 30;
  const litShare = (n) => (n >= FULL_CITY ? 1 : 0.03 + (0.92 * n) / FULL_CITY);
  const rng = (seed) => () => { // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const PLANE = `<g class="plane" aria-hidden="true"><path d="M0 9Q3 6 12 6H52Q58 6 61 1H65L63 7L70 8.5L63 10L54 11H36L25 20H18L25 11H12Q3 12 0 9Z"/><circle class="beacon" cx="64" cy="2" r="1.6"/></g>`;
  const city = ({ w, h, seed, days, text = false }) => {
    const r = rng(seed), share = litShare(days), parts = [], signs = [];
    let windows = 0, lit = 0;
    for (let x = -10; x < w;) { // modern Kowloon towers behind, in the haze
      const bw = 40 + r() * 60, bh = h * (0.56 + r() * 0.24);
      parts.push(`<rect class="far" x="${x | 0}" y="${(h - bh) | 0}" width="${bw | 0}" height="${bh | 0}"/>`);
      x += bw - r() * 12;
    }
    for (let x = -4, n = 0; x < w; n++) { // the slab itself: buildings packed with no gaps, near-uniform height
      const bw = (26 + r() * 36) | 0, bh = (h * (0.5 + r() * 0.17)) | 0, top = h - bh;
      parts.push(`<rect class="fa${n % 4}" x="${x}" y="${top}" width="${bw}" height="${bh}"/>`);
      if (r() < 0.55) parts.push(`<rect class="stain" x="${x + ((r() * bw) | 0)}" y="${top}" width="${(2 + r() * 4) | 0}" height="${(bh * (0.3 + r() * 0.6)) | 0}"/>`);
      for (let wy = top + 7; wy < h - 9; wy += 13) {
        for (let wx = x + 4; wx < x + bw - 7; wx += 10) {
          windows++;
          const on = r() < share, tint = r();
          if (on) lit++;
          parts.push(`<rect class="cw${on ? (tint < 0.88 ? " on" : " on2") : ""}" x="${wx}" y="${wy}" width="6" height="8"/>`);
          const q = r();
          if (q < 0.04) parts.push(`<rect class="ac" x="${wx - 1}" y="${wy + 9}" width="8" height="3"/>`);
          else if (q < 0.065) parts.push(`<path class="pole" d="M${wx + 6} ${wy + 4}h10"/><rect class="ld${(q * 997) % 4 | 0}" x="${wx + 8}" y="${wy + 4}" width="3" height="5"/><rect class="ld${(q * 7919) % 4 | 0}" x="${wx + 12}" y="${wy + 4}" width="3" height="4"/>`);
        }
      }
      for (let k = 0, m = (2 + r() * 4) | 0; k < m; k++) { // rooftop forest of TV aerials
        const ax = (x + 3 + r() * (bw - 6)) | 0, ah = (8 + r() * 22) | 0;
        parts.push(`<path class="aerial" d="M${ax} ${top}v-${ah}m-6 5h12m-9 5h6"/>`);
      }
      if (r() < 0.5) parts.push(`<rect class="tank" x="${(x + bw / 3) | 0}" y="${top - 8}" width="11" height="8"/>`);
      if (r() < 0.42) signs.push({ x: x + bw - 4, y: (top + 16 + r() * bh * 0.4) | 0 });
      x += bw - ((r() * 3) | 0);
    }
    const signSvg = signs.map((s, i) => {
      const def = SIGNS[i % SIGNS.length], on = days >= def.day, len = [...def.zh].length, sh = len * 12 + 6;
      return `<rect class="sg s${i % 3}${on ? " on" : ""}" x="${s.x}" y="${s.y}" width="13" height="${sh}"/>` +
        (text ? [...def.zh].map((ch, j) => `<text class="sgt${on ? " on" : ""}" x="${s.x + 6.5}" y="${s.y + 13 + j * 12}">${ch}</text>`).join("") : "");
    }).join("");
    return { svg: parts.join("") + signSvg + PLANE, windows, lit };
  };
  document.getElementById("skyline").innerHTML = city({ w: 1200, h: 240, seed: 1993, days: streak.count }).svg;
  const saveBtn = (s) => `<button type="button" class="save" data-save="${esc(s.id)}" aria-pressed="${!!saved[s.id]}" aria-label="${saved[s.id] ? "Unsave" : "Save"} story: ${esc(s.title)}">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 3.5h12v17l-6-4.2-6 4.2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg></button>`;
  let storyIndex = {}; // id → story, for everything rendered
  const toggleSave = (id) => {
    if (saved[id]) delete saved[id];
    else if (storyIndex[id]) saved[id] = { ...storyIndex[id], saved_at: new Date().toISOString() };
    else return;
    store.set("saved", saved);
    document.querySelectorAll(`[data-save="${CSS.escape(id)}"]`).forEach((b) => {
      b.setAttribute("aria-pressed", !!saved[id]);
      b.setAttribute("aria-label", b.getAttribute("aria-label").replace(/^(Save|Unsave)/, saved[id] ? "Unsave" : "Save"));
    });
    toast(saved[id] ? "Saved. Find it under Saved 收藏." : "Removed from saved");
    if (VIEW === "saved") renderSaved();
  };
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-save]");
    if (b) toggleSave(b.dataset.save);
  });

  // ── RSS links ────────────────────────────────────────
  document.getElementById("rss-links").innerHTML = [...document.querySelectorAll('link[type="application/rss+xml"]')]
    .map((l) => `<a href="${esc(l.getAttribute("href"))}">${esc(l.title.split(": ").pop())}</a>`).join(", ");

  // ── charts (single-series SVG; values also reachable via labels, tables and <title> tooltips) ──
  let index = null;
  const fmtShort = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(d + "T00:00:00Z"));
  const fmtNum = (v) => v.toLocaleString("en-CA", v >= 1000 ? { maximumFractionDigits: 0 } : v < 10 ? { minimumFractionDigits: 4, maximumFractionDigits: 4 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const spark = (vals, { w = 88, h = 26, label = "", fmt = String, dates = [] } = {}) => {
    if (vals.length < 2) return "";
    const min = Math.min(...vals), max = Math.max(...vals), pad = 5, step = (w - 2 * pad) / (vals.length - 1);
    const x = (i) => pad + i * step;
    const y = (v) => (max === min ? h / 2 : h - pad - ((v - min) * (h - 2 * pad)) / (max - min));
    const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const hits = vals.map((v, i) => `<rect x="${(x(i) - step / 2).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${h}" fill="transparent"><title>${esc(dates[i] ? fmtShort(dates[i]) + ": " : "")}${esc(fmt(v))}</title></rect>`).join("");
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
      <path d="${d}" fill="none" stroke="var(--spark)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(vals.at(-1)).toFixed(1)}" r="4" fill="var(--chart, var(--ink))" stroke="var(--panel)" stroke-width="2"/>${hits}</svg>`;
  };
  // last `n` briefings up to the day on screen, oldest first; tolerates the older index format (bare counts)
  const pastDays = (key, n = 7) => (index?.dates || []).filter((d) => d.date <= day.date).slice(0, n).reverse().map((d) => {
    const s = d.sections[key];
    return { date: d.date, v: typeof s === "number" ? s : s?.matched ?? 0, kw: (typeof s === "object" && s?.keywords) || {} };
  });
  const columns = (pts, name) => {
    const bw = 22, gap = 8, base = 58, top = 14, w = pts.length * (bw + gap) - gap, max = Math.max(...pts.map((p) => p.v), 1);
    const bars = pts.map((p, i) => {
      const x = i * (bw + gap), hgt = Math.max(2, ((base - top) * p.v) / max), y0 = base - hgt, r = Math.min(4, hgt);
      const last = i === pts.length - 1;
      return `<g><path d="M${x},${base}V${y0 + r}Q${x},${y0} ${x + r},${y0}H${x + bw - r}Q${x + bw},${y0} ${x + bw},${y0 + r}V${base}Z" fill="${last ? "var(--chart)" : "var(--spark-bar)"}"/>
        ${last ? `<text x="${x + bw / 2}" y="${y0 - 4}" text-anchor="middle" class="ch-val">${p.v}</text>` : ""}
        <text x="${x + bw / 2}" y="${base + 14}" text-anchor="middle" class="ch-ax">${esc(fmtShort(p.date).slice(0, 3))}</text>
        <rect x="${x - gap / 2}" y="0" width="${bw + gap}" height="${base + 16}" fill="transparent"><title>${esc(fmtShort(p.date))}: ${p.v} stories matched</title></rect></g>`;
    }).join("");
    return `<svg class="cols" viewBox="${-gap / 2} -2 ${w + gap} ${base + 18}" width="${w + gap}" height="${base + 20}" role="img" aria-label="${esc(name)} stories matched per day, last ${pts.length} days: ${pts.map((p) => p.v).join(", ")}">${bars}</svg>`;
  };
  const risingKeywords = (pts) => {
    if (pts.length < 3) return [];
    const today = pts.at(-1).kw, before = pts.slice(0, -1);
    return Object.entries(today).map(([k, c]) => {
      const avg = before.reduce((a, p) => a + (p.kw[k] || 0), 0) / before.length;
      return { k, c, avg, ratio: (c + 1) / (avg + 1) };
    }).filter((r) => r.c >= 3 && r.ratio >= 1.5).sort((a, b) => b.ratio - a.ratio).slice(0, 3);
  };
  const weekStrip = (key, name) => {
    const pts = pastDays(key);
    if (pts.length < 2) return `<p class="week empty-note">Trend lines appear after a few daily runs (${pts.length} so far).</p>`;
    const rising = risingKeywords(pts);
    return `<div class="week"><span class="week-label">Last ${pts.length} days</span>${spark(pts.map((p) => p.v), { w: 110, label: `${name} stories matched per day: ${pts.map((p) => p.v).join(", ")}`, fmt: (v) => `${v} stories`, dates: pts.map((p) => p.date) })}
      ${rising.length ? `<span>Rising: ${rising.map((r) => `<strong>${esc(r.k)}</strong> ${r.c} today vs ${Math.round(r.avg)} on average`).join(", ")}</span>` : ""}</div>`;
  };
  const trendsPanel = (key, name) => {
    const pts = pastDays(key);
    if (pts.length < 2) return `<section class="trends" aria-labelledby="tr-h"><h2 id="tr-h">This week</h2><p class="empty-note">Trend charts appear after a few daily runs (${pts.length} so far).</p></section>`;
    const kws = Object.entries(pts.at(-1).kw).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const rows = kws.map(([k, c]) => {
      const vals = pts.map((p) => p.kw[k] || 0), avg = vals.slice(0, -1).reduce((a, b) => a + b, 0) / (vals.length - 1);
      const pct = avg ? Math.round(((c - avg) / avg) * 100) : null;
      return `<tr><th scope="row">${esc(k)}</th><td>${spark(vals, { w: 96, label: `${k} mentions per day: ${vals.join(", ")}`, fmt: (v) => `${v} stories`, dates: pts.map((p) => p.date) })}</td>
        <td class="num">${c}</td><td class="num">${pct === null ? "new" : `<span class="${pct >= 0 ? "up" : "down"}"><span aria-hidden="true">${pct >= 0 ? "▲" : "▼"}</span> ${pct >= 0 ? "+" : "−"}${Math.abs(pct)}%</span>`}</td></tr>`;
    }).join("");
    return `<section class="trends" aria-labelledby="tr-h"><h2 id="tr-h">This week</h2>
      <div class="trends-grid"><figure><figcaption>Stories matched per day</figcaption>${columns(pts, name)}</figure>
      ${rows ? `<table><caption>Top keywords, last ${pts.length} days</caption><thead><tr><th scope="col">Keyword</th><th scope="col">Trend</th><th scope="col" class="num">Today</th><th scope="col" class="num">vs. average</th></tr></thead><tbody>${rows}</tbody></table>` : ""}</div></section>`;
  };
  const trendTag = (s) => {
    const t = s.trend;
    if (!t) return "";
    const outlets = 1 + (s.also_covered_by?.length || 0);
    if (t.state === "breaking") return `<span class="tag tag-hot" title="New today and already covered by ${outlets} outlets">Breaking</span>`;
    if (t.state === "rising") return `<span class="tag tag-up" title="More outlets than in the previous briefing">Rising: ${t.prev_outlets} → ${outlets} outlets</span>`;
    if (t.state === "ongoing" && t.days >= 2) return `<span class="tag" title="Appeared in ${t.days} briefings in a row">Day ${t.days}</span>`;
    return "";
  };
  const board = () => {
    const quotes = day.markets || [];
    if (!quotes.length) return;
    const el = document.getElementById("board");
    // dates in Toronto time: Bitcoin's 03:30 UTC quote is still the previous evening here
    const asOf = quotes.map((q) => (q.as_of.length > 10 ? new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(q.as_of)) : q.as_of)).sort().at(-1);
    el.innerHTML = `<p class="board-label" id="board-label">Markets at previous close, ${esc(fmtShort(asOf))}</p><ul>${quotes.map((q) => {
      const up = q.change_pct >= 0;
      return `<li class="tile"><span class="t-name">${esc(q.name)}</span><span class="t-val">${esc(fmtNum(q.price))}</span>
        <span class="t-delta ${up ? "up" : "down"}"><span aria-hidden="true">${up ? "▲" : "▼"}</span> ${up ? "+" : "−"}${Math.abs(q.change_pct).toFixed(2)}%<span class="vh"> ${up ? "up" : "down"} on the day</span></span>
        ${spark(q.closes, { w: 72, h: 22, label: `${q.name}, last ${q.closes.length} closes: ${q.closes.map(fmtNum).join(", ")}`, fmt: fmtNum })}</li>`;
    }).join("")}</ul>`;
    el.hidden = false;
    document.getElementById("markets-note").hidden = false;
  };

  // ── rendering ────────────────────────────────────────
  let day = null;
  const sectionHref = (key) => (DATE ? `./?s=${key}` : `${ROOT}${key}/`);
  const remember = (list) => { for (const s of list) storyIndex[s.id] = s; return list; };

  const storyMeta = (s, ref) =>
    `<p class="meta">${isNew(s) ? `<span class="new" title="New since your last visit"><span aria-hidden="true">新</span><span class="vh">New</span></span>` : ""}` +
    `<span class="src">${esc(s.source)}</span>` + trendTag(s) +
    `<time datetime="${esc(s.published_at)}" title="${esc(fmtExact(s.published_at))}${s.date_estimated ? " (date estimated)" : ""}">${ago(s.published_at, ref)}</time>` +
    (s.date_estimated ? `<span class="est">date estimated</span>` : "") +
    (s.also_covered_by?.length ? `<span>${s.also_covered_by.length + 1} outlets</span>` : "") + `</p>`;

  const alsoLine = (s) => s.also_covered_by?.length
    ? `<p class="also">Also covered by: ${s.also_covered_by.map((a) => `<a href="${esc(safeUrl(a.url))}" rel="noopener" target="_blank">${esc(a.source)}</a>`).join(", ")}</p>` : "";

  const crossLinks = (s) => {
    const others = (s.topic_tags || []).filter((t) => t !== s.section && day.sections[t]);
    return others.length ? `<p class="xlinks">Also relevant to: ${others.map((t) => `<a href="${esc(sectionHref(t))}">${esc(day.sections[t].name)}</a>`).join(", ")}</p>` : "";
  };

  const card = (s, ref, active = null) => `
    <li class="card" data-sec="${esc(s.section)}">
      <div class="card-head">
        <h3><a href="${esc(safeUrl(s.url))}" rel="noopener" target="_blank" data-story>${esc(s.title)}</a></h3>
        ${saveBtn(s)}
      </div>
      ${storyMeta(s, ref)}
      ${s.ai_summary || s.summary ? `<p class="snip">${esc(s.ai_summary || s.summary)}</p>` : ""}
      ${s.matched_keywords?.length ? `<ul class="chips" aria-label="Matched keywords">${s.matched_keywords.map((k) => (active
        ? `<li><button type="button" class="chip" data-kw="${esc(k)}" aria-pressed="${active.has(k)}">${esc(k)}</button></li>`
        : `<li><span class="chip">${esc(k)}</span></li>`)).join("")}</ul>` : ""}
      ${alsoLine(s)}
      ${crossLinks(s)}
    </li>`;

  const whatMatters = (sec) => {
    const wm = sec.what_matters;
    if (!wm.clusters.length) return "";
    const [lead, ...rest] = wm.clusters;
    const kws = wm.keywords.map((k) => `${esc(k.keyword)} (${k.count})`).join(", ");
    return `<div class="brief"><h3>What matters today</h3>
      <p>Leading: <strong>${esc(lead.title)}</strong>${lead.sources > 1 ? `, reported by ${lead.sources} outlets` : ""}.</p>
      ${rest.length ? `<p>Also leading:</p><ul class="wm-list">${rest.map((c) => `<li>${esc(c.title)}${c.sources > 1 ? ` <span class="wm-n">${c.sources} outlets</span>` : ""}</li>`).join("")}</ul>` : ""}
      ${kws ? `<p>Most-mentioned terms: ${kws}.</p>` : ""}</div>`;
  };

  const hud = () => {
    const s = day.stats;
    const fresh = lastSeen && !DATE ? Object.values(day.sections).flatMap((x) => x.items).filter(isNew).length : 0;
    document.getElementById("hud").innerHTML =
      `<span class="zh" lang="zh-Hant">${esc(fmtDayZh(day.date))}</span>${esc(fmtDay(day.date))}` +
      `<span class="sep">/</span>Updated ${esc(fmtExact(day.generated_at))} Toronto time` +
      `<span class="sep">/</span><strong>${s.scanned}</strong> scanned, <strong>${s.kept}</strong> kept` +
      (fresh ? `<span class="sep">/</span><strong>${fresh}</strong> new since your last visit` : "")
    const age = (Date.now() - new Date(day.generated_at)) / 36e5;
    if (!DATE && age > 6) {
      document.getElementById("hud").insertAdjacentHTML("beforeend",
        `<span class="stale">This briefing is ${Math.round(age)} hours old. The next update is running late; it usually arrives within the hour.</span>`);
    }
  };

  const footer = () => {
    const bad = day.health.filter((h) => !h.ok);
    document.getElementById("health").innerHTML = `Feed health: <span class="ok">${day.stats.feeds_ok} of ${day.stats.feeds_total} sources OK</span>.` +
      (bad.length ? `<details><summary>Show ${bad.length} failing source${bad.length > 1 ? "s" : ""}</summary><ul>${bad.map((h) => `<li>${esc(h.name)}: ${esc(h.error)}</li>`).join("")}</ul></details>` : "");
  };

  const ticker = () => {
    const tops = Object.values(day.sections).flatMap((sec) => {
      const byId = Object.fromEntries(sec.items.map((s) => [s.id, s]));
      return sec.top.slice(0, 3).map((id) => byId[id]);
    });
    if (!tops.length) return;
    const row = tops.map((s) => `<a href="${esc(safeUrl(s.url))}" rel="noopener" target="_blank">${esc(s.title)}</a>`).join("");
    const el = document.getElementById("ticker");
    el.innerHTML = `<div class="led-track" style="--crawl:${tops.length * 8}s"><span>${row}</span><span aria-hidden="true">${row.replaceAll("<a ", '<a tabindex="-1" ')}</span></div>`;
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Top headlines");
    el.hidden = false;
  };

  // ── export ───────────────────────────────────────────
  let visible = []; // [{title, stories}] currently on screen
  const asMarkdown = () => [`# ${document.title}`, `_${fmtDay(day.date)}_`, "",
    ...visible.flatMap((g) => [`## ${g.title}`, ...g.stories.map((s) => `- [${s.title}](${s.url}) — ${s.source}${s.summary ? `\n  > ${s.summary}` : ""}`), ""])].join("\n");
  const asText = () => [document.title, fmtDay(day.date), "",
    ...visible.flatMap((g) => [g.title.toUpperCase(), ...g.stories.map((s) => `* ${s.title} (${s.source})\n  ${s.url}`), ""])].join("\n");
  const asHTML = () => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(document.title)} — ${esc(day.date)}</title>
<style>body{font:17px/1.6 Georgia,serif;max-width:44rem;margin:2rem auto;padding:0 16px;color:#13201f}h1,h2{font-family:"Arial Narrow",system-ui,sans-serif}h2{border-bottom:3px solid #b3122a;padding-bottom:.2rem;margin-top:2rem}li{margin:.7rem 0}small{color:#4a5c58}a{color:#13201f}</style>
<h1>${esc(document.title)}</h1><p><small>${esc(fmtDay(day.date))}</small></p>
${visible.map((g) => `<h2>${esc(g.title)}</h2><ul>${g.stories.map((s) => `<li><a href="${esc(safeUrl(s.url))}">${esc(s.title)}</a> <small>${esc(s.source)}</small>${s.summary ? `<br>${esc(s.summary)}` : ""}</li>`).join("")}</ul>`).join("")}
<p><small>Headlines belong to their original publishers.</small></p></html>`;

  const exportButtons = `<div class="exports" role="group" aria-label="Export">
    <button type="button" class="btn" data-export="md">Copy as Markdown</button>
    <button type="button" class="btn" data-export="txt">Copy as plain text</button>
    <button type="button" class="btn" data-export="html">Download HTML</button></div>`;

  main.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-export]");
    if (!b) return;
    if (!visible.some((g) => g.stories.length)) return toast("Nothing to export. Clear the filters first.");
    if (b.dataset.export === "html") {
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(new Blob([asHTML()], { type: "text/html" })), download: `briefing-${day.date}${SECTION ? "-" + SECTION : ""}.html` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return toast("Downloaded HTML");
    }
    try {
      await navigator.clipboard.writeText(b.dataset.export === "md" ? asMarkdown() : asText());
      toast(b.dataset.export === "md" ? "Copied as Markdown" : "Copied as plain text");
    } catch {
      toast("Copy blocked by the browser. Use Download HTML instead.");
    }
  });

  // ── search ───────────────────────────────────────────
  let archiveRows = null;
  const terms = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
  const searchArchive = async (q) => {
    archiveRows ??= await getJSON("data/search.json");
    const t = terms(q);
    return archiveRows.filter((r) => t.every((w) => `${r[2]} ${r[4]}`.toLowerCase().includes(w))).slice(0, 200);
  };
  const matchesQuery = (s, q) => {
    const hay = `${s.title} ${s.summary} ${s.source} ${s.matched_keywords.join(" ")}`.toLowerCase();
    return terms(q).every((t) => hay.includes(t));
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ── views ────────────────────────────────────────────
  const renderHome = () => {
    const ref = new Date(day.generated_at);
    main.innerHTML = `
      <h1 class="vh">${DATE ? `Briefing for ${esc(fmtDay(day.date))}` : "Today's briefing"}</h1>
      <div class="toolbar">
        <label class="grow">Search today's stories<input type="search" id="q" placeholder="e.g. tariffs, Nvidia, city council" autocomplete="off" value="${esc(params.get("q") || "")}"></label>
        <label class="check"><input type="checkbox" id="all-days"> Search all archived days</label>
        ${exportButtons}
      </div>
      <div id="results"></div>`;
    const results = document.getElementById("results");
    const q = document.getElementById("q");
    const allDays = document.getElementById("all-days");

    const overview = () => {
      visible = [];
      results.innerHTML = `<div class="sections">${Object.entries(day.sections).map(([key, sec]) => {
        const byId = Object.fromEntries(sec.items.map((s) => [s.id, s]));
        const top = remember(sec.top.map((id) => byId[id]));
        visible.push({ title: sec.name, stories: top });
        const zh = signFor(key);
        return `<section class="block" data-sec="${esc(key)}" aria-labelledby="h-${esc(key)}">
          ${zh ? `<p class="sign" lang="zh-Hant" aria-hidden="true">${esc(zh)}</p>` : "<span></span>"}
          <div class="block-body">
          <h2 id="h-${esc(key)}"><a href="${esc(sectionHref(key))}">${esc(sec.name)}</a><small>${sec.count} stories</small></h2>
          ${weekStrip(key, sec.name)}
          ${whatMatters(sec)}
          ${top.length ? `<ol class="top" aria-label="Top ${top.length}">${top.map((s) => `<li>
            <div class="card-head"><a class="hl" href="${esc(safeUrl(s.url))}" rel="noopener" target="_blank" data-story>${esc(s.title)}</a>${saveBtn(s)}</div>
            ${storyMeta(s, ref)}</li>`).join("")}</ol>` : `<p class="empty">No ${esc(sec.name)} stories matched today. Edit the keywords in config.yaml to widen the net.</p>`}
          <p class="more"><a href="${esc(sectionHref(key))}">See all ${sec.count} ${esc(sec.name)} stories</a></p>
          </div>
        </section>`;
      }).join("")}</div>`;
    };

    const run = async () => {
      const text = q.value.trim();
      if (!text) return overview();
      if (allDays.checked) {
        results.innerHTML = `<p class="count">Searching the archive…</p>`;
        let rows;
        try { rows = await searchArchive(text); } catch { results.innerHTML = `<p class="empty">The archive index could not be loaded. Search today's stories instead.</p>`; return; }
        if (q.value.trim() !== text) return;
        visible = [{ title: `Archive results for “${text}”`, stories: rows.map((r) => ({ title: r[2], url: r[3], source: r[4], summary: "" })) }];
        results.innerHTML = `<p class="count">${rows.length} match${rows.length === 1 ? "" : "es"} across ${archiveRows.length} archived stories</p>
          <ul class="stories">${rows.map((r) => `<li class="card" data-sec="${esc(r[1])}"><h3><a href="${esc(safeUrl(r[3]))}" rel="noopener" target="_blank" data-story>${esc(r[2])}</a></h3>
          <p class="meta"><span class="src">${esc(r[4])}</span><a href="${ROOT}archive/${esc(r[0])}/">${esc(r[0])}</a></p></li>`).join("")}</ul>`;
        return;
      }
      const hits = remember(Object.values(day.sections).flatMap((s) => s.items).filter((s) => matchesQuery(s, text)));
      visible = [{ title: `Results for “${text}”`, stories: hits }];
      results.innerHTML = `<p class="count">${hits.length} match${hits.length === 1 ? "" : "es"} today</p>` +
        (hits.length ? `<ul class="stories">${hits.map((s) => card(s, ref)).join("")}</ul>` : `<p class="empty">No stories today mention “${esc(text)}”. Tick "Search all archived days" to look further back.</p>`);
    };
    q.addEventListener("input", debounce(run, 150));
    allDays.addEventListener("change", run);
    run();
  };

  const renderSection = () => {
    const sec = day.sections[SECTION];
    if (!sec) { main.innerHTML = `<p class="empty">This section is turned off or has no data for ${esc(day.date)}.</p>`; return; }
    remember(sec.items);
    const ref = new Date(day.generated_at);
    const sources = [...new Set(sec.items.map((s) => s.source))].sort((a, b) => a.localeCompare(b));
    const allKw = [...new Set([...sec.what_matters.keywords.map((k) => k.keyword), ...sec.items.flatMap((s) => s.matched_keywords).sort()])].slice(0, 24);
    // filter state lives in the URL so a filtered view can be bookmarked or shared
    const state = { q: params.get("q") || "", hours: +params.get("h") || 0, source: params.get("src") || "",
                    kws: new Set((params.get("kw") || "").split(",").filter(Boolean)) };
    const zh = signFor(SECTION);
    main.dataset.sec = SECTION;
    main.innerHTML = `
      <div class="page-head">
        ${zh ? `<p class="sign" lang="zh-Hant" aria-hidden="true">${esc(zh)}</p>` : "<span></span>"}
        <div><h1 class="page">${esc(sec.name)}</h1>${whatMatters(sec)}</div>
      </div>
      ${trendsPanel(SECTION, sec.name)}
      <div class="toolbar">
        <label class="grow">Search ${esc(sec.name)}<input type="search" id="q" autocomplete="off" value="${esc(state.q)}"></label>
        <div><span class="field-label" id="time-label">Published within</span>
          <div class="seg" role="group" aria-labelledby="time-label">${[[0, "Any time"], [6, "6h"], [12, "12h"], [24, "24h"]].map(([h, l]) =>
            `<button type="button" data-hours="${h}" aria-pressed="${h === state.hours}">${l}</button>`).join("")}</div></div>
        <label>Source<select id="src"><option value="">All sources</option>${sources.map((s) => `<option${s === state.source ? " selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
        ${exportButtons}
      </div>
      <ul class="chips kwbar" aria-label="Filter by keyword">${allKw.map((k) => `<li><button type="button" class="chip" data-kw="${esc(k)}" aria-pressed="false">${esc(k)}</button></li>`).join("")}</ul>
      <p class="count" id="count" aria-live="polite"></p>
      <ul class="stories" id="list"></ul>`;
    const list = document.getElementById("list");
    const count = document.getElementById("count");

    const syncUrl = () => {
      const p = new URLSearchParams(DATE ? { s: SECTION } : {});
      if (state.q) p.set("q", state.q);
      if (state.hours) p.set("h", state.hours);
      if (state.source) p.set("src", state.source);
      if (state.kws.size) p.set("kw", [...state.kws].join(","));
      history.replaceState(null, "", p.size ? `?${p}` : location.pathname);
    };
    const apply = () => {
      const stories = sec.items.filter((s) =>
        (!state.q || matchesQuery(s, state.q)) &&
        (!state.hours || ref - new Date(s.published_at) <= state.hours * 3600e3) &&
        (!state.source || s.source === state.source) &&
        (!state.kws.size || s.matched_keywords.some((k) => state.kws.has(k))));
      visible = [{ title: sec.name, stories }];
      count.textContent = `Showing ${stories.length} of ${sec.count} stories`;
      list.innerHTML = stories.length ? stories.map((s) => card(s, ref, state.kws)).join("")
        : `<li class="empty">No stories match these filters. Clear a keyword or widen the time window.</li>`;
      main.querySelectorAll(".kwbar .chip").forEach((c) => c.setAttribute("aria-pressed", state.kws.has(c.dataset.kw)));
      syncUrl();
    };

    document.getElementById("q").addEventListener("input", debounce((e) => { state.q = e.target.value.trim(); apply(); }, 120));
    document.getElementById("src").addEventListener("change", (e) => { state.source = e.target.value; apply(); });
    main.querySelector(".seg").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      state.hours = +b.dataset.hours;
      main.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", x === b));
      apply();
    });
    main.addEventListener("click", (e) => {
      const c = e.target.closest(".chip[data-kw]");
      if (!c) return;
      state.kws.has(c.dataset.kw) ? state.kws.delete(c.dataset.kw) : state.kws.add(c.dataset.kw);
      apply();
    });
    apply();
  };

  const renderArchive = (index) => {
    const dates = index.dates;
    main.innerHTML = `<div class="page-head"><p class="sign" lang="zh-Hant" aria-hidden="true">檔案</p><div><h1 class="page">Archive</h1>
      <div class="toolbar"><label>Jump to a date<input type="date" id="pick" min="${esc(dates.at(-1)?.date || "")}" max="${esc(dates[0]?.date || "")}"></label></div>
      <p class="count" id="pick-msg" aria-live="polite">${dates.length} briefing${dates.length === 1 ? "" : "s"} kept</p></div></div>
      <ul class="days">${dates.map((d) => `<li><a href="${esc(d.date)}/">${esc(fmtDay(d.date))}<small>${d.kept} stories from ${d.scanned} scanned</small></a></li>`).join("")}</ul>`;
    document.getElementById("pick").addEventListener("change", (e) => {
      if (dates.some((d) => d.date === e.target.value)) location.href = `${e.target.value}/`;
      else document.getElementById("pick-msg").textContent = `There is no briefing for ${e.target.value}. Pick one of the dates listed below.`;
    });
  };

  function renderSaved() {
    const items = remember(Object.values(saved).sort((a, b) => b.saved_at.localeCompare(a.saved_at)));
    visible = [{ title: "Saved stories", stories: items }];
    main.innerHTML = `<div class="page-head"><p class="sign" lang="zh-Hant" aria-hidden="true">收藏</p><div><h1 class="page">Saved</h1>
      <p class="count">${items.length} saved stor${items.length === 1 ? "y" : "ies"}, kept in this browser only.</p></div></div>
      ${items.length ? `<div class="toolbar">${exportButtons}</div><ul class="stories">${items.map((s) => card(s, Date.now())).join("")}</ul>`
        : `<p class="empty">Nothing saved yet. Use the bookmark button on any story, or press <kbd>s</kbd> on a selected story.</p>`}`;
  }

  const renderTuning = () => {
    const rep = day.keywords || {};
    const list = (rows, unit) => rows.length ? `<ul class="kw-list">${rows.map(([k, c]) => `<li><span class="chip">${esc(k)}</span> ${c}${unit ? ` ${unit}${c === 1 ? "y" : "ies"}` : ""}</li>`).join("")}</ul>` : `<p class="empty-note">None today.</p>`;
    main.innerHTML = `<div class="page-head"><p class="sign" lang="zh-Hant" aria-hidden="true">調校</p><div><h1 class="page">Keyword tuning</h1>
      <p class="lede">How each section's keywords behaved in the ${esc(fmtDay(day.date))} briefing. To change them, edit the <code>keywords</code> and <code>exclude</code> lines under each section in <code>config.yaml</code>.</p></div></div>
      ${Object.keys(rep).length ? "" : `<p class="empty-note">This briefing was made before keyword tuning existed. The next run fills this page.</p>`}
      <div class="sections">${Object.entries(day.sections).map(([key, sec]) => {
        const r = rep[key];
        if (!r) return "";
        return `<section class="block tuning" data-sec="${esc(key)}" aria-labelledby="t-${esc(key)}"><p class="sign" lang="zh-Hant" aria-hidden="true">${esc(signFor(key))}</p><div class="block-body">
          <h2 id="t-${esc(key)}">${esc(sec.name)}<small>${sec.matched ?? sec.count} matched</small></h2>
          <h3>Kept on one keyword alone</h3><p class="hint">Nothing else confirms these stories. If they look like noise, pair the word with another (<code>launch AND (app OR software)</code>) or add it to exclude.</p>
          ${list(r.sole, "stor")}
          <h3>Mentioned most</h3><p class="hint">Fresh stories mentioning each keyword, in any section.</p>${list(r.hits.slice(0, 12), "")}
          <h3>Blocked by exclude rules</h3>${r.excluded.length ? `<ul class="kw-list">${r.excluded.map((e) => `<li><span class="chip">${esc(e.term)}</span> blocked ${e.count}<ul class="ex">${e.examples.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></li>`).join("")}</ul>` : `<p class="empty-note">Nothing was blocked today.</p>`}
          <h3>No matches today</h3>${r.unused.length ? `<p class="chips">${r.unused.map((k) => `<span class="chip">${esc(k)}</span>`).join(" ")}</p><p class="hint">A quiet day explains some of these. A word that stays here for weeks isn't doing anything.</p>` : `<p class="empty-note">Every keyword matched something.</p>`}
        </div></section>`;
      }).join("")}</div>`;
  };

  const renderKowloon = () => {
    const n = streak.count, c = city({ w: 800, h: 373, seed: 1993, days: n, text: true });
    const pct = Math.round((c.lit / c.windows) * 100);
    const next = SIGNS.find((s) => s.day > n);
    const nextLine = next
      ? `Day ${next.day} switches on the <span lang="zh-Hant" class="zh">${next.zh}</span> ${esc(next.en.toLowerCase())} sign${n < FULL_CITY ? `, and day ${FULL_CITY} lights every window` : ""}.`
      : n >= FULL_CITY ? "The whole city is lit. Keep your streak going to keep it that way." : `Day ${FULL_CITY} lights every window.`;
    const steps = [...SIGNS.map((s) => ({ day: s.day, zh: s.zh, en: `${s.en} sign` })), { day: FULL_CITY, zh: "", en: "Every window in the city" }];
    main.innerHTML = `<div class="page-head"><p class="sign" lang="zh-Hant" aria-hidden="true">九龍</p><div><h1 class="page">Kowloon</h1>
      <p class="lede">Your reading streak powers this city. Each day in a row you open the briefing, more windows switch on. Miss a day and it goes dark again, back to day 1.</p></div></div>
      <figure class="scene"><svg class="city" viewBox="0 0 800 373" preserveAspectRatio="xMidYMax slice" role="img" aria-label="The Kowloon Walled City at night, ${c.lit} of ${c.windows} windows lit by your ${n}-day streak">${c.svg}</svg></figure>
      <div class="power">
        <p class="power-day"><strong>Day ${n}</strong> <span>${c.lit.toLocaleString("en-CA")} of ${c.windows.toLocaleString("en-CA")} windows lit</span></p>
        <progress max="${c.windows}" value="${c.lit}" aria-label="Windows lit">${pct}%</progress>
        <p class="power-next">${nextLine}</p>
        <p class="power-best">Best streak: ${streak.best} day${streak.best === 1 ? "" : "s"}.</p>
      </div>
      <h2 class="ms-h">What your streak switches on</h2>
      <ol class="milestones">${steps.map((s) => `<li class="${n >= s.day ? "done" : ""}"><span class="ms-day">Day ${s.day}</span>
        ${s.zh ? `<span class="ms-sign" lang="zh-Hant">${s.zh}</span>` : `<span class="ms-sign ms-all" aria-hidden="true"></span>`}
        <span>${esc(s.en)}</span><span class="ms-state">${n >= s.day ? "On" : `${s.day - n} day${s.day - n === 1 ? "" : "s"} to go`}</span></li>`).join("")}</ol>`;
  };

  // ── keyboard ─────────────────────────────────────────
  const keysDialog = document.getElementById("keys");
  document.getElementById("keys-btn").addEventListener("click", () => keysDialog.showModal());
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, select, textarea") || keysDialog.open) return;
    const links = [...main.querySelectorAll("a[data-story]")];
    const at = links.indexOf(document.activeElement);
    const go = (i) => { const el = links[Math.max(0, Math.min(links.length - 1, i))]; el?.focus(); el?.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" }); };
    const sectionKeys = [...document.querySelectorAll(".mast nav a[data-key]")].filter((a) => day?.sections[a.dataset.key]);
    if (e.key === "/") { e.preventDefault(); document.getElementById("q")?.focus(); }
    else if (e.key === "j") go(at + 1);
    else if (e.key === "k") go(at < 0 ? 0 : at - 1);
    else if (e.key === "o" && at >= 0) links[at].click();
    else if (e.key === "s" && at >= 0) links[at].closest("li")?.querySelector("[data-save]")?.click();
    else if (e.key === "t") toggleTheme();
    else if (e.key === "?") keysDialog.showModal();
    else if (/^[1-9]$/.test(e.key) && sectionKeys[+e.key - 1]) location.href = sectionKeys[+e.key - 1].href;
  });

  // ── boot ─────────────────────────────────────────────
  const markCurrentSection = () => {
    if (!SECTION || body.dataset.section) return; // archive permalinks pick the section from ?s=
    document.querySelectorAll(".mast nav a").forEach((a) => (a.dataset.key === SECTION ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  };
  (async () => {
    try {
      const date = DATE || LATEST;
      const [idx, loaded] = await Promise.all([getJSON("data/index.json"), date ? getJSON(`data/${date}.json`) : null]);
      index = idx;
      day = loaded || (index.latest ? await getJSON(`data/${index.latest}.json`) : null);
      if (!day) { main.innerHTML = `<p class="empty">No briefing yet. Run the "Daily briefing" workflow from the Actions tab to create the first one.</p>`; return; }
      hud();
      footer();
      board();
      if (VIEW === "archive") return renderArchive(index);
      if (VIEW === "saved") return renderSaved();
      if (VIEW === "tuning") return renderTuning();
      if (VIEW === "kowloon") return renderKowloon();
      ticker();
      if (SECTION) { markCurrentSection(); renderSection(); } else renderHome();
      if (!DATE) store.set("lastSeen", day.generated_at);
    } catch (err) {
      main.innerHTML = `<p class="empty">The briefing data could not be loaded (${esc(err.message)}). Reload the page; if it keeps failing, check the latest workflow run.</p>`;
    }
  })();

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register(ROOT + "sw.js").catch(() => { /* offline mode is optional */ });
  }
})();
