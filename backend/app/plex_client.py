import time
from datetime import datetime, timedelta

import httpx
from plexapi.exceptions import NotFound
from plexapi.server import PlexServer

from app.config import settings

PLEX_TV_BASE = "https://plex.tv"

# Analyze on a Show can span many episodes and take well past plexapi's 30s default. Passed
# explicitly to PlexServer() rather than set via the plexapi.TIMEOUT module global — that global
# gets copied into a local binding inside plexapi.server at import time, so mutating it afterward
# (as this code used to do) is silently a no-op.
PLEX_REQUEST_TIMEOUT = 600


class PlexAuthPending(Exception):
    """The user hasn't approved the PIN yet."""


class PlexAuthExpired(Exception):
    """The PIN expired before the user approved it."""


def _headers() -> dict:
    return {
        "X-Plex-Client-Identifier": settings.plex_client_identifier,
        "X-Plex-Product": settings.plex_product,
        "Accept": "application/json",
    }


def create_pin() -> dict:
    """Request a new PIN. Returns {id, code} — code goes into the auth URL, id is used to poll."""
    resp = httpx.post(f"{PLEX_TV_BASE}/api/v2/pins", headers=_headers(), params={"strong": "true"})
    resp.raise_for_status()
    return resp.json()


def auth_url(pin_code: str, forward_url: str | None = None) -> str:
    params = f"clientID={settings.plex_client_identifier}&code={pin_code}&context%5Bdevice%5D%5Bproduct%5D={settings.plex_product}"
    if forward_url:
        params += f"&forwardUrl={forward_url}"
    return f"https://app.plex.tv/auth#?{params}"


def poll_pin(pin_id: int) -> str:
    """Returns the auth token once the user has approved the PIN. Raises PlexAuthPending until then.

    Plex deletes a PIN once it's been successfully claimed, so polling an already-claimed PIN
    returns 404 — treated the same as expired, since neither is recoverable by polling again.
    """
    resp = httpx.get(f"{PLEX_TV_BASE}/api/v2/pins/{pin_id}", headers=_headers())
    if resp.status_code == 404:
        raise PlexAuthExpired()
    resp.raise_for_status()
    data = resp.json()
    token = data.get("authToken")
    if token:
        return token
    if data.get("expiresIn", 1) <= 0:
        raise PlexAuthExpired()
    raise PlexAuthPending()


def wait_for_pin(pin_id: int, timeout_seconds: int = 120, interval_seconds: int = 2) -> str:
    """Blocking convenience wrapper for CLI/dev use. The API route should poll client-side instead."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            return poll_pin(pin_id)
        except PlexAuthPending:
            time.sleep(interval_seconds)
    raise PlexAuthExpired()


def connect(base_url: str, token: str) -> PlexServer:
    return PlexServer(base_url, token, timeout=PLEX_REQUEST_TIMEOUT)


def fetch_account(account_token: str) -> dict:
    """Basic identity of the Plex account behind a token — used to link/create a CreditEngine user."""
    resp = httpx.get(
        f"{PLEX_TV_BASE}/api/v2/user",
        headers={**_headers(), "X-Plex-Token": account_token},
    )
    resp.raise_for_status()
    data = resp.json()
    return {"id": data["id"], "username": data.get("username") or data.get("title")}


def fetch_servers(account_token: str) -> list[dict]:
    """Every Plex Media Server this account can reach, with connection URIs and a server-scoped access token.

    Each connection is a candidate base_url — callers should try `local` connections first and fall back
    to remote/relay ones, since local is faster and doesn't route through Plex's relay.
    """
    resp = httpx.get(
        f"{PLEX_TV_BASE}/api/v2/resources",
        headers={**_headers(), "X-Plex-Token": account_token},
        params={"includeHttps": "1", "includeRelay": "1"},
    )
    resp.raise_for_status()

    servers = []
    for resource in resp.json():
        if "server" not in resource.get("provides", ""):
            continue
        servers.append(
            {
                "name": resource["name"],
                "client_identifier": resource["clientIdentifier"],
                "access_token": resource["accessToken"],
                "owned": resource.get("owned", False),
                "connections": [
                    {"uri": c["uri"], "local": c.get("local", False), "relay": c.get("relay", False)}
                    for c in resource.get("connections", [])
                ],
            }
        )
    return servers


def apply_credits_rule(plex: PlexServer, section_keys: list[int], criteria: dict) -> dict:
    """Full enable/disable pass over the rule's target sections: matches get their credits-marker
    override reverted to inherit (enabled), everything else gets forced off. Re-running a rule after
    an item stops matching (e.g. no longer "recently watched") correctly turns it back off."""
    criteria_type = criteria.get("type")
    if criteria_type != "recently_watched":
        raise ValueError(f"Unsupported rule criteria type: {criteria_type!r}")

    cutoff = datetime.utcnow() - timedelta(days=criteria["days"])

    enabled_titles = []
    disabled_count = 0
    for key in section_keys:
        section = plex.library.sectionByID(key)
        for item in section.all():
            if item.lastViewedAt is not None and item.lastViewedAt >= cutoff:
                enable_item_credits(item)
                enabled_titles.append(item.title)
            else:
                disable_item_credits(item)
                disabled_count += 1

    return {"enabled": enabled_titles, "disabled_count": disabled_count}


def enable_item_credits(item) -> bool:
    """Revert an item's credits-marker override to 'inherit library default'.

    There is no per-item 'force enabled' — only -1 (inherit) or 0 (disabled). This only produces
    the desired effect if the library/global default is actually on; see set_global_credits_behavior.

    Returns False (without raising) if this item simply doesn't expose the preference at all —
    true for some movies/items depending on metadata agent. Nothing we can do about those.
    """
    try:
        item.editAdvanced(enableCreditsMarkerGeneration=-1)
        return True
    except NotFound:
        return False


def disable_item_credits(item) -> bool:
    """Force credits-marker generation off for a single item, overriding the library default.
    Returns False (without raising) if this item doesn't expose the preference — see enable_item_credits."""
    try:
        item.editAdvanced(enableCreditsMarkerGeneration=0)
        return True
    except NotFound:
        return False


