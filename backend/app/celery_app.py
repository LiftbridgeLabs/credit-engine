from celery import Celery
from celery.signals import beat_init, worker_init, worker_process_init

from app.config import settings
from app.db import engine
from app.log_handler import install_log_handler
from app.migrations import run_migrations

install_log_handler()


@worker_init.connect
@beat_init.connect
def _run_migrations_on_start(**_kwargs) -> None:
    """The worker and beat never import main.py, so they'd otherwise start against a database that
    hasn't had new columns added yet and fail on the first query naming one. Run from the startup
    signals rather than at import time so merely importing this module (a smoke test, a shell) still
    doesn't need a reachable database.

    Then empty the connection pool. This signal fires in the *parent* worker process, before Celery
    forks its children, so any connection left in the pool here is inherited by every child as the
    same TCP socket — several processes then talk over one libpq connection and the protocol
    desynchronises. That shows up as "error with status PGRES_TUPLES_OK and no message from the
    libpq" and as NotImplementedError raised out of SQLAlchemy's result handling, neither of which
    names its real cause. Disposing leaves the pool empty at fork time; children open their own."""
    run_migrations(engine)
    engine.dispose()


@worker_process_init.connect
def _dispose_inherited_connections(**_kwargs) -> None:
    """Runs in each child after the fork, covering anything the parent opened between the dispose
    above and the fork itself (a log record written through DatabaseLogHandler is enough).

    close=False matters: the sockets belong to the parent, and closing them from a child would
    break the process that actually owns them. This drops the child's references and lets it
    connect for itself."""
    engine.dispose(close=False)

celery_app = Celery(
    "credit_engine",
    broker=settings.redis_url,
    backend=settings.redis_url,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    broker_connection_retry_on_startup=True,
    beat_schedule={
        "check-scheduled-rules": {
            "task": "app.tasks.check_scheduled_rules",
            "schedule": 60.0,
        },
        "check-scheduled-batches": {
            "task": "app.tasks.check_scheduled_batches",
            "schedule": 60.0,
        },
        "reconcile-new-items": {
            "task": "app.tasks.reconcile_new_items",
            "schedule": 120.0,
        },
        # Checks staleness only — the actual rebuild is skipped unless a library is past
        # settings.content_sync_interval_hours, so this running often is cheap.
        "check-content-sync": {
            "task": "app.tasks.check_content_sync",
            "schedule": 900.0,
        },
        "prune-logs": {
            "task": "app.tasks.prune_logs",
            "schedule": 600.0,
        },
    },
)

celery_app.autodiscover_tasks(["app"])
