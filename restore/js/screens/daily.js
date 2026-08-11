// Daily logs, photos and signatures — the record of what happened on site.

import { store } from '../store.js';
import { openForm, openSheet, card, cardHead, emptyState, pill, confirmDialog, actionSheet } from '../ui.js';
import { putPhoto, photoUrl, deletePhoto, compressImage } from '../idb.js';
import { esc, fmtDate, fmtTime, todayISO, uid, toast, nowISO, round } from '../util.js';

async function paintThumbs(root) {
  for (const el of root.querySelectorAll('[data-photo]')) {
    if (el.dataset.painted) continue;
    const url = await photoUrl(el.dataset.photo);
    if (url) {
      el.querySelector('img').src = url;
      el.dataset.painted = '1';
    }
  }
}

function signaturePad({ title, onSave }) {
  const sheet = openSheet({
    title,
    subtitle: 'Sign with a finger or stylus.',
    body: `
      <canvas id="sigPad" style="width:100%;height:220px;background:#0b1220;border:1px solid #24334d;border-radius:12px;touch-action:none"></canvas>
      <div class="form__actions">
        <button class="btn btn--ghost" data-clear>Clear</button>
        <button class="btn btn--primary" data-save>Save signature</button>
      </div>`,
  });
  const canvas = sheet.body.querySelector('#sigPad');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  requestAnimationFrame(() => {
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.strokeStyle = '#e6edf7';
    let drawing = false;
    const pt = (e) => {
      const b = canvas.getBoundingClientRect();
      return { x: e.clientX - b.left, y: e.clientY - b.top };
    };
    canvas.addEventListener('pointerdown', (e) => {
      drawing = true; canvas.setPointerCapture(e.pointerId);
      const p = pt(e); ctx.beginPath(); ctx.moveTo(p.x, p.y);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pt(e); ctx.lineTo(p.x, p.y); ctx.stroke();
    });
    canvas.addEventListener('pointerup', () => { drawing = false; });
  });
  sheet.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-clear]')) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    if (e.target.closest('[data-save]')) {
      onSave(canvas.toDataURL('image/png'));
      sheet.close();
    }
  });
}

