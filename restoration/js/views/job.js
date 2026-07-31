/** Job overview: classification, what to do next, and the job record. */

import * as store from '../store.js';
import { esc, onAct, formSheet, toast, statCard, flagList, sectionHeader, confirmDialog } from '../ui.js';
import { fmtDate, fmtDateTime, sqft, cuft, round } from '../util.js';
import {
  classify, totals, dryingSummary, nextActions, recommendation,
  hoursSinceLoss, environment, daysOnJob,
} from '../jobcalc.js';
import { WATER_SOURCES, CATEGORY_GUIDANCE, CLASS_GUIDANCE, LOW_EVAPORATION_MATERIALS } from '../iicrc.js';
import { deleteJobFlow, STATUS_LABEL } from './jobs.js';

export async function render(ctx) {
  const job = ctx.job;
  const { category, waterClass } = classify(job);
  const t = totals(job);
  const drying = dryingSummary(job);
  const rec = recommendation(job, ctx.settings);
  const env = environment(job);
  const actions = nextActions(job, ctx.settings);

  const html = `
    <div class="stat-grid">
      ${statCard('Category', category.category, CATEGORY_GUIDANCE[category.category].name.split('—')[1]?.trim() || '', category.category === 1 ? 'dry' : category.category === 2 ? 'near' : 'wet')}
      ${statCard('Class', waterClass.class, `${Math.round(waterClass.wettedFraction * 100)}% wetted`, 'brand')}
      ${statCard('Affected', Math.round(t.affectedSqft), 'square feet')}
      ${statCard('Day', daysOnJob(job), 'on this job')}
    </div>

    <div class="card">
      <div class="card-head"><h2>Next</h2>
        <span class="chip">${esc(STATUS_LABEL[job.status] || job.status)}</span></div>
      ${flagList(actions.map((a) => ({ level: a.level, text: a.text })))}
      ${actions.some((a) => a.href) ? `<div class="btn-row mt">
        ${[...new Set(actions.filter((a) => a.href).map((a) => a.href))].map((h) => `
          <button class="btn btn-sm" data-act="go" data-to="${esc(h)}">${esc(hrefLabel(h))}</button>`).join('')}
      </div>` : ''}
    </div>

    ${sectionHeader('Classification', `<button class="btn btn-sm" data-act="classify">Adjust</button>`)}
    <div class="card">
      <div class="card-row"><span class="label">Category ${category.category}${category.overridden ? ' (overridden)' : ''}</span>
        <span class="value">${esc(CATEGORY_GUIDANCE[category.category].name.split('—')[1]?.trim() || '')}</span></div>
      <ul class="flags" style="margin:8px 0 12px">
        ${category.reasons.map((r) => `<li class="flag flag-info"><span class="flag-dot"></span>${esc(r)}</li>`).join('')}
      </ul>
      <div class="note-block"><strong>PPE:</strong> ${esc(CATEGORY_GUIDANCE[category.category].ppe)}<br>
        <strong>Handling:</strong> ${esc(CATEGORY_GUIDANCE[category.category].handling)}</div>

      <div class="divider"></div>

      <div class="card-row"><span class="label">Class ${waterClass.class}${waterClass.overridden ? ' (overridden)' : ''}</span>
        <span class="value">${esc(CLASS_GUIDANCE[waterClass.class].name.split('—')[1]?.trim() || '')}</span></div>
      <ul class="flags" style="margin-top:8px">
        ${waterClass.reasons.map((r) => `<li class="flag flag-info"><span class="flag-dot"></span>${esc(r)}</li>`).join('')}
      </ul>
      <p class="tiny muted mt">${esc(CLASS_GUIDANCE[waterClass.class].summary)}</p>
    </div>

    ${sectionHeader('Recommended equipment', `<button class="btn btn-sm" data-act="go" data-to="equipment">Manage</button>`)}
    <div class="card">
      <div class="card-row"><span class="label">Air movers</span><span class="value">${rec.airMovers}</span></div>
      <div class="card-row"><span class="label">Dehumidification</span><span class="value">
        ${rec.dehumidifiers.units} × ${rec.dehumidifiers.type === 'desiccant' ? `${rec.dehumidifiers.unitCfm} CFM` : `${rec.dehumidifiers.unitPpd} ppd`}</span></div>
      ${rec.airScrubbers.units ? `<div class="card-row"><span class="label">Air scrubbers</span><span class="value">${rec.airScrubbers.units}</span></div>` : ''}
      <div class="card-row"><span class="label">Chamber volume</span><span class="value">${cuft(rec.cubicFeet)}</span></div>
    </div>

    ${env ? `
      ${sectionHeader('Drying environment', `<button class="btn btn-sm" data-act="go" data-to="readings">Log reading</button>`)}
      <div class="card">
        <div class="card-row"><span class="label">Chamber</span><span class="value">
          ${round(env.inside.tempF)}°F · ${round(env.inside.rh)}% RH · ${round(env.inside.gpp)} gpp</span></div>
        ${env.unaffected ? `<div class="card-row"><span class="label">Unaffected</span><span class="value">${round(env.unaffected.gpp)} gpp</span></div>` : ''}
        ${env.outside ? `<div class="card-row"><span class="label">Outside</span><span class="value">${round(env.outside.gpp)} gpp</span></div>` : ''}
        <div class="mt">${flagList(env.flags)}</div>
      </div>` : ''}

    ${sectionHeader('Drying progress', `<button class="btn btn-sm" data-act="go" data-to="readings">Readings</button>`)}
    <div class="card">
      ${drying.monitored ? `
        <div class="stat-grid" style="margin:0">
          ${statCard('Dry', drying.counts.dry, 'points', 'dry')}
          ${statCard('Close', drying.counts.near, 'points', 'near')}
          ${statCard('Wet', drying.counts.wet, 'points', 'wet')}
        </div>` : `<p class="muted small">No monitoring points yet.</p>`}
    </div>

    ${sectionHeader('Job record', `<button class="btn btn-sm" data-act="edit">Edit</button>`)}
    <div class="card">
      ${row('Client', job.client?.name)}
      ${row('Address', [job.client?.address, job.client?.city, job.client?.state, job.client?.zip].filter(Boolean).join(', '))}
      ${row('Job number', job.jobNumber)}
      ${row('Date of loss', job.loss?.dateOfLoss ? `${fmtDateTime(job.loss.dateOfLoss)} (${Math.round(hoursSinceLoss(job))} h ago)` : '')}
      ${row('Source', WATER_SOURCES.find((s) => s.id === job.loss?.sourceId)?.label)}
      ${row('Carrier', job.claim?.carrier)}
      ${row('Claim #', job.claim?.claimNumber)}
      ${row('Adjuster', job.claim?.adjusterName)}
      ${row('Rooms', t.rooms ? `${t.rooms} · ${sqft(t.floorSqft)} · ${cuft(t.cubicFeet)}` : '')}
    </div>

    <div class="btn-row mt">
      <button class="btn" data-act="status">Change status</button>
      <button class="btn" data-act="go" data-to="report">Report</button>
    </div>
    <div class="btn-row mt">
      <button class="btn btn-ghost" data-act="export">Export job file</button>
      <button class="btn btn-ghost" data-act="delete" style="color:var(--bad)">Delete job</button>
    </div>`;

  return {
    title: job.client?.name || 'Job',
    subtitle: job.jobNumber ? `Job ${job.jobNumber}` : fmtDate(job.createdAt),
    back: '#/jobs',
    html,
    mount: (root) => {
      onAct(root, {
        go: (el) => ctx.navigate(`#/job/${job.id}/${el.dataset.to}`),
        classify: () => classifySheet(ctx),
        edit: () => editJobSheet(ctx),
        status: () => statusSheet(ctx),
        export: () => exportJob(ctx),
        delete: () => deleteJobFlow(ctx, job),
      });
    },
  };
}

