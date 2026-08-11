// The documentation package: everything an adjuster asks for, in one file.

import { store } from '../store.js';
import { card, cardHead, pill, actionSheet, openSheet } from '../ui.js';
import { Sketch } from '../sketch.js';
import { getPhoto } from '../idb.js';
import { WATER_SOURCES, CATEGORY_LABELS, CLASS_LABELS, materialById } from '../standards.js';
import { catalogById } from '../equipment.js';
import { lineTotal } from '../derive.js';
import { esc, fmtDate, fmtTime, money, round, download, toast, formatFeet, polygonArea, polygonPerimeter } from '../util.js';

/** Render the plan to a PNG using a detached canvas. */
function planImage(job) {
  if (!(job.plan.rooms || []).length) return null;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1000px;height:700px;';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:1000px;height:700px;';
  host.appendChild(canvas);
  document.body.appendChild(host);
  try {
    const s = new Sketch(canvas, { plan: job.plan, job: {}, onChange: () => {} });
    const url = s.exportPNG({ width: 1500, height: 1050 });
    s.destroy();
    return url;
  } catch (err) {
    console.warn('plan image failed', err);
    return null;
  } finally {
    host.remove();
  }
}

const blobToDataUrl = (blob) => new Promise((resolve) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result);
  fr.onerror = () => resolve(null);
  fr.readAsDataURL(blob);
});

async function photoDataUrls(job, limit = 24) {
  const out = [];
  for (const p of (job.photos || []).slice(0, limit)) {
    try {
      const blob = await getPhoto(p.blobId);
      if (blob) out.push({ ...p, data: await blobToDataUrl(blob) });
    } catch { /* skip unreadable photos */ }
  }
  return out;
}

function reportHtml(job, d, settings, { planPng, photos }) {
  const src = WATER_SOURCES.find((s) => s.id === job.loss.sourceId);
  const rooms = job.plan.rooms || [];
  const atmoRows = d.atmo.rows.slice(0, 60);

  const section = (title, body) => `<section><h2>${esc(title)}</h2>${body}</section>`;
  const kv = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(job.jobNumber)} — drying documentation</title>
