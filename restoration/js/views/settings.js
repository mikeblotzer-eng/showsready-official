/** Company details, sizing coefficients, price list, sync and backup. */

import * as store from '../store.js';
import {
  esc, onAct, formSheet, toast, sheet, sectionHeader, confirmDialog, download, shareOrDownload,
} from '../ui.js';
import { money, num, round } from '../util.js';
import { DEFAULT_COEFFICIENTS, DEHU_TYPES } from '../iicrc.js';
import { LINE_ITEM_CATALOG, LABOR_ROLES, catalogById } from '../estimate.js';

export async function render(ctx) {
  const s = ctx.settings;
  const pending = await store.outboxCount();
  const usage = await store.storageEstimate();
  const jobs = await store.listJobs();

  const html = `
    ${sectionHeader('Company & technician', `<button class="btn btn-sm" data-act="company">Edit</button>`)}
    <div class="card">
      ${row('Company', s.companyName)}
      ${row('Phone', s.companyPhone)}
      ${row('Licence', s.companyLicense)}
      ${row('Technician', s.techName)}
      ${row('Certification', s.techCertification)}
      ${row('Mileage rate', money(s.mileageRate))}
      ${!s.companyName && !s.techName ? '<p class="muted small">Set these once — they go on every report you generate.</p>' : ''}
    </div>

    ${sectionHeader('Sizing coefficients', `<button class="btn btn-sm" data-act="coefficients">Edit</button>`)}
    <div class="card">
      <p class="tiny muted mb">What the equipment recommendation sizes against. Defaults follow the field factors
        taught for IICRC S500 work — align them with your firm's SOP and the edition of the standard you work to.</p>
      ${[1, 2, 3, 4].map((c) => {
        const co = (s.coefficients?.airMover?.[c]) || DEFAULT_COEFFICIENTS.airMover[c];
        const dehu = (s.coefficients?.dehuFactor?.lgr?.[c]) ?? DEFAULT_COEFFICIENTS.dehuFactor.lgr[c];
        return `<div class="card-row"><span class="label">Class ${c}</span><span class="value">
          ${co.sqftPerAirMover} ft²/mover · ${co.lfWallPerAirMover} lf/mover<br>
          <span class="tiny muted">LGR: ${dehu} ft³ per pint</span></span></div>`;
      }).join('')}
      ${s.coefficients ? `<button class="btn btn-sm btn-ghost btn-block mt" data-act="reset-coefficients">Reset to defaults</button>` : ''}
    </div>

    ${sectionHeader('Price list', `<button class="btn btn-sm" data-act="prices">Edit</button>`)}
    <div class="card">
      <p class="tiny muted mb">Codes and unit prices used in the estimate. The shipped values are placeholders —
        set them to your own price list before sending anything to an adjuster.</p>
      <div class="card-row"><span class="label">Customised items</span>
        <span class="value">${Object.keys(s.priceList || {}).length} of ${LINE_ITEM_CATALOG.length}</span></div>
      <button class="btn btn-sm btn-block mt" data-act="labor-rates">Labour rates</button>
    </div>

    ${sectionHeader('Sync', `<button class="btn btn-sm" data-act="sync-settings">Configure</button>`)}
    <div class="card">
      <p class="tiny muted mb">The app works entirely offline and keeps everything on this device. Point it at an
        endpoint that accepts <code>PUT /jobs/:id</code> and it will push changes whenever there is signal.</p>
      ${row('Endpoint', s.syncEndpoint || 'Not configured')}
      <div class="card-row"><span class="label">Queued changes</span><span class="value">${pending}</span></div>
      ${s.syncEndpoint ? `<button class="btn btn-sm btn-block mt" data-act="sync-now">Sync now</button>` : ''}
    </div>

    ${sectionHeader('Data')}
    <div class="card">
      <div class="card-row"><span class="label">Jobs on device</span><span class="value">${jobs.length}</span></div>
      ${usage ? `<div class="card-row"><span class="label">Storage used</span>
        <span class="value">${formatBytes(usage.usage)} of ${formatBytes(usage.quota)}<br>
        <span class="tiny muted">${round(usage.pct, 1)}%</span></span></div>` : ''}
      <div class="btn-row mt">
        <button class="btn btn-sm" data-act="backup">Back up everything</button>
        <button class="btn btn-sm" data-act="restore">Restore</button>
      </div>
      ${usage && usage.pct > 75 ? `<p class="tiny mt" style="color:var(--warn)">
        Storage is filling up. Export finished jobs and delete them from the device.</p>` : ''}
    </div>

    <div class="note-block">
      <strong>About the guidance in this app.</strong> Category, class and equipment counts are computed from what you
      record, following the IICRC S500 approach. They are a starting point that shows its working — the standard
      itself requires your professional judgement on site, and every result here can be overridden with a reason
      that carries through to the report.
    </div>

    <p class="tiny muted" style="text-align:center;margin-top:18px">DryLine Field · works offline · data stays on this device</p>`;

  return {
    title: 'Settings',
    html,
    mount: (root) => {
      onAct(root, {
        company: () => companySheet(ctx),
        coefficients: () => coefficientsSheet(ctx),
        'reset-coefficients': async () => {
          if (await confirmDialog('Reset sizing coefficients to the defaults?', { confirmLabel: 'Reset' })) {
            await store.setSetting('coefficients', null);
            toast('Reset.', 'success');
            ctx.refresh();
          }
        },
        prices: () => priceSheet(ctx),
        'labor-rates': () => laborRatesSheet(ctx),
        'sync-settings': () => syncSheet(ctx),
        'sync-now': async () => {
          const result = await store.syncNow();
          if (result.skipped) toast(result.reason, 'warn');
          else toast(`${result.sent} change(s) synced${result.errors.length ? `, ${result.errors.length} failed` : ''}.`,
            result.errors.length ? 'warn' : 'success');
          ctx.refresh();
        },
        backup: () => backup(),
        restore: () => restore(ctx),
      });
    },
  };
}

