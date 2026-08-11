// Floor plan: sketch the affected area, drop moisture points, place equipment,
// draw airflow and containment.

import { store } from '../store.js';
import { Sketch, TOOLS } from '../sketch.js';
import { openForm, actionSheet, confirmDialog, promptValue } from '../ui.js';
import { MATERIALS, materialById, roomSurfaces } from '../standards.js';
import { CATALOG, EQUIPMENT_TYPES, catalogById } from '../equipment.js';
import { derive, dryingStatus } from '../derive.js';
import { esc, parseFeet, formatFeet, polygonArea, polygonPerimeter, round, toast, todayISO, download, dist } from '../util.js';

let sketch = null;
let lastCamera = null;

const HINTS = {
  select: 'Tap to select. Drag a corner to reshape, drag a selected room to move it. Pinch to zoom.',
  room: 'Tap each corner, or type a wall length and press a direction. Tap the green circle on the first corner to close the room.',
  rect: 'Enter a width and depth to drop a square room.',
  door: 'Tap a wall where the doorway or opening sits.',
  pin: 'Tap where you took the reading. Each point keeps its own daily readings and dry goal.',
  equip: 'Pick a unit, then tap the plan to place it. Placement drives the equipment charges on the estimate.',
  arrow: 'Drag to draw an airflow arrow — show the vortex and where the dehumidifier discharges.',
  containment: 'Tap along the containment line. Use the finish button when done.',
  erase: 'Tap an item to delete it.',
};

function toolbar(activeTool) {
  return `<div class="plan__tools">${Object.entries(TOOLS).map(([id, t]) =>
    `<button class="tool-btn${id === activeTool ? ' is-on' : ''}" data-tool="${id}">
      <span>${t.icon}</span><span>${esc(t.label)}</span>
    </button>`).join('')}
    <button class="tool-btn" data-undo><span>↺</span><span>Undo</span></button>
    <button class="tool-btn" data-fit><span>⤢</span><span>Fit</span></button>
  </div>`;
}

function roomForm(room, { isNew = false } = {}) {
  const a = room.affected || {};
  const matOptions = MATERIALS.map((m) => ({ value: m.id, label: m.label }));
  return openForm({
    title: isNew ? 'New room' : room.name,
    subtitle: 'Wet material and coverage here drive the Class calculation and the equipment count.',
    submitLabel: 'Save room',
    deleteLabel: isNew ? null : 'Delete room',
    fields: [
      { k: 'name', label: 'Room name', type: 'text', value: room.name, required: true, half: true },
      { k: 'level', label: 'Level', type: 'text', value: room.level, half: true, placeholder: 'Main, Basement…' },
      { k: 'ceilingHeight', label: 'Ceiling height', type: 'feet', value: room.ceilingHeight, half: true },
      { k: 'isAffected', label: 'Room is affected', type: 'checkbox', value: room.isAffected !== false },
      { k: 'sec1', label: 'Floor', type: 'section' },
      { k: 'floorMaterial', label: 'Floor material', type: 'select', value: a.floorMaterial, options: matOptions, half: true },
      { k: 'floorPct', label: '% of floor wet', type: 'number', value: a.floorPct, min: 0, max: 100, half: true },
      { k: 'sec2', label: 'Walls', type: 'section' },
      { k: 'wallMaterial', label: 'Wall material', type: 'select', value: a.wallMaterial, options: matOptions, half: true },
      { k: 'wallLf', label: 'Wet wall length (lf)', type: 'number', value: a.wallLf, half: true, hint: `Perimeter is ${round(polygonPerimeter(room.poly))} lf` },
      { k: 'wallHeightIn', label: 'Wicking height (inches)', type: 'number', value: a.wallHeightIn, half: true, hint: 'Measured with a non-penetrating meter' },
      { k: 'sec3', label: 'Ceiling', type: 'section' },
      { k: 'ceilingMaterial', label: 'Ceiling material', type: 'select', value: a.ceilingMaterial || '', options: [{ value: '', label: 'Not affected' }, ...matOptions], half: true },
      { k: 'ceilingPct', label: '% of ceiling wet', type: 'number', value: a.ceilingPct, min: 0, max: 100, half: true },
      { k: 'sec4', label: 'Airflow obstacles', hint: 'Each one earns an extra air mover', type: 'section' },
      { k: 'offsets', label: 'Offsets / inside corners', type: 'number', value: a.offsets, half: true },
      { k: 'closets', label: 'Closets', type: 'number', value: a.closets, half: true },
      { k: 'stairs', label: 'Stairwells', type: 'number', value: a.stairs, half: true },
      { k: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: room.notes },
    ],
  });
}

