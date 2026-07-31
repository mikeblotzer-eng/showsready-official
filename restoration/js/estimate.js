/**
 * Estimating and job costing.
 *
 * The goal is not to replace Xactimate — it is to walk off the job once and
 * have the scope, the equipment days and the receipts already totalled when
 * you sit down to write it. Two outputs:
 *
 *   - a line item sheet keyed to your own price list, exportable as CSV that
 *     drops into Xactimate, Symbility, a spreadsheet or an invoice;
 *   - a job cost roll-up (AP/AR) so what you spent and what you billed live in
 *     the same place.
 *
 * The codes below are placeholders shaped like the selectors most estimating
 * platforms use. They are editable in Settings — set them and the unit prices
 * to match your carrier price list before you send anything to an adjuster.
 */

import { num, round, toCsv, uid, hoursBetween, sum } from './util.js';

export const UNITS = {
  EA: 'EA',      // each
  DA: 'DA',      // per day
  SF: 'SF',      // square foot
  LF: 'LF',      // linear foot
  HR: 'HR',      // hour
  CF: 'CF',      // cubic foot
  MI: 'MI',      // mile
  LS: 'LS',      // lump sum
};

/** Default catalog. `unitPrice` is a starting point, not a carrier price. */
export const LINE_ITEM_CATALOG = [
  // Emergency service and labour
  { id: 'emergency_call', code: 'WTR EMERG', description: 'Emergency service call — after hours', unit: UNITS.EA, unitPrice: 168.00, group: 'Emergency service' },
  { id: 'equip_setup', code: 'WTR EQPS', description: 'Equipment setup, take down and monitoring — per hour', unit: UNITS.HR, unitPrice: 61.50, group: 'Emergency service' },
  { id: 'monitoring_visit', code: 'WTR MON', description: 'Monitoring visit — daily documentation and readings', unit: UNITS.EA, unitPrice: 78.00, group: 'Emergency service' },

  // Extraction and cleaning
  { id: 'extract_carpet', code: 'WTR EXTC', description: 'Water extraction from carpeted floor', unit: UNITS.SF, unitPrice: 0.52, group: 'Extraction' },
  { id: 'extract_hard', code: 'WTR EXTH', description: 'Water extraction from hard surface floor', unit: UNITS.SF, unitPrice: 0.42, group: 'Extraction' },
  { id: 'extract_standing', code: 'WTR EXTS', description: 'Extraction of standing water — heavy volume', unit: UNITS.SF, unitPrice: 0.88, group: 'Extraction' },
  { id: 'antimicrobial', code: 'WTR ANTI', description: 'Apply antimicrobial agent to affected surfaces', unit: UNITS.SF, unitPrice: 0.31, group: 'Cleaning' },
  { id: 'hepa_vacuum', code: 'WTR HEPA', description: 'HEPA vacuuming — affected surfaces', unit: UNITS.SF, unitPrice: 0.38, group: 'Cleaning' },
  { id: 'clean_disinfect', code: 'WTR CLNS', description: 'Clean and disinfect structure — Category 2/3', unit: UNITS.SF, unitPrice: 0.66, group: 'Cleaning' },

  // Drying equipment (billed per day per unit)
  { id: 'air_mover', code: 'WTR AMOVE', description: 'Air mover (axial or centrifugal) — per 24 hour period', unit: UNITS.DA, unitPrice: 32.00, group: 'Drying equipment' },
  { id: 'dehu_conventional', code: 'WTR DHMC', description: 'Dehumidifier, conventional refrigerant — per 24 hour period', unit: UNITS.DA, unitPrice: 68.00, group: 'Drying equipment' },
  { id: 'dehu_lgr', code: 'WTR DHML', description: 'Dehumidifier, LGR — per 24 hour period', unit: UNITS.DA, unitPrice: 94.00, group: 'Drying equipment' },
  { id: 'dehu_desiccant', code: 'WTR DHMD', description: 'Dehumidifier, desiccant — per 24 hour period', unit: UNITS.DA, unitPrice: 285.00, group: 'Drying equipment' },
  { id: 'air_scrubber', code: 'WTR AFDS', description: 'Negative air fan / air scrubber (HEPA) — per 24 hour period', unit: UNITS.DA, unitPrice: 82.00, group: 'Drying equipment' },
  { id: 'heater', code: 'WTR HEAT', description: 'Portable heater — per 24 hour period', unit: UNITS.DA, unitPrice: 58.00, group: 'Drying equipment' },
  { id: 'floor_mat_system', code: 'WTR FMAT', description: 'Hardwood floor drying system — per mat per day', unit: UNITS.DA, unitPrice: 24.00, group: 'Drying equipment' },
  { id: 'injectidry', code: 'WTR WALL', description: 'Wall cavity drying system — per unit per day', unit: UNITS.DA, unitPrice: 46.00, group: 'Drying equipment' },

  // Demolition and material handling
  { id: 'remove_pad', code: 'WTR RPAD', description: 'Remove and dispose carpet pad', unit: UNITS.SF, unitPrice: 0.44, group: 'Demolition' },
  { id: 'detach_reset_carpet', code: 'WTR DRCP', description: 'Detach and reset carpet for drying', unit: UNITS.SF, unitPrice: 0.62, group: 'Demolition' },
  { id: 'remove_carpet', code: 'WTR RCRP', description: 'Remove and dispose carpet', unit: UNITS.SF, unitPrice: 0.52, group: 'Demolition' },
  { id: 'flood_cut', code: 'WTR DRYW2', description: 'Drywall removal — flood cut to 2 ft, bagged', unit: UNITS.LF, unitPrice: 3.85, group: 'Demolition' },
  { id: 'flood_cut_4', code: 'WTR DRYW4', description: 'Drywall removal — flood cut to 4 ft, bagged', unit: UNITS.LF, unitPrice: 5.20, group: 'Demolition' },
  { id: 'remove_ceiling', code: 'WTR RCEIL', description: 'Remove and dispose ceiling drywall', unit: UNITS.SF, unitPrice: 1.35, group: 'Demolition' },
  { id: 'remove_insulation', code: 'WTR RINS', description: 'Remove and dispose wet insulation', unit: UNITS.SF, unitPrice: 0.72, group: 'Demolition' },
  { id: 'remove_baseboard', code: 'WTR RBASE', description: 'Detach baseboard for drying', unit: UNITS.LF, unitPrice: 1.05, group: 'Demolition' },
  { id: 'drill_holes', code: 'WTR DRILL', description: 'Drill weep holes / remove base for cavity drying', unit: UNITS.LF, unitPrice: 1.40, group: 'Demolition' },
  { id: 'content_manipulation', code: 'WTR CONT', description: 'Content manipulation — move and block furniture', unit: UNITS.SF, unitPrice: 0.48, group: 'Contents' },

  // Containment and safety
  { id: 'containment_barrier', code: 'WTR CONTB', description: 'Containment barrier — 6 mil poly with zipper door', unit: UNITS.SF, unitPrice: 1.28, group: 'Containment' },
  { id: 'ppe_cat3', code: 'WTR PPE', description: 'Personal protective equipment — per technician per day', unit: UNITS.EA, unitPrice: 28.00, group: 'Containment' },
  { id: 'disposal', code: 'WTR HAUL', description: 'Haul debris — per load', unit: UNITS.EA, unitPrice: 165.00, group: 'Containment' },

  // Travel and consumables
  { id: 'mileage', code: 'WTR MILE', description: 'Vehicle mileage to and from jobsite', unit: UNITS.MI, unitPrice: 0.70, group: 'Travel' },
  { id: 'consumables', code: 'WTR SUPP', description: 'Job consumables and supplies', unit: UNITS.LS, unitPrice: 0, group: 'Travel' },
];

