// Sheets, forms and small render helpers. Every data-entry screen in the app is
// built from openForm() so field input behaves the same everywhere.

import { $, $$, esc, parseFeet, formatFeet } from './util.js';

let sheetCount = 0;

/** Generic bottom sheet. Returns { el, body, close }. */
export function openSheet({ title = '', subtitle = '', body = '', size = 'md', onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `
    <div class="sheet sheet--${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="sheet__head">
        <div>
          <h2>${esc(title)}</h2>
          ${subtitle ? `<p class="sheet__sub">${esc(subtitle)}</p>` : ''}
        </div>
        <button class="icon-btn" data-close aria-label="Close">✕</button>
      </header>
      <div class="sheet__body"></div>
    </div>`;
  const bodyEl = $('.sheet__body', wrap);
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);

  document.body.appendChild(wrap);
  document.body.classList.add('is-locked');
  sheetCount++;
  requestAnimationFrame(() => wrap.classList.add('is-open'));

  const close = (result) => {
    if (!wrap.isConnected) return;
    wrap.classList.remove('is-open');
    sheetCount = Math.max(0, sheetCount - 1);
    if (!sheetCount) document.body.classList.remove('is-locked');
    setTimeout(() => wrap.remove(), 200);
    onClose?.(result);
  };

  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close(null);
  });
  const onKey = (e) => { if (e.key === 'Escape') { close(null); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  return { el: wrap, body: bodyEl, close };
}

function fieldHtml(f) {
  const id = `f_${f.k || Math.random().toString(36).slice(2)}`;
  const cls = `field${f.half ? ' field--half' : ''}${f.type === 'checkbox' ? ' field--check' : ''}`;
  const hint = f.hint ? `<p class="field__hint">${esc(f.hint)}</p>` : '';
  const req = f.required ? ' required' : '';

  switch (f.type) {
    case 'section':
      return `<div class="field-section">${esc(f.label)}${f.hint ? `<span>${esc(f.hint)}</span>` : ''}</div>`;
    case 'static':
      return `<div class="${cls}"><label>${esc(f.label)}</label><div class="field__static">${f.html || esc(f.value ?? '')}</div>${hint}</div>`;
    case 'checkbox':
      return `<div class="${cls}"><label class="check"><input type="checkbox" id="${id}" data-k="${esc(f.k)}" data-type="checkbox"${f.value ? ' checked' : ''}><span>${esc(f.label)}</span></label>${hint}</div>`;
    case 'select':
      return `<div class="${cls}"><label for="${id}">${esc(f.label)}</label>
        <select id="${id}" data-k="${esc(f.k)}" data-type="select"${req}>
          ${(f.options || []).map((o) => {
            const v = o.value ?? o.id ?? o;
            const l = o.label ?? o;
            return `<option value="${esc(v)}"${String(v) === String(f.value ?? '') ? ' selected' : ''}>${esc(l)}</option>`;
          }).join('')}
        </select>${hint}</div>`;
    case 'textarea':
      return `<div class="${cls}"><label for="${id}">${esc(f.label)}</label>
        <textarea id="${id}" data-k="${esc(f.k)}" data-type="text" rows="${f.rows || 3}" placeholder="${esc(f.placeholder || '')}"${req}>${esc(f.value ?? '')}</textarea>${hint}</div>`;
    case 'segmented':
      return `<div class="${cls}"><label>${esc(f.label)}</label>
        <div class="segmented" data-k="${esc(f.k)}" data-type="segmented" data-value="${esc(f.value ?? '')}">
          ${(f.options || []).map((o) => {
            const v = o.value ?? o;
            return `<button type="button" data-v="${esc(v)}" class="${String(v) === String(f.value ?? '') ? 'is-on' : ''}">${esc(o.label ?? o)}</button>`;
          }).join('')}
        </div>${hint}</div>`;
    case 'feet':
      return `<div class="${cls}"><label for="${id}">${esc(f.label)}</label>
        <input id="${id}" data-k="${esc(f.k)}" data-type="feet" inputmode="decimal" placeholder="${esc(f.placeholder || `e.g. 12'6"`)}" value="${f.value != null && f.value !== '' ? esc(formatFeet(Number(f.value))) : ''}"${req}>${hint}</div>`;
    default: {
      const inputmode = f.type === 'number' ? ' inputmode="decimal"'
        : f.type === 'tel' ? ' inputmode="tel"'
        : f.type === 'email' ? ' inputmode="email"' : '';
      const step = f.step ? ` step="${f.step}"` : (f.type === 'number' ? ' step="any"' : '');
      const minmax = `${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}`;
      return `<div class="${cls}"><label for="${id}">${esc(f.label)}</label>
        <input id="${id}" data-k="${esc(f.k)}" data-type="${f.type || 'text'}" type="${f.type || 'text'}"${inputmode}${step}${minmax} placeholder="${esc(f.placeholder || '')}" value="${esc(f.value ?? '')}"${req}>${hint}</div>`;
    }
  }
}

function readFields(root) {
  const out = {};
  for (const el of $$('[data-k]', root)) {
    const k = el.dataset.k;
    const type = el.dataset.type;
    if (type === 'checkbox') out[k] = el.checked;
    else if (type === 'segmented') out[k] = el.dataset.value;
    else if (type === 'feet') out[k] = parseFeet(el.value);
    else if (type === 'number') out[k] = el.value === '' ? null : Number(el.value);
    else out[k] = el.value;
  }
  return out;
}

/**
 * Build a form in a sheet. Resolves with the values object, or null if the
 * user backed out.
 */
export function openForm({ title, subtitle = '', fields = [], submitLabel = 'Save', deleteLabel = null, size = 'md', onChange = null }) {
  return new Promise((resolve) => {
    let settled = false;
    const html = `
      <form class="form" novalidate>
        <div class="form__grid">${fields.filter(Boolean).map(fieldHtml).join('')}</div>
        <div class="form__actions">
          ${deleteLabel ? `<button type="button" class="btn btn--danger-ghost" data-delete>${esc(deleteLabel)}</button>` : ''}
          <button type="button" class="btn btn--ghost" data-cancel>Cancel</button>
          <button type="submit" class="btn btn--primary">${esc(submitLabel)}</button>
        </div>
      </form>`;
    const sheet = openSheet({
      title, subtitle, body: html, size,
      onClose: () => { if (!settled) { settled = true; resolve(null); } },
    });

    const form = $('form', sheet.body);

    form.addEventListener('click', (e) => {
      const seg = e.target.closest('.segmented button');
      if (seg) {
        const host = seg.parentElement;
        host.dataset.value = seg.dataset.v;
        $$('button', host).forEach((b) => b.classList.toggle('is-on', b === seg));
        onChange?.(readFields(form), host.dataset.k, sheet);
        return;
      }
      if (e.target.closest('[data-cancel]')) { settled = true; resolve(null); sheet.close(); }
      if (e.target.closest('[data-delete]')) { settled = true; resolve({ __delete: true }); sheet.close(); }
    });

    if (onChange) {
      form.addEventListener('input', (e) => onChange(readFields(form), e.target.dataset?.k, sheet));
      form.addEventListener('change', (e) => onChange(readFields(form), e.target.dataset?.k, sheet));
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const missing = $$('[required]', form).filter((el) => !String(el.value || '').trim());
      if (missing.length) {
        missing[0].focus();
        missing[0].classList.add('is-invalid');
        setTimeout(() => missing[0].classList.remove('is-invalid'), 1200);
        return;
      }
      settled = true;
      resolve(readFields(form));
      sheet.close();
    });

    setTimeout(() => $('input, select, textarea', form)?.focus({ preventScroll: true }), 120);
  });
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', destructive = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const sheet = openSheet({
      title, size: 'sm',
      body: `<p class="confirm__msg">${esc(message)}</p>
        <div class="form__actions">
          <button class="btn btn--ghost" data-no>Cancel</button>
          <button class="btn ${destructive ? 'btn--danger' : 'btn--primary'}" data-yes>${esc(confirmLabel)}</button>
        </div>`,
      onClose: () => { if (!settled) { settled = true; resolve(false); } },
    });
    sheet.body.addEventListener('click', (e) => {
      if (e.target.closest('[data-yes]')) { settled = true; resolve(true); sheet.close(); }
      if (e.target.closest('[data-no]')) { settled = true; resolve(false); sheet.close(); }
    });
  });
}

