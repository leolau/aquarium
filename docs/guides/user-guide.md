---
title: Aquarium User Guide
subtitle: Working with your Aquarium assistant every day
---

# About this guide

Aquarium is your organisation's AI assistant. It chats with you, reads the
email and messages you connect, remembers what matters, keeps a to-do list,
works on longer projects on its own, and files what arrives. This guide shows
you how to use it in the browser.

The app works on a phone and on a computer. Web addresses in this guide use the
example `https://home.example.com`; your organisation will give you the real
one.

The app is available in **English** and **Traditional Chinese (繁體中文)**.

# 1. Signing in

## 1.1 Your first sign-in

You do not choose a password for someone else, and nobody chooses one for you.
Instead:

1. An owner or admin invites you and sends you a **one-time activation link**.
2. Open the link and choose your own password (at least 12 characters).
3. You are signed in.

The link works once. If it has expired or was already used, ask the person who
invited you for a new one.

## 1.2 Signing in later

1. Go to `https://home.example.com/login`.
2. Enter your email and password.
3. If two-factor login is on, enter the 6-digit code from your authenticator
   app (or one of your recovery codes).

**Forgot your password?** Press **Can't sign in?** on the login page. An owner
or admin then gets a one-time link they can hand to you.

## 1.3 Two-factor login (recommended)

Open **Settings → Account security**:

- **Turn on two-factor login**, scan the QR code with an authenticator app
  (Google Authenticator, Microsoft Authenticator, 1Password…), and type the
  6-digit code to confirm.
- **Save your recovery codes.** Each one lets you sign in once without your
  phone. You can make new ones at any time; the old ones then stop working.
- **Change password** is also here.

# 2. Finding your way around

## 2.1 The menu (Coral launcher)

Open the menu from the launcher button. Apps are grouped into **Workspace**
and **System**. Which apps you see depends on your role and on what the owner
has chosen to show (Settings → Menu). **Home** and **Settings** are always
there.

| App | What it is for |
|---|---|
| **Home** | your starting point |
| **To-dos** | what needs you |
| **Chat** | talk to the assistant |
| **Inbox** | everything that arrived, plus approvals and the change log |
| **Memory** | what the assistant remembers |
| **Projects** | longer work the assistant runs on its own |
| **Files** | every file that arrived, and network folders |
| **Activity** | a timeline of what the assistant did |
| **Graph** | goals, tasks and how they connect (read-only) |
| **Capacity** | how busy the server is |
| **Users** | who is in your Aquarium |
| **Suggestions** | proposed new goals (owner decides) |
| **Tools** | apps the assistant built for you |
| **Models** | which AI model is used for what |
| **Core area** | the protected core settings (read-only) |
| **Agent webview** | watch and approve the assistant using a web browser |
| **Settings** | your account, connections and preferences |
| **Getting started** | readiness overview |

## 2.2 The status bar

The small indicators show **CPU**, **Disk**, **Tokens** used in the last 30
days, active **Tasks**, and scheduled **Cron** jobs. Tap CPU to open the
Capacity page.

# 3. Chatting with the assistant

Open **Chat**.

- **Type a message** and press send. The answer appears as it is written.
  While the assistant is working, a live activity line shows what it is doing
  (for example searching the web or reading a file).
- **Attach files** with the paperclip button (shown when file storage is set
  up). Attachments are included with your next message.
- **New conversation**: press **+ New**. Each conversation is kept separately;
  switch between them from the conversation list.
- **Archived** conversations are kept under the archive button.
- **Search** inside a conversation and across conversations; **filter** by tag.
- **Copy** a message with its copy button.
- **Profile picker**: if your Aquarium has more than one assistant (profile),
  choose which one answers. Each profile has its own memory, skills and
  conversations. If there is only one, the picker is hidden.

## 3.1 Approvals

Some actions are risky (for example running a command, or sending something on
your behalf). The assistant then stops and asks. You can choose:

- **Approve** — this once,
- **Approve for this chat** — for the rest of this conversation,
- **Always approve** — from now on,
- **Deny**.

Pending approvals also appear in **Inbox → Approvals**.

