from celery import Celery

from app.config import settings
from app.log_handler import install_log_handler

install_log_handler()

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
