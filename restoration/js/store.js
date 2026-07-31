/**
 * Offline-first storage.
 *
 * Restoration work happens in basements and crawlspaces with no signal, so the
 * device is the source of truth: every write lands in IndexedDB first and the
 * UI never waits on a network call. If a sync endpoint is configured, changes
 * queue in an outbox and drain when the truck gets back to coverage.
 */

import { uid, nowIso } from './util.js';

const DB_NAME = 'dryline';
const DB_VERSION = 1;
const STORES = { jobs: 'jobs', photos: 'photos', settings: 'settings', outbox: 'outbox' };

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.jobs)) {
        const jobs = db.createObjectStore(STORES.jobs, { keyPath: 'id' });
        jobs.createIndex('updatedAt', 'updatedAt');
        jobs.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains(STORES.photos)) {
        const photos = db.createObjectStore(STORES.photos, { keyPath: 'id' });
        photos.createIndex('jobId', 'jobId');
      }
      if (!db.objectStoreNames.contains(STORES.settings)) db.createObjectStore(STORES.settings, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORES.outbox)) db.createObjectStore(STORES.outbox, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    try { result = fn(store); } catch (err) { reject(err); return; }
    t.oncomplete = () => resolve(result?.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqValue = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

/* ------------------------------------------------------------------ */
/* Change notification                                                 */
/* ------------------------------------------------------------------ */

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(type, payload) { for (const fn of listeners) { try { fn(type, payload); } catch (e) { console.error(e); } } }

/* ------------------------------------------------------------------ */
/* Job schema                                                          */
/* ------------------------------------------------------------------ */

export function newJob(overrides = {}) {
  const id = uid('job');
  return {
    id,
    schemaVersion: 1,
    jobNumber: '',
    status: 'active',
    createdAt: nowIso(),
    updatedAt: nowIso(),

    client: { name: '', phone: '', email: '', address: '', city: '', state: '', zip: '', lat: null, lng: null },
    loss: { dateOfLoss: '', sourceId: '', description: '', standingWater: false, affectedLevels: 1 },
    claim: { carrier: '', claimNumber: '', policyNumber: '', adjusterName: '', adjusterPhone: '', adjusterEmail: '', deductible: null },

    categoryOverride: null,
    classOverride: null,
    dehuType: 'lgr',
    dehuCapacityPpd: 110,
    elevationFt: 0,
    crewSize: 2,
    afterHoursCall: false,
    disposalLoads: 0,

    levels: [{ id: uid('lvl'), name: 'Main level', order: 0 }],
    rooms: [],
    equipment: [],
    monitoringPoints: [],
    readings: [],
    ambientReadings: [],
    dailyLogs: [],
    contacts: [],
    comms: [],
    trips: [],
    expenses: [],
    labor: [],
    payments: [],
    manualLines: [],
    photos: [],
    signatures: [],

    ...overrides,
  };
}

export function newRoom(levelId, overrides = {}) {
  return {
    id: uid('room'),
    levelId,
    name: 'Room',
    points: [],
    origin: { x: 0, y: 0 },
    ceilingHeightFt: 8,
    floorAreaSqft: 0,
    perimeterFt: 0,
    insideCorners: 0,

    // Null means "not yet set" — recalcRoom fills these with the full room, on
    // the assumption that a room you took the trouble to sketch is affected.
    // Defaulting them to zero silently under-sizes the equipment instead.
    affectedFloorSqft: null,
    affectedWallLf: null,
    wetWallHeightFt: 2,
    ceilingAffected: false,
    affectedCeilingSqft: 0,

    flooring: 'carpet',
    lowEvaporationMaterials: [],
    standingWater: false,
    floodCutHeightFt: 0,
    padRemoved: true,
    contentsManipulated: false,
    insulationRemovedSqft: 0,
    containmentSqft: 0,
    ceilingRemoved: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export async function listJobs() {
  const db = await openDb();
  const t = db.transaction(STORES.jobs, 'readonly');
  const jobs = await reqValue(t.objectStore(STORES.jobs).getAll());
  return jobs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function getJob(id) {
  const db = await openDb();
  const t = db.transaction(STORES.jobs, 'readonly');
  return reqValue(t.objectStore(STORES.jobs).get(id));
}

export async function saveJob(job, { silent = false } = {}) {
  job.updatedAt = nowIso();
  await tx(STORES.jobs, 'readwrite', (s) => s.put(job));
  await queueSync('job', job.id);
  if (!silent) emit('job:saved', job);
  return job;
}

export async function deleteJob(id) {
  await tx(STORES.jobs, 'readwrite', (s) => s.delete(id));
  const photos = await photosForJob(id);
  await Promise.all(photos.map((p) => deletePhoto(p.id)));
  emit('job:deleted', { id });
}

/**
 * Mutate a job through a callback and persist. Every write goes through here so
 * a save can never be forgotten halfway through a screen.
 */
export async function updateJob(id, mutator) {
  const job = await getJob(id);
  if (!job) throw new Error(`Job ${id} not found`);
  const result = mutator(job);
  await saveJob(job);
  return result === undefined ? job : result;
}

/* ------------------------------------------------------------------ */
/* Photos — stored as blobs, keyed to the job                          */
/* ------------------------------------------------------------------ */

export async function savePhoto({ jobId, blob, caption = '', roomId = null, kind = 'documentation', meta = {} }) {
  const record = { id: uid('img'), jobId, blob, caption, roomId, kind, meta, at: nowIso() };
  await tx(STORES.photos, 'readwrite', (s) => s.put(record));
  emit('photo:saved', record);
  return record;
}

export async function getPhoto(id) {
  const db = await openDb();
  const t = db.transaction(STORES.photos, 'readonly');
  return reqValue(t.objectStore(STORES.photos).get(id));
}

export async function photosForJob(jobId) {
  const db = await openDb();
  const t = db.transaction(STORES.photos, 'readonly');
  const all = await reqValue(t.objectStore(STORES.photos).index('jobId').getAll(jobId));
  return all.sort((a, b) => new Date(b.at) - new Date(a.at));
}

export async function deletePhoto(id) {
  await tx(STORES.photos, 'readwrite', (s) => s.delete(id));
  emit('photo:deleted', { id });
}

/** Downscale before storing — a modern phone camera will fill a device fast. */
export function compressImage(file, { maxDimension = 1600, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  companyName: '',
  companyPhone: '',
  companyLicense: '',
  techName: '',
  techCertification: '',
  units: 'imperial',
  mileageRate: 0.70,
  elevationFt: 0,
  coefficients: null,       // null = use the S500 defaults from iicrc.js
  priceList: {},            // { [catalogId]: { unitPrice, code } }
  laborRates: {},
  syncEndpoint: '',
  syncToken: '',
  autoTrackDrive: false,
};

export async function getSettings() {
  const db = await openDb();
  const t = db.transaction(STORES.settings, 'readonly');
  const rows = await reqValue(t.objectStore(STORES.settings).getAll());
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSetting(key, value) {
  await tx(STORES.settings, 'readwrite', (s) => s.put({ key, value }));
  emit('settings:changed', { key, value });
}

export async function setSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    await tx(STORES.settings, 'readwrite', (s) => s.put({ key, value }));
  }
  emit('settings:changed', patch);
}

/* ------------------------------------------------------------------ */
/* Sync outbox                                                         */
/* ------------------------------------------------------------------ */

async function queueSync(kind, refId) {
  const settings = await getSettings();
  if (!settings.syncEndpoint) return;
  await tx(STORES.outbox, 'readwrite', (s) => s.put({ id: `${kind}:${refId}`, kind, refId, queuedAt: nowIso() }));
}

export async function outboxCount() {
  const db = await openDb();
  const t = db.transaction(STORES.outbox, 'readonly');
  return reqValue(t.objectStore(STORES.outbox).count());
}

/**
 * Drain the outbox. Failures stay queued — a job is never dropped because the
 * server was unreachable at the moment the tech hit save.
 */
export async function syncNow() {
  const settings = await getSettings();
  if (!settings.syncEndpoint) return { skipped: true, reason: 'No sync endpoint configured.' };
  if (!navigator.onLine) return { skipped: true, reason: 'Device is offline.' };

  const db = await openDb();
  const t = db.transaction(STORES.outbox, 'readonly');
  const items = await reqValue(t.objectStore(STORES.outbox).getAll());
  let sent = 0;
  const errors = [];

  for (const item of items) {
    try {
      const payload = item.kind === 'job' ? await getJob(item.refId) : null;
      if (!payload) { await tx(STORES.outbox, 'readwrite', (s) => s.delete(item.id)); continue; }
      const res = await fetch(`${settings.syncEndpoint.replace(/\/$/, '')}/jobs/${payload.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.syncToken ? { Authorization: `Bearer ${settings.syncToken}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await tx(STORES.outbox, 'readwrite', (s) => s.delete(item.id));
      sent++;
    } catch (err) {
      errors.push(`${item.id}: ${err.message}`);
    }
  }
  emit('sync:done', { sent, errors });
  return { sent, pending: items.length - sent, errors };
}

/* ------------------------------------------------------------------ */
/* Backup / restore                                                    */
/* ------------------------------------------------------------------ */

/** Full JSON export, photos included as data URLs, for handing off a job. */
export async function exportAll({ jobId = null } = {}) {
  const jobs = jobId ? [await getJob(jobId)].filter(Boolean) : await listJobs();
  const settings = await getSettings();
  const photos = [];
  for (const job of jobs) {
    for (const p of await photosForJob(job.id)) {
      photos.push({ ...p, blob: undefined, dataUrl: await blobToDataUrl(p.blob) });
    }
  }
  return {
    format: 'dryline-export',
    version: 1,
    exportedAt: nowIso(),
    settings: { ...settings, syncToken: '' },
    jobs,
    photos,
  };
}

export async function importAll(payload, { replace = false } = {}) {
  if (payload?.format !== 'dryline-export') throw new Error('Not a DryLine export file.');
  let jobs = 0, photos = 0;
  for (const job of payload.jobs || []) {
    if (!replace && (await getJob(job.id))) job.id = uid('job');
    await saveJob(job, { silent: true });
    jobs++;
  }
  for (const p of payload.photos || []) {
    if (!p.dataUrl) continue;
    const blob = await (await fetch(p.dataUrl)).blob();
    await tx(STORES.photos, 'readwrite', (s) => s.put({ ...p, dataUrl: undefined, blob }));
    photos++;
  }
  emit('import:done', { jobs, photos });
  return { jobs, photos };
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    if (!blob) return resolve(null);
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Rough storage headroom, so a tech is warned before the device fills up. */
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota, pct: quota ? (usage / quota) * 100 : 0 };
}
