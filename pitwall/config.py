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
    # Moss indexer: reads golden+work to build retrieval docs, writes ONLY the two
    # telemetry tables (moss_outbox, retrieval_metric) + its own audit rows. It can
    # never touch the ledger, installments, or payroll — limits in the DB, not a prompt.
    "retrieval": "retrieval",
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
    pitwall_retrieval_db_password: str = "retrieval_dev"
    pitwall_database_url: str | None = None

    # --- world ---
    pitwall_seed: int = 1313
    pitwall_scale: str = "demo"

    # --- agent ---
    anthropic_api_key: str | None = None
    pitwall_agent_model: str = "claude-sonnet-4-6"
    pitwall_llm_mode: str = "auto"
    # agent context: onboarded = uses learned policies; newbie/no-context = escalates
    # everything (showcase of what the learned policies are worth)
    pitwall_agent_mode: str = "onboarded"
    pitwall_agent_daily_evidence_budget_usdc: float = 5.0
    pitwall_approval_threshold_usdc: float = 250000.0

    # memory recall: how many prior memories to pull per lookup, and the similarity
    # floor below which a hit is dropped (so a novel prompt says "no close match"
    # instead of surfacing irrelevant memories — nonsense scores ~0, real hits >0.3)
    pitwall_recall_top_k: int = 3
    pitwall_recall_min_score: float = 0.2

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

    # --- moss (semantic retrieval; Tiger stays the source of truth) ---
    moss_project_id: str | None = None
    moss_project_key: str | None = None
    pitwall_moss_mode: str = "auto"          # auto | off  (auto = on iff creds present)
    pitwall_moss_index_prefix: str = "pitwall"

    # ------------------------------------------------------------------ roles
    @property
    def _role_passwords(self) -> dict[str, str]:
        return {
            "agent": self.pitwall_agent_db_password,
            "gateway": self.pitwall_gateway_db_password,
            "sync": self.pitwall_sync_db_password,
            "voice": self.pitwall_voice_db_password,
            "retrieval": self.pitwall_retrieval_db_password,
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

    @property
    def moss_is_live(self) -> bool:
        if self.pitwall_moss_mode == "off":
            return False
        return bool(self.moss_project_id and self.moss_project_key)  # auto

    def moss_index(self, name: str) -> str:
        """Fully-qualified Moss index name, e.g. 'pitwall_clauses'."""
        return f"{self.pitwall_moss_index_prefix}_{name}"


@lru_cache
def get_settings() -> Settings:
    return Settings()


# Runtime agent-context override — flipped live by the control-room toggle (a button
# switches the current agent between a seasoned 'onboarded' agent and a 'newbie').
# Falls back to the PITWALL_AGENT_MODE env default.
_RUNTIME_AGENT_MODE: str | None = None


def set_agent_mode(mode: str) -> None:
    global _RUNTIME_AGENT_MODE
    _RUNTIME_AGENT_MODE = mode


def get_agent_mode() -> str:
    return _RUNTIME_AGENT_MODE or get_settings().pitwall_agent_mode


# the display name of the agent that was onboarded this session (so the stadium can
# show "X is already onboarded" when you reopen the Onboard panel)
_RUNTIME_AGENT_NAME: str | None = None


def set_agent_name(name: str | None) -> None:
    global _RUNTIME_AGENT_NAME
    if name:
        _RUNTIME_AGENT_NAME = name


def get_agent_name() -> str | None:
    return _RUNTIME_AGENT_NAME


# the roster of agents onboarded this session — each with the policy snapshot it
# approved. The Onboard panel lists these (you view an agent's policies here; you do
# NOT pick policies up front — the agent learns them from the data).
_ONBOARDED_AGENTS: list[dict] = []


def register_onboarded_agent(name: str | None, policies: list[dict], *, engine: str | None = None) -> dict:
    global _ONBOARDED_AGENTS
    from datetime import datetime, timezone

    name = (name or "Agent").strip() or "Agent"
    rec = {"name": name, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "engine": engine, "policies": policies or []}
    _ONBOARDED_AGENTS = [a for a in _ONBOARDED_AGENTS if a["name"] != name]  # re-onboard replaces
    _ONBOARDED_AGENTS.append(rec)
    set_agent_name(name)
    return rec


def list_onboarded_agents() -> list[dict]:
    return list(reversed(_ONBOARDED_AGENTS))  # newest first


def reset_agents() -> None:
    """Forget every onboarded agent + the current agent name (back to a blank slate)."""
    global _ONBOARDED_AGENTS, _RUNTIME_AGENT_NAME
    _ONBOARDED_AGENTS = []
    _RUNTIME_AGENT_NAME = None
