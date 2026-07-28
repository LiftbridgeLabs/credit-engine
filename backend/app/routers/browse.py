import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import CachedItem, Library, ServerConnection, User
from app.plex_client import browse_all_episodes, browse_children, browse_top_level, connect, disable_item_credits, enable_item_credits
from app.security import get_current_user, get_current_user_via_query

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
        "has_thumb": bool(getattr(item, "thumb", None)),
        # Live (non-cached) browsing predates a sync — credits status genuinely isn't known yet.
        "credits_enabled": None,
        "has_credits": None,
        "episode_count": None,
        "episodes_with_credits": None,
    }


def _episode_rollups(db: Session, server_id: int, section_id: int) -> dict[int, tuple[int, int]]:
    """show_rating_key -> (episode_count, episodes_with_credits), one grouped query for the whole
    library rather than one query per show."""
    rows = (
        db.query(
            CachedItem.show_rating_key,
            func.count().label("total"),
            func.sum(case((CachedItem.has_credits.is_(True), 1), else_=0)).label("with_credits"),
        )
        .filter(
            CachedItem.server_id == server_id,
            CachedItem.section_id == section_id,
            CachedItem.type == "episode",
        )
        .group_by(CachedItem.show_rating_key)
        .all()
    )
    return {r.show_rating_key: (r.total, int(r.with_credits or 0)) for r in rows}


def _serialize_cached(c: CachedItem, rollups: dict[int, tuple[int, int]] | None = None) -> dict:
    episode_count = episodes_with_credits = None
    if c.type == "show" and rollups is not None:
        episode_count, episodes_with_credits = rollups.get(c.rating_key, (0, 0))
    return {
        "rating_key": c.rating_key,
        "title": c.title,
        "type": c.type,
        "index": c.index,
        "season_number": c.season_number,
        "has_children": c.type in ("show", "season"),
        "has_thumb": c.has_thumb,
        "credits_enabled": c.credits_enabled,
        "has_credits": c.has_credits,
        "episode_count": episode_count,
        "episodes_with_credits": episodes_with_credits,
    }