async function editPin(pin, ctx) {
  const mat = materialById(pin.materialId);
  const res = await openForm({
    title: `Monitoring point ${pin.label}`,
    subtitle: `${mat.label} · readings in ${mat.meter === 'mc' ? '%MC' : mat.meter === 'wme' ? '%WME' : 'relative scale'}`,
    deleteLabel: 'Delete point',
    fields: [
      { k: 'label', label: 'Point label', type: 'text', value: pin.label, half: true, required: true },
      { k: 'surface', label: 'Surface', type: 'select', value: pin.surface, half: true, options: [
        { value: 'wall', label: 'Wall' }, { value: 'floor', label: 'Floor' },
        { value: 'ceiling', label: 'Ceiling' }, { value: 'cavity', label: 'Wall cavity' },
        { value: 'subfloor', label: 'Subfloor' }, { value: 'framing', label: 'Framing' }] },
      { k: 'materialId', label: 'Material', type: 'select', value: pin.materialId, options: MATERIALS.map((m) => ({ value: m.id, label: m.label })) },
      { k: 'dryStandard', label: 'Dry standard', type: 'number', value: pin.dryStandard, half: true, hint: 'Reading from the same material in an unaffected area' },
      { k: 'reading', label: 'Reading today', type: 'number', half: true, hint: 'Leave blank to skip' },
      { k: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: pin.notes },
    ],
  });
  if (!res) return;
  if (res.__delete) {
    sketch.deleteItem('pin', pin.id);
    return;
  }
  store.update((s) => {
    const job = s.jobs.find((j) => j.id === ctx.job.id);
    const p = job.plan.pins.find((x) => x.id === pin.id);
    if (!p) return;
    Object.assign(p, {
      label: res.label, surface: res.surface, materialId: res.materialId,
      dryStandard: res.dryStandard, notes: res.notes,
    });
    if (res.reading != null && res.reading !== '') {
      p.readings = p.readings || [];
      p.readings.push({ date: todayISO(), value: Number(res.reading), ts: new Date().toISOString() });
    }
  }, { silent: true });
  applyGoals(ctx);
  sketch.render();
}

/** Copy computed goals onto the pins so the canvas can colour them. */
function applyGoals(ctx) {
  const status = dryingStatus(ctx.job, store.settings);
  for (const p of status.pins) p.pin.goal = p.goal;
}

async function editEquipment(eq, ctx) {
  const item = catalogById(eq.catalogId);
  const res = await openForm({
    title: item?.label || 'Equipment',
    deleteLabel: 'Remove from plan',
    fields: [
      { k: 'catalogId', label: 'Unit', type: 'select', value: eq.catalogId, options: CATALOG.map((c) => ({ value: c.id, label: c.label })) },
      { k: 'serial', label: 'Asset / serial number', type: 'text', value: eq.serial, half: true },
      { k: 'rot', label: 'Rotation °', type: 'number', value: eq.rot || 0, half: true, hint: 'Air movers point in this direction' },
      { k: 'placedAt', label: 'Placed', type: 'datetime-local', value: (eq.placedAt || '').slice(0, 16), half: true },
      { k: 'removedAt', label: 'Removed', type: 'datetime-local', value: (eq.removedAt || '').slice(0, 16), half: true, hint: 'Leave blank while it is running' },
    ],
  });
  if (!res) return;
  if (res.__delete) { sketch.deleteItem('equipment', eq.id); return; }
  store.update((s) => {
    const job = s.jobs.find((j) => j.id === ctx.job.id);
    const e = job.plan.equipment.find((x) => x.id === eq.id);
    if (!e) return;
    const cat = catalogById(res.catalogId);
    Object.assign(e, {
      catalogId: res.catalogId,
      type: cat?.type || e.type,
      serial: res.serial,
      rot: Number(res.rot) || 0,
      placedAt: res.placedAt ? new Date(res.placedAt).toISOString() : e.placedAt,
      removedAt: res.removedAt ? new Date(res.removedAt).toISOString() : null,
    });
  }, { silent: true });
  sketch.render();
}

