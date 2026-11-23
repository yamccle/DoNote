'use strict';

function pdfPreviewFingerprint(session) {
  const [original, modified] = session.pdf.fingerprints || [];
  return JSON.stringify([session.file.id, original, modified, session.sourceBlob?.size, session.pdf.numPages]);
}

const PdfPreviewCache = (() => {
  const limits = {
    paragraph: {count: 16000, bytes: 64 * 1024, budget: 32 * 1024 * 1024},
    page: {count: 512, bytes: 80 * 1024 * 1024, budget: 256 * 1024 * 1024}
  };
  let opening;

  function open() {
    return opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('donote-pdf-preview-cache', 1);
      request.onupgradeneeded = () => {
        for (const kind of Object.keys(limits)) request.result.createObjectStore(kind).createIndex('saved', 'saved');
        request.result.createObjectStore('sizes');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('PDF cache is busy'));
    }).catch(() => null);
  }

  async function keyHash(key) {
    const data = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return Array.from(new Uint8Array(data), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function get(kind, key) {
    try {
      const hash = await keyHash(key);
      const db = await open();
      if (!db) return;
      return await new Promise((resolve, reject) => {
        const request = db.transaction(kind).objectStore(kind).get(hash);
        request.onsuccess = () => resolve(request.result?.value);
        request.onerror = () => reject(request.error);
      });
    } catch {}
  }

  async function put(kind, key, value) {
    const limit = limits[kind];
    const size = typeof value === 'string' ? value.length * 2 : value?.blob?.size;
    if (!size || size > limit.bytes) return;
    try {
      const hash = await keyHash(key);
      const db = await open();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const transaction = db.transaction([kind, 'sizes'], 'readwrite');
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
        const store = transaction.objectStore(kind);
        const sizes = transaction.objectStore('sizes');
        const old = store.get(hash);
        const usage = sizes.get(kind);
        usage.onsuccess = () => {
          const existing = usage.result || {bytes: 0, count: 0};
          let bytes = existing.bytes + size - (old.result?.size || 0);
          let count = existing.count + (old.result ? 0 : 1);
          store.put({value, size, saved: Date.now()}, hash);
          const saveUsage = () => sizes.put({bytes, count}, kind);
          if (bytes <= limit.budget && count <= limit.count) {
            saveUsage();
            return;
          }
          const cursor = store.index('saved').openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry || bytes <= limit.budget && count <= limit.count) {
              saveUsage();
              return;
            }
            bytes -= entry.value.size;
            count--;
            entry.delete();
            entry.continue();
          };
        };
      });
    } catch {}
  }

  async function remove(kind, key) {
    try {
      const hash = await keyHash(key);
      const db = await open();
      if (!db) return;
      const transaction = db.transaction([kind, 'sizes'], 'readwrite');
      const store = transaction.objectStore(kind);
      const sizes = transaction.objectStore('sizes');
      const old = store.get(hash);
      const usage = sizes.get(kind);
      usage.onsuccess = () => {
        if (!old.result || !usage.result) return;
        store.delete(hash);
        sizes.put({bytes: usage.result.bytes - old.result.size, count: usage.result.count - 1}, kind);
      };
    } catch {}
  }

  return {get, put, delete: remove};
})();
