"""Reject browser-originated, remote, and rebinding requests to the local service."""

from __future__ import annotations

import ipaddress
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

ASGIApp = Callable[..., Awaitable[None]]


def _is_loopback_peer(client: Any) -> bool:
    """Check the ASGI socket peer, allowing common in-process test scopes."""
    if client is None:
        return True
    try:
        host = client[0]
    except (IndexError, TypeError):
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except (TypeError, ValueError):
        return False


def is_loopback_host(authority: str) -> bool:
    """Accept only localhost or a canonical loopback IP, with an optional port."""
    if not authority or authority != authority.strip() or any(
        character in authority for character in "\r\n/@?#"
    ):
        return False

    try:
        parsed = urlsplit(f"//{authority}")
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return False

    if (
        parsed.netloc != authority
        or parsed.path
        or parsed.query
        or parsed.fragment
        or hostname is None
        or (port is not None and not 1 <= port <= 65535)
    ):
        return False

    if hostname.casefold() == "localhost":
        return True

    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


class LocalRequestBoundary:
    """Apply local-only Host and browser Origin checks to HTTP and WebSockets."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self,
        scope: dict[str, Any],
        receive: Callable[..., Any],
        send: Callable[..., Any],
    ) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        if not _is_loopback_peer(scope.get("client")):
            await self._reject(scope, send)
            return

        headers = scope.get("headers", ())
        if any(name.lower() == b"origin" for name, _ in headers):
            await self._reject(scope, send)
            return

        hosts = [value for name, value in headers if name.lower() == b"host"]
        if len(hosts) != 1:
            await self._reject(scope, send)
            return
        try:
            host = hosts[0].decode("ascii")
        except UnicodeDecodeError:
            await self._reject(scope, send)
            return
        if not is_loopback_host(host):
            await self._reject(scope, send)
            return

        await self.app(scope, receive, send)

    @staticmethod
    async def _reject(scope: dict[str, Any], send: Callable[..., Any]) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return

        body = b"Local clients only"
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
