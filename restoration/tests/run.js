/**
 * Unit tests for the domain math. Run with `node tests/run.js` from the
 * restoration/ directory. These modules are pure and browser-agnostic on
 * purpose so the numbers a tech relies on can be checked outside a browser.
 */
import assert from 'node:assert/strict';
import * as psy from '../js/psychro.js';
import * as iicrc from '../js/iicrc.js';
import * as u from '../js/util.js';
import { buildEstimate, LINE_ITEM_CATALOG, equipmentDays, buildLedger } from '../js/estimate.js';
import { setEdgeLength, rectanglePoints, recalcRoom, latestReading } from '../js/sketch.js';

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { failed++; failures.push({ name, err }); }
}
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `${msg || ''} expected ${expected} ±${tol}, got ${actual}`);

/* ----------------------------- psychrometrics ---------------------------- */

test('saturation vapour pressure matches ASHRAE at 70F', () => {
  // ASHRAE: 0.3632 psia at 70 °F => 2.504 kPa
  near(psy.satVaporPressure(psy.F_to_C(70)), 2.504, 0.01);
});

test('GPP at 70F/50%RH is ~54.5 grains', () => {
  near(psy.gpp(70, 50), 54.5, 0.5);
});

test('GPP at 80F/60%RH is ~92.6 grains', () => {
  near(psy.gpp(80, 60), 92.6, 1.5);
});

test('GPP is zero at 0% RH and rises with RH', () => {
  assert.equal(psy.gpp(70, 0), 0);
  assert.ok(psy.gpp(70, 80) > psy.gpp(70, 40));
});

test('dew point at 70F/50%RH is ~50.5F', () => {
  near(psy.dewPointF(70, 50), 50.5, 0.6);
});

test('dew point equals dry bulb at saturation', () => {
  near(psy.dewPointF(72, 100), 72, 0.2);
});

test('rhFromGpp inverts gpp', () => {
  for (const [t, rh] of [[70, 50], [85, 30], [55, 90], [100, 15]]) {
    near(psy.rhFromGpp(t, psy.gpp(t, rh)), rh, 0.2, `${t}F/${rh}%`);
  }
});

test('elevation raises GPP for the same temp and RH', () => {
  const sea = psy.gpp(70, 50, 0);
  const denver = psy.gpp(70, 50, 5280);
  assert.ok(denver > sea, 'thinner air holds more grains per pound of dry air');
  near(denver / sea, 1.21, 0.05);
});

test('enthalpy at 70F/50%RH is ~25.3 BTU/lb', () => {
  near(psy.enthalpy(70, 50), 25.3, 0.4);
});

test('specific volume at 70F/50%RH is ~13.5 ft3/lb', () => {
  near(psy.specificVolume(70, 50), 13.5, 0.15);
});

test('RH is clamped to a sane range', () => {
  assert.equal(psy.gpp(70, -20), 0);
  near(psy.gpp(70, 150), psy.gpp(70, 100), 0.001);
});

test('dehu performance grades grain depression', () => {
  const good = psy.dehuPerformance(80, 60, 95, 25);
  assert.ok(good.depression > 30);
  assert.equal(good.verdict, 'good');
  assert.ok(good.tempRise > 0, 'refrigerant dehus exhaust warmer air');

  const dead = psy.dehuPerformance(80, 60, 81, 58);
  assert.equal(dead.verdict, 'check');
});

test('environment evaluation flags a cold chamber and a losing dehu', () => {
  const r = psy.evaluateEnvironment({
    insideTempF: 62, insideRh: 70,
    unaffectedTempF: 70, unaffectedRh: 35,
  });
  const text = r.flags.map((f) => f.text).join(' ');
  assert.match(text, /below 70/);
  assert.ok(r.flags.some((f) => f.level === 'bad' || f.level === 'warn'));
});

