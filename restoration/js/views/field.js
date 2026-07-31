/**
 * Field day: the daily log, the drive, the people on the job, and photos.
 *
 * These live on one screen because they are one workflow — you arrive, you
 * work, you tell people what you found, you leave.
 */

import * as store from '../store.js';
import {
  esc, onAct, formSheet, toast, sheet, statCard, sectionHeader, emptyState,
  confirmDialog, signaturePad, pickPhoto,
} from '../ui.js';
import { uid, nowIso, num, round, fmtDate, fmtDateTime, fmtTime, dayKey, sum, money } from '../util.js';
import * as drive from '../drive.js';
import { pointStatuses, dryingSummary, environment, totals, classify } from '../jobcalc.js';
import { LABOR_ROLES } from '../estimate.js';

const CONTACT_ROLES = [
  { value: 'client', label: 'Client / property owner' },
  { value: 'adjuster', label: 'Insurance adjuster' },
  { value: 'agent', label: 'Insurance agent' },
  { value: 'project_manager', label: 'Project manager (office)' },
  { value: 'estimator', label: 'Estimator' },
  { value: 'technician', label: 'Technician (crew)' },
  { value: 'plumber', label: 'Plumber / trade' },
  { value: 'property_manager', label: 'Property manager' },
  { value: 'other', label: 'Other' },
];

const CHANNELS = [
  { value: 'call', label: 'Call' },
  { value: 'text', label: 'Text' },
  { value: 'email', label: 'Email' },
  { value: 'in_person', label: 'In person' },
  { value: 'note', label: 'Note' },
];

