import enum
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Enum, ForeignKey, Integer, String, Boolean, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String, unique=True, index=True)
    # Null when the account was created purely by linking a Plex login and never set a local password.
    password_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)

    # Account-level Plex identity, used only to discover/authorize servers via plex.tv's resources API.
    plex_id: Mapped[int | None] = mapped_column(nullable=True, unique=True)
    plex_username: Mapped[str | None] = mapped_column(String, nullable=True)
    plex_account_token: Mapped[str | None] = mapped_column(String, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    servers: Mapped[list["ServerConnection"]] = relationship(back_populates="owner", cascade="all, delete-orphan")


class ServerConnection(Base):
    __tablename__ = "server_connections"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String, default="My Plex Server")
    # Plex's own identifier for this server (from the resources API) — distinct from our app's client identifier.
    client_identifier: Mapped[str | None] = mapped_column(String, nullable=True)
    base_url: Mapped[str] = mapped_column(String)
    token: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    # Sonarr/Radarr can't do our JWT login flow — this authenticates their webhook calls instead.
    webhook_secret: Mapped[str] = mapped_column(String)
    # Set when a "Test" event is received on the webhook endpoint — confirms it's actually reachable.
    webhook_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Whether CreditEngine manages this server's credits-marker generation: bulk-disabled by default,
    # selectively re-enabled per item by rules. Covers every section on the server, not just "included"
    # libraries, since the underlying Plex setting this depends on is server-wide.
    credits_control_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    credits_control_bootstrapped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Reconciliation checkpoint — only items added after this need to be caught and disabled.
    last_new_item_check_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # On a Plex scrobble (watch) event, how many episodes forward (from the one just watched) to
    # scan — bounded on purpose so starting a 20-season show doesn't queue the whole series at once.
    scrobble_lookahead_episodes: Mapped[int] = mapped_column(default=5)

    owner: Mapped["User"] = relationship(back_populates="servers")
    libraries: Mapped[list["Library"]] = relationship(back_populates="server", cascade="all, delete-orphan")


