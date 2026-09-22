import asyncio
import base64
import json

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from src.server.cv.perception import Detection, Observation
from src.server.engine import handle_frame
from src.server.notifier import Notifier
from src.server.privacy import encrypt
from src.server.session import Feed
from tests.fake_convex import FakeConvex
from tests.test_engine import image


def keys():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = base64.b64encode(
        private.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
    ).decode()
    return private, public


def decrypt(text, private, context):
    box = json.loads(text.removeprefix("enc:v1:"))
    key = private.decrypt(
        base64.b64decode(box["key"]),
        padding.OAEP(
            mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None
        ),
    )
    return (
        AESGCM(key)
        .decrypt(
            base64.b64decode(box["iv"]), base64.b64decode(box["data"]), context.encode()
        )
        .decode()
    )


async def test_worker_gets_clear_rules_but_only_writes_encrypted_text():
    private, public = keys()
    convex = FakeConvex()
    session = convex.add(
        "s",
        (
            encrypt("private rule", public, "rule"),
            encrypt("private predicate", public, "predicate"),
            "rising",
        ),
    )
    session["encryptionKey"] = public

    class Model:
        async def detect(self, jpeg, predicates):
            assert predicates == ["private predicate"]
            return Detection([Observation(True, "private evidence")])

    feed = Feed()
    await handle_frame(
        feed,
        "s",
        image(),
        Model(),
        convex,
        Notifier(),
        clear_watches=[
            {"id": "s-w0", "rule": "private rule", "predicate": "private predicate"}
        ],
    )
    await feed.task
    await asyncio.gather(*feed.notifications)
    assert not feed.retry
    assert "private" not in json.dumps(convex.events)
    assert "private" not in json.dumps(convex.sessions)
    assert (
        decrypt(session["watches"][0]["evidence"], private, "evidence")
        == "private evidence"
    )
    assert (
        decrypt(convex.events[0]["text"], private, "text")
        == "private predicate - became true"
    )
    assert decrypt(convex.events[0]["rule"], private, "rule") == "private rule"


async def test_worker_does_not_send_ciphertext_to_the_model_without_browser_key():
    _, public = keys()
    convex = FakeConvex()
    convex.add("s", ("enc:v1:rule", "enc:v1:predicate", "rising"))[
        "encryptionKey"
    ] = public

    class Never:
        async def detect(self, *args):
            raise AssertionError("ciphertext must not reach the model")

    feed = Feed()
    await handle_frame(feed, "s", image(), Never(), convex, Notifier())
    await feed.task
    assert feed.retry
    assert not convex.events


@pytest.mark.parametrize("public", ["MIIBbroken", "MIIB", "MIIB!!!!"])
async def test_invalid_recipient_never_causes_a_paid_model_call(public):
    convex = FakeConvex()
    convex.add("s", ("enc:v1:r", "enc:v1:p", "rising"))["encryptionKey"] = public

    class Never:
        async def detect(self, *args):
            pytest.fail("invalid public key reached the paid model")

    feed = Feed()
    clear = [{"id": "s-w0", "rule": "r", "predicate": "p"}]
    for _ in range(2):
        await handle_frame(
            feed, "s", image(), Never(), convex, Notifier(), clear_watches=clear
        )
        await feed.task
    assert not convex.events and not convex.usage


@pytest.mark.parametrize("partial", [False, True])
async def test_replaced_rules_are_retried_even_when_the_next_frame_is_quiet(partial):
    _, public = keys()
    convex = FakeConvex()
    args = [("enc:v1:r", "enc:v1:p", "rising")]
    if partial:
        args.append(("enc:v1:r2", "enc:v1:p2", "rising"))
    convex.add("s", *args)["encryptionKey"] = public

    class Model:
        calls = 0

        async def detect(self, jpeg, predicates):
            self.calls += 1
            return Detection([Observation(False, "quiet") for _ in predicates])

    model, feed = Model(), Feed()
    old = [{"id": "s-w0" if partial else "replaced", "rule": "r", "predicate": "p"}]
    await handle_frame(feed, "s", image(), model, convex, Notifier(), clear_watches=old)
    await feed.task
    assert feed.retry
    assert model.calls == int(partial)
    fresh = [{"id": f"s-w{i}", "rule": "r", "predicate": "p"} for i in range(len(args))]
    result = await handle_frame(
        feed, "s", image(), model, convex, Notifier(), clear_watches=fresh
    )
    await feed.task
    assert result["sent"] and not feed.retry
    assert model.calls == int(partial) + 1
