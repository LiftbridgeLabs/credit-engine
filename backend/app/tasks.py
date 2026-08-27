import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import redis
from croniter import croniter
from sqlalchemy.orm import Session

from app.celery_app import celery_app
from app.config import settings
from app.db import SessionLocal
from app.models import (
    AppSettings,
    CachedItem,
    LogEntry,
    Library,
    ScanBatch,
    ScanJob,
    ScanRule,
    ScanStatus,
    ServerConnection,
)
from app.plex_client import (
    CREDITS_BATCH_SIZE,
    analyze_item,
    apply_credits_rule,
    check_credits_enabled,
    check_has_credits,
    check_has_credits_bulk,
    connect,
    describe_item,
    disable_item_credits,
    enable_item_credits,
    find_item_by_title_and_guid,
    find_items_added_since,
    find_lookahead_episodes,
    iter_all_sections,
    set_global_credits_behavior,
)

# Credits-status checks are one Plex round trip per movie/episode (see check_credits_status) —
# parallelized so a sync doesn't take literal hours on a large library. Kept modest rather than
# maximized: this is extra concurrent load on top of whatever else is already hitting the same
# Plex server (playback, other scans), and Plex itself has to serve every one of these requests.
_CREDITS_CHECK_WORKERS = 8

# Batched marker lookups do far more per request, so fewer of them run at once — this is the shape
# that measured fastest (4 x 100) and it is gentler on Plex than the old eight-at-a-time trickle
# while being an order of magnitude quicker overall.
_CREDITS_BATCH_WORKERS = 4

# A content sync is long (one Plex round trip per movie/episode) and rebuilds each library's rows
# wholesale, so exactly one may be in flight per server. Without this, check_content_sync would
# queue a fresh one every time it ran while a multi-hour sync was still going — content_synced_at
# isn't advanced until a library finishes, so the server stays "stale" for the whole run — and they
# would stack until the worker pool was doing nothing else.
#
# The lock is released in a finally block, which a killed process never reaches — a container
# restarted mid-sync used to leave the lock behind for its full TTL, and with a TTL measured in
# hours that meant "a content sync is already running" for the rest of the day with nothing
# actually running and no way to clear it. So the TTL is short and a heartbeat renews it for as
# long as the sync is genuinely alive: a real multi-hour sync keeps its lock, while an abandoned
# one frees itself within the TTL.
_CONTENT_SYNC_LOCK_TTL_SECONDS = 300
_CONTENT_SYNC_HEARTBEAT_SECONDS = 60

# How often a long phase reports progress. The episode pass runs for hours on a large library, so
# this is the only evidence it's alive; frequent enough to be reassuring, rare enough that an
# overnight run doesn't dominate the log table.
_PROGRESS_INTERVAL_SECONDS = 60

logger = logging.getLogger(__name__)


def _content_sync_lock_key(server_id: int) -> str:
    return f"creditengine:content-sync:{server_id}"


def is_content_sync_running(server_id: int) -> bool:
    """Best-effort read of the lock below, so the API can answer "already running" rather than
    cheerfully reporting a second sync started when it's really going to be dropped on arrival."""
    client = redis.Redis.from_url(settings.redis_url)
    try:
        return bool(client.exists(_content_sync_lock_key(server_id)))
    finally:
        client.close()


def content_sync_started_at(server_id: int) -> datetime | None:
    """When the in-flight sync started, or None if nothing holds the lock. "Already running" is far
    easier to trust when it can say since when — a start time from four hours ago on a library that
    takes twenty minutes says something is wrong, and the bare message never could."""
    client = redis.Redis.from_url(settings.redis_url)
    try:
        raw = client.get(_content_sync_lock_key(server_id))
    finally:
        client.close()
    if raw is None:
        return None
    try:
        return datetime.fromisoformat(raw.decode())
    except (AttributeError, ValueError):
        return None  # a lock written by an older build, which stored no timestamp


