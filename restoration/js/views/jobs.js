/** Job list and job intake. */

import * as store from '../store.js';
import { esc, onAct, formSheet, toast, emptyState, confirmDialog } from '../ui.js';
import { fmtDate, relativeDays } from '../util.js';
import { classify, totals, dryingSummary } from '../jobcalc.js';
import { WATER_SOURCES } from '../iicrc.js';

const STATUS_LABEL = { active: 'Active', drying: 'Drying', complete: 'Complete', invoiced: 'Invoiced' };

export async function render(ctx) {
  const jobs = await store.listJobs();
  const filter = sessionStorage.getItem('jobFilter') || 'open';
  const visible = jobs.filter((j) => (filter === 'all' ? true : filter === 'open'
    ? j.status === 'active' || j.status === 'drying'
    : j.status === filter));

  const html = `
    <div class="pill-row">
      ${['open', 'all', 'complete', 'invoiced'].map((f) => `
        <button class="chip ${filter === f ? 'chip-brand' : ''}" data-act="filter" data-filter="${f}">
          ${f === 'open' ? 'Open' : STATUS_LABEL[f] || 'All'}
        </button>`).join('')}
    </div>

    ${visible.length ? visible.map(jobCard).join('') : emptyState(
      jobs.length ? 'Nothing here' : 'No jobs yet',
      jobs.length ? 'Try a different filter.' : 'Start a job when you roll up to the loss. Everything after that works offline.',
      `<button class="btn btn-primary" data-act="new">Start a job</button>`,
    )}

    <button class="fab" data-act="new" aria-label="New job">+</button>`;

  return {
    title: 'Jobs',
    subtitle: jobs.length ? `${jobs.length} on this device` : 'Offline-first field app',
    html,
    mount: (root) => {
      onAct(root, {
        filter: (el) => { sessionStorage.setItem('jobFilter', el.dataset.filter); ctx.refresh(); },
        new: () => newJobFlow(ctx),
        open: (el) => ctx.navigate(`#/job/${el.dataset.id}`),
      });
    },
  };
}

function jobCard(job) {
  const { category, waterClass } = classify(job);
  const t = totals(job);
  const drying = dryingSummary(job);
  const addr = [job.client?.address, job.client?.city].filter(Boolean).join(', ');

  return `
    <button class="list-item" data-act="open" data-id="${esc(job.id)}">
      <span class="status-dot status-${esc(job.status)}"></span>
      <span class="grow">
        <span class="title">${esc(job.client?.name || 'Unnamed job')}${job.jobNumber ? ` · ${esc(job.jobNumber)}` : ''}</span>
        <span class="meta">${esc(addr || 'No address')} · updated ${esc(relativeDays(job.updatedAt))}</span>
        <span class="row wrap" style="margin-top:6px">
          <span class="chip chip-cat${category.category}">Cat ${category.category}</span>
          <span class="chip">Class ${waterClass.class}</span>
          ${t.affectedSqft ? `<span class="chip">${Math.round(t.affectedSqft)} ft² wet</span>` : ''}
          ${drying.monitored ? `<span class="chip chip-${drying.allDry ? 'dry' : drying.counts.wet ? 'wet' : 'near'}">${drying.pctDry}% dry</span>` : ''}
        </span>
      </span>
      <span class="chev">›</span>
    </button>`;
}

/* ------------------------------------------------------------------ */

export async function newJobFlow(ctx) {
  const values = await formSheet({
    title: 'New job',
    intro: 'Just enough to get moving. Everything else can wait until the truck is unloaded.',
    submitLabel: 'Create job',
    fields: [
      { name: 'name', label: 'Client name', type: 'text', full: true, required: true, autocomplete: 'name' },
      { name: 'phone', label: 'Phone', type: 'tel', inputmode: 'tel' },
      { name: 'jobNumber', label: 'Job number', type: 'text' },
      { name: 'address', label: 'Address', type: 'text', full: true, autocomplete: 'street-address' },
      { name: 'city', label: 'City', type: 'text' },
      { name: 'state', label: 'State', type: 'text' },
      { name: 'dateOfLoss', label: 'Date & time of loss', type: 'datetime-local', full: true,
        hint: 'Drives category degradation — a Cat 1 loss does not stay Cat 1 forever.' },
      { name: 'sourceId', label: 'Water source', type: 'select', full: true,
        options: [{ value: '', label: 'Select a source…' }, ...WATER_SOURCES.map((s) => ({ value: s.id, label: s.label }))] },
      { name: 'carrier', label: 'Insurance carrier', type: 'text' },
      { name: 'claimNumber', label: 'Claim number', type: 'text' },
    ],
  });
  if (!values || !values.name?.trim()) {
    if (values) toast('A client name is required.', 'error');
    return;
  }

  const job = store.newJob();
  job.jobNumber = values.jobNumber || '';
  job.client = { ...job.client, name: values.name.trim(), phone: values.phone || '', address: values.address || '', city: values.city || '', state: values.state || '' };
  job.loss = { ...job.loss, dateOfLoss: values.dateOfLoss || '', sourceId: values.sourceId || '' };
  job.claim = { ...job.claim, carrier: values.carrier || '', claimNumber: values.claimNumber || '' };
  if (values.name) {
    job.contacts.push({
      id: `c_${Date.now().toString(36)}`, role: 'client', name: values.name.trim(),
      phone: values.phone || '', email: '', company: '', notes: '',
    });
  }
  await store.saveJob(job);
  toast('Job created.', 'success');
  ctx.navigate(`#/job/${job.id}`);
}

export async function deleteJobFlow(ctx, job) {
  const ok = await confirmDialog(
    `Delete ${job.client?.name || 'this job'} and every reading, photo and sketch on it? This cannot be undone and it is not synced anywhere unless you have set up sync.`,
    { title: 'Delete job', confirmLabel: 'Delete', danger: true },
  );
  if (!ok) return;
  await store.deleteJob(job.id);
  toast('Job deleted.');
  ctx.navigate('#/jobs');
}

export { STATUS_LABEL };
