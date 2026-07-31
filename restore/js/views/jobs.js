/* Job list, job creation, and the loss/classification setup screen. */

import { el, sheet, field, toast, confirmDialog, fmtDate, todayISO, download, esc, num } from '../util.js';
import * as store from '../store.js';
import { WATER_SOURCES, CATEGORY_GUIDANCE, CLASS_GUIDANCE, MATERIALS } from '../iicrc.js';

export default function renderJobs(view, { go }) {
  const jobs = store.state.jobs;

  view.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { text: 'Jobs' }),
      el('p', { class: 'mute', text: `${jobs.length} job${jobs.length === 1 ? '' : 's'} on this device` }),
    ),
    el('button', { class: 'btn btn-primary btn-sm', onClick: () => newJobSheet(go) }, '+ New Job'),
  ));

  if (!jobs.length) {
    view.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
      el('div', { class: 'empty-ico', text: '▦' }),
      el('h2', { text: 'No jobs yet' }),
      el('p', { text: 'Start a loss to sketch the affected area, map moisture, and size equipment.' }),
      el('button', { class: 'btn btn-primary', onClick: () => newJobSheet(go) }, 'Start first job'),
    )));
    view.append(importCard());
    return;
  }

  const active = jobs.filter((j) => j.status !== 'closed');
  const closed = jobs.filter((j) => j.status === 'closed');

  if (active.length) view.append(jobGroup('Active', active, go));
  if (closed.length) view.append(el('div', { class: 'spacer' }), jobGroup('Closed', closed, go));
  view.append(el('div', { class: 'spacer' }), importCard());
}

function jobGroup(label, jobs, go) {
  const list = el('div', { class: 'list' });
  for (const job of jobs) {
    const cls = store.classification(job);
    const progress = store.dryingProgress(job);
    list.append(el('button', {
      class: 'list-item',
      onClick: async () => { await store.openJob(job.id); go(job.rooms.length ? 'plan' : 'setup'); },
    },
      el('div', { class: 'li-main' },
        el('div', { class: 'li-title', text: job.claim?.insured || job.jobNumber || 'Untitled job' }),
        el('div', { class: 'li-sub', text: [job.claim?.address, job.claim?.claimNumber && `Claim ${job.claim.claimNumber}`, `DOL ${fmtDate(job.claim?.dateOfLoss)}`].filter(Boolean).join(' · ') }),
      ),
      el('div', { class: 'row', style: 'gap:6px' },
        cls ? el('span', { class: `chip ${catChipClass(cls.category)}`, text: `C${cls.category}/${cls.class}` }) : null,
        progress.measured ? el('span', { class: `chip ${progress.complete ? 'chip-green' : 'chip-blue'}`, text: `${Math.round(progress.pct)}%` }) : null,
      ),
      el('span', { class: 'li-chev', text: '›' }),
    ));
  }
  return el('div', {},
    el('p', { class: 'eyebrow', style: 'margin-bottom:8px', text: label }),
    el('div', { class: 'card' }, list),
  );
}

function catChipClass(cat) {
  return cat === 3 ? 'chip-red' : cat === 2 ? 'chip-amber' : 'chip-green';
}

function importCard() {
  const input = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const job = await store.importJob(await file.text());
      toast(`Imported ${job.claim?.insured || 'job'}.`, 'success');
    } catch (err) {
      toast(err.message || 'Could not read that file.', 'error');
    }
    input.value = '';
  });
  return el('div', { class: 'card' },
    el('div', { class: 'card-body' },
      el('p', { class: 'eyebrow', style: 'margin-bottom:8px', text: 'Transfer' }),
      el('p', { class: 'mute', style: 'margin-bottom:12px', text: 'Jobs live on this device. Export to hand a job to another tech or to back it up before wiping the browser.' }),
      el('button', { class: 'btn btn-ghost btn-block', onClick: () => input.click() }, 'Import job file'),
      input,
    ),
  );
}

