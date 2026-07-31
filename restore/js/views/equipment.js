/* Equipment: what S500 calls for, what is actually on site, and the gap. */

import { el, sheet, field, toast, num, round, fmtDate, fmtTime, download, toCsv, confirmDialog } from '../util.js';
import * as store from '../store.js';
import { DEHU_FACTORS, DESICCANT_ACH } from '../iicrc.js';
import { slug } from './jobs.js';

export default function renderEquipment(view, { go }) {
  const job = store.state.job;
  if (!job) return go('jobs');

  const rerender = () => { view.innerHTML = ''; renderEquipment(view, { go }); };
  const cls = store.classification(job);
  const plan = store.equipmentPlan(job);
  const placed = store.placedEquipment(job);

  view.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { text: 'Equipment' }),
      el('p', { class: 'mute', text: `Class ${cls.class} · Category ${cls.category} · ${Math.round(plan.cubicFeet).toLocaleString()} cu ft chamber` }),
    ),
    el('button', { class: 'btn btn-sm', onClick: () => go('plan') }, 'Place →'),
  ));

  if (!cls.metrics.roomCount) {
    view.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
      el('div', { class: 'empty-ico', text: '➤' }),
      el('h2', { text: 'Sketch the rooms first' }),
      el('p', { text: 'Equipment counts come from wet floor area, wet wall linear feet and chamber volume. No geometry, no numbers.' }),
      el('button', { class: 'btn btn-primary', onClick: () => go('plan') }, 'Go to plan'),
    )));
    return;
  }

  /* Recommended vs placed */
  const am = plan.airMovers;
  const dh = plan.dehumidification;
  const sc = plan.airScrubbers;
  const placedAirMovers = placed.counts.airMover || 0;
  const placedDehus = ['dehuLgr', 'dehuConventional', 'dehuDesiccant'].reduce((s, k) => s + (placed.counts[k] || 0), 0);
  const placedScrubbers = placed.counts.airScrubber || 0;

  view.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: 'Recommended vs. on site' })),
    el('div', { class: 'list' },
      compareRow('Air movers', `${am.min}–${am.max}`, placedAirMovers, am.recommended, am.basis),
      dh.type === 'desiccant'
        ? compareRow('Desiccant CFM', `${Math.round(dh.requiredCfm)} CFM`, placedDehus, 1, dh.basis)
        : compareRow('Dehumidifiers', dh.unitCount != null ? `${dh.unitCount} × ${dh.unitPints} AHAM pt` : 'n/a', placedDehus, dh.unitCount ?? 0, dh.basis),
      compareRow('Air scrubbers', sc.required ? `${sc.required}` : 'Optional', placedScrubbers, sc.required, sc.basis),
    ),
  ), el('div', { class: 'spacer' }));

  for (const w of plan.warnings) {
    view.append(el('div', { class: 'note note-warn', style: 'margin-bottom:8px', text: w }));
  }

  /* Per-room air mover breakdown */
  if (am.perRoom.length) {
    view.append(el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { text: 'Air movers by room' })),
      el('div', { class: 'table-scroll' }, el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Room'), el('th', { class: 'num' }, 'Called for'), el('th', { class: 'num' }, 'Placed'), el('th', {}, 'Basis'),
        )),
        el('tbody', {}, ...am.perRoom.map((r) => {
          const room = job.rooms.find((x) => x.id === r.roomId);
          const on = (room?.equipment || []).filter((e) => e.type === 'airMover' && !e.removedAt).length;
          return el('tr', {},
            el('td', {}, r.name),
            el('td', { class: 'num mono' }, `${r.min}–${r.max}`),
            el('td', { class: 'num mono' }, el('span', { class: `chip ${on >= r.min ? 'chip-green' : 'chip-amber'}`, text: String(on) })),
            el('td', { class: 'mute tiny', style: 'white-space:normal;min-width:200px' }, r.basis),
          );
        })),
      )),
    ), el('div', { class: 'spacer' }));
  }

  /* Sizing assumptions */
  view.append(sizingCard(cls, rerender), el('div', { class: 'spacer' }));

  /* On-site inventory */
  view.append(inventoryCard(job, placed, rerender), el('div', { class: 'spacer' }));

  /* Equipment days ledger */
  const fin = store.financials(job);
  if (fin.equipment.length) {
    view.append(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h2', { text: 'Equipment days' }),
        el('span', { class: 'chip chip-green', text: `$${fin.equipmentTotal.toFixed(2)}` }),
      ),
      el('div', { class: 'table-scroll' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Type'), el('th', { class: 'num' }, 'Units'), el('th', { class: 'num' }, 'Unit-days'), el('th', { class: 'num' }, 'Rate'), el('th', { class: 'num' }, 'Amount'))),
        el('tbody', {}, ...fin.equipment.map((r) => el('tr', {},
          el('td', {}, r.label),
          el('td', { class: 'num mono' }, String(r.units)),
          el('td', { class: 'num mono' }, String(r.days)),
          el('td', { class: 'num mono' }, `$${r.rate.toFixed(2)}`),
          el('td', { class: 'num mono' }, `$${r.amount.toFixed(2)}`),
        ))),
      )),
      el('div', { class: 'card-body tight' },
        el('p', { class: 'mute tiny', text: 'Any part of a calendar day counts as a billable equipment day, accruing from placement until the unit is marked picked up on the plan.' }),
      ),
    ), el('div', { class: 'spacer' }));
  }

  view.append(el('button', { class: 'btn btn-ghost btn-block btn-sm', onClick: () => exportEquipment(job, plan) }, '⤓ Export equipment sheet'));
}

