// Floor-plan canvas engine. World units are decimal feet; the camera stores the
// world coordinate at the canvas top-left plus a pixels-per-foot scale.
//
// Designed for a gloved finger on a tablet: tap to drop corners, type exact
// tape/laser measurements, drag vertices with snapping, pinch to zoom.

import {
  dist, polygonArea, polygonCentroid, polygonPerimeter, pointInPolygon,
  pointToSegment, bounds, uid, formatFeet, round, clamp,
} from './util.js';
import { EQUIPMENT_TYPES, catalogById } from './equipment.js';
import { materialById } from './standards.js';

const GRID_MINOR = 1;      // ft
const GRID_MAJOR = 5;      // ft
const SNAP = 0.25;         // ft
const VERTEX_SNAP_FT = 1.0;
const ORTHO_DEG = 12;
const MIN_ICON_PX = 20;

export const TOOLS = {
  select: { label: 'Select', icon: '✥' },
  room: { label: 'Room', icon: '⬠' },
  rect: { label: 'Box room', icon: '▭' },
  door: { label: 'Opening', icon: '⌷' },
  pin: { label: 'Moisture', icon: '💧' },
  equip: { label: 'Equipment', icon: '➤' },
  arrow: { label: 'Airflow', icon: '↝' },
  containment: { label: 'Containment', icon: '▨' },
  erase: { label: 'Erase', icon: '⌫' },
};

// One palette per theme: the screen is dark, the printed plan is light. Both go
// through the same drawing code so the report always matches the tablet.
const PALETTES = {
  dark: {
    bg: '#0b1220',
    roomFill: 'rgba(148,163,184,0.10)',
    wetFill: 'rgba(56,189,248,0.20)',
    cat3Fill: 'rgba(248,113,113,0.18)',
    wall: '#94a3b8', wallWet: '#7dd3fc',
    text: '#e2e8f0', sub: '#94a3b8',
    dimText: '#cbd5e1', dimBg: 'rgba(2,6,23,0.78)',
    outline: 'rgba(2,6,23,0.85)', gap: '#0b1220',
    scale: '#94a3b8',
  },
  light: {
    bg: '#ffffff',
    roomFill: 'rgba(148,163,184,0.12)',
    wetFill: 'rgba(56,189,248,0.18)',
    cat3Fill: 'rgba(248,113,113,0.15)',
    wall: '#64748b', wallWet: '#0f172a',
    text: '#0f172a', sub: '#475569',
    dimText: '#334155', dimBg: 'rgba(255,255,255,0.9)',
    outline: '#0f172a', gap: '#ffffff',
    scale: '#475569',
  },
};

export class Sketch {
  #unbind = null;

  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.plan = opts.plan;
    this.job = opts.job;
    this.onChange = opts.onChange || (() => {});
    this.onSelect = opts.onSelect || (() => {});
    this.onDraft = opts.onDraft || (() => {});

    this.cam = { x: -5, y: -5, scale: 14 };
    this.theme = 'dark';
    this.tool = 'select';
    this.draft = null;            // { kind:'room'|'containment', pts:[] }
    this.selection = null;        // { kind, id, index? }
    this.pendingEquip = null;     // catalog id armed for placement
    this.layers = { grid: true, dims: true, moisture: true, equipment: true, airflow: true, labels: true };
    this.snapEnabled = true;
    this.undoStack = [];
    this.redoStack = [];

    this.pointers = new Map();
    this.gesture = null;
    this.hover = null;

