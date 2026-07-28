from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Library, ServerConnection, User
from app.plex_client import connect
from app.security import get_current_user

router = APIRouter(prefix="/servers/{server_id}/libraries", tags=["libraries"])


def _get_owned_server(server_id: int, current_user: User, db: Session) -> ServerConnection:
    server = db.get(ServerConnection, server_id)
    if server is None or server.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Server not found")
    return server


@router.post("/sync")
def sync_libraries(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Pull the current library list from Plex and upsert it locally."""
    server = _get_owned_server(server_id, current_user, db)
    plex = connect(server.base_url, server.token)

    existing = {lib.section_id: lib for lib in db.query(Library).filter_by(server_id=server.id)}
    seen_section_ids = set()

    for section in plex.library.sections():
        seen_section_ids.add(section.key)
        if section.key in existing:
            existing[section.key].title = section.title
            existing[section.key].type = section.type
        else:
            db.add(Library(server_id=server.id, section_id=section.key, title=section.title, type=section.type))

    for section_id, lib in existing.items():
        if section_id not in seen_section_ids:
            db.delete(lib)

    db.commit()
    return {"synced": len(seen_section_ids)}


@router.get("")
def list_libraries(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    server = _get_owned_server(server_id, current_user, db)
    return db.query(Library).filter_by(server_id=server.id).all()


@router.patch("/{library_id}")
def set_included(
    server_id: int,
    library_id: int,
    included: bool,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_owned_server(server_id, current_user, db)
    lib = db.query(Library).filter_by(id=library_id, server_id=server_id).first()
    if lib is None:
        raise HTTPException(status_code=404, detail="Library not found")
    lib.included = included
    db.commit()
    db.refresh(lib)
    return lib
