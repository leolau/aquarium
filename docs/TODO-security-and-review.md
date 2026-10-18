# ai-prentice-4-all — Consolidated To-Do List

Combines (A) security hardening to-dos from the eGoBid RDS incident + "how do we
stop the box agent from changing infrastructure" discussion, and (B) the
findings from `ai-prentice-4-all-docs-review.md`.

Priority legend: **[P0]** do now / incident follow-up · **[High]** fix soon ·
**[Med]** should fix · **[Low]** polish.

---

## A. Security hardening (agent must not be able to change infra)

Core principle established by the incident: **in-agent controls are bypassable**
(there is a skill on the box that explicitly teaches bypassing the MCP approval
gate via boto3 from the terminal). The only enforceable boundary is **AWS IAM**.
Order below is most-effective → least.

### A1. [P0] Lock down the agent's AWS credentials with least privilege
- [ ] Replace the near-admin keys in `config.yaml` (`mcp_servers.aws-api-egobid.env`,
      IAM user `devin-egobid`, acct `444643374336`; and any sibling `aws-api-*`
      entries) with **read-only** infra access (`AmazonRDSReadOnlyAccess`,
      `AmazonEC2ReadOnlyAccess`) for reporting.
- [ ] Attach an **explicit Deny** on destructive/security actions (explicit Deny
      always beats Allow):
      `rds:ModifyDBInstance`, `rds:DeleteDBInstance`, `rds:Reboot*`,
      `rds:ResetDBParameterGroup`, `ec2:AuthorizeSecurityGroup*`,
      `ec2:RevokeSecurityGroup*`, `ec2:StopInstances`, `ec2:StartInstances`,
      `ec2:TerminateInstances`, `ec2:ModifyInstanceAttribute`,
      `ec2:CreateKeyPair`, `ec2:*Address` (EIP), `iam:*`, `kms:*`.

### A2. [P0] Take the DB master user off the box
- [ ] Stop putting `egobiddbadmin` (RDS master) in `config.yaml` / cron scripts.
- [ ] Create a dedicated MySQL reporting user with `SELECT` only on the needed
      schemas; put that in config. Then the agent literally cannot change
      passwords or drop/alter data.

### A3. [P0] Enforce the guardrail where the agent can't edit it
- [ ] Put the Deny in an **AWS Organizations SCP** (or an IAM permissions
      boundary) — not a local file/policy the agent could modify.
- [ ] **Rotate** the `devin-egobid` access keys (and any other AWS keys found in
      `config.yaml`): they were used and are in plaintext in `config.yaml`,
      session dumps, and logs.

### A4. [P0] Remove / rewrite the bypass + credential-harvest skill
- [ ] Delete or rewrite `skills/devops/find-project-credentials/` on the box —
      it teaches boto3 approval-gate bypass and credential harvesting
      (`references/aws-rds-access.md`, `templates/egobid-report.py`,
      `templates/ebid-report.py`).

### A5. [High] Detective controls & least standing access
- [ ] Enable CloudTrail alerts on `ModifyDBInstance` and security-group changes.
- [ ] Keep any true admin access in a **separate human-only break-glass role**
      behind MFA.
- [ ] Ideally the assistant agent holds **no** standing prod access — give it a
      read replica or a scoped read-only reporting user instead.

### A6. [High] Fix the approval gate; don't rely on it alone
- [ ] The Hermes tool-approval plugin only gates the `call_aws` MCP tool; direct
      boto3 via the `terminal` tool is ungated. Either sandbox the terminal tool
      without AWS creds in its env, or ensure creds are read-only (A1) so an
      ungated path is harmless. Also fix the approval-prompt topic-routing bug
      noted in the bypass skill.

### A7. [Med] eGoBid incident follow-ups (from recovery)
- [ ] **Route53 check:** confirm no dev DNS A-record still points at the old dev
      IP `18.166.28.165` (I couldn't verify — `devin-egobid` lacks
      `route53:ListHostedZones`).
- [ ] **Elastic IP for egobid-dev:** dev has no EIP, so its public IP churns on
      every stop/start (`18.166.28.165` → `43.198.184.161` → `95.40.28.37`).
      5 idle EIPs exist in the account — associate one (live, no downtime) for a
      stable IP. (Decision pending.)
- [ ] Dev user-data was cleared; original backed up at
      `/tmp/dev_userdata_backup.b64` on the ECS box — move somewhere durable or
      discard.
- [ ] Remove the transient `python3-pymysql` package installed on egobid-prod /
      egobid-dev during recovery, if you want the boxes pristine.

