/* Application state: the job model, persistence, and everything derived from it.
 *
 * One job is one loss. Views read from `state.job`, mutate it through
 * `update()`, and re-render on the `change` event. Saves are debounced so
 * dragging an air mover across the plan doesn't hammer IndexedDB.
 */

import * as db from './db.js';
import { uid, todayISO, num, debounce } from './util.js';
import { roomSurfaceAreas, polygonArea, polygonPerimeter, insideCorners, wetWallLinearFeet, trackMiles } from './geom.js';
import { detectCategory, detectClass, recommendEquipment, pointStatus, POROUS_MATERIALS, LOW_EVAP_MATERIALS, MATERIALS } from './iicrc.js';
import { readingSummary, grainDepression, chamberAnalysis } from './psychro.js';

export const SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS = {
  companyName: '',
  techName: '',
  mileageRate: 0.70,
  units: 'imperial',
  elevationFt: 0,
  dehuType: 'lgr',
  dehuUnitPints: 130,
  scrubberCfm: 500,
  equipmentRates: {
    airMover: 26.00,
    dehuLgr: 92.00,
    dehuConventional: 68.00,
    dehuDesiccant: 320.00,
    airScrubber: 78.00,
    heater: 110.00,
    injectidry: 145.00,
  },
  laborRates: { tech: 52.00, techAfterHours: 78.00, supervisor: 68.00 },
};

export const EQUIPMENT_TYPES = [
  { id: 'airMover',        label: 'Air mover',            icon: '➤',  rateKey: 'airMover' },
  { id: 'dehuLgr',         label: 'LGR dehumidifier',     icon: '▤',  rateKey: 'dehuLgr' },
  { id: 'dehuConventional', label: 'Conventional dehu',   icon: '▥',  rateKey: 'dehuConventional' },
  { id: 'dehuDesiccant',   label: 'Desiccant dehu',       icon: '▦',  rateKey: 'dehuDesiccant' },
  { id: 'airScrubber',     label: 'Air scrubber / AFD',   icon: '◍',  rateKey: 'airScrubber' },
  { id: 'heater',          label: 'Heater',               icon: '☀',  rateKey: 'heater' },
  { id: 'injectidry',      label: 'Injection / panel dry', icon: '⊞', rateKey: 'injectidry' },
];

export const CONTACT_ROLES = [
  { id: 'client', label: 'Client / Insured' },
  { id: 'adjuster', label: 'Insurance Adjuster' },
  { id: 'carrier', label: 'Carrier / Desk Adjuster' },
  { id: 'office', label: 'Restoration Office / PM' },
  { id: 'tech', label: 'Team Technician' },
  { id: 'agent', label: 'Insurance Agent' },
  { id: 'plumber', label: 'Plumber / Trade' },
  { id: 'other', label: 'Other' },
];

export const COST_TYPES = [
  { id: 'fuel', label: 'Fuel', billable: true },
  { id: 'mileage', label: 'Mileage', billable: true },
  { id: 'supplies', label: 'Supplies / Consumables', billable: true },
  { id: 'ppe', label: 'PPE', billable: true },
  { id: 'labor', label: 'Labor', billable: true },
  { id: 'equipment_rental', label: 'Equipment Rental', billable: true },
  { id: 'subcontractor', label: 'Subcontractor', billable: true },
  { id: 'disposal', label: 'Dumpster / Disposal', billable: true },
  { id: 'lodging', label: 'Lodging / Per Diem', billable: false },
  { id: 'other', label: 'Other', billable: false },
];

/* ── Job factory ──────────────────────────────────────────────────────────── */

export function newJob(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: uid('job'),
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    jobNumber: '',
    claim: {
      insured: '', address: '', city: '', state: '', zip: '',
      carrier: '', claimNumber: '', policyNumber: '', deductible: '',
      dateOfLoss: todayISO(), timeOfLoss: '', dateContacted: todayISO(), dateArrived: now,
    },
    loss: {
      sourceId: '', causeNotes: '',
      categoryOverride: null, classOverride: null,
      lowEvaporationMaterials: false, visibleGrowth: false, contactedContaminated: false,
      containment: false,
    },
    rooms: [],
    psychro: [],
    dailies: [],
    trips: [],
    costs: [],
    invoices: [],
    comms: [],
    scope: [],
    notes: '',
    ...overrides,
  };
}

