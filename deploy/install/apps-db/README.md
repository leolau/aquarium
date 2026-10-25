# Apps database clusters (FG-33 P8-1 item 1.3)

Local vibe-coded apps never get a database on Aquarium's own `supabase-db`. They live on two
dedicated Postgres instances started from `docker-compose.yml` here (pinned Supabase Postgres image):

| target | container | host port (loopback) | holds |
|---|---|---|---|
| `prod` | `supabase-apps-db` | 54330 | every app's `lapp_<id>_prod` |
| `dev` (decision 18) | `supabase-apps-dev-db` | 54331 | every app's `lapp_<id>_dev`, all dev testing |

Names, ports, memory, connection limits and the storage base path (`APPS_BASE`, decision 21) are
keys in `/etc/aquarium/aquarium.conf` (`APPS_*`, see `DEFAULTS` in `deploy/aquarium.py`).

## Commands (root only, `/usr/local/sbin/aquarium`)

    aquarium apps cluster up|status|down <prod|dev|all>
    aquarium apps db create|migrate|status|suspend|resume|drop|archive|restore <slug> <prod|dev>

The `apps db` argv is exactly what the sudoers file from item 1.2 allows the service user to run.
Anything else the verb needs arrives as one JSON object on **stdin** (never argv, so nothing leaks
into `ps` or the sudo log):

| key | used by | meaning |
|---|---|---|
| `approval_ref` | every `prod` verb except `status` | id of an `approved` row in `<APPS_APPROVALS_SCHEMA>.approvals` with `target_ref = 'tool:<slug>'`, at most 24 h old; one use per verb |
| `migrations` | `migrate` | `[{"name": "<digits>_<name>.sql", "sql": "..."}]`, the app's `supabase/migrations/*.sql` at the promoted SHA |
| `confirm` | `drop` | must equal the slug: the explicit confirmation before irreversible data loss (decision 9) |
| `backup_ref` | `restore` | the path `archive` returned; only an `archive` copy of this database in `<APPS_BASE>/db-backups/` is accepted |

Each verb prints exactly one JSON line (`{"ok": true, ...}` or `{"ok": false, "error": ..., "fix": ...}`).

## What `create` makes

* database `lapp_<id>_<mode>` (`<id>` = slug with `-`→`_` plus an 8-hex hash of the slug), from
  `template0`, `CONNECT` revoked from `PUBLIC`, `pgcrypto` + `uuid-ossp` in schema `extensions`;
* roles `<db>_owner` (DDL; runs migrations), `<db>_rw` (runtime DML), `<db>_ro` (read-only), all
  `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, each with a `CONNECTION LIMIT`,
  `statement_timeout` and `idle_in_transaction_session_timeout`;
* DSNs `/etc/aquarium/apps/<slug>/db-<mode>-{rw,ro,owner}.dsn` (dir 0700, files 0600, root) for
  `LoadCredential=`; they only ever point at the apps cluster, never at Aquarium's database.

`migrate` applies pending migrations in order as the owner role, each in one transaction; a
migration whose text changed after it was applied is refused. In `prod` a `pg_dump` is taken first
(`<APPS_BASE>/db-backups/`). `suspend` sets `CONNECTION LIMIT 0` and ends sessions; `resume`
restores the limits. `drop` dumps, then drops the database, its roles and its DSN files.

`archive` (used by `hermes tool archive` and the 90-day watch) dumps the database to
`<APPS_BASE>/db-backups/<db>-<utc>-archive.dump` (dir 0700, file 0600) and only then suspends it; if
the dump fails nothing is suspended and the verb fails. It returns `backup_ref` and `size_bytes`,
which Hermes records on the app's `app_databases` row (`archive_ref`, `archive_bytes`, `archived_at`).
`restore` (used by `hermes tool restore`) reloads that copy when the database is gone or its `public`
tables hold no rows (a safety dump of an empty-but-present database is taken first), then resumes it;
a database that still has rows is only resumed.

## Backups

`aquarium backup` dumps every `lapp_*` database on both clusters into `db/apps/<db>.dump` and lists
them in the manifest's `apps_db[]`. `aquarium restore --test` restores each into a scratch database
on its own cluster and compares row counts; `aquarium restore <file> --app <slug> --mode <mode> --yes`
puts back one app database only (Aquarium's database and files are untouched).
