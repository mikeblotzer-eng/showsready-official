/**
 * Report generation.
 *
 * Produces one self-contained HTML file — sketch, moisture map, readings,
 * equipment, dailies and photos all inlined — that prints, emails or uploads
 * to a carrier portal without needing this app or a network connection.
 */

import * as store from '../store.js';
import { esc, onAct, toast, sectionHeader, shareOrDownload, sheet, formSheet } from '../ui.js';
import { fmtDate, fmtDateTime, fmtTime, round, num, money, sqft, cuft, sum } from '../util.js';
import { PlanCanvas } from '../sketch.js';
import { MATERIAL_DEFAULTS, CATEGORY_GUIDANCE, CLASS_GUIDANCE, WATER_SOURCES, DEHU_TYPES } from '../iicrc.js';
import { buildEstimate } from '../estimate.js';
import { equipmentDays } from '../estimate.js';
import {
  classify, totals, dryingSummary, recommendation, equipmentAudit, environment, daysOnJob,
} from '../jobcalc.js';

export async function render(ctx) {
  const job = ctx.job;
  const t = totals(job);
  const drying = dryingSummary(job);

  const html = `
    <div class="card">
      <h2>Job report</h2>
      <p class="muted small mt">
        Builds a single HTML file containing the floor plan, moisture map, every reading, the equipment log,
        the daily logs and the photos. It opens in any browser and prints to PDF — no app required at the other end.
      </p>
      <div class="card-row mt"><span class="label">Rooms</span><span class="value">${t.rooms} · ${sqft(t.floorSqft)}</span></div>
      <div class="card-row"><span class="label">Readings</span><span class="value">${(job.readings || []).length}</span></div>
      <div class="card-row"><span class="label">Daily logs</span><span class="value">${(job.dailyLogs || []).length}</span></div>
      <div class="card-row"><span class="label">Drying status</span><span class="value">${drying.pctDry}% of points dry</span></div>
    </div>

    <div class="btn-row">
      <button class="btn btn-primary btn-block" data-act="build">Build report</button>
    </div>
    <div class="btn-row mt">
      <button class="btn" data-act="preview">Preview</button>
      <button class="btn" data-act="summary">Client summary text</button>
    </div>

    <div class="note-block">
      Photos are embedded, so a job with many photos makes a large file. If you need to email it,
      the summary text is a short version you can paste into a message.
    </div>`;

  return {
    title: 'Report',
    subtitle: job.client?.name,
    back: `#/job/${job.id}`,
    html,
    mount: (root) => {
      onAct(root, {
        build: () => buildAndShare(ctx),
        preview: () => previewReport(ctx),
        summary: () => summarySheet(ctx),
      });
    },
  };
}

/* ------------------------------------------------------------------ */

async function buildAndShare(ctx) {
  toast('Building report…');
  const html = await buildReportHtml(ctx);
  const name = `${(ctx.job.client?.name || 'job').replace(/[^\w-]+/g, '_')}_report.html`;
  await shareOrDownload({ filename: name, text: html, title: 'Restoration job report', mime: 'text/html' });
  toast('Report ready.', 'success');
}

async function previewReport(ctx) {
  const html = await buildReportHtml(ctx);
  const win = window.open('', '_blank');
  if (!win) return toast('Allow pop-ups to preview, or use Build report.', 'error');
  win.document.write(html);
  win.document.close();
}

/**
 * Render each level's plan to a PNG. The canvas has to be laid out for the
 * renderer to measure, so it goes off-screen rather than being detached.
 */
async function renderPlanImages(job) {
  const images = [];
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:600px;pointer-events:none';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:900px;height:600px';
  host.appendChild(canvas);
  document.body.appendChild(host);

  try {
    for (const level of job.levels || []) {
      const rooms = (job.rooms || []).filter((r) => r.levelId === level.id);
      if (!rooms.length) continue;

      const plan = new PlanCanvas(canvas, {});
      plan.setData({
        rooms: job.rooms, monitoringPoints: job.monitoringPoints, readings: job.readings,
        equipment: job.equipment, arrows: job.arrows || [], pins: job.pins || [], levelId: level.id,
      });
      const withOverlays = plan.exportPng({ width: 1400 });
      plan.setLayers({ moisture: false, equipment: false, airflow: false, pins: false });
      const bare = plan.exportPng({ width: 1400 });
      plan.destroy();

      if (withOverlays) images.push({ level, withOverlays, bare });
    }
  } finally {
    host.remove();
  }
  return images;
}

