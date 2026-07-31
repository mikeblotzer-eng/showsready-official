/** Floor plan: sketch rooms, then lay the moisture map, equipment and airflow on top. */

import * as store from '../store.js';
import {
  esc, onAct, formSheet, toast, sheet, confirmDialog, download,
} from '../ui.js';
import { PlanCanvas, MODES, rectanglePoints, setEdgeLength, recalcRoom, EQUIPMENT_GLYPH } from '../sketch.js';
import { parseFeet, formatFeet, uid, num, round, nowIso } from '../util.js';
import { MATERIAL_DEFAULTS, LOW_EVAPORATION_MATERIALS } from '../iicrc.js';
import { totals } from '../jobcalc.js';

const FLOORING = [
  { value: 'carpet', label: 'Carpet & pad' },
  { value: 'carpet_glue', label: 'Glue-down carpet' },
  { value: 'hardwood', label: 'Hardwood' },
  { value: 'laminate', label: 'Laminate' },
  { value: 'lvt', label: 'Vinyl plank / LVT' },
  { value: 'tile', label: 'Tile' },
  { value: 'concrete', label: 'Bare concrete' },
  { value: 'other', label: 'Other' },
];

const HINTS = {
  [MODES.SELECT]: 'Tap a room to edit it, a wall to retype its length. Drag to pan, pinch to zoom.',
  [MODES.DRAW]: 'Tap each corner. Walls snap square. Tap the first corner to close the room.',
  [MODES.MOISTURE]: 'Tap where you took the reading to drop a monitoring point.',
  [MODES.EQUIPMENT]: 'Tap to place equipment. Long-press a unit to set its direction or remove it.',
  [MODES.AIRFLOW]: 'Drag to draw an airflow arrow showing how the chamber is set.',
  [MODES.PIN]: 'Tap to drop a note or photo pin.',
};

export async function render(ctx) {
  const job = ctx.job;
  const levels = job.levels?.length ? job.levels : [{ id: 'lvl_default', name: 'Main level', order: 0 }];
  let levelId = sessionStorage.getItem(`level:${job.id}`) || levels[0].id;
  if (!levels.some((l) => l.id === levelId)) levelId = levels[0].id;

  const t = totals(job);

  const html = `
    <div class="plan-wrap">
      <canvas id="plan-canvas"></canvas>

      <div class="plan-toolbar">
        <button class="tool-btn" data-act="mode" data-mode="select">✋ Select</button>
        <button class="tool-btn" data-act="mode" data-mode="draw">✏️ Trace</button>
        <button class="tool-btn" data-act="rect">▭ Room by size</button>
        <button class="tool-btn" data-act="mode" data-mode="moisture">💧 Point</button>
        <button class="tool-btn" data-act="mode" data-mode="equipment">🌀 Equipment</button>
        <button class="tool-btn" data-act="mode" data-mode="airflow">➡️ Airflow</button>
        <button class="tool-btn" data-act="mode" data-mode="pin">📍 Pin</button>
      </div>

      <div class="zoom-stack">
        <button class="zoom-btn" data-act="zoomin" aria-label="Zoom in">+</button>
        <button class="zoom-btn" data-act="zoomout" aria-label="Zoom out">−</button>
        <button class="zoom-btn" data-act="fit" aria-label="Fit to screen">⤢</button>
      </div>

      <div class="plan-bottom">
        <div class="plan-hint" id="plan-hint">${esc(HINTS[MODES.SELECT])}</div>
        <div id="draw-actions" class="btn-row" hidden style="flex:0 0 auto">
          <button class="btn btn-sm" data-act="undo">Undo</button>
          <button class="btn btn-sm btn-primary" data-act="close-room">Close room</button>
        </div>
      </div>
    </div>

    <div style="padding:14px">
      <div class="row wrap mb">
        <select id="level-select" style="max-width:200px">
          ${levels.map((l) => `<option value="${esc(l.id)}" ${l.id === levelId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" data-act="add-level">+ Level</button>
        <span class="right chip">${t.rooms} rooms · ${Math.round(t.floorSqft)} ft²</span>
      </div>

      <div class="layer-toggles mb">
        ${[['moisture', 'Moisture'], ['equipment', 'Equipment'], ['airflow', 'Airflow'],
           ['dimensions', 'Dimensions'], ['pins', 'Pins'], ['grid', 'Grid']]
          .map(([k, label]) => `<button class="layer-toggle on" data-act="layer" data-layer="${k}">${label}</button>`).join('')}
      </div>

      <div class="btn-row">
        <button class="btn btn-sm" data-act="export-png">Export plan PNG</button>
        <button class="btn btn-sm" data-act="room-list">Room details</button>
      </div>

      <div class="note-block">
        Sketch dimensions drive the class calculation, the equipment count and the estimate quantities.
        Measure with a tape or laser and retype any wall that is off — tap the wall to set its exact length.
      </div>
    </div>`;

  return {
    title: 'Floor plan',
    subtitle: job.client?.name,
    fullBleed: true,
    back: `#/job/${job.id}`,
    html,
    mount: (root) => mount(root, ctx, levelId),
  };
}

