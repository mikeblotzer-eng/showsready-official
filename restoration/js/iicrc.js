/**
 * Classification and equipment sizing, modelled on the IICRC S500 approach to
 * water damage restoration.
 *
 * Two things to be clear about, because a tech will be standing in a wet
 * basement trusting this screen:
 *
 *  1. The category/class logic below follows the S500 definitions, but the
 *     standard requires professional judgement. The app always shows its
 *     reasoning and always lets the tech override the result.
 *  2. The sizing coefficients are the widely taught field factors. They are
 *     editable in Settings so a firm can align them with its own SOP and with
 *     whatever edition of the standard it works to. Nothing here replaces the
 *     standard itself.
 */

/* ------------------------------------------------------------------ */
/* Category of water                                                   */
/* ------------------------------------------------------------------ */

export const WATER_SOURCES = [
  { id: 'supply_line', label: 'Broken supply line / burst pipe', baseCategory: 1 },
  { id: 'water_heater', label: 'Water heater tank failure', baseCategory: 1 },
  { id: 'tub_sink_overflow', label: 'Tub or sink overflow (no contaminants)', baseCategory: 1 },
  { id: 'appliance_supply', label: 'Appliance supply line (ice maker, washer inlet)', baseCategory: 1 },
  { id: 'rain_intrusion', label: 'Wind-driven rain / roof leak', baseCategory: 1 },
  { id: 'fire_sprinkler', label: 'Fire suppression discharge', baseCategory: 1 },
  { id: 'toilet_clean', label: 'Toilet overflow — bowl water only, no solids', baseCategory: 2 },
  { id: 'washer_discharge', label: 'Washing machine discharge', baseCategory: 2 },
  { id: 'dishwasher_discharge', label: 'Dishwasher discharge', baseCategory: 2 },
  { id: 'aquarium', label: 'Aquarium / waterbed', baseCategory: 2 },
  { id: 'hydrostatic', label: 'Hydrostatic seepage through slab or foundation', baseCategory: 2 },
  { id: 'hvac_condensate', label: 'HVAC condensate line / drain pan', baseCategory: 2 },
  { id: 'sewage', label: 'Sewage or toilet backflow past the trap', baseCategory: 3 },
  { id: 'ground_surface', label: 'Rising ground or surface water / flooding', baseCategory: 3 },
  { id: 'seawater', label: 'Sea water or tidal intrusion', baseCategory: 3 },
  { id: 'stagnant', label: 'Stagnant / unknown standing water', baseCategory: 3 },
];

/**
 * Category, with degradation. S500 is explicit that a Category 1 loss can
 * deteriorate as time, temperature and contact with soils change the water.
 */
export function determineCategory({
  sourceId,
  hoursSinceLoss = 0,
  ambientTempF = 70,
  contactedContaminatedMaterial = false,
  visibleMicrobialGrowth = false,
  odorPresent = false,
  occupantHealthConcern = false,
  override = null,
}) {
  const source = WATER_SOURCES.find((s) => s.id === sourceId);
  let category = source ? source.baseCategory : 1;
  const reasons = [];
  reasons.push(source
    ? `Source "${source.label}" starts at Category ${source.baseCategory}.`
    : 'No source selected — assuming Category 1 as a starting point.');

  if (category === 1) {
    // Warm, wet and sitting: the classic Cat 1 -> Cat 2 escalation.
    if (hoursSinceLoss >= 72 || (hoursSinceLoss >= 48 && ambientTempF >= 80)) {
      category = 2;
      reasons.push(`Water has stood ${Math.round(hoursSinceLoss)} h at ~${Math.round(ambientTempF)} °F — escalated to Category 2.`);
    }
    if (contactedContaminatedMaterial) {
      category = Math.max(category, 2);
      reasons.push('Water contacted contaminated materials or soils — escalated to Category 2.');
    }
  }
  if (category === 2 && (hoursSinceLoss >= 120 || visibleMicrobialGrowth)) {
    category = 3;
    reasons.push(visibleMicrobialGrowth
      ? 'Visible microbial growth — escalated to Category 3.'
      : `Category 2 water standing over ${Math.round(hoursSinceLoss)} h — escalated to Category 3.`);
  }
  if (visibleMicrobialGrowth && category < 3) {
    category = 3;
    reasons.push('Visible microbial growth — escalated to Category 3.');
  }
  if (odorPresent) reasons.push('Odour reported — confirm category on site and document.');
  if (occupantHealthConcern) reasons.push('Occupant health concern noted — consider containment and a specialised expert regardless of category.');

  const applied = override ?? category;
  if (override && override !== category) reasons.push(`Technician override: recorded as Category ${override}.`);

  return { category: applied, computed: category, overridden: override != null && override !== category, reasons, guidance: CATEGORY_GUIDANCE[applied] };
}