export function openJobList({ go }) {
  const { body, close } = sheet('Switch job');
  const list = el('div', { class: 'list' });
  for (const job of store.state.jobs) {
    list.append(el('div', { class: 'list-item' },
      el('div', { class: 'li-main', onClick: async () => { await store.openJob(job.id); close(); go('plan'); } },
        el('div', { class: 'li-title', text: job.claim?.insured || 'Untitled job' }),
        el('div', { class: 'li-sub', text: job.claim?.address || fmtDate(job.createdAt) }),
      ),
      el('button', {
        class: 'icon-btn', 'aria-label': 'Delete job',
        onClick: async () => {
          if (await confirmDialog(`Delete "${job.claim?.insured || 'this job'}" and all of its readings, photos and costs? This cannot be undone.`)) {
            await store.deleteJob(job.id);
            close();
            go('jobs');
          }
        },
      }, '🗑'),
    ));
  }
  body.append(
    store.state.jobs.length ? list : el('p', { class: 'mute center', text: 'No jobs yet.' }),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn-primary btn-block', onClick: () => { close(); newJobSheet(go); } }, '+ New job'),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn-ghost btn-block', onClick: () => { close(); go('jobs'); } }, 'All jobs'),
  );
}

function newJobSheet(go) {
  const { body, close } = sheet('New job');
  const insured = field('Insured / client name', { placeholder: 'Jane Doe', autofocus: true });
  const address = field('Loss address', { placeholder: '123 Main St' });
  const jobNumber = field('Job number', { placeholder: 'Optional' });
  const claimNumber = field('Claim number', { placeholder: 'Optional' });
  const dol = field('Date of loss', { type: 'date', value: todayISO() });

  body.append(insured.wrap, address.wrap,
    el('div', { class: 'grid-2' }, jobNumber.wrap, claimNumber.wrap),
    dol.wrap,
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: async () => {
        if (!insured.input.value.trim() && !jobNumber.input.value.trim()) {
          toast('Enter at least a client name or job number.', 'error');
          return;
        }
        await store.createJob({
          jobNumber: jobNumber.input.value.trim(),
          claim: {
            ...store.newJob().claim,
            insured: insured.input.value.trim(),
            address: address.input.value.trim(),
            claimNumber: claimNumber.input.value.trim(),
            dateOfLoss: dol.input.value || todayISO(),
          },
        });
        close();
        go('setup');
      },
    }, 'Create job'),
  );
  setTimeout(() => insured.input.focus(), 60);
}

/* ── Setup / classification screen ────────────────────────────────────────── */

