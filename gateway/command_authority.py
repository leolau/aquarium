"""Who may switch off safety checks from a chat (security review F7, F22).

Two sources of "this sender is an owner/admin", either is enough:

* the sender's Aquarium role (``hermes_cli.access``), when the gateway has
  a people database (``datastore.supabase_app.dsn``) — owner or admin;
* the operator's per-platform ``allow_admin_from`` list (``gateway/slash_access``).

When neither is configured (a single-person install with no roles at all),
every sender the gateway already lets in counts as trusted, same as before.
"""

from __future__ import annotations

import dataclasses
import logging
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

_ADMIN_ROLES = frozenset({"owner", "admin"})


@dataclass(frozen=True)
class SenderAuthority:
    is_admin: bool
    roles_configured: bool
    role: Optional[str] = None
    internal_user_id: Optional[str] = None

    @property
    def may_change_safety(self) -> bool:
        """May turn off approvals (``/yolo``, ``/approve always`` in a group, ...)."""
        return self.is_admin or not self.roles_configured


async def resolve_sender_authority(runner: Any, source: Any) -> SenderAuthority:
    """Resolve ``source``'s role without enrolling anyone. Fails closed."""
    from gateway.slash_access import policy_for_source

    policy = policy_for_source(getattr(runner, "config", None), source)
    listed_admin = bool(policy.enabled and policy.is_admin(getattr(source, "user_id", None)))

    role = getattr(source, "internal_user_role", None)
    internal_id = getattr(source, "internal_user_id", None)
    store = None
    getter = getattr(runner, "_get_principal_store", None)
    if callable(getter):
        try:
            store = getter()
        except Exception:
            logger.debug("principal store lookup failed", exc_info=True)
            store = None
    if store is not None and not internal_id:
        try:
            from hermes_cli.access import resolve_principal

            probe = dataclasses.replace(source) if dataclasses.is_dataclass(source) else source
            principal = await resolve_principal(
                probe, store=store, auto_enroll_if_paired=False
            )
        except Exception:
            logger.warning("Could not resolve the sender's role; treating as non-admin", exc_info=True)
            principal = None
        if principal is not None:
            role = principal.role
            internal_id = principal.user_id

    return SenderAuthority(
        is_admin=listed_admin or (internal_id is not None and role in _ADMIN_ROLES),
        roles_configured=store is not None or policy.enabled,
        role=role,
        internal_user_id=internal_id,
    )


def is_shared_session(runner: Any, source: Any) -> bool:
    """True when several people talk in this chat's session (threads, shared groups)."""
    from gateway.session import is_shared_multi_user_session

    config = getattr(runner, "config", None)
    return is_shared_multi_user_session(
        source,
        group_sessions_per_user=getattr(config, "group_sessions_per_user", True),
        thread_sessions_per_user=getattr(config, "thread_sessions_per_user", False),
    )


def safety_denied_message(what: str) -> str:
    return f"⛔ {what} is for an owner or admin only. Ask one of them if you need it."


def approval_refusal(runner: Any, source: Any, authority: SenderAuthority, *,
                     choice: str, none_owned: bool = False) -> Optional[str]:
    """Plain-words reason this sender cannot answer the pending approval, or None.

    ``none_owned`` = the resolver found nothing this sender may answer, while
    an approval is still pending (it was asked for by someone else).
    """
    if none_owned:
        return (
            "⛔ The command waiting for approval was asked for by someone else. "
            "Only that person or an owner/admin can approve or deny it."
        )
    if choice == "always" and is_shared_session(runner, source) and not authority.may_change_safety:
        return (
            "⛔ \"Always approve\" changes the rules for everyone in this chat, so it is "
            "for an owner or admin only. Reply /approve to allow it just this once."
        )
    return None
