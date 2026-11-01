---
title: Aquarium Installation Guide
subtitle: Setting up a new Aquarium server, step by step
---

# About this guide

This guide is for the person who sets up and looks after an Aquarium server (the
**operator**). You do not need to be a developer. You do need to be comfortable
typing commands into a Linux terminal over SSH.

When you finish, you will have:

- an Aquarium server running on its own virtual machine (VM),
- a web address where your team signs in (the **app**, for example
  `https://home.example.com`),
- a second web address for the operator dashboard (for example
  `https://dash.example.com`),
- an **owner** account with two-factor login, an AI model key, and backups.

All host names in this guide are examples. Replace `home.example.com`,
`dash.example.com` and `203.0.113.10` with your own values.

> **Words used in this guide**
>
> - **Owner** — the one person who can change everything in an Aquarium.
> - **Admin, member, viewer** — the other roles (see the User Guide).
> - **agent-home** — the Aquarium web app your team uses in the browser.
> - **Dashboard** — a secondary console for the operator.
> - **Profile** — one independent assistant (its own memory, skills and
>   conversations). Most servers have one, called `default`.

# 1. What you need before you start

## 1.1 A server

| Item | Minimum | Recommended |
|---|---|---|
| Operating system | Ubuntu 24.04 LTS (64-bit, x86_64), fresh install | same |
| CPU | 4 vCPU | 8 vCPU |
| Memory (RAM) | 8 GB | 16 GB |
| Disk | 80 GB (the installer refuses to start with less than 25 GB free) | 160 GB SSD |
| Network | a public IPv4 address | same |
| Access | SSH login as `root`, or a user that can run `sudo` | SSH key login |

Notes:

- The automated install test uses a 4 vCPU / 8 GB / 80 GB cloud VM, so this is
  the smallest size known to work. Choose the recommended size for a team.
- The server needs outbound internet access during installation (Ubuntu
  packages, Docker images, GitHub, the Hugging Face embedding model of about
  2.3 GB) and afterwards (your AI provider, Google, Telegram and so on).
- Use a **dedicated** VM. The installer turns on the firewall, creates service
  accounts and takes over ports 80 and 443.

## 1.2 Two domain names (DNS)

