// Job list + intake.

import { store } from '../store.js';
import { derive } from '../derive.js';
import { openForm, card, cardHead, emptyState, pill, actionSheet, confirmDialog } from '../ui.js';
import { WATER_SOURCES } from '../standards.js';
import { esc, fmtDate, daysBetween, money, toast, download, nowISO } from '../util.js';

const STATUS = {
  active: { label: 'Active', tone: 'info' },
  monitoring: { label: 'Monitoring', tone: 'warn' },
  'drying-complete': { label: 'Dry', tone: 'good' },
  closed: { label: 'Closed', tone: '' },
};

export async function newJobForm() {
  const res = await openForm({
    title: 'New job',
    subtitle: 'Only the loss date and source are needed to start — the rest can wait.',
    submitLabel: 'Create job',
    fields: [
      { k: 'name', label: 'Insured / property name', type: 'text', placeholder: 'Rivera residence', required: true },
      { k: 'address', label: 'Address', type: 'text', placeholder: '1420 Oak St' },
      { k: 'city', label: 'City', type: 'text', half: true },
      { k: 'state', label: 'State', type: 'text', half: true },
      { k: 'phone', label: 'Client phone', type: 'tel', half: true },
      { k: 'email', label: 'Client email', type: 'email', half: true },
      { k: 'lossDate', label: 'Date & time of loss', type: 'datetime-local', value: new Date(Date.now() - 36e5).toISOString().slice(0, 16), required: true },
      { k: 'sourceId', label: 'Source of water', type: 'select', options: WATER_SOURCES.map((s) => ({ value: s.id, label: s.label })), value: 'supply_line' },
      { k: 'description', label: 'What happened', type: 'textarea', rows: 2, placeholder: 'Supply line under the kitchen sink failed overnight…' },
      { k: 'section', label: 'Claim', type: 'section' },
      { k: 'carrier', label: 'Insurance carrier', type: 'text', half: true },
      { k: 'claimNumber', label: 'Claim number', type: 'text', half: true },
    ],
  });
  if (!res) return null;

  const job = store.createJob({
    site: { name: res.name, address: res.address, city: res.city, state: res.state },
    loss: {
      dateISO: res.lossDate ? new Date(res.lossDate).toISOString() : nowISO(),
      sourceId: res.sourceId,
      description: res.description,
    },
    carrier: { name: res.carrier, claimNumber: res.claimNumber },
  });
  if (res.phone || res.email) {
    store.updateJob(job.id, (j) => {
      j.contacts.push({
        id: `c_${Date.now()}`, role: 'Client', name: res.name,
        phone: res.phone, email: res.email, company: '', notes: '',
      });
    });
  }
  return job;
}

function jobCard(job) {
  const d = derive(job, store.settings);
  const st = STATUS[job.status] || STATUS.active;
  const days = Math.max(0, Math.floor(daysBetween(job.loss.dateISO, null) ?? 0));
  const dry = d.drying.total ? `${d.drying.pctDry}% at goal` : 'no readings yet';
  return `
    <a class="list-item" href="#/job/${job.id}/overview">
      <div class="list-item__icon">${d.cls === 4 ? '🪵' : d.category >= 3 ? '☣️' : '💧'}</div>
      <div class="list-item__main">
        <strong>${esc(job.site.name || job.site.address || 'Untitled job')}</strong>
        <small>${esc(job.jobNumber)} · Cat ${d.category} / Class ${d.cls} · day ${days} · ${esc(dry)}</small>
      </div>
      <div class="list-item__right">
        ${pill(st.label, st.tone)}
        <div class="tiny" style="margin-top:4px">${d.deployed.active} eq · ${money(d.money.total, { cents: false })}</div>
      </div>
    </a>`;
}

