"""Entry point for running the voiceserver with uvicorn."""

import uvicorn

from voiceserver.config import get_settings


def main() -> None:
    """Run the voiceserver."""
    settings = get_settings()

    uvicorn.run(
        "voiceserver.app:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