const row = (label, value) => (value
  ? `<div class="card-row"><span class="label">${esc(label)}</span><span class="value">${esc(value)}</span></div>`
  : '');

const hrefLabel = (h) => ({ plan: 'Floor plan', readings: 'Readings', equipment: 'Equipment', field: 'Daily log' }[h] || h);

/* ------------------------------------------------------------------ */

async function classifySheet(ctx) {
  const job = ctx.job;
  const { category, waterClass } = classify(job);
  const values = await formSheet({
    title: 'Classification',
    intro: 'The app classifies from the source, the elapsed time and the wetted area. Override only when you can defend it — the reason is recorded on the report.',
    fields: [
      { name: 'sourceId', label: 'Water source', type: 'select', full: true,
        options: [{ value: '', label: 'Not recorded' }, ...WATER_SOURCES.map((s) => ({ value: s.id, label: s.label }))],
        value: job.loss?.sourceId || '' },
      { name: 'dateOfLoss', label: 'Date & time of loss', type: 'datetime-local', full: true, value: job.loss?.dateOfLoss || '' },
      { name: 'contactedContaminated', label: 'Contacted contaminated materials or soils', type: 'checkbox', full: true, value: !!job.loss?.contactedContaminated },
      { name: 'visibleGrowth', label: 'Visible microbial growth', type: 'checkbox', full: true, value: !!job.loss?.visibleGrowth },
      { name: 'odor', label: 'Odour present', type: 'checkbox', full: true, value: !!job.loss?.odor },
      { name: 'healthConcern', label: 'Occupant health concern reported', type: 'checkbox', full: true, value: !!job.loss?.healthConcern },
      { name: 'categoryOverride', label: `Category (auto: ${category.computed})`, type: 'segmented',
        options: [{ value: '', label: 'Auto' }, { value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }],
        value: job.categoryOverride ? String(job.categoryOverride) : '', full: true },
      { name: 'classOverride', label: `Class (auto: ${waterClass.computed})`, type: 'segmented',
        options: [{ value: '', label: 'Auto' }, { value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }, { value: '4', label: '4' }],
        value: job.classOverride ? String(job.classOverride) : '', full: true },
    ],
  });
  if (!values) return;

  await ctx.save((j) => {
    j.loss = {
      ...j.loss,
      sourceId: values.sourceId,
      dateOfLoss: values.dateOfLoss,
      contactedContaminated: values.contactedContaminated,
      visibleGrowth: values.visibleGrowth,
      odor: values.odor,
      healthConcern: values.healthConcern,
    };
    j.categoryOverride = values.categoryOverride ? Number(values.categoryOverride) : null;
    j.classOverride = values.classOverride ? Number(values.classOverride) : null;
  });
  toast('Classification updated.', 'success');
  ctx.refresh();
}

