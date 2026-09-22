# Encrypted history MVP

New sessions started by the web page save rules, normalized predicates, evidence and
event text as encrypted envelopes in Convex. Existing sessions keep their legacy
behavior; this change does not migrate or erase old plaintext or its backups.

The browser generates an RSA-OAEP/SHA-256 key pair with Web Crypto and keeps the
non-exportable private CryptoKey only in page memory. The public SPKI key identifies the recipient in
Convex. Each text field uses a fresh AES-256-GCM key and 96-bit random nonce; RSA
wraps that AES key. The field name is authenticated as additional data. The
versioned `enc:v1:` envelope contains only the wrapped key, nonce and ciphertext.

Rules go directly to the Python worker for normalization, then the browser encrypts
both original and normalized text before calling Convex. For model calls the
browser includes clear rules with the camera frame. The worker encrypts generated
evidence and event text using the session's public key before writing to Convex.
It validates the public key before calling the model and never receives the private key. Model processing and enabled Telegram alerts
still see readable content; this is encrypted storage, not private inference.

Browser decryption caches private keys in memory and up to 256 decrypted envelopes,
keyed by recipient, field context and ciphertext. Failed decryptions are not retained.

## Session lifecycle

Keys are created automatically for each Watch. Stop, heartbeat expiry observed by
this page, reload, and tab closure discard the private key and decryption cache.
Restart generates a fresh pair. Hiding a tab pauses uploads but keeps the session.
The page does not persist session IDs or resume old sessions, and exposes no key
export, import, or saved-history controls. Legacy browser key storage is removed
when the new page loads. Previously stored ciphertext remains in Convex but cannot
be reopened with this UI. Already downloaded recovery files cannot be revoked.

Stop and heartbeat expiry still archive encrypted rows in Convex; this change does
not delete server records. Session results already rendered remain visible after
Stop until the next Watch or page reload. Telegram live alerts remain readable.

## Limits

This protects text in a database dump. It does not protect against malicious code
in the browser, a compromised device, the model/compute provider, or someone who copied a private key from a previous version. The current application's session/subscriber capability IDs and
public mutation permissions are unchanged: encryption does not add account-based
authorization or prevent someone with IDs from stopping/removing data. Public-key
encryption also does not authenticate an author. Metadata (time, state, IDs, public
key, usage, ciphertext size) remains visible. This MVP has no key rotation, device
revocation, comprehensive migration, or automatic retention limit for encrypted
sessions.

## Validation and rollout

Run `make format`, `make lint`, `make test`, and:

```sh
node --test tests/test_web_client.js tests/test_dictation.js tests/test_encrypted_convex.js
# With Playwright and its Chromium installed (or PLAYWRIGHT_CHANNEL=chrome):
node --test tests/test_privacy_browser.js
```

Browser tests use real Web Crypto and mocked Convex transport. They test
non-exportable memory-only keys, tab closure, reload, Stop/restart, field-context
validation, Python-to-browser encryption, and absence of recovery controls.
Convex handler tests exercise encryption guards and retention without a deployment.

Deploy the Python worker, Convex functions/schema, and frontend together. The worker
must have `cryptography` installed from the updated Poetry lock before the new page
is enabled. No new environment variables or server-side decryption secrets are needed.
