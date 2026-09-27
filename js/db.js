const DB_NAME = 'request-resilience-lab';
const DB_VERSION = 1;
const CACHE_STORE = 'responseCache';
const HISTORY_STORE = 'requestHistory';

let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CACHE_STORE)) {
          db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(HISTORY_STORE)) {
          const store = db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
          store.createIndex('startedAt', 'startedAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function cacheKey(method, url) {
  return `${method.toUpperCase()} ${url}`;
}

export async function putCache(entry) {
  const db = await openDb();
  await requestToPromise(db.transaction(CACHE_STORE, 'readwrite').objectStore(CACHE_STORE).put(entry));
}

export async function getCache(key) {
  const db = await openDb();
  return requestToPromise(db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(key));
}

export async function clearCacheStore() {
  const db = await openDb();
  await requestToPromise(db.transaction(CACHE_STORE, 'readwrite').objectStore(CACHE_STORE).clear());
}

export async function putHistory(entry) {
  const db = await openDb();
  const compact = {
    ...entry,
    response: entry.response && entry.response.body && entry.response.body.length > 12000
      ? { ...entry.response, body: `${entry.response.body.slice(0, 12000)}\n…（详情已截断）` }
      : entry.response
  };
  await requestToPromise(db.transaction(HISTORY_STORE, 'readwrite').objectStore(HISTORY_STORE).put(compact));
}

export async function getAllHistory() {
  const db = await openDb();
  const records = await requestToPromise(
    db.transaction(HISTORY_STORE, 'readonly').objectStore(HISTORY_STORE).getAll()
  );
  return records.sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
}

export async function clearHistoryStore() {
  const db = await openDb();
  await requestToPromise(db.transaction(HISTORY_STORE, 'readwrite').objectStore(HISTORY_STORE).clear());
}
