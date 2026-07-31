/* Floor plan canvas: draw rooms with a finger, then stack the moisture,
 * airflow and equipment layers on top of the same geometry.
 *
 * World units are feet. Screen units are CSS pixels. `view` holds the
 * pan/zoom transform; everything else converts through toScreen/toWorld.
 */

import {
  polygonArea, polygonPerimeter, polygonCentroid, boundingBox, pointInPolygon,
  dist, closestPointOnSegment, snapToAngle, snapToGrid, snapToVertices, walls,
} from './geom.js';

const HIT_RADIUS_PX = 22;      // generous — this is used with a gloved thumb
const VERTEX_RADIUS_PX = 7;

export const TOOLS = {
  SELECT: 'select',
  ROOM: 'room',
  MOISTURE: 'moisture',
  EQUIPMENT: 'equipment',
  FLOW: 'flow',
  OPENING: 'opening',
};

export class Sketch {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { x: 0, y: 0, scale: 12 }; // pixels per foot
    this.tool = TOOLS.SELECT;
    this.rooms = [];
    this.activeRoomId = null;
    this.draft = null;            // in-progress room polygon
    this.layers = { moisture: true, equipment: true, flow: true, dimensions: true, grid: true };
    this.equipmentType = 'airMover';
    this.onChange = opts.onChange || (() => {});
    this.onSelect = opts.onSelect || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.pointStatusFor = opts.pointStatusFor || (() => null);
    this.snapAngle = true;
    this.gridSize = 0.5;
    this.drag = null;
    this.pointers = new Map();
    this.pinch = null;
    this.theme = readTheme();