test('environment evaluation passes a healthy chamber', () => {
  // Chamber warm and well below the unaffected reference in grains.
  const r = psy.evaluateEnvironment({
    insideTempF: 85, insideRh: 25,
    unaffectedTempF: 72, unaffectedRh: 50,
  });
  assert.equal(r.flags.length, 1, r.flags.map((f) => f.text).join(' | '));
  assert.equal(r.flags[0].level, 'good');
});

test('a chamber barely drier than ambient is flagged, not passed', () => {
  const r = psy.evaluateEnvironment({
    insideTempF: 82, insideRh: 35,
    unaffectedTempF: 72, unaffectedRh: 50,
  });
  assert.ok(r.flags.some((f) => /add or resize dehumidification/i.test(f.text)));
});

/* -------------------------------- category ------------------------------- */

test('clean supply line stays Category 1 when addressed quickly', () => {
  const r = iicrc.determineCategory({ sourceId: 'supply_line', hoursSinceLoss: 6, ambientTempF: 70 });
  assert.equal(r.category, 1);
});

test('Category 1 degrades to 2 after 72 hours', () => {
  const r = iicrc.determineCategory({ sourceId: 'supply_line', hoursSinceLoss: 80, ambientTempF: 70 });
  assert.equal(r.category, 2);
  assert.match(r.reasons.join(' '), /escalated to Category 2/);
});

test('warm standing water degrades faster', () => {
  assert.equal(iicrc.determineCategory({ sourceId: 'supply_line', hoursSinceLoss: 50, ambientTempF: 85 }).category, 2);
  assert.equal(iicrc.determineCategory({ sourceId: 'supply_line', hoursSinceLoss: 50, ambientTempF: 68 }).category, 1);
});

test('sewage is Category 3 immediately', () => {
  assert.equal(iicrc.determineCategory({ sourceId: 'sewage', hoursSinceLoss: 1 }).category, 3);
});

test('visible microbial growth forces Category 3', () => {
  const r = iicrc.determineCategory({ sourceId: 'supply_line', hoursSinceLoss: 2, visibleMicrobialGrowth: true });
  assert.equal(r.category, 3);
});

test('technician override is honoured and recorded', () => {
  const r = iicrc.determineCategory({ sourceId: 'supply_line', hoursSinceLoss: 1, override: 2 });
  assert.equal(r.category, 2);
  assert.equal(r.computed, 1);
  assert.ok(r.overridden);
});

/* --------------------------------- class --------------------------------- */

const room = (over = {}) => ({
  id: 'r1', name: 'Room', floorAreaSqft: 200, perimeterFt: 60, ceilingHeightFt: 8,
  affectedFloorSqft: 0, affectedWallLf: 0, wetWallHeightFt: 2, ceilingAffected: false,
  lowEvaporationMaterials: [], insideCorners: 0, ...over,
});

test('a small wet spot is Class 1', () => {
  // 200 sf floor + 480 sf wall + 200 sf ceiling = 880 sf total; 20 sf wet = 2.3%
  const r = iicrc.determineClass([room({ affectedFloorSqft: 20 })]);
  assert.equal(r.class, 1);
});

test('a fully wet floor is Class 2', () => {
  const r = iicrc.determineClass([room({ affectedFloorSqft: 200, affectedWallLf: 60, wetWallHeightFt: 2 })]);
  assert.equal(r.class, 2);
  assert.ok(r.wettedFraction > 0.05 && r.wettedFraction <= 0.4);
});

test('water from overhead soaking walls and ceiling is Class 3', () => {
  const r = iicrc.determineClass([room({
    affectedFloorSqft: 200, affectedWallLf: 60, wetWallHeightFt: 8,
    ceilingAffected: true, affectedCeilingSqft: 200,
  })]);
  assert.equal(r.class, 3);
});

test('hardwood makes it a Class 4 specialty dry regardless of area', () => {
  const r = iicrc.determineClass([room({ affectedFloorSqft: 20, lowEvaporationMaterials: ['hardwood'] })]);
  assert.equal(r.class, 4);
  assert.match(r.reasons.join(' '), /Class 4 specialty dry/);
});

