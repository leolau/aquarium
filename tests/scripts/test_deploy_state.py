"""Invariants for scripts/deploy_state.py.

Context: a Hermes deployment's identity — MCP servers, approval gates,
systemd's unprivileged model, interactively-obtained OAuth credentials —
lives on the box and nowhere else. `deploy_state.py` puts a sanitized copy
in the repo so a rebuild is possible and a hand edit is visible.

Two properties decide whether it can be trusted, and both are asserted here
rather than argued for:

  1. **Nothing secret reaches the repo.** Sanitization is heuristic; a
     heuristic that quietly misses is exactly how a token gets committed.
  2. **The snapshot is faithful.** render(capture(x)) must reproduce x
     exactly, or "rebuild from the repo" silently produces a different
     deployment than the one that was working.

The rest pins the diff semantics that make a drift report actionable
(dotted key paths, not a YAML text diff) and the refusal to render a config
with a blank credential in it.
"""

import os
import stat

import pytest
import yaml

import scripts.deploy_state as ds

DRIFT = ds.SEVERITY_DRIFT
NOTE = ds.SEVERITY_NOTE

LIVE_CONFIG = {
    "model": {"provider": "deepseek"},
    "datastore": {"url": "postgresql://hermes:hunter2@127.0.0.1:5432/hermes"},
    "approvals": {
        "tools": ["mcp_github_*", "mcp_google_workspace_*"],
        "tools_respect_bypass": False,
    },
    "mcp_servers": {
        "github": {
            "url": "https://api.githubcopilot.com/mcp/",
            "headers": {"Authorization": "Bearer ghp_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"},
            "enabled": True,
        },
        "aws-api": {
            "env": {
                "AWS_SECRET_ACCESS_KEY": "first-account-secret",
                "AWS_REGION": "ap-east-1",
            },
        },
        "aws-api-arprod": {
            "env": {
                "AWS_SECRET_ACCESS_KEY": "second-account-secret",
                "AWS_REGION": "ap-east-1",
            },
        },
        "google-workspace": {
            "env": {
                "GOOGLE_OAUTH_CLIENT_SECRET": "GOCSPX-abcdefghijklmnop",
                "WORKSPACE_MCP_CREDENTIALS_DIR": "/opt/data/creds",
            },
            "tools": {"include": ["get_events", "manage_event"]},
        },
    },
}

ENV_TEXT = (
    "TELEGRAM_BOT_TOKEN=123:abcdefghij\n"
    "DEEPSEEK_API_KEY=sk-deadbeefdeadbeefdead\n"
    "AWS_REGION=ap-east-1\n"
)


def _known(env_text=ENV_TEXT):
    return ds.secret_env_values(ds.parse_env_file(env_text))


# --- sanitization ----------------------------------------------------------


def test_secret_values_never_survive_sanitization():
    snapshot, secrets = ds.sanitize(LIVE_CONFIG, _known())
    text = yaml.safe_dump(snapshot)
    for value in secrets.values():
        assert value not in text
    assert "hunter2" not in text
    assert "ghp_" not in text
    assert "GOCSPX-" not in text
    assert ds.find_leaks(snapshot, _known()) == []


def test_non_secret_configuration_is_preserved_verbatim():
    snapshot, _ = ds.sanitize(LIVE_CONFIG, _known())
    assert snapshot["approvals"]["tools"] == ["mcp_github_*", "mcp_google_workspace_*"]
    assert snapshot["approvals"]["tools_respect_bypass"] is False
    assert (
        snapshot["mcp_servers"]["google-workspace"]["env"][
            "WORKSPACE_MCP_CREDENTIALS_DIR"
        ]
        == "/opt/data/creds"
    )
    assert snapshot["mcp_servers"]["github"]["enabled"] is True


def test_scheme_prefix_stays_in_the_snapshot():
    """`Bearer ` is not secret; keeping it out of the secrets file means the
    operator pastes a token, not a token with framing they might mistype."""
    snapshot, secrets = ds.sanitize(LIVE_CONFIG, _known())
    header = snapshot["mcp_servers"]["github"]["headers"]["Authorization"]
    assert header.startswith("Bearer ${")
    assert not any(value.startswith("Bearer ") for value in secrets.values())