export const catalogById = (id) => LINE_ITEM_CATALOG.find((c) => c.id === id);

/** Labour roles and default billing rates. Editable in Settings. */
export const LABOR_ROLES = {
  tech: { label: 'Technician', defaultRate: 62 },
  lead: { label: 'Lead technician', defaultRate: 78 },
  supervisor: { label: 'Project supervisor', defaultRate: 95 },
  helper: { label: 'Helper / labourer', defaultRate: 46 },
  after_hours: { label: 'After hours technician', defaultRate: 93 },
};

/** Expense kinds tracked against a job for accounts payable. */
export const EXPENSE_KINDS = {
  fuel: { label: 'Fuel', billableByDefault: true, defaultMarkup: 0 },
  supplies: { label: 'Supplies / consumables', billableByDefault: true, defaultMarkup: 20 },
  equipment_rental: { label: 'Equipment rental', billableByDefault: true, defaultMarkup: 10 },
  subcontractor: { label: 'Subcontractor', billableByDefault: true, defaultMarkup: 10 },
  disposal: { label: 'Dump / disposal fees', billableByDefault: true, defaultMarkup: 0 },
  permits: { label: 'Permits', billableByDefault: true, defaultMarkup: 0 },
  lodging: { label: 'Lodging', billableByDefault: false, defaultMarkup: 0 },
  meals: { label: 'Meals', billableByDefault: false, defaultMarkup: 0 },
  other: { label: 'Other', billableByDefault: false, defaultMarkup: 0 },
};