test('class is computed across every room in the chamber', () => {
  const r = iicrc.determineClass([
    room({ id: 'a', affectedFloorSqft: 200, affectedWallLf: 60, wetWallHeightFt: 4 }),
    room({ id: 'b', affectedFloorSqft: 0 }),
  ]);
  assert.equal(r.computed, 2);
  assert.ok(r.totalSurfaceSqft > 1700);
});

/* ------------------------------- equipment ------------------------------- */

test('air movers cover floor, wet wall and inside corners', () => {
  const rec = iicrc.recommendEquipment({
    rooms: [room({ affectedFloorSqft: 200, affectedWallLf: 32, insideCorners: 1 })],
    waterClass: 2,
  });
  // Class 2: 200/50 = 4 from floor, 32/16 = 2 from wall, +1 corner
  assert.equal(rec.airMovers, 7);
  assert.equal(rec.perRoom[0].breakdown.fromFloor, 4);
  assert.equal(rec.perRoom[0].breakdown.fromWall, 2);
});

test('every affected room gets at least one air mover', () => {
  const rec = iicrc.recommendEquipment({ rooms: [room({ affectedFloorSqft: 6 })], waterClass: 1 });
  assert.equal(rec.airMovers, 1);
});

test('dry rooms in the chamber get no air movers', () => {
  const rec = iicrc.recommendEquipment({ rooms: [room({ affectedFloorSqft: 0, affectedWallLf: 0 })], waterClass: 2 });
  assert.equal(rec.airMovers, 0);
});

test('a Class 3 loss needs more air movers than the same Class 1 area', () => {
  const rooms = [room({ affectedFloorSqft: 240 })];
  const c1 = iicrc.recommendEquipment({ rooms, waterClass: 1 }).airMovers;
  const c3 = iicrc.recommendEquipment({ rooms, waterClass: 3 }).airMovers;
  assert.ok(c3 > c1, `${c3} should exceed ${c1}`);
});

test('LGR dehu sizing follows cubic feet over the class factor', () => {
  const rec = iicrc.recommendEquipment({
    rooms: [room({ floorAreaSqft: 500, ceilingHeightFt: 8, affectedFloorSqft: 500 })],
    waterClass: 2, dehuType: 'lgr', dehuCapacityPpd: 110,
  });
  // 4000 ft3 / 50 = 80 AHAM pints => one 110-pint unit
  assert.equal(rec.cubicFeet, 4000);
  assert.equal(rec.dehumidifiers.requiredPpd, 80);
  assert.equal(rec.dehumidifiers.units, 1);
});

test('a Class 3 loss needs more dehumidification than Class 2', () => {
  const rooms = [room({ floorAreaSqft: 800, affectedFloorSqft: 800 })];
  const c2 = iicrc.recommendEquipment({ rooms, waterClass: 2, dehuType: 'lgr' }).dehumidifiers.requiredPpd;
  const c3 = iicrc.recommendEquipment({ rooms, waterClass: 3, dehuType: 'lgr' }).dehumidifiers.requiredPpd;
  assert.ok(c3 > c2);
});

test('desiccant sizing is by process air changes', () => {
  const rec = iicrc.recommendEquipment({
    rooms: [room({ floorAreaSqft: 1500, ceilingHeightFt: 8, affectedFloorSqft: 1500 })],
    waterClass: 3, dehuType: 'desiccant', desiccantCfm: 1200,
  });
  // 12000 ft3 * 3 ACH / 60 = 600 CFM
  assert.equal(rec.dehumidifiers.requiredProcessCfm, 600);
  assert.equal(rec.dehumidifiers.units, 1);
});

