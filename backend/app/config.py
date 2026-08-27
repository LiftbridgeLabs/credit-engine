from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    redis_url: str

    secret_key: str
    session_ttl_hours: int = 24 * 14

    plex_client_identifier: str
    plex_product: str = "CreditEngine"

    # How often the browse cache (CachedItem) is rebuilt from Plex, in hours — see
    # tasks.check_content_sync. Env-driven rather than a row in AppSettings because there's no
    # migration story here (Base.metadata.create_all only ever creates missing tables, never adds
    # columns to existing ones), so a new settings column wouldn't reach an already-deployed
    # database. 0 disables the periodic rebuild, leaving only the manual Sync button.
    content_sync_interval_hours: int = 24

    class Config:
        env_file = ".env"


settings = Settings()