export function newRoom(overrides = {}) {
  return {
    id: uid('room'),
    name: 'New Room',
    level: 'Main',
    ceilingHeight: 8,
    poly: [],
    affected: {
      floorPct: 100, wallPct: 100, ceilingPct: 0,
      wallAffectedHeight: 2, floorMaterial: 'carpet', wallMaterial: 'drywall', ceilingMaterial: 'drywall',
      obstructions: 0,
    },
    openings: [],
    points: [],
    equipment: [],
    flow: [],
    ...overrides,
  };
}

/* ── State ────────────────────────────────────────────────────────────────── */

const listeners = new Set();

export const state = {
  jobs: [],
  job: null,
  settings: { ...DEFAULT_SETTINGS },
  activeRoomId: null,
  ready: false,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(reason = 'change') {
  for (const fn of listeners) fn(reason);
}

const persist = debounce(async () => {
  if (!state.job) return;
  state.job.updatedAt = new Date().toISOString();
  await db.jobs.put(structuredClone(state.job));
  const idx = state.jobs.findIndex((j) => j.id === state.job.id);
  if (idx >= 0) state.jobs[idx] = state.job;
}, 350);

/** Mutate the open job, then save and notify. */
export function update(mutator, { reason = 'change', silent = false } = {}) {
  if (!state.job) return;
  mutator(state.job);
  persist();
  if (!silent) emit(reason);
}

export async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await db.meta.set('settings', state.settings);
  emit('settings');
}

export async function init() {
  state.settings = { ...DEFAULT_SETTINGS, ...(await db.meta.get('settings', {})) };
  // Nested defaults survive a settings object written by an older version.
  state.settings.equipmentRates = { ...DEFAULT_SETTINGS.equipmentRates, ...(state.settings.equipmentRates || {}) };
  state.settings.laborRates = { ...DEFAULT_SETTINGS.laborRates, ...(state.settings.laborRates || {}) };

  const all = (await db.jobs.all()) || [];
  state.jobs = all.map(migrate).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const lastId = await db.meta.get('lastJobId');
  if (lastId) state.job = state.jobs.find((j) => j.id === lastId) || null;
  state.ready = true;
  emit('init');
}

function migrate(job) {
  const base = newJob({ id: job.id });
  const merged = { ...base, ...job, claim: { ...base.claim, ...job.claim }, loss: { ...base.loss, ...job.loss } };
  merged.rooms = (merged.rooms || []).map((r) => ({ ...newRoom({ id: r.id }), ...r, affected: { ...newRoom().affected, ...r.affected } }));
  merged.schemaVersion = SCHEMA_VERSION;
  return merged;
}

export async function createJob(overrides) {
  const job = newJob(overrides);
  await db.jobs.put(structuredClone(job));
  state.jobs.unshift(job);
  await openJob(job.id);
  return job;
}

export async function openJob(id) {
  state.job = state.jobs.find((j) => j.id === id) || null;
  state.activeRoomId = state.job?.rooms?.[0]?.id || null;
  await db.meta.set('lastJobId', id);
  emit('job');
}

export async function deleteJob(id) {
  await db.jobs.remove(id);
  for (const b of await db.blobs.allForJob(id)) await db.blobs.remove(b.id);
  state.jobs = state.jobs.filter((j) => j.id !== id);
  if (state.job?.id === id) {
    state.job = null;
    await db.meta.set('lastJobId', null);
  }
  emit('job');
}

export function activeRoom() {
  if (!state.job) return null;
  return state.job.rooms.find((r) => r.id === state.activeRoomId) || state.job.rooms[0] || null;
}

/* ── Derived: room metrics ────────────────────────────────────────────────── */

