/* Monitoring: material moisture readings plus the psychrometric log.
 *
 * Optimised for the way monitoring actually happens — one pass through the
 * house, one number per point, typed with a thumb. */

import { el, sheet, field, toast, todayISO, fmtDate, num, round, download, toCsv, uid, confirmDialog } from '../util.js';
import * as store from '../store.js';
import { pointStatus, MATERIALS, dryingGoal } from '../iicrc.js';
import { readingSummary, gpp, dewPoint, grainDepression, dehuVerdict, condensationRisk, rhFromGpp } from '../psychro.js';
import { slug } from './jobs.js';

const PSYCHRO_LOCATIONS = [
  { id: 'affected', label: 'Affected area', hint: 'Inside the drying chamber' },
  { id: 'unaffected', label: 'Unaffected area', hint: 'Same structure, dry area — your baseline' },
  { id: 'exterior', label: 'Exterior', hint: 'Outside air' },
  { id: 'dehuIn', label: 'Dehu inlet', hint: 'Air going into the dehumidifier' },
  { id: 'dehuOut', label: 'Dehu outlet', hint: 'Air coming out — inlet minus outlet is grain depression' },
  { id: 'hvac', label: 'HVAC supply', hint: 'Optional' },
];

let selectedDate = todayISO();

export default function renderReadings(view, { go }) {
  const job = store.state.job;
  if (!job) return go('jobs');

  const rerender = () => { view.innerHTML = ''; renderReadings(view, { go }); };

  /* Derived blocks are refreshed in place. Rebuilding the whole view on every
   * keystroke would tear the input the tech is typing into out of the DOM,
   * dropping focus and the numeric keypad between every reading. */
  const progressCard = el('div', { class: 'card' });
  const refreshProgress = () => {
    const progress = store.dryingProgress(store.state.job);
    progressCard.innerHTML = '';
    progressCard.append(
      el('div', { class: 'stats' },
        st(`${Math.round(progress.pct)}%`, 'Dry', progress.complete ? 'green' : progress.pct > 60 ? 'amber' : ''),
        st(`${progress.dry}/${progress.measured}`, 'Points met'),
        st(String(progress.stalled.length), 'Stalled', progress.stalled.length ? 'red' : ''),
        st(String(dayNumber(store.state.job, selectedDate)), 'Day'),
      ),
      el('div', { class: 'card-body tight' },
        el('div', { class: 'bar' }, el('div', { class: `bar-fill ${progress.complete ? '' : progress.pct > 60 ? 'amber' : 'red'}`, style: `width:${Math.max(2, progress.pct)}%` })),
      ),
      progress.complete
        ? el('div', { class: 'card-body tight' }, el('div', { class: 'note note-good', html: '<strong>Every monitored point has met its drying goal.</strong> Document the final readings, pull equipment, and get a completion signature on the Daily tab.' }))
        : null,
      progress.stalled.length
        ? el('div', { class: 'card-body tight' }, el('div', { class: 'note note-warn', html: `<strong>${progress.stalled.length} point${progress.stalled.length === 1 ? ' has' : 's have'} stalled.</strong> ${progress.stalled.map((p) => `${p.roomName} · ${p.label}`).join(', ')}. Change the setup — more airflow, more heat, or open the assembly — and note why in today's daily.` }))
        : null,
    );
  };
  refreshProgress();

  view.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { text: 'Monitoring' }),
      el('p', { class: 'mute', text: `Day ${dayNumber(job, selectedDate)} · ${fmtDate(selectedDate)}` }),
    ),
    datePicker(rerender),
  ));

  view.append(progressCard, el('div', { class: 'spacer' }));

  /* Material readings, grouped by room */
  if (!store.allPoints(job).length) {
    view.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
      el('div', { class: 'empty-ico', text: '◈' }),
      el('h2', { text: 'No monitoring points yet' }),
      el('p', { text: 'Drop points on the floor plan where you take readings, then come back here to log them each day.' }),
      el('button', { class: 'btn btn-primary', onClick: () => go('plan') }, 'Go to plan'),
    )), el('div', { class: 'spacer' }));
  } else {
    for (const room of job.rooms) {
      if (!room.points?.length) continue;
      view.append(roomReadingCard(room, refreshProgress, rerender), el('div', { class: 'spacer' }));
    }
  }

  /* Psychrometrics */
  view.append(psychroCard(job), el('div', { class: 'spacer' }));

  view.append(el('div', { class: 'btn-row' },
    el('button', { class: 'btn btn-ghost btn-sm', onClick: () => exportMoistureLog(job) }, '⤓ Moisture log CSV'),
    el('button', { class: 'btn btn-ghost btn-sm', onClick: () => psychroCalculator() }, '🧮 Psychro calculator'),
  ));
}

