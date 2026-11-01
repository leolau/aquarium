"""Read and send mail from the signed-in person's own IMAP/SMTP mailboxes.

The agent-side half of Settings -> Email mailboxes (``hermes_cli/email_mailboxes.py``),
mirroring what the Google Workspace skill offers for Gmail: list mailboxes,
search, read, send, reply, list folders and flag/move messages. The mailbox
password stays in the credential store (``email-imap`` entries are never
materialised into the terminal); this tool logs in in-process and only ever
acts for the person the tool call is bound to.
"""

from __future__ import annotations

import email
import email.utils
import imaplib
import json
import re
import smtplib
from email.message import EmailMessage
from typing import Any, Dict, List, Mapping, Optional

from tools.registry import registry

MAX_RESULTS = 50
MAX_BODY_CHARS = 20000
ACTIONS = ("list_mailboxes", "search", "read", "send", "reply", "folders", "modify")

SCHEMA = {
    "name": "email_mailbox",
    "description": (
        "Use the signed-in person's own email mailboxes added under Settings -> "
        "Email mailboxes (any IMAP/SMTP provider). Actions: list_mailboxes; "
        "search (IMAP search in a folder, newest first); read (one message by uid); "
        "send (new email via SMTP); reply (answer a message by uid, keeps the thread); "
        "folders; modify (mark read/unread, flag/unflag, move to a folder). "
        "Confirm recipients and content with the person before sending."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(ACTIONS)},
            "mailbox": {
                "type": "string",
                "description": "Mailbox address; optional when the person has exactly one.",
            },
            "folder": {"type": "string", "description": "IMAP folder (default INBOX)."},
            "query": {
                "type": "string",
                "description": "search: raw IMAP criteria, e.g. 'UNSEEN', 'FROM \"ada@x.com\"', 'SINCE 01-Oct-2026'. Default ALL.",
            },
            "limit": {"type": "integer", "description": f"search: max results (<= {MAX_RESULTS})."},
            "uid": {"type": "string", "description": "read/reply/modify: message UID from search."},
            "to": {"type": "array", "items": {"type": "string"}},
            "cc": {"type": "array", "items": {"type": "string"}},
            "bcc": {"type": "array", "items": {"type": "string"}},
            "subject": {"type": "string"},
            "body": {"type": "string", "description": "send/reply: plain-text body."},
            "html": {"type": "string", "description": "send/reply: optional HTML body."},
            "seen": {"type": "boolean", "description": "modify: mark read (true) or unread (false)."},
            "flagged": {"type": "boolean", "description": "modify: star (true) or unstar (false)."},
            "move_to": {"type": "string", "description": "modify: move the message to this folder."},
        },
        "required": ["action"],
    },
}


class MailboxToolError(Exception):
    pass


def _result(**data: Any) -> str:
    return json.dumps({"success": True, **data}, ensure_ascii=False, default=str)


def _error(message: str) -> str:
    return json.dumps({"success": False, "error": message}, ensure_ascii=False)


def _principal():
    from hermes_cli.access import Principal, normalize_role
    from tools.access_policy import current_principal

    user_id, role = current_principal()
    if not user_id:
        raise MailboxToolError("no signed-in person is bound to this request")
    return Principal(user_id=user_id, display=user_id, role=normalize_role(role))


async def _mailboxes() -> list:
    from hermes_cli import email_mailboxes as mb

    return await mb._own_entries(_principal())


def _pick(entries: list, address: Optional[str]):
    if not entries:
        raise MailboxToolError(
            "no email mailbox is set up; add one in Settings -> Email mailboxes"
        )
    if address:
        wanted = address.strip().lower()
        for entry in entries:
            if entry.name.lower() == wanted:
                return entry
        raise MailboxToolError("no mailbox with that address")
    if len(entries) > 1:
        raise MailboxToolError(
            "several mailboxes are set up; pass mailbox= one of "
            + ", ".join(e.name for e in entries)
        )
    return entries[0]


def _quote_folder(folder: str) -> str:
    return '"' + folder.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _decode(value: Optional[str]) -> str:
    if not value:
        return ""
    from email.header import decode_header, make_header

    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def _text_of(msg: email.message.Message) -> str:
    plain, html = [], []
    for part in msg.walk() if msg.is_multipart() else [msg]:
        if part.get_content_maintype() == "multipart" or part.get_filename():
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        text = payload.decode(part.get_content_charset() or "utf-8", "replace")
        (html if part.get_content_type() == "text/html" else plain).append(text)
    if plain:
        return "\n".join(plain)
    return re.sub(r"<[^>]+>", " ", "\n".join(html))