## 3.2 Other ways to chat

If you connect Telegram or WhatsApp (section 5), you can talk to the same
assistant from your phone's messaging app. It remembers you across all of them.

# 4. Settings

**Settings** contains:

| Section | What you can do |
|---|---|
| Account security | password, two-factor login, recovery codes |
| Theme | light/dark look (saved in this browser) |
| Language | English or Traditional Chinese |
| Notifications | turn on push notifications on this device |
| In&Out | your connections: Google, WhatsApp, Telegram, email, VPN, SQL Server databases |
| Apps / Menu | which apps appear in the menu (owner or admin sets this per role, owner included) |
| Tools & Integrations | the tools the assistant can use |
| Get ready | the setup checklist |
| Entity goal | what the whole system is for (owner edits) |
| Tags | create and delete tags used to organise items |

Members and viewers see a reduced Settings page: they manage their own account
and connections, not the system.

# 5. Connected accounts

Your connections are **private to you**. The assistant uses them only for you.
Owner and admins can see *whether* you are connected, never your messages,
files, keys or passwords.

The easiest place to start is **Settings → Get ready**. Under *Your
connections* each item shows *Done*, *Needs attention* or *Not started*, with a
**Set up** and a **Test** button.

## 5.1 Google (Gmail, Calendar, Drive)

The owner must first register Google for your Aquarium (see the Installation
Guide). Then:

1. Open **Settings → In&Out → Connected accounts**.
2. Choose the services you want: Email, Calendar, Drive, or Full workspace
   (Drive, Docs, Sheets).
3. Open the Google link, sign in, and approve.
4. Your browser ends on a `localhost` address that does not load. **This is
   expected.** Copy the whole address from the address bar and paste it into
   Aquarium.
5. Check that the correct Google account is shown.

If Google warns "Google hasn't verified this app", that is normal for your
organisation's own app: click *Advanced → Go to Aquarium*.

## 5.2 WhatsApp

1. **Settings → In&Out → WhatsApp**: type a short name (e.g. `work`) and press
   **Add bridge**.
2. On your phone: WhatsApp → Settings → Linked devices → Link a device, and
   scan the QR code.
3. Press **Send test**.

**Restart** fixes a stuck bridge. **Rebind** unlinks the phone and shows a new
QR code. Use a business number: WhatsApp may block numbers that behave like
bots.

## 5.3 Telegram

1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token.
2. **Settings → In&Out → Telegram**: paste the token and press **Save and
   test**.
3. Press **Link my Telegram account**, press **Start** in Telegram, then
   **Check** in Aquarium.

The bot then answers only you.

## 5.4 Extra tools and office network

- **Extra tools**: add your own MCP servers (for example Notion). Only you can
  use them.
- **Office network (VPN)**: add your VPN login so the assistant can reach
  office file servers; then add network folders under **Files**.

## 5.5 SQL Server databases

If your organisation keeps data in a Microsoft SQL Server database (for
example an ERP or accounting system), the assistant can look things up in it
for you. Ask your IT team for a **read-only SQL login** first; the
Installation Guide (section 10.1) tells them what to set up.

### Adding a database

1. Open **Settings → In&Out → SQL Server databases → Add database**.
2. Fill in:

   | Field | What to enter |
   |---|---|
   | Name | a short name you will use in chat, e.g. `ERP` |
   | Database | the database name |
   | Server | the server's name or address |
   | Port | usually `1433` (IT tells you if it is different) |
   | Instance (optional) | the instance name, if IT gave you one |
   | SQL login / Password | the read-only login from IT |
   | Encryption | keep **Encrypt (recommended)**. **Strict (TDS 8.0)** is for new servers that require it. **Only the sign-in** encrypts just the login. |
   | Reach it through VPN | pick your office VPN if the server is only reachable from the office, otherwise **No VPN** |

3. Tick the boxes only if IT tells you to, or the test asks for them:
    - **Trust the server certificate (self-signed)**: the server uses its own
      certificate.
    - **Older Windows Server 2008/2012 (TLS 1.0)**: an old server that cannot
      use modern encryption.