    this.#bind();
    this.resize();
  }

  // ── coordinate helpers ────────────────────────────────────────────────────
  toScreen(p) {
    return { x: (p.x - this.cam.x) * this.cam.scale, y: (p.y - this.cam.y) * this.cam.scale };
  }
  toWorld(p) {
    return { x: p.x / this.cam.scale + this.cam.x, y: p.y / this.cam.scale + this.cam.y };
  }
  eventPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  snapWorld(p) {
    if (!this.snapEnabled) return p;
    return { x: Math.round(p.x / SNAP) * SNAP, y: Math.round(p.y / SNAP) * SNAP };
  }

  /** Snap to any existing room corner so adjacent rooms share walls cleanly. */
  snapToVertices(p, { exclude } = {}) {
    let best = null, bestD = VERTEX_SNAP_FT;
    for (const room of this.plan.rooms) {
      for (let i = 0; i < room.poly.length; i++) {
        if (exclude && exclude.roomId === room.id && exclude.index === i) continue;
        const d = dist(p, room.poly[i]);
        if (d < bestD) { bestD = d; best = { ...room.poly[i] }; }
      }
    }
    return best;
  }

  /** Constrain a point to axis alignment with the previous corner. */
  applyOrtho(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    if (!dx && !dy) return to;
    const angle = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
    const nearH = angle < ORTHO_DEG || angle > 180 - ORTHO_DEG;
    const nearV = Math.abs(angle - 90) < ORTHO_DEG;
    if (nearH) return { x: to.x, y: from.y };
    if (nearV) return { x: from.x, y: to.y };
    return to;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(r.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(r.height * dpr));
    this.dpr = dpr;
    this.w = r.width; this.h = r.height;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  destroy() {
    this.#unbind?.();
  }

  setTool(tool) {
    this.tool = tool;
    if (tool !== 'room' && tool !== 'containment') this.cancelDraft();
    if (tool !== 'select') this.select(null);
    this.render();
  }

  setLayer(name, on) { this.layers[name] = on; this.render(); }

  select(sel) {
    this.selection = sel;
    this.onSelect(sel);
    this.render();
  }

  pushUndo() {
    this.undoStack.push(JSON.stringify(this.plan));
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.plan));
    const prev = JSON.parse(this.undoStack.pop());
    this.#replacePlan(prev);
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.plan));
    this.#replacePlan(JSON.parse(this.redoStack.pop()));
    return true;
  }

  #replacePlan(next) {
    for (const k of Object.keys(this.plan)) delete this.plan[k];
    Object.assign(this.plan, next);
    this.select(null);
    this.commit();
  }

  commit() {
    this.onChange(this.plan);
    this.render();
  }

  // ── content creation ──────────────────────────────────────────────────────
  addRoom(poly, patch = {}) {
    const room = {
      id: uid('room'),
      name: patch.name || `Room ${this.plan.rooms.length + 1}`,
      level: patch.level || 'Main',
      ceilingHeight: patch.ceilingHeight || 8,
      poly,
      openings: [],
      isAffected: patch.isAffected !== false,
      affected: {
        floorMaterial: 'carpet', floorPct: 100,
        wallMaterial: 'drywall', wallLf: round(polygonPerimeter(poly)), wallHeightIn: 12,
        ceilingMaterial: '', ceilingPct: 0,
        offsets: 0, closets: 0, stairs: 0,
        ...(patch.affected || {}),
      },
      notes: '',
    };
    this.pushUndo();
    this.plan.rooms.push(room);
    this.commit();
    return room;
  }

  addRectRoom(widthFt, depthFt, patch = {}) {
    const origin = this.#nextRoomOrigin(widthFt, depthFt);
    const poly = [
      { x: origin.x, y: origin.y },
      { x: origin.x + widthFt, y: origin.y },
      { x: origin.x + widthFt, y: origin.y + depthFt },
      { x: origin.x, y: origin.y + depthFt },
    ];
    const room = this.addRoom(poly, patch);
    this.zoomToFit();
    return room;
  }

  /** Drop new boxes to the right of what already exists, with a 3 ft gap. */
  #nextRoomOrigin(w, d) {
    if (!this.plan.rooms.length) {
      const c = this.toWorld({ x: this.w / 2, y: this.h / 2 });
      return this.snapWorld({ x: c.x - w / 2, y: c.y - d / 2 });
    }
    const all = this.plan.rooms.flatMap((r) => r.poly);
    const b = bounds(all);
    return { x: round(b.maxX + 3), y: round(b.minY) };
  }

  deleteRoom(id) {
    this.pushUndo();
    this.plan.rooms = this.plan.rooms.filter((r) => r.id !== id);
    this.plan.pins = this.plan.pins.filter((p) => p.roomId !== id);
    this.plan.equipment = this.plan.equipment.filter((e) => e.roomId !== id);
    this.select(null);
    this.commit();
  }

  roomAt(worldPt) {
    return [...this.plan.rooms].reverse().find((r) => pointInPolygon(worldPt, r.poly)) || null;
  }

  addPin(worldPt, patch = {}) {
    const room = this.roomAt(worldPt);
    const pin = {
      id: uid('pin'),
      roomId: room?.id || null,
      x: round(worldPt.x, 2), y: round(worldPt.y, 2),
      label: patch.label || `${(this.plan.pins.length + 1)}`,
      materialId: patch.materialId || room?.affected?.floorMaterial || 'drywall',
      surface: patch.surface || 'wall',
      dryStandard: patch.dryStandard ?? null,
      readings: patch.readings || [],
      notes: '',
    };
    this.pushUndo();
    this.plan.pins.push(pin);
    this.commit();
    return pin;
  }

  addEquipment(worldPt, catalogId) {
    const item = catalogById(catalogId);
    if (!item) return null;
    const room = this.roomAt(worldPt);
    const eq = {
      id: uid('eq'),
      catalogId,
      type: item.type,
      roomId: room?.id || null,
      x: round(worldPt.x, 2), y: round(worldPt.y, 2),
      rot: 0,
      serial: '',
      placedAt: new Date().toISOString(),
      removedAt: null,
    };
    this.pushUndo();
    this.plan.equipment.push(eq);
    this.commit();
    return eq;
  }

  addArrow(a, b) {
    const arrow = { id: uid('arw'), kind: 'airflow', a: { ...a }, b: { ...b } };
    this.pushUndo();
    this.plan.arrows.push(arrow);
    this.commit();
    return arrow;
  }

  deleteItem(kind, id) {
    this.pushUndo();
    const map = { room: 'rooms', pin: 'pins', equipment: 'equipment', arrow: 'arrows', containment: 'containment' };
    const key = map[kind];
    if (!key) return;
    if (kind === 'room') return this.deleteRoom(id);
    this.plan[key] = (this.plan[key] || []).filter((x) => x.id !== id);
    this.select(null);
    this.commit();
  }

  // ── drafting ──────────────────────────────────────────────────────────────
  startDraft(kind = 'room') {
    this.draft = { kind, pts: [] };
    this.onDraft(this.draft);
    this.render();
  }

  cancelDraft() {
    if (!this.draft) return;
    this.draft = null;
    this.onDraft(null);
    this.render();
  }

  draftPoint(worldPt) {
    if (!this.draft) this.startDraft(this.tool === 'containment' ? 'containment' : 'room');
    const pts = this.draft.pts;
    let p = worldPt;

    if (pts.length) {
      const snapV = this.snapToVertices(p);
      p = snapV || this.snapWorld(this.applyOrtho(pts.at(-1), p));
      // tapping the first corner closes the shape
      if (pts.length >= 3 && dist(p, pts[0]) * this.cam.scale < 22) return this.closeDraft();
    } else {
      p = this.snapToVertices(p) || this.snapWorld(p);
    }
    pts.push(p);
    this.onDraft(this.draft);
    this.render();
    return null;
  }

  /** Add a wall of an exact typed length in a compass direction. */
  draftSegment(lengthFt, dir) {
    if (!Number.isFinite(lengthFt) || lengthFt <= 0) return;
    if (!this.draft) this.startDraft(this.tool === 'containment' ? 'containment' : 'room');
    const vec = { right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } }[dir]
      || { x: 1, y: 0 };
    const pts = this.draft.pts;
    if (!pts.length) {
      const c = this.toWorld({ x: this.w / 2, y: this.h / 2 });
      pts.push(this.snapWorld(c));
    }
    const last = pts.at(-1);
    pts.push({ x: round(last.x + vec.x * lengthFt, 3), y: round(last.y + vec.y * lengthFt, 3) });
    this.onDraft(this.draft);
    this.zoomToFit({ padding: 60, only: pts });
    this.render();
  }

  undoDraftPoint() {
    if (!this.draft?.pts.length) return;
    this.draft.pts.pop();
    this.onDraft(this.draft);
    this.render();
  }

  closeDraft() {
    const d = this.draft;
    if (!d) return null;
    if (d.kind === 'containment') {
      if (d.pts.length < 2) { this.cancelDraft(); return null; }
      this.pushUndo();
      this.plan.containment.push({ id: uid('con'), pts: d.pts.map((p) => ({ ...p })) });
      this.draft = null; this.onDraft(null); this.commit();
      return null;
    }
    if (d.pts.length < 3) { this.cancelDraft(); return null; }
    const poly = d.pts.map((p) => ({ ...p }));
    this.draft = null;
    this.onDraft(null);
    const room = this.addRoom(this.#squareUp(poly));
    this.select({ kind: 'room', id: room.id });
    return room;
  }

  /** Nudge near-axis walls fully square — hand-drawn plans are never exact. */
  #squareUp(poly) {
    const out = poly.map((p) => ({ ...p }));
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
      if (dx < 0.35 && dx > 0) b.x = a.x;
      else if (dy < 0.35 && dy > 0) b.y = a.y;
    }
    return out;
  }

  // ── wall editing ──────────────────────────────────────────────────────────
  /**
   * Set the length of one wall. The endpoint slides along the wall direction
   * and every following corner moves with it; the closing wall takes up the
   * difference, which is what you want on an orthogonal plan.
   */
  setWallLength(roomId, wallIndex, newLength) {
    const room = this.plan.rooms.find((r) => r.id === roomId);
    if (!room || !Number.isFinite(newLength) || newLength <= 0) return;
    const n = room.poly.length;
    const a = room.poly[wallIndex];
    const b = room.poly[(wallIndex + 1) % n];
    const cur = dist(a, b);
    if (cur < 1e-6) return;
    const ux = (b.x - a.x) / cur, uy = (b.y - a.y) / cur;
    const delta = newLength - cur;
    this.pushUndo();
    // move the endpoint and everything downstream of it, stopping before the
    // first corner so the polygon stays closed
    for (let k = 1; k < n; k++) {
      const idx = (wallIndex + k) % n;
      if (idx === 0) break;
      room.poly[idx].x = round(room.poly[idx].x + ux * delta, 3);
      room.poly[idx].y = round(room.poly[idx].y + uy * delta, 3);
    }
    this.commit();
  }

  moveVertex(roomId, index, worldPt) {
    const room = this.plan.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const snapped = this.snapToVertices(worldPt, { exclude: { roomId, index } }) || this.snapWorld(worldPt);
    room.poly[index] = snapped;
    this.render();
  }

  moveRoom(roomId, dx, dy) {
    const room = this.plan.rooms.find((r) => r.id === roomId);
    if (!room) return;
    for (const p of room.poly) { p.x = round(p.x + dx, 3); p.y = round(p.y + dy, 3); }
    for (const pin of this.plan.pins.filter((p) => p.roomId === roomId)) { pin.x += dx; pin.y += dy; }
    for (const eq of this.plan.equipment.filter((e) => e.roomId === roomId)) { eq.x += dx; eq.y += dy; }
    this.render();
  }

  addOpening(roomId, wallIndex, t, patch = {}) {
    const room = this.plan.rooms.find((r) => r.id === roomId);
    if (!room) return null;
    const opening = { id: uid('op'), wallIndex, t: clamp(t, 0.05, 0.95), width: patch.width || 3, type: patch.type || 'door' };
    this.pushUndo();
    room.openings.push(opening);
    this.commit();
    return opening;
  }

  // ── hit testing ───────────────────────────────────────────────────────────
  hitTest(worldPt) {
    const tol = 14 / this.cam.scale;

    for (const pin of this.plan.pins) {
      if (dist(worldPt, pin) < Math.max(tol, 0.8)) return { kind: 'pin', id: pin.id };
    }
    for (const eq of this.plan.equipment) {
      if (dist(worldPt, eq) < Math.max(tol, 0.9)) return { kind: 'equipment', id: eq.id };
    }
    for (const arw of this.plan.arrows) {
      if (pointToSegment(worldPt, arw.a, arw.b).dist < tol) return { kind: 'arrow', id: arw.id };
    }
    for (const room of [...this.plan.rooms].reverse()) {
      for (let i = 0; i < room.poly.length; i++) {
        if (dist(worldPt, room.poly[i]) < Math.max(tol, 0.6)) {
          return { kind: 'vertex', id: room.id, index: i };
        }
      }
    }
    for (const room of [...this.plan.rooms].reverse()) {
      for (let i = 0; i < room.poly.length; i++) {
        const a = room.poly[i], b = room.poly[(i + 1) % room.poly.length];
        if (pointToSegment(worldPt, a, b).dist < tol) return { kind: 'wall', id: room.id, index: i };
      }
    }
    const room = this.roomAt(worldPt);
    if (room) return { kind: 'room', id: room.id };
    return null;
  }

  // ── camera ────────────────────────────────────────────────────────────────
  zoomToFit({ padding = 48, only = null } = {}) {
    const pts = only || [
      ...this.plan.rooms.flatMap((r) => r.poly),
      ...this.plan.pins.map((p) => ({ x: p.x, y: p.y })),
      ...this.plan.equipment.map((e) => ({ x: e.x, y: e.y })),
    ];
    if (!pts.length) { this.cam = { x: -5, y: -5, scale: 14 }; this.render(); return; }
    const b = bounds(pts);
    const scale = clamp(
      Math.min((this.w - padding * 2) / Math.max(b.w, 4), (this.h - padding * 2) / Math.max(b.h, 4)),
      2, 60,
    );
    this.cam.scale = scale;
    this.cam.x = b.minX - (this.w / scale - b.w) / 2;
    this.cam.y = b.minY - (this.h / scale - b.h) / 2;
    this.render();
  }

  zoomBy(factor, center) {
    const c = center || { x: this.w / 2, y: this.h / 2 };
    const before = this.toWorld(c);
    this.cam.scale = clamp(this.cam.scale * factor, 2, 80);
    const after = this.toWorld(c);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.render();
  }

  // ── input ─────────────────────────────────────────────────────────────────
  #bind() {
    const c = this.canvas;
    const down = (e) => this.#onDown(e);
    const move = (e) => this.#onMove(e);
    const up = (e) => this.#onUp(e);
    const wheel = (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.12 : 0.89, this.eventPoint(e));
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', up);
    c.addEventListener('wheel', wheel, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    this.#unbind = () => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
      c.removeEventListener('pointerleave', up);
      c.removeEventListener('wheel', wheel);
    };
  }

  #onDown(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.eventPoint(e);
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.gesture = {
        type: 'pinch',
        startDist: dist(a, b),
        startScale: this.cam.scale,
        center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      return;
    }

    const world = this.toWorld(p);
    const hit = this.hitTest(world);

    if (this.tool === 'select') {
      if (hit?.kind === 'vertex') {
        this.pushUndo();
        this.gesture = { type: 'vertex', roomId: hit.id, index: hit.index, moved: false };
      } else if (hit?.kind === 'pin' || hit?.kind === 'equipment') {
        this.pushUndo();
        this.gesture = { type: 'item', kind: hit.kind, id: hit.id, moved: false, start: world };
      } else if (hit?.kind === 'room' && this.selection?.kind === 'room' && this.selection.id === hit.id) {
        this.pushUndo();
        this.gesture = { type: 'room', roomId: hit.id, last: world, moved: false };
      } else {
        this.gesture = { type: 'pan', start: p, cam: { ...this.cam }, moved: false, hit };
      }
    } else if (this.tool === 'arrow') {
      this.gesture = { type: 'arrow', a: this.snapWorld(world), b: this.snapWorld(world) };
    } else {
      this.gesture = { type: 'tap', start: p, world, hit, moved: false };
    }
    this.render();
  }

  #onMove(e) {
    if (!this.pointers.has(e.pointerId)) {
      const world = this.toWorld(this.eventPoint(e));
      if (this.draft?.pts.length) { this.hover = world; this.render(); }
      return;
    }
    const p = this.eventPoint(e);
    this.pointers.set(e.pointerId, p);
    const g = this.gesture;
    if (!g) return;

    if (g.type === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = dist(a, b);
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const worldBefore = this.toWorld(center);
      this.cam.scale = clamp((d / Math.max(g.startDist, 1)) * g.startScale, 2, 80);
      const worldAfter = this.toWorld(center);
      this.cam.x += worldBefore.x - worldAfter.x;
      this.cam.y += worldBefore.y - worldAfter.y;
      this.render();
      return;
    }

    const world = this.toWorld(p);
    switch (g.type) {
      case 'pan': {
        const dx = (p.x - g.start.x) / this.cam.scale;
        const dy = (p.y - g.start.y) / this.cam.scale;
        if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > 6) g.moved = true;
        this.cam.x = g.cam.x - dx;
        this.cam.y = g.cam.y - dy;
        this.render();
        break;
      }
      case 'vertex':
        g.moved = true;
        this.moveVertex(g.roomId, g.index, world);
        break;
      case 'room': {
        g.moved = true;
        this.moveRoom(g.roomId, world.x - g.last.x, world.y - g.last.y);
        g.last = world;
        break;
      }
      case 'item': {
        const list = g.kind === 'pin' ? this.plan.pins : this.plan.equipment;
        const item = list.find((x) => x.id === g.id);
        if (item) {
          g.moved = true;
          const s = this.snapWorld(world);
          item.x = s.x; item.y = s.y;
          const room = this.roomAt(s);
          item.roomId = room?.id || null;
          this.render();
        }
        break;
      }
      case 'arrow':
        g.b = this.snapWorld(world);
        this.render();
        break;
      case 'tap':
        if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > 8) {
          g.moved = true;
          this.gesture = { type: 'pan', start: g.start, cam: { ...this.cam }, moved: true };
        }
        break;
      default: break;
    }
  }

  #onUp(e) {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (this.pointers.size > 0) return;
    this.gesture = null;
    if (!g) return;

    if (g.type === 'pinch') return;

    if (g.type === 'arrow') {
      if (dist(g.a, g.b) > 0.5) this.addArrow(g.a, g.b);
      else this.render();
      return;
    }

    if (g.type === 'vertex' || g.type === 'room' || g.type === 'item') {
      if (g.moved) this.commit();
      else if (g.type === 'item') this.select({ kind: g.kind, id: g.id });
      return;
    }

    if (g.type === 'pan') {
      if (!g.moved && this.tool === 'select') this.select(g.hit || null);
      return;
    }

    if (g.type === 'tap' && !g.moved) {
      const world = g.world;
      switch (this.tool) {
        case 'room':
        case 'containment':
          this.draftPoint(world);
          break;
        case 'pin': {
          const pin = this.addPin(world);
          this.select({ kind: 'pin', id: pin.id, isNew: true });
          break;
        }
        case 'equip': {
          if (this.pendingEquip) {
            const eq = this.addEquipment(world, this.pendingEquip);
            if (eq) this.select({ kind: 'equipment', id: eq.id, isNew: true });
          }
          break;
        }
        case 'door': {
          const hit = this.hitTest(world);
          if (hit?.kind === 'wall') {
            const room = this.plan.rooms.find((r) => r.id === hit.id);
            const a = room.poly[hit.index], b = room.poly[(hit.index + 1) % room.poly.length];
            const { t } = pointToSegment(world, a, b);
            const op = this.addOpening(room.id, hit.index, t);
            this.select({ kind: 'opening', id: op.id, roomId: room.id, isNew: true });
          }
          break;
        }
        case 'erase': {
          const hit = this.hitTest(world);
          if (hit && hit.kind !== 'wall' && hit.kind !== 'vertex') {
            this.deleteItem(hit.kind, hit.id);
          }
          break;
        }
        default: break;
      }
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  get palette() { return PALETTES[this.theme] || PALETTES.dark; }

  render() {
    const ctx = this.ctx;
    if (!ctx || !this.w) return;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = this.palette.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    this.#paintContent();
    this.#drawDraft();
    this.#drawSelection();
    this.#drawScaleBar();
  }

  /** Everything that belongs in both the live canvas and the printed plan. */
  #paintContent() {
    if (this.layers.grid) this.#drawGrid();
    for (const room of this.plan.rooms) this.#drawRoom(room);
    if (this.layers.dims) for (const room of this.plan.rooms) this.#drawDimensions(room);
    for (const c of this.plan.containment || []) this.#drawContainment(c);
    if (this.layers.airflow) for (const a of this.plan.arrows || []) this.#drawArrow(a);
    if (this.layers.equipment) for (const e of this.plan.equipment || []) this.#drawEquipment(e);
    if (this.layers.moisture) for (const p of this.plan.pins || []) this.#drawPin(p);
    // room names last so nothing is drawn over them
    if (this.layers.labels) for (const room of this.plan.rooms) this.#drawRoomLabel(room);
  }

  #drawGrid() {
    const ctx = this.ctx;
    const step = this.cam.scale < 6 ? GRID_MAJOR : GRID_MINOR;
    const x0 = Math.floor(this.cam.x / step) * step;
    const y0 = Math.floor(this.cam.y / step) * step;
    const x1 = this.cam.x + this.w / this.cam.scale;
    const y1 = this.cam.y + this.h / this.cam.scale;
    ctx.lineWidth = 1;
    for (let x = x0; x <= x1; x += step) {
      const major = Math.abs(x % GRID_MAJOR) < 1e-6;
      ctx.strokeStyle = major ? 'rgba(148,163,184,0.16)' : 'rgba(148,163,184,0.07)';
      const sx = Math.round(this.toScreen({ x, y: 0 }).x) + 0.5;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, this.h); ctx.stroke();
    }
    for (let y = y0; y <= y1; y += step) {
      const major = Math.abs(y % GRID_MAJOR) < 1e-6;
      ctx.strokeStyle = major ? 'rgba(148,163,184,0.16)' : 'rgba(148,163,184,0.07)';
      const sy = Math.round(this.toScreen({ x: 0, y }).y) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(this.w, sy); ctx.stroke();
    }
  }

  #path(pts, close = true) {
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = this.toScreen(p);
      i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
    });
    if (close) ctx.closePath();
  }

  #drawRoom(room) {
    const ctx = this.ctx;
    const p = this.palette;
    const cat = this.job?.derived?.category || 1;
    const wet = room.isAffected !== false;
    this.#path(room.poly);
    ctx.fillStyle = wet ? (cat >= 3 ? p.cat3Fill : p.wetFill) : p.roomFill;
    ctx.fill();

    ctx.lineJoin = 'round';
    ctx.strokeStyle = wet ? p.wallWet : p.wall;
    ctx.lineWidth = Math.max(2, Math.min(6, this.cam.scale * 0.35));
    ctx.stroke();

    for (const op of room.openings || []) this.#drawOpening(room, op);
  }

  #drawOpening(room, op) {
    const ctx = this.ctx;
    const n = room.poly.length;
    const a = room.poly[op.wallIndex % n];
    const b = room.poly[(op.wallIndex + 1) % n];
    const len = dist(a, b);
    if (len < 0.1) return;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const centerT = clamp(op.t, 0, 1) * len;
    const half = Math.min(op.width, len) / 2;
    const p1 = { x: a.x + ux * (centerT - half), y: a.y + uy * (centerT - half) };
    const p2 = { x: a.x + ux * (centerT + half), y: a.y + uy * (centerT + half) };
    const s1 = this.toScreen(p1), s2 = this.toScreen(p2);
    ctx.save();
    ctx.strokeStyle = this.palette.gap;
    ctx.lineWidth = Math.max(3, Math.min(8, this.cam.scale * 0.42));
    ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y); ctx.stroke();
    ctx.strokeStyle = op.type === 'window' ? '#60a5fa' : '#fbbf24';
    ctx.lineWidth = 2;
    ctx.setLineDash(op.type === 'cased' ? [6, 4] : []);
    ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y); ctx.stroke();
    ctx.restore();
  }

  #drawDimensions(room) {
    const ctx = this.ctx;
    if (this.cam.scale < 4) return;
    ctx.save();
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const c = polygonCentroid(room.poly);
    for (let i = 0; i < room.poly.length; i++) {
      const a = room.poly[i], b = room.poly[(i + 1) % room.poly.length];
      const len = dist(a, b);
      // skip walls too short to label without colliding with their neighbours
      if (len * this.cam.scale < 34) continue;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // push the label outside the room
      const away = { x: mid.x - c.x, y: mid.y - c.y };
      const mag = Math.hypot(away.x, away.y) || 1;
      const off = 16 / this.cam.scale;
      const lp = this.toScreen({ x: mid.x + (away.x / mag) * off, y: mid.y + (away.y / mag) * off });
      const text = formatFeet(len, { compact: true });
      const w = ctx.measureText(text).width + 8;
      ctx.fillStyle = this.palette.dimBg;
      ctx.fillRect(lp.x - w / 2, lp.y - 8, w, 16);
      ctx.fillStyle = this.palette.dimText;
      ctx.fillText(text, lp.x, lp.y);
    }
    ctx.restore();
  }

  #drawRoomLabel(room) {
    const ctx = this.ctx;
    const b = bounds(room.poly);
    const wPx = b.w * this.cam.scale, hPx = b.h * this.cam.scale;
    if (Math.min(wPx, hPx) < 30) return;
    const c = this.toScreen(polygonCentroid(room.poly));
    const area = polygonArea(room.poly);
    const sub = `${Math.round(area)} sf · ${room.ceilingHeight}' clg`;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
    const boxW = Math.max(ctx.measureText(room.name).width, hPx > 46 ? ctx.measureText(sub).width : 0) + 12;
    // knock out a background so wall dimensions never sit on top of the name
    ctx.fillStyle = this.palette.dimBg;
    ctx.fillRect(c.x - boxW / 2, c.y - 15, boxW, hPx > 46 ? 34 : 20);
    ctx.fillStyle = this.palette.text;
    ctx.fillText(room.name, c.x, hPx > 46 ? c.y - 2 : c.y + 4);
    if (hPx > 46) {
      ctx.fillStyle = this.palette.sub;
      ctx.font = '500 11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(sub, c.x, c.y + 14);
    }
    ctx.restore();
  }

  #drawContainment(c) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#f472b6';
    ctx.setLineDash([10, 6]);
    ctx.lineWidth = 3;
    this.#path(c.pts, false);
    ctx.stroke();
    ctx.restore();
  }

  #drawArrow(a) {
    const ctx = this.ctx;
    const s = this.toScreen(a.a), e = this.toScreen(a.b);
    const ang = Math.atan2(e.y - s.y, e.x - s.x);
    ctx.save();
    ctx.strokeStyle = '#38bdf8';
    ctx.fillStyle = '#38bdf8';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y); ctx.stroke();
    const head = 10;
    ctx.beginPath();
    ctx.moveTo(e.x, e.y);
    ctx.lineTo(e.x - head * Math.cos(ang - 0.4), e.y - head * Math.sin(ang - 0.4));
    ctx.lineTo(e.x - head * Math.cos(ang + 0.4), e.y - head * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  #drawEquipment(eq) {
    const ctx = this.ctx;
    const item = catalogById(eq.catalogId);
    const type = EQUIPMENT_TYPES[eq.type] || EQUIPMENT_TYPES.air_mover;
    const s = this.toScreen(eq);
    const r = Math.max(MIN_ICON_PX, this.cam.scale * 1.1) / 2;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(((eq.rot || 0) * Math.PI) / 180);
    ctx.fillStyle = eq.removedAt ? 'rgba(100,116,139,0.5)' : type.color;
    ctx.strokeStyle = this.palette.outline;
    ctx.lineWidth = 2;

    if (eq.type === 'air_mover') {
      ctx.beginPath();
      ctx.moveTo(-r, -r * 0.8); ctx.lineTo(r, 0); ctx.lineTo(-r, r * 0.8);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (eq.type === 'dehu') {
      ctx.beginPath();
      ctx.roundRect(-r, -r * 0.85, r * 2, r * 1.7, 4);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#0b1220';
      ctx.font = `700 ${Math.round(r)}px ui-sans-serif, system-ui`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('D', 0, 0);
    } else {
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#0b1220';
      ctx.font = `700 ${Math.round(r)}px ui-sans-serif, system-ui`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(eq.type === 'afd' ? 'A' : 'S', 0, 0);
    }
    ctx.restore();

    if ((this.cam.scale > 16 || this.theme === 'light') && item) {
      ctx.save();
      ctx.font = '500 10px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.fillStyle = this.palette.sub;
      ctx.fillText(item.code || '', s.x, s.y + r + 12);
      ctx.restore();
    }
  }

  #drawPin(pin) {
    const ctx = this.ctx;
    const s = this.toScreen(pin);
    const last = pin.readings?.at(-1);
    const goal = pin.goal ?? null;
    let color = '#f59e0b';
    if (last && goal != null) color = Number(last.value) <= Number(goal) ? '#22c55e' : '#ef4444';
    else if (last) color = '#38bdf8';

    const r = Math.max(9, Math.min(16, this.cam.scale * 0.6));
    ctx.save();
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.92;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.palette.outline;
    ctx.stroke();
    ctx.fillStyle = '#0b1220';
    ctx.font = `700 ${Math.round(r)}px ui-sans-serif, system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(pin.label ?? '').slice(0, 3), s.x, s.y + 0.5);
    if (last && (this.cam.scale > 8 || this.theme === 'light')) {
      ctx.font = '600 11px ui-sans-serif, system-ui';
      ctx.fillStyle = this.palette.text;
      ctx.fillText(String(last.value), s.x, s.y + r + 10);
    }
    ctx.restore();
  }

  #drawDraft() {
    const d = this.draft;
    if (!d || !d.pts.length) return;
    const ctx = this.ctx;
    const pts = [...d.pts];
    if (this.hover) pts.push(this.snapWorld(this.applyOrtho(d.pts.at(-1), this.hover)));

    ctx.save();
    ctx.strokeStyle = d.kind === 'containment' ? '#f472b6' : '#facc15';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 5]);
    this.#path(pts, false);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '600 11px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const mid = this.toScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const text = formatFeet(dist(a, b), { compact: true });
      const w = ctx.measureText(text).width + 8;
      ctx.fillStyle = 'rgba(250,204,21,0.15)';
      ctx.fillRect(mid.x - w / 2, mid.y - 9, w, 18);
      ctx.fillStyle = '#facc15';
      ctx.fillText(text, mid.x, mid.y + 4);
    }

    for (const p of d.pts) {
      const s = this.toScreen(p);
      ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#facc15'; ctx.fill();
    }
    if (d.pts.length >= 3) {
      const s = this.toScreen(d.pts[0]);
      ctx.beginPath(); ctx.arc(s.x, s.y, 11, 0, Math.PI * 2);
      ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 2.5; ctx.stroke();
    }
    ctx.restore();
  }

  #drawSelection() {
    const sel = this.selection;
    if (!sel) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 2.5;

    if (sel.kind === 'room' || sel.kind === 'wall' || sel.kind === 'vertex') {
      const room = this.plan.rooms.find((r) => r.id === sel.id);
      if (room) {
        this.#path(room.poly);
        ctx.stroke();
        for (const p of room.poly) {
          const s = this.toScreen(p);
          ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
          ctx.fillStyle = '#facc15'; ctx.fill();
        }
        if (sel.kind === 'wall' && sel.index != null) {
          const a = room.poly[sel.index], b = room.poly[(sel.index + 1) % room.poly.length];
          const sa = this.toScreen(a), sb = this.toScreen(b);
          ctx.strokeStyle = '#fb923c'; ctx.lineWidth = 5;
          ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
        }
      }
    } else {
      const list = sel.kind === 'pin' ? this.plan.pins
        : sel.kind === 'equipment' ? this.plan.equipment
        : sel.kind === 'arrow' ? this.plan.arrows : [];
      const item = list.find((x) => x.id === sel.id);
      if (item) {
        const s = this.toScreen(item.a ? item.a : item);
        ctx.beginPath(); ctx.arc(s.x, s.y, 20, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  }

  #drawScaleBar() {
    const ctx = this.ctx;
    const targetPx = 90;
    const feet = [1, 2, 5, 10, 20, 50].find((f) => f * this.cam.scale >= targetPx) || 50;
    const px = feet * this.cam.scale;
    const x = 14, y = this.h - 18;
    ctx.save();
    ctx.strokeStyle = this.palette.scale;
    ctx.fillStyle = this.palette.scale;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5);
    ctx.stroke();
    ctx.font = '600 11px ui-sans-serif, system-ui';
    ctx.fillText(`${feet}'`, x + px + 8, y + 3);
    ctx.restore();
  }

  /**
   * PNG data URL of the plan on a light background, for the report and for
   * sending to an adjuster. Same drawing code as the screen, light palette.
   */
  exportPNG({ width = 1400, height = 1000 } = {}) {
    const off = document.createElement('canvas');
    off.width = width; off.height = height;
    const octx = off.getContext('2d');

    const saved = {
      ctx: this.ctx, cam: { ...this.cam }, w: this.w, h: this.h,
      layers: { ...this.layers }, sel: this.selection, theme: this.theme,
    };
    this.ctx = octx; this.w = width; this.h = height;
    this.selection = null; this.theme = 'light';
    this.layers = { ...this.layers, grid: false, labels: true, dims: true };

    octx.fillStyle = this.palette.bg;
    octx.fillRect(0, 0, width, height);
    this.zoomToFit({ padding: 70 });
    octx.fillStyle = this.palette.bg;
    octx.fillRect(0, 0, width, height);
    this.#paintContent();
    this.#drawScaleBar();

    const url = off.toDataURL('image/png');
    Object.assign(this, {
      ctx: saved.ctx, cam: saved.cam, w: saved.w, h: saved.h,
      layers: saved.layers, selection: saved.sel, theme: saved.theme,
    });
    this.render();
    return url;
  }

  /** Totals used by the estimate, report and drying calculations. */
  totals() {
    let floor = 0, wall = 0, ceiling = 0, volume = 0, perimeter = 0;
    for (const room of this.plan.rooms) {
      const a = polygonArea(room.poly);
      const p = polygonPerimeter(room.poly);
      const hgt = Number(room.ceilingHeight) || 8;
      floor += a; ceiling += a; wall += p * hgt; volume += a * hgt; perimeter += p;
    }
    return { floor: round(floor), wall: round(wall), ceiling: round(ceiling), volume: round(volume), perimeter: round(perimeter), rooms: this.plan.rooms.length };
  }
}

export { materialById };
