/** Equipment: what the loss needs, what is actually on the floor, and the gap. */

import { esc, onAct, formSheet, toast, statCard, flagList, sectionHeader, emptyState, confirmDialog } from '../ui.js';
import { uid, nowIso, num, round, fmtDateTime, cuft, groupBy } from '../util.js';
import { EQUIPMENT_GLYPH } from '../sketch.js';
import { DEHU_TYPES } from '../iicrc.js';
import { equipmentDays } from '../estimate.js';
import { recommendation, equipmentAudit, electricalLoad, totals } from '../jobcalc.js';

export async function render(ctx) {
  const job = ctx.job;
  const rec = recommendation(job, ctx.settings);
  const audit = equipmentAudit(job, ctx.settings);
  const power = electricalLoad(job, ctx.settings);
  const t = totals(job);

  const active = (job.equipment || []).filter((e) => !e.removedAt);
  const removed = (job.equipment || []).filter((e) => e.removedAt);

  const html = `
    <div class="stat-grid">
      ${statCard('Air movers', `${audit.placed.airMovers}/${rec.airMovers}`, 'set / recommended', audit.placed.airMovers >= rec.airMovers ? 'dry' : 'wet')}
      ${statCard('Dehu', `${audit.placed.dehuUnits}/${rec.dehumidifiers.units}`, 'units', audit.placed.dehuUnits >= rec.dehumidifiers.units ? 'dry' : 'wet')}
      ${statCard('Volume', Math.round(rec.cubicFeet).toLocaleString(), 'cubic feet')}
      ${statCard('Circuits', power.circuits, `${round(power.totalAmps)} A total`)}
    </div>

    <div class="card">
      <div class="card-head"><h2>Placement check</h2>
        <span class="chip">Class ${rec.class} · Cat ${rec.category}</span></div>
      ${flagList(audit.issues)}
      ${rec.airMovers > audit.placed.airMovers || rec.dehumidifiers.units > audit.placed.dehuUnits ? `
        <button class="btn btn-primary btn-block mt" data-act="set-recommended">Log the recommended set</button>` : ''}
    </div>

    ${sectionHeader('Recommendation', `<button class="btn btn-sm" data-act="dehu-settings">Dehu type</button>`)}
    <div class="card">
      <div class="card-row"><span class="label">Air movers</span><span class="value">${rec.airMovers}</span></div>
      <p class="tiny muted" style="margin:-4px 0 8px">
        ${esc(`${rec.coefficientsUsed.airMover.sqftPerAirMover} ft² of wet floor per unit, one per ${rec.coefficientsUsed.airMover.lfWallPerAirMover} lf of wet wall, one per inside corner, minimum one per affected room.`)}
      </p>
      <div class="card-row"><span class="label">Dehumidification</span><span class="value">
        ${rec.dehumidifiers.units} × ${rec.dehumidifiers.type === 'desiccant'
          ? `${rec.dehumidifiers.unitCfm} CFM`
          : `${rec.dehumidifiers.unitPpd} ppd ${esc(DEHU_TYPES[rec.dehumidifiers.type]?.label || '')}`}</span></div>
      <p class="tiny muted" style="margin:-4px 0 8px">${esc(rec.dehumidifiers.basis)}</p>
      <div class="card-row"><span class="label">Air scrubbers</span><span class="value">${rec.airScrubbers.units}</span></div>
      <p class="tiny muted" style="margin:-4px 0 8px">${esc(rec.airScrubbers.basis)}</p>
      <div class="card-row"><span class="label">Electrical</span><span class="value">${power.circuits} × 15 A circuits</span></div>
      <p class="tiny muted" style="margin:-4px 0 0">${esc(power.note)}</p>
      ${rec.notes.length ? `<div class="mt">${flagList(rec.notes.map((n) => ({ level: 'info', text: n })))}</div>` : ''}
    </div>

    ${rec.perRoom.some((r) => r.airMovers) ? `
      ${sectionHeader('By room')}
      <div class="card">
        <div class="table-scroll"><table class="data">
          <thead><tr><th>Room</th><th class="num">Wet floor</th><th class="num">Air movers</th><th>Basis</th></tr></thead>
          <tbody>${rec.perRoom.filter((r) => r.airMovers).map((r) => `<tr>
            <td>${esc(r.name || 'Room')}</td>
            <td class="num">${Math.round(r.affectedFloorSqft)} ft²</td>
            <td class="num"><strong>${r.airMovers}</strong></td>
            <td class="tiny muted">${r.breakdown.fromFloor} floor + ${r.breakdown.fromWall} wall + ${r.breakdown.fromCorners} corner</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>` : ''}

    ${sectionHeader('On site', `<button class="btn btn-sm btn-primary" data-act="add">+ Equipment</button>`)}
    ${active.length ? active.map((e) => equipmentRow(e, job)).join('')
      : emptyState('Nothing logged yet', 'Log what you set so the days bill correctly and the chamber can be audited.',
        `<button class="btn btn-primary" data-act="add">Add equipment</button>`)}

    ${removed.length ? `
      ${sectionHeader('Picked up')}
      ${removed.map((e) => equipmentRow(e, job)).join('')}` : ''}

    <div class="note-block">
      Equipment days bill from the moment a unit is logged until it is marked picked up, rounded up to whole days.
      Mark units picked up the day you pull them — that is the number the carrier checks.
    </div>`;

  return {
    title: 'Equipment',
    subtitle: job.client?.name,
    back: `#/job/${job.id}`,
    html,
    mount: (root) => {
      onAct(root, {
        add: () => addEquipment(ctx),
        edit: (el) => editEquipment(ctx, el.dataset.id),
        'set-recommended': () => setRecommended(ctx, rec),
        'dehu-settings': () => dehuSettings(ctx),
      });
    },
  };
}