@contextmanager
def _content_sync_lock(server_id: int):
    """Yields True if this caller holds the server's sync lock, False if someone else already does.
    Deliberately not a wait-then-proceed lock: a queued duplicate has nothing useful to add by the
    time the one ahead of it finishes, so it's dropped instead.

    While held, a daemon thread renews the TTL — see the constants above for why the lock can't
    simply be given a long expiry."""
    client = redis.Redis.from_url(settings.redis_url)
    key = _content_sync_lock_key(server_id)
    held_since = datetime.now(timezone.utc).isoformat()
    acquired = bool(client.set(key, held_since, nx=True, ex=_CONTENT_SYNC_LOCK_TTL_SECONDS))

    done = threading.Event()

    def _renew() -> None:
        # wait() returns True the moment the sync finishes, which ends the loop without waiting out
        # the remaining interval.
        #
        # SET rather than EXPIRE, so a lock deleted by hand while its sync is still running is put
        # back. Clearing a lock is the documented way out of a stuck one, but on a live sync it
        # only unblocks the scheduler to start a second full sweep alongside the first — both then
        # competing for the same Plex server. A dead sync has no heartbeat, so deleting that one
        # still works exactly as intended.
        while not done.wait(_CONTENT_SYNC_HEARTBEAT_SECONDS):
            try:
                client.set(key, held_since, ex=_CONTENT_SYNC_LOCK_TTL_SECONDS)
            except Exception:  # noqa: BLE001 — a lost heartbeat must not kill the sync it guards
                return

    heartbeat = None
    if acquired:
        heartbeat = threading.Thread(target=_renew, name=f"content-sync-heartbeat-{server_id}", daemon=True)
        heartbeat.start()

    try:
        yield acquired
    finally:
        done.set()
        if heartbeat is not None:
            heartbeat.join(timeout=5)
        if acquired:
            client.delete(key)
        client.close()


def _is_due(schedule_cron: str, last_run_at: datetime | None, now: datetime) -> bool:
    """Naive-UTC comparison throughout — matches the assumption already made in plex_client."""
    reference = (last_run_at or now - timedelta(minutes=1)).replace(tzinfo=None)
    next_fire = croniter(schedule_cron, reference).get_next(datetime)
    return next_fire <= now.replace(tzinfo=None)


def queue_batch_scan(db: Session, batch: ScanBatch) -> list[int]:
    """Creates a ScanJob per rating key in the batch and queues each through Celery. Commits."""
    job_ids = []
    for rating_key in batch.rating_keys:
        job = ScanJob(server_id=batch.server_id, batch_id=batch.id, rating_key=rating_key)
        db.add(job)
        db.flush()
        job_ids.append(job.id)

    batch.last_run_at = datetime.now(timezone.utc)
    db.commit()

    for job_id in job_ids:
        run_scan_job.delay(job_id)
    return job_ids


@celery_app.task(name="app.tasks.run_scan_job")
def run_scan_job(scan_job_id: int) -> None:
    db = SessionLocal()
    try:
        job = db.get(ScanJob, scan_job_id)
        if job is None:
            return

        job.status = ScanStatus.running
        db.commit()

        server_conn = db.get(ServerConnection, job.server_id)
        if server_conn is None:
            job.status = ScanStatus.failed
            job.error = "Server connection no longer exists"
            db.commit()
            logger.error("Scan job %s failed: server connection no longer exists", scan_job_id)
            return

        try:
            plex = connect(server_conn.base_url, server_conn.token)
            item = plex.fetchItem(job.rating_key)
            job.title = describe_item(item)
            # Plex's analyze action cascades to every child of a show/season — batches create
            # ScanJob rows directly (bypassing the /scans endpoint's own check), so this is the one
            # place every scan trigger actually passes through. Refuse rather than silently
            # sweeping an entire show.
            if item.type not in ("movie", "episode"):
                raise ValueError(f"{item.type} isn't a movie or episode — refusing to avoid a full-show scan")
            analyze_item(item)
            job.status = ScanStatus.complete
            logger.info(
                "Scan complete: %s (rating key %s)",
                job.title,
                job.rating_key,
                extra={"server_id": job.server_id},
            )
        except Exception as exc:  # noqa: BLE001 — persist whatever Plex/plexapi raises
            job.status = ScanStatus.failed
            job.error = str(exc)
            logger.error(
                "Scan failed: rating key %s — %s",
                job.rating_key,
                exc,
                extra={"server_id": job.server_id},
            )
        finally:
            job.completed_at = datetime.now(timezone.utc)
            db.commit()
    finally:
        db.close()