export const CATEGORY_GUIDANCE = {
  1: {
    name: 'Category 1 — Sanitary',
    summary: 'Originates from a sanitary source and poses no substantial risk from ingestion, inhalation or contact.',
    ppe: 'Minimum: gloves, safety glasses, work boots.',
    handling: 'Materials may generally be dried in place. Re-evaluate category daily — this can degrade.',
  },
  2: {
    name: 'Category 2 — Significantly contaminated',
    summary: 'Contains significant contamination and has the potential to cause discomfort or sickness if contacted or consumed.',
    ppe: 'Gloves, eye protection, N95 or better, and dedicated outerwear.',
    handling: 'Clean and disinfect salvageable materials. Remove porous materials that cannot be effectively cleaned (typically pad, and often carpet).',
  },
  3: {
    name: 'Category 3 — Grossly contaminated',
    summary: 'Grossly contaminated and can contain pathogenic, toxigenic or other harmful agents.',
    ppe: 'Full PPE: suit, gloves, boots, full-face or half-face respirator with appropriate cartridges.',
    handling: 'Remove and dispose of porous materials. Establish containment and negative pressure. Clean and disinfect all affected surfaces before drying.',
  },
};

/* ------------------------------------------------------------------ */
/* Class of water — the drying/evaporation load                        */
/* ------------------------------------------------------------------ */

/** Materials whose bound water makes a job a Class 4 specialty dry. */
export const LOW_EVAPORATION_MATERIALS = [
  { id: 'hardwood', label: 'Hardwood flooring' },
  { id: 'plaster', label: 'Plaster / lath' },
  { id: 'concrete', label: 'Concrete or lightweight concrete' },
  { id: 'gypcrete', label: 'Gypcrete underlayment' },
  { id: 'masonry', label: 'Brick / block / stone' },
  { id: 'crawlspace_soil', label: 'Crawlspace soil' },
  { id: 'multilayer_floor', label: 'Multi-layer floor assembly (LVT/tile over subfloor)' },
];

/**
 * Class from wetted surface fraction, per S500.
 *
 *   Class 1  — < ~5%  of the combined floor, wall and ceiling area is wet
 *   Class 2  — ~5–40%
 *   Class 3  — > ~40%, typically water from overhead
 *   Class 4  — deeply bound water in low-evaporation materials (specialty drying)
 *
 * `rooms` entries carry the affected quantities the sketch already computes.
 */
export function determineClass(rooms, { override = null } = {}) {
  let totalSurface = 0;
  let affectedSurface = 0;
  let anyCeiling = false;
  const lowEvap = new Set();

  for (const r of rooms) {
    const ceilingH = r.ceilingHeightFt || 8;
    const floor = r.floorAreaSqft || 0;
    const wall = (r.perimeterFt || 0) * ceilingH;
    const ceiling = floor;
    totalSurface += floor + wall + ceiling;

    const affFloor = Math.min(r.affectedFloorSqft ?? floor, floor);
    const affWall = Math.min((r.affectedWallLf ?? 0) * Math.min(r.wetWallHeightFt ?? 2, ceilingH), wall);
    const affCeiling = r.ceilingAffected ? (r.affectedCeilingSqft ?? ceiling) : 0;
    affectedSurface += affFloor + affWall + affCeiling;

    if (r.ceilingAffected) anyCeiling = true;
    for (const m of r.lowEvaporationMaterials || []) lowEvap.add(m);
  }

  const fraction = totalSurface > 0 ? affectedSurface / totalSurface : 0;
  const reasons = [];
  let cls;
  if (fraction > 0.4) {
    cls = 3;
    reasons.push(`${(fraction * 100).toFixed(0)}% of the combined floor, wall and ceiling area is affected (> 40%).`);
  } else if (fraction >= 0.05) {
    cls = 2;
    reasons.push(`${(fraction * 100).toFixed(0)}% of the combined floor, wall and ceiling area is affected (5–40%).`);
  } else {
    cls = 1;
    reasons.push(`${(fraction * 100).toFixed(0)}% of the combined floor, wall and ceiling area is affected (< 5%).`);
  }
  if (anyCeiling && cls < 3) reasons.push('Ceilings are affected — water came from overhead; verify whether this is a Class 3 loss.');

  if (lowEvap.size) {
    cls = 4;
    const names = [...lowEvap].map((id) => LOW_EVAPORATION_MATERIALS.find((m) => m.id === id)?.label || id);
    reasons.push(`Low-evaporation materials present (${names.join(', ')}) — deeply held water makes this a Class 4 specialty dry.`);
  }

  const applied = override ?? cls;
  if (override && override !== cls) reasons.push(`Technician override: recorded as Class ${override}.`);

  return {
    class: applied,
    computed: cls,
    overridden: override != null && override !== cls,
    wettedFraction: fraction,
    totalSurfaceSqft: totalSurface,
    affectedSurfaceSqft: affectedSurface,
    reasons,
    guidance: CLASS_GUIDANCE[applied],
  };
}

