/**
 * Monitoring round.
 *
 * Built around the way the work actually goes: you walk the chamber once with
 * a meter, and every point gets a number. So the default screen is one input
 * per point and a single save, not a form per reading.
 */

import * as store from '../store.js';
import { esc, onAct, formSheet, toast, sheet, statCard, flagList, sectionHeader, emptyState } from '../ui.js';
import { uid, nowIso, num, round, fmtDateTime, fmtDate, toCsv, sum } from '../util.js';
import { psychroSet, dehuPerformance, gpp } from '../psychro.js';
import { MATERIAL_DEFAULTS, dryingTrend } from '../iicrc.js';
import { pointStatuses, dryingSummary, environment, latestAmbient, grainDepression } from '../jobcalc.js';

const AMBIENT_LOCATIONS = [
  { value: 'inside', label: 'Chamber' },
  { value: 'unaffected', label: 'Unaffected' },
  { value: 'outside', label: 'Outside' },
  { value: 'dehu_in', label: 'Dehu intake' },
  { value: 'dehu_out', label: 'Dehu outlet' },
  { value: 'hvac', label: 'HVAC supply' },
];

export async function render(ctx) {
  const job = ctx.job;
  const drying = dryingSummary(job);
  const env = environment(job);
  const depression = grainDepression(job);
  const statuses = drying.statuses;

  const html = `
    <div class="stat-grid">
      ${statCard('Dry', drying.counts.dry, `of ${drying.monitored}`, 'dry')}
      ${statCard('Close', drying.counts.near, 'within tolerance', 'near')}
      ${statCard('Wet', drying.counts.wet, 'above goal', 'wet')}
      ${statCard('Progress', `${drying.pctDry}%`, 'points dry', 'brand')}
    </div>

    ${sectionHeader('Atmospheric', `<button class="btn btn-sm btn-primary" data-act="ambient">+ Reading</button>`)}
    <div class="card">
      ${env ? `
        <div class="card-row"><span class="label">Chamber</span><span class="value">
          ${round(env.inside.tempF)} °F · ${round(env.inside.rh)}% RH<br>
          <span class="tiny muted">${round(env.inside.gpp)} gpp · dew point ${round(env.inside.dewPointF)} °F</span></span></div>
        ${env.unaffected ? ambientRow('Unaffected', env.unaffected) : ''}
        ${env.outside ? ambientRow('Outside', env.outside) : ''}
        ${depression != null ? `<div class="card-row"><span class="label">Grain depression</span>
          <span class="value" style="color:${depression >= 10 ? 'var(--dry)' : 'var(--wet)'}">${round(depression)} gpp</span></div>` : ''}
        <div class="mt">${flagList(env.flags)}</div>
      ` : `<p class="muted small">No atmospheric readings yet. Log the chamber, an unaffected area and outside — the comparison is what proves the chamber is working.</p>`}
      <div class="btn-row mt">
        <button class="btn btn-sm" data-act="dehu-check">Dehu performance check</button>
        <button class="btn btn-sm" data-act="ambient-history">History</button>
      </div>
    </div>

    ${sectionHeader('Monitoring round', statuses.length
      ? `<button class="btn btn-sm btn-primary" data-act="save-round">Save round</button>` : '')}

    ${statuses.length ? `
      <div class="card">
        <p class="tiny muted mb">Enter what the meter reads at each point, then save the whole round at once.</p>
        ${statuses.map(readingRow).join('')}
        <button class="btn btn-primary btn-block mt" data-act="save-round">Save round</button>
      </div>

      ${sectionHeader('Points')}
      ${statuses.map(pointCard).join('')}
    ` : emptyState(
      'No monitoring points',
      'Place points on the floor plan where you take readings — wet materials, the far edge of the affected area, and an unaffected area for the dry standard.',
      `<button class="btn btn-primary" data-act="go-plan">Open floor plan</button>`,
    )}

    ${statuses.length ? `<div class="btn-row mt">
      <button class="btn btn-sm" data-act="export-csv">Export readings CSV</button>
    </div>` : ''}`;

  return {
    title: 'Readings',
    subtitle: job.client?.name,
    back: `#/job/${job.id}`,
    html,
    mount: (root) => {
      onAct(root, {
        ambient: () => ambientSheet(ctx),
        'ambient-history': () => ambientHistory(ctx),
        'dehu-check': () => dehuCheck(ctx),
        'save-round': () => saveRound(ctx, root),
        'go-plan': () => ctx.navigate(`#/job/${job.id}/plan`),
        point: (el) => pointDetail(ctx, el.dataset.id),
        'export-csv': () => exportReadings(ctx),
      });

      // Enter on a reading input jumps to the next one — keeps the round moving.
      root.querySelectorAll('.reading-input').forEach((input, i, all) => {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            all[i + 1] ? all[i + 1].focus() : saveRound(ctx, root);
          }
        });
      });
    },
  };
}