    this._bind();
    this.resize();
  }

  /* ── Coordinate transforms ─────────────────────────────────────────────── */

  toScreen(p) {
    return { x: (p.x - this.view.x) * this.view.scale, y: (p.y - this.view.y) * this.view.scale };
  }

  toWorld(p) {
    return { x: p.x / this.view.scale + this.view.x, y: p.y / this.view.scale + this.view.y };
  }

  eventPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /* ── Lifecycle ─────────────────────────────────────────────────────────── */

  resize() {
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = w;
    this.height = h;
    this.draw();
  }

  setRooms(rooms, activeRoomId) {
    this.rooms = rooms || [];
    this.activeRoomId = activeRoomId;
    this.draw();
  }

  setTool(tool) {
    this.tool = tool;
    if (tool !== TOOLS.ROOM) this.draft = null;
    this.status();
    this.draw();
  }

  setLayer(name, on) {
    this.layers[name] = on;
    this.draw();
  }

  status() {
    const msgs = {
      [TOOLS.SELECT]: 'Drag to pan. Pinch to zoom. Tap a room to select, drag a corner to reshape.',
      [TOOLS.ROOM]: this.draft
        ? `${this.draft.poly.length} corner${this.draft.poly.length === 1 ? '' : 's'} — tap the first corner to close, or press Finish.`
        : 'Tap each corner of the room in order. Walls snap square automatically.',
      [TOOLS.MOISTURE]: 'Tap where you took the reading to drop a monitoring point.',
      [TOOLS.EQUIPMENT]: 'Tap to place equipment. Drag a placed unit to move it; tap it to rotate or remove.',
      [TOOLS.FLOW]: 'Drag to draw an airflow arrow showing which way the air is being pushed.',
      [TOOLS.OPENING]: 'Tap a wall to mark a door or window opening.',
    };
    this.onStatus(msgs[this.tool] || '');
  }

  /** Fit every drawn room in view, with a margin. */
  zoomToFit(padding = 40) {
    const pts = this.rooms.flatMap((r) => r.poly || []);
    if (pts.length < 2) {
      this.view = { x: -this.width / 2 / 12, y: -this.height / 2 / 12, scale: 12 };
      this.draw();
      return;
    }
    const bb = boundingBox(pts);
    const scaleX = (this.width - padding * 2) / Math.max(1, bb.width);
    const scaleY = (this.height - padding * 2) / Math.max(1, bb.height);
    const scale = Math.max(2, Math.min(60, Math.min(scaleX, scaleY)));
    this.view = {
      scale,
      x: bb.minX - (this.width - bb.width * scale) / 2 / scale,
      y: bb.minY - (this.height - bb.height * scale) / 2 / scale,
    };
    this.draw();
  }

  /* ── Input ─────────────────────────────────────────────────────────────── */

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e));
    c.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _down(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, this.eventPoint(e));

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: dist(a, b), center: mid(a, b), scale: this.view.scale, view: { ...this.view } };
      this.drag = null;
      return;
    }
    if (this.pointers.size > 2) return;

    const screen = this.eventPoint(e);
    const world = this.toWorld(screen);
    this.pressStart = { screen, world, at: Date.now(), moved: false };

    switch (this.tool) {
      case TOOLS.SELECT:   this._downSelect(screen, world); break;
      case TOOLS.FLOW:     this._downFlow(world); break;
      default:             this.drag = { mode: 'maybe-pan', start: screen, view: { ...this.view } };
    }
  }

  _downSelect(screen, world) {
    // Vertex handles on the active room win over everything else.
    const room = this.rooms.find((r) => r.id === this.activeRoomId);
    if (room) {
      const vi = (room.poly || []).findIndex((p) => dist(this.toScreen(p), screen) < HIT_RADIUS_PX);
      if (vi >= 0) {
        this.drag = { mode: 'vertex', roomId: room.id, index: vi };
        return;
      }
      const eq = this._hitEquipment(room, screen);
      if (eq) {
        this.drag = { mode: 'equipment', roomId: room.id, id: eq.id, offset: sub(world, eq) };
        return;
      }
      const pt = this._hitPoint(room, screen);
      if (pt) {
        this.drag = { mode: 'point', roomId: room.id, id: pt.id, offset: sub(world, pt) };
        return;
      }
    }
    this.drag = { mode: 'maybe-pan', start: screen, view: { ...this.view } };
  }

  _downFlow(world) {
    this.drag = { mode: 'flow', from: world, to: world };
  }

  _move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, this.eventPoint(e));

    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = dist(a, b);
      const factor = d / (this.pinch.dist || 1);
      const scale = clamp(this.pinch.scale * factor, 2, 90);
      // Keep the world point under the pinch centre pinned.
      const center = this.pinch.center;
      const worldCenter = {
        x: center.x / this.pinch.view.scale + this.pinch.view.x,
        y: center.y / this.pinch.view.scale + this.pinch.view.y,
      };
      this.view = { scale, x: worldCenter.x - center.x / scale, y: worldCenter.y - center.y / scale };
      this.draw();
      return;
    }

    const screen = this.eventPoint(e);
    const world = this.toWorld(screen);
    if (this.pressStart && dist(screen, this.pressStart.screen) > 6) this.pressStart.moved = true;

    if (!this.drag) {
      if (this.tool === TOOLS.ROOM && this.draft) {
        this.hover = this._snapDraftPoint(world);
        this.draw();
      }
      return;
    }

    switch (this.drag.mode) {
      case 'maybe-pan':
        if (dist(screen, this.drag.start) > 6) this.drag.mode = 'pan';
        break;
      case 'flow':
        this.drag.to = world;
        break;
      case 'vertex': {
        const room = this.rooms.find((r) => r.id === this.drag.roomId);
        if (room) {
          const others = this.rooms.filter((r) => r.id !== room.id).flatMap((r) => r.poly || []);
          let p = snapToVertices(world, others, 18 / this.view.scale);
          if (!p.snapped) p = snapToGrid(world, this.gridSize);
          room.poly[this.drag.index] = { x: p.x, y: p.y };
          this.onChange('vertex');
        }
        break;
      }
      case 'equipment': {
        const room = this.rooms.find((r) => r.id === this.drag.roomId);
        const eq = room?.equipment?.find((x) => x.id === this.drag.id);
        if (eq) {
          const p = sub(world, this.drag.offset);
          eq.x = p.x; eq.y = p.y;
          this.onChange('equipment-move');
        }
        break;
      }
      case 'point': {
        const room = this.rooms.find((r) => r.id === this.drag.roomId);
        const pt = room?.points?.find((x) => x.id === this.drag.id);
        if (pt) {
          const p = sub(world, this.drag.offset);
          pt.x = p.x; pt.y = p.y;
          this.onChange('point-move');
        }
        break;
      }
    }

    if (this.drag.mode === 'pan') {
      const dx = (screen.x - this.drag.start.x) / this.view.scale;
      const dy = (screen.y - this.drag.start.y) / this.view.scale;
      this.view.x = this.drag.view.x - dx;
      this.view.y = this.drag.view.y - dy;
    }
    this.draw();
  }

  _up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;

    const drag = this.drag;
    const press = this.pressStart;
    this.drag = null;
    this.pressStart = null;
    if (this.pointers.size > 0) return;

    if (drag?.mode === 'flow') {
      if (dist(drag.from, drag.to) > 1) {
        this.onSelect({ type: 'flow', from: drag.from, to: drag.to });
      }
      this.draw();
      return;
    }
    if (drag && drag.mode !== 'maybe-pan') {
      // A real drag already fired onChange; nothing more to do on release.
      if (drag.mode === 'vertex' || drag.mode === 'equipment' || drag.mode === 'point') this.onChange('commit');
      this.draw();
      return;
    }

    // Treat as a tap.
    if (!press || press.moved) { this.draw(); return; }
    this._tap(press.screen, press.world);
  }

  _tap(screen, world) {
    switch (this.tool) {
      case TOOLS.ROOM: this._tapRoom(screen, world); break;
      case TOOLS.MOISTURE: {
        const room = this._roomAt(world) || this.rooms.find((r) => r.id === this.activeRoomId);
        if (room) this.onSelect({ type: 'moisture', roomId: room.id, x: world.x, y: world.y });
        break;
      }
      case TOOLS.EQUIPMENT: {
        const room = this._roomAt(world) || this.rooms.find((r) => r.id === this.activeRoomId);
        if (room) this.onSelect({ type: 'equipment', roomId: room.id, x: world.x, y: world.y, equipmentType: this.equipmentType });
        break;
      }
      case TOOLS.OPENING: {
        const hit = this._hitWall(world);
        if (hit) this.onSelect({ type: 'opening', roomId: hit.roomId, wallIndex: hit.wallIndex, t: hit.t, x: hit.point.x, y: hit.point.y });
        break;
      }
      default: {
        const room = this.rooms.find((r) => r.id === this.activeRoomId);
        if (room) {
          const eq = this._hitEquipment(room, screen);
          if (eq) { this.onSelect({ type: 'equipment-tap', roomId: room.id, id: eq.id }); return; }
          const pt = this._hitPoint(room, screen);
          if (pt) { this.onSelect({ type: 'point-tap', roomId: room.id, id: pt.id }); return; }
        }
        const target = this._roomAt(world);
        if (target) this.onSelect({ type: 'room-tap', roomId: target.id });
      }
    }
    this.draw();
  }

  _tapRoom(screen, world) {
    if (!this.draft) {
      this.draft = { poly: [] };
    }
    const poly = this.draft.poly;
    // Tapping the first corner closes the room.
    if (poly.length >= 3 && dist(this.toScreen(poly[0]), screen) < HIT_RADIUS_PX) {
      this.finishRoom();
      return;
    }
    poly.push(this._snapDraftPoint(world));
    this.status();
    this.onChange('draft');
  }

  _snapDraftPoint(world) {
    const poly = this.draft?.poly || [];
    const others = this.rooms.flatMap((r) => r.poly || []);
    const vertexSnap = snapToVertices(world, others, 18 / this.view.scale);
    if (vertexSnap.snapped) return { x: vertexSnap.x, y: vertexSnap.y };
    if (poly.length && this.snapAngle) {
      const prev = poly[poly.length - 1];
      const snapped = snapToAngle(prev, world, { thresholdDeg: 14 });
      return snapToGrid(snapped, this.gridSize);
    }
    return snapToGrid(world, this.gridSize);
  }

  finishRoom() {
    const poly = this.draft?.poly || [];
    if (poly.length < 3) {
      this.draft = null;
      this.status();
      this.draw();
      return null;
    }
    this.draft = null;
    this.hover = null;
    this.status();
    this.onSelect({ type: 'room-complete', poly });
    return poly;
  }

  cancelRoom() {
    this.draft = null;
    this.hover = null;
    this.status();
    this.draw();
  }

  undoDraftPoint() {
    if (this.draft?.poly.length) {
      this.draft.poly.pop();
      if (!this.draft.poly.length) this.draft = null;
      this.status();
      this.draw();
    }
  }

  /** Snap the draft to a clean rectangle — the 90% case in residential work. */
  draftRectangle(widthFt, heightFt) {
    const origin = this.draft?.poly?.[0] || this.toWorld({ x: this.width / 2 - (widthFt * this.view.scale) / 2, y: this.height / 2 - (heightFt * this.view.scale) / 2 });
    return [
      { x: origin.x, y: origin.y },
      { x: origin.x + widthFt, y: origin.y },
      { x: origin.x + widthFt, y: origin.y + heightFt },
      { x: origin.x, y: origin.y + heightFt },
    ];
  }

  _wheel(e) {
    e.preventDefault();
    const screen = this.eventPoint(e);
    const world = this.toWorld(screen);
    const factor = Math.exp(-e.deltaY * 0.0016);
    const scale = clamp(this.view.scale * factor, 2, 90);
    this.view = { scale, x: world.x - screen.x / scale, y: world.y - screen.y / scale };
    this.draw();
  }

  /* ── Hit testing ───────────────────────────────────────────────────────── */

  _roomAt(world) {
    // Later rooms draw on top, so search backwards.
    for (let i = this.rooms.length - 1; i >= 0; i--) {
      if (pointInPolygon(world, this.rooms[i].poly || [])) return this.rooms[i];
    }
    return null;
  }

  _hitEquipment(room, screen) {
    if (!this.layers.equipment) return null;
    return (room.equipment || []).filter((eq) => !eq.removedAt)
      .find((eq) => dist(this.toScreen(eq), screen) < HIT_RADIUS_PX) || null;
  }

  _hitPoint(room, screen) {
    if (!this.layers.moisture) return null;
    return (room.points || []).find((p) => dist(this.toScreen(p), screen) < HIT_RADIUS_PX) || null;
  }

  _hitWall(world) {
    let best = null;
    const tolerance = 20 / this.view.scale;
    for (const room of this.rooms) {
      for (const w of walls(room.poly || [])) {
        const hit = closestPointOnSegment(world, w.a, w.b);
        if (hit.distance < tolerance && (!best || hit.distance < best.distance)) {
          best = { roomId: room.id, wallIndex: w.index, t: hit.t, point: hit.point, distance: hit.distance };
        }
      }
    }
    return best;
  }

  /* ── Rendering ─────────────────────────────────────────────────────────── */

  draw() {
    const ctx = this.ctx;
    const t = this.theme;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = t.canvasBg;
    ctx.fillRect(0, 0, this.width, this.height);

    if (this.layers.grid) this._drawGrid();

    for (const room of this.rooms) this._drawRoom(room, room.id === this.activeRoomId);
    for (const room of this.rooms) {
      if (this.layers.flow) this._drawFlow(room);
      if (this.layers.equipment) this._drawEquipment(room);
      if (this.layers.moisture) this._drawPoints(room);
    }

    if (this.draft) this._drawDraft();
    if (this.drag?.mode === 'flow') this._drawArrow(this.toScreen(this.drag.from), this.toScreen(this.drag.to), t.flow, 3);

    this._drawScaleBar();
  }

  _drawGrid() {
    const ctx = this.ctx, t = this.theme;
    // Grid lines every foot, heavier every 5 ft; drop the fine grid when zoomed out.
    const step = this.view.scale >= 14 ? 1 : this.view.scale >= 7 ? 5 : 10;
    const startX = Math.floor(this.view.x / step) * step;
    const startY = Math.floor(this.view.y / step) * step;
    const endX = this.view.x + this.width / this.view.scale;
    const endY = this.view.y + this.height / this.view.scale;

    ctx.lineWidth = 1;
    for (let x = startX; x <= endX; x += step) {
      const major = Math.abs(x % 5) < 1e-6;
      ctx.strokeStyle = major ? t.gridMajor : t.gridMinor;
      const sx = Math.round((x - this.view.x) * this.view.scale) + 0.5;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, this.height); ctx.stroke();
    }
    for (let y = startY; y <= endY; y += step) {
      const major = Math.abs(y % 5) < 1e-6;
      ctx.strokeStyle = major ? t.gridMajor : t.gridMinor;
      const sy = Math.round((y - this.view.y) * this.view.scale) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(this.width, sy); ctx.stroke();
    }
  }

  _drawRoom(room, active) {
    const poly = room.poly || [];
    if (poly.length < 2) return;
    const ctx = this.ctx, t = this.theme;
    const pts = poly.map((p) => this.toScreen(p));

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();

    ctx.fillStyle = active ? t.roomFillActive : t.roomFill;
    ctx.fill();
    ctx.strokeStyle = active ? t.roomStrokeActive : t.roomStroke;
    ctx.lineWidth = active ? 3 : 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    if (this.layers.moisture) this._drawMoistureWash(room, pts);
    this._drawOpenings(room);
    if (this.layers.dimensions) this._drawDimensions(room, pts);
    this._drawRoomLabel(room);

    if (active) {
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, VERTEX_RADIUS_PX, 0, Math.PI * 2);
        ctx.fillStyle = t.vertexFill;
        ctx.fill();
        ctx.strokeStyle = t.roomStrokeActive;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  /**
   * Soft radial wash under each monitoring point, clipped to the room, so the
   * plan reads as a moisture map at a glance rather than a scatter of dots.
   */
  _drawMoistureWash(room, screenPts) {
    const points = (room.points || []).filter((p) => (p.readings || []).length);
    if (!points.length || screenPts.length < 3) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(screenPts[0].x, screenPts[0].y);
    for (let i = 1; i < screenPts.length; i++) ctx.lineTo(screenPts[i].x, screenPts[i].y);
    ctx.closePath();
    ctx.clip();

    for (const p of points) {
      const status = this.pointStatusFor(p);
      if (!status || status.state === 'no-data') continue;
      const s = this.toScreen(p);
      const radius = Math.max(40, 6 * this.view.scale);
      const color = wetnessColor(status);
      const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, radius);
      grad.addColorStop(0, `${color}66`);
      grad.addColorStop(0.6, `${color}26`);
      grad.addColorStop(1, `${color}00`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawOpenings(room) {
    const ctx = this.ctx, t = this.theme;
    const segs = walls(room.poly || []);
    for (const o of room.openings || []) {
      const seg = segs[o.wallIndex];
      if (!seg) continue;
      const halfW = (o.width || 3) / 2;
      const center = seg.length * (o.t ?? 0.5);
      const a = { x: seg.a.x + seg.dir.x * Math.max(0, center - halfW), y: seg.a.y + seg.dir.y * Math.max(0, center - halfW) };
      const b = { x: seg.a.x + seg.dir.x * Math.min(seg.length, center + halfW), y: seg.a.y + seg.dir.y * Math.min(seg.length, center + halfW) };
      const sa = this.toScreen(a), sb = this.toScreen(b);
      ctx.strokeStyle = t.canvasBg;
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
      ctx.strokeStyle = o.type === 'window' ? t.window : t.door;
      ctx.lineWidth = 3;
      ctx.setLineDash(o.type === 'window' ? [] : [7, 5]);
      ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  _drawDimensions(room, screenPts) {
    if (this.view.scale < 5) return;
    const ctx = this.ctx, t = this.theme;
    const poly = room.poly;
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const len = dist(a, b);
      if (len < 0.5) continue;
      const sa = screenPts[i], sb = screenPts[(i + 1) % screenPts.length];
      if (dist(sa, sb) < 34) continue;
      const m = mid(sa, sb);
      const label = formatFeetInches(len);
      const w = ctx.measureText(label).width;

      // Nudge the label off the wall, toward the outside of the room.
      const c = this.toScreen(polygonCentroid(poly));
      const away = norm({ x: m.x - c.x, y: m.y - c.y });
      const lx = m.x + away.x * 13, ly = m.y + away.y * 13;

      ctx.fillStyle = t.dimBg;
      roundRect(ctx, lx - w / 2 - 5, ly - 9, w + 10, 18, 4);
      ctx.fill();
      ctx.fillStyle = t.dimText;
      ctx.fillText(label, lx, ly);
    }
  }

  _drawRoomLabel(room) {
    const poly = room.poly || [];
    if (poly.length < 3) return;
    const ctx = this.ctx, t = this.theme;
    const c = this.toScreen(polygonCentroid(poly));
    const area = polygonArea(poly);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = t.roomLabel;
    ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(room.name || 'Room', c.x, c.y - 9);
    ctx.font = '500 11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = t.roomLabelDim;
    ctx.fillText(`${Math.round(area)} sf · ${Math.round(polygonPerimeter(poly))} lf`, c.x, c.y + 8);
  }

  _drawPoints(room) {
    const ctx = this.ctx, t = this.theme;
    for (const p of room.points || []) {
      const s = this.toScreen(p);
      const status = this.pointStatusFor(p);
      const color = status && status.state !== 'no-data' ? wetnessColor(status) : t.pointEmpty;

      ctx.beginPath();
      ctx.arc(s.x, s.y, 11, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = t.pointRing;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      const value = status && status.value != null ? Math.round(status.value) : '?';
      ctx.fillStyle = '#fff';
      ctx.font = '700 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(value), s.x, s.y);

      if (p.label) {
        ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = t.roomLabelDim;
        ctx.fillText(p.label, s.x, s.y + 21);
      }
      // A stalled point is the thing you most need to notice on the plan.
      if (status?.state === 'stalled' && status.readingCount >= 3) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 16, 0, Math.PI * 2);
        ctx.strokeStyle = t.stalled;
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  _drawEquipment(room) {
    const ctx = this.ctx, t = this.theme;
    for (const eq of room.equipment || []) {
      if (eq.removedAt) continue;
      const s = this.toScreen(eq);
      const size = Math.max(15, Math.min(26, this.view.scale * 1.5));
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(((eq.rot || 0) * Math.PI) / 180);

      const color = t.equipment[eq.type] || t.equipmentDefault;
      if (eq.type === 'airMover') {
        // Wedge pointing the way the air is thrown.
        ctx.beginPath();
        ctx.moveTo(size * 0.9, 0);
        ctx.lineTo(-size * 0.55, -size * 0.6);
        ctx.lineTo(-size * 0.25, 0);
        ctx.lineTo(-size * 0.55, size * 0.6);
        ctx.closePath();
      } else if (eq.type === 'airScrubber') {
        ctx.beginPath();
        ctx.arc(0, 0, size * 0.66, 0, Math.PI * 2);
      } else {
        roundRect(ctx, -size * 0.62, -size * 0.5, size * 1.24, size, 4);
      }
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = t.equipmentRing;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      // Unit labels turn to mush when a dozen air movers sit in a small room,
      // so only draw them once there is enough zoom to read them apart.
      if (eq.label && this.view.scale >= 16) {
        ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = t.roomLabelDim;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(eq.label, s.x, s.y + size * 0.72);
      }
    }
  }

  _drawFlow(room) {
    const t = this.theme;
    for (const f of room.flow || []) {
      this._drawArrow(this.toScreen(f.from), this.toScreen(f.to), t.flow, 3);
    }
  }

  _drawArrow(a, b, color, width) {
    const ctx = this.ctx;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = 11;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x - Math.cos(angle) * head * 0.6, b.y - Math.sin(angle) * head * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - Math.cos(angle - 0.42) * head, b.y - Math.sin(angle - 0.42) * head);
    ctx.lineTo(b.x - Math.cos(angle + 0.42) * head, b.y - Math.sin(angle + 0.42) * head);
    ctx.closePath();
    ctx.fill();
  }

  _drawDraft() {
    const ctx = this.ctx, t = this.theme;
    const poly = this.draft.poly;
    if (!poly.length) return;
    const pts = poly.map((p) => this.toScreen(p));
    const preview = this.hover ? this.toScreen(this.hover) : null;

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (preview) ctx.lineTo(preview.x, preview.y);
    ctx.strokeStyle = t.draft;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Live length readout on the segment being drawn.
    if (preview && pts.length) {
      const last = poly[poly.length - 1];
      const len = dist(last, this.hover);
      if (len > 0.3) {
        const m = mid(pts[pts.length - 1], preview);
        const label = formatFeetInches(len);
        ctx.font = '700 12px ui-sans-serif, system-ui, sans-serif';
        const w = ctx.measureText(label).width;
        ctx.fillStyle = t.draft;
        roundRect(ctx, m.x - w / 2 - 6, m.y - 10, w + 12, 20, 4);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, m.x, m.y);
      }
    }

    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, i === 0 && poly.length >= 3 ? 11 : 6, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 && poly.length >= 3 ? t.draftClose : t.draft;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  _drawScaleBar() {
    const ctx = this.ctx, t = this.theme;
    const targetPx = 90;
    const feet = niceNumber(targetPx / this.view.scale);
    const px = feet * this.view.scale;
    const x = 14, y = this.height - 18;
    ctx.strokeStyle = t.scaleBar;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + px, y);
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5);
    ctx.moveTo(x + px, y - 5); ctx.lineTo(x + px, y + 5);
    ctx.stroke();
    ctx.fillStyle = t.scaleBar;
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${feet} ft`, x, y - 8);
  }

  /** PNG snapshot for the report / estimate package. */
  toPng() {
    return this.canvas.toDataURL('image/png');
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function wetnessColor(status) {
  if (status.state === 'dry') return '#2f9e6e';
  if (status.goal == null || status.value == null) return '#5b8def';
  // Ramp from goal (green) to 2.5x goal or +25 points (deep red).
  const span = Math.max(6, status.goal * 1.5);
  const over = Math.max(0, status.value - status.goal);
  const ratio = Math.min(1, over / span);
  if (ratio < 0.34) return '#e8b53a';
  if (ratio < 0.67) return '#e07b34';
  return '#d1443f';
}

function readTheme() {
  const dark = matchMedia?.('(prefers-color-scheme: dark)')?.matches
    && document.documentElement.dataset.theme !== 'light';
  return dark ? DARK_THEME : LIGHT_THEME;
}

const LIGHT_THEME = {
  canvasBg: '#f7f8fa',
  gridMinor: '#e8ebf0',
  gridMajor: '#d6dbe4',
  roomFill: 'rgba(91,141,239,0.06)',
  roomFillActive: 'rgba(91,141,239,0.12)',
  roomStroke: '#98a2b3',
  roomStrokeActive: '#2f6fed',
  vertexFill: '#ffffff',
  roomLabel: '#1f2a37',
  roomLabelDim: '#6b7480',
  dimBg: 'rgba(255,255,255,0.92)',
  dimText: '#374151',
  door: '#8b6f47',
  window: '#4a9ec4',
  flow: '#2f9e6e',
  draft: '#2f6fed',
  draftClose: '#d1443f',
  pointEmpty: '#98a2b3',
  pointRing: '#ffffff',
  stalled: '#d1443f',
  scaleBar: '#6b7480',
  equipmentRing: '#ffffff',
  equipmentDefault: '#6b7480',
  equipment: {
    airMover: '#2f6fed', dehuLgr: '#7a4fd6', dehuConventional: '#9b7ae0',
    dehuDesiccant: '#5b3fa8', airScrubber: '#0f9c8f', heater: '#e07b34', injectidry: '#c2568f',
  },
};

const DARK_THEME = {
  ...LIGHT_THEME,
  canvasBg: '#12161c',
  gridMinor: '#1c222b',
  gridMajor: '#2a323d',
  roomFill: 'rgba(91,141,239,0.08)',
  roomFillActive: 'rgba(91,141,239,0.16)',
  roomStroke: '#4a5563',
  roomStrokeActive: '#6ba0ff',
  vertexFill: '#12161c',
  roomLabel: '#e8ecf2',
  roomLabelDim: '#93a0b0',
  dimBg: 'rgba(18,22,28,0.9)',
  dimText: '#c7d0da',
  pointRing: '#12161c',
  equipmentRing: '#12161c',
  scaleBar: '#93a0b0',
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 12.5 ft reads as 12' 6" on a sketch, which is how techs call it out. */
export function formatFeetInches(feet) {
  const totalInches = Math.round(feet * 12);
  const ft = Math.floor(totalInches / 12);
  const inch = totalInches % 12;
  return inch === 0 ? `${ft}'` : `${ft}' ${inch}"`;
}

export function parseFeetInches(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  // 12' 6", 12'6, 12-6, 12.5, 12 6
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)?\s*(?:[-\s]\s*)?(\d+(?:\.\d+)?)?\s*(?:"|in|inches)?$/i);
  if (!m) return null;
  const ft = Number(m[1]);
  const inch = m[2] != null ? Number(m[2]) : 0;
  if (!Number.isFinite(ft)) return null;
  // A bare decimal like "12.5" is feet, not feet-and-inches.
  if (m[2] == null) return ft;
  return ft + inch / 12;
}

function niceNumber(v) {
  const pow = 10 ** Math.floor(Math.log10(Math.max(1e-6, v)));
  const n = v / pow;
  const nice = n >= 5 ? 5 : n >= 2 ? 2 : 1;
  return Math.max(1, nice * pow);
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function norm(v) {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}
