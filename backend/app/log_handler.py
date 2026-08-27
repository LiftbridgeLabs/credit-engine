import logging

from celery.signals import after_setup_logger, after_setup_task_logger

from app.db import SessionLocal
from app.models import LogEntry

# Third-party libraries that log routine per-request noise at INFO — left un-silenced, a single
# Plex library scan or a page of pagination in the UI would flood the log table with entries no one
# asked to see. The root logger stays at DEBUG so app.* loggers pass everything through for the
# "Debug" filter tier; these are the exceptions, dialed back to WARNING individually.
# "celery" covers the worker's own per-task chatter, which is genuinely per-task: a single library
# sync queues thousands of scans, and "Task received"/"succeeded" for each would bury the app's own
# progress lines in the very view meant to show them (5 days of container stdout held ~19k
# "received" lines). Its ERROR records — the "Task raised unexpected" tracebacks — still come
# through, which is the part worth keeping.
_QUIET_LOGGERS = [
    "httpx",
    "httpcore",
    "urllib3",
    "uvicorn.access",
    "asyncio",
    "celery",
    "kombu",
    "amqp",
]


class DatabaseLogHandler(logging.Handler):
    """Writes every log record to the log_entries table. Never raises — a logging failure (DB
    briefly unavailable, table not migrated yet on a fresh container) must not take down whatever
    code was trying to log in the first place."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = self.format(record)
            db = SessionLocal()
            try:
                db.add(
                    LogEntry(
                        level=record.levelname,
                        logger_name=record.name,
                        message=message,
                        server_id=getattr(record, "server_id", None),
                    )
                )
                db.commit()
            finally:
                db.close()
        except Exception:  # noqa: BLE001 — logging must never be the thing that crashes the app
            pass


def install_log_handler() -> None:
    """Call once, at process startup (FastAPI's main.py and Celery's celery_app.py both do this) —
    idempotent, so it's safe if celery_app is imported multiple times within the same process."""
    root = logging.getLogger()
    if any(isinstance(h, DatabaseLogHandler) for h in root.handlers):
        return

    handler = DatabaseLogHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)

    for name in _QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


@after_setup_logger.connect
@after_setup_task_logger.connect
def _reinstall_after_celery_setup(**_kwargs) -> None:
    """Put the database handler back after Celery has configured logging in a worker or beat process.

    Celery replaces the root logger's handlers wholesale at startup (worker_hijack_root_logger,
    on by default), so the handler installed when celery_app was imported was gone before a single
    task ran — root went from [DatabaseLogHandler] to [StreamHandler]. Every task log line (scans,
    rule applies, library sync progress) reached the container's stdout and nowhere else, which is
    why the Logs page only ever showed records emitted by the web process.

    Re-installing here rather than setting worker_hijack_root_logger=False is deliberate: Celery
    still configures its own stdout logging exactly as it always has, and the database handler is
    simply added back alongside it once that's done."""
    install_log_handler()
