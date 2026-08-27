---
name: plex-api
description: Use when writing, reviewing, or debugging code that talks to the Plex Media Server API or plex.tv API — authentication, library/metadata access, playback control, webhooks, or client SDKs. Triggers on mentions of "Plex API", "PlexAPI", "plex.tv", "X-Plex-Token", or Plex server/client integration work in this project.
---

# Plex API Reference

Before writing or modifying code that calls the Plex API, consult current documentation rather than relying on training data alone — Plex's API surface changes, and endpoints get added or deprecated over time.

## Reference links

- **Official Plex Developer Portal** — https://developer.plex.tv/ — authentication (X-Plex-Token), API overview, general developer resources.
- **Plex API SDKs** — https://plexapi.dev/SDKs — official/community SDKs across languages; check here before hand-rolling a client from scratch.
- **plexswift (GitHub)** — https://github.com/LukasParke/plexswift — a Swift client implementation; useful as a reference for endpoint shapes and request/response structures even outside Swift.

## How to use these

1. When a task in this project touches Plex (auth, library scanning, metadata, playback control, webhooks, etc.), fetch the relevant page(s) above with WebFetch before writing code — don't assume endpoint names or parameters purely from memory.
2. If plexapi.dev/SDKs lists an SDK in this project's language, prefer wrapping or mirroring its approach over a fully custom client, unless there's a stated reason not to.
3. Cross-check plexswift's implementation when the official docs are thin on a specific endpoint — it's a working reference implementation of the API surface.
4. Note auth requirements (X-Plex-Token, client identifiers/headers) up front, since most endpoints require them.
5. If these links 404 or the docs look substantially different from what's described here, say so rather than silently guessing.