export default {
  id: 'daily',
  title: 'Daily log',

  render(ctx) {
    const { job } = ctx;
    const dailies = [...(job.dailies || [])].sort((a, b) => String(b.dateISO).localeCompare(String(a.dateISO)));
    const photos = [...(job.photos || [])].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

    return `
      ${card(`${cardHead('Visits', `<button class="btn btn--sm btn--primary" data-new-daily>+ Log a visit</button>`)}
        ${dailies.length ? `<div class="timeline">${dailies.map((x) => `
          <div class="timeline__item" data-daily="${x.id}">
            <div class="timeline__dot"></div>
            <div class="timeline__body">
              <strong>${esc(fmtDate(x.dateISO))} · ${esc(x.techs || 1)} tech${Number(x.techs) === 1 ? '' : 's'} · ${esc(x.hours || 0)} hr</strong>
              <small>${x.arrive ? `${esc(x.arrive)}–${esc(x.depart || '')}` : ''}${x.clientPresent ? ' · client present' : ''}</small>
              <p class="muted" style="margin-top:4px">${esc(x.work || '')}</p>
              ${x.notes ? `<p class="tiny" style="margin-top:4px">${esc(x.notes)}</p>` : ''}
            </div>
          </div>`).join('')}</div>`
          : emptyState('📋', 'No visits logged', 'Log every trip: who was there, how long, what changed. This is what supports the labor and monitoring charges.')}
      `)}

      ${card(`${cardHead('Photos', `<button class="btn btn--sm" data-add-photo>+ Photo</button>`)}
        ${photos.length ? `<div class="thumbs">${photos.map((p) => `
          <button class="thumb" data-photo="${esc(p.blobId)}" data-photo-id="${esc(p.id)}">
            <img alt="${esc(p.caption || 'job photo')}">
            <span>${esc(p.caption || fmtDate(p.ts))}</span>
          </button>`).join('')}</div>`
          : '<p class="muted">No photos yet. Shoot the source, the affected materials, equipment placement and the meter readings.</p>'}
        <input type="file" accept="image/*" capture="environment" id="photoInput" hidden multiple>
      `)}

      ${card(`${cardHead('Signatures', `<button class="btn btn--sm" data-sign>+ Signature</button>`)}
        ${(job.signatures || []).length ? `<div class="list">${job.signatures.map((s) => `
          <div class="list-item">
            <div class="list-item__icon">✍️</div>
            <div class="list-item__main"><strong>${esc(s.label)}</strong><small>${esc(s.name || '')} · ${esc(fmtDate(s.ts, { withTime: true }))}</small></div>
            <img src="${esc(s.data)}" alt="signature" style="height:38px;background:#0b1220;border-radius:6px">
          </div>`).join('')}</div>`
          : '<p class="muted">Capture authorization to perform services when you arrive, and a completion signature when you pull equipment.</p>'}
      `)}
    `;
  },

  mount(root, ctx) {
    const { job } = ctx;
    paintThumbs(root);

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-new-daily]')) {
        const now = new Date();
        const res = await openForm({
          title: 'Log a visit',
          fields: [
            { k: 'dateISO', label: 'Date', type: 'date', value: todayISO(), half: true },
            { k: 'techs', label: 'Technicians on site', type: 'number', value: 1, half: true },
            { k: 'arrive', label: 'Arrived', type: 'time', half: true, value: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` },
            { k: 'depart', label: 'Departed', type: 'time', half: true },
            { k: 'hours', label: 'Billable hours (each tech)', type: 'number', half: true, value: 1 },
            { k: 'clientPresent', label: 'Client was present', type: 'checkbox', value: true },
            { k: 'work', label: 'Work performed', type: 'textarea', rows: 3, required: true, placeholder: 'Took readings on all points, repositioned two air movers in the hall, removed wet cushion in the family room…' },
            { k: 'notes', label: 'Conversations & decisions', type: 'textarea', rows: 2, placeholder: 'Told the adjuster the hardwood is holding at 16% and will need mat drying…' },
          ],
        });
        if (!res) return;
        store.updateJob(job.id, (j) => {
          j.dailies.push({ id: uid('day'), ts: nowISO(), ...res });
        });
        toast('Visit logged', 'good');
        ctx.refresh();
        return;
      }

      const dailyEl = e.target.closest('[data-daily]');
      if (dailyEl) {
        const entry = job.dailies.find((x) => x.id === dailyEl.dataset.daily);
        if (!entry) return;
        const res = await openForm({
          title: fmtDate(entry.dateISO),
          deleteLabel: 'Delete entry',
          fields: [
            { k: 'techs', label: 'Technicians', type: 'number', value: entry.techs, half: true },
            { k: 'hours', label: 'Hours each', type: 'number', value: entry.hours, half: true },
            { k: 'work', label: 'Work performed', type: 'textarea', rows: 3, value: entry.work },
            { k: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: entry.notes },
          ],
        });
        if (!res) return;
        store.updateJob(job.id, (j) => {
          if (res.__delete) { j.dailies = j.dailies.filter((x) => x.id !== entry.id); return; }
          Object.assign(j.dailies.find((x) => x.id === entry.id), res);
        });
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-add-photo]')) {
        root.querySelector('#photoInput').click();
        return;
      }

      const thumb = e.target.closest('[data-photo-id]');
      if (thumb) {
        const photo = job.photos.find((p) => p.id === thumb.dataset.photoId);
        if (!photo) return;
        const url = await photoUrl(photo.blobId);
        const choice = await actionSheet({
          title: photo.caption || 'Photo',
          actions: [
            { id: 'view', label: 'View full size', icon: '🔍' },
            { id: 'caption', label: 'Edit caption', icon: '✎' },
            { id: 'delete', label: 'Delete photo', icon: '🗑', danger: true },
          ],
        });
        if (choice === 'view' && url) {
          openSheet({ title: photo.caption || 'Photo', size: 'lg', body: `<img src="${url}" style="width:100%;border-radius:12px">` });
        } else if (choice === 'caption') {
          const res = await openForm({
            title: 'Caption', size: 'sm',
            fields: [
              { k: 'caption', label: 'Caption', type: 'text', value: photo.caption },
              { k: 'roomId', label: 'Room', type: 'select', value: photo.roomId || '', options: [{ value: '', label: 'Whole job' }, ...job.plan.rooms.map((r) => ({ value: r.id, label: r.name }))] },
            ],
          });
          if (res) {
            store.updateJob(job.id, (j) => Object.assign(j.photos.find((p) => p.id === photo.id), res));
            ctx.refresh();
          }
        } else if (choice === 'delete') {
          if (await confirmDialog({ title: 'Delete photo?', message: 'It is removed from this device.', confirmLabel: 'Delete', destructive: true })) {
            await deletePhoto(photo.blobId).catch(() => {});
            store.updateJob(job.id, (j) => { j.photos = j.photos.filter((p) => p.id !== photo.id); });
            ctx.refresh();
          }
        }
        return;
      }

      if (e.target.closest('[data-sign]')) {
        const meta = await openForm({
          title: 'Signature', size: 'sm',
          submitLabel: 'Sign',
          fields: [
            { k: 'label', label: 'What is being signed', type: 'select', value: 'Authorization to perform services', options: [
              { value: 'Authorization to perform services', label: 'Authorization to perform services' },
              { value: 'Certificate of satisfaction', label: 'Certificate of satisfaction' },
              { value: 'Equipment placement acknowledgement', label: 'Equipment placement acknowledgement' },
              { value: 'Refusal of recommended services', label: 'Refusal of recommended services' },
            ] },
            { k: 'name', label: 'Signed by', type: 'text', required: true },
          ],
        });
        if (!meta) return;
        signaturePad({
          title: meta.label,
          onSave: (data) => {
            store.updateJob(job.id, (j) => {
              j.signatures.push({ id: uid('sig'), label: meta.label, name: meta.name, ts: nowISO(), data });
            });
            toast('Signature saved', 'good');
            ctx.refresh();
          },
        });
      }
    });

    root.querySelector('#photoInput')?.addEventListener('change', async (e) => {
      const files = [...(e.target.files || [])];
      if (!files.length) return;
      for (const file of files) {
        try {
          const blob = await compressImage(file);
          const blobId = uid('img');
          await putPhoto(blobId, blob);
          store.updateJob(job.id, (j) => {
            j.photos.push({ id: uid('pho'), blobId, caption: '', roomId: null, ts: nowISO(), tag: '' });
          });
        } catch (err) {
          toast(`Could not save photo: ${err.message}`, 'bad');
        }
      }
      toast(`${files.length} photo${files.length === 1 ? '' : 's'} added`, 'good');
      ctx.refresh();
    });
  },
};