@celery_app.task(name="app.tasks.apply_rule_job")
def apply_rule_job(rule_id: int) -> None:
    db = SessionLocal()
    try:
        rule = db.get(ScanRule, rule_id)
        if rule is None or not rule.enabled:
            return

        server = db.get(ServerConnection, rule.server_id)
        if server is None or not server.credits_control_enabled:
            return

        section_keys = [
            lib.section_id
            for lib in db.query(Library).filter(
                Library.id.in_(rule.criteria.get("library_ids", [])), Library.server_id == rule.server_id
            )
        ]
        if not section_keys:
            return

        plex = connect(server.base_url, server.token)
        result = apply_credits_rule(plex, section_keys, rule.criteria)

        rule.last_run_at = datetime.now(timezone.utc)
        db.commit()

        titles = ", ".join(result["enabled"]) if result["enabled"] else "none"
        logger.info(
            'Rule "%s" applied: enabled %d, disabled %d — enabled: %s',
            rule.name,
            len(result["enabled"]),
            result["disabled_count"],
            titles,
            extra={"server_id": rule.server_id},
        )
    finally:
        db.close()


@celery_app.task(name="app.tasks.bootstrap_credits_control")
def bootstrap_credits_control(server_id: int) -> None:
    """One-time setup: disable credits-marker generation on every existing item across every
    section on the server, then flip the global gate on. Can take a long time on large libraries —
    runs as a background task, not inline with the HTTP request that triggers it."""
    db = SessionLocal()
    try:
        server = db.get(ServerConnection, server_id)
        if server is None:
            return

        started_at = datetime.now(timezone.utc)
        logger.info("Bootstrap started for %s", server.name, extra={"server_id": server_id})
        plex = connect(server.base_url, server.token)

        touched = 0
        skipped = 0
        for section in iter_all_sections(plex):
            for item in section.all():
                touched += 1
                try:
                    if not disable_item_credits(item):
                        skipped += 1
                except Exception:  # noqa: BLE001 — one bad item (network blip, odd metadata) shouldn't
                    # abort a run touching thousands of items; reconcile_new_items can't help here since
                    # this item isn't "new", so it's simply left at the library default going forward.
                    skipped += 1
        if skipped:
            logger.warning(
                "Bootstrap for %s: skipped %d of %d items that couldn't be set",
                server.name,
                skipped,
                touched,
                extra={"server_id": server_id},
            )

        set_global_credits_behavior(plex, "scheduled")

        server.credits_control_enabled = True
        server.credits_control_bootstrapped_at = datetime.now(timezone.utc)
        # Anything added during this (possibly long) run wasn't in the section.all() snapshot above —
        # backdating the checkpoint to the start ensures reconciliation catches it on the next pass.
        server.last_new_item_check_at = started_at
        db.commit()

        elapsed = (server.credits_control_bootstrapped_at - started_at).total_seconds()
        logger.info(
            "Bootstrap complete for %s: %d items touched, %d skipped, %.0fs",
            server.name,
            touched,
            skipped,
            elapsed,
            extra={"server_id": server_id},
        )
    finally:
        db.close()


@celery_app.task(name="app.tasks.reconcile_new_items")
def reconcile_new_items() -> None:
    """Safety net alongside the Sonarr/Radarr webhook: catches any item that showed up without
    triggering a webhook (manual adds, missed/failed webhook deliveries) and disables it before
    Plex's own scheduled sweep would otherwise pick it up."""
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        servers = db.query(ServerConnection).filter(ServerConnection.credits_control_enabled.is_(True))
        for server in servers:
            since = server.last_new_item_check_at or server.credits_control_bootstrapped_at
            if since is None:
                continue

            plex = connect(server.base_url, server.token)
            found = 0
            for section in iter_all_sections(plex):
                for item in find_items_added_since(section, since):
                    disable_item_credits(item)
                    found += 1

            server.last_new_item_check_at = now
            db.commit()
            if found:
                logger.info(
                    "Reconciliation for %s: disabled %d newly-added item(s) that missed the webhook",
                    server.name,
                    found,
                    extra={"server_id": server.id},
                )
    finally:
        db.close()


