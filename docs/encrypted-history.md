# Encrypted history MVP

New sessions started by the web page save rules, normalized predicates, evidence and
event text as encrypted envelopes in Convex. Existing sessions keep their legacy
behavior; this change does not migrate or erase old plaintext or its backups.

The browser generates an RSA-OAEP/SHA-256 key pair with Web Crypto and stores the
private CryptoKey in IndexedDB. The public SPKI key identifies the recipient in
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

## User flow

- Open **Encrypted history & recovery key** and choose **Download key**. Store the
  recovery JSON privately: it contains an unencrypted private key.
- Closing a regular browser tab does not delete the key. Clearing site data,
  deleting the browser profile or ending an incognito session can delete it.
- On another device, **Import key**, then choose a saved session. Imports add keys
  without deleting existing keys. A mismatched public/private pair is rejected
  before storage changes.
- The recovery file includes known session IDs. Import also discovers the latest
  100 sessions for that public key, including ones created after the export.
  Older sessions remain accessible by their saved URL and matching key.
- Stop and heartbeat expiry move protected sessions to `archived`, retaining encrypted text.
  Cleanup scans only `stopped` sessions and upgrades older retained rows to `archived` as it encounters them.
  Opening saved history does not restart that session. Watch starts a new one.
  The history view uses the existing latest-50-events query. Snapshots remain
  memory-only and disappear on reload.
- Protected rule editing happens in the browser. Telegram displays placeholders
  for stored protected content; live alerts still work when enabled.

## Limits

This protects text in a database dump. It does not protect against malicious code
in the browser, a compromised device, the model/compute provider, or someone holding
the recovery file. The current application's session/subscriber capability IDs and
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

Browser tests use real Web Crypto/IndexedDB and mocked Convex transport. They test
tab closure, recovery in another browser context, Python-to-browser encryption,
tampering, failed imports, and the actual page's save/reload/Stop/import flow.
Convex handler tests exercise encryption guards and retention without a deployment.

Deploy the Python worker, Convex functions/schema, and frontend together. The worker
must have `cryptography` installed from the updated Poetry lock before the new page
is enabled. No new environment variables or server-side decryption secrets are needed.
