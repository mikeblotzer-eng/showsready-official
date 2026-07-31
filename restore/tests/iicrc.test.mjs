import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCategory, detectClass, sizeDehumidification, dehuUnitCount, sizeAirMovers,
  sizeAirScrubbers, recommendEquipment, dryingGoal, pointStatus, DEHU_FACTORS,
  WATER_SOURCES, MATERIALS, POROUS_MATERIALS, LOW_EVAP_MATERIALS,
} from '../js/iicrc.js';

/* ── Category ─────────────────────────────────────────────────────────────── */

test('category follows the source', () => {
  assert.equal(detectCategory({ sourceId: 'supply', hoursElapsed: 2 }).category, 1);
  assert.equal(detectCategory({ sourceId: 'dishwasher', hoursElapsed: 2 }).category, 2);
  assert.equal(detectCategory({ sourceId: 'sewage', hoursElapsed: 2 }).category, 3);
});

test('every listed source maps to a valid category', () => {
  for (const s of WATER_SOURCES) {
    assert.ok([1, 2, 3].includes(s.cat), `${s.id} has an invalid category`);
  }
});

test('clean water degrades to Category 2 after the time window', () => {
  const fresh = detectCategory({ sourceId: 'supply', hoursElapsed: 10, tempF: 70 });
  assert.equal(fresh.category, 1);
  assert.equal(fresh.degraded, false);

  const stale = detectCategory({ sourceId: 'supply', hoursElapsed: 60, tempF: 70 });
  assert.equal(stale.category, 2);
  assert.equal(stale.degraded, true);
  assert.ok(stale.reasons.some((r) => /degraded/i.test(r)));
});

test('warm conditions shorten the degradation window', () => {
  const warm = detectCategory({ sourceId: 'supply', hoursElapsed: 30, tempF: 85 });
  assert.equal(warm.category, 2, 'at 85°F the 24 hr window has passed');
  const cool = detectCategory({ sourceId: 'supply', hoursElapsed: 30, tempF: 62 });
  assert.equal(cool.category, 1, 'at 62°F the window is 72 hrs');
});

test('prolonged Category 2 degrades to Category 3', () => {
  const r = detectCategory({ sourceId: 'dishwasher', hoursElapsed: 200, tempF: 70 });
  assert.equal(r.category, 3);
});

test('visible growth forces Category 3 regardless of source', () => {
  const r = detectCategory({ sourceId: 'supply', hoursElapsed: 1, visibleGrowth: true });
  assert.equal(r.category, 3);
  assert.ok(r.reasons.some((x) => /growth/i.test(x)));
});

test('contact with contaminated materials escalates Category 1', () => {
  assert.equal(detectCategory({ sourceId: 'supply', hoursElapsed: 1, contactedContaminated: true }).category, 2);
});

test('category never decreases below the source baseline', () => {
  const r = detectCategory({ sourceId: 'sewage', hoursElapsed: 0, tempF: 40 });
  assert.equal(r.category, 3);
});

test('countdown to the next category is reported', () => {
  const r = detectCategory({ sourceId: 'supply', hoursElapsed: 12, tempF: 70 });
  assert.equal(Math.round(r.hoursToNextCategory), 36);
});

/* ── Class ────────────────────────────────────────────────────────────────── */

test('class thresholds follow the wet porous share of surface area', () => {
  assert.equal(detectClass({ wetPorousArea: 20, totalSurfaceArea: 1000 }).class, 1, '2% is Class 1');
  assert.equal(detectClass({ wetPorousArea: 200, totalSurfaceArea: 1000 }).class, 2, '20% is Class 2');
  assert.equal(detectClass({ wetPorousArea: 500, totalSurfaceArea: 1000 }).class, 3, '50% is Class 3');
});

test('class boundaries land on the right side', () => {
  assert.equal(detectClass({ wetPorousArea: 49, totalSurfaceArea: 1000 }).class, 1, '4.9% stays Class 1');
  assert.equal(detectClass({ wetPorousArea: 50, totalSurfaceArea: 1000 }).class, 2, '5% becomes Class 2');
  assert.equal(detectClass({ wetPorousArea: 400, totalSurfaceArea: 1000 }).class, 2, '40% stays Class 2');
  assert.equal(detectClass({ wetPorousArea: 401, totalSurfaceArea: 1000 }).class, 3, 'over 40% is Class 3');
});

test('low evaporation materials force Class 4', () => {
  const r = detectClass({ wetPorousArea: 10, totalSurfaceArea: 1000, lowEvaporationMaterials: true });
  assert.equal(r.class, 4);
  assert.ok(r.reasons.some((x) => /specialty/i.test(x)));
});

test('no geometry defaults to Class 1 with an explanation', () => {
  const r = detectClass({ wetPorousArea: 0, totalSurfaceArea: 0 });
  assert.equal(r.class, 1);
  assert.ok(r.reasons.some((x) => /sketch/i.test(x)));
});