@router.get("")
def browse_section(
    server_id: int,
    section_id: int,
    missing_only: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Top-level items (shows or movies) directly under a library section — served from the cache
    if this library has been synced (Servers page), otherwise a live Plex call so browsing still
    works before the first sync, just without the cache's speed on a large library.

    missing_only filters to shows with at least one episode missing its credits marker (or movies
    missing theirs) — meaningless before a sync has ever run (nothing to filter on), so it's simply
    ignored on the live-fallback path."""
    server = _get_owned_server(server_id, current_user, db)

    lib = db.query(Library).filter_by(server_id=server_id, section_id=section_id).first()
    if lib is not None and lib.content_synced_at is not None:
        cached = (
            db.query(CachedItem)
            .filter_by(server_id=server_id, section_id=section_id, parent_rating_key=None)
            .all()
        )
        rollups = _episode_rollups(db, server_id, section_id)
        serialized = [_serialize_cached(c, rollups) for c in cached]
        if missing_only:
            serialized = [
                s
                for s in serialized
                if (s["type"] == "movie" and not s["has_credits"])
                or (s["type"] == "show" and (s["episode_count"] or 0) > (s["episodes_with_credits"] or 0))
            ]
        return serialized

    try:
        plex = connect(server.base_url, server.token)
        items = browse_top_level(plex, section_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Couldn't browse that section: {exc}")
    return [_serialize(i) for i in items]


@router.get("/stats")
def browse_stats(
    server_id: int,
    section_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Library Overview numbers — total top-level items, and how many leaf items (episodes or
    movies) have credits already, are eligible and waiting on Plex's own schedule, or aren't
    eligible at all. Cache-only (no live-Plex fallback) — these figures are meaningless before a
    sync has ever populated real credits status."""
    _get_owned_server(server_id, current_user, db)

    top_level_count = (
        db.query(CachedItem)
        .filter_by(server_id=server_id, section_id=section_id, parent_rating_key=None)
        .count()
    )
    leaf = db.query(CachedItem).filter(
        CachedItem.server_id == server_id,
        CachedItem.section_id == section_id,
        CachedItem.type.in_(["movie", "episode"]),
    )
    total_items = leaf.count()
    has_credits = leaf.filter(CachedItem.has_credits.is_(True)).count()
    pending = leaf.filter(CachedItem.has_credits.is_(False), CachedItem.credits_enabled.is_(True)).count()
    missing = total_items - has_credits - pending

    return {
        "top_level_count": top_level_count,
        "total_items": total_items,
        "has_credits": has_credits,
        "pending": pending,
        "missing": missing,
    }


@router.post("/{rating_key}/credits")
def set_item_credits(
    server_id: int,
    rating_key: int,
    enabled: bool,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Enable/disable credits generation for one show or movie directly — the same per-item
    override rules/bootstrap use, just for a single item instead of a bulk pass.

    Show/movie only, on purpose: confirmed directly against a real Plex server that seasons don't
    expose this preference at all (its available preferences were audioLanguage/subtitleLanguage/
    subtitleMode — nothing credits-related), and episodes never have either. Show is the finest
    granularity Plex actually supports."""
    server = _get_owned_server(server_id, current_user, db)

    try:
        plex = connect(server.base_url, server.token)
        item = plex.fetchItem(rating_key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Couldn't reach that item: {exc}")

    if item.type not in ("show", "movie"):
        raise HTTPException(
            status_code=400,
            detail=f"Can't set credits generation on a {item.type} — Plex only supports this at the show or movie level",
        )

    ok = enable_item_credits(item) if enabled else disable_item_credits(item)
    if not ok:
        raise HTTPException(status_code=400, detail="This item doesn't expose the credits-generation setting")

    # Keep the cache in sync immediately rather than waiting for the next full Sync — cascades to
    # every cached descendant (seasons, episodes) too, since they display the same inherited value.
    db.query(CachedItem).filter_by(server_id=server_id, rating_key=rating_key).update({"credits_enabled": enabled})
    if item.type == "show":
        db.query(CachedItem).filter_by(server_id=server_id, show_rating_key=rating_key).update({"credits_enabled": enabled})
        db.query(CachedItem).filter_by(server_id=server_id, parent_rating_key=rating_key, type="season").update(
            {"credits_enabled": enabled}
        )
    db.commit()

    return {"rating_key": rating_key, "credits_enabled": enabled}


@router.get("/{rating_key}/children")
def browse_item_children(
    server_id: int,
    rating_key: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Seasons under a show, or episodes under a season — cache-first, same fallback as above."""
    server = _get_owned_server(server_id, current_user, db)

    cached = db.query(CachedItem).filter_by(server_id=server_id, parent_rating_key=rating_key).all()
    if cached:
        return [_serialize_cached(c) for c in cached]

    try:
        plex = connect(server.base_url, server.token)
        items = browse_children(plex, rating_key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Couldn't browse that item: {exc}")
    return [_serialize(i) for i in items]


@router.get("/{rating_key}/episodes")
def browse_item_all_episodes(
    server_id: int,
    rating_key: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Every episode under a show or season, flattened — powers "add this whole season/show" as a
    bulk-pick convenience without ever queuing an analyze() call on the container itself. Always
    live (not cache-backed) — a lower-frequency action than plain browsing, not worth the added
    complexity of resolving a show's episodes through two levels of cached parent links."""
    server = _get_owned_server(server_id, current_user, db)
    try:
        plex = connect(server.base_url, server.token)
        items = browse_all_episodes(plex, rating_key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Couldn't browse that item: {exc}")
    return [_serialize(i) for i in items]


@router.get("/{rating_key}/thumb")
def get_thumb(
    server_id: int,
    rating_key: int,
    current_user: User = Depends(get_current_user_via_query),
    db: Session = Depends(get_db),
):
    """Streams the item's poster/thumbnail straight from Plex — never stored on our side, so this
    endpoint is the only place image bytes exist outside the user's own Plex server. Auth comes from
    a query param (?auth=<session token>), not the header, since <img> tags can't set custom
    headers; the Plex token itself never leaves the backend. Aggressively browser-cached since art
    for a given item rarely changes."""
    server = _get_owned_server(server_id, current_user, db)

    thumb_url = f"{server.base_url}/library/metadata/{rating_key}/thumb"
    try:
        resp = httpx.get(thumb_url, params={"X-Plex-Token": server.token}, timeout=10.0, follow_redirects=True)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Couldn't reach Plex: {exc}")

    if resp.status_code != 200:
        raise HTTPException(status_code=404, detail="No thumbnail available")

    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "public, max-age=604800"},
    )
