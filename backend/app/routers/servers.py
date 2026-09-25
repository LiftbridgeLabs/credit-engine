import hashlib
import logging
import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import CachedItem, ServerConnection, User
from app.plex_client import (
    account_webhooks,
    connect,
    get_diagnostics,
    is_creditengine_webhook,
    redact_webhook,
    set_global_credits_behavior,
    update_account_webhooks,
)
from app.routers.libraries import sync_libraries_now
from app.security import get_current_user
from app.tasks import (
    bootstrap_credits_control,
    content_sync_started_at,
    request_content_sync_cancel,
    schedule_credits_recheck,
    sync_library_contents,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/servers", tags=["servers"])


class LinkServerRequest(BaseModel):
    name: str
    base_url: str
    token: str
    client_identifier: str | None = None


@router.post("")
def link_server(
    body: LinkServerRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Attach a Plex server to this account — either a connection picked from /auth/plex/servers,
    or a manually-entered base_url/token for users who skip Plex login entirely."""
    try:
        plex = connect(body.base_url, body.token)
    except Exception as exc:  # noqa: BLE001 — surface whatever plexapi/requests raised as a 400
        raise HTTPException(status_code=400, detail=f"Couldn't reach that server: {exc}")

    server = ServerConnection(
        owner_id=current_user.id,
        name=body.name,
        base_url=body.base_url,
        token=body.token,
        client_identifier=body.client_identifier,
        webhook_secret=secrets.token_urlsafe(32),
    )
    db.add(server)
    db.commit()
    db.refresh(server)

    # Best-effort — the server is already linked either way; the Libraries tab's own Sync button
    # is still there if this fails for some reason (transient network blip right after linking).
    try:
        sync_libraries_now(plex, server.id, db)
    except Exception:  # noqa: BLE001
        pass

    return server


def _with_sync_state(server: ServerConnection) -> dict:
    """A server plus whether a content sync is running on it. Read from the lock rather than stored
    on the row: the fact is owned by whichever worker holds it, and a database column would go
    stale the moment a worker died without clearing it."""
    started_at = content_sync_started_at(server.id)
    data = {c.name: getattr(server, c.name) for c in server.__table__.columns}
    data["content_sync_running"] = started_at is not None
    data["content_sync_started_at"] = started_at.isoformat() if started_at else None
    return data


@router.get("")
def list_servers(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    servers = db.query(ServerConnection).filter_by(owner_id=current_user.id).all()
    return [_with_sync_state(s) for s in servers]


@router.get("/{server_id}")
def get_server(server_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _get_owned_server(server_id, current_user, db)


@router.delete("/{server_id}")
def unlink_server(server_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    server = db.get(ServerConnection, server_id)
    if server is None or server.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Server not found")
    db.delete(server)
    db.commit()
    return {"deleted": True}


def _get_owned_server(server_id: int, current_user: User, db: Session) -> ServerConnection:
    server = db.get(ServerConnection, server_id)
    if server is None or server.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Server not found")
    return server


@router.get("/{server_id}/diagnostics")
def get_server_diagnostics(server_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Live read of every Plex-side setting that determines whether credits generation actually
    happens — not cached, so it always reflects reality even if something was changed directly
    in Plex outside this app."""
    server = _get_owned_server(server_id, current_user, db)
    try:
        plex = connect(server.base_url, server.token)
        return get_diagnostics(plex)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Couldn't reach that server: {exc}")


class PlexWebhookRequest(BaseModel):
    # Where Plex should reach *this app* — browsers know it (window.location.origin), the app
    # can't, since it may sit behind a proxy or be reached by a different name than it sees.
    callback_base_url: str


class PlexWebhookRemoveRequest(BaseModel):
    hook_id: str


def _expected_plex_webhook(server: ServerConnection, callback_base_url: str) -> str:
    return f"{callback_base_url.rstrip('/')}/api/servers/{server.id}/webhooks/plex?secret={server.webhook_secret}"


def _hook_id(url: str) -> str:
    """Opaque handle for one webhook, so the UI can ask to remove it without the URL (which
    carries a secret) ever leaving the server."""
    return hashlib.sha256(url.encode()).hexdigest()[:16]


def _account_token(user: User) -> str:
    if not user.plex_account_token:
        raise HTTPException(
            status_code=400,
            detail="This account isn't signed in with Plex, so there's no Plex account to manage webhooks in. "
            "Paste the URL into Plex → Settings → Webhooks yourself.",
        )
    return user.plex_account_token


@router.get("/{server_id}/plex-webhook")
def plex_webhook_status(
    server_id: int,
    callback_base_url: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Whether Plex is set up to tell this app when something is played, and whether it ever has.

    Only ever reports on webhooks that look like this app's (any instance) — an account's other
    webhooks belong to other services, and their URLs carry those services' tokens."""
    server = _get_owned_server(server_id, current_user, db)
    expected = _expected_plex_webhook(server, callback_base_url)

    status = {
        "expected_url": expected,
        "last_event_at": server.plex_webhook_last_event_at,
        "last_event": server.plex_webhook_last_event,
        "can_manage": bool(current_user.plex_account_token),
        "registered": None,
        "others": [],
        "error": None,
    }
    if not current_user.plex_account_token:
        return status

    try:
        hooks = account_webhooks(current_user.plex_account_token)
    except Exception as exc:  # noqa: BLE001
        status["error"] = f"Couldn't read your Plex account's webhooks: {exc}"
        return status

    status["registered"] = expected in hooks
    status["others"] = [
        {"hook_id": _hook_id(u), "url": redact_webhook(u)}
        for u in hooks
        if is_creditengine_webhook(u) and u != expected
    ]
    return status


@router.post("/{server_id}/plex-webhook/register")
def register_plex_webhook(
    server_id: int,
    body: PlexWebhookRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    server = _get_owned_server(server_id, current_user, db)
    token = _account_token(current_user)
    try:
        update_account_webhooks(token, add=[_expected_plex_webhook(server, body.callback_base_url)], remove=[])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Couldn't update your Plex account's webhooks: {exc}")
    logger.info("Registered Plex watch webhook for %s", server.name, extra={"server_id": server_id})
    return {"status": "registered"}


@router.post("/{server_id}/plex-webhook/remove")
def remove_plex_webhook(
    server_id: int,
    body: PlexWebhookRemoveRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Removes one of this app's *other* webhooks (a stale address, say). Deliberately one at a
    time and by explicit choice: a CreditEngine-shaped URL might be a second, perfectly healthy
    instance, which this app has no way to tell apart from a dead one."""
    _get_owned_server(server_id, current_user, db)
    token = _account_token(current_user)
    try:
        current = account_webhooks(token)
        matches = [u for u in current if is_creditengine_webhook(u) and _hook_id(u) == body.hook_id]
        if not matches:
            raise HTTPException(status_code=404, detail="That webhook is already gone")
        update_account_webhooks(token, add=[], remove=matches)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Couldn't update your Plex account's webhooks: {exc}")
    logger.info("Removed a Plex webhook: %s", redact_webhook(matches[0]), extra={"server_id": server_id})
    return {"status": "removed"}


@router.post("/{server_id}/credits-control/enable")
def enable_credits_control(server_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Kicks off the one-time bootstrap: disables credits-marker generation on every existing item
    across every section on the server, then flips the global gate on. Runs in the background —
    can take a long time on large libraries. Poll GET /servers/{id} for credits_control_bootstrapped_at."""
    server = _get_owned_server(server_id, current_user, db)
    if server.credits_control_enabled:
        raise HTTPException(status_code=400, detail="Credits control is already enabled for this server")

    bootstrap_credits_control.delay(server_id)
    return {"status": "bootstrap_started"}


@router.post("/{server_id}/credits-control/run-detection")
def run_credits_detection_now(server_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Starts Plex's own credits-detection task right now instead of waiting for its maintenance
    window. What it processes is still decided by the per-show flags — so this is "generate for
    everything I've enabled, now", not "scan the library". Refused unless credits control has been
    set up: without that, nothing is opted out and this would mean every item on the server."""
    server = _get_owned_server(server_id, current_user, db)
    if not server.credits_control_enabled:
        raise HTTPException(
            status_code=400,
            detail="Credits control isn't enabled for this server, so nothing is opted out yet — running "
            "detection now would process every item, not just the ones you've chosen.",
        )
    try:
        plex = connect(server.base_url, server.token)
        plex.runButlerTask("ButlerTaskGenerateCreditsMarkers")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Couldn't start credits detection: {exc}")
    logger.info("Started Plex credits detection on demand for %s", server.name, extra={"server_id": server_id})
    enabled = db.query(CachedItem.rating_key).filter(
        CachedItem.server_id == server_id,
        CachedItem.type.in_(["show", "movie"]),
        CachedItem.credits_enabled.is_(True),
    )
    for row in enabled:
        schedule_credits_recheck(server_id, row.rating_key)
    return {"status": "started"}


@router.post("/{server_id}/credits-control/disable")
def disable_credits_control(server_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Turns the global gate back off. Per-item overrides are left as-is rather than bulk-reverted —
    they're inert once the global setting is 'never', and reverting them is an expensive pass with
    no functional benefit."""
    server = _get_owned_server(server_id, current_user, db)

    try:
        plex = connect(server.base_url, server.token)
        set_global_credits_behavior(plex, "never")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Couldn't reach that server: {exc}")

    server.credits_control_enabled = False
    db.commit()
    return {"status": "disabled"}


@router.post("/{server_id}/sync-content")
def sync_content(server_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Snapshots every included library's structure (titles, ordering, thumb availability) so
    browsing doesn't have to hit Plex live every time. Runs in the background, can take a while on a
    large library, same pattern as the credits-control bootstrap.

    This is the "don't wait for the next pass" button, not the only way the cache is ever
    refreshed — tasks.check_content_sync rebuilds it on an interval too."""
    server = _get_owned_server(server_id, current_user, db)
    # Only one sync runs per server (tasks._content_sync_lock), so a second request is dropped on
    # arrival. Reporting "started" for a request that's really going to be discarded is exactly the
    # kind of silent no-op that makes a stale cache hard to notice. The start time goes back with
    # it so "already running" can be sanity-checked rather than taken on faith.
    started_at = content_sync_started_at(server.id)
    if started_at is not None:
        return {"status": "already_running", "started_at": started_at.isoformat()}
    sync_library_contents.delay(server_id)
    return {"status": "sync_started"}


@router.post("/{server_id}/sync-content/cancel")
def cancel_sync_content(server_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Stop a running content sync, or clear a lock left behind by one that died.

    Both used to require deleting a Redis key from a shell, which is not a reasonable thing to ask
    of anyone using the app. See tasks.request_content_sync_cancel for why stopping a live sync
    can't just be that delete."""
    server = _get_owned_server(server_id, current_user, db)
    return {"status": request_content_sync_cancel(server.id)}