@celery_app.task(name="app.tasks.handle_import_webhook", bind=True, max_retries=4)
def handle_import_webhook(self, server_id: int, payload: dict) -> None:
    """Sonarr/Radarr fires this right after import, often before Plex has actually scanned the
    file in — retries with backoff for a couple minutes before giving up. reconcile_new_items is
    the ultimate safety net if a match is never found (e.g. title mismatch, webhook malformed)."""
    db = SessionLocal()
    try:
        server = db.get(ServerConnection, server_id)
        if server is None or not server.credits_control_enabled:
            return

        if "series" in payload:
            title = payload["series"]["title"]
            guid_fragment = f"tvdb://{payload['series']['tvdbId']}"
            section_type = "show"
        elif "movie" in payload:
            title = payload["movie"]["title"]
            guid_fragment = f"tmdb://{payload['movie']['tmdbId']}"
            section_type = "movie"
        else:
            return

        plex = connect(server.base_url, server.token)
        item = find_item_by_title_and_guid(plex, section_type, title, guid_fragment)
        if item is None:
            if self.request.retries >= self.max_retries:
                logger.warning(
                    'Import webhook: gave up matching "%s" after %d retries — reconcile_new_items '
                    "will catch it eventually if it's actually in Plex",
                    title,
                    self.max_retries,
                    extra={"server_id": server_id},
                )
            raise self.retry(countdown=30)

        disable_item_credits(item)
        logger.info(
            'Import webhook: disabled credits for "%s" (new from Sonarr/Radarr)',
            title,
            extra={"server_id": server_id},
        )
    finally:
        db.close()


@celery_app.task(name="app.tasks.handle_plex_scrobble")
def handle_plex_scrobble(server_id: int, rating_key: int) -> None:
    """Plex fires this when someone finishes watching *anything* on the server — the webhook itself
    has no per-library filter, so this only acts if the watched item is in a library the user has
    explicitly included. Otherwise a watch event in, say, a Music or Sports library the user never
    opted into managing would still trigger enable+scan.

    For an episode: enables the show (if not already) and queues real scans for the next N
    unwatched-ahead episodes only — not the whole series, so starting a 20-season show doesn't
    queue hundreds of scans."""
    db = SessionLocal()
    try:
        server = db.get(ServerConnection, server_id)
        if server is None or not server.credits_control_enabled:
            return

        plex = connect(server.base_url, server.token)
        item = plex.fetchItem(rating_key)

        library = db.query(Library).filter_by(
            server_id=server_id, section_id=item.librarySectionID, included=True
        ).first()
        if library is None:
            logger.debug(
                "Scrobble for %s ignored: library %s isn't included",
                describe_item(item),
                item.librarySectionID,
                extra={"server_id": server_id},
            )
            return

        if item.type == "episode":
            enable_item_credits(item.show())
            targets = find_lookahead_episodes(item, server.scrobble_lookahead_episodes)
        elif item.type == "movie":
            enable_item_credits(item)
            targets = [item]
        else:
            return

        job_ids = []
        for target in targets:
            job = ScanJob(server_id=server_id, rating_key=target.ratingKey)
            db.add(job)
            db.flush()
            job_ids.append(job.id)
        db.commit()

        logger.info(
            "Watch event: %s — queued %d scan(s) (lookahead %d)",
            describe_item(item),
            len(job_ids),
            server.scrobble_lookahead_episodes,
            extra={"server_id": server_id},
        )
        for job_id in job_ids:
            run_scan_job.delay(job_id)
    finally:
        db.close()


@celery_app.task(name="app.tasks.check_scheduled_rules")
def check_scheduled_rules() -> None:
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        rules = db.query(ScanRule).filter(ScanRule.schedule_cron.isnot(None), ScanRule.enabled.is_(True))
        for rule in rules:
            if _is_due(rule.schedule_cron, rule.last_run_at, now):
                apply_rule_job.delay(rule.id)
    finally:
        db.close()


