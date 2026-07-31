/* Daily documentation: the daily log, photos, communication with everyone on
 * the job, and drive/mileage tracking. */

import {
  el, sheet, field, toast, confirmDialog, uid, num, round, todayISO, fmtDate, fmtTime,
  download, toCsv, compressImage, telHref, smsHref, mailHref, mapsHref, esc, hoursBetween,
} from '../util.js';
import * as store from '../store.js';
import * as db from '../db.js';
import { trackMiles, haversineMiles } from '../geom.js';
import { pointStatus, MATERIALS } from '../iicrc.js';
import { slug } from './jobs.js';
import { toLocalInput } from './plan.js';

let tab = 'log';

export default function renderDaily(view, { go }) {
  const job = store.state.job;
  if (!job) return go('jobs');
  const rerender = () => { view.innerHTML = ''; renderDaily(view, { go }); };

  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: 'Daily' }), el('p', { class: 'mute', text: 'Documentation, contacts and drive time' })),
  ));

  const tabs = el('div', { class: 'room-tabs', style: 'padding:0 0 12px' });
  for (const [id, label] of [['log', 'Daily log'], ['contacts', 'Contacts'], ['comms', 'Communication'], ['drive', 'Drive']]) {
    tabs.append(el('button', { class: `room-tab${tab === id ? ' on' : ''}`, onClick: () => { tab = id; rerender(); } }, label));
  }
  view.append(tabs);

  if (tab === 'log') renderLog(view, rerender, go);
  if (tab === 'contacts') renderContacts(view, rerender);
  if (tab === 'comms') renderComms(view, rerender);
  if (tab === 'drive') renderDrive(view, rerender);
}

/* ── Daily log ────────────────────────────────────────────────────────────── */

function renderLog(view, rerender, go) {
  const job = store.state.job;
  const dailies = [...(job.dailies || [])].sort((a, b) => b.date.localeCompare(a.date));

  view.append(el('button', { class: 'btn btn-primary btn-block', onClick: () => dailySheet(null, rerender) }, '+ New daily entry'), el('div', { class: 'spacer' }));

  if (!dailies.length) {
    view.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
      el('div', { class: 'empty-ico', text: '▤' }),
      el('h2', { text: 'No dailies yet' }),
      el('p', { text: 'A daily entry ties the day together: who was on site, what you did, the readings you took, and photos. It is what gets paid and what defends the file.' }),
    )));
    return;
  }

  for (const d of dailies) {
    const progress = progressOnDate(job, d.date);
    view.append(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {},
          el('h2', { text: fmtDate(d.date) }),
          el('p', { class: 'mute tiny', text: `${d.arrive ? fmtTime(d.arrive) : '—'} → ${d.depart ? fmtTime(d.depart) : '—'}${d.arrive && d.depart ? ` · ${round(hoursBetween(d.arrive, d.depart), 1)} hrs` : ''}` }),
        ),
        el('button', { class: 'btn btn-ghost btn-sm', onClick: () => dailySheet(d, rerender) }, 'Edit'),
      ),
      el('div', { class: 'card-body' },
        d.techs?.length ? el('div', { class: 'row wrap', style: 'gap:6px;margin-bottom:10px' }, ...d.techs.map((t) => el('span', { class: 'chip', text: t }))) : null,
        d.workPerformed ? el('p', { style: 'white-space:pre-wrap;margin-bottom:8px', text: d.workPerformed }) : null,
        d.notes ? el('p', { class: 'mute', style: 'white-space:pre-wrap', text: d.notes }) : null,
        progress.measured
          ? el('div', { class: 'note', style: 'margin-top:10px', html: `<strong>${progress.dry}/${progress.measured}</strong> points met their goal on this date.` })
          : null,
        d.photoIds?.length ? photoStrip(d.photoIds) : null,
        d.clientSignature ? el('div', { class: 'note note-good', style: 'margin-top:10px', html: `Signed by <strong>${esc(d.clientSignature)}</strong>${d.signedAt ? ` on ${fmtDate(d.signedAt)}` : ''}` }) : null,
      ),
    ), el('div', { class: 'spacer' }));
  }

  view.append(el('div', { class: 'btn-row' },
    el('button', { class: 'btn btn-ghost btn-sm', onClick: () => exportDailies(job) }, '⤓ Export dailies'),
    el('button', { class: 'btn btn-ghost btn-sm', onClick: () => window.print() }, '🖨 Print report'),
  ));
}

