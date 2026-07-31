/* Floor plan view: sketch rooms, then layer moisture points, airflow and
 * equipment on top of the same geometry. */

import { el, sheet, field, toast, confirmDialog, uid, num, round, download } from '../util.js';
import * as store from '../store.js';
import { Sketch, TOOLS, parseFeetInches, formatFeetInches } from '../sketch.js';
import { polygonArea, polygonPerimeter, layoutAirMovers, polygonCentroid } from '../geom.js';
import { pointStatus, MATERIALS } from '../iicrc.js';
import { wire, slug } from './jobs.js';

const TOOL_BUTTONS = [
  { id: TOOLS.SELECT,    icon: '✥', label: 'Move' },
  { id: TOOLS.ROOM,      icon: '▢', label: 'Room' },
  { id: TOOLS.MOISTURE,  icon: '◈', label: 'Reading' },
  { id: TOOLS.EQUIPMENT, icon: '➤', label: 'Equip' },
  { id: TOOLS.FLOW,      icon: '⇢', label: 'Airflow' },
  { id: TOOLS.OPENING,   icon: '▭', label: 'Door' },
];

export default function renderPlan(view, { go }) {
  const job = store.state.job;
  if (!job) return go('jobs');

  const statusBar = el('div', { class: 'sketch-status' });
  const canvas = el('canvas', { id: 'plan-canvas' });
  const wrap = el('div', { class: 'sketch-wrap' }, canvas, statusBar);

  const toolbar = el('div', { class: 'toolbar' });
  const layerBar = el('div', { class: 'layer-bar' });
  const roomTabs = el('div', { class: 'room-tabs' });
  const summary = el('div', { style: 'padding:12px 14px 0' });

  view.append(roomTabs, toolbar, layerBar, wrap, summary);

  const sketch = new Sketch(canvas, {
    onChange: (reason) => {
      if (reason === 'draft') {
        // Placing the first corner is what makes Finish/Undo available.
        refreshActions();
        return;
      }
      store.update(() => {}, { silent: true });
      if (reason === 'commit') refreshSummary();
    },
    onSelect: handleSelect,
    onStatus: (msg) => { statusBar.textContent = msg; },
    pointStatusFor: (p) => pointStatus(p, p.readings || []),
  });

  /* Sketch actions float over the canvas so they follow the thumb. */
  const actions = el('div', { class: 'sketch-actions' });
  wrap.append(actions);

  function refreshActions() {
    actions.innerHTML = '';
    if (sketch.tool === TOOLS.ROOM) {
      if (sketch.draft?.poly?.length) {
        actions.append(
          el('button', { class: 'btn btn-primary btn-sm', onClick: () => sketch.finishRoom() }, 'Finish room'),
          el('button', { class: 'btn btn-sm', onClick: () => { sketch.undoDraftPoint(); refreshActions(); } }, 'Undo point'),
          el('button', { class: 'btn btn-ghost btn-sm', onClick: () => { sketch.cancelRoom(); refreshActions(); } }, 'Cancel'),
        );
      } else {
        actions.append(el('button', { class: 'btn btn-sm', onClick: () => rectangleSheet(sketch, refreshAll) }, '▢ Type dimensions'));
      }
    } else {
      actions.append(el('button', { class: 'btn btn-sm', onClick: () => sketch.zoomToFit() }, '⤢ Fit'));
    }
  }

  function refreshTools() {
    toolbar.innerHTML = '';
    for (const t of TOOL_BUTTONS) {
      toolbar.append(el('button', {
        class: `tool${sketch.tool === t.id ? ' on' : ''}`,
        onClick: () => {
          sketch.setTool(t.id);
          if (t.id === TOOLS.EQUIPMENT) equipmentPickerSheet(sketch);
          refreshTools();
          refreshActions();
        },
      }, el('span', { class: 'tool-ico', text: t.icon }), t.label));
    }
  }

  function refreshLayers() {
    layerBar.innerHTML = '';
    const layers = [
      ['moisture', 'Moisture'], ['equipment', 'Equipment'], ['flow', 'Airflow'],
      ['dimensions', 'Dimensions'], ['grid', 'Grid'],
    ];
    for (const [key, label] of layers) {
      layerBar.append(el('button', {
        class: `layer-toggle${sketch.layers[key] ? ' on' : ''}`,
        onClick: (e) => { sketch.setLayer(key, !sketch.layers[key]); e.target.classList.toggle('on', sketch.layers[key]); },
      }, label));
    }
  }

  function refreshRoomTabs() {
    roomTabs.innerHTML = '';
    for (const room of job.rooms) {
      roomTabs.append(el('button', {
        class: `room-tab${room.id === store.state.activeRoomId ? ' on' : ''}`,
        onClick: () => {
          if (room.id === store.state.activeRoomId) { roomSheet(room, refreshAll); return; }
          store.state.activeRoomId = room.id;
          refreshAll();
        },
      }, room.name));
    }
    roomTabs.append(el('button', {
      class: 'room-tab',
      onClick: () => addRoomSheet(sketch, refreshAll),
    }, '+ Room'));
  }

  function refreshSummary() {
    summary.innerHTML = '';
    const room = store.activeRoom();
    if (!room) {
      summary.append(el('div', { class: 'note', html: 'Tap <strong>Room</strong>, then tap each corner of the affected room. Walls snap square as you go, and every wall is labelled with its length.' }));
      return;
    }
    const m = store.roomMetrics(room);
    const cls = store.classification(job);
    summary.append(
      el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h2', { text: room.name }),
          el('button', { class: 'btn btn-ghost btn-sm', onClick: () => roomSheet(room, refreshAll) }, 'Edit'),
        ),
        el('div', { class: 'stats' },
          st(Math.round(m.floor).toLocaleString(), 'Floor SF'),
          st(Math.round(m.perimeter).toLocaleString(), 'Perim LF'),
          st(Math.round(m.volume).toLocaleString(), 'Cu FT'),
          st(Math.round(m.wetFloorArea).toLocaleString(), 'Wet SF'),
        ),
        el('div', { class: 'card-body tight' },
          el('div', { class: 'row wrap', style: 'gap:6px' },
            el('span', { class: 'chip', text: `${(room.points || []).length} reading pts` }),
            el('span', { class: 'chip', text: `${(room.equipment || []).filter((e) => !e.removedAt).length} equipment` }),
            el('span', { class: 'chip', text: `${m.extraCorners} offset${m.extraCorners === 1 ? '' : 's'}/alcoves` }),
            el('span', { class: 'chip chip-blue', text: `Class ${cls.class}` }),
          ),
        ),
      ),
      el('div', { class: 'spacer' }),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-ghost btn-sm', onClick: () => autoPlaceSheet(room, refreshAll) }, '⚡ Auto-place air movers'),
        el('button', { class: 'btn btn-ghost btn-sm', onClick: () => exportPlanPng(sketch, job) }, '⤓ Export plan'),
      ),
      el('div', { class: 'spacer' }),
    );
  }

  function refreshAll() {
    sketch.setRooms(job.rooms, store.state.activeRoomId);
    refreshTools();
    refreshLayers();
    refreshRoomTabs();
    refreshSummary();
    refreshActions();
    sketch.status();
  }

  function handleSelect(evt) {
    const job = store.state.job;
    switch (evt.type) {
      case 'room-complete': {
        const room = store.newRoom({ name: nextRoomName(job), poly: evt.poly });
        store.update((j) => { j.rooms.push(room); });
        store.state.activeRoomId = room.id;
        sketch.setTool(TOOLS.SELECT);
        refreshAll();
        roomSheet(room, refreshAll, { isNew: true });
        break;
      }
      case 'room-tap':
        store.state.activeRoomId = evt.roomId;
        refreshAll();
        break;
      case 'moisture':
        moisturePointSheet(evt, refreshAll);
        break;
      case 'equipment':
        placeEquipment(evt, refreshAll);
        break;
      case 'equipment-tap':
        equipmentSheet(evt, refreshAll);
        break;
      case 'point-tap':
        moisturePointSheet({ roomId: evt.roomId, id: evt.id }, refreshAll);
        break;
      case 'flow': {
        const room = store.activeRoom();
        if (!room) return;
        store.update((j) => {
          const r = j.rooms.find((x) => x.id === room.id);
          r.flow = r.flow || [];
          r.flow.push({ id: uid('flow'), from: evt.from, to: evt.to });
        });
        refreshAll();
        break;
      }
      case 'opening':
        openingSheet(evt, refreshAll);
        break;
    }
  }

  refreshAll();
  requestAnimationFrame(() => { sketch.resize(); sketch.zoomToFit(); });

  const onResize = () => sketch.resize();
  window.addEventListener('resize', onResize);
  const themeQuery = matchMedia('(prefers-color-scheme: dark)');
  const onTheme = () => { sketch.theme = undefined; sketch.draw(); };
  themeQuery.addEventListener?.('change', onTheme);

  // Cleanup handed back to the router.
  return () => {
    window.removeEventListener('resize', onResize);
    themeQuery.removeEventListener?.('change', onTheme);
  };
}