export function actionSheet({ title = '', actions = [] }) {
  return new Promise((resolve) => {
    let settled = false;
    const sheet = openSheet({
      title, size: 'sm',
      body: `<div class="action-list">${actions.map((a) =>
        `<button class="action-list__item${a.danger ? ' is-danger' : ''}" data-id="${esc(a.id)}">
          <span class="action-list__icon">${a.icon || ''}</span>
          <span><strong>${esc(a.label)}</strong>${a.hint ? `<small>${esc(a.hint)}</small>` : ''}</span>
        </button>`).join('')}</div>`,
      onClose: () => { if (!settled) { settled = true; resolve(null); } },
    });
    sheet.body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-id]');
      if (btn) { settled = true; resolve(btn.dataset.id); sheet.close(); }
    });
  });
}

// ── small render helpers ────────────────────────────────────────────────────

export const card = (inner, cls = '') => `<section class="card ${cls}">${inner}</section>`;

export const cardHead = (title, right = '') =>
  `<header class="card__head"><h3>${esc(title)}</h3>${right}</header>`;

export const emptyState = (icon, title, msg, actionHtml = '') =>
  `<div class="empty"><div class="empty__icon">${icon}</div><h4>${esc(title)}</h4><p>${esc(msg)}</p>${actionHtml}</div>`;

export const pill = (text, tone = '') => `<span class="pill pill--${tone}">${esc(text)}</span>`;

export const stat = (label, value, sub = '') =>
  `<div class="stat"><span class="stat__label">${esc(label)}</span><strong class="stat__value">${value}</strong>${sub ? `<span class="stat__sub">${esc(sub)}</span>` : ''}</div>`;

export const row = (left, right) => `<div class="kv"><span>${esc(left)}</span><span>${right}</span></div>`;

/** Ask for a single value without building a whole form. */
export async function promptValue({ title, label, value = '', type = 'text', hint = '', submitLabel = 'Save', options }) {
  const res = await openForm({
    title, size: 'sm', submitLabel,
    fields: [{ k: 'v', label, type, value, hint, options, required: true }],
  });
  return res ? res.v : null;
}