def _summary(uid: str, msg: email.message.Message) -> Dict[str, Any]:
    return {
        "uid": uid,
        "from": _decode(msg.get("From")),
        "to": _decode(msg.get("To")),
        "subject": _decode(msg.get("Subject")),
        "date": msg.get("Date", ""),
        "message_id": msg.get("Message-ID", ""),
    }


def _select(conn: imaplib.IMAP4, folder: str, readonly: bool) -> None:
    status, _ = conn.select(_quote_folder(folder), readonly=readonly)
    if status != "OK":
        raise MailboxToolError(f"cannot open folder {folder}")


def _fetch(conn: imaplib.IMAP4, uid: str, what: str = "(BODY.PEEK[])"):
    status, data = conn.uid("FETCH", uid, what)
    for item in data or []:
        if isinstance(item, tuple):
            return email.message_from_bytes(item[1])
    raise MailboxToolError(f"no message with uid {uid}")


def _with_imap(payload: Mapping[str, Any], fn):
    from hermes_cli import email_mailboxes as mb

    try:
        conn = mb.open_imap(payload)
    except Exception as exc:
        raise MailboxToolError(mb.plain_error(exc, payload.get("imap_host", ""))) from None
    try:
        return fn(conn)
    finally:
        try:
            conn.logout()
        except Exception:
            pass


def _smtp_send(payload: Mapping[str, Any], msg: EmailMessage) -> None:
    from hermes_cli import email_mailboxes as mb

    host, port = payload["smtp_host"], int(payload["smtp_port"])
    context = mb._ssl_context()
    try:
        if payload.get("smtp_security", "ssl") == "starttls":
            conn: smtplib.SMTP = smtplib.SMTP(host, port, timeout=mb.TIMEOUT_SECONDS)
            conn.ehlo()
            conn.starttls(context=context)
            conn.ehlo()
        else:
            conn = smtplib.SMTP_SSL(host, port, timeout=mb.TIMEOUT_SECONDS, context=context)
        try:
            conn.login(payload["username"], payload["password"])
            conn.send_message(msg)
        finally:
            try:
                conn.quit()
            except Exception:
                conn.close()
    except MailboxToolError:
        raise
    except Exception as exc:
        raise MailboxToolError(mb.plain_error(exc, host)) from None


def _addresses(value: Any) -> List[str]:
    if isinstance(value, str):
        value = [value]
    return [str(v).strip() for v in (value or []) if str(v).strip()]


def _compose(sender: str, args: Mapping[str, Any]) -> EmailMessage:
    to = _addresses(args.get("to"))
    if not to:
        raise MailboxToolError("to is required")
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = ", ".join(to)
    if _addresses(args.get("cc")):
        msg["Cc"] = ", ".join(_addresses(args.get("cc")))
    if _addresses(args.get("bcc")):
        msg["Bcc"] = ", ".join(_addresses(args.get("bcc")))
    msg["Subject"] = str(args.get("subject") or "")
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid(domain=sender.split("@")[-1])
    msg.set_content(str(args.get("body") or ""))
    if args.get("html"):
        msg.add_alternative(str(args["html"]), subtype="html")
    return msg


def _search(payload, args):
    folder = str(args.get("folder") or "INBOX")
    query = str(args.get("query") or "ALL").strip() or "ALL"
    limit = max(1, min(int(args.get("limit") or 20), MAX_RESULTS))

    def run(conn):
        _select(conn, folder, readonly=True)
        status, found = conn.uid("SEARCH", None, query)
        if status != "OK":
            raise MailboxToolError(f"search failed for: {query}")
        uids = (found[0].split() if found and found[0] else [])[-limit:][::-1]
        out = []
        for raw in uids:
            uid = raw.decode() if isinstance(raw, bytes) else str(raw)
            out.append(_summary(uid, _fetch(conn, uid, "(BODY.PEEK[HEADER])")))
        return out

    return _with_imap(payload, run)


def _read(payload, args):
    uid, folder = str(args.get("uid") or ""), str(args.get("folder") or "INBOX")
    if not uid:
        raise MailboxToolError("uid is required")

    def run(conn):
        _select(conn, folder, readonly=True)
        msg = _fetch(conn, uid)
        body = _text_of(msg)
        attachments = [p.get_filename() for p in msg.walk() if p.get_filename()]
        return {
            **_summary(uid, msg),
            "cc": _decode(msg.get("Cc")),
            "body": body[:MAX_BODY_CHARS],
            "truncated": len(body) > MAX_BODY_CHARS,
            "attachments": attachments,
        }

    return _with_imap(payload, run)