def check_has_credits(plex: PlexServer, rating_key: int) -> bool:
    """Whether Plex has already generated a credits marker for this item — true per-item concept,
    works for any leaf video (movie or episode). The one part of syncing that can't be answered
    from a bulk listing: Plex only exposes markers via a full per-item fetch, never inline in bulk
    results (confirmed empirically — bulk requests with includeMarkers=1 still come back with zero
    Marker elements), so this is a real network round trip per item, meant to be run in parallel
    across many items rather than called in a loop."""
    item = plex.fetchItem(rating_key)
    return any(m.type == "credits" for m in (item.markers or []))


def check_credits_enabled(item) -> bool | None:
    """Whether generation is currently allowed by this item's own per-item override. Only
    Movie/Show/Season expose this preference — Episode does not, because Plex's own credits
    generation setting only ever applies at the show (or movie) level, never per individual
    episode; this app has only ever set/read it at that granularity too (see enable_item_credits).
    Callers checking an episode's status should use its parent show's value instead of calling this
    on the episode itself, which would raise.

    None if the item doesn't expose the preference at all (some movies, depending on metadata
    agent) — genuinely unknown, not "disabled". Takes an already-fetched item, not a rating key —
    unlike check_has_credits, this is cheap enough (no extra round trip; the preference call is the
    expensive part, already being paid for) to call on objects you already have in hand from a bulk
    listing."""
    try:
        pref = item.preference("enableCreditsMarkerGeneration")
        return pref.value != 0 if pref else None
    except NotFound:
        return None


def get_global_credits_behavior(plex: PlexServer) -> str:
    """One of 'never', 'scheduled', 'asap' — the server-wide gate. 'never' blocks even explicit
    per-item Analyze calls; anything else also enables Plex's own automatic Butler sweep."""
    plex.settings.reload()
    return plex.settings.get("GenerateCreditsMarkerBehavior").value


def set_global_credits_behavior(plex: PlexServer, behavior: str) -> None:
    plex.settings.get("GenerateCreditsMarkerBehavior").set(behavior)
    plex.settings.save()


def iter_all_sections(plex: PlexServer):
    """Every library section on the server, movie and show alike."""
    return [s for s in plex.library.sections() if s.type in ("movie", "show")]


def describe_item(item) -> str:
    """Human-readable label for a Plex item — "rating key 38129" means nothing to a user,
    but "3 Body Problem — S01E01 — Countdown" does."""
    if item.type == "episode":
        return f"{item.grandparentTitle} — S{item.seasonNumber:02}E{item.episodeNumber:02} — {item.title}"
    if item.type == "season":
        return f"{item.parentTitle} — {item.title}"
    return item.title