function st(value, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'stat-val', text: value }), el('div', { class: 'stat-lbl', text: label }));
}

function nextRoomName(job) {
  const common = ['Living Room', 'Kitchen', 'Hallway', 'Master Bedroom', 'Bathroom', 'Bedroom 2', 'Basement', 'Laundry'];
  const used = new Set(job.rooms.map((r) => r.name));
  return common.find((n) => !used.has(n)) || `Room ${job.rooms.length + 1}`;
}

/* ── Sheets ───────────────────────────────────────────────────────────────── */

function addRoomSheet(sketch, refresh) {
  const { body, close } = sheet('Add a room');
  body.append(
    el('p', { class: 'mute', style: 'margin-bottom:14px', text: 'Trace the room by tapping its corners, or type the dimensions if it is a simple rectangle.' }),
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: () => { close(); sketch.setTool(TOOLS.ROOM); refresh(); },
    }, '✎ Trace on the plan'),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn-block', onClick: () => { close(); rectangleSheet(sketch, refresh); } }, '▢ Type width × length'),
  );
}

function rectangleSheet(sketch, refresh) {
  const { body, close } = sheet('Rectangular room');
  const name = field('Room name', { value: nextRoomName(store.state.job) });
  const w = field('Width', { placeholder: `12' 6"`, inputmode: 'decimal', hint: `Feet, or feet and inches like 12' 6"` });
  const l = field('Length', { placeholder: `14'`, inputmode: 'decimal' });
  const h = field('Ceiling height', { value: 8, inputmode: 'decimal' });

  body.append(name.wrap, el('div', { class: 'grid-2' }, w.wrap, l.wrap), h.wrap,
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: () => {
        const width = parseFeetInches(w.input.value);
        const length = parseFeetInches(l.input.value);
        if (!width || !length || width <= 0 || length <= 0) {
          toast('Enter a width and length.', 'error');
          return;
        }
        const poly = sketch.draftRectangle(width, length);
        const room = store.newRoom({ name: name.input.value.trim() || 'Room', poly, ceilingHeight: num(h.input.value, 8) });
        store.update((j) => { j.rooms.push(room); });
        store.state.activeRoomId = room.id;
        close();
        refresh();
        sketch.zoomToFit();
      },
    }, 'Add room'),
  );
  setTimeout(() => w.input.focus(), 60);
}