class ArrInstance(Base):
    __tablename__ = "arr_instances"

    id: Mapped[int] = mapped_column(primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("server_connections.id"))
    type: Mapped[str] = mapped_column(String)  # "sonarr" | "radarr"
    base_url: Mapped[str] = mapped_column(String)
    api_key: Mapped[str] = mapped_column(String)
    # Sonarr/Radarr's own ID for the notification connection we created — needed to remove it on unlink.
    notification_id: Mapped[int | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class Library(Base):
    __tablename__ = "libraries"

    id: Mapped[int] = mapped_column(primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("server_connections.id"))
    section_id: Mapped[int] = mapped_column()
    title: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(String)  # "movie" | "show"
    included: Mapped[bool] = mapped_column(Boolean, default=False)
    # Null until the "Sync" button on the Servers page is used at least once — browse endpoints fall
    # back to live Plex calls until then, so browsing still works, just without the cache's speed.
    content_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    server: Mapped["ServerConnection"] = relationship(back_populates="libraries")


class ScanRule(Base):
    __tablename__ = "scan_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("server_connections.id"))
    name: Mapped[str] = mapped_column(String)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # e.g. {"type": "recently_watched", "days": 30, "library_ids": [1, 2]}
    criteria: Mapped[dict] = mapped_column(JSON)
    # Optional: re-apply this rule automatically on a schedule (e.g. nightly re-check of "recently watched").
    schedule_cron: Mapped[str | None] = mapped_column(String, nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class ScanBatch(Base):
    __tablename__ = "scan_batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("server_connections.id"))
    name: Mapped[str] = mapped_column(String)
    rating_keys: Mapped[list[int]] = mapped_column(JSON)
    schedule_cron: Mapped[str | None] = mapped_column(String, nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class ScanStatus(str, enum.Enum):
    pending = "pending"
    running = "running"
    complete = "complete"
    failed = "failed"


class ScanJob(Base):
    __tablename__ = "scan_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("server_connections.id"))
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("scan_batches.id"), nullable=True)
    rating_key: Mapped[int] = mapped_column()
    # Filled in once the job actually runs and fetches the item — null if it never got that far
    # (e.g. server unreachable). Descriptive ("Show — S01E01 — Episode Title"), not just the raw key.
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[ScanStatus] = mapped_column(Enum(ScanStatus), default=ScanStatus.pending)
    error: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class LogEntry(Base):
    """One row per log record emitted anywhere in the app (FastAPI request handlers, Celery tasks,
    the webhook receivers) via DatabaseLogHandler — see app/log_handler.py. Indexed on id (not
    timestamp) for the live-tail viewer, which polls "give me everything after id N" rather than
    re-fetching a timestamp range every couple seconds."""

    __tablename__ = "log_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, index=True)
    level: Mapped[str] = mapped_column(String, index=True)  # DEBUG | INFO | WARNING | ERROR | CRITICAL
    logger_name: Mapped[str] = mapped_column(String)  # e.g. "app.tasks"
    message: Mapped[str] = mapped_column(Text)
    # Best-effort context, not a hard link — a server can be unlinked after the fact and the log
    # entry should still be readable, so this is nullable and has no relationship/cascade.
    server_id: Mapped[int | None] = mapped_column(ForeignKey("server_connections.id"), nullable=True)


class CachedItem(Base):
    """A lightweight snapshot of one item's position in the library tree (title, type, parent,
    ordering) — populated by the manual "Sync" button on the Servers page (app/tasks.py's
    sync_library_contents), not touched automatically. Deliberately just metadata, a few hundred
    bytes a row even for a huge library — actual image bytes are never stored here or anywhere in
    the DB; see the /thumb proxy endpoint, which streams straight from Plex on request instead."""

    __tablename__ = "cached_items"
    __table_args__ = (UniqueConstraint("server_id", "rating_key", name="uq_cached_item_server_rating_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("server_connections.id"), index=True)
    section_id: Mapped[int] = mapped_column(index=True)
    rating_key: Mapped[int] = mapped_column(index=True)
    # Null for top-level items (movies, shows) — the same field browse queries filter on to answer
    # both "what's at the top of this library" (None) and "what's under rating key X" (= X).
    parent_rating_key: Mapped[int | None] = mapped_column(nullable=True, index=True)
    # Episodes only — the show's rating key directly (skipping the season in between), so per-show
    # credits stats are a single GROUP BY instead of a two-hop join through seasons every time the
    # dashboard loads.
    show_rating_key: Mapped[int | None] = mapped_column(nullable=True, index=True)
    title: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(String)  # "movie" | "show" | "season" | "episode"
    index: Mapped[int | None] = mapped_column(nullable=True)
    season_number: Mapped[int | None] = mapped_column(nullable=True)
    has_thumb: Mapped[bool] = mapped_column(Boolean, default=False)
    # Only meaningful for movie/episode (leaf) rows — the other two fields answering "will this
    # ever get one" and "does it already have one," read straight from Plex at sync time rather
    # than assumed from our own history. This is what lets re-linking a server (a fresh database,
    # e.g. a new deployment) correctly rediscover credits that were already generated previously,
    # instead of treating everything as untouched.
    credits_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    has_credits: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


class AppSettings(Base):
    """Single-row table (id is always 1) for app-wide settings that don't belong to any one server —
    currently just log retention. A real settings table rather than env vars because these are meant
    to be changed at runtime from the Settings page, not at container-start time."""

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    # Two independent triggers — whichever is hit first prunes the oldest rows. "Max size" is
    # enforced as a row-count cap rather than a byte-size, since that's what's cheaply and reliably
    # enforceable with a single DELETE ... ORDER BY id LIMIT query, and roughly tracks disk usage
    # anyway since rows are similar sizes.
    log_max_entries: Mapped[int] = mapped_column(Integer, default=50_000)
    log_retention_days: Mapped[int] = mapped_column(Integer, default=30)
