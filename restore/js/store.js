// Offline-first store. Everything lives on the device so the app works in a
// basement with no signal; sharing happens through export, print and messaging.

import { uid, nowISO, todayISO, debounce } from './util.js';

const KEY = 'dryplan.state.v1';
const VERSION = 1;

export const DEFAULT_SETTINGS = {
  company: '', companyPhone: '', companyEmail: '', companyAddress: '', license: '',
  techName: '', techPhone: '', techEmail: '',
  mileageRate: 0.7, // IRS business rate — editable, changes annually
  fuelSurcharge: 0,
  laborRate: 62, afterHoursRate: 93, emergencyRate: 124,
  tolerance: 2, // points added to the dry standard when setting a goal
  dehuKind: 'lgr',
  elevationFt: 0,
  taxRate: 0, overhead: 10, profit: 10, applyOandP: false,
  monitorReminderHour: 8,
};

const emptyJob = () => ({
  id: uid('job'),
  version: VERSION,
  jobNumber: '',
  status: 'active', // active | monitoring | drying-complete | closed
  createdAt: nowISO(),
  updatedAt: nowISO(),
  site: { name: '', address: '', city: '', state: '', zip: '', lat: null, lng: null, sqft: null, occupied: true },
  loss: {
    dateISO: '', sourceId: 'supply_line', description: '',
    sourceStopped: true, contactedContaminants: false, occupantSensitive: false,
    ambientTempF: 70,
    categoryOverride: null, classOverride: null,
    categoryLocked: false, classLocked: false,
  },
  carrier: { name: '', claimNumber: '', policyNumber: '', deductible: null, adjuster: '', adjusterPhone: '', adjusterEmail: '' },
  contacts: [],
  plan: { rooms: [], pins: [], equipment: [], arrows: [], containment: [], notes: [] },
  atmo: [],      // atmospheric monitoring readings
  dailies: [],   // daily work logs
  trips: [],     // mileage
  expenses: [],  // job-costed purchases (AP)
  estimate: { lines: [], notes: '' },
  invoices: [],  // AR
  messages: [],  // communication log
  photos: [],    // { id, blobId, caption, roomId, ts, tag }
  signatures: [],
});

function migrate(state) {
  if (!state || typeof state !== 'object') return null;
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  state.jobs = Array.isArray(state.jobs) ? state.jobs : [];
  for (const job of state.jobs) {
    const base = emptyJob();
    for (const k of Object.keys(base)) {
      if (job[k] === undefined) job[k] = base[k];
    }
    job.plan = { ...base.plan, ...(job.plan || {}) };
    job.loss = { ...base.loss, ...(job.loss || {}) };
    job.site = { ...base.site, ...(job.site || {}) };
    job.carrier = { ...base.carrier, ...(job.carrier || {}) };
    job.estimate = { ...base.estimate, ...(job.estimate || {}) };
  }
  return state;
}

class Store {
  constructor() {
    this.state = this.#load();
    this.listeners = new Set();
    this.persist = debounce(() => this.#write(), 200);
  }

  #load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = migrate(JSON.parse(raw));
        if (parsed) return parsed;
      }
    } catch (err) {
      console.warn('[store] could not read saved data', err);
    }
    return { version: VERSION, settings: { ...DEFAULT_SETTINGS }, jobs: [] };
  }

  #write() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch (err) {
      console.error('[store] save failed', err);
      if (String(err).includes('Quota')) {
        alert('Device storage is full. Export and archive older jobs from Settings to free space.');
      }
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      try { fn(this.state); } catch (err) { console.error(err); }
    }
  }

  /** Mutate + persist + notify. All writes go through here. */
  update(mutator, { silent = false } = {}) {
    const result = mutator(this.state);
    this.persist();
    if (!silent) this.emit();
    return result;
  }

  get settings() { return this.state.settings; }

  saveSettings(patch) {
    return this.update((s) => { Object.assign(s.settings, patch); });
  }

  get jobs() { return this.state.jobs; }

  job(id) { return this.state.jobs.find((j) => j.id === id) || null; }

  createJob(patch = {}) {
    const job = emptyJob();
    const year = new Date().getFullYear();
    const seq = this.state.jobs.length + 1;
    job.jobNumber = patch.jobNumber || `${year}-${String(seq).padStart(4, '0')}`;
    job.loss.dateISO = patch.loss?.dateISO || nowISO();
    deepAssign(job, patch);
    this.update((s) => { s.jobs.unshift(job); });
    return job;
  }

  /** Mutate one job and stamp it. */
  updateJob(id, mutator) {
    return this.update((s) => {
      const job = s.jobs.find((j) => j.id === id);
      if (!job) return null;
      const r = mutator(job);
      job.updatedAt = nowISO();
      return r;
    });
  }

  deleteJob(id) {
    this.update((s) => { s.jobs = s.jobs.filter((j) => j.id !== id); });
  }

  duplicateJob(id) {
    const job = this.job(id);
    if (!job) return null;
    const copy = JSON.parse(JSON.stringify(job));
    copy.id = uid('job');
    copy.jobNumber = `${job.jobNumber}-copy`;
    copy.createdAt = nowISO();
    this.update((s) => { s.jobs.unshift(copy); });
    return copy;
  }

  exportAll() {
    return JSON.stringify({ ...this.state, exportedAt: nowISO() }, null, 2);
  }

  importAll(json, { merge = true } = {}) {
    const incoming = migrate(typeof json === 'string' ? JSON.parse(json) : json);
    if (!incoming) throw new Error('Not a DryPlan backup file');
    this.update((s) => {
      if (!merge) { s.jobs = incoming.jobs; s.settings = incoming.settings; return; }
      const byId = new Map(s.jobs.map((j) => [j.id, j]));
      for (const j of incoming.jobs) {
        if (byId.has(j.id)) {
          const existing = byId.get(j.id);
          if (new Date(j.updatedAt) > new Date(existing.updatedAt)) {
            s.jobs[s.jobs.indexOf(existing)] = j;
          }
        } else {
          s.jobs.push(j);
        }
      }
    });
    return incoming.jobs.length;
  }
}

function deepAssign(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepAssign(target[k], v);
    } else if (v !== undefined) {
      target[k] = v;
    }
  }
  return target;
}

export const store = new Store();
export { emptyJob, deepAssign, todayISO };