function st(value, label, tone) {
  return el('div', { class: 'stat' }, el('div', { class: `stat-val ${tone || ''}`, text: value }), el('div', { class: 'stat-lbl', text: label }));
}

function datePicker(rerender) {
  const input = el('input', { type: 'date', value: selectedDate, style: 'min-height:38px;padding:6px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;font-size:14px' });
  input.addEventListener('change', () => { selectedDate = input.value || todayISO(); rerender(); });
  return input;
}

function dayNumber(job, date) {
  const start = job.claim?.dateArrived || job.createdAt;
  const d0 = new Date(String(start).slice(0, 10) + 'T12:00:00');
  const d1 = new Date(date + 'T12:00:00');
  return Math.max(1, Math.round((d1 - d0) / 864e5) + 1);
}

/* ── Material readings ────────────────────────────────────────────────────── */

function roomReadingCard(room, refreshProgress, rerender) {
  const rows = el('div');

  for (const point of room.points) {
    const mat = MATERIALS.find((m) => m.id === point.materialId);
    const todays = (point.readings || []).find((r) => r.date === selectedDate);

    const dot = el('div', { class: 'pt-dot' });
    const meta = el('div', { class: 'pt-meta' });
    const sparkSlot = el('div', { style: 'display:flex' });

    const input = el('input', {
      type: 'number', inputmode: 'decimal', step: '0.1',
      value: todays ? todays.value : '',
      placeholder: '—',
      'aria-label': `Reading for ${point.label}`,
    });

    // Repaint only this row plus the summary — never the input being typed in.
    const paint = () => {
      const live = store.state.job.rooms.find((r) => r.id === room.id)?.points.find((x) => x.id === point.id) || point;
      const status = pointStatus(live, live.readings || []);
      dot.style.background = dotColor(status);
      dot.textContent = status.value != null ? String(Math.round(status.value)) : '·';
      meta.textContent = `${mat?.label || 'Material'} · goal ≤ ${status.goal ?? '—'}${mat?.unit || '%'}${point.note ? ` · ${point.note}` : ''}`;
      sparkSlot.innerHTML = '';
      sparkSlot.append(sparkline(live.readings || [], status.goal));
    };

    input.addEventListener('change', () => {
      const raw = input.value.trim();
      store.update((j) => {
        const p = j.rooms.find((r) => r.id === room.id).points.find((x) => x.id === point.id);
        p.readings = p.readings || [];
        const existing = p.readings.find((r) => r.date === selectedDate);
        if (raw === '') {
          p.readings = p.readings.filter((r) => r.date !== selectedDate);
        } else if (existing) {
          existing.value = num(raw);
          existing.at = new Date().toISOString();
        } else {
          p.readings.push({ id: uid('rd'), date: selectedDate, value: num(raw), at: new Date().toISOString() });
        }
      });
      paint();
      refreshProgress();
    });

    paint();
    rows.append(el('div', { class: 'pt-row' },
      dot,
      el('div', { class: 'pt-main', onClick: () => pointDetailSheet(room, point, rerender) },
        el('div', { class: 'pt-name', text: point.label || 'Point' }),
        meta,
      ),
      sparkSlot,
      el('div', { class: 'pt-input' }, input),
    ));
  }

  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', { text: room.name }),
      el('span', { class: 'mute tiny', text: `${room.points.length} pt` }),
    ),
    rows,
  );
}

function dotColor(status) {
  if (status.state === 'no-data') return 'var(--text-mute)';
  if (status.state === 'dry') return 'var(--green)';
  if (status.state === 'wetting') return 'var(--red)';
  if (status.state === 'stalled') return 'var(--orange)';
  return 'var(--amber)';
}

function sparkline(readings, goal) {
  const sorted = [...readings].sort((a, b) => new Date(a.date) - new Date(b.date)).slice(-7);
  const wrap = el('div', { class: 'spark' });
  if (sorted.length < 2) return el('div', { style: 'width:38px' });
  const values = sorted.map((r) => num(r.value));
  const max = Math.max(...values, num(goal, 0) * 1.2, 1);
  for (const v of values) {
    const h = Math.max(2, (v / max) * 26);
    const met = goal != null && v <= goal;
    wrap.append(el('i', { style: `height:${h}px;background:${met ? 'var(--green)' : 'var(--accent)'}` }));
  }
  return wrap;
}

