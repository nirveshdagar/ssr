"""Multi-channel notifier — fan out one alert to every configured channel.

Configured from Settings. All four channels are optional and independent
(missing creds → that channel is skipped, not an error). One failing
channel never blocks the others.

Channels:
  1. Email — SMTP (requires smtp_server, smtp_port, smtp_email,
     smtp_password, notify_email). Falls back to STARTTLS automatically.
  2. Telegram — Bot API. Requires telegram_bot_token and telegram_chat_id.
     Create a bot via @BotFather, then message the bot once so it can
     see the chat_id. Look up chat_id via
     https://api.telegram.org/bot<TOKEN>/getUpdates
  3. WhatsApp — CallMeBot free API. Requires whatsapp_phone (with country
     code, no +) and whatsapp_apikey. One-time setup: message
     "I allow callmebot to send me messages" to +34 644 52 74 88 from
     the phone you want to receive alerts on — CallMeBot replies with
     your personal apikey. Free for personal use.
  4. SMS — Twilio. Requires twilio_account_sid, twilio_auth_token,
     twilio_from_number (purchased Twilio number), and sms_to_number.
     Costs ~$0.0075 per SMS. Enable in Twilio console.

Fan-out model: each channel runs on its own daemon thread so a slow/hung
SMTP server can't delay a Telegram alert. Results come back via
notify_status() (for test endpoints / dashboard).
"""
from __future__ import annotations

import base64
import smtplib
import ssl
import threading
import time
from email.mime.text import MIMEText
from email.utils import formatdate

import requests

from database import get_setting, log_pipeline


# Last-send results per channel, for dashboard / test endpoints.
_last_status: dict[str, dict] = {
    "email": {}, "telegram": {}, "whatsapp": {}, "sms": {},
}
_status_lock = threading.Lock()

# Dedupe state: {dedupe_key: last_fired_timestamp}. Notifications tagged with
# the same key within _DEDUPE_WINDOW_S are silently skipped. Prevents the
# "60 alerts in 10 seconds" storm when many domains on one dead server
# each trigger the same DO-all-failed path.
_DEDUPE_WINDOW_S = 600  # 10 minutes
_last_fired: dict[str, float] = {}
_dedupe_lock = threading.Lock()


def _dedupe_should_skip(key: str | None) -> bool:
    if not key:
        return False
    now = time.time()
    with _dedupe_lock:
        last = _last_fired.get(key, 0)
        if now - last < _DEDUPE_WINDOW_S:
            return True
        _last_fired[key] = now
        return False


def _stamp(channel: str, ok: bool, msg: str) -> None:
    with _status_lock:
        _last_status[channel] = {
            "ok": ok, "msg": msg,
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }


def notify_status() -> dict:
    """Snapshot of the last send-attempt per channel (for /api/notify/status)."""
    with _status_lock:
        return {k: dict(v) for k, v in _last_status.items()}


# ---------------------------------------------------------------------------
# Per-channel senders  (each returns (ok, detail_message))
# ---------------------------------------------------------------------------

def _send_email(subject: str, body: str) -> tuple[bool, str]:
    host = (get_setting("smtp_server") or "").strip()
    port = int(get_setting("smtp_port") or 587)
    user = (get_setting("smtp_email") or "").strip()
    pwd  = (get_setting("smtp_password") or "").strip()
    to   = (get_setting("notify_email") or "").strip()
    if not (host and user and pwd and to):
        return False, "email not configured"

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = f"[SSR] {subject}"
    msg["From"] = user
    msg["To"] = to
    msg["Date"] = formatdate(localtime=True)

    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(),
                                  timeout=15) as s:
                s.login(user, pwd)
                s.sendmail(user, [to], msg.as_string())
        else:
            with smtplib.SMTP(host, port, timeout=15) as s:
                s.ehlo()
                try:
                    s.starttls(context=ssl.create_default_context())
                    s.ehlo()
                except smtplib.SMTPException:
                    pass  # server may not support STARTTLS, proceed plaintext
                s.login(user, pwd)
                s.sendmail(user, [to], msg.as_string())
        return True, f"sent to {to}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def _send_telegram(subject: str, body: str) -> tuple[bool, str]:
    tok  = (get_setting("telegram_bot_token") or "").strip()
    chat = (get_setting("telegram_chat_id") or "").strip()
    if not tok or not chat:
        return False, "telegram not configured"

    text = f"*{subject}*\n\n{body}"[:4000]
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{tok}/sendMessage",
            json={"chat_id": chat, "text": text, "parse_mode": "Markdown"},
            timeout=15,
        )
        if r.ok and r.json().get("ok"):
            return True, f"delivered to chat {chat}"
        return False, f"HTTP {r.status_code}: {r.text[:200]}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def _send_whatsapp(subject: str, body: str) -> tuple[bool, str]:
    """Route to the configured WhatsApp provider (CallMeBot or Green-API).

    Falls back to CallMeBot when the provider setting is blank, preserving
    prior behaviour for users who haven't re-visited Settings.
    """
    provider = (get_setting("whatsapp_provider") or "callmebot").strip().lower()
    if provider == "greenapi":
        return _send_whatsapp_greenapi(subject, body)
    return _send_whatsapp_callmebot(subject, body)


