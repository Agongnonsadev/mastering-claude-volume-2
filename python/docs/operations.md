# Operating procedure for the Comptoir online

Chapter 21. For the person who runs the Comptoir without having written its code. All the commands are run on the server, in the `ch19/deployment/` folder, unless stated otherwise. Délices d'Awa is a fictional business.

## What runs

| Element | Where | Good to know |
|---|---|---|
| The Comptoir (web chat and WhatsApp) | Container `comptoir`, image built from `ch19/deployment/Dockerfile` | A user without privileges, no published port |
| Caddy | Container `caddy` | HTTPS (certificate renewed on its own), request size bounded |
| The databases (shop, conversations, budget) and the log | Volume `comptoir_data`, mounted on `/data` | Customer data: to back up, to purge |
| The secrets | `.env`, readable by its owner only (`chmod 600`) | Never in Git or in the image |
| The models | `comptoir/config.py`: Claude Haiku 5.5 (Comptoir, router, documents), Claude Sonnet 5.5 (complaints) | Checked every week by `ch21.watch` |

## Every day, every week

- **Every morning**: the dashboard (`https://<domain>/dashboard`, header `Authorization: Bearer <COMPTOIR_DASHBOARD_TOKEN>`). The alerts first.
- **Every night**: `./backup.sh` (cron job), which keeps the last 14 copies.
- **Every day, on its own**: the purge of data beyond the promised periods (the Comptoir runs it at startup, then every 24 hours).
- **Every week**: the watch (`python -m ch21.watch`, or the CI's `watch.yml` job); the Usage and Logs pages of the Console; the review of the members of the production workspace once a month (chapter 18).

## The dashboard's alerts, and what to do

| Alert | What it means | What to do |
|---|---|---|
| “Spending over the last 24 hours: …” | 80% of the daily ceiling reached | Look at the cost per conversation: a customer, a script, a loop? The ceiling protects; raise it only knowing why |
| “…% of the messages of the last 24 hours failed.” | More than 5% errors over at least 10 messages | The failure modes: `invalid_key` (the key), `overloaded` or `rate_limit` (temporary), `billing` or `spend_limit` (the credits or the Console's limit) |
| “Customers received “The Comptoir can't answer right now” for lack of budget.” | The ceiling of the day or of a customer is reached | The list of conversations to pick up: Awa answers herself |
| “The conversation … was flagged N times by the monitoring.” | Someone is trying to manipulate the Comptoir | Read the conversation; no rule has given way as long as the guards hold (chapter 18) |
| “WhatsApp is not configured …” | `COMPTOIR_PSEUDONYM_SALT` is missing from `.env` | Fill it in, then `docker compose up -d`; Meta resends the messages for 7 days |
| “WhatsApp messages were left without an answer …” | Send refused by Meta, or processing impossible | Meta's token (expired? revoked?), then the logs: `docker compose logs comptoir` |

## The operations

**Start, or apply a change to `.env`**:

```bash
docker compose up -d --build
```

Then `https://<domain>/health` must answer `{"state":"ok"}`, and a chat message must get an answer.

**Update the Comptoir**: the CI has passed the tests and the regression on the pull request. On the server: `git pull`, then `docker compose up -d --build`. When stopping, the Comptoir finishes the queued messages (Compose gives it 30 seconds). Rollback: `git checkout <previous commit>`, then the same command.

**Restore a database**:

```bash
./restore.sh 2026-10-22 conversations
```

The script stops the Comptoir, puts the copy back, gives it back to the Comptoir's user, and restarts. Do not put a database back with `docker cp` alone: it would belong to root, and the Comptoir could no longer write to it.

**Erase the data of a customer who asks for it** (the Comptoir passes the request on to Awa; it cannot erase anything itself):

```bash
docker compose exec comptoir python -m ch18.data erase-number 22997000000     # a WhatsApp customer
docker compose exec comptoir python -m ch18.data erase <conversation>          # a web chat customer
```

The conversation, the requests and the number are erased; past orders remain, reduced to the first name and the initial, for the accounts. The backups of the last 14 days still contain this data: it disappears with the rotation of the copies. The time allowed to answer depends on the law of the customer's country.

**Change the API key** (every 90 days, or right away if it has leaked):

1. Console, production workspace, service account `comptoir-production`: create a new key.
2. Put it in `.env` (`ANTHROPIC_API_KEY`), then `docker compose up -d`.
3. Check `/health` and a message.
4. Delete the old key in the Console. **If it has leaked, start there**, even if it means cutting the service for a few minutes.

The same for Meta's token (`COMPTOIR_WHATSAPP_TOKEN`) and the app secret (`COMPTOIR_WHATSAPP_APP_SECRET`). The fingerprint salt (`COMPTOIR_PSEUDONYM_SALT`) is not changed without a reason: the old fingerprints would no longer match the numbers.

## The incidents

| Incident | First move | Then |
|---|---|---|
| A key or a token has leaked | Delete it in the Console (or at Meta) | New key (above); find where it leaked: repository, log, screenshot |
| Anthropic's API answers badly (`overloaded` errors, delays) | Nothing: the SDK retries; if it does not succeed, the customer reads “The Comptoir is very busy right now” or “Awa will reply to you directly” | If it lasts, warn Awa: she picks up the conversations by hand |
| The month's budget is used up | The Comptoir answers “can't answer right now” | Awa's decision: raise the ceiling (`COMPTOIR_MONTHLY_BUDGET`) or wait for the next month |
| The server is lost | A new server, the repository, `.env` (kept off the server, encrypted) | `docker compose up -d --build`, then `./restore.sh` for each database |
| A customer complains about an answer | Read the conversation, without changing it | A case for the evaluation suite (chapter 17); a fix, measured |

## Changes of model, SDK or API

See `docs/migration.md`. Nothing changes in production without going through the evaluation suite.
