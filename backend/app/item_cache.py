from sqlalchemy.orm import Session

from app.models import CachedItem


def set_cached_credits_enabled(db: Session, server_id: int, rating_key: int, enabled: bool) -> None:
    """Mirror a show/movie's credits flag into the browse cache, cascading to its seasons and
    episodes (they display the same inherited value). Anything that flips the flag in Plex has to
    call this, or the library page keeps showing the old value until the next full sync — which is
    how a show enabled by a watch event still read "Disabled". The caller commits."""
    db.query(CachedItem).filter_by(server_id=server_id, rating_key=rating_key).update({"credits_enabled": enabled})
    db.query(CachedItem).filter_by(server_id=server_id, show_rating_key=rating_key).update({"credits_enabled": enabled})
    db.query(CachedItem).filter_by(server_id=server_id, parent_rating_key=rating_key, type="season").update(
        {"credits_enabled": enabled}
    )
