"""One-time marker for profiles in use before the first-run steps (run by deploy-hermes.sh).

The /setup page offers the AI model, region and domain steps only on the very
first run. A profile that already has chats is not a first run: it gets
``auth/first_run_done.json`` written once, so a later ``hermes setup-link``
(e.g. to reset the owner's login) only sets the password, exactly as before.
A fresh install (no chats yet) is left alone.
"""

from __future__ import annotations

import sys

from hermes_cli.first_run_steps import done_path, is_done, mark_existing_install_done


def main() -> int:
    if is_done():
        print(f"{done_path()}: first run already marked done, kept")
    elif mark_existing_install_done():
        print(f"{done_path()}: profile already has chats; first-run steps turned off")
    return 0


if __name__ == "__main__":
    sys.exit(main())