export const CLASS_GUIDANCE = {
  1: { name: 'Class 1 — Least amount of water', summary: 'Minimal absorption and evaporation load. Materials of low porosity, small wetted area.' },
  2: { name: 'Class 2 — Significant water', summary: 'Large wetted area with absorption into cushion, carpet and structural materials; wicking up walls under two feet.' },
  3: { name: 'Class 3 — Greatest amount of water', summary: 'Water generally from overhead; ceilings, walls, insulation, carpet and subfloor are saturated.' },
  4: { name: 'Class 4 — Specialty drying', summary: 'Deeply held or bound water in low-evaporation materials. Requires low specific humidity, extended drying time, and often heat or targeted systems.' },
};

/* ------------------------------------------------------------------ */
/* Equipment sizing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Default sizing coefficients. Editable in Settings — see the note at the top
 * of this file. `sqftPerAirMover` is the affected-floor allowance; wall and
 * corner allowances follow the common field practice of one mover per stretch
 * of wet wall and one per inside corner or offset.
 */
export const DEFAULT_COEFFICIENTS = {
  airMover: {
    1: { sqftPerAirMover: 60, lfWallPerAirMover: 16 },
    2: { sqftPerAirMover: 50, lfWallPerAirMover: 16 },
    3: { sqftPerAirMover: 40, lfWallPerAirMover: 14 },
    4: { sqftPerAirMover: 50, lfWallPerAirMover: 16 },
  },
  // Cubic feet of chamber per AHAM pint of capacity. Lower factor = more dehu.
  dehuFactor: {
    conventional: { 1: 100, 2: 40, 3: 30, 4: 50 },
    lgr: { 1: 100, 2: 50, 3: 40, 4: 60 },
  },
  // Desiccant sizing is by air changes per hour of process air.
  desiccantAch: { 1: 1, 2: 2, 3: 3, 4: 4 },
  // Air scrubber sizing: air changes per hour by category.
  scrubberAch: { 1: 0, 2: 4, 3: 6 },
};

export const DEHU_TYPES = {
  conventional: { label: 'Conventional refrigerant', defaultCapacityPpd: 70 },
  lgr: { label: 'LGR (low grain refrigerant)', defaultCapacityPpd: 110 },
  desiccant: { label: 'Desiccant', defaultCfm: 1200 },
};

/**
 * Recommend the drying equipment for a chamber.
 *
 * @param {object} p
 * @param {Array}  p.rooms          rooms in the chamber, with affected quantities
 * @param {number} p.waterClass     1..4
 * @param {number} p.category       1..3
 * @param {string} p.dehuType       'conventional' | 'lgr' | 'desiccant'
 * @param {number} p.dehuCapacityPpd  AHAM rating of the units on the truck
 * @param {object} p.coefficients   overrides for DEFAULT_COEFFICIENTS
 */
