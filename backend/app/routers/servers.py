import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import ServerConnection, User
from app.plex_client import connect, get_diagnostics, set_global_credits_behavior
from app.security import get_current_user
from app.tasks import bootstrap_credits_control

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
        connect(body.base_url, body.token)
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
    return server


@router.get("")
def list_servers(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.query(ServerConnection).filter_by(owner_id=current_user.id).all()


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
