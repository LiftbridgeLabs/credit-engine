# CreditEngine

On-demand and rule-based credits-marker (Skip Credits) generation for Plex — built for "unlimited"
libraries (debrid/Usenet) where letting Plex auto-scan everything isn't practical. Everything is
disabled by default; you control what actually gets analyzed, on demand, by rule, or automatically
when someone starts watching.

## What it does

- Links your Plex account/server via Plex's own SSO
- Disables Plex's automatic credits-marker generation for every existing item by default
- Lets you selectively re-enable + scan specific movies, shows, seasons, or episodes on demand
- Rules can re-enable/disable items automatically on a schedule (e.g. "anything watched in the last 30 days")
- A Plex webhook can trigger scanning automatically the moment someone watches something — bounded
  to the next few episodes, not the whole series
- Sonarr/Radarr integration auto-disables newly-imported content before Plex's own scheduler can catch it

## Requirements

- Docker and Docker Compose
- A Plex server with **Plex Pass** (credits-marker generation and Plex webhooks both require it)
- Network access from this app to your Plex server, and (if you use them) from Sonarr/Radarr/Plex back to this app

## Setup

1. Copy the env template and fill it in:

   ```bash
   cp .env.example .env
   ```

   - `SECRET_KEY` — signs session tokens. Generate one with:
     ```bash
     python3 -c "import secrets; print(secrets.token_hex(32))"
     ```
   - `PLEX_CLIENT_IDENTIFIER` — a stable ID for this app's Plex API requests, any UUID works:
     ```bash
     python3 -c "import uuid; print(uuid.uuid4())"
     ```

2. Build and start everything:

   ```bash
   docker compose up -d --build
   ```

3. Open the UI at `http://<this-machine's-address>:5173` (e.g. `http://192.168.1.50:5173`).
   Works from any device on your LAN — the API is served from that same address/port, no separate
   backend URL to configure.

## First run

1. **Create an account** (email/password) or **Login with Plex** on the first screen.
2. **Link a server** — either pick one from your Plex account's server list, or enter a `base_url`/token manually.
3. Go to the **Libraries** tab, click **Sync libraries**, and mark the ones you want rules/batches to
   be able to target as **Included**. (This doesn't affect protection — see below.)
4. Go to **Credits control** and click **Enable credits control**. This disables credits-marker
   generation on every existing item across the *entire server* (not just included libraries — the
   underlying Plex setting is server-wide) and turns Plex's global generation setting on. It's a real
   bulk operation against your Plex server — expect roughly 30 items/sec, so a few minutes for a large library.
5. From here you have several ways to actually generate markers:
   - **Manual, any granularity**: in the Libraries tab, click **Browse** on a library to drill into
     shows → seasons → episodes, each with its own **Scan** button.
   - **Rules**: create a rule (e.g. "recently watched, last 30 days") scoped to specific libraries.
     Applying it enables matching items and disables everything else in scope — re-running it later
     correctly turns items back off once they stop matching. Give it a `schedule_cron` to re-apply automatically.
   - **Batches**: a fixed list of Plex rating keys, run on demand or on a schedule.
   - **The Plex webhook** (recommended for real day-to-day use): in Plex, go to Settings → Webhooks →
     Add Webhook, and paste the URL shown in CreditEngine — find it under a server's settings
     (`/api/servers/{id}/webhooks/plex?secret=...`). Once added, watching something automatically enables
     that show and scans the next few unwatched-ahead episodes (5 by default) — not the whole series.

## Sonarr/Radarr (optional)

In a server's **Sonarr/Radarr** tab, link an instance with its base URL and API key, plus the address
this app is reachable at from wherever Sonarr/Radarr runs (not "localhost" unless they're on the same
machine). This pushes a Webhook connection into Sonarr/Radarr automatically — no manual setup on
their side. Newly imported content gets disabled immediately, before Plex's own scheduler would
otherwise pick it up. A periodic reconciliation pass (every 10 min) also catches anything added
outside Sonarr/Radarr, as a safety net.

## Known limitations

- **Credits markers only** — Plex doesn't expose a per-item override for intro-marker generation at
  all (confirmed against a real server), so intro detection stays fully global/all-or-nothing if you
  use it; this app doesn't attempt to control it.
- **Global setting is server-wide** — enabling credits control affects every library on the Plex
  server, not just ones marked "included" in this app. "Included" only controls which libraries
  rules/batches can target.
- No UI yet for changing the webhook lookahead count (`scrobble_lookahead_episodes`, default 5) —
  it's a per-server database field, adjustable via the API for now.
