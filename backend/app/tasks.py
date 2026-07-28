from datetime import datetime, timedelta, timezone

from croniter import croniter
from sqlalchemy.orm import Session

from app.celery_app import celery_app
from app.db import SessionLocal
from app.models import Library, ScanBatch, ScanJob, ScanRule, ScanStatus, ServerConnection
from app.plex_client import (
    analyze_item,
    apply_credits_rule,
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
        except Exception as exc:  # noqa: BLE001 — persist whatever Plex/plexapi raises
            job.status = ScanStatus.failed
            job.error = str(exc)
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
        apply_credits_rule(plex, section_keys, rule.criteria)

        rule.last_run_at = datetime.now(timezone.utc)
        db.commit()
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
        plex = connect(server.base_url, server.token)

        skipped = 0
        for section in iter_all_sections(plex):
            for item in section.all():
                try:
                    if not disable_item_credits(item):
                        skipped += 1
                except Exception:  # noqa: BLE001 — one bad item (network blip, odd metadata) shouldn't
                    # abort a run touching thousands of items; reconcile_new_items can't help here since
                    # this item isn't "new", so it's simply left at the library default going forward.
                    skipped += 1
        if skipped:
            print(f"bootstrap_credits_control: skipped {skipped} items that couldn't be set")

        set_global_credits_behavior(plex, "scheduled")

        server.credits_control_enabled = True
        server.credits_control_bootstrapped_at = datetime.now(timezone.utc)
        # Anything added during this (possibly long) run wasn't in the section.all() snapshot above —
        # backdating the checkpoint to the start ensures reconciliation catches it on the next pass.
        server.last_new_item_check_at = started_at
        db.commit()
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
            for section in iter_all_sections(plex):
                for item in find_items_added_since(section, since):
                    disable_item_credits(item)

            server.last_new_item_check_at = now
            db.commit()
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
            raise self.retry(countdown=30)

        disable_item_credits(item)
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
