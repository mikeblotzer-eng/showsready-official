/* IICRC S500-aligned classification and equipment sizing.
 *
 * Everything here is a starting point for a trained tech, not a substitute for
 * one. Each result carries a `basis` string so the number that lands on the
 * estimate can be defended to an adjuster.
 *
 * Pure functions, no DOM. Also imported by restore/tests/*.test.mjs.
 */

/* ── Category of water — how contaminated the source is ───────────────────── */

export const WATER_SOURCES = [
  { id: 'supply', label: 'Broken supply line / pressurized pipe', cat: 1 },
  { id: 'tub_sink_overflow', label: 'Tub or sink overflow, no additives', cat: 1 },
  { id: 'appliance_supply', label: 'Appliance supply line (fridge, ice maker)', cat: 1 },
  { id: 'melting_ice', label: 'Melting ice or snow', cat: 1 },
  { id: 'rainwater', label: 'Falling rainwater / roof leak', cat: 1 },
  { id: 'water_heater', label: 'Water heater tank failure', cat: 1 },
  { id: 'fire_sprinkler', label: 'Fire sprinkler discharge', cat: 1 },
  { id: 'toilet_urine', label: 'Toilet overflow — urine, no solids', cat: 2 },
  { id: 'dishwasher', label: 'Dishwasher or washing machine discharge', cat: 2 },
  { id: 'aquarium', label: 'Punctured water bed / aquarium', cat: 2 },
  { id: 'hydrostatic', label: 'Hydrostatic pressure / seepage through slab', cat: 2 },
  { id: 'sewage', label: 'Sewage / toilet backflow past the trap', cat: 3 },
  { id: 'toilet_solids', label: 'Toilet overflow with solids', cat: 3 },
  { id: 'ground_surface', label: 'Ground or surface water intrusion', cat: 3 },
  { id: 'flood', label: 'Rising flood water / storm surge', cat: 3 },
  { id: 'wind_driven_rain', label: 'Wind-driven rain from a named storm', cat: 3 },
  { id: 'sea_water', label: 'Sea water', cat: 3 },
];

/**
 * Category with time-based degradation. S500 is explicit that category is a
 * function of source *and* of what has happened to the water since: Cat 1 that
 * has sat in contact with contaminated materials, or sat warm and long enough
 * to grow, is no longer Cat 1.
 */
export function detectCategory({ sourceId, hoursElapsed = 0, tempF = 70, visibleGrowth = false, contactedContaminated = false }) {
  const source = WATER_SOURCES.find((s) => s.id === sourceId);
  const base = source ? source.cat : 1;
  let cat = base;
  const reasons = [source ? `Source: ${source.label} — Category ${base}.` : 'No source selected; defaulting to Category 1.'];

  // Warm conditions accelerate amplification; the common field threshold is
  // 48-72 hours, tightened when the space is warm.
  const threshold = tempF >= 80 ? 24 : tempF >= 70 ? 48 : 72;

  if (base === 1 && hoursElapsed >= threshold) {
    cat = 2;
    reasons.push(`${Math.round(hoursElapsed)} hrs elapsed at ~${Math.round(tempF)}°F exceeds the ${threshold} hr window — Category 1 has degraded to Category 2.`);
  }
  if (base === 2 && hoursElapsed >= threshold * 2) {
    cat = 3;
    reasons.push(`${Math.round(hoursElapsed)} hrs elapsed — prolonged Category 2 has degraded to Category 3.`);
  }
  if (contactedContaminated && cat < 2) {
    cat = 2;
    reasons.push('Water contacted contaminated materials — escalated to Category 2.');
  }
  if (visibleGrowth) {
    cat = Math.max(cat, 3);
    reasons.push('Visible microbial growth reported — treat as Category 3 and follow remediation protocols.');
  }
  return { category: cat, baseCategory: base, degraded: cat > base, reasons, hoursToNextCategory: Math.max(0, threshold - hoursElapsed) };
}