def test_same_key_in_sibling_servers_gets_distinct_placeholders():
    """Three AWS servers hold one key name for three different accounts.
    Collapsing them onto a single placeholder renders the wrong credential
    into two of the three — and the failure is invisible until a call fails."""
    _, secrets = ds.sanitize(LIVE_CONFIG, _known())
    aws = {name: value for name, value in secrets.items() if "AWS_SECRET" in name}
    assert len(aws) == 2
    assert sorted(aws.values()) == ["first-account-secret", "second-account-secret"]


def test_a_setting_that_happens_to_match_env_stays_visible():
    """`AWS_REGION=ap-east-1` is in .env *and* in config as plain
    configuration. Treating the value as secret would hide from review that
    two AWS servers point at different regions — the snapshot has to keep
    showing behaviour, and only hide credentials."""
    snapshot, secrets = ds.sanitize(
        {"mcp_servers": {"aws": {"env": {"AWS_REGION": "ap-east-1"}}}}, _known()
    )
    assert secrets == {}
    assert snapshot["mcp_servers"]["aws"]["env"]["AWS_REGION"] == "ap-east-1"


def test_value_matching_env_is_caught_even_with_an_innocent_key():
    config = {"display": {"greeting": "sk-deadbeefdeadbeefdead"}}
    snapshot, secrets = ds.sanitize(config, _known())
    assert list(secrets.values()) == ["sk-deadbeefdeadbeefdead"]
    assert ds.find_leaks(snapshot, _known()) == []


def test_find_leaks_reports_material_sanitization_missed():
    """The safety net. If the heuristics are ever loosened, this is what stops
    a token reaching the repo."""
    planted = {"web": {"note": "use ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA to fetch"}}
    leaks = ds.find_leaks(planted)
    assert len(leaks) == 1
    assert "web.note" in leaks[0]


# --- round trip ------------------------------------------------------------


def test_render_reproduces_the_original_config_exactly():
    snapshot, secrets = ds.sanitize(LIVE_CONFIG, _known())
    rendered, missing = ds.render(snapshot, secrets)
    assert missing == []
    assert rendered == LIVE_CONFIG


def test_placeholders_hermes_itself_resolves_are_left_alone():
    """The live config really contains `dsn: ${DATABASE_URL}` — Hermes expands
    it from .env at load time. Rendering it here would bake a secret into a
    file the deployment deliberately kept it out of."""
    config = {"datastore": {"supabase_app": {"dsn": "${DATABASE_URL}"}}}
    snapshot, secrets = ds.sanitize(config, _known())
    assert secrets == {}
    rendered, missing = ds.render(
        snapshot, {"DATABASE_URL": "postgresql://leaked"}, managed=set()
    )
    assert missing == []
    assert rendered == config


def test_render_refuses_to_blank_a_missing_secret():
    snapshot, secrets = ds.sanitize(LIVE_CONFIG, _known())
    dropped = next(iter(secrets))
    partial = {name: value for name, value in secrets.items() if name != dropped}
    rendered, missing = ds.render(snapshot, partial)
    assert missing == [dropped]
    assert "${" in yaml.safe_dump(rendered)


# --- env parsing -----------------------------------------------------------


@pytest.mark.parametrize(
    "line,key,value",
    [
        ("A=1", "A", "1"),
        ('B="quoted value"', "B", "quoted value"),
        ("C='single'", "C", "single"),
        ("export D=exported", "D", "exported"),
        ("E=has=equals", "E", "has=equals"),
    ],
)
def test_parse_env_file_shapes(line, key, value):
    assert ds.parse_env_file(f"# comment\n\n{line}\n")[key] == value


# --- diffing ---------------------------------------------------------------


def test_diff_names_the_exact_key_that_changed():
    before = {"a": {"b": 1}, "keep": True}
    after = {"a": {"b": 2}, "keep": True}
    findings = ds.diff_config(before, after)
    assert [f["component"] for f in findings] == ["config:a.b"]
    assert findings[0]["expected"] == "1"
    assert findings[0]["actual"] == "2"


def test_diff_reports_additions_and_removals_separately():
    findings = ds.diff_config({"gone": 1}, {"added": 2})
    by_component = {f["component"]: f for f in findings}
    assert by_component["config:gone"]["actual"] == "absent"
    assert by_component["config:added"]["expected"] == "absent"
    assert all(f["severity"] == DRIFT for f in findings)


def test_list_reordering_is_reported_because_order_is_semantic():
    """MCP `args` are positional; a reordered list is a different command."""
    findings = ds.diff_config(
        {"args": ["--tools", "calendar"]}, {"args": ["calendar", "--tools"]}
    )
    assert len(findings) == 2


