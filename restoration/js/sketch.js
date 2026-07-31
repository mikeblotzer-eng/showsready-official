/**
 * Floor plan canvas.
 *
 * World units are feet. The view is a simple uniform transform
 * (screen = world * scale + translate), which keeps hit-testing, snapping and
 * dimension labels honest — a wall that reads 12'6" is 12.5 in the model.
 *
 * Interaction is built for a gloved hand on a tablet: large hit targets, pinch
 * to zoom, one-finger pan, tap to place. Every measurement can also be typed,
 * because a tape measure beats a fingertip and the estimate has to defend
 * itself later.
 */

import {
  polygonArea, polygonPerimeter, countInsideCorners, pointInPolygon,
  boundingBox, centroid, dist, pointToSegment, formatFeet, clamp, uid, round,
} from './util.js';
import { evaluateDryness } from './iicrc.js';

export const MODES = {
  SELECT: 'select',
  DRAW: 'draw',
  MOISTURE: 'moisture',
  EQUIPMENT: 'equipment',
  AIRFLOW: 'airflow',
  PIN: 'pin',
};

const COLORS = {
  grid: 'rgba(148,163,184,0.16)',
  gridMajor: 'rgba(148,163,184,0.3)',
  wall: '#1e293b',
  wallWet: '#0891b2',
  roomFill: 'rgba(148,163,184,0.10)',
  roomFillAffected: 'rgba(14,165,233,0.13)',
  roomFillSelected: 'rgba(56,189,248,0.22)',
  label: '#0f172a',
  dim: '#475569',
  dry: '#22c55e',
  near: '#f59e0b',
  wet: '#ef4444',
  unknown: '#94a3b8',
  equipment: '#7c3aed',
  airflow: '#0ea5e9',
  pin: '#f43f5e',
  draft: '#0ea5e9',
};

const DRY_COLOR = { dry: COLORS.dry, near: COLORS.near, wet: COLORS.wet, unknown: COLORS.unknown };

export const EQUIPMENT_GLYPH = {
  air_mover: { short: 'AM', label: 'Air mover', color: '#7c3aed' },
  dehumidifier: { short: 'DH', label: 'Dehumidifier', color: '#2563eb' },
  air_scrubber: { short: 'AS', label: 'Air scrubber', color: '#0d9488' },
  heater: { short: 'HT', label: 'Heater', color: '#ea580c' },
  floor_mat: { short: 'FM', label: 'Floor mat system', color: '#a16207' },
  wall_system: { short: 'WS', label: 'Wall cavity system', color: '#be123c' },
};

/* ------------------------------------------------------------------ */
/* Geometry helpers shared with the views                              */
/* ------------------------------------------------------------------ */

/** Axis-aligned rectangle in feet, centred on a world point. */
export function rectanglePoints(widthFt, lengthFt, origin = { x: 0, y: 0 }) {
  const w = Math.max(0.5, widthFt), h = Math.max(0.5, lengthFt);
  return [
    { x: origin.x, y: origin.y },
    { x: origin.x + w, y: origin.y },
    { x: origin.x + w, y: origin.y + h },
    { x: origin.x, y: origin.y + h },
  ];
}

/**
 * Retype one wall's length and let the rest of the outline follow.
 *
 * For the rectilinear outlines that make up almost every room, translating the
 * chain between the edited edge and the vertex before the edge's start keeps
 * every other wall's length and every corner square — the far wall absorbs the
 * change, which is what a tech expects when they correct a measurement.
 */
export function setEdgeLength(points, edgeIndex, newLengthFt) {
  const n = points.length;
  if (n < 3 || newLengthFt <= 0) return points;
  const a = points[edgeIndex % n];
  const b = points[(edgeIndex + 1) % n];
  const current = dist(a, b);
  if (current < 1e-9) return points;

  const ux = (b.x - a.x) / current, uy = (b.y - a.y) / current;
  const delta = { x: ux * (newLengthFt - current), y: uy * (newLengthFt - current) };

  const out = points.map((p) => ({ ...p }));
  // Move vertices edgeIndex+1 .. edgeIndex+n-2, leaving the edge's start and
  // the vertex that precedes it fixed.
  for (let k = 1; k <= n - 2; k++) {
    const idx = (edgeIndex + k) % n;
    out[idx] = { x: out[idx].x + delta.x, y: out[idx].y + delta.y };
  }
  return out;
}

