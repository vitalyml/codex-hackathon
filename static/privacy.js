// Local recovery keys. Only the public key and encrypted envelopes leave this module.
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
  let opening;
  const privateKeys = new Map();
  const decrypted = new Map();
  const DECRYPT_CACHE_SIZE = 256;
  function db() {
    if (!opening) opening = new Promise((resolve, reject) => {
      const req = indexedDB.open('watcher-privacy', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('Cannot open key storage. Use a regular browser window.'));
    });
    return opening;
  }
  async function stored(mode, operation) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('keys', mode);
      const request = operation(tx.objectStore('keys'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error('Cannot save or read the recovery key.'));
    });
  }
  async function generate() {
    if (!globalThis.crypto?.subtle) throw new Error('Encrypted history requires HTTPS or localhost.');
    const pair = await crypto.subtle.generateKey({ ...algorithm, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['encrypt', 'decrypt']);
    const publicKey = base64(await crypto.subtle.exportKey('spki', pair.publicKey));
    await stored('readwrite', (s) => s.put(pair.privateKey, publicKey));
    privateKeys.set(publicKey, Promise.resolve(pair.privateKey));
    localStorage.setItem('watcher.publicKey', publicKey);
    return publicKey;
  }
  async function current() {
    const key = localStorage.getItem('watcher.publicKey');
    if (key && await stored('readonly', (s) => s.get(key))) return key;
    return generate();
  }
  async function requireKey(publicKey) {
    if (!privateKeys.has(publicKey)) {
      const loading = stored('readonly', (s) => s.get(publicKey)).then((key) => {
        if (!key) throw new Error('History locked. Import the recovery key from the original device.');
        return key;
      });
      privateKeys.set(publicKey, loading);
      loading.catch(() => { if (privateKeys.get(publicKey) === loading) privateKeys.delete(publicKey); });
    }
    return privateKeys.get(publicKey);
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
    if (!text.startsWith(prefix)) throw new Error('Invalid encrypted history.');
    const privateKey = await requireKey(publicKey);
    try {
      const box = JSON.parse(text.slice(prefix.length));
      const raw = await crypto.subtle.decrypt(algorithm, privateKey, bytes(box.key));
      const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
      const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(box.iv), additionalData: new TextEncoder().encode(context) }, key, bytes(box.data));
      return new TextDecoder().decode(clear);
    } catch (_) {
      throw new Error('Cannot decrypt history: wrong key or damaged data.');
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
  async function exportBackup(publicKey, sessions) {
    const privateKey = await requireKey(publicKey);
    return JSON.stringify({ format: 'watcher-key-v1', publicKey, privateKey: base64(await crypto.subtle.exportKey('pkcs8', privateKey)), sessions });
  }
  async function importBackup(text) {
    const backup = JSON.parse(text);
    if (backup.format !== 'watcher-key-v1' || !Array.isArray(backup.sessions) || !backup.sessions.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id))) throw new Error('Not a Watcher recovery file.');
    const key = await crypto.subtle.importKey('pkcs8', bytes(backup.privateKey), algorithm, true, ['decrypt']);
    // Verify the pair before changing storage; a failed import cannot replace a good key.
    const probe = await encrypt('watcher recovery', backup.publicKey, 'recovery');
    const box = JSON.parse(probe.slice(prefix.length));
    await crypto.subtle.decrypt(algorithm, key, bytes(box.key));
    await stored('readwrite', (s) => s.put(key, backup.publicKey));
    privateKeys.set(backup.publicKey, Promise.resolve(key));
    localStorage.setItem('watcher.publicKey', backup.publicKey);
    return backup;
  }
  return { current, requireKey, encrypt, decrypt, exportBackup, importBackup };
})();