function progressOnDate(job, date) {
  const points = store.allPoints(job);
  let measured = 0, dry = 0;
  for (const p of points) {
    const upTo = (p.readings || []).filter((r) => r.date <= date);
    if (!upTo.length) continue;
    measured++;
    const s = pointStatus(p, upTo);
    if (s.state === 'dry') dry++;
  }
  return { measured, dry };
}

function photoStrip(ids) {
  const strip = el('div', { class: 'row wrap', style: 'gap:6px;margin-top:10px' });
  for (const id of ids) {
    const img = el('img', { style: 'width:76px;height:76px;object-fit:cover;border-radius:8px;border:1px solid var(--border)', alt: 'Job photo' });
    db.blobs.get(id).then((rec) => {
      if (rec?.blob) {
        const url = URL.createObjectURL(rec.blob);
        img.src = url;
        img.addEventListener('load', () => setTimeout(() => URL.revokeObjectURL(url), 5000), { once: true });
      }
    });
    strip.append(img);
  }
  return strip;
}

function dailySheet(existing, rerender) {
  const job = store.state.job;
  const { body, close } = sheet(existing ? `Daily — ${fmtDate(existing.date)}` : 'New daily entry');
  const now = new Date().toISOString();

  const dateF = field('Date', { type: 'date', value: existing?.date || todayISO() });
  const arriveF = field('Arrived', { type: 'datetime-local', value: toLocalInput(existing?.arrive || now) });
  const departF = field('Departed', { type: 'datetime-local', value: toLocalInput(existing?.depart) });
  const techsF = field('Technicians on site', { value: (existing?.techs || [store.state.settings.techName].filter(Boolean)).join(', '), hint: 'Comma separated' });
  const workF = field('Work performed', { type: 'textarea', value: existing?.workPerformed || '', placeholder: 'Monitored all points, repositioned two air movers in the hallway, verified dehu grain depression at 18 gr…' });
  const notesF = field('Notes / conditions', { type: 'textarea', value: existing?.notes || '', placeholder: 'Client concerns, access issues, anything the office needs to know.' });
  const sigF = field('Client signature (typed name)', { value: existing?.clientSignature || '', hint: 'Typed acknowledgement that the work described was performed.' });

  const photoIds = [...(existing?.photoIds || [])];
  const photoWrap = el('div', { class: 'row wrap', style: 'gap:6px;margin-bottom:12px' });
  const renderPhotos = () => {
    photoWrap.innerHTML = '';
    for (const id of photoIds) {
      const cell = el('div', { style: 'position:relative' });
      const img = el('img', { style: 'width:76px;height:76px;object-fit:cover;border-radius:8px;border:1px solid var(--border)', alt: 'Job photo' });
      db.blobs.get(id).then((rec) => { if (rec?.blob) img.src = URL.createObjectURL(rec.blob); });
      cell.append(img, el('button', {
        class: 'icon-btn',
        style: 'position:absolute;top:-6px;right:-6px;min-width:26px;height:26px;background:var(--red);color:#fff;border-radius:50%;font-size:13px',
        onClick: async () => {
          await db.blobs.remove(id);
          photoIds.splice(photoIds.indexOf(id), 1);
          renderPhotos();
        },
      }, '✕'));
      photoWrap.append(cell);
    }
  };
  renderPhotos();

  const fileInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, style: 'display:none' });
  fileInput.addEventListener('change', async () => {
    for (const file of fileInput.files || []) {
      try {
        const blob = await compressImage(file);
        const id = uid('photo');
        await db.blobs.put({ id, jobId: job.id, blob, at: new Date().toISOString() });
        photoIds.push(id);
      } catch (err) {
        toast(err.message || 'Could not add that photo.', 'error');
      }
    }
    fileInput.value = '';
    renderPhotos();
  });

  body.append(
    dateF.wrap,
    el('div', { class: 'grid-2' }, arriveF.wrap, departF.wrap),
    techsF.wrap, workF.wrap, notesF.wrap,
    el('p', { class: 'eyebrow', style: 'margin:14px 0 8px', text: 'Photos' }),
    photoWrap,
    el('button', { class: 'btn btn-block', style: 'margin-bottom:14px', onClick: () => fileInput.click() }, '📷 Add photos'),
    fileInput,
    sigF.wrap,
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: () => {
        const entry = {
          id: existing?.id || uid('daily'),
          date: dateF.input.value || todayISO(),
          arrive: arriveF.input.value ? new Date(arriveF.input.value).toISOString() : null,
          depart: departF.input.value ? new Date(departF.input.value).toISOString() : null,
          techs: techsF.input.value.split(',').map((s) => s.trim()).filter(Boolean),
          workPerformed: workF.input.value.trim(),
          notes: notesF.input.value.trim(),
          clientSignature: sigF.input.value.trim(),
          signedAt: sigF.input.value.trim() ? (existing?.signedAt || new Date().toISOString()) : null,
          photoIds,
        };
        store.update((j) => {
          j.dailies = j.dailies || [];
          const i = j.dailies.findIndex((d) => d.id === entry.id);
          if (i >= 0) j.dailies[i] = entry; else j.dailies.push(entry);
        });
        close();
        rerender();
      },
    }, 'Save daily'),
    existing ? el('div', { class: 'spacer' }) : null,
    existing ? el('button', {
      class: 'btn btn-ghost btn-block',
      onClick: async () => {
        if (await confirmDialog('Delete this daily entry?')) {
          store.update((j) => { j.dailies = j.dailies.filter((d) => d.id !== existing.id); });
          close();
          rerender();
        }
      },
    }, 'Delete entry') : null,
  );
}

