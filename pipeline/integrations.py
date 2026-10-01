"""Optional outputs: Google Sheets, email digest, Slack/Discord webhook, ntfy.sh alerts. All off by default."""
from __future__ import annotations

import json
import logging
import os
import smtplib
from email.message import EmailMessage

import httpx

from pipeline.summarize import digest_text

log = logging.getLogger("integrations")


def _env(*names: str) -> list[str]:
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        raise RuntimeError(f"missing secret(s): {', '.join(missing)}")
    return [os.environ[n] for n in names]


def google_sheets(day: dict) -> None:
    """Append one row per kept story to the first worksheet."""
    import gspread  # imported lazily: only needed when enabled

    creds_json, sheet_id = _env("GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_SHEET_ID")
    ws = gspread.service_account_from_dict(json.loads(creds_json)).open_by_key(sheet_id).sheet1
    rows = [[day["date"], key, s["title"], s["url"], s["source"], s["published_at"], ", ".join(s["matched_keywords"]),
             len(s["also_covered_by"]), s["score"]]
            for key, sec in day["sections"].items() for s in sec["items"]]
    if rows:
        ws.append_rows(rows, value_input_option="RAW")


def email(day: dict) -> None:
    """Send the plain-text digest over SMTP (STARTTLS)."""
    host, port, user, password, to = _env("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_TO")
    msg = EmailMessage()
    msg["Subject"] = f"Daily Briefing — {day['date']}"
    msg["From"], msg["To"] = user, to
    msg.set_content(digest_text(day, markdown=False))
    with smtplib.SMTP(host, int(port), timeout=20) as s:
        s.starttls()
        s.login(user, password)
        s.send_message(msg)


def webhook(day: dict) -> None:
    """Post Top-N per section to a Slack or Discord incoming webhook."""
    (url,) = _env("WEBHOOK_URL")
    text = digest_text(day, markdown=True)
    payload = {"content": text[:1990]} if "discord" in url else {"text": text}
    httpx.post(url, json=payload, timeout=10).raise_for_status()


def ntfy(day: dict, config: dict) -> None:
    """Push a phone/desktop notification for each top story that hit a priority keyword."""
    (topic,) = _env("NTFY_TOPIC")
    for key, sec in day["sections"].items():
        priority = {p.lower() for p in config["sections"][key].get("priority", [])}
        for s in sec["items"]:
            hits = priority.intersection(s["matched_keywords"])
            if hits:
                httpx.post(f"https://ntfy.sh/{topic}", content=s["title"].encode(), timeout=10, headers={
                    "Title": f"{sec['name']}: {', '.join(sorted(hits))}".encode("ascii", "ignore").decode(),
                    "Click": s["url"], "Tags": "newspaper",
                }).raise_for_status()


def run_all(day: dict, config: dict) -> dict[str, str]:
    """Run each enabled integration in isolation. Returns {name: "ok" | error}."""
    enabled = config.get("integrations", {})
    jobs = {"google_sheets": lambda: google_sheets(day), "email": lambda: email(day),
            "webhook": lambda: webhook(day), "ntfy": lambda: ntfy(day, config)}
    results = {}
    for name, job in jobs.items():
        if not enabled.get(name):
            continue
        try:
            job()
            results[name] = "ok"
        except Exception as e:  # noqa: BLE001 - one integration must not break the run
            results[name] = f"{type(e).__name__}: {e}"[:200]
            log.error("integration_failed name=%s error=%r", name, results[name])
    return results
