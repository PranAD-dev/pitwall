"""Typed settings loaded from .env. Also derives per-role database URLs so the
app can connect as a least-privilege role (agent/gateway/sync/voice) instead of
the superuser."""

from __future__ import annotations

from functools import lru_cache
from urllib.parse import quote, urlsplit, urlunsplit

from pydantic_settings import BaseSettings, SettingsConfigDict

# App role -> the Postgres role name created by the migration.
ROLE_USERS = {
    "agent": "pitwall_agent",
    "gateway": "gateway",
    "sync": "sync",
    "voice": "voice_readonly",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    # --- database ---
    pitwall_db_host: str = "localhost"
    pitwall_db_port: int = 5432
    pitwall_db_name: str = "pitwall"
    pitwall_db_superuser: str = "postgres"
    pitwall_db_superuser_password: str = "pitwall_dev"
    pitwall_agent_db_password: str = "agent_dev"
    pitwall_gateway_db_password: str = "gateway_dev"
    pitwall_sync_db_password: str = "sync_dev"
    pitwall_voice_db_password: str = "voice_dev"
    pitwall_database_url: str | None = None

    # --- world ---
    pitwall_seed: int = 1313
    pitwall_scale: str = "demo"

    # --- agent ---
    anthropic_api_key: str | None = None
    pitwall_agent_model: str = "claude-sonnet-4-6"
    pitwall_llm_mode: str = "auto"
    pitwall_agent_daily_evidence_budget_usdc: float = 5.0
    pitwall_approval_threshold_usdc: float = 250000.0

    # --- x402 ---
    cdp_api_key_id: str | None = None
    cdp_api_key_secret: str | None = None
    cdp_wallet_secret: str | None = None
    pitwall_x402_mode: str = "mock"
    pitwall_x402_network: str = "base-sepolia"
    pitwall_sellers_url: str = "http://localhost:4021"

    # --- voice ---
    livekit_url: str | None = None
    livekit_api_key: str | None = None
    livekit_api_secret: str | None = None
    cartesia_api_key: str | None = None

    # ------------------------------------------------------------------ roles
    @property
    def _role_passwords(self) -> dict[str, str]:
        return {
            "agent": self.pitwall_agent_db_password,
            "gateway": self.pitwall_gateway_db_password,
            "sync": self.pitwall_sync_db_password,
            "voice": self.pitwall_voice_db_password,
        }

    def _build_url(self, user: str, password: str) -> str:
        return (
            f"postgresql://{quote(user)}:{quote(password)}@"
            f"{self.pitwall_db_host}:{self.pitwall_db_port}/{self.pitwall_db_name}"
        )

    @staticmethod
    def _swap_userinfo(url: str, user: str, password: str) -> str:
        parts = urlsplit(url)
        hostport = parts.netloc.rsplit("@", 1)[-1]
        netloc = f"{quote(user)}:{quote(password)}@{hostport}"
        return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))

    def superuser_url(self) -> str:
        """Connection for migrations + role creation."""
        if self.pitwall_database_url:
            return self.pitwall_database_url
        return self._build_url(self.pitwall_db_superuser, self.pitwall_db_superuser_password)

    def role_url(self, role: str) -> str:
        """Connection for a least-privilege app role."""
        if role == "superuser":
            return self.superuser_url()
        user = ROLE_USERS[role]
        password = self._role_passwords[role]
        if self.pitwall_database_url:
            return self._swap_userinfo(self.pitwall_database_url, user, password)
        return self._build_url(user, password)

    def role_credentials(self) -> dict[str, str]:
        """Postgres role name -> password, for the migration to create/alter."""
        return {ROLE_USERS[role]: pw for role, pw in self._role_passwords.items()}

    @property
    def llm_is_live(self) -> bool:
        if self.pitwall_llm_mode == "mock":
            return False
        if self.pitwall_llm_mode == "live":
            return True
        return bool(self.anthropic_api_key)  # auto

    @property
    def x402_is_live(self) -> bool:
        return self.pitwall_x402_mode == "testnet" and bool(self.cdp_api_key_id)


@lru_cache
def get_settings() -> Settings:
    return Settings()
