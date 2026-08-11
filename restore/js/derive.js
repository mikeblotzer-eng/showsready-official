// Everything computed from a job: category, class, drying status, equipment
// sizing and money. Screens read this instead of recalculating.

import {
  determineCategory, determineClass, dryingGoal, materialById,
  roomSurfaces, CATEGORY_LABELS, CLASS_LABELS, categoryRequirements,
} from './standards.js';
import { recommendSystem, catalogById } from './equipment.js';
import { psychro, dehuPerformance, targetGpp } from './psychro.js';
import { hoursBetween, round, polygonArea, polygonPerimeter, todayISO, daysBetween } from './util.js';

export function derive(job, settings) {
  const hours = job.loss?.dateISO ? hoursBetween(job.loss.dateISO, null) : null;

  const catAuto = determineCategory({
    sourceId: job.loss?.sourceId,
    hoursSinceLoss: hours,
    tempF: job.loss?.ambientTempF ?? 70,
    contactedContaminants: !!job.loss?.contactedContaminants,
    occupantSensitive: !!job.loss?.occupantSensitive,
  });
  const category = job.loss?.categoryOverride ?? catAuto.category;

  const clsAuto = determineClass(job.plan?.rooms || []);
  const cls = job.loss?.classOverride ?? clsAuto.cls ?? 2;

  const rec = recommendSystem({
    rooms: job.plan?.rooms || [],
    cls,
    category,
    dehuKind: settings.dehuKind || 'lgr',
  });

  const totals = planTotals(job.plan);
  const drying = dryingStatus(job, settings);
  const atmo = atmoStatus(job, settings, cls);
  const money = moneySummary(job, settings);
  const deployed = deployedEquipment(job);

  return {
    hours,
    category,
    categoryAuto: catAuto.category,
    categoryOverridden: job.loss?.categoryOverride != null,
    categoryRationale: catAuto.rationale,
    categoryLabel: CATEGORY_LABELS[category],
    requirements: categoryRequirements(category),
    cls,
    classAuto: clsAuto.cls,
    classOverridden: job.loss?.classOverride != null,
    classRationale: clsAuto.rationale,
    classLabel: CLASS_LABELS[cls],
    wetPct: clsAuto.pct,
    rec, totals, drying, atmo, money, deployed,
  };
}

export function planTotals(plan = {}) {
  let floor = 0, wall = 0, volume = 0, perimeter = 0, affectedFloor = 0;
  const rooms = plan.rooms || [];
  for (const room of rooms) {
    const s = roomSurfaces(room);
    floor += s.floor; wall += s.wall; volume += s.volume; perimeter += s.perimeter;
    if (room.isAffected !== false) affectedFloor += s.floor;
  }
  return {
    rooms: rooms.length,
    floor: round(floor), wall: round(wall), volume: round(volume),
    perimeter: round(perimeter), affectedFloor: round(affectedFloor),
    ceiling: round(floor),
  };
}