def _send_whatsapp_callmebot(subject: str, body: str) -> tuple[bool, str]:
    phone  = (get_setting("whatsapp_phone") or "").strip().lstrip("+")
    apikey = (get_setting("whatsapp_apikey") or "").strip()
    if not phone or not apikey:
        return False, "callmebot not configured (phone + apikey required)"

    text = f"*{subject}*\n\n{body}"[:900]  # CallMeBot has a ~1000 char cap
    try:
        r = requests.get(
            "https://api.callmebot.com/whatsapp.php",
            params={"phone": phone, "text": text, "apikey": apikey},
            timeout=20,
        )
        if r.ok and ("Message queued" in r.text or "Message Sent" in r.text):
            return True, f"queued to +{phone}"
        return False, f"HTTP {r.status_code}: {r.text[:200]}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def _send_whatsapp_greenapi(subject: str, body: str) -> tuple[bool, str]:
    """Send via Green-API (https://green-api.com). Much more reliable than
    CallMeBot — has a free tier (200 msgs/day) and instant delivery.

    Setup: create an Instance in the Green-API console, scan the QR from
    your WhatsApp, and copy idInstance + apiTokenInstance into Settings.
    """
    instance_id = (get_setting("greenapi_instance_id") or "").strip()
    api_token   = (get_setting("greenapi_api_token") or "").strip()
    phone       = (get_setting("whatsapp_phone") or "").strip().lstrip("+")
    if not (instance_id and api_token and phone):
        return False, ("green-api not configured "
                       "(instance_id + api_token + whatsapp_phone required)")

    # Green-API wants digits-only, then suffixed with @c.us for 1-to-1 chats.
    digits = "".join(c for c in phone if c.isdigit())
    chat_id = f"{digits}@c.us"
    text = f"*{subject}*\n\n{body}"[:4096]

    # Try the universal host first. If the instance is on a region-specific
    # host (e.g. 7105.api.greenapi.com) we retry there on 404/connection.
    hosts = ["https://api.green-api.com"]
    region_host = (get_setting("greenapi_host") or "").strip().rstrip("/")
    if region_host:
        hosts.insert(0, region_host)
    else:
        # Heuristic: instances of the form 7105xxxxxx live on `7105.api.greenapi.com`
        if len(instance_id) >= 4 and instance_id[:4].isdigit():
            hosts.append(f"https://{instance_id[:4]}.api.greenapi.com")

    last_err = None
    for host in hosts:
        try:
            r = requests.post(
                f"{host}/waInstance{instance_id}/sendMessage/{api_token}",
                json={"chatId": chat_id, "message": text},
                timeout=20,
            )
            if r.ok:
                mid = ""
                try: mid = r.json().get("idMessage", "") or ""
                except Exception: pass
                return True, f"sent via {host}  id={mid[:24]}" + ("…" if len(mid) > 24 else "")
            # 404 typically means wrong host — try the next one.
            if r.status_code == 404 and host != hosts[-1]:
                last_err = f"HTTP 404 on {host}"
                continue
            return False, f"HTTP {r.status_code}: {r.text[:200]}"
        except requests.RequestException as e:
            last_err = f"{type(e).__name__}: {e}"
            continue

    return False, last_err or "green-api: all hosts failed"


def _send_sms(subject: str, body: str) -> tuple[bool, str]:
    sid   = (get_setting("twilio_account_sid") or "").strip()
    token = (get_setting("twilio_auth_token") or "").strip()
    frm   = (get_setting("twilio_from_number") or "").strip()
    to    = (get_setting("sms_to_number") or "").strip()
    if not (sid and token and frm and to):
        return False, "sms not configured"

    text = f"[SSR] {subject}\n{body}"[:1500]
    try:
        auth = base64.b64encode(f"{sid}:{token}".encode()).decode()
        r = requests.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
            headers={"Authorization": f"Basic {auth}",
                     "Content-Type": "application/x-www-form-urlencoded"},
            data={"From": frm, "To": to, "Body": text},
            timeout=20,
        )
        if r.ok:
            return True, f"sid={r.json().get('sid','?')}"
        return False, f"HTTP {r.status_code}: {r.text[:200]}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


_CHANNELS = {
    "email": _send_email,
    "telegram": _send_telegram,
    "whatsapp": _send_whatsapp,
    "sms": _send_sms,
}


