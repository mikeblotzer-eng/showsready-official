// Shared helpers: DOM, formatting, geometry, feet/inch parsing.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const round = (v, n = 2) => {
  const f = 10 ** n;
  return Math.round((Number(v) || 0) * f) / f;
};
export const num = (v, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Parse a field measurement into decimal feet. Accepts the shapes techs
 * actually type off a laser meter or tape:
 *   12  12.5  12'  12'6  12'6"  12-6  12 6  150"  6"
 */
export function parseFeet(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  let s = String(input).trim().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  if (!s) return null;

  // inches only: 150"
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:"|in|inch(?:es)?)$/i);
  if (m) return num(m[1]) / 12;

  // feet + inches: 12'6", 12' 6, 12-6, 12 6
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|f|-|\s)\s*(\d+(?:\.\d+)?)\s*(?:"|in|inch(?:es)?)?$/i);
  if (m) return num(m[1]) + num(m[2]) / 12;

  // feet only: 12, 12.5, 12'
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|f)?$/i);
  if (m) return num(m[1]);

  return null;
}

/** Decimal feet -> 12' 6" (rounded to the nearest inch). */
export function formatFeet(ft, { compact = false } = {}) {
  if (!Number.isFinite(ft)) return '—';
  const sign = ft < 0 ? '-' : '';
  let totalIn = Math.round(Math.abs(ft) * 12);
  const f = Math.floor(totalIn / 12);
  const i = totalIn % 12;
  if (compact) return `${sign}${f}'${i ? i + '"' : ''}`;
  return i ? `${sign}${f}' ${i}"` : `${sign}${f}'`;
}

export const money = (n, { cents = true } = {}) =>
  (Number(n) || 0).toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0,
  });

export const todayISO = () => new Date().toISOString().slice(0, 10);
export const nowISO = () => new Date().toISOString();

export function fmtDate(iso, { withTime = false } = {}) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return '—';
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (!withTime) return date;
  return `${date} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function hoursBetween(aISO, bISO) {
  const a = new Date(aISO).getTime();
  const b = new Date(bISO ?? Date.now()).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 36e5;
}

export function daysBetween(aISO, bISO) {
  const h = hoursBetween(aISO, bISO);
  return h === null ? null : h / 24;
}

export function relativeDay(iso) {
  const d = daysBetween(iso, null);
  if (d === null) return '';
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  return `${Math.floor(d)} days ago`;
}

// ── geometry (world units are decimal feet) ─────────────────────────────────

export function polygonArea(pts) {
  if (!pts || pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

export function polygonPerimeter(pts) {
  if (!pts || pts.length < 2) return 0;
  let p = 0;
  for (let i = 0; i < pts.length; i++) p += dist(pts[i], pts[(i + 1) % pts.length]);
  return p;
}

export function polygonCentroid(pts) {
  if (!pts || !pts.length) return { x: 0, y: 0 };
  if (pts.length < 3) return { ...pts[0] };
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross; cx += (p.x + q.x) * cross; cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-9) return { ...pts[0] };
  a *= 0.5;
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function pointInPolygon(pt, pts) {
  if (!pts || pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if ((yi > pt.y) !== (yj > pt.y) &&
        pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Shortest distance from p to segment ab, plus the closest point. */
export function pointToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const cp = { x: a.x + t * dx, y: a.y + t * dy };
  return { dist: dist(p, cp), point: cp, t };
}

export function bounds(pts) {
  if (!pts || !pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Great-circle distance in miles — used for GPS mileage logging. */
export function haversineMiles(a, b) {
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ── misc ────────────────────────────────────────────────────────────────────

export function download(filename, mime, content) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csv(rows) {
  return rows.map((r) => r.map((c) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function toast(msg, kind = 'info') {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = `toast toast--${kind}`;
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => { t.classList.add('is-out'); setTimeout(() => t.remove(), 300); }, 2600);
}

export const telHref = (v) => `tel:${String(v || '').replace(/[^\d+]/g, '')}`;
export const smsHref = (v, body) =>
  `sms:${String(v || '').replace(/[^\d+]/g, '')}${body ? `?&body=${encodeURIComponent(body)}` : ''}`;
export const mailHref = (v, subject, body) => {
  const q = [];
  if (subject) q.push(`subject=${encodeURIComponent(subject)}`);
  if (body) q.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${v || ''}${q.length ? `?${q.join('&')}` : ''}`;
};
