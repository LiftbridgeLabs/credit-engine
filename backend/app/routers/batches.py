from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import ScanBatch, ServerConnection, User
from app.security import get_current_user
from app.tasks import queue_batch_scan

router = APIRouter(prefix="/servers/{server_id}/batches", tags=["batches"])


class BatchRequest(BaseModel):
    name: str
    rating_keys: list[int]
    schedule_cron: str | None = None


def _get_owned_server(server_id: int, current_user: User, db: Session) -> ServerConnection:
    server = db.get(ServerConnection, server_id)
    if server is None or server.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Server not found")
    return server


def _get_owned_batch(server_id: int, batch_id: int, current_user: User, db: Session) -> ScanBatch:
    _get_owned_server(server_id, current_user, db)
    batch = db.query(ScanBatch).filter_by(id=batch_id, server_id=server_id).first()
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    return batch


@router.post("")
def create_batch(
    server_id: int,
    body: BatchRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_owned_server(server_id, current_user, db)
    batch = ScanBatch(server_id=server_id, **body.model_dump())
    db.add(batch)
    db.commit()
    db.refresh(batch)
    return batch


@router.get("")
def list_batches(server_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _get_owned_server(server_id, current_user, db)
    return db.query(ScanBatch).filter_by(server_id=server_id).all()


@router.patch("/{batch_id}")
def update_batch(
    server_id: int,
    batch_id: int,
    body: BatchRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    batch = _get_owned_batch(server_id, batch_id, current_user, db)
    for field, value in body.model_dump().items():
        setattr(batch, field, value)
    db.commit()
    db.refresh(batch)
    return batch


@router.delete("/{batch_id}")
def delete_batch(
    server_id: int,
    batch_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    batch = _get_owned_batch(server_id, batch_id, current_user, db)
    db.delete(batch)
    db.commit()
    return {"deleted": True}


@router.post("/{batch_id}/run")
def run_batch_now(
    server_id: int,
    batch_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Queue an analyze job for every item in the batch, right now."""
    batch = _get_owned_batch(server_id, batch_id, current_user, db)
    job_ids = queue_batch_scan(db, batch)
    return {"queued": len(job_ids), "job_ids": job_ids}