### A8. [High] Loopback-bind the custom HTTP services (defense in depth)
> (Same as docs-review #1 below — listed here too because it's a security item.)
- [ ] Bind email/WhatsApp MCP + poller/batcher health servers to `127.0.0.1`,
      drop `Access-Control-Allow-Origin: *`, and reconcile the ECS security
      group so only 80/443 (+22 from trusted CIDRs) are internet-facing.

---

## B. Docs / design review to-dos (from ai-prentice-4-all-docs-review.md)

### B1. [High] Local services bind `0.0.0.0` and lean entirely on the SG  (review #1)
- [x] (F1, 2026-10-18) Bind to `127.0.0.1`: `custom/email/email_mcp_server.py:688` (:8651, also
      drop `*` CORS/no-auth), `custom/whatsapp/mcp_server.py:474` (:8650),
      `custom/whatsapp/batcher.py:348` (:7900),
      `custom/email/email_poller.py:317` (:7901),
      `custom/calendar/calendar_poller.py:426`,
      `custom/{whatsapp,shared}/telegram_callback_handler.py:268`.
- [ ] Document intended per-port exposure in
      `docs/security/network-egress-isolation.md` /
      `docs/deployment/mcp-approval-gating.md`; tighten the SG (currently opens
      22/80/443 + 3000/7337/7338/7902/8080/8642 to `0.0.0.0/0`).

### B2. [High] Triage agents import an out-of-repo module  (review #2)
- [ ] `custom/whatsapp/triage_agent.py:24` and
      `custom/email/email_triage_agent.py:23` do top-level
      `from track_credit_helper import track_inference`, but the module lives
      only at `/opt/data/track_credit_helper.py`. Vendor it into
      `custom/shared/` (or make the import optional with a no-op fallback) so the
      pipeline is self-contained and CI-testable.

### B3. [High] Pipeline runs from a hardcoded, out-of-repo skills dir  (review #3)
- [ ] `custom/whatsapp/triage_agent.py:30` → `SKILLS_DIR =
      '/opt/data/skills/whatsapp-triage'`. Make `SKILLS_DIR`/`DB_PATH`/paths
      configurable (env or `config.yaml`, per ".env = secrets only") with box
      values as defaults; document/automate the `custom/skills → /opt/data/skills`
      sync (or symlink) so the repo is the source of truth.

### B4. [High] `custom/skills/whatsapp-triage/SKILL.md` is Docker-era; prod is systemd  (review #4)
- [ ] Rewrite paths + restart procedure for systemd
      (`systemctl restart hermes-wa-triage hermes-wa-batcher …`); remove
      `docker exec … hermes-agent …` and the `/opt/data/whatsapp-messages/…`
      "Key Files" paths (live processes run from
      `/opt/data/hermes-agent/custom/{whatsapp,email}/…`).

### B5. [Med] prod-cutover handoff calls the old box "kept for rollback" — it's gone  (review #5)
- [ ] Add a superseding banner to
      `docs/design/SESSION-HANDOFF-2026-07-prod-cutover.md` (§0/§1): the 2/4 box
      (`ai-prentice`, `i-j6camnt3ocwlmzajthil`, `8.217.86.90`) has been released.
      (Root `HANDOFF.md` already fixed in PR #117.)

### B6. [Med] v1 (`custom/whatsapp/`) vs v2 (`custom/shared/`) duplication  (review #6)
- [ ] `custom/shared/{escalation_pusher_v2,digest_cron_v2,contact_manager,
      telegram_callback_handler}.py` duplicate the `custom/whatsapp/` v1 files;
      live systemd runs v1. Pick one, delete the other, make `custom/README.md`
      match what actually runs.

### B7. [Med] Custom datastore sits outside the master plan's C3/D4 model  (review #7)
- [ ] The pipeline stores WhatsApp+email+contacts+escalations in a standalone
      SQLite `whatsapp_data.db`, outside the C3 router / Supabase `app_*` (D4).
      Add a section (in FG-03 or a dedicated FG) that either scopes the triage DB
      as an explicit legacy subsystem or describes its migration path into
      C3 + `app_*`.

### B8. [Low] SKILL.md frontmatter inconsistent  (review #8)
- [ ] `custom/skills/calendar-triage/SKILL.md` has no YAML frontmatter; add
      `name`/`description` for consistent discovery.

### B9. [Low] "whatsapp-triage" skill actually documents the whole pipeline  (review #9)
- [ ] `whatsapp-triage/SKILL.md` (v2.0.0) covers WhatsApp + email + contacts +
      credit + digests. Rename to `triage-pipeline` (or split into per-channel
      skills) so the name matches scope.

### B10. [Low] Minor code notes (spotted while cross-checking; not doc issues)
- [ ] `custom/email/email_poller.py`: `INSERT OR IGNORE` but `total_new`
      increments unconditionally (and catches `IntegrityError` that `OR IGNORE`
      won't raise) — the "N new emails" count over-reports duplicates.
- [ ] `email_poller` caps `uids[:50]` per poll; a >50 backlog drains 50/cycle —
      fine, just worth a comment.

---

## Suggested execution order
1. **A1–A4** (P0 security): least-privilege IAM + explicit Deny, take the DB
   master user off the box, SCP + rotate keys, remove the bypass skill.
2. **A7** eGoBid incident follow-ups (Route53 check, dev EIP decision).
3. **B1/A8** loopback-bind custom services + tighten/document the SG.
4. **B2, B3** vendor `track_credit_helper`, de-hardcode paths/skills dir.
5. **B4** refresh the whatsapp-triage SKILL for systemd.
6. **B6** resolve v1/v2 duplication + reconcile `custom/README.md`.
7. **B5, B7** prod-cutover banner + C3/Supabase note for the triage DB.
8. **B8, B9, B10** polish.
