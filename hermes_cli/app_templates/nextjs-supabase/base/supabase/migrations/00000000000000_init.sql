-- Initial migration for {{name}}. Migrations are forward-only: never edit one
-- that has been applied; add a new <timestamp>_<name>.sql instead.
create extension if not exists pgcrypto;
