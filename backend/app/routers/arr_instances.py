from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.arr_client import create_webhook_connection, delete_webhook_connection, test_connection, test_webhook_connection
from app.db import get_db
from app.models import ArrInstance, ServerConnection, User
from app.security import get_current_user

router = APIRouter(prefix="/servers/{server_id}/arr-instances", tags=["arr-instances"])


class LinkArrRequest(BaseModel):
    type: str  # "sonarr" | "radarr"
    base_url: str
    api_key: str
    # Address Sonarr/Radarr should use to reach *this* app — not secret, just network topology,
    # so it's a plain form field rather than server-side config.
    callback_base_url: str


def _get_owned_server(server_id: int, current_user: User, db: Session) -> ServerConnection:
    server = db.get(ServerConnection, server_id)
    if server is None or server.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Server not found")
    return server


@router.post("")
def link_arr_instance(
    server_id: int,
    body: LinkArrRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Validates the Sonarr/Radarr connection, then pushes a Webhook notification into it
    pointed at this server's /webhooks/import endpoint — no manual copy-pasting required."""
    if body.type not in ("sonarr", "radarr"):
        raise HTTPException(status_code=400, detail="type must be 'sonarr' or 'radarr'")

    server = _get_owned_server(server_id, current_user, db)

    try:
        test_connection(body.base_url, body.api_key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Couldn't reach {body.type}: {exc}")

    callback_base = body.callback_base_url.rstrip("/")
    webhook_url = f"{callback_base}/api/servers/{server_id}/webhooks/import?secret={server.webhook_secret}"

    try:
        notification_id = create_webhook_connection(body.base_url, body.api_key, webhook_url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Couldn't create the webhook connection: {exc}")

    try:
        # Best effort — if this fails, the connection still exists and gets verified whenever
        # Sonarr/Radarr next fires it (a real import, or the user clicking Test manually).
        test_webhook_connection(body.base_url, body.api_key, webhook_url)
    except Exception:  # noqa: BLE001
        pass

    instance = ArrInstance(
        server_id=server_id,
        type=body.type,
        base_url=body.base_url,
        api_key=body.api_key,
        notification_id=notification_id,
    )
    db.add(instance)
    db.commit()
    db.refresh(instance)
    return instance


@router.get("")
def list_arr_instances(server_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _get_owned_server(server_id, current_user, db)
    return db.query(ArrInstance).filter_by(server_id=server_id).all()


@router.delete("/{instance_id}")
def unlink_arr_instance(
    server_id: int,
    instance_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_owned_server(server_id, current_user, db)
    instance = db.query(ArrInstance).filter_by(id=instance_id, server_id=server_id).first()
    if instance is None:
        raise HTTPException(status_code=404, detail="Arr instance not found")

    if instance.notification_id is not None:
        try:
            delete_webhook_connection(instance.base_url, instance.api_key, instance.notification_id)
        except Exception:  # noqa: BLE001 — best effort, don't block unlinking on this
            pass

    db.delete(instance)
    db.commit()
    return {"deleted": True}
