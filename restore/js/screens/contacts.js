// Everyone on the job, and the paper trail of what was said to them.

import { store } from '../store.js';
import { openForm, card, cardHead, emptyState, pill, actionSheet, openSheet } from '../ui.js';
import { esc, fmtDate, uid, nowISO, toast, telHref, smsHref, mailHref, money, round, daysBetween } from '../util.js';

const ROLES = ['Client', 'Adjuster', 'Office / project manager', 'Lead technician', 'Technician', 'Agent', 'Plumber', 'Subcontractor', 'Property manager', 'Other'];

const ROLE_ICON = {
  Client: '🏠', Adjuster: '📄', 'Office / project manager': '🏢',
  'Lead technician': '🧰', Technician: '🧰', Agent: '📞',
  Plumber: '🔧', Subcontractor: '🚚', 'Property manager': '🔑', Other: '👤',
};

/** Job-aware message drafts, so an update is two taps instead of five minutes. */
function templates(job, d) {
  const day = d.hours != null ? Math.floor(d.hours / 24) : 0;
  const site = job.site.name || job.site.address || 'your property';
  const dry = d.drying.total ? `${d.drying.atGoal} of ${d.drying.total} monitoring points are at their drying goal` : 'monitoring points are being established';
  const eq = d.deployed.active;
  return [
    {
      id: 'client_update',
      label: 'Daily update — client',
      audience: 'Client',
      subject: `Drying update — ${site}`,
      body: `Hi,\n\nQuick update on the drying at ${site} (job ${job.jobNumber}).\n\nWe are on day ${day}. Today ${dry}. There ${eq === 1 ? 'is' : 'are'} ${eq} piece${eq === 1 ? '' : 's'} of drying equipment running.\n\nPlease leave the equipment running and keep interior doors positioned as we set them. We will be back tomorrow to take readings.\n\nCall or text me with any questions.\n\n${store.settings.techName || ''}\n${store.settings.company || ''}\n${store.settings.techPhone || ''}`,
    },
    {
      id: 'adjuster_status',
      label: 'Status — adjuster',
      audience: 'Adjuster',
      subject: `Claim ${job.carrier.claimNumber || job.jobNumber} — mitigation status`,
      body: `Good morning,\n\nStatus on claim ${job.carrier.claimNumber || '(pending)'} at ${site}.\n\nCategory ${d.category}, Class ${d.cls}. Affected area is ${d.totals.affectedFloor} sf across ${d.totals.rooms} room(s), ${round(d.rec.volume)} cf of drying volume.\n\nEquipment on site: ${d.rec.airMovers} air movers and ${d.rec.ppdRequired} AHAM pints per day of dehumidification, sized per the S500 method (volume ÷ ${d.rec.factor}).\n\nDay ${day} of drying. ${dry}.\n\nFull documentation with the floor plan, moisture map and psychrometric log is available on request.\n\n${store.settings.techName || ''}\n${store.settings.company || ''}`,
    },
    {
      id: 'office_equipment',
      label: 'Equipment request — office',
      audience: 'Office / project manager',
      subject: `${job.jobNumber} — equipment needed`,
      body: `Need on ${job.jobNumber} (${site}):\n\n${d.rec.airMovers} air movers\n${d.rec.dehus.map((x) => `${x.qty} × ${x.item.label}`).join('\n') || `${d.rec.ppdRequired} AHAM pints of dehumidification`}\n${d.rec.afdQty ? `${d.rec.afdQty} × air scrubber\n` : ''}\nCurrently on site: ${d.deployed.active} unit(s). Class ${d.cls}, Category ${d.category}.`,
    },
    {
      id: 'tech_handoff',
      label: 'Handoff — next technician',
      audience: 'Technician',
      subject: `${job.jobNumber} handoff`,
      body: `${site} — job ${job.jobNumber}, day ${day}.\n\nCat ${d.category} / Class ${d.cls}. ${d.deployed.active} units running.\n\n${dry}.\n${d.drying.stalled.length ? `Watch these points, they are not moving: ${d.drying.stalled.map((p) => p.pin.label).join(', ')}.\n` : ''}\nTake a full set of readings, check dehu inlet/outlet grain depression, and log the visit.`,
    },
  ];
}

