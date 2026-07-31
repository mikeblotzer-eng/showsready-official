/** Shared helpers: ids, formatting, feet-inch parsing, geometry, geo distance. */

export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const nowIso = () => new Date().toISOString();

/* ------------------------------- numbers ------------------------------- */

export function num(v, fallback = 0) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : fallback;
}

export const money = (v) =>
  (num(v) < 0 ? '-' : '') + '$' + Math.abs(num(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const round = (v, places = 1) => {
  const f = Math.pow(10, places);
  return Math.round(num(v) * f) / f;
};

/**
 * Parse the ways a tech actually types a dimension:
 *   12'6"   12' 6   12.5   12-6   12'6 1/2"   150"   6"
 * Returns feet as a decimal, or null if it can't be read.
 */
export function parseFeet(input) {
  if (input == null) return null;
  if (typeof input === 'number') return isFinite(input) ? input : null;
  let s = String(input).trim().toLowerCase().replace(/[”″]/g, '"').replace(/[’′]/g, "'");
  if (!s) return null;

  // Inches only: 150" or 150in
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:"|in|inch(?:es)?)$/);
  if (m) return parseFloat(m[1]) / 12;

  // Feet and inches, with optional fraction: 12'6 1/2"
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|f)?\s*[-\s]?\s*(\d+(?:\.\d+)?)?\s*(?:(\d+)\/(\d+))?\s*(?:"|in|inches)?$/);
  if (m && (m[2] != null || m[3] != null)) {
    const feet = parseFloat(m[1]);
    let inches = m[2] ? parseFloat(m[2]) : 0;
    if (m[3] && m[4]) inches += parseFloat(m[3]) / parseFloat(m[4]);
    return feet + inches / 12;
  }

  // Plain feet: 12 or 12.5 or 12'
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)?$/);
  if (m) return parseFloat(m[1]);

  return null;
}

/** Format decimal feet the way a sketch label should read: 12' 6" */
export function formatFeet(feet, { precision = 1 } = {}) {
  if (!isFinite(feet)) return '—';
  const sign = feet < 0 ? '-' : '';
  const abs = Math.abs(feet);
  let ft = Math.floor(abs);
  let inches = (abs - ft) * 12;
  // Snap to the nearest inch (or half inch) so labels don't read 6.999".
  const step = precision === 0 ? 1 : 1 / 2;
  inches = Math.round(inches / step) * step;
  if (inches >= 12) { ft += 1; inches -= 12; }
  const inStr = inches === 0 ? '' : ` ${inches % 1 === 0 ? inches : inches.toFixed(1)}"`;
  return `${sign}${ft}'${inStr}`;
}

export const sqft = (v) => `${Math.round(num(v)).toLocaleString()} ft²`;
export const cuft = (v) => `${Math.round(num(v)).toLocaleString()} ft³`;

/* ------------------------------- dates --------------------------------- */

export function fmtDate(iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString(undefined, opts);
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function fmtDateTime(iso) {
  return iso ? `${fmtDate(iso)} ${fmtTime(iso)}` : '—';
}

export function dayKey(iso = nowIso()) {
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}

export function hoursBetween(a, b) {
  return Math.abs(new Date(b) - new Date(a)) / 3600000;
}

export function relativeDays(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/* ------------------------------ geometry ------------------------------- */

/** Shoelace area of a closed polygon of {x,y} points, in the points' units². */
export function polygonArea(points) {
  if (!points || points.length < 3) return 0;
  let a = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function polygonPerimeter(points, { closed = true } = {}) {
  if (!points || points.length < 2) return 0;
  let p = 0;
  const n = points.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    p += dist(points[i], points[(i + 1) % n]);
  }
  return p;
}

export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

export const centroid = (points) => {
  if (!points?.length) return { x: 0, y: 0 };
  const s = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: s.x / points.length, y: s.y / points.length };
};

/** Signed area — negative means clockwise in screen coordinates. */
export function signedArea(points) {
  let a = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Count inside corners of a room polygon — each one is an air-mover position
 * in the S500 sizing model, so it's worth computing rather than asking for.
 */
export function countInsideCorners(points) {
  if (!points || points.length < 4) return 0;
  const orientation = Math.sign(signedArea(points)) || 1;
  let count = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n], cur = points[i], next = points[(i + 1) % n];
    const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    if (Math.sign(cross) !== orientation && Math.abs(cross) > 1e-6) count++;
  }
  return count;
}

export function pointInPolygon(pt, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y, xj = points[j].x, yj = points[j].y;
    const intersect = (yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function boundingBox(points) {
  if (!points?.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Distance from point to segment, plus the closest point — used for snapping. */
export function pointToSegment(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = clamp(t, 0, 1);
  const closest = { x: a.x + t * vx, y: a.y + t * vy };
  return { distance: dist(p, closest), closest, t };
}

/* -------------------------------- geo ---------------------------------- */

/** Great-circle distance in miles. */
export function haversineMiles(a, b) {
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Total a GPS track, dropping jitter. A phone sitting on a dashboard drifts a
 * few metres a second; without a floor the odometer climbs while parked.
 */
export function trackDistanceMiles(points, { minSegmentMiles = 0.0062, maxAccuracyM = 50 } = {}) {
  let total = 0;
  let prev = null;
  for (const p of points) {
    if (p.accuracy != null && p.accuracy > maxAccuracyM) continue;
    if (prev) {
      const d = haversineMiles(prev, p);
      if (d >= minSegmentMiles) { total += d; prev = p; }
    } else {
      prev = p;
    }
  }
  return total;
}

/* ------------------------------- misc ---------------------------------- */

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

export const sum = (items, fn = (x) => x) => items.reduce((n, i) => n + num(fn(i)), 0);

/** Escape for interpolation into innerHTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
}
