from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

PLATFORM_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """Runtime configuration, read from AIMEM_* environment variables and platform/.env."""

    model_config = SettingsConfigDict(
        env_prefix="AIMEM_",
        env_file=PLATFORM_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: str = "dev"
    # Runtime role: may INSERT and SELECT audit rows, never UPDATE or DELETE them.
    database_url: str = "postgresql+psycopg://aimem_platform_app@localhost:5432/aimem_platform"
    # Owner role: runs migrations. Never used by the running API.
    owner_database_url: str | None = None
    # Throwaway databases for the test suite. Tests refuse any name not ending in _test.
    test_database_url: str | None = None
    test_owner_database_url: str | None = None

    features_path: Path = PLATFORM_ROOT / "features.yaml"
    var_dir: Path = PLATFORM_ROOT / "var"

    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]
    allow_anonymous_ui_events: bool = True
    session_ttl_hours: int = 12
    cookie_name: str = "aimem_session"
    cookie_secure: bool = False
    cookie_samesite: str = "lax"

    ui_events_per_minute: int = 1200
    login_attempts_per_minute: int = 10
    max_ui_batch: int = 200
    max_ui_details_bytes: int = 16_384
    max_artifact_bytes: int = 64 * 1024 * 1024

    otel_console: bool = False

    # Phase 1 runs
    repo_root: Path = PLATFORM_ROOT.parent
    toolchains_path: Path = PLATFORM_ROOT / "toolchains.lock.json"
    runner: str = "docker"  # docker (sandboxed) or local (tests only; no isolation)
    docker_bin: str = "docker"
    keep_run_workspaces: bool = False
    run_log_chunk_bytes: int = 262_144

    # Phase 2 agents. The local route (Ollama) is the default. The hosted route (Claude)
    # is available only when a key is configured here and a mission opts in.
    agent_route: str = "local"
    ollama_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen3.6:35b"
    ollama_context_tokens: int = 32_768
    ollama_think: bool | None = False  # None omits the flag for models without a thinking mode
    anthropic_api_key: SecretStr | None = None  # AIMEM_ANTHROPIC_API_KEY in platform/.env
    anthropic_base_url: str = "https://api.anthropic.com"
    anthropic_model: str = "claude-opus-5"
    anthropic_usd_per_mtok: tuple[float, float] = (5.0, 25.0)  # input, output
    llm_timeout_s: float = 900.0
    llm_max_output_tokens: int = 4_096
    task_max_tokens: int = 60_000
    mission_max_tokens: int = 400_000
    mission_max_usd: float = 5.0

    @property
    def artifact_root(self) -> Path:
        return self.var_dir / "artifacts"

    @property
    def fallback_path(self) -> Path:
        """Where audit events go when the database write fails after an action ran."""
        return self.var_dir / "audit-fallback.jsonl"

    def anchor_path(self, database_name: str) -> Path:
        """External record of verified chain heads, one file per database."""
        return self.var_dir / f"audit-anchors-{database_name}.jsonl"


@lru_cache
def get_settings() -> Settings:
    return Settings()
