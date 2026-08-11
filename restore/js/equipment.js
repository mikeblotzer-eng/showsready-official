// Equipment catalog and drying-system sizing.
// Sizing follows the sizing methods published with ANSI/IICRC S500: air movers
// off wet wall length and wet floor area, dehumidification off cubic feet
// divided by a class factor, air filtration off air changes per hour.

import { roomSurfaces, roomWetLowEvap } from './standards.js';
import { round } from './util.js';

export const EQUIPMENT_TYPES = {
  air_mover: { label: 'Air mover', icon: '➤', color: '#38bdf8' },
  dehu: { label: 'Dehumidifier', icon: '▣', color: '#a78bfa' },
  afd: { label: 'Air scrubber / AFD', icon: '◍', color: '#34d399' },
  heater: { label: 'Heater', icon: '🔥', color: '#fb923c' },
  specialty: { label: 'Specialty drying', icon: '✦', color: '#f472b6' },
};

/**
 * Fleet catalog. `rate` is the default daily billing rate and `code` is the
 * line-item code carried into the estimate; both are editable in Settings so a
 * shop can match its own price list.
 */
export const CATALOG = [
  { id: 'am_axial', type: 'air_mover', label: 'Axial air mover', cfm: 3200, amps: 1.9, rate: 26.5, code: 'WTR-AM' },
  { id: 'am_centrifugal', type: 'air_mover', label: 'Centrifugal air mover', cfm: 2400, amps: 2.3, rate: 26.5, code: 'WTR-AM' },
  { id: 'am_lowprofile', type: 'air_mover', label: 'Low-profile air mover', cfm: 1800, amps: 1.5, rate: 26.5, code: 'WTR-AM' },
  { id: 'dehu_lgr_std', type: 'dehu', label: 'LGR dehumidifier — 70 AHAM', aham: 70, kind: 'lgr', amps: 5.5, rate: 78, code: 'WTR-DHM' },
  { id: 'dehu_lgr_lg', type: 'dehu', label: 'LGR dehumidifier — 110 AHAM', aham: 110, kind: 'lgr', amps: 7.5, rate: 95, code: 'WTR-DHL' },
  { id: 'dehu_lgr_xl', type: 'dehu', label: 'LGR dehumidifier — 150 AHAM', aham: 150, kind: 'lgr', amps: 9.5, rate: 118, code: 'WTR-DHX' },
  { id: 'dehu_conv', type: 'dehu', label: 'Conventional refrigerant — 50 AHAM', aham: 50, kind: 'conventional', amps: 4.5, rate: 62, code: 'WTR-DHC' },
  { id: 'dehu_desiccant', type: 'dehu', label: 'Desiccant dehumidifier', cfm: 1500, kind: 'desiccant', rate: 285, code: 'WTR-DES' },
  { id: 'afd_500', type: 'afd', label: 'HEPA air scrubber — 500 CFM', cfm: 500, amps: 2.5, rate: 78, code: 'WTR-AFD' },
  { id: 'afd_1000', type: 'afd', label: 'HEPA air scrubber — 1000 CFM', cfm: 1000, amps: 4.5, rate: 105, code: 'WTR-AFD' },
  { id: 'heat_elec', type: 'heater', label: 'Electric heater / heat drying', btu: 17000, rate: 92, code: 'WTR-HTR' },
  { id: 'spec_injectidry', type: 'specialty', label: 'Wall cavity / injection drying system', rate: 88, code: 'WTR-INJ' },
  { id: 'spec_floormat', type: 'specialty', label: 'Hardwood floor drying mat system', rate: 96, code: 'WTR-HWD' },
  { id: 'spec_negair', type: 'specialty', label: 'Negative air machine w/ ducting', cfm: 1000, rate: 110, code: 'WTR-NEG' },
];

export const catalogById = (id) => CATALOG.find((c) => c.id === id) || null;
export const catalogByType = (type) => CATALOG.filter((c) => c.type === type);

