from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    redis_url: str

    secret_key: str
    session_ttl_hours: int = 24 * 14

    plex_client_identifier: str
    plex_product: str = "CreditEngine"

    # Seed for AppSettings.content_sync_interval_hours, which is where the interval actually lives
    # now that app/migrations.py can add a column to a deployed database. Read once, by the
    # migration that first creates the column — so an install that had deliberately set this env
    # var keeps its value on upgrade instead of silently reverting to the default. Nothing reads it
    # afterwards; the Settings page is the source of truth from then on.
    content_sync_interval_hours: int = 24

    # Build stamp, set by the Dockerfile's APP_VERSION arg. "dev" means an unstamped build (running
    # from source, or a plain `docker build` with no --build-arg).
    app_version: str = "dev"

    class Config:
        env_file = ".env"


settings = Settings()
