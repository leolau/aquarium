"""``hermes member`` — owner/admin management of additional brain members (C1).

Create a member (GoTrue account → enrolled principal), list members, change a
member's role, hand out an activation/reset link, and deactivate/reactivate an
enrolment. Runs on the box as the operator, acting as the enrolled **owner** —
the member-management authority (owner or admin) that
:func:`require_member_admin` requires. Ownership itself is managed separately by
``hermes owner``.

FG-26 moved password issuance off this surface: ``member add`` creates a banned
account with a random password and prints a one-time activation link the person
redeems themselves, and ``member invite`` regenerates that link when the short
window lapses. The operator never sees or relays a password.

The GoTrue base url comes from ``dashboard.supabase_auth`` / the ``SUPABASE_*``
env vars; the service-role key is read from the environment only (a credential).
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from hermes_cli.access import Principal, PrincipalStore, Role
from hermes_cli.console_scope import AccountLevelPermissionError
from hermes_cli.datastore import get_store
from hermes_cli.invitations import activation_path
from hermes_cli.members import (
    ADMIN_UNCONFIGURED_MESSAGE,
    ASSIGNABLE_ROLES,
    DELETE_STRATEGIES,
    MemberError,
    MemberService,
    administered_profile,
    link_member_channel,
    load_admin_client,
    unlink_member_channel,
)


#: What ``member delete`` does, in the words the operator reads before doing
#: it. Kept as a constant so a test can hold it to the behaviour: it said
#: "Nothing cascades to memories" for as long as purge had been erasing them.
DELETE_DESCRIPTION = (
    "Un-enrol a member from this profile. Nothing cascades to the rows they "
    "own, so a strategy is required: 'transfer' moves them to another "
    "principal, 'purge' deletes their private rows and moves the shared ones "
    "to you. Memory is not inheritable either way: their memory rows are "
    "deleted under both strategies, and 'purge' also erases the curated "
    "memory files about them (and their cross-profile identity file if this "
    "was their last participation on the box). Their box-wide account is "
    "left alone."
)


def _prod_store() -> PrincipalStore:
    return PrincipalStore(get_store("supabase-app", "prod"))


def _actor() -> Principal:
    """Resolve the enrolled owner to act as (the box operator's authority)."""
    store = _prod_store()
    owner = asyncio.run(store.get_owner())
    if owner is None:
        print(
            "No owner is enrolled; run 'hermes owner init <user_id>' first.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    return owner


def _service() -> MemberService:
    from hermes_cli.config import load_config

    admin = load_admin_client()
    if admin is None:
        print(ADMIN_UNCONFIGURED_MESSAGE, file=sys.stderr)
        raise SystemExit(1)
    return MemberService(_prod_store(), admin, config=load_config() or {})


def _print_activation_link(token: str, *, expires_at: str) -> None:
    """Print the one-time link, with the two facts that make it usable.

    Shown once (it is not recoverable — only its hash is stored) and with its
    expiry, because a link whose five minutes elapsed silently looks identical
    to a broken one.
    """
    print(f"Activation link (valid until {expires_at}, single use):")
    path = activation_path(token, administered_profile())
    print(f"  {path}")
    print(
        "Prefix it with your agent-home origin, e.g. "
        f"https://<your-agent-home>{path}"
    )


def member_list_command(args: argparse.Namespace) -> int:
    """Run ``hermes member list``."""
    try:
        service = _service()
        page = asyncio.run(
            service.list_members(
                _actor(), limit=args.limit, offset=args.offset, query=args.query
            )
        )
    except (MemberError, PermissionError, RuntimeError, ValueError) as error:
        print(f"Could not list members: {error}", file=sys.stderr)
        raise SystemExit(1) from error

    members = page.members
    if not members:
        print("No members enrolled.")
        return 0
    for m in members:
        status = "active" if m.enrolled else "SUSPENDED HERE"
        if m.enrolled and not m.active:
            status = "not activated"
        email = m.email or "(no email)"
        # Channels are the reason a member's inbound traffic resolves to this
        # principal at all, so show them: a member with none is one whose
        # messages still arrive as an unlinked raw handle.
        channels = ", ".join(m.channels) if m.channels else "no channels linked"
        print(
            f"{m.role:<6} {m.user_id}  {email}  "
            f"[{status}]  {m.display or ''}".rstrip()
        )
        print(f"       {channels}")
    shown = page.offset + len(members)
    if page.total > shown or page.offset:
        print(
            f"\nShowing {page.offset + 1}-{shown} of {page.total}. "
            f"Next page: --offset {shown}"
        )
    return 0


def member_add_command(args: argparse.Namespace) -> int:
    """Run ``hermes member add`` — enrol somebody into the active profile."""
    try:
        service = _service()
        role: Role = args.role
        created = asyncio.run(
            service.create_member(
                _actor(),
                email=args.email,
                profile=args.profile or administered_profile(),
                display=args.display,
                role=role,
            )
        )
    except (MemberError, PermissionError, RuntimeError, ValueError) as error:
        print(f"Could not create member: {error}", file=sys.stderr)
        raise SystemExit(1) from error

    if created.enrolled_existing:
        print(
            f"{created.email} already had an account; enrolled "
            f"{created.principal.user_id} into "
            f"{administered_profile()!r} as {created.principal.role}. "
            "Their existing password is unchanged."
        )
        return 0
    print(
        f"Created member {created.principal.user_id} ({created.email}) as "
        f"{created.principal.role}, banned until activation."
    )
    if created.invitation_token and created.invitation:
        _print_activation_link(
            created.invitation_token,
            expires_at=created.invitation.expires_at.isoformat(),
        )
    return 0


def member_invite_command(args: argparse.Namespace) -> int:
    """Run ``hermes member invite`` — mint a fresh one-time activation link."""
    try:
        service = _service()
        invitation, token = asyncio.run(
            service.issue_invitation(_actor(), user_id=args.user_id)
        )
    except (
        AccountLevelPermissionError,
        MemberError,
        PermissionError,
        RuntimeError,
        ValueError,
    ) as error:
        print(f"Could not issue an invitation: {error}", file=sys.stderr)
        raise SystemExit(1) from error

    print(f"Issued an invitation for {args.user_id} (earlier links revoked).")
    _print_activation_link(token, expires_at=invitation.expires_at.isoformat())
    return 0


def member_delete_command(args: argparse.Namespace) -> int:
    """Run ``hermes member delete`` — un-enrol and resolve owned rows."""
    try:
        service = _service()
        deleted = asyncio.run(
            service.delete_member(
                _actor(),
                user_id=args.user_id,
                strategy=args.strategy,
                transfer_to=args.transfer_to,
            )
        )
    except (MemberError, PermissionError, RuntimeError, ValueError) as error:
        print(f"Could not delete member: {error}", file=sys.stderr)
        raise SystemExit(1) from error

    outcome = deleted.ownership
    print(
        f"Removed {deleted.user_id} from this profile "
        f"(strategy={outcome.strategy}): {outcome.rows_transferred} rows "
        f"transferred, {outcome.rows_deleted} deleted."
    )
    for path in deleted.memory_files_erased:
        print(f"Erased curated memory: {path}")
    if outcome.strategy == "transfer" and not deleted.memory_files_erased:
        print(
            "Their curated memory files were left in place — transfer moves "
            "what they owned, and memory about a person is not inheritable."
        )
    print(
        "Their box-wide account still exists — accounts are shared across "
        "profiles, so removing it here does not sign them out elsewhere."
    )
    return 0


def member_set_role_command(args: argparse.Namespace) -> int:
    """Run ``hermes member set-role``."""
    try:
        service = _service()
        role: Role = args.role
        principal = asyncio.run(
            service.set_member_role(_actor(), user_id=args.user_id, role=role)
        )
    except (MemberError, PermissionError, RuntimeError, ValueError) as error:
        print(f"Could not change role: {error}", file=sys.stderr)
        raise SystemExit(1) from error

    print(f"{principal.user_id} is now {principal.role}.")
    return 0


def member_link_channel_command(args: argparse.Namespace) -> int:
    """Run ``hermes member link-channel`` — map a channel handle to a member."""
    try:
        principal = asyncio.run(
            link_member_channel(
                _prod_store(),
                _actor(),
                user_id=args.user_id,
                platform=args.platform,
                channel_user_id=args.channel_user_id,
            )
        )
    except (MemberError, PermissionError, RuntimeError, ValueError) as error:
        print(f"Could not link the channel: {error}", file=sys.stderr)
        raise SystemExit(1) from error

    print(
        f"{args.platform}:{args.channel_user_id} now resolves to "
        f"{principal.user_id} ({principal.role})."
    )
    print(f"Linked channels: {', '.join(principal.channels) or 'none'}")
    return 0


def member_unlink_channel_command(args: argparse.Namespace) -> int:
    """Run ``hermes member unlink-channel`` — detach a channel handle from a member."""
    try:
        principal = asyncio.run(
            unlink_member_channel(
                _prod_store(),
                _actor(),
                user_id=args.user_id,
                platform=args.platform,
                channel_user_id=args.channel_user_id,
            )
        )
    except (MemberError, PermissionError, RuntimeError, ValueError) as error:
        print(f"Could not unlink the channel: {error}", file=sys.stderr)
        raise SystemExit(1) from error

    print(f"{args.platform}:{args.channel_user_id} no longer resolves to {principal.user_id}.")
    print(f"Linked channels: {', '.join(principal.channels) or 'none'}")
    return 0


def member_deactivate_command(args: argparse.Namespace) -> int:
    """Run ``hermes member deactivate`` — suspend the enrolment in this profile."""
    return _set_active(args.user_id, active=False)


def member_activate_command(args: argparse.Namespace) -> int:
    """Run ``hermes member activate`` — restore a suspended enrolment."""
    return _set_active(args.user_id, active=True)


def _set_active(user_id: str, *, active: bool) -> int:
    try:
        service = _service()
        asyncio.run(
            service.set_member_active(_actor(), user_id=user_id, active=active)
        )
    except (MemberError, PermissionError, RuntimeError, ValueError) as error:
        verb = "reactivate" if active else "deactivate"
        print(f"Could not {verb} member: {error}", file=sys.stderr)
        raise SystemExit(1) from error

    print(f"{user_id} is now {'active' if active else 'deactivated'}.")
    return 0


def member_local_principal_command(args: argparse.Namespace) -> int:
    """Run ``hermes member local-principal`` — whose memory local sessions write.

    Sessions that arrive without a channel identity (the CLI, cron jobs, the
    digest, the pollers) have no sender for C1 to resolve, so FG-24 resolves the
    person they act as: a remembered binding, else the login subject, else the
    only enrolled principal, else this command.
    """
    from hermes_cli.principal_binding import (
        binding_path,
        forget_binding,
        read_binding,
        remember_binding,
    )

    if args.clear:
        if forget_binding():
            print("Cleared the local principal binding.")
        else:
            print("No local principal binding was set.")
        return 0

    if args.set:
        try:
            store = _prod_store()
            principal = asyncio.run(store.get(args.set))
        except (RuntimeError, ValueError) as error:
            print(f"Could not read the principal: {error}", file=sys.stderr)
            raise SystemExit(1) from error
        if principal is None:
            print(
                f"No enrolled principal {args.set!r}; 'hermes member list' "
                "shows who is enrolled.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        binding = remember_binding(principal.user_id, principal.role, "asked")
        print(
            f"Local sessions in this profile now act as {binding.user_id} "
            f"({binding.role})."
        )
        return 0

    binding = read_binding()
    if binding is None:
        print(
            "No local principal binding is set. Hermes resolves one per "
            "session (login subject, else the only enrolled principal, else it "
            "asks); set one explicitly with --set <user_id>."
        )
        return 0
    print(f"Local sessions act as {binding.user_id} ({binding.role})")
    print(f"Resolved by: {binding.source}")
    print(f"Stored in:   {binding_path()}")
    return 0


def register_member_subparser(subparsers: argparse._SubParsersAction) -> None:
    """Register ``hermes member`` and its sub-actions."""
    parser = subparsers.add_parser(
        "member",
        help="Create and manage additional brain members (owner/admin)",
        description=(
            "Owner/admin management of additional members of the shared "
            "Hermes brain: create a Supabase account and enrol it as a "
            "principal, list members, change roles, issue one-time "
            "activation links, and suspend/restore an enrolment. Ownership "
            "itself is managed with 'hermes owner'."
        ),
    )
    member_sub = parser.add_subparsers(dest="member_command", required=True)

    lst = member_sub.add_parser("list", help="List enrolled members")
    lst.add_argument(
        "--limit", type=int, default=25, help="Page size (default: 25)"
    )
    lst.add_argument("--offset", type=int, default=0, help="Rows to skip")
    lst.add_argument(
        "--query",
        default=None,
        help="Filter by display name or principal id (case-insensitive)",
    )
    lst.set_defaults(func=member_list_command)

    add = member_sub.add_parser(
        "add",
        help="Create a member account and enrol it as a principal",
    )
    add.add_argument("email", help="The new member's email (their login)")
    add.add_argument(
        "--role",
        default="member",
        choices=list(ASSIGNABLE_ROLES),
        help="Role to enrol the member with (default: member)",
    )
    add.add_argument("--display", default="", help="Display name")
    add.add_argument(
        "--profile",
        default=None,
        help=(
            "Profile to enrol into (defaults to the active profile; naming "
            "another profile is refused — cross-profile assignment is FG-28)"
        ),
    )
    add.set_defaults(func=member_add_command)

    invite = member_sub.add_parser(
        "invite",
        help="Issue a fresh one-time activation link (revokes earlier links)",
        description=(
            "Mint a single-use, short-lived activation link for an enrolled "
            "member and print it once. Use this when the previous link "
            "expired: minting a new one revokes the old one, so a link that "
            "leaked cannot be redeemed afterwards."
        ),
    )
    invite.add_argument("user_id", help="The member's principal id")
    invite.set_defaults(func=member_invite_command)

    delete = member_sub.add_parser(
        "delete",
        help="Remove an enrolment, transferring or purging the rows it owns",
        description=DELETE_DESCRIPTION,
    )
    delete.add_argument("user_id", help="The member's principal id")
    delete.add_argument(
        "--strategy", required=True, choices=list(DELETE_STRATEGIES)
    )
    delete.add_argument(
        "--transfer-to",
        dest="transfer_to",
        default=None,
        help="Principal inheriting the rows (required with --strategy transfer)",
    )
    delete.set_defaults(func=member_delete_command)

    set_role = member_sub.add_parser(
        "set-role",
        help="Change a member's role (never the owner; never to owner)",
    )
    set_role.add_argument("user_id", help="The member's principal id")
    set_role.add_argument("role", choices=list(ASSIGNABLE_ROLES))
    set_role.set_defaults(func=member_set_role_command)

    link_channel = member_sub.add_parser(
        "link-channel",
        help="Map an inbound channel handle onto an enrolled member",
        description=(
            "State that messages from (platform, channel_user_id) belong to "
            "this principal, so the session resolves to that member's "
            "identity and role instead of the raw channel handle. Needed for "
            "anyone authorised by an allow-list rather than by pairing, since "
            "only pairing auto-enrols."
        ),
    )
    link_channel.add_argument("user_id", help="The member's principal id")
    link_channel.add_argument(
        "platform", help="Gateway platform name (e.g. telegram, discord, slack)"
    )
    link_channel.add_argument(
        "channel_user_id",
        help="The platform-native sender id (e.g. a Telegram numeric user id)",
    )
    link_channel.set_defaults(func=member_link_channel_command)

    unlink_channel = member_sub.add_parser(
        "unlink-channel",
        help="Detach an inbound channel handle from a member",
        description=(
            "Undo link-channel: messages from (platform, channel_user_id) go "
            "back to resolving as the raw channel handle. The member and "
            "their data are untouched."
        ),
    )
    unlink_channel.add_argument("user_id", help="The member's principal id")
    unlink_channel.add_argument("platform", help="Gateway platform name (e.g. telegram)")
    unlink_channel.add_argument("channel_user_id", help="The platform-native sender id")
    unlink_channel.set_defaults(func=member_unlink_channel_command)

    deactivate = member_sub.add_parser(
        "deactivate",
        help="Suspend a member's enrolment in this profile",
        description=(
            "Suspend the enrolment, not the account: the person keeps their "
            "login and their access to any other profile they belong to, and "
            "their rows keep a resolvable owner. Reversible with 'activate'."
        ),
    )
    deactivate.add_argument("user_id", help="The member's principal id")
    deactivate.set_defaults(func=member_deactivate_command)

    activate = member_sub.add_parser(
        "activate",
        help="Restore a suspended enrolment",
    )
    activate.add_argument("user_id", help="The member's principal id")
    activate.set_defaults(func=member_activate_command)

    local_principal = member_sub.add_parser(
        "local-principal",
        help="Show/set which person channel-less sessions act as (FG-24)",
        description=(
            "Sessions with no channel identity — the local CLI, cron jobs, the "
            "digest, the email poller — have no sender to resolve, so Hermes "
            "resolves the person they act as: a remembered binding, else the "
            "login subject, else the only enrolled principal, else it asks "
            "once and remembers. Use this to see, set or clear that answer. "
            "With several people enrolled and no binding, memory writes are "
            "refused rather than landing in the profile's shared block."
        ),
    )
    local_principal.add_argument(
        "--set",
        metavar="USER_ID",
        default=None,
        help="Bind local sessions to this enrolled principal",
    )
    local_principal.add_argument(
        "--clear",
        action="store_true",
        help="Forget the binding (it will be resolved again next session)",
    )
    local_principal.set_defaults(func=member_local_principal_command)