async function editJobSheet(ctx) {
  const job = ctx.job;
  const values = await formSheet({
    title: 'Job record',
    fields: [
      { name: 'name', label: 'Client name', type: 'text', full: true, value: job.client?.name },
      { name: 'phone', label: 'Phone', type: 'tel', value: job.client?.phone },
      { name: 'email', label: 'Email', type: 'email', value: job.client?.email },
      { name: 'address', label: 'Address', type: 'text', full: true, value: job.client?.address },
      { name: 'city', label: 'City', type: 'text', value: job.client?.city },
      { name: 'state', label: 'State', type: 'text', value: job.client?.state },
      { name: 'zip', label: 'ZIP', type: 'text', value: job.client?.zip, inputmode: 'numeric' },
      { name: 'jobNumber', label: 'Job number', type: 'text', value: job.jobNumber },
      { name: 'carrier', label: 'Carrier', type: 'text', value: job.claim?.carrier },
      { name: 'claimNumber', label: 'Claim number', type: 'text', value: job.claim?.claimNumber },
      { name: 'policyNumber', label: 'Policy number', type: 'text', value: job.claim?.policyNumber },
      { name: 'deductible', label: 'Deductible', type: 'number', value: job.claim?.deductible },
      { name: 'adjusterName', label: 'Adjuster', type: 'text', value: job.claim?.adjusterName },
      { name: 'adjusterPhone', label: 'Adjuster phone', type: 'tel', value: job.claim?.adjusterPhone },
      { name: 'adjusterEmail', label: 'Adjuster email', type: 'email', value: job.claim?.adjusterEmail, full: true },
      { name: 'description', label: 'Loss description', type: 'textarea', full: true, value: job.loss?.description },
      { name: 'elevationFt', label: 'Site elevation (ft)', type: 'number', value: job.elevationFt,
        hint: 'Corrects grain calculations above about 2,000 ft.' },
      { name: 'crewSize', label: 'Crew size', type: 'number', value: job.crewSize },
      { name: 'afterHoursCall', label: 'After-hours emergency call', type: 'checkbox', full: true, value: job.afterHoursCall },
    ],
  });
  if (!values) return;

  await ctx.save((j) => {
    j.client = { ...j.client, name: values.name, phone: values.phone, email: values.email,
      address: values.address, city: values.city, state: values.state, zip: values.zip };
    j.claim = { ...j.claim, carrier: values.carrier, claimNumber: values.claimNumber, policyNumber: values.policyNumber,
      deductible: values.deductible, adjusterName: values.adjusterName, adjusterPhone: values.adjusterPhone, adjusterEmail: values.adjusterEmail };
    j.loss = { ...j.loss, description: values.description };
    j.jobNumber = values.jobNumber;
    j.elevationFt = values.elevationFt ?? 0;
    j.crewSize = values.crewSize ?? 2;
    j.afterHoursCall = values.afterHoursCall;
  });
  toast('Saved.', 'success');
  ctx.refresh();
}

async function statusSheet(ctx) {
  const values = await formSheet({
    title: 'Job status',
    fields: [{
      name: 'status', label: 'Status', type: 'segmented', full: true, value: ctx.job.status,
      options: [
        { value: 'active', label: 'Active' }, { value: 'drying', label: 'Drying' },
        { value: 'complete', label: 'Complete' }, { value: 'invoiced', label: 'Invoiced' },
      ],
    }],
  });
  if (!values) return;
  await ctx.save((j) => {
    j.status = values.status;
    if (values.status === 'drying' && !j.dryingStartedAt) j.dryingStartedAt = new Date().toISOString();
    if (values.status === 'complete' && !j.completedAt) j.completedAt = new Date().toISOString();
  });
  ctx.refresh();
}

async function exportJob(ctx) {
  const payload = await store.exportAll({ jobId: ctx.job.id });
  const name = `${(ctx.job.client?.name || 'job').replace(/[^\w-]+/g, '_')}_${ctx.job.jobNumber || ctx.job.id.slice(-6)}.json`;
  const { shareOrDownload } = await import('../ui.js');
  await shareOrDownload({ filename: name, text: JSON.stringify(payload, null, 2), title: 'DryLine job export', mime: 'application/json' });
  toast('Job file exported.', 'success');
}