const row = (label, value) => `<div class="card-row"><span class="label">${esc(label)}</span>
  <span class="value">${esc(value || '—')}</span></div>`;

/* ------------------------------------------------------------------ */

async function companySheet(ctx) {
  const s = ctx.settings;
  const values = await formSheet({
    title: 'Company & technician',
    fields: [
      { name: 'companyName', label: 'Company', type: 'text', full: true, value: s.companyName },
      { name: 'companyPhone', label: 'Phone', type: 'tel', value: s.companyPhone },
      { name: 'companyLicense', label: 'Licence #', type: 'text', value: s.companyLicense },
      { name: 'techName', label: 'Your name', type: 'text', value: s.techName },
      { name: 'techCertification', label: 'Certification', type: 'text', value: s.techCertification, placeholder: 'IICRC WRT #' },
      { name: 'mileageRate', label: 'Mileage rate ($/mi)', type: 'number', value: s.mileageRate, step: '0.01' },
    ],
  });
  if (!values) return;
  await store.setSettings(values);
  toast('Saved.', 'success');
  ctx.refresh();
}

async function coefficientsSheet(ctx) {
  const current = ctx.settings.coefficients || DEFAULT_COEFFICIENTS;
  const fields = [];
  for (const c of [1, 2, 3, 4]) {
    const am = current.airMover?.[c] || DEFAULT_COEFFICIENTS.airMover[c];
    fields.push(
      { name: `sq${c}`, label: `Class ${c} — ft² per mover`, type: 'number', value: am.sqftPerAirMover },
      { name: `lf${c}`, label: `Class ${c} — lf per mover`, type: 'number', value: am.lfWallPerAirMover },
      { name: `lgr${c}`, label: `Class ${c} — ft³ per LGR pint`, type: 'number',
        value: current.dehuFactor?.lgr?.[c] ?? DEFAULT_COEFFICIENTS.dehuFactor.lgr[c] },
      { name: `conv${c}`, label: `Class ${c} — ft³ per conventional pint`, type: 'number',
        value: current.dehuFactor?.conventional?.[c] ?? DEFAULT_COEFFICIENTS.dehuFactor.conventional[c] },
    );
  }

  const values = await formSheet({
    title: 'Sizing coefficients',
    intro: 'Lower numbers mean more equipment. A smaller ft³-per-pint figure calls for more dehumidification.',
    fields,
  });
  if (!values) return;

  const coefficients = {
    airMover: {}, dehuFactor: { lgr: {}, conventional: {} },
    desiccantAch: { ...DEFAULT_COEFFICIENTS.desiccantAch, ...(current.desiccantAch || {}) },
    scrubberAch: { ...DEFAULT_COEFFICIENTS.scrubberAch, ...(current.scrubberAch || {}) },
  };
  for (const c of [1, 2, 3, 4]) {
    coefficients.airMover[c] = {
      sqftPerAirMover: Math.max(1, num(values[`sq${c}`], DEFAULT_COEFFICIENTS.airMover[c].sqftPerAirMover)),
      lfWallPerAirMover: Math.max(1, num(values[`lf${c}`], DEFAULT_COEFFICIENTS.airMover[c].lfWallPerAirMover)),
    };
    coefficients.dehuFactor.lgr[c] = Math.max(1, num(values[`lgr${c}`], DEFAULT_COEFFICIENTS.dehuFactor.lgr[c]));
    coefficients.dehuFactor.conventional[c] = Math.max(1, num(values[`conv${c}`], DEFAULT_COEFFICIENTS.dehuFactor.conventional[c]));
  }
  await store.setSetting('coefficients', coefficients);
  toast('Coefficients saved.', 'success');
  ctx.refresh();
}

