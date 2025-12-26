"""Application configuration for the torghut service."""

from functools import lru_cache
from typing import Literal, Optional

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-backed settings."""

    app_env: Literal["dev", "stage", "prod"] = Field(
        default="dev", alias="APP_ENV", description="Deployment environment."
    )
    db_dsn: str = Field(
        default="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        alias="DB_DSN",
        validation_alias=AliasChoices("DB_DSN", "DB_URL", "DATABASE_URL"),
        description="PostgreSQL connection string.",
    )
    apca_api_key_id: Optional[str] = Field(default=None, alias="APCA_API_KEY_ID")
    apca_api_secret_key: Optional[str] = Field(default=None, alias="APCA_API_SECRET_KEY")
    apca_api_base_url: Optional[str] = Field(default=None, alias="APCA_API_BASE_URL")
    apca_data_api_base_url: Optional[str] = Field(default=None, alias="APCA_DATA_API_BASE_URL")
    clickhouse_host: str = Field(
        default="torghut-clickhouse.torghut.svc.cluster.local",
        alias="CLICKHOUSE_HOST",
    )
    clickhouse_port: int = Field(default=8123, alias="CLICKHOUSE_PORT")
    clickhouse_database: str = Field(default="torghut", alias="CLICKHOUSE_DATABASE")
    clickhouse_username: Optional[str] = Field(default="torghut", alias="CLICKHOUSE_USERNAME")
    clickhouse_password: Optional[str] = Field(default=None, alias="CLICKHOUSE_PASSWORD")
    clickhouse_secure: bool = Field(default=False, alias="CLICKHOUSE_SECURE")
    clickhouse_timeout_seconds: int = Field(default=10, alias="CLICKHOUSE_TIMEOUT_SECONDS")

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @property
    def sqlalchemy_dsn(self) -> str:
        """Return a SQLAlchemy-friendly DSN, normalizing postgres URIs to psycopg."""

        if self.db_dsn.startswith("postgresql+psycopg://"):
            return self.db_dsn

        if self.db_dsn.startswith("postgres://"):
            return self.db_dsn.replace("postgres://", "postgresql+psycopg://", 1)

        if self.db_dsn.startswith("postgresql://"):
            return self.db_dsn.replace("postgresql://", "postgresql+psycopg://", 1)

        return self.db_dsn

    @property
    def clickhouse_http_url(self) -> str:
        """Return the ClickHouse HTTP base URL."""

        scheme = "https" if self.clickhouse_secure else "http"
        return f"{scheme}://{self.clickhouse_host}:{self.clickhouse_port}"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached Settings instance so values are loaded once."""

    return Settings()  # type: ignore[call-arg]


settings = get_settings()
