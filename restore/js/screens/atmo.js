// Atmospheric monitoring: temperature, RH and the psychrometrics that follow.

import { store } from '../store.js';
import { openForm, card, cardHead, emptyState, pill, stat } from '../ui.js';
import { psychro, ventilationAdvice } from '../psychro.js';
import { esc, fmtDate, fmtTime, todayISO, uid, toast, csv, download, round, nowISO } from '../util.js';
import { catalogById } from '../equipment.js';

const LOCATIONS = [
  { value: 'outside', label: 'Outside' },
  { value: 'unaffected', label: 'Unaffected area' },
  { value: 'affected', label: 'Affected area' },
  { value: 'dehu_inlet', label: 'Dehumidifier inlet' },
  { value: 'dehu_outlet', label: 'Dehumidifier outlet' },
  { value: 'hvac', label: 'HVAC supply' },
  { value: 'chamber', label: 'Drying chamber' },
];
const locLabel = (v) => LOCATIONS.find((l) => l.value === v)?.label || v;

export default {
  id: 'atmo',
  title: 'Psychrometrics',

  render(ctx) {
    const { job, d, settings } = ctx;
    const a = d.atmo;
    const dehus = (job.plan.equipment || []).filter((e) => e.type === 'dehu');

    const vent = a.latestAffected && a.latestOutside
      ? ventilationAdvice(a.latestAffected, a.latestOutside, settings.elevationFt)
      : null;

    const readingRows = a.rows.slice(0, 40).map((r) => `
      <tr data-edit data-row="${r.id}">
        <td>${esc(fmtDate(r.ts))}<br><span class="tiny">${esc(fmtTime(r.ts))}</span></td>
        <td>${esc(locLabel(r.location))}${r.equipmentId ? `<br><span class="tiny">${esc(catalogById((job.plan.equipment.find((e) => e.id === r.equipmentId) || {}).catalogId)?.label || '')}</span>` : ''}</td>
        <td class="num">${round(r.tempF, 1)}°F</td>
        <td class="num">${round(r.rh, 1)}%</td>
        <td class="num">${r.dewPointF != null ? `${round(r.dewPointF, 1)}°F` : '—'}</td>
        <td class="num strong">${r.gpp != null ? round(r.gpp, 1) : '—'}</td>
      </tr>`).join('');

    return `
      ${card(`${cardHead('Current conditions', pill(`target ≤ ${a.target} gpp`, a.onTarget === true ? 'good' : a.onTarget === false ? 'warn' : ''))}
        ${a.rows.length ? `
          <div class="grid-3">
            ${stat('Affected', a.latestAffected ? `${round(a.latestAffected.gpp, 1)} gpp` : '—', a.latestAffected ? `${round(a.latestAffected.tempF)}°F / ${round(a.latestAffected.rh)}% RH` : 'no reading')}
            ${stat('Unaffected', a.latestUnaffected ? `${round(a.latestUnaffected.gpp, 1)} gpp` : '—', a.latestUnaffected ? `${round(a.latestUnaffected.tempF)}°F / ${round(a.latestUnaffected.rh)}% RH` : 'no reading')}
            ${stat('Outside', a.latestOutside ? `${round(a.latestOutside.gpp, 1)} gpp` : '—', a.latestOutside ? `${round(a.latestOutside.tempF)}°F / ${round(a.latestOutside.rh)}% RH` : 'no reading')}
          </div>
          ${vent ? `<div class="callout ${vent.mode === 'open' ? 'callout--good' : ''}" style="margin-top:10px">${esc(vent.text)}</div>` : ''}
          ${a.onTarget === false ? `<div class="callout callout--warn" style="margin-top:10px">The affected area is above the ${a.target} gpp target for a Class ${d.cls} loss. Add dehumidification capacity or check that the chamber is sealed.</div>` : ''}
        ` : '<p class="muted">No readings yet. Log a set on every visit — the grain load is what proves the structure is drying.</p>'}
        <div class="row row--wrap" style="margin-top:12px">
          <button class="btn btn--sm btn--primary" data-log>Log a set of readings</button>
          <button class="btn btn--sm" data-single>Single reading</button>
          ${a.rows.length ? '<button class="btn btn--sm" data-export>Export CSV</button>' : ''}
        </div>
      `)}

      ${a.dehuChecks.length ? card(`${cardHead('Dehumidifier performance')}
        <div class="list">
          ${a.dehuChecks.slice(0, 6).map((c) => `
            <div class="list-item">
              <div class="list-item__icon">${c.verdict === 'ok' ? '✅' : c.verdict === 'watch' ? '⚠️' : '⛔'}</div>
              <div class="list-item__main">
                <strong>${round(c.depression, 1)} grain depression</strong>
                <small>${esc(c.note)}</small>
              </div>
              <div class="list-item__right">${round(c.inlet.gpp, 0)} → ${round(c.outlet.gpp, 0)}<div class="tiny">${esc(fmtDate(c.ts))}</div></div>
            </div>`).join('')}
        </div>
      `) : ''}

      ${a.rows.length ? card(`${cardHead('Log')}
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>When</th><th>Location</th><th class="num">Temp</th><th class="num">RH</th><th class="num">Dew pt</th><th class="num">GPP</th></tr></thead>
            <tbody>${readingRows}</tbody>
          </table>
        </div>
      `) : ''}

      ${card(`${cardHead('What these numbers mean')}
        <p class="muted">Grains per pound is the amount of water actually in the air — it is the only number that tells you whether the dehumidifiers are winning. Relative humidity moves when the temperature moves; the grain load does not. Dew point tells you where condensation will form on cold surfaces.</p>
        <p class="muted" style="margin-top:8px">Take inlet and outlet readings at each dehumidifier. A healthy refrigerant unit pulls 15 grains or more between inlet and outlet with a noticeable temperature rise.</p>
      `, 'card--flat')}
    `;
  },

  mount(root, ctx) {
    const { job, settings } = ctx;
    const dehus = (job.plan.equipment || []).filter((e) => e.type === 'dehu');

    const saveReading = (r) => store.updateJob(job.id, (j) => { j.atmo.push(r); });

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-log]')) {
        const fields = [
          { k: 'ts', label: 'Date & time', type: 'datetime-local', value: new Date().toISOString().slice(0, 16) },
          { k: 'sec1', label: 'Outside', type: 'section' },
          { k: 'out_t', label: 'Temp °F', type: 'number', half: true },
          { k: 'out_rh', label: 'RH %', type: 'number', half: true },
          { k: 'sec2', label: 'Unaffected area', type: 'section' },
          { k: 'un_t', label: 'Temp °F', type: 'number', half: true },
          { k: 'un_rh', label: 'RH %', type: 'number', half: true },
          { k: 'sec3', label: 'Affected area', type: 'section' },
          { k: 'aff_t', label: 'Temp °F', type: 'number', half: true },
          { k: 'aff_rh', label: 'RH %', type: 'number', half: true },
        ];
        for (const [i, eq] of dehus.entries()) {
          const item = catalogById(eq.catalogId);
          fields.push({ k: `d${i}sec`, label: `${item?.label || 'Dehumidifier'}${eq.serial ? ` #${eq.serial}` : ''}`, type: 'section' });
          fields.push({ k: `d${i}_it`, label: 'Inlet temp °F', type: 'number', half: true });
          fields.push({ k: `d${i}_irh`, label: 'Inlet RH %', type: 'number', half: true });
          fields.push({ k: `d${i}_ot`, label: 'Outlet temp °F', type: 'number', half: true });
          fields.push({ k: `d${i}_orh`, label: 'Outlet RH %', type: 'number', half: true });
        }
        const res = await openForm({ title: 'Monitoring readings', subtitle: 'Leave any section blank to skip it.', fields, submitLabel: 'Save readings' });
        if (!res) return;

        const ts = res.ts ? new Date(res.ts).toISOString() : nowISO();
        const add = (location, t, rh, equipmentId = null) => {
          if (t == null || t === '' || rh == null || rh === '') return 0;
          saveReading({ id: uid('atm'), ts, location, tempF: Number(t), rh: Number(rh), equipmentId });
          return 1;
        };
        let n = 0;
        n += add('outside', res.out_t, res.out_rh);
        n += add('unaffected', res.un_t, res.un_rh);
        n += add('affected', res.aff_t, res.aff_rh);
        for (const [i, eq] of dehus.entries()) {
          n += add('dehu_inlet', res[`d${i}_it`], res[`d${i}_irh`], eq.id);
          n += add('dehu_outlet', res[`d${i}_ot`], res[`d${i}_orh`], eq.id);
        }
        toast(`${n} reading${n === 1 ? '' : 's'} saved`, 'good');
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-single]')) {
        const res = await openForm({
          title: 'Single reading',
          fields: [
            { k: 'location', label: 'Location', type: 'select', options: LOCATIONS, value: 'affected' },
            { k: 'tempF', label: 'Temp °F', type: 'number', half: true, required: true },
            { k: 'rh', label: 'RH %', type: 'number', half: true, required: true },
            { k: 'ts', label: 'Date & time', type: 'datetime-local', value: new Date().toISOString().slice(0, 16) },
            { k: 'note', label: 'Note', type: 'text' },
          ],
        });
        if (!res) return;
        const p = psychro(Number(res.tempF), Number(res.rh), settings.elevationFt);
        saveReading({
          id: uid('atm'), ts: res.ts ? new Date(res.ts).toISOString() : nowISO(),
          location: res.location, tempF: Number(res.tempF), rh: Number(res.rh), note: res.note,
        });
        toast(`${round(p.gpp, 1)} gpp · dew point ${round(p.dewPointF, 1)}°F`, 'good');
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-export]')) {
        const rows = [['Timestamp', 'Location', 'Temp F', 'RH %', 'Dew point F', 'GPP', 'Vapor pressure inHg']];
        for (const r of ctx.d.atmo.rows) {
          rows.push([r.ts, locLabel(r.location), r.tempF, r.rh, round(r.dewPointF, 1), round(r.gpp, 1), round(r.vpInHg, 3)]);
        }
        download(`${job.jobNumber}-psychrometrics.csv`, 'text/csv', csv(rows));
        toast('Exported');
        return;
      }

      const rowEl = e.target.closest('[data-row]');
      if (rowEl) {
        const r = ctx.d.atmo.rows.find((x) => x.id === rowEl.dataset.row);
        if (!r) return;
        const res = await openForm({
          title: locLabel(r.location),
          subtitle: `${round(r.gpp, 1)} gpp · dew point ${round(r.dewPointF, 1)}°F`,
          deleteLabel: 'Delete reading',
          fields: [
            { k: 'tempF', label: 'Temp °F', type: 'number', value: r.tempF, half: true },
            { k: 'rh', label: 'RH %', type: 'number', value: r.rh, half: true },
            { k: 'location', label: 'Location', type: 'select', value: r.location, options: LOCATIONS },
          ],
        });
        if (!res) return;
        store.updateJob(job.id, (j) => {
          if (res.__delete) { j.atmo = j.atmo.filter((x) => x.id !== r.id); return; }
          const target = j.atmo.find((x) => x.id === r.id);
          Object.assign(target, { tempF: Number(res.tempF), rh: Number(res.rh), location: res.location });
        });
        ctx.refresh();
      }
    });
  },
};
