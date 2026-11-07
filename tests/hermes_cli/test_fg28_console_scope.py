"""FG-28 console scope — the per-request chokepoint, unit-tested.

These exercise the fastapi-free core (:mod:`hermes_cli.console_scope`) with a
synthetic :class:`PrincipalStore`, so the security properties hold without a
live Supabase. The real-Postgres negative matrix is the FG-28 E2E on the box
(item 10); here we assert the *invariants* the chokepoint must satisfy
regardless of the store: authority re-derived in the target profile's scope,
owner-fallback refused, the picker never a grant.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from hermes_cli.access import Principal
from hermes_cli.console_scope import (
    AccountLevelPermissionError,
    OwnerFallbackRefused,
    ProfileScopeError,
    administered_profiles,
    enrolled_profiles,
    guard_account_level_op,
    person_enrolments,
    resolve_console_principal,
)
from hermes_cli.profile_registry import ProfileRegistryEntry

# The caller's GoTrue subject — one shared account, enrolled per-profile.
SUBJECT = "cto-sub-123"
OTHER_SUBJECT = "cfo-sub-456"


class _FakeStore:
    """Synthetic PrincipalStore answering from a ``{user_id: Principal}`` map."""

    def __init__(self, principals: dict[str, Principal]) -> None:
        self._principals = principals

    async def get(self, user_id: str) -> Principal | None:
        return self._principals.get(user_id)

    async def get_owner(self) -> Principal | None:
        return next(
            (p for p in self._principals.values() if p.role == "owner"), None
        )

    async def resolve_alias(self, subject: str) -> str | None:
        # No alias table in the test — the subject IS the user_id.
        return None


def _entry(name: str, home: Path) -> ProfileRegistryEntry:
    return ProfileRegistryEntry(
        name=name,
        hermes_home=home,
        is_default=(name == "default"),
        served=True,
        base_url="" if name == "default" else f"/p/{name}/",
        schema="app_prod" if name == "default" else f"app_prod_{name}",
        has_env=False,
        gateway_running=False,
    )


def _store_factory(per_home: dict[Path, _FakeStore]):
    """A StoreFactory that picks the synthetic store by home path."""

    def _build(home: Path) -> _FakeStore:
        return per_home.get(home, _FakeStore({}))

    return _build


@pytest.fixture
def two_profiles(
    tmp_path: Path,
) -> tuple[list[ProfileRegistryEntry], dict[Path, _FakeStore]]:
    """A default + engineers + hr registry with per-profile synthetic stores.

    CTO (SUBJECT) is owner of default, admin of engineers, and NOT enrolled
    in hr. CFO (OTHER_SUBJECT) is admin of hr only. That is the FG-28 motif:
    one shared account, several per-profile enrolments, separate authority.
    """
    root = tmp_path / "hermes-root"
    engineers_home = root / "profiles" / "engineers"
    hr_home = root / "profiles" / "hr"
    for home in (root, engineers_home, hr_home):
        home.mkdir(parents=True, exist_ok=True)

    entries = [
        _entry("default", root),
        _entry("engineers", engineers_home),
        _entry("hr", hr_home),
    ]
    per_home = {
        root: _FakeStore({SUBJECT: Principal(SUBJECT, "CTO", "owner")}),
        engineers_home: _FakeStore({SUBJECT: Principal(SUBJECT, "CTO", "admin")}),
        hr_home: _FakeStore({OTHER_SUBJECT: Principal(OTHER_SUBJECT, "CFO", "admin")}),
    }
    return entries, per_home


def test_administered_profiles_lists_only_where_caller_is_admin_or_owner(
    two_profiles,
) -> None:
    entries, per_home = two_profiles
    factory = _store_factory(per_home)
    # CTO administers default (owner) and engineers (admin), but not hr (not
    # enrolled there at all). CFO administers hr only.
    cto = asyncio.run(administered_profiles(SUBJECT, store_factory=factory, registry=entries))
    assert cto == ["default", "engineers"]
    cfo = asyncio.run(administered_profiles(OTHER_SUBJECT, store_factory=factory, registry=entries))
    assert cfo == ["hr"]


def test_administered_profiles_empty_subject_returns_nothing(two_profiles) -> None:
    entries, per_home = two_profiles
    assert asyncio.run(
        administered_profiles("", store_factory=_store_factory(per_home), registry=entries)
    ) == []


def test_resolve_console_principal_re_derives_in_target_scope(two_profiles) -> None:
    entries, per_home = two_profiles
    factory = _store_factory(per_home)
    # CTO is enrolled in engineers as admin — resolving there returns that
    # principal (re-derived from engineers' own principals, not default's).
    principal = asyncio.run(
        resolve_console_principal(SUBJECT, "engineers", store_factory=factory, registry=entries)
    )
    assert principal.user_id == SUBJECT
    assert principal.role == "admin"


def test_resolve_console_principal_refuses_owner_fallback(two_profiles) -> None:
    # The hole FG-28 closes: a console-routed request with no verified
    # subject must NOT fall back to the enrolled owner. It raises, and the
    # web_server maps that to 401.
    entries, per_home = two_profiles
    factory = _store_factory(per_home)
    with pytest.raises(OwnerFallbackRefused):
        asyncio.run(
            resolve_console_principal("", "engineers", store_factory=factory, registry=entries)
        )


def test_resolve_console_principal_refuses_caller_not_enrolled_in_target(
    two_profiles,
) -> None:
    # The picker is not a grant: CTO holds no row in hr, so scoping a turn
    # there is refused — even if the console offered the profile by mistake.
    entries, per_home = two_profiles
    factory = _store_factory(per_home)
    with pytest.raises(ProfileScopeError):
        asyncio.run(
            resolve_console_principal(SUBJECT, "hr", store_factory=factory, registry=entries)
        )


def test_resolve_console_principal_refuses_suspended_enrolment(two_profiles) -> None:
    entries, per_home = two_profiles
    # A suspended enrolment is a 403 (FG-26 §3.5 profile-local suspension),
    # not a silent fall-through to the owner.
    engineers_home = entries[1].hermes_home
    per_home = dict(per_home)
    per_home[engineers_home] = _FakeStore(
        {SUBJECT: Principal(SUBJECT, "CTO", "admin", active=False)}
    )
    factory = _store_factory(per_home)
    with pytest.raises(ProfileScopeError):
        asyncio.run(
            resolve_console_principal(SUBJECT, "engineers", store_factory=factory, registry=entries)
        )


def test_resolve_console_principal_refuses_unknown_target(two_profiles) -> None:
    entries, per_home = two_profiles
    factory = _store_factory(per_home)
    with pytest.raises(ProfileScopeError):
        asyncio.run(
            resolve_console_principal(
                SUBJECT, "nonexistent", store_factory=factory, registry=entries
            )
        )


# -- account-level verb guard (item 8) ------------------------------------


@pytest.fixture
def target_in_two_profiles(
    tmp_path: Path,
) -> tuple[list[ProfileRegistryEntry], dict[Path, _FakeStore]]:
    """Mary is enrolled (member) in engineers AND hr — the cross-profile case.

    CTO administers default + engineers; CFO administers hr. An account-level
    op on Mary affects both engineers and hr, so neither a lone CTO-admin nor
    a lone CFO-admin may perform it — only an owner, or an admin of *both*
    profiles Mary is in (nobody here is). This is the hr-admin-bans-an-
    engineers-account escalation the guard refuses.
    """
    root = tmp_path / "hermes-root"
    engineers_home = root / "profiles" / "engineers"
    hr_home = root / "profiles" / "hr"
    for home in (root, engineers_home, hr_home):
        home.mkdir(parents=True, exist_ok=True)
    entries = [
        _entry("default", root),
        _entry("engineers", engineers_home),
        _entry("hr", hr_home),
    ]
    per_home = {
        root: _FakeStore({SUBJECT: Principal(SUBJECT, "CTO", "owner")}),
        engineers_home: _FakeStore({
            SUBJECT: Principal(SUBJECT, "CTO", "admin"),
            "mary": Principal("mary", "Mary", "member"),
        }),
        hr_home: _FakeStore({
            OTHER_SUBJECT: Principal(OTHER_SUBJECT, "CFO", "admin"),
            "mary": Principal("mary", "Mary", "member"),
        }),
    }
    return entries, per_home


def test_enrolled_profiles_lists_every_profile_the_target_is_in(
    target_in_two_profiles,
) -> None:
    entries, per_home = target_in_two_profiles
    factory = _store_factory(per_home)
    # Mary is enrolled in engineers + hr (the blast radius of an account op).
    assert asyncio.run(enrolled_profiles("mary", store_factory=factory, registry=entries)) == [
        "engineers",
        "hr",
    ]


def test_guard_refuses_an_owner_whose_ownership_is_profile_local(
    target_in_two_profiles,
) -> None:
    entries, per_home = target_in_two_profiles
    factory = _store_factory(per_home)
    # ``owner`` is a per-profile role: every profile has one. CTO owns default
    # and administers engineers but holds nothing in hr, so banning Mary — who
    # is in hr too — reaches past their authority. The role must not exempt
    # them from the blast-radius check, or the hole reopens through the role
    # most likely to hold it.
    actor = Principal(SUBJECT, "CTO", "owner")
    with pytest.raises(AccountLevelPermissionError) as excinfo:
        asyncio.run(
            guard_account_level_op(actor, "mary", store_factory=factory, registry=entries)
        )
    assert "hr" in str(excinfo.value)


def test_guard_allows_an_owner_enrolled_everywhere_the_target_is(
    target_in_two_profiles,
) -> None:
    entries, per_home = target_in_two_profiles
    per_home = dict(per_home)
    hr_home = entries[2].hermes_home
    # A box-wide owner: enrolled with authority in hr as well, so nothing Mary
    # is in falls outside it. Passes on the same condition as any other actor.
    per_home[hr_home] = _FakeStore({
        SUBJECT: Principal(SUBJECT, "CTO", "owner"),
        "mary": Principal("mary", "Mary", "member"),
    })
    actor = Principal(SUBJECT, "CTO", "owner")
    asyncio.run(
        guard_account_level_op(
            actor, "mary", store_factory=_store_factory(per_home), registry=entries
        )
    )


def test_guard_refuses_admin_when_target_spills_outside_administered_set(
    target_in_two_profiles,
) -> None:
    entries, per_home = target_in_two_profiles
    factory = _store_factory(per_home)
    # CTO-admin administers default + engineers, but Mary is also in hr —
    # banning Mary would revoke her access in hr, a profile CTO cannot
    # administer. Refused (the cross-profile escalation).
    actor = Principal(SUBJECT, "CTO", "admin")
    with pytest.raises(AccountLevelPermissionError) as excinfo:
        asyncio.run(
            guard_account_level_op(actor, "mary", store_factory=factory, registry=entries)
        )
    assert "hr" in str(excinfo.value)


def test_guard_allows_when_target_solely_in_administered_profiles(
    target_in_two_profiles,
) -> None:
    entries, per_home = target_in_two_profiles
    factory = _store_factory(per_home)
    # CFO administers hr; a target enrolled ONLY in hr is within that authority.
    # (Mary is in engineers+hr here, so this must refuse — and a target in hr
    # alone must allow. Swap Mary out of engineers to get the allow case.)
    engineers_home = entries[1].hermes_home
    per_home = dict(per_home)
    per_home[engineers_home] = _FakeStore({SUBJECT: Principal(SUBJECT, "CTO", "admin")})
    factory = _store_factory(per_home)
    actor = Principal(OTHER_SUBJECT, "CFO", "admin")
    # Now Mary is in hr only; CFO administers hr → allow.
    asyncio.run(
        guard_account_level_op(actor, "mary", store_factory=factory, registry=entries)
    )


def test_guard_counts_a_suspended_enrolment_as_blast_radius(
    target_in_two_profiles,
) -> None:
    entries, per_home = target_in_two_profiles
    per_home = dict(per_home)
    hr_home = entries[2].hermes_home
    # Mary is suspended in hr — a reversible, profile-local un-enrol hr's own
    # admin can lift. Banning the box-wide account takes that decision away
    # from them, so the suspended row still counts against the actor's reach.
    per_home[hr_home] = _FakeStore({
        OTHER_SUBJECT: Principal(OTHER_SUBJECT, "CFO", "admin"),
        "mary": Principal("mary", "Mary", "member", active=False),
    })
    actor = Principal(SUBJECT, "CTO", "admin")
    with pytest.raises(AccountLevelPermissionError) as excinfo:
        asyncio.run(
            guard_account_level_op(
                actor, "mary", store_factory=_store_factory(per_home), registry=entries
            )
        )
    assert "hr" in str(excinfo.value)


def test_guard_allows_vacuously_when_target_enrolled_nowhere(
    target_in_two_profiles,
) -> None:
    entries, per_home = target_in_two_profiles
    factory = _store_factory(per_home)
    # A target with no enrolments has no blast radius — a rollback/redemption
    # on such an account must not be blocked by the guard.
    actor = Principal(SUBJECT, "CTO", "admin")
    asyncio.run(
        guard_account_level_op(actor, "ghost", store_factory=factory, registry=entries)
    )


# -- person_enrolments: the Users screen's per-person "Profiles & roles" read --


@pytest.fixture
def people_box(tmp_path: Path):
    """``default`` (CTO admin), ``hr`` (CTO suspended admin), ``engineers``
    (CTO member), ``testers`` (CTO owner); the target ``pat`` is enrolled in
    default, hr and engineers but not testers."""
    homes = {n: tmp_path / n for n in ("default", "hr", "engineers", "testers")}
    for home in homes.values():
        home.mkdir()
    stores = {
        homes["default"]: _FakeStore(
            {
                SUBJECT: Principal(user_id=SUBJECT, display="CTO", role="admin"),
                "pat": Principal(user_id="pat", display="Pat", role="member"),
            }
        ),
        homes["hr"]: _FakeStore(
            {
                SUBJECT: Principal(
                    user_id=SUBJECT, display="CTO", role="admin", active=False
                ),
                "pat": Principal(user_id="pat", display="Pat", role="admin"),
            }
        ),
        homes["engineers"]: _FakeStore(
            {
                SUBJECT: Principal(user_id=SUBJECT, display="CTO", role="member"),
                "pat": Principal(user_id="pat", display="Pat", role="viewer"),
            }
        ),
        homes["testers"]: _FakeStore(
            {SUBJECT: Principal(user_id=SUBJECT, display="CTO", role="owner")}
        ),
    }
    registry = [_entry(n, h) for n, h in homes.items()]
    return registry, stores


def test_person_enrolments_lists_only_profiles_the_actor_administers(
    people_box,
) -> None:
    registry, stores = people_box
    rows = asyncio.run(
        person_enrolments(
            SUBJECT, "pat", store_factory=_store_factory(stores), registry=registry
        )
    )
    # hr (suspended admin) and engineers (member) are not the actor's to
    # administer, so pat's enrolment there is not even read.
    assert [r.profile.name for r in rows] == ["default", "testers"]
    by_name = {r.profile.name: r for r in rows}
    assert by_name["default"].principal.role == "member"
    assert by_name["default"].actor_role == "admin"
    assert by_name["testers"].principal is None
    assert by_name["testers"].actor_role == "owner"


def test_person_enrolments_never_reads_the_target_outside_administered_profiles(
    people_box,
) -> None:
    registry, stores = people_box
    looked_up: list[tuple[str, str]] = []
    for home, store in stores.items():
        original = store.get

        async def _spy(user_id, _orig=original, _home=home):
            looked_up.append((_home.name, user_id))
            return await _orig(user_id)

        store.get = _spy  # type: ignore[method-assign]
    asyncio.run(
        person_enrolments(
            SUBJECT, "pat", store_factory=_store_factory(stores), registry=registry
        )
    )
    assert ("hr", "pat") not in looked_up
    assert ("engineers", "pat") not in looked_up


def test_person_enrolments_without_a_subject_is_empty(people_box) -> None:
    registry, stores = people_box
    rows = asyncio.run(
        person_enrolments(
            "", "pat", store_factory=_store_factory(stores), registry=registry
        )
    )
    assert rows == []


def test_person_enrolments_for_a_member_everywhere_is_empty(people_box) -> None:
    registry, stores = people_box
    rows = asyncio.run(
        person_enrolments(
            "pat", SUBJECT, store_factory=_store_factory(stores), registry=registry
        )
    )
    # pat is an active admin only in hr — and is listed there alone.
    assert [r.profile.name for r in rows] == ["hr"]