/* ── Contacts ─────────────────────────────────────────────────────────────── */

function renderContacts(view, rerender) {
  const job = store.state.job;
  const contacts = job.contacts || [];

  view.append(el('button', { class: 'btn btn-primary btn-block', onClick: () => contactSheet(null, rerender) }, '+ Add contact'), el('div', { class: 'spacer' }));

  if (job.claim?.address) {
    view.append(el('div', { class: 'card' }, el('div', { class: 'card-body' },
      el('p', { class: 'eyebrow', style: 'margin-bottom:6px', text: 'Loss address' }),
      el('p', { style: 'margin-bottom:10px', text: [job.claim.address, job.claim.city, job.claim.state, job.claim.zip].filter(Boolean).join(', ') }),
      el('a', { class: 'btn btn-block', href: mapsHref([job.claim.address, job.claim.city, job.claim.state, job.claim.zip].filter(Boolean).join(', ')), target: '_blank', rel: 'noopener' }, '🧭 Navigate to jobsite'),
    )), el('div', { class: 'spacer' }));
  }

  if (!contacts.length) {
    view.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
      el('div', { class: 'empty-ico', text: '☏' }),
      el('p', { text: 'Add the client, the adjuster, your PM and the techs on this job. One tap to call, text or email any of them — with a job-specific message pre-filled.' }),
    )));
    return;
  }

  for (const role of store.CONTACT_ROLES) {
    const group = contacts.filter((c) => c.role === role.id);
    if (!group.length) continue;
    const list = el('div', { class: 'list' });
    for (const c of group) list.append(contactRow(c, rerender));
    view.append(el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { text: role.label })),
      list,
    ), el('div', { class: 'spacer' }));
  }
}

function contactRow(c, rerender) {
  const job = store.state.job;
  const msg = statusMessage(job);
  const subject = `${job.claim?.insured || 'Job'} — ${job.claim?.address || ''} (Claim ${job.claim?.claimNumber || 'n/a'})`;

  return el('div', { class: 'list-item', style: 'cursor:default;flex-wrap:wrap' },
    el('div', { class: 'li-main', onClick: () => contactSheet(c, rerender) },
      el('div', { class: 'li-title', text: c.name }),
      el('div', { class: 'li-sub', text: [c.company, c.phone, c.email].filter(Boolean).join(' · ') }),
    ),
    el('div', { class: 'row', style: 'gap:4px' },
      c.phone ? el('a', { class: 'btn btn-sm', href: telHref(c.phone), onClick: () => logComm(c, 'call') }, '☏') : null,
      c.phone ? el('a', { class: 'btn btn-sm', href: smsHref(c.phone, msg), onClick: () => logComm(c, 'text') }, '✉') : null,
      c.email ? el('a', { class: 'btn btn-sm', href: mailHref(c.email, subject, msg), onClick: () => logComm(c, 'email') }, '@') : null,
    ),
  );
}