export function recommendEquipment({
  rooms = [],
  waterClass = 2,
  category = 1,
  dehuType = 'lgr',
  dehuCapacityPpd,
  desiccantCfm,
  coefficients = DEFAULT_COEFFICIENTS,
  containment = false,
}) {
  const co = mergeCoefficients(coefficients);
  const cls = clampClass(waterClass);
  const amCo = co.airMover[cls];

  let cubicFeet = 0, affectedFloor = 0, wetWallLf = 0, corners = 0, ceilingSqft = 0;
  const perRoom = [];

  for (const r of rooms) {
    const h = r.ceilingHeightFt || 8;
    const floor = r.floorAreaSqft || 0;
    const aff = Math.min(r.affectedFloorSqft ?? floor, floor);
    const wallLf = r.affectedWallLf ?? 0;
    const rc = r.insideCorners ?? 0;

    cubicFeet += floor * h;
    affectedFloor += aff;
    wetWallLf += wallLf;
    corners += rc;
    if (r.ceilingAffected) ceilingSqft += r.affectedCeilingSqft ?? floor;

    // Per S500 practice: at least one mover per affected room, then coverage
    // for wet floor, wet wall runs, and each inside corner or offset.
    const fromFloor = aff > 0 ? Math.ceil(aff / amCo.sqftPerAirMover) : 0;
    const fromWall = wallLf > 0 ? Math.ceil(wallLf / amCo.lfWallPerAirMover) : 0;
    const roomMovers = aff > 0 || wallLf > 0
      ? Math.max(1, fromFloor + fromWall + rc)
      : 0;
    perRoom.push({
      roomId: r.id,
      name: r.name,
      airMovers: roomMovers,
      breakdown: { fromFloor, fromWall, fromCorners: rc, minimumPerRoom: 1 },
      cubicFeet: floor * h,
      affectedFloorSqft: aff,
    });
  }

  const airMovers = perRoom.reduce((n, r) => n + r.airMovers, 0);

  // Dehumidification
  let dehumidifiers = null;
  if (dehuType === 'desiccant') {
    const ach = co.desiccantAch[cls];
    const cfm = Math.ceil(cubicFeet * ach / 60);
    const unitCfm = desiccantCfm || DEHU_TYPES.desiccant.defaultCfm;
    dehumidifiers = {
      type: 'desiccant',
      requiredProcessCfm: cfm,
      unitCfm,
      units: cfm > 0 ? Math.ceil(cfm / unitCfm) : 0,
      basis: `${ach} air change${ach === 1 ? '' : 's'} per hour of process air for a Class ${cls} loss.`,
    };
  } else {
    const factor = co.dehuFactor[dehuType]?.[cls] ?? co.dehuFactor.lgr[cls];
    const requiredPpd = Math.ceil(cubicFeet / factor);
    const unitPpd = dehuCapacityPpd || DEHU_TYPES[dehuType]?.defaultCapacityPpd || 110;
    dehumidifiers = {
      type: dehuType,
      requiredPpd,
      unitPpd,
      units: requiredPpd > 0 ? Math.ceil(requiredPpd / unitPpd) : 0,
      basis: `${Math.round(cubicFeet).toLocaleString()} ft³ ÷ ${factor} ft³ per AHAM pint (Class ${cls}, ${DEHU_TYPES[dehuType]?.label || dehuType}).`,
    };
  }

  // Air filtration — driven by category, not class.
  const scrubAch = co.scrubberAch[clampCategory(category)] ?? 0;
  const scrubberCfm = Math.ceil(cubicFeet * scrubAch / 60);
  const airScrubbers = {
    units: scrubberCfm > 0 ? Math.ceil(scrubberCfm / 500) : 0,
    requiredCfm: scrubberCfm,
    achTarget: scrubAch,
    unitCfm: 500,
    basis: scrubAch
      ? `${scrubAch} air changes per hour for a Category ${category} loss, at 500 CFM per scrubber.`
      : 'Not indicated for a Category 1 loss unless dust or odour control is needed.',
  };

  const notes = [];
  if (cls === 4) notes.push('Class 4: expect an extended dry-down. Consider low specific humidity, heat drying or targeted systems (floor mats, wall injection, cavity ducting) instead of adding surface air movers.');
  if (category >= 2) notes.push('Category 2 or worse: run air filtration continuously and exhaust or scrub before demolition.');
  if (category === 3 || containment) notes.push('Establish containment under negative pressure and set the scrubber to exhaust outside the containment.');
  if (ceilingSqft > 0) notes.push('Ceilings are affected — verify insulation is removed or drying is confirmed above the ceiling plane.');

  return {
    class: cls,
    category: clampCategory(category),
    cubicFeet,
    affectedFloorSqft: affectedFloor,
    wetWallLf,
    insideCorners: corners,
    affectedCeilingSqft: ceilingSqft,
    airMovers,
    perRoom,
    dehumidifiers,
    airScrubbers,
    coefficientsUsed: { airMover: amCo },
    notes,
  };
}