# --- end-to-end against a real filesystem ---------------------------------


@pytest.fixture()
def deployment(tmp_path, monkeypatch):
    """A miniature deployment on disk: HERMES_HOME, units, credentials."""
    home = tmp_path / "hermes-home"
    (home / "creds").mkdir(parents=True)
    (home / "config.yaml").write_text(yaml.safe_dump(LIVE_CONFIG), encoding="utf-8")
    (home / ".env").write_text(ENV_TEXT, encoding="utf-8")
    token = home / "creds" / "user@example.com.json"
    token.write_text('{"refresh_token": "1//zzzzzzzzzzzzzzzzzzzz"}', encoding="utf-8")
    token.chmod(0o600)

    units = tmp_path / "systemd"
    (units / "hermes-gateway.service.d").mkdir(parents=True)
    (units / "hermes-gateway.service").write_text(
        "[Service]\nUser=hermes\n", encoding="utf-8"
    )
    (units / "hermes-gateway.service.d" / "10-unprivileged.conf").write_text(
        "[Service]\nUser=hermes\n", encoding="utf-8"
    )

    monkeypatch.setattr(ds, "DEPLOY_ROOT", tmp_path / "deploy")
    ds.capture(
        "systest-fixture",
        home,
        units,
        ["hermes-*"],
        None,
        ["creds/*.json"],
    )
    return home, units


def test_capture_then_check_is_clean(deployment):
    assert ds.check("systest-fixture") == []


def test_capture_inventories_credentials_without_reading_them(deployment, tmp_path):
    manifest = yaml.safe_load(
        (tmp_path / "deploy" / "systest-fixture" / ds.MANIFEST_NAME).read_text(
            encoding="utf-8"
        )
    )
    entry = manifest["credential_files"][0]
    assert entry["path"] == "creds/user@example.com.json"
    assert entry["mode"] == "600"
    assert "1//" not in (
        tmp_path / "deploy" / "systest-fixture" / ds.MANIFEST_NAME
    ).read_text(encoding="utf-8")


