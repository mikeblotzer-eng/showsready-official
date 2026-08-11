// Drying system: what the loss calls for, what is actually on site.

import { store } from '../store.js';
import { openForm, card, cardHead, emptyState, pill, stat, actionSheet, confirmDialog } from '../ui.js';
import { CATALOG, EQUIPMENT_TYPES, catalogById, DEHU_FACTORS } from '../equipment.js';
import { esc, fmtDate, money, toast, uid, round } from '../util.js';

export default {
  id: 'equipment',
  title: 'Equipment',

  render(ctx) {
    const { job, d, settings } = ctx;
    const rec = d.rec;
    const dep = d.deployed;

    const placedAM = dep.list.filter((r) => r.eq.type === 'air_mover' && r.active).length;
    const placedDehuPints = dep.list
      .filter((r) => r.eq.type === 'dehu' && r.active)
      .reduce((t, r) => t + (r.item?.aham || 0), 0);
    const placedAfd = dep.list.filter((r) => r.eq.type === 'afd' && r.active).length;

    const gap = (have, need) => have >= need
      ? pill('met', 'good')
      : pill(`short ${round(need - have, 0)}`, 'bad');

    return `
      ${card(`${cardHead(`Recommended for Class ${d.cls}`, pill(`${settings.dehuKind === 'lgr' ? 'LGR' : settings.dehuKind === 'desiccant' ? 'Desiccant' : 'Conventional'}`, 'purple'))}
        <div class="grid-3">
          ${stat('Air movers', String(rec.airMovers), `${placedAM} placed`)}
          ${stat('Dehu pints/day', String(rec.ppdRequired || rec.desiccantCfm), rec.ppdRequired ? `${placedDehuPints} AHAM placed` : 'CFM of process air')}
          ${stat('Air scrubbers', String(rec.afdQty), rec.afdQty ? `${placedAfd} placed` : 'not required')}
        </div>
        <div class="row row--wrap" style="margin-top:10px">
          ${gap(placedAM, rec.airMovers)} ${rec.ppdRequired ? gap(placedDehuPints, rec.ppdRequired) : ''} ${rec.afdQty ? gap(placedAfd, rec.afdQty) : ''}
        </div>
        <ul class="rationale">${rec.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        ${rec.dehus.length ? `<p class="muted" style="margin-top:8px"><strong>Suggested units:</strong> ${rec.dehus.map((x) => `${x.qty} × ${esc(x.item.label)}`).join(', ')}</p>` : ''}
        ${rec.specialty.length ? `<div class="callout callout--warn" style="margin-top:10px">Class 4 — plan on ${rec.specialty.map((s) => esc(s.label)).join(' and ')}. Bound water will not come out with airflow alone.</div>` : ''}
        <div class="callout" style="margin-top:10px">Estimated load ${rec.amps} amps — about ${rec.circuits} dedicated 15A circuit${rec.circuits === 1 ? '' : 's'}. Confirm the panel can carry it before you plug in.</div>
        <div class="row row--wrap" style="margin-top:12px">
          <button class="btn btn--sm btn--primary" data-deploy>Add recommended units</button>
          <button class="btn btn--sm" data-dehukind>Change dehu type</button>
          <a class="btn btn--sm" href="#/job/${job.id}/plan">Place on the plan</a>
        </div>
      `)}

      ${rec.perRoom.length ? card(`${cardHead('Air movers by room')}
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Room</th><th class="num">Units</th><th>Basis</th></tr></thead>
          <tbody>${rec.perRoom.map((r) => `<tr>
            <td>${esc(r.room.name)}<br><span class="tiny">${round(r.floor)} sf · ${round(r.volume)} cf</span></td>
            <td class="num strong">${r.airMovers}</td>
            <td><span class="tiny">${r.notes.length ? esc(r.notes.join(' · ')) : 'not affected'}</span></td>
          </tr>`).join('')}</tbody>
        </table></div>
      `) : ''}

      ${card(`${cardHead('On site', `<span class="tiny">${dep.active} running</span>`)}
        ${dep.list.length ? `<div class="list">${dep.list.map((r) => `
          <button class="list-item" data-eq="${r.eq.id}">
            <div class="list-item__icon" style="color:${EQUIPMENT_TYPES[r.eq.type]?.color}">${EQUIPMENT_TYPES[r.eq.type]?.icon || '•'}</div>
            <div class="list-item__main">
              <strong>${esc(r.item?.label || 'Unit')}</strong>
              <small>${r.eq.serial ? `#${esc(r.eq.serial)} · ` : ''}${esc((job.plan.rooms.find((x) => x.id === r.eq.roomId) || {}).name || 'unassigned')} · placed ${esc(fmtDate(r.eq.placedAt))}</small>
            </div>
            <div class="list-item__right">${r.days} day${r.days === 1 ? '' : 's'}<div class="tiny">${r.active ? money((r.item?.rate || 0) * r.days, { cents: false }) : 'pulled'}</div></div>
          </button>`).join('')}</div>`
          : emptyState('🔌', 'Nothing deployed yet', 'Add the recommended units, then drop them on the plan so the report shows where each one sat.')}
        <div class="row row--wrap" style="margin-top:12px">
          <button class="btn btn--sm" data-add>Add a unit</button>
          ${dep.active ? '<button class="btn btn--sm" data-pull-all>Pull all equipment</button>' : ''}
        </div>
      `)}

      ${card(`${cardHead('How this was sized')}
        <p class="muted">Air movers: one per ${14} linear feet of wet wall, or one per ${{ 1: 70, 2: 60, 3: 50, 4: 50 }[d.cls]} square feet of wet floor for a Class ${d.cls} loss, whichever is greater, plus one for each offset, closet and stairwell.</p>
        <p class="muted" style="margin-top:8px">Dehumidification: affected volume divided by ${rec.factor} cubic feet per pint — the ${settings.dehuKind === 'lgr' ? 'LGR' : 'conventional refrigerant'} factor for a Class ${d.cls} loss — giving the AHAM pints per day the job needs.</p>
        <p class="muted" style="margin-top:8px">These are starting points. Conditions on site win; change the counts and note why in the daily log.</p>
      `, 'card--flat')}
    `;
  },

  mount(root, ctx) {
    const { job, d } = ctx;

    const place = (catalogId, qty) => {
      store.updateJob(job.id, (j) => {
        const item = catalogById(catalogId);
        for (let i = 0; i < qty; i++) {
          j.plan.equipment.push({
            id: uid('eq'), catalogId, type: item.type, roomId: null,
            x: 0, y: 0, rot: 0, serial: '',
            placedAt: new Date().toISOString(), removedAt: null,
          });
        }
      });
    };

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-deploy]')) {
        const rec = d.rec;
        const res = await openForm({
          title: 'Add recommended units',
          subtitle: 'Adjust the counts to match the truck. Units land at the origin of the plan — drag them into place on the Plan tab.',
          submitLabel: 'Add to job',
          fields: [
            { k: 'am', label: 'Air movers', type: 'number', value: rec.airMovers, half: true },
            ...rec.dehus.map((x, i) => ({ k: `dehu${i}`, label: x.item.label, type: 'number', value: x.qty, half: true })),
            { k: 'afd', label: 'Air scrubbers', type: 'number', value: rec.afdQty, half: true },
            ...(rec.specialty || []).map((s, i) => ({ k: `spec${i}`, label: s.label, type: 'number', value: 0, half: true })),
          ],
        });
        if (!res) return;
        if (res.am > 0) place('am_axial', res.am);
        d.rec.dehus.forEach((x, i) => { if (res[`dehu${i}`] > 0) place(x.item.id, res[`dehu${i}`]); });
        if (res.afd > 0) place(d.rec.afdUnit.id, res.afd);
        (d.rec.specialty || []).forEach((s, i) => { if (res[`spec${i}`] > 0) place(s.id, res[`spec${i}`]); });
        toast('Equipment added — place it on the plan', 'good');
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-dehukind]')) {
        const choice = await actionSheet({
          title: 'Dehumidification type',
          actions: [
            { id: 'lgr', label: 'LGR refrigerant', hint: 'Standard for most structural drying' },
            { id: 'conventional', label: 'Conventional refrigerant', hint: 'Warmer, wetter conditions' },
            { id: 'desiccant', label: 'Desiccant', hint: 'Cold conditions, bound water, Class 4' },
          ],
        });
        if (choice) { store.saveSettings({ dehuKind: choice }); ctx.refresh(); }
        return;
      }

      if (e.target.closest('[data-add]')) {
        const choice = await actionSheet({
          title: 'Add equipment',
          actions: CATALOG.map((c) => ({
            id: c.id, icon: EQUIPMENT_TYPES[c.type]?.icon || '•', label: c.label,
            hint: `${c.aham ? `${c.aham} AHAM · ` : ''}${c.cfm ? `${c.cfm} CFM · ` : ''}$${c.rate}/day`,
          })),
        });
        if (!choice) return;
        const res = await openForm({
          title: catalogById(choice).label, size: 'sm',
          fields: [{ k: 'qty', label: 'How many?', type: 'number', value: 1, min: 1 }],
        });
        if (!res) return;
        place(choice, Math.max(1, Number(res.qty) || 1));
        toast('Added');
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-pull-all]')) {
        if (!await confirmDialog({
          title: 'Pull all equipment?',
          message: 'Every running unit gets stamped with today as its removal date. Billing stops there.',
          confirmLabel: 'Pull all',
        })) return;
        store.updateJob(job.id, (j) => {
          for (const eq of j.plan.equipment) if (!eq.removedAt) eq.removedAt = new Date().toISOString();
        });
        toast('Equipment pulled', 'good');
        ctx.refresh();
        return;
      }

      const eqBtn = e.target.closest('[data-eq]');
      if (eqBtn) {
        const row = d.deployed.list.find((r) => r.eq.id === eqBtn.dataset.eq);
        if (!row) return;
        const res = await openForm({
          title: row.item?.label || 'Unit',
          subtitle: `${row.days} day${row.days === 1 ? '' : 's'} on the job · ${money((row.item?.rate || 0) * row.days)}`,
          deleteLabel: 'Delete from job',
          fields: [
            { k: 'serial', label: 'Asset / serial number', type: 'text', value: row.eq.serial, half: true },
            { k: 'roomId', label: 'Room', type: 'select', value: row.eq.roomId || '', half: true, options: [{ value: '', label: 'Unassigned' }, ...job.plan.rooms.map((r) => ({ value: r.id, label: r.name }))] },
            { k: 'placedAt', label: 'Placed', type: 'datetime-local', value: (row.eq.placedAt || '').slice(0, 16), half: true },
            { k: 'removedAt', label: 'Removed', type: 'datetime-local', value: (row.eq.removedAt || '').slice(0, 16), half: true },
          ],
        });
        if (!res) return;
        store.updateJob(job.id, (j) => {
          if (res.__delete) { j.plan.equipment = j.plan.equipment.filter((x) => x.id !== row.eq.id); return; }
          const eq = j.plan.equipment.find((x) => x.id === row.eq.id);
          Object.assign(eq, {
            serial: res.serial, roomId: res.roomId || null,
            placedAt: res.placedAt ? new Date(res.placedAt).toISOString() : eq.placedAt,
            removedAt: res.removedAt ? new Date(res.removedAt).toISOString() : null,
          });
        });
        ctx.refresh();
      }
    });
  },
};