4. Press **Save and test**. Aquarium signs in and shows **Signed in:** with the
   server version.

The database then shows **Working**, **Needs attention** (with the reason, for
example *"Sign-in failed: check the SQL login and password."*) or **Not tested
yet**. It is marked **Read-only** or **Changes allowed**, and **via** the VPN
it uses. Use **Test** to check again, **Edit** to change details (leave the
password empty to keep the saved one), and **Remove** to delete the connection.
Removing it does not change the database itself.

Only you can see and use your connections. The password stays on the server
and is never shown again, not even to the assistant.

**Allow changes (owner only).** The owner also sees **Allow changes (each change
asks you first)** on their own connections. Everyone else's connections are
always read-only.

### Asking the assistant about a database

Just ask in **Chat**, for example:

- *"List the tables in ERP."*
- *"What columns does dbo.Orders have?"*
- *"How many orders did we ship last month, by customer?"*
- *"Show the ten biggest unpaid invoices."*

If you have more than one database, say which one. The assistant can list your
connections, list tables, describe a table and run a query.

- **Read-only by default.** It runs one `SELECT` query at a time and never
  changes data.
- **Limits:** at most 500 rows per answer (it tells you when there were more),
  30 seconds per query, and very long values are shortened. Ask for totals or a
  narrower filter when a result is too big.
- **Changes** run only on a connection where the owner ticked **Allow
  changes**. Even then the assistant shows you the exact SQL statement first,
  and it runs only if you approve.
- If the database is behind your VPN, Aquarium connects the VPN when needed. If
  your VPN is set not to connect automatically, connect it in Settings →
  In&Out first.

# 6. Email mailboxes and polling

## 6.1 Adding a mailbox (IMAP / SMTP)

Use this for any mailbox: Outlook / Microsoft 365, your web host, or a company
mail server.

1. **Settings → In&Out → Email (IMAP / SMTP) → Add mailbox**.
2. Pick a preset (Gmail, Outlook or Other). Presets fill in the server names
   and ports.
3. Fill in your email address, user name and password. Check the incoming
   (IMAP) and outgoing (SMTP) server, port and security.
   *Gmail and Outlook need an **app password** when 2-step sign-in is on.*
4. Press **Save and test**. Aquarium signs in to both servers (it does not send
   any mail).

The mailbox then shows one of:

- **Working** — both servers accepted the login,
- **Needs attention** — with the reason, e.g. wrong password,
- **Not tested yet**.

Use **Test** to check again, **Edit** to change details (leave the password
empty to keep the saved one), and **Remove** to delete it. Your password is
stored on the server and never shown again.

## 6.2 Email polling

**Polling** means Aquarium checks an inbox regularly by itself and files new
mail into **Inbox**, where the assistant triages it (for example creating
to-dos).

- **Gmail:** for a Google account connected with the Email service, the owner
  can switch **Email polling** on in **Connected accounts**.
- **IMAP / SMTP mailboxes:** the owner sees an **Email polling** checkbox
  under each of their own mailboxes in **Settings → In&Out → Email (IMAP /
  SMTP)**. Ticking it gives that mailbox the same polling and triage as Gmail.
  Aquarium logs in with the saved password. The checkbox is hidden from
  everyone else.

## 6.3 Asking the assistant about your mail

Once you have saved a mailbox (section 6.1), you can just ask in **Chat**. The
assistant can list your mailboxes, search, read, send, reply, show your
folders, mark mail as read or unread, flag it, and move it to another folder.
For example:

- *"Search my unread mail."*
- *"Find emails from ada@example.com since last Monday."*
- *"Read the newest one and summarise it."*
- *"Reply to that email: thanks, Thursday works for me."*
- *"Mark it as read and move it to the Archive folder."*
- *"Send an email to team@example.com about tomorrow's meeting."*