export function roomMetrics(room) {
  const areas = roomSurfaceAreas(room.poly, num(room.ceilingHeight, 8));
  const a = room.affected || {};
  const openingWidths = (room.openings || []).map((o) => o.width);

  const wetFloorArea = areas.floor * (num(a.floorPct, 0) / 100);
  const wetCeilingArea = areas.ceiling * (num(a.ceilingPct, 0) / 100);
  // Wet wall area is capped by how far the water actually wicked up.
  const affectedHeight = Math.min(num(room.ceilingHeight, 8), num(a.wallAffectedHeight, 0));
  const wetWallArea = areas.perimeter * affectedHeight * (num(a.wallPct, 0) / 100);
  const wetWallLf = wetWallLinearFeet(room.poly, { openingWidths, affectedPct: num(a.wallPct, 0) });

  // Only porous materials count toward the S500 class threshold.
  const porousFloor = POROUS_MATERIALS.has(a.floorMaterial) ? wetFloorArea : 0;
  const porousWall = POROUS_MATERIALS.has(a.wallMaterial) ? wetWallArea : 0;
  const porousCeiling = POROUS_MATERIALS.has(a.ceilingMaterial) ? wetCeilingArea : 0;
  const corners = insideCorners(room.poly);

  return {
    ...areas,
    wetFloorArea, wetWallArea, wetCeilingArea, wetWallLf,
    affectedHeight,
    wetPorousArea: porousFloor + porousWall + porousCeiling,
    insideCorners: corners,
    // S500's extra air mover per inside corner is aimed at offsets, alcoves and
    // bump-outs. A plain rectangle's four corners are already served by the
    // perimeter airflow pattern, so only corners beyond those four earn a unit.
    extraCorners: Math.max(0, corners - 4),
    obstructions: num(a.obstructions, 0),
    hasLowEvap: [a.floorMaterial, a.wallMaterial, a.ceilingMaterial].some((m) => LOW_EVAP_MATERIALS.has(m)),
    drawn: (room.poly || []).length >= 3,
  };
}

export function jobMetrics(job = state.job) {
  const empty = { rooms: [], totalFloor: 0, totalSurface: 0, totalVolume: 0, wetPorousArea: 0, wetFloorArea: 0, hasLowEvap: false, roomCount: 0 };
  if (!job) return empty;
  const rooms = job.rooms.map((r) => ({ room: r, metrics: roomMetrics(r) }));
  return rooms.reduce((acc, { room, metrics }) => {
    acc.rooms.push({ room, metrics });
    acc.totalFloor += metrics.floor;
    acc.totalSurface += metrics.total;
    acc.totalVolume += metrics.volume;
    acc.wetPorousArea += metrics.wetPorousArea;
    acc.wetFloorArea += metrics.wetFloorArea;
    acc.hasLowEvap = acc.hasLowEvap || metrics.hasLowEvap;
    acc.roomCount++;
    return acc;
  }, { ...empty, rooms: [] });
}

/* ── Derived: classification ──────────────────────────────────────────────── */

export function classification(job = state.job) {
  if (!job) return null;
  const m = jobMetrics(job);
  const loss = job.loss || {};

  const hoursElapsed = job.claim?.dateOfLoss
    ? Math.max(0, (Date.now() - new Date(`${job.claim.dateOfLoss}T${job.claim.timeOfLoss || '12:00'}`).getTime()) / 36e5)
    : 0;

  const latestAffected = latestPsychro(job, 'affected');
  const cat = detectCategory({
    sourceId: loss.sourceId,
    hoursElapsed,
    tempF: latestAffected?.temp ?? 70,
    visibleGrowth: loss.visibleGrowth,
    contactedContaminated: loss.contactedContaminated,
  });
  const cls = detectClass({
    wetPorousArea: m.wetPorousArea,
    totalSurfaceArea: m.totalSurface,
    lowEvaporationMaterials: loss.lowEvaporationMaterials || m.hasLowEvap,
  });

  return {
    hoursElapsed,
    detectedCategory: cat.category,
    detectedClass: cls.class,
    category: loss.categoryOverride ?? cat.category,
    class: loss.classOverride ?? cls.class,
    categoryOverridden: loss.categoryOverride != null && loss.categoryOverride !== cat.category,
    classOverridden: loss.classOverride != null && loss.classOverride !== cls.class,
    categoryReasons: cat.reasons,
    classReasons: cls.reasons,
    degraded: cat.degraded,
    hoursToNextCategory: cat.hoursToNextCategory,
    wetPorousPct: cls.wetPorousPct,
    metrics: m,
  };
}

