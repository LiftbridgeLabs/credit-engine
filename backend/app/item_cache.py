from sqlalchemy.orm import Session

from app.models import CachedItem, CreditsExclusion
from app.plex_client import CREDITS_BATCH_SIZE, check_credits_enabled, check_has_credits_bulk


def set_cached_credits_enabled(db: Session, server_id: int, rating_key: int, enabled: bool | None) -> None:
    """Mirror a show/movie's credits flag into the browse cache, cascading to its seasons and
    episodes (they display the same inherited value). Anything that flips the flag in Plex has to
    call this, or the library page keeps showing the old value until the next full sync — which is
    how a show enabled by a watch event still read "Disabled". The caller commits."""
    db.query(CachedItem).filter_by(server_id=server_id, rating_key=rating_key).update({"credits_enabled": enabled})
    db.query(CachedItem).filter_by(server_id=server_id, show_rating_key=rating_key).update({"credits_enabled": enabled})
    db.query(CachedItem).filter_by(server_id=server_id, parent_rating_key=rating_key, type="season").update(
        {"credits_enabled": enabled}
    )


def excluded_rating_keys(db: Session, server_id: int) -> set[int]:
    """Shows/movies marked Never on this server — nothing may turn their credits back on."""
    return {row.rating_key for row in db.query(CreditsExclusion.rating_key).filter_by(server_id=server_id)}


def refresh_item_credits(db: Session, plex, server_id: int, rating_key: int) -> dict:
    """Re-read one show or movie straight from Plex — its credits flag and which episodes have
    markers — and write that into the browse cache. The cache otherwise only learns about new
    markers from a full library sync, so a show whose credits Plex generated this afternoon kept
    reading "0/38" until the next one. Cheap: one request per hundred episodes. The caller commits.

    Only updates rows the cache already has; episodes added since the last sync appear with it."""
    item = plex.fetchItem(rating_key)
    if item.type not in ("show", "movie"):
        raise ValueError(f"Can only re-check a show or movie, not a {item.type}")
    enabled = check_credits_enabled(item)

    if item.type == "movie":
        has = check_has_credits_bulk(plex, [item.ratingKey]).get(item.ratingKey, False)
        db.query(CachedItem).filter_by(server_id=server_id, rating_key=rating_key).update(
            {"credits_enabled": enabled, "has_credits": has}
        )
        return {"rating_key": rating_key, "title": item.title, "credits_enabled": enabled, "has_credits": has}

    keys = [e.ratingKey for e in item.episodes()]
    has_credits: dict[int, bool] = {}
    for i in range(0, len(keys), CREDITS_BATCH_SIZE):
        has_credits.update(check_has_credits_bulk(plex, keys[i : i + CREDITS_BATCH_SIZE]))

    set_cached_credits_enabled(db, server_id, rating_key, enabled)
    for flag in (True, False):
        matching = [k for k in keys if bool(has_credits.get(k)) is flag]
        for i in range(0, len(matching), 500):
            db.query(CachedItem).filter(
                CachedItem.server_id == server_id, CachedItem.rating_key.in_(matching[i : i + 500])
            ).update({"has_credits": flag}, synchronize_session=False)

    return {
        "rating_key": rating_key,
        "title": item.title,
        "credits_enabled": enabled,
        "episode_count": len(keys),
        "episodes_with_credits": sum(1 for k in keys if has_credits.get(k)),
    }
