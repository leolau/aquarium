"""Tests for OSV malware check on MCP extension packages."""

import json
import pytest
from unittest.mock import patch, MagicMock

from tools.osv_check import (
    check_package_for_malware,
    _infer_ecosystem,
    _parse_package_from_args,
    _parse_npm_package,
    _parse_pypi_package,
    _query_osv,
)


class TestInferEcosystem:
    def test_npx(self):
        assert _infer_ecosystem("npx") == "npm"
        assert _infer_ecosystem("/usr/bin/npx") == "npm"

    def test_uvx(self):
        assert _infer_ecosystem("uvx") == "PyPI"
        assert _infer_ecosystem("/home/user/.local/bin/uvx") == "PyPI"

    def test_pipx(self):
        assert _infer_ecosystem("pipx") == "PyPI"

    def test_unknown(self):
        assert _infer_ecosystem("node") is None
        assert _infer_ecosystem("python") is None
        assert _infer_ecosystem("/bin/bash") is None


class TestParseNpmPackage:
    def test_simple(self):
        assert _parse_npm_package("react") == ("react", None)

    def test_with_version(self):
        assert _parse_npm_package("react@18.3.1") == ("react", "18.3.1")

    def test_scoped(self):
        assert _parse_npm_package("@modelcontextprotocol/server-filesystem") == (
            "@modelcontextprotocol/server-filesystem", None
        )

    def test_scoped_with_version(self):
        assert _parse_npm_package("@scope/pkg@1.2.3") == ("@scope/pkg", "1.2.3")

    def test_latest_ignored(self):
        assert _parse_npm_package("react@latest") == ("react", None)


class TestParsePypiPackage:
    def test_simple(self):
        assert _parse_pypi_package("requests") == ("requests", None)

    def test_with_version(self):
        assert _parse_pypi_package("requests==2.32.3") == ("requests", "2.32.3")

    def test_with_extras(self):
        assert _parse_pypi_package("mcp[cli]==1.2.3") == ("mcp", "1.2.3")

    def test_extras_no_version(self):
        assert _parse_pypi_package("mcp[cli]") == ("mcp", None)


class TestParsePackageFromArgs:
    def test_npm_skips_flags(self):
        name, ver = _parse_package_from_args(["-y", "@scope/pkg@1.0"], "npm")
        assert name == "@scope/pkg"
        assert ver == "1.0"

    def test_pypi_skips_flags(self):
        name, ver = _parse_package_from_args(["--from", "mcp[cli]"], "PyPI")
        # --from is a flag, mcp[cli] is the package
        # Actually --from is a flag so it gets skipped, mcp[cli] is found
        assert name == "mcp"

    def test_empty_args(self):
        assert _parse_package_from_args([], "npm") == (None, None)

    def test_only_flags(self):
        assert _parse_package_from_args(["-y", "--yes"], "npm") == (None, None)

    def test_package_equals_form(self):
        # `npx --package=@scope/pkg@1.0 some-bin` -> install target is the
        # --package value, NOT the executed binary `some-bin`.
        name, ver = _parse_package_from_args(
            ["--package=@scope/pkg@1.0", "some-bin"], "npm"
        )
        assert name == "@scope/pkg"
        assert ver == "1.0"

    def test_package_space_form(self):
        # `npx --package @scope/pkg some-bin` (value in the next token).
        name, ver = _parse_package_from_args(
            ["--package", "@scope/pkg@2.0", "some-bin"], "npm"
        )
        assert name == "@scope/pkg"
        assert ver == "2.0"

    def test_short_p_form(self):
        # `npx -p left-pad@1.3.0 cli-cmd` -> package is left-pad, not cli-cmd.
        name, ver = _parse_package_from_args(
            ["-p", "left-pad@1.3.0", "cli-cmd"], "npm"
        )
        assert name == "left-pad"
        assert ver == "1.3.0"

    def test_plain_positional_still_works(self):
        # Regression guard: bare positional with no --package flag is the pkg.
        name, ver = _parse_package_from_args(["-y", "react@18.3.1"], "npm")
        assert name == "react"
        assert ver == "18.3.1"