function roomSheet(room, refresh, { isNew = false } = {}) {
  const { body, close } = sheet(isNew ? 'Room details' : `Edit ${room.name}`);
  const a = room.affected;
  const matOptions = MATERIALS.map((m) => ({ value: m.id, label: m.label }));

  const save = (patch) => store.update((j) => {
    const r = j.rooms.find((x) => x.id === room.id);
    if (!r) return;
    Object.assign(r, patch.room || {});
    Object.assign(r.affected, patch.affected || {});
  });

  const nameF = field('Room name', { value: room.name });
  const levelF = field('Level', { type: 'select', value: room.level, options: ['Basement', 'Main', 'Second', 'Third', 'Attic', 'Garage', 'Crawlspace'].map((v) => ({ value: v, label: v })) });
  const heightF = field('Ceiling height (ft)', { value: room.ceilingHeight, inputmode: 'decimal' });

  const floorPct = field('Floor affected %', { value: a.floorPct, inputmode: 'numeric', type: 'number', min: 0, max: 100 });
  const wallPct = field('Walls affected %', { value: a.wallPct, inputmode: 'numeric', type: 'number', min: 0, max: 100 });
  const ceilPct = field('Ceiling affected %', { value: a.ceilingPct, inputmode: 'numeric', type: 'number', min: 0, max: 100 });
  const wallHeight = field('Water height up the wall (ft)', { value: a.wallAffectedHeight, inputmode: 'decimal', hint: 'How far the moisture meter reads wet up the wall. Under 2 ft is typical of Class 2.' });
  const obstructions = field('Obstructions / offsets', { value: a.obstructions, type: 'number', inputmode: 'numeric', hint: 'Cabinets, islands, closets — each one gets its own air mover under S500.' });

  const floorMat = field('Floor material', { type: 'select', value: a.floorMaterial, options: matOptions });
  const wallMat = field('Wall material', { type: 'select', value: a.wallMaterial, options: matOptions });
  const ceilMat = field('Ceiling material', { type: 'select', value: a.ceilingMaterial, options: matOptions });

  const metricsBox = el('div', { class: 'stats' });
  const renderMetrics = () => {
    const m = store.roomMetrics(store.state.job.rooms.find((r) => r.id === room.id) || room);
    metricsBox.innerHTML = '';
    metricsBox.append(
      st(Math.round(m.floor).toLocaleString(), 'Floor SF'),
      st(Math.round(m.wetWallLf).toLocaleString(), 'Wet wall LF'),
      st(Math.round(m.volume).toLocaleString(), 'Cu FT'),
      st(Math.round(m.wetPorousArea).toLocaleString(), 'Wet porous SF'),
    );
  };

  const bindAll = [
    [nameF, (v) => save({ room: { name: v || 'Room' } })],
    [levelF, (v) => save({ room: { level: v } })],
    [heightF, (v) => save({ room: { ceilingHeight: num(v, 8) } })],
    [floorPct, (v) => save({ affected: { floorPct: clampPct(v) } })],
    [wallPct, (v) => save({ affected: { wallPct: clampPct(v) } })],
    [ceilPct, (v) => save({ affected: { ceilingPct: clampPct(v) } })],
    [wallHeight, (v) => save({ affected: { wallAffectedHeight: num(v, 0) } })],
    [obstructions, (v) => save({ affected: { obstructions: Math.max(0, num(v, 0)) } })],
    [floorMat, (v) => save({ affected: { floorMaterial: v } })],
    [wallMat, (v) => save({ affected: { wallMaterial: v } })],
    [ceilMat, (v) => save({ affected: { ceilingMaterial: v } })],
  ];
  for (const [f, fn] of bindAll) {
    const commit = () => { fn(f.input.value); renderMetrics(); refresh(); };
    f.input.addEventListener('change', commit);
    f.input.addEventListener('blur', commit);
  }
  renderMetrics();

  body.append(
    metricsBox,
    el('div', { class: 'spacer' }),
    nameF.wrap,
    el('div', { class: 'grid-2' }, levelF.wrap, heightF.wrap),
    el('p', { class: 'eyebrow', style: 'margin:14px 0 8px', text: 'Affected surfaces' }),
    el('div', { class: 'grid-3' }, floorPct.wrap, wallPct.wrap, ceilPct.wrap),
    el('div', { class: 'grid-2' }, wallHeight.wrap, obstructions.wrap),
    el('p', { class: 'eyebrow', style: 'margin:14px 0 8px', text: 'Materials' }),
    floorMat.wrap, wallMat.wrap, ceilMat.wrap,
    el('div', { class: 'note', style: 'margin:8px 0 14px', html: 'Only <strong>porous</strong> wet materials count toward the S500 class threshold. Materials flagged low-evaporation (hardwood, plaster, concrete, masonry) push the job toward Class 4.' }),
    el('button', { class: 'btn btn-primary btn-block', onClick: () => { close(); refresh(); } }, 'Done'),
    el('div', { class: 'spacer' }),
    el('button', {
      class: 'btn btn-ghost btn-block',
      onClick: async () => {
        if (await confirmDialog(`Delete ${room.name} and its readings and equipment?`)) {
          store.update((j) => { j.rooms = j.rooms.filter((r) => r.id !== room.id); });
          store.state.activeRoomId = store.state.job.rooms[0]?.id || null;
          close();
          refresh();
        }
      },
    }, 'Delete room'),
  );
}

