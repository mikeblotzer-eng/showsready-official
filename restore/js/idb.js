// Minimal IndexedDB wrapper for photo blobs. Job records stay in localStorage
// (small, synchronous, easy to export); photos would blow that budget instantly.

const DB_NAME = 'dryplan';
const STORE = 'photos';
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const putPhoto = (id, blob) => tx('readwrite', (s) => s.put(blob, id));
export const getPhoto = (id) => tx('readonly', (s) => s.get(id));
export const deletePhoto = (id) => tx('readwrite', (s) => s.delete(id));

const urlCache = new Map();

/** Object URL for a stored photo, cached so repeated renders don't leak. */
export async function photoUrl(id) {
  if (!id) return null;
  if (urlCache.has(id)) return urlCache.get(id);
  try {
    const blob = await getPhoto(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urlCache.set(id, url);
    return url;
  } catch {
    return null;
  }
}

export function forgetPhotoUrl(id) {
  const url = urlCache.get(id);
  if (url) { URL.revokeObjectURL(url); urlCache.delete(id); }
}

/** Downscale a camera capture before storing — field phones shoot 8 MP. */
export function compressImage(file, maxDim = 1600, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}