test('air scrubbers appear for Category 2 and above only', () => {
  const rooms = [room({ affectedFloorSqft: 200 })];
  assert.equal(iicrc.recommendEquipment({ rooms, category: 1 }).airScrubbers.units, 0);
  assert.ok(iicrc.recommendEquipment({ rooms, category: 3 }).airScrubbers.units > 0);
});

test('placement audit catches air movers running with no dehumidification', () => {
  const rec = iicrc.recommendEquipment({ rooms: [room({ affectedFloorSqft: 200 })], waterClass: 2 });
  const audit = iicrc.auditPlacement(rec, [{ type: 'air_mover', count: 4 }]);
  assert.ok(audit.issues.some((i) => i.level === 'bad' && /no dehumidification/i.test(i.text)));
});

test('placement audit reports an equipment shortfall', () => {
  const rec = iicrc.recommendEquipment({ rooms: [room({ affectedFloorSqft: 200 })], waterClass: 2 });
  const audit = iicrc.auditPlacement(rec, [
    { type: 'air_mover', count: 2 },
    { type: 'dehumidifier', subtype: 'lgr', count: 1 },
  ]);
  assert.equal(audit.placed.airMovers, 2);
  assert.ok(audit.issues.some((i) => /air mover\(s\) short/.test(i.text)));
});

test('placement audit passes a correctly set chamber', () => {
  const rec = iicrc.recommendEquipment({ rooms: [room({ affectedFloorSqft: 200 })], waterClass: 2, dehuType: 'lgr' });
  const audit = iicrc.auditPlacement(rec, [
    { type: 'air_mover', count: rec.airMovers },
    { type: 'dehumidifier', subtype: 'lgr', count: 2, capacityPpd: 110 },
  ]);
  assert.deepEqual(audit.issues.map((i) => i.level), ['good'], audit.issues.map((i) => i.text).join(' | '));
});

test('placement audit ignores equipment already picked up', () => {
  const rec = iicrc.recommendEquipment({ rooms: [room({ affectedFloorSqft: 200 })], waterClass: 2 });
  const audit = iicrc.auditPlacement(rec, [{ type: 'air_mover', count: 9, removedAt: '2026-01-04T08:00:00Z' }]);
  assert.equal(audit.placed.airMovers, 0);
});

test('placement audit flags a missing scrubber on a Category 3 loss', () => {
  const rec = iicrc.recommendEquipment({ rooms: [room({ affectedFloorSqft: 200 })], waterClass: 2, category: 3 });
  const audit = iicrc.auditPlacement(rec, [
    { type: 'air_mover', count: rec.airMovers },
    { type: 'dehumidifier', subtype: 'lgr', count: 2, capacityPpd: 110 },
  ]);
  assert.ok(audit.issues.some((i) => /air scrubber\(s\) indicated/.test(i.text)));
});

test('custom coefficients override the defaults', () => {
  const rooms = [room({ affectedFloorSqft: 200 })];
  const rec = iicrc.recommendEquipment({
    rooms, waterClass: 2,
    coefficients: { airMover: { 2: { sqftPerAirMover: 100, lfWallPerAirMover: 16 } } },
  });
  assert.equal(rec.airMovers, 2); // 200/100
});

test('power load sizes circuits at 80 percent', () => {
  const p = iicrc.powerLoad({ airMovers: 6, dehuUnits: 1, dehuType: 'lgr', ampsPerCircuit: 15 });
  near(p.totalAmps, 23.5, 0.01);
  assert.equal(p.circuits, 2);
});

/* ----------------------------- dryness targets --------------------------- */

test('dryness compares against the dry standard plus tolerance', () => {
  assert.equal(iicrc.evaluateDryness({ material: 'framing_pine', reading: 11 }).status, 'dry');
  assert.equal(iicrc.evaluateDryness({ material: 'framing_pine', reading: 14 }).status, 'near');
  assert.equal(iicrc.evaluateDryness({ material: 'framing_pine', reading: 24 }).status, 'wet');
});

