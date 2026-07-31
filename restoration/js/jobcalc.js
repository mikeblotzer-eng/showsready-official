/**
 * Derived job state.
 *
 * Every screen needs the same handful of answers — what category is this, what
 * class, what equipment does it need, is it drying — so they are computed in
 * one place from the stored job rather than cached on it. Stale numbers on a
 * drying log are worse than no numbers.
 */

import {
  determineCategory, determineClass, recommendEquipment, auditPlacement,
  evaluateDryness, dryingTrend, powerLoad, DEFAULT_COEFFICIENTS,
} from './iicrc.js';
import { psychroSet, evaluateEnvironment, gpp } from './psychro.js';
import { hoursBetween, num, dayKey, sum } from './util.js';
import { latestReading } from './sketch.js';

/** Hours since the loss, from the recorded date of loss. */
export function hoursSinceLoss(job) {
  const dol = job.loss?.dateOfLoss;
  if (!dol) return 0;
  const d = new Date(dol);
  return isNaN(d) ? 0 : Math.max(0, hoursBetween(d, new Date()));
}

/** Most recent ambient reading at a given location. */
export function latestAmbient(job, location) {
  let best = null;
  for (const r of job.ambientReadings || []) {
    if (r.location !== location) continue;
    if (!best || new Date(r.at) > new Date(best.at)) best = r;
  }
  return best;
}

export function classify(job) {
  const inside = latestAmbient(job, 'inside');
  const category = determineCategory({
    sourceId: job.loss?.sourceId,
    hoursSinceLoss: hoursSinceLoss(job),
    ambientTempF: inside?.tempF ?? 70,
    contactedContaminatedMaterial: !!job.loss?.contactedContaminated,
    visibleMicrobialGrowth: !!job.loss?.visibleGrowth,
    odorPresent: !!job.loss?.odor,
    occupantHealthConcern: !!job.loss?.healthConcern,
    override: job.categoryOverride,
  });
  const waterClass = determineClass(job.rooms || [], { override: job.classOverride });
  return { category, waterClass };
}

export function recommendation(job, settings = {}) {
  const { category, waterClass } = classify(job);
  return recommendEquipment({
    rooms: job.rooms || [],
    waterClass: waterClass.class,
    category: category.category,
    dehuType: job.dehuType || 'lgr',
    dehuCapacityPpd: job.dehuCapacityPpd,
    desiccantCfm: job.desiccantCfm,
    coefficients: settings.coefficients || DEFAULT_COEFFICIENTS,
    containment: !!job.containment,
  });
}

export function equipmentAudit(job, settings = {}) {
  return auditPlacement(recommendation(job, settings), job.equipment || []);
}

export function electricalLoad(job, settings = {}) {
  const rec = recommendation(job, settings);
  return powerLoad({
    airMovers: rec.airMovers,
    dehuUnits: rec.dehumidifiers.units,
    dehuType: rec.dehumidifiers.type,
    airScrubbers: rec.airScrubbers.units,
  });
}

/* ------------------------------- moisture ------------------------------- */

/** Every monitoring point with its latest reading, status and trend. */
export function pointStatuses(job) {
  return (job.monitoringPoints || []).map((p) => {
    const readings = (job.readings || []).filter((r) => r.pointId === p.id);
    const latest = latestReading(job.readings, p.id);
    const evaluated = evaluateDryness({ ...p, reading: latest?.reading });
    return { point: p, latest, readings, ...evaluated, trend: dryingTrend(readings) };
  });
}

export function dryingSummary(job) {
  const statuses = pointStatuses(job);
  const counts = { dry: 0, near: 0, wet: 0, unknown: 0 };
  for (const s of statuses) counts[s.status]++;
  const monitored = statuses.length;
  const stalled = statuses.filter((s) => s.status !== 'dry' && ['stalled', 'rewetting'].includes(s.trend.direction));
  return {
    statuses,
    counts,
    monitored,
    pctDry: monitored ? Math.round((counts.dry / monitored) * 100) : 0,
    stalled,
    allDry: monitored > 0 && counts.dry === monitored,
  };
}

