import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Library, ScanRule, ServerConnection, User
from app.plex_client import apply_credits_rule, connect
from app.security import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/servers/{server_id}/rules", tags=["rules"])


class RuleRequest(BaseModel):
    name: str
    enabled: bool = True
    criteria: dict
    schedule_cron: str | None = None


def _get_owned_server(server_id: int, current_user: User, db: Session) -> ServerConnection:
    server = db.get(ServerConnection, server_id)
    if server is None or server.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Server not found")
    return server


def _get_owned_rule(server_id: int, rule_id: int, current_user: User, db: Session) -> ScanRule:
    _get_owned_server(server_id, current_user, db)
    rule = db.query(ScanRule).filter_by(id=rule_id, server_id=server_id).first()
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    return rule


@router.post("")
def create_rule(
    server_id: int,
    body: RuleRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_owned_server(server_id, current_user, db)
    rule = ScanRule(server_id=server_id, **body.model_dump())
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


@router.get("")
def list_rules(server_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _get_owned_server(server_id, current_user, db)
    return db.query(ScanRule).filter_by(server_id=server_id).all()


@router.patch("/{rule_id}")
def update_rule(
    server_id: int,
    rule_id: int,
    body: RuleRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rule = _get_owned_rule(server_id, rule_id, current_user, db)
    for field, value in body.model_dump().items():
        setattr(rule, field, value)
    db.commit()
    db.refresh(rule)
    return rule


@router.delete("/{rule_id}")
def delete_rule(
    server_id: int,
    rule_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rule = _get_owned_rule(server_id, rule_id, current_user, db)
    db.delete(rule)
    db.commit()
    return {"deleted": True}


@router.post("/{rule_id}/apply")
def apply_rule(
    server_id: int,
    rule_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Evaluate the rule right now: matching items get credits generation enabled, everything
    else in scope gets it disabled (so a show that's no longer "recently watched" loses it again)."""
    server = _get_owned_server(server_id, current_user, db)
    rule = _get_owned_rule(server_id, rule_id, current_user, db)

    if not server.credits_control_enabled:
        raise HTTPException(
            status_code=400,
            detail="Credits control isn't bootstrapped for this server yet — run the bootstrap first",
        )

    section_keys = [
        lib.section_id
        for lib in db.query(Library).filter(Library.id.in_(rule.criteria.get("library_ids", [])), Library.server_id == server_id)
    ]
    if not section_keys:
        raise HTTPException(status_code=400, detail="Rule's criteria doesn't reference any libraries on this server")

    try:
        plex = connect(server.base_url, server.token)
        result = apply_credits_rule(plex, section_keys, rule.criteria)
    except Exception as exc:  # noqa: BLE001 — surface whatever plexapi/requests raised as a 400
        raise HTTPException(status_code=400, detail=f"Couldn't apply rule: {exc}")

    rule.last_run_at = datetime.now(timezone.utc)
    db.commit()

    titles = ", ".join(result["enabled"]) if result["enabled"] else "none"
    logger.info(
        'Rule "%s" applied manually: enabled %d, disabled %d — enabled: %s',
        rule.name,
        len(result["enabled"]),
        result["disabled_count"],
        titles,
        extra={"server_id": server_id},
    )

    return {"enabled_count": len(result["enabled"]), "enabled_titles": result["enabled"], "disabled_count": result["disabled_count"]}