/* ── Dehumidification ─────────────────────────────────────────────────────── */

test('LGR sizing divides cubic feet by the class factor', () => {
  const r = sizeDehumidification({ cubicFeet: 10000, waterClass: 2, type: 'lgr' });
  assert.equal(r.requiredPintsPerDay, 10000 / DEHU_FACTORS.lgr[2]);
  assert.equal(r.requiredPintsPerDay, 200);
  assert.match(r.basis, /Class 2/);
});

test('a wetter class calls for more dehumidification', () => {
  const cf = 12000;
  const c1 = sizeDehumidification({ cubicFeet: cf, waterClass: 1, type: 'lgr' }).requiredPintsPerDay;
  const c2 = sizeDehumidification({ cubicFeet: cf, waterClass: 2, type: 'lgr' }).requiredPintsPerDay;
  const c3 = sizeDehumidification({ cubicFeet: cf, waterClass: 3, type: 'lgr' }).requiredPintsPerDay;
  assert.ok(c1 < c2 && c2 < c3);
});

test('conventional refrigerant is rejected for Class 4', () => {
  const r = sizeDehumidification({ cubicFeet: 8000, waterClass: 4, type: 'conventional' });
  assert.equal(r.requiredPintsPerDay, null);
  assert.equal(r.warning, true);
  assert.match(r.basis, /LGR or desiccant/i);
});

test('desiccant sizing uses air changes per hour', () => {
  const r = sizeDehumidification({ cubicFeet: 6000, waterClass: 3, type: 'desiccant' });
  assert.equal(r.airChangesPerHour, 3);
  assert.equal(r.requiredCfm, (6000 * 3) / 60);
  assert.equal(r.requiredCfm, 300);
});

test('unit count rounds up and never goes below one', () => {
  assert.equal(dehuUnitCount(200, 130), 2);
  assert.equal(dehuUnitCount(260, 130), 2);
  assert.equal(dehuUnitCount(261, 130), 3);
  assert.equal(dehuUnitCount(10, 130), 1);
  assert.equal(dehuUnitCount(200, 0), null);
});

/* ── Air movers ───────────────────────────────────────────────────────────── */

test('every affected room gets at least one air mover', () => {
  const r = sizeAirMovers({ rooms: [{ id: 'a', name: 'A', wetFloorArea: 0, wetWallLinearFeet: 0 }], waterClass: 1 });
  assert.equal(r.min, 1);
  assert.equal(r.max, 1);
});

test('air movers scale with wet floor area', () => {
  const small = sizeAirMovers({ rooms: [{ id: 'a', name: 'A', wetFloorArea: 100 }], waterClass: 2 });
  const big = sizeAirMovers({ rooms: [{ id: 'a', name: 'A', wetFloorArea: 600 }], waterClass: 2 });
  assert.ok(big.max > small.max);
  // 600 sf ÷ 50 = 12, plus one for the room.
  assert.equal(big.max, 13);
});

test('Class 2 and up add coverage for wet wall length', () => {
  const room = { id: 'a', name: 'A', wetFloorArea: 200, wetWallLinearFeet: 56 };
  const c2 = sizeAirMovers({ rooms: [room], waterClass: 2 });
  // 1 room + ceil(200/50)=4 floor + ceil(56/14)=4 wall
  assert.equal(c2.max, 9);
});

test('Class 1 takes floor or wall coverage, whichever is greater', () => {
  const r = sizeAirMovers({ rooms: [{ id: 'a', name: 'A', wetFloorArea: 60, wetWallLinearFeet: 140 }], waterClass: 1 });
  // Wall path: 1 + ceil(140/14) = 11 beats the floor path.
  assert.equal(r.max, 11);
});

test('inside corners and obstructions each add a unit', () => {
  const base = sizeAirMovers({ rooms: [{ id: 'a', name: 'A', wetFloorArea: 100 }], waterClass: 2 });
  const withExtras = sizeAirMovers({ rooms: [{ id: 'a', name: 'A', wetFloorArea: 100, insideCorners: 4, obstructions: 1 }], waterClass: 2 });
  assert.equal(withExtras.max - base.max, 5);
});

test('multiple rooms sum and report per-room detail', () => {
  const r = sizeAirMovers({
    rooms: [
      { id: 'a', name: 'Kitchen', wetFloorArea: 120 },
      { id: 'b', name: 'Hall', wetFloorArea: 60 },
    ],
    waterClass: 2,
  });
  assert.equal(r.perRoom.length, 2);
  assert.equal(r.max, r.perRoom.reduce((s, x) => s + x.max, 0));
  assert.ok(r.perRoom[0].basis.includes('per affected room'));
});

/* ── Air filtration ───────────────────────────────────────────────────────── */

test('air scrubbers are driven by category, not class', () => {
  assert.equal(sizeAirScrubbers({ cubicFeet: 9000, category: 1 }).required, 0);
  assert.equal(sizeAirScrubbers({ cubicFeet: 9000, category: 2 }).ach, 4);
  assert.equal(sizeAirScrubbers({ cubicFeet: 9000, category: 3 }).ach, 6);
});

