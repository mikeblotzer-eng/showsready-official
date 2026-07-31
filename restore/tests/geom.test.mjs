import test from 'node:test';
import assert from 'node:assert/strict';
import {
  polygonArea, polygonPerimeter, polygonCentroid, boundingBox, pointInPolygon,
  closestPointOnSegment, snapToAngle, snapToGrid, snapToVertices, walls,
  insideCorners, layoutAirMovers, wetWallLinearFeet, roomSurfaceAreas,
  haversineMiles, trackMiles, dist,
} from '../js/geom.js';
import { parseFeetInches, formatFeetInches } from '../js/sketch.js';

const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ±${tol}, got ${a}`);

test('area and perimeter of a rectangle', () => {
  assert.equal(polygonArea(rect(12, 10)), 120);
  assert.equal(polygonPerimeter(rect(12, 10)), 44);
});

test('area is orientation independent', () => {
  const cw = rect(10, 8);
  const ccw = [...cw].reverse();
  assert.equal(polygonArea(cw), polygonArea(ccw));
});

test('degenerate polygons have zero area', () => {
  assert.equal(polygonArea([]), 0);
  assert.equal(polygonArea([{ x: 0, y: 0 }, { x: 5, y: 5 }]), 0);
});

test('an L-shaped room measures correctly', () => {
  // 20x20 square with a 10x10 bite taken out of one corner = 300 sf.
  const l = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 },
    { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 },
  ];
  assert.equal(polygonArea(l), 300);
  assert.equal(polygonPerimeter(l), 80);
});

test('centroid of a rectangle is its middle', () => {
  const c = polygonCentroid(rect(10, 20));
  close(c.x, 5, 1e-9);
  close(c.y, 10, 1e-9);
});

test('bounding box covers the polygon', () => {
  const bb = boundingBox([{ x: -3, y: 2 }, { x: 7, y: -1 }, { x: 4, y: 9 }]);
  assert.deepEqual(
    { minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY, width: bb.width, height: bb.height },
    { minX: -3, minY: -1, maxX: 7, maxY: 9, width: 10, height: 10 },
  );
});

test('point in polygon', () => {
  const r = rect(10, 10);
  assert.equal(pointInPolygon({ x: 5, y: 5 }, r), true);
  assert.equal(pointInPolygon({ x: 15, y: 5 }, r), false);
  assert.equal(pointInPolygon({ x: -1, y: -1 }, r), false);
});

test('point in polygon handles a concave shape', () => {
  const l = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 },
    { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 },
  ];
  assert.equal(pointInPolygon({ x: 5, y: 15 }, l), true, 'inside the leg');
  assert.equal(pointInPolygon({ x: 15, y: 15 }, l), false, 'inside the notch is outside the room');
});

test('closest point on a segment clamps to the endpoints', () => {
  const a = { x: 0, y: 0 }, b = { x: 10, y: 0 };
  close(closestPointOnSegment({ x: 5, y: 3 }, a, b).distance, 3, 1e-9);
  const before = closestPointOnSegment({ x: -5, y: 0 }, a, b);
  assert.deepEqual(before.point, { x: 0, y: 0 });
  const after = closestPointOnSegment({ x: 50, y: 0 }, a, b);
  assert.deepEqual(after.point, { x: 10, y: 0 });
});

test('angle snapping squares up a nearly horizontal wall', () => {
  const from = { x: 0, y: 0 };
  const snapped = snapToAngle(from, { x: 10, y: 0.4 });
  close(snapped.y, 0, 1e-9, 'should pull flat');
  close(dist(from, snapped), dist(from, { x: 10, y: 0.4 }), 1e-9, 'length is preserved');
});

test('angle snapping leaves a deliberately angled wall alone', () => {
  const snapped = snapToAngle({ x: 0, y: 0 }, { x: 10, y: 4 });
  assert.ok(Math.abs(snapped.y - 4) < 1e-9, '21.8° is outside the snap threshold');
});

test('grid snapping rounds to the nearest half foot', () => {
  assert.deepEqual(snapToGrid({ x: 3.3, y: 7.9 }, 0.5), { x: 3.5, y: 8 });
  assert.deepEqual(snapToGrid({ x: 3.3, y: 7.9 }, 0), { x: 3.3, y: 7.9 });
});

test('vertex snapping joins shared corners', () => {
  const verts = [{ x: 10, y: 10 }, { x: 20, y: 0 }];
  const hit = snapToVertices({ x: 10.4, y: 9.8 }, verts, 1);
  assert.equal(hit.snapped, true);
  assert.equal(hit.x, 10);
  const miss = snapToVertices({ x: 14, y: 9.8 }, verts, 1);
  assert.equal(miss.snapped, false);
});

test('wall normals point into the room for both windings', () => {
  for (const poly of [rect(10, 10), [...rect(10, 10)].reverse()]) {
    for (const w of walls(poly)) {
      const probe = { x: w.mid.x + w.normal.x * 0.5, y: w.mid.y + w.normal.y * 0.5 };
      assert.ok(pointInPolygon(probe, poly), 'normal should point inward');
    }
  }
});

test('a rectangle has four inside corners', () => {
  assert.equal(insideCorners(rect(10, 10)), 4);
});

test('an L-shape has five inside corners and one reflex', () => {
  const l = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 },
    { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 },
  ];
  assert.equal(insideCorners(l), 5, 'six vertices, one of which is reflex');
});

test('air movers are laid out inside the room, spaced around the perimeter', () => {
  const poly = rect(20, 15);
  const spots = layoutAirMovers(poly, 6);
  assert.equal(spots.length, 6);
  for (const s of spots) {
    assert.ok(pointInPolygon(s, poly), 'placement should sit inside the room');
    assert.ok(Number.isFinite(s.rot));
  }
  // No two units stacked on top of each other.
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) {
      assert.ok(dist(spots[i], spots[j]) > 0.5, 'units should be spread out');
    }
  }
});

test('layout degrades gracefully on an undrawn room', () => {
  assert.deepEqual(layoutAirMovers([], 4), []);
  assert.deepEqual(layoutAirMovers(rect(10, 10), 0), []);
});

test('openings are subtracted from wet wall linear feet', () => {
  const poly = rect(12, 10);
  assert.equal(wetWallLinearFeet(poly), 44);
  assert.equal(wetWallLinearFeet(poly, { openingWidths: [3, 5] }), 36);
  assert.equal(wetWallLinearFeet(poly, { affectedPct: 50 }), 22);
  assert.equal(wetWallLinearFeet(poly, { openingWidths: [100] }), 0, 'never negative');
});

test('room surface areas add floor, ceiling and walls', () => {
  const a = roomSurfaceAreas(rect(12, 10), 8);
  assert.equal(a.floor, 120);
  assert.equal(a.ceiling, 120);
  assert.equal(a.wall, 44 * 8);
  assert.equal(a.total, 120 * 2 + 352);
  assert.equal(a.volume, 960);
});

test('haversine distance matches a known separation', () => {
  // One degree of latitude is about 69 miles.
  close(haversineMiles({ lat: 40, lng: -75 }, { lat: 41, lng: -75 }), 69.09, 0.3);
  assert.equal(haversineMiles({ lat: 40, lng: -75 }, { lat: 40, lng: -75 }), 0);
});

test('track mileage ignores GPS jitter', () => {
  const straight = [
    { lat: 40.000, lng: -75.0 },
    { lat: 40.010, lng: -75.0 },
    { lat: 40.020, lng: -75.0 },
  ];
  const withJitter = [
    { lat: 40.000, lng: -75.0 },
    { lat: 40.0000001, lng: -75.0 },
    { lat: 40.010, lng: -75.0 },
    { lat: 40.0100002, lng: -75.0 },
    { lat: 40.020, lng: -75.0 },
  ];
  close(trackMiles(withJitter), trackMiles(straight), 0.01);
});

/* ── Dimension parsing ────────────────────────────────────────────────────── */

test('feet and inches parse from the ways techs type them', () => {
  assert.equal(parseFeetInches('12'), 12);
  assert.equal(parseFeetInches('12.5'), 12.5);
  close(parseFeetInches(`12' 6"`), 12.5, 1e-9);
  close(parseFeetInches('12-6'), 12.5, 1e-9);
  close(parseFeetInches('12 6'), 12.5, 1e-9);
  close(parseFeetInches(`8'3"`), 8.25, 1e-9);
});

test('unparseable dimensions return null rather than NaN', () => {
  assert.equal(parseFeetInches(''), null);
  assert.equal(parseFeetInches('about twelve'), null);
  assert.equal(parseFeetInches(null), null);
});

test('lengths format the way they get called out', () => {
  assert.equal(formatFeetInches(12), `12'`);
  assert.equal(formatFeetInches(12.5), `12' 6"`);
  assert.equal(formatFeetInches(8.25), `8' 3"`);
});

test('formatting round-trips through parsing', () => {
  for (const v of [4, 7.25, 12.5, 20.75]) {
    close(parseFeetInches(formatFeetInches(v)), v, 1e-9, `${v} ft`);
  }
});
