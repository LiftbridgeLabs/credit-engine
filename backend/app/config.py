from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    redis_url: str

    secret_key: str
    session_ttl_hours: int = 24 * 14

    plex_client_identifier: str
    plex_product: str = "CreditEngine"

    class Config:
        env_file = ".env"


settings = Settings()