def _reply(entry, args):
    uid, folder = str(args.get("uid") or ""), str(args.get("folder") or "INBOX")
    if not uid:
        raise MailboxToolError("uid is required")

    def original(conn):
        _select(conn, folder, readonly=True)
        return _fetch(conn, uid, "(BODY.PEEK[HEADER])")

    orig = _with_imap(entry.payload, original)
    subject = _decode(orig.get("Subject"))
    reply_args = dict(args)
    reply_args.setdefault("to", [orig.get("Reply-To") or orig.get("From") or ""])
    if not args.get("subject"):
        reply_args["subject"] = subject if subject.lower().startswith("re:") else f"Re: {subject}"
    msg = _compose(entry.name, reply_args)
    if orig.get("Message-ID"):
        msg["In-Reply-To"] = orig["Message-ID"]
        msg["References"] = " ".join(
            x for x in (orig.get("References"), orig["Message-ID"]) if x
        )
    _smtp_send(entry.payload, msg)
    return {"sent": True, "to": msg["To"], "subject": msg["Subject"], "in_reply_to": orig.get("Message-ID", "")}


def _folders(payload):
    def run(conn):
        status, data = conn.list()
        names = []
        for line in data or []:
            text = line.decode(errors="replace") if isinstance(line, bytes) else str(line)
            match = re.search(r'"([^"]*)"\s*$|(\S+)\s*$', text)
            if match:
                names.append(match.group(1) if match.group(1) is not None else match.group(2))
        return names

    return _with_imap(payload, run)


def _modify(payload, args):
    uid, folder = str(args.get("uid") or ""), str(args.get("folder") or "INBOX")
    if not uid:
        raise MailboxToolError("uid is required")
    if args.get("seen") is None and args.get("flagged") is None and not args.get("move_to"):
        raise MailboxToolError("pass seen, flagged and/or move_to")

    def run(conn):
        _select(conn, folder, readonly=False)
        done = []
        for key, flag in (("seen", "\\Seen"), ("flagged", "\\Flagged")):
            if args.get(key) is not None:
                op = "+FLAGS" if args[key] else "-FLAGS"
                conn.uid("STORE", uid, op, f"({flag})")
                done.append(f"{op} {flag}")
        if args.get("move_to"):
            target = _quote_folder(str(args["move_to"]))
            status, _ = conn.uid("COPY", uid, target)
            if status != "OK":
                raise MailboxToolError(f"cannot move to {args['move_to']}")
            conn.uid("STORE", uid, "+FLAGS", "(\\Deleted)")
            conn.expunge()
            done.append(f"moved to {args['move_to']}")
        return done

    return {"uid": uid, "changes": _with_imap(payload, run)}


async def email_mailbox_tool(args: Mapping[str, Any], **_kw: Any) -> str:
    action = str(args.get("action") or "")
    if action not in ACTIONS:
        return _error(f"action must be one of {', '.join(ACTIONS)}")
    try:
        entries = await _mailboxes()
        if action == "list_mailboxes":
            return _result(mailboxes=[
                {"address": e.name, "imap_host": e.payload.get("imap_host"),
                 "smtp_host": e.payload.get("smtp_host")}
                for e in entries
            ])
        entry = _pick(entries, args.get("mailbox"))
        if action == "search":
            return _result(mailbox=entry.name, messages=_search(entry.payload, args))
        if action == "read":
            return _result(mailbox=entry.name, message=_read(entry.payload, args))
        if action == "send":
            msg = _compose(entry.name, args)
            _smtp_send(entry.payload, msg)
            return _result(mailbox=entry.name, sent=True, to=msg["To"], subject=msg["Subject"])
        if action == "reply":
            return _result(mailbox=entry.name, **_reply(entry, args))
        if action == "folders":
            return _result(mailbox=entry.name, folders=_folders(entry.payload))
        return _result(mailbox=entry.name, **_modify(entry.payload, args))
    except MailboxToolError as exc:
        return _error(str(exc))


registry.register(
    name="email_mailbox",
    toolset="email_mailbox",
    schema=SCHEMA,
    handler=email_mailbox_tool,
    is_async=True,
    emoji="📧",
)