export const CATEGORY_GUIDANCE = {
  1: {
    label: 'Category 1 — Sanitary',
    ppe: 'Gloves and eye protection minimum.',
    notes: 'Porous materials are generally restorable if dried promptly. Reassess if it sits past 48–72 hrs.',
  },
  2: {
    label: 'Category 2 — Significantly contaminated',
    ppe: 'Gloves, eye protection, N95 minimum; consider Tyvek.',
    notes: 'Remove wet carpet pad. Carpet may be cleanable in place. Antimicrobial application is typical.',
  },
  3: {
    label: 'Category 3 — Grossly contaminated',
    ppe: 'Full PPE: Tyvek, gloves, boot covers, full-face or half-face respirator with P100.',
    notes: 'Remove porous materials. Containment plus negative air. Clean and disinfect all salvageable surfaces before drying.',
  },
};

/* ── Class of water — how much evaporation load you are fighting ──────────── */

/**
 * S500 (2021) frames class by the share of the combined floor, wall and ceiling
 * surface area made up of wet porous materials, with Class 4 reserved for
 * deeply held / bound water in low-evaporation assemblies.
 */
export function detectClass({ wetPorousArea = 0, totalSurfaceArea = 0, lowEvaporationMaterials = false, wetPorousOnly = false }) {
  const pct = totalSurfaceArea > 0 ? (wetPorousArea / totalSurfaceArea) * 100 : 0;
  const reasons = [];
  let cls;

  if (lowEvaporationMaterials) {
    cls = 4;
    reasons.push('Deeply held or bound water in low-evaporation materials (hardwood, plaster, concrete, masonry, lightweight concrete) — Class 4 specialty drying.');
  } else if (totalSurfaceArea <= 0) {
    cls = 1;
    reasons.push('No surface areas captured yet — defaulting to Class 1. Sketch the affected rooms to classify properly.');
  } else if (pct > 40) {
    cls = 3;
    reasons.push(`${pct.toFixed(0)}% of the combined floor, wall and ceiling area is wet porous material (>40%) — Class 3.`);
  } else if (pct >= 5) {
    cls = 2;
    reasons.push(`${pct.toFixed(0)}% of the combined floor, wall and ceiling area is wet porous material (5–40%) — Class 2.`);
  } else {
    cls = 1;
    reasons.push(`${pct.toFixed(0)}% of the combined floor, wall and ceiling area is wet porous material (<5%) — Class 1.`);
  }

  if (cls === 3 && !wetPorousOnly) {
    reasons.push('Class 3 typically means water came from overhead — check and document ceilings and insulation.');
  }
  return { class: cls, wetPorousPct: pct, reasons };
}

export const CLASS_GUIDANCE = {
  1: 'Least amount of water absorption and evaporation load. Minimal wet porous material.',
  2: 'Significant water absorption and evaporation load. Water has wicked up walls less than 24 inches.',
  3: 'Greatest water absorption and evaporation load. Water generally came from overhead.',
  4: 'Deeply held or bound water requiring specialty drying — low evaporation materials, longer drying times, often heat or desiccant.',
};

/* ── Dehumidification sizing ──────────────────────────────────────────────── */

/**
 * S500 initial dehumidification factors. Divide the cubic footage of the
 * drying chamber by the factor to get the required AHAM pints per day.
 * Desiccants are sized by air changes per hour instead of pints.
 */
export const DEHU_FACTORS = {
  conventional: { 1: 100, 2: 40, 3: 30, 4: null },
  lgr:          { 1: 100, 2: 50, 3: 40, 4: 40 },
};
export const DESICCANT_ACH = { 1: 1, 2: 2, 3: 3, 4: 4 };

