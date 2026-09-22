import json

import httpx
import pytest

from src.server.convex_client import Convex, ConvexError


def convex(handler) -> Convex:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return Convex("https://x.convex.cloud/", "s3cret", client)


async def test_secret_goes_to_the_worker_tier_only():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, json.loads(request.content)))
        return httpx.Response(200, json={"status": "success", "value": {"ok": 1}})

    c = convex(handler)
    assert await c.query("sessions:live", sessionId="abc") == {"ok": 1}
    await c.mutation("worker:record", sessionId="abc")
    assert seen[0] == (
        "/api/query",
        {"path": "sessions:live", "args": {"sessionId": "abc"}, "format": "json"},
    )
    assert seen[1][0] == "/api/mutation"
    assert seen[1][1]["args"] == {"sessionId": "abc", "secret": "s3cret"}


async def test_failures_raise_convex_error():
    def failed(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"status": "error", "errorMessage": "forbidden"}
        )

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    with pytest.raises(ConvexError, match="forbidden"):
        await convex(failed).mutation("worker:record")
    with pytest.raises(ConvexError, match="no route"):
        await convex(down).query("sessions:live", sessionId="abc")