/* ------------------------------------------------------------------ */
/* Equipment days                                                      */
/* ------------------------------------------------------------------ */

/**
 * Billable equipment-days: units × days on the job, rounded up to whole days,
 * which is how carriers pay drying equipment.
 */
export function equipmentDays(entry, asOf = new Date()) {
  const start = entry.placedAt ? new Date(entry.placedAt) : null;
  if (!start) return 0;
  const end = entry.removedAt ? new Date(entry.removedAt) : asOf;
  const hours = hoursBetween(start, end);
  const days = Math.max(1, Math.ceil(hours / 24 - 1e-9));
  return days * Math.max(1, num(entry.count, 1));
}

const EQUIPMENT_LINE_ID = {
  air_mover: 'air_mover',
  dehumidifier: (e) => `dehu_${e.subtype || 'lgr'}`,
  air_scrubber: 'air_scrubber',
  heater: 'heater',
  floor_mat: 'floor_mat_system',
  wall_system: 'injectidry',
};

/* ------------------------------------------------------------------ */
/* Estimate builder                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build a scope from what the job already knows: the sketch gives areas and
 * wall runs, the equipment log gives days, the daily logs give visits, and the
 * expense log gives pass-through costs.
 *
 * @param {object} job
 * @param {object} [options]
 * @param {object} [options.priceList]  { [catalogId]: { unitPrice, code } }
 * @param {Date}   [options.asOf]
 */
