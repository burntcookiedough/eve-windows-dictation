"""Entry point for running the murmur with uvicorn."""

import uvicorn

from murmur.config import get_settings


def main() -> None:
    """Run the murmur."""
    settings = get_settings()

    uvicorn.run(
        "murmur.app:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
