from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import ScanJob, ServerConnection, User
from app.plex_client import connect
from app.security import get_current_user
from app.tasks import run_scan_job

router = APIRouter(prefix="/servers/{server_id}/scans", tags=["scans"])


def _get_owned_server(server_id: int, current_user: User, db: Session) -> ServerConnection:
    server = db.get(ServerConnection, server_id)
    if server is None or server.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Server not found")
    return server


@router.post("")
def queue_scan(
    server_id: int,
    rating_key: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Queue an on-demand analyze for a single movie or episode.

    Deliberately leaf-items-only: Plex's analyze action cascades to every child of a show/season,
    so a container's rating key here would silently turn a targeted, on-demand scan into a full-show
    sweep — exactly the "overload while people are watching" scenario this app exists to avoid. The
    item picker already only offers leaf items; this catches the "enter a rating key directly"
    manual-entry path, which has no client-side type information. run_scan_job re-checks this too,
    since batches create ScanJob rows directly and don't go through this endpoint.
    """
    server = _get_owned_server(server_id, current_user, db)

    try:
        plex = connect(server.base_url, server.token)
        item = plex.fetchItem(rating_key)
    except Exception as exc:  # noqa: BLE001 — surface whatever plexapi/requests raised as a 400
        raise HTTPException(status_code=400, detail=f"Couldn't look up that rating key: {exc}")

    if item.type not in ("movie", "episode"):
        raise HTTPException(
            status_code=400,
            detail=f"Rating key {rating_key} is a {item.type}, not a movie or episode — "
            "scanning it would analyze everything underneath it. Pick a specific episode instead.",
        )

    job = ScanJob(server_id=server_id, rating_key=rating_key)
    db.add(job)
    db.commit()
    db.refresh(job)

    run_scan_job.delay(job.id)
    return job


@router.get("/{job_id}")
def get_scan(
    server_id: int,
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_owned_server(server_id, current_user, db)
    job = db.query(ScanJob).filter_by(id=job_id, server_id=server_id).first()
    if job is None:
        raise HTTPException(status_code=404, detail="Scan job not found")
    return job


@router.get("")
def list_scans(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_owned_server(server_id, current_user, db)
    return db.query(ScanJob).filter_by(server_id=server_id).order_by(ScanJob.created_at.desc()).limit(100).all()
