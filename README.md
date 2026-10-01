# Daily Briefing

A personal news site that rebuilds itself every 4 hours. Each time, a GitHub robot reads about 35 news and press-release feeds. It keeps the stories that match your keywords, merges duplicates, ranks what matters, and publishes four pages: **Finance**, **Tech**, **Global Politics** and **Local Politics**. It's free, with no server, no database and no AI.

---

## Set it up (about 15 minutes, no coding)

### 1. Create the GitHub repository
1. Sign in at [github.com](https://github.com) (create a free account if needed).
2. Click **+** (top right), then **New repository**.
3. Name it `daily-briefing`, choose **Public** (Pages is free for public repos), and click **Create repository**.

### 2. Upload the files
1. On the new repo page, click **uploading an existing file**.
2. Drag in **everything inside this folder**, including the hidden `.github` folder. Skip `.venv`, `.cache` and `public` if they exist.
   - On Mac, press `Cmd + Shift + .` in Finder to show hidden folders. On Windows, open File Explorer, then **View**, then **Show**, then **Hidden items**.
   - If dragging the `.github` folder doesn't work, create the files by hand: click **Add file**, then **Create new file**, type `.github/workflows/daily.yml` as the name, and paste the contents. Do the same for `tests.yml`.
3. Click **Commit changes**.

### 3. Turn on GitHub Pages
1. Open **Settings**, then **Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Open `config.yaml` in the repo, click the pencil icon, and change `base_url` to `https://YOUR-GITHUB-NAME.github.io/daily-briefing/`. Commit.

### 4. Allow the robot to save data
Open **Settings**, then **Actions**, then **General**. Under **Workflow permissions**, choose **Read and write permissions** and save.

### 5. Run it for the first time
1. Open the **Actions** tab. If asked, click **I understand my workflows, go ahead and enable them**.
2. Click **Daily briefing** on the left, then **Run workflow**, then the green **Run workflow** button.
3. Wait 2–3 minutes for a green tick. Your site is live at `https://YOUR-GITHUB-NAME.github.io/daily-briefing/`.
4. Click the run, then the **build** job, then the **Fetch, filter and build** step to see the **feed health table**.

From now on it runs by itself every morning.

### 6. Optional extras (secrets)
Each extra is **off** until you switch it on in `config.yaml` under `integrations:` and add its secrets in **Settings**, then **Secrets and variables**, then **Actions**, then **New repository secret**.

| Extra | Switch in config.yaml | Secrets to add |
|---|---|---|
| Google Sheets log (one row per story) | `google_sheets: true` | `GOOGLE_SERVICE_ACCOUNT_JSON` (whole key file), `GOOGLE_SHEET_ID`. Share the sheet with the service account's email as Editor. |
| Email digest | `email: true` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_TO`. For Gmail, use an [App Password](https://myaccount.google.com/apppasswords). |
| Slack or Discord post | `webhook: true` | `WEBHOOK_URL` (an incoming-webhook URL) |
| Phone alerts on priority words | `ntfy: true` | `NTFY_TOPIC` (a long random name). Subscribe to the same topic in the [ntfy app](https://ntfy.sh). |

Never paste secrets into `config.yaml` or any other file in the repo.

---

## Using the site
- **Save stories** with the bookmark button (or press `s`). They're listed under **Saved 收藏** and stored in your browser only.
- **新 badges** mark stories published since your last visit.
- **Keyboard:** `/` search, `j`/`k` next/previous story, `o` open, `s` save, `1`–`4` sections, `t` theme, `?` all shortcuts.
- **Share a filtered view:** filters on section pages are kept in the address bar, e.g. `tech/?h=12&kw=breach`.
- **Install it:** in Chrome or Edge, choose **Install app**; on iPhone, **Share**, then **Add to Home Screen**. The last briefing you opened also works offline.
- **Breaking / Rising / Day 3 tags:** each story is compared with the previous morning's briefing. *Breaking* means new today with 3+ outlets, *Rising* means more outlets than yesterday (e.g. 1 → 6), and *Day N* means a continuing story. Breaking and rising stories rank higher.
- **This week:** each section shows a 7-day line of how many stories matched, plus keywords rising compared with the week's average. Section pages add a daily bar chart and a keyword trend table. These fill in after a few daily runs.
- **Market board:** S&P 500, TSX, Nasdaq, oil, Bitcoin and USD/CAD at the previous close, with a 5-day line. Change the list under `markets:` in `config.yaml`, or set `enabled: false`.
- **Keyword tuning page** (footer link): which keywords brought stories in on their own (often the noisy ones), what your exclude rules blocked, and which keywords matched nothing.
- **Signboard text:** each section's `sign:` in `config.yaml` sets its neon sign (財經, 科技, 國際, 本地 by default).

---

## Change keywords and feeds

Everything lives in **`config.yaml`**. Edit it on GitHub with the pencil icon. Changes apply on the next run, or click **Run workflow** to apply them now.

**Keywords:** each line under `keywords:` is one rule. A story joins the section if **any** line matches its headline or snippet, and is dropped if any `exclude:` line matches.

| You write | It means |
|---|---|
| `ipo OR merger` | either word |
| `acquisition AND (tech OR software)` | both, with grouping |
| `"series a"` | an exact phrase |
| `merger AND NOT opinion` | leave out stories that also say "opinion" |
| `re:raised \$\d+` | a pattern ("raised $40") |

Write AND, OR and NOT in **capitals**. Matching ignores upper/lower case and only matches whole words, so `merger` will not match "emergency". Words listed under `priority:` count three times in ranking and trigger phone alerts.

**Feeds:** add a line under a section's `feeds:`:
```yaml
- { name: "My Source", type: rss, url: "https://example.com/feed.xml" }
- { name: "Some outlet (via Google News)", type: rss, query: "site:example.com when:1d" }
```
Add `require_keyword_match: false` to keep everything a feed publishes. For a page with no feed, use `type: html` with CSS `selectors`; the CP24 entry is a working example.

**Publisher names:** under `sources:`, `rename` tidies how outlets are shown (e.g. `"reuters.com": "Reuters"`) and `block` hides an outlet everywhere.

**Local region:** change `region:` (city, province, country). The Google News queries in the Local section fill them in automatically. You'll also want to swap in your city's own outlets.

Also in `config.yaml`: `update_every_hours` (4), `recency_hours` (12), `max_items_per_section` (40), `retention_days` (90), `similarity_threshold` (85).

---

## Run it on your computer (optional)

Requires [Python 3.12+](https://www.python.org/downloads/).

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt        # Windows: .venv\Scripts\pip install -r requirements.txt
python -m pipeline.main --dry-run                # fetch + print today's top stories, write nothing
python -m pipeline.main                          # full run: writes data/ and builds public/
python -m http.server 8000 -d public             # preview at http://localhost:8000
python scripts/validate_feeds.py                 # check every feed; lists dead or stale ones
python -m pytest -q                              # run the tests
```
On Windows, use `.venv\Scripts\python` in place of `python` once the venv exists. Copy `.env.example` to `.env` to test the extras locally.

---

## How it works

```
config.yaml ─▶ fetch.py ─▶ parse.py ─▶ filter.py ─▶ dedupe.py ─▶ summarize.py ─▶ build.py ─▶ public/ ─▶ GitHub Pages
               async,      RSS/Atom/   recency +    canonical    rank, Top 5,    data/*.json,
               retries,    HTML →      keyword      URLs, merge, "What matters"  archive, RSS
               ETag cache  one shape   rules        cluster
```
- `data/YYYY-MM-DD.json` holds one file per day, and `data/index.json` lists them. Files older than `retention_days` are deleted automatically.
- Each section page has an RSS feed at `feeds/<section>.xml`.
- If a run collects **zero** stories, nothing is published (yesterday's site stays up) and the Action fails with a red ✗.
- The workflow has a concurrency guard so two runs never overlap.

## Known limitations
- **Paywalls:** only headlines and the publisher's own feed snippets are stored, never article bodies. Some links open paywalled pages.
- **Bot-blocking sites:** some publishers reject automated requests (VentureBeat returned HTTP 429 during testing, so it was replaced). They show as DEAD in the health table; swap them for a Google News `query:` feed.
- **Google News links:** newer Google News links can't be decoded without running Google's JavaScript, so some stories link via `news.google.com`, which then redirects to the publisher. The publisher name is still shown correctly. Because those links don't match publishers' own URLs, duplicates are caught by headline similarity instead.
- **Cron delays:** GitHub may start scheduled runs 5–15 minutes late (occasionally more) at busy times. Late runs still go ahead.
- **Scraped pages:** `type: html` sources break when the site redesigns. `validate_feeds.py` will flag them.
- **Market data:** Yahoo Finance's chart endpoint is free but unofficial and can change or block without notice. If it fails, the board simply hides. USD/CAD comes from the official Bank of Canada API. Figures are the previous close, not live, and aren't investment advice.
- **Duplicate detection** has no AI: it compares wording and shared names and numbers ("Gemini 4"). Rarely, two near-identical press releases from one company family are merged, or two angles on one story stay separate.
- **Search:** today's search covers headlines, snippets and keywords. Archive search covers headlines and sources only, to keep the download small.
- GitHub disables scheduled workflows in repos with no activity for 60 days. The daily data commits normally prevent this.
