/* Floor plan geometry. All world coordinates are in feet.
 *
 * Pure functions, no DOM. Also imported by restore/tests/*.test.mjs.
 */

/** Signed area via the shoelace formula; absolute value is the room's sq ft. */
export function polygonArea(pts) {
  if (!pts || pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

export function polygonPerimeter(pts) {
  if (!pts || pts.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    sum += dist(pts[i], pts[(i + 1) % pts.length]);
  }
  return sum;
}

export function polygonCentroid(pts) {
  if (!pts || !pts.length) return { x: 0, y: 0 };
  if (pts.length < 3) return { x: avg(pts, 'x'), y: avg(pts, 'y') };
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) return { x: avg(pts, 'x'), y: avg(pts, 'y') };
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function boundingBox(pts) {
  if (!pts || !pts.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function pointInPolygon(pt, poly) {
  if (!poly || poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const intersects = (yi > pt.y) !== (yj > pt.y) &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** Closest point on segment ab to p, plus the distance to it. */
export function closestPointOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return { point: { ...a }, t: 0, distance: dist(p, a) };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  return { point, t, distance: dist(p, point) };
}

/**
 * Snap a candidate point so walls come out square. Techs sketch fast and
 * crooked; almost every residential room is orthogonal, so pull to the axis
 * when we are close, then to 45°.
 */
export function snapToAngle(from, to, { thresholdDeg = 12, allow45 = true } = {}) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { ...to };
  let angle = Math.atan2(dy, dx);
  const step = allow45 ? Math.PI / 4 : Math.PI / 2;
  const snapped = Math.round(angle / step) * step;
  if (Math.abs(normalizeAngle(snapped - angle)) <= (thresholdDeg * Math.PI) / 180) {
    return { x: from.x + Math.cos(snapped) * len, y: from.y + Math.sin(snapped) * len };
  }
  return { ...to };
}

export function snapToGrid(pt, grid = 0.5) {
  if (!grid) return { ...pt };
  return { x: Math.round(pt.x / grid) * grid, y: Math.round(pt.y / grid) * grid };
}

/** Pull to an existing vertex when within tolerance, so rooms share corners. */
export function snapToVertices(pt, vertices, tolerance = 1) {
  let best = null, bestD = tolerance;
  for (const v of vertices) {
    const d = dist(pt, v);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best ? { x: best.x, y: best.y, snapped: true } : { ...pt, snapped: false };
}

/** Walls as segments, with length and inward normal — used for equipment layout. */
export function walls(poly) {
  const out = [];
  if (!poly || poly.length < 2) return out;
  const clockwise = signedArea(poly) < 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = dist(a, b);
    if (len < 1e-9) continue;
    const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
    // Rotate the direction 90° toward the interior. Which way that is depends
    // on the winding: for a positive signed area the interior is to the left
    // of the travel direction, for a negative one it is to the right.
    const normal = clockwise ? { x: dy, y: -dx } : { x: -dy, y: dx };
    out.push({ index: i, a, b, length: len, dir: { x: dx, y: dy }, normal, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
  }
  return out;
}

/** Interior angle at each vertex, to count the inside corners S500 charges for. */
export function insideCorners(poly) {
  if (!poly || poly.length < 3) return 0;
  const clockwise = signedArea(poly) < 0;
  let count = 0;
  for (let i = 0; i < poly.length; i++) {
    const prev = poly[(i - 1 + poly.length) % poly.length];
    const cur = poly[i];
    const next = poly[(i + 1) % poly.length];
    const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    const convex = clockwise ? cross < 0 : cross > 0;
    if (convex) count++;
  }
  return count;
}

export function signedArea(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * Space air movers around the perimeter, angled along the wall so they throw
 * air in one direction around the room — the vortex pattern taught in WRT.
 * Returns positions offset inward off the wall so icons don't sit on the line.
 */
export function layoutAirMovers(poly, count, { offset = 1.5 } = {}) {
  const segs = walls(poly);
  const total = segs.reduce((s, w) => s + w.length, 0);
  const placements = [];
  if (!segs.length || count < 1 || total <= 0) return placements;

  const spacing = total / count;
  // Start a quarter-step in so the first unit isn't sitting in a corner.
  let target = spacing * 0.25;
  let walked = 0, si = 0;

  for (let i = 0; i < count; i++) {
    while (si < segs.length - 1 && walked + segs[si].length < target) {
      walked += segs[si].length;
      si++;
    }
    const seg = segs[si];
    const along = Math.min(seg.length, Math.max(0, target - walked));
    const base = { x: seg.a.x + seg.dir.x * along, y: seg.a.y + seg.dir.y * along };
    placements.push({
      x: base.x + seg.normal.x * offset,
      y: base.y + seg.normal.y * offset,
      // Face down-wall so the throw wraps the perimeter.
      rot: (Math.atan2(seg.dir.y, seg.dir.x) * 180) / Math.PI,
      wallIndex: seg.index,
    });
    target += spacing;
  }
  return placements;
}

/** Wet wall linear feet at a given affected height — perimeter minus openings. */
export function wetWallLinearFeet(poly, { openingWidths = [], affectedPct = 100 } = {}) {
  const perim = polygonPerimeter(poly);
  const openings = openingWidths.reduce((s, w) => s + (Number(w) || 0), 0);
  return Math.max(0, (perim - openings) * (Math.min(100, Math.max(0, affectedPct)) / 100));
}

/**
 * Combined floor + wall + ceiling area for a room — the denominator S500 uses
 * to pick a class.
 */
export function roomSurfaceAreas(poly, ceilingHeight = 8) {
  const floor = polygonArea(poly);
  const perimeter = polygonPerimeter(poly);
  const wall = perimeter * ceilingHeight;
  return { floor, wall, ceiling: floor, perimeter, total: floor * 2 + wall, volume: floor * ceilingHeight };
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function avg(pts, k) {
  return pts.reduce((s, p) => s + p[k], 0) / pts.length;
}

/** Haversine distance in miles — drive tracking. */
export function haversineMiles(a, b) {
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total a GPS track, dropping jitter points that would inflate the mileage. */
export function trackMiles(points, { minSegmentMiles = 0.005 } = {}) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = haversineMiles(points[i - 1], points[i]);
    if (d >= minSegmentMiles) total += d;
  }
  return total;
}
