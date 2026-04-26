"""End-to-end integration test for the pipeline through the job queue.

Mocks every upstream API call (Spaceship, CF, DO, SA, LLM, migration) at
the module-function level, enqueues one pipeline.full job, drives the
worker manually (no live thread), and verifies:
  - pipeline_runs row created and ends as 'completed'
  - pipeline_step_runs has one row per executed step, in order
  - artifact_json populated for steps wired in commit e8d0785 (2/3/6/7/9/10)
  - domain.status ends as 'hosted' (step 10 success)

This is the load-bearing test that ensures handler registration in app.py
and the pipeline.full handler still work as a unit. Unit tests cover each
piece individually; this proves they compose."""
from unittest import mock

import pytest


@pytest.fixture
def integration_setup(tmp_db, monkeypatch):
    """Insert a ready server, mock every upstream, register the handler."""
    from database import get_db, add_domain
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO servers (name, ip, sa_server_id, status, max_sites)
           VALUES ('srv1', '10.0.0.1', 'sa-1', 'ready', 60)"""
    )
    server_id = cur.lastrowid
    cur = conn.execute(
        """INSERT INTO cf_keys (email, api_key, cf_account_id, alias,
                                  is_active, domains_used, max_domains)
           VALUES ('cf@x.y', 'CFKEY', 'acct1', 'cf1', 1, 0, 20)"""
    )
    conn.commit()
    conn.close()
    add_domain("integration.test")

    # ---- Mock all upstream surfaces ----
    from modules import (
        spaceship, cloudflare_api, serveravatar, digitalocean,
        website_generator, migration,
    )

    monkeypatch.setattr(spaceship, "check_availability",
                        lambda doms: [{"name": d, "available": False} for d in doms])
    monkeypatch.setattr(spaceship, "list_domains",
                        lambda **kw: {"items": [{"name": "integration.test"}]})
    monkeypatch.setattr(spaceship, "set_nameservers",
                        lambda dom, nss: True)

    # The real create_zone_for_domain writes cf_zone_id + cf_nameservers
    # back to the domain row as a side effect — step 4 reads cf_nameservers
    # from the row, so a mock that skips that side effect breaks the next
    # step. Mirror the real behavior here.
    def _fake_create_zone(dom):
        from database import update_domain as _ud
        _ud(dom, cf_zone_id="Z123", cf_nameservers="ns1.x,ns2.x")
        return {"zone_id": "Z123", "nameservers": ["ns1.x", "ns2.x"]}
    monkeypatch.setattr(cloudflare_api, "create_zone_for_domain", _fake_create_zone)
    monkeypatch.setattr(cloudflare_api, "get_zone_status",
                        lambda dom: "active")
    monkeypatch.setattr(cloudflare_api, "setup_domain_dns",
                        lambda dom, ip: None)
    monkeypatch.setattr(cloudflare_api, "fetch_origin_ca_cert",
                        lambda dom: {"certificate": "PEM", "private_key": "PEMK", "chain": ""})
    monkeypatch.setattr(cloudflare_api, "set_dns_a_record",
                        lambda dom, ip, proxied=True: None)
    monkeypatch.setattr(cloudflare_api, "set_dns_a_record_www",
                        lambda dom, ip, proxied=True: None)

    monkeypatch.setattr(serveravatar, "create_application",
                        lambda sa_server_id, dom: "APP-1")
    monkeypatch.setattr(serveravatar, "_find_app_id",
                        lambda sa_server_id, dom: "APP-1")
    monkeypatch.setattr(serveravatar, "install_custom_ssl",
                        lambda *a, **kw: (True, "ok"))
    monkeypatch.setattr(serveravatar, "upload_index_php",
                        lambda sa_server_id, dom, php: None)

    # _verify_sa_server_or_mark_dead pings SA — bypass it.
    from modules import pipeline as _pl
    monkeypatch.setattr(_pl, "_verify_sa_server_or_mark_dead",
                        lambda server: True)

    monkeypatch.setattr(website_generator, "generate_single_page",
                        lambda dom: {"php": "<?php echo 'integration'; ?>",
                                       "inferred_niche": "test"})
    monkeypatch.setattr(migration, "archive_site",
                        lambda dom, php, **kw: "/tmp/fake-archive")
    monkeypatch.setattr(migration, "capture_cf_record_ids",
                        lambda dom: {})
    monkeypatch.setattr(migration, "save_origin_cert",
                        lambda dom, cert, key: None)

    # Don't sleep through step 8's 30s grey-cloud wait
    import time as _time
    monkeypatch.setattr(_pl.time, "sleep", lambda *a, **kw: None)

    # Register the pipeline.full handler against the (empty) test handler set.
    from modules import jobs
    jobs._handlers.clear()
    jobs.register_handler("pipeline.full", _pl.pipeline_full_handler)
    yield server_id


def test_full_pipeline_through_queue_lands_completed_with_artifacts(integration_setup, tmp_db):
    """Single end-to-end sanity check: enqueue, drive, verify."""
    import json
    from modules import jobs, pipeline
    from database import (
        get_domain, list_pipeline_runs, get_step_runs, get_steps,
    )

    # Enqueue via the public path
    job_id = pipeline.run_full_pipeline(
        "integration.test", skip_purchase=True
    )
    assert job_id is not None, "slot already held? bad fixture"

    # Drive the worker manually
    job = jobs._claim_one()
    assert job["kind"] == "pipeline.full"
    jobs._run_one(job)

    final_job = jobs.get_job(job_id)
    assert final_job["status"] == "done", \
        f"job didn't complete: status={final_job['status']!r} " \
        f"err={final_job['last_error']!r}"

    # Domain ends as 'hosted' (step 10 success; live_checker would later flip
    # to 'live' but that's a separate thread).
    d = get_domain("integration.test")
    assert d["status"] == "hosted", \
        f"unexpected final domain status: {d['status']!r}"

    # Exactly one pipeline_runs row, marked completed
    runs = list_pipeline_runs("integration.test")
    assert len(runs) == 1
    run = runs[0]
    assert run["status"] == "completed"
    assert run["error"] is None
    assert run["ended_at"] is not None and run["started_at"] is not None
    assert run["ended_at"] > run["started_at"]

    # All 10 steps recorded in step_runs in the right order, all completed/skipped
    steps = get_step_runs(run["id"])
    by_num = {s["step_num"]: s for s in steps}
    assert sorted(by_num.keys()) == list(range(1, 11))
    for n, s in by_num.items():
        assert s["status"] in ("completed", "skipped", "warning"), \
            f"step {n} ended {s['status']!r}: {s['message']!r}"

    # Artifacts wired in commit e8d0785 + cert metadata in commit 1c1dcc3
    def artifact(n):
        return json.loads(by_num[n]["artifact_json"]) if by_num[n]["artifact_json"] else {}

    a2 = artifact(2)
    assert a2.get("cf_email") == "cf@x.y"
    assert a2.get("max_domains") == 20

    a3 = artifact(3)
    assert a3.get("cf_zone_id") == "Z123"
    assert a3.get("cf_nameservers") == ["ns1.x", "ns2.x"]

    a6 = artifact(6)
    assert a6.get("source") == "existing"
    assert a6.get("server_ip") == "10.0.0.1"

    a7 = artifact(7)
    assert a7.get("sa_app_id") == "APP-1"
    assert a7.get("server_ip") == "10.0.0.1"

    a8 = artifact(8)
    # cert metadata extraction from "PEM" string fails (it's not a real cert);
    # the wrapper catches that and logs a warning. Either an empty dict or no
    # row is fine — what we DON'T want is the pipeline crashing.
    assert isinstance(a8, dict)

    a9 = artifact(9)
    assert a9.get("niche") == "test"
    assert a9.get("byte_size") == len("<?php echo 'integration'; ?>")
    assert "sha256" in a9

    a10 = artifact(10)
    assert a10.get("server_ip") == "10.0.0.1"
    assert a10.get("byte_size") == len("<?php echo 'integration'; ?>")

    # step_tracker (legacy) also populated
    legacy = get_steps("integration.test")
    legacy_by_num = {r["step_num"]: r for r in legacy}
    for n in range(1, 11):
        assert legacy_by_num[n]["status"] in ("completed", "skipped", "warning")