/**
 * The message a tech would otherwise type twice a day. Pulled straight from
 * live job state so it is never stale.
 */
export function statusMessage(job) {
  const progress = store.dryingProgress(job);
  const placed = store.placedEquipment(job);
  const cls = store.classification(job);
  const lines = [
    `${job.claim?.insured || 'Job'} — ${job.claim?.address || ''}`,
    job.claim?.claimNumber ? `Claim ${job.claim.claimNumber}` : null,
    `Category ${cls.category}, Class ${cls.class}.`,
    placed.total ? `${placed.total} pieces of drying equipment on site.` : null,
    progress.measured
      ? `${progress.dry} of ${progress.measured} monitoring points have reached their drying goal (${Math.round(progress.pct)}%).`
      : 'Monitoring points not yet established.',
    progress.complete
      ? 'All points have met the drying goal — ready to pull equipment.'
      : progress.stalled.length
        ? `${progress.stalled.length} point(s) have stalled; adjusting the drying setup.`
        : 'Drying is progressing; continuing to monitor daily.',
  ];
  return lines.filter(Boolean).join('\n');
}

function logComm(contact, channel) {
  store.update((j) => {
    j.comms = j.comms || [];
    j.comms.push({
      id: uid('comm'), at: new Date().toISOString(), direction: 'out', channel,
      party: contact.name, role: contact.role, summary: `${channel} initiated from the app`,
    });
  });
}

function contactSheet(existing, rerender) {
  const { body, close } = sheet(existing ? existing.name : 'New contact');
  const nameF = field('Name', { value: existing?.name || '' });
  const roleF = field('Role', { type: 'select', value: existing?.role || 'client', options: store.CONTACT_ROLES.map((r) => ({ value: r.id, label: r.label })) });
  const companyF = field('Company', { value: existing?.company || '' });
  const phoneF = field('Phone', { type: 'tel', inputmode: 'tel', value: existing?.phone || '' });
  const emailF = field('Email', { type: 'email', inputmode: 'email', value: existing?.email || '' });
  const notesF = field('Notes', { type: 'textarea', value: existing?.notes || '' });

  body.append(nameF.wrap, roleF.wrap, companyF.wrap,
    el('div', { class: 'grid-2' }, phoneF.wrap, emailF.wrap),
    notesF.wrap,
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: () => {
        if (!nameF.input.value.trim()) { toast('Enter a name.', 'error'); return; }
        const c = {
          id: existing?.id || uid('c'),
          name: nameF.input.value.trim(),
          role: roleF.input.value,
          company: companyF.input.value.trim(),
          phone: phoneF.input.value.trim(),
          email: emailF.input.value.trim(),
          notes: notesF.input.value.trim(),
        };
        store.update((j) => {
          j.contacts = j.contacts || [];
          const i = j.contacts.findIndex((x) => x.id === c.id);
          if (i >= 0) j.contacts[i] = c; else j.contacts.push(c);
        });
        close();
        rerender();
      },
    }, 'Save contact'),
    existing ? el('div', { class: 'spacer' }) : null,
    existing ? el('button', {
      class: 'btn btn-ghost btn-block',
      onClick: async () => {
        if (await confirmDialog(`Remove ${existing.name} from this job?`)) {
          store.update((j) => { j.contacts = j.contacts.filter((x) => x.id !== existing.id); });
          close();
          rerender();
        }
      },
    }, 'Delete contact') : null,
  );
}

/* ── Communication log ────────────────────────────────────────────────────── */

