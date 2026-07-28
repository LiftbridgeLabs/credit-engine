from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import AppSettings, LogEntry, User
from app.security import get_current_user

router = APIRouter(prefix="/logs", tags=["logs"])
settings_router = APIRouter(prefix="/settings", tags=["settings"])

_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


@router.get("")
def list_logs(
    since_id: int = 0,
    level: str = "INFO",
    server_id: int | None = None,
    limit: int = 500,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Tail-style polling: pass since_id=<highest id you've already seen> to get only what's new,
    ordered oldest-first so it appends naturally. Omit since_id (or pass 0) for the initial page —
    that returns the most recent `limit` rows instead of the oldest ones in the table."""
    if level not in _LEVELS:
        raise HTTPException(status_code=400, detail=f"level must be one of {_LEVELS}")
    allowed_levels = _LEVELS[_LEVELS.index(level):]

    query = db.query(LogEntry).filter(LogEntry.level.in_(allowed_levels))
    if server_id is not None:
        query = query.filter(LogEntry.server_id == server_id)

    if since_id > 0:
        return query.filter(LogEntry.id > since_id).order_by(LogEntry.id.asc()).limit(limit).all()

    return list(reversed(query.order_by(LogEntry.id.desc()).limit(limit).all()))


@router.delete("")
def clear_logs(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deleted = db.query(LogEntry).delete()
    db.commit()
    return {"deleted": deleted}


def _get_or_create_settings(db: Session) -> AppSettings:
    cfg = db.get(AppSettings, 1)
    if cfg is None:
        cfg = AppSettings(id=1)
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    return cfg


class LogSettingsRequest(BaseModel):
    log_max_entries: int
    log_retention_days: int


@settings_router.get("/logs")
def get_log_settings(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _get_or_create_settings(db)


@settings_router.patch("/logs")
def update_log_settings(
    body: LogSettingsRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if body.log_max_entries < 100:
        raise HTTPException(status_code=400, detail="Max entries must be at least 100")
    if body.log_retention_days < 1:
        raise HTTPException(status_code=400, detail="Retention must be at least 1 day")

    cfg = _get_or_create_settings(db)
    cfg.log_max_entries = body.log_max_entries
    cfg.log_retention_days = body.log_retention_days
    db.commit()
    db.refresh(cfg)
    return cfg