/* ── Derived: equipment ───────────────────────────────────────────────────── */

export function equipmentPlan(job = state.job) {
  if (!job) return null;
  const cls = classification(job);
  const rooms = cls.metrics.rooms
    .filter(({ metrics }) => metrics.drawn)
    .map(({ room, metrics }) => ({
      id: room.id,
      name: room.name,
      wetFloorArea: metrics.wetFloorArea,
      wetWallLinearFeet: metrics.wetWallLf,
      insideCorners: metrics.extraCorners,
      obstructions: metrics.obstructions,
      volume: metrics.volume,
    }));

  return recommendEquipment({
    rooms,
    waterClass: cls.class,
    category: cls.category,
    dehuType: state.settings.dehuType,
    dehuUnitPints: num(state.settings.dehuUnitPints, 130),
    scrubberCfm: num(state.settings.scrubberCfm, 500),
    containment: job.loss?.containment,
  });
}

/** What is physically on site right now, by type. */
export function placedEquipment(job = state.job) {
  const counts = {};
  const items = [];
  for (const room of job?.rooms || []) {
    for (const eq of room.equipment || []) {
      if (eq.removedAt) continue;
      counts[eq.type] = (counts[eq.type] || 0) + 1;
      items.push({ ...eq, roomId: room.id, roomName: room.name });
    }
  }
  return { counts, items, total: items.length };
}

/** Equipment-days for billing: each unit accrues from placement to removal. */
export function equipmentDays(job = state.job, asOf = new Date()) {
  const rows = {};
  for (const room of job?.rooms || []) {
    for (const eq of room.equipment || []) {
      const start = new Date(eq.placedAt || job.createdAt);
      const end = eq.removedAt ? new Date(eq.removedAt) : asOf;
      // Any part of a day is a billable day — industry standard for drying equipment.
      const days = Math.max(1, Math.ceil((end - start) / 864e5));
      if (!rows[eq.type]) rows[eq.type] = { type: eq.type, units: 0, days: 0 };
      rows[eq.type].units++;
      rows[eq.type].days += days;
    }
  }
  return Object.values(rows);
}

/* ── Derived: readings ────────────────────────────────────────────────────── */

export function allPoints(job = state.job) {
  const out = [];
  for (const room of job?.rooms || []) {
    for (const p of room.points || []) out.push({ ...p, roomId: room.id, roomName: room.name });
  }
  return out;
}

export function pointsWithStatus(job = state.job) {
  return allPoints(job).map((p) => ({ ...p, status: pointStatus(p, p.readings || []) }));
}

export function dryingProgress(job = state.job) {
  const pts = pointsWithStatus(job);
  const withData = pts.filter((p) => p.status.state !== 'no-data');
  const dry = withData.filter((p) => p.status.state === 'dry');
  const stalled = withData.filter((p) => p.status.state === 'stalled' && p.status.readingCount >= 3);
  const wetting = withData.filter((p) => p.status.state === 'wetting');
  return {
    total: pts.length,
    measured: withData.length,
    dry: dry.length,
    stalled, wetting,
    pct: withData.length ? (dry.length / withData.length) * 100 : 0,
    complete: withData.length > 0 && dry.length === withData.length,
  };
}

export function latestPsychro(job = state.job, location) {
  const rows = (job?.psychro || []).filter((p) => p.location === location);
  rows.sort((a, b) => new Date(b.at) - new Date(a.at));
  return rows[0] || null;
}

