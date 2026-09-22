"""Encrypt model output for the browser. This process never receives a private key."""

import base64
import json
import os
from functools import lru_cache

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


@lru_cache(maxsize=64)
def load_public_key(public_key: str) -> rsa.RSAPublicKey:
    recipient = serialization.load_der_public_key(
        base64.b64decode(public_key, validate=True)
    )
    if not isinstance(recipient, rsa.RSAPublicKey) or recipient.key_size != 2048:
        raise ValueError("invalid encryption public key")
    return recipient


def encrypt(text: str, public_key: str, context: str) -> str:
    recipient = load_public_key(public_key)
    key = AESGCM.generate_key(bit_length=256)
    iv = os.urandom(12)
    data = AESGCM(key).encrypt(iv, text.encode(), context.encode())
    wrapped = recipient.encrypt(
        key,
        padding.OAEP(
            mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None
        ),
    )
    return "enc:v1:" + json.dumps(
        {
            name: base64.b64encode(value).decode()
            for name, value in {"key": wrapped, "iv": iv, "data": data}.items()
        },
        separators=(",", ":"),
    )