export function buildEstimate(job, options = {}) {
  const { priceList = {}, asOf = new Date(), includeManual = true } = options;
  const lines = [];

  const price = (id) => {
    const base = catalogById(id);
    if (!base) return null;
    const custom = priceList[id] || {};
    return { ...base, ...custom };
  };

  const add = (id, quantity, opts = {}) => {
    const q = round(num(quantity), 2);
    if (q <= 0) return;
    const item = price(id);
    if (!item) return;
    const unitPrice = num(opts.unitPrice ?? item.unitPrice);
    lines.push({
      lineId: uid('ln'),
      catalogId: id,
      code: opts.code || item.code,
      description: opts.description || item.description,
      unit: item.unit,
      group: item.group,
      quantity: q,
      unitPrice,
      total: round(q * unitPrice, 2),
      note: opts.note || '',
      source: opts.source || 'auto',
    });
  };

  const rooms = job.rooms || [];
  const category = num(job.category, 1);

  /* ---- extraction, scaled by the affected floor and its covering ---- */
  const byFlooring = { carpet: 0, hard: 0, standing: 0 };
  for (const r of rooms) {
    const aff = num(r.affectedFloorSqft, 0);
    if (aff <= 0) continue;
    if (r.standingWater) byFlooring.standing += aff;
    else if ((r.flooring || '').includes('carpet')) byFlooring.carpet += aff;
    else byFlooring.hard += aff;
  }
  add('extract_standing', byFlooring.standing);
  add('extract_carpet', byFlooring.carpet);
  add('extract_hard', byFlooring.hard);

  const totalAffectedFloor = byFlooring.carpet + byFlooring.hard + byFlooring.standing;

  /* ---- cleaning, driven by category ---- */
  const affectedSurface = sum(rooms, (r) => {
    const h = num(r.ceilingHeightFt, 8);
    const wetWall = num(r.affectedWallLf, 0) * Math.min(num(r.wetWallHeightFt, 2), h);
    return num(r.affectedFloorSqft, 0) + wetWall + (r.ceilingAffected ? num(r.affectedCeilingSqft, 0) : 0);
  });
  if (category >= 2) {
    add('antimicrobial', affectedSurface);
    add('hepa_vacuum', affectedSurface);
  }
  if (category >= 3) {
    add('clean_disinfect', affectedSurface);
    add('containment_barrier', sum(rooms, (r) => num(r.containmentSqft, 0)));
  }

  /* ---- demolition, from what the sketch says is wet ---- */
  const padSqft = sum(rooms, (r) => ((r.flooring || '').includes('carpet') && r.padRemoved !== false ? num(r.affectedFloorSqft, 0) : 0));
  if (category >= 2) add('remove_pad', padSqft);
  else add('detach_reset_carpet', padSqft);
  if (category >= 3) add('remove_carpet', byFlooring.carpet);

  let floodCut2 = 0, floodCut4 = 0, baseboardLf = 0;
  for (const r of rooms) {
    const lf = num(r.affectedWallLf, 0);
    if (!lf) continue;
    baseboardLf += lf;
    const cut = num(r.floodCutHeightFt, 0);
    if (cut >= 3) floodCut4 += lf;
    else if (cut > 0) floodCut2 += lf;
  }
  add('flood_cut', floodCut2);
  add('flood_cut_4', floodCut4);
  add('remove_baseboard', baseboardLf - floodCut2 - floodCut4);
  add('remove_ceiling', sum(rooms, (r) => (r.ceilingRemoved ? num(r.affectedCeilingSqft, 0) : 0)));
  add('remove_insulation', sum(rooms, (r) => num(r.insulationRemovedSqft, 0)));
  add('content_manipulation', sum(rooms, (r) => (r.contentsManipulated ? num(r.floorAreaSqft, 0) : 0)));

  /* ---- drying equipment, from the equipment log ---- */
  const equipTotals = new Map();
  for (const e of job.equipment || []) {
    const resolver = EQUIPMENT_LINE_ID[e.type];
    const id = typeof resolver === 'function' ? resolver(e) : resolver;
    if (!id) continue;
    equipTotals.set(id, (equipTotals.get(id) || 0) + equipmentDays(e, asOf));
  }
  for (const [id, days] of equipTotals) add(id, days);

  /* ---- service labour ---- */
  const setupHours = sum(job.labor || [], (l) => (l.role === 'setup' ? num(l.hours) : 0));
  add('equip_setup', setupHours);
  const visits = (job.dailyLogs || []).filter((d) => d.monitoringPerformed !== false).length;
  add('monitoring_visit', visits);
  if (job.afterHoursCall) add('emergency_call', 1);
  if (category >= 3) {
    const techDays = new Set((job.dailyLogs || []).map((d) => d.date)).size || 1;
    const techs = Math.max(1, num(job.crewSize, 2));
    add('ppe_cat3', techDays * techs);
  }
  add('disposal', num(job.disposalLoads, 0));

  /* ---- billable mileage ---- */
  const billableMiles = sum((job.trips || []).filter((t) => t.billable !== false), (t) => num(t.miles));
  add('mileage', billableMiles);

  /* ---- anything the tech added by hand ---- */
  if (includeManual) {
    for (const m of job.manualLines || []) {
      const item = price(m.catalogId) || {};
      lines.push({
        lineId: m.lineId || uid('ln'),
        catalogId: m.catalogId,
        code: m.code || item.code || 'CUSTOM',
        description: m.description || item.description || 'Custom line item',
        unit: m.unit || item.unit || UNITS.EA,
        group: m.group || item.group || 'Custom',
        quantity: round(num(m.quantity), 2),
        unitPrice: num(m.unitPrice ?? item.unitPrice),
        total: round(num(m.quantity) * num(m.unitPrice ?? item.unitPrice), 2),
        note: m.note || '',
        source: 'manual',
      });
    }
  }

  /* ---- totals ---- */
  const lineItems = round(sum(lines, (l) => l.total), 2);
  const labor = round(sum(job.labor || [], (l) => num(l.hours) * num(l.rate, LABOR_ROLES[l.role]?.defaultRate ?? 0)), 2);

  const expenseRows = (job.expenses || []).map((e) => {
    const markup = num(e.markupPct, EXPENSE_KINDS[e.kind]?.defaultMarkup ?? 0);
    const billed = e.billable ? round(num(e.amount) * (1 + markup / 100), 2) : 0;
    return { ...e, markupPct: markup, billed, cost: round(num(e.amount), 2) };
  });
  const billableExpenses = round(sum(expenseRows.filter((e) => e.billable), (e) => e.billed), 2);
  const costOut = round(sum(expenseRows, (e) => e.cost), 2);

  const totals = {
    lineItems,
    labor,
    billableExpenses,
    grand: round(lineItems + labor + billableExpenses, 2),
    costOut,
    payrollCost: round(sum(job.labor || [], (l) => num(l.hours) * num(l.costRate, num(l.rate, 0) * 0.55)), 2),
  };
  totals.grossMargin = round(totals.grand - totals.costOut - totals.payrollCost, 2);
  totals.marginPct = totals.grand > 0 ? round((totals.grossMargin / totals.grand) * 100, 1) : 0;

  const byGroup = [...new Map(lines.map((l) => [l.group, null])).keys()].map((group) => ({
    group,
    lines: lines.filter((l) => l.group === group),
    total: round(sum(lines.filter((l) => l.group === group), (l) => l.total), 2),
  }));

  return { lines, byGroup, totals, expenses: expenseRows, csv: estimateCsv(lines, job) };
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/**
 * CSV in the column order estimating platforms expect for a line item import.
 * Xactimate's own .esx is a proprietary container we cannot write, so the
 * practical path is this sheet: import or key it against your price list, and
 * the quantities are already walked off and defensible.
 */
export function estimateCsv(lines, job = {}) {
  const header = ['Code', 'Description', 'Unit', 'Quantity', 'Unit Price', 'Total', 'Group', 'Room/Scope', 'Note'];
  const rows = lines.map((l) => [
    l.code, l.description, l.unit, l.quantity, l.unitPrice.toFixed(2), l.total.toFixed(2),
    l.group, l.room || job.lossLocation || '', l.note,
  ]);
  return toCsv([header, ...rows]);
}

/** Accounts payable / receivable ledger for the job. */
export function buildLedger(job, estimate) {
  const receivable = [];
  const payable = [];

  if (estimate.totals.grand > 0) {
    receivable.push({
      id: 'estimate',
      label: 'Mitigation estimate',
      party: job.billTo || job.insuranceCarrier || 'Client',
      amount: estimate.totals.grand,
      status: job.invoiceStatus || 'draft',
    });
  }
  for (const p of job.payments || []) {
    receivable.push({ id: p.id, label: p.label || 'Payment received', party: p.from || 'Client', amount: -num(p.amount), status: 'received', at: p.at });
  }
  for (const e of estimate.expenses) {
    payable.push({
      id: e.id, label: EXPENSE_KINDS[e.kind]?.label || e.kind,
      vendor: e.vendor || '', amount: e.cost, billable: !!e.billable,
      markupPct: e.markupPct, rebilled: e.billed, at: e.at, receiptPhotoId: e.receiptPhotoId,
    });
  }
  const outstanding = round(sum(receivable, (r) => r.amount), 2);
  return {
    receivable, payable, outstanding,
    payableTotal: round(sum(payable, (p) => p.amount), 2),
    reimbursable: round(sum(payable.filter((p) => p.billable), (p) => p.rebilled), 2),
  };
}