test('a job-specific unaffected reading beats the table default', () => {
  const r = iicrc.evaluateDryness({ material: 'framing_pine', reading: 9, dryStandard: 7 });
  assert.equal(r.status, 'near'); // 7 + 4 tolerance
  assert.equal(r.standard, 7);
});

test('missing readings report unknown rather than guessing', () => {
  assert.equal(iicrc.evaluateDryness({ material: 'framing_pine', reading: null }).status, 'unknown');
});

test('drying trend detects progress, stall and rewetting', () => {
  const mk = (vals) => vals.map((v, i) => ({ at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), reading: v }));
  assert.equal(iicrc.dryingTrend(mk([30, 24, 18])).direction, 'drying');
  assert.equal(iicrc.dryingTrend(mk([18, 18, 18])).direction, 'stalled');
  assert.equal(iicrc.dryingTrend(mk([18, 20, 24])).direction, 'rewetting');
  assert.equal(iicrc.dryingTrend(mk([18])).direction, 'insufficient');
});

/* --------------------------------- util ---------------------------------- */

test('parseFeet reads the formats techs actually type', () => {
  near(u.parseFeet("12'6\""), 12.5, 0.001);
  near(u.parseFeet('12\'6'), 12.5, 0.001);
  near(u.parseFeet('12-6'), 12.5, 0.001);
  near(u.parseFeet('12.5'), 12.5, 0.001);
  near(u.parseFeet('12'), 12, 0.001);
  near(u.parseFeet('150"'), 12.5, 0.001);
  near(u.parseFeet('6"'), 0.5, 0.001);
  near(u.parseFeet("12'6 1/2\""), 12.5417, 0.001);
  near(u.parseFeet('8 ft'), 8, 0.001);
  assert.equal(u.parseFeet('banana'), null);
  assert.equal(u.parseFeet(''), null);
});

test('formatFeet renders feet and inches', () => {
  assert.equal(u.formatFeet(12.5), `12' 6"`);
  assert.equal(u.formatFeet(12), `12'`);
  assert.equal(u.formatFeet(0.5), `0' 6"`);
});

test('formatFeet output feeds back into parseFeet', () => {
  // The wall-length sheet prefills with formatFeet and reparses what comes back.
  for (const v of [12.5, 12, 0.5, 8.25, 33.75]) {
    near(u.parseFeet(u.formatFeet(v)), v, 0.05, `round trip ${v}`);
  }
});

test('polygon area and perimeter of a 12x20 room', () => {
  const pts = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 12 }, { x: 0, y: 12 }];
  assert.equal(u.polygonArea(pts), 240);
  assert.equal(u.polygonPerimeter(pts), 64);
});

test('inside corners are counted on an L-shaped room', () => {
  const l = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 },
    { x: 10, y: 10 }, { x: 10, y: 16 }, { x: 0, y: 16 },
  ];
  assert.equal(u.countInsideCorners(l), 1);
  assert.equal(u.countInsideCorners([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), 0);
});

test('point in polygon', () => {
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.ok(u.pointInPolygon({ x: 5, y: 5 }, sq));
  assert.ok(!u.pointInPolygon({ x: 15, y: 5 }, sq));
});

test('haversine matches a known city pair', () => {
  // Denver to Boulder, ~24 miles
  near(u.haversineMiles({ lat: 39.7392, lng: -104.9903 }, { lat: 40.015, lng: -105.2705 }), 24, 1.5);
});

test('GPS track ignores parked jitter and poor fixes', () => {
  const parked = Array.from({ length: 40 }, (_, i) => ({
    lat: 39.7392 + (i % 2 ? 0.00001 : -0.00001), lng: -104.9903, accuracy: 10,
  }));
  assert.ok(u.trackDistanceMiles(parked) < 0.01, 'parked truck should not accumulate miles');

  const drive = [
    { lat: 39.7392, lng: -104.9903, accuracy: 8 },
    { lat: 39.7592, lng: -104.9903, accuracy: 8 },
    { lat: 39.7792, lng: -104.9903, accuracy: 8 },
  ];
  near(u.trackDistanceMiles(drive), 2.76, 0.15);

  const noisy = [
    { lat: 39.7392, lng: -104.9903, accuracy: 8 },
    { lat: 41.0, lng: -104.9903, accuracy: 900 },
    { lat: 39.7592, lng: -104.9903, accuracy: 8 },
  ];
  near(u.trackDistanceMiles(noisy), 1.38, 0.1, 'a wild fix should be discarded');
});

