# Giving the agent a password or token safely

Never paste a password, personal access token (PAT) or API key into a chat message. Chat text goes to the model provider, the transcript and the logs. Give it to the agent through the secret prompt instead: the agent only ever gets the secret's **name**.

## In agent-home chat

- **When the agent asks.** The agent calls `request_secret` and a popup opens over the chat with what it needs and why. Type or paste the value into the masked field (shown as dots; **Show secret** reveals it while you check it) and press **Submit securely**. Press **Decline** if you do not want to give it. The popup expires after 15 minutes.
- **When you want to give one first.** Press the lock button (**Share a secret securely**) next to the message box, give the secret a name (for example `github-pat`) and the value, and press **Save securely**. The message gets `[secret: github-pat]`, which tells the agent which secret to use. If you paste something that looks like a token into the normal message box, agent-home warns you and offers **Move to secure box**.

## On WhatsApp, Telegram or email

The agent sends you a one-time HTTPS link instead of asking in chat. Open it, enter the value on the page and press **Save securely** (or **Don't share**). The link:

- works once; after that the page says "This link cannot be used";
- expires after 15 minutes;
- is only sent in a direct chat to a person whose account is linked, never in a group;
- needs `agent_home.public_url` (an `https://` address) in `config.yaml`. Without it the agent tells you to add the secret under **Settings → Connected accounts** instead.

Do not forward the link: anyone who opens it before you can answer it.

## How the agent uses it

Saved secrets go to your own credential store under provider `secret`. The agent sees them by name with `list_secrets` and uses them only inside a terminal command, for example `secret_env={"GH_TOKEN": "github-pat"}`. The value is put into that one command's environment, and every copy of it in the command's output (also JSON-escaped or base64, standard or URL-safe) is replaced by `***` before the agent sees it. Other people's secrets cannot be used.

You can view, replace or delete your secrets under **Settings → Connected accounts**.

## What is protected, and what is not

Protected:

- the value travels from your browser to the server over HTTPS and is never part of the chat, the transcript, the model's context, the live event stream, the request registry (`secret_requests.db`) or the logs;
- only you can answer a popup meant for you, and each popup or link can be answered once;
- link tokens are random (256 bits), only their SHA-256 hash is stored, link pages are not cached, indexed or sent as a referrer, and repeated guesses are rate limited.

Not protected:

- **the credential store is not encrypted at rest.** Values are stored as plaintext JSON (Supabase `jsonb` behind row-level security, or `0600` files under `~/.hermes/credentials/`). Anyone with database or box administrator access can read them;
- the server reads the value whenever a command uses it, so a command you let the agent run can still send the value somewhere (for example to the site it logs in to, which is the point). Masking covers the command's output, not what the command does;
- a value that the program prints in a form other than the ones above (for example split across lines or hex-encoded) is not masked;
- anything you type into the normal message box is ordinary chat text.

This is safer than chat, not "100% safe". Use tokens with the smallest scope that does the job, and revoke them when you no longer need them.
