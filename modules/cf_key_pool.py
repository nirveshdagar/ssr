"""Cloudflare API key pool — 20 domains per key, auto-rotate.

The pool lives in the `cf_keys` table. Each domain takes one "slot" from
the next available key. When all keys hit their max_domains (default 20),
`get_next_available_cf_key()` raises CFKeyPoolExhausted — the pipeline
pauses and the user must add a new key via the dashboard.

Slot accounting:
  - `assign_cf_key_to_domain(domain, key_id)` — atomically increments
    domains_used on the key and writes cf_key_id + cf_email + cf_global_key
    onto the domain row. Idempotent: if this domain already has a key
    assigned, it returns early.
  - `release_cf_key_slot(domain)` — on domain delete, decrement the used
    counter so the slot becomes available again.

This module is DB-only. All CF HTTP calls live in cloudflare_api.py.
"""

from database import get_db


class CFKeyPoolExhausted(Exception):
    """Raised when no CF key has a free slot. Pipeline should pause."""
    pass


def get_next_available_cf_key():
    """Return the CF key with the lowest ID that still has free slots.

    Returns a dict:
      {id, email, api_key, alias, cf_account_id, domains_used, max_domains}

    Raises CFKeyPoolExhausted if no active key has capacity.
    """
    conn = get_db()
    try:
        row = conn.execute("""
            SELECT id, email, api_key, alias, cf_account_id, domains_used, max_domains
            FROM cf_keys
            WHERE is_active = 1 AND domains_used < max_domains
            ORDER BY id ASC
            LIMIT 1
        """).fetchone()
        if not row:
            # Are there any keys at all?
            total = conn.execute("SELECT COUNT(*) FROM cf_keys WHERE is_active=1").fetchone()[0]
            if total == 0:
                raise CFKeyPoolExhausted("No active CF keys in pool. Add one via the dashboard.")
            raise CFKeyPoolExhausted(
                f"All {total} CF keys are at max_domains. Add a new key to continue."
            )
        return dict(row)
    finally:
        conn.close()


def assign_cf_key_to_domain(domain, key_id=None):
    """Pick (or reuse) a CF key for this domain and increment usage atomically.

    If key_id is given, use that specific key (must have capacity).
    If key_id is None, use get_next_available_cf_key().

    Idempotent: if the domain already has cf_key_id set, just return the
    existing key info — no double-counting.

    Returns the key dict (same shape as get_next_available_cf_key).
    """
    conn = get_db()
    try:
        # If domain already has a key, return it without mutation
        existing = conn.execute(
            "SELECT cf_key_id FROM domains WHERE domain = ?", (domain,)
        ).fetchone()
        if existing and existing["cf_key_id"]:
            key_row = conn.execute("""
                SELECT id, email, api_key, alias, cf_account_id, domains_used, max_domains
                FROM cf_keys WHERE id = ?
            """, (existing["cf_key_id"],)).fetchone()
            if key_row:
                return dict(key_row)

        # Pick a fresh key
        if key_id is None:
            key = get_next_available_cf_key()
        else:
            row = conn.execute("""
                SELECT id, email, api_key, alias, cf_account_id, domains_used, max_domains
                FROM cf_keys WHERE id = ? AND is_active = 1 AND domains_used < max_domains
            """, (key_id,)).fetchone()
            if not row:
                raise CFKeyPoolExhausted(f"CF key id={key_id} not available (missing, inactive, or full).")
            key = dict(row)

        # Atomic increment + domain assignment
        conn.execute("BEGIN IMMEDIATE")
        # Race-safe: only increment if still under max
        cursor = conn.execute("""
            UPDATE cf_keys
               SET domains_used = domains_used + 1,
                   last_used_at = datetime('now')
             WHERE id = ? AND domains_used < max_domains AND is_active = 1
        """, (key["id"],))
        if cursor.rowcount != 1:
            conn.execute("ROLLBACK")
            # Retry with a fresh pick — the key we had got filled in a race
            return assign_cf_key_to_domain(domain, key_id=None)

        conn.execute("""
            UPDATE domains
               SET cf_key_id = ?,
                   cf_email = ?,
                   cf_global_key = ?,
                   cf_account_id = ?,
                   updated_at = datetime('now')
             WHERE domain = ?
        """, (key["id"], key["email"], key["api_key"], key["cf_account_id"], domain))
        conn.commit()

        # Refresh domains_used before returning
        fresh = conn.execute("""
            SELECT id, email, api_key, alias, cf_account_id, domains_used, max_domains
            FROM cf_keys WHERE id = ?
        """, (key["id"],)).fetchone()
        return dict(fresh)
    finally:
        conn.close()