const clampPct = (v) => Math.min(100, Math.max(0, num(v, 0)));

function moisturePointSheet(evt, refresh) {
  const job = store.state.job;
  const room = job.rooms.find((r) => r.id === evt.roomId);
  if (!room) return;
  const existing = evt.id ? room.points.find((p) => p.id === evt.id) : null;
  const { body, close } = sheet(existing ? `Point ${existing.label || ''}` : 'New monitoring point');

  const label = field('Label', { value: existing?.label || nextPointLabel(room), hint: 'Short — it prints on the plan. "W1", "Sub-2", "Base N".' });
  const material = field('Material', { type: 'select', value: existing?.materialId || room.affected.floorMaterial, options: MATERIALS.map((m) => ({ value: m.id, label: m.label })) });
  const dryStd = field('Unaffected dry standard', { value: existing?.dryStandard ?? '', inputmode: 'decimal', hint: 'Reading from the same material in an unaffected area. This is what makes your drying goal defensible.' });
  const note = field('Location note', { value: existing?.note || '', placeholder: 'North wall, 6" above base' });

  const readingWrap = el('div');
  const renderReadings = () => {
    readingWrap.innerHTML = '';
    const pt = existing ? store.state.job.rooms.find((r) => r.id === room.id).points.find((p) => p.id === existing.id) : null;
    const readings = (pt?.readings || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    if (!readings.length) return;
    const s = pointStatus(pt, pt.readings);
    readingWrap.append(
      el('p', { class: 'eyebrow', style: 'margin:14px 0 8px', text: 'Reading history' }),
      el('div', { class: 'card' }, el('div', { class: 'list' },
        ...readings.map((r) => el('div', { class: 'list-item', style: 'cursor:default' },
          el('div', { class: 'li-main' },
            el('div', { class: 'li-title', text: `${r.value}${MATERIALS.find((m) => m.id === pt.materialId)?.unit || '%'}` }),
            el('div', { class: 'li-sub', text: r.date }),
          ),
          el('button', {
            class: 'icon-btn', 'aria-label': 'Delete reading',
            onClick: () => {
              store.update((j) => {
                const p = j.rooms.find((x) => x.id === room.id).points.find((x) => x.id === pt.id);
                p.readings = p.readings.filter((x) => x.id !== r.id);
              });
              renderReadings();
              refresh();
            },
          }, '🗑'),
        )),
      )),
      el('div', { class: `note ${s.state === 'dry' ? 'note-good' : s.state === 'stalled' ? 'note-warn' : ''}`, style: 'margin-top:10px', text: s.basis }),
    );
  };
  renderReadings();

  body.append(
    label.wrap, material.wrap, dryStd.wrap, note.wrap,
    readingWrap,
    el('div', { class: 'spacer' }),
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: () => {
        const patch = {
          label: label.input.value.trim(),
          materialId: material.input.value,
          dryStandard: dryStd.input.value === '' ? null : num(dryStd.input.value),
          note: note.input.value.trim(),
        };
        store.update((j) => {
          const r = j.rooms.find((x) => x.id === room.id);
          if (existing) {
            Object.assign(r.points.find((p) => p.id === existing.id), patch);
          } else {
            r.points.push({ id: uid('pt'), x: evt.x, y: evt.y, readings: [], ...patch });
          }
        });
        close();
        refresh();
      },
    }, existing ? 'Save point' : 'Add point'),
    existing ? el('div', { class: 'spacer' }) : null,
    existing ? el('button', {
      class: 'btn btn-ghost btn-block',
      onClick: async () => {
        if (await confirmDialog('Delete this monitoring point and its readings?')) {
          store.update((j) => {
            const r = j.rooms.find((x) => x.id === room.id);
            r.points = r.points.filter((p) => p.id !== existing.id);
          });
          close();
          refresh();
        }
      },
    }, 'Delete point') : null,
  );
}

