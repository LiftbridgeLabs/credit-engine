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

    if not server.credits_control_enabled:
        return {"status": "ignored", "reason": "credits control not enabled for this server"}

    data = json.loads(payload)
    metadata = data.get("Metadata", {})
    if data.get("event") == "media.scrobble" and metadata.get("type") in ("episode", "movie"):
        # Plex sends ratingKey as a string in the webhook payload, not a JSON number.
        handle_plex_scrobble.delay(server_id, int(metadata["ratingKey"]))

    return {"status": "ok"}
