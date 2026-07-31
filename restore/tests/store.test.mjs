/* Exercises the layer that turns sketched geometry into classification and
 * equipment numbers. store.js touches IndexedDB only inside async calls, so
 * the pure derivation functions can be driven directly here. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newJob, newRoom, roomMetrics, jobMetrics, classification, equipmentPlan,
  placedEquipment, equipmentDays, dryingProgress, financials, tripMiles,
  state, EQUIPMENT_TYPES, COST_TYPES, CONTACT_ROLES,
} from '../js/store.js';

const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];

function jobWith(rooms, loss = {}) {
  const job = newJob();
  job.rooms = rooms;
  job.loss = { ...job.loss, ...loss };
  // Freeze the loss date so elapsed-time category degradation is deterministic.
  job.claim.dateOfLoss = new Date().toISOString().slice(0, 10);
  job.claim.timeOfLoss = new Date().toTimeString().slice(0, 5);
  return job;
}

function room(overrides = {}, affected = {}) {
  const r = newRoom(overrides);
  r.affected = { ...r.affected, ...affected };
  return r;
}

/* ── Room metrics ─────────────────────────────────────────────────────────── */

test('a 14x12 room measures out correctly', () => {
  const m = roomMetrics(room({ poly: rect(14, 12), ceilingHeight: 8 }));
  assert.equal(m.floor, 168);
  assert.equal(m.perimeter, 52);
  assert.equal(m.volume, 168 * 8);
  assert.equal(m.total, 168 * 2 + 52 * 8);
  assert.equal(m.drawn, true);
});

test('an undrawn room reports drawn: false', () => {
  assert.equal(roomMetrics(room({ poly: [] })).drawn, false);
});

test('wet areas scale with the affected percentages', () => {
  const m = roomMetrics(room({ poly: rect(10, 10) }, { floorPct: 50, wallPct: 100, wallAffectedHeight: 2 }));
  assert.equal(m.wetFloorArea, 50);
  assert.equal(m.wetWallArea, 40 * 2, 'perimeter 40 × 2 ft of wick');
  assert.equal(m.wetWallLf, 40);
});

test('water height up the wall is capped by the ceiling', () => {
  const m = roomMetrics(room({ poly: rect(10, 10), ceilingHeight: 8 }, { wallAffectedHeight: 20 }));
  assert.equal(m.affectedHeight, 8);
});

test('only porous materials count toward the wet porous area', () => {
  const porous = roomMetrics(room({ poly: rect(10, 10) }, { floorPct: 100, wallPct: 0, ceilingPct: 0, floorMaterial: 'carpet' }));
  const nonPorous = roomMetrics(room({ poly: rect(10, 10) }, { floorPct: 100, wallPct: 0, ceilingPct: 0, floorMaterial: 'tile' }));
  assert.equal(porous.wetPorousArea, 100);
  assert.equal(nonPorous.wetPorousArea, 0);
});

test('low evaporation materials are flagged on the room', () => {
  assert.equal(roomMetrics(room({ poly: rect(10, 10) }, { floorMaterial: 'hardwood' })).hasLowEvap, true);
  assert.equal(roomMetrics(room({ poly: rect(10, 10) }, { floorMaterial: 'carpet', wallMaterial: 'drywall', ceilingMaterial: 'drywall' })).hasLowEvap, false);
});

test('a rectangle earns no extra air movers for its four corners', () => {
  const m = roomMetrics(room({ poly: rect(12, 12) }));
  assert.equal(m.insideCorners, 4);
  assert.equal(m.extraCorners, 0, 'a plain rectangle has no offsets');
});

test('an L-shaped room earns one extra unit for its offset', () => {
  const l = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 },
    { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 },
  ];
  const m = roomMetrics(room({ poly: l }));
  assert.equal(m.insideCorners, 5);
  assert.equal(m.extraCorners, 1);
});