function nextPointLabel(room) {
  const n = (room.points || []).length + 1;
  return `P${n}`;
}

function equipmentPickerSheet(sketch) {
  const { body, close } = sheet('Place which equipment?');
  const list = el('div', { class: 'list' });
  for (const t of store.EQUIPMENT_TYPES) {
    list.append(el('button', {
      class: 'list-item',
      onClick: () => { sketch.equipmentType = t.id; close(); },
    },
      el('span', { style: 'font-size:19px;width:26px', text: t.icon }),
      el('div', { class: 'li-main' }, el('div', { class: 'li-title', text: t.label })),
      sketch.equipmentType === t.id ? el('span', { class: 'chip chip-blue', text: 'Selected' }) : null,
    ));
  }
  body.append(list);
}

function placeEquipment(evt, refresh) {
  store.update((j) => {
    const r = j.rooms.find((x) => x.id === evt.roomId);
    if (!r) return;
    r.equipment = r.equipment || [];
    r.equipment.push({
      id: uid('eq'),
      type: evt.equipmentType,
      x: evt.x, y: evt.y, rot: 0,
      placedAt: new Date().toISOString(),
      removedAt: null,
      label: '', serial: '',
    });
  });
  refresh();
}

function equipmentSheet(evt, refresh) {
  const job = store.state.job;
  const room = job.rooms.find((r) => r.id === evt.roomId);
  const eq = room?.equipment.find((e) => e.id === evt.id);
  if (!eq) return;
  const type = store.EQUIPMENT_TYPES.find((t) => t.id === eq.type);
  const { body, close } = sheet(type?.label || 'Equipment');

  const typeF = field('Type', { type: 'select', value: eq.type, options: store.EQUIPMENT_TYPES.map((t) => ({ value: t.id, label: t.label })) });
  const labelF = field('Unit label', { value: eq.label, placeholder: 'AM-4' });
  const serialF = field('Serial / asset #', { value: eq.serial });
  const placedF = field('Placed', { type: 'datetime-local', value: toLocalInput(eq.placedAt) });

  const save = (patch) => store.update((j) => {
    const r = j.rooms.find((x) => x.id === room.id);
    Object.assign(r.equipment.find((e) => e.id === eq.id), patch);
  });

  body.append(
    typeF.wrap, labelF.wrap, serialF.wrap, placedF.wrap,
    el('div', { class: 'btn-row', style: 'margin-bottom:10px' },
      el('button', { class: 'btn', onClick: () => { save({ rot: (eq.rot || 0) - 45 }); refresh(); } }, '↺ 45°'),
      el('button', { class: 'btn', onClick: () => { save({ rot: (eq.rot || 0) + 45 }); refresh(); } }, '↻ 45°'),
    ),
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: () => {
        save({
          type: typeF.input.value,
          label: labelF.input.value.trim(),
          serial: serialF.input.value.trim(),
          placedAt: placedF.input.value ? new Date(placedF.input.value).toISOString() : eq.placedAt,
        });
        close();
        refresh();
      },
    }, 'Save'),
    el('div', { class: 'spacer' }),
    el('button', {
      class: 'btn btn-ghost btn-block',
      onClick: () => {
        // Pulling equipment stops the billing clock but keeps the record.
        save({ removedAt: new Date().toISOString() });
        close();
        refresh();
        toast('Marked as picked up — equipment days stop accruing now.');
      },
    }, 'Mark picked up'),
    el('div', { class: 'spacer' }),
    el('button', {
      class: 'btn btn-ghost btn-block',
      onClick: async () => {
        if (await confirmDialog('Remove this unit from the plan entirely? Use "Mark picked up" instead if it was on site.')) {
          store.update((j) => {
            const r = j.rooms.find((x) => x.id === room.id);
            r.equipment = r.equipment.filter((e) => e.id !== eq.id);
          });
          close();
          refresh();
        }
      },
    }, 'Delete from plan'),
  );
}