/** Recompute the derived quantities the rest of the app sizes equipment from. */
export function recalcRoom(room) {
  const pts = room.points || [];
  const area = polygonArea(pts);
  room.floorAreaSqft = Math.round(area * 10) / 10;
  room.perimeterFt = Math.round(polygonPerimeter(pts) * 10) / 10;
  room.insideCorners = countInsideCorners(pts);
  if (room.affectedFloorSqft == null || room.affectedFloorSqft > room.floorAreaSqft) {
    room.affectedFloorSqft = room.floorAreaSqft;
  }
  if (room.affectedWallLf == null) room.affectedWallLf = room.perimeterFt;
  if (room.ceilingAffected && !room.affectedCeilingSqft) room.affectedCeilingSqft = room.floorAreaSqft;
  return room;
}

/* ------------------------------------------------------------------ */
/* The canvas                                                          */
/* ------------------------------------------------------------------ */

export class PlanCanvas {
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.handlers = handlers;

    this.view = { scale: 14, tx: 40, ty: 40 };
    this.mode = MODES.SELECT;
    this.layers = { dimensions: true, moisture: true, equipment: true, airflow: true, pins: true, grid: true };
    this.data = { rooms: [], monitoringPoints: [], readings: [], equipment: [], arrows: [], pins: [], levelId: null };
    this.selection = null;          // { type, id }
    this.draft = null;              // in-progress polygon
    this.snapFt = 0.5;
    this.orthoSnap = true;
    this.equipmentBrush = 'air_mover';
    this._heatCache = null;
    this._pointers = new Map();
    this._pinch = null;
    this._raf = null;