function renderComms(view, rerender) {
  const job = store.state.job;
  const comms = [...(job.comms || [])].sort((a, b) => new Date(b.at) - new Date(a.at));

  view.append(el('div', { class: 'card' }, el('div', { class: 'card-body' },
    el('p', { class: 'eyebrow', style: 'margin-bottom:8px', text: 'Job status update' }),
    el('p', { class: 'mute tiny', style: 'white-space:pre-wrap;margin-bottom:12px', text: statusMessage(job) }),
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-sm',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(statusMessage(job));
            toast('Status copied.', 'success');
          } catch { toast('Could not copy — select the text above.', 'error'); }
        },
      }, 'Copy'),
      el('button', {
        class: 'btn btn-sm',
        onClick: async () => {
          const text = statusMessage(job);
          if (navigator.share) {
            try { await navigator.share({ title: 'Job status', text }); } catch { /* user cancelled */ }
          } else { toast('Sharing is not available on this device.'); }
        },
      }, 'Share'),
    ),
  )), el('div', { class: 'spacer' }));

  view.append(el('button', { class: 'btn btn-primary btn-block', onClick: () => commSheet(rerender) }, '+ Log a conversation'), el('div', { class: 'spacer' }));

  if (!comms.length) {
    view.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
      el('p', { text: 'Nothing logged yet. Every call with an adjuster that is not written down did not happen.' }),
    )));
    return;
  }

  const list = el('div', { class: 'list' });
  for (const c of comms) {
    list.append(el('div', { class: 'list-item', style: 'cursor:default' },
      el('div', { class: 'li-main' },
        el('div', { class: 'li-title', text: `${c.party || 'Unknown'} · ${c.channel}` }),
        el('div', { class: 'li-sub', style: 'white-space:normal', text: c.summary }),
      ),
      el('div', { style: 'text-align:right;flex:none' },
        el('div', { class: 'tiny mute', text: fmtDate(c.at) }),
        el('div', { class: 'tiny mute', text: fmtTime(c.at) }),
      ),
    ));
  }
  view.append(el('div', { class: 'card' }, list));
}

function commSheet(rerender) {
  const job = store.state.job;
  const { body, close } = sheet('Log a conversation');
  const partyF = field('Who', {
    type: 'select', value: '',
    options: [{ value: '', label: 'Select…' }, ...(job.contacts || []).map((c) => ({ value: c.name, label: `${c.name} (${store.CONTACT_ROLES.find((r) => r.id === c.role)?.label || c.role})` })), { value: '__other', label: 'Someone else' }],
  });
  const otherF = field('Name', { value: '' });
  otherF.wrap.style.display = 'none';
  partyF.input.addEventListener('change', () => { otherF.wrap.style.display = partyF.input.value === '__other' ? '' : 'none'; });

  const channelF = field('Channel', { type: 'select', value: 'call', options: ['call', 'text', 'email', 'in person', 'voicemail', 'portal'].map((v) => ({ value: v, label: v })) });
  const dirF = field('Direction', { type: 'select', value: 'out', options: [{ value: 'out', label: 'I contacted them' }, { value: 'in', label: 'They contacted me' }] });
  const summaryF = field('What was discussed', { type: 'textarea', value: '' });

  body.append(partyF.wrap, otherF.wrap, el('div', { class: 'grid-2' }, channelF.wrap, dirF.wrap), summaryF.wrap,
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: () => {
        const party = partyF.input.value === '__other' ? otherF.input.value.trim() : partyF.input.value;
        if (!party) { toast('Pick who you spoke with.', 'error'); return; }
        store.update((j) => {
          j.comms = j.comms || [];
          j.comms.push({
            id: uid('comm'), at: new Date().toISOString(), party,
            channel: channelF.input.value, direction: dirF.input.value,
            summary: summaryF.input.value.trim(),
          });
        });
        close();
        rerender();
      },
    }, 'Save log entry'),
  );
}

/* ── Drive tracking ───────────────────────────────────────────────────────── */

let liveTrip = null;
let watchId = null;

