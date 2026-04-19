"""Tests for issue #8: dangerous-pattern detector in website_generator."""
import pytest
from modules.website_generator import _scan_for_dangerous_content, ContentBlockedError


def test_clean_html_passes():
    _scan_for_dangerous_content("x.com",
        "<!DOCTYPE html><html><body><h1>Hello</h1>"
        "<p>Welcome to my site.</p></body></html>")


def test_blocks_cookie_stealer():
    with pytest.raises(ContentBlockedError) as ei:
        _scan_for_dangerous_content("x.com", "<script>document.cookie;</script>")
    assert "cookie" in ei.value.reason.lower()


def test_blocks_eval_atob():
    with pytest.raises(ContentBlockedError):
        _scan_for_dangerous_content("x.com", 'eval(atob("YWxlcnQ="))')


def test_blocks_iframe_to_raw_ip():
    with pytest.raises(ContentBlockedError):
        _scan_for_dangerous_content("x.com",
            '<iframe src="http://1.2.3.4/x"></iframe>')


def test_blocks_inner_html_script_injection():
    with pytest.raises(ContentBlockedError):
        _scan_for_dangerous_content("x.com",
            'el.innerHTML = "<script src=evil>";')


def test_blocks_new_function_dyn_exec():
    with pytest.raises(ContentBlockedError):
        _scan_for_dangerous_content("x.com", 'var f = new Function("code");')