const ambientRow = (label, set) => `
  <div class="card-row"><span class="label">${esc(label)}</span><span class="value">
    ${round(set.tempF)} °F · ${round(set.rh)}% RH<br><span class="tiny muted">${round(set.gpp)} gpp</span></span></div>`;

function readingRow(s) {
  const material = MATERIAL_DEFAULTS.find((m) => m.id === s.point.material);
  return `
    <div class="reading-row">
      <div class="grow">
        <strong>${esc(s.point.label || 'Point')}</strong>
        <span class="tiny muted" style="display:block">${esc(material?.label || '')}${s.standard != null ? ` · dry at ${s.standard}` : ''}</span>
      </div>
      <span class="chip chip-${s.status === 'unknown' ? '' : s.status}">${s.latest?.reading != null ? round(s.latest.reading) : '—'}</span>
      <input class="reading-input" type="number" inputmode="decimal" step="any"
        data-point="${esc(s.point.id)}" placeholder="—" aria-label="Reading for ${esc(s.point.label || 'point')}">
    </div>`;
}

function pointCard(s) {
  const material = MATERIAL_DEFAULTS.find((m) => m.id === s.point.material);
  return `
    <button class="list-item" data-act="point" data-id="${esc(s.point.id)}">
      <span class="status-dot" style="background:var(--${s.status === 'unknown' ? 'text-faint' : s.status})"></span>
      <span class="grow">
        <span class="title">${esc(s.point.label || 'Point')} · ${esc(material?.label || '')}</span>
        <span class="meta">
          ${s.latest ? `${round(s.latest.reading)} ${esc(material?.unit || '')} · ${fmtDate(s.latest.at)}` : 'No readings yet'}
          ${s.standard != null ? ` · goal ${round(s.goal)}` : ''}
        </span>
        ${s.readings.length > 1 ? `<span class="trend trend-${s.trend.direction}">
          ${trendLabel(s.trend)}</span>` : ''}
      </span>
      ${sparkline(s.readings, s.standard)}
      <span class="chev">›</span>
    </button>`;
}

function trendLabel(trend) {
  const rate = Math.abs(round(trend.perDay, 1));
  switch (trend.direction) {
    case 'drying': return `Drying ${rate}/day`;
    case 'slow': return `Slow — ${rate}/day`;
    case 'stalled': return 'Stalled — change the approach';
    case 'rewetting': return `Re-wetting ${rate}/day`;
    default: return '';
  }
}

