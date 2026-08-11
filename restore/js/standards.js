// Loss classification helpers modeled on ANSI/IICRC S500 water damage
// terminology. Every result carries its own rationale so a tech can defend the
// call in a file review — and every result is overridable.

import { polygonArea, polygonPerimeter, round } from './util.js';

export const WATER_SOURCES = [
  { id: 'supply_line', label: 'Broken supply line / pipe (clean)', category: 1 },
  { id: 'water_heater', label: 'Water heater failure', category: 1 },
  { id: 'tub_sink_overflow', label: 'Tub or sink overflow (clean)', category: 1 },
  { id: 'ice_maker', label: 'Ice maker / fridge line', category: 1 },
  { id: 'fire_sprinkler', label: 'Fire sprinkler discharge', category: 1 },
  { id: 'rain_intrusion', label: 'Rain / wind-driven water intrusion', category: 2, note: 'Category rises to 2 once it passes through the building envelope or insulation.' },
  { id: 'roof_leak', label: 'Roof leak', category: 2 },
  { id: 'appliance_discharge', label: 'Washing machine / dishwasher discharge', category: 2 },
  { id: 'toilet_urine', label: 'Toilet overflow — urine only, no solids', category: 2 },
  { id: 'hvac_condensate', label: 'HVAC condensate / drain pan', category: 2 },
  { id: 'aquarium', label: 'Aquarium or waterbed', category: 2 },
  { id: 'hydrostatic', label: 'Hydrostatic pressure through slab / foundation', category: 2 },
  { id: 'sump_failure', label: 'Sump pump failure', category: 2, note: 'Treat as Category 3 if the pit carries sewage or ground water.' },
  { id: 'sewage', label: 'Sewage backup / toilet with solids', category: 3 },
  { id: 'ground_surface', label: 'Ground surface water / rising flood water', category: 3 },
  { id: 'stream_river', label: 'Stream, river or sea water', category: 3 },
  { id: 'other', label: 'Other / unknown', category: 2 },
];

/**
 * Materials with the properties drying decisions turn on.
 *  lowEvap  – counts toward the wet-surface percentage used for Class
 *  bound    – deeply held moisture, the Class 4 trigger
 *  meter    – 'wme' pin meter %, 'mc' wood moisture content %, 'rel' relative scale
 *  dryGoal  – typical dry standard when no unaffected reading is available
 */
export const MATERIALS = [
  { id: 'drywall', label: 'Drywall / gypsum board', lowEvap: true, meter: 'wme', dryGoal: 0.7, porosity: 'semi' },
  { id: 'plaster', label: 'Plaster / lath', lowEvap: true, bound: true, meter: 'wme', dryGoal: 1.0, porosity: 'semi' },
  { id: 'hardwood', label: 'Hardwood flooring', lowEvap: true, bound: true, meter: 'mc', dryGoal: 9, porosity: 'semi' },
  { id: 'engineered_wood', label: 'Engineered wood flooring', lowEvap: true, bound: true, meter: 'mc', dryGoal: 9, porosity: 'semi' },
  { id: 'subfloor_osb', label: 'OSB / plywood subfloor', lowEvap: true, meter: 'mc', dryGoal: 12, porosity: 'semi' },
  { id: 'framing', label: 'Framing lumber / studs', lowEvap: true, meter: 'mc', dryGoal: 15, porosity: 'semi' },
  { id: 'concrete', label: 'Concrete slab', lowEvap: true, bound: true, meter: 'rel', dryGoal: 60, porosity: 'semi' },
  { id: 'masonry', label: 'Brick / block / stone', lowEvap: true, bound: true, meter: 'rel', dryGoal: 60, porosity: 'semi' },
  { id: 'tile_mudset', label: 'Tile on mud bed', lowEvap: true, bound: true, meter: 'rel', dryGoal: 60, porosity: 'semi' },
  { id: 'vinyl_lvp', label: 'Vinyl / LVP over subfloor', lowEvap: true, meter: 'mc', dryGoal: 12, porosity: 'non' },
  { id: 'carpet', label: 'Carpet', lowEvap: false, meter: 'rel', dryGoal: 15, porosity: 'porous' },
  { id: 'cushion', label: 'Carpet cushion / pad', lowEvap: false, meter: 'rel', dryGoal: 15, porosity: 'porous' },
  { id: 'insulation', label: 'Insulation', lowEvap: false, meter: 'rel', dryGoal: 15, porosity: 'porous' },
  { id: 'cabinetry', label: 'Cabinetry / millwork', lowEvap: true, bound: true, meter: 'mc', dryGoal: 12, porosity: 'semi' },
  { id: 'trim_base', label: 'Baseboard / trim', lowEvap: true, meter: 'mc', dryGoal: 12, porosity: 'semi' },
  { id: 'ceiling', label: 'Ceiling assembly', lowEvap: true, meter: 'wme', dryGoal: 0.7, porosity: 'semi' },
];

