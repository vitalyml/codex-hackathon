// Session-only keys. Only the public key and encrypted envelopes leave this module.
'use strict';
const Privacy = (() => {
  const prefix = 'enc:v1:';
  const algorithm = { name: 'RSA-OAEP', hash: 'SHA-256' };
  const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const base64 = (data) => {
    let s = '';
    for (const b of new Uint8Array(data)) s += String.fromCharCode(b);
    return btoa(s);
  };
  let active = null;
  let generation = 0;
  const privateKeys = new Map();
  const decrypted = new Map();
  const DECRYPT_CACHE_SIZE = 256;
  // Remove storage left by the former persistent-key implementation.
  localStorage.removeItem('watcher.publicKey');
  localStorage.removeItem('watcher.history');
  indexedDB.deleteDatabase('watcher-privacy');

  async function generate() {
    const attempt = generation;
    if (!globalThis.crypto?.subtle) throw new Error('This browser requires HTTPS or localhost.');
    const pair = await crypto.subtle.generateKey({ ...algorithm, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, false, ['encrypt', 'decrypt']);
    const publicKey = base64(await crypto.subtle.exportKey('spki', pair.publicKey));
    if (attempt !== generation) throw new Error('Session ended — start again.');
    privateKeys.set(publicKey, pair.privateKey);
    return publicKey;
  }
  function current() {
    if (!active) active = generate();
    return active;
  }
  function reset() {
    generation++;
    active = null;
    privateKeys.clear();
    decrypted.clear();
  }
  async function requireKey(publicKey) {
    const key = privateKeys.get(publicKey);
    if (!key) throw new Error('Session ended — start again.');
    return key;
  }
  async function encrypt(text, publicKey, context) {
    const recipient = await crypto.subtle.importKey('spki', bytes(publicKey), algorithm, false, ['encrypt']);
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(context);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, new TextEncoder().encode(text));
    const wrapped = await crypto.subtle.encrypt(algorithm, recipient, await crypto.subtle.exportKey('raw', key));
    return prefix + JSON.stringify({ key: base64(wrapped), iv: base64(iv), data: base64(data) });
  }
  async function decryptUncached(text, publicKey, context) {
    if (!text) return text; // initial evidence is empty
    if (!text.startsWith(prefix)) throw new Error('Session data is unavailable.');
    const privateKey = await requireKey(publicKey);
    try {
      const box = JSON.parse(text.slice(prefix.length));
      const raw = await crypto.subtle.decrypt(algorithm, privateKey, bytes(box.key));
      const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
      const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(box.iv), additionalData: new TextEncoder().encode(context) }, key, bytes(box.data));
      return new TextDecoder().decode(clear);
    } catch (_) {
      throw new Error('Cannot read session data. Start again.');
    }
  }
  async function decrypt(text, publicKey, context) {
    if (!text) return text;
    const id = JSON.stringify([publicKey, context, text]);
    if (decrypted.has(id)) {
      const cached = decrypted.get(id);
      decrypted.delete(id); decrypted.set(id, cached);
      return cached;
    }
    const result = decryptUncached(text, publicKey, context);
    decrypted.set(id, result); // coalesce concurrent updates too
    if (decrypted.size > DECRYPT_CACHE_SIZE) decrypted.delete(decrypted.keys().next().value);
    result.catch(() => { if (decrypted.get(id) === result) decrypted.delete(id); });
    return result;
  }
  return { current, reset, requireKey, encrypt, decrypt };
})();