export function sizeDehumidification({ cubicFeet, waterClass, type = 'lgr' }) {
  const cls = clampClass(waterClass);
  const cf = Math.max(0, Number(cubicFeet) || 0);

  if (type === 'desiccant') {
    const ach = DESICCANT_ACH[cls];
    const cfm = (cf * ach) / 60;
    return {
      type: 'desiccant',
      requiredCfm: cfm,
      airChangesPerHour: ach,
      basis: `${fmt(cf)} cu ft × ${ach} ACH ÷ 60 = ${fmt(cfm)} CFM of process air (S500 Class ${cls} desiccant factor).`,
    };
  }

  const factor = DEHU_FACTORS[type]?.[cls];
  if (!factor) {
    return {
      type,
      requiredPintsPerDay: null,
      basis: `Conventional refrigerant dehumidification is not appropriate for Class ${cls}. Use LGR or desiccant.`,
      warning: true,
    };
  }
  const pints = cf / factor;
  return {
    type,
    requiredPintsPerDay: pints,
    factor,
    basis: `${fmt(cf)} cu ft ÷ ${factor} (S500 Class ${cls} ${type === 'lgr' ? 'LGR' : 'conventional'} factor) = ${fmt(pints)} AHAM pints/day.`,
  };
}

/** Turn a pints-per-day requirement into a count of the units on the truck. */
export function dehuUnitCount(requiredPints, unitAhamPints) {
  const need = Number(requiredPints) || 0;
  const per = Number(unitAhamPints) || 0;
  if (per <= 0) return null;
  return Math.max(1, Math.ceil(need / per));
}

/* ── Air mover sizing ─────────────────────────────────────────────────────── */

/**
 * S500 air mover guidance: one per affected room, plus coverage by wet floor
 * area, plus coverage by wet wall length for Class 2 and above, plus one for
 * each inside corner, offset, alcove or obstruction.
 */
const AIRMOVER_FLOOR_DENSITY = {
  1: { min: 70, max: 50 },
  2: { min: 60, max: 50 },
  3: { min: 60, max: 40 },
  4: { min: 60, max: 40 },
};

export function sizeAirMovers({ rooms = [], waterClass }) {
  const cls = clampClass(waterClass);
  const density = AIRMOVER_FLOOR_DENSITY[cls];
  let min = 0, max = 0;
  const perRoom = [];

  for (const room of rooms) {
    const wetFloor = Math.max(0, Number(room.wetFloorArea) || 0);
    const wetWallLf = Math.max(0, Number(room.wetWallLinearFeet) || 0);
    const corners = Math.max(0, Number(room.insideCorners) || 0);
    const obstructions = Math.max(0, Number(room.obstructions) || 0);

    // One per affected room, always.
    let roomMin = 1, roomMax = 1;
    const parts = ['1 per affected room'];

    const floorMin = Math.ceil(wetFloor / density.min);
    const floorMax = Math.ceil(wetFloor / density.max);
    roomMin += floorMin;
    roomMax += floorMax;
    if (wetFloor > 0) parts.push(`${fmt(wetFloor)} sq ft wet floor ÷ ${density.min}–${density.max} sq ft`);

    if (cls >= 2 && wetWallLf > 0) {
      // Class 2+ adds wall coverage at roughly one unit per 14 linear feet.
      const wall = Math.ceil(wetWallLf / 14);
      roomMin += wall;
      roomMax += wall;
      parts.push(`${fmt(wetWallLf)} lf wet wall ÷ 14 lf`);
    } else if (cls === 1 && wetWallLf > 0) {
      // Class 1 uses floor area *or* wall length, whichever calls for more.
      const wall = Math.ceil(wetWallLf / 14);
      roomMin = Math.max(roomMin, 1 + wall);
      roomMax = Math.max(roomMax, 1 + wall);
      parts.push(`or ${fmt(wetWallLf)} lf wet wall ÷ 14 lf, whichever is greater`);
    }

    const extras = corners + obstructions;
    if (extras > 0) {
      roomMin += extras;
      roomMax += extras;
      parts.push(`${extras} inside corner/offset/obstruction`);
    }

    min += roomMin;
    max += roomMax;
    perRoom.push({ roomId: room.id, name: room.name, min: roomMin, max: roomMax, basis: parts.join(' + ') });
  }

  return {
    min, max,
    recommended: max,
    perRoom,
    basis: `S500 Class ${cls}: one air mover per affected room, plus one per ${density.max}–${density.min} sq ft of wet floor${cls >= 2 ? ', plus one per 14 lf of wet wall' : ''}, plus one per inside corner, offset or obstruction.`,
  };
}

