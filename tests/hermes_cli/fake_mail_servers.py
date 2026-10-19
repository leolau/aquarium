"""Local fake IMAP + SMTP servers (TLS, localhost) for mailbox tests.

Real sockets and real ``imaplib``/``smtplib`` clients: just enough of each
protocol for login, read-only INBOX listing and fetching, and AUTH. The
SMTP server records every command so tests can prove no mail was sent.
"""

from __future__ import annotations

import base64
import datetime as _dt
import re
import socket
import ssl
import threading
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


def make_cert(directory: Path) -> Tuple[Path, Path]:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = _dt.datetime.now(_dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - _dt.timedelta(minutes=5))
        .not_valid_after(now + _dt.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), True)
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = directory / "cert.pem", directory / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return cert_path, key_path


class _Server:
    def __init__(self, cert: Path, key: Path, *, implicit_tls: bool = True) -> None:
        self.server_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        self.server_ctx.load_cert_chain(str(cert), str(key))
        self.implicit_tls = implicit_tls
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.logins: List[Tuple[str, bool]] = []
        self._stop = False
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while not self._stop:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle_safe, args=(conn,), daemon=True).start()

    def _handle_safe(self, conn: socket.socket) -> None:
        try:
            if self.implicit_tls:
                conn = self.server_ctx.wrap_socket(conn, server_side=True)
            self.handle(conn)
        except (OSError, ssl.SSLError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def handle(self, conn) -> None:  # pragma: no cover - overridden
        raise NotImplementedError

    def close(self) -> None:
        self._stop = True
        self.sock.close()


def _readline(f) -> Optional[str]:
    line = f.readline()
    if not line:
        return None
    return line.decode("utf-8", "replace").rstrip("\r\n")


class FakeIMAP(_Server):
    """Accepts ``username``/``password``; serves ``messages`` (uid -> bytes)."""

    def __init__(self, cert, key, *, username, password, messages=None,
                 uidvalidity="7") -> None:
        self.username, self.password = username, password
        self.messages: Dict[int, bytes] = dict(messages or {})
        self.uidvalidity = uidvalidity
        self.commands: List[str] = []
        super().__init__(cert, key)

    def handle(self, conn) -> None:
        f = conn.makefile("rb")

        def send(text: str) -> None:
            conn.sendall(text.encode() + b"\r\n")

        send("* OK fake IMAP ready")
        while True:
            line = _readline(f)
            if line is None:
                return
            tag, _, rest = line.partition(" ")
            cmd, _, args = rest.partition(" ")
            cmd = cmd.upper()
            self.commands.append(cmd if cmd != "LOGIN" else "LOGIN")
            if cmd == "CAPABILITY":
                send("* CAPABILITY IMAP4rev1 AUTH=PLAIN")
                send(f"{tag} OK done")
            elif cmd == "LOGIN":
                parts = re.findall(r'"((?:[^"\\]|\\.)*)"|(\S+)', args)
                values = [a.replace('\\"', '"').replace("\\\\", "\\") or b for a, b in parts]
                ok = values[:2] == [self.username, self.password]
                self.logins.append((values[0] if values else "", ok))
                send(f"{tag} OK logged in" if ok else f"{tag} NO [AUTHENTICATIONFAILED] bad login")
            elif cmd in ("SELECT", "EXAMINE"):
                send(f"* {len(self.messages)} EXISTS")
                send(f"* OK [UIDVALIDITY {self.uidvalidity}] ok")
                send(f"{tag} OK [READ-ONLY] selected")
            elif cmd == "UID":
                sub, _, uargs = args.partition(" ")
                sub = sub.upper()
                self.commands.append(f"UID {sub}")
                if sub == "SEARCH":
                    uids = sorted(self.messages)
                    m = re.match(r"UID (\d+):\*", uargs)
                    if m:
                        uids = [u for u in uids if u >= int(m.group(1))]
                    send("* SEARCH " + " ".join(str(u) for u in uids) if uids else "* SEARCH")
                    send(f"{tag} OK search done")
                elif sub == "FETCH":
                    uid = int(uargs.split(" ", 1)[0])
                    body = self.messages.get(uid)
                    if body is not None:
                        conn.sendall(
                            f"* 1 FETCH (UID {uid} RFC822 {{{len(body)}}}\r\n".encode()
                            + body + b")\r\n"
                        )
                    send(f"{tag} OK fetch done")
                else:
                    send(f"{tag} BAD unsupported")
            elif cmd == "LOGOUT":
                send("* BYE")
                send(f"{tag} OK bye")
                return
            elif cmd == "NOOP":
                send(f"{tag} OK")
            else:
                send(f"{tag} BAD unsupported")


class FakeSMTP(_Server):
    """AUTH PLAIN/LOGIN against ``username``/``password``; logs commands."""

    def __init__(self, cert, key, *, username, password, implicit_tls=True) -> None:
        self.username, self.password = username, password
        self.commands: List[str] = []
        super().__init__(cert, key, implicit_tls=implicit_tls)

    def handle(self, conn) -> None:
        f = conn.makefile("rb")

        def send(text: str) -> None:
            conn.sendall(text.encode() + b"\r\n")

        send("220 fake ESMTP")
        tls = self.implicit_tls
        while True:
            line = _readline(f)
            if line is None:
                return
            verb = line.split(" ", 1)[0].upper()
            self.commands.append(verb)
            if verb in ("EHLO", "HELO"):
                if tls:
                    send("250-fake\r\n250 AUTH PLAIN LOGIN")
                else:
                    send("250-fake\r\n250 STARTTLS")
            elif verb == "STARTTLS":
                send("220 go ahead")
                conn = self.server_ctx.wrap_socket(conn, server_side=True)
                f = conn.makefile("rb")
                tls = True
            elif verb == "AUTH":
                parts = line.split(" ")
                ok = False
                if len(parts) == 3 and parts[1].upper() == "PLAIN":
                    try:
                        _, user, pw = base64.b64decode(parts[2]).decode().split("\0")
                        ok = (user, pw) == (self.username, self.password)
                        self.logins.append((user, ok))
                    except ValueError:
                        ok = False
                send("235 ok" if ok else "535 bad credentials")
            elif verb == "QUIT":
                send("221 bye")
                return
            else:
                # MAIL / RCPT / DATA would mean a message was being sent.
                send("250 ok")


def client_context(cert: Path) -> ssl.SSLContext:
    ctx = ssl.create_default_context(cafile=str(cert))
    return ctx


def rfc822(subject: str, sender: str = "Bob <bob@example.com>", msg_id: str = "m1@example.com") -> bytes:
    return (
        f"From: {sender}\r\nTo: alice@example.com\r\nSubject: {subject}\r\n"
        f"Message-ID: <{msg_id}>\r\nDate: Mon, 19 Oct 2026 10:00:00 +0000\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n\r\nHello there.\r\n"
    ).encode()
