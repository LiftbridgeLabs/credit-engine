import json
import logging
import secrets as secrets_module
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Form, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import ServerConnection
from app.tasks import handle_import_webhook, handle_plex_scrobble

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/servers/{server_id}/webhooks", tags=["webhooks"])

_WATCH_EVENTS = {"media.play", "media.scrobble"}


@router.post("/import")
def receive_import_webhook(server_id: int, secret: str, payload: dict, db: Session = Depends(get_db)):
    """Point a Sonarr/Radarr 'On Import' connection at this URL with ?secret=<server's webhook_secret>.
    No user auth here — Sonarr/Radarr can't do our login flow, so the secret in the URL is the gate."""
    server = db.get(ServerConnection, server_id)
    if server is None or not secrets_module.compare_digest(server.webhook_secret, secret):
        raise HTTPException(status_code=404, detail="Not found")

    if payload.get("eventType") == "Test":
        server.webhook_verified_at = datetime.now(timezone.utc)
        db.commit()
        logger.info("Sonarr/Radarr webhook verified for %s", server.name, extra={"server_id": server_id})
        return {"status": "verified"}

    if not server.credits_control_enabled:
        return {"status": "ignored", "reason": "credits control not enabled for this server"}

    handle_import_webhook.delay(server_id, payload)
    return {"status": "queued"}


@router.post("/plex")
def receive_plex_webhook(server_id: int, secret: str, payload: str = Form(...), db: Session = Depends(get_db)):
    """Point Plex's Settings > Webhooks at this URL with ?secret=<server's webhook_secret>. Plex
    sends multipart/form-data with the JSON payload in a 'payload' field — not a plain JSON body."""
    server = db.get(ServerConnection, server_id)
    if server is None or not secrets_module.compare_digest(server.webhook_secret, secret):
        raise HTTPException(status_code=404, detail="Not found")

    try:
        data = json.loads(payload)
    except ValueError:
        raise HTTPException(status_code=400, detail="payload isn't valid JSON")
    event = data.get("event", "unknown")
    metadata = data.get("Metadata", {})
    label = metadata.get("grandparentTitle") or metadata.get("title") or "?"

    # Recorded before anything can decide to ignore the event: this is the delivery receipt. Without
    # it, "Plex isn't calling us" and "Plex calls us and we quietly skip it" are indistinguishable.
    server.plex_webhook_last_event_at = datetime.now(timezone.utc)
    server.plex_webhook_last_event = f"{event}: {label}"[:200]
    db.commit()
    logger.info("Plex webhook %s — %s", event, label, extra={"server_id": server_id})

    if not server.credits_control_enabled:
        return {"status": "ignored", "reason": "credits control not enabled for this server"}

    # Playback only: Plex sends nothing when an item is manually marked watched, so bulk-marking a
    # pile of shows as "not interested" can't trigger enabling and scanning them. media.play fires
    # when playback *starts* — early enough for the lookahead scans to finish before the next
    # episode's credits — and media.scrobble (90% watched) is the backstop if that one was missed.
    if event in _WATCH_EVENTS and metadata.get("type") in ("episode", "movie"):
        # Plex sends ratingKey as a string in the webhook payload, not a JSON number.
        handle_plex_scrobble.delay(server_id, int(metadata["ratingKey"]))

    return {"status": "ok"}