class TestCheckPackageForMalware:
    def test_clean_package(self):
        """Clean package returns None (allow)."""
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({"vulns": []}).encode()
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)

        with patch("tools.osv_check.urllib.request.urlopen", return_value=mock_response):
            result = check_package_for_malware("npx", ["-y", "@modelcontextprotocol/server-filesystem"])
        assert result is None

    def test_malware_blocked(self):
        """Known malware package returns error string."""
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "vulns": [
                {"id": "MAL-2023-7938", "summary": "Malicious code in evil-pkg"},
                {"id": "CVE-2023-1234", "summary": "Regular vulnerability"},  # should be filtered
            ]
        }).encode()
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)

        with patch("tools.osv_check.urllib.request.urlopen", return_value=mock_response):
            result = check_package_for_malware("npx", ["evil-pkg"])
        assert result is not None
        assert "BLOCKED" in result
        assert "MAL-2023-7938" in result
        assert "CVE-2023-1234" not in result  # regular CVEs filtered

    def test_network_error_fails_open(self):
        """Network errors allow the package (fail-open)."""
        with patch("tools.osv_check.urllib.request.urlopen", side_effect=ConnectionError("timeout")):
            result = check_package_for_malware("npx", ["some-package"])
        assert result is None

    def test_non_npx_skipped(self):
        """Non-npx/uvx commands are skipped entirely."""
        result = check_package_for_malware("node", ["server.js"])
        assert result is None

    def test_uvx_pypi(self):
        """uvx commands check PyPI ecosystem."""
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({"vulns": []}).encode()
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)

        with patch("tools.osv_check.urllib.request.urlopen", return_value=mock_response) as mock_url:
            check_package_for_malware("uvx", ["mcp-server-fetch"])
            # Verify PyPI ecosystem was sent
            call_data = json.loads(mock_url.call_args[0][0].data)
            assert call_data["package"]["ecosystem"] == "PyPI"
            assert call_data["package"]["name"] == "mcp-server-fetch"


class TestLiveOsvQuery:
    """Live integration test against the real OSV API. Skipped if offline."""

    @pytest.mark.skipif(
        not pytest.importorskip("urllib.request", reason="no network"),
        reason="network required",
    )
    def test_known_malware_package(self):
        """node-hide-console-windows has a real MAL- advisory."""
        try:
            result = _query_osv("node-hide-console-windows", "npm")
            assert len(result) >= 1
            assert result[0]["id"].startswith("MAL-")
        except Exception:
            pytest.skip("OSV API unreachable")

    @pytest.mark.skipif(
        not pytest.importorskip("urllib.request", reason="no network"),
        reason="network required",
    )
    def test_clean_package(self):
        """react should have zero MAL- advisories."""
        try:
            result = _query_osv("react", "npm")
            assert len(result) == 0
        except Exception:
            pytest.skip("OSV API unreachable")


# ---------------------------------------------------------------------------
# Fail-closed lockfile mode (FG-33 local apps)
# ---------------------------------------------------------------------------

from tools import osv_check  # noqa: E402


def _pkg(name, version="1.0.0", **kw):
    entry = {"version": version, "resolved": f"https://registry.npmjs.org/{name}/-/{name}-{version}.tgz",
             "integrity": "sha512-AAAA"}
    entry.update(kw)
    return entry


def _lock(**pkgs):
    return {"lockfileVersion": 3, "packages": {"": {"name": "app"},
                                               **{f"node_modules/{k}": v for k, v in pkgs.items()}}}


GOOD_LOCK = _lock(next=_pkg("next", "15.0.0"), **{"@types/node": _pkg("@types/node", "22.0.0")})