    this._bind();
    this.resize();
  }

  /* ------------------------------- setup ------------------------------- */

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', this._onDown = (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', this._onMove = (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', this._onUp = (e) => this.onPointerUp(e));
    c.addEventListener('pointercancel', this._onUp);
    c.addEventListener('wheel', this._onWheel = (e) => this.onWheel(e), { passive: false });
    this._onResize = () => { this.resize(); this.render(); };
    window.addEventListener('resize', this._onResize);
  }

  destroy() {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onDown);
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerup', this._onUp);
    c.removeEventListener('pointercancel', this._onUp);
    c.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('resize', this._onResize);
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setData(data) {
    this.data = { arrows: [], pins: [], ...this.data, ...data };
    this._heatCache = null;
    this.render();
  }

  setMode(mode) {
    if (this.mode === MODES.DRAW && mode !== MODES.DRAW) this.draft = null;
    this.mode = mode;
    this.render();
    this.handlers.onModeChange?.(mode);
  }

  setLayers(patch) {
    Object.assign(this.layers, patch);
    this.render();
  }

  invalidateHeat() { this._heatCache = null; this.render(); }

  /* ---------------------------- transforms ----------------------------- */

  toScreen(p) {
    return { x: p.x * this.view.scale + this.view.tx, y: p.y * this.view.scale + this.view.ty };
  }

  toWorld(p) {
    return { x: (p.x - this.view.tx) / this.view.scale, y: (p.y - this.view.ty) / this.view.scale };
  }

  eventPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  snap(world) {
    const s = this.snapFt;
    return s > 0 ? { x: Math.round(world.x / s) * s, y: Math.round(world.y / s) * s } : world;
  }

  /** Fit every room on the level, with a margin. */
  fit(padding = 40) {
    const pts = this.rooms().flatMap((r) => r.points || []);
    if (!pts.length) {
      this.view = { scale: 14, tx: this.width / 2 - 70, ty: this.height / 2 - 70 };
      this.render();
      return;
    }
    const bb = boundingBox(pts);
    const scale = Math.min(
      (this.width - padding * 2) / Math.max(bb.width, 1),
      (this.height - padding * 2) / Math.max(bb.height, 1),
    );
    this.view.scale = clamp(scale, 2, 80);
    this.view.tx = this.width / 2 - (bb.minX + bb.width / 2) * this.view.scale;
    this.view.ty = this.height / 2 - (bb.minY + bb.height / 2) * this.view.scale;
    this.render();
  }

  zoomBy(factor, center) {
    const c = center || { x: this.width / 2, y: this.height / 2 };
    const before = this.toWorld(c);
    this.view.scale = clamp(this.view.scale * factor, 2, 120);
    const after = this.toWorld(c);
    this.view.tx += (after.x - before.x) * this.view.scale;
    this.view.ty += (after.y - before.y) * this.view.scale;
    this.render();
  }

  rooms() {
    return (this.data.rooms || []).filter((r) => !this.data.levelId || r.levelId === this.data.levelId);
  }

  /* ---------------------------- interaction ---------------------------- */

  onPointerDown(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.eventPoint(e);
    this._pointers.set(e.pointerId, p);

    if (this._pointers.size === 2) {
      const [a, b] = [...this._pointers.values()];
      this._pinch = { startDist: dist(a, b), startScale: this.view.scale, mid: mid(a, b) };
      this._drag = null;
      this._longPress && clearTimeout(this._longPress);
      return;
    }

    this._down = { at: Date.now(), screen: p, world: this.toWorld(p), moved: false };
    this._drag = this._pickDraggable(p);

    this._longPress = setTimeout(() => {
      if (this._down && !this._down.moved) {
        const hit = this._hitTest(p);
        if (hit) {
          this._down.consumed = true;
          this.handlers.onLongPress?.(hit, this.toWorld(p));
        }
      }
    }, 550);
  }

  onPointerMove(e) {
    if (!this._pointers.has(e.pointerId)) return;
    const p = this.eventPoint(e);
    this._pointers.set(e.pointerId, p);

    if (this._pinch && this._pointers.size === 2) {
      const [a, b] = [...this._pointers.values()];
      const d = dist(a, b);
      if (this._pinch.startDist > 0) {
        const m = mid(a, b);
        const before = this.toWorld(m);
        this.view.scale = clamp(this._pinch.startScale * (d / this._pinch.startDist), 2, 120);
        const after = this.toWorld(m);
        this.view.tx += (after.x - before.x) * this.view.scale;
        this.view.ty += (after.y - before.y) * this.view.scale;
        // Two-finger drag pans as well.
        this.view.tx += m.x - this._pinch.mid.x;
        this.view.ty += m.y - this._pinch.mid.y;
        this._pinch.mid = m;
      }
      this.render();
      return;
    }

    if (!this._down) return;
    const moved = dist(p, this._down.screen);
    if (moved > 8) {
      this._down.moved = true;
      clearTimeout(this._longPress);
    }
    if (!this._down.moved) return;

    if (this._drag) {
      const world = this.snap(this.toWorld(p));
      this._applyDrag(this._drag, world);
      this.render();
    } else if (this.mode === MODES.AIRFLOW) {
      this._down.airflowTo = this.toWorld(p);
      this.render();
    } else if (this.mode === MODES.DRAW && this.draft) {
      this.render(); // live rubber band follows the cursor
      this._hover = this.toWorld(p);
    } else {
      const prev = this._down.screen;
      this.view.tx += p.x - prev.x;
      this.view.ty += p.y - prev.y;
      this._down.screen = p;
      this.render();
    }
  }

  onPointerUp(e) {
    clearTimeout(this._longPress);
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._pinch = null;
    if (!this._down) return;

    const down = this._down;
    this._down = null;

    if (this._drag) {
      const drag = this._drag;
      this._drag = null;
      if (down.moved) { this.handlers.onEdit?.(drag.type, drag.id); return; }
    }
    if (down.consumed) return;

    if (this.mode === MODES.AIRFLOW && down.moved && down.airflowTo) {
      const from = this.snap(down.world), to = this.snap(down.airflowTo);
      if (dist(from, to) > 0.5) {
        this.data.arrows.push({ id: uid('arw'), from, to, levelId: this.data.levelId });
        this.handlers.onChange?.('arrows', this.data.arrows);
      }
      this.render();
      return;
    }

    if (down.moved) return; // it was a pan or a drag, not a tap
    this._handleTap(down.screen, this.toWorld(down.screen));
  }

  onWheel(e) {
    e.preventDefault();
    const p = this.eventPoint(e);
    this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, p);
  }

  _handleTap(screen, world) {
    const snapped = this.snap(world);

    switch (this.mode) {
      case MODES.DRAW:
        this._drawTap(snapped);
        return;

      case MODES.MOISTURE: {
        const room = this._roomAt(world);
        this.handlers.onPlaceMoisture?.({ ...snapped, roomId: room?.id || null });
        return;
      }

      case MODES.EQUIPMENT: {
        const room = this._roomAt(world);
        this.handlers.onPlaceEquipment?.({ ...snapped, roomId: room?.id || null, type: this.equipmentBrush });
        return;
      }

      case MODES.PIN: {
        const room = this._roomAt(world);
        this.handlers.onPlacePin?.({ ...snapped, roomId: room?.id || null });
        return;
      }

      default: {
        const hit = this._hitTest(screen);
        this.selection = hit ? { type: hit.type, id: hit.id } : null;
        this.render();
        this.handlers.onSelect?.(hit);
      }
    }
  }

  /* ------------------------------ drawing ------------------------------ */

  startDraw() {
    this.draft = { points: [] };
    this.setMode(MODES.DRAW);
  }

  cancelDraw() {
    this.draft = null;
    this.setMode(MODES.SELECT);
  }

  /** Undo the last placed corner. */
  undoDraftPoint() {
    if (this.draft?.points.length) {
      this.draft.points.pop();
      this.render();
    }
  }

  _drawTap(worldPoint) {
    if (!this.draft) this.draft = { points: [] };
    const pts = this.draft.points;

    // Tapping the first corner closes the outline.
    if (pts.length >= 3 && dist(worldPoint, pts[0]) * this.view.scale < 24) {
      this.finishDraw();
      return;
    }
    const p = pts.length && this.orthoSnap ? orthoSnap(pts[pts.length - 1], worldPoint) : worldPoint;
    pts.push(this.snap(p));
    this.render();
  }

  finishDraw() {
    const pts = this.draft?.points || [];
    if (pts.length < 3) return null;
    this.draft = null;
    this.setMode(MODES.SELECT);
    return this.handlers.onRoomDrawn?.(pts) ?? pts;
  }

  /* ---------------------------- hit testing ---------------------------- */

  _hitTest(screen) {
    const world = this.toWorld(screen);
    const tol = 22 / this.view.scale; // ~22px finger target, in feet

    if (this.layers.pins) {
      for (const pin of this.data.pins || []) {
        if (pin.levelId && pin.levelId !== this.data.levelId) continue;
        if (dist(world, pin) <= tol) return { type: 'pin', id: pin.id, item: pin };
      }
    }
    if (this.layers.equipment) {
      for (const eq of this.data.equipment || []) {
        if (eq.x == null || (eq.levelId && eq.levelId !== this.data.levelId)) continue;
        if (dist(world, eq) <= tol) return { type: 'equipment', id: eq.id, item: eq };
      }
    }
    if (this.layers.moisture) {
      for (const pt of this.data.monitoringPoints || []) {
        if (pt.x == null) continue;
        if (dist(world, pt) <= tol) return { type: 'moisture', id: pt.id, item: pt };
      }
    }
    for (const arrow of this.data.arrows || []) {
      if (arrow.levelId && arrow.levelId !== this.data.levelId) continue;
      if (pointToSegment(world, arrow.from, arrow.to).distance <= tol) return { type: 'arrow', id: arrow.id, item: arrow };
    }
    // Walls before rooms, so a tap on the outline edits the dimension.
    for (const room of this.rooms()) {
      const pts = room.points || [];
      for (let i = 0; i < pts.length; i++) {
        const seg = pointToSegment(world, pts[i], pts[(i + 1) % pts.length]);
        if (seg.distance <= tol * 0.7) return { type: 'wall', id: room.id, edgeIndex: i, item: room };
      }
    }
    for (const room of this.rooms()) {
      if ((room.points || []).length >= 3 && pointInPolygon(world, room.points)) {
        return { type: 'room', id: room.id, item: room };
      }
    }
    return null;
  }

  _roomAt(world) {
    return this.rooms().find((r) => (r.points || []).length >= 3 && pointInPolygon(world, r.points)) || null;
  }

  /** Vertices, moisture points, equipment and pins can be dragged directly. */
  _pickDraggable(screen) {
    if (this.mode !== MODES.SELECT) return null;
    const world = this.toWorld(screen);
    const tol = 20 / this.view.scale;

    if (this.selection?.type === 'room') {
      const room = this.rooms().find((r) => r.id === this.selection.id);
      if (room) {
        const idx = (room.points || []).findIndex((p) => dist(world, p) <= tol);
        if (idx >= 0) return { type: 'vertex', id: room.id, index: idx };
      }
    }
    for (const pt of this.data.monitoringPoints || []) {
      if (pt.x != null && dist(world, pt) <= tol) return { type: 'moisture', id: pt.id, item: pt };
    }
    for (const eq of this.data.equipment || []) {
      if (eq.x != null && dist(world, eq) <= tol) return { type: 'equipment', id: eq.id, item: eq };
    }
    for (const pin of this.data.pins || []) {
      if (dist(world, pin) <= tol) return { type: 'pin', id: pin.id, item: pin };
    }
    return null;
  }

  _applyDrag(drag, world) {
    if (drag.type === 'vertex') {
      const room = this.rooms().find((r) => r.id === drag.id);
      if (!room) return;
      room.points[drag.index] = { x: world.x, y: world.y };
      recalcRoom(room);
      this._heatCache = null;
    } else if (drag.item) {
      drag.item.x = world.x;
      drag.item.y = world.y;
      if (drag.type === 'moisture') this._heatCache = null;
    }
  }

  /* ------------------------------ rendering ---------------------------- */

  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._paint(); });
  }

  _paint() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.save();

    if (this.layers.grid) this._paintGrid(ctx);

    const rooms = this.rooms();
    for (const room of rooms) this._paintRoomFill(ctx, room);
    if (this.layers.moisture) this._paintHeatmap(ctx, rooms);
    for (const room of rooms) this._paintRoomOutline(ctx, room);
    if (this.layers.dimensions) for (const room of rooms) this._paintDimensions(ctx, room);
    for (const room of rooms) this._paintRoomLabel(ctx, room);

    if (this.layers.airflow) this._paintArrows(ctx);
    if (this.layers.moisture) this._paintMoisturePoints(ctx);
    if (this.layers.equipment) this._paintEquipment(ctx);
    if (this.layers.pins) this._paintPins(ctx);

    this._paintDraft(ctx);
    this._paintSelection(ctx);
    this._paintScaleBar(ctx);

    ctx.restore();
  }

  _paintGrid(ctx) {
    const step = gridStep(this.view.scale);
    const px = step * this.view.scale;
    if (px < 6) return;
    const startX = Math.floor(-this.view.tx / px) * px + this.view.tx;
    const startY = Math.floor(-this.view.ty / px) * px + this.view.ty;

    ctx.lineWidth = 1;
    for (let x = startX, i = 0; x < this.width; x += px, i++) {
      const worldX = Math.round((x - this.view.tx) / this.view.scale);
      ctx.strokeStyle = worldX % (step * 5) === 0 ? COLORS.gridMajor : COLORS.grid;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, this.height); ctx.stroke();
    }
    for (let y = startY; y < this.height; y += px) {
      const worldY = Math.round((y - this.view.ty) / this.view.scale);
      ctx.strokeStyle = worldY % (step * 5) === 0 ? COLORS.gridMajor : COLORS.grid;
      ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(this.width, Math.round(y) + 0.5); ctx.stroke();
    }
  }

  _pathRoom(ctx, room) {
    const pts = room.points || [];
    if (pts.length < 2) return false;
    ctx.beginPath();
    const first = this.toScreen(pts[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < pts.length; i++) {
      const s = this.toScreen(pts[i]);
      ctx.lineTo(s.x, s.y);
    }
    ctx.closePath();
    return true;
  }

  _paintRoomFill(ctx, room) {
    if (!this._pathRoom(ctx, room)) return;
    const selected = this.selection?.type === 'room' && this.selection.id === room.id;
    ctx.fillStyle = selected ? COLORS.roomFillSelected
      : room.affectedFloorSqft > 0 ? COLORS.roomFillAffected : COLORS.roomFill;
    ctx.fill();
  }

  _paintRoomOutline(ctx, room) {
    const pts = room.points || [];
    if (pts.length < 2) return;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = COLORS.wall;
    ctx.lineWidth = Math.max(2.5, Math.min(7, this.view.scale * 0.45));
    this._pathRoom(ctx, room);
    ctx.stroke();

    // Wet walls read as a cyan overlay on the affected run.
    if (room.affectedWallLf > 0 && room.perimeterFt > 0) {
      const fraction = clamp(room.affectedWallLf / room.perimeterFt, 0, 1);
      let remaining = room.perimeterFt * fraction;
      ctx.strokeStyle = COLORS.wallWet;
      ctx.lineWidth = Math.max(2, Math.min(5, this.view.scale * 0.3));
      for (let i = 0; i < pts.length && remaining > 0.01; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const len = dist(a, b);
        const use = Math.min(len, remaining);
        const t = len ? use / len : 0;
        const end = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const sa = this.toScreen(a), sb = this.toScreen(end);
        ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
        remaining -= use;
      }
    }
  }

  _paintDimensions(ctx, room) {
    const pts = room.points || [];
    if (pts.length < 2 || this.view.scale < 4) return;
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const len = dist(a, b);
      if (len * this.view.scale < 28) continue;
      const sa = this.toScreen(a), sb = this.toScreen(b);
      const mx = (sa.x + sb.x) / 2, my = (sa.y + sb.y) / 2;
      // Nudge the label outward from the room centre so it clears the wall.
      const c = this.toScreen(centroid(pts));
      const nx = mx - c.x, ny = my - c.y;
      const nl = Math.hypot(nx, ny) || 1;
      const lx = mx + (nx / nl) * 13, ly = my + (ny / nl) * 13;

      const text = formatFeet(len);
      const w = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(255,255,255,0.86)';
      ctx.fillRect(lx - w / 2 - 3, ly - 8, w + 6, 16);
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(text, lx, ly);
    }
  }

  /**
   * Room labels are drawn only where they actually fit inside the room's
   * footprint. A 4 ft hallway at low zoom cannot hold a name and an area, and
   * a label spilling across the neighbouring room is worse than no label.
   */
  _paintRoomLabel(ctx, room) {
    const pts = room.points || [];
    if (pts.length < 3 || this.view.scale < 5) return;

    const bb = boundingBox(pts);
    const screenW = bb.width * this.view.scale;
    const screenH = bb.height * this.view.scale;
    const c = this.toScreen(centroid(pts));

    const label = room.name || 'Room';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
    const labelW = ctx.measureText(label).width;
    if (labelW + 12 > screenW || screenH < 22) return;

    const detail = `${Math.round(room.floorAreaSqft)} ft² · ${room.ceilingHeightFt}' clg`;
    ctx.font = '500 11px ui-sans-serif, system-ui, sans-serif';
    const detailW = ctx.measureText(detail).width;
    const showDetail = this.view.scale >= 11 && detailW + 12 <= screenW && screenH >= 44;

    // Knock a light plate out behind the label so it stays legible over the
    // moisture surface.
    const plateW = Math.max(labelW, showDetail ? detailW : 0) + 10;
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.fillRect(c.x - plateW / 2, c.y - (showDetail ? 18 : 9), plateW, showDetail ? 34 : 18);

    ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = COLORS.label;
    ctx.fillText(label, c.x, c.y - (showDetail ? 8 : 0));
    if (showDetail) {
      ctx.font = '500 11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(detail, c.x, c.y + 8);
    }
  }

  /** Marker sizes track the zoom so a plan does not turn into a pile of badges. */
  _glyphScale() { return clamp(this.view.scale / 16, 0.62, 1.35); }

  /* --------------------------- moisture layer -------------------------- */

  /**
   * Inverse-distance-weighted moisture surface, rendered once into a world
   * space bitmap and cached. Recomputing on every pan would stutter on a
   * mid-range tablet, and the surface only changes when a reading does.
   */
  _buildHeatmap(rooms) {
    const points = (this.data.monitoringPoints || []).filter((p) => p.x != null);
    if (!points.length || !rooms.length) return null;

    const withStatus = points.map((p) => {
      const latest = latestReading(this.data.readings, p.id);
      const evaluated = evaluateDryness({ ...p, reading: latest?.reading });
      return { ...p, status: evaluated.status, ratio: wetnessRatio(latest?.reading, evaluated) };
    }).filter((p) => p.status !== 'unknown');
    if (!withStatus.length) return null;

    const allPts = rooms.flatMap((r) => r.points || []);
    const bb = boundingBox(allPts);
    const pad = 2;
    const cell = 0.5; // feet per pixel of the cached surface
    const w = Math.ceil((bb.width + pad * 2) / cell);
    const h = Math.ceil((bb.height + pad * 2) / cell);
    if (w <= 0 || h <= 0 || w * h > 1_500_000) return null;

    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d');
    const img = octx.createImageData(w, h);
    const originX = bb.minX - pad, originY = bb.minY - pad;

    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const wx = originX + px * cell, wy = originY + py * cell;
        const inside = rooms.some((r) => (r.points || []).length >= 3 && pointInPolygon({ x: wx, y: wy }, r.points));
        const idx = (py * w + px) * 4;
        if (!inside) { img.data[idx + 3] = 0; continue; }

        let num = 0, den = 0, nearest = Infinity;
        for (const p of withStatus) {
          const d2 = (p.x - wx) ** 2 + (p.y - wy) ** 2;
          nearest = Math.min(nearest, d2);
          const wgt = 1 / (d2 + 0.35);
          num += p.ratio * wgt;
          den += wgt;
        }
        const value = den ? num / den : 0;
        // Fade out beyond ~10 ft from any reading — don't imply data we lack.
        const falloff = clamp(1 - (Math.sqrt(nearest) - 6) / 8, 0, 1);
        const [r, g, b] = heatColor(value);
        img.data[idx] = r; img.data[idx + 1] = g; img.data[idx + 2] = b;
        img.data[idx + 3] = Math.round(150 * clamp(value, 0.12, 1) * falloff);
      }
    }
    octx.putImageData(img, 0, 0);
    return { canvas: off, originX, originY, cell };
  }

  _paintHeatmap(ctx, rooms) {
    if (!this._heatCache) this._heatCache = this._buildHeatmap(rooms) || { empty: true };
    const cache = this._heatCache;
    if (cache.empty) return;
    const tl = this.toScreen({ x: cache.originX, y: cache.originY });
    const w = cache.canvas.width * cache.cell * this.view.scale;
    const h = cache.canvas.height * cache.cell * this.view.scale;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(cache.canvas, tl.x, tl.y, w, h);
    ctx.restore();
  }

  _paintMoisturePoints(ctx) {
    const pts = (this.data.monitoringPoints || []).filter((p) => p.x != null);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const k = this._glyphScale();
    for (const p of pts) {
      const s = this.toScreen(p);
      const latest = latestReading(this.data.readings, p.id);
      const status = evaluateDryness({ ...p, reading: latest?.reading }).status;
      const r = 11 * k;

      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = DRY_COLOR[status];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.font = `700 ${round(10 * k)}px ui-sans-serif, system-ui, sans-serif`;
      const text = latest?.reading != null ? String(Math.round(latest.reading)) : '—';
      ctx.fillText(text, s.x, s.y);

      if (p.label && this.view.scale > 12) {
        ctx.fillStyle = COLORS.label;
        ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(p.label, s.x, s.y + r + 9);
      }
    }
  }

  /* -------------------------- equipment layer -------------------------- */

  _paintEquipment(ctx) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const k = this._glyphScale();
    for (const eq of this.data.equipment || []) {
      if (eq.x == null) continue;
      if (eq.levelId && eq.levelId !== this.data.levelId) continue;
      const s = this.toScreen(eq);
      const glyph = EQUIPMENT_GLYPH[eq.type] || { short: '?', color: COLORS.equipment };
      const size = 15 * k;
      const stale = !!eq.removedAt;

      ctx.save();
      ctx.globalAlpha = stale ? 0.35 : 1;

      // Air movers show the direction they are throwing.
      if (eq.type === 'air_mover') {
        const angle = (eq.angle ?? 0) * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.arc(s.x, s.y, Math.max(size * 2.6, this.view.scale * 3), angle - 0.42, angle + 0.42);
        ctx.closePath();
        ctx.fillStyle = 'rgba(124,58,237,0.16)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.roundRect
        ? ctx.roundRect(s.x - size, s.y - size, size * 2, size * 2, 5)
        : ctx.rect(s.x - size, s.y - size, size * 2, size * 2);
      ctx.fillStyle = glyph.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();

      ctx.fillStyle = '#fff';
      const multi = (eq.count || 1) > 1;
      ctx.font = `700 ${round(12 * k)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(glyph.short, s.x, s.y - (multi ? 4 * k : 1));
      if (multi) {
        ctx.font = `700 ${round(9 * k)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillText(`×${eq.count}`, s.x, s.y + 7 * k);
      }
      ctx.restore();
    }
  }

  _paintArrows(ctx) {
    ctx.strokeStyle = COLORS.airflow;
    ctx.fillStyle = COLORS.airflow;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    const draw = (from, to, dashed = false) => {
      const a = this.toScreen(from), b = this.toScreen(to);
      ctx.save();
      if (dashed) ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const head = 11;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(angle - 0.4), b.y - head * Math.sin(angle - 0.4));
      ctx.lineTo(b.x - head * Math.cos(angle + 0.4), b.y - head * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    for (const arrow of this.data.arrows || []) {
      if (arrow.levelId && arrow.levelId !== this.data.levelId) continue;
      draw(arrow.from, arrow.to);
    }
    if (this._down?.airflowTo) draw(this._down.world, this._down.airflowTo, true);
  }

  _paintPins(ctx) {
    ctx.textAlign = 'center';
    for (const pin of this.data.pins || []) {
      if (pin.levelId && pin.levelId !== this.data.levelId) continue;
      const s = this.toScreen(pin);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - 8, s.y - 14);
      ctx.arc(s.x, s.y - 20, 9, Math.PI * 0.75, Math.PI * 0.25);
      ctx.closePath();
      ctx.fillStyle = pin.kind === 'photo' ? COLORS.pin : '#0f766e';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '700 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(pin.kind === 'photo' ? '📷' : 'N', s.x, s.y - 20);
    }
  }

  _paintDraft(ctx) {
    const pts = this.draft?.points || [];
    if (!pts.length) return;
    ctx.save();
    ctx.strokeStyle = COLORS.draft;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    const first = this.toScreen(pts[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < pts.length; i++) {
      const s = this.toScreen(pts[i]);
      ctx.lineTo(s.x, s.y);
    }
    if (this._hover && this.mode === MODES.DRAW) {
      const h = this.toScreen(this.orthoSnap ? orthoSnap(pts[pts.length - 1], this._hover) : this._hover);
      ctx.lineTo(h.x, h.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Live segment lengths while tracing.
    ctx.font = '700 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.draft;
    for (let i = 1; i < pts.length; i++) {
      const a = this.toScreen(pts[i - 1]), b = this.toScreen(pts[i]);
      ctx.fillText(formatFeet(dist(pts[i - 1], pts[i])), (a.x + b.x) / 2, (a.y + b.y) / 2 - 6);
    }
    for (const [i, p] of pts.entries()) {
      const s = this.toScreen(p);
      ctx.beginPath();
      ctx.arc(s.x, s.y, i === 0 ? 8 : 5, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? COLORS.draft : '#fff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.draft;
      ctx.stroke();
    }
    ctx.restore();
  }

  _paintSelection(ctx) {
    if (this.selection?.type !== 'room') return;
    const room = this.rooms().find((r) => r.id === this.selection.id);
    if (!room) return;
    for (const p of room.points || []) {
      const s = this.toScreen(p);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = COLORS.draft;
      ctx.stroke();
    }
  }

  _paintScaleBar(ctx) {
    const target = 90;
    const feet = niceLength(target / this.view.scale);
    const px = feet * this.view.scale;
    const x = 14, y = this.height - 18;
    ctx.save();
    ctx.strokeStyle = 'rgba(15,23,42,0.55)';
    ctx.fillStyle = 'rgba(15,23,42,0.72)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5);
    ctx.stroke();
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatFeet(feet), x + px + 6, y + 2);
    ctx.restore();
  }

  /* ------------------------------- export ------------------------------ */

  /** Flatten the current level to a PNG data URL for reports. */
  exportPng({ width = 1400, padding = 60, background = '#ffffff' } = {}) {
    const rooms = this.rooms();
    const pts = rooms.flatMap((r) => r.points || []);
    if (!pts.length) return null;
    const bb = boundingBox(pts);
    const scale = (width - padding * 2) / Math.max(bb.width, 1);
    const height = Math.round(bb.height * scale + padding * 2);

    const off = document.createElement('canvas');
    off.width = width; off.height = height;
    const octx = off.getContext('2d');
    octx.fillStyle = background;
    octx.fillRect(0, 0, width, height);

    // Temporarily retarget the renderer at the export canvas.
    const saved = { ctx: this.ctx, view: { ...this.view }, width: this.width, height: this.height, grid: this.layers.grid };
    this.ctx = octx;
    this.width = width; this.height = height;
    this.layers.grid = false;
    this.view = { scale, tx: padding - bb.minX * scale, ty: padding - bb.minY * scale };
    const selection = this.selection;
    this.selection = null;
    this._heatCache = null;
    try {
      this._paint();
    } finally {
      this.ctx = saved.ctx;
      this.view = saved.view;
      this.width = saved.width;
      this.height = saved.height;
      this.layers.grid = saved.grid;
      this.selection = selection;
      this._heatCache = null;
    }
    return off.toDataURL('image/png');
  }
}

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Snap a segment to the nearest axis when it is close to square. */
function orthoSnap(from, to, toleranceDeg = 12) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const nearest = Math.round(angle / 90) * 90;
  if (Math.abs(angle - nearest) > toleranceDeg) return to;
  const len = Math.hypot(dx, dy);
  const rad = nearest * Math.PI / 180;
  return { x: from.x + Math.cos(rad) * len, y: from.y + Math.sin(rad) * len };
}

function gridStep(scale) {
  if (scale > 40) return 0.5;
  if (scale > 18) return 1;
  if (scale > 8) return 2;
  if (scale > 4) return 5;
  return 10;
}

function niceLength(feet) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100];
  return steps.find((s) => s >= feet) || 100;
}

export function latestReading(readings, pointId) {
  let best = null;
  for (const r of readings || []) {
    if (r.pointId !== pointId) continue;
    if (!best || new Date(r.at) > new Date(best.at)) best = r;
  }
  return best;
}

/** 0 = at the dry standard, 1 = soaking. Used to colour the surface. */
function wetnessRatio(reading, evaluated) {
  if (reading == null || evaluated.standard == null) return 0;
  const over = reading - evaluated.standard;
  if (over <= 0) return 0;
  const span = Math.max(evaluated.goal - evaluated.standard, 1) * 6;
  return clamp(over / span, 0, 1);
}

/** Green -> amber -> red ramp. */
function heatColor(t) {
  const stops = [
    [0.0, [34, 197, 94]],
    [0.35, [250, 204, 21]],
    [0.65, [249, 115, 22]],
    [1.0, [239, 68, 68]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0 || 1);
      return c0.map((c, j) => Math.round(c + (c1[j] - c) * k));
    }
  }
  return stops[stops.length - 1][1];
}