/** Tiny inline trend chart. No library, no network. */
function sparkline(readings, standard, w = 56, h = 26) {
  const series = readings.filter((r) => isFinite(r.reading)).sort((a, b) => new Date(a.at) - new Date(b.at));
  if (series.length < 2) return '';
  const values = series.map((r) => r.reading);
  const lo = Math.min(...values, standard ?? Infinity);
  const hi = Math.max(...values, standard ?? -Infinity);
  const span = hi - lo || 1;
  const pts = series.map((r, i) => {
    const x = (i / (series.length - 1)) * (w - 2) + 1;
    const y = h - 2 - ((r.reading - lo) / span) * (h - 4);
    return `${round(x, 1)},${round(y, 1)}`;
  }).join(' ');
  const goalY = standard != null ? h - 2 - ((standard - lo) / span) * (h - 4) : null;
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" style="width:${w}px;flex:0 0 ${w}px">
      ${goalY != null ? `<line x1="0" y1="${round(goalY, 1)}" x2="${w}" y2="${round(goalY, 1)}" stroke="var(--dry)" stroke-width="1" stroke-dasharray="2 2" opacity=".7"/>` : ''}
      <polyline points="${pts}" fill="none" stroke="var(--brand)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

/* ------------------------------------------------------------------ */

async function saveRound(ctx, root) {
  const inputs = [...root.querySelectorAll('.reading-input')].filter((i) => i.value !== '');
  if (!inputs.length) return toast('Nothing entered yet.', 'warn');

  const at = nowIso();
  await ctx.save((job) => {
    for (const input of inputs) {
      const point = job.monitoringPoints.find((p) => p.id === input.dataset.point);
      job.readings.push({
        id: uid('rd'), pointId: input.dataset.point, at,
        reading: num(input.value),
        method: MATERIAL_DEFAULTS.find((m) => m.id === point?.material)?.meter || 'pin',
        by: ctx.settings.techName || '',
      });
    }
  });
  toast(`${inputs.length} reading${inputs.length === 1 ? '' : 's'} saved.`, 'success');
  ctx.refresh();
}

async function ambientSheet(ctx) {
  const last = latestAmbient(ctx.job, 'inside');
  const values = await formSheet({
    title: 'Atmospheric reading',
    intro: 'Grains, dew point and enthalpy are computed for you, corrected for site elevation.',
    fields: [
      { name: 'location', label: 'Where', type: 'select', full: true, value: 'inside', options: AMBIENT_LOCATIONS },
      { name: 'tempF', label: 'Temperature (°F)', type: 'number', required: true, value: last?.tempF },
      { name: 'rh', label: 'Relative humidity (%)', type: 'number', required: true, min: 0, max: 100, value: last?.rh },
      { name: 'note', label: 'Note', type: 'text', full: true },
    ],
  });
  if (!values || values.tempF == null || values.rh == null) return;

  const set = psychroSet(values.tempF, values.rh, num(ctx.job.elevationFt, 0));
  await ctx.save((job) => {
    job.ambientReadings.push({
      id: uid('amb'), at: nowIso(), location: values.location,
      tempF: values.tempF, rh: values.rh, note: values.note || '',
      gpp: round(set.gpp, 1), dewPointF: round(set.dewPointF, 1), by: ctx.settings.techName || '',
    });
  });
  toast(`Logged: ${round(set.gpp)} gpp, dew point ${round(set.dewPointF)} °F.`, 'success');
  ctx.refresh();
}

async function ambientHistory(ctx) {
  const rows = [...(ctx.job.ambientReadings || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
  await sheet({
    title: 'Atmospheric history',
    size: 'full',
    body: rows.length ? `<div class="table-scroll"><table class="data">
        <thead><tr><th>When</th><th>Where</th><th class="num">°F</th><th class="num">%RH</th><th class="num">gpp</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(fmtDateTime(r.at))}</td>
          <td>${esc(AMBIENT_LOCATIONS.find((l) => l.value === r.location)?.label || r.location)}</td>
          <td class="num">${round(r.tempF)}</td><td class="num">${round(r.rh)}</td>
          <td class="num">${round(r.gpp ?? gpp(r.tempF, r.rh, num(ctx.job.elevationFt, 0)))}</td>
        </tr>`).join('')}</tbody></table></div>`
      : '<p class="muted small">No atmospheric readings yet.</p>',
    actions: [{ label: 'Done', variant: 'primary', value: true }],
  });
}

async function dehuCheck(ctx) {
  const values = await formSheet({
    title: 'Dehumidifier performance',
    intro: 'Read the intake and the outlet. A healthy unit shows a real grain depression across the coil.',
    submitLabel: 'Check',
    fields: [
      { name: 'inTempF', label: 'Intake °F', type: 'number', required: true },
      { name: 'inRh', label: 'Intake %RH', type: 'number', required: true },
      { name: 'outTempF', label: 'Outlet °F', type: 'number', required: true },
      { name: 'outRh', label: 'Outlet %RH', type: 'number', required: true },
    ],
  });
  if (!values || [values.inTempF, values.inRh, values.outTempF, values.outRh].some((v) => v == null)) return;

  const result = dehuPerformance(values.inTempF, values.inRh, values.outTempF, values.outRh, num(ctx.job.elevationFt, 0));
  await ctx.save((job) => {
    job.ambientReadings.push(
      { id: uid('amb'), at: nowIso(), location: 'dehu_in', tempF: values.inTempF, rh: values.inRh, gpp: round(result.inlet.gpp, 1) },
      { id: uid('amb'), at: nowIso(), location: 'dehu_out', tempF: values.outTempF, rh: values.outRh, gpp: round(result.outlet.gpp, 1) },
    );
  });

  await sheet({
    title: 'Performance check',
    body: `
      <div class="stat-grid">
        ${statCard('Depression', `${round(result.depression)}`, 'grains removed', result.verdict === 'good' ? 'dry' : result.verdict === 'fair' ? 'near' : 'wet')}
        ${statCard('Intake', `${round(result.inlet.gpp)}`, 'gpp')}
        ${statCard('Outlet', `${round(result.outlet.gpp)}`, 'gpp')}
        ${statCard('Temp rise', `${round(result.tempRise)}°`, 'across the unit')}
      </div>
      <p class="dialog-text">${esc(result.detail)}</p>`,
    actions: [{ label: 'Done', variant: 'primary', value: true }],
  });
  ctx.refresh();
}

async function pointDetail(ctx, pointId) {
  const job = ctx.job;
  const point = job.monitoringPoints.find((p) => p.id === pointId);
  if (!point) return;
  const readings = job.readings.filter((r) => r.pointId === pointId).sort((a, b) => new Date(b.at) - new Date(a.at));
  const trend = dryingTrend(readings);
  const material = MATERIAL_DEFAULTS.find((m) => m.id === point.material);

  await sheet({
    title: point.label || 'Monitoring point',
    size: 'full',
    body: `
      <p class="dialog-text">${esc(material?.label || '')}${point.dryStandard != null ? ` · dry standard ${point.dryStandard}` : ` · table default ${material?.dryStandard ?? '—'}`}</p>
      ${readings.length > 1 ? `<p class="trend trend-${trend.direction} mb">${esc(trendLabel(trend))}</p>` : ''}
      <div class="table-scroll"><table class="data">
        <thead><tr><th>When</th><th class="num">Reading</th><th>Method</th><th>By</th></tr></thead>
        <tbody>${readings.length ? readings.map((r) => `<tr>
            <td>${esc(fmtDateTime(r.at))}</td>
            <td class="num"><strong>${round(r.reading)}</strong></td>
            <td>${esc(r.method || '')}</td><td>${esc(r.by || '')}</td>
          </tr>`).join('') : '<tr><td colspan="4" class="muted">No readings yet.</td></tr>'}</tbody>
      </table></div>`,
    actions: [
      { label: 'Close', value: true },
      {
        label: 'Add reading',
        variant: 'primary',
        onClick: async ({ close }) => {
          close(null);
          const v = await formSheet({
            title: `Reading — ${point.label}`,
            fields: [
              { name: 'reading', label: `Reading (${material?.unit || ''})`, type: 'number', full: true, required: true },
              { name: 'at', label: 'When', type: 'datetime-local', full: true, value: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) },
            ],
          });
          if (v?.reading == null) return;
          await ctx.save((j) => {
            j.readings.push({
              id: uid('rd'), pointId, at: v.at ? new Date(v.at).toISOString() : nowIso(),
              reading: num(v.reading), method: material?.meter || 'pin', by: ctx.settings.techName || '',
            });
          });
          toast('Reading saved.', 'success');
          ctx.refresh();
          return false;
        },
      },
    ],
  });
}

async function exportReadings(ctx) {
  const job = ctx.job;
  const byId = new Map(job.monitoringPoints.map((p) => [p.id, p]));
  const rows = [['Date', 'Point', 'Room', 'Material', 'Reading', 'Dry standard', 'Method', 'Technician']];
  for (const r of [...job.readings].sort((a, b) => new Date(a.at) - new Date(b.at))) {
    const p = byId.get(r.pointId);
    const material = MATERIAL_DEFAULTS.find((m) => m.id === p?.material);
    rows.push([
      fmtDateTime(r.at), p?.label || r.pointId,
      job.rooms.find((rm) => rm.id === p?.roomId)?.name || '',
      material?.label || '', r.reading,
      p?.dryStandard ?? material?.dryStandard ?? '', r.method || '', r.by || '',
    ]);
  }
  const { shareOrDownload } = await import('../ui.js');
  await shareOrDownload({
    filename: `${(job.client?.name || 'job').replace(/[^\w-]+/g, '_')}_readings.csv`,
    text: toCsv(rows), title: 'Moisture readings', mime: 'text/csv',
  });
}