/* ------------------------------- ambient -------------------------------- */

export function environment(job) {
  const inside = latestAmbient(job, 'inside');
  const outside = latestAmbient(job, 'outside');
  const unaffected = latestAmbient(job, 'unaffected');
  if (!inside) return null;
  const elevationFt = num(job.elevationFt, 0);
  return {
    ...evaluateEnvironment({
      insideTempF: inside.tempF, insideRh: inside.rh,
      outsideTempF: outside?.tempF, outsideRh: outside?.rh,
      unaffectedTempF: unaffected?.tempF, unaffectedRh: unaffected?.rh,
      elevationFt,
    }),
    readings: { inside, outside, unaffected },
  };
}

export function psychroFor(reading, job) {
  return psychroSet(reading.tempF, reading.rh, num(job.elevationFt, 0));
}

/** Grain depression between the chamber and the unaffected reference. */
export function grainDepression(job) {
  const inside = latestAmbient(job, 'inside');
  const reference = latestAmbient(job, 'unaffected') || latestAmbient(job, 'outside');
  if (!inside || !reference) return null;
  const elevationFt = num(job.elevationFt, 0);
  return gpp(reference.tempF, reference.rh, elevationFt) - gpp(inside.tempF, inside.rh, elevationFt);
}

/* -------------------------------- totals -------------------------------- */

export function totals(job) {
  const rooms = job.rooms || [];
  return {
    rooms: rooms.length,
    floorSqft: sum(rooms, (r) => num(r.floorAreaSqft)),
    affectedSqft: sum(rooms, (r) => num(r.affectedFloorSqft)),
    cubicFeet: sum(rooms, (r) => num(r.floorAreaSqft) * num(r.ceilingHeightFt, 8)),
    wetWallLf: sum(rooms, (r) => num(r.affectedWallLf)),
  };
}

export function daysOnJob(job) {
  const start = job.dryingStartedAt || job.createdAt;
  return Math.max(1, Math.ceil(hoursBetween(new Date(start), new Date()) / 24));
}

/** Days a monitoring visit was logged, newest first. */
export function loggedDays(job) {
  return [...new Set((job.dailyLogs || []).map((d) => d.date))].sort().reverse();
}

/**
 * What a tech should do next. Drives the prompt on the job overview — the
 * screen should tell you the job's state, not make you reconstruct it.
 */
export function nextActions(job, settings = {}) {
  const actions = [];
  const t = totals(job);
  const drying = dryingSummary(job);
  const audit = equipmentAudit(job, settings);

  if (!t.rooms) {
    actions.push({ level: 'warn', text: 'No rooms sketched yet — map the affected area to size equipment.', href: 'plan' });
  }
  if (t.rooms && !job.monitoringPoints?.length) {
    actions.push({ level: 'warn', text: 'No monitoring points set. Place points on wet materials and record a dry standard.', href: 'readings' });
  }
  if (!latestAmbient(job, 'inside')) {
    actions.push({ level: 'warn', text: 'No chamber temperature and humidity logged yet.', href: 'readings' });
  }
  for (const issue of audit.issues) {
    if (issue.level === 'bad' || issue.level === 'warn') actions.push({ ...issue, href: 'equipment' });
  }
  if (drying.stalled.length) {
    actions.push({
      level: 'warn',
      text: `${drying.stalled.length} monitoring point(s) have stalled or are re-wetting. Change the drying approach and document why.`,
      href: 'readings',
    });
  }
  const today = dayKey();
  if ((job.dailyLogs || []).length && !(job.dailyLogs || []).some((d) => d.date === today)) {
    actions.push({ level: 'info', text: "Today's daily has not been logged.", href: 'field' });
  }
  if (drying.allDry && job.status !== 'complete') {
    actions.push({ level: 'good', text: 'Every monitoring point has reached its dry standard — document completion and pull equipment.', href: 'readings' });
  }
  if (!actions.length) actions.push({ level: 'good', text: 'Job is on track. Keep logging daily readings.' });
  return actions;
}