async function priceSheet(ctx) {
  const priceList = { ...(ctx.settings.priceList || {}) };
  const groups = [...new Set(LINE_ITEM_CATALOG.map((c) => c.group))];

  const picked = await sheet({
    title: 'Price list',
    size: 'full',
    body: `<p class="dialog-text">Tap an item to set your code and unit price.</p>
      ${groups.map((g) => `<h3 style="margin:14px 0 6px">${esc(g)}</h3>
        ${LINE_ITEM_CATALOG.filter((c) => c.group === g).map((c) => {
          const custom = priceList[c.id] || {};
          return `<button class="list-item" data-pick="${esc(c.id)}">
              <span class="grow">
                <span class="title">${esc(custom.code || c.code)} — ${esc(c.description)}</span>
                <span class="meta">${esc(c.unit)} · ${money(custom.unitPrice ?? c.unitPrice)}${custom.unitPrice != null ? ' · customised' : ''}</span>
              </span><span class="chev">›</span>
            </button>`;
        }).join('')}`).join('')}`,
    onMount: ({ root, close }) => {
      root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pick]');
        if (btn) close(btn.dataset.pick);
      });
    },
    actions: [{ label: 'Done', value: null }],
  });
  if (!picked) return;

  const item = catalogById(picked);
  const custom = priceList[picked] || {};
  const values = await formSheet({
    title: item.description,
    fields: [
      { name: 'code', label: 'Code', type: 'text', full: true, value: custom.code ?? item.code,
        hint: 'Match the selector your estimating platform uses.' },
      { name: 'unitPrice', label: `Unit price per ${item.unit}`, type: 'number', full: true, step: '0.01',
        value: custom.unitPrice ?? item.unitPrice },
    ],
  });
  if (values) {
    priceList[picked] = { code: values.code, unitPrice: num(values.unitPrice, item.unitPrice) };
    await store.setSetting('priceList', priceList);
    toast('Price saved.', 'success');
  }
  ctx.settings.priceList = priceList;
  await priceSheet(ctx); // stay in the list — pricing is done in a batch
}

async function laborRatesSheet(ctx) {
  const rates = { ...(ctx.settings.laborRates || {}) };
  const values = await formSheet({
    title: 'Labour rates',
    fields: Object.entries(LABOR_ROLES).map(([key, r]) => ({
      name: key, label: r.label, type: 'number', step: '0.01',
      value: rates[key] ?? r.defaultRate,
    })),
  });
  if (!values) return;
  await store.setSetting('laborRates', values);
  toast('Rates saved.', 'success');
  ctx.refresh();
}

async function syncSheet(ctx) {
  const values = await formSheet({
    title: 'Sync',
    intro: 'Optional. Without this, everything stays on the device and nothing leaves it.',
    fields: [
      { name: 'syncEndpoint', label: 'Endpoint URL', type: 'text', full: true, value: ctx.settings.syncEndpoint,
        placeholder: 'https://api.example.com' },
      { name: 'syncToken', label: 'Bearer token', type: 'text', full: true, value: ctx.settings.syncToken },
    ],
  });
  if (!values) return;
  await store.setSettings(values);
  toast('Sync settings saved.', 'success');
  ctx.refresh();
}

async function backup() {
  const payload = await store.exportAll();
  const name = `dryline-backup-${new Date().toISOString().slice(0, 10)}.json`;
  await shareOrDownload({ filename: name, text: JSON.stringify(payload), title: 'DryLine backup', mime: 'application/json' });
}

async function restore(ctx) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.style.display = 'none';
  document.body.appendChild(input);

  const file = await new Promise((resolve) => {
    input.addEventListener('change', () => { resolve(input.files?.[0] || null); input.remove(); });
    input.click();
  });
  if (!file) return;

  try {
    const payload = JSON.parse(await file.text());
    const result = await store.importAll(payload);
    toast(`Restored ${result.jobs} job(s) and ${result.photos} photo(s).`, 'success');
    ctx.refresh();
  } catch (err) {
    toast(err.message || 'Could not read that file.', 'error');
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / 1048576;
  return mb > 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}
