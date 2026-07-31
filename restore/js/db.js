/* Tiny promise wrapper over IndexedDB.
 *
 * Jobs live in `jobs` (structured-clonable JSON), photos and signatures live in
 * `blobs` so a job record stays small enough to sync later. IndexedDB rather
 * than localStorage because a week of daily photos blows past the 5 MB cap.
 */

const DB_NAME = 'restoremap';
const DB_VERSION = 1;
const STORES = { jobs: 'jobs', blobs: 'blobs', meta: 'meta' };

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('This browser has no IndexedDB. Field data cannot be stored offline.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.jobs)) {
        const s = db.createObjectStore(STORES.jobs, { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STORES.blobs)) {
        db.createObjectStore(STORES.blobs, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try {
      result = fn(s);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = (req) => ({ __req: req });

export const jobs = {
  all: () => tx(STORES.jobs, 'readonly', (s) => wrap(s.getAll())),
  get: (id) => tx(STORES.jobs, 'readonly', (s) => wrap(s.get(id))),
  put: (job) => tx(STORES.jobs, 'readwrite', (s) => wrap(s.put(job))),
  remove: (id) => tx(STORES.jobs, 'readwrite', (s) => wrap(s.delete(id))),
};

export const blobs = {
  get: (id) => tx(STORES.blobs, 'readonly', (s) => wrap(s.get(id))),
  put: (record) => tx(STORES.blobs, 'readwrite', (s) => wrap(s.put(record))),
  remove: (id) => tx(STORES.blobs, 'readwrite', (s) => wrap(s.delete(id))),
  allForJob: async (jobId) => {
    const all = await tx(STORES.blobs, 'readonly', (s) => wrap(s.getAll()));
    return (all || []).filter((b) => b.jobId === jobId);
  },
};

export const meta = {
  get: async (key, fallback = null) => {
    const rec = await tx(STORES.meta, 'readonly', (s) => wrap(s.get(key)));
    return rec ? rec.value : fallback;
  },
  set: (key, value) => tx(STORES.meta, 'readwrite', (s) => wrap(s.put({ key, value }))),
};

/** Rough storage headroom, so a tech finds out before the card fills up. */
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota, pct: quota ? (usage / quota) * 100 : 0 };
}

/**
 * Ask the browser to keep this data out of the automatic-eviction pool. Weeks
 * of drying logs should not vanish because the OS wanted disk back.
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
