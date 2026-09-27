// IndexedDB 访问层：缓存（带 TTL）与请求历史。主线程与 Worker 共用（ES module）。
const DB_NAME = 'request-observer';
const DB_VERSION = 1;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('history')) {
        const store = db.createObjectStore('history', { keyPath: 'id' });
        store.createIndex('startTime', 'startTime');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && result._value !== undefined ? result._value : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- 缓存 ----
export async function cacheSet(key, data, ttlMs) {
  const db = await openDB();
  await tx(db, 'cache', 'readwrite', (s) => s.put({ key, data, storedAt: Date.now(), ttlMs }));
  db.close();
}

// 返回 { hit, expired, data, storedAt, ttlMs }
export async function cacheGet(key) {
  const db = await openDB();
  const entry = await reqToPromise(
    (() => { let r; const t = db.transaction('cache', 'readonly'); r = t.objectStore('cache').get(key); return r; })()
  );
  db.close();
  if (!entry) return { hit: false, expired: false };
  const expired = entry.ttlMs > 0 && Date.now() - entry.storedAt > entry.ttlMs;
  return { hit: true, expired, data: entry.data, storedAt: entry.storedAt, ttlMs: entry.ttlMs };
}

export async function cacheClear() {
  const db = await openDB();
  await tx(db, 'cache', 'readwrite', (s) => s.clear());
  db.close();
}

// ---- 历史 ----
export async function historyAdd(record) {
  const db = await openDB();
  await tx(db, 'history', 'readwrite', (s) => s.put(record));
  db.close();
}

export async function historyAll() {
  const db = await openDB();
  const all = await reqToPromise(
    (() => { const t = db.transaction('history', 'readonly'); return t.objectStore('history').getAll(); })()
  );
  db.close();
  return (all || []).sort((a, b) => a.startTime - b.startTime);
}

export async function historyClear() {
  const db = await openDB();
  await tx(db, 'history', 'readwrite', (s) => s.clear());
  db.close();
}
