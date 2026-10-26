"""The Outputs tab's backend: decoded output specs and the produced-files read.

Behaviour contracts: CJK specs never reach a reader as ``\\uXXXX`` (new
writes *and* rows stored before the fix), the artifacts read follows the
project read gate (404 for a stranger), classifies deliverable / draft /
note, flags files no output owns (``output_id`` null), carries run/card
provenance newest first, and only streams files from managed roots.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import kanban_db, projects_api, projects_db, projects_outputs_api
from hermes_cli.access import Principal

OWNER = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]
VIEWER = Principal(user_id="vic", display="Vic", role="member")  # type: ignore[arg-type]
STRANGER = Principal(user_id="eve", display="Eve", role="member")  # type: ignore[arg-type]

CJK_SPEC = "青田與合作方的兩份諒解備忘錄（中英對照）"
ESCAPED_SPEC = CJK_SPEC.encode("unicode_escape").decode("ascii")


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    monkeypatch.setenv("HERMES_KANBAN_WORKSPACES_ROOT", str(tmp_path / "ws"))
    monkeypatch.setenv("HERMES_KANBAN_ATTACHMENTS_ROOT", str(tmp_path / "att"))
    state = {"actor": OWNER, "enrolled": set(), "subject": "leo"}

    async def _resolve(request, *, allow_as=True):
        return state["actor"]

    async def _enrolled(user_id):
        return set(state["enrolled"])

    async def _subject(request):
        return state["subject"]

    monkeypatch.setattr(
        "hermes_cli.web_server._comms_resolve_principal", _resolve, raising=False
    )
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)
    monkeypatch.setattr(projects_api, "_interactive_subject", _subject)

    app = FastAPI()
    app.include_router(projects_api.router)
    app.include_router(projects_outputs_api.router)
    return TestClient(app), state, tmp_path


def _project(env, *, outputs=None) -> dict:
    client, _state, _tmp = env
    resp = client.post(
        "/api/registry/projects",
        json={
            "goal": "Sign the MOUs with both partners",
            "description": "Two bilingual MOUs.",
            "host_profile": "default",
            "outputs": outputs or [{"title": "2 MOUs in docx", "spec": CJK_SPEC}],
        },
    )
    assert resp.status_code == 200, resp.text
    project = resp.json()
    with projects_db.connect_closing() as conn:
        projects_db.add_project_member(
            conn, project_id=project["id"], user_id="vic", role="viewer"
        )
    return client.get(f"/api/registry/projects/{project['slug']}").json()


def _done_card(project, *, title, result=None, metadata=None, workspace=None):
    with kanban_db.connect_closing() as bconn:
        tid = kanban_db.create_task(
            bconn, title=title, assignee="default", project_id=project["id"],
            workspace_kind="dir" if workspace else "scratch",
            workspace_path=str(workspace) if workspace else None,
        )
        assert kanban_db.claim_task(bconn, tid, claimer="test:1")
        assert kanban_db.complete_task(
            bconn, tid, result=result, summary=result, metadata=metadata
        )
    return tid


def _run(project, task_ids) -> dict:
    with projects_db.connect_closing() as conn:
        run = projects_db.open_project_run(
            conn, project_id=project["id"], trigger="manual", profile="default"
        )
        for tid in task_ids:
            projects_db.link_run_card(conn, run["id"], tid)
        conn.execute(
            "UPDATE project_runs SET status = 'succeeded' WHERE id = ?", (run["id"],)
        )
        conn.commit()
    return run


def _artifacts(env, slug):
    client, _state, _tmp = env
    resp = client.get(f"/api/registry/projects/{slug}/artifacts")
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# Escape-code regression
# ---------------------------------------------------------------------------


def test_decode_literal_unicode_escapes_is_idempotent_and_safe():
    decode = projects_db.decode_literal_unicode_escapes
    assert decode(ESCAPED_SPEC) == CJK_SPEC
    assert decode(CJK_SPEC) == CJK_SPEC
    assert decode(decode(ESCAPED_SPEC)) == CJK_SPEC
    assert decode("\\ud83d\\ude00 done") == "😀 done"
    assert decode("C:\\users\\me") == "C:\\users\\me"
    assert decode(None) is None and decode("") == ""


def test_cjk_spec_round_trips_through_create_and_detail(env):
    project = _project(env)
    assert project["outputs"][0]["spec"] == CJK_SPEC
    assert "\\u" not in project["outputs"][0]["spec"]


def test_escaped_spec_written_by_an_agent_is_stored_decoded(env):
    client, _state, _tmp = env
    project = _project(
        env, outputs=[{"title": "\\u9752\\u7530 MOU", "spec": ESCAPED_SPEC}]
    )
    out = project["outputs"][0]
    assert out["title"] == "青田 MOU"
    assert out["spec"] == CJK_SPEC
    with projects_db.connect_closing() as conn:
        raw = conn.execute(
            "SELECT spec FROM project_outputs WHERE id = ?", (out["id"],)
        ).fetchone()["spec"]
    assert raw == CJK_SPEC

    resp = client.patch(
        f"/api/registry/projects/{project['slug']}/outputs/{out['id']}",
        json={"spec": "\\u5408\\u4f5c"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["spec"] == "合作"


def test_rows_stored_escaped_before_the_fix_read_decoded(env):
    client, _state, _tmp = env
    project = _project(env)
    with projects_db.connect_closing() as conn:
        conn.execute(
            "UPDATE project_outputs SET spec = ? WHERE project_id = ?",
            (ESCAPED_SPEC, project["id"]),
        )
        conn.commit()
    detail = client.get(f"/api/registry/projects/{project['slug']}").json()
    assert detail["outputs"][0]["spec"] == CJK_SPEC


# ---------------------------------------------------------------------------
# Artifacts read
# ---------------------------------------------------------------------------


def test_artifacts_empty_project_is_an_empty_list(env):
    project = _project(env)
    assert _artifacts(env, project["slug"]) == []


def test_artifacts_follow_the_read_gate(env):
    client, state, _tmp = env
    project = _project(env)
    state["actor"] = STRANGER
    assert client.get(f"/api/registry/projects/{project['slug']}/artifacts").status_code == 404
    state["actor"] = VIEWER
    assert client.get(f"/api/registry/projects/{project['slug']}/artifacts").status_code == 200
    assert client.get("/api/registry/projects/nope/artifacts").status_code == 404


def test_artifacts_classify_and_flag_unattached_files(env):
    client, _state, tmp = env
    project = _project(env)
    ws = tmp / "ws" / "mou"
    ws.mkdir(parents=True)
    (ws / "mou-qingtian.docx").write_bytes(b"docx-a")
    (ws / "mou-partner.docx").write_bytes(b"docx-b")
    (ws / "party-notes.md").write_text("who signs")
    tid = _done_card(
        project,
        title="Draft both MOUs",
        workspace=ws,
        metadata={"artifacts": [str(ws / "mou-qingtian.docx"), str(ws / "mou-partner.docx")]},
        result=(
            f"Notes in {ws / 'party-notes.md'}; shared "
            "[MOU draft](https://docs.google.com/document/d/abc123/edit)."
        ),
    )
    run = _run(project, [tid])

    items = _artifacts(env, project["slug"])
    by_title = {a["title"]: a for a in items}
    assert set(by_title) == {
        "mou-qingtian.docx", "mou-partner.docx", "party-notes.md", "MOU draft",
    }
    docx = by_title["mou-qingtian.docx"]
    assert docx["kind"] == "draft"
    assert docx["output_id"] is None
    assert docx["ext"] == "docx"
    assert docx["run_no"] == run["run_no"] == 1
    assert docx["card_id"] == tid and docx["card_title"] == "Draft both MOUs"
    assert docx["href"].startswith(f"/api/projects/{project['slug']}/artifacts/")
    assert by_title["party-notes.md"]["kind"] == "note"
    link = by_title["MOU draft"]
    assert link["kind"] == "draft" and link["href"].startswith("https://docs.google.com/")
    assert link["ext"] == "gdoc"

    # The file opens through the content route.
    aid = docx["id"]
    resp = client.get(f"/api/registry/projects/{project['slug']}/artifacts/{aid}/content")
    assert resp.status_code == 200
    assert resp.content == b"docx-a"


def test_attaching_a_card_file_makes_it_a_versioned_deliverable(env):
    client, _state, tmp = env
    project = _project(env)
    output_id = project["outputs"][0]["id"]
    ws = tmp / "ws" / "mou"
    ws.mkdir(parents=True)
    path = ws / "mou-qingtian.docx"
    path.write_bytes(b"docx-a")
    tid = _done_card(project, title="Draft MOU", workspace=ws,
                     metadata={"artifacts": [str(path)]})
    run = _run(project, [tid])

    resp = client.post(
        f"/api/registry/projects/{project['slug']}/outputs/{output_id}/deliver",
        json={"run_id": run["id"], "task_id": tid, "link_kind": "workspace",
              "link_ref": str(path), "label": "MOU (Qingtian)"},
    )
    assert resp.status_code == 200, resp.text

    items = _artifacts(env, project["slug"])
    assert len(items) == 1
    item = items[0]
    assert item["kind"] == "deliverable"
    assert item["output_id"] == output_id
    assert item["title"] == "MOU (Qingtian)"
    assert item["version"] == 1 and item["run_no"] == 1
    assert item["card_id"] == tid
    got = client.get(item["href"].replace("/api/projects/", "/api/registry/projects/"))
    assert got.status_code == 200 and got.content == b"docx-a"


def test_versions_count_runs_per_output_and_newest_comes_first(env):
    client, _state, _tmp = env
    project = _project(env)
    output_id = project["outputs"][0]["id"]
    slug = project["slug"]
    run1 = _run(project, [])
    for label in ("v1 a", "v1 b"):
        client.post(f"/api/registry/projects/{slug}/outputs/{output_id}/deliver",
                    json={"run_id": run1["id"], "link_kind": "url",
                          "link_ref": f"https://x.test/{label.replace(' ', '-')}.pdf",
                          "label": label})
    with projects_db.connect_closing() as conn:
        conn.execute("UPDATE project_output_deliveries SET delivered_at = delivered_at - 100")
        conn.commit()
    run2 = _run(project, [])
    client.post(f"/api/registry/projects/{slug}/outputs/{output_id}/deliver",
                json={"run_id": run2["id"], "link_kind": "url",
                      "link_ref": "https://x.test/v2.pdf", "label": "v2"})

    items = _artifacts(env, slug)
    assert [a["title"] for a in items][0] == "v2"
    versions = {a["title"]: (a["version"], a["run_no"]) for a in items}
    assert versions == {"v2": (2, 2), "v1 a": (1, 1), "v1 b": (1, 1)}
    assert all(a["ext"] == "pdf" for a in items)


def test_a_file_claimed_by_two_cards_appears_once(env):
    """A follow-on card that names another card's workspace file must not
    re-list it: the row is owned by the card whose workspace holds it, and
    attaching it leaves no unattached twin."""
    client, _state, tmp = env
    project = _project(env)
    output_id = project["outputs"][0]["id"]
    ws = tmp / "ws" / "producer"
    ws.mkdir(parents=True)
    path = ws / "mou-final.docx"
    path.write_bytes(b"docx-a")
    producer = _done_card(project, title="Write the MOU", workspace=ws,
                          metadata={"artifacts": [str(path)]})
    consumer = _done_card(project, title="File the MOU away",
                          metadata={"artifacts": [str(path)]})
    run = _run(project, [producer, consumer])

    items = _artifacts(env, project["slug"])
    matches = [a for a in items if a["title"] == "mou-final.docx"]
    assert len(matches) == 1
    assert matches[0]["card_id"] == producer
    assert matches[0]["kind"] == "draft" and matches[0]["output_id"] is None

    resp = client.post(
        f"/api/registry/projects/{project['slug']}/outputs/{output_id}/deliver",
        json={"run_id": run["id"], "task_id": consumer, "link_kind": "workspace",
              "link_ref": str(path), "label": "mou-final.docx"},
    )
    assert resp.status_code == 200, resp.text
    items = _artifacts(env, project["slug"])
    matches = [a for a in items if a["title"] == "mou-final.docx"]
    assert len(matches) == 1 and matches[0]["kind"] == "deliverable"


def test_a_url_linked_by_two_cards_appears_once(env):
    project = _project(env)
    url = "https://docs.google.com/document/d/abc123/edit"
    _done_card(project, title="Draft", result=f"shared [draft]({url})")
    _done_card(project, title="Review", result=f"re-checked {url}")
    items = _artifacts(env, project["slug"])
    assert [a["link_ref"] for a in items].count(url) == 1


def test_a_bare_doc_link_takes_its_recorded_filename(env):
    """A bare docs.google.com URL in a summary/result names the file the
    run recorded for it (``new_files`` name/link), not the generic
    "Google Doc" — and the mention need not match the recorded link
    byte-for-byte (edit vs view, extra query)."""
    project = _project(env)
    url = "https://docs.google.com/document/d/abc123def456/view?usp=sharing"
    _done_card(
        project, title="Upload the MOU", result=f"uploaded {url}",
        metadata={"new_files": [{
            "name": "MOU-final-v2.docx",
            "link": "https://docs.google.com/document/d/abc123def456/edit",
        }]},
    )
    items = _artifacts(env, project["slug"])
    link = next(a for a in items if a["link_ref"] == url)
    assert link["title"] == "MOU-final-v2.docx"


def test_a_bare_doc_link_takes_the_recorded_drive_id_name(env):
    """The confirm-upload card's ``files`` entries record
    ``{"stored_name": …, "id": <drive id>}`` with no link field — the
    /d/<id>/ in a bare mention still resolves the filename."""
    project = _project(env)
    url = "https://docs.google.com/document/d/1j6AvJD2hu4V7PWJ1UKcgmA6xh/edit"
    _done_card(
        project, title="Confirm upload", result=f"confirmed {url}",
        metadata={"files": [
            {"stored_name": "01_黃震遐醫生_版權授權及版稅協議 (1).docx",
             "id": "1j6AvJD2hu4V7PWJ1UKcgmA6xh"},
        ]},
    )
    items = _artifacts(env, project["slug"])
    link = next(a for a in items if a["link_ref"] == url)
    assert link["title"] == "01_黃震遐醫生_版權授權及版稅協議 (1).docx"


def test_a_markdown_link_label_still_wins_over_the_recorded_name(env):
    """An explicit ``[label](url)`` is the author's chosen title — the
    recorded filename only fills in when the mention is bare."""
    project = _project(env)
    url = "https://docs.google.com/document/d/abc123def456/edit"
    _done_card(
        project, title="Upload the MOU", result=f"see [signed copy]({url})",
        metadata={"new_files": [{"name": "MOU-final-v2.docx", "link": url}]},
    )
    items = _artifacts(env, project["slug"])
    link = next(a for a in items if a["link_ref"] == url)
    assert link["title"] == "signed copy"


def test_an_unnamed_doc_link_keeps_the_generic_title(env):
    project = _project(env)
    url = "https://docs.google.com/document/d/abc123def456/edit"
    _done_card(project, title="Note", result=f"link {url}")
    items = _artifacts(env, project["slug"])
    link = next(a for a in items if a["link_ref"] == url)
    assert link["title"] == "Google Doc"


def test_rotted_workspace_delivery_opens_the_uploaded_copy(env):
    """Scratch workspaces are wiped when a card completes, so a workspace
    delivery rots. When a run recorded an uploaded copy in its metadata
    (``new_files`` name/link), the deliverable opens that instead."""
    client, _state, tmp = env
    project = _project(env)
    output_id = project["outputs"][0]["id"]
    ws = tmp / "ws" / "gone"
    ws.mkdir(parents=True)
    path = ws / "mou-final.docx"
    path.write_bytes(b"docx-a")
    remote = "https://docs.google.com/document/d/abc123/edit"
    tid = _done_card(
        project, title="Write + file the MOU", workspace=ws,
        metadata={"artifacts": [str(path)],
                  "new_files": [{"name": "mou-final.docx", "link": remote}]},
    )
    run = _run(project, [tid])
    resp = client.post(
        f"/api/registry/projects/{project['slug']}/outputs/{output_id}/deliver",
        json={"run_id": run["id"], "task_id": tid, "link_kind": "workspace",
              "link_ref": str(path), "label": "mou-final.docx"},
    )
    assert resp.status_code == 200, resp.text
    path.unlink()  # scratch cleanup

    item = _artifacts(env, project["slug"])[0]
    assert item["kind"] == "deliverable"
    assert item["href"] == remote
    assert item["location"] == "docs.google.com"


def test_rotted_workspace_draft_opens_the_uploaded_copy(env):
    _client, _state, tmp = env
    project = _project(env)
    ws = tmp / "ws" / "gone"
    ws.mkdir(parents=True)
    path = ws / "mou-final.docx"
    path.write_bytes(b"docx-a")
    remote = "https://docs.google.com/document/d/abc123/edit"
    _done_card(
        project, title="Write + file the MOU", workspace=ws,
        metadata={"artifacts": [str(path)],
                  "new_files": [{"name": "mou-final.docx", "link": remote}]},
    )
    path.unlink()

    item = _artifacts(env, project["slug"])[0]
    assert item["kind"] == "draft" and item["output_id"] is None
    assert item["href"] == remote


def test_a_handoff_file_in_the_kanban_artifacts_folder_opens(env):
    """Workers keep handoff files in ``<kanban>/artifacts`` beside the
    scratch workspaces because those are wiped on completion."""
    client, _state, tmp = env
    project = _project(env)
    store = tmp / "artifacts"
    store.mkdir()
    path = store / "t_1-quotation-draft.md"
    path.write_text("draft")
    _done_card(project, title="Draft the quote", metadata={"deliverable": str(path)},
               result=f"Draft at {path}")
    item = _artifacts(env, project["slug"])[0]
    assert item["title"] == "t_1-quotation-draft.md"
    assert item["missing"] is False
    got = client.get(item["href"].replace("/api/projects/", "/api/registry/projects/"))
    assert got.status_code == 200 and got.content == b"draft"


def test_a_file_wiped_with_its_scratch_workspace_reads_missing(env):
    _client, _state, tmp = env
    project = _project(env)
    ws = tmp / "ws" / "gone"
    ws.mkdir(parents=True)
    path = ws / "quote.pdf"
    path.write_bytes(b"pdf")
    _done_card(project, title="Render the quote", workspace=ws,
               metadata={"artifacts": [str(path)]})
    path.unlink()
    item = _artifacts(env, project["slug"])[0]
    assert item["href"] is None
    assert item["missing"] is True
    assert item["location"] == "card workspace"


def _scratch_card(project, *, title, files, result=None, artifacts=None):
    """A project card on a real scratch workspace: write ``files`` into it,
    then complete it (which wipes the workspace)."""
    with kanban_db.connect_closing() as bconn:
        tid = kanban_db.create_task(
            bconn, title=title, assignee="default", project_id=project["id"],
        )
        ws = kanban_db.resolve_workspace(kanban_db.get_task(bconn, tid))
        kanban_db.set_workspace_path(bconn, tid, ws)
        paths = {}
        for rel, data in files.items():
            path = ws / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            paths[rel] = path
        assert kanban_db.claim_task(bconn, tid, claimer="test:1")
        names = [str(paths[r]) for r in (artifacts or [])]
        assert kanban_db.complete_task(
            bconn, tid, result=result, summary=result,
            metadata={"artifacts": names} if names else None,
        )
    assert not ws.exists()
    return tid, ws, paths


def test_a_reported_file_survives_its_scratch_workspace(env):
    client, _state, _tmp = env
    project = _project(env)
    _tid, _ws, paths = _scratch_card(
        project, title="Build the sheet",
        files={"out/sheet.xlsx": b"xlsx-bytes", "out/scratch.tmp": b"junk", "NOTES.md": b"notes"},
        artifacts=["out/sheet.xlsx"],
    )
    items = {i["title"]: i for i in _artifacts(env, project["slug"])}
    sheet = items["sheet.xlsx"]
    assert sheet["missing"] is False and sheet["href"]
    assert sheet["location"] == "card workspace / out"
    got = client.get(sheet["href"].replace("/api/projects/", "/api/registry/projects/"))
    assert got.status_code == 200 and got.content == b"xlsx-bytes"
    kept = kanban_db.kept_copy(paths["out/sheet.xlsx"].parent.parent, paths["out/sheet.xlsx"])
    assert kept is not None and kept.read_bytes() == b"xlsx-bytes"
    # Only what the card reported is kept; the rest of the workspace goes.
    assert not kanban_db.kept_copy(
        paths["out/scratch.tmp"].parent.parent, paths["out/scratch.tmp"]
    ).exists()


def test_a_workspace_whose_reported_file_cannot_be_kept_is_not_wiped(env, monkeypatch):
    """A reported file this process cannot read (the sandboxed terminal user
    wrote it 0600) must not be lost: the workspace stays instead of being
    wiped with the only copy in it."""
    project = _project(env)

    def _denied(src, dst, **_kw):
        raise PermissionError(13, "Permission denied", str(src))

    monkeypatch.setattr("shutil.copy2", _denied)
    with kanban_db.connect_closing() as bconn:
        tid = kanban_db.create_task(
            bconn, title="Finalise", assignee="default", project_id=project["id"],
        )
        ws = kanban_db.resolve_workspace(kanban_db.get_task(bconn, tid))
        kanban_db.set_workspace_path(bconn, tid, ws)
        final = ws / "summary.md"
        final.write_text("final")
        assert kanban_db.claim_task(bconn, tid, claimer="test:1")
        assert kanban_db.complete_task(bconn, tid, metadata={"artifacts": [str(final)]})
    assert final.read_text() == "final"


def test_a_delivery_of_a_kept_file_opens_after_the_wipe(env):
    client, _state, _tmp = env
    project = _project(env)
    tid, _ws, paths = _scratch_card(
        project, title="Build the sheet", files={"out/final.xlsx": b"final"},
        artifacts=["out/final.xlsx"],
    )
    output_id = project["outputs"][0]["id"]
    with projects_db.connect_closing() as conn:
        projects_db.record_output_delivery(
            conn, output_id=output_id, task_id=tid, link_kind="workspace",
            link_ref=str(paths["out/final.xlsx"]), profile="default",
        )
    item = next(i for i in _artifacts(env, project["slug"]) if i["kind"] == "deliverable")
    assert item["missing"] is False and item["href"]
    got = client.get(item["href"].replace("/api/projects/", "/api/registry/projects/"))
    assert got.status_code == 200 and got.content == b"final"


def test_a_symlink_out_of_the_workspace_is_not_kept(env, tmp_path):
    _client, _state, _tmp = env
    project = _project(env)
    secret = tmp_path / "secret.txt"
    secret.write_text("secret")
    with kanban_db.connect_closing() as bconn:
        tid = kanban_db.create_task(bconn, title="Leak", assignee="default", project_id=project["id"])
        ws = kanban_db.resolve_workspace(kanban_db.get_task(bconn, tid))
        kanban_db.set_workspace_path(bconn, tid, ws)
        link = ws / "leak.txt"
        link.symlink_to(secret)
        assert kanban_db.claim_task(bconn, tid, claimer="test:1")
        assert kanban_db.complete_task(bconn, tid, metadata={"artifacts": [str(link)]})
    assert not kanban_db.kept_copy(ws, link).exists()


def test_a_wiped_docx_opens_the_google_doc_made_from_it(env):
    """A run that converts ``Quote v1.0.docx`` into the Google Doc
    ``Quote v1.0`` records ``name`` + ``doc_url``; the wiped local docx
    opens that doc."""
    _client, _state, tmp = env
    project = _project(env)
    ws = tmp / "ws" / "gone"
    ws.mkdir(parents=True)
    path = ws / "Quote v1.0.docx"
    path.write_bytes(b"docx")
    remote = "https://docs.google.com/document/d/1tt0J-wj8e2TbKXhEX1k8o_4sp4K/edit"
    _done_card(project, title="Create the Google Doc", workspace=ws,
               metadata={"artifacts": [str(path)], "name": "Quote v1.0",
                         "doc_url": remote})
    path.unlink()
    item = next(a for a in _artifacts(env, project["slug"]) if a["source"] == "card_file")
    assert item["title"] == "Quote v1.0.docx"
    assert item["href"] == remote
    assert item["missing"] is False


def test_a_web_link_delivered_without_a_kind_is_a_url_delivery(env):
    """An agent delivering ``link_ref=<Google Doc URL>`` with no
    ``link_kind`` gets an openable, named deliverable."""
    client, _state, _tmp = env
    project = _project(env)
    output_id = project["outputs"][0]["id"]
    doc_id = "1tt0J-wj8e2TbKXhEX1k8o_4sp4KaH8YsVMViSbHhY1w"
    url = f"https://docs.google.com/document/d/{doc_id}/edit"
    _done_card(project, title="Create the Google Doc",
               metadata={"doc_id": doc_id, "doc_name": "x", "name": "Quote v1.0"})
    with projects_db.connect_closing() as conn:
        did = projects_db.record_output_delivery(conn, output_id=output_id, link_ref=url)
        legacy = projects_db.record_output_delivery(
            conn, output_id=output_id, link_ref=url + "?legacy=1"
        )
        conn.execute(
            "UPDATE project_output_deliveries SET link_kind = NULL WHERE id = ?",
            (legacy,),
        )
        conn.commit()
        stored = {
            d["id"]: d["link_kind"]
            for d in projects_db.get_output_deliveries(conn, output_id=output_id)
        }
    assert stored[did] == "url"

    items = {a["id"]: a for a in _artifacts(env, project["slug"])}
    for key in (f"d:{did}", f"d:{legacy}"):
        item = items[key]
        assert item["link_kind"] == "url"
        assert item["href"].startswith(url)
        assert item["title"] == "Quote v1.0"
        assert item["location"] == "docs.google.com"


def test_a_local_path_delivered_without_a_kind_is_not_a_url(env):
    _client, _state, _tmp = env
    project = _project(env)
    output_id = project["outputs"][0]["id"]
    with projects_db.connect_closing() as conn:
        did = projects_db.record_output_delivery(
            conn, output_id=output_id, link_ref="/tmp/quote.docx"
        )
        kinds = [d["link_kind"] for d in projects_db.get_output_deliveries(conn, output_id=output_id)]
    assert kinds == [None]
    item = _artifacts(env, project["slug"])[0]
    assert item["id"] == f"d:{did}" and item["href"] is None


def test_a_claimed_path_outside_the_managed_roots_is_never_served(env):
    client, _state, tmp = env
    project = _project(env)
    secret = tmp / "secret-report.md"
    secret.write_text("not yours")
    _done_card(project, title="Sneaky", metadata={"artifacts": [str(secret)]})
    items = _artifacts(env, project["slug"])
    assert len(items) == 1
    assert items[0]["href"] is None
    resp = client.get(
        f"/api/registry/projects/{project['slug']}/artifacts/{items[0]['id']}/content"
    )
    assert resp.status_code == 404


def test_stranger_cannot_open_content(env):
    client, state, tmp = env
    project = _project(env)
    ws = tmp / "ws" / "c"
    ws.mkdir(parents=True)
    (ws / "a.md").write_text("x")
    _done_card(project, title="c", workspace=ws, metadata={"artifacts": [str(ws / "a.md")]})
    aid = _artifacts(env, project["slug"])[0]["id"]
    state["actor"] = STRANGER
    resp = client.get(f"/api/registry/projects/{project['slug']}/artifacts/{aid}/content")
    assert resp.status_code == 404


def test_pure_helpers():
    m = projects_outputs_api
    assert m.ext_of("/a/MOU.v2.DOCX") == "docx"
    assert m.ext_of("README") is None
    assert m.classify("run.log", attached=False) == "note"
    assert m.classify("Final report.pdf", attached=False) == "draft"
    assert m.classify("notes.md", attached=True) == "deliverable"
    assert m.links_in_text("see https://example.com/page and https://e.com/f.pdf") == [
        ("https://e.com/f.pdf", None)
    ]
    assert m.paths_in_text("wrote /w/a.md, then /w/b.md.") == ["/w/a.md", "/w/b.md"]


def test_agent_written_html_downloads_sandboxed_and_pdf_stays_inline(env):
    """F3: an agent can write HTML; it must never render inline on the origin."""
    client, _state, tmp = env
    project = _project(env)
    ws = tmp / "ws" / "xss"
    ws.mkdir(parents=True)
    (ws / "report.html").write_text("<script>alert(document.cookie)</script>")
    (ws / "logo.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>")
    (ws / "mou.pdf").write_bytes(b"%PDF-1.4")
    _done_card(project, title="xss", workspace=ws, metadata={"artifacts": [
        str(ws / "report.html"), str(ws / "logo.svg"), str(ws / "mou.pdf"),
    ]})
    by_title = {a["title"]: a for a in _artifacts(env, project["slug"])}
    slug = project["slug"]

    for name in ("report.html", "logo.svg"):
        resp = client.get(f"/api/registry/projects/{slug}/artifacts/{by_title[name]['id']}/content")
        assert resp.status_code == 200
        assert resp.headers["content-disposition"].startswith("attachment;")
        assert resp.headers["x-content-type-options"] == "nosniff"
        assert resp.headers["content-security-policy"].startswith("sandbox;")

    resp = client.get(f"/api/registry/projects/{slug}/artifacts/{by_title['mou.pdf']['id']}/content")
    assert resp.headers["content-disposition"].startswith("inline;")
    assert resp.headers["content-security-policy"].startswith("sandbox;")


# ---------------------------------------------------------------------------
# A delivery never points at a scratch path that completion deletes
# ---------------------------------------------------------------------------


def _deliver(env, project, body):
    client, _state, _tmp = env
    oid = project["outputs"][0]["id"]
    return client.post(
        f"/api/registry/projects/{project['slug']}/outputs/{oid}/deliver", json=body
    )


def _output_status(project):
    with projects_db.connect_closing() as conn:
        return projects_db.get_project_outputs(conn, project["id"])[0]["status"]


def test_delivering_a_scratch_file_delivers_its_kept_copy(env):
    client, _state, _tmp = env
    project = _project(env)
    with kanban_db.connect_closing() as bconn:
        tid = kanban_db.create_task(
            bconn, title="Build the book", assignee="default", project_id=project["id"],
        )
        ws = kanban_db.resolve_workspace(kanban_db.get_task(bconn, tid))
        kanban_db.set_workspace_path(bconn, tid, ws)
        book = ws / "out" / "book.xlsx"
        book.parent.mkdir(parents=True)
        book.write_bytes(b"book-bytes")
        assert kanban_db.claim_task(bconn, tid, claimer="test:1")
    # Delivered mid-run, the way the CLI does it: a bare path, no kind.
    resp = _deliver(env, project, {"link_ref": str(book), "task_id": tid})
    assert resp.status_code == 200, resp.text
    with projects_db.connect_closing() as conn:
        (d,) = projects_db.get_output_deliveries(conn, project_id=project["id"])
    kept = kanban_db.kept_copy(ws, book)
    assert d["link_kind"] == "workspace" and d["link_ref"] == str(kept)
    assert kept.read_bytes() == b"book-bytes"
    # The card completes without listing the file; the workspace goes.
    with kanban_db.connect_closing() as bconn:
        assert kanban_db.complete_task(bconn, tid, summary="built the book")
    assert not ws.exists()
    item = next(i for i in _artifacts(env, project["slug"]) if i["kind"] == "deliverable")
    assert item["missing"] is False and item["href"]
    assert item["location"] == "kept artifacts"
    got = client.get(item["href"].replace("/api/projects/", "/api/registry/projects/"))
    assert got.status_code == 200 and got.content == b"book-bytes"


def test_a_delivery_of_a_wiped_scratch_path_is_refused(env):
    project = _project(env)
    tid, _ws, paths = _scratch_card(
        project, title="Build the book", files={"out/book.xlsx": b"x"},
    )
    resp = _deliver(env, project, {
        "link_kind": "workspace", "link_ref": str(paths["out/book.xlsx"]),
        "task_id": tid,
    })
    assert resp.status_code == 422
    assert "scratch workspace" in resp.json()["detail"]
    assert _output_status(project) != "delivered"
    with projects_db.connect_closing() as conn:
        assert projects_db.get_output_deliveries(conn, project_id=project["id"]) == []


def test_a_wiped_scratch_path_whose_copy_was_kept_delivers_the_copy(env):
    project = _project(env)
    tid, ws, paths = _scratch_card(
        project, title="Build the book", files={"out/book.xlsx": b"x"},
        artifacts=["out/book.xlsx"],
    )
    resp = _deliver(env, project, {"link_ref": str(paths["out/book.xlsx"]), "task_id": tid})
    assert resp.status_code == 200, resp.text
    with projects_db.connect_closing() as conn:
        (d,) = projects_db.get_output_deliveries(conn, project_id=project["id"])
    assert d["link_ref"] == str(kanban_db.kept_copy(ws, paths["out/book.xlsx"]))


def test_a_local_path_that_does_not_resolve_is_refused(env, tmp_path):
    project = _project(env)
    resp = _deliver(env, project, {"link_ref": str(tmp_path / "nowhere.xlsx")})
    assert resp.status_code == 422
    assert _output_status(project) != "delivered"


def test_urls_and_non_paths_are_delivered_as_given(env):
    project = _project(env)
    url = "https://home.example/api/files/abc/content?download=1"
    assert _deliver(env, project, {"link_ref": url}).status_code == 200
    assert _deliver(env, project, {"link_kind": "file", "link_ref": "fa_123"}).status_code == 200
    with projects_db.connect_closing() as conn:
        refs = {(d["link_kind"], d["link_ref"]) for d in
                projects_db.get_output_deliveries(conn, project_id=project["id"])}
    assert refs == {("url", url), ("file", "fa_123")}
    assert _output_status(project) == "delivered"


def test_a_file_named_only_in_run_metadata_survives_the_wipe(env):
    project = _project(env)
    with kanban_db.connect_closing() as bconn:
        tid = kanban_db.create_task(
            bconn, title="Build the book", assignee="default", project_id=project["id"],
        )
        ws = kanban_db.resolve_workspace(kanban_db.get_task(bconn, tid))
        kanban_db.set_workspace_path(bconn, tid, ws)
        (ws / "out").mkdir()
        (ws / "out" / "book.xlsx").write_bytes(b"book")
        (ws / "out" / "unmatched.csv").write_bytes(b"csv")
        assert kanban_db.claim_task(bconn, tid, claimer="test:1")
        assert kanban_db.complete_task(
            bconn, tid, summary="built it",
            metadata={"output": str(ws / "out" / "book.xlsx"),
                      "companions": ["out/unmatched.csv"]},
        )
    assert not ws.exists()
    kept = kanban_db.kept_files_dir(ws)
    assert (kept / "out" / "book.xlsx").read_bytes() == b"book"
    assert (kept / "out" / "unmatched.csv").read_bytes() == b"csv"