<style>
  @page { margin: 0.6in; }
  * { box-sizing: border-box; }
  body { font: 12px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; color: #0f172a; margin: 0; padding: 24px; background: #fff; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 22px 0 8px; padding-bottom: 5px; border-bottom: 2px solid #0ea5e9; text-transform: uppercase; letter-spacing: 0.05em; }
  h3 { font-size: 12.5px; margin: 12px 0 6px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; border-bottom: 3px solid #0f172a; padding-bottom: 12px; }
  .head p { margin: 2px 0; color: #475569; font-size: 11.5px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th, td { padding: 5px 7px; text-align: left; border-bottom: 1px solid #e2e8f0; vertical-align: top; font-size: 11.5px; }
  th { background: #f1f5f9; font-weight: 700; }
  table.kv th { width: 32%; background: #f8fafc; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .badges { display: flex; gap: 8px; margin: 10px 0; flex-wrap: wrap; }
  .badge { padding: 4px 10px; border-radius: 999px; background: #0f172a; color: #fff; font-size: 11px; font-weight: 700; }
  .badge--cat3 { background: #b91c1c; }
  .badge--cls4 { background: #7c3aed; }
  .note { background: #f8fafc; border-left: 3px solid #0ea5e9; padding: 8px 11px; margin: 8px 0; font-size: 11.5px; }
  ul { margin: 6px 0; padding-left: 18px; font-size: 11.5px; }
  li { margin-bottom: 3px; }
  .plan img { width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; }
  .photos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .photo img { width: 100%; height: 130px; object-fit: cover; border: 1px solid #cbd5e1; border-radius: 5px; }
  .photo span { display: block; font-size: 10px; color: #64748b; margin-top: 3px; }
  .sig { display: flex; gap: 20px; flex-wrap: wrap; }
  .sig div { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px; min-width: 220px; }
  .sig img { height: 54px; }
  .dry { color: #15803d; font-weight: 700; }
  .wet { color: #b91c1c; font-weight: 700; }
  footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #cbd5e1; font-size: 10px; color: #64748b; }
  section { break-inside: avoid; }
</style></head>
<body>
  <div class="head">
    <div>
      <h1>${esc(settings.company || 'Water damage mitigation')}</h1>
      <p>${esc([settings.companyAddress, settings.companyPhone, settings.companyEmail].filter(Boolean).join(' · ') || 'Drying documentation package')}</p>
      ${settings.license ? `<p>License ${esc(settings.license)}</p>` : ''}
    </div>
    <div style="text-align:right">
      <p><strong>Job ${esc(job.jobNumber)}</strong></p>
      <p>${esc(job.site.name || '')}</p>
      <p>${esc([job.site.address, job.site.city, job.site.state, job.site.zip].filter(Boolean).join(', '))}</p>
      <p>Printed ${esc(fmtDate(new Date().toISOString()))}</p>
    </div>
  </div>

  <div class="badges">
    <span class="badge ${d.category >= 3 ? 'badge--cat3' : ''}">Category ${d.category}</span>
    <span class="badge ${d.cls === 4 ? 'badge--cls4' : ''}">Class ${d.cls}</span>
    <span class="badge">${d.totals.affectedFloor} sf affected</span>
    <span class="badge">${round(d.rec.volume)} cf drying volume</span>
    <span class="badge">${d.drying.atGoal}/${d.drying.total} points at goal</span>
  </div>

  ${section('Loss information', `<table class="kv">
    ${kv('Date and time of loss', esc(fmtDate(job.loss.dateISO, { withTime: true })))}
    ${kv('Elapsed at print', d.hours != null ? `${Math.round(d.hours)} hours (day ${Math.floor(d.hours / 24)})` : '—')}
    ${kv('Source of water', esc(src?.label || '—'))}
    ${kv('Source stopped', job.loss.sourceStopped ? 'Yes' : 'No')}
    ${kv('Carrier', esc(job.carrier.name || '—'))}
    ${kv('Claim number', esc(job.carrier.claimNumber || '—'))}
    ${kv('Adjuster', esc(job.carrier.adjuster || '—'))}
    ${kv('Description', esc(job.loss.description || '—'))}
  </table>`)}

  ${section('Classification', `
    <h3>${esc(CATEGORY_LABELS[d.category])}</h3>
    <ul>${d.categoryRationale.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    <h3>${esc(CLASS_LABELS[d.cls])}</h3>
    <ul>${d.classRationale.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    ${job.loss.overrideNote ? `<div class="note"><strong>Technician override:</strong> ${esc(job.loss.overrideNote)}</div>` : ''}
    <h3>Work practices applied</h3>
    <ul>${d.requirements.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
  `)}

  ${planPng ? section('Floor plan, moisture map and equipment placement',
    `<div class="plan"><img src="${planPng}" alt="floor plan"></div>
     <p style="font-size:10.5px;color:#64748b;margin-top:5px">Dimensions measured on site. Circles are moisture monitoring points, arrows show air movement, blocks and triangles show dehumidification and air movers as placed.</p>`) : ''}

  ${rooms.length ? section('Affected areas', `<table>
    <thead><tr><th>Room</th><th class="num">Floor sf</th><th class="num">Wall sf</th><th class="num">Volume cf</th><th>Wet materials</th></tr></thead>
    <tbody>${rooms.map((r) => {
      const area = polygonArea(r.poly), per = polygonPerimeter(r.poly), h = Number(r.ceilingHeight) || 8;
      const a = r.affected || {};
      const wet = [
        a.floorPct > 0 ? `floor ${esc(materialById(a.floorMaterial).label)} ${a.floorPct}%` : '',
        a.wallLf > 0 ? `walls ${esc(materialById(a.wallMaterial).label)} ${round(a.wallLf)} lf to ${a.wallHeightIn}"` : '',
        a.ceilingPct > 0 ? `ceiling ${a.ceilingPct}%` : '',
      ].filter(Boolean).join('; ');
      return `<tr><td>${esc(r.name)}<br><span style="color:#64748b">${esc(r.level || '')} · ${h}' ceiling · ${round(per)} lf perimeter</span></td>
        <td class="num">${round(area)}</td><td class="num">${round(per * h)}</td><td class="num">${round(area * h)}</td>
        <td>${wet || 'not affected'}</td></tr>`;
    }).join('')}</tbody>
  </table>`) : ''}

  ${d.drying.total ? section('Moisture readings', `<table>
    <thead><tr><th>Point</th><th>Room</th><th>Material</th><th class="num">Dry std</th><th class="num">Goal</th><th class="num">First</th><th class="num">Latest</th><th>Status</th></tr></thead>
    <tbody>${d.drying.pins.map((p) => `<tr>
      <td>${esc(p.pin.label)}</td><td>${esc(p.room?.name || '—')}</td>
      <td>${esc(p.material.label)}<br><span style="color:#64748b">${esc(p.pin.surface)}</span></td>
      <td class="num">${p.pin.dryStandard ?? '—'}</td>
      <td class="num">${p.goal} ${esc(p.unit)}</td>
      <td class="num">${p.first ? `${p.first.value}<br><span style="color:#64748b">${esc(p.first.date)}</span>` : '—'}</td>
      <td class="num">${p.last ? `${p.last.value}<br><span style="color:#64748b">${esc(p.last.date)}</span>` : '—'}</td>
      <td class="${p.atGoal ? 'dry' : 'wet'}">${p.atGoal ? 'At goal' : `${Math.round(p.progress)}% dried`}</td>
    </tr>`).join('')}</tbody>
  </table>
  <p style="font-size:10.5px;color:#64748b;margin-top:5px">Drying goals are set from a dry standard measured in an unaffected area of the same material, plus a tolerance of ${settings.tolerance} points.</p>`) : ''}

  ${atmoRows.length ? section('Psychrometric log', `<table>
    <thead><tr><th>Date</th><th>Time</th><th>Location</th><th class="num">Temp °F</th><th class="num">RH %</th><th class="num">Dew pt °F</th><th class="num">GPP</th></tr></thead>
    <tbody>${atmoRows.map((r) => `<tr>
      <td>${esc(fmtDate(r.ts))}</td><td>${esc(fmtTime(r.ts))}</td><td>${esc(r.location.replace('_', ' '))}</td>
      <td class="num">${round(r.tempF, 1)}</td><td class="num">${round(r.rh, 1)}</td>
      <td class="num">${round(r.dewPointF, 1)}</td><td class="num">${round(r.gpp, 1)}</td>
    </tr>`).join('')}</tbody>
  </table>`) : ''}

  ${d.deployed.list.length ? section('Equipment', `<table>
    <thead><tr><th>Unit</th><th>Asset</th><th>Room</th><th>Placed</th><th>Removed</th><th class="num">Days</th></tr></thead>
    <tbody>${d.deployed.list.map((r) => `<tr>
      <td>${esc(r.item?.label || '—')}</td><td>${esc(r.eq.serial || '—')}</td>
      <td>${esc((job.plan.rooms.find((x) => x.id === r.eq.roomId) || {}).name || '—')}</td>
      <td>${esc(fmtDate(r.eq.placedAt))}</td><td>${r.eq.removedAt ? esc(fmtDate(r.eq.removedAt)) : 'running'}</td>
      <td class="num">${r.days}</td></tr>`).join('')}</tbody>
  </table>
  <div class="note">${d.rec.notes.map(esc).join('<br>')}</div>`) : ''}

  ${(job.dailies || []).length ? section('Daily log', `<table>
    <thead><tr><th>Date</th><th class="num">Techs</th><th class="num">Hrs</th><th>Work performed</th></tr></thead>
    <tbody>${[...job.dailies].sort((a, b) => String(a.dateISO).localeCompare(String(b.dateISO))).map((x) => `<tr>
      <td>${esc(fmtDate(x.dateISO))}</td><td class="num">${esc(x.techs ?? 1)}</td><td class="num">${esc(x.hours ?? '')}</td>
      <td>${esc(x.work || '')}${x.notes ? `<br><span style="color:#64748b">${esc(x.notes)}</span>` : ''}</td></tr>`).join('')}</tbody>
  </table>`) : ''}

  ${photos.length ? section('Photographs', `<div class="photos">${photos.map((p) => `
    <div class="photo"><img src="${p.data}" alt="${esc(p.caption || '')}"><span>${esc(p.caption || fmtDate(p.ts))}</span></div>`).join('')}</div>`) : ''}

  ${(job.estimate.lines || []).length ? section('Estimate', `<table>
    <thead><tr><th>Code</th><th>Description</th><th class="num">Qty</th><th>Unit</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
    <tbody>${job.estimate.lines.map((l) => `<tr>
      <td>${esc(l.code || '')}</td><td>${esc(l.description)}</td>
      <td class="num">${l.qty}</td><td>${esc(l.unit || '')}</td>
      <td class="num">${money(l.unitPrice)}</td><td class="num">${money(lineTotal(l))}</td></tr>`).join('')}
      <tr><th colspan="5" class="num">Subtotal</th><th class="num">${money(d.money.subtotal)}</th></tr>
      ${settings.applyOandP ? `<tr><th colspan="5" class="num">Overhead &amp; profit</th><th class="num">${money(d.money.oh + d.money.profit)}</th></tr>` : ''}
      ${settings.taxRate ? `<tr><th colspan="5" class="num">Tax</th><th class="num">${money(d.money.tax)}</th></tr>` : ''}
      <tr><th colspan="5" class="num">Total</th><th class="num">${money(d.money.total)}</th></tr>
    </tbody>
  </table>`) : ''}

  ${(job.signatures || []).length ? section('Signatures', `<div class="sig">${job.signatures.map((s) => `
    <div><strong>${esc(s.label)}</strong><br><img src="${esc(s.data)}" alt="signature"><br>
    ${esc(s.name || '')} · ${esc(fmtDate(s.ts, { withTime: true }))}</div>`).join('')}</div>`) : ''}

  <footer>
    Prepared by ${esc(settings.techName || 'field technician')}${settings.company ? ` · ${esc(settings.company)}` : ''}.
    Classification and drying-system sizing follow the methods published in ANSI/IICRC S500 for water damage restoration.
    Readings were taken with calibrated meters at the locations shown on the floor plan.
  </footer>
</body></html>`;
}

export default {
  id: 'report',
  title: 'Report',

  render(ctx) {
    const { job, d } = ctx;
    const missing = [];
    if (!(job.plan.rooms || []).length) missing.push('a floor plan of the affected area');
    if (!d.drying.total) missing.push('moisture monitoring points');
    if (!d.atmo.rows.length) missing.push('psychrometric readings');
    if (!(job.photos || []).length) missing.push('photographs');
    if (!(job.dailies || []).length) missing.push('daily logs');
    if (!(job.signatures || []).length) missing.push('an authorization signature');

    return `
      ${card(`${cardHead('Documentation package', pill(missing.length ? `${6 - missing.length}/6 complete` : 'complete', missing.length ? 'warn' : 'good'))}
        <p class="muted">One file with the loss information, the classification and why it was made, the floor plan with the moisture map and equipment placement, every reading, the daily log, photos and the estimate.</p>
        ${missing.length ? `<div class="callout callout--warn" style="margin-top:10px">Still missing: ${esc(missing.join(', '))}.</div>`
          : '<div class="callout callout--good" style="margin-top:10px">Everything an adjuster normally asks for is in the file.</div>'}
        <div class="row row--wrap" style="margin-top:12px">
          <button class="btn btn--primary" data-print>Print / save as PDF</button>
          <button class="btn" data-preview>Preview</button>
          <button class="btn" data-share>Send</button>
          <button class="btn" data-plan-png>Export plan image</button>
        </div>
      `)}

      ${card(`${cardHead('What goes in')}
        <div class="kv"><span>Loss information &amp; claim details</span><span>${job.carrier.claimNumber ? '✓' : '—'}</span></div>
        <div class="kv"><span>Category &amp; class with written justification</span><span>✓</span></div>
        <div class="kv"><span>Floor plan with dimensions</span><span>${(job.plan.rooms || []).length ? `✓ ${job.plan.rooms.length} room${job.plan.rooms.length === 1 ? '' : 's'}` : '—'}</span></div>
        <div class="kv"><span>Moisture map &amp; readings</span><span>${d.drying.total ? `✓ ${d.drying.total} points` : '—'}</span></div>
        <div class="kv"><span>Psychrometric log</span><span>${d.atmo.rows.length ? `✓ ${d.atmo.rows.length} readings` : '—'}</span></div>
        <div class="kv"><span>Equipment log with days on site</span><span>${d.deployed.list.length ? `✓ ${d.deployed.list.length} units` : '—'}</span></div>
        <div class="kv"><span>Daily work log</span><span>${(job.dailies || []).length ? `✓ ${job.dailies.length} visits` : '—'}</span></div>
        <div class="kv"><span>Photographs</span><span>${(job.photos || []).length ? `✓ ${job.photos.length}` : '—'}</span></div>
        <div class="kv"><span>Estimate</span><span>${(job.estimate.lines || []).length ? `✓ ${money(d.money.total)}` : '—'}</span></div>
        <div class="kv"><span>Signatures</span><span>${(job.signatures || []).length ? `✓ ${job.signatures.length}` : '—'}</span></div>
      `)}
    `;
  },

  mount(root, ctx) {
    const { job, d, settings } = ctx;

    async function build() {
      const planPng = planImage(job);
      const photos = await photoDataUrls(job);
      return reportHtml(job, d, settings, { planPng, photos });
    }

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-print]')) {
        toast('Building the package…');
        const html = await build();
        const w = window.open('', '_blank');
        if (!w) { download(`${job.jobNumber}-report.html`, 'text/html', html); toast('Pop-up blocked — downloaded instead', 'bad'); return; }
        w.document.write(html);
        w.document.close();
        w.onload = () => setTimeout(() => w.print(), 400);
        return;
      }

      if (e.target.closest('[data-preview]')) {
        toast('Building the package…');
        const html = await build();
        const sheet = openSheet({ title: 'Report preview', size: 'lg', body: '<div id="rpt"></div>' });
        const frame = document.createElement('iframe');
        frame.style.cssText = 'width:100%;height:70vh;border:1px solid #24334d;border-radius:10px;background:#fff';
        sheet.body.querySelector('#rpt').appendChild(frame);
        frame.srcdoc = html;
        return;
      }

      if (e.target.closest('[data-share]')) {
        const choice = await actionSheet({
          title: 'Send the package',
          actions: [
            { id: 'download', label: 'Download HTML file', icon: '⬇︎', hint: 'Opens in any browser, prints to PDF' },
            { id: 'share', label: 'Share…', icon: '📤', hint: 'Email, messages, cloud storage' },
            { id: 'email', label: 'Email the adjuster', icon: '✉️', hint: job.carrier.adjusterEmail || 'no adjuster email on file' },
          ],
        });
        if (!choice) return;
        if (choice === 'download') {
          download(`${job.jobNumber}-documentation.html`, 'text/html', await build());
          toast('Downloaded', 'good');
        } else if (choice === 'share') {
          const html = await build();
          const file = new File([html], `${job.jobNumber}-documentation.html`, { type: 'text/html' });
          if (navigator.canShare?.({ files: [file] })) {
            try { await navigator.share({ files: [file], title: `${job.jobNumber} documentation` }); }
            catch { /* user cancelled */ }
          } else {
            download(`${job.jobNumber}-documentation.html`, 'text/html', html);
            toast('Sharing unavailable — downloaded instead');
          }
        } else if (choice === 'email') {
          if (!job.carrier.adjusterEmail) return toast('Add the adjuster email on the Overview tab', 'bad');
          download(`${job.jobNumber}-documentation.html`, 'text/html', await build());
          const subject = `Claim ${job.carrier.claimNumber || job.jobNumber} — drying documentation`;
          const body = `Attached is the drying documentation for ${job.site.name || job.site.address}.\n\nCategory ${d.category}, Class ${d.cls}. ${d.drying.atGoal} of ${d.drying.total} monitoring points are at goal.\n\n${settings.techName || ''}\n${settings.company || ''}`;
          location.href = `mailto:${job.carrier.adjusterEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
          toast('File downloaded — attach it to the email');
        }
        return;
      }

      if (e.target.closest('[data-plan-png]')) {
        const url = planImage(job);
        if (!url) return toast('Sketch the floor plan first', 'bad');
        const a = document.createElement('a');
        a.href = url; a.download = `${job.jobNumber}-floorplan.png`;
        a.click();
        toast('Plan exported', 'good');
      }
    });
  },
};
