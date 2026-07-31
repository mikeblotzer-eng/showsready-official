/**
 * Small UI kit: sheets, dialogs, toasts, forms and a signature pad.
 *
 * Deliberately dependency-free and DOM-first. Views render HTML strings and
 * wire behaviour through delegated `data-act` attributes, which keeps each
 * screen readable and avoids shipping a framework to a device that may be on
 * a hotspot in a parking lot.
 */

import { esc } from './util.js';

export { esc };

/* ------------------------------- toasts -------------------------------- */

let toastHost;
export function toast(message, kind = 'info', ms = 2600) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

/* ------------------------------- sheets -------------------------------- */

/**
 * Bottom sheet. Resolves with whatever `close(value)` is called with, or null
 * if dismissed. Body may be an HTML string or a node.
 */
export function sheet({ title, body, actions = [], onMount, dismissible = true, size = 'auto' }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    backdrop.innerHTML = `
      <div class="sheet sheet-${size}" role="dialog" aria-modal="true" aria-label="${esc(title || 'Dialog')}">
        <div class="sheet-grip"></div>
        ${title ? `<h2 class="sheet-title">${esc(title)}</h2>` : ''}
        <div class="sheet-body"></div>
        <div class="sheet-actions"></div>
      </div>`;

    const bodyEl = backdrop.querySelector('.sheet-body');
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);

    const actionsEl = backdrop.querySelector('.sheet-actions');
    let settled = false;
    const close = (value = null) => {
      if (settled) return;
      settled = true;
      backdrop.classList.remove('in');
      setTimeout(() => backdrop.remove(), 200);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };

    for (const action of actions) {
      const btn = document.createElement('button');
      btn.className = `btn ${action.variant ? `btn-${action.variant}` : 'btn-ghost'}`;
      btn.textContent = action.label;
      btn.addEventListener('click', async () => {
        const value = action.onClick ? await action.onClick({ root: backdrop, close }) : action.value;
        if (value !== false) close(value ?? action.value ?? true);
      });
      actionsEl.appendChild(btn);
    }

    if (dismissible) {
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    }
    const onKey = (e) => { if (e.key === 'Escape' && dismissible) close(null); };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('in'));
    onMount?.({ root: backdrop, body: bodyEl, close });
    backdrop.querySelector('input,select,textarea')?.focus();
  });
}

export function confirmDialog(message, { title = 'Confirm', confirmLabel = 'Confirm', danger = false } = {}) {
  return sheet({
    title,
    body: `<p class="dialog-text">${esc(message)}</p>`,
    actions: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, value: true, variant: danger ? 'danger' : 'primary' },
    ],
  }).then((v) => v === true);
}

/* -------------------------------- forms -------------------------------- */

/**
 * Field spec:
 *   { name, label, type, value, options, placeholder, hint, required,
 *     inputmode, step, min, max, rows, full }
 * type: text | number | dimension | date | time | datetime | select | textarea
 *       | checkbox | tel | email | segmented | color
 */
