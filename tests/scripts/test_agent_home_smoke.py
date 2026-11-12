"""Pure helpers of ``scripts/smoke/agent_home_smoke.py``."""

from __future__ import annotations

import time

import scripts.smoke.agent_home_smoke as smoke
from scripts.smoke.agent_home_smoke import ADMIN, ANON, MEMBER, VIEWER, PageSpec


def _html(*components: str, extra: str = "") -> str:
    return "".join(f'<div data-component="{c}"></div>' for c in components) + extra


SHELL = smoke.SHELL_MARKERS


def test_parse_env_file_handles_export_quotes_and_comments():
    text = "# creds\nexport SMOKE_ADMIN_EMAIL='a@example.invalid'\nSMOKE_ADMIN_PASSWORD=\"p=w#1\"\n\nJUNK\n"
    assert smoke.parse_env_file(text) == {
        "SMOKE_ADMIN_EMAIL": "a@example.invalid",
        "SMOKE_ADMIN_PASSWORD": "p=w#1",
    }


def test_load_credentials_env_overrides_file_and_skips_incomplete_roles():
    text = "SMOKE_ADMIN_EMAIL=a@x\nSMOKE_ADMIN_PASSWORD=file\nSMOKE_MEMBER_EMAIL=m@x\n"
    creds = smoke.load_credentials(text, {"SMOKE_ADMIN_PASSWORD": "env", "OTHER": "x"})
    assert creds == {ADMIN: ("a@x", "env")}
    assert smoke.load_credentials(None, {}) == {}


def test_session_cookie_picks_the_session_cookie_from_many_headers():
    headers = ["other=1; Path=/", "__Host-agent_home_session=abc.def; Path=/; Secure; HttpOnly"]
    assert smoke.session_cookie(headers) == "__Host-agent_home_session=abc.def"
    assert smoke.session_cookie(["__Host-agent_home_session=; Max-Age=0"]) is None
    assert smoke.session_cookie([]) is None


def test_cookie_header_joins_non_empty_cookies():
    assert smoke.cookie_header(["a=1; Path=/", "b=; Max-Age=0", "c=3"]) == "a=1; c=3"


def test_streamed_redirect_and_not_found_markers():
    assert smoke.streamed_redirect('..."NEXT_REDIRECT;replace;/login;307;"...') == "/login"
    assert smoke.streamed_redirect("plain") is None
    assert smoke.streamed_not_found('"NEXT_HTTP_ERROR_FALLBACK;404"')
    assert not smoke.streamed_not_found("ok")


def test_page_verdict_logged_out_protected_page_must_redirect_to_login():
    spec = PageSpec("/chat", ("ChatPane",))
    assert smoke.page_verdict(spec, ANON, 200, "NEXT_REDIRECT;replace;/login;")[0]
    assert not smoke.page_verdict(spec, ANON, 200, _html("ChatPane"))[0]
    assert not smoke.page_verdict(spec, ANON, 500, "")[0]


def test_page_verdict_public_page_renders_its_marker_without_redirect():
    spec = PageSpec("/login", anon="public", anon_markers=("LoginForm",), redirect="/")
    assert smoke.page_verdict(spec, ANON, 200, _html("LoginForm"))[0]
    assert not smoke.page_verdict(spec, ANON, 200, _html("Other"))[0]
    # signed in, /login bounces home
    assert smoke.page_verdict(spec, MEMBER, 200, "NEXT_REDIRECT;replace;/;")[0]
    assert not smoke.page_verdict(spec, MEMBER, 200, _html("LoginForm"))[0]


def test_page_verdict_signed_in_needs_shell_and_page_markers():
    spec = PageSpec("/chat", ("ChatPane",))
    assert smoke.page_verdict(spec, MEMBER, 200, _html(*SHELL, "ChatPane"))[0]
    ok, detail = smoke.page_verdict(spec, MEMBER, 200, _html(*SHELL, "PageError"))
    assert not ok and "missing ChatPane" in detail and "PageError" in detail
    assert not smoke.page_verdict(spec, MEMBER, 200, _html("ChatPane"))[0]
    assert not smoke.page_verdict(spec, MEMBER, 200, "NEXT_REDIRECT;replace;/login;")[0]


def test_page_verdict_public_page_skips_shell_when_signed_in():
    spec = PageSpec("/setup", ("SetupChecking",), shell=False, anon="public")
    assert smoke.page_verdict(spec, ADMIN, 200, _html("SetupChecking"))[0]


def test_page_verdict_role_markers_and_admin_only_leak():
    spec = PageSpec("/users", ("UsersView",), admin_markers=("CreateUserForm",), member_markers=("UsersReadOnlyNotice",))
    assert smoke.page_verdict(spec, ADMIN, 200, _html(*SHELL, "UsersView", "CreateUserForm"))[0]
    assert smoke.page_verdict(spec, VIEWER, 200, _html(*SHELL, "UsersView", "UsersReadOnlyNotice"))[0]
    ok, detail = smoke.page_verdict(
        spec, MEMBER, 200, _html(*SHELL, "UsersView", "UsersReadOnlyNotice", "CreateUserForm")
    )
    assert not ok and "leaked" in detail