function renderDrive(view, rerender) {
  const job = store.state.job;
  const trips = [...(job.trips || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const fin = store.financials(job);

  view.append(el('div', { class: 'card' },
    el('div', { class: 'stats' },
      st(round(fin.mileage.miles, 1), 'Total miles'),
      st(round(fin.mileage.billableMiles, 1), 'Billable'),
      st(`$${fin.mileage.amount.toFixed(2)}`, 'Reimbursable', 'green'),
    ),
    el('div', { class: 'card-body tight' },
      el('p', { class: 'mute tiny', text: `At $${num(store.state.settings.mileageRate, 0.7).toFixed(3)}/mile. Change the rate in settings.` }),
    ),
  ), el('div', { class: 'spacer' }));

  /* Live GPS tracking */
  const liveCard = el('div', { class: 'card' });
  const renderLive = () => {
    liveCard.innerHTML = '';
    if (liveTrip) {
      liveCard.append(
        el('div', { class: 'card-head' },
          el('h2', { text: 'Tracking…' }),
          el('span', { class: 'chip chip-green', text: `${round(trackMiles(liveTrip.path), 2)} mi` }),
        ),
        el('div', { class: 'card-body' },
          el('p', { class: 'mute tiny', style: 'margin-bottom:12px', text: `${liveTrip.path.length} GPS points since ${fmtTime(liveTrip.startedAt)}. Keep this screen open — browsers stop GPS in the background.` }),
          el('button', { class: 'btn btn-danger btn-block', onClick: () => { stopTracking(rerender); } }, '■ Stop and save trip'),
        ),
      );
    } else {
      liveCard.append(el('div', { class: 'card-body' },
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn btn-primary', onClick: () => startTracking(renderLive) }, '▶ Track drive'),
          el('button', { class: 'btn', onClick: () => tripSheet(null, rerender) }, '+ Enter manually'),
        ),
      ));
    }
  };
  renderLive();
  view.append(liveCard, el('div', { class: 'spacer' }));

  if (!trips.length) {
    view.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
      el('div', { class: 'empty-ico', text: '🧭' }),
      el('p', { text: 'Track a drive with GPS, or enter odometer readings. Mileage flows straight into job costs as a billable line.' }),
    )));
    return;
  }

  const list = el('div', { class: 'list' });
  for (const t of trips) {
    const miles = store.tripMiles(t);
    list.append(el('button', { class: 'list-item', onClick: () => tripSheet(t, rerender) },
      el('div', { class: 'li-main' },
        el('div', { class: 'li-title', text: t.purpose || 'Drive' }),
        el('div', { class: 'li-sub', text: `${fmtDate(t.date)}${t.path?.length ? ' · GPS tracked' : ''}` }),
      ),
      el('div', { style: 'text-align:right;flex:none' },
        el('div', { class: 'mono', style: 'font-weight:700', text: `${round(miles, 1)} mi` }),
        el('div', { class: 'tiny mute', text: t.billable === false ? 'Not billable' : `$${(miles * num(store.state.settings.mileageRate, 0.7)).toFixed(2)}` }),
      ),
    ));
  }
  view.append(el('div', { class: 'card' }, list), el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn-ghost btn-block btn-sm', onClick: () => exportTrips(job) }, '⤓ Export mileage log'));
}

function st(value, label, tone) {
  return el('div', { class: 'stat' }, el('div', { class: `stat-val ${tone || ''}`, text: value }), el('div', { class: 'stat-lbl', text: label }));
}

function startTracking(rerender) {
  if (!navigator.geolocation) { toast('This device has no GPS available to the browser.', 'error'); return; }
  liveTrip = { path: [], startedAt: new Date().toISOString() };
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, at: Date.now(), acc: pos.coords.accuracy };
      // Drop low-accuracy fixes — they are what inflate GPS mileage.
      if (p.acc != null && p.acc > 60) return;
      const last = liveTrip.path[liveTrip.path.length - 1];
      if (!last || haversineMiles(last, p) >= 0.005) {
        liveTrip.path.push(p);
        rerender();
      }
    },
    (err) => {
      toast(err.code === 1 ? 'Location permission denied.' : 'Could not get a GPS fix.', 'error');
      stopTracking(rerender, { discard: true });
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
  toast('Tracking started. Keep this screen open.');
  rerender();
}

function stopTracking(rerender, { discard = false } = {}) {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  const trip = liveTrip;
  liveTrip = null;
  if (discard || !trip || trip.path.length < 2) {
    rerender();
    if (!discard) toast('Not enough GPS points to save a trip.');
    return;
  }
  store.update((j) => {
    j.trips = j.trips || [];
    j.trips.push({
      id: uid('trip'), date: todayISO(), purpose: 'Drive to jobsite',
      path: trip.path, miles: round(trackMiles(trip.path), 2), billable: true,
      startedAt: trip.startedAt, endedAt: new Date().toISOString(),
    });
  });
  rerender();
  toast('Trip saved.', 'success');
}