/**
 * Compare what is actually on the floor against the recommendation.
 *
 * This is the check that matters on day two: the recommendation is only advice
 * until someone sets the equipment, and a carrier will ask why the chamber ran
 * short — or why it ran heavy.
 *
 * @param {object} recommendation  output of recommendEquipment()
 * @param {Array}  placed          equipment log entries currently on site
 */
export function auditPlacement(recommendation, placed = []) {
  const active = placed.filter((e) => !e.removedAt);
  const count = (type) => active.filter((e) => e.type === type).reduce((n, e) => n + (e.count || 1), 0);

  const airMovers = count('air_mover');
  const scrubbers = count('air_scrubber');
  const dehus = active.filter((e) => e.type === 'dehumidifier');
  const dehuUnits = dehus.reduce((n, e) => n + (e.count || 1), 0);
  const dehuPpd = dehus.reduce((n, e) => n + (e.capacityPpd || DEHU_TYPES[e.subtype]?.defaultCapacityPpd || 0) * (e.count || 1), 0);

  const issues = [];
  const rec = recommendation;

  if (airMovers > 0 && dehuUnits === 0) {
    issues.push({ level: 'bad', text: 'Air movers are running with no dehumidification on site. That drives moisture into unaffected parts of the structure — set dehumidification now.' });
  }
  if (rec.airMovers > airMovers) {
    issues.push({ level: 'warn', text: `${rec.airMovers - airMovers} air mover(s) short of the recommendation (${airMovers} set, ${rec.airMovers} recommended).` });
  } else if (airMovers > rec.airMovers * 1.5 && airMovers - rec.airMovers > 2) {
    issues.push({ level: 'info', text: `${airMovers} air movers set against a recommendation of ${rec.airMovers}. Document the reason — over-set chambers get challenged on review.` });
  }
  if (rec.dehumidifiers.type !== 'desiccant' && dehuUnits > 0 && dehuPpd < rec.dehumidifiers.requiredPpd) {
    issues.push({ level: 'warn', text: `Dehumidification is ${rec.dehumidifiers.requiredPpd - dehuPpd} AHAM pints short (${dehuPpd} on site, ${rec.dehumidifiers.requiredPpd} required).` });
  }
  if (rec.airScrubbers.units > scrubbers) {
    issues.push({ level: 'warn', text: `Category ${rec.category} loss: ${rec.airScrubbers.units} air scrubber(s) indicated, ${scrubbers} on site.` });
  }
  if (!issues.length && airMovers > 0) {
    issues.push({ level: 'good', text: 'Equipment on site matches the recommendation.' });
  }
  return { placed: { airMovers, dehuUnits, dehuPpd, scrubbers }, issues };
}

/** Estimated electrical load, so the tech knows how many circuits to find. */
export function powerLoad({ airMovers = 0, dehuUnits = 0, dehuType = 'lgr', airScrubbers = 0, ampsPerCircuit = 15 }) {
  const amps = {
    airMover: 2.5,
    conventional: 5.5,
    lgr: 8.5,
    desiccant: 12,
    scrubber: 3,
  };
  const total = airMovers * amps.airMover + dehuUnits * (amps[dehuType] ?? amps.lgr) + airScrubbers * amps.scrubber;
  // Continuous loads get 80% of the breaker rating.
  const usable = ampsPerCircuit * 0.8;
  return {
    totalAmps: total,
    circuits: Math.ceil(total / usable),
    usableAmpsPerCircuit: usable,
    note: `Sized at 80% of a ${ampsPerCircuit} A circuit for continuous load. Verify the panel before plugging in.`,
  };
}

/* ------------------------------------------------------------------ */
/* Moisture targets                                                    */
/* ------------------------------------------------------------------ */

/**
 * Typical dry standards. The real dry standard is a reading taken from an
 * unaffected area of the same material on the same job — these are the
 * fallbacks used until that reading exists.
 */