def test_page_verdict_admin_names_need_one_name_for_admins_only():
    spec = PageSpec("/profiles", admin_markers=("ProfilesView",), admin_names=("Agent Profiles", "代理設定檔"), member_markers=("NotAvailableForRole",))
    assert smoke.page_verdict(spec, ADMIN, 200, _html(*SHELL, "ProfilesView", extra="<h1>Agent Profiles</h1>"))[0]
    assert smoke.page_verdict(spec, ADMIN, 200, _html(*SHELL, "ProfilesView", extra="<h1>代理設定檔</h1>"))[0]
    ok, detail = smoke.page_verdict(spec, ADMIN, 200, _html(*SHELL, "ProfilesView", extra="<h1>Profiles</h1>"))
    assert not ok and "missing name" in detail
    assert smoke.page_verdict(spec, MEMBER, 200, _html(*SHELL, "NotAvailableForRole"))[0]


def test_profiles_page_spec_expects_the_agent_profiles_name():
    spec = next(p for p in smoke.PAGES if p.path == "/profiles")
    assert "Agent Profiles" in spec.admin_names


def test_page_verdict_member_redirect_applies_to_members_only():
    spec = PageSpec("/settings/upgrade", admin_markers=("SoftwareUpgradeView",), member_redirect="/not-available")
    sent = '"NEXT_REDIRECT;replace;/not-available;307;"'
    assert smoke.page_verdict(spec, ADMIN, 200, _html(*SHELL, "SoftwareUpgradeView"))[0]
    assert smoke.page_verdict(spec, MEMBER, 200, sent)[0]
    assert smoke.page_verdict(spec, VIEWER, 200, sent)[0]
    assert not smoke.page_verdict(spec, MEMBER, 200, _html(*SHELL, "SoftwareUpgradeView"))[0]
    assert not smoke.page_verdict(spec, ADMIN, 200, sent)[0]


def test_profile_suggestions_spec_passes_empty_queue_and_fails_load_error():
    # A fresh install has no suggestions: the empty state must still pass.
    spec = next(p for p in smoke.PAGES if p.path == "/profiles/suggestions")
    empty = _html(*SHELL, "ProfileSuggestionsView", "SuggestionsEmpty")
    for role in (ADMIN, MEMBER, VIEWER):
        assert smoke.page_verdict(spec, role, 200, empty)[0]
    ok, detail = smoke.page_verdict(spec, ADMIN, 200, _html(*SHELL, "SuggestionsError"))
    assert not ok and "SuggestionsError" in detail


def test_page_verdict_not_found_page():
    spec = PageSpec("/todos/x", not_found=True)
    assert smoke.page_verdict(spec, MEMBER, 200, '"NEXT_HTTP_ERROR_FALLBACK;404"')[0]
    assert not smoke.page_verdict(spec, MEMBER, 200, _html(*SHELL))[0]


def test_page_verdict_admin_not_found_page():
    spec = PageSpec("/skills/x", admin_not_found=True, member_markers=("NotAvailableForRole",))
    assert smoke.page_verdict(spec, ADMIN, 200, '"NEXT_HTTP_ERROR_FALLBACK;404"')[0]
    assert not smoke.page_verdict(spec, ADMIN, 200, _html(*SHELL))[0]
    assert smoke.page_verdict(spec, MEMBER, 200, _html(*SHELL, "NotAvailableForRole"))[0]
    assert not smoke.page_verdict(spec, MEMBER, 200, '"NEXT_HTTP_ERROR_FALLBACK;404"')[0]


def _summary(**over):
    base = {
        "cpu_pct": 12.5, "mem_pct": 40, "disk_pct": 70.1,
        "tokens_month": {"input": 10, "output": 5, "cost_usd": None},
        "active_conversations": 0, "running_cards": 1, "cron_total": 3, "cron_enabled": 2,
        "upload_storage": None, "collected_at": time.time(), "build": "c0ffee123",
    }
    base.update(over)
    return base


def test_summary_problems_accepts_sane_payload():
    assert smoke.summary_problems(_summary()) == []


def test_summary_problems_flags_each_insane_field():
    assert smoke.summary_problems(_summary(cpu_pct=None)) == ["cpu_pct=None"]
    assert smoke.summary_problems(_summary(disk_pct=101)) == ["disk_pct=101"]
    assert smoke.summary_problems(_summary(tokens_month=None)) == ["tokens_month=None"]
    assert smoke.summary_problems(_summary(running_cards=-1)) == ["running_cards=-1"]
    assert smoke.summary_problems(_summary(cron_enabled=4)) == ["cron_enabled > cron_total"]
    assert smoke.summary_problems(_summary(collected_at=time.time() - 3600))[0].startswith("collected_at=")
    assert smoke.summary_problems(_summary(build=None)) == ["build missing"]


def test_build_verdict_short_sha_prefix_matches_head():
    head = "c0ad8e58e1234567890abcdef1234567890abcd"
    assert smoke.build_verdict("c0ad8e58e", head, lambda _s: None)[0]
    assert smoke.build_verdict(head, head, lambda _s: None)[0]
    assert not smoke.build_verdict(None, head, lambda _s: [])[0]