test('csv escapes quotes and commas', () => {
  assert.equal(u.toCsv([['a', 'b,c'], ['say "hi"', 1]]), 'a,"b,c"\r\n"say ""hi""",1');
});

/* ------------------------------- estimate -------------------------------- */

const estimateJob = {
  id: 'j1',
  rooms: [room({
    id: 'r1', name: 'Basement', floorAreaSqft: 400, perimeterFt: 80, ceilingHeightFt: 8,
    affectedFloorSqft: 400, affectedWallLf: 80, wetWallHeightFt: 2,
    flooring: 'carpet', affectedCeilingSqft: 0,
  })],
  category: 2,
  waterClass: 2,
  equipment: [
    { type: 'air_mover', count: 9, placedAt: '2026-01-01T08:00:00Z', removedAt: '2026-01-04T08:00:00Z' },
    { type: 'dehumidifier', subtype: 'lgr', count: 1, placedAt: '2026-01-01T08:00:00Z', removedAt: '2026-01-04T08:00:00Z' },
  ],
  labor: [{ role: 'tech', hours: 6, rate: 62 }],
  expenses: [
    { kind: 'fuel', amount: 48.2, billable: true },
    { kind: 'supplies', amount: 90, billable: true, markupPct: 20 },
    { kind: 'meals', amount: 22, billable: false },
  ],
};

test('estimate builds water mitigation line items from the sketch', () => {
  const est = buildEstimate(estimateJob);
  const codes = est.lines.map((l) => l.code);
  assert.ok(codes.some((c) => /AIR MOVER|AIRMOVER|AM/i.test(c)) || est.lines.some((l) => /air mover/i.test(l.description)));
  const am = est.lines.find((l) => /air mover/i.test(l.description));
  assert.equal(am.quantity, 27, '9 movers over 3 days = 27 equipment-days');
  const dehu = est.lines.find((l) => /dehumidifier/i.test(l.description));
  assert.equal(dehu.quantity, 3);
});

test('extraction and antimicrobial scale with the affected area', () => {
  const est = buildEstimate(estimateJob);
  const extraction = est.lines.find((l) => /extract/i.test(l.description));
  assert.equal(extraction.quantity, 400);
  const anti = est.lines.find((l) => /antimicrobial/i.test(l.description));
  assert.ok(anti, 'Category 2 loss should include antimicrobial application');
});

test('Category 1 loss omits the antimicrobial line', () => {
  const est = buildEstimate({ ...estimateJob, category: 1 });
  assert.ok(!est.lines.find((l) => /antimicrobial/i.test(l.description)));
});

test('estimate totals labour, equipment and marked-up billable expenses', () => {
  const est = buildEstimate(estimateJob);
  assert.equal(est.totals.labor, 372);
  near(est.totals.billableExpenses, 48.2 + 108, 0.01);
  assert.ok(!JSON.stringify(est.lines).includes('meals'), 'non-billable costs stay out of the estimate');
  near(est.totals.grand, est.totals.lineItems + est.totals.labor + est.totals.billableExpenses, 0.01);
});

test('every catalog item has a code, unit and price', () => {
  for (const item of LINE_ITEM_CATALOG) {
    assert.ok(item.code && item.description && item.unit, `incomplete catalog entry ${item.id}`);
    assert.ok(typeof item.unitPrice === 'number' && item.unitPrice >= 0, `bad price on ${item.id}`);
  }
});