/* ── Air filtration / negative air ────────────────────────────────────────── */

/** AFD sizing by air changes per hour, driven by category rather than class. */
export function sizeAirScrubbers({ cubicFeet, category, unitCfm = 500, containment = false }) {
  const cat = Math.min(3, Math.max(1, Number(category) || 1));
  const cf = Math.max(0, Number(cubicFeet) || 0);
  const ach = cat === 3 ? 6 : cat === 2 ? 4 : containment ? 4 : 0;

  if (ach === 0) {
    return { required: 0, ach: 0, requiredCfm: 0, basis: 'Category 1 with no containment — air filtration is optional, not required.' };
  }
  const cfm = (cf * ach) / 60;
  const units = Math.max(1, Math.ceil(cfm / Math.max(1, unitCfm)));
  return {
    required: units,
    ach,
    requiredCfm: cfm,
    negativeAir: cat === 3,
    basis: `${fmt(cf)} cu ft × ${ach} ACH ÷ 60 = ${fmt(cfm)} CFM. At ${unitCfm} CFM per unit that is ${units} air scrubber${units === 1 ? '' : 's'}${cat === 3 ? ', run under negative pressure inside containment' : ''}.`,
  };
}

/* ── Whole-job equipment recommendation ───────────────────────────────────── */

export function recommendEquipment({ rooms = [], waterClass, category, dehuType = 'lgr', dehuUnitPints = 130, scrubberCfm = 500, containment = false }) {
  const cubicFeet = rooms.reduce((sum, r) => sum + (Number(r.volume) || 0), 0);
  const airMovers = sizeAirMovers({ rooms, waterClass });
  const dehu = sizeDehumidification({ cubicFeet, waterClass, type: dehuType });
  const scrubbers = sizeAirScrubbers({ cubicFeet, category, unitCfm: scrubberCfm, containment });

  const dehuCount = dehu.requiredPintsPerDay != null
    ? dehuUnitCount(dehu.requiredPintsPerDay, dehuUnitPints)
    : null;

  const warnings = [];
  if (clampClass(waterClass) === 4) {
    warnings.push('Class 4 — plan on specialty drying: heat, desiccant, injection drying systems or drying panels. Standard air movers alone will not reach bound water.');
  }
  if (Number(category) === 3) {
    warnings.push('Category 3 — containment, negative air, full PPE and removal of porous materials before drying equipment goes in.');
  }
  if (dehu.warning) warnings.push(dehu.basis);

  return {
    cubicFeet,
    airMovers,
    dehumidification: { ...dehu, unitCount: dehuCount, unitPints: dehuUnitPints },
    airScrubbers: scrubbers,
    warnings,
  };
}

/* ── Material dry standards ───────────────────────────────────────────────── */

/**
 * Typical dry-standard ranges by material. The defensible dry standard is
 * always a reading taken from an unaffected area of the same material in the
 * same structure — these are the fallback when that is not available.
 */