// Cubic-feet-per-pint factors by dehumidifier technology and class of loss.
export const DEHU_FACTORS = {
  conventional: { 1: 100, 2: 40, 3: 30, 4: 50 },
  lgr: { 1: 100, 2: 50, 3: 40, 4: 50 },
};
// Desiccants are sized by air changes per hour instead of pints.
export const DESICCANT_ACH = { 1: 1, 2: 2, 3: 3, 4: 4 };

// Air-mover coverage: linear feet of wet wall per unit, and square feet of wet
// floor per unit by class.
const LF_PER_AIR_MOVER = 14;
const SF_PER_AIR_MOVER = { 1: 70, 2: 60, 3: 50, 4: 50 };

/** Air movers for a single room, with the arithmetic exposed. */
export function airMoversForRoom(room, cls) {
  const s = roomSurfaces(room);
  const a = room.affected || {};
  const wetWallLf = Number(a.wallLf) || 0;
  const wetFloorSf = s.floor * ((Number(a.floorPct) || 0) / 100);
  const wetCeilingSf = s.ceiling * ((Number(a.ceilingPct) || 0) / 100);

  const wallUnits = wetWallLf > 0 ? Math.ceil(wetWallLf / LF_PER_AIR_MOVER) : 0;
  const floorUnits = wetFloorSf > 0 ? Math.ceil(wetFloorSf / (SF_PER_AIR_MOVER[cls] || 60)) : 0;
  const ceilingUnits = cls >= 3 && wetCeilingSf > 0 ? Math.ceil(wetCeilingSf / 60) : 0;

  const extras = (Number(a.offsets) || 0) + (Number(a.closets) || 0) + (Number(a.stairs) || 0);
  const base = Math.max(wallUnits, floorUnits);
  const total = Math.max(wetWallLf + wetFloorSf > 0 ? 1 : 0, base + ceilingUnits + extras);

  const notes = [];
  if (wallUnits) notes.push(`${round(wetWallLf)} lf wet wall ÷ ${LF_PER_AIR_MOVER} lf = ${wallUnits}`);
  if (floorUnits) notes.push(`${round(wetFloorSf)} sf wet floor ÷ ${SF_PER_AIR_MOVER[cls] || 60} sf = ${floorUnits}`);
  if (ceilingUnits) notes.push(`${round(wetCeilingSf)} sf wet ceiling ÷ 60 sf = ${ceilingUnits} (Class 3 overhead water)`);
  if (extras) notes.push(`+${extras} for offsets, closets and stairwells`);

  return { count: total, notes, wetWallLf, wetFloorSf, wetCeilingSf };
}

/** Pick the fewest units from the fleet that cover a required pint load. */
export function pickDehus(ppdRequired, kind = 'lgr') {
  const options = CATALOG
    .filter((c) => c.type === 'dehu' && c.kind === kind && c.aham)
    .sort((a, b) => b.aham - a.aham);
  if (!options.length || ppdRequired <= 0) return [];

  const picks = [];
  let remaining = ppdRequired;
  const largest = options[0];
  while (remaining > largest.aham) {
    picks.push(largest);
    remaining -= largest.aham;
  }
  const fit = [...options].reverse().find((o) => o.aham >= remaining) || largest;
  if (remaining > 0) picks.push(fit);

  const grouped = new Map();
  for (const p of picks) grouped.set(p.id, (grouped.get(p.id) || 0) + 1);
  return [...grouped].map(([id, qty]) => ({ item: catalogById(id), qty }));
}

/**
 * Whole-job drying system. Returns recommended quantities plus the reasoning,
 * so the numbers land in the file, not just on the truck.
 */
