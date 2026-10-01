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
  const SIGNS = [ // businesses the Walled City was known for; each switches on at its streak day
    { day: 1, zh: "牙科", en: "Dentist", c: 0, shape: "v", fact: "Unlicensed dentists and doctors crowded the Walled City's edges, where Hong Kong's licensing rules didn't reach." },
    { day: 2, zh: "士多", en: "Corner store", c: 4, shape: "h", fact: "士多 is borrowed from the English word “store”: tiny shops selling soft drinks, cigarettes and snacks." },
    { day: 3, zh: "冰室", en: "Ice café", c: 1, shape: "v", fact: "Before the cha chaan teng, the bing sutt served iced drinks, milk tea and pineapple buns." },
    { day: 5, zh: "理髮", en: "Barber", c: 5, shape: "v", fact: "Barbers worked out of single rooms, a chair and a mirror wedged between staircases." },
    { day: 7, zh: "押", en: "Pawnshop", c: 2, shape: "box", fact: "Hong Kong pawnshops hang a 押 sign, traditionally shaped like a bat holding a coin, for good fortune." },
    { day: 9, zh: "涼茶", en: "Herbal tea", c: 1, shape: "h", fact: "Bitter herbal teas sold by the bowl, meant to cool the body's “inner heat” on humid nights." },
    { day: 11, zh: "麵家", en: "Noodle shop", c: 2, shape: "v", fact: "Small factories in the Walled City made fish balls and noodles for restaurants across Kowloon." },
    { day: 14, zh: "茶餐廳", en: "Teahouse", c: 0, shape: "v", fact: "The Hong Kong café: silk-stocking milk tea, French toast and macaroni soup, fast and cheap." },
    { day: 17, zh: "藥房", en: "Pharmacy", c: 4, shape: "h", fact: "Pharmacies sold Western medicine on one shelf and dried herbs and tiger balm on the next." },
    { day: 21, zh: "酒家", en: "Restaurant", c: 3, shape: "v", fact: "Cantonese restaurants: dim sum carts in the morning, wedding banquets at night." },
    { day: 24, zh: "麻雀", en: "Mahjong parlour", c: 3, shape: "v2", fact: "The clatter of mahjong tiles carried through the alleys long after midnight." },
    { day: 27, zh: "金舖", en: "Goldsmith", c: 2, shape: "h", fact: "Goldsmiths sold the heavy gold bangles given at weddings and births." },
    { day: 30, zh: "影樓", en: "Photo studio", c: 5, shape: "v", fact: "Portrait studios with painted backdrops took wedding and family photos." },
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
  const signShape = (def, x, y) => { // returns [width, height, char positions]
    const ch = [...def.zh], n = ch.length;
    if (def.shape === "h") return [n * 12 + 6, 16, ch.map((c, j) => [c, x + 9 + j * 12, y + 12])];
    if (def.shape === "box") return [20, 20, [[ch[0], x + 10, y + 15]]];
    if (def.shape === "v2") return [26, 30, ch.map((c, j) => [c, x + 7 + j * 12, y + 19])];
    return [13, n * 12 + 6, ch.map((c, j) => [c, x + 6.5, y + 13 + j * 12])];
  };
  const city = ({ w, h, seed, days, text = false }) => {
    const r = rng(seed), share = litShare(days), parts = [], spots = [];
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
      if (r() < 0.6) spots.push({ x, bw, y: (top + 14 + r() * bh * 0.45) | 0 });
      x += bw - ((r() * 3) | 0);
    }
    const signSvg = spots.map((s, i) => {
      const k = i % SIGNS.length, def = SIGNS[k], on = days >= def.day;
      const sx = def.shape === "v" ? s.x + s.bw - 4 : s.x + 3; // vertical boards jut from the corner; others hang flat
      const [sw, sh, chars] = signShape(def, sx, s.y);
      const flick = on && i % 5 === 2 ? " flicker" : "";
      const label = `${def.zh} ${def.en} sign, ${on ? "on" : `switches on at day ${def.day}`}`;
      return `<g class="sgn${on ? " on" : ""}${flick}" data-sign="${k}"${text ? ` tabindex="0" role="button" aria-label="${esc(label)}"` : ""}>` +
        `<rect class="sg c${def.c}" x="${sx}" y="${s.y}" width="${sw}" height="${sh}" rx="${def.shape === "box" ? 10 : 1.5}"/>` +
        (text ? chars.map(([c, cx, cy]) => `<text class="sgt" x="${cx}" y="${cy}">${c}</text>`).join("") +
          `<rect class="hit" x="${sx - 10}" y="${s.y - 12}" width="${sw + 20}" height="${sh + 24}"/>` : "") + `</g>`;
    }).join("");
    return { svg: parts.join("") + signSvg + PLANE, windows, lit, signsOn: SIGNS.filter((d) => days >= d.day).length };
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

  // ── Kowloon page: the skyline (days 1–30) and, once the gate opens at 30, inside the walls (another 30) ──
  const ROOMS = [ // [col, row, colspan] in a 3-column cutaway; row 0 = rooftop, row 4 = ground. day = days past 30.
    { id: "alley", zh: "小巷", en: "The alleys", day: 0, at: [0, 4, 2],
      fact: "Sunlight barely reached the ground-floor alleys. Fluorescent tubes lit them day and night, under dripping pipes and sagging wires." },
    { id: "fish", zh: "魚蛋廠", en: "Fish ball factory", day: 2, at: [0, 3, 1],
      fact: "Small, often unlicensed food factories inside the walls made fish balls sold all over Hong Kong." },
    { id: "dentist", zh: "牙醫", en: "Dentist", day: 5, at: [1, 3, 1],
      fact: "Hong Kong's licensing rules didn't reach inside, so dentists trained in mainland China opened cheap clinics by the dozen." },
    { id: "well", zh: "水井", en: "The wells", day: 8, at: [2, 3, 1],
      fact: "Water came from a handful of wells, later joined by government standpipes; pumps pushed it up through a tangle of pipes." },
    { id: "noodle", zh: "麵廠", en: "Noodle maker", day: 11, at: [0, 2, 1],
      fact: "Noodle makers hung fresh noodles to dry wherever air moved: in corridors, at windows, on the rooftops." },
    { id: "school", zh: "學校", en: "School", day: 14, at: [1, 2, 1],
      fact: "Churches and charities ran kindergartens and schools inside the walls for the city's thousands of children." },
    { id: "temple", zh: "廟", en: "Temple", day: 17, at: [2, 2, 1],
      fact: "Small temples and household shrines sat between flats and factories; incense coils smouldered for days overhead." },
    { id: "stairs", zh: "樓梯", en: "Stairwells", day: 20, at: [0, 1, 1],
      fact: "Buildings grew into each other, so you could cross much of the city through linked stairwells and corridors without touching the ground." },
    { id: "roof", zh: "天台", en: "The rooftops", day: 23, at: [0, 0, 3],
      fact: "Buildings topped out around 14 storeys, the limit for planes landing at Kai Tak. Children played and flew kites on the roofs beneath the jets." },
    { id: "home", zh: "家", en: "A family flat", day: 26, at: [1, 1, 1],
      fact: "Around 33,000 people lived on 2.6 hectares, often a whole family in a single small room." },
    { id: "wires", zh: "電線", en: "The wiring", day: 28, at: [2, 1, 1],
      fact: "Electric wires and water pipes snaked across every ceiling, many of them unofficial connections tapped off the meters." },
    { id: "yamen", zh: "衙門", en: "The Yamen", day: 30, at: [2, 4, 1],
      fact: "The old Yamen, a Qing dynasty government office, was the only building kept when the city was demolished in 1993–94. It still stands in Kowloon Walled City Park." },
  ];

  // ── pixel-art cutaway: a 400×244 canvas scaled up with crisp pixels ──
  const PW = 400, PH = 244, ROW_Y = [4, 45, 92, 139, 186], ROW_H = [38, 44, 44, 44, 44];
  const cell = ([col, row, span]) => ({ x: 4 + col * 132, y: ROW_Y[row], w: span * 132 - 4, h: ROW_H[row] });
  const SPR = { // tiny sprites: one character per pixel, "." is transparent
    person: ["..hh..", ".hhhh.", ".ffff.", "..ff..", ".ssss.", "ssssss", "f.ss.f", "..ss..", ".pppp.", ".p..p.", ".p..p.", "kk..kk"],
    kid: [".hh.", "hhhh", "ffff", ".ss.", "ssss", "f..f", ".pp.", ".p.p"],
    seated: ["..hh..", ".hhhh.", ".ffff.", "..ff..", ".ssss.", "ssssss", ".pppppp", ".p...p"],
    cat: ["k...k.", "kk.kk.", "kkkkkk", ".kkkkkk", ".k..k."],
    pigeon: [".gg.", "gggw", ".gg."],
    tooth: [".www.", "wwwww", "wwwww", "ww.ww", "w...w"],
    lock: [".yy.", "y..y", "yyyy", "yyyy", "yyyy"],
  };
  const paintCutaway = (ctx, days, t) => {
    const R = rng(77); // same speckle every frame; only `t` moves things
    const r = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x | 0, y | 0, w | 0, h | 0); };
    const dot = (x, y, c) => r(x, y, 1, 1, c);
    const spr = (rows, pal, x, y, flip = false) => rows.forEach((row, j) => [...row].forEach((ch, i) => {
      if (pal[ch]) dot(x + (flip ? row.length - 1 - i : i), y + j, pal[ch]);
    }));
    const speckle = (x, y, w, h, cols, n) => { for (let i = 0; i < w * h * n; i++) dot(x + R() * w, y + R() * h, cols[(R() * cols.length) | 0]); };
    const sag = (x, y, w, depth, c) => { for (let i = 0; i < w; i++) dot(x + i, y + Math.sin((Math.PI * i) / w) * depth, c); };
    const glow = (x, y, rad, c) => { // stepped halo, no smooth gradients: pixel-pure
      ctx.globalAlpha = 0.07; for (let k = rad; k > 0; k -= 2) r(x - k, y - k / 2, k * 2, k, c); ctx.globalAlpha = 1;
    };
    const cone = (x, y, w, h, c) => { ctx.globalAlpha = 0.06; for (let k = 0; k < h; k += 2) r(x - w / 2 - k / 2, y + k, w + k, 2, c); ctx.globalAlpha = 1; };
    const tube = (x, y, len, on = true) => { r(x - 1, y - 1, len + 2, 3, "#3b4644"); r(x, y, len, 1, on ? "#f4fffb" : "#6f7c78"); if (on) { glow(x + len / 2, y, 10, "#c8fff0"); } };
    const bulb = (x, y, c = "#ffe9a8") => { r(x, y - 6, 1, 6, "#222"); r(x - 1, y, 3, 2, c); glow(x, y + 1, 9, c); };
    const person = (x, y, shirt, pants = "#2b3550", hair = "#17110f", flip = false) =>
      spr(SPR.person, { h: hair, f: "#d9a37a", s: shirt, p: pants, k: "#111" }, x, y, flip);
    const wallBase = (c, base, tones, dado) => {
      r(c.x, c.y, c.w, c.h, base);
      speckle(c.x, c.y, c.w, c.h, tones, 0.06);
      for (let i = 0; i < c.w / 18; i++) { const sx = c.x + R() * c.w, sh = 6 + R() * c.h * 0.5; ctx.globalAlpha = 0.18; r(sx, c.y + 2, 1 + R() * 2, sh, "#000"); ctx.globalAlpha = 1; }
      r(c.x, c.y, c.w, 2, "#121817"); // ceiling slab shadow
      if (dado) { r(c.x, c.y + c.h - 12, c.w, 9, dado[0]); for (let gx = c.x; gx < c.x + c.w; gx += 4) r(gx, c.y + c.h - 12, 1, 9, dado[1]); r(c.x, c.y + c.h - 8, c.w, 1, dado[1]); }
      r(c.x, c.y + c.h - 3, c.w, 3, "#1c2322"); for (let fx = c.x; fx < c.x + c.w; fx += 6) r(fx, c.y + c.h - 3, 3, 1, "#2a3331"); // floor
    };
    const pipes = (c, y, cols = ["#56645f", "#4a5550"]) => cols.forEach((col, k) => {
      r(c.x, y + k * 3, c.w, 2, col); r(c.x, y + k * 3, c.w, 1, "#7d8b86");
      for (let jx = c.x + 7 + k * 11; jx < c.x + c.w; jx += 26) r(jx, y + k * 3 - 1, 2, 4, "#8a9893");
    });

    // shell: the building's outer skin, slabs and the street
    r(0, 0, PW, PH, "#060a0b");
    for (const y of ROW_Y.slice(1)) { r(0, y - 3, PW, 3, "#2b3433"); r(0, y - 3, PW, 1, "#3d4846"); }
    r(0, 230, PW, 14, "#1a2021"); for (let x = 0; x < PW; x += 8) r(x, 236, 5, 1, "#2a3132"); r(0, 230, PW, 1, "#46504e");

    const painters = {
      roof(c) {
        const bands = ["#140f26", "#1d1530", "#2a1a3a", "#3d2043", "#5a2a45", "#7a3443", "#9a4740", "#b85d3b"];
        bands.forEach((col, k) => r(c.x, c.y + k * (c.h - 8) / bands.length, c.w, (c.h - 8) / bands.length + 1, col));
        for (let i = 0; i < 26; i++) dot(c.x + R() * c.w, c.y + R() * 12, R() < 0.3 ? "#fff8e0" : "#8f84b0");
        // Lion Rock and the Kowloon hills far off, then a band of city glow
        ctx.fillStyle = "#24162f"; ctx.beginPath(); ctx.moveTo(c.x, c.y + 26);
        [[40, 20], [90, 22], [130, 14], [150, 11], [170, 15], [230, 21], [300, 17], [350, 22], [c.w, 24]].forEach(([dx, dy]) => ctx.lineTo(c.x + dx, c.y + dy));
        ctx.lineTo(c.x + c.w, c.y + 30); ctx.lineTo(c.x, c.y + 30); ctx.fill();
        for (let i = 0; i < 60; i++) dot(c.x + R() * c.w, c.y + 24 + R() * 5, ["#ffcf7a", "#ff5fae", "#7fe9d6"][(R() * 3) | 0]);
        r(c.x, c.y + c.h - 8, c.w, 8, "#2b3231"); speckle(c.x, c.y + c.h - 8, c.w, 8, ["#363e3c", "#222827"], 0.15);
        r(c.x, c.y + c.h - 9, c.w, 1, "#4a5452"); // parapet edge
        for (let i = 0; i < 44; i++) { // the aerial forest
          const ax = c.x + 4 + R() * (c.w - 8), ah = 6 + R() * 18, ay = c.y + c.h - 8;
          r(ax, ay - ah, 1, ah, "#3e4c4f");
          const bars = 1 + ((R() * 3) | 0);
          for (let b = 0; b < bars; b++) { const bw = 3 + R() * 6; r(ax - bw / 2, ay - ah + 1 + b * 3, bw, 1, "#4e5f62"); }
        }
        [[60, 9], [205, 11], [330, 8]].forEach(([dx, s]) => { r(c.x + dx, c.y + c.h - 8 - s, 12, s, "#3a4446"); r(c.x + dx, c.y + c.h - 8 - s, 12, 1, "#56625f"); r(c.x + dx + 2, c.y + c.h - 8 - s - 2, 8, 2, "#2c3537"); });
        // laundry line, fluttering
        sag(c.x + 100, c.y + 20, 70, 3, "#9aa"); ["#e8283c", "#2f7fe0", "#f2efe6", "#ffb03a", "#12b89a", "#f2efe6"].forEach((col, k) => {
          const lx = c.x + 106 + k * 10, ly = c.y + 21 + Math.sin((Math.PI * (lx - c.x - 100)) / 70) * 3;
          r(lx + (Math.sin(t * 3 + k) > 0.6 ? 1 : 0), ly, 5, 5 + (k % 2) * 2, col);
        });
        // pigeon coop
        r(c.x + 260, c.y + c.h - 18, 18, 10, "#1e2526"); for (let gx = 0; gx < 18; gx += 2) r(c.x + 260 + gx, c.y + c.h - 18, 1, 10, "#5c6a68");
        spr(SPR.pigeon, { g: "#9aa3b8", w: "#e6ebf2" }, c.x + 263, c.y + c.h - 13); spr(SPR.pigeon, { g: "#8a93a8", w: "#e6ebf2" }, c.x + 270, c.y + c.h - 12, true);
        // a kid on the roof with a kite
        const kx = c.x + 236, ky = c.y + 8 + Math.sin(t * 1.4) * 2;
        spr(SPR.kid, { h: "#111", f: "#d9a37a", s: "#e8283c", p: "#2b3550" }, kx - 30, c.y + c.h - 16);
        sag(kx - 27, ky + 6, 27, -6, "#c9c9c9");
        ctx.fillStyle = "#ff5fae"; ctx.beginPath(); ctx.moveTo(kx, ky); ctx.lineTo(kx + 4, ky + 4); ctx.lineTo(kx, ky + 8); ctx.lineTo(kx - 4, ky + 4); ctx.fill();
        r(kx, ky, 1, 8, "#ffd0e6"); for (let k = 0; k < 5; k++) dot(kx + Math.sin(t * 4 + k) , ky + 9 + k * 2, k % 2 ? "#ffb03a" : "#ff5fae");
        // the Kai Tak approach, every 18 seconds
        const pt = (t % 18) / 18, px = c.x + c.w + 30 - pt * (c.w + 80), py = c.y + 4 + pt * 6;
        if (px > c.x - 40 && px < c.x + c.w + 10) {
          r(px, py + 2, 22, 3, "#2a3134"); r(px + 1, py + 1, 20, 1, "#3c4548"); r(px + 18, py - 2, 3, 4, "#2a3134"); r(px + 8, py + 5, 7, 2, "#2a3134");
          for (let w = 2; w < 18; w += 3) dot(px + w, py + 3, "#ffe9a8");
          dot(px + 1, py + 3, t % 1 < 0.5 ? "#ff3b4e" : "#2a3134"); dot(px + 21, py, (t * 2) % 1 < 0.3 ? "#ffffff" : "#2a3134");
        }
      },
      alley(c) {
        wallBase(c, "#2c3634", ["#33403d", "#253030", "#3a4744"], ["#2f4a40", "#1f342d"]);
        pipes(c, c.y + 4);
        for (let k = 0; k < 5; k++) sag(c.x, c.y + 11 + k, c.w, 4 + k * 1.5, ["#151515", "#3b2f26", "#1f1f2a", "#2a2018", "#141c1c"][k]);
        [[18, "#4a5254"], [104, "#5a4a3a"], [196, "#4a5254"]].forEach(([dx, col]) => { // metal doors with red couplets
          const dx0 = c.x + dx, dy0 = c.y + c.h - 27;
          r(dx0, dy0, 15, 24, col); r(dx0, dy0, 15, 1, "#7d8b86"); for (let ry = 3; ry < 24; ry += 5) { dot(dx0 + 2, dy0 + ry, "#8a9893"); dot(dx0 + 12, dy0 + ry, "#8a9893"); }
          r(dx0 - 3, dy0 + 2, 2, 12, "#b3122a"); r(dx0 + 16, dy0 + 2, 2, 12, "#b3122a"); for (let g = 4; g < 13; g += 3) { dot(dx0 - 3, dy0 + g, "#e8c46a"); dot(dx0 + 16, dy0 + g, "#e8c46a"); }
          r(dx0 + 3, dy0 - 4, 9, 3, "#b3122a"); dot(dx0 + 7, dy0 - 3, "#e8c46a");
        });
        for (let mx = 0; mx < 4; mx++) for (let my = 0; my < 3; my++) { const bx = c.x + 52 + mx * 6, by = c.y + 18 + my * 5; r(bx, by, 5, 4, ["#6b7a6d", "#7a6b5a", "#5a6b7a"][(mx + my) % 3]); dot(bx + 2, by + 1, "#111"); }
        [[140, 6, "#e8283c"], [232, 9, "#12b89a"]].forEach(([dx, n, col]) => { r(c.x + dx, c.y + 16, 6, n * 2, col); glow(c.x + dx + 3, c.y + 16 + n, 8, col); for (let i = 1; i < n * 2; i += 3) r(c.x + dx + 1, c.y + 16 + i, 4, 1, "#fff"); });
        [40, 120, 190].forEach((dx, k) => { const on = !(k === 1 && Math.sin(t * 13) > 0.85); tube(c.x + dx, c.y + 14, 18, on); if (on) cone(c.x + dx + 9, c.y + 16, 14, c.h - 19, "#c8fff0"); });
        [[70, 22], [170, 16]].forEach(([dx, w]) => { r(c.x + dx, c.y + c.h - 4, w, 1, "#7fe9d6"); ctx.globalAlpha = 0.35; r(c.x + dx + 2, c.y + c.h - 4, w - 4, 1, "#f4fffb"); ctx.globalAlpha = 1; });
        for (let k = 0; k < 3; k++) { const dpx = c.x + 60 + k * 70, dy = ((t * 30 + k * 13) % 28); dot(dpx, c.y + 9 + dy, "#9fd9ff"); }
        spr(SPR.cat, { k: "#141414" }, c.x + 160, c.y + c.h - 8);
        const wx = c.x + ((t * 9) % (c.w + 20)) - 10; // someone walking through
        person(wx, c.y + c.h - 15, "#2f7fe0", "#2b3550", "#17110f", false);
        r(wx - 3, c.y + c.h - 20, 12, 2, "#b3122a"); r(wx + 2, c.y + c.h - 18, 1, 4, "#222"); // umbrella
      },
      fish(c) {
        wallBase(c, "#9fb0a8", ["#aebdb6", "#93a39c"], null);
        for (let gx = c.x; gx < c.x + c.w; gx += 4) r(gx, c.y + 2, 1, c.h - 5, "#86978f"); for (let gy = c.y + 2; gy < c.y + c.h - 3; gy += 4) r(c.x, gy, c.w, 1, "#86978f");
        bulb(c.x + 30, c.y + 9); bulb(c.x + 95, c.y + 9);
        [8, 44, 80].forEach((dx) => { const vx = c.x + dx; r(vx, c.y + c.h - 17, 24, 14, "#5b6a6e"); r(vx, c.y + c.h - 17, 24, 1, "#c4d0d2"); r(vx + 1, c.y + c.h - 16, 22, 2, "#1f2729"); r(vx + 3, c.y + c.h - 13, 1, 9, "#8a989b"); r(vx + 20, c.y + c.h - 13, 1, 9, "#3e4a4d");
          for (let s = 0; s < 6; s++) { const sy = ((t * 6 + s * 3 + dx) % 14); ctx.globalAlpha = 0.5 - sy / 30; dot(vx + 6 + ((s * 5) % 12) + Math.sin(t + s) , c.y + c.h - 19 - sy, "#ffffff"); ctx.globalAlpha = 1; } });
        r(c.x + 30, c.y + c.h - 24, 22, 2, "#6b5a45"); r(c.x + 32, c.y + c.h - 26, 18, 2, "#8a9496"); for (let b = 0; b < 8; b++) dot(c.x + 33 + b * 2, c.y + c.h - 27, "#e8c46a");
        person(c.x + 36, c.y + c.h - 15, "#e8ecea", "#3a3f4a", "#f2f2f2"); person(c.x + 104, c.y + c.h - 15, "#e8ecea", "#3a3f4a", "#f2f2f2", true);
        r(c.x + 120, c.y + c.h - 7, 4, 4, "#b3122a"); r(c.x + 2, c.y + c.h - 7, 4, 4, "#2f7fe0"); sag(c.x + 4, c.y + c.h - 4, 30, 1, "#2f8a4a");
      },
      dentist(c) {
        wallBase(c, "#6f8a7e", ["#7a978a", "#647e72"], ["#cfd8d2", "#a9b4ad"]);
        r(c.x + 8, c.y + 6, 14, 10, "#1b2a33"); for (let g = 0; g < 14; g += 3) r(c.x + 8 + g, c.y + 6, 1, 10, "#8a9893"); dot(c.x + 12, c.y + 9, "#ffcf7a"); dot(c.x + 17, c.y + 12, "#7fe9d6");
        r(c.x + 30, c.y + 5, 16, 12, "#b3122a"); spr(SPR.tooth, { w: "#fff" }, c.x + 35, c.y + 8);
        [[52, 6], [62, 7]].forEach(([dx, dy]) => { r(c.x + dx, c.y + dy, 8, 9, "#c9a13b"); r(c.x + dx + 1, c.y + dy + 1, 6, 7, "#f2efe6"); r(c.x + dx + 2, c.y + dy + 3, 4, 1, "#888"); r(c.x + dx + 2, c.y + dy + 5, 3, 1, "#888"); });
        const cx = c.x + 70, cy = c.y + c.h - 4;
        r(cx + 6, cy - 4, 4, 4, "#9aa8aa"); r(cx, cy - 9, 22, 5, "#b3122a"); r(cx, cy - 9, 22, 1, "#e04a5a"); r(cx + 18, cy - 17, 5, 9, "#b3122a"); r(cx + 18, cy - 17, 1, 9, "#e04a5a"); r(cx - 4, cy - 8, 5, 2, "#b3122a");
        spr(SPR.seated, { h: "#17110f", f: "#d9a37a", s: "#ffb03a", p: "#2b3550" }, cx + 2, cy - 16);
        r(cx + 30, c.y + 4, 1, 12, "#9aa8aa"); r(cx + 14, c.y + 15, 17, 1, "#9aa8aa"); r(cx + 12, c.y + 15, 4, 2, "#fff8e0"); glow(cx + 14, c.y + 17, 12, "#fff8e0"); cone(cx + 14, c.y + 17, 6, 14, "#fff8e0");
        person(cx + 32, cy - 12, "#f2f2f2", "#5a6470", "#2a2220", true);
        r(c.x + 6, cy - 16, 14, 16, "#3c4a4c"); for (let s = 0; s < 3; s++) { r(c.x + 6, cy - 12 + s * 4, 14, 1, "#2a3436"); for (let j = 0; j < 4; j++) r(c.x + 8 + j * 3, cy - 15 + s * 4, 2, 3, ["#e8283c", "#7fe9d6", "#ffcf7a", "#f2efe6"][(s + j) % 4]); }
        r(c.x + 24, cy - 9, 6, 2, "#e8ecea"); r(c.x + 26, cy - 7, 2, 7, "#9aa8aa");
      },
      well(c) {
        wallBase(c, "#3a4644", ["#43504e", "#323d3b"], null);
        r(c.x + 6, c.y + c.h - 22, 20, 19, "#3c5a6a"); r(c.x + 6, c.y + c.h - 22, 20, 1, "#6e93a6"); // the pump
        for (let a = 0; a < 16; a++) { const ang = (a / 16) * Math.PI * 2 + t * 2; dot(c.x + 34 + Math.cos(ang) * 6, c.y + c.h - 14 + Math.sin(ang) * 6, "#8a9893"); }
        r(c.x + 33, c.y + c.h - 15, 3, 3, "#c4d0d2");
        r(c.x + 9, c.y + c.h - 19, 7, 7, "#f2efe6"); const na = -2.4 + Math.sin(t * 1.7) * 0.8; dot(c.x + 12 + Math.cos(na) * 2, c.y + c.h - 16 + Math.sin(na) * 2, "#e8283c"); dot(c.x + 12, c.y + c.h - 16, "#222");
        r(c.x + 14, c.y + 6, 3, c.h - 28, "#56645f"); r(c.x + 14, c.y + 6, c.w - 30, 3, "#56645f"); r(c.x + 60, c.y + 6, 3, 20, "#56645f"); r(c.x + 60, c.y + 26, 40, 3, "#56645f"); r(c.x + 97, c.y + 9, 3, 20, "#56645f");
        [[15, 14], [61, 18], [80, 26]].forEach(([dx, dy]) => { r(c.x + dx - 2, c.y + dy, 7, 1, "#c0392b"); r(c.x + dx + 1, c.y + dy - 3, 1, 7, "#c0392b"); });
        r(c.x + 102, c.y + 12, 20, c.h - 15, "#4a5658"); r(c.x + 102, c.y + 12, 20, 1, "#7d8b86"); for (let rv = 15; rv < c.h - 4; rv += 5) { dot(c.x + 103, c.y + rv, "#8a9893"); dot(c.x + 120, c.y + rv, "#8a9893"); }
        r(c.x + 108, c.y + 16, 3, c.h - 22, "#1a2a33"); r(c.x + 108, c.y + 16 + (c.h - 22) * 0.4, 3, (c.h - 22) * 0.6, "#2f7fe0");
        [44, 54, 64, 74].forEach((dx, k) => { r(c.x + dx, c.y + c.h - 9, 7, 6, ["#e8283c", "#2f7fe0", "#e8283c", "#ffb03a"][k]); sag(c.x + dx, c.y + c.h - 11, 7, -2, "#888"); });
        for (let k = 0; k < 3; k++) { const dy = (t * 26 + k * 9) % (c.h - 10); dot(c.x + 70 + k * 12, c.y + 29 + dy * 0.4, "#9fd9ff"); }
        ctx.globalAlpha = 0.3; r(c.x + 40, c.y + c.h - 3, 50, 1, "#7fe9d6"); ctx.globalAlpha = 1; tube(c.x + 30, c.y + 4, 16);
      },
      noodle(c) {
        wallBase(c, "#5a4a3a", ["#64533f", "#4e3f31"], null);
        bulb(c.x + 64, c.y + 8, "#ffd98a");
        [8, 16].forEach((ry) => { r(c.x + 4, c.y + ry, c.w - 8, 1, "#8a6a40"); for (let i = 0; i < (c.w - 12) / 2; i++) { const nx = c.x + 6 + i * 2 + (ry === 16 ? 1 : 0); const len = 6 + ((i * 7) % 5); for (let l = 0; l < len; l++) dot(nx + (l % 4 === 2 ? 1 : 0), c.y + ry + 1 + l, l % 3 ? "#f2e6c0" : "#e2d2a0"); } });
        r(c.x + 10, c.y + c.h - 12, 50, 3, "#7a5530"); r(c.x + 12, c.y + c.h - 9, 2, 6, "#5a3e22"); r(c.x + 56, c.y + c.h - 9, 2, 6, "#5a3e22");
        for (let k = 0; k < 9; k++) r(c.x + 22 + k, c.y + c.h - 13 - Math.min(k, 8 - k), 1, Math.min(k, 8 - k) + 1, "#f6f2e8");
        r(c.x + 70, c.y + c.h - 18, 16, 15, "#5b6a6e"); r(c.x + 70, c.y + c.h - 18, 16, 1, "#9aa8aa"); r(c.x + 86, c.y + c.h - 14 + Math.round(Math.sin(t * 3)), 5, 1, "#9aa8aa");
        [96, 106, 114].forEach((dx, k) => { r(c.x + dx, c.y + c.h - 11 + (k % 2), 9, 8 - (k % 2), "#b8a07a"); r(c.x + dx + 2, c.y + c.h - 8, 5, 1, "#8a6a40"); });
        person(c.x + 40, c.y + c.h - 15, "#f2efe6", "#3a3f4a", "#17110f");
      },
      school(c) {
        wallBase(c, "#8fa38f", ["#9bb09b", "#829682"], ["#5d7a5d", "#4a634a"]);
        r(c.x + 6, c.y + 5, 46, 18, "#7a5530"); r(c.x + 7, c.y + 6, 44, 16, "#1f3a2c");
        for (let l = 0; l < 4; l++) for (let ch = 0; ch < 8 - l; ch++) if ((ch * 3 + l) % 4) r(c.x + 9 + ch * 5, c.y + 8 + l * 4, 3, 1, "#e8f1ec");
        r(c.x + 58, c.y + 6, 8, 8, "#f2efe6"); dot(c.x + 62, c.y + 9, "#111"); dot(c.x + 62, c.y + 10, "#111"); dot(c.x + 63, c.y + 10, "#111");
        const fan = Math.floor(t * 8) % 2; r(c.x + 90, c.y + 2, 1, 3, "#555"); r(c.x + 84 + fan, c.y + 5, 13 - fan * 2, 1, "#777"); dot(c.x + 90, c.y + 5, "#999");
        [[100, 6], [112, 6]].forEach(([dx, dy]) => { r(c.x + dx, c.y + dy, 9, 11, "#2a4a5a"); for (let g = 0; g < 9; g += 2) r(c.x + dx + g, c.y + dy, 1, 11, "#4a5a5a"); });
        for (let row = 0; row < 2; row++) for (let d = 0; d < 4; d++) {
          const dx = c.x + 52 + d * 18 + row * 4, dy = c.y + c.h - 13 + row * 4;
          spr(SPR.kid, { h: "#111", f: "#d9a37a", s: d % 2 ? "#f2efe6" : "#2f7fe0", p: "#2b3550" }, dx + 4, dy - 9);
          r(dx, dy, 12, 2, "#a07040"); r(dx + 1, dy + 2, 1, 4, "#6a4a2a"); r(dx + 10, dy + 2, 1, 4, "#6a4a2a");
        }
        person(c.x + 20, c.y + c.h - 15, "#b3122a", "#2b2b2b", "#2a2220"); tube(c.x + 40, c.y + 3, 20);
      },
      temple(c) {
        wallBase(c, "#4a1416", ["#561a1c", "#3e1012"], null);
        for (let gx = c.x + 4; gx < c.x + c.w; gx += 10) { dot(gx, c.y + 6, "#c9a13b"); dot(gx + 5, c.y + 8, "#c9a13b"); }
        [[16, 0], [48, 1], [80, 0], [108, 1]].forEach(([dx, k]) => { // incense coils hanging from the ceiling
          const ix = c.x + dx; r(ix, c.y + 2, 1, 4, "#777");
          for (let ring = 0; ring < 5; ring++) { const rw = 2 + ring * 2, ry = c.y + 6 + ring * 2; r(ix - rw / 2, ry, rw + 1, 1, ring % 2 ? "#b07a3a" : "#8a5a2a"); }
          r(ix - 1, c.y + 16, 3, 2, "#e8c46a"); dot(ix, c.y + 18, Math.sin(t * 5 + k * 2) > 0 ? "#ff5a3a" : "#ffb03a");
        });
        r(c.x + 30, c.y + c.h - 15, 66, 12, "#8e1b24"); r(c.x + 30, c.y + c.h - 15, 66, 1, "#e8c46a"); r(c.x + 30, c.y + c.h - 5, 66, 1, "#c9a13b");
        const gx0 = c.x + 56; r(gx0, c.y + c.h - 30, 14, 15, "#c9a13b"); r(gx0 + 4, c.y + c.h - 34, 6, 5, "#c9a13b"); r(gx0 + 2, c.y + c.h - 26, 10, 1, "#f2d27a"); dot(gx0 + 6, c.y + c.h - 32, "#7a5a1a"); dot(gx0 + 8, c.y + c.h - 32, "#7a5a1a");
        glow(gx0 + 7, c.y + c.h - 24, 14, "#ffcf7a");
        [36, 88].forEach((dx) => { r(c.x + dx, c.y + c.h - 21, 2, 6, "#e8283c"); dot(c.x + dx, c.y + c.h - 22 - (Math.sin(t * 9 + dx) > 0.3 ? 1 : 0), "#ffcf7a"); glow(c.x + dx, c.y + c.h - 22, 5, "#ffcf7a"); });
        [44, 76].forEach((dx) => { r(c.x + dx, c.y + c.h - 17, 6, 2, "#e8901f"); dot(c.x + dx + 1, c.y + c.h - 18, "#e8901f"); dot(c.x + dx + 3, c.y + c.h - 18, "#ffb03a"); });
        [8, 116].forEach((dx) => { r(c.x + dx, c.y + 20, 7, 9, "#e8283c"); r(c.x + dx, c.y + 20, 7, 1, "#c9a13b"); r(c.x + dx, c.y + 28, 7, 1, "#c9a13b"); r(c.x + dx + 3, c.y + 29, 1, 4, "#e8c46a"); glow(c.x + dx + 3, c.y + 24, 8, "#ff3b4e"); });
        for (let s = 0; s < 10; s++) { const sy = (t * 5 + s * 2.3) % 22; ctx.globalAlpha = 0.45 - sy / 50; dot(c.x + 63 + Math.sin(t * 2 + s) * 2 + Math.sin(sy / 3) * 2, c.y + c.h - 36 - sy, "#d8d0c8"); ctx.globalAlpha = 1; }
      },
      stairs(c) {
        wallBase(c, "#3a4240", ["#434c4a", "#323937"], null);
        for (let g = 0; g < 14; g++) dot(c.x + 70 + R() * 30, c.y + 8 + R() * 10, ["#e8283c", "#2f7fe0", "#ffb03a", "#12b89a"][g % 4]);
        r(c.x + 100, c.y + 6, 14, 14, "#0b1418"); for (let g = 0; g < 14; g += 3) r(c.x + 100 + g, c.y + 6, 1, 14, "#6a7472"); for (let w = 0; w < 9; w++) dot(c.x + 101 + R() * 12, c.y + 8 + R() * 10, R() < 0.5 ? "#ffcf7a" : "#7fe9d6");
        for (let s = 0; s < 8; s++) { const sx = c.x + 6 + s * 9, sy = c.y + c.h - 4 - s * 4.5; r(sx, sy, 10, 2, "#6b7775"); r(sx, sy, 10, 1, "#8a9694"); r(sx, sy + 2, 10, c.y + c.h - sy - 2, "#2b3331"); }
        for (let s = 0; s < 8; s++) { const sx = c.x + 8 + s * 9, sy = c.y + c.h - 14 - s * 4.5; r(sx, sy, 1, 9, "#9aa8aa"); }
        for (let k = 0; k < 66; k++) dot(c.x + 8 + k, c.y + c.h - 14 - (k / 9) * 4.5, "#9aa8aa");
        spr(SPR.kid, { h: "#111", f: "#d9a37a", s: "#ffb03a", p: "#2b3550" }, c.x + 33, c.y + c.h - 24);
        r(c.x + 4, c.y + c.h - 5, 3, 2, "#e8283c"); r(c.x + 8, c.y + c.h - 5, 3, 2, "#e8283c"); bulb(c.x + 50, c.y + 8);
      },
      home(c) {
        wallBase(c, "#6f7f8a", ["#7a8a96", "#64737d"], null);
        r(c.x + 4, c.y + 8, 24, 30, "#4a3a2a"); r(c.x + 4, c.y + 20, 24, 2, "#3a2a1a"); // bunk bed
        for (let b = 0; b < 22; b += 2) { r(c.x + 5 + b, c.y + 17, 2, 3, b % 4 ? "#e8283c" : "#f2efe6"); r(c.x + 5 + b, c.y + 30, 2, 3, b % 4 ? "#2f7fe0" : "#f2efe6"); }
        spr(SPR.kid, { h: "#111", f: "#d9a37a", s: "#12b89a", p: "#2b3550" }, c.x + 12, c.y + 9);
        r(c.x + 34, c.y + 6, 10, 9, "#f2efe6"); r(c.x + 34, c.y + 6, 10, 2, "#e8283c"); r(c.x + 37, c.y + 9, 4, 4, "#333"); // calendar
        r(c.x + 50, c.y + 7, 6, 5, "#c9a13b"); r(c.x + 51, c.y + 8, 4, 3, "#556"); r(c.x + 58, c.y + 8, 5, 4, "#c9a13b"); r(c.x + 59, c.y + 9, 3, 2, "#655");
        r(c.x + 36, c.y + c.h - 13, 34, 2, "#8a5a2a"); r(c.x + 38, c.y + c.h - 11, 1, 8, "#6a4a2a"); r(c.x + 67, c.y + c.h - 11, 1, 8, "#6a4a2a");
        r(c.x + 40, c.y + c.h - 18, 7, 5, "#f2efe6"); r(c.x + 41, c.y + c.h - 19, 5, 1, "#ccc"); r(c.x + 50, c.y + c.h - 20, 4, 7, "#e8283c"); dot(c.x + 51, c.y + c.h - 17, "#ffb03a"); r(c.x + 57, c.y + c.h - 15, 4, 2, "#f2efe6"); r(c.x + 62, c.y + c.h - 15, 4, 2, "#f2efe6");
        spr(SPR.seated, { h: "#d0d0d0", f: "#d9a37a", s: "#5a3a6a", p: "#2b2b2b" }, c.x + 70, c.y + c.h - 11);
        r(c.x + 84, c.y + c.h - 21, 18, 14, "#2a2a2a"); r(c.x + 86, c.y + c.h - 19, 14, 10, ["#2f7fe0", "#12b89a", "#e8901f", "#7fe9d6"][Math.floor(t * 2) % 4]); r(c.x + 88, c.y + c.h - 7, 2, 4, "#222"); r(c.x + 96, c.y + c.h - 7, 2, 4, "#222");
        glow(c.x + 93, c.y + c.h - 14, 12, "#7fe9d6");
        r(c.x + 106, c.y + 5, 18, 16, "#0b1418"); for (let g = 0; g < 18; g += 3) r(c.x + 106 + g, c.y + 5, 1, 16, "#8a9893"); for (let g = 0; g < 16; g += 4) r(c.x + 106, c.y + 5 + g, 18, 1, "#8a9893");
        r(c.x + 108, c.y + 24, 14, 6, "#8e1b24"); dot(c.x + 111, c.y + 26, "#ff3b4e"); dot(c.x + 118, c.y + 26, "#ff3b4e"); glow(c.x + 115, c.y + 27, 7, "#ff3b4e");
        bulb(c.x + 60, c.y + 9, "#ffe9a8");
      },
      wires(c) {
        wallBase(c, "#2a2f2e", ["#323837", "#232827"], null);
        for (let my = 0; my < 3; my++) for (let mx = 0; mx < 7; mx++) { // electricity meters, discs turning
          const bx = c.x + 6 + mx * 11, by = c.y + 10 + my * 10;
          r(bx, by, 9, 8, "#3c4446"); r(bx + 1, by + 1, 7, 4, "#e8ecea"); r(bx + 1 + ((Math.floor(t * (3 + mx + my)) % 5)), by + 4, 2, 1, "#111"); dot(bx + 4, by + 6, "#e8283c");
        }
        for (let k = 0; k < 9; k++) sag(c.x, c.y + 6 + k, c.w, 4 + (k * 7) % 9, ["#151515", "#3b2f26", "#20282a", "#4a2020", "#1a1a2a"][k % 5]);
        r(c.x + 90, c.y + 14, 14, 18, "#4a5254"); r(c.x + 90, c.y + 14, 14, 1, "#7d8b86"); r(c.x + 95, c.y + 18, 4, 4, "#ffb03a");
        if (Math.sin(t * 7) > 0.92) { for (let s = 0; s < 6; s++) dot(c.x + 104 + R() * 6, c.y + 16 + R() * 6, "#fff3a0"); glow(c.x + 106, c.y + 18, 8, "#fff3a0"); }
        for (let ly = 0; ly < 22; ly += 3) r(c.x + 112, c.y + c.h - 4 - ly, 8, 1, "#9a8a5a"); r(c.x + 112, c.y + c.h - 26, 1, 23, "#9a8a5a"); r(c.x + 119, c.y + c.h - 26, 1, 23, "#9a8a5a");
        tube(c.x + 30, c.y + 4, 22);
      },
      yamen(c) {
        for (let k = 0; k < 6; k++) r(c.x, c.y + k * 4, c.w, 4, ["#0d1424", "#111a2c", "#152034", "#1a263a", "#1e2c40", "#223246"][k]);
        for (let s = 0; s < 6; s++) dot(c.x + R() * c.w, c.y + R() * 10, "#fff8e0");
        r(c.x, c.y + c.h - 6, c.w, 6, "#3a3a34"); for (let p = 0; p < c.w; p += 6) r(c.x + p, c.y + c.h - 6, 5, 1, "#56564c");
        const rx = c.x + 18, rw = c.w - 36, ry = c.y + 10;
        for (let k = 0; k < 7; k++) r(rx - 6 + k, ry + k, rw + 12 - k * 2, 1, "#3b4a44"); // stepped roof
        r(rx - 8, ry - 1, 3, 2, "#3b4a44"); r(rx + rw + 5, ry - 1, 3, 2, "#3b4a44"); // upturned eaves
        for (let tx = rx - 4; tx < rx + rw + 4; tx += 2) r(tx, ry + 1, 1, 5, "#2a3632");
        r(rx - 6, ry - 1, rw + 12, 1, "#5a6a62");
        r(rx, ry + 7, rw, c.h - 23, "#cbbfa8"); speckle(rx, ry + 7, rw, c.h - 23, ["#bfb39c", "#d6cbb6"], 0.08);
        [0, 0.33, 0.66, 1].forEach((f) => r(rx + f * (rw - 3), ry + 7, 3, c.h - 23, "#8e1b24"));
        r(rx + rw / 2 - 10, ry + 9, 20, 5, "#1a1a1a"); r(rx + rw / 2 - 9, ry + 10, 18, 3, "#c9a13b");
        r(rx + rw / 2 - 6, c.y + c.h - 15, 12, 9, "#6b2a1f"); r(rx + rw / 2, c.y + c.h - 15, 1, 9, "#3a140f");
        [rx + 6, rx + rw - 10].forEach((lx) => { r(lx, ry + 14, 4, 5, "#e8283c"); glow(lx + 2, ry + 16, 8, "#ff3b4e"); });
        [4, c.w - 14].forEach((dx) => { for (let b = 0; b < 30; b++) dot(c.x + dx + R() * 10, c.y + c.h - 16 + R() * 10, R() < 0.5 ? "#2f5d4a" : "#3f7a5e"); r(c.x + dx + 4, c.y + c.h - 7, 2, 2, "#4a3020"); });
      },
    };

    ROOMS.forEach((room) => {
      const c = cell(room.at);
      if (days >= room.day) { ctx.save(); ctx.beginPath(); ctx.rect(c.x, c.y, c.w, c.h); ctx.clip(); painters[room.id](c); ctx.restore(); return; }
      // closed: a roll-up metal shutter with rust and a padlock
      r(c.x, c.y, c.w, c.h, "#2a3436");
      for (let sy = c.y; sy < c.y + c.h; sy += 3) { r(c.x, sy, c.w, 1, "#3a4648"); r(c.x, sy + 2, c.w, 1, "#1a2224"); }
      for (let i = 0; i < c.w / 10; i++) { ctx.globalAlpha = 0.25; r(c.x + R() * c.w, c.y + R() * c.h * 0.5, 1, 4 + R() * 10, "#6b3a1f"); ctx.globalAlpha = 1; }
      r(c.x, c.y + c.h - 3, c.w, 3, "#4a5456");
      spr(SPR.lock, { y: "#c9a13b" }, c.x + c.w / 2 - 2, c.y + c.h - 9);
    });
  };

  // one set of window listeners for drag-to-pan, whichever scene is on screen
  let pan = null, panMoved = false;
  addEventListener("pointermove", (e) => {
    if (!pan) return;
    if (Math.abs(e.clientX - pan.x) > 4) { panMoved = true; pan.el.classList.add("dragging"); }
    pan.el.scrollLeft = pan.left - (e.clientX - pan.x);
  });
  addEventListener("pointerup", () => { if (pan) pan.el.classList.remove("dragging"); pan = null; });
  const pannable = (el) => el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") { pan = { el, x: e.clientX, left: el.scrollLeft }; panMoved = false; }
  });
  const zhSpan = (s) => `<span lang="zh-Hant" class="zh">${s}</span>`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  const renderKowloon = () => {
    const unlocked = streak.best >= FULL_CITY, inside = location.hash === "#inside";
    main.innerHTML = `<div class="page-head"><p class="sign" lang="zh-Hant" aria-hidden="true">${inside ? "城寨" : "九龍"}</p><div><h1 class="page">${inside ? "Inside the walls" : "Kowloon"}</h1>
      <p class="lede">${inside
        ? "The Kowloon Walled City from the inside: a block cut open from the alleys to the rooftops. Every day in a row past day 30 opens another room. Tap a room to learn what happened there."
        : "Your reading streak powers this city. Each day in a row you open the briefing, more windows and signs switch on. Miss a day and it goes dark again, back to day 1."}</p></div></div>
      <div class="k-tabs" role="tablist" aria-label="Kowloon views">
        <button type="button" role="tab" data-go="" aria-selected="${!inside}">${zhSpan("九龍")} The skyline</button>
        <button type="button" role="tab" data-go="#inside" aria-selected="${inside}" class="${unlocked ? "" : "locked"}">${zhSpan("城寨")} Inside the walls
          ${unlocked ? "" : `<span class="lock-note">opens at day ${FULL_CITY}</span>`}</button>
      </div>
      <div id="k-body"></div>`;
    main.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => {
      history.replaceState(null, "", b.dataset.go || location.pathname);
      renderKowloon();
    }));
    (inside ? renderInside : renderOutside)(document.getElementById("k-body"), unlocked);
  };
  addEventListener("hashchange", () => VIEW === "kowloon" && renderKowloon());

  const renderOutside = (body, unlocked) => {
    const mine = Math.max(1, streak.count);
    const state = { days: mine, flipped: 0 };
    const flipText = () => (state.flipped ? `You flipped ${plural(state.flipped, "light")} by hand. They reset when the city redraws.` : "");
    body.innerHTML = `
      <div class="k-controls" role="group" aria-label="City controls">
        <label class="k-field k-preview">Preview a streak: <strong id="k-day-label"></strong>
          <input type="range" id="k-day" min="1" max="${FULL_CITY}" step="1" value="${Math.min(mine, FULL_CITY)}"></label>
        <button type="button" class="btn" id="k-mine">Back to my streak (day ${mine})</button>
        <div class="k-field"><span id="k-time-l">Time of day</span>
          <div class="seg" role="group" aria-labelledby="k-time-l">${["dusk", "night", "dawn"].map((t) =>
            `<button type="button" data-time="${t}" aria-pressed="${t === "night"}">${t === "night" ? "Midnight" : t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div></div>
        <div class="k-field"><span id="k-wx-l">Weather</span>
          <div class="seg" role="group" aria-labelledby="k-wx-l"><button type="button" data-rain="0" aria-pressed="true">Clear</button><button type="button" data-rain="1" aria-pressed="false">Rain</button></div></div>
        <button type="button" class="btn" id="k-plane">Land a plane</button>
      </div>
      <div class="scene-wrap" id="k-wrap"><div class="scene t-night" id="k-scene"><svg class="city" id="k-city" viewBox="0 0 1600 420" preserveAspectRatio="xMidYMax meet" role="img"></svg></div><div class="rain" aria-hidden="true"></div></div>
      <p class="k-hint">Drag or swipe to look around. Tap a sign to read about it, or tap a window to flip its light.</p>
      <div class="k-below">
        <aside class="sign-card" id="k-card" aria-live="polite"></aside>
        <div class="power" id="k-power"></div>
      </div>
      <h2 class="ms-h">Signs on the street</h2>
      <ul class="registry" id="k-reg"></ul>`;

    const scene = document.getElementById("k-scene"), svg = document.getElementById("k-city");
    const card = (k) => {
      const d = SIGNS[k], on = state.days >= d.day;
      document.getElementById("k-card").innerHTML = `<p class="sc-sign sc-c${d.c}${on ? " on" : ""}" lang="zh-Hant" aria-hidden="true">${d.zh}</p>
        <div><h3>${zhSpan(d.zh)} ${esc(d.en)}</h3><p class="sc-state">${on ? "Switched on" : `Switches on at day ${d.day}`}</p><p>${esc(d.fact)}</p></div>`;
    };
    const draw = () => {
      const c = city({ w: 1600, h: 420, seed: 1993, days: state.days, text: true });
      svg.innerHTML = c.svg;
      svg.style.setProperty("--fly-from", "1700px");
      svg.setAttribute("aria-label", `The Kowloon Walled City, ${c.lit} of ${c.windows} windows and ${c.signsOn} of ${SIGNS.length} signs lit at day ${state.days}`);
      const preview = state.days !== mine;
      document.getElementById("k-day-label").textContent = `day ${state.days}${preview ? " (preview)" : ", your streak"}`;
      document.getElementById("k-mine").hidden = !preview;
      const next = SIGNS.find((s) => s.day > state.days);
      document.getElementById("k-power").innerHTML = `
        <p class="power-day"><strong>Day ${state.days}</strong> <span>${c.lit.toLocaleString("en-CA")} of ${c.windows.toLocaleString("en-CA")} windows, ${c.signsOn} of ${SIGNS.length} signs</span></p>
        <progress max="${c.windows}" value="${c.lit}" aria-label="Windows lit"></progress>
        <p class="power-next">${next ? `Day ${next.day} switches on the ${zhSpan(next.zh)} ${esc(next.en.toLowerCase())} sign.` : "Every window and sign in the city is on."}</p>
        <p class="power-best">${preview ? `Previewing. Your real streak is day ${mine}.` : `Best streak: ${plural(streak.best, "day")}.`}</p>
        <p class="power-best" id="k-flips">${flipText()}</p>
        ${unlocked ? `<button type="button" class="btn gate" data-go-inside>The gate is open: go inside the walls</button>`
          : `<p class="power-best">At day ${FULL_CITY} the gate opens and you can go inside the Walled City.</p>`}`;
      document.getElementById("k-reg").innerHTML = SIGNS.map((d, k) => `<li><button type="button" class="reg${state.days >= d.day ? " on" : ""}" data-reg="${k}">
        <span class="sc-sign sc-c${d.c}${state.days >= d.day ? " on" : ""}" lang="zh-Hant" aria-hidden="true">${d.zh}</span>
        <span class="reg-t"><strong>${esc(d.en)}</strong><span>${state.days >= d.day ? "On" : `Day ${d.day}`}</span></span></button></li>`).join("");
    };
    draw();
    card(0);
    scene.scrollLeft = (scene.scrollWidth - scene.clientWidth) / 2;
    pannable(scene);

    const day = document.getElementById("k-day");
    day.addEventListener("input", () => { state.days = +day.value; draw(); });
    document.getElementById("k-mine").addEventListener("click", () => { state.days = mine; day.value = Math.min(mine, FULL_CITY); draw(); });
    body.querySelectorAll("[data-time]").forEach((b) => b.addEventListener("click", () => {
      scene.classList.remove("t-dusk", "t-night", "t-dawn");
      scene.classList.add(`t-${b.dataset.time}`);
      body.querySelectorAll("[data-time]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    }));
    body.querySelectorAll("[data-rain]").forEach((b) => b.addEventListener("click", () => {
      document.getElementById("k-wrap").classList.toggle("raining", b.dataset.rain === "1");
      body.querySelectorAll("[data-rain]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    }));
    document.getElementById("k-plane").addEventListener("click", () => {
      const plane = svg.querySelector(".plane");
      plane.classList.remove("landing");
      void plane.getBoundingClientRect(); // restart the animation
      plane.classList.add("landing");
      toast("Kai Tak approach: jets passed so low over Kowloon that people on the roofs could read the airline names.");
    });
    body.addEventListener("click", (e) => {
      if (e.target.closest("[data-go-inside]")) { location.hash = "inside"; return; }
      const b = e.target.closest("[data-reg]");
      if (!b) return;
      const k = +b.dataset.reg, el = svg.querySelector(`.sgn[data-sign="${k}"]`);
      card(k);
      if (el) {
        const box = el.getBoundingClientRect(), sb = scene.getBoundingClientRect();
        scene.scrollTo({ left: scene.scrollLeft + box.left - sb.left - sb.width / 2, behavior: reduceMotion ? "auto" : "smooth" });
        scene.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
        pulse(el);
      }
    });
    const pulse = (el) => { el.classList.remove("pulse"); void el.getBoundingClientRect(); el.classList.add("pulse"); };
    svg.addEventListener("click", (e) => {
      if (panMoved) { panMoved = false; return; }
      const sign = e.target.closest(".sgn");
      if (sign) { card(+sign.dataset.sign); return pulse(sign); }
      const win = e.target.closest(".cw");
      if (win) {
        win.classList.toggle("on");
        win.classList.remove("on2");
        state.flipped++;
        document.getElementById("k-flips").textContent = flipText();
      }
    });
    svg.addEventListener("keydown", (e) => {
      const sign = e.target.closest?.(".sgn");
      if (sign && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); card(+sign.dataset.sign); pulse(sign); }
    });
  };

  const renderInside = (body, unlocked) => {
    const mine = Math.max(0, Math.min(FULL_CITY, streak.count - FULL_CITY)); // days past 30, this streak
    const state = { days: unlocked ? mine : ROOMS[3].day, torch: false, sel: 0 };
    body.innerHTML = `
      ${unlocked ? (streak.count < FULL_CITY ? `<p class="k-note">Your streak reset to day ${streak.count}, so the rooms are dark again. They reopen one by one from day ${FULL_CITY + 1}.</p>` : "")
        : `<p class="k-note">You're peeking. The gate opens for real when your streak reaches day ${FULL_CITY} (you're on day ${Math.max(1, streak.count)}). Until then this is a preview.</p>`}
      <div class="k-controls" role="group" aria-label="Inside controls">
        <label class="k-field k-preview">${unlocked ? "Preview days inside" : "Preview"}: <strong id="i-day-label"></strong>
          <input type="range" id="i-day" min="0" max="${FULL_CITY}" step="1" value="${state.days}"></label>
        ${unlocked ? `<button type="button" class="btn" id="i-mine">Back to my streak</button>` : ""}
        <button type="button" class="btn" id="i-torch" aria-pressed="false">Torch</button>
      </div>
      <div class="scene-wrap inside" id="i-wrap"><div class="scene scene-in" id="i-scene"><div class="cut">
        <canvas id="i-canvas" width="${PW}" height="${PH}" role="img"></canvas><div class="rooms" id="i-rooms"></div>
      </div></div><div class="torch" aria-hidden="true"></div></div>
      <p class="k-hint">Tap a room to learn about it. Turn on the torch and move your finger or mouse to explore in the dark.</p>
      <div class="k-below">
        <aside class="sign-card" id="i-card" aria-live="polite"></aside>
        <div class="power" id="i-power"></div>
      </div>
      <h2 class="ms-h">Rooms</h2>
      <ul class="registry" id="i-reg"></ul>`;

    const canvas = document.getElementById("i-canvas"), ctx = canvas.getContext("2d");
    const wrap = document.getElementById("i-wrap"), scene = document.getElementById("i-scene"), roomsEl = document.getElementById("i-rooms");
    const pct = (v, of) => `${((v / of) * 100).toFixed(3)}%`;
    const card = (k) => {
      const r = ROOMS[k], open = state.days >= r.day;
      document.getElementById("i-card").innerHTML = `<p class="sc-sign sc-c2${open ? " on" : ""}" lang="zh-Hant" aria-hidden="true">${r.zh}</p>
        <div><h3>${zhSpan(r.zh)} ${esc(r.en)}</h3><p class="sc-state">${open ? "Open" : `Opens at day ${FULL_CITY + r.day}`}</p><p>${open ? esc(r.fact) : "The shutter is down. Keep your streak going to open it."}</p></div>`;
    };
    const pick = (k) => {
      state.sel = k;
      card(k);
      roomsEl.querySelectorAll(".room-btn").forEach((b) => b.setAttribute("aria-pressed", +b.dataset.room === k));
    };
    const draw = () => {
      const open = ROOMS.filter((r) => state.days >= r.day).length;
      canvas.setAttribute("aria-label", `Pixel-art cutaway of a Walled City block, ${open} of ${ROOMS.length} rooms open`);
      roomsEl.innerHTML = ROOMS.map((r, k) => {
        const c = cell(r.at), on = state.days >= r.day;
        return `<button type="button" class="room-btn${on ? " open" : ""}" data-room="${k}" aria-pressed="${k === state.sel}"
          style="left:${pct(c.x, PW)};top:${pct(c.y, PH)};width:${pct(c.w, PW)};height:${pct(c.h, PH)}"
          aria-label="${esc(`${r.zh} ${r.en}, ${on ? "open" : `opens at day ${FULL_CITY + r.day}`}`)}">
          <span class="rl" lang="zh-Hant" aria-hidden="true">${r.zh}</span>${on ? "" : `<span class="rlk" aria-hidden="true">Day ${FULL_CITY + r.day}</span>`}</button>`;
      }).join("");
      const preview = !unlocked || state.days !== mine;
      document.getElementById("i-day-label").textContent = `day ${FULL_CITY + state.days}${preview ? " (preview)" : ", your streak"}`;
      const mineBtn = document.getElementById("i-mine");
      if (mineBtn) mineBtn.hidden = !preview;
      const next = ROOMS.find((r) => r.day > state.days);
      document.getElementById("i-power").innerHTML = `
        <p class="power-day"><strong>Day ${FULL_CITY + state.days}</strong> <span>${open} of ${ROOMS.length} rooms open</span></p>
        <progress max="${ROOMS.length}" value="${open}" aria-label="Rooms open"></progress>
        <p class="power-next">${next ? `Day ${FULL_CITY + next.day} opens ${zhSpan(next.zh)} ${esc(next.en.toLowerCase())}.` : "Every room is open. You've seen the whole Walled City."}</p>
        <p class="power-best">${preview ? "Previewing." : `Best streak: ${plural(streak.best, "day")}.`}</p>`;
      document.getElementById("i-reg").innerHTML = ROOMS.map((r, k) => `<li><button type="button" class="reg${state.days >= r.day ? " on" : ""}" data-room-reg="${k}">
        <span class="sc-sign sc-c2${state.days >= r.day ? " on" : ""}" lang="zh-Hant" aria-hidden="true">${r.zh}</span>
        <span class="reg-t"><strong>${esc(r.en)}</strong><span>${state.days >= r.day ? "Open" : `Day ${FULL_CITY + r.day}`}</span></span></button></li>`).join("");
      card(state.sel);
      paintCutaway(ctx, state.days, performance.now() / 1000);
    };

    // animation: ~12 fps, only while the cutaway is on screen and the tab is visible; still frame for reduced motion
    let visible = true, last = 0;
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(canvas);
    const tick = (now) => {
      if (!canvas.isConnected) return; // page re-rendered: stop
      if (visible && !document.hidden && now - last > 80) { last = now; paintCutaway(ctx, state.days, now / 1000); }
      requestAnimationFrame(tick);
    };
    if (!reduceMotion) requestAnimationFrame(tick);

    document.getElementById("i-torch").addEventListener("click", (e) => {
      state.torch = !state.torch;
      e.currentTarget.setAttribute("aria-pressed", state.torch);
      wrap.classList.toggle("torch-on", state.torch);
    });
    wrap.addEventListener("pointermove", (e) => {
      const b = wrap.getBoundingClientRect();
      wrap.style.setProperty("--mx", `${e.clientX - b.left}px`);
      wrap.style.setProperty("--my", `${e.clientY - b.top}px`);
    });
    pannable(scene);
    roomsEl.addEventListener("click", (e) => {
      if (panMoved) { panMoved = false; return; }
      const b = e.target.closest(".room-btn");
      if (b) pick(+b.dataset.room);
    });
    document.getElementById("i-reg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-room-reg]");
      if (!b) return;
      pick(+b.dataset.roomReg);
      wrap.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    });
    const day = document.getElementById("i-day");
    day.addEventListener("input", () => { state.days = +day.value; draw(); });
    document.getElementById("i-mine")?.addEventListener("click", () => { state.days = mine; day.value = mine; draw(); });
    draw();
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