test('openings are subtracted from wet wall linear feet', () => {
  const r = room({ poly: rect(10, 10) }, { wallPct: 100 });
  r.openings = [{ id: 'o1', wallIndex: 0, t: 0.5, width: 3, type: 'door' }];
  assert.equal(roomMetrics(r).wetWallLf, 37, 'perimeter 40 less a 3 ft door');
});

/* ── Job aggregation ──────────────────────────────────────────────────────── */

test('job metrics sum across rooms', () => {
  const job = jobWith([
    room({ poly: rect(10, 10), ceilingHeight: 8 }),
    room({ poly: rect(20, 10), ceilingHeight: 8 }),
  ]);
  const m = jobMetrics(job);
  assert.equal(m.roomCount, 2);
  assert.equal(m.totalFloor, 300);
  assert.equal(m.totalVolume, 300 * 8);
});

test('job metrics on an empty job do not throw', () => {
  const m = jobMetrics(newJob());
  assert.equal(m.roomCount, 0);
  assert.equal(m.totalFloor, 0);
});

/* ── Classification wiring ────────────────────────────────────────────────── */

test('a small wet area on a big job classifies as Class 1', () => {
  const job = jobWith(
    [room({ poly: rect(30, 30), ceilingHeight: 9 }, { floorPct: 2, wallPct: 0, ceilingPct: 0, floorMaterial: 'carpet' })],
    { sourceId: 'supply' },
  );
  const c = classification(job);
  assert.equal(c.class, 1);
  assert.equal(c.category, 1);
});

test('a fully wet carpeted room with wet walls classifies higher', () => {
  const job = jobWith(
    [room({ poly: rect(12, 12), ceilingHeight: 8 }, { floorPct: 100, wallPct: 100, wallAffectedHeight: 4, floorMaterial: 'carpet', wallMaterial: 'drywall' })],
    { sourceId: 'supply' },
  );
  const c = classification(job);
  assert.ok(c.class >= 2, `expected Class 2 or 3, got ${c.class}`);
  assert.ok(c.wetPorousPct >= 5);
});

test('hardwood in the room drives the job to Class 4', () => {
  const job = jobWith(
    [room({ poly: rect(12, 12) }, { floorMaterial: 'hardwood' })],
    { sourceId: 'supply' },
  );
  assert.equal(classification(job).class, 4);
});

test('a manual class override is honoured and flagged', () => {
  const job = jobWith([room({ poly: rect(12, 12) }, { floorMaterial: 'hardwood' })], { sourceId: 'supply', classOverride: 2 });
  const c = classification(job);
  assert.equal(c.class, 2);
  assert.equal(c.detectedClass, 4);
  assert.equal(c.classOverridden, true);
});

test('a manual category override is honoured and flagged', () => {
  const job = jobWith([room({ poly: rect(12, 12) })], { sourceId: 'supply', categoryOverride: 3 });
  const c = classification(job);
  assert.equal(c.category, 3);
  assert.equal(c.detectedCategory, 1);
  assert.equal(c.categoryOverridden, true);
});

test('an override matching detection is not reported as an override', () => {
  const job = jobWith([room({ poly: rect(12, 12) })], { sourceId: 'sewage', categoryOverride: 3 });
  const c = classification(job);
  assert.equal(c.categoryOverridden, false);
});

/* ── Equipment plan ───────────────────────────────────────────────────────── */

test('the equipment plan reflects the sketched geometry', () => {
  const job = jobWith(
    [room({ poly: rect(20, 15), ceilingHeight: 8 }, { floorPct: 100, wallPct: 100, wallAffectedHeight: 2, floorMaterial: 'carpet' })],
    { sourceId: 'supply' },
  );
  const plan = equipmentPlan(job);
  assert.equal(plan.cubicFeet, 300 * 8);
  assert.ok(plan.airMovers.max >= 1);
  assert.ok(plan.dehumidification.requiredPintsPerDay > 0);
  assert.ok(plan.dehumidification.unitCount >= 1);
});