def test_build_verdict_lagging_build_ok_only_without_agent_home_changes():
    head = "f" * 40
    assert smoke.build_verdict("abc1234", head, lambda _s: ["hermes_cli/web_server.py"])[0]
    ok, detail = smoke.build_verdict("abc1234", head, lambda _s: ["agent-home/src/app/page.tsx"])
    assert not ok and "stale" in detail
    assert not smoke.build_verdict("abc1234", head, lambda _s: ["package-lock.json"])[0]
    assert not smoke.build_verdict("abc1234", head, lambda _s: None)[0]


def test_format_table_aligns_columns():
    table = smoke.format_table([("PASS", "a", "x"), ("FAIL", "longer check", "y")]).splitlines()
    assert table[0].startswith("RESULT  CHECK")
    assert table[2] == "PASS    a             x"
    assert table[3] == "FAIL    longer check  y"


def test_smoke_name_is_prefixed():
    assert smoke.smoke_name("project", 42) == "[smoke] project 42"


def test_specs_cover_every_page_route_and_expect_every_role():
    from pathlib import Path

    app = Path(smoke.__file__).resolve().parents[2] / "agent-home" / "src" / "app"
    routes = {
        "/" + str(p.parent.relative_to(app)).replace("\\", "/") if p.parent != app else "/"
        for p in app.rglob("page.tsx")
    }
    import re

    def matches(route: str, path: str) -> bool:
        pattern = "^" + re.sub(r"\[[^/]+\]", "[^/]+", route) + "$"
        return re.match(pattern, path) is not None

    uncovered = [r for r in routes if not any(matches(r, p.path) for p in smoke.PAGES)]
    assert uncovered == []
    for spec in smoke.APIS:
        assert set(spec.expect) == {VIEWER, MEMBER, ADMIN}, spec.path
        assert spec.path.startswith("/api/")


def test_row_status_retry_only_pass_is_warn():
    assert smoke.row_status(True) == "PASS"
    assert smoke.row_status(True, retried=True) == "WARN"
    assert smoke.row_status(False, retried=True) == "FAIL"
    assert smoke.row_status(None) == "SKIP"


def test_report_counts_warn_separately_and_warn_does_not_fail():
    report = smoke.Report()
    report.add(True, "a")
    report.add(True, "b", "HTTP 200 (1st try: HTTP 500)", retried=True)
    report.add(None, "c")
    assert [r[0] for r in report.rows] == ["PASS", "WARN", "SKIP"]
    assert report.failed == 0
    line = smoke.summary_line(report.rows, 1.0, "http://x", write=False)
    assert line.startswith("1 PASS, 1 WARN (passed only on retry), 0 FAIL, 1 SKIP")


def test_concurrency_defaults_to_two():
    assert smoke.parse_args([]).concurrency == 2
    assert smoke.parse_args(["--concurrency", "5"]).concurrency == 5


def test_hidden_by_menu_matches_by_path_segment_and_exactness():
    assert smoke.hidden_by_menu("/todos", ["todos"], api=False)
    assert smoke.hidden_by_menu("/todos/zz-smoke-missing", ["todos"], api=False)
    assert smoke.hidden_by_menu("/api/todos/facets", ["todos"], api=True)
    assert not smoke.hidden_by_menu("/api/todos", ["todos"], api=False)
    assert not smoke.hidden_by_menu("/todosx", ["todos"], api=False)
    assert smoke.hidden_by_menu("/projects?view=task", ["projects"], api=False)
    assert not smoke.hidden_by_menu("/projects/zz-smoke-missing", ["projects"], api=False)
    assert not smoke.hidden_by_menu("/profiles/suggestions", ["profiles"], api=False)
    assert not smoke.hidden_by_menu("/todos", [], api=False)


def test_page_verdict_hidden_page_wants_not_available_screen():
    html = _html(*SHELL, "NotAvailableForRole")
    assert smoke.page_verdict(smoke.HIDDEN_PAGE, ADMIN, 200, html)[0]
    assert not smoke.page_verdict(smoke.HIDDEN_PAGE, ADMIN, 200, _html(*SHELL, "TodosList"))[0]


def test_app_urls_mirror_agent_home_menu_access():
    import re
    from pathlib import Path

    ts = (
        Path(smoke.__file__).resolve().parents[2] / "agent-home" / "src" / "lib" / "nav" / "menu-access.ts"
    ).read_text(encoding="utf-8")
    block = ts.split("export const APP_URLS", 1)[1].split("\n};", 1)[0]
    rule = re.compile(r'\{\s*path:\s*"([^"]+)"(\s*,\s*exact:\s*true)?\s*\}')
    parsed = {}
    for m in re.finditer(r"^  (\w+): \{(.*?)(?=^  \w+: \{|\Z)", block, re.S | re.M):
        body = m.group(2)
        pages, _, apis = body.partition("apis:")
        parsed[m.group(1)] = (
            tuple((p, bool(e)) for p, e in rule.findall(pages)),
            tuple((p, bool(e)) for p, e in rule.findall(apis)),
        )
    assert parsed == dict(smoke.APP_URLS)