def _enabled(channel: str) -> bool:
    return (get_setting(f"{channel}_enabled") or "0") == "1"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def notify(subject: str, body: str, severity: str = "warning",
           channels: list[str] | None = None,
           blocking: bool = False,
           dedupe_key: str | None = None) -> dict:
    """Fan out a message to every enabled channel.

    Args:
        subject: short one-liner
        body:    details (plain text; channels add their own formatting)
        severity: used in the log line ('warning' / 'error' / 'info')
        channels: if given, only those channels fire. Otherwise all enabled
                  ones fire (and those with no creds silently skip).
        blocking: if True, wait for all sends to complete before returning
                  (used by test endpoints). Otherwise runs async.
        dedupe_key: if set and a notification with the same key fired less
                    than _DEDUPE_WINDOW_S (10 min) ago, the call is skipped.
                    Prevents alert storms when many related events fire in
                    quick succession (e.g., 60 domains each hitting
                    DOAllTokensFailed during step-6 provisioning).

    Master off-switch: if settings.notifications_enabled != '1', nothing fires.
    """
    if (get_setting("notifications_enabled") or "0") != "1":
        return {"skipped": "notifications_enabled is off"}

    if _dedupe_should_skip(dedupe_key):
        return {"skipped": f"deduped within {_DEDUPE_WINDOW_S}s", "key": dedupe_key}

    if channels is None:
        channels = [c for c in _CHANNELS if _enabled(c)]
    results: dict[str, tuple[bool, str]] = {}

    def _one(name: str):
        fn = _CHANNELS.get(name)
        if not fn:
            return
        ok, detail = fn(subject, body)
        results[name] = (ok, detail)
        _stamp(name, ok, detail)
        try:
            log_pipeline(
                f"(notify-{name})", "notify",
                "completed" if ok else "warning",
                f"{severity}: {subject}  [{detail}]",
            )
        except Exception:
            pass

    threads = []
    for ch in channels:
        t = threading.Thread(target=_one, args=(ch,), daemon=True,
                             name=f"notify-{ch}")
        t.start()
        threads.append(t)
    if blocking:
        for t in threads:
            t.join(timeout=25)

    return {"channels": channels, "results": results}


def notify_server_dead(server_id: int, name: str, ip: str,
                       domain_count: int) -> None:
    subject = f"Server #{server_id} DEAD — {name}"
    body = (
        f"Server marked DEAD by auto-detector.\n"
        f"  ID:   {server_id}\n"
        f"  Name: {name}\n"
        f"  IP:   {ip}\n"
        f"  Domains hosted here: {domain_count}\n\n"
        f"Auto-migrate will {'run now' if (get_setting('auto_migrate_enabled') or '0') == '1' else 'NOT run (disabled in Settings)'}."
    )
    # Dedupe per-server: repeated detection ticks can't double-alert.
    notify(subject, body, severity="error",
           dedupe_key=f"server_dead:{server_id}")


def notify_migration_done(server_id: int, msg: str,
                          ok_count: int, fail_count: int) -> None:
    subject = (f"Migration {'PARTIAL FAIL' if fail_count else 'OK'}: "
               f"server #{server_id}")
    body = f"{msg}\nSucceeded: {ok_count}\nFailed:    {fail_count}"
    # Dedupe per-server-per-result: a retry with same result doesn't re-alert.
    notify(subject, body,
           severity="error" if fail_count else "info",
           dedupe_key=f"migration_done:{server_id}:"
                      f"{'fail' if fail_count else 'ok'}")


def notify_pipeline_failure(domain: str, step, error: str) -> None:
    subject = f"Pipeline failed: {domain}"
    body = (f"Domain: {domain}\nStep: {step}\nError: {error}\n\n"
            f"Check the SSR dashboard for details.")
    # Dedupe per-domain-per-step: bulk re-runs that repeatedly fail same step
    # only page you once every 10 min.
    notify(subject, body, severity="error",
           dedupe_key=f"pipeline_fail:{domain}:{step}")


def notify_do_all_failed(context: str, attempts: list[tuple[str, str]]) -> None:
    subject = "CRITICAL: all DO tokens rejected"
    body = (f"Context: {context}\n\n"
            f"Attempted tokens:\n" +
            "\n".join(f"  {lbl}: {err}" for lbl, err in attempts) +
            "\n\nAdd a working token to Settings → DigitalOcean immediately — "
            "auto-migrate cannot provision replacement servers until at "
            "least one token works.")
    # Dedupe globally: if 60 domains each hit this in the same minute, the
    # user gets ONE alert, not 60. Key is not context-specific on purpose.
    notify(subject, body, severity="error",
           dedupe_key="do_all_failed")