test('undrawn rooms are excluded from the equipment plan', () => {
  const job = jobWith([room({ poly: [] }), room({ poly: rect(10, 10) })], { sourceId: 'supply' });
  assert.equal(equipmentPlan(job).airMovers.perRoom.length, 1);
});

test('a Category 3 job demands air scrubbers and negative air', () => {
  const job = jobWith([room({ poly: rect(20, 20), ceilingHeight: 8 })], { sourceId: 'sewage' });
  const plan = equipmentPlan(job);
  assert.ok(plan.airScrubbers.required >= 1);
  assert.equal(plan.airScrubbers.negativeAir, true);
  assert.ok(plan.warnings.some((w) => /Category 3/.test(w)));
});

/* ── Equipment inventory and days ─────────────────────────────────────────── */

test('picked-up units leave the on-site count but stay on the record', () => {
  const r = room({ poly: rect(10, 10) });
  r.equipment = [
    { id: 'e1', type: 'airMover', x: 1, y: 1, placedAt: '2026-01-01T08:00:00Z', removedAt: null },
    { id: 'e2', type: 'airMover', x: 2, y: 2, placedAt: '2026-01-01T08:00:00Z', removedAt: '2026-01-03T08:00:00Z' },
  ];
  const job = jobWith([r]);
  const placed = placedEquipment(job);
  assert.equal(placed.total, 1);
  assert.equal(placed.counts.airMover, 1);
  assert.equal(equipmentDays(job, new Date('2026-01-04T08:00:00Z')).find((x) => x.type === 'airMover').units, 2);
});

test('equipment days accrue per unit and stop at pickup', () => {
  const r = room({ poly: rect(10, 10) });
  r.equipment = [
    { id: 'e1', type: 'dehuLgr', x: 1, y: 1, placedAt: '2026-01-01T08:00:00Z', removedAt: '2026-01-04T08:00:00Z' },
  ];
  const rows = equipmentDays(jobWith([r]), new Date('2026-01-10T08:00:00Z'));
  assert.equal(rows[0].days, 3, 'three days between placement and pickup, not ten');
});

test('any part of a day counts as a billable equipment day', () => {
  const r = room({ poly: rect(10, 10) });
  r.equipment = [{ id: 'e1', type: 'airMover', x: 1, y: 1, placedAt: '2026-01-01T08:00:00Z', removedAt: '2026-01-01T14:00:00Z' }];
  assert.equal(equipmentDays(jobWith([r]))[0].days, 1);
});

/* ── Drying progress ──────────────────────────────────────────────────────── */

test('drying progress counts only points that have readings', () => {
  const r = room({ poly: rect(10, 10) });
  r.points = [
    { id: 'p1', x: 1, y: 1, label: 'P1', materialId: 'framing_pine', dryStandard: 11, readings: [{ date: '2026-01-02', value: 12 }] },
    { id: 'p2', x: 2, y: 2, label: 'P2', materialId: 'framing_pine', dryStandard: 11, readings: [{ date: '2026-01-02', value: 25 }] },
    { id: 'p3', x: 3, y: 3, label: 'P3', materialId: 'framing_pine', dryStandard: 11, readings: [] },
  ];
  const p = dryingProgress(jobWith([r]));
  assert.equal(p.total, 3);
  assert.equal(p.measured, 2);
  assert.equal(p.dry, 1);
  assert.equal(Math.round(p.pct), 50);
  assert.equal(p.complete, false);
});

test('a job is complete only when every measured point has met its goal', () => {
  const r = room({ poly: rect(10, 10) });
  r.points = [{ id: 'p1', x: 1, y: 1, materialId: 'framing_pine', dryStandard: 11, readings: [{ date: '2026-01-02', value: 12 }] }];
  assert.equal(dryingProgress(jobWith([r])).complete, true);
});

test('a job with no readings anywhere is not complete', () => {
  assert.equal(dryingProgress(jobWith([room({ poly: rect(10, 10) })])).complete, false);
});

/* ── Money ────────────────────────────────────────────────────────────────── */