export const MATERIALS = [
  { id: 'drywall',        label: 'Drywall / gypsum',      meter: 'wme',   dryMax: 1,  unit: '%',   scale: 'reference' },
  { id: 'plaster',        label: 'Plaster',               meter: 'wme',   dryMax: 1,  unit: '%',   scale: 'reference', lowEvap: true },
  { id: 'framing_pine',   label: 'Framing lumber (pine)', meter: 'pin',   dryMax: 16, unit: '%',   scale: 'wood' },
  { id: 'hardwood',       label: 'Hardwood flooring',     meter: 'pin',   dryMax: 12, unit: '%',   scale: 'wood', lowEvap: true },
  { id: 'subfloor_osb',   label: 'OSB / plywood subfloor', meter: 'pin',  dryMax: 16, unit: '%',   scale: 'wood' },
  { id: 'concrete',       label: 'Concrete slab',         meter: 'rh_probe', dryMax: 75, unit: '% RH', scale: 'insitu', lowEvap: true },
  { id: 'lw_concrete',    label: 'Lightweight concrete',  meter: 'rh_probe', dryMax: 75, unit: '% RH', scale: 'insitu', lowEvap: true },
  { id: 'carpet',         label: 'Carpet / pad',          meter: 'wme',   dryMax: 1,  unit: '%',   scale: 'reference' },
  { id: 'masonry',        label: 'Brick / block masonry', meter: 'wme',   dryMax: 1,  unit: '%',   scale: 'reference', lowEvap: true },
  { id: 'insulation',     label: 'Insulation',            meter: 'wme',   dryMax: 1,  unit: '%',   scale: 'reference' },
  { id: 'tile',           label: 'Tile / non-porous',     meter: 'wme',   dryMax: 0,  unit: '%',   scale: 'reference' },
];

export const POROUS_MATERIALS = new Set(['drywall', 'carpet', 'insulation', 'framing_pine', 'subfloor_osb', 'plaster', 'hardwood']);
export const LOW_EVAP_MATERIALS = new Set(MATERIALS.filter((m) => m.lowEvap).map((m) => m.id));

/**
 * Drying goal for a monitoring point. A reading from an unaffected area of the
 * same material always wins; the published range is only the fallback.
 */
export function dryingGoal({ materialId, dryStandard }) {
  const mat = MATERIALS.find((m) => m.id === materialId);
  if (dryStandard != null && dryStandard !== '' && Number.isFinite(Number(dryStandard))) {
    const ds = Number(dryStandard);
    // Allow a small tolerance above the unaffected reference.
    const goal = mat?.scale === 'wood' ? ds + 2 : ds + 1;
    return { goal, source: 'measured', basis: `Unaffected ${mat ? mat.label.toLowerCase() : 'material'} reads ${ds}${mat?.unit || '%'}; goal is that reference plus tolerance.` };
  }
  if (!mat) return { goal: null, source: 'none', basis: 'Select a material to get a drying goal.' };
  return { goal: mat.dryMax, source: 'published', basis: `No unaffected reference recorded — falling back to a typical dry standard of ${mat.dryMax}${mat.unit} for ${mat.label.toLowerCase()}. Take an unaffected reading to make this defensible.` };
}

/** Is this point dry, and if not, is it trending the right way? */
export function pointStatus(point, readings = []) {
  const sorted = [...readings].sort((a, b) => new Date(a.date) - new Date(b.date));
  const latest = sorted[sorted.length - 1];
  const { goal, source, basis } = dryingGoal(point);
  if (!latest) return { state: 'no-data', goal, goalSource: source, basis };

  const value = Number(latest.value);
  const dry = goal != null && value <= goal;
  let trend = 'flat';
  if (sorted.length >= 2) {
    const prev = Number(sorted[sorted.length - 2].value);
    if (value < prev - 0.5) trend = 'drying';
    else if (value > prev + 0.5) trend = 'wetting';
  }
  return {
    state: dry ? 'dry' : trend === 'wetting' ? 'wetting' : trend === 'drying' ? 'drying' : 'stalled',
    value, goal, goalSource: source, basis, trend,
    readingCount: sorted.length,
    first: sorted[0] ? Number(sorted[0].value) : null,
  };
}

/**
 * A stalled point across two or more consecutive days is the single most
 * common reason a drying job runs long and gets denied. Surface it loudly.
 */
export function stalledPoints(points) {
  return points.filter((p) => {
    const s = pointStatus(p, p.readings || []);
    return s.state === 'stalled' && s.readingCount >= 3;
  });
}

function clampClass(c) {
  const n = Number(c);
  return [1, 2, 3, 4].includes(n) ? n : 1;
}

function fmt(n) {
  const v = Number(n) || 0;
  return v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1).replace(/\.0$/, '');
}
