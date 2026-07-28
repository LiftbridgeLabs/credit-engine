from celery import Celery

from app.config import settings

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
    },
)

celery_app.autodiscover_tasks(["app"])
