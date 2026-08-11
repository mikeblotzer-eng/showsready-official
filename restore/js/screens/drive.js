// Mileage: GPS-tracked or typed, billed to the job at the configured rate.

import { store } from '../store.js';
import { openForm, card, cardHead, emptyState, pill, stat, confirmDialog } from '../ui.js';
import { esc, fmtDate, fmtTime, todayISO, uid, toast, money, round, haversineMiles, csv, download, nowISO } from '../util.js';

const PURPOSES = [
  { value: 'to_site', label: 'To the loss site' },
  { value: 'from_site', label: 'Return from site' },
  { value: 'supply_run', label: 'Supply run' },
  { value: 'equipment', label: 'Equipment pickup / drop' },
  { value: 'inspection', label: 'Inspection' },
  { value: 'other', label: 'Other' },
];

let tracker = null; // { watchId, points, miles, startedAt, purpose }

function trackerCard(job, settings) {
  if (!tracker) {
    return `<div class="row row--wrap">
      <button class="btn btn--primary" data-track-start>Start GPS trip</button>
      <button class="btn" data-manual>Enter miles</button>
    </div>
    <p class="tiny" style="margin-top:8px">GPS tracking runs while this screen is open. For long drives, log the odometer instead — it survives a locked phone.</p>`;
  }
  return `<div class="callout callout--good">
      <strong>Tracking — ${round(tracker.miles, 1)} mi</strong><br>
      Started ${esc(fmtTime(tracker.startedAt))} · ${tracker.points.length} GPS fixes
    </div>
    <div class="row row--wrap" style="margin-top:10px">
      <button class="btn btn--primary" data-track-stop>Stop & save</button>
      <button class="btn btn--ghost" data-track-cancel>Discard</button>
    </div>`;
}

