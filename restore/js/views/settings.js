/* Company defaults: rates, tech identity, storage. */

import { el, sheet, field, toast, num, round, download } from '../util.js';
import * as store from '../store.js';
import { storageEstimate } from '../db.js';
import { slug } from './jobs.js';

export function openSettings({ go }) {
  const { body, close } = sheet('Settings');
  const s = store.state.settings;

  const company = field('Company name', { value: s.companyName });
  const tech = field('Your name', { value: s.techName, hint: 'Pre-fills the technician on new dailies.' });
  const mileage = field('Mileage rate ($/mile)', { type: 'number', inputmode: 'decimal', step: '0.001', value: s.mileageRate });
  const elevation = field('Site elevation (ft)', { type: 'number', inputmode: 'numeric', value: s.elevationFt, hint: 'Only matters above ~2,000 ft, where thinner air shifts grain calculations.' });

  const eq = s.equipmentRates;
  const rateFields = store.EQUIPMENT_TYPES.map((t) => {
    const f = field(t.label, { type: 'number', inputmode: 'decimal', step: '0.01', value: eq[t.rateKey] ?? 0 });
    return { t, f };
  });

  const theme = field('Appearance', {
    type: 'select',
    value: document.documentElement.dataset.theme || 'auto',
    options: [{ value: 'auto', label: 'Match device' }, { value: 'dark', label: 'Always dark' }, { value: 'light', label: 'Always light' }],
  });
  theme.input.addEventListener('change', () => {
    const v = theme.input.value;
    if (v === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v;
    localStorage.setItem('restoremap.theme', v);
  });

  const storageLine = el('p', { class: 'mute tiny' });
  storageEstimate().then((est) => {
    if (!est) return;
    storageLine.textContent = `${(est.usage / 1048576).toFixed(1)} MB used of ${(est.quota / 1048576).toFixed(0)} MB available (${Math.round(est.pct)}%).`;
  });

  body.append(
    company.wrap, tech.wrap,
    el('div', { class: 'grid-2' }, mileage.wrap, elevation.wrap),
    theme.wrap,

    el('p', { class: 'eyebrow', style: 'margin:16px 0 8px', text: 'Equipment day rates' }),
    el('div', { class: 'grid-2' }, ...rateFields.map((r) => r.f.wrap)),

    el('p', { class: 'eyebrow', style: 'margin:16px 0 8px', text: 'Storage' }),
    storageLine,
    el('p', { class: 'mute tiny', style: 'margin-top:6px', text: 'All job data lives on this device. Export jobs regularly — clearing browser data deletes them.' }),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn-ghost btn-block btn-sm', onClick: () => exportAll() }, '⤓ Export all jobs'),

    el('div', { class: 'spacer' }),
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: async () => {
        const equipmentRates = {};
        for (const { t, f } of rateFields) equipmentRates[t.rateKey] = num(f.input.value, 0);
        await store.saveSettings({
          companyName: company.input.value.trim(),
          techName: tech.input.value.trim(),
          mileageRate: num(mileage.input.value, 0.7),
          elevationFt: num(elevation.input.value, 0),
          equipmentRates,
        });
        close();
        toast('Settings saved.', 'success');
      },
    }, 'Save settings'),

    el('div', { class: 'spacer' }),
    el('p', { class: 'mute tiny center', text: 'RestoreMap — sizing and classification follow IICRC S500 guidance. Always apply your own judgement and local requirements; this app documents decisions, it does not make them for you.' }),
  );
}

function exportAll() {
  const payload = {
    app: 'restoremap',
    schemaVersion: store.SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: store.state.settings,
    jobs: store.state.jobs,
  };
  download(`restoremap-all-jobs-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json');
  toast('All jobs exported.', 'success');
}

// Restore the saved theme preference before first paint of any view.
const saved = localStorage.getItem('restoremap.theme');
if (saved && saved !== 'auto') document.documentElement.dataset.theme = saved;