export function fieldHtml(f) {
  const id = `f_${f.name}`;
  const common = `id="${id}" name="${esc(f.name)}" ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}`;
  let control;

  switch (f.type) {
    case 'select':
      control = `<select ${common}>${(f.options || []).map((o) => {
        const value = o.value ?? o;
        const label = o.label ?? o;
        return `<option value="${esc(value)}" ${String(value) === String(f.value ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
      }).join('')}</select>`;
      break;
    case 'textarea':
      control = `<textarea ${common} rows="${f.rows || 3}">${esc(f.value ?? '')}</textarea>`;
      break;
    case 'checkbox':
      return `<label class="field field-check ${f.full ? 'full' : ''}">
          <input type="checkbox" id="${id}" name="${esc(f.name)}" ${f.value ? 'checked' : ''}>
          <span>${esc(f.label)}</span>
        </label>`;
    case 'segmented':
      return `<div class="field ${f.full ? 'full' : ''}">
          <span class="field-label">${esc(f.label)}</span>
          <div class="segmented" data-seg="${esc(f.name)}">
            ${(f.options || []).map((o) => {
              const value = o.value ?? o;
              return `<button type="button" class="seg ${String(value) === String(f.value) ? 'on' : ''}" data-value="${esc(value)}">${esc(o.label ?? o)}</button>`;
            }).join('')}
          </div>
          <input type="hidden" name="${esc(f.name)}" value="${esc(f.value ?? '')}">
          ${f.hint ? `<span class="field-hint">${esc(f.hint)}</span>` : ''}
        </div>`;
    case 'number':
      control = `<input type="number" ${common} value="${esc(f.value ?? '')}" inputmode="${f.inputmode || 'decimal'}"
        ${f.step ? `step="${f.step}"` : 'step="any"'} ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''}>`;
      break;
    case 'dimension':
      control = `<input type="text" ${common} value="${esc(f.value ?? '')}" inputmode="text" autocapitalize="off" autocomplete="off">`;
      break;
    default:
      control = `<input type="${f.type || 'text'}" ${common} value="${esc(f.value ?? '')}"
        ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} autocomplete="${f.autocomplete || 'off'}">`;
  }

  return `<label class="field ${f.full ? 'full' : ''}" for="${id}">
      <span class="field-label">${esc(f.label)}</span>
      ${control}
      ${f.hint ? `<span class="field-hint">${esc(f.hint)}</span>` : ''}
    </label>`;
}

export function formHtml(fields, { className = '' } = {}) {
  return `<div class="form-grid ${className}">${fields.map(fieldHtml).join('')}</div>`;
}

/** Read a form's values back out, coercing by field type. */
export function readForm(root, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'segmented') {
      out[f.name] = root.querySelector(`input[name="${CSS.escape(f.name)}"]`)?.value ?? f.value;
      continue;
    }
    const el = root.querySelector(`[name="${CSS.escape(f.name)}"]`);
    if (!el) continue;
    if (f.type === 'checkbox') out[f.name] = el.checked;
    else if (f.type === 'number') out[f.name] = el.value === '' ? null : Number(el.value);
    else out[f.name] = el.value;
  }
  return out;
}

/** Wire segmented controls inside a container. */
export function bindSegmented(root) {
  root.querySelectorAll('[data-seg]').forEach((group) => {
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg');
      if (!btn) return;
      group.querySelectorAll('.seg').forEach((b) => b.classList.toggle('on', b === btn));
      const hidden = group.parentElement.querySelector(`input[name="${CSS.escape(group.dataset.seg)}"]`);
      if (hidden) {
        hidden.value = btn.dataset.value;
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });
}

/** A form in a sheet. Resolves with the values, or null on cancel. */
export async function formSheet({ title, fields, submitLabel = 'Save', intro = '', danger = false, extraActions = [] }) {
  let values = null;
  await sheet({
    title,
    body: `${intro ? `<p class="dialog-text">${intro}</p>` : ''}<form class="sheet-form" novalidate>${formHtml(fields)}</form>`,
    onMount: ({ root, close }) => {
      bindSegmented(root);
      root.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        values = readForm(root, fields);
        close(true);
      });
    },
    actions: [
      { label: 'Cancel', value: false },
      ...extraActions,
      {
        label: submitLabel,
        variant: danger ? 'danger' : 'primary',
        onClick: ({ root, close }) => { values = readForm(root, fields); close(true); return false; },
      },
    ],
  });
  return values;
}

/* --------------------------- signature capture -------------------------- */

/** Finger-friendly signature pad. Returns a controller with toPngDataUrl(). */
export function signaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#0f172a';
  canvas.style.touchAction = 'none';

  let drawing = false, empty = true, last = null;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drawing = true; empty = false; last = pos(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  return {
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); empty = true; },
    isEmpty: () => empty,
    toPngDataUrl: () => (empty ? null : canvas.toDataURL('image/png')),
  };
}

/* ------------------------------ fragments ------------------------------- */

export function statCard(label, value, sub = '', tone = '') {
  // Currency totals blow past the tile width at the base size, so step the
  // type down rather than clipping the number the user came here to read.
  const len = String(value).length;
  const size = len > 9 ? 'stat-xs' : len > 6 ? 'stat-sm' : '';
  return `<div class="stat ${tone ? `stat-${tone}` : ''}">
      <span class="stat-value ${size}">${esc(value)}</span>
      <span class="stat-label">${esc(label)}</span>
      ${sub ? `<span class="stat-sub">${esc(sub)}</span>` : ''}
    </div>`;
}

export function emptyState(title, body, action = '') {
  return `<div class="empty">
      <h3>${esc(title)}</h3>
      <p>${esc(body)}</p>
      ${action}
    </div>`;
}

export function flagList(flags) {
  if (!flags?.length) return '';
  return `<ul class="flags">${flags.map((f) => `
    <li class="flag flag-${f.level}"><span class="flag-dot"></span>${esc(f.text)}</li>`).join('')}</ul>`;
}

export function sectionHeader(title, actionHtml = '') {
  return `<div class="section-header"><h2>${esc(title)}</h2>${actionHtml}</div>`;
}

/** Delegated click handling: elements carry data-act="name". */
export function onAct(root, handlers) {
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const handler = handlers[el.dataset.act];
    if (!handler) return;
    e.preventDefault();
    handler(el, e);
  });
}

/** Trigger a client-side file download. */
export function download(filename, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Share if the device supports it, otherwise fall back to a download. */
export async function shareOrDownload({ filename, text, title, mime = 'text/plain' }) {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text: title });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  download(filename, text, mime);
  return 'downloaded';
}

/** Ask for a photo from the camera or library. */
export function pickPhoto({ capture = 'environment' } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (capture) input.capture = capture;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(input.files?.[0] || null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}