def test_a_hand_edited_config_shows_up_as_drift(deployment):
    """The original complaint: the box changed and nothing said so."""
    home, _ = deployment
    config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    config["approvals"]["tools"].remove("mcp_github_*")
    (home / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")

    findings = ds.check("systest-fixture")
    assert any("approvals.tools" in f["component"] for f in findings)
    assert all(f["severity"] == DRIFT for f in findings)


def test_rotating_a_secret_in_place_is_not_drift(deployment):
    """Values are placeholders in the snapshot, so a rotated token must not
    page anyone — otherwise the check cries wolf and gets ignored."""
    home, _ = deployment
    config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    config["mcp_servers"]["github"]["headers"]["Authorization"] = (
        "Bearer ghp_NEWNEWNEWNEWNEWNEWNEW1"
    )
    (home / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
    assert ds.check("systest-fixture") == []


def test_loosened_credential_permissions_are_drift(deployment):
    home, _ = deployment
    (home / "creds" / "user@example.com.json").chmod(0o644)
    findings = ds.check("systest-fixture")
    assert [f["component"] for f in findings] == [
        "credential:creds/user@example.com.json:mode"
    ]
    assert findings[0]["expected"] == "600"


def test_a_missing_credential_is_drift(deployment):
    home, _ = deployment
    (home / "creds" / "user@example.com.json").unlink()
    findings = ds.check("systest-fixture")
    assert findings[0]["component"] == "credential:creds/user@example.com.json"
    assert findings[0]["actual"] == "absent"


def test_an_edited_systemd_unit_is_drift(deployment):
    """Units carry the privilege model — an edit that puts the agent back to
    root is the highest-consequence change on the box."""
    _, units = deployment
    (units / "hermes-gateway.service").write_text(
        "[Service]\nUser=root\n", encoding="utf-8"
    )
    findings = ds.check("systest-fixture")
    assert [f["component"] for f in findings] == ["unit:hermes-gateway.service"]
    assert "differs from the repo copy" in findings[0]["actual"]


def test_the_default_globs_capture_the_unit_that_is_not_named_hermes(
    tmp_path, monkeypatch
):
    """`agent-home.service` serves the phone and is not named `hermes-*`.

    FG-23 A0: with a single `hermes-*` glob the drift check was structurally
    blind to it — a clean report said nothing about the one service on the box
    running from a different checkout.
    """
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text(yaml.safe_dump(LIVE_CONFIG), encoding="utf-8")
    (home / ".env").write_text(ENV_TEXT, encoding="utf-8")
    units = tmp_path / "systemd"
    units.mkdir()
    (units / "hermes-gateway.service").write_text(
        "[Service]\nUser=hermes\n", encoding="utf-8"
    )
    (units / "agent-home.service").write_text(
        "[Service]\nUser=hermes\n", encoding="utf-8"
    )
    (units / "unrelated.service").write_text(
        "[Service]\nUser=root\n", encoding="utf-8"
    )
    monkeypatch.setattr(ds, "DEPLOY_ROOT", tmp_path / "deploy")

    ds.capture("globs", home, units, list(ds.DEFAULT_UNIT_GLOBS), None, [])

    manifest = yaml.safe_load(
        (tmp_path / "deploy" / "globs" / ds.MANIFEST_NAME).read_text(encoding="utf-8")
    )
    assert set(manifest["units"]) == {
        "hermes-gateway.service",
        "agent-home.service",
    }

    # And an edit to it is now reported, which is the property that matters.
    (units / "agent-home.service").write_text(
        "[Service]\nUser=root\n", encoding="utf-8"
    )
    findings = ds.check("globs")
    assert [f["component"] for f in findings] == ["unit:agent-home.service"]


def test_a_unit_nobody_captured_is_drift(deployment):
    """The hole `hermes-calendar-triage` went through.

    That unit ran as root for weeks and every check passed, because they all
    walked the manifest's units and none asked the box what *else* was
    installed. An uncaptured unit is not in the reviewed privilege model and a
    rebuild would not recreate it — both are drift.
    """
    _, units = deployment
    (units / "hermes-calendar-triage.service").write_text(
        "[Service]\nExecStart=/opt/data/triage.sh\n", encoding="utf-8"
    )

    findings = ds.check("systest-fixture")

    assert [f["component"] for f in findings] == [
        "unit:hermes-calendar-triage.service"
    ]
    assert findings[0]["severity"] == DRIFT
    # The first question about an unknown unit is who it runs as.
    assert "root (no User=)" in findings[0]["actual"]


def test_an_uncaptured_dropin_is_drift_and_names_its_user(deployment):
    """A drop-in is how a unit's `User=` is overridden without touching it."""
    _, units = deployment
    dropin = units / "hermes-gateway.service.d" / "99-local.conf"
    dropin.write_text("[Service]\nUser=root\n", encoding="utf-8")

    findings = ds.check("systest-fixture")

    assert [f["component"] for f in findings] == [
        "unit:hermes-gateway.service.d/99-local.conf"
    ]
    assert "runs as root" in findings[0]["actual"]


def test_capturing_the_unknown_unit_clears_it(deployment, tmp_path):
    """The finding must be actionable: capture is the fix, and it works."""
    home, units = deployment
    (units / "hermes-review-pass.timer").write_text(
        "[Timer]\nOnCalendar=Mon *-*-* 08:00:00\n", encoding="utf-8"
    )
    assert ds.check("systest-fixture")

    ds.capture("systest-fixture", home, units, ["hermes-*"], None, ["creds/*.json"])

    assert ds.check("systest-fixture") == []


def test_check_enumerates_the_box_the_way_capture_did(deployment, tmp_path):
    """Both sides use `installed_units`, or "unknown" means two things."""
    _, units = deployment
    manifest = yaml.safe_load(
        (tmp_path / "deploy" / "systest-fixture" / ds.MANIFEST_NAME).read_text(
            encoding="utf-8"
        )
    )
    assert set(manifest["units"]) == set(
        ds.installed_units(units, manifest["unit_globs"])
    )


def test_capture_refuses_to_quietly_watch_less_than_last_time(deployment):
    """A forgotten argument used to shrink the record, silently.

    Coverage is decided by arguments on one long command line. Re-running
    `capture` without `--credential-glob` wrote a manifest with no credentials
    in it and exited 0 — after which `check` reported "no drift" about files it
    was no longer looking at. Happened for real on 2026-08-16: 15 credential
    files and the deploy script's hash left the record and nothing said so.
    """
    home, units = deployment

    with pytest.raises(ds.StateError) as caught:
        ds.capture("systest-fixture", home, units, ["hermes-*"], None, [])

    assert "--credential-glob" in str(caught.value)
    # And the old record is intact, so the trail is not broken by the refusal.
    assert ds.check("systest-fixture") == []


def test_narrowing_is_allowed_when_it_is_deliberate(deployment):
    home, units = deployment

    ds.capture(
        "systest-fixture", home, units, ["hermes-*"], None, [], allow_narrowing=True
    )

    assert ds.check("systest-fixture") == []


def test_dropping_the_deploy_script_or_secrets_file_is_narrowing(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text(yaml.safe_dump(LIVE_CONFIG), encoding="utf-8")
    (home / ".env").write_text(ENV_TEXT, encoding="utf-8")
    units = tmp_path / "systemd"
    units.mkdir()
    (units / "hermes-gateway.service").write_text(
        "[Service]\nUser=hermes\n", encoding="utf-8"
    )
    script = tmp_path / "deploy-hermes.sh"
    script.write_text("#!/bin/bash\n", encoding="utf-8")
    monkeypatch.setattr(ds, "DEPLOY_ROOT", tmp_path / "deploy")

    ds.capture(
        "narrow", home, units, ["hermes-*"], script, [], tmp_path / "secrets.env"
    )
    with pytest.raises(ds.StateError) as caught:
        ds.capture("narrow", home, units, ["hermes-*"], None, [])

    assert "--deploy-script" in str(caught.value)
    assert "--secrets-out" in str(caught.value)


def test_a_new_secret_on_the_box_is_a_note_not_drift(deployment):
    """Adding a secret is normal; the report should say "capture this" rather
    than fail the weekly run."""
    home, _ = deployment
    (home / ".env").write_text(
        ENV_TEXT + "NEW_PROVIDER_KEY=whatever\n", encoding="utf-8"
    )
    findings = ds.check("systest-fixture")
    assert [(f["component"], f["severity"]) for f in findings] == [
        ("env:NEW_PROVIDER_KEY", NOTE)
    ]


def test_a_missing_secret_is_drift(deployment):
    home, _ = deployment
    (home / ".env").write_text("TELEGRAM_BOT_TOKEN=123:abc\n", encoding="utf-8")
    findings = ds.check("systest-fixture")
    assert any(f["component"] == "env:DEEPSEEK_API_KEY" for f in findings)


def test_render_writes_a_file_only_the_owner_can_read(deployment, tmp_path):
    secrets_file = tmp_path / "state-secrets.env"
    snapshot = yaml.safe_load(
        (tmp_path / "deploy" / "systest-fixture" / ds.SNAPSHOT_NAME).read_text(
            encoding="utf-8"
        )
    )
    _, secrets = ds.sanitize(LIVE_CONFIG, _known())
    secrets_file.write_text(
        "".join(f"{name}={value}\n" for name, value in secrets.items()),
        encoding="utf-8",
    )
    out = tmp_path / "rendered.yaml"
    code = ds.main([
        "render",
        "--deployment",
        "systest-fixture",
        "--secrets",
        str(secrets_file),
        "--out",
        str(out),
    ])
    assert code == 0
    assert yaml.safe_load(out.read_text(encoding="utf-8")) == LIVE_CONFIG
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o600
    assert ds.render(snapshot, secrets)[1] == []


def test_secrets_out_is_owner_only_and_renders_the_live_config(tmp_path, monkeypatch):
    """The rebuild path is only real if the values exist somewhere. They are
    written once, root-owned, 0600 — never into the repo."""
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text(yaml.safe_dump(LIVE_CONFIG), encoding="utf-8")
    (home / ".env").write_text(ENV_TEXT, encoding="utf-8")
    units = tmp_path / "systemd"
    units.mkdir()
    monkeypatch.setattr(ds, "DEPLOY_ROOT", tmp_path / "deploy")

    secrets_file = tmp_path / "state-secrets.env"
    ds.capture("roundtrip", home, units, ["hermes-*"], None, [], secrets_file)

    assert stat.S_IMODE(os.stat(secrets_file).st_mode) == 0o600
    snapshot = yaml.safe_load(
        (tmp_path / "deploy" / "roundtrip" / ds.SNAPSHOT_NAME).read_text(
            encoding="utf-8"
        )
    )
    rendered, missing = ds.render(
        snapshot, ds.parse_env_file(secrets_file.read_text(encoding="utf-8"))
    )
    assert missing == []
    assert rendered == LIVE_CONFIG


def test_state_can_live_outside_this_repo(tmp_path, monkeypatch):
    """This repo is public, so the captured state — account names, service
    layout, enrolled identities — has to be able to live in a private store
    while the tooling stays here."""
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text(yaml.safe_dump(LIVE_CONFIG), encoding="utf-8")
    (home / ".env").write_text(ENV_TEXT, encoding="utf-8")
    units = tmp_path / "systemd"
    units.mkdir()
    elsewhere = tmp_path / "private-store"
    monkeypatch.setattr(ds, "DEPLOY_ROOT", tmp_path / "repo-deploy")

    ds.capture("offsite", home, units, ["hermes-*"], None, [], None, elsewhere)

    assert (elsewhere / "offsite" / ds.SNAPSHOT_NAME).is_file()
    assert not (tmp_path / "repo-deploy").exists()
    assert ds.check("offsite", elsewhere) == []
    assert (
        ds.main(["--state-root", str(elsewhere), "check", "--deployment", "offsite"])
        == 0
    )


def test_a_file_the_checking_user_cannot_read_is_a_note_not_a_crash(deployment):
    """The weekly check runs as unprivileged `hermes` and will meet root-only
    files. Crashing there loses the layers it *can* verify — found the hard way
    when the deploy script was installed `0700 root`."""
    home, units = deployment
    unreadable = units / "hermes-gateway.service"
    unreadable.chmod(0o000)
    try:
        findings = ds.check("systest-fixture")
    finally:
        unreadable.chmod(0o644)

    assert [(f["component"], f["severity"]) for f in findings] == [
        ("unit:hermes-gateway.service", NOTE)
    ]
    assert "permission denied" in findings[0]["actual"]


def test_check_exit_code_is_the_signal(deployment, capsys):
    assert ds.main(["check", "--deployment", "systest-fixture"]) == 0
    home, _ = deployment
    (home / "config.yaml").unlink()
    assert ds.main(["check", "--deployment", "systest-fixture"]) == 1
    assert "unconfigured" in capsys.readouterr().out


def test_the_default_globs_cover_the_local_app_runtime_templates_not_its_instances(
    tmp_path, monkeypatch
):
    """FG-33: the app templates, slices and their timers are drift-checked; the
    per-instance drop-ins the root helper writes on every start are not."""
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text(yaml.safe_dump(LIVE_CONFIG), encoding="utf-8")
    (home / ".env").write_text(ENV_TEXT, encoding="utf-8")
    units = tmp_path / "systemd"
    units.mkdir()
    for name in (
        "aquarium-app@.service",
        "aquarium-app-build@.service",
        "aquarium.slice",
        "aquarium-apps.slice",
        "aquarium-build.slice",
        "aquarium-db.slice",
        "aquarium-apps-reconcile.timer",
    ):
        (units / name).write_text("[Unit]\nDescription=x\n", encoding="utf-8")
    instance = units / "aquarium-app@demo-prod.service.d"
    instance.mkdir()
    (instance / "10-release.conf").write_text("[Service]\nUser=t-demo\n", encoding="utf-8")
    monkeypatch.setattr(ds, "DEPLOY_ROOT", tmp_path / "deploy")

    ds.capture("apps", home, units, list(ds.DEFAULT_UNIT_GLOBS), None, [])

    manifest = yaml.safe_load(
        (tmp_path / "deploy" / "apps" / ds.MANIFEST_NAME).read_text(encoding="utf-8")
    )
    assert set(manifest["units"]) == {
        "aquarium-app@.service",
        "aquarium-app-build@.service",
        "aquarium.slice",
        "aquarium-apps.slice",
        "aquarium-build.slice",
        "aquarium-db.slice",
        "aquarium-apps-reconcile.timer",
    }
    assert ds.check("apps") == []

    # A helper re-writing an instance drop-in is not drift ...
    (instance / "10-release.conf").write_text("[Service]\nUser=t-other\n", encoding="utf-8")
    assert ds.check("apps") == []
    # ... an edited cap, or a slice override nobody captured, is.
    (units / "aquarium-apps.slice").write_text("[Slice]\nMemoryMax=8G\n", encoding="utf-8")
    override = units / "aquarium.slice.d"
    override.mkdir()
    (override / "50-cap.conf").write_text("[Slice]\nMemoryMax=12G\n", encoding="utf-8")
    components = sorted(f["component"] for f in ds.check("apps"))
    assert components == ["unit:aquarium-apps.slice", "unit:aquarium.slice.d/50-cap.conf"]