export const materialById = (id) => MATERIALS.find((m) => m.id === id) || MATERIALS[0];

export const METER_UNITS = { wme: '%WME', mc: '%MC', rel: 'rel' };

export const CATEGORY_LABELS = {
  1: 'Category 1 — sanitary source',
  2: 'Category 2 — significantly contaminated',
  3: 'Category 3 — grossly contaminated',
};

export const CLASS_LABELS = {
  1: 'Class 1 — least evaporation load',
  2: 'Class 2 — significant evaporation load',
  3: 'Class 3 — greatest evaporation load',
  4: 'Class 4 — deeply held / bound water',
};

/**
 * Category of water. Starts from the source, then applies the two things that
 * actually change it in the field: elapsed time (with temperature) and contact
 * with contaminated materials.
 */
export function determineCategory({ sourceId, hoursSinceLoss, tempF = 70, contactedContaminants = false, occupantSensitive = false }) {
  const src = WATER_SOURCES.find((s) => s.id === sourceId) || WATER_SOURCES.at(-1);
  let cat = src.category;
  const why = [`Source: ${src.label} → starts at Category ${src.category}.`];
  if (src.note) why.push(src.note);

  if (contactedContaminants && cat < 3) {
    cat = Math.min(3, cat + 1);
    why.push(`Water contacted contaminated materials or a contaminated assembly → escalated to Category ${cat}.`);
  }

  // S500: category degrades over time, faster in warm conditions.
  const h = Number(hoursSinceLoss);
  if (Number.isFinite(h) && cat < 3) {
    const window = tempF >= 75 ? 48 : 72;
    if (h >= window) {
      const before = cat;
      cat = Math.min(3, cat + 1);
      why.push(`${Math.round(h)} hours elapsed at ~${Math.round(tempF)}°F (past the ${window}-hour window) → Category ${before} degraded to ${cat}.`);
    } else {
      why.push(`${Math.round(h)} hours elapsed — inside the ${window}-hour degradation window at ~${Math.round(tempF)}°F.`);
    }
  }

  if (occupantSensitive) {
    why.push('High-risk occupants noted — apply increased precautions regardless of category.');
  }

  return { category: cat, rationale: why };
}

/** Surface areas for one room, in square feet. */
export function roomSurfaces(room) {
  const pts = room.poly || [];
  const floor = polygonArea(pts);
  const perimeter = polygonPerimeter(pts);
  const height = Number(room.ceilingHeight) || 8;
  const wall = perimeter * height;
  return { floor, ceiling: floor, wall, perimeter, height, total: floor * 2 + wall, volume: floor * height };
}

/** Square feet of wet, low-evaporation material in a room. */
export function roomWetLowEvap(room) {
  const s = roomSurfaces(room);
  const a = room.affected || {};
  let wet = 0;
  const parts = [];

  const floorMat = a.floorMaterial ? materialById(a.floorMaterial) : null;
  if (floorMat?.lowEvap && a.floorPct > 0) {
    const sf = s.floor * (a.floorPct / 100);
    wet += sf;
    parts.push(`${round(sf)} sf floor (${floorMat.label}, ${a.floorPct}% wet)`);
  }

  const wallMat = a.wallMaterial ? materialById(a.wallMaterial) : null;
  if (wallMat?.lowEvap && a.wallLf > 0 && a.wallHeightIn > 0) {
    const sf = Number(a.wallLf) * (Number(a.wallHeightIn) / 12);
    wet += sf;
    parts.push(`${round(sf)} sf wall (${round(a.wallLf)} lf × ${a.wallHeightIn}" up)`);
  }

  const ceilMat = a.ceilingMaterial ? materialById(a.ceilingMaterial) : null;
  if (ceilMat?.lowEvap && a.ceilingPct > 0) {
    const sf = s.ceiling * (a.ceilingPct / 100);
    wet += sf;
    parts.push(`${round(sf)} sf ceiling (${a.ceilingPct}% wet)`);
  }

  return { wet, parts, surfaces: s };
}

/**
 * Class of water loss — the evaporation load. Uses the wet-surface-area
 * percentage method: wet low-evaporation material as a share of the combined
 * floor, wall and ceiling area, with a Class 4 override for bound water.
 */