export async function render(ctx) {
  const job = ctx.job;
  const today = dayKey();
  const todayLog = (job.dailyLogs || []).find((d) => d.date === today);
  const trips = [...(job.trips || [])].sort((a, b) => new Date(b.startedAt || b.at) - new Date(a.startedAt || a.at));
  const totalMiles = sum(trips, (t) => t.miles);
  const photos = await store.photosForJob(job.id);
  const activeTrip = drive.activeTrip();
  const mapUrl = drive.directionsUrl(job);

  const html = `
    <div class="stat-grid">
      ${statCard('Dailies', (job.dailyLogs || []).length, 'logged')}
      ${statCard('Miles', round(totalMiles, 1), 'this job')}
      ${statCard('Photos', photos.length, 'on device')}
      ${statCard('Contacts', (job.contacts || []).length, 'on this job')}
    </div>

    ${sectionHeader("Today's daily", todayLog
      ? `<button class="btn btn-sm" data-act="daily" data-date="${today}">Edit</button>`
      : `<button class="btn btn-sm btn-primary" data-act="daily" data-date="${today}">Start</button>`)}
    <div class="card">
      ${todayLog ? `
        <div class="card-row"><span class="label">On site</span><span class="value">
          ${todayLog.arrivedAt ? fmtTime(todayLog.arrivedAt) : '—'} → ${todayLog.departedAt ? fmtTime(todayLog.departedAt) : 'still on site'}</span></div>
        <div class="card-row"><span class="label">Crew</span><span class="value">${esc(todayLog.techs || '—')}</span></div>
        ${todayLog.workPerformed ? `<p class="small mt">${esc(todayLog.workPerformed)}</p>` : ''}
        ${todayLog.signatureDataUrl ? `<p class="tiny muted mt">Signed by ${esc(todayLog.signerName || 'client')}</p>` : ''}
      ` : `<p class="muted small">Nothing logged today. The daily is what proves the visit happened — carriers pay monitoring on it.</p>`}
      <div class="btn-row mt">
        <button class="btn btn-sm" data-act="autofill">Build from today's readings</button>
        <button class="btn btn-sm" data-act="daily-list">All dailies</button>
      </div>
    </div>

    ${sectionHeader('Drive', mapUrl ? `<a class="btn btn-sm" href="${esc(mapUrl)}" target="_blank" rel="noopener">Directions</a>` : '')}
    <div class="card">
      ${activeTrip ? `
        <div class="card-row"><span class="label">Tracking</span>
          <span class="value" id="live-miles">${round(activeTrip.miles, 1)} mi</span></div>
        <div class="card-row"><span class="label">Started</span><span class="value">${esc(fmtTime(activeTrip.startedAt))}</span></div>
        <button class="btn btn-danger btn-block mt" data-act="stop-trip">Stop tracking</button>
        <button class="btn btn-ghost btn-block" data-act="cancel-trip">Discard this drive</button>
      ` : `
        <div class="btn-row">
          <button class="btn btn-primary" data-act="start-trip">Track a drive</button>
          <button class="btn" data-act="manual-trip">Enter miles</button>
        </div>`}
      ${trips.length ? `
        <div class="divider"></div>
        ${trips.slice(0, 6).map((t) => `
          <div class="card-row">
            <span class="label">${esc(t.purpose || 'Drive')}<br><span class="tiny">${esc(fmtDate(t.startedAt || t.at))}${t.billable === false ? ' · not billable' : ''}</span></span>
            <span class="value">${round(t.miles, 1)} mi<br><span class="tiny muted">${money(num(t.miles) * num(ctx.settings.mileageRate, 0.7))}</span></span>
          </div>`).join('')}
        <div class="card-row"><span class="label"><strong>Total</strong></span>
          <span class="value"><strong>${round(totalMiles, 1)} mi · ${money(totalMiles * num(ctx.settings.mileageRate, 0.7))}</strong></span></div>
      ` : ''}
    </div>

    ${sectionHeader('People', `<button class="btn btn-sm btn-primary" data-act="add-contact">+ Contact</button>`)}
    ${(job.contacts || []).length ? (job.contacts || []).map(contactCard).join('')
      : emptyState('No contacts', 'Add the client, the adjuster and your office so you can reach them without leaving the job.',
        `<button class="btn btn-primary" data-act="add-contact">Add a contact</button>`)}

    ${sectionHeader('Communication log', `<button class="btn btn-sm" data-act="add-comm">+ Entry</button>`)}
    <div class="card">
      ${(job.comms || []).length ? [...job.comms].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 12).map((c) => {
        const who = (job.contacts || []).find((x) => x.id === c.contactId);
        return `<div class="card-row">
            <span class="label">${esc(who?.name || 'Someone')} · ${esc(CHANNELS.find((ch) => ch.value === c.channel)?.label || c.channel)}
              <br><span class="tiny">${esc(fmtDateTime(c.at))}</span></span>
            <span class="value" style="font-weight:400;text-align:left;max-width:60%">${esc(c.summary || '')}</span>
          </div>`;
      }).join('') : '<p class="muted small">Nothing logged. Every call you log is one you can prove you made.</p>'}
    </div>

    ${sectionHeader('Photos', `<button class="btn btn-sm btn-primary" data-act="add-photo">+ Photo</button>`)}
    <div class="card">
      ${photos.length ? `<div class="photo-grid" id="photo-grid">
        ${photos.map((p) => `<div class="photo-tile" data-act="photo" data-id="${esc(p.id)}">
            <img alt="${esc(p.caption || 'Job photo')}" data-photo="${esc(p.id)}">
            ${p.caption ? `<span class="cap">${esc(p.caption)}</span>` : ''}
          </div>`).join('')}
      </div>` : '<p class="muted small">No photos yet. Shoot the source, the affected area and the equipment as set.</p>'}
    </div>

    ${sectionHeader('Labour', `<button class="btn btn-sm" data-act="add-labor">+ Hours</button>`)}
    <div class="card">
      ${(job.labor || []).length ? `
        ${job.labor.map((l) => `<div class="card-row">
          <span class="label">${esc(LABOR_ROLES[l.role]?.label || l.role)}${l.date ? `<br><span class="tiny">${esc(fmtDate(l.date))}</span>` : ''}</span>
          <span class="value">${round(l.hours, 1)} h × ${money(l.rate)}<br><span class="tiny muted">${money(num(l.hours) * num(l.rate))}</span></span>
        </div>`).join('')}
        <div class="card-row"><span class="label"><strong>Total</strong></span>
          <span class="value"><strong>${money(sum(job.labor, (l) => num(l.hours) * num(l.rate)))}</strong></span></div>`
        : '<p class="muted small">No hours logged.</p>'}
    </div>`;

  return {
    title: 'Field',
    subtitle: job.client?.name,
    back: `#/job/${job.id}`,
    html,
    mount: (root) => mount(root, ctx, photos),
  };
}