/** Per-pin goals and progress, plus the job-level dry percentage. */
export function dryingStatus(job, settings) {
  const pins = (job.plan?.pins || []).map((pin) => {
    const mat = materialById(pin.materialId);
    const { goal, unit, source } = dryingGoal({
      materialId: pin.materialId,
      dryStandard: pin.dryStandard,
      tolerance: settings.tolerance ?? 2,
    });
    const readings = [...(pin.readings || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const first = readings[0] || null;
    const last = readings.at(-1) || null;
    const atGoal = last ? Number(last.value) <= goal : false;
    const progress = first && last && Number(first.value) > goal
      ? Math.min(100, Math.max(0, ((Number(first.value) - Number(last.value)) / (Number(first.value) - goal)) * 100))
      : atGoal ? 100 : 0;
    const stalled = readings.length >= 2 &&
      Math.abs(Number(readings.at(-1).value) - Number(readings.at(-2).value)) < 0.5 && !atGoal;
    const room = (job.plan?.rooms || []).find((r) => r.id === pin.roomId) || null;
    return { pin, material: mat, goal, unit, goalSource: source, readings, first, last, atGoal, progress, stalled, room };
  });

  const done = pins.filter((p) => p.atGoal).length;
  return {
    pins,
    total: pins.length,
    atGoal: done,
    pctDry: pins.length ? Math.round((done / pins.length) * 100) : 0,
    stalled: pins.filter((p) => p.stalled),
    allDry: pins.length > 0 && done === pins.length,
  };
}

/** Atmospheric log with psychrometrics resolved, newest first. */
export function atmoStatus(job, settings, cls) {
  const elev = settings.elevationFt || 0;
  const rows = (job.atmo || []).map((r) => {
    const p = psychro(Number(r.tempF), Number(r.rh), elev);
    return { ...r, ...p };
  }).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  const byDay = new Map();
  for (const r of rows) {
    const day = String(r.ts).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }

  const latestAffected = rows.find((r) => r.location === 'affected');
  const latestOutside = rows.find((r) => r.location === 'outside');
  const latestUnaffected = rows.find((r) => r.location === 'unaffected');
  const target = targetGpp(cls);

  const dehuChecks = [];
  for (const [, dayRows] of byDay) {
    const inlets = dayRows.filter((r) => r.location === 'dehu_inlet');
    const outlets = dayRows.filter((r) => r.location === 'dehu_outlet');
    for (const inlet of inlets) {
      const outlet = outlets.find((o) => o.equipmentId === inlet.equipmentId) || outlets[0];
      if (!outlet) continue;
      const perf = dehuPerformance(inlet, outlet, elev);
      if (perf) dehuChecks.push({ ...perf, ts: inlet.ts, equipmentId: inlet.equipmentId });
    }
  }

  return {
    rows, byDay: [...byDay.entries()],
    latestAffected, latestOutside, latestUnaffected,
    target,
    onTarget: latestAffected?.gpp != null ? latestAffected.gpp <= target : null,
    dehuChecks,
  };
}

/** Equipment currently on site, with days deployed for billing. */
export function deployedEquipment(job) {
  const list = (job.plan?.equipment || []).map((eq) => {
    const item = catalogById(eq.catalogId);
    const end = eq.removedAt ? new Date(eq.removedAt) : new Date();
    const days = Math.max(1, Math.ceil((end - new Date(eq.placedAt)) / 864e5));
    return { eq, item, days, active: !eq.removedAt };
  });
  const byCatalog = new Map();
  for (const row of list) {
    const key = row.eq.catalogId;
    if (!byCatalog.has(key)) byCatalog.set(key, { item: row.item, qty: 0, unitDays: 0, active: 0 });
    const g = byCatalog.get(key);
    g.qty++; g.unitDays += row.days;
    if (row.active) g.active++;
  }
  return { list, grouped: [...byCatalog.values()], active: list.filter((r) => r.active).length };
}

// ── money ───────────────────────────────────────────────────────────────────

export function lineTotal(line) {
  return round((Number(line.qty) || 0) * (Number(line.unitPrice) || 0), 2);
}

export function moneySummary(job, settings) {
  const lines = job.estimate?.lines || [];
  const subtotal = round(lines.reduce((t, l) => t + lineTotal(l), 0), 2);
  const oh = settings.applyOandP ? round(subtotal * ((settings.overhead || 0) / 100), 2) : 0;
  const profit = settings.applyOandP ? round(subtotal * ((settings.profit || 0) / 100), 2) : 0;
  const taxable = round(lines.filter((l) => l.taxable).reduce((t, l) => t + lineTotal(l), 0), 2);
  const tax = round(taxable * ((settings.taxRate || 0) / 100), 2);
  const total = round(subtotal + oh + profit + tax, 2);

  const expenses = job.expenses || [];
  const expenseTotal = round(expenses.reduce((t, e) => t + (Number(e.amount) || 0), 0), 2);
  const billableExpenses = round(
    expenses.filter((e) => e.billable)
      .reduce((t, e) => t + (Number(e.amount) || 0) * (1 + (Number(e.markup) || 0) / 100), 0), 2);

  const trips = job.trips || [];
  const miles = round(trips.reduce((t, x) => t + (Number(x.miles) || 0), 0), 1);
  const mileageBillable = round(
    trips.filter((t) => t.billable).reduce((t, x) => t + (Number(x.miles) || 0), 0) * (settings.mileageRate || 0), 2);

  const invoices = job.invoices || [];
  const invoiced = round(invoices.reduce((t, i) => t + (Number(i.amount) || 0), 0), 2);
  const paid = round(invoices.reduce((t, i) =>
    t + (i.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0), 0), 2);
  const receivable = round(invoiced - paid, 2);

  const aging = invoices.filter((i) => {
    const bal = (Number(i.amount) || 0) - (i.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    return bal > 0.01;
  }).map((i) => {
    const bal = round((Number(i.amount) || 0) - (i.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0), 2);
    const days = Math.floor(daysBetween(i.dateISO, null) ?? 0);
    return { invoice: i, balance: bal, days, bucket: days > 90 ? '90+' : days > 60 ? '61-90' : days > 30 ? '31-60' : '0-30' };
  });

  return {
    subtotal, oh, profit, tax, total,
    expenseTotal, billableExpenses, miles, mileageBillable,
    invoiced, paid, receivable, aging,
    margin: total > 0 ? round(((total - expenseTotal) / total) * 100, 1) : 0,
  };
}

/**
 * Line items the job data already justifies: equipment days, monitoring visits,
 * mileage and billable purchases. The tech reviews them before they land on the
 * estimate — nothing is billed silently.
 */
export function buildAutoLines(job, settings, d = null) {
  const der = d || derive(job, settings);
  const out = [];
  const push = (code, description, qty, unit, unitPrice, source, taxable = false) => {
    if (!qty || qty <= 0) return;
    out.push({ code, description, qty: round(qty, 2), unit, unitPrice: round(unitPrice, 2), taxable, source });
  };

  for (const g of der.deployed.grouped) {
    if (!g.item) continue;
    push(g.item.code, `${g.item.label} — ${g.qty} unit${g.qty === 1 ? '' : 's'}`, g.unitDays, 'unit-day',
      g.item.rate, 'equipment on the plan');
  }

  const visits = new Set((job.dailies || []).map((x) => x.dateISO)).size;
  push('WTR-MON', 'Daily monitoring visit — readings, equipment check, documentation', visits, 'ea', 65, 'daily logs');

  const laborHours = round((job.dailies || []).reduce((t, x) => t + (Number(x.hours) || 0) * (Number(x.techs) || 1), 0), 2);
  push('WTR-LAB', 'Restoration technician labor', laborHours, 'hr', settings.laborRate || 62, 'daily logs');

  const affectedFloor = der.totals.affectedFloor;
  if (der.cls >= 2) {
    push('WTR-EXT', 'Water extraction from carpeted floor', affectedFloor, 'sf', 0.55, 'affected floor area');
  }
  if (der.category >= 2) {
    push('WTR-ANTI', 'Apply antimicrobial agent to affected surfaces', affectedFloor, 'sf', 0.32, `Category ${der.category} work practice`);
  }
  if (der.category >= 3) {
    push('WTR-CONT', 'Containment barrier — poly, zipper door, framing', Math.max(0, der.totals.perimeter * 8 * 0.35), 'sf', 1.45, 'Category 3 containment');
    push('WTR-HEPA', 'HEPA vacuuming of affected surfaces', affectedFloor, 'sf', 0.45, 'Category 3 cleaning');
  }

  const wetWallLf = (job.plan?.rooms || []).reduce((t, r) => t + (Number(r.affected?.wallLf) || 0), 0);
  const maxWick = Math.max(0, ...(job.plan?.rooms || []).map((r) => Number(r.affected?.wallHeightIn) || 0));
  if (wetWallLf > 0) {
    push('WTR-BASE', 'Detach and reset baseboard', wetWallLf, 'lf', 1.1, 'wet wall length');
    if (maxWick >= 20) {
      push('WTR-FC2', 'Drywall flood cut — 2 ft', wetWallLf, 'lf', 3.2, `wicking measured at ${maxWick}"`);
    }
  }

  const miles = der.money.miles;
  const billableMiles = round((job.trips || []).filter((t) => t.billable).reduce((t, x) => t + (Number(x.miles) || 0), 0), 1);
  push('WTR-MILE', 'Mileage to and from the loss site', billableMiles, 'mi', settings.mileageRate || 0.7, `${miles} mi logged`);

  for (const e of (job.expenses || []).filter((x) => x.billable)) {
    push(e.code || 'MAT-SUP', `${e.description || e.category} (${e.vendor || 'supplier'})`, 1, 'ea',
      (Number(e.amount) || 0) * (1 + (Number(e.markup) || 0) / 100), 'job-costed purchase', true);
  }

  return out;
}

/** Xactimate-style export rows — CSV that maps cleanly into an estimating platform. */
export function estimateExportRows(job, settings) {
  const d = derive(job, settings);
  const rows = [[
    'Job Number', 'Claim Number', 'Insured', 'Loss Date', 'Category', 'Class',
    'Room', 'Code', 'Description', 'Quantity', 'Unit', 'Unit Price', 'Total', 'Taxable',
  ]];
  for (const l of job.estimate?.lines || []) {
    rows.push([
      job.jobNumber, job.carrier?.claimNumber || '', job.site?.name || '',
      (job.loss?.dateISO || '').slice(0, 10), d.category, d.cls,
      l.room || '', l.code || '', l.description || '',
      l.qty, l.unit || 'ea', l.unitPrice, lineTotal(l), l.taxable ? 'Y' : 'N',
    ]);
  }
  return rows;
}
