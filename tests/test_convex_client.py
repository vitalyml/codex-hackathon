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


async def test_upload_returns_the_storage_id():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/mutation":
            return httpx.Response(
                200, json={"status": "success", "value": "https://x.convex.cloud/up"}
            )
        assert request.content == b"jpeg" and request.url.path == "/up"
        return httpx.Response(200, json={"storageId": "kg2"})

    assert await convex(handler).upload(b"jpeg") == "kg2"


async def test_failures_raise_convex_error():
    def failed(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"status": "error", "errorMessage": "forbidden"}
        )

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    with pytest.raises(ConvexError, match="forbidden"):
        await convex(failed).mutation("worker:uploadUrl")
    with pytest.raises(ConvexError, match="no route"):
        await convex(down).query("sessions:live", sessionId="abc")