export default {
  id: 'jobs',
  title: 'Jobs',

  render() {
    const jobs = store.jobs;
    const open = jobs.filter((j) => j.status !== 'closed');
    const closed = jobs.filter((j) => j.status === 'closed');

    if (!jobs.length) {
      return card(emptyState('🏚️', 'No jobs yet',
        'Start a job when you roll up to a loss. Everything is stored on this device and works with no signal.',
        '<button class="btn btn--primary" data-new style="margin-top:12px">Start a job</button>'));
    }

    return `
      ${card(`${cardHead('Open jobs', `<button class="btn btn--sm btn--primary" data-new>+ New</button>`)}
        <div class="list">${open.map(jobCard).join('') || '<p class="muted">Nothing open.</p>'}</div>`)}
      ${closed.length ? card(`${cardHead('Closed')}<div class="list">${closed.map(jobCard).join('')}</div>`) : ''}
      ${card(`${cardHead('Device data')}
        <p class="muted">${jobs.length} job${jobs.length === 1 ? '' : 's'} stored on this device. Back up before switching phones.</p>
        <div class="row row--wrap" style="margin-top:10px">
          <button class="btn btn--sm" data-backup>Export backup</button>
          <button class="btn btn--sm" data-restore>Import backup</button>
          <a class="btn btn--sm" href="#/settings">Settings</a>
        </div>`, 'card--flat')}
      <button class="fab" data-new>+ New job</button>
    `;
  },

  mount(root, ctx) {
    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-new]')) {
        const job = await newJobForm();
        if (job) ctx.navigate(`#/job/${job.id}/overview`);
      }
      if (e.target.closest('[data-backup]')) {
        download(`dryplan-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', store.exportAll());
        toast('Backup exported', 'good');
      }
      if (e.target.closest('[data-restore]')) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          try {
            const count = store.importAll(await file.text(), { merge: true });
            toast(`Imported ${count} job${count === 1 ? '' : 's'}`, 'good');
            ctx.refresh();
          } catch (err) {
            toast(`Import failed: ${err.message}`, 'bad');
          }
        };
        input.click();
      }
    });

    // long-press a job for archive / duplicate / delete
    let timer = null;
    let suppressClick = false;
    root.addEventListener('click', (e) => {
      if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; }
    }, true);
    root.addEventListener('pointerdown', (e) => {
      const link = e.target.closest('a.list-item[href^="#/job/"]');
      if (!link) return;
      const id = link.getAttribute('href').split('/')[2];
      timer = setTimeout(async () => {
        timer = null;
        suppressClick = true;
        const job = store.job(id);
        if (!job) return;
        const choice = await actionSheet({
          title: job.site.name || job.jobNumber,
          actions: [
            { id: 'status', label: 'Change status', icon: '🔁' },
            { id: 'duplicate', label: 'Duplicate job', icon: '⧉' },
            { id: 'export', label: 'Export this job', icon: '⬇︎' },
            { id: 'delete', label: 'Delete job', icon: '🗑', danger: true },
          ],
        });
        if (choice === 'status') {
          const res = await openForm({
            title: 'Job status', size: 'sm',
            fields: [{
              k: 'status', label: 'Status', type: 'select', value: job.status,
              options: Object.entries(STATUS).map(([value, v]) => ({ value, label: v.label })),
            }],
          });
          if (res) { store.updateJob(id, (j) => { j.status = res.status; }); ctx.refresh(); }
        } else if (choice === 'duplicate') {
          store.duplicateJob(id); ctx.refresh(); toast('Job duplicated');
        } else if (choice === 'export') {
          download(`${job.jobNumber}.json`, 'application/json', JSON.stringify(job, null, 2));
        } else if (choice === 'delete') {
          if (await confirmDialog({
            title: 'Delete this job?',
            message: 'The sketch, readings, logs and estimate are deleted from this device. Export a backup first if you need it.',
            confirmLabel: 'Delete', destructive: true,
          })) { store.deleteJob(id); ctx.refresh(); }
        }
      }, 550);
    });
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    root.addEventListener('pointerup', clear);
    root.addEventListener('pointermove', clear);
    root.addEventListener('pointercancel', clear);
  },
};