test('estimate CSV round-trips the line items', () => {
  const est = buildEstimate(estimateJob);
  const rows = est.csv.trim().split('\r\n');
  assert.equal(rows.length, est.lines.length + 1, 'header plus one row per line');
  assert.match(rows[0], /Code/);
});

test('equipment days round up and multiply by unit count', () => {
  const e = { count: 4, placedAt: '2026-01-01T08:00:00Z', removedAt: '2026-01-03T09:00:00Z' };
  assert.equal(equipmentDays(e), 12); // 49 h -> 3 days x 4 units
  assert.equal(equipmentDays({ count: 1, placedAt: '2026-01-01T08:00:00Z', removedAt: '2026-01-01T10:00:00Z' }), 1);
  assert.equal(equipmentDays({ count: 2 }), 0, 'equipment never placed bills nothing');
});

test('ledger separates receivable, payable and reimbursable', () => {
  const est = buildEstimate(estimateJob);
  const ledger = buildLedger({ ...estimateJob, payments: [{ id: 'p1', amount: 500 }] }, est);
  assert.equal(ledger.receivable.length, 2);
  near(ledger.outstanding, est.totals.grand - 500, 0.01);
  near(ledger.payableTotal, 48.2 + 90 + 22, 0.01);
  near(ledger.reimbursable, 48.2 + 108, 0.01);
});

/* --------------------------------- sketch -------------------------------- */

test('rectangle helper produces the right area and perimeter', () => {
  const r = recalcRoom({ points: rectanglePoints(12, 20) });
  assert.equal(r.floorAreaSqft, 240);
  assert.equal(r.perimeterFt, 64);
  assert.equal(r.insideCorners, 0);
});

test('retyping a wall length keeps a rectangle square', () => {
  const pts = setEdgeLength(rectanglePoints(20, 12), 0, 24);
  const r = recalcRoom({ points: pts });
  assert.equal(r.floorAreaSqft, 288);      // 24 x 12
  assert.equal(r.perimeterFt, 72);
  // Every corner still square.
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    assert.ok(Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9, `edge ${i} is no longer axis aligned`);
  }
});

test('retyping a wall on an L-shape preserves the other walls', () => {
  const l = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 },
    { x: 10, y: 10 }, { x: 10, y: 16 }, { x: 0, y: 16 },
  ];
  const out = setEdgeLength(l, 1, 14); // the 10 ft vertical run becomes 14
  const len = (i) => Math.hypot(out[(i + 1) % out.length].x - out[i].x, out[(i + 1) % out.length].y - out[i].y);
  near(len(0), 20, 1e-9, 'first wall unchanged');
  near(len(1), 14, 1e-9, 'edited wall');
  near(len(2), 10, 1e-9, 'third wall unchanged');
  near(len(3), 6, 1e-9, 'fourth wall unchanged');
  assert.equal(recalcRoom({ points: out }).insideCorners, 1, 'still an L');
});

test('recalcRoom clamps affected area to the room it belongs to', () => {
  const r = recalcRoom({ points: rectanglePoints(10, 10), affectedFloorSqft: 500 });
  assert.equal(r.affectedFloorSqft, 100);
});

test('latestReading picks the newest entry for the point', () => {
  const readings = [
    { pointId: 'p1', at: '2026-01-01T00:00:00Z', reading: 30 },
    { pointId: 'p1', at: '2026-01-03T00:00:00Z', reading: 18 },
    { pointId: 'p2', at: '2026-01-04T00:00:00Z', reading: 40 },
  ];
  assert.equal(latestReading(readings, 'p1').reading, 18);
  assert.equal(latestReading(readings, 'nope'), null);
});

/* --------------------------------- report -------------------------------- */

console.log(`\n  ${passed} passed, ${failed} failed\n`);
for (const f of failures) {
  console.error(`  ✗ ${f.name}\n    ${f.err.message}\n`);
}
process.exit(failed ? 1 : 0);
