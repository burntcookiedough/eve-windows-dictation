"""Engine metadata types used by the legacy transport boundary."""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class EngineInfo:
    id: str
    name: str
    model: str                   # Model identifier
    supports_hotwords: bool
    languages: list[str] = field(default_factory=lambda: ["en"])
    model_size_gb: float = 0.0
    gpu_name: str | None = None
    gpu_vram_gb: float | None = None
    estimated_max_duration_s: int | None = None
    repo_id: str | None = None
    model_path: str | None = None
    device: str | None = None
    compute_type: str | None = None
    cuda_active: bool | None = None
    load_time_s: float | None = None
    last_transcription_latency_s: float | None = None
    vram_used_gb: float | None = None