export function psychroForDate(job = state.job, date) {
  const day = (job?.psychro || []).filter((p) => (p.at || '').slice(0, 10) === date);
  const pick = (loc) => day.filter((p) => p.location === loc).slice(-1)[0] || null;
  const affected = pick('affected'), unaffected = pick('unaffected'), exterior = pick('exterior');
  const dehuIn = pick('dehuIn'), dehuOut = pick('dehuOut');
  return {
    rows: day,
    affected: readingSummary(affected),
    unaffected: readingSummary(unaffected),
    exterior: readingSummary(exterior),
    dehuIn: readingSummary(dehuIn),
    dehuOut: readingSummary(dehuOut),
    depression: grainDepression(dehuIn, dehuOut),
    analysis: chamberAnalysis({ affected, unaffected, exterior }),
  };
}

/* ── Derived: money ───────────────────────────────────────────────────────── */

export function tripMiles(trip) {
  if (trip.miles != null && trip.miles !== '') return num(trip.miles);
  if (trip.startOdo != null && trip.endOdo != null && trip.endOdo !== '' && trip.startOdo !== '') {
    return Math.max(0, num(trip.endOdo) - num(trip.startOdo));
  }
  if (trip.path?.length > 1) return trackMiles(trip.path);
  return 0;
}

export function financials(job = state.job) {
  if (!job) return null;
  const rate = num(state.settings.mileageRate, 0.7);

  const mileage = (job.trips || []).reduce((acc, t) => {
    const miles = tripMiles(t);
    acc.miles += miles;
    if (t.billable !== false) acc.billableMiles += miles;
    return acc;
  }, { miles: 0, billableMiles: 0 });
  mileage.amount = mileage.billableMiles * rate;

  const costs = (job.costs || []).reduce((acc, c) => {
    const amount = num(c.amount) * (c.qty ? num(c.qty, 1) : 1);
    acc.total += amount;
    if (c.billable) {
      acc.billable += amount;
      acc.billed += amount * (1 + num(c.markupPct, 0) / 100);
    } else {
      acc.nonBillable += amount;
    }
    acc.byType[c.type] = (acc.byType[c.type] || 0) + amount;
    return acc;
  }, { total: 0, billable: 0, billed: 0, nonBillable: 0, byType: {} });

  const equip = equipmentDays(job).map((row) => {
    const type = EQUIPMENT_TYPES.find((t) => t.id === row.type);
    const unitRate = num(state.settings.equipmentRates[type?.rateKey], 0);
    return { ...row, label: type?.label || row.type, rate: unitRate, amount: row.days * unitRate };
  });
  const equipTotal = equip.reduce((s, r) => s + r.amount, 0);

  const invoiced = (job.invoices || []).reduce((acc, inv) => {
    const total = num(inv.total);
    acc.total += total;
    if (inv.status === 'paid') acc.paid += total;
    else if (inv.status === 'sent') acc.outstanding += total;
    else acc.draft += total;
    return acc;
  }, { total: 0, paid: 0, outstanding: 0, draft: 0 });

  const receivable = equipTotal + costs.billed + mileage.amount;
  return {
    mileage, costs, equipment: equip, equipmentTotal: equipTotal, invoiced,
    payable: costs.total,
    receivable,
    margin: receivable - costs.total,
    marginPct: receivable > 0 ? ((receivable - costs.total) / receivable) * 100 : 0,
  };
}

/* ── Import / export ──────────────────────────────────────────────────────── */

export function exportJob(job = state.job) {
  return JSON.stringify({ app: 'restoremap', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), job }, null, 2);
}

export async function importJob(json) {
  const parsed = JSON.parse(json);
  const incoming = parsed.job || parsed;
  if (!incoming || !Array.isArray(incoming.rooms)) throw new Error('That file is not a RestoreMap job export.');
  // Always land as a new record so an import can never clobber live field data.
  const job = migrate({ ...incoming, id: uid('job'), importedFrom: incoming.id, updatedAt: new Date().toISOString() });
  await db.jobs.put(structuredClone(job));
  state.jobs.unshift(job);
  emit('job');
  return job;
}

export { MATERIALS };
