/* DOM and formatting helpers. Kept deliberately small — no framework. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function uid(prefix = 'id') {
  const rand = globalThis.crypto?.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** Escape for interpolation into innerHTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function money(v) {
  return (num(v) < 0 ? '-$' : '$') + Math.abs(num(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ft(v, digits = 1) {
  return `${num(v).toFixed(digits).replace(/\.0$/, '')} ft`;
}

export function sqft(v) {
  return `${Math.round(num(v)).toLocaleString()} sq ft`;
}

export function round(v, digits = 1) {
  const f = 10 ** digits;
  return Math.round(num(v) * f) / f;
}

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function hoursBetween(a, b) {
  const t1 = new Date(a).getTime(), t2 = new Date(b).getTime();
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 0;
  return Math.abs(t2 - t1) / 36e5;
}

export function daysBetween(a, b) {
  return hoursBetween(a, b) / 24;
}

let toastTimer;
export function toast(message, kind = 'info') {
  let node = $('#toast');
  if (!node) {
    node = el('div', { id: 'toast', class: 'toast' });
    document.body.append(node);
  }
  node.textContent = message;
  node.className = `toast on ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = 'toast'; }, 3200);
}

/** Promise-based confirm so destructive taps get one deliberate stop. */
export function confirmDialog(message, { confirmText = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    const back = el('div', { class: 'modal-back on' });
    const close = (val) => { back.remove(); resolve(val); };
    back.append(el('div', { class: 'modal' },
      el('p', { class: 'modal-msg', text: message }),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn btn-ghost', onClick: () => close(false) }, 'Cancel'),
        el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onClick: () => close(true) }, confirmText),
      ),
    ));
    back.addEventListener('click', (e) => { if (e.target === back) close(false); });
    document.body.append(back);
  });
}

/** Generic sheet/modal for forms. Returns the body node to fill. */
export function sheet(title, { onClose } = {}) {
  const back = el('div', { class: 'modal-back on' });
  const body = el('div', { class: 'sheet-body' });
  const close = () => { back.remove(); onClose?.(); };
  back.append(el('div', { class: 'modal sheet' },
    el('div', { class: 'sheet-head' },
      el('h3', { text: title }),
      el('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: close }, '✕'),
    ),
    body,
  ));
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  return { body, close };
}

/** Build a labelled field. `type: 'select'` takes `options: [{value,label}]`. */
export function field(label, opts = {}) {
  const { type = 'text', value = '', options = [], hint, ...rest } = opts;
  let input;
  if (type === 'select') {
    input = el('select', rest);
    for (const o of options) {
      const option = el('option', { value: o.value }, o.label);
      if (String(o.value) === String(value)) option.selected = true;
      input.append(option);
    }
  } else if (type === 'textarea') {
    input = el('textarea', rest);
    input.value = value ?? '';
  } else {
    input = el('input', { type, ...rest });
    if (type === 'checkbox') input.checked = !!value;
    else input.value = value ?? '';
  }
  const wrap = el('label', { class: `fld${type === 'checkbox' ? ' fld-check' : ''}` },
    el('span', { class: 'fld-label', text: label }),
    input,
    hint ? el('span', { class: 'fld-hint', text: hint }) : null,
  );
  return { wrap, input };
}

export function download(filename, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV with the quoting rules estimating platforms actually expect. */
export function toCsv(rows) {
  return rows.map((row) => row.map((cell) => {
    const s = String(cell ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}

/**
 * Downscale a camera photo before it goes in the database. Phone cameras
 * produce 4–8 MB files; a documentation photo needs ~200 KB.
 */
export function compressImage(file, { maxDim = 1600, quality = 0.72 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = el('canvas', { width: w, height: h });
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Image compression failed.')), 'image/jpeg', quality);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** tel:/sms:/mailto: links that behave on both iOS and Android. */
export const telHref = (phone) => `tel:${String(phone || '').replace(/[^\d+]/g, '')}`;
export const smsHref = (phone, body = '') => {
  const n = String(phone || '').replace(/[^\d+]/g, '');
  const sep = /iPhone|iPad|Macintosh/.test(navigator.userAgent) ? '&' : '?';
  return body ? `sms:${n}${sep}body=${encodeURIComponent(body)}` : `sms:${n}`;
};
export const mailHref = (email, subject = '', body = '') =>
  `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

export function mapsHref(address) {
  const q = encodeURIComponent(address || '');
  return /iPhone|iPad/.test(navigator.userAgent)
    ? `maps://?daddr=${q}`
    : `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}
