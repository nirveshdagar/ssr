"""Tests for bulk DNS CSV upsert (parser + endpoint + handler)."""
import pytest


@pytest.fixture
def client(tmp_db):
    import sys
    if "modules.jobs" in sys.modules:
        sys.modules["modules.jobs"]._handlers.clear()
    if "app" in sys.modules:
        del sys.modules["app"]
    import app as _app
    _app.app.config["TESTING"] = True
    with _app.app.test_client() as c:
        with c.session_transaction() as sess:
            sess["authenticated"] = True
        yield c
    try:
        from modules import jobs
        jobs.stop_worker(timeout=1.0)
    except Exception:
        pass


def _seed_key_with_domains(*domain_names, alias="cfd"):
    from database import get_db, add_domain
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO cf_keys (email, api_key, cf_account_id, alias, is_active,
                                  domains_used, max_domains)
           VALUES (?, 'KEY-X', 'acct', ?, 1, ?, 20)""",
        (f"{alias}@x.y", alias, len(domain_names))
    )
    key_id = cur.lastrowid
    conn.commit()
    conn.close()
    for d in domain_names:
        add_domain(d)
    conn = get_db()
    for d in domain_names:
        conn.execute(
            "UPDATE domains SET cf_key_id=?, status='live' WHERE domain=?",
            (key_id, d)
        )
    conn.commit()
    conn.close()
    return key_id


# ---------------------------------------------------------------------------
# _parse_dns_csv
# ---------------------------------------------------------------------------

def test_parse_csv_returns_valid_rows():
    import app as _app
    csv = (
        "domain,type,name,content,proxied,ttl\n"
        "ex.com,A,@,1.2.3.4,true,1\n"
        "ex.com,CNAME,blog,medium.com,false,300\n"
    )
    valid, errors = _app._parse_dns_csv(csv, allowed_domains={"ex.com"})
    assert errors == []
    assert len(valid) == 2
    assert valid[0]["type"] == "A"
    assert valid[0]["proxied"] is True
    assert valid[0]["ttl"] == 1
    assert valid[1]["type"] == "CNAME"
    assert valid[1]["proxied"] is False
    assert valid[1]["ttl"] == 300


def test_parse_csv_rejects_unknown_type():
    import app as _app
    csv = (
        "domain,type,name,content\n"
        "ex.com,UNKNOWN,@,foo\n"
    )
    valid, errors = _app._parse_dns_csv(csv, allowed_domains={"ex.com"})
    assert valid == []
    assert len(errors) == 1
    assert "type must be one of" in errors[0][1]


def test_parse_csv_rejects_domain_not_in_allowed():
    """Forged-form guard at parse time."""
    import app as _app
    csv = (
        "domain,type,name,content\n"
        "allowed.com,A,@,1.1.1.1\n"
        "stranger.com,A,@,2.2.2.2\n"
    )
    valid, errors = _app._parse_dns_csv(csv, allowed_domains={"allowed.com"})
    assert len(valid) == 1
    assert valid[0]["domain"] == "allowed.com"
    assert any("stranger.com" in m for _, m in errors)


def test_parse_csv_missing_required_column():
    import app as _app
    csv = "domain,type,content\nex.com,A,1.1.1.1\n"  # no 'name'
    valid, errors = _app._parse_dns_csv(csv, allowed_domains={"ex.com"})
    assert valid == []
    assert any("missing required" in m for _, m in errors)


def test_parse_csv_proxied_loose_truthiness():
    import app as _app
    csv = (
        "domain,type,name,content,proxied\n"
        "ex.com,A,a,1.1.1.1,TRUE\n"
        "ex.com,A,b,1.1.1.1,1\n"
        "ex.com,A,c,1.1.1.1,yes\n"
        "ex.com,A,d,1.1.1.1,no\n"
        "ex.com,A,e,1.1.1.1,\n"
    )
    valid, _ = _app._parse_dns_csv(csv, allowed_domains={"ex.com"})
    assert [r["proxied"] for r in valid] == [True, True, True, False, False]


def test_parse_csv_ttl_default_when_missing(client, tmp_db):
    import app as _app
    csv = "domain,type,name,content\nex.com,A,@,1.1.1.1\n"
    valid, _ = _app._parse_dns_csv(csv, allowed_domains={"ex.com"})
    assert valid[0]["ttl"] == 1


def test_parse_csv_skips_empty_content():
    import app as _app
    csv = (
        "domain,type,name,content\n"
        "ex.com,A,@,\n"
        "ex.com,A,www,1.1.1.1\n"
    )
    valid, errors = _app._parse_dns_csv(csv, allowed_domains={"ex.com"})
    assert len(valid) == 1
    assert any("empty content" in m for _, m in errors)


def test_parse_csv_caps_at_max_rows():
    import app as _app
    cap = _app._BULK_DNS_MAX_ROWS
    rows = ["domain,type,name,content"] + [
        f"ex.com,A,sub{i},1.1.1.{i % 250}" for i in range(cap + 50)
    ]
    valid, errors = _app._parse_dns_csv("\n".join(rows),
                                         allowed_domains={"ex.com"})
    assert len(valid) <= cap
    assert any("row cap" in m for _, m in errors)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

def test_endpoint_enqueues_one_job(client, tmp_db):
    key_id = _seed_key_with_domains("a.com", "b.com")
    csv = (
        "domain,type,name,content\n"
        "a.com,A,@,1.1.1.1\n"
        "b.com,CNAME,www,a.com\n"
    )
    r = client.post(
        f"/api/cf-keys/{key_id}/bulk-dns-csv",
        data={"csv_text": csv},
        headers={"Origin": "http://localhost"},
    )
    assert r.status_code in (200, 302)
    from modules import jobs
    qs = jobs.list_jobs(kind="cf.bulk_dns_csv")
    assert len(qs) == 1
    import json
    payload = json.loads(qs[0]["payload_json"])
    assert payload["key_id"] == key_id
    assert len(payload["rows"]) == 2


def test_endpoint_rejects_oversize_body(client, tmp_db):
    key_id = _seed_key_with_domains("a.com")
    body = "domain,type,name,content\n" + "a.com,TXT,t,X\n" * (1024 * 1024)  # huge
    client.post(
        f"/api/cf-keys/{key_id}/bulk-dns-csv",
        data={"csv_text": body},
        headers={"Origin": "http://localhost"},
    )
    from modules import jobs
    assert jobs.list_jobs(kind="cf.bulk_dns_csv") == []


def test_endpoint_rejects_csv_with_no_valid_rows(client, tmp_db):
    """All rows reference an unassigned domain → no enqueue."""
    key_id = _seed_key_with_domains("a.com")
    csv = "domain,type,name,content\nfor-other-key.com,A,@,1.1.1.1\n"
    client.post(
        f"/api/cf-keys/{key_id}/bulk-dns-csv",
        data={"csv_text": csv},
        headers={"Origin": "http://localhost"},
    )
    from modules import jobs
    assert jobs.list_jobs(kind="cf.bulk_dns_csv") == []


def test_endpoint_partial_csv_skips_bad_rows_but_enqueues_good(client, tmp_db):
    key_id = _seed_key_with_domains("good.com")
    csv = (
        "domain,type,name,content\n"
        "good.com,A,@,1.1.1.1\n"
        "stranger.com,A,@,9.9.9.9\n"
        "good.com,CNAME,blog,target.com\n"
    )
    client.post(
        f"/api/cf-keys/{key_id}/bulk-dns-csv",
        data={"csv_text": csv},
        headers={"Origin": "http://localhost"},
    )
    import json
    from modules import jobs
    qs = jobs.list_jobs(kind="cf.bulk_dns_csv")
    assert len(qs) == 1
    payload = json.loads(qs[0]["payload_json"])
    domains = sorted(r["domain"] for r in payload["rows"])
    # stranger.com filtered out; both good.com rows present
    assert domains == ["good.com", "good.com"]


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

def test_handler_calls_upsert_per_row(client, tmp_db, monkeypatch):
    key_id = _seed_key_with_domains("h.com")
    from modules import cloudflare_api as _cf
    calls = []
    monkeypatch.setattr(_cf, "upsert_dns_record",
                        lambda *a, **kw: calls.append((a, kw)))
    import app as _app
    _app._cf_bulk_dns_csv_handler({
        "key_id": key_id,
        "rows": [
            {"domain": "h.com", "type": "A", "name": "@",
             "content": "1.1.1.1", "proxied": True, "ttl": 1},
            {"domain": "h.com", "type": "TXT", "name": "_v",
             "content": "verify-me", "proxied": False, "ttl": 1},
        ],
    })
    assert len(calls) == 2


def test_handler_continues_on_per_row_failure(client, tmp_db, monkeypatch):
    key_id = _seed_key_with_domains("h.com")
    from modules import cloudflare_api as _cf
    successes = []
    def fake(domain, rtype, *a, **kw):
        if rtype == "BAD":
            raise RuntimeError("boom")
        successes.append((domain, rtype))
    monkeypatch.setattr(_cf, "upsert_dns_record", fake)
    import app as _app
    _app._cf_bulk_dns_csv_handler({
        "key_id": key_id,
        "rows": [
            {"domain": "h.com", "type": "A", "name": "@",
             "content": "1.1.1.1", "proxied": True, "ttl": 1},
            {"domain": "h.com", "type": "BAD", "name": "x",
             "content": "y", "proxied": False, "ttl": 1},
            {"domain": "h.com", "type": "CNAME", "name": "blog",
             "content": "target.com", "proxied": False, "ttl": 1},
        ],
    })
    # First and third succeeded; second failed but didn't abort.
    assert ("h.com", "A") in successes
    assert ("h.com", "CNAME") in successes
    assert len(successes) == 2


# ---------------------------------------------------------------------------
# upsert_dns_record validation
# ---------------------------------------------------------------------------

def test_upsert_rejects_invalid_record_type():
    from modules import cloudflare_api
    with pytest.raises(ValueError, match="record_type must be"):
        cloudflare_api.upsert_dns_record("x.com", "BOGUS", "@", "y")
