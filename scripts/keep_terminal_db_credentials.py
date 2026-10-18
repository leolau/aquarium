"""One-time switch for profiles created before F16 (run by deploy-hermes.sh).

Before F16 the agent's terminal always saw DATABASE_URL and the Supabase
service-role key, and chat features such as ``hermes promote`` rely on that.
A profile whose config.yaml does not mention
``security.terminal_database_credentials`` gets ``true`` written once, so it
keeps working; a profile with any explicit value is left alone.
"""

from __future__ import annotations

import sys

from hermes_cli.config import get_config_path, read_raw_config, set_config_value

KEY = "security.terminal_database_credentials"


def main() -> int:
    path = get_config_path()
    if not path.exists():
        return 0
    security = read_raw_config().get("security")
    if isinstance(security, dict) and "terminal_database_credentials" in security:
        print(f"{path}: {KEY} already set to {security['terminal_database_credentials']!r}, kept")
        return 0
    set_config_value(KEY, "true")
    print(f"{path}: {KEY} was unset; set to true so the agent keeps its database access (F16)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