/* ------------------------------------------------------------------ */

function mount(root, ctx, levelId) {
  const job = ctx.job;
  const canvasEl = root.querySelector('#plan-canvas');
  const wrapEl = root.querySelector('.plan-wrap');
  const hintEl = root.querySelector('#plan-hint');
  const drawActions = root.querySelector('#draw-actions');

  // The top bar grows when a job has a two-line title, so measure rather than
  // guess — a mis-sized canvas either clips the plan or leaves dead space.
  const sizeWrap = () => {
    const top = document.getElementById('topbar')?.getBoundingClientRect().height ?? 56;
    const nav = document.getElementById('nav')?.getBoundingClientRect().height ?? 60;
    wrapEl.style.height = `${Math.max(300, window.innerHeight - top - nav)}px`;
  };
  sizeWrap();
  window.addEventListener('resize', sizeWrap);

  const persist = async () => { await store.saveJob(job); };

  const plan = new PlanCanvas(canvasEl, {
    onModeChange: (mode) => {
      hintEl.textContent = HINTS[mode] || '';
      drawActions.hidden = mode !== MODES.DRAW;
      root.querySelectorAll('[data-act="mode"]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    },
    onRoomDrawn: async (points) => {
      const room = store.newRoom(levelId, { points, name: `Room ${(job.rooms?.length || 0) + 1}` });
      recalcRoom(room);
      job.rooms.push(room);
      await persist();
      plan.setData({ rooms: job.rooms });
      plan.selection = { type: 'room', id: room.id };
      plan.render();
      await roomSheet(ctx, plan, room, persist);
    },
    onSelect: async (hit) => {
      if (!hit) return;
      if (hit.type === 'room') await roomSheet(ctx, plan, hit.item, persist);
      else if (hit.type === 'wall') await wallSheet(ctx, plan, hit.item, hit.edgeIndex, persist);
      else if (hit.type === 'moisture') await pointSheet(ctx, plan, hit.item, persist);
      else if (hit.type === 'equipment') await equipmentSheet(ctx, plan, hit.item, persist);
      else if (hit.type === 'pin') await pinSheet(ctx, plan, hit.item, persist);
    },
    onLongPress: async (hit) => {
      if (hit.type === 'arrow') {
        if (await confirmDialog('Remove this airflow arrow?', { confirmLabel: 'Remove', danger: true })) {
          job.arrows = (job.arrows || []).filter((a) => a.id !== hit.id);
          await persist();
          plan.setData({ arrows: job.arrows });
        }
        return;
      }
      await deleteSheet(ctx, plan, hit, persist);
    },
    onPlaceMoisture: async (pos) => {
      const point = {
        id: uid('pt'), levelId, roomId: pos.roomId, x: pos.x, y: pos.y,
        label: `P${(job.monitoringPoints?.length || 0) + 1}`,
        material: 'drywall', dryStandard: null, createdAt: nowIso(),
      };
      job.monitoringPoints.push(point);
      await persist();
      plan.setData({ monitoringPoints: job.monitoringPoints });
      plan.invalidateHeat();
      await pointSheet(ctx, plan, point, persist, { isNew: true });
    },
    onPlaceEquipment: async (pos) => {
      const entry = {
        id: uid('eq'), levelId, roomId: pos.roomId, type: pos.type, subtype: pos.type === 'dehumidifier' ? (job.dehuType || 'lgr') : null,
        count: 1, angle: 0, x: pos.x, y: pos.y, placedAt: nowIso(), removedAt: null,
        capacityPpd: pos.type === 'dehumidifier' ? job.dehuCapacityPpd : null,
      };
      job.equipment.push(entry);
      await persist();
      plan.setData({ equipment: job.equipment });
      await equipmentSheet(ctx, plan, entry, persist, { isNew: true });
    },
    onPlacePin: async (pos) => {
      const pin = { id: uid('pin'), levelId, roomId: pos.roomId, x: pos.x, y: pos.y, kind: 'note', text: '' };
      job.pins = job.pins || [];
      job.pins.push(pin);
      await persist();
      plan.setData({ pins: job.pins });
      await pinSheet(ctx, plan, pin, persist, { isNew: true });
    },
    onChange: async (key, value) => {
      job[key] = value;
      await persist();
    },
    onEdit: async () => { await persist(); plan.invalidateHeat(); },
  });

  job.arrows = job.arrows || [];
  job.pins = job.pins || [];
  plan.setData({
    rooms: job.rooms, monitoringPoints: job.monitoringPoints, readings: job.readings,
    equipment: job.equipment, arrows: job.arrows, pins: job.pins, levelId,
  });
  plan.setMode(MODES.SELECT);
  requestAnimationFrame(() => { plan.resize(); plan.fit(); });

  root.querySelector('#level-select')?.addEventListener('change', (e) => {
    levelId = e.target.value;
    sessionStorage.setItem(`level:${job.id}`, levelId);
    plan.setData({ levelId });
    plan.fit();
  });

  onAct(root, {
    mode: (el) => {
      if (el.dataset.mode === MODES.DRAW) plan.startDraw();
      else plan.setMode(el.dataset.mode);
    },
    rect: () => quickRectangle(ctx, plan, levelId, persist),
    undo: () => plan.undoDraftPoint(),
    'close-room': () => plan.finishDraw(),
    zoomin: () => plan.zoomBy(1.25),
    zoomout: () => plan.zoomBy(1 / 1.25),
    fit: () => plan.fit(),
    layer: (el) => {
      const on = !el.classList.contains('on');
      el.classList.toggle('on', on);
      plan.setLayers({ [el.dataset.layer]: on });
    },
    'add-level': () => addLevel(ctx),
    'export-png': () => {
      const url = plan.exportPng();
      if (!url) return toast('Sketch a room first.', 'error');
      fetch(url).then((r) => r.blob()).then((blob) => {
        download(`${(job.client?.name || 'plan').replace(/[^\w-]+/g, '_')}_plan.png`, blob, 'image/png');
        toast('Plan exported.', 'success');
      });
    },
    'room-list': () => roomListSheet(ctx, plan, persist),
  });

  return () => {
    window.removeEventListener('resize', sizeWrap);
    plan.destroy();
  };
}

/* ------------------------------------------------------------------ */
/* Sheets                                                              */
/* ------------------------------------------------------------------ */

async function quickRectangle(ctx, plan, levelId, persist) {
  const values = await formSheet({
    title: 'Room by size',
    intro: 'Fastest way in for a square room. Type feet and inches however you like — 12\'6", 12-6 and 12.5 all work.',
    submitLabel: 'Add room',
    fields: [
      { name: 'name', label: 'Room name', type: 'text', full: true, value: `Room ${(ctx.job.rooms?.length || 0) + 1}` },
      { name: 'width', label: 'Width', type: 'dimension', placeholder: `12'6"`, required: true },
      { name: 'length', label: 'Length', type: 'dimension', placeholder: `20'`, required: true },
      { name: 'ceiling', label: 'Ceiling height', type: 'dimension', value: '8' },
    ],
  });
  if (!values) return;

  const w = parseFeet(values.width), l = parseFeet(values.length);
  if (!w || !l) return toast('Could not read those dimensions.', 'error');

  // Drop the new room to the right of whatever is already on this level.
  const existing = (ctx.job.rooms || []).filter((r) => r.levelId === levelId);
  const offsetX = existing.reduce((max, r) => Math.max(max, ...(r.points || []).map((p) => p.x)), 0);
  const origin = { x: existing.length ? offsetX + 3 : 0, y: 0 };

  const room = store.newRoom(levelId, {
    name: values.name || 'Room',
    points: rectanglePoints(w, l, origin),
    ceilingHeightFt: parseFeet(values.ceiling) || 8,
  });
  recalcRoom(room);
  ctx.job.rooms.push(room);
  await persist();
  plan.setData({ rooms: ctx.job.rooms });
  plan.fit();
  await roomSheet(ctx, plan, room, persist);
}

async function roomSheet(ctx, plan, room, persist) {
  const values = await formSheet({
    title: room.name || 'Room',
    intro: `${Math.round(room.floorAreaSqft)} ft² floor · ${formatFeet(room.perimeterFt)} perimeter · ${room.insideCorners} inside corner(s)`,
    fields: [
      { name: 'name', label: 'Room name', type: 'text', full: true, value: room.name },
      { name: 'ceilingHeightFt', label: 'Ceiling height', type: 'dimension', value: String(room.ceilingHeightFt) },
      { name: 'flooring', label: 'Flooring', type: 'select', options: FLOORING, value: room.flooring },
      { name: 'affectedFloorSqft', label: 'Wet floor (ft²)', type: 'number', value: room.affectedFloorSqft,
        hint: `Room is ${Math.round(room.floorAreaSqft)} ft² total — defaults to all of it. Reduce it if only part got wet.` },
      { name: 'affectedWallLf', label: 'Wet wall (linear ft)', type: 'number', value: room.affectedWallLf,
        hint: `Perimeter is ${Math.round(room.perimeterFt)} ft. Reduce it to the walls that actually wicked.` },
      { name: 'wetWallHeightFt', label: 'Height of wetness', type: 'dimension', value: String(room.wetWallHeightFt),
        hint: 'How far the water wicked up the wall.' },
      { name: 'standingWater', label: 'Standing water on arrival', type: 'checkbox', full: true, value: room.standingWater },
      { name: 'ceilingAffected', label: 'Ceiling affected', type: 'checkbox', full: true, value: room.ceilingAffected },
      { name: 'affectedCeilingSqft', label: 'Wet ceiling (ft²)', type: 'number', value: room.affectedCeilingSqft },
      { name: 'floodCutHeightFt', label: 'Flood cut height (ft)', type: 'number', value: room.floodCutHeightFt,
        hint: '0 if no drywall was removed.' },
      { name: 'insulationRemovedSqft', label: 'Insulation removed (ft²)', type: 'number', value: room.insulationRemovedSqft },
      { name: 'containmentSqft', label: 'Containment (ft²)', type: 'number', value: room.containmentSqft },
      { name: 'contentsManipulated', label: 'Contents moved and blocked', type: 'checkbox', full: true, value: room.contentsManipulated },
      { name: 'ceilingRemoved', label: 'Ceiling drywall removed', type: 'checkbox', full: true, value: room.ceilingRemoved },
      ...LOW_EVAPORATION_MATERIALS.map((m) => ({
        name: `mat_${m.id}`, label: `${m.label} present`, type: 'checkbox', full: true,
        value: (room.lowEvaporationMaterials || []).includes(m.id),
      })),
    ],
    extraActions: [{
      label: 'Delete room',
      onClick: async ({ close }) => {
        if (await confirmDialog(`Delete ${room.name}? Monitoring points and equipment inside it stay on the plan.`, { confirmLabel: 'Delete', danger: true })) {
          ctx.job.rooms = ctx.job.rooms.filter((r) => r.id !== room.id);
          await persist();
          plan.setData({ rooms: ctx.job.rooms });
          plan.invalidateHeat();
          close(null);
        }
        return false;
      },
    }],
  });
  if (!values) return;

  room.name = values.name || room.name;
  room.ceilingHeightFt = parseFeet(values.ceilingHeightFt) || 8;
  room.flooring = values.flooring;
  room.affectedFloorSqft = Math.min(num(values.affectedFloorSqft, 0), room.floorAreaSqft);
  room.affectedWallLf = Math.min(num(values.affectedWallLf, 0), room.perimeterFt);
  room.wetWallHeightFt = parseFeet(values.wetWallHeightFt) || 2;
  room.standingWater = values.standingWater;
  room.ceilingAffected = values.ceilingAffected;
  room.affectedCeilingSqft = values.ceilingAffected ? (num(values.affectedCeilingSqft) || room.floorAreaSqft) : 0;
  room.floodCutHeightFt = num(values.floodCutHeightFt, 0);
  room.insulationRemovedSqft = num(values.insulationRemovedSqft, 0);
  room.containmentSqft = num(values.containmentSqft, 0);
  room.contentsManipulated = values.contentsManipulated;
  room.ceilingRemoved = values.ceilingRemoved;
  room.lowEvaporationMaterials = LOW_EVAPORATION_MATERIALS.filter((m) => values[`mat_${m.id}`]).map((m) => m.id);

  await persist();
  plan.setData({ rooms: ctx.job.rooms });
  toast('Room saved.', 'success');
}

async function wallSheet(ctx, plan, room, edgeIndex, persist) {
  const pts = room.points;
  const a = pts[edgeIndex], b = pts[(edgeIndex + 1) % pts.length];
  const current = Math.hypot(b.x - a.x, b.y - a.y);

  const values = await formSheet({
    title: 'Wall length',
    intro: `Currently ${formatFeet(current)}. Retyping it moves the rest of the outline and keeps the other walls square.`,
    submitLabel: 'Set length',
    fields: [{ name: 'length', label: 'Measured length', type: 'dimension', full: true, value: formatFeet(current), placeholder: `12'6"` }],
  });
  if (!values) return;
  const feet = parseFeet(values.length);
  if (!feet || feet <= 0) return toast('Could not read that length.', 'error');

  room.points = setEdgeLength(room.points, edgeIndex, feet);
  recalcRoom(room);
  await persist();
  plan.setData({ rooms: ctx.job.rooms });
  plan.invalidateHeat();
  toast(`Wall set to ${formatFeet(feet)}.`, 'success');
}

async function pointSheet(ctx, plan, point, persist, { isNew = false } = {}) {
  const material = MATERIAL_DEFAULTS.find((m) => m.id === point.material);
  const values = await formSheet({
    title: isNew ? 'New monitoring point' : point.label || 'Monitoring point',
    intro: 'The dry standard is a reading from the same material in an unaffected area. Leave it blank to use the table default.',
    fields: [
      { name: 'label', label: 'Label', type: 'text', value: point.label },
      { name: 'material', label: 'Material', type: 'select', value: point.material,
        options: MATERIAL_DEFAULTS.map((m) => ({ value: m.id, label: m.label })) },
      { name: 'dryStandard', label: 'Dry standard', type: 'number', value: point.dryStandard,
        hint: material ? `Table default ${material.dryStandard} ${material.unit}` : '' },
      { name: 'heightIn', label: 'Height off floor (in)', type: 'number', value: point.heightIn },
      { name: 'note', label: 'Note', type: 'text', full: true, value: point.note },
      { name: 'reading', label: 'Reading now', type: 'number', full: true, value: '',
        hint: 'Optional — records a reading at this point right away.' },
    ],
    extraActions: [{
      label: 'Delete',
      onClick: async ({ close }) => {
        ctx.job.monitoringPoints = ctx.job.monitoringPoints.filter((p) => p.id !== point.id);
        ctx.job.readings = ctx.job.readings.filter((r) => r.pointId !== point.id);
        await persist();
        plan.setData({ monitoringPoints: ctx.job.monitoringPoints, readings: ctx.job.readings });
        plan.invalidateHeat();
        close(null);
        return false;
      },
    }],
  });
  if (!values) return;

  Object.assign(point, {
    label: values.label || point.label,
    material: values.material,
    dryStandard: values.dryStandard,
    heightIn: values.heightIn,
    note: values.note,
  });
  if (values.reading != null && values.reading !== '') {
    ctx.job.readings.push({
      id: uid('rd'), pointId: point.id, at: nowIso(),
      reading: num(values.reading), method: MATERIAL_DEFAULTS.find((m) => m.id === values.material)?.meter || 'pin',
      by: ctx.settings.techName || '',
    });
  }
  await persist();
  plan.setData({ monitoringPoints: ctx.job.monitoringPoints, readings: ctx.job.readings });
  plan.invalidateHeat();
}

async function equipmentSheet(ctx, plan, entry, persist, { isNew = false } = {}) {
  const values = await formSheet({
    title: isNew ? 'Place equipment' : EQUIPMENT_GLYPH[entry.type]?.label || 'Equipment',
    fields: [
      { name: 'type', label: 'Type', type: 'select', full: true, value: entry.type,
        options: Object.entries(EQUIPMENT_GLYPH).map(([value, g]) => ({ value, label: g.label })) },
      { name: 'count', label: 'Quantity here', type: 'number', value: entry.count, min: 1 },
      { name: 'angle', label: 'Direction (°)', type: 'number', value: entry.angle,
        hint: '0 points right, 90 down. Air movers only.' },
      { name: 'subtype', label: 'Dehumidifier type', type: 'select', value: entry.subtype || 'lgr',
        options: [{ value: 'conventional', label: 'Conventional' }, { value: 'lgr', label: 'LGR' }, { value: 'desiccant', label: 'Desiccant' }] },
      { name: 'capacityPpd', label: 'Capacity (AHAM ppd)', type: 'number', value: entry.capacityPpd },
      { name: 'serial', label: 'Asset / serial', type: 'text', value: entry.serial },
      { name: 'removed', label: 'Picked up', type: 'checkbox', full: true, value: !!entry.removedAt,
        hint: 'Stops the billable day count for this unit.' },
    ],
    extraActions: [{
      label: 'Delete',
      onClick: async ({ close }) => {
        ctx.job.equipment = ctx.job.equipment.filter((e) => e.id !== entry.id);
        await persist();
        plan.setData({ equipment: ctx.job.equipment });
        close(null);
        return false;
      },
    }],
  });
  if (!values) return;

  Object.assign(entry, {
    type: values.type,
    count: Math.max(1, num(values.count, 1)),
    angle: num(values.angle, 0),
    subtype: values.type === 'dehumidifier' ? values.subtype : null,
    capacityPpd: values.capacityPpd,
    serial: values.serial,
    removedAt: values.removed ? (entry.removedAt || nowIso()) : null,
  });
  await persist();
  plan.setData({ equipment: ctx.job.equipment });
}

async function pinSheet(ctx, plan, pin, persist, { isNew = false } = {}) {
  const values = await formSheet({
    title: isNew ? 'Drop a pin' : 'Pin',
    fields: [
      { name: 'kind', label: 'Type', type: 'segmented', full: true, value: pin.kind,
        options: [{ value: 'note', label: 'Note' }, { value: 'photo', label: 'Photo' }] },
      { name: 'text', label: 'Note', type: 'textarea', full: true, value: pin.text },
    ],
    extraActions: [{
      label: 'Delete',
      onClick: async ({ close }) => {
        ctx.job.pins = ctx.job.pins.filter((p) => p.id !== pin.id);
        await persist();
        plan.setData({ pins: ctx.job.pins });
        close(null);
        return false;
      },
    }],
  });
  if (!values) return;

  pin.kind = values.kind;
  pin.text = values.text;

  if (values.kind === 'photo' && !pin.photoId) {
    const { pickPhoto } = await import('../ui.js');
    const file = await pickPhoto();
    if (file) {
      const blob = await store.compressImage(file);
      const rec = await store.savePhoto({ jobId: ctx.job.id, blob, caption: values.text, roomId: pin.roomId, kind: 'plan_pin' });
      pin.photoId = rec.id;
    }
  }
  await persist();
  plan.setData({ pins: ctx.job.pins });
}

async function deleteSheet(ctx, plan, hit, persist) {
  const labels = { room: 'room', moisture: 'monitoring point', equipment: 'equipment', pin: 'pin' };
  const ok = await confirmDialog(`Remove this ${labels[hit.type] || 'item'} from the plan?`, { confirmLabel: 'Remove', danger: true });
  if (!ok) return;

  const job = ctx.job;
  if (hit.type === 'room') job.rooms = job.rooms.filter((r) => r.id !== hit.id);
  if (hit.type === 'moisture') {
    job.monitoringPoints = job.monitoringPoints.filter((p) => p.id !== hit.id);
    job.readings = job.readings.filter((r) => r.pointId !== hit.id);
  }
  if (hit.type === 'equipment') job.equipment = job.equipment.filter((e) => e.id !== hit.id);
  if (hit.type === 'pin') job.pins = job.pins.filter((p) => p.id !== hit.id);

  await persist();
  plan.setData({ rooms: job.rooms, monitoringPoints: job.monitoringPoints, readings: job.readings, equipment: job.equipment, pins: job.pins });
  plan.invalidateHeat();
}

async function addLevel(ctx) {
  const values = await formSheet({
    title: 'Add a level',
    fields: [{ name: 'name', label: 'Level name', type: 'text', full: true, placeholder: 'Basement' }],
  });
  if (!values?.name) return;
  await ctx.save((j) => { j.levels.push({ id: uid('lvl'), name: values.name, order: j.levels.length }); });
  ctx.refresh();
}

async function roomListSheet(ctx, plan, persist) {
  const rooms = ctx.job.rooms || [];
  await sheet({
    title: 'Room details',
    size: 'full',
    body: rooms.length ? `
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Room</th><th class="num">Floor</th><th class="num">Wet floor</th><th class="num">Wet wall</th><th class="num">Volume</th></tr></thead>
        <tbody>${rooms.map((r) => `
          <tr>
            <td><strong>${esc(r.name)}</strong><br><span class="tiny muted">${esc(FLOORING.find((f) => f.value === r.flooring)?.label || '')}</span></td>
            <td class="num">${Math.round(r.floorAreaSqft)} ft²</td>
            <td class="num">${Math.round(r.affectedFloorSqft)} ft²</td>
            <td class="num">${Math.round(r.affectedWallLf)} lf</td>
            <td class="num">${Math.round(r.floorAreaSqft * r.ceilingHeightFt)} ft³</td>
          </tr>`).join('')}</tbody>
        <tfoot><tr>
          <th>Total</th>
          <th class="num">${Math.round(rooms.reduce((n, r) => n + r.floorAreaSqft, 0))} ft²</th>
          <th class="num">${Math.round(rooms.reduce((n, r) => n + r.affectedFloorSqft, 0))} ft²</th>
          <th class="num">${Math.round(rooms.reduce((n, r) => n + r.affectedWallLf, 0))} lf</th>
          <th class="num">${Math.round(rooms.reduce((n, r) => n + r.floorAreaSqft * r.ceilingHeightFt, 0))} ft³</th>
        </tr></tfoot>
      </table></div>` : '<p class="muted small">No rooms yet.</p>',
    actions: [{ label: 'Done', variant: 'primary', value: true }],
  });
}