export default {
  id: 'contacts',
  title: 'Contacts',

  render(ctx) {
    const { job, d } = ctx;
    const contacts = job.contacts || [];
    const messages = [...(job.messages || [])].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

    return `
      ${card(`${cardHead('People on this job', `<button class="btn btn--sm btn--primary" data-add>+ Add</button>`)}
        ${contacts.length ? `<div class="list">${contacts.map((c) => `
          <div class="list-item" data-contact="${c.id}">
            <div class="list-item__icon">${ROLE_ICON[c.role] || '👤'}</div>
            <div class="list-item__main">
              <strong>${esc(c.name || 'Unnamed')}</strong>
              <small>${esc(c.role)}${c.company ? ` · ${esc(c.company)}` : ''}${c.phone ? ` · ${esc(c.phone)}` : ''}</small>
            </div>
            <div class="row" style="gap:6px">
              ${c.phone ? `<a class="icon-btn" href="${telHref(c.phone)}" data-stop aria-label="Call">📞</a>` : ''}
              ${c.phone ? `<a class="icon-btn" href="${smsHref(c.phone)}" data-stop aria-label="Text">💬</a>` : ''}
              ${c.email ? `<a class="icon-btn" href="${mailHref(c.email)}" data-stop aria-label="Email">✉️</a>` : ''}
            </div>
          </div>`).join('')}</div>`
          : emptyState('👥', 'No contacts yet', 'Add the client, the adjuster and your office so everything is one tap away in the field.')}
        ${job.carrier.adjuster ? `<p class="tiny" style="margin-top:10px">Adjuster on the claim record: ${esc(job.carrier.adjuster)}${job.carrier.adjusterPhone ? ` · ${esc(job.carrier.adjusterPhone)}` : ''}</p>` : ''}
      `)}

      ${card(`${cardHead('Send an update')}
        <p class="muted">Drafts are filled in from this job — day count, classification, equipment and drying progress.</p>
        <div class="list" style="margin-top:10px">
          ${templates(job, d).map((t) => `
            <button class="list-item" data-template="${t.id}">
              <div class="list-item__icon">✉️</div>
              <div class="list-item__main"><strong>${esc(t.label)}</strong><small>${esc(t.subject)}</small></div>
              <div class="list-item__right">›</div>
            </button>`).join('')}
        </div>
      `)}

      ${card(`${cardHead('Communication log', `<button class="btn btn--sm" data-log>+ Log a call</button>`)}
        ${messages.length ? `<div class="timeline">${messages.map((m) => `
          <div class="timeline__item">
            <div class="timeline__dot"></div>
            <div class="timeline__body">
              <strong>${esc(m.channel)} · ${esc(m.to)}</strong>
              <small>${esc(fmtDate(m.ts, { withTime: true }))}</small>
              <p class="muted" style="margin-top:4px;white-space:pre-wrap">${esc(m.body)}</p>
            </div>
          </div>`).join('')}</div>`
          : '<p class="muted">Nothing logged yet. Every call and text that changes the scope belongs here — it is the first thing asked for when a claim is disputed.</p>'}
      `)}
    `;
  },

  mount(root, ctx) {
    const { job, d } = ctx;

    const logMessage = (channel, to, body) => {
      store.updateJob(job.id, (j) => {
        j.messages.push({ id: uid('msg'), ts: nowISO(), channel, to, body, direction: 'out' });
      });
    };

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-stop]')) return; // let tel:/sms:/mailto: through

      if (e.target.closest('[data-add]')) {
        const res = await openForm({
          title: 'Add contact',
          fields: [
            { k: 'name', label: 'Name', type: 'text', required: true, half: true },
            { k: 'role', label: 'Role', type: 'select', options: ROLES, value: 'Client', half: true },
            { k: 'company', label: 'Company', type: 'text', half: true },
            { k: 'phone', label: 'Phone', type: 'tel', half: true },
            { k: 'email', label: 'Email', type: 'email' },
            { k: 'notes', label: 'Notes', type: 'textarea', rows: 2 },
          ],
        });
        if (!res) return;
        store.updateJob(job.id, (j) => { j.contacts.push({ id: uid('c'), ...res }); });
        ctx.refresh();
        return;
      }

      const contactEl = e.target.closest('[data-contact]');
      if (contactEl) {
        const c = job.contacts.find((x) => x.id === contactEl.dataset.contact);
        if (!c) return;
        const res = await openForm({
          title: c.name || 'Contact',
          deleteLabel: 'Delete contact',
          fields: [
            { k: 'name', label: 'Name', type: 'text', value: c.name, half: true },
            { k: 'role', label: 'Role', type: 'select', options: ROLES, value: c.role, half: true },
            { k: 'company', label: 'Company', type: 'text', value: c.company, half: true },
            { k: 'phone', label: 'Phone', type: 'tel', value: c.phone, half: true },
            { k: 'email', label: 'Email', type: 'email', value: c.email },
            { k: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: c.notes },
          ],
        });
        if (!res) return;
        store.updateJob(job.id, (j) => {
          if (res.__delete) { j.contacts = j.contacts.filter((x) => x.id !== c.id); return; }
          Object.assign(j.contacts.find((x) => x.id === c.id), res);
        });
        ctx.refresh();
        return;
      }

      const tplBtn = e.target.closest('[data-template]');
      if (tplBtn) {
        const tpl = templates(job, d).find((t) => t.id === tplBtn.dataset.template);
        if (!tpl) return;
        const match = job.contacts.find((c) => c.role === tpl.audience) ||
          (tpl.audience === 'Adjuster' && job.carrier.adjusterEmail
            ? { name: job.carrier.adjuster, email: job.carrier.adjusterEmail, phone: job.carrier.adjusterPhone }
            : null);
        const res = await openForm({
          title: tpl.label,
          subtitle: match ? `To ${match.name || tpl.audience}` : `No ${tpl.audience} on file — add one to send directly.`,
          submitLabel: 'Continue',
          fields: [
            { k: 'subject', label: 'Subject', type: 'text', value: tpl.subject },
            { k: 'body', label: 'Message', type: 'textarea', rows: 12, value: tpl.body },
          ],
        });
        if (!res) return;
        const choice = await actionSheet({
          title: 'Send how?',
          actions: [
            ...(match?.email ? [{ id: 'email', label: `Email ${match.email}`, icon: '✉️' }] : []),
            ...(match?.phone ? [{ id: 'sms', label: `Text ${match.phone}`, icon: '💬' }] : []),
            { id: 'share', label: 'Share…', icon: '📤', hint: 'Send through any app on the device' },
            { id: 'copy', label: 'Copy to clipboard', icon: '⧉' },
            { id: 'log', label: 'Just log it', icon: '📝' },
          ],
        });
        if (!choice) return;
        const to = match?.name || tpl.audience;
        if (choice === 'email') { location.href = mailHref(match.email, res.subject, res.body); logMessage('Email', to, res.body); }
        else if (choice === 'sms') { location.href = smsHref(match.phone, res.body); logMessage('Text', to, res.body); }
        else if (choice === 'share') {
          if (navigator.share) {
            try { await navigator.share({ title: res.subject, text: res.body }); logMessage('Shared', to, res.body); }
            catch { return; }
          } else { toast('Sharing is not available on this device', 'bad'); return; }
        } else if (choice === 'copy') {
          try { await navigator.clipboard.writeText(`${res.subject}\n\n${res.body}`); toast('Copied', 'good'); logMessage('Copied', to, res.body); }
          catch { toast('Could not copy', 'bad'); return; }
        } else { logMessage('Note', to, res.body); }
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-log]')) {
        const res = await openForm({
          title: 'Log a communication',
          fields: [
            { k: 'channel', label: 'Channel', type: 'segmented', value: 'Call', options: [
              { value: 'Call', label: 'Call' }, { value: 'Text', label: 'Text' },
              { value: 'Email', label: 'Email' }, { value: 'In person', label: 'In person' }] },
            { k: 'to', label: 'Who', type: 'text', required: true, placeholder: 'Adjuster — R. Patel' },
            { k: 'body', label: 'What was said / decided', type: 'textarea', rows: 4, required: true },
          ],
        });
        if (!res) return;
        logMessage(res.channel, res.to, res.body);
        ctx.refresh();
      }
    });
  },
};