function contactCard(c) {
  const role = CONTACT_ROLES.find((r) => r.value === c.role)?.label || c.role;
  return `
    <div class="card card-tight">
      <div class="row">
        <span class="grow">
          <strong>${esc(c.name || 'Contact')}</strong>
          <span class="tiny muted" style="display:block">${esc(role)}${c.company ? ` · ${esc(c.company)}` : ''}</span>
        </span>
        <button class="btn btn-sm btn-ghost" data-act="edit-contact" data-id="${esc(c.id)}">Edit</button>
      </div>
      <div class="btn-row mt">
        ${c.phone ? `<a class="btn btn-sm" href="tel:${esc(c.phone)}" data-act="log-call" data-id="${esc(c.id)}">Call</a>` : ''}
        ${c.phone ? `<a class="btn btn-sm" href="sms:${esc(c.phone)}" data-act="log-text" data-id="${esc(c.id)}">Text</a>` : ''}
        ${c.email ? `<a class="btn btn-sm" href="mailto:${esc(c.email)}" data-act="log-email" data-id="${esc(c.id)}">Email</a>` : ''}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */

function mount(root, ctx, photos) {
  const job = ctx.job;

  // Photo thumbnails come out of IndexedDB as blobs; wire up object URLs and
  // revoke them when the view is torn down.
  const urls = [];
  (async () => {
    for (const p of photos) {
      const img = root.querySelector(`img[data-photo="${CSS.escape(p.id)}"]`);
      if (!img || !p.blob) continue;
      const url = URL.createObjectURL(p.blob);
      urls.push(url);
      img.src = url;
    }
  })();

  drive.resumeIfTracking();
  const unsubscribe = drive.subscribe((trip) => {
    const el = root.querySelector('#live-miles');
    if (el && trip) el.textContent = `${round(trip.miles, 1)} mi`;
  });

  onAct(root, {
    daily: (el) => dailySheet(ctx, el.dataset.date),
    'daily-list': () => dailyList(ctx),
    autofill: () => autofillDaily(ctx),
    'start-trip': () => startTrip(ctx),
    'stop-trip': () => stopTrip(ctx),
    'cancel-trip': async () => {
      if (await confirmDialog('Discard this drive without saving the miles?', { confirmLabel: 'Discard', danger: true })) {
        drive.cancelTrip();
        ctx.refresh();
      }
    },
    'manual-trip': () => manualTrip(ctx),
    'add-contact': () => contactSheet(ctx),
    'edit-contact': (el) => contactSheet(ctx, el.dataset.id),
    'add-comm': () => commSheet(ctx),
    'log-call': (el) => quickLogComm(ctx, el.dataset.id, 'call'),
    'log-text': (el) => quickLogComm(ctx, el.dataset.id, 'text'),
    'log-email': (el) => quickLogComm(ctx, el.dataset.id, 'email'),
    'add-photo': () => addPhoto(ctx),
    photo: (el) => viewPhoto(ctx, el.dataset.id),
    'add-labor': () => laborSheet(ctx),
  });

  return () => {
    unsubscribe();
    urls.forEach((u) => URL.revokeObjectURL(u));
  };
}

/* -------------------------------- daily -------------------------------- */

async function dailySheet(ctx, date) {
  const job = ctx.job;
  const existing = (job.dailyLogs || []).find((d) => d.date === date) || {};
  let pad = null;

  const values = await new Promise((resolve) => {
    const fields = [
      { name: 'arrivedAt', label: 'Arrived', type: 'time', value: existing.arrivedAt ? toTime(existing.arrivedAt) : toTime(nowIso()) },
      { name: 'departedAt', label: 'Departed', type: 'time', value: existing.departedAt ? toTime(existing.departedAt) : '' },
      { name: 'techs', label: 'Technicians on site', type: 'text', full: true, value: existing.techs ?? ctx.settings.techName ?? '' },
      { name: 'workPerformed', label: 'Work performed', type: 'textarea', full: true, rows: 4, value: existing.workPerformed ?? '' },
      { name: 'equipmentAdjustments', label: 'Equipment adjustments', type: 'textarea', full: true, value: existing.equipmentAdjustments ?? '' },
      { name: 'monitoringPerformed', label: 'Monitoring readings taken', type: 'checkbox', full: true, value: existing.monitoringPerformed !== false },
      { name: 'clientPresent', label: 'Client present', type: 'checkbox', full: true, value: !!existing.clientPresent },
      { name: 'signerName', label: 'Signed by', type: 'text', full: true, value: existing.signerName ?? '' },
    ];

    import('../ui.js').then(({ formHtml, readForm, bindSegmented }) => {
      sheet({
        title: `Daily — ${fmtDate(date)}`,
        size: 'full',
        body: `<form class="sheet-form" novalidate>${formHtml(fields)}
            <div class="field full mt">
              <span class="field-label">Client signature</span>
              <canvas class="sig-pad" id="sig-pad"></canvas>
              <div class="btn-row mt"><button type="button" class="btn btn-sm" id="sig-clear">Clear signature</button></div>
            </div>
          </form>`,
        onMount: ({ root }) => {
          bindSegmented(root);
          const canvas = root.querySelector('#sig-pad');
          pad = signaturePad(canvas);
          if (existing.signatureDataUrl) {
            const img = new Image();
            img.onload = () => canvas.getContext('2d').drawImage(img, 0, 0, canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height);
            img.src = existing.signatureDataUrl;
          }
          root.querySelector('#sig-clear').addEventListener('click', () => pad.clear());
        },
        actions: [
          { label: 'Cancel', onClick: ({ close }) => { resolve(null); close(null); return false; } },
          {
            label: 'Save daily',
            variant: 'primary',
            onClick: ({ root, close }) => {
              resolve({ ...readForm(root, fields), signature: pad?.toPngDataUrl() || existing.signatureDataUrl || null });
              close(true);
              return false;
            },
          },
        ],
      });
    });
  });

  if (!values) return;

  await ctx.save((j) => {
    const log = (j.dailyLogs = j.dailyLogs || []).find((d) => d.date === date) || { id: uid('day'), date };
    Object.assign(log, {
      arrivedAt: values.arrivedAt ? fromTime(date, values.arrivedAt) : null,
      departedAt: values.departedAt ? fromTime(date, values.departedAt) : null,
      techs: values.techs,
      workPerformed: values.workPerformed,
      equipmentAdjustments: values.equipmentAdjustments,
      monitoringPerformed: values.monitoringPerformed,
      clientPresent: values.clientPresent,
      signerName: values.signerName,
      signatureDataUrl: values.signature,
      updatedAt: nowIso(),
    });
    if (!j.dailyLogs.includes(log)) j.dailyLogs.push(log);
  });
  toast('Daily saved.', 'success');
  ctx.refresh();
}

/**
 * Draft today's narrative from what the app already knows. The tech edits it —
 * it is a starting point, not a substitute for describing the actual work.
 */
async function autofillDaily(ctx) {
  const job = ctx.job;
  const drying = dryingSummary(job);
  const env = environment(job);
  const t = totals(job);
  const active = (job.equipment || []).filter((e) => !e.removedAt);
  const today = dayKey();
  const todaysReadings = (job.readings || []).filter((r) => dayKey(r.at) === today);

  const lines = [];
  lines.push(`Monitoring visit. ${t.rooms} room(s) affected, ${Math.round(t.affectedSqft)} ft² of wet floor.`);
  if (env) lines.push(`Chamber at ${round(env.inside.tempF)} °F and ${round(env.inside.rh)}% RH (${round(env.inside.gpp)} gpp).`);
  if (todaysReadings.length) lines.push(`${todaysReadings.length} moisture reading(s) recorded. ${drying.counts.dry} of ${drying.monitored} point(s) at the dry standard.`);
  if (active.length) {
    const counts = new Map();
    for (const e of active) counts.set(e.type, (counts.get(e.type) || 0) + (e.count || 1));
    lines.push(`Equipment running: ${[...counts].map(([type, n]) => `${n} ${type.replace(/_/g, ' ')}`).join(', ')}.`);
  }
  if (drying.stalled.length) lines.push(`${drying.stalled.length} point(s) not progressing — drying approach adjusted.`);
  if (drying.allDry) lines.push('All monitoring points have reached the dry standard. Recommend equipment removal.');

  await ctx.save((j) => {
    const log = (j.dailyLogs = j.dailyLogs || []).find((d) => d.date === today) || { id: uid('day'), date: today };
    log.workPerformed = [log.workPerformed, lines.join(' ')].filter(Boolean).join('\n\n');
    log.arrivedAt = log.arrivedAt || nowIso();
    log.techs = log.techs || ctx.settings.techName || '';
    log.monitoringPerformed = true;
    if (!j.dailyLogs.includes(log)) j.dailyLogs.push(log);
  });
  toast('Draft added to today’s daily — review it before you send anything.', 'success');
  await dailySheet(ctx, today);
}

async function dailyList(ctx) {
  const logs = [...(ctx.job.dailyLogs || [])].sort((a, b) => b.date.localeCompare(a.date));
  const picked = await sheet({
    title: 'Daily logs',
    size: 'full',
    body: logs.length ? logs.map((d) => `
        <button class="list-item" data-pick="${esc(d.date)}">
          <span class="grow">
            <span class="title">${esc(fmtDate(d.date))}</span>
            <span class="meta">${d.arrivedAt ? fmtTime(d.arrivedAt) : '—'}${d.departedAt ? ` → ${fmtTime(d.departedAt)}` : ''} · ${esc(d.techs || 'no crew listed')}</span>
          </span>
          <span class="chev">›</span>
        </button>`).join('') : '<p class="muted small">No dailies yet.</p>',
    onMount: ({ root, close }) => {
      root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pick]');
        if (btn) close(btn.dataset.pick);
      });
    },
    actions: [{ label: 'Close', value: null }],
  });
  if (picked) await dailySheet(ctx, picked);
}

/* -------------------------------- drive -------------------------------- */

async function startTrip(ctx) {
  const values = await formSheet({
    title: 'Track a drive',
    intro: 'Keep the app open or in the background. Mileage keeps counting if the screen locks, and it survives a reload.',
    submitLabel: 'Start',
    fields: [
      { name: 'purpose', label: 'Purpose', type: 'select', full: true, value: 'To jobsite',
        options: ['To jobsite', 'From jobsite', 'Supply run', 'Equipment pickup', 'Equipment return', 'Other'] },
      { name: 'billable', label: 'Billable to this job', type: 'checkbox', full: true, value: true },
    ],
  });
  if (!values) return;
  try {
    await drive.startTrip({ jobId: ctx.job.id, purpose: values.purpose, billable: values.billable });
    toast('Tracking. Stop it when you park.', 'success');
    ctx.refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function stopTrip(ctx) {
  const trip = drive.endTrip();
  if (!trip) return;
  const values = await formSheet({
    title: 'Drive complete',
    intro: `${round(trip.miles, 2)} miles tracked from ${trip.fixCount} location fixes. Adjust if your odometer disagrees.`,
    submitLabel: 'Save drive',
    fields: [
      { name: 'miles', label: 'Miles', type: 'number', value: round(trip.miles, 1), full: true },
      { name: 'purpose', label: 'Purpose', type: 'text', full: true, value: trip.purpose },
      { name: 'billable', label: 'Billable to this job', type: 'checkbox', full: true, value: trip.billable !== false },
    ],
  });
  await ctx.save((j) => {
    j.trips.push({
      ...trip,
      miles: values ? num(values.miles, trip.miles) : trip.miles,
      purpose: values?.purpose || trip.purpose,
      billable: values ? values.billable : trip.billable,
      tracked: true,
    });
  });
  toast('Drive saved.', 'success');
  ctx.refresh();
}

async function manualTrip(ctx) {
  const values = await formSheet({
    title: 'Enter miles',
    fields: [
      { name: 'miles', label: 'Miles', type: 'number', required: true },
      { name: 'date', label: 'Date', type: 'date', value: dayKey() },
      { name: 'purpose', label: 'Purpose', type: 'select', full: true, value: 'To jobsite',
        options: ['To jobsite', 'From jobsite', 'Supply run', 'Equipment pickup', 'Equipment return', 'Other'] },
      { name: 'billable', label: 'Billable to this job', type: 'checkbox', full: true, value: true },
    ],
  });
  if (!values?.miles) return;
  await ctx.save((j) => {
    j.trips.push({
      id: uid('trip'), jobId: j.id, miles: num(values.miles),
      startedAt: new Date(values.date || dayKey()).toISOString(),
      endedAt: new Date(values.date || dayKey()).toISOString(),
      purpose: values.purpose, billable: values.billable, tracked: false,
    });
  });
  toast('Miles logged.', 'success');
  ctx.refresh();
}

/* ------------------------------- contacts ------------------------------- */

async function contactSheet(ctx, id) {
  const existing = (ctx.job.contacts || []).find((c) => c.id === id) || {};
  const values = await formSheet({
    title: id ? 'Edit contact' : 'Add contact',
    fields: [
      { name: 'name', label: 'Name', type: 'text', full: true, required: true, value: existing.name },
      { name: 'role', label: 'Role', type: 'select', full: true, value: existing.role || 'client', options: CONTACT_ROLES },
      { name: 'company', label: 'Company', type: 'text', full: true, value: existing.company },
      { name: 'phone', label: 'Phone', type: 'tel', value: existing.phone },
      { name: 'email', label: 'Email', type: 'email', value: existing.email },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, value: existing.notes },
    ],
    extraActions: id ? [{
      label: 'Delete',
      onClick: async ({ close }) => {
        await ctx.save((j) => { j.contacts = j.contacts.filter((c) => c.id !== id); });
        close(null);
        ctx.refresh();
        return false;
      },
    }] : [],
  });
  if (!values?.name) return;

  await ctx.save((j) => {
    if (id) Object.assign(j.contacts.find((c) => c.id === id), values);
    else j.contacts.push({ id: uid('c'), ...values });
  });
  ctx.refresh();
}

async function commSheet(ctx, contactId, channel) {
  const contacts = ctx.job.contacts || [];
  if (!contacts.length) return toast('Add a contact first.', 'warn');
  const values = await formSheet({
    title: 'Log communication',
    fields: [
      { name: 'contactId', label: 'Who', type: 'select', full: true, value: contactId || contacts[0].id,
        options: contacts.map((c) => ({ value: c.id, label: `${c.name} (${CONTACT_ROLES.find((r) => r.value === c.role)?.label || c.role})` })) },
      { name: 'channel', label: 'Channel', type: 'select', value: channel || 'call', options: CHANNELS },
      { name: 'direction', label: 'Direction', type: 'select', value: 'outbound',
        options: [{ value: 'outbound', label: 'I contacted them' }, { value: 'inbound', label: 'They contacted me' }] },
      { name: 'summary', label: 'What was discussed', type: 'textarea', full: true, rows: 3 },
    ],
  });
  if (!values) return;
  await ctx.save((j) => {
    j.comms.push({ id: uid('cm'), at: nowIso(), by: ctx.settings.techName || '', ...values });
  });
  toast('Logged.', 'success');
  ctx.refresh();
}

/** Tapping Call/Text/Email opens the dialer and offers to log it. */
function quickLogComm(ctx, contactId, channel) {
  setTimeout(() => commSheet(ctx, contactId, channel), 900);
}

/* -------------------------------- photos -------------------------------- */

async function addPhoto(ctx) {
  const file = await pickPhoto();
  if (!file) return;
  const values = await formSheet({
    title: 'Photo',
    fields: [
      { name: 'caption', label: 'Caption', type: 'text', full: true, placeholder: 'Source of loss — supply line under sink' },
      { name: 'roomId', label: 'Room', type: 'select', full: true, value: '',
        options: [{ value: '', label: 'Not room specific' }, ...(ctx.job.rooms || []).map((r) => ({ value: r.id, label: r.name }))] },
      { name: 'kind', label: 'Type', type: 'select', full: true, value: 'documentation',
        options: [
          { value: 'documentation', label: 'General documentation' }, { value: 'source', label: 'Source of loss' },
          { value: 'damage', label: 'Damage' }, { value: 'equipment', label: 'Equipment as set' },
          { value: 'moisture_meter', label: 'Meter reading' }, { value: 'receipt', label: 'Receipt' },
          { value: 'completion', label: 'Completion' },
        ] },
    ],
  });
  const blob = await store.compressImage(file);
  await store.savePhoto({
    jobId: ctx.job.id, blob,
    caption: values?.caption || '', roomId: values?.roomId || null, kind: values?.kind || 'documentation',
  });
  toast('Photo saved to this device.', 'success');
  ctx.refresh();
}

async function viewPhoto(ctx, id) {
  const photo = await store.getPhoto(id);
  if (!photo) return;
  const url = URL.createObjectURL(photo.blob);
  const result = await sheet({
    title: photo.caption || 'Photo',
    size: 'full',
    body: `<img src="${url}" alt="${esc(photo.caption || 'Job photo')}" style="width:100%;border-radius:12px">
      <p class="tiny muted mt">${esc(fmtDateTime(photo.at))} · ${esc(photo.kind || '')}</p>`,
    actions: [
      { label: 'Delete', onClick: async ({ close }) => { close('delete'); return false; } },
      { label: 'Close', variant: 'primary', value: 'close' },
    ],
  });
  URL.revokeObjectURL(url);
  if (result === 'delete' && await confirmDialog('Delete this photo from the device?', { confirmLabel: 'Delete', danger: true })) {
    await store.deletePhoto(id);
    ctx.refresh();
  }
}

/* -------------------------------- labour -------------------------------- */

async function laborSheet(ctx) {
  const values = await formSheet({
    title: 'Log hours',
    fields: [
      { name: 'role', label: 'Role', type: 'select', full: true, value: 'tech',
        options: Object.entries(LABOR_ROLES).map(([value, r]) => ({ value, label: r.label })) },
      { name: 'hours', label: 'Hours', type: 'number', required: true, step: '0.25' },
      { name: 'rate', label: 'Billing rate', type: 'number' },
      { name: 'date', label: 'Date', type: 'date', full: true, value: dayKey() },
      { name: 'note', label: 'Note', type: 'text', full: true },
    ],
  });
  if (!values?.hours) return;
  const rate = values.rate ?? ctx.settings.laborRates?.[values.role] ?? LABOR_ROLES[values.role]?.defaultRate ?? 0;
  await ctx.save((j) => {
    j.labor.push({ id: uid('lab'), role: values.role, hours: num(values.hours), rate: num(rate), date: values.date, note: values.note });
  });
  toast('Hours logged.', 'success');
  ctx.refresh();
}

/* -------------------------------- helpers ------------------------------- */

const toTime = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? '' : new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(11, 16);
};

const fromTime = (date, hhmm) => new Date(`${date}T${hhmm}`).toISOString();

export { CONTACT_ROLES, CHANNELS };
