// Moisture map readings: dry standards, goals and the daily round.

import { store } from '../store.js';
import { openForm, card, cardHead, emptyState, pill, stat, confirmDialog } from '../ui.js';
import { MATERIALS, materialById } from '../standards.js';
import { esc, fmtDate, todayISO, toast, csv, download, round } from '../util.js';

function readingDates(job) {
  const set = new Set();
  for (const p of job.plan.pins || []) for (const r of p.readings || []) set.add(r.date);
  return [...set].sort();
}

export default {
  id: 'moisture',
  title: 'Moisture',

  render(ctx) {
    const { job, d } = ctx;
    const pins = d.drying.pins;
    const dates = readingDates(job).slice(-6);

    if (!pins.length) {
      return card(emptyState('💧', 'No monitoring points yet',
        'Open the floor plan, pick the Moisture tool and tap where you took each reading. Points keep their own dry standard, goal and daily history.',
        `<a class="btn btn--primary" href="#/job/${job.id}/plan" style="margin-top:12px">Go to the plan</a>`));
    }

    const rows = pins.map((p) => {
      const cells = dates.map((date) => {
        const r = (p.readings || []).filter((x) => x.date === date).at(-1);
        if (!r) return '<td class="num dim">·</td>';
        const dry = Number(r.value) <= p.goal;
        return `<td class="num" style="color:${dry ? '#86efac' : '#fca5a5'};font-weight:700">${esc(r.value)}</td>`;
      }).join('');
      return `<tr data-edit data-pin="${p.pin.id}">
        <td><strong>${esc(p.pin.label)}</strong><br><span class="tiny">${esc(p.room?.name || 'unassigned')} · ${esc(p.pin.surface)}</span></td>
        <td>${esc(p.material.label)}<br><span class="tiny">goal ≤ ${p.goal} ${esc(p.unit)}</span></td>
        ${cells}
        <td class="num">${p.atGoal ? pill('Dry', 'good') : p.stalled ? pill('Stalled', 'warn') : pill(`${Math.round(p.progress)}%`, 'info')}</td>
      </tr>`;
    }).join('');

    return `
      ${card(`${cardHead('Drying status', pill(`${d.drying.atGoal}/${d.drying.total} at goal`, d.drying.allDry ? 'good' : 'info'))}
        <div class="grid-3">
          ${stat('Points', String(d.drying.total))}
          ${stat('At goal', String(d.drying.atGoal), `${d.drying.pctDry}%`)}
          ${stat('Stalled', String(d.drying.stalled.length), 'no movement')}
        </div>
        <div class="progress ${d.drying.allDry ? 'progress--good' : ''}" style="margin-top:12px"><span style="width:${d.drying.pctDry}%"></span></div>
        <div class="row row--wrap" style="margin-top:12px">
          <button class="btn btn--sm btn--primary" data-round>Log today's round</button>
          <button class="btn btn--sm" data-standards>Set dry standards</button>
          <button class="btn btn--sm" data-export>Export CSV</button>
        </div>
        ${d.drying.allDry ? '<div class="callout callout--good" style="margin-top:10px">All points are at or below goal. Take a final set of readings, then pull equipment.</div>' : ''}
      `)}

      ${card(`${cardHead('Readings', `<span class="tiny">last ${dates.length} day${dates.length === 1 ? '' : 's'}</span>`)}
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>Point</th><th>Material</th>
              ${dates.map((dt) => `<th class="num">${esc(fmtDate(dt).replace(/, \d{4}/, ''))}</th>`).join('')}
              <th class="num">Status</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="tiny" style="margin-top:8px">Tap a row to see the full history for that point.</p>
      `)}

      ${d.drying.stalled.length ? card(`${cardHead('Not moving')}
        <p class="muted">These points have not changed since the previous reading. Check air movement across the surface, look for trapped water behind the assembly, or move to specialty drying.</p>
        <ul class="rationale">${d.drying.stalled.map((p) => `<li><strong>${esc(p.pin.label)}</strong> — ${esc(p.material.label)} in ${esc(p.room?.name || 'unassigned')}, holding at ${esc(p.last?.value ?? '—')} against a goal of ${p.goal}</li>`).join('')}</ul>
      `) : ''}
    `;
  },

  mount(root, ctx) {
    const { job } = ctx;

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-round]')) {
        const pins = ctx.d.drying.pins;
        const res = await openForm({
          title: `Readings — ${fmtDate(todayISO())}`,
          subtitle: 'Blank fields are skipped. Points already at goal show in green.',
          submitLabel: 'Save round',
          fields: pins.map((p) => ({
            k: p.pin.id,
            label: `${p.pin.label} · ${p.room?.name || 'unassigned'} · ${p.material.label}`,
            type: 'number', half: true,
            hint: `goal ≤ ${p.goal} ${p.unit}${p.last ? ` · last ${p.last.value}` : ''}`,
          })),
        });
        if (!res) return;
        let count = 0;
        store.updateJob(job.id, (j) => {
          for (const p of j.plan.pins) {
            const v = res[p.id];
            if (v == null || v === '') continue;
            p.readings = p.readings || [];
            const existing = p.readings.findIndex((r) => r.date === todayISO());
            const entry = { date: todayISO(), value: Number(v), ts: new Date().toISOString() };
            if (existing >= 0) p.readings[existing] = entry; else p.readings.push(entry);
            count++;
          }
        });
        toast(`${count} reading${count === 1 ? '' : 's'} logged`, 'good');
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-standards]')) {
        const pins = ctx.d.drying.pins;
        const res = await openForm({
          title: 'Dry standards',
          subtitle: 'Take a reading of the same material in an unaffected area of the structure. The goal is that value plus your tolerance.',
          fields: pins.map((p) => ({
            k: p.pin.id, label: `${p.pin.label} · ${p.material.label}`, type: 'number', half: true,
            value: p.pin.dryStandard, hint: `currently ${p.goalSource}, goal ≤ ${p.goal}`,
          })),
        });
        if (!res) return;
        store.updateJob(job.id, (j) => {
          for (const p of j.plan.pins) {
            if (res[p.id] !== undefined) p.dryStandard = res[p.id] === '' ? null : res[p.id];
          }
        });
        toast('Dry standards saved', 'good');
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-export]')) {
        const dates = readingDates(job);
        const rows = [['Point', 'Room', 'Surface', 'Material', 'Dry standard', 'Goal', ...dates.map((x) => x)]];
        for (const p of ctx.d.drying.pins) {
          rows.push([
            p.pin.label, p.room?.name || '', p.pin.surface, p.material.label,
            p.pin.dryStandard ?? '', p.goal,
            ...dates.map((dt) => (p.readings.filter((r) => r.date === dt).at(-1)?.value ?? '')),
          ]);
        }
        download(`${job.jobNumber}-moisture.csv`, 'text/csv', csv(rows));
        toast('Exported');
        return;
      }

      const row = e.target.closest('[data-pin]');
      if (row) {
        const p = ctx.d.drying.pins.find((x) => x.pin.id === row.dataset.pin);
        if (!p) return;
        const history = p.readings.map((r) =>
          `<div class="kv"><span>${esc(fmtDate(r.date))}</span><span style="color:${Number(r.value) <= p.goal ? '#86efac' : '#fca5a5'}">${esc(r.value)} ${esc(p.unit)}</span></div>`).join('')
          || '<p class="muted">No readings yet.</p>';
        const res = await openForm({
          title: `Point ${p.pin.label}`,
          subtitle: `${p.material.label} · ${p.room?.name || 'unassigned'} · goal ≤ ${p.goal} ${p.unit} (${p.goalSource})`,
          submitLabel: 'Add reading',
          deleteLabel: 'Delete point',
          fields: [
            { k: 'history', label: 'History', type: 'static', html: history },
            { k: 'value', label: 'New reading', type: 'number', half: true },
            { k: 'date', label: 'Date', type: 'date', value: todayISO(), half: true },
          ],
        });
        if (!res) return;
        if (res.__delete) {
          if (await confirmDialog({ title: 'Delete this point?', message: 'Its reading history goes with it.', confirmLabel: 'Delete', destructive: true })) {
            store.updateJob(job.id, (j) => { j.plan.pins = j.plan.pins.filter((x) => x.id !== p.pin.id); });
            ctx.refresh();
          }
          return;
        }
        if (res.value == null || res.value === '') return;
        store.updateJob(job.id, (j) => {
          const pin = j.plan.pins.find((x) => x.id === p.pin.id);
          pin.readings = pin.readings || [];
          pin.readings.push({ date: res.date || todayISO(), value: Number(res.value), ts: new Date().toISOString() });
        });
        ctx.refresh();
        toast('Reading added', 'good');
      }
    });
  },
};
