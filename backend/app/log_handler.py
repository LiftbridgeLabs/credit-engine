import logging

from app.db import SessionLocal
from app.models import LogEntry

# Third-party libraries that log routine per-request noise at INFO — left un-silenced, a single
# Plex library scan or a page of pagination in the UI would flood the log table with entries no one
# asked to see. The root logger stays at DEBUG so app.* loggers pass everything through for the
# "Debug" filter tier; these are the exceptions, dialed back to WARNING individually.
_QUIET_LOGGERS = ["httpx", "httpcore", "urllib3", "uvicorn.access", "asyncio", "celery.utils.functional"]


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