test('Category 3 calls for negative air', () => {
  const r = sizeAirScrubbers({ cubicFeet: 9000, category: 3, unitCfm: 500 });
  assert.equal(r.negativeAir, true);
  // 9000 × 6 ÷ 60 = 900 CFM → 2 units at 500 CFM.
  assert.equal(r.requiredCfm, 900);
  assert.equal(r.required, 2);
});

test('Category 1 with containment still gets filtration', () => {
  const r = sizeAirScrubbers({ cubicFeet: 6000, category: 1, containment: true });
  assert.equal(r.ach, 4);
  assert.ok(r.required >= 1);
});

/* ── Whole-job recommendation ─────────────────────────────────────────────── */

test('recommendEquipment aggregates volume and warns appropriately', () => {
  const r = recommendEquipment({
    rooms: [
      { id: 'a', name: 'A', wetFloorArea: 200, wetWallLinearFeet: 40, volume: 1600 },
      { id: 'b', name: 'B', wetFloorArea: 100, wetWallLinearFeet: 30, volume: 800 },
    ],
    waterClass: 3,
    category: 3,
    dehuType: 'lgr',
    dehuUnitPints: 130,
  });
  assert.equal(r.cubicFeet, 2400);
  assert.ok(r.airMovers.max > 0);
  assert.equal(r.dehumidification.requiredPintsPerDay, 2400 / DEHU_FACTORS.lgr[3]);
  assert.equal(r.dehumidification.unitCount, 1);
  assert.ok(r.warnings.some((w) => /Category 3/.test(w)));
});

test('Class 4 produces a specialty drying warning', () => {
  const r = recommendEquipment({ rooms: [{ id: 'a', name: 'A', wetFloorArea: 100, volume: 900 }], waterClass: 4, category: 1 });
  assert.ok(r.warnings.some((w) => /specialty drying/i.test(w)));
});

/* ── Drying goals ─────────────────────────────────────────────────────────── */

test('a measured unaffected reference beats the published value', () => {
  const g = dryingGoal({ materialId: 'framing_pine', dryStandard: 11 });
  assert.equal(g.source, 'measured');
  assert.equal(g.goal, 13, 'wood gets a 2 point tolerance');
});

test('without a reference the published dry standard is used and flagged', () => {
  const g = dryingGoal({ materialId: 'framing_pine' });
  assert.equal(g.source, 'published');
  assert.equal(g.goal, 16);
  assert.match(g.basis, /defensible/i);
});

test('every material has a coherent definition', () => {
  for (const m of MATERIALS) {
    assert.ok(m.id && m.label && m.unit, `${m.id} is incomplete`);
    assert.ok(Number.isFinite(m.dryMax), `${m.id} has no dry standard`);
  }
  assert.ok(POROUS_MATERIALS.has('drywall'));
  assert.ok(!POROUS_MATERIALS.has('tile'));
  assert.ok(LOW_EVAP_MATERIALS.has('concrete'));
  assert.ok(LOW_EVAP_MATERIALS.has('hardwood'));
});

/* ── Point status ─────────────────────────────────────────────────────────── */

const pt = (dryStandard, materialId = 'framing_pine') => ({ materialId, dryStandard });

test('a point with no readings reports no-data', () => {
  assert.equal(pointStatus(pt(11), []).state, 'no-data');
});

test('a point at or below goal is dry', () => {
  const s = pointStatus(pt(11), [{ date: '2026-01-01', value: 12 }]);
  assert.equal(s.state, 'dry', '12 is within the 13 goal');
});

test('a falling point is drying and a rising point is wetting', () => {
  const drying = pointStatus(pt(11), [
    { date: '2026-01-01', value: 28 },
    { date: '2026-01-02', value: 22 },
  ]);
  assert.equal(drying.state, 'drying');
  assert.equal(drying.trend, 'drying');

  const wetting = pointStatus(pt(11), [
    { date: '2026-01-01', value: 20 },
    { date: '2026-01-02', value: 26 },
  ]);
  assert.equal(wetting.state, 'wetting');
});

test('an unchanged wet point stalls', () => {
  const s = pointStatus(pt(11), [
    { date: '2026-01-01', value: 24 },
    { date: '2026-01-02', value: 24 },
    { date: '2026-01-03', value: 24.2 },
  ]);
  assert.equal(s.state, 'stalled');
  assert.equal(s.readingCount, 3);
});

test('readings are ordered by date regardless of insertion order', () => {
  const s = pointStatus(pt(11), [
    { date: '2026-01-03', value: 14 },
    { date: '2026-01-01', value: 30 },
    { date: '2026-01-02', value: 22 },
  ]);
  assert.equal(s.value, 14, 'latest reading by date wins');
  assert.equal(s.first, 30);
  assert.equal(s.trend, 'drying');
});