function openingSheet(evt, refresh) {
  const { body, close } = sheet('Door or window');
  const typeF = field('Type', { type: 'select', value: 'door', options: [{ value: 'door', label: 'Door / opening' }, { value: 'window', label: 'Window' }] });
  const widthF = field('Width (ft)', { value: 3, inputmode: 'decimal' });
  body.append(typeF.wrap, widthF.wrap,
    el('div', { class: 'note', style: 'margin-bottom:12px', text: 'Openings are subtracted from wet wall linear feet so the air mover count is not inflated.' }),
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: () => {
        store.update((j) => {
          const r = j.rooms.find((x) => x.id === evt.roomId);
          r.openings = r.openings || [];
          r.openings.push({ id: uid('op'), type: typeF.input.value, wallIndex: evt.wallIndex, t: evt.t, width: num(widthF.input.value, 3) });
        });
        close();
        refresh();
      },
    }, 'Add opening'),
  );
}

function autoPlaceSheet(room, refresh) {
  const plan = store.equipmentPlan();
  const roomPlan = plan?.airMovers.perRoom.find((r) => r.roomId === room.id);
  const suggested = roomPlan?.max ?? 2;
  const { body, close } = sheet('Auto-place air movers');
  const countF = field('How many', { type: 'number', value: suggested, inputmode: 'numeric', min: 1, max: 40 });

  body.append(
    el('div', { class: 'note', style: 'margin-bottom:12px', html: roomPlan ? `S500 calls for <strong>${roomPlan.min}–${roomPlan.max}</strong> in this room: ${roomPlan.basis}.` : 'Sketch the room first to get a calculated count.' }),
    countF.wrap,
    el('p', { class: 'mute', style: 'margin-bottom:12px', text: 'Units are spaced evenly around the perimeter and angled down-wall so the airflow wraps the room in one direction. Drag any of them afterwards.' }),
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: () => {
        const count = Math.max(1, Math.min(40, num(countF.input.value, suggested)));
        const spots = layoutAirMovers(room.poly, count);
        if (!spots.length) { toast('Sketch the room outline first.', 'error'); return; }
        store.update((j) => {
          const r = j.rooms.find((x) => x.id === room.id);
          r.equipment = r.equipment || [];
          const now = new Date().toISOString();
          spots.forEach((s, i) => {
            r.equipment.push({ id: uid('eq'), type: 'airMover', x: s.x, y: s.y, rot: s.rot, placedAt: now, removedAt: null, label: `AM${(r.equipment.filter((e) => e.type === 'airMover').length) + i + 1}`, serial: '' });
          });
        });
        close();
        refresh();
        toast(`Placed ${count} air mover${count === 1 ? '' : 's'}.`, 'success');
      },
    }, 'Place them'),
  );
}

function exportPlanPng(sketch, job) {
  const url = sketch.toPng();
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug(job)}-floorplan.png`;
  document.body.append(a);
  a.click();
  a.remove();
  toast('Plan image saved.', 'success');
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export { toLocalInput };