function tripSheet(existing, rerender) {
  const { body, close } = sheet(existing ? 'Edit trip' : 'Add trip');
  const dateF = field('Date', { type: 'date', value: existing?.date || todayISO() });
  const purposeF = field('Purpose', { value: existing?.purpose || 'Drive to jobsite', placeholder: 'Drive to jobsite, supply run, equipment pickup' });
  const startF = field('Start odometer', { type: 'number', inputmode: 'decimal', value: existing?.startOdo ?? '' });
  const endF = field('End odometer', { type: 'number', inputmode: 'decimal', value: existing?.endOdo ?? '' });
  const milesF = field('Miles', { type: 'number', inputmode: 'decimal', value: existing?.miles ?? '', hint: 'Leave blank to compute from the odometer readings.' });
  const billableF = field('Billable to this job', { type: 'checkbox', value: existing ? existing.billable !== false : true });

  const recalc = () => {
    const s = num(startF.input.value, NaN), e = num(endF.input.value, NaN);
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) milesF.input.value = round(e - s, 1);
  };
  startF.input.addEventListener('change', recalc);
  endF.input.addEventListener('change', recalc);

  body.append(dateF.wrap, purposeF.wrap,
    el('div', { class: 'grid-2' }, startF.wrap, endF.wrap),
    milesF.wrap, billableF.wrap,
    existing?.path?.length ? el('div', { class: 'note', style: 'margin-bottom:12px', text: `${existing.path.length} GPS points recorded. Editing the miles here overrides the tracked distance.` }) : null,
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: () => {
        const trip = {
          id: existing?.id || uid('trip'),
          date: dateF.input.value || todayISO(),
          purpose: purposeF.input.value.trim(),
          startOdo: startF.input.value === '' ? null : num(startF.input.value),
          endOdo: endF.input.value === '' ? null : num(endF.input.value),
          miles: milesF.input.value === '' ? null : num(milesF.input.value),
          billable: billableF.input.checked,
          path: existing?.path || null,
        };
        store.update((j) => {
          j.trips = j.trips || [];
          const i = j.trips.findIndex((t) => t.id === trip.id);
          if (i >= 0) j.trips[i] = trip; else j.trips.push(trip);
        });
        close();
        rerender();
      },
    }, 'Save trip'),
    existing ? el('div', { class: 'spacer' }) : null,
    existing ? el('button', {
      class: 'btn btn-ghost btn-block',
      onClick: async () => {
        if (await confirmDialog('Delete this trip?')) {
          store.update((j) => { j.trips = j.trips.filter((t) => t.id !== existing.id); });
          close();
          rerender();
        }
      },
    }, 'Delete trip') : null,
  );
}

/* ── Exports ──────────────────────────────────────────────────────────────── */

function exportDailies(job) {
  const rows = [
    [`Daily log — ${job.claim?.insured || ''}`, `Claim ${job.claim?.claimNumber || ''}`],
    [],
    ['Date', 'Arrived', 'Departed', 'Hours', 'Technicians', 'Work performed', 'Notes', 'Signed by'],
  ];
  for (const d of [...(job.dailies || [])].sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([
      d.date, d.arrive ? fmtTime(d.arrive) : '', d.depart ? fmtTime(d.depart) : '',
      d.arrive && d.depart ? round(hoursBetween(d.arrive, d.depart), 2) : '',
      (d.techs || []).join('; '), d.workPerformed, d.notes, d.clientSignature || '',
    ]);
  }
  download(`${slug(job)}-dailies.csv`, toCsv(rows), 'text/csv');
  toast('Dailies exported.', 'success');
}

function exportTrips(job) {
  const rate = num(store.state.settings.mileageRate, 0.7);
  const rows = [['Date', 'Purpose', 'Start odo', 'End odo', 'Miles', 'Billable', 'Amount']];
  for (const t of [...(job.trips || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    const miles = store.tripMiles(t);
    rows.push([t.date, t.purpose, t.startOdo ?? '', t.endOdo ?? '', round(miles, 2), t.billable === false ? 'No' : 'Yes', t.billable === false ? '' : (miles * rate).toFixed(2)]);
  }
  download(`${slug(job)}-mileage.csv`, toCsv(rows), 'text/csv');
  toast('Mileage log exported.', 'success');
}