test('trip miles prefer an explicit figure, then the odometer, then the track', () => {
  assert.equal(tripMiles({ miles: 24 }), 24);
  assert.equal(tripMiles({ startOdo: 10000, endOdo: 10024 }), 24);
  assert.equal(tripMiles({ startOdo: 10024, endOdo: 10000 }), 0, 'never negative');
  assert.ok(tripMiles({ path: [{ lat: 40, lng: -75 }, { lat: 40.1, lng: -75 }] }) > 6);
  assert.equal(tripMiles({}), 0);
});

test('financials separate what was spent from what is billable', () => {
  const job = jobWith([room({ poly: rect(10, 10) })]);
  job.costs = [
    { id: 'c1', type: 'supplies', amount: 100, qty: 1, markupPct: 20, billable: true },
    { id: 'c2', type: 'lodging', amount: 150, qty: 1, billable: false },
  ];
  job.trips = [{ id: 't1', miles: 100, billable: true }];
  state.settings.mileageRate = 0.70;

  const fin = financials(job);
  assert.equal(fin.costs.total, 250, 'everything spent');
  assert.equal(fin.costs.billable, 100);
  assert.equal(fin.costs.billed, 120, '100 plus 20% markup');
  assert.equal(fin.costs.nonBillable, 150);
  assert.equal(round2(fin.mileage.amount), 70);
  assert.equal(round2(fin.receivable), 190, 'billed costs plus mileage');
  assert.equal(round2(fin.payable), 250);
  assert.equal(round2(fin.margin), -60, 'this job is losing money');
});

test('cost quantity multiplies the unit amount', () => {
  const job = jobWith([]);
  job.costs = [{ id: 'c1', type: 'supplies', amount: 25, qty: 4, billable: true, markupPct: 0 }];
  assert.equal(financials(job).costs.total, 100);
});

test('non-billable trips are excluded from reimbursement', () => {
  const job = jobWith([]);
  job.trips = [{ id: 't1', miles: 50, billable: false }, { id: 't2', miles: 50, billable: true }];
  state.settings.mileageRate = 1;
  const fin = financials(job);
  assert.equal(fin.mileage.miles, 100);
  assert.equal(fin.mileage.billableMiles, 50);
  assert.equal(fin.mileage.amount, 50);
});

test('invoices are bucketed by status', () => {
  const job = jobWith([]);
  job.invoices = [
    { id: 'i1', total: 1000, status: 'paid' },
    { id: 'i2', total: 500, status: 'sent' },
    { id: 'i3', total: 250, status: 'draft' },
  ];
  const inv = financials(job).invoiced;
  assert.equal(inv.total, 1750);
  assert.equal(inv.paid, 1000);
  assert.equal(inv.outstanding, 500);
  assert.equal(inv.draft, 250);
});

/* ── Reference data integrity ─────────────────────────────────────────────── */

test('every equipment type has a rate key that resolves in settings', () => {
  for (const t of EQUIPMENT_TYPES) {
    assert.ok(t.id && t.label && t.rateKey, `${t.id} incomplete`);
    assert.ok(
      Object.hasOwn(state.settings.equipmentRates, t.rateKey),
      `${t.rateKey} has no default rate`,
    );
  }
});

test('cost types and contact roles are well formed', () => {
  for (const c of COST_TYPES) assert.ok(c.id && c.label, `${c.id} incomplete`);
  for (const r of CONTACT_ROLES) assert.ok(r.id && r.label, `${r.id} incomplete`);
});

test('a new job has every collection the views expect', () => {
  const job = newJob();
  for (const key of ['rooms', 'psychro', 'dailies', 'trips', 'costs', 'invoices', 'comms', 'scope']) {
    assert.ok(Array.isArray(job[key]), `${key} should be an array`);
  }
  assert.ok(job.id.startsWith('job_'));
  assert.equal(job.status, 'active');
});

const round2 = (v) => Math.round(v * 100) / 100;