If you have more than one mailbox, say which one (for example *"in my
ops@example.com inbox"*). Before it sends or replies, the assistant checks the
recipients and the text with you.

The assistant can only use **your own** mailboxes. It never uses anyone else's,
and it never shows your password.

# 7. To-dos, Inbox and Activity

## 7.1 To-dos

The assistant notices things in what arrives (emails, messages, chats) and puts
them on your to-do list:

- quietly as **staged** items, or
- as **open** items when they are worth interrupting you.

On **To-dos** you can promote, close or dismiss items and filter the list (for
example `/todos?stage=open`). You are always the final judge.

## 7.2 Inbox

**Inbox** shows everything that arrived, from any channel, with filters. It
also has:

- **Approvals** — actions waiting for your decision,
- **Change log** — changes the assistant made, many of which can be undone.

## 7.3 Activity

**Activity** is a read-only timeline of the assistant's interactions: what it
was asked, which tools it used, and what came out. Use it to check what
happened.

# 8. Projects, Memory, Files and Tools

## 8.1 Projects

**Projects** are longer-running pieces of work the assistant handles over
time, for example a weekly report or an ongoing follow-up. The board shows
active projects by category; filter by status or cadence. A project can be
limited to certain tools and skills; the page shows what will actually run.

## 8.2 Memory

**Memory** shows what the assistant remembers about you and your work. Search
it, page through it, and see it on a map. Memory is per person: your private
memories are yours.

## 8.3 Files

**Files** lists every file that arrived from any channel (chat, email,
WhatsApp…) with where it came from. A file only becomes part of memory when you
ask, or when a triage skill decides. Network folders (via VPN) also appear
here.

## 8.4 Tools (apps the assistant built)

The assistant can build small apps for you. **Tools** shows the ones you own
and the shared ones, with their health.

## 8.5 Agent webview

When the assistant uses a web browser for you, **Agent webview** shows the
session. Nothing happens without your consent: actions that need approval wait
for you here.

# 9. Skills

A **skill** is a reusable set of instructions that teaches the assistant how to
do a particular job well (for example "prepare a meeting summary" or "process
an invoice"). The assistant chooses the right skill by itself; you do not need
to start skills manually.

- **Ask for a skill in chat.** For example: *"Remember how you did this and
  make it a skill."* The assistant can create and improve its own skills.
- **Skills belong to a profile.** Each profile (assistant) has its own skills.
- **Projects** can be limited to certain skills (section 8.1).
- Operators can install and manage skills on the server with
  `hermes skills`.

## 9.1 Reading websites that need a login (auth-web-crawler)

The built-in **auth-web-crawler** skill lets the assistant sign in to a website
you are allowed to use, look through it and pull out the content to study or
summarise. Good examples are an intranet wiki, a supplier portal or a course
site.

**How to use it:** in Chat, give the address, your login name and what you
want. For example:

- *"Log in to https://portal.example.com with my login alice and summarise the
  pages under /docs."*
- *"Read the supplier price lists on our intranet wiki and make a table."*

**Your password:**

- If you send the password in chat, the assistant saves it right away in
  Aquarium's credential store (as `web-login/<site>`). After that it refers to
  it only by name, for example "the saved password for portal.example.com".
  Next time you only need to name the site.
- It never repeats your password, and never puts it in files, memory or
  output.

**What it does and doesn't do:**

- It stays on the same website, under the starting page. It visits a limited
  number of pages and follows the site's robots.txt rules. It skips "log out"
  and "delete" links.
- It saves the pages it read (title, text and links) so it can work with them.
- It refuses to send a password over plain `http://` unless you allow it.
- It **stops and asks you** at CAPTCHAs, two-factor codes or "verify it's you"
  pages. It does not get around them, or around paywalls.
- Only use it on sites you are authorised to access. If that is unclear, the
  assistant asks first.
- Addresses inside the office network (for example `10.x`, `192.168.x`) are
  blocked by default. Only your operator can allow them (see the Installation
  Guide, section 10).

# 10. Roles and permissions

Every person has one role.

| Role | Typically for | Can | Cannot |
|---|---|---|---|
| **Owner** | one person | everything: settings, model keys, people, backups and security checks; their own connections | hand over ownership in the app (done on the server); read other people's private items unless senior access is on |
| **Admin** | office manager, IT | invite people and change roles; change settings, tools and model keys; use every assistant tool | make someone owner; set up backups; see or use anyone else's connections; read others' private items (with senior access: only members' and viewers') |
| **Member** | staff | chat; own private chats and files; everything shared; own Google, WhatsApp, Telegram, email, extra tools, VPN and SQL Server databases | see other people's private items; change settings; let the assistant run commands on the server |
| **Viewer** | part-time staff, guests | read what is shared; chat using the tools allowed for viewers | have the assistant write files; change settings; see other people's private items |

Which menu apps each role sees is set by the owner or an admin in **Settings →
Menu**, with one tab per role: Owner, Admin, Member and Viewer. Only the owner
can change the Owner tab. A hidden app is also blocked if someone types its
address directly.

# 11. Admin functions (owner and admins)

## 11.1 Users

**Users** is a directory everyone can read. Owner and admins also see:

- **Invite**: enter email, display name and role. Copy the one-time
  activation link shown and send it to the person. It is shown only once; make
  a new one if it is lost (the old one stops working).
- **Change role** and **suspend** people.
- **CSV import**: upload `email,display,role` rows; preview, then apply.
- **Audit trail** of changes to people and roles.

## 11.2 Get ready

**Settings → Get ready** shows all eleven setup items plus each person's
connection status (status only, never keys). **Test everything** checks them
all.

## 11.3 Models

**Models** chooses the AI model for the main chat and for helper jobs (vision,
summarising web pages, titles, approvals, tool routing…), sets **backup
models** used when the main one fails, and shows usage and cost.

## 11.4 Tools & Integrations

In **Settings → Tools & Integrations** owner and admins enable, disable, test,
remove and re-authenticate tool servers, and decide which tools each role's
assistant may use.

## 11.5 Suggestions and goals

The owner sets the **Entity goal** in Settings. Aquarium may propose new
sub-goals in **Suggestions**, one at a time; the owner adopts or dismisses each
one (dismissal is permanent for that evidence).

## 11.6 Backups and security (owner)

Set up nightly encrypted offsite backups and run restore tests in **Get ready →
Backups**. **Security basics → Test** runs read-only security checks. See the
Installation Guide for details.

# 12. FAQ

**I did not get an activation link.** Ask the person who invited you; they can
make a new one.

**The activation or setup link says it is not valid.** It was used already or
has expired. Ask for a new one.

**I lost my phone with the authenticator app.** Sign in with a recovery code,
then turn two-factor login off and on again in Settings → Account security to
set up the new phone.

**Can my manager read my email or chats?** No. Connections and private items
are yours. Owner and admins see only whether you are connected. (If the owner
turns on *senior access*, owner and admins can read members' and viewers'
private items; ask your owner whether it is on.)

**Google shows "This site can't be reached" after I approve.** That is
expected. Copy the address from the address bar and paste it into Aquarium.

**My mailbox says "Needs attention".** The password is probably wrong or your
provider requires an app password. Create one and edit the mailbox.

**Can the assistant read or send mail from my mailbox?** Yes, but only from
the mailboxes you saved yourself, and it checks with you before sending. See
section 6.3.

**Can the assistant read a website that needs a login?** Yes, if you are
allowed to use the site. Give it the address and your login; see section 9.1.

**My SQL Server database says "Needs attention".** Read the reason. *Sign-in
failed* means a wrong login or password. *Did not answer in time* or *Could
not connect* usually means the VPN is not chosen or the port is blocked; ask
IT. For *Could not open a secure connection*, tick the older-server or
trust-certificate box as the message says.

**Can the assistant change data in our database?** Not by default. It only
reads. Changes need the owner's **Allow changes** switch and your approval of
each statement; see section 5.5.

**The assistant does not answer.** The AI model key may be missing or out of
credit. Ask your owner or admin to check **Get ready → AI model**.

**An app is missing from my menu.** The owner may have hidden it for your role.

**Why does the assistant ask before doing something?** Risky actions need your
approval. You can approve once, for the whole chat, or always.

**Can I use it in Chinese?** Yes. The app is available in English and
Traditional Chinese.