export async function buildReportHtml(ctx) {
  const job = ctx.job;
  const settings = ctx.settings;
  const { category, waterClass } = classify(job);
  const t = totals(job);
  const drying = dryingSummary(job);
  const rec = recommendation(job, settings);
  const audit = equipmentAudit(job, settings);
  const env = environment(job);
  const estimate = buildEstimate(job, { priceList: settings.priceList || {} });
  const plans = await renderPlanImages(job);

  const photos = await store.photosForJob(job.id);
  const photoTags = [];
  for (const p of photos.slice(0, 60)) {
    const dataUrl = await store.blobToDataUrl(p.blob);
    if (dataUrl) photoTags.push({ dataUrl, caption: p.caption, at: p.at, kind: p.kind });
  }

  const address = [job.client?.address, job.client?.city, job.client?.state, job.client?.zip].filter(Boolean).join(', ');
  const pointRows = drying.statuses;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(job.client?.name || 'Job')} — Restoration report</title>
<style>
  :root { --line:#d9dee7; --dim:#5b6577; --ink:#0f172a; }
  * { box-sizing:border-box; }
  body { font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--ink);
         margin:0; padding:32px 24px; background:#fff; }
  .wrap { max-width:900px; margin:0 auto; }
  h1 { font-size:24px; margin:0 0 4px; }
  h2 { font-size:16px; margin:32px 0 10px; padding-bottom:6px; border-bottom:2px solid var(--ink); }
  h3 { font-size:13px; margin:18px 0 6px; color:var(--dim); text-transform:uppercase; letter-spacing:.05em; }
  .sub { color:var(--dim); margin-bottom:20px; }
  table { width:100%; border-collapse:collapse; margin:8px 0 14px; font-size:13px; }
  th { text-align:left; background:#f4f6fa; padding:7px 8px; border-bottom:1px solid var(--line); font-size:11px;
       text-transform:uppercase; letter-spacing:.04em; color:var(--dim); }
  td { padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .kv { display:grid; grid-template-columns:180px 1fr; gap:2px 14px; font-size:13px; }
  .kv dt { color:var(--dim); }
  .kv dd { margin:0; font-weight:600; }
  .badge { display:inline-block; padding:2px 9px; border-radius:99px; font-size:11px; font-weight:700; }
  .b1 { background:#dcfce7; color:#166534; } .b2 { background:#fef3c7; color:#92400e; } .b3 { background:#fee2e2; color:#991b1b; }
  .dry { color:#166534; font-weight:700; } .near { color:#92400e; font-weight:700; } .wet { color:#991b1b; font-weight:700; }
  .plan { width:100%; border:1px solid var(--line); border-radius:8px; margin:8px 0; }
  .photos { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
  .photo img { width:100%; border:1px solid var(--line); border-radius:6px; display:block; }
  .photo p { font-size:11px; color:var(--dim); margin:4px 0 0; }
  .note { background:#f4f6fa; border-left:3px solid #0369a1; padding:10px 12px; font-size:12px; color:var(--dim); margin:10px 0; }
  .sig { border:1px solid var(--line); border-radius:6px; max-width:320px; display:block; margin-top:6px; }
  footer { margin-top:40px; padding-top:14px; border-top:1px solid var(--line); font-size:11px; color:var(--dim); }
  @media print { body { padding:0; } h2 { page-break-after:avoid; } table, .photo, .daily { page-break-inside:avoid; } }
</style></head><body><div class="wrap">

<h1>${esc(job.client?.name || 'Restoration job')}</h1>
<p class="sub">
  ${esc(address)}${job.jobNumber ? ` · Job ${esc(job.jobNumber)}` : ''}<br>
  ${settings.companyName ? `${esc(settings.companyName)}${settings.companyPhone ? ` · ${esc(settings.companyPhone)}` : ''}${settings.companyLicense ? ` · Lic ${esc(settings.companyLicense)}` : ''}` : ''}
</p>

<h2>Loss summary</h2>
<dl class="kv">
  <dt>Category</dt><dd><span class="badge b${category.category}">Category ${category.category}</span> ${esc(CATEGORY_GUIDANCE[category.category].name.split('—')[1]?.trim() || '')}</dd>
  <dt>Class</dt><dd>Class ${waterClass.class} — ${esc(CLASS_GUIDANCE[waterClass.class].name.split('—')[1]?.trim() || '')} (${Math.round(waterClass.wettedFraction * 100)}% of surfaces affected)</dd>
  <dt>Source</dt><dd>${esc(WATER_SOURCES.find((s) => s.id === job.loss?.sourceId)?.label || 'Not recorded')}</dd>
  <dt>Date of loss</dt><dd>${esc(job.loss?.dateOfLoss ? fmtDateTime(job.loss.dateOfLoss) : 'Not recorded')}</dd>
  <dt>Claim</dt><dd>${esc(job.claim?.carrier || '—')}${job.claim?.claimNumber ? ` · ${esc(job.claim.claimNumber)}` : ''}</dd>
  <dt>Adjuster</dt><dd>${esc(job.claim?.adjusterName || '—')}${job.claim?.adjusterPhone ? ` · ${esc(job.claim.adjusterPhone)}` : ''}</dd>
  <dt>Affected area</dt><dd>${sqft(t.affectedSqft)} of ${sqft(t.floorSqft)} across ${t.rooms} room(s) · ${cuft(t.cubicFeet)}</dd>
  <dt>Days on job</dt><dd>${daysOnJob(job)}</dd>
</dl>
${job.loss?.description ? `<p>${esc(job.loss.description)}</p>` : ''}

<h3>How the classification was reached</h3>
<ul>${[...category.reasons, ...waterClass.reasons].map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
<div class="note"><strong>Handling:</strong> ${esc(CATEGORY_GUIDANCE[category.category].handling)}</div>

${plans.length ? `<h2>Floor plan</h2>
  ${plans.map((p) => `
    <h3>${esc(p.level.name)} — moisture map, equipment and airflow</h3>
    <img class="plan" src="${p.withOverlays}" alt="Floor plan with moisture map for ${esc(p.level.name)}">
    <h3>${esc(p.level.name)} — dimensions</h3>
    <img class="plan" src="${p.bare}" alt="Dimensioned floor plan for ${esc(p.level.name)}">`).join('')}` : ''}

<h2>Rooms</h2>
<table>
  <thead><tr><th>Room</th><th>Flooring</th><th class="num">Floor</th><th class="num">Wet floor</th><th class="num">Wet wall</th><th class="num">Ceiling ht</th><th class="num">Volume</th></tr></thead>
  <tbody>${(job.rooms || []).map((r) => `<tr>
    <td>${esc(r.name)}</td><td>${esc(r.flooring || '')}</td>
    <td class="num">${Math.round(r.floorAreaSqft)} ft²</td>
    <td class="num">${Math.round(r.affectedFloorSqft)} ft²</td>
    <td class="num">${Math.round(r.affectedWallLf)} lf</td>
    <td class="num">${r.ceilingHeightFt}'</td>
    <td class="num">${Math.round(r.floorAreaSqft * r.ceilingHeightFt)} ft³</td>
  </tr>`).join('') || '<tr><td colspan="7">No rooms recorded.</td></tr>'}</tbody>
</table>

<h2>Drying equipment</h2>
<dl class="kv">
  <dt>Recommended air movers</dt><dd>${rec.airMovers} (${audit.placed.airMovers} on site)</dd>
  <dt>Recommended dehumidification</dt><dd>${rec.dehumidifiers.units} × ${rec.dehumidifiers.type === 'desiccant' ? `${rec.dehumidifiers.unitCfm} CFM` : `${rec.dehumidifiers.unitPpd} AHAM pint`} ${esc(DEHU_TYPES[rec.dehumidifiers.type]?.label || '')}</dd>
  <dt>Sizing basis</dt><dd>${esc(rec.dehumidifiers.basis)}</dd>
  ${rec.airScrubbers.units ? `<dt>Air filtration</dt><dd>${rec.airScrubbers.units} scrubber(s) — ${esc(rec.airScrubbers.basis)}</dd>` : ''}
</dl>
<table>
  <thead><tr><th>Equipment</th><th class="num">Qty</th><th>Placed</th><th>Removed</th><th class="num">Unit-days</th></tr></thead>
  <tbody>${(job.equipment || []).map((e) => `<tr>
    <td>${esc(e.type.replace(/_/g, ' '))}${e.subtype ? ` (${esc(e.subtype)})` : ''}</td>
    <td class="num">${e.count || 1}</td>
    <td>${e.placedAt ? esc(fmtDateTime(e.placedAt)) : '—'}</td>
    <td>${e.removedAt ? esc(fmtDateTime(e.removedAt)) : 'on site'}</td>
    <td class="num">${equipmentDays(e)}</td>
  </tr>`).join('') || '<tr><td colspan="5">No equipment recorded.</td></tr>'}</tbody>
</table>

${env ? `<h2>Drying environment</h2>
<table>
  <thead><tr><th>Location</th><th class="num">°F</th><th class="num">%RH</th><th class="num">GPP</th><th class="num">Dew point</th></tr></thead>
  <tbody>
    ${envRow('Chamber', env.inside)}
    ${env.unaffected ? envRow('Unaffected area', env.unaffected) : ''}
    ${env.outside ? envRow('Outside', env.outside) : ''}
  </tbody>
</table>
<ul>${env.flags.map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul>` : ''}

<h2>Moisture readings</h2>
<p>${drying.counts.dry} of ${drying.monitored} monitoring point(s) have reached the dry standard.</p>
<table>
  <thead><tr><th>Point</th><th>Room</th><th>Material</th><th class="num">Dry standard</th><th class="num">Latest</th><th>Status</th><th>Trend</th></tr></thead>
  <tbody>${pointRows.map((s) => {
    const material = MATERIAL_DEFAULTS.find((m) => m.id === s.point.material);
    return `<tr>
      <td>${esc(s.point.label || '')}</td>
      <td>${esc((job.rooms || []).find((r) => r.id === s.point.roomId)?.name || '')}</td>
      <td>${esc(material?.label || '')}</td>
      <td class="num">${s.standard ?? '—'}</td>
      <td class="num">${s.latest ? round(s.latest.reading) : '—'}</td>
      <td class="${s.status}">${s.status}</td>
      <td>${esc(s.trend.direction)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7">No monitoring points recorded.</td></tr>'}</tbody>
</table>

${(job.readings || []).length ? `<h3>Full reading history</h3>
<table>
  <thead><tr><th>Date</th><th>Point</th><th class="num">Reading</th><th>Method</th><th>Technician</th></tr></thead>
  <tbody>${[...job.readings].sort((a, b) => new Date(a.at) - new Date(b.at)).map((r) => {
    const p = (job.monitoringPoints || []).find((x) => x.id === r.pointId);
    return `<tr><td>${esc(fmtDateTime(r.at))}</td><td>${esc(p?.label || '')}</td>
      <td class="num">${round(r.reading)}</td><td>${esc(r.method || '')}</td><td>${esc(r.by || '')}</td></tr>`;
  }).join('')}</tbody>
</table>` : ''}

${(job.dailyLogs || []).length ? `<h2>Daily logs</h2>
${[...job.dailyLogs].sort((a, b) => a.date.localeCompare(b.date)).map((d) => `
  <div class="daily">
    <h3>${esc(fmtDate(d.date))} · ${d.arrivedAt ? esc(fmtTime(d.arrivedAt)) : '—'}${d.departedAt ? ` – ${esc(fmtTime(d.departedAt))}` : ''}</h3>
    <p><strong>Crew:</strong> ${esc(d.techs || '—')}</p>
    ${d.workPerformed ? `<p>${esc(d.workPerformed).replace(/\n/g, '<br>')}</p>` : ''}
    ${d.equipmentAdjustments ? `<p><strong>Equipment adjustments:</strong> ${esc(d.equipmentAdjustments)}</p>` : ''}
    ${d.signatureDataUrl ? `<p><strong>Acknowledged by ${esc(d.signerName || 'client')}:</strong>
      <img class="sig" src="${d.signatureDataUrl}" alt="Signature"></p>` : ''}
  </div>`).join('')}` : ''}

${(job.trips || []).length ? `<h2>Travel</h2>
<table>
  <thead><tr><th>Date</th><th>Purpose</th><th class="num">Miles</th><th>Billable</th></tr></thead>
  <tbody>${job.trips.map((t2) => `<tr><td>${esc(fmtDate(t2.startedAt || t2.at))}</td><td>${esc(t2.purpose || '')}</td>
    <td class="num">${round(t2.miles, 1)}</td><td>${t2.billable === false ? 'No' : 'Yes'}</td></tr>`).join('')}
    <tr><th>Total</th><th></th><th class="num">${round(sum(job.trips, (x) => num(x.miles)), 1)}</th><th></th></tr>
  </tbody>
</table>` : ''}

${estimate.lines.length ? `<h2>Scope of work</h2>
<table>
  <thead><tr><th>Code</th><th>Description</th><th>Unit</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th></tr></thead>
  <tbody>${estimate.lines.map((l) => `<tr>
    <td>${esc(l.code)}</td><td>${esc(l.description)}</td><td>${esc(l.unit)}</td>
    <td class="num">${round(l.quantity, 2)}</td><td class="num">${money(l.unitPrice)}</td><td class="num">${money(l.total)}</td>
  </tr>`).join('')}
    <tr><th colspan="5">Line items</th><th class="num">${money(estimate.totals.lineItems)}</th></tr>
    <tr><th colspan="5">Labour</th><th class="num">${money(estimate.totals.labor)}</th></tr>
    <tr><th colspan="5">Billable expenses</th><th class="num">${money(estimate.totals.billableExpenses)}</th></tr>
    <tr><th colspan="5">Total</th><th class="num">${money(estimate.totals.grand)}</th></tr>
  </tbody>
</table>
<div class="note">Quantities are derived from the recorded sketch dimensions, equipment log and daily visits.
Unit prices come from the price list configured in the app and should be reconciled against the carrier price list.</div>` : ''}

${photoTags.length ? `<h2>Photographs</h2>
<div class="photos">${photoTags.map((p) => `<div class="photo">
  <img src="${p.dataUrl}" alt="${esc(p.caption || 'Job photo')}">
  <p>${esc(p.caption || '')}${p.caption ? ' · ' : ''}${esc(fmtDate(p.at))}</p>
</div>`).join('')}</div>` : ''}

<footer>
  Generated ${esc(fmtDateTime(new Date().toISOString()))}${settings.techName ? ` by ${esc(settings.techName)}` : ''}${settings.techCertification ? ` (${esc(settings.techCertification)})` : ''}.
  Classification and equipment recommendations follow the IICRC S500 approach to water damage restoration and are
  subject to the technician's professional judgement on site.
</footer>

</div></body></html>`;
}

const envRow = (label, set) => `<tr>
  <td>${esc(label)}</td><td class="num">${round(set.tempF)}</td><td class="num">${round(set.rh)}</td>
  <td class="num">${round(set.gpp)}</td><td class="num">${round(set.dewPointF)}</td></tr>`;

/* ------------------------------------------------------------------ */

async function summarySheet(ctx) {
  const job = ctx.job;
  const { category, waterClass } = classify(job);
  const t = totals(job);
  const drying = dryingSummary(job);
  const audit = equipmentAudit(job, ctx.settings);

  const text = [
    `${job.client?.name || 'Job'}${job.jobNumber ? ` (Job ${job.jobNumber})` : ''}`,
    job.claim?.claimNumber ? `Claim ${job.claim.claimNumber}${job.claim.carrier ? ` — ${job.claim.carrier}` : ''}` : '',
    '',
    `Category ${category.category} water loss, Class ${waterClass.class}.`,
    `${t.rooms} room(s) affected, ${Math.round(t.affectedSqft)} sq ft of wet floor, ${Math.round(t.cubicFeet).toLocaleString()} cu ft of drying chamber.`,
    `Equipment on site: ${audit.placed.airMovers} air mover(s), ${audit.placed.dehuUnits} dehumidifier(s)${audit.placed.scrubbers ? `, ${audit.placed.scrubbers} air scrubber(s)` : ''}.`,
    drying.monitored
      ? `Drying progress: ${drying.counts.dry} of ${drying.monitored} monitoring points have reached the dry standard (${drying.pctDry}%).`
      : 'Monitoring points not yet established.',
    drying.stalled.length ? `${drying.stalled.length} point(s) are not progressing; the drying approach is being adjusted.` : '',
    drying.allDry ? 'All points are at the dry standard — equipment removal recommended.' : '',
    '',
    `Day ${daysOnJob(job)} of the drying process. Next monitoring visit within 24 hours.`,
  ].filter(Boolean).join('\n');

  await sheet({
    title: 'Client summary',
    body: `<textarea rows="14" id="summary-text" style="font-size:14px">${esc(text)}</textarea>
      <p class="tiny muted mt">Review before sending. This describes what is recorded in the app, not a substitute for your own assessment.</p>`,
    actions: [
      { label: 'Close', value: null },
      {
        label: 'Copy',
        variant: 'primary',
        onClick: async ({ root, close }) => {
          const value = root.querySelector('#summary-text').value;
          try {
            await navigator.clipboard.writeText(value);
            toast('Copied.', 'success');
          } catch {
            toast('Could not copy — select the text and copy manually.', 'error');
            return false;
          }
          close(true);
          return false;
        },
      },
    ],
  });
}