function equipmentRow(e, job) {
  const glyph = EQUIPMENT_GLYPH[e.type] || { label: e.type, short: '?' };
  const days = equipmentDays(e);
  const room = job.rooms.find((r) => r.id === e.roomId);
  return `
    <button class="list-item" data-act="edit" data-id="${esc(e.id)}">
      <span class="status-dot" style="background:${esc(glyph.color || 'var(--brand)')}"></span>
      <span class="grow">
        <span class="title">${e.count > 1 ? `${e.count} × ` : ''}${esc(glyph.label)}${e.subtype ? ` (${esc(e.subtype.toUpperCase())})` : ''}</span>
        <span class="meta">
          ${room ? `${esc(room.name)} · ` : ''}${e.placedAt ? `set ${esc(fmtDateTime(e.placedAt))}` : 'not placed'}
          ${e.removedAt ? ` · pulled ${esc(fmtDateTime(e.removedAt))}` : ''}
        </span>
      </span>
      <span class="chip">${days} unit-day${days === 1 ? '' : 's'}</span>
      <span class="chev">›</span>
    </button>`;
}

/* ------------------------------------------------------------------ */

const equipmentFields = (e = {}, job = {}) => [
  { name: 'type', label: 'Type', type: 'select', full: true, value: e.type || 'air_mover',
    options: Object.entries(EQUIPMENT_GLYPH).map(([value, g]) => ({ value, label: g.label })) },
  { name: 'count', label: 'Quantity', type: 'number', value: e.count ?? 1, min: 1 },
  { name: 'roomId', label: 'Room', type: 'select', value: e.roomId || '',
    options: [{ value: '', label: 'Unassigned' }, ...(job.rooms || []).map((r) => ({ value: r.id, label: r.name }))] },
  { name: 'subtype', label: 'Dehumidifier type', type: 'select', value: e.subtype || job.dehuType || 'lgr',
    options: Object.entries(DEHU_TYPES).map(([value, d]) => ({ value, label: d.label })) },
  { name: 'capacityPpd', label: 'Capacity (AHAM ppd)', type: 'number', value: e.capacityPpd ?? job.dehuCapacityPpd },
  { name: 'serial', label: 'Asset / serial', type: 'text', value: e.serial },
  { name: 'placedAt', label: 'Placed', type: 'datetime-local', full: true,
    value: toLocalInput(e.placedAt || nowIso()) },
];

async function addEquipment(ctx) {
  const values = await formSheet({
    title: 'Add equipment',
    intro: 'Placement on the floor plan is optional — this is the billing and audit record.',
    fields: equipmentFields({}, ctx.job),
  });
  if (!values) return;
  await ctx.save((job) => {
    job.equipment.push({
      id: uid('eq'), type: values.type, count: Math.max(1, num(values.count, 1)),
      roomId: values.roomId || null, levelId: job.levels?.[0]?.id || null,
      subtype: values.type === 'dehumidifier' ? values.subtype : null,
      capacityPpd: values.capacityPpd, serial: values.serial,
      placedAt: values.placedAt ? new Date(values.placedAt).toISOString() : nowIso(),
      removedAt: null, x: null, y: null, angle: 0,
    });
    if (!job.dryingStartedAt) job.dryingStartedAt = nowIso();
    if (job.status === 'active') job.status = 'drying';
  });
  toast('Equipment logged.', 'success');
  ctx.refresh();
}