export const MATERIAL_DEFAULTS = [
  { id: 'drywall', label: 'Drywall / gypsum board', meter: 'noninvasive', dryStandard: 0.7, unit: '%MC', tolerance: 0.3 },
  { id: 'framing_pine', label: 'Framing lumber (softwood)', meter: 'pin', dryStandard: 12, unit: '%MC', tolerance: 4 },
  { id: 'hardwood', label: 'Hardwood flooring', meter: 'pin', dryStandard: 9, unit: '%MC', tolerance: 3 },
  { id: 'subfloor_osb', label: 'OSB / plywood subfloor', meter: 'pin', dryStandard: 12, unit: '%MC', tolerance: 4 },
  { id: 'concrete', label: 'Concrete slab', meter: 'noninvasive', dryStandard: 3.5, unit: 'rel', tolerance: 1 },
  { id: 'plaster', label: 'Plaster', meter: 'noninvasive', dryStandard: 1, unit: '%MC', tolerance: 0.5 },
  { id: 'carpet_pad', label: 'Carpet & pad', meter: 'noninvasive', dryStandard: 5, unit: 'rel', tolerance: 2 },
  { id: 'insulation', label: 'Insulation', meter: 'noninvasive', dryStandard: 2, unit: 'rel', tolerance: 1 },
  { id: 'trim', label: 'Baseboard / trim', meter: 'pin', dryStandard: 11, unit: '%MC', tolerance: 3 },
];

/**
 * Is a monitoring point dry? Prefers the job's own unaffected reading over the
 * table default, which is how the standard wants it done.
 */
export function evaluateDryness(point, { dryStandardOverride } = {}) {
  const mat = MATERIAL_DEFAULTS.find((m) => m.id === point.material);
  const standard = dryStandardOverride ?? point.dryStandard ?? mat?.dryStandard;
  const tolerance = mat?.tolerance ?? 2;
  const reading = point.reading;
  if (standard == null || reading == null || !isFinite(reading)) {
    return { status: 'unknown', standard, goal: null };
  }
  const goal = standard + tolerance;
  if (reading <= standard) return { status: 'dry', standard, goal, margin: standard - reading };
  if (reading <= goal) return { status: 'near', standard, goal, margin: goal - reading };
  return { status: 'wet', standard, goal, margin: reading - goal };
}

/** Drying progress across readings for one point, oldest first. */
export function dryingTrend(readings) {
  const series = readings.filter((r) => isFinite(r.reading)).sort((a, b) => new Date(a.at) - new Date(b.at));
  if (series.length < 2) return { direction: 'insufficient', perDay: 0, series };
  const first = series[0], last = series[series.length - 1];
  const days = Math.max((new Date(last.at) - new Date(first.at)) / 86400000, 1 / 24);
  const perDay = (first.reading - last.reading) / days;
  let direction;
  if (perDay > 0.5) direction = 'drying';
  else if (perDay > 0.05) direction = 'slow';
  else if (perDay > -0.05) direction = 'stalled';
  else direction = 'rewetting';
  return { direction, perDay, days, first, last, series };
}

/* ------------------------------------------------------------------ */

function clampClass(c) { return Math.min(4, Math.max(1, Math.round(c || 1))); }
function clampCategory(c) { return Math.min(3, Math.max(1, Math.round(c || 1))); }

function mergeCoefficients(overrides) {
  if (!overrides || overrides === DEFAULT_COEFFICIENTS) return DEFAULT_COEFFICIENTS;
  return {
    airMover: { ...DEFAULT_COEFFICIENTS.airMover, ...(overrides.airMover || {}) },
    dehuFactor: {
      conventional: { ...DEFAULT_COEFFICIENTS.dehuFactor.conventional, ...(overrides.dehuFactor?.conventional || {}) },
      lgr: { ...DEFAULT_COEFFICIENTS.dehuFactor.lgr, ...(overrides.dehuFactor?.lgr || {}) },
    },
    desiccantAch: { ...DEFAULT_COEFFICIENTS.desiccantAch, ...(overrides.desiccantAch || {}) },
    scrubberAch: { ...DEFAULT_COEFFICIENTS.scrubberAch, ...(overrides.scrubberAch || {}) },
  };
}