Aquarium is reached through two names. Both must point at the server's public
IP address **before** you install, so that free HTTPS certificates can be
issued automatically (by Caddy, using Let's Encrypt).

| Name (example) | Used for | DNS record |
|---|---|---|
| `home.example.com` | the app (agent-home) your team uses | `A` record → `203.0.113.10` |
| `dash.example.com` | the operator dashboard | `A` record → `203.0.113.10` |

How to check: on your own computer run `nslookup home.example.com` and confirm
it shows the server's IP address. DNS changes can take up to an hour.

> **No domain yet?** You can install without domains. Aquarium then listens
> only on the server itself (`http://127.0.0.1:3100`) and you reach it through
> an SSH tunnel. You can add a domain later from the first-run setup page
> (step 5, "Web address").

## 1.3 Ports

| Port | Open to the internet? | Why |
|---|---|---|
| 22 (SSH) | yes | so you can log in |
| 80 (HTTP) | yes | certificate checks and redirect to HTTPS |
| 443 (HTTPS) | yes | the app and the dashboard |
| everything else | **no** | internal services listen on `127.0.0.1` only |

The installer configures the Ubuntu firewall (`ufw`) for you: it allows only
SSH, 80 and 443. If your cloud provider has its own firewall, open the same
three ports there.

## 1.4 Accounts you will need later

You can collect these after the installation:

- **An AI model provider account and API key** (required) — for example
  OpenRouter, Anthropic, OpenAI, DeepSeek or Google Gemini.
- **A Google account that can create Google Cloud projects** (optional) —
  for Gmail, Google Calendar and Google Drive.
- **Email server details** (optional) — for non-Gmail mailboxes over
  IMAP/SMTP.
- **A Telegram account** and/or **a dedicated WhatsApp phone number**
  (optional).
- **S3-compatible storage** such as Backblaze B2 or Amazon S3 (strongly
  recommended) — for offsite backups.

# 2. Installing Aquarium

The whole installation is one command. It takes about 20–35 minutes,
most of it downloading.

## 2.1 Log in to the server

```bash
ssh root@203.0.113.10
```

If you log in as a normal user, put `sudo` in front of the install command
below.

## 2.2 Run the installer

There are two ways to start it. Both run the same script,
`install-aquarium.sh`.

**Option A — straight from GitHub (most common).** Replace the two domain
names with yours:

```bash
curl -fsSL https://raw.githubusercontent.com/leolau/aquarium/develop/install-aquarium.sh \
  | sudo AQUARIUM_HOME_DOMAIN=home.example.com \
         AQUARIUM_DASHBOARD_DOMAIN=dash.example.com \
         bash -s -- --channel stable
```

**Option B — after cloning the repository.**

```bash
git clone https://github.com/leolau/aquarium.git
cd aquarium
sudo AQUARIUM_HOME_DOMAIN=home.example.com \
     AQUARIUM_DASHBOARD_DOMAIN=dash.example.com \
     bash install-aquarium.sh --channel stable
```

> **TODO (new simple install command):** a shorter post-clone install command
> is being added. When it lands, this section will show it as the first
> option. Until then use Option A or B above.
<!-- TODO(installer): replace with the new post-clone install command name once its PR is merged. -->

### Choosing what to install

Pick **one** of these options at the end of the command:

| Option | What it installs | Use it for |
|---|---|---|
| `--channel stable` (default) | the newest signed stable release | normal servers |
| `--channel beta` | the newest release, including release candidates | trying new features early |
| `--version v1.2.0` | exactly that release | installing a known version |
| `--from-branch develop` | a git checkout of a branch (not signature-checked) | development and test servers only |

Releases are verified before they are installed: the installer checks a
cryptographic signature (cosign) and a checksum, and stops if either does not
match.

> If no signed release has been published yet, `--channel stable` has nothing
> to install. In that case use `--from-branch develop`.

### Optional settings

Put these in front of `bash` in the same way as the domain names:

| Setting | Default | Meaning |
|---|---|---|
| `AQUARIUM_HOME_DOMAIN` | (none) | public name of the app. Without it there is no HTTPS and nothing but SSH is reachable from outside. |
| `AQUARIUM_DASHBOARD_DOMAIN` | (none) | public name of the operator dashboard |
| `AQUARIUM_OWNER_ID` | `admin` | the owner's login name on the dashboard |
| `AQUARIUM_ROOT` | `/opt/data` | where data and settings live |
| `AQUARIUM_SKIP_EMBED_MODEL=1` | off | do not download the 2.3 GB search model now (faster, but memory search needs it later) |

## 2.3 What the installer does

You do not need to do any of this by hand; it is listed so you know what is on
the server:

1. Checks the server (Ubuntu, root, at least 25 GB free disk).
2. Installs system packages, Docker, Node.js 22, `uv` (Python), and Caddy (web
   server with automatic HTTPS). Turns on automatic Ubuntu security updates,
   the firewall, and a 4 GB swap file if there is none. Warns about weak SSH
   settings (it never changes SSH itself).
3. Creates two service accounts: `hermes` (runs Aquarium) and `hermes-tools`
   (runs the commands the assistant types, so they cannot read Aquarium's
   secrets).
4. Generates all passwords and keys and stores them in
   `/opt/data/aquarium-secrets.env` (readable by root only).
5. Downloads and verifies the Aquarium release (or clones the branch).
6. Starts a private, self-hosted Supabase database (Docker), creates the
   database tables and the first owner.
7. Installs the local embedding service (used to search memory).
8. Installs the services, starts them, configures Caddy for your two domains,
   and runs health checks.

Running the installer again is safe: it keeps existing secrets, data and
settings.

## 2.4 When it finishes

At the end the installer prints health checks and a summary, for example:

```text
==> Health checks
  ok    service hermes-embed active
  ok    service hermes-dashboard active
  ok    service hermes-gateway active
  ok    service app-mcp active
  ok    service agent-home active
  ok    supabase containers healthy
  ok    postgres reachable (pooler)
  ok    agent-home :3100/login
  ok    dashboard :9119
  ok    embedding :8791
  ok    https://home.example.com/login

Aquarium installed (home.example.com).
  Owner setup : open this one-time link within 24 hours to set the owner's email and password:
                https://home.example.com/setup#token=…
```

- Every line should say `ok`. If any line says `FAIL`, see
  [Troubleshooting](#troubleshooting).
- **Copy the Owner setup link now.** It works once and expires after 24
  hours. Treat it like a password: whoever opens it first becomes the owner.

# 3. First owner setup

Open the setup link from the installer in your browser. The **Set up
Aquarium** page takes about 5 minutes and has five steps.

1. **Owner account.** Enter your work email and a password of at least 12
   characters (a short sentence works well). This email and password are your
   login from now on. The same password is also set for the operator dashboard.
2. **Two-factor login (recommended).** Leave it on. After you press *Finish
   setup* the page shows a QR code: scan it with an authenticator app
   (Google Authenticator, Microsoft Authenticator, 1Password…), type the
   6-digit code, then **save the recovery codes** somewhere safe. Each
   recovery code lets you in once if you lose your phone.
3. **AI model.** Choose a provider (OpenRouter, Anthropic, OpenAI, DeepSeek or
   Google), paste your API key and press **Test**. Aquarium sends one short
   message; you should see "✓ Works". You can skip this and add the key later.
4. **Region and language.** Check the time zone (used for reminders and
   schedules).
5. **Web address (optional).** If you installed without a domain, type the
   name you want to use and press **Check**. Aquarium tells you whether the
   name points at the server and whether HTTPS is ready.

Press **Finish setup**. You land on the **Get ready** checklist (section 4).

### The link expired or was lost

Create a new link on the server (a new link cancels the old one):

```bash
sudo -u hermes -H bash -c 'set -a; . /opt/data/hermes.env; set +a; \
  /opt/data/hermes-agent/.venv/bin/hermes setup-link --origin https://home.example.com'
```

### Signing in later

Go to `https://home.example.com/login`, enter your email and password, then
the 6-digit code from your authenticator app.

# 4. The Get ready checklist

Everything starts empty after a fresh install. **Settings → Get ready** is a
checklist of what is set up and what is left. Each item shows *Done*, *Needs
attention* or *Not started*, has a **Set up** button that opens its settings
inline, and a **Test** button. **Test everything** checks all items at once.

| Group | Item | Who |
|---|---|---|
| Basics | Owner account and two-factor login | owner |
| Basics | AI model provider key | owner, admins |
| Basics | People and roles | owner, admins |
| Your connections | Google (Gmail, Calendar, Drive) | each person |
| Your connections | WhatsApp | each person |
| Your connections | Telegram | each person |
| Your connections | Email (IMAP / SMTP) | each person |
| Your connections | Extra tools (MCP servers) | each person |
| Your connections | Office network: VPN and network folders | each person |
| Keep it safe | Backups | owner |
| Keep it safe | Security basics | owner, admins |

"Your connections" are personal: every person gets their own list and sets up
their own. Owner and admins only see *whether* each person is set up, never
their keys, messages or files.

The rest of this chapter walks through each item.

# 5. Adding AI model providers and API keys

Aquarium needs at least one AI model provider before the assistant can answer.

**From the app (recommended):**

1. Open **Settings → Get ready → AI model provider key → Set up**, or open
   **Models** from the menu (System group).
2. Choose the provider and paste the API key from the provider's website.
3. Press **Test**. The key is checked with the provider before it is saved and
   is never shown again.

On the **Models** page the owner and admins can also choose which model is used
for the main chat and for background tasks, add backup models, and see 30-day
usage.

**From the server (alternative):** API keys are secrets and live in the
profile's `.env` file. Add a line such as `OPENROUTER_API_KEY=…` to
`/opt/data/hermes-home/.env`, then restart:

```bash
sudo systemctl restart hermes-gateway hermes-dashboard
```

Only put secrets (keys, tokens, passwords) in `.env`. Every other setting
belongs in `config.yaml`.

# 6. Inviting people

1. Open **Users** (System group of the menu).
2. Enter the person's email, display name and role (admin, member or viewer).
   You cannot make someone owner here; ownership is changed on the server.
3. Aquarium shows a **one-time activation link**. Copy it and send it to the
   person. It is shown only once; if it is lost, make a new one (the old one
   stops working).
4. The person opens the link and chooses their own password. Nobody else ever
   sees it.

To add many people at once, use **CSV import** with the columns
`email,display,role`. Aquarium previews every row before you apply it and shows
the activation links in order.

If someone forgets their password, they press **Can't sign in?** on the login
page; an administrator then gets a one-time link to hand over.

# 7. Connecting Gmail, Google Calendar and Drive (Google OAuth)

Google only lets an app read Gmail, Calendar and Drive if the app is registered
in Google Cloud. Each Aquarium registers its **own** Google client, so your
data never passes through anyone else's account. This has two steps.

## Step A — create the Google client (owner, once, about 10 minutes)

Open **Settings → In&Out → Google** (or Get ready → Google → Set up). The page
lists six steps, each with a button that opens the right Google Cloud page.
Tick each step when you finish it.

1. **Create a Google Cloud project**, for example named "Aquarium". Use a
   Google account that can create projects (a Workspace admin is best).
2. **Turn on the Google APIs:** Gmail, Calendar, Drive, People, Sheets, Docs.
3. **Set up the consent screen** (Google Auth Platform → Branding): app name,
   support email, developer contact email.
   - *Audience:* choose **Internal** if everyone uses your company's Google
     Workspace. Otherwise choose **External**, add your colleagues as test
     users, then press **Publish app** so connections don't expire after 7 days.
   - Your team will see "Google hasn't verified this app". That is expected for
     your own company's app: click *Advanced → Go to Aquarium*.
4. **Add the permissions (scopes):** Data access → Add or remove scopes →
   paste the scopes Aquarium shows (use **Copy all**) → Update → Save.
5. **Create the OAuth client:** Clients → Create client → Application type
   **Desktop app** → name "Aquarium" → Create → **Download JSON**.
6. **Give the client to Aquarium:** drop the downloaded `client_secret_….json`
   file on the page (or paste the client ID and secret) and press
   **Save and test**. You should see "✓ Google accepted this client".

If you chose *Web application* instead of *Desktop app*, add
`http://localhost:4321` under *Authorized redirect URIs*.

## Step B — connect a Google account (each person)

1. Open **Settings → In&Out → Connected accounts**.
2. Choose which services to enable (Email, Calendar, Drive, Full workspace).
3. Open the Google consent link, sign in, and approve.
4. The browser ends on a `localhost` address that does not load — this is
   expected. Copy the whole address from the browser's address bar and paste
   it back into Aquarium.
5. Aquarium shows which Google account and permissions were granted. Check it
   is the right account.

## Email polling for Gmail

For a Google account connected with the Mail permission, the owner sees an
**Email polling** switch next to it in Connected accounts. When it is on,
Aquarium regularly checks that inbox and files new mail into the person's
Inbox for triage. Without the Mail permission, email polling stays off.

# 8. Connecting other mailboxes (IMAP / SMTP)

For mailboxes that are not Gmail (Microsoft 365/Outlook, your hosting
provider, your company mail server):

1. Open **Settings → In&Out → Email (IMAP / SMTP) → Add mailbox**.
2. Choose a provider preset (Gmail, Outlook or Other). Presets fill in the
   server names and ports.
3. Enter the email address, user name, incoming server (IMAP), outgoing server
   (SMTP), ports, security (SSL/TLS or STARTTLS) and the password.
   *Gmail and Outlook need an **app password** when 2-step sign-in is on.*
4. Press **Save and test**. Aquarium logs in to both servers; no mail is sent.
   The mailbox shows *Working*, *Needs attention* (with the reason) or
   *Not tested yet*.

Each mailbox is private to the person who added it. The password is stored on
the server and never shown again (leave the field empty when editing to keep
it).

> **TODO (IMAP/SMTP email polling):** an **Email polling** switch is being
> added to each mailbox in Settings → Email mailboxes, so the owner can turn on
> install-wide polling for IMAP/SMTP mailboxes the same way as for Gmail. The
> exact label and steps will be confirmed here when that change is released.
<!-- TODO(email-parity): confirm toggle label/location once the IMAP/SMTP Gmail-parity PR is merged. -->

# 9. Messaging channels

## 9.1 Telegram

Each person can have their own Telegram bot that answers only them.

1. In Telegram, message **@BotFather**, send `/newbot`, answer the questions
   and copy the token it gives you (looks like `123456789:AA…`).
2. In Aquarium open **Settings → In&Out → Telegram**, paste the token and press
   **Save and test**.
3. Press **Link my Telegram account**, open the link, press **Start** in
   Telegram, then come back and press **Check**.

From then on the bot answers only that Telegram account. Owner and admins can
also link Telegram user IDs to members in **Telegram links** in the same
section; messages from unlinked IDs are treated as anonymous.

## 9.2 WhatsApp

WhatsApp works through a "bridge" linked to a phone, like WhatsApp Web.

1. Open **Settings → In&Out → WhatsApp**, type a name for the phone (lowercase
   letters, digits and hyphens, e.g. `work`) and press **Add bridge**.
2. On the phone: WhatsApp → Settings → Linked devices → Link a device, and
   scan the QR code shown in Aquarium.
3. Press **Send test** to send yourself a message.

Use a **dedicated business phone number**. Aquarium reads and sends messages as
that number, and WhatsApp may block numbers that behave like bots. On the
server each bridge runs as a service named `hermes-wa-bridge@<name>`.

## 9.3 Other platforms

The Aquarium messaging gateway (`hermes-gateway`) is based on Hermes Agent,
which also supports Discord, Slack, Signal, Matrix and other platforms. These
are configured on the server rather than in the app; see the Hermes messaging
documentation in `website/docs/user-guide/messaging/` of the repository.

# 10. Extra tools, VPN and network folders

- **Tools & Integrations** (Settings): the MCP servers and tool groups the
  assistant can use. Owner and admins can enable, disable, test, remove, and
  re-authenticate (for example Canva). Members and viewers can view them.
- **Your own tools** (Get ready → Extra tools): each person can add their own
  MCP servers (for example Notion), visible only to them.
- **Office network (VPN):** Settings → In&Out → Private networks. Add a
  Fortinet SSL-VPN login so Aquarium can reach files on an office file server;
  then add network folders under Files.
- **What each role can use** (Settings → Tools & Integrations): which tool
  groups and files each role's assistant may use.
- **Menu** (Settings): which launcher items each role sees.

# 11. Backups

There are two layers of backup. Set up both.

## 11.1 Offsite backups (from the app — recommended)

1. Open **Settings → Get ready → Backups → Set up** (owner only).
2. Choose the storage: Backblaze B2, Amazon S3 or other S3-compatible storage.
   Enter the bucket name, key ID and secret key (and the storage address for
   "other").
3. Choose **Back up every night**, the time, and how many days to keep copies.
4. Press **Save and test**, then **Run first backup**.
5. **Save the backup key** that is shown. Copies are encrypted with it, and you
   need it to open them if the server is lost. It is shown only once.
6. Press **Restore test**. It unpacks the latest copy into a scratch area and
   compares it; your live data is not touched.

The checklist warns when the last good copy is more than two days old or a
restore test failed.

## 11.2 Local backups (from the server)

```bash
sudo aquarium backup                 # encrypted backup to /var/backups/aquarium/
sudo aquarium backup --to /mnt/usb   # somewhere else
sudo aquarium restore <file> --test  # check a backup opens, change nothing
sudo aquarium restore <file> --yes   # put a backup back (takes a safety backup first)
```

The backup key is `/etc/aquarium/backup.key`. **Keep a copy of it off the
server**, together with `/opt/data/aquarium-secrets.env`, in a password
manager. Without the key a backup cannot be opened.

# 12. Updating Aquarium

Check what is installed and whether an update is available:

```bash
sudo aquarium status
```

Install the newest release on your channel:

```bash
sudo aquarium update                    # newest on the configured channel
sudo aquarium update --version v1.3.0   # a specific release
sudo aquarium update --channel beta     # switch to the beta channel
```

`aquarium update` makes a backup first, downloads and verifies the signed
release, switches to it, restarts the services and runs health checks. If the
checks fail, it rolls back to the previous release automatically.

Servers installed with `--from-branch` run from a git checkout. Update them
with `/opt/data/deploy-hermes.sh <branch>`, or move them once to the release
layout with `sudo aquarium migrate-layout --dry-run` and then `--yes`.

# 13. Troubleshooting {#troubleshooting}

## 13.1 First step: run the doctor

```bash
sudo aquarium doctor
```

It checks everything and prints a plain-language **Fix:** line under each
problem. **Settings → Get ready → Security basics → Test** runs read-only
security checks from the app.

## 13.2 Services

| Service | What it does | Listens on (local only) |
|---|---|---|
| `agent-home` | the web app | 127.0.0.1:3100 |
| `hermes-dashboard` | the AI layer API and operator dashboard | :9119 (closed by firewall) |
| `hermes-gateway` | messaging (Telegram, WhatsApp, email…), schedules | — |
| `app-mcp` | tools for apps the assistant builds | 127.0.0.1:9220/9221 |
| `hermes-embed` | local embedding model for memory search | 127.0.0.1:8791 |
| `hermes-wa-bridge@<name>` | one per linked WhatsApp phone | — |
| `caddy` | HTTPS for your two domains | 80, 443 |
| Docker `supabase-*` | the database (Postgres) and its services | 127.0.0.1:5432/8000 |

Useful commands:

```bash
sudo aquarium status                     # version and the state of every service
sudo systemctl status agent-home         # one service in detail
sudo systemctl restart hermes-gateway    # restart one service
sudo aquarium logs                       # recent logs of all services
sudo aquarium logs gateway -f            # follow one service's log
sudo journalctl -u agent-home -n 200     # the same with journalctl
sudo docker ps                           # database containers (all should be "healthy")
```

Quick health checks from the server:

```bash
curl -sf -o /dev/null http://127.0.0.1:3100/login && echo app ok
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9119/   # 200, 302 or 401 is fine
```

## 13.3 Common problems

| Symptom | Likely cause | What to do |
|---|---|---|
| Installer stops with "need >= 25 GB free disk" | disk too small | use a bigger disk |
| `https://home.example.com` does not load; certificate errors | DNS does not point at the server yet, or ports 80/443 closed at the cloud firewall | check `nslookup`, open 80/443, then `sudo systemctl restart caddy` |
| Health check `FAIL` for one service | the service did not start | `sudo aquarium logs <service>`; fix, then re-run the installer (it is safe) |
| "This setup link is not valid" | expired (24 h) or already used | create a new link (section 3) |
| The assistant does not answer | no model key, or the key is wrong | Get ready → AI model → Test; check the provider account has credit |
| Google: "redirect_uri_mismatch" | client type is Web application | use Desktop app, or add `http://localhost:4321` as redirect URI |
| Google connection stops after 7 days | consent screen is External and not published | press **Publish app** in Google Cloud |
| Mailbox "Needs attention" | wrong password, or app password required | create an app password at your mail provider and edit the mailbox |
| WhatsApp bridge "stopped" or QR old | phone unlinked or bridge stuck | press **Restart**, or **Rebind** to scan a new QR |
| Lost the owner's two-factor phone | — | sign in with a recovery code, then turn two-factor off and on again |

# 14. Security notes

- **Keep the setup link, activation links and backup key private.** Each one
  grants access.
- **Turn on two-factor login** for the owner and every admin.
- **Only ports 22, 80 and 443** should be reachable from the internet. Do not
  open 3100, 5432, 8000, 9119 or other internal ports.
- **Use SSH keys**, not passwords, for server login. The installer warns about
  weak SSH settings but never changes them for you.
- **Secrets live in root-only files:** `/opt/data/aquarium-secrets.env`,
  `/etc/aquarium/*.env`, `/etc/aquarium/backup.key`. Do not copy them into chat,
  email or tickets.
- **The assistant's commands run as a separate account** (`hermes-tools`) that
  cannot read Aquarium's secrets or database passwords.
- **Personal connections stay personal.** Each person's Google, email,
  WhatsApp, Telegram, tools and VPN are visible and usable only by them.
- **Updates are signed.** Only install releases through the installer or
  `aquarium update`, which verify the signature.
- **Automatic security updates** for Ubuntu are turned on by the installer.
  Reboot the server from time to time when Ubuntu asks for it.
- **Removing Aquarium:** `sudo aquarium uninstall` (keeps data unless you add
  `--purge-data`).