async function editEquipment(ctx, id) {
  const e = ctx.job.equipment.find((x) => x.id === id);
  if (!e) return;
  const values = await formSheet({
    title: EQUIPMENT_GLYPH[e.type]?.label || 'Equipment',
    intro: `${equipmentDays(e)} billable unit-days so far.`,
    fields: [
      ...equipmentFields(e, ctx.job),
      { name: 'removed', label: 'Picked up', type: 'checkbox', full: true, value: !!e.removedAt },
      { name: 'removedAt', label: 'Picked up at', type: 'datetime-local', full: true, value: toLocalInput(e.removedAt) },
    ],
    extraActions: [{
      label: 'Delete',
      onClick: async ({ close }) => {
        if (!(await confirmDialog('Delete this equipment record? Its billable days go with it.', { confirmLabel: 'Delete', danger: true }))) return false;
        await ctx.save((job) => { job.equipment = job.equipment.filter((x) => x.id !== id); });
        close(null);
        ctx.refresh();
        return false;
      },
    }],
  });
  if (!values) return;

  await ctx.save((job) => {
    const entry = job.equipment.find((x) => x.id === id);
    Object.assign(entry, {
      type: values.type, count: Math.max(1, num(values.count, 1)), roomId: values.roomId || null,
      subtype: values.type === 'dehumidifier' ? values.subtype : null,
      capacityPpd: values.capacityPpd, serial: values.serial,
      placedAt: values.placedAt ? new Date(values.placedAt).toISOString() : entry.placedAt,
      removedAt: values.removed
        ? (values.removedAt ? new Date(values.removedAt).toISOString() : entry.removedAt || nowIso())
        : null,
    });
  });
  toast('Saved.', 'success');
  ctx.refresh();
}

/** One tap to log the whole recommended set — the common case on day one. */
async function setRecommended(ctx, rec) {
  const audit = equipmentAudit(ctx.job, ctx.settings);
  const needAm = Math.max(0, rec.airMovers - audit.placed.airMovers);
  const needDehu = Math.max(0, rec.dehumidifiers.units - audit.placed.dehuUnits);
  const needScrub = Math.max(0, rec.airScrubbers.units - audit.placed.scrubbers);

  const ok = await confirmDialog(
    `Log ${needAm} air mover(s)${needDehu ? `, ${needDehu} dehumidifier(s)` : ''}${needScrub ? `, ${needScrub} air scrubber(s)` : ''} as placed now? You can adjust counts and positions afterwards.`,
    { title: 'Log recommended set', confirmLabel: 'Log it' },
  );
  if (!ok) return;

  await ctx.save((job) => {
    const at = nowIso();
    if (needAm) job.equipment.push({ id: uid('eq'), type: 'air_mover', count: needAm, placedAt: at, removedAt: null, x: null, y: null, angle: 0 });
    if (needDehu) job.equipment.push({
      id: uid('eq'), type: 'dehumidifier', subtype: rec.dehumidifiers.type, count: needDehu,
      capacityPpd: rec.dehumidifiers.unitPpd, placedAt: at, removedAt: null, x: null, y: null,
    });
    if (needScrub) job.equipment.push({ id: uid('eq'), type: 'air_scrubber', count: needScrub, placedAt: at, removedAt: null, x: null, y: null });
    if (!job.dryingStartedAt) job.dryingStartedAt = at;
    if (job.status === 'active') job.status = 'drying';
  });
  toast('Equipment logged. Drop them on the floor plan when you set them.', 'success');
  ctx.refresh();
}

async function dehuSettings(ctx) {
  const values = await formSheet({
    title: 'Dehumidification',
    intro: 'Sets what the recommendation sizes against — use what is actually on your truck.',
    fields: [
      { name: 'dehuType', label: 'Type', type: 'segmented', full: true, value: ctx.job.dehuType || 'lgr',
        options: [{ value: 'conventional', label: 'Conventional' }, { value: 'lgr', label: 'LGR' }, { value: 'desiccant', label: 'Desiccant' }] },
      { name: 'dehuCapacityPpd', label: 'Unit capacity (AHAM ppd)', type: 'number', value: ctx.job.dehuCapacityPpd },
      { name: 'desiccantCfm', label: 'Desiccant process CFM', type: 'number', value: ctx.job.desiccantCfm },
    ],
  });
  if (!values) return;
  await ctx.save((j) => {
    j.dehuType = values.dehuType;
    j.dehuCapacityPpd = values.dehuCapacityPpd ?? DEHU_TYPES[values.dehuType]?.defaultCapacityPpd;
    j.desiccantCfm = values.desiccantCfm;
  });
  ctx.refresh();
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