def release_cf_key_slot(domain):
    """Decrement the CF key's domains_used when a domain is removed.

    No-op if the domain has no cf_key_id assigned.
    """
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT cf_key_id FROM domains WHERE domain = ?", (domain,)
        ).fetchone()
        if not row or not row["cf_key_id"]:
            return
        conn.execute("""
            UPDATE cf_keys
               SET domains_used = MAX(0, domains_used - 1)
             WHERE id = ?
        """, (row["cf_key_id"],))
        conn.execute(
            "UPDATE domains SET cf_key_id = NULL WHERE domain = ?", (domain,)
        )
        conn.commit()
    finally:
        conn.close()


def list_cf_keys():
    """Return all CF keys with their current usage, for the dashboard."""
    conn = get_db()
    try:
        rows = conn.execute("""
            SELECT id, email, alias, cf_account_id, domains_used, max_domains,
                   is_active, created_at, last_used_at
              FROM cf_keys
             ORDER BY id ASC
        """).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def refresh_cf_account_id(cf_key_id):
    """Re-fetch the real Account ID from Cloudflare's /accounts endpoint
    and store it on this cf_keys row (AND on every domain currently assigned
    to the key). Used when a stored account_id turns out to be stale/wrong
    — e.g. if it was populated from the user ID by an old version of our code.

    Returns the fresh account_id string. Raises ValueError/HTTPError on
    auth or network failure.
    """
    import requests  # local import to keep cf_key_pool.py dependency-light
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, email, api_key FROM cf_keys WHERE id=?", (cf_key_id,)
        ).fetchone()
        if not row:
            raise ValueError(f"cf_keys id={cf_key_id} not found")
        email, api_key = row["email"], row["api_key"]
    finally:
        conn.close()

    r = requests.get(
        "https://api.cloudflare.com/client/v4/accounts",
        headers={"X-Auth-Email": email, "X-Auth-Key": api_key,
                 "Content-Type": "application/json"},
        timeout=15,
    )
    r.raise_for_status()
    accts = (r.json().get("result") or [])
    if not accts:
        raise ValueError(
            f"CF returned no accounts for {email} — is billing set up on this CF account?"
        )
    real_id = accts[0].get("id")
    if not real_id:
        raise ValueError(f"CF /accounts response missing id: {accts[0]}")

    # Persist on the key AND on any domain rows already using it,
    # so the next pipeline pass for those domains doesn't hit the same bug.
    conn = get_db()
    try:
        conn.execute("UPDATE cf_keys SET cf_account_id=? WHERE id=?", (real_id, cf_key_id))
        conn.execute("UPDATE domains  SET cf_account_id=? WHERE cf_key_id=?", (real_id, cf_key_id))
        conn.commit()
    finally:
        conn.close()
    return real_id


def refresh_all_cf_account_ids():
    """Walk every active CF key and refresh its account_id. Returns a list
    of {id, email, alias, before, after, changed, error} dicts — one per key.
    Used by the Settings "Verify all keys" button.
    """
    results = []
    for k in list_cf_keys():
        before = k.get("cf_account_id") or ""
        try:
            after = refresh_cf_account_id(k["id"])
            results.append({
                "id": k["id"], "email": k["email"], "alias": k["alias"],
                "before": before, "after": after,
                "changed": before != after, "error": None,
            })
        except Exception as e:
            results.append({
                "id": k["id"], "email": k["email"], "alias": k["alias"],
                "before": before, "after": before,
                "changed": False, "error": str(e),
            })
    return results


def add_cf_key(email, api_key, alias=None, cf_account_id=None, max_domains=None):
    """Insert a new CF key into the pool. Returns the inserted id.

    Raises ValueError if email already exists.
    """
    if not email or not api_key:
        raise ValueError("email and api_key are required")
    if max_domains is None:
        # Pull default from settings so the dashboard can change it centrally
        from database import get_setting
        try:
            max_domains = int(get_setting("cf_domains_per_key") or 20)
        except (TypeError, ValueError):
            max_domains = 20

    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT id FROM cf_keys WHERE email = ?", (email,)
        ).fetchone()
        if existing:
            raise ValueError(f"CF key for email {email} already exists (id={existing['id']})")
        cur = conn.execute("""
            INSERT INTO cf_keys(email, api_key, alias, cf_account_id, max_domains)
            VALUES(?, ?, ?, ?, ?)
        """, (email, api_key, alias, cf_account_id, max_domains))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()