export function recommendSystem({ rooms = [], cls = 2, category = 1, dehuKind = 'lgr' }) {
  const affected = rooms.filter((r) => r.isAffected !== false && (r.poly || []).length >= 3);

  let volume = 0, floorSf = 0, wetWallLf = 0, wetSf = 0;
  let airMovers = 0;
  const perRoom = [];

  for (const room of affected) {
    const s = roomSurfaces(room);
    volume += s.volume;
    floorSf += s.floor;
    wetWallLf += Number(room.affected?.wallLf) || 0;
    wetSf += roomWetLowEvap(room).wet;
    const am = airMoversForRoom(room, cls);
    airMovers += am.count;
    perRoom.push({ room, airMovers: am.count, notes: am.notes, volume: s.volume, floor: s.floor });
  }

  const factor = (DEHU_FACTORS[dehuKind] || DEHU_FACTORS.lgr)[cls] || 40;
  const ppdRequired = dehuKind === 'desiccant' ? 0 : Math.ceil(volume / factor);
  const dehus = dehuKind === 'desiccant' ? [] : pickDehus(ppdRequired, dehuKind);
  const desiccantCfm = Math.ceil((volume * (DESICCANT_ACH[cls] || 2)) / 60);

  // Air filtration: 4 ACH is the working target for Cat 2/3 work areas.
  const ach = category >= 3 ? 4 : category === 2 ? 4 : 0;
  const afdCfm = Math.ceil((volume * ach) / 60);
  const afdUnit = catalogById(afdCfm > 700 ? 'afd_1000' : 'afd_500');
  const afdQty = ach ? Math.max(1, Math.ceil(afdCfm / (afdUnit?.cfm || 500))) : 0;

  const notes = [];
  notes.push(`Affected volume ${round(volume)} cf across ${affected.length} area${affected.length === 1 ? '' : 's'}.`);
  if (dehuKind === 'desiccant') {
    notes.push(`Desiccant sizing: ${round(volume)} cf × ${DESICCANT_ACH[cls] || 2} ACH ÷ 60 = ${desiccantCfm} CFM of process air.`);
  } else {
    notes.push(`Dehumidification: ${round(volume)} cf ÷ ${factor} (${dehuKind === 'lgr' ? 'LGR' : 'conventional'} factor for Class ${cls}) = ${ppdRequired} AHAM pints/day required.`);
  }
  notes.push(`Air movers: ${airMovers} total from per-room wet wall and wet floor coverage.`);
  if (ach) notes.push(`Air filtration: ${round(volume)} cf × ${ach} ACH ÷ 60 = ${afdCfm} CFM for Category ${category} work.`);
  if (cls === 4) notes.push('Class 4 — add specialty systems (injection drying, floor mat systems, heat) for bound water; standard airflow alone will not reach it.');

  const amp = airMovers * 1.9 + dehus.reduce((t, d) => t + d.qty * (d.item.amps || 6), 0) + afdQty * 2.5;
  const circuits = Math.ceil(amp / 12);

  return {
    volume, floorSf, wetWallLf, wetSf, cls, category,
    airMovers,
    airMoverUnit: catalogById('am_axial'),
    ppdRequired, dehus, dehuKind, factor,
    desiccantCfm,
    afdCfm, afdQty, afdUnit,
    perRoom, notes,
    amps: round(amp, 1), circuits,
    specialty: cls === 4
      ? [catalogById('spec_injectidry'), catalogById('spec_floormat')].filter(Boolean)
      : [],
  };
}

/** Turn a recommendation into placeable equipment records. */
export function recommendationToPlacements(rec) {
  const out = [];
  for (let i = 0; i < rec.airMovers; i++) out.push({ catalogId: rec.airMoverUnit.id, type: 'air_mover' });
  for (const d of rec.dehus) for (let i = 0; i < d.qty; i++) out.push({ catalogId: d.item.id, type: 'dehu' });
  for (let i = 0; i < rec.afdQty; i++) out.push({ catalogId: rec.afdUnit.id, type: 'afd' });
  return out;
}
