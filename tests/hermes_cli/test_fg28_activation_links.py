"""FG-28 C2: activation links name their profile, and the hash binds to it.

The profile in ``/activate/<profile>/<token>`` is routing metadata. These
contracts are what make it safe to trust as routing and useless as a grant:
the stored hash differs per profile, so editing the name in a link makes the
token match nothing; and the pre-binding (v1) hash is only ever a candidate in
the default profile, where every legacy link was minted.
"""

from __future__ import annotations

from types import SimpleNamespace

from hermes_cli.console_scope import Enrolment, pick_enrolment
from hermes_cli.invitations import activation_path, hash_token, token_digests


def test_a_named_profile_travels_in_the_link() -> None:
    assert activation_path("tok", "hr") == "/activate/hr/tok"


def test_the_default_profile_keeps_the_legacy_link() -> None:
    assert activation_path("tok") == "/activate/tok"
    assert activation_path("tok", "default") == activation_path("tok")


def test_the_stored_hash_is_bound_to_the_profile() -> None:
    assert hash_token("tok", "hr") != hash_token("tok", "sales")
    assert hash_token("tok", "default") != hash_token("tok")
    assert hash_token("tok", "hr") == hash_token("tok", "hr")


def test_a_token_only_matches_the_profile_it_was_minted_in() -> None:
    minted_in_hr = hash_token("tok", "hr")
    assert minted_in_hr in token_digests("tok", "hr")
    for other in ("default", "sales"):
        assert minted_in_hr not in token_digests("tok", other)


def test_legacy_v1_hashes_are_honoured_only_in_the_default_profile() -> None:
    legacy = hash_token("tok")
    assert legacy in token_digests("tok", "default")
    assert legacy not in token_digests("tok", "hr")


def _enrolment(name: str, *, active: bool = True) -> Enrolment:
    return Enrolment(
        profile=SimpleNamespace(name=name),
        principal=SimpleNamespace(active=active, role="member"),
    )


def test_a_reset_lands_in_the_hint_then_default_then_the_first_enrolment() -> None:
    both = [_enrolment("hr"), _enrolment("default")]
    assert pick_enrolment(both, "hr").profile.name == "hr"
    assert pick_enrolment(both, "").profile.name == "default"
    assert pick_enrolment(both, "sales").profile.name == "default"
    assert pick_enrolment([_enrolment("hr"), _enrolment("ops")], "").profile.name == "hr"


def test_a_suspended_enrolment_is_never_picked() -> None:
    found = [_enrolment("hr", active=False), _enrolment("ops")]
    assert pick_enrolment(found, "hr").profile.name == "ops"
    assert pick_enrolment([_enrolment("hr", active=False)], "hr") is None