@celery_app.task(name="app.tasks.check_scheduled_batches")
def check_scheduled_batches() -> None:
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        batches = db.query(ScanBatch).filter(ScanBatch.schedule_cron.isnot(None))
        for batch in batches:
            if _is_due(batch.schedule_cron, batch.last_run_at, now):
                queue_batch_scan(db, batch)
    finally:
        db.close()


@celery_app.task(name="app.tasks.prune_logs")
def prune_logs() -> None:
    """Two independent triggers, whichever fires prunes the oldest rows: age (log_retention_days)
    and a row-count cap (log_max_entries, the practical stand-in for "max size" — see AppSettings).
    Runs on a timer (celery_app.py beat_schedule) rather than after every write, since checking on
    every single log call would mean a COUNT query per log line."""
    db = SessionLocal()
    try:
        cfg = db.get(AppSettings, 1)
        if cfg is None:
            cfg = AppSettings(id=1)
            db.add(cfg)
            db.commit()

        cutoff = datetime.now(timezone.utc) - timedelta(days=cfg.log_retention_days)
        deleted_by_age = (
            db.query(LogEntry).filter(LogEntry.created_at < cutoff).delete(synchronize_session=False)
        )

        deleted_by_size = 0
        total = db.query(LogEntry).count()
        if total > cfg.log_max_entries:
            excess = total - cfg.log_max_entries
            # id is monotonic and indexed (primary key) — cheaper to order by than created_at.
            cutoff_id = db.query(LogEntry.id).order_by(LogEntry.id.asc()).offset(excess - 1).limit(1).scalar()
            if cutoff_id is not None:
                deleted_by_size = (
                    db.query(LogEntry).filter(LogEntry.id <= cutoff_id).delete(synchronize_session=False)
                )

        db.commit()
        if deleted_by_age or deleted_by_size:
            logger.debug(
                "Log pruning: removed %d (past %d days), %d (over %d-row cap)",
                deleted_by_age,
                cfg.log_retention_days,
                deleted_by_size,
                cfg.log_max_entries,
            )
    finally:
        db.close()