class TestCheckLockfile:
    def _osv(self, answer):
        calls = []

        def fake(queries):
            calls.append(queries)
            if isinstance(answer, Exception):
                raise answer
            return answer(queries)

        return patch("tools.osv_check._query_osv_batch", side_effect=fake), calls

    def test_clean_lockfile_passes(self, tmp_path):
        path = tmp_path / "package-lock.json"
        path.write_text(json.dumps(GOOD_LOCK))
        p, calls = self._osv(lambda qs: [{} for _ in qs])
        with p:
            verdict = osv_check.check_lockfile(path)
        assert verdict.ok and verdict.packages == 2 and verdict.reasons == []
        assert sorted(q["package"]["name"] for q in calls[0]) == ["@types/node", "next"]
        assert all(q["package"]["ecosystem"] == "npm" for q in calls[0])

    def test_malware_anywhere_in_the_tree_refuses(self):
        p, _ = self._osv(lambda qs: [{"vulns": [{"id": "MAL-2025-9"}]} if q["package"]["name"] == "next" else {}
                                     for q in qs])
        with p:
            verdict = osv_check.check_lockfile(GOOD_LOCK)
        assert not verdict.ok and verdict.malware == [{"package": "next", "version": "15.0.0", "ids": ["MAL-2025-9"]}]

    def test_regular_cves_do_not_refuse(self):
        p, _ = self._osv(lambda qs: [{"vulns": [{"id": "GHSA-1"}, {"id": "CVE-2024-2"}]} for _ in qs])
        with p:
            assert osv_check.check_lockfile(GOOD_LOCK).ok

    @pytest.mark.parametrize("answer", [
        Exception("connection refused"),
        TimeoutError("slow"),
        lambda qs: None,
        lambda qs: [{}],
        lambda qs: [{"next_page_token": "t"} for _ in qs],
        lambda qs: ["x" for _ in qs],
    ])
    def test_osv_trouble_fails_closed(self, answer):
        p, _ = self._osv(answer)
        with p:
            verdict = osv_check.check_lockfile(GOOD_LOCK)
        assert not verdict.ok and verdict.reasons

    @pytest.mark.parametrize("lock", [
        {"lockfileVersion": 1, "dependencies": {}},
        {"lockfileVersion": 3},
        _lock(x=_pkg("x", resolved="git+ssh://git@github.com/x/x.git")),
        _lock(x=_pkg("x", resolved="https://evil.example.com/x.tgz")),
        _lock(x=_pkg("x", integrity=None)),
        _lock(x=_pkg("x", integrity="sha1-abc")),
        _lock(x={"link": True, "resolved": "../x"}),
        _lock(x=_pkg("x", version="")),
        [],
    ])
    def test_unpinned_or_malformed_lockfiles_refuse_without_asking_osv(self, lock):
        p, calls = self._osv(lambda qs: [{} for _ in qs])
        with p:
            verdict = osv_check.check_lockfile(lock)
        assert not verdict.ok and calls == []

    def test_missing_unreadable_and_oversized_lockfiles_refuse(self, tmp_path):
        assert not osv_check.check_lockfile(tmp_path / "package-lock.json").ok
        bad = tmp_path / "bad.json"
        bad.write_text("{not json")
        assert not osv_check.check_lockfile(bad).ok
        big = tmp_path / "big.json"
        big.write_text(json.dumps(GOOD_LOCK))
        assert not osv_check.check_lockfile(big, max_bytes=10).ok

    def test_package_ceiling(self):
        lock = _lock(**{f"p{i}": _pkg(f"p{i}") for i in range(4)})
        p, _ = self._osv(lambda qs: [{} for _ in qs])
        with p:
            assert not osv_check.check_lockfile(lock, max_packages=3).ok
            assert osv_check.check_lockfile(lock, max_packages=4).ok

    def test_large_trees_are_batched(self):
        lock = _lock(**{f"p{i}": _pkg(f"p{i}") for i in range(2500)})
        p, calls = self._osv(lambda qs: [{} for _ in qs])
        with p:
            assert osv_check.check_lockfile(lock).ok
        assert [len(c) for c in calls] == [1000, 1000, 500]

    def test_cli_exit_codes(self, tmp_path, capsys):
        path = tmp_path / "package-lock.json"
        path.write_text(json.dumps(GOOD_LOCK))
        p, _ = self._osv(lambda qs: [{} for _ in qs])
        with p:
            assert osv_check.main([str(path)]) == 0
        p, _ = self._osv(Exception("offline"))
        with p:
            assert osv_check.main([str(path)]) == 1
        assert osv_check.main([]) == 2

    def test_mcp_package_check_stays_fail_open(self):
        """The npx/uvx launch check keeps its documented fail-open behaviour."""
        with patch("tools.osv_check._query_osv", side_effect=ConnectionError("offline")):
            assert check_package_for_malware("npx", ["-y", "some-package"]) is None