function compareRow(label, called, on, target, basis) {
  const short = target > 0 && on < target;
  return el('div', { class: 'list-item', style: 'cursor:default' },
    el('div', { class: 'li-main' },
      el('div', { class: 'li-title', text: label }),
      el('div', { class: 'li-sub', style: 'white-space:normal', text: basis }),
    ),
    el('div', { style: 'text-align:right;flex:none' },
      el('div', { class: 'mono', style: 'font-weight:700;font-size:15px', text: String(on) }),
      el('div', { class: 'tiny mute', text: `of ${called}` }),
    ),
    el('span', { class: `chip ${short ? 'chip-amber' : 'chip-green'}`, text: short ? 'Short' : 'OK' }),
  );
}

function sizingCard(cls, rerender) {
  const s = store.state.settings;
  const dehuType = field('Dehumidifier type', {
    type: 'select', value: s.dehuType,
    options: [
      { value: 'lgr', label: 'LGR (low grain refrigerant)' },
      { value: 'conventional', label: 'Conventional refrigerant' },
      { value: 'desiccant', label: 'Desiccant' },
    ],
  });
  dehuType.input.addEventListener('change', async () => { await store.saveSettings({ dehuType: dehuType.input.value }); rerender(); });

  const dehuPints = field('Your unit AHAM rating (pints/day)', { type: 'number', inputmode: 'numeric', value: s.dehuUnitPints, hint: 'AHAM, not the marketing number on the box.' });
  dehuPints.input.addEventListener('change', async () => { await store.saveSettings({ dehuUnitPints: num(dehuPints.input.value, 130) }); rerender(); });

  const scrubberCfm = field('Air scrubber CFM', { type: 'number', inputmode: 'numeric', value: s.scrubberCfm });
  scrubberCfm.input.addEventListener('change', async () => { await store.saveSettings({ scrubberCfm: num(scrubberCfm.input.value, 500) }); rerender(); });

  const containment = field('Containment erected', { type: 'checkbox', value: store.state.job.loss.containment });
  containment.input.addEventListener('change', () => { store.update((j) => { j.loss.containment = containment.input.checked; }); rerender(); });

  const factor = s.dehuType === 'desiccant' ? `${DESICCANT_ACH[cls.class]} ACH` : String(DEHU_FACTORS[s.dehuType]?.[cls.class] ?? 'n/a');

  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', { text: 'Sizing assumptions' }),
      el('span', { class: 'chip chip-blue', text: `Class ${cls.class} factor: ${factor}` }),
    ),
    el('div', { class: 'card-body' },
      dehuType.wrap,
      el('div', { class: 'grid-2' }, dehuPints.wrap, scrubberCfm.wrap),
      containment.wrap,
      el('div', { class: 'note', style: 'margin-top:10px', html: 'Dehumidification is sized by dividing chamber cubic feet by the S500 initial dehumidification factor for the class. Air filtration is sized by air changes per hour driven by the <strong>category</strong>, not the class.' }),
    ),
  );
}