export function determineClass(rooms = []) {
  const affected = rooms.filter((r) => r.isAffected !== false && (r.poly || []).length >= 3);
  if (!affected.length) {
    return { cls: null, pct: 0, rationale: ['No affected rooms sketched yet — draw the affected area to calculate Class.'] };
  }

  let wetSf = 0, totalSf = 0;
  const detail = [];
  let boundWater = false;
  const boundMaterials = new Set();

  for (const room of affected) {
    const { wet, parts, surfaces } = roomWetLowEvap(room);
    wetSf += wet;
    totalSf += surfaces.total;
    if (parts.length) detail.push(`${room.name}: ${parts.join(', ')}`);

    // Class 4 needs a meaningful amount of wet bound-water material, not a
    // token percentage — a 1% marking should not flip the whole loss.
    const a = room.affected || {};
    for (const key of ['floorMaterial', 'wallMaterial', 'ceilingMaterial']) {
      const m = a[key] ? materialById(a[key]) : null;
      const wetHere = key === 'floorMaterial' ? Number(a.floorPct) >= 5
        : key === 'wallMaterial' ? Number(a.wallLf) > 0 && Number(a.wallHeightIn) > 0
        : Number(a.ceilingPct) >= 5;
      if (m?.bound && wetHere) { boundWater = true; boundMaterials.add(m.label); }
    }
  }

  const pct = totalSf > 0 ? (wetSf / totalSf) * 100 : 0;
  let cls = pct < 5 ? 1 : pct <= 40 ? 2 : 3;

  const why = [
    `${round(wetSf)} sf of wet, low-evaporation material across ${round(totalSf)} sf of combined floor, wall and ceiling surface = ${round(pct, 1)}%.`,
    `Under 5% is Class 1, 5–40% is Class 2, over 40% is Class 3 → Class ${cls}.`,
  ];
  if (detail.length) why.push(...detail);

  if (boundWater) {
    cls = 4;
    why.push(`Wet materials that hold water deeply (${[...boundMaterials].join(', ')}) are present → Class 4, specialty drying methods required.`);
  }

  const wallUp = Math.max(0, ...affected.map((r) => Number(r.affected?.wallHeightIn) || 0));
  if (wallUp > 0) why.push(`Highest observed wall wicking: ${wallUp}" above the floor.`);

  return { cls, pct, wetSf, totalSf, rationale: why, boundWater };
}

/**
 * Drying goal for a material. Preference order: a measured unaffected (dry
 * standard) reading, then the material's typical dry value, plus tolerance.
 */
export function dryingGoal({ materialId, dryStandard, tolerance = 2 }) {
  const m = materialById(materialId);
  const base = Number.isFinite(Number(dryStandard)) && dryStandard !== null && dryStandard !== ''
    ? Number(dryStandard) : m.dryGoal;
  const source = Number.isFinite(Number(dryStandard)) && dryStandard !== null && dryStandard !== ''
    ? 'measured dry standard' : 'typical value for this material';
  const goal = m.meter === 'rel' ? base + tolerance * 2 : base + tolerance;
  return { goal: round(goal, 1), base, source, unit: METER_UNITS[m.meter], meter: m.meter };
}

/** Is this reading at goal? */
export function isDry(value, goal) {
  return Number.isFinite(Number(value)) && Number(value) <= Number(goal);
}

/** Category-driven work practices — what has to be on the job to be compliant. */
export function categoryRequirements(category) {
  if (category >= 3) {
    return [
      'Full containment with negative pressure; HEPA air filtration in the work area.',
      'Remove and dispose of porous materials that contacted the water (carpet, cushion, insulation, unsalvageable drywall).',
      'PPE: full-face or half-face respirator with P100, non-porous suit, gloves and boots.',
      'Clean and apply an appropriate antimicrobial to affected surfaces before drying.',
      'Do not run air movers on contaminated surfaces before removal and cleaning.',
    ];
  }
  if (category === 2) {
    return [
      'Contain the work area; HEPA air filtration recommended.',
      'Remove cushion and any grossly affected porous materials; carpet may be salvageable after cleaning.',
      'PPE: N95 minimum, gloves, eye protection.',
      'Clean affected surfaces before and after drying.',
    ];
  }
  return [
    'Standard precautions; contain to control airflow and dust.',
    'Monitor for degradation — Category 1 becomes Category 2 with time and temperature.',
    'PPE: gloves and eye protection at minimum.',
  ];
}