function pointDetailSheet(room, point, rerender) {
  const { body, close } = sheet(`${room.name} · ${point.label}`);
  const mat = MATERIALS.find((m) => m.id === point.materialId);
  const status = pointStatus(point, point.readings || []);
  const readings = [...(point.readings || [])].sort((a, b) => new Date(b.date) - new Date(a.date));

  body.append(
    el('div', { class: 'stats' },
      st(status.value != null ? `${round(status.value, 1)}` : '—', `Current ${mat?.unit || '%'}`),
      st(status.goal != null ? `${round(status.goal, 1)}` : '—', 'Goal'),
      st(status.first != null && status.value != null ? `${round(status.first - status.value, 1)}` : '—', 'Change'),
    ),
    el('div', { class: `note ${status.state === 'dry' ? 'note-good' : status.state === 'stalled' ? 'note-warn' : ''}`, style: 'margin:12px 0', text: status.basis }),
    status.goalSource === 'published'
      ? el('div', { class: 'note note-warn', html: 'No unaffected reference recorded for this point. Take a reading on the same material in a dry area and enter it as the dry standard — adjusters challenge published-value goals.' })
      : null,
  );

  if (readings.length) {
    body.append(
      el('p', { class: 'eyebrow', style: 'margin:14px 0 8px', text: 'History' }),
      el('div', { class: 'card' }, el('div', { class: 'table-scroll' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', { class: 'num' }, 'Reading'), el('th', { class: 'num' }, 'Δ'), el('th', {}, 'Status'))),
        el('tbody', {}, ...readings.map((r, i) => {
          const prev = readings[i + 1];
          const delta = prev ? num(r.value) - num(prev.value) : null;
          const met = status.goal != null && num(r.value) <= status.goal;
          return el('tr', {},
            el('td', {}, fmtDate(r.date)),
            el('td', { class: 'num mono' }, `${r.value}${mat?.unit || '%'}`),
            el('td', { class: 'num mono' }, delta == null ? '—' : `${delta > 0 ? '+' : ''}${round(delta, 1)}`),
            el('td', {}, el('span', { class: `chip ${met ? 'chip-green' : 'chip-amber'}`, text: met ? 'Met' : 'Wet' })),
          );
        })),
      ))),
    );
  }
  body.append(el('div', { class: 'spacer' }), el('button', { class: 'btn btn-block', onClick: close }, 'Close'));
}

/* ── Psychrometrics ───────────────────────────────────────────────────────── */

function psychroCard(job) {
  const rows = el('div');
  const analysis = el('div', { class: 'card-body tight' });
  const metaByLocation = {};

  const refreshAnalysis = () => {
    const day = store.psychroForDate(store.state.job, selectedDate);

    for (const loc of PSYCHRO_LOCATIONS) {
      const summary = day[loc.id];
      metaByLocation[loc.id].textContent = summary
        ? `${round(summary.gpp, 1)} gr/lb · DP ${round(summary.dewPoint, 0)}°F`
        : loc.hint;
    }

    analysis.innerHTML = '';
    if (day.depression != null) {
      const v = dehuVerdict(day.depression);
      analysis.append(el('div', { class: `note ${v.level === 'good' || v.level === 'ok' ? 'note-good' : v.level === 'bad' ? 'note-danger' : 'note-warn'}`, text: v.text }));
    }
    for (const note of day.analysis?.notes || []) {
      analysis.append(el('div', { class: 'note', style: 'margin-top:8px', text: note }));
    }
    if (day.affected && day.exterior) {
      const risk = condensationRisk(day.affected.temp, day.affected.rh, day.exterior.temp);
      if (risk.risk !== 'clear') {
        analysis.append(el('div', { class: 'note note-warn', style: 'margin-top:8px', html: `Exterior surfaces near <strong>${round(day.exterior.temp, 0)}°F</strong> are at or below the room dew point of <strong>${round(risk.dewPoint, 0)}°F</strong> — expect condensation on windows and exterior walls.` }));
      }
    }
  };

  for (const loc of PSYCHRO_LOCATIONS) {
    const existing = (job.psychro || []).filter((p) => p.location === loc.id && (p.at || '').slice(0, 10) === selectedDate).slice(-1)[0];

    const tempIn = el('input', { type: 'number', inputmode: 'decimal', step: '0.1', placeholder: '°F', value: existing?.temp ?? '', 'aria-label': `${loc.label} temperature` });
    const rhIn = el('input', { type: 'number', inputmode: 'decimal', step: '0.1', placeholder: '%RH', value: existing?.rh ?? '', 'aria-label': `${loc.label} relative humidity` });
    const meta = el('div', { class: 'pt-meta' });
    metaByLocation[loc.id] = meta;

    const commit = () => {
      const t = tempIn.value.trim(), r = rhIn.value.trim();
      store.update((j) => {
        j.psychro = j.psychro || [];
        j.psychro = j.psychro.filter((p) => !(p.location === loc.id && (p.at || '').slice(0, 10) === selectedDate));
        // A row is only a reading once both halves are in; a lone temperature
        // is someone mid-entry, not data.
        if (t !== '' && r !== '') {
          j.psychro.push({ id: uid('ps'), location: loc.id, temp: num(t), rh: num(r), at: `${selectedDate}T${new Date().toTimeString().slice(0, 8)}` });
        }
      });
      refreshAnalysis();
    };
    tempIn.addEventListener('change', commit);
    rhIn.addEventListener('change', commit);

    rows.append(el('div', { class: 'pt-row' },
      el('div', { class: 'pt-main' },
        el('div', { class: 'pt-name', text: loc.label }),
        meta,
      ),
      el('div', { class: 'pt-input' }, tempIn),
      el('div', { class: 'pt-input' }, rhIn),
    ));
  }

  refreshAnalysis();

  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', { text: 'Psychrometrics' }),
      el('span', { class: 'mute tiny', text: '°F / %RH' }),
    ),
    rows,
    analysis,
  );
}

