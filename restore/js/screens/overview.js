// Job overview: the classification call, the drying picture and the loss file.

import { store } from '../store.js';
import { openForm, card, cardHead, pill, stat, row, confirmDialog } from '../ui.js';
import { WATER_SOURCES, CATEGORY_LABELS, CLASS_LABELS } from '../standards.js';
import { esc, fmtDate, money, toast, telHref, round } from '../util.js';

function classTone(cls) { return cls >= 3 ? 'bad' : cls === 2 ? 'warn' : 'good'; }
function catTone(cat) { return cat >= 3 ? 'bad' : cat === 2 ? 'warn' : 'good'; }

export default {
  id: 'overview',
  title: 'Overview',

  render(ctx) {
    const { job, d } = ctx;
    const client = job.contacts.find((c) => /client|insured|owner/i.test(c.role)) || null;
    const days = d.hours != null ? Math.floor(d.hours / 24) : null;

    return `
      ${card(`
        <div class="grid-2">
          <div class="stat">
            <span class="stat__label">Category ${d.categoryOverridden ? '(set by tech)' : '(auto)'}</span>
            <strong class="stat__value">${d.category}</strong>
            <span class="stat__sub">${esc(CATEGORY_LABELS[d.category].split('—')[1].trim())}</span>
          </div>
          <div class="stat">
            <span class="stat__label">Class ${d.classOverridden ? '(set by tech)' : '(auto)'}</span>
            <strong class="stat__value">${d.cls}</strong>
            <span class="stat__sub">${esc(CLASS_LABELS[d.cls].split('—')[1].trim())}</span>
          </div>
        </div>
        <details style="margin-top:10px">
          <summary class="muted" style="cursor:pointer">Why this call?</summary>
          <p class="dim" style="margin-top:8px;font-weight:700">Category</p>
          <ul class="rationale">${d.categoryRationale.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
          <p class="dim" style="margin-top:8px;font-weight:700">Class</p>
          <ul class="rationale">${d.classRationale.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        </details>
        <div class="row row--wrap" style="margin-top:12px">
          <button class="btn btn--sm" data-override>Override call</button>
          <a class="btn btn--sm" href="#/job/${job.id}/plan">Edit affected areas</a>
        </div>
      `, '')}

      ${card(`${cardHead('Drying progress')}
        <div class="grid-3">
          ${stat('Points at goal', `${d.drying.atGoal}/${d.drying.total}`, `${d.drying.pctDry}% dry`)}
          ${stat('Equipment on site', String(d.deployed.active), `${d.rec.airMovers} AM recommended`)}
          ${stat('Day', days != null ? String(days) : '—', d.hours != null ? `${Math.round(d.hours)} hrs since loss` : 'set loss date')}
        </div>
        <div class="progress ${d.drying.pctDry === 100 ? 'progress--good' : ''}" style="margin-top:12px"><span style="width:${d.drying.pctDry}%"></span></div>
        ${d.drying.stalled.length ? `<div class="callout callout--warn" style="margin-top:10px">${d.drying.stalled.length} monitoring point${d.drying.stalled.length === 1 ? ' has' : 's have'} not moved since the last reading. Check airflow, look for trapped water, or add specialty drying.</div>` : ''}
        ${d.drying.allDry ? `<div class="callout callout--good" style="margin-top:10px">Every monitoring point is at goal. Document a final reading, pull equipment and close out drying.</div>` : ''}
      `)}

      ${card(`${cardHead('Work practices required', pill(`Category ${d.category}`, catTone(d.category)))}
        <ul class="rationale">${d.requirements.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      `)}

      ${card(`${cardHead('Loss', `<button class="btn btn--sm" data-edit-loss>Edit</button>`)}
        ${row('Loss date', esc(fmtDate(job.loss.dateISO, { withTime: true })))}
        ${row('Source', esc((WATER_SOURCES.find((s) => s.id === job.loss.sourceId) || {}).label || '—'))}
        ${row('Source stopped', job.loss.sourceStopped ? 'Yes' : '<span style="color:#fca5a5">No — stop the source first</span>')}
        ${row('Ambient temp', `${job.loss.ambientTempF ?? '—'}°F`)}
        ${job.loss.description ? `<p class="muted" style="margin-top:8px">${esc(job.loss.description)}</p>` : ''}
      `)}

      ${card(`${cardHead('Structure', `<button class="btn btn--sm" data-edit-site>Edit</button>`)}
        ${row('Address', esc([job.site.address, job.site.city, job.site.state, job.site.zip].filter(Boolean).join(', ') || '—'))}
        ${row('Rooms sketched', `${d.totals.rooms}`)}
        ${row('Affected floor', `${d.totals.affectedFloor} sf`)}
        ${row('Affected volume', `${d.rec.volume ? round(d.rec.volume) : 0} cf`)}
        <div class="row row--wrap" style="margin-top:10px">
          ${job.site.address ? `<a class="btn btn--sm" target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent([job.site.address, job.site.city, job.site.state].filter(Boolean).join(' '))}">Navigate</a>` : ''}
          ${client?.phone ? `<a class="btn btn--sm" href="${telHref(client.phone)}">Call ${esc(client.name || 'client')}</a>` : ''}
          <a class="btn btn--sm" href="#/job/${job.id}/contacts">Contacts</a>
        </div>
      `)}

      ${card(`${cardHead('Claim', `<button class="btn btn--sm" data-edit-carrier>Edit</button>`)}
        ${row('Carrier', esc(job.carrier.name || '—'))}
        ${row('Claim #', esc(job.carrier.claimNumber || '—'))}
        ${row('Policy #', esc(job.carrier.policyNumber || '—'))}
        ${row('Adjuster', esc(job.carrier.adjuster || '—'))}
        ${row('Deductible', job.carrier.deductible ? money(job.carrier.deductible) : '—')}
      `)}

      ${card(`${cardHead('Money')}
        <div class="grid-3">
          ${stat('Estimate', money(d.money.total, { cents: false }))}
          ${stat('Job cost', money(d.money.expenseTotal, { cents: false }), `${d.money.miles} mi logged`)}
          ${stat('Receivable', money(d.money.receivable, { cents: false }))}
        </div>
        <div class="row row--wrap" style="margin-top:10px">
          <a class="btn btn--sm" href="#/job/${job.id}/estimate">Estimate</a>
          <a class="btn btn--sm" href="#/job/${job.id}/costs">Job costs</a>
          <a class="btn btn--sm" href="#/job/${job.id}/report">Report</a>
        </div>
      `)}
    `;
  },

  mount(root, ctx) {
    const { job } = ctx;

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-override]')) {
        const d = ctx.d;
        const res = await openForm({
          title: 'Override the classification',
          subtitle: 'Auto values come from the source, elapsed time and the wet surface area on the plan. Override when field conditions say otherwise.',
          fields: [
            { k: 'category', label: 'Category of water', type: 'select', value: String(job.loss.categoryOverride ?? ''), options: [{ value: '', label: `Auto — Category ${d.categoryAuto}` }, { value: '1', label: 'Category 1' }, { value: '2', label: 'Category 2' }, { value: '3', label: 'Category 3' }] },
            { k: 'cls', label: 'Class of loss', type: 'select', value: String(job.loss.classOverride ?? ''), options: [{ value: '', label: `Auto — Class ${d.classAuto ?? '—'}` }, { value: '1', label: 'Class 1' }, { value: '2', label: 'Class 2' }, { value: '3', label: 'Class 3' }, { value: '4', label: 'Class 4' }] },
            { k: 'why', label: 'Reason for the override', type: 'textarea', rows: 2, value: job.loss.overrideNote || '', hint: 'This goes in the report — write it for the adjuster.' },
          ],
        });
        if (res) {
          store.updateJob(job.id, (j) => {
            j.loss.categoryOverride = res.category ? Number(res.category) : null;
            j.loss.classOverride = res.cls ? Number(res.cls) : null;
            j.loss.overrideNote = res.why;
          });
          ctx.refresh();
        }
      }

      if (e.target.closest('[data-edit-loss]')) {
        const res = await openForm({
          title: 'Loss details',
          fields: [
            { k: 'lossDate', label: 'Date & time of loss', type: 'datetime-local', value: (job.loss.dateISO || '').slice(0, 16) },
            { k: 'sourceId', label: 'Source of water', type: 'select', value: job.loss.sourceId, options: WATER_SOURCES.map((s) => ({ value: s.id, label: s.label })) },
            { k: 'ambientTempF', label: 'Ambient temp °F', type: 'number', half: true, value: job.loss.ambientTempF },
            { k: 'sourceStopped', label: 'Source has been stopped', type: 'checkbox', value: job.loss.sourceStopped },
            { k: 'contactedContaminants', label: 'Water contacted contaminated materials', type: 'checkbox', value: job.loss.contactedContaminants },
            { k: 'occupantSensitive', label: 'High-risk occupants (infant, elderly, immunocompromised)', type: 'checkbox', value: job.loss.occupantSensitive },
            { k: 'description', label: 'Description', type: 'textarea', rows: 3, value: job.loss.description },
          ],
        });
        if (res) {
          store.updateJob(job.id, (j) => {
            Object.assign(j.loss, {
              dateISO: res.lossDate ? new Date(res.lossDate).toISOString() : j.loss.dateISO,
              sourceId: res.sourceId,
              ambientTempF: res.ambientTempF,
              sourceStopped: res.sourceStopped,
              contactedContaminants: res.contactedContaminants,
              occupantSensitive: res.occupantSensitive,
              description: res.description,
            });
          });
          ctx.refresh();
        }
      }

      if (e.target.closest('[data-edit-site]')) {
        const res = await openForm({
          title: 'Structure',
          fields: [
            { k: 'name', label: 'Insured / property name', type: 'text', value: job.site.name },
            { k: 'address', label: 'Address', type: 'text', value: job.site.address },
            { k: 'city', label: 'City', type: 'text', half: true, value: job.site.city },
            { k: 'state', label: 'State', type: 'text', half: true, value: job.site.state },
            { k: 'zip', label: 'ZIP', type: 'text', half: true, value: job.site.zip },
            { k: 'sqft', label: 'Structure sf', type: 'number', half: true, value: job.site.sqft },
            { k: 'occupied', label: 'Occupied during drying', type: 'checkbox', value: job.site.occupied },
          ],
        });
        if (res) { store.updateJob(job.id, (j) => Object.assign(j.site, res)); ctx.refresh(); }
      }

      if (e.target.closest('[data-edit-carrier]')) {
        const res = await openForm({
          title: 'Claim & carrier',
          fields: [
            { k: 'name', label: 'Carrier', type: 'text', value: job.carrier.name },
            { k: 'claimNumber', label: 'Claim number', type: 'text', half: true, value: job.carrier.claimNumber },
            { k: 'policyNumber', label: 'Policy number', type: 'text', half: true, value: job.carrier.policyNumber },
            { k: 'deductible', label: 'Deductible', type: 'number', half: true, value: job.carrier.deductible },
            { k: 'adjuster', label: 'Adjuster', type: 'text', value: job.carrier.adjuster },
            { k: 'adjusterPhone', label: 'Adjuster phone', type: 'tel', half: true, value: job.carrier.adjusterPhone },
            { k: 'adjusterEmail', label: 'Adjuster email', type: 'email', half: true, value: job.carrier.adjusterEmail },
          ],
        });
        if (res) { store.updateJob(job.id, (j) => Object.assign(j.carrier, res)); ctx.refresh(); }
      }
    });
  },
};
