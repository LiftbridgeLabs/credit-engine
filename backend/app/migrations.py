"""Additive schema migrations, run at process startup.

Base.metadata.create_all() only ever creates *missing tables* — it will not touch a table that
already exists. So any column added to a model after first deploy is invisible to an
already-deployed database, and every query naming that column fails against it. Until this module
existed, that meant new settings had to live in environment variables instead of the settings
table, because a new column could never reach a running install.

Scope is deliberately narrow: this adds columns the models declare and the database lacks, and
nothing else. It never drops, renames or retypes a column, so it cannot destroy data — the failure
mode of a bad guess here is an unused column, not a lost one. Anything beyond that (a real rename,
a backfill with logic, a type change) wants a proper migration tool; this is the small,
safe subset that removes the "can't add a setting" problem.
"""

import logging

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from app.config import settings
from app.db import Base

# Imported for the side effect of registering every model on Base.metadata — without it
# sorted_tables is empty and this module silently migrates nothing.
from app import models  # noqa: F401  isort:skip

logger = logging.getLogger(__name__)


def _column_default(col):
    """The model's Python-side scalar default, or None if it has none or it's a callable
    (e.g. _utcnow) — a callable can't be evaluated meaningfully for rows that already exist."""
    if col.default is None or col.default.is_callable:
        return None
    return col.default.arg


def _add_column(conn, table, col, dialect) -> None:
    """Add one column in three steps rather than a single DDL statement with a DEFAULT clause: add
    it nullable, fill existing rows through a bound parameter (DDL can't take bind parameters, and
    interpolating a literal into DDL is how quoting bugs get in), then apply NOT NULL if the model
    asks for it. Identifiers come from our own models, never from user input."""
    type_sql = col.type.compile(dialect=dialect)
    conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN IF NOT EXISTS "{col.name}" {type_sql}'))

    default = _column_default(col)
    if default is not None:
        conn.execute(
            text(f'UPDATE "{table.name}" SET "{col.name}" = :value WHERE "{col.name}" IS NULL'),
            {"value": default},
        )

    if not col.nullable:
        if default is None:
            # No default to backfill with, so existing rows would violate the constraint. Leaving
            # the column nullable is the safe outcome: the application still works, and the
            # alternative is refusing to start.
            logger.warning(
                "Migration: %s.%s is declared NOT NULL but has no default — left nullable",
                table.name,
                col.name,
            )
            return
        conn.execute(text(f'ALTER TABLE "{table.name}" ALTER COLUMN "{col.name}" SET NOT NULL'))


def run_migrations(engine: Engine) -> None:
    """Bring an existing database up to whatever columns the models now declare.

    Safe to run concurrently from more than one process — web, worker and beat all start at once
    under supervisor — because ADD COLUMN IF NOT EXISTS makes a lost race a no-op rather than an
    error. Cheap enough to run unconditionally on every start: one catalogue read per table when
    there's nothing to do."""
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    added: list[tuple[str, str]] = []

    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue  # create_all handles brand new tables, with every column already present
            existing_columns = {c["name"] for c in inspector.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing_columns:
                    continue
                logger.info("Migration: adding %s.%s", table.name, col.name)
                _add_column(conn, table, col, engine.dialect)
                added.append((table.name, col.name))

        if ("app_settings", "content_sync_interval_hours") in added:
            _seed_content_sync_interval(conn)

    if added:
        logger.info("Migration: added %d column(s): %s", len(added), ", ".join(f"{t}.{c}" for t, c in added))


def _seed_content_sync_interval(conn) -> None:
    """Carry CONTENT_SYNC_INTERVAL_HOURS over the one time this column appears.

    The interval shipped as an environment variable before it could live in the settings table, and
    an install that deliberately set it (to 0, to stop a large sync running unattended) would
    otherwise silently get the column default instead on upgrade. Runs only on the migration that
    actually adds the column, so it can't overwrite a value later chosen in the UI."""
    conn.execute(
        text("UPDATE app_settings SET content_sync_interval_hours = :value"),
        {"value": settings.content_sync_interval_hours},
    )
    logger.info(
        "Migration: seeded content_sync_interval_hours from CONTENT_SYNC_INTERVAL_HOURS (%dh)",
        settings.content_sync_interval_hours,
    )
