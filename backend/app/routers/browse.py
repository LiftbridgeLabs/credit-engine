from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import ServerConnection, User
from app.plex_client import browse_children, browse_top_level, connect
from app.security import get_current_user

router = APIRouter(prefix="/servers/{server_id}/browse", tags=["browse"])


def _get_owned_server(server_id: int, current_user: User, db: Session) -> ServerConnection:
    server = db.get(ServerConnection, server_id)
    if server is None or server.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Server not found")
    return server


def _serialize(item) -> dict:
    return {
        "rating_key": item.ratingKey,
        "title": item.title,
        "type": item.type,
        "index": getattr(item, "index", None),
        "season_number": getattr(item, "seasonNumber", None) if item.type == "episode" else None,
        "has_children": item.type in ("show", "season"),
    }


@router.get("")
def browse_section(
    server_id: int,
    section_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Top-level items (shows or movies) directly under a library section."""
    server = _get_owned_server(server_id, current_user, db)
    try:
        plex = connect(server.base_url, server.token)
        items = browse_top_level(plex, section_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Couldn't browse that section: {exc}")
    return [_serialize(i) for i in items]


@router.get("/{rating_key}/children")
def browse_item_children(
    server_id: int,
    rating_key: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Seasons under a show, or episodes under a season."""
    server = _get_owned_server(server_id, current_user, db)
    try:
        plex = connect(server.base_url, server.token)
        items = browse_children(plex, rating_key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Couldn't browse that item: {exc}")
    return [_serialize(i) for i in items]
