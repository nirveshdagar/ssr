"""Tests for the bulk A-record change endpoint on /cloudflare."""
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


def _seed_key_and_domains(key_alias="cf1", domain_names=("a.com", "b.com")):
    """Insert a CF key + N domains assigned to it. Returns (key_id, domain_names)."""
    from database import get_db, add_domain
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO cf_keys (email, api_key, cf_account_id, alias, is_active,
                                  domains_used, max_domains)
           VALUES (?, 'KEY-' || ?, 'acct', ?, 1, ?, 20)""",
        (f"{key_alias}@b.c", key_alias, key_alias, len(domain_names))
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
    return key_id, list(domain_names)


def test_bulk_set_ip_enqueues_one_job(client, tmp_db):
    key_id, doms = _seed_key_and_domains()
    r = client.post(
        f"/api/cf-keys/{key_id}/bulk-set-ip",
        data={"new_ip": "5.6.7.8", "proxied": "on",
              "domains": doms},
        headers={"Origin": "http://localhost"},
    )
    assert r.status_code in (200, 302)
    from modules import jobs
    qs = jobs.list_jobs(kind="cf.bulk_set_ip")
    assert len(qs) == 1
    import json
    payload = json.loads(qs[0]["payload_json"])
    assert payload["new_ip"] == "5.6.7.8"
    assert payload["proxied"] is True
    assert sorted(payload["domains"]) == sorted(doms)


def test_bulk_set_ip_rejects_invalid_ip(client, tmp_db):
    key_id, doms = _seed_key_and_domains()
    client.post(
        f"/api/cf-keys/{key_id}/bulk-set-ip",
        data={"new_ip": "not-an-ip", "proxied": "on", "domains": doms},
        headers={"Origin": "http://localhost"},
    )
    from modules import jobs
    qs = jobs.list_jobs(kind="cf.bulk_set_ip")
    assert qs == [], "invalid IP should NOT have enqueued a job"


def test_bulk_set_ip_rejects_domains_under_other_key(client, tmp_db):
    """Security: even if the form lists a domain that exists, if it's not
    assigned to THIS cf_key, the whole batch must be rejected — otherwise
    a forged form could redirect the wrong key's domains."""
    a_id, a_doms = _seed_key_and_domains("ka", ("a-key.com",))
    b_id, b_doms = _seed_key_and_domains("kb", ("b-key.com",))
    # Try to mix: key A's endpoint, but include a domain that belongs to B
    client.post(
        f"/api/cf-keys/{a_id}/bulk-set-ip",
        data={"new_ip": "9.9.9.9", "proxied": "on",
              "domains": ["a-key.com", "b-key.com"]},
        headers={"Origin": "http://localhost"},
    )
    from modules import jobs
    qs = jobs.list_jobs(kind="cf.bulk_set_ip")
    assert qs == [], "mixed-key request must NOT enqueue"


def test_bulk_set_ip_rejects_no_domains_selected(client, tmp_db):
    key_id, _ = _seed_key_and_domains()
    client.post(
        f"/api/cf-keys/{key_id}/bulk-set-ip",
        data={"new_ip": "1.2.3.4", "proxied": "on"},  # no domains
        headers={"Origin": "http://localhost"},
    )
    from modules import jobs
    assert jobs.list_jobs(kind="cf.bulk_set_ip") == []


def test_bulk_set_ip_handler_updates_proxy_ip(client, tmp_db, monkeypatch):
    """Drive the job handler with mocked CF calls; verify
    domain.current_proxy_ip reflects the change for successful domains."""
    key_id, doms = _seed_key_and_domains("kbulk", ("ok1.com", "ok2.com"))
    from modules import cloudflare_api as _cf
    calls = []
    def fake_apex(dom, ip, proxied=True):
        calls.append(("apex", dom, ip, proxied))
    def fake_www(dom, ip, proxied=True):
        calls.append(("www", dom, ip, proxied))
    monkeypatch.setattr(_cf, "set_dns_a_record", fake_apex)
    monkeypatch.setattr(_cf, "set_dns_a_record_www", fake_www)

    import app as _app
    _app._cf_bulk_set_ip_handler({
        "key_id": key_id, "domains": doms,
        "new_ip": "10.20.30.40", "proxied": True,
    })

    # Each domain should have triggered two calls
    apex = [c for c in calls if c[0] == "apex"]
    www  = [c for c in calls if c[0] == "www"]
    assert len(apex) == 2
    assert len(www) == 2
    assert all(c[2] == "10.20.30.40" for c in calls)

    from database import get_domain
    for d in doms:
        assert get_domain(d)["current_proxy_ip"] == "10.20.30.40"


def test_bulk_set_ip_handler_continues_on_per_domain_failure(client, tmp_db, monkeypatch):
    """One domain raising shouldn't abort the rest."""
    key_id, doms = _seed_key_and_domains("kerr", ("good.com", "bad.com", "good2.com"))
    from modules import cloudflare_api as _cf
    def fake_apex(dom, ip, proxied=True):
        if dom == "bad.com":
            raise RuntimeError("CF API error")
    monkeypatch.setattr(_cf, "set_dns_a_record", fake_apex)
    monkeypatch.setattr(_cf, "set_dns_a_record_www", lambda *a, **kw: None)

    import app as _app
    _app._cf_bulk_set_ip_handler({
        "key_id": key_id, "domains": doms,
        "new_ip": "1.1.1.1", "proxied": True,
    })

    from database import get_domain
    assert get_domain("good.com")["current_proxy_ip"] == "1.1.1.1"
    assert get_domain("good2.com")["current_proxy_ip"] == "1.1.1.1"
    # The failing domain stays at whatever it was (None initially)
    assert get_domain("bad.com")["current_proxy_ip"] != "1.1.1.1"