function inventoryCard(job, placed, rerender) {
  const removed = [];
  for (const room of job.rooms) {
    for (const eq of room.equipment || []) {
      if (eq.removedAt) removed.push({ ...eq, roomName: room.name });
    }
  }

  const list = el('div', { class: 'list' });
  if (!placed.items.length && !removed.length) {
    list.append(el('div', { class: 'empty' },
      el('p', { text: 'Nothing placed yet. Drop equipment on the plan, or auto-place air movers around a room perimeter.' }),
    ));
  }
  for (const item of placed.items) {
    const type = store.EQUIPMENT_TYPES.find((t) => t.id === item.type);
    list.append(el('div', { class: 'list-item', style: 'cursor:default' },
      el('span', { style: 'font-size:18px;width:24px', text: type?.icon || '•' }),
      el('div', { class: 'li-main' },
        el('div', { class: 'li-title', text: `${type?.label || item.type}${item.label ? ` · ${item.label}` : ''}` }),
        el('div', { class: 'li-sub', text: `${item.roomName} · placed ${fmtDate(item.placedAt)} ${fmtTime(item.placedAt)}${item.serial ? ` · #${item.serial}` : ''}` }),
      ),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        onClick: () => {
          store.update((j) => {
            const r = j.rooms.find((x) => x.id === item.roomId);
            r.equipment.find((e) => e.id === item.id).removedAt = new Date().toISOString();
          });
          rerender();
          toast('Marked picked up.');
        },
      }, 'Pick up'),
    ));
  }
  for (const item of removed) {
    const type = store.EQUIPMENT_TYPES.find((t) => t.id === item.type);
    list.append(el('div', { class: 'list-item', style: 'cursor:default;opacity:.55' },
      el('span', { style: 'font-size:18px;width:24px', text: type?.icon || '•' }),
      el('div', { class: 'li-main' },
        el('div', { class: 'li-title', text: `${type?.label || item.type}${item.label ? ` · ${item.label}` : ''}` }),
        el('div', { class: 'li-sub', text: `${item.roomName} · ${fmtDate(item.placedAt)} → ${fmtDate(item.removedAt)}` }),
      ),
      el('span', { class: 'chip', text: 'Picked up' }),
    ));
  }

  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', { text: 'On site' }),
      el('span', { class: 'chip chip-blue', text: `${placed.total} unit${placed.total === 1 ? '' : 's'}` }),
    ),
    list,
  );
}

function exportEquipment(job, plan) {
  const placed = store.placedEquipment(job);
  const fin = store.financials(job);
  const rows = [
    [`Equipment sheet — ${job.claim?.insured || ''}`],
    [`Claim ${job.claim?.claimNumber || ''}`],
    [],
    ['Recommended'],
    ['Item', 'Quantity', 'Basis'],
    ['Air movers', `${plan.airMovers.min}-${plan.airMovers.max}`, plan.airMovers.basis],
    ['Dehumidification', plan.dehumidification.unitCount != null ? `${plan.dehumidification.unitCount} units` : `${Math.round(plan.dehumidification.requiredCfm || 0)} CFM`, plan.dehumidification.basis],
    ['Air scrubbers', String(plan.airScrubbers.required), plan.airScrubbers.basis],
    [],
    ['Placed'],
    ['Type', 'Label', 'Serial', 'Room', 'Placed', 'Picked up'],
  ];
  for (const room of job.rooms) {
    for (const eq of room.equipment || []) {
      const type = store.EQUIPMENT_TYPES.find((t) => t.id === eq.type);
      rows.push([type?.label || eq.type, eq.label, eq.serial, room.name, eq.placedAt, eq.removedAt || 'on site']);
    }
  }
  rows.push([], ['Equipment days'], ['Type', 'Units', 'Unit-days', 'Rate', 'Amount']);
  for (const r of fin.equipment) rows.push([r.label, r.units, r.days, r.rate.toFixed(2), r.amount.toFixed(2)]);
  rows.push(['', '', '', 'Total', fin.equipmentTotal.toFixed(2)]);

  download(`${slug(job)}-equipment.csv`, toCsv(rows), 'text/csv');
  toast('Equipment sheet exported.', 'success');
}