export function renderJobSetup(view, { go }) {
  const job = store.state.job;
  if (!job) return go('jobs');

  const rerender = () => { view.innerHTML = ''; renderJobSetup(view, { go }); };
  const cls = store.classification(job);

  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: 'Loss details' }), el('p', { class: 'mute', text: 'Source and materials drive the category and class.' })),
    el('button', { class: 'btn btn-sm', onClick: () => go('plan') }, 'Plan →'),
  ));

  /* Claim info */
  const claim = job.claim;
  const bind = (obj, key) => (e) => store.update((j) => {
    const target = key.split('.').reduce((o, k, i, arr) => (i === arr.length - 1 ? o : o[k]), obj);
    obj[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  }, { silent: true });

  const claimFields = el('div', { class: 'card-body' },
    el('div', { class: 'grid-2' },
      wire(field('Insured', { value: claim.insured }), (v) => store.update((j) => { j.claim.insured = v; })),
      wire(field('Job number', { value: job.jobNumber }), (v) => store.update((j) => { j.jobNumber = v; })),
    ),
    wire(field('Loss address', { value: claim.address }), (v) => store.update((j) => { j.claim.address = v; })),
    el('div', { class: 'grid-3' },
      wire(field('City', { value: claim.city }), (v) => store.update((j) => { j.claim.city = v; })),
      wire(field('State', { value: claim.state }), (v) => store.update((j) => { j.claim.state = v; })),
      wire(field('ZIP', { value: claim.zip, inputmode: 'numeric' }), (v) => store.update((j) => { j.claim.zip = v; })),
    ),
    el('div', { class: 'grid-2' },
      wire(field('Carrier', { value: claim.carrier }), (v) => store.update((j) => { j.claim.carrier = v; })),
      wire(field('Claim #', { value: claim.claimNumber }), (v) => store.update((j) => { j.claim.claimNumber = v; })),
    ),
    el('div', { class: 'grid-2' },
      wire(field('Policy #', { value: claim.policyNumber }), (v) => store.update((j) => { j.claim.policyNumber = v; })),
      wire(field('Deductible', { value: claim.deductible, inputmode: 'decimal' }), (v) => store.update((j) => { j.claim.deductible = v; })),
    ),
    el('div', { class: 'grid-2' },
      wire(field('Date of loss', { type: 'date', value: claim.dateOfLoss }), (v) => { store.update((j) => { j.claim.dateOfLoss = v; }); rerender(); }),
      wire(field('Time of loss', { type: 'time', value: claim.timeOfLoss }), (v) => { store.update((j) => { j.claim.timeOfLoss = v; }); rerender(); }),
    ),
  );
  view.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: 'Claim' })),
    claimFields,
  ), el('div', { class: 'spacer' }));

  /* Category */
  const sourceSel = field('Water source', {
    type: 'select',
    value: job.loss.sourceId,
    options: [{ value: '', label: 'Select the source…' }, ...WATER_SOURCES.map((s) => ({ value: s.id, label: `${s.label} (Cat ${s.cat})` }))],
  });
  sourceSel.input.addEventListener('change', () => { store.update((j) => { j.loss.sourceId = sourceSel.input.value; }); rerender(); });

  const catOverride = field('Category', {
    type: 'select',
    value: job.loss.categoryOverride ?? '',
    options: [
      { value: '', label: `Auto — detected Category ${cls.detectedCategory}` },
      { value: '1', label: 'Category 1 — Sanitary' },
      { value: '2', label: 'Category 2 — Significantly contaminated' },
      { value: '3', label: 'Category 3 — Grossly contaminated' },
    ],
  });
  catOverride.input.addEventListener('change', () => {
    const v = catOverride.input.value;
    store.update((j) => { j.loss.categoryOverride = v === '' ? null : Number(v); });
    rerender();
  });

  const growth = field('Visible microbial growth', { type: 'checkbox', value: job.loss.visibleGrowth });
  growth.input.addEventListener('change', () => { store.update((j) => { j.loss.visibleGrowth = growth.input.checked; }); rerender(); });
  const contaminated = field('Water contacted contaminated materials', { type: 'checkbox', value: job.loss.contactedContaminated });
  contaminated.input.addEventListener('change', () => { store.update((j) => { j.loss.contactedContaminated = contaminated.input.checked; }); rerender(); });

  const catGuide = CATEGORY_GUIDANCE[cls.category];
  view.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', { text: 'Category of water' }),
      el('span', { class: `chip ${catChipClass(cls.category)}`, text: `Category ${cls.category}` }),
    ),
    el('div', { class: 'card-body' },
      sourceSel.wrap,
      growth.wrap, contaminated.wrap,
      el('div', { class: 'spacer' }),
      catOverride.wrap,
      cls.categoryOverridden ? el('div', { class: 'note note-warn' }, el('strong', { text: 'Manual override. ' }), `Detection says Category ${cls.detectedCategory}. Document why you differ.`) : null,
      el('div', { class: 'stack', style: 'margin-top:10px' },
        ...cls.categoryReasons.map((r) => el('div', { class: 'note', text: r })),
        cls.degraded && cls.hoursToNextCategory === 0
          ? null
          : cls.hoursToNextCategory > 0 && cls.hoursToNextCategory < 999
            ? el('div', { class: 'note note-warn', html: `<strong>${Math.round(cls.hoursToNextCategory)} hrs</strong> until this source degrades to the next category at current temperature.` })
            : null,
      ),
      el('div', { class: 'note note-danger', style: 'margin-top:10px', html: `<strong>${esc(catGuide.label)}</strong><br>PPE: ${esc(catGuide.ppe)}<br>${esc(catGuide.notes)}` }),
    ),
  ), el('div', { class: 'spacer' }));

  /* Class */
  const m = cls.metrics;
  const classOverride = field('Class', {
    type: 'select',
    value: job.loss.classOverride ?? '',
    options: [
      { value: '', label: `Auto — detected Class ${cls.detectedClass}` },
      { value: '1', label: 'Class 1 — least evaporation load' },
      { value: '2', label: 'Class 2 — significant load' },
      { value: '3', label: 'Class 3 — greatest load' },
      { value: '4', label: 'Class 4 — specialty / bound water' },
    ],
  });
  classOverride.input.addEventListener('change', () => {
    const v = classOverride.input.value;
    store.update((j) => { j.loss.classOverride = v === '' ? null : Number(v); });
    rerender();
  });
  const lowEvap = field('Deeply held water in low-evaporation materials (hardwood, plaster, concrete, masonry)', { type: 'checkbox', value: job.loss.lowEvaporationMaterials });
  lowEvap.input.addEventListener('change', () => { store.update((j) => { j.loss.lowEvaporationMaterials = lowEvap.input.checked; }); rerender(); });

  view.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', { text: 'Class of water' }),
      el('span', { class: 'chip chip-blue', text: `Class ${cls.class}` }),
    ),
    el('div', { class: 'stats' },
      stat(Math.round(m.totalFloor).toLocaleString(), 'Floor SF'),
      stat(Math.round(m.totalSurface).toLocaleString(), 'Surface SF'),
      stat(Math.round(m.totalVolume).toLocaleString(), 'Cu FT'),
      stat(`${Math.round(cls.wetPorousPct)}%`, 'Wet porous'),
    ),
    el('div', { class: 'card-body' },
      m.roomCount === 0
        ? el('div', { class: 'note note-warn', html: 'No rooms sketched yet. <strong>Class is a function of wet surface area</strong> — sketch the affected rooms on the Plan tab to classify this loss properly.' })
        : null,
      lowEvap.wrap,
      el('div', { class: 'spacer' }),
      classOverride.wrap,
      cls.classOverridden ? el('div', { class: 'note note-warn' }, el('strong', { text: 'Manual override. ' }), `Detection says Class ${cls.detectedClass}.`) : null,
      el('div', { class: 'stack', style: 'margin-top:10px' },
        ...cls.classReasons.map((r) => el('div', { class: 'note', text: r })),
        el('div', { class: 'note', text: CLASS_GUIDANCE[cls.class] }),
      ),
    ),
  ), el('div', { class: 'spacer' }));

  view.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: 'Notes' })),
    el('div', { class: 'card-body' },
      wire(field('Cause of loss / scope notes', { type: 'textarea', value: job.loss.causeNotes, placeholder: 'What failed, what you found on arrival, what the client reported…' }),
        (v) => store.update((j) => { j.loss.causeNotes = v; })),
    ),
  ), el('div', { class: 'spacer' }));

  view.append(el('div', { class: 'btn-row' },
    el('button', { class: 'btn btn-ghost', onClick: () => download(`${slug(job)}-job.json`, store.exportJob(job), 'application/json') }, 'Export job'),
    el('button', {
      class: 'btn',
      onClick: () => {
        store.update((j) => { j.status = j.status === 'closed' ? 'active' : 'closed'; });
        toast(job.status === 'closed' ? 'Job closed.' : 'Job reopened.');
        rerender();
      },
    }, job.status === 'closed' ? 'Reopen job' : 'Close job'),
  ));
}

function stat(value, label, tone) {
  return el('div', { class: 'stat' },
    el('div', { class: `stat-val ${tone || ''}`, text: value }),
    el('div', { class: 'stat-lbl', text: label }),
  );
}

/** Wire a field to a save handler on blur/change — no save-button hunting. */
export function wire(f, onSave) {
  const commit = () => onSave(f.input.type === 'checkbox' ? f.input.checked : f.input.value);
  f.input.addEventListener('change', commit);
  f.input.addEventListener('blur', commit);
  return f.wrap;
}

export function slug(job) {
  const base = job.jobNumber || job.claim?.insured || 'job';
  return String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'job';
}

export { stat, MATERIALS };