def test_cloudflare_page_lists_domains_per_key(client, tmp_db):
    """Regression for the 'show domains under each key' UI: the page
    response should include the domain name in a row beneath the key."""
    key_id, doms = _seed_key_and_domains("vis", ("alpha.example",))
    r = client.get("/cloudflare")
    assert r.status_code == 200
    body = r.data.decode()
    assert "alpha.example" in body
    assert "1 domain(s)" in body  # collapse trigger label


# ---------------------------------------------------------------------------
# bulk-set-settings (SSL mode + Always-HTTPS)
# ---------------------------------------------------------------------------

def test_bulk_set_settings_enqueues_ssl_only(client, tmp_db):
    key_id, doms = _seed_key_and_domains("kssl", ("a.com", "b.com"))
    r = client.post(
        f"/api/cf-keys/{key_id}/bulk-set-settings",
        data={"ssl_mode": "strict", "always_https": "",
              "domains": doms},
        headers={"Origin": "http://localhost"},
    )
    assert r.status_code in (200, 302)
    from modules import jobs
    qs = jobs.list_jobs(kind="cf.bulk_set_settings")
    assert len(qs) == 1
    import json
    payload = json.loads(qs[0]["payload_json"])
    assert payload["ssl_mode"] == "strict"
    assert payload["always_https"] is None  # 'unchanged' encoded as None


def test_bulk_set_settings_enqueues_always_https_only(client, tmp_db):
    key_id, doms = _seed_key_and_domains("kah", ("a.com",))
    client.post(
        f"/api/cf-keys/{key_id}/bulk-set-settings",
        data={"ssl_mode": "", "always_https": "on", "domains": doms},
        headers={"Origin": "http://localhost"},
    )
    import json
    from modules import jobs
    p = json.loads(jobs.list_jobs(kind="cf.bulk_set_settings")[0]["payload_json"])
    assert p["ssl_mode"] is None
    assert p["always_https"] is True


def test_bulk_set_settings_rejects_invalid_ssl_mode(client, tmp_db):
    key_id, doms = _seed_key_and_domains("kssli", ("a.com",))
    client.post(
        f"/api/cf-keys/{key_id}/bulk-set-settings",
        data={"ssl_mode": "garbage", "always_https": "", "domains": doms},
        headers={"Origin": "http://localhost"},
    )
    from modules import jobs
    assert jobs.list_jobs(kind="cf.bulk_set_settings") == []


def test_bulk_set_settings_refuses_when_neither_set(client, tmp_db):
    key_id, doms = _seed_key_and_domains("kn", ("a.com",))
    client.post(
        f"/api/cf-keys/{key_id}/bulk-set-settings",
        data={"ssl_mode": "", "always_https": "", "domains": doms},
        headers={"Origin": "http://localhost"},
    )
    from modules import jobs
    assert jobs.list_jobs(kind="cf.bulk_set_settings") == []


def test_bulk_set_settings_rejects_cross_key(client, tmp_db):
    a_id, _ = _seed_key_and_domains("ka", ("a-key.com",))
    b_id, _ = _seed_key_and_domains("kb", ("b-key.com",))
    client.post(
        f"/api/cf-keys/{a_id}/bulk-set-settings",
        data={"ssl_mode": "full", "always_https": "",
              "domains": ["a-key.com", "b-key.com"]},
        headers={"Origin": "http://localhost"},
    )
    from modules import jobs
    assert jobs.list_jobs(kind="cf.bulk_set_settings") == []


def test_bulk_set_settings_handler_calls_cf_per_domain(client, tmp_db, monkeypatch):
    key_id, doms = _seed_key_and_domains("kh", ("h1.com", "h2.com"))
    from modules import cloudflare_api as _cf
    calls = []
    monkeypatch.setattr(_cf, "set_ssl_mode",
                        lambda d, m: calls.append(("ssl", d, m)))
    monkeypatch.setattr(_cf, "set_always_use_https",
                        lambda d, on: calls.append(("ah", d, on)))

    import app as _app
    _app._cf_bulk_set_settings_handler({
        "key_id": key_id, "domains": doms,
        "ssl_mode": "full", "always_https": True,
    })

    ssl_calls = [c for c in calls if c[0] == "ssl"]
    ah_calls = [c for c in calls if c[0] == "ah"]
    assert len(ssl_calls) == 2
    assert len(ah_calls) == 2
    assert all(c[2] == "full" for c in ssl_calls)
    assert all(c[2] is True for c in ah_calls)


def test_bulk_set_settings_handler_skips_unset_fields(client, tmp_db, monkeypatch):
    """If always_https is None, set_always_use_https should NOT be called."""
    key_id, doms = _seed_key_and_domains("ksk", ("only-ssl.com",))
    from modules import cloudflare_api as _cf
    ssl_calls, ah_calls = [], []
    monkeypatch.setattr(_cf, "set_ssl_mode",
                        lambda d, m: ssl_calls.append((d, m)))
    monkeypatch.setattr(_cf, "set_always_use_https",
                        lambda d, on: ah_calls.append((d, on)))

    import app as _app
    _app._cf_bulk_set_settings_handler({
        "key_id": key_id, "domains": doms,
        "ssl_mode": "flexible", "always_https": None,
    })
    assert ssl_calls == [("only-ssl.com", "flexible")]
    assert ah_calls == []  # untouched


def test_set_ssl_mode_validates_value():
    """Helper-level validation: ValueError on unknown mode."""
    from modules import cloudflare_api
    with pytest.raises(ValueError, match="ssl mode"):
        cloudflare_api.set_ssl_mode("x.com", "nonsense")