def get_diagnostics(plex: PlexServer) -> dict:
    """A live snapshot of every Plex-side setting that determines whether credits generation
    actually happens — spans three independent tiers (global, per-library, per-item) that all
    have to line up. Read fresh from Plex every time, not cached, so drift (someone changing a
    setting directly in Plex) is always caught rather than trusted from our own DB state."""
    plex.settings.reload()
    global_behavior = plex.settings.get("GenerateCreditsMarkerBehavior").value

    butler_task = next((t for t in plex.butlerTasks() if t.name == "ButlerTaskGenerateCreditsMarkers"), None)
    butler_start = plex.settings.get("ButlerStartHour").value
    butler_end = plex.settings.get("ButlerEndHour").value

    libraries = []
    for section in iter_all_sections(plex):
        section_settings = {s.id: s.value for s in section.settings()}
        libraries.append(
            {
                "section_id": section.key,
                "title": section.title,
                "credits_detection_enabled": bool(section_settings.get("enableCreditsMarkerGeneration", False)),
            }
        )

    return {
        "global_behavior": global_behavior,
        "butler_task_enabled": bool(butler_task.enabled) if butler_task else False,
        "butler_window": {"start_hour": butler_start, "end_hour": butler_end},
        "libraries": libraries,
    }


def find_items_added_since(section, since: datetime) -> list:
    """Cheap, addedAt-indexed lookup — used by reconciliation so it only touches new items,
    not the whole library, on every pass."""
    return section.search(filters={"addedAt>>": since})


def browse_top_level(plex: PlexServer, section_id: int) -> list:
    """Shows (for a TV section) or movies (for a movie section) directly under a library section."""
    return plex.library.sectionByID(section_id).all()


def browse_children(plex: PlexServer, rating_key: int):
    """Seasons under a show, or episodes under a season. Empty for movies/episodes (leaf nodes)."""
    item = plex.fetchItem(rating_key)
    if item.type == "show":
        return item.seasons()
    if item.type == "season":
        return item.episodes()
    return []


def browse_all_episodes(plex: PlexServer, rating_key: int):
    """Every episode under a show or season, flattened — one Plex API call either way (plexapi's
    .episodes() hits Plex's "all leaves" endpoint directly rather than us walking seasons one by one).

    This is the safe way to offer "add this whole season/show" as a bulk-pick convenience: each
    episode still becomes its own individual scan target, so Plex's per-item analyze() is only ever
    called on leaf items — never on the season/show rating key itself, which is what would cascade
    into an uncontrolled full-show sweep (see the leaf-only guardrail in tasks.py/scans.py)."""
    item = plex.fetchItem(rating_key)
    if item.type in ("show", "season"):
        return item.episodes()
    return []


def find_lookahead_episodes(episode, count: int) -> list:
    """Up to `count` episodes starting from this one (inclusive), in show order, skipping any
    that already have markers. Bounded on purpose — a 20-season show shouldn't get scanned in
    full just because someone started watching season 1.
    """
    show = episode.show()
    all_episodes = sorted(show.episodes(), key=lambda e: (e.seasonNumber, e.episodeNumber))
    try:
        start_idx = next(
            i
            for i, e in enumerate(all_episodes)
            if e.seasonNumber == episode.seasonNumber and e.episodeNumber == episode.episodeNumber
        )
    except StopIteration:
        return []
    candidates = all_episodes[start_idx : start_idx + count]
    return [e for e in candidates if not e.markers]


def find_item_by_title_and_guid(plex: PlexServer, section_type: str, title: str, guid_fragment: str):
    """Best-effort match for a freshly-imported item, keyed by a Sonarr/Radarr webhook payload.

    Searches by title within sections of the right type first (cheap — no per-item fetch needed).
    Only falls back to checking each candidate's external-ID guids (tvdb://, tmdb://, imdb://) when
    the title match is ambiguous, since that requires an extra fetch per candidate.
    """
    candidates = []
    for section in iter_all_sections(plex):
        if section.type != section_type:
            continue
        candidates.extend(section.search(title=title))

    if len(candidates) == 1:
        return candidates[0]
    for item in candidates:
        if any(guid_fragment in g.id for g in item.guids):
            return item
    return None


def analyze_item(item) -> None:
    """Triggers Plex's per-item Analyze action (loudness, chapter thumbnails, intro/credit detection).

    Only actually performs credits detection when the global GenerateCreditsMarkerBehavior isn't 'never'.
    """
    item.analyze()