function psychroCalculator() {
  const { body } = sheet('Psychrometric calculator');
  const temp = field('Temperature °F', { type: 'number', inputmode: 'decimal', value: 78 });
  const rh = field('Relative humidity %', { type: 'number', inputmode: 'decimal', value: 55 });
  const out = el('div', { class: 'stats' });
  const whatIf = el('div', { class: 'note', style: 'margin-top:12px' });

  const calc = () => {
    const t = num(temp.input.value, 70), r = num(rh.input.value, 50);
    const s = readingSummary({ temp: t, rh: r });
    out.innerHTML = '';
    out.append(
      st(round(s.gpp, 1), 'GPP'),
      st(round(s.dewPoint, 0), 'Dew pt °F'),
      st(round(s.vaporPressure * 10, 2), 'VP mb'),
      st(round(s.enthalpy, 1), 'BTU/lb'),
    );
    // Heating at constant moisture is the lever techs reach for most often.
    const heated = t + 15;
    whatIf.innerHTML = `Heat this air to <strong>${round(heated, 0)}°F</strong> without adding moisture and RH drops to <strong>${round(rhFromGpp(heated, s.gpp), 0)}%</strong> — that is why adding heat speeds up evaporation.`;
  };
  temp.input.addEventListener('input', calc);
  rh.input.addEventListener('input', calc);
  calc();

  body.append(el('div', { class: 'grid-2' }, temp.wrap, rh.wrap), out, whatIf);
}

/* ── Export ───────────────────────────────────────────────────────────────── */

function exportMoistureLog(job) {
  const points = store.allPoints(job);
  const dates = [...new Set(points.flatMap((p) => (p.readings || []).map((r) => r.date)))].sort();
  const rows = [
    [`Moisture log — ${job.claim?.insured || ''}`],
    [`Claim ${job.claim?.claimNumber || ''}`, `Loss address ${job.claim?.address || ''}`],
    [],
    ['Room', 'Point', 'Material', 'Dry standard', 'Goal', ...dates.map(fmtDate), 'Status'],
  ];
  for (const p of points) {
    const s = pointStatus(p, p.readings || []);
    const mat = MATERIALS.find((m) => m.id === p.materialId);
    rows.push([
      p.roomName, p.label, mat?.label || '', p.dryStandard ?? '', s.goal ?? '',
      ...dates.map((d) => (p.readings || []).find((r) => r.date === d)?.value ?? ''),
      s.state,
    ]);
  }
  rows.push([]);
  rows.push(['Psychrometrics']);
  rows.push(['Date', 'Location', 'Temp °F', 'RH %', 'GPP', 'Dew point °F']);
  for (const p of [...(job.psychro || [])].sort((a, b) => new Date(a.at) - new Date(b.at))) {
    rows.push([
      (p.at || '').slice(0, 10),
      PSYCHRO_LOCATIONS.find((l) => l.id === p.location)?.label || p.location,
      p.temp, p.rh, round(gpp(p.temp, p.rh), 1), round(dewPoint(p.temp, p.rh), 1),
    ]);
  }
  download(`${slug(job)}-moisture-log.csv`, toCsv(rows), 'text/csv');
  toast('Moisture log exported.', 'success');
}