def _format_duration(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m{seconds % 60:02}s"
    return f"{seconds // 3600}h{(seconds % 3600) // 60:02}m"


def _map_with_progress(pool, fn, items, label: str, lib_title: str, server_id: int, units=None) -> list:
    """pool.map, narrated on a timer.

    Reporting used to happen inside the result loop every 10% of items, which fails twice over on
    the episode pass: 10% of 47k items is a very long first wait, and pool.map yields results *in
    order*, so a single stalled item blocks all reporting while the other workers quietly finish
    thousands. Instead the wrapped function counts its own completions and a daemon thread reports
    on a fixed interval — so the line appears on schedule regardless of which item is slow, and
    reflects work actually finished rather than work finished in order.

    units maps an item to how many underlying things it stands for, so a batch of a hundred
    episodes counts as a hundred rather than as one and progress still reads in episodes."""
    unit_of = units or (lambda _: 1)
    total = sum(unit_of(i) for i in items)
    if total == 0:
        return []
    # Below this a phase finishes quickly enough that the "Checking credits status for N …" line
    # already said everything useful.
    if total < 50:
        return list(pool.map(fn, items))

    done = 0
    counter_lock = threading.Lock()

    def _counted(item):
        nonlocal done
        try:
            return fn(item)
        finally:
            with counter_lock:
                done += unit_of(item)

    started = time.monotonic()
    finished = threading.Event()

    def _report(final: bool = False) -> None:
        with counter_lock:
            completed = done
        if completed == 0 and not final:
            return
        elapsed = time.monotonic() - started
        rate = completed / elapsed if elapsed > 0 else 0
        logger.info(
            "%s in %s: %d/%d (%d%%) — %s elapsed, ~%s left",
            label,
            lib_title,
            completed,
            total,
            # Floored, not rounded: 3999/4000 reporting "100%" while an item is still outstanding
            # is precisely the false finish this reporting exists to avoid.
            completed * 100 // total,
            _format_duration(elapsed),
            _format_duration((total - completed) / rate) if rate > 0 else "?",
            extra={"server_id": server_id},
        )

    def _report_loop() -> None:
        while not finished.wait(_PROGRESS_INTERVAL_SECONDS):
            _report()

    reporter = threading.Thread(target=_report_loop, name=f"sync-progress-{server_id}", daemon=True)
    reporter.start()
    try:
        results = list(pool.map(_counted, items))
    finally:
        finished.set()
        reporter.join(timeout=5)
    _report(final=True)
    return results


def _safe_credits_enabled(item) -> bool | None:
    """check_credits_enabled already returns None for items that don't expose the preference at
    all; this additionally swallows transport-level failures (a timeout, a Plex hiccup partway
    through a sweep of thousands of items) so one bad item degrades to "unknown" instead of taking
    the whole library's sync down with it. These run inside a ThreadPoolExecutor whose results are
    consumed lazily, so an escaping exception surfaces far from the item that caused it."""
    try:
        return check_credits_enabled(item)
    except Exception:  # noqa: BLE001
        return None


def _credits_by_rating_key(plex, rating_keys: list[int], label: str, lib_title: str, server_id: int) -> dict[int, bool]:
    """Credits status for every leaf item in a library, batched.

    This used to be one Plex request per item, which is what made a full sweep an overnight job:
    the per-item call goes through plexapi's fetchItem and pulls the heaviest metadata document
    Plex will produce, purely to read one Marker element. Batching turns tens of thousands of those
    into a few hundred cheap requests."""
    if not rating_keys:
        return {}

    chunks = [
        rating_keys[i : i + CREDITS_BATCH_SIZE] for i in range(0, len(rating_keys), CREDITS_BATCH_SIZE)
    ]

    def _chunk(chunk: list[int]) -> dict[int, bool]:
        try:
            return check_has_credits_bulk(plex, chunk)
        except Exception:  # noqa: BLE001
            # Retry this chunk one item at a time rather than writing off a hundred episodes as
            # "no credits" because a single request failed.
            logger.warning(
                "Batched credits check failed for %d item(s) in %s — falling back to one at a time",
                len(chunk),
                lib_title,
                extra={"server_id": server_id},
            )
            return {k: _safe_has_credits(plex, k) for k in chunk}

    with ThreadPoolExecutor(max_workers=_CREDITS_BATCH_WORKERS) as pool:
        results = _map_with_progress(pool, _chunk, chunks, label, lib_title, server_id, units=len)

    merged: dict[int, bool] = {}
    for result in results:
        merged.update(result)
    return merged


def _safe_has_credits(plex, rating_key: int) -> bool:
    """False on failure rather than None: absent evidence of a marker, "no credits yet" is the
    conservative answer — it leaves the item eligible for a scan instead of hiding it."""
    try:
        return check_has_credits(plex, rating_key)
    except Exception:  # noqa: BLE001
        return False


def _build_movie_rows(plex, server_id: int, lib: Library, section) -> list[CachedItem]:
    movies = list(section.all())
    logger.info("Checking credits status for %d movie(s) in %s...", len(movies), lib.title, extra={"server_id": server_id})

    has_credits = _credits_by_rating_key(
        plex, [m.ratingKey for m in movies], "Movie credits checked", lib.title, server_id
    )

    # The enable/disable preference has no bulk equivalent — it's a separate per-item call — so it
    # stays parallel-per-item. It's also much cheaper than the marker lookup used to be.
    with ThreadPoolExecutor(max_workers=_CREDITS_CHECK_WORKERS) as pool:
        enabled = _map_with_progress(
            pool, _safe_credits_enabled, movies, "Movie settings checked", lib.title, server_id
        )

    return [
        CachedItem(
            server_id=server_id,
            section_id=lib.section_id,
            rating_key=m.ratingKey,
            parent_rating_key=None,
            title=m.title,
            type="movie",
            has_thumb=bool(getattr(m, "thumb", None)),
            credits_enabled=is_enabled,
            has_credits=has_credits.get(m.ratingKey, False),
        )
        for m, is_enabled in zip(movies, enabled)
    ]


def _build_show_rows(plex, server_id: int, lib: Library, section) -> list[CachedItem]:
    rows: list[CachedItem] = []

    shows = list(section.all(libtype="show"))
    logger.info("Checking credits status for %d show(s) in %s...", len(shows), lib.title, extra={"server_id": server_id})

    # Cheap relative to the episode pass below — one preference read per show, no per-episode
    # equivalent since Episode doesn't expose the preference at all.
    with ThreadPoolExecutor(max_workers=_CREDITS_CHECK_WORKERS) as pool:
        enabled_values = _map_with_progress(
            pool, _safe_credits_enabled, shows, "Shows checked", lib.title, server_id
        )
    show_enabled = dict(zip((s.ratingKey for s in shows), enabled_values))

    for s in shows:
        rows.append(
            CachedItem(
                server_id=server_id,
                section_id=lib.section_id,
                rating_key=s.ratingKey,
                parent_rating_key=None,
                title=s.title,
                type="show",
                has_thumb=bool(getattr(s, "thumb", None)),
                credits_enabled=show_enabled.get(s.ratingKey),
            )
        )
    for se in section.all(libtype="season"):
        rows.append(
            CachedItem(
                server_id=server_id,
                section_id=lib.section_id,
                rating_key=se.ratingKey,
                parent_rating_key=se.parentRatingKey,
                title=se.title,
                type="season",
                index=se.index,
                season_number=se.index,
                has_thumb=bool(getattr(se, "thumb", None)),
                credits_enabled=show_enabled.get(se.parentRatingKey),
            )
        )

    episodes = list(section.all(libtype="episode"))
    logger.info("Checking credits status for %d episode(s) in %s...", len(episodes), lib.title, extra={"server_id": server_id})

    episode_credits = _credits_by_rating_key(
        plex, [ep.ratingKey for ep in episodes], "Episodes checked", lib.title, server_id
    )

    for ep in episodes:
        has_credits = episode_credits.get(ep.ratingKey, False)
        rows.append(
            CachedItem(
                server_id=server_id,
                section_id=lib.section_id,
                rating_key=ep.ratingKey,
                parent_rating_key=ep.parentRatingKey,
                show_rating_key=ep.grandparentRatingKey,
                title=ep.title,
                type="episode",
                index=ep.index,
                season_number=ep.parentIndex,
                has_thumb=bool(getattr(ep, "thumb", None)),
                credits_enabled=show_enabled.get(ep.grandparentRatingKey),
                has_credits=has_credits,
            )
        )
    return rows


@celery_app.task(name="app.tasks.sync_library_contents")
def sync_library_contents(server_id: int) -> None:
    """Snapshots every included library's structure into CachedItem so browsing doesn't have to hit
    Plex live every time — triggered by the "Sync" button on the Servers page, and automatically by
    check_content_sync once a library's snapshot goes stale.

    Uses flat, type-filtered section queries (all shows, all seasons, all episodes, each in one Plex
    API call) rather than walking show -> season -> episode one at a time, which would be an N+1
    round trip per level on a large library.

    Also checks each item's real credits status against Plex directly — this is what lets a fresh
    deployment (a brand new database, no prior history) correctly rediscover credits that were
    already generated before this database ever existed, instead of showing everything as
    "missing." Two different, genuinely N+1 checks, both parallelized across a thread pool:
    credits_enabled (only Movie/Show expose this preference — Episode does not, since Plex's own
    generation setting is per-show, never per-episode, so an episode's value is just copied from
    its parent show rather than checked again) and has_credits (a true per-episode/movie fact,
    checked directly on every leaf item).

    Each library is built, swapped in and committed on its own, and a library that fails is logged
    and skipped rather than aborting the run. Both matter: this used to delete a library's rows
    first and commit only once at the very end, across every library, so a single unreachable item
    anywhere rolled the whole thing back to the previous snapshot — leaving a silently stale cache
    and nothing to indicate anything had gone wrong."""
    db = SessionLocal()
    try:
        server = db.get(ServerConnection, server_id)
        if server is None:
            return

        with _content_sync_lock(server_id) as acquired:
            if not acquired:
                logger.info(
                    "Library sync for %s skipped: one is already running",
                    server.name,
                    extra={"server_id": server_id},
                )
                return

            libraries = db.query(Library).filter_by(server_id=server_id, included=True).all()
            if not libraries:
                logger.warning("Library sync requested for %s but no libraries are included", server.name, extra={"server_id": server_id})
                return

            logger.info(
                "Library sync starting for %s: %d included librar%s",
                server.name,
                len(libraries),
                "y" if len(libraries) == 1 else "ies",
                extra={"server_id": server_id},
            )
            plex = connect(server.base_url, server.token)

            sync_started = time.monotonic()
            total = 0
            failed = []
            for lib in libraries:
                try:
                    section = plex.library.sectionByID(lib.section_id)
                    # Build the replacement set before touching what's already cached — this is the
                    # slow, network-bound part, and nothing is thrown away until there's something
                    # complete to put in its place.
                    rows = []
                    if section.type == "movie":
                        rows = _build_movie_rows(plex, server_id, lib, section)
                    elif section.type == "show":
                        rows = _build_show_rows(plex, server_id, lib, section)

                    db.query(CachedItem).filter_by(server_id=server_id, section_id=lib.section_id).delete()
                    db.add_all(rows)
                    # Only advanced once this library has actually been rebuilt, so a failure leaves
                    # it looking stale to check_content_sync and it gets retried on the next pass.
                    lib.content_synced_at = datetime.now(timezone.utc)
                    db.commit()
                    total += len(rows)
                except Exception as exc:  # noqa: BLE001 — one library shouldn't sink the others
                    db.rollback()
                    failed.append(lib.title)
                    logger.error(
                        "Library sync failed for %s: %s",
                        lib.title,
                        exc,
                        extra={"server_id": server_id},
                    )

            if failed:
                logger.warning(
                    "Library sync for %s: %d items cached, %d library/libraries failed and kept their previous snapshot: %s",
                    server.name,
                    total,
                    len(failed),
                    ", ".join(failed),
                    extra={"server_id": server_id},
                )
            else:
                logger.info(
                    "Library sync complete for %s: %d items cached in %s",
                    server.name,
                    total,
                    _format_duration(time.monotonic() - sync_started),
                    extra={"server_id": server_id},
                )
    finally:
        db.close()


@celery_app.task(name="app.tasks.check_content_sync")
def check_content_sync() -> None:
    """Rebuilds each server's browse cache once it passes AppSettings.content_sync_interval_hours.

    Without this the cache only ever changed when someone pressed "Sync" on the Servers page, so
    anything added to Plex afterwards stayed invisible in CreditEngine indefinitely — browse serves
    from the cache the moment content_synced_at is set, with no staleness signal anywhere in the UI
    to suggest a rebuild was overdue.

    Staleness is read off Library.content_synced_at, which sync_library_contents only advances for
    libraries it actually rebuilt, so a failed or partial run stays due instead of being recorded as
    done."""
    db = SessionLocal()
    try:
        cfg = db.get(AppSettings, 1)
        # No settings row yet means nothing has ever been configured — the web process creates it on
        # first read. Falling back to the model default here instead of skipping keeps a fresh
        # install syncing without someone having to open the Settings page first.
        interval_hours = cfg.content_sync_interval_hours if cfg is not None else 24
        if interval_hours <= 0:
            return

        cutoff = datetime.now(timezone.utc) - timedelta(hours=interval_hours)
        for server in db.query(ServerConnection):
            libraries = db.query(Library).filter_by(server_id=server.id, included=True).all()
            if not any(lib.content_synced_at is None or lib.content_synced_at < cutoff for lib in libraries):
                continue
            # The task takes the same lock itself; checking here just avoids queueing work that's
            # only going to be dropped, and the log line that would come with it.
            if is_content_sync_running(server.id):
                continue
            logger.info(
                "Content cache for %s is over %dh old — queueing a sync",
                server.name,
                interval_hours,
                extra={"server_id": server.id},
            )
            sync_library_contents.delay(server.id)
    finally:
        db.close()