export default {
  id: 'plan',
  title: 'Floor plan',

  render(ctx) {
    return `
      <div class="plan">
        ${toolbar('select')}
        <div class="plan__canvas-wrap">
          <canvas class="plan__canvas" id="planCanvas"></canvas>
          <div class="plan__overlay">
            <button class="chip is-on" data-layer="dims">Dimensions</button>
            <button class="chip is-on" data-layer="moisture">Moisture</button>
            <button class="chip is-on" data-layer="equipment">Equipment</button>
            <button class="chip is-on" data-layer="airflow">Airflow</button>
            <button class="chip is-on" data-layer="grid">Grid</button>
          </div>
          <div class="plan__zoom">
            <button data-zoom="in">+</button>
            <button data-zoom="out">−</button>
          </div>
        </div>
        <div id="planPanel"></div>
        <div class="plan__hint" id="planHint">${esc(HINTS.select)}</div>
      </div>`;
  },

  mount(root, ctx) {
    const canvas = root.querySelector('#planCanvas');
    const panel = root.querySelector('#planPanel');
    const hint = root.querySelector('#planHint');
    const job = ctx.job;

    sketch = new Sketch(canvas, {
      plan: job.plan,
      job: { derived: ctx.d },
      onChange: () => {
        store.update((s) => {
          const j = s.jobs.find((x) => x.id === job.id);
          if (j) { j.plan = job.plan; j.updatedAt = new Date().toISOString(); }
        }, { silent: true });
        renderPanel();
      },
      onSelect: () => renderPanel(),
      onDraft: () => renderPanel(),
    });

    applyGoals(ctx);
    if (lastCamera) sketch.cam = { ...lastCamera };
    else sketch.zoomToFit();
    sketch.render();

    const onResize = () => sketch?.resize();
    window.addEventListener('resize', onResize);

    // The canvas is laid out by flexbox; re-fit once the real size is known so
    // the plan is not drawn against a stale height on first paint.
    let fitted = !!lastCamera;
    const ro = new ResizeObserver(() => {
      if (!sketch) return;
      sketch.resize();
      if (!fitted) { fitted = true; sketch.zoomToFit(); }
    });
    ro.observe(canvas.parentElement);

    this._cleanup = () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      lastCamera = { ...sketch.cam };
      sketch.destroy();
      sketch = null;
    };

    function setTool(tool) {
      if (tool === 'rect') return boxRoom();
      if (tool === 'equip') return pickEquipment();
      sketch.setTool(tool);
      root.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('is-on', b.dataset.tool === tool));
      hint.textContent = HINTS[tool] || '';
      if (tool === 'room' || tool === 'containment') sketch.startDraft(tool === 'containment' ? 'containment' : 'room');
      renderPanel();
    }

    async function boxRoom() {
      const res = await openForm({
        title: 'Add a rectangular room',
        subtitle: 'Fastest way in — draw irregular shapes with the Room tool.',
        submitLabel: 'Add room',
        fields: [
          { k: 'name', label: 'Room name', type: 'text', value: `Room ${job.plan.rooms.length + 1}`, required: true },
          { k: 'w', label: 'Width', type: 'feet', required: true, half: true, placeholder: `12'6"` },
          { k: 'd', label: 'Depth', type: 'feet', required: true, half: true, placeholder: `10'` },
          { k: 'h', label: 'Ceiling height', type: 'feet', value: 8, half: true },
        ],
      });
      if (!res) return;
      const room = sketch.addRectRoom(res.w, res.d, { name: res.name, ceilingHeight: res.h || 8 });
      sketch.select({ kind: 'room', id: room.id });
      openRoomEditor(room, true);
    }

    async function pickEquipment() {
      const choice = await actionSheet({
        title: 'Place equipment',
        actions: CATALOG.map((c) => ({
          id: c.id,
          icon: EQUIPMENT_TYPES[c.type]?.icon || '•',
          label: c.label,
          hint: `${c.aham ? `${c.aham} AHAM pints · ` : ''}${c.cfm ? `${c.cfm} CFM · ` : ''}$${c.rate}/day`,
        })),
      });
      if (!choice) return;
      sketch.pendingEquip = choice;
      sketch.setTool('equip');
      root.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('is-on', b.dataset.tool === 'equip'));
      hint.textContent = `${catalogById(choice).label} — tap the plan to place. Tap again for another.`;
    }

    async function openRoomEditor(room, isNew = false) {
      const res = await roomForm(room, { isNew });
      if (!res) return;
      if (res.__delete) {
        if (await confirmDialog({ title: `Delete ${room.name}?`, message: 'Moisture points and equipment inside it are removed too.', confirmLabel: 'Delete', destructive: true })) {
          sketch.deleteRoom(room.id);
        }
        return;
      }
      sketch.pushUndo();
      Object.assign(room, {
        name: res.name, level: res.level,
        ceilingHeight: res.ceilingHeight || 8,
        isAffected: res.isAffected,
        notes: res.notes,
      });
      room.affected = {
        ...room.affected,
        floorMaterial: res.floorMaterial, floorPct: res.floorPct ?? 0,
        wallMaterial: res.wallMaterial, wallLf: res.wallLf ?? 0, wallHeightIn: res.wallHeightIn ?? 0,
        ceilingMaterial: res.ceilingMaterial, ceilingPct: res.ceilingPct ?? 0,
        offsets: res.offsets ?? 0, closets: res.closets ?? 0, stairs: res.stairs ?? 0,
      };
      sketch.commit();
      toast('Room saved');
    }

    async function editWalls(room) {
      const fields = room.poly.map((p, i) => {
        const b = room.poly[(i + 1) % room.poly.length];
        return { k: `w${i}`, label: `Wall ${i + 1}`, type: 'feet', value: dist(p, b), half: true };
      });
      const res = await openForm({
        title: `${room.name} — wall lengths`,
        subtitle: 'Type what the laser says. The closing wall absorbs the difference.',
        fields,
      });
      if (!res) return;
      for (let i = room.poly.length - 1; i >= 0; i--) {
        const v = res[`w${i}`];
        const cur = dist(room.poly[i], room.poly[(i + 1) % room.poly.length]);
        if (Number.isFinite(v) && Math.abs(v - cur) > 0.02) sketch.setWallLength(room.id, i, v);
      }
      toast('Walls updated');
    }

    async function editOpening(room, opening) {
      const res = await openForm({
        title: 'Opening',
        deleteLabel: 'Delete opening',
        fields: [
          { k: 'type', label: 'Type', type: 'segmented', value: opening.type, options: [
            { value: 'door', label: 'Door' }, { value: 'cased', label: 'Cased' }, { value: 'window', label: 'Window' }] },
          { k: 'width', label: 'Width', type: 'feet', value: opening.width, half: true },
        ],
      });
      if (!res) return;
      sketch.pushUndo();
      if (res.__delete) {
        room.openings = room.openings.filter((o) => o.id !== opening.id);
      } else {
        opening.type = res.type; opening.width = res.width || 3;
      }
      sketch.commit();
    }

    function renderPanel() {
      const draft = sketch.draft;
      const sel = sketch.selection;

      if (draft) {
        panel.innerHTML = `
          <div class="draftbar">
            <div class="draftbar__row">
              <input id="lenInput" inputmode="decimal" placeholder="Wall length — 12'6&quot;" autocomplete="off">
              <button class="btn btn--sm" data-draft="undo">⌫</button>
            </div>
            <div class="dirpad">
              <button data-dir="up">↑</button>
              <button data-dir="left">←</button>
              <button data-dir="down">↓</button>
              <button data-dir="right">→</button>
            </div>
            <div class="draftbar__row">
              <span class="tiny">${draft.pts.length} point${draft.pts.length === 1 ? '' : 's'} placed</span>
              <span class="spacer"></span>
              <button class="btn btn--sm btn--ghost" data-draft="cancel">Cancel</button>
              <button class="btn btn--sm btn--primary" data-draft="close">${draft.kind === 'containment' ? 'Finish line' : 'Close room'}</button>
            </div>
          </div>`;
        return;
      }

      if (!sel) { panel.innerHTML = ''; return; }

      if (sel.kind === 'room' || sel.kind === 'wall' || sel.kind === 'vertex') {
        const room = job.plan.rooms.find((r) => r.id === sel.id);
        if (!room) { panel.innerHTML = ''; return; }
        const s = roomSurfaces(room);
        panel.innerHTML = `
          <div class="draftbar">
            <div class="draftbar__row">
              <div style="flex:1;min-width:0">
                <strong>${esc(room.name)}</strong>
                <div class="tiny">${round(s.floor)} sf floor · ${round(s.perimeter)} lf perimeter · ${round(s.wall)} sf wall · ${round(s.volume)} cf</div>
              </div>
            </div>
            <div class="row row--wrap">
              <button class="btn btn--sm btn--primary" data-room="edit">Room details</button>
              <button class="btn btn--sm" data-room="walls">Wall lengths</button>
              <button class="btn btn--sm" data-room="copy">Duplicate</button>
              <button class="btn btn--sm btn--danger-ghost" data-room="delete" style="margin:0">Delete</button>
            </div>
          </div>`;
        return;
      }

      if (sel.kind === 'pin') {
        const pin = job.plan.pins.find((p) => p.id === sel.id);
        if (!pin) { panel.innerHTML = ''; return; }
        if (sel.isNew) { sel.isNew = false; editPin(pin, ctx); }
        const last = pin.readings?.at(-1);
        panel.innerHTML = `
          <div class="draftbar">
            <div class="draftbar__row">
              <div style="flex:1">
                <strong>Point ${esc(pin.label)}</strong>
                <div class="tiny">${esc(materialById(pin.materialId).label)} · ${last ? `last ${last.value} on ${last.date}` : 'no readings'}${pin.goal != null ? ` · goal ≤ ${pin.goal}` : ''}</div>
              </div>
            </div>
            <div class="row row--wrap">
              <button class="btn btn--sm btn--primary" data-pin="reading">Log reading</button>
              <button class="btn btn--sm" data-pin="edit">Edit point</button>
              <a class="btn btn--sm" href="#/job/${job.id}/moisture">All readings</a>
            </div>
          </div>`;
        return;
      }

      if (sel.kind === 'equipment') {
        const eq = job.plan.equipment.find((x) => x.id === sel.id);
        if (!eq) { panel.innerHTML = ''; return; }
        if (sel.isNew) sel.isNew = false;
        const item = catalogById(eq.catalogId);
        panel.innerHTML = `
          <div class="draftbar">
            <div class="draftbar__row">
              <div style="flex:1">
                <strong>${esc(item?.label || 'Equipment')}</strong>
                <div class="tiny">${eq.removedAt ? 'Removed' : 'Running'}${eq.serial ? ` · #${esc(eq.serial)}` : ''} · $${item?.rate || 0}/day</div>
              </div>
            </div>
            <div class="row row--wrap">
              <button class="btn btn--sm" data-eq="rotate">Rotate 45°</button>
              <button class="btn btn--sm btn--primary" data-eq="edit">Details</button>
              <button class="btn btn--sm" data-eq="pull">${eq.removedAt ? 'Mark running' : 'Mark pulled'}</button>
            </div>
          </div>`;
        return;
      }

      if (sel.kind === 'opening') {
        const room = job.plan.rooms.find((r) => r.id === sel.roomId);
        const op = room?.openings.find((o) => o.id === sel.id);
        if (op) { sketch.select(null); editOpening(room, op); }
        return;
      }

      panel.innerHTML = '';
    }

    // ── events ──────────────────────────────────────────────────────────────
    root.addEventListener('click', async (e) => {
      const toolBtn = e.target.closest('[data-tool]');
      if (toolBtn) return setTool(toolBtn.dataset.tool);

      if (e.target.closest('[data-undo]')) {
        sketch.undo() ? toast('Undone') : toast('Nothing to undo');
        renderPanel();
        return;
      }
      if (e.target.closest('[data-fit]')) return sketch.zoomToFit();

      const zoom = e.target.closest('[data-zoom]');
      if (zoom) return sketch.zoomBy(zoom.dataset.zoom === 'in' ? 1.25 : 0.8);

      const layer = e.target.closest('[data-layer]');
      if (layer) {
        const on = !layer.classList.contains('is-on');
        layer.classList.toggle('is-on', on);
        sketch.setLayer(layer.dataset.layer, on);
        return;
      }

      const draftBtn = e.target.closest('[data-draft]');
      if (draftBtn) {
        const act = draftBtn.dataset.draft;
        if (act === 'undo') sketch.undoDraftPoint();
        if (act === 'cancel') { sketch.cancelDraft(); setTool('select'); }
        if (act === 'close') {
          const room = sketch.closeDraft();
          if (room) { setTool('select'); openRoomEditor(room, true); }
          else setTool('select');
        }
        return;
      }

      const dir = e.target.closest('[data-dir]');
      if (dir) {
        const input = root.querySelector('#lenInput');
        const len = parseFeet(input?.value);
        if (!len) { toast('Enter a length first', 'bad'); input?.focus(); return; }
        sketch.draftSegment(len, dir.dataset.dir);
        if (input) { input.value = ''; input.focus(); }
        return;
      }

      const roomBtn = e.target.closest('[data-room]');
      if (roomBtn) {
        const room = job.plan.rooms.find((r) => r.id === sketch.selection?.id);
        if (!room) return;
        const act = roomBtn.dataset.room;
        if (act === 'edit') return openRoomEditor(room);
        if (act === 'walls') return editWalls(room);
        if (act === 'copy') {
          const copy = JSON.parse(JSON.stringify(room));
          copy.id = `room_${Date.now()}`;
          copy.name = `${room.name} (copy)`;
          const b = polygonPerimeter(room.poly);
          for (const p of copy.poly) { p.x += 3; p.y += 3; }
          sketch.pushUndo();
          job.plan.rooms.push(copy);
          sketch.commit();
          sketch.select({ kind: 'room', id: copy.id });
          return;
        }
        if (act === 'delete') {
          if (await confirmDialog({ title: `Delete ${room.name}?`, message: 'Moisture points and equipment inside it are removed too.', confirmLabel: 'Delete', destructive: true })) {
            sketch.deleteRoom(room.id);
          }
        }
        return;
      }

      const pinBtn = e.target.closest('[data-pin]');
      if (pinBtn) {
        const pin = job.plan.pins.find((p) => p.id === sketch.selection?.id);
        if (!pin) return;
        if (pinBtn.dataset.pin === 'edit') return editPin(pin, ctx);
        const v = await promptValue({
          title: `Reading — point ${pin.label}`,
          label: `${materialById(pin.materialId).label} reading`,
          type: 'number',
          hint: pin.goal != null ? `Goal is ${pin.goal} or lower` : '',
          submitLabel: 'Log reading',
        });
        if (v == null || v === '') return;
        store.update((s) => {
          const j = s.jobs.find((x) => x.id === job.id);
          const p = j.plan.pins.find((x) => x.id === pin.id);
          p.readings = p.readings || [];
          p.readings.push({ date: todayISO(), value: Number(v), ts: new Date().toISOString() });
        }, { silent: true });
        applyGoals(ctx);
        sketch.render();
        renderPanel();
        toast('Reading logged', 'good');
        return;
      }

      const eqBtn = e.target.closest('[data-eq]');
      if (eqBtn) {
        const eq = job.plan.equipment.find((x) => x.id === sketch.selection?.id);
        if (!eq) return;
        const act = eqBtn.dataset.eq;
        if (act === 'edit') return editEquipment(eq, ctx);
        if (act === 'rotate') {
          sketch.pushUndo();
          eq.rot = ((eq.rot || 0) + 45) % 360;
          sketch.commit();
          return;
        }
        if (act === 'pull') {
          sketch.pushUndo();
          eq.removedAt = eq.removedAt ? null : new Date().toISOString();
          sketch.commit();
          renderPanel();
          toast(eq.removedAt ? 'Marked pulled' : 'Back on the clock');
        }
      }
    });

    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'lenInput') {
        e.preventDefault();
        root.querySelector('[data-dir="right"]')?.click();
      }
    });
  },

  unmount() { this._cleanup?.(); this._cleanup = null; },
};
