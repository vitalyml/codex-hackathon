"""Convex over its HTTP API: all durable state lives there, the worker only computes."""

from typing import Any, Optional

import httpx


class ConvexError(Exception):
    pass


class Convex:
    def __init__(
        self, url: str, secret: str, client: Optional[httpx.AsyncClient] = None
    ) -> None:
        if not url:
            raise ValueError("no CONVEX_URL configured")
        self.url = url.rstrip("/")
        self.secret = secret
        self.client = client or httpx.AsyncClient(timeout=10)

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _call(self, kind: str, path: str, args: dict[str, Any]) -> Any:
        # Convex functions cannot read headers, so the worker tier takes the shared
        # secret as an argument.
        if path.startswith("worker:"):
            args = {**args, "secret": self.secret}
        try:
            response = await self.client.post(
                f"{self.url}/api/{kind}",
                json={"path": path, "args": args, "format": "json"},
            )
            body = response.json()
        except (httpx.HTTPError, ValueError) as e:
            raise ConvexError(f"{path}: {e}") from e
        if body.get("status") != "success":
            raise ConvexError(f"{path}: {body.get('errorMessage', response.text)}")
        return body.get("value")

    async def query(self, path: str, **args: Any) -> Any:
        return await self._call("query", path, args)

    async def mutation(self, path: str, **args: Any) -> Any:
        return await self._call("mutation", path, args)

    async def upload(self, jpeg: bytes) -> str:
        """Store an event photo; returns the storageId for worker:record."""
        url = await self.mutation("worker:uploadUrl")
        try:
            response = await self.client.post(
                url, content=jpeg, headers={"content-type": "image/jpeg"}
            )
            response.raise_for_status()
            return str(response.json()["storageId"])
        except (httpx.HTTPError, ValueError, KeyError) as e:
            raise ConvexError(f"upload: {e}") from e