export default {
  id: 'drive',
  title: 'Mileage',

  render(ctx) {
    const { job, d, settings } = ctx;
    const trips = [...(job.trips || [])].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const billableMiles = round(trips.filter((t) => t.billable).reduce((s, t) => s + (Number(t.miles) || 0), 0), 1);

    return `
      ${card(`${cardHead('Trips', pill(`$${settings.mileageRate}/mi`, 'info'))}
        <div class="grid-3">
          ${stat('Total miles', String(d.money.miles))}
          ${stat('Billable', String(billableMiles), money(d.money.mileageBillable, { cents: false }))}
          ${stat('Trips', String(trips.length))}
        </div>
        <div style="margin-top:12px">${trackerCard(job, settings)}</div>
      `)}

      ${card(`${cardHead('Navigate')}
        ${job.site.address ? `
          <p class="muted">${esc([job.site.address, job.site.city, job.site.state, job.site.zip].filter(Boolean).join(', '))}</p>
          <div class="row row--wrap" style="margin-top:10px">
            <a class="btn btn--sm btn--primary" target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent([job.site.address, job.site.city, job.site.state, job.site.zip].filter(Boolean).join(' '))}">Open in Maps</a>
            <a class="btn btn--sm" target="_blank" rel="noopener" href="https://maps.apple.com/?daddr=${encodeURIComponent([job.site.address, job.site.city, job.site.state].filter(Boolean).join(' '))}">Apple Maps</a>
          </div>`
        : '<p class="muted">Add the site address on the Overview tab to get one-tap navigation.</p>'}
      `)}

      ${card(`${cardHead('Log', trips.length ? '<button class="btn btn--sm" data-export>Export</button>' : '')}
        ${trips.length ? `<div class="list">${trips.map((t) => `
          <button class="list-item" data-trip="${t.id}">
            <div class="list-item__icon">${t.gps ? '📍' : '🚚'}</div>
            <div class="list-item__main">
              <strong>${esc((PURPOSES.find((p) => p.value === t.purpose) || {}).label || 'Trip')}</strong>
              <small>${esc(fmtDate(t.dateISO))}${t.vehicle ? ` · ${esc(t.vehicle)}` : ''}${t.billable ? '' : ' · not billable'}</small>
            </div>
            <div class="list-item__right">${round(t.miles, 1)} mi<div class="tiny">${t.billable ? money((Number(t.miles) || 0) * ctx.settings.mileageRate, { cents: false }) : '—'}</div></div>
          </button>`).join('')}</div>`
          : emptyState('🚚', 'No trips logged', 'Mileage is real money on a restoration job. Log it as you drive and it lands on the estimate automatically.')}
      `)}
    `;
  },

  mount(root, ctx) {
    const { job, settings } = ctx;

    const saveTrip = (trip) => {
      store.updateJob(job.id, (j) => { j.trips.push({ id: uid('trip'), ts: nowISO(), ...trip }); });
    };

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-track-start]')) {
        if (!navigator.geolocation) return toast('This device has no GPS available', 'bad');
        const res = await openForm({
          title: 'Start trip', size: 'sm',
          submitLabel: 'Start tracking',
          fields: [
            { k: 'purpose', label: 'Purpose', type: 'select', options: PURPOSES, value: 'to_site' },
            { k: 'vehicle', label: 'Vehicle', type: 'text', value: settings.vehicle || '' },
          ],
        });
        if (!res) return;
        tracker = { points: [], miles: 0, startedAt: nowISO(), purpose: res.purpose, vehicle: res.vehicle, watchId: null };
        tracker.watchId = navigator.geolocation.watchPosition(
          (pos) => {
            const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: Date.now() };
            const prev = tracker.points.at(-1);
            if (prev) {
              const step = haversineMiles(prev, p);
              // ignore GPS jitter while parked
              if (step > 0.01 && step < 5) tracker.miles += step;
            }
            tracker.points.push(p);
            ctx.refresh();
          },
          (err) => { toast(`GPS: ${err.message}`, 'bad'); },
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
        );
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-track-stop]')) {
        if (!tracker) return;
        navigator.geolocation.clearWatch(tracker.watchId);
        const miles = round(tracker.miles, 1);
        const t = tracker; tracker = null;
        const res = await openForm({
          title: 'Save trip', size: 'sm',
          fields: [
            { k: 'miles', label: 'Miles', type: 'number', value: miles, required: true },
            { k: 'purpose', label: 'Purpose', type: 'select', options: PURPOSES, value: t.purpose },
            { k: 'billable', label: 'Bill to this job', type: 'checkbox', value: true },
            { k: 'notes', label: 'Notes', type: 'text' },
          ],
        });
        if (res) {
          saveTrip({
            dateISO: todayISO(), miles: Number(res.miles), purpose: res.purpose,
            billable: res.billable, notes: res.notes, vehicle: t.vehicle, gps: true,
            path: t.points.map((p) => [round(p.lat, 5), round(p.lng, 5)]),
          });
          toast(`${res.miles} mi logged`, 'good');
        }
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-track-cancel]')) {
        if (tracker) navigator.geolocation.clearWatch(tracker.watchId);
        tracker = null;
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-manual]')) {
        const res = await openForm({
          title: 'Log miles',
          fields: [
            { k: 'dateISO', label: 'Date', type: 'date', value: todayISO(), half: true },
            { k: 'miles', label: 'Miles', type: 'number', required: true, half: true },
            { k: 'purpose', label: 'Purpose', type: 'select', options: PURPOSES, value: 'to_site' },
            { k: 'vehicle', label: 'Vehicle', type: 'text', value: settings.vehicle || '', half: true },
            { k: 'billable', label: 'Bill to this job', type: 'checkbox', value: true },
            { k: 'notes', label: 'Notes', type: 'text' },
          ],
        });
        if (!res) return;
        saveTrip({ ...res, miles: Number(res.miles), gps: false });
        toast('Trip logged', 'good');
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-export]')) {
        const rows = [['Date', 'Purpose', 'Miles', 'Billable', 'Rate', 'Amount', 'Vehicle', 'Notes']];
        for (const t of job.trips) {
          rows.push([t.dateISO, (PURPOSES.find((p) => p.value === t.purpose) || {}).label || '', t.miles,
            t.billable ? 'Y' : 'N', settings.mileageRate,
            round((Number(t.miles) || 0) * (t.billable ? settings.mileageRate : 0), 2), t.vehicle || '', t.notes || '']);
        }
        download(`${job.jobNumber}-mileage.csv`, 'text/csv', csv(rows));
        toast('Exported');
        return;
      }

      const tripEl = e.target.closest('[data-trip]');
      if (tripEl) {
        const t = job.trips.find((x) => x.id === tripEl.dataset.trip);
        if (!t) return;
        const res = await openForm({
          title: 'Trip',
          subtitle: t.gps ? `${(t.path || []).length} GPS fixes recorded` : 'Entered by hand',
          deleteLabel: 'Delete trip',
          fields: [
            { k: 'dateISO', label: 'Date', type: 'date', value: t.dateISO, half: true },
            { k: 'miles', label: 'Miles', type: 'number', value: t.miles, half: true },
            { k: 'purpose', label: 'Purpose', type: 'select', options: PURPOSES, value: t.purpose },
            { k: 'billable', label: 'Bill to this job', type: 'checkbox', value: t.billable },
            { k: 'notes', label: 'Notes', type: 'text', value: t.notes },
          ],
        });
        if (!res) return;
        store.updateJob(job.id, (j) => {
          if (res.__delete) { j.trips = j.trips.filter((x) => x.id !== t.id); return; }
          Object.assign(j.trips.find((x) => x.id === t.id), { ...res, miles: Number(res.miles) });
        });
        ctx.refresh();
      }
    });
  },

  unmount() {
    if (tracker) { navigator.geolocation.clearWatch(tracker.watchId); tracker = null; }
  },
};
