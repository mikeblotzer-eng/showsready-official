// Company, rates and device data.

import { store, DEFAULT_SETTINGS } from '../store.js';
import { openForm, card, cardHead, confirmDialog, row } from '../ui.js';
import { esc, money, download, toast } from '../util.js';

export default {
  id: 'settings',
  title: 'Settings',

  render(ctx) {
    const s = store.settings;
    const jobs = store.jobs;
    const bytes = (() => {
      try { return new Blob([store.exportAll()]).size; } catch { return 0; }
    })();

    return `
      ${card(`${cardHead('Company', `<button class="btn btn--sm" data-edit="company">Edit</button>`)}
        ${row('Company', esc(s.company || '—'))}
        ${row('Phone', esc(s.companyPhone || '—'))}
        ${row('Email', esc(s.companyEmail || '—'))}
        ${row('License', esc(s.license || '—'))}
        ${row('Technician', esc(s.techName || '—'))}
      `)}

      ${card(`${cardHead('Rates', `<button class="btn btn--sm" data-edit="rates">Edit</button>`)}
        ${row('Mileage billed', `${money(s.mileageRate)}/mi`)}
        ${row('Vehicle cost', `${money(s.vehicleCostPerMile || 0.32)}/mi`)}
        ${row('Labor billed', `${money(s.laborRate)}/hr`)}
        ${row('Labor cost', `${money(s.laborCost || 32)}/hr`)}
        ${row('Tax rate', `${s.taxRate}%`)}
        ${row('Overhead & profit', s.applyOandP ? `${s.overhead}% + ${s.profit}%` : 'not applied')}
      `)}

      ${card(`${cardHead('Drying defaults', `<button class="btn btn--sm" data-edit="drying">Edit</button>`)}
        ${row('Dehumidification', s.dehuKind === 'lgr' ? 'LGR refrigerant' : s.dehuKind === 'desiccant' ? 'Desiccant' : 'Conventional refrigerant')}
        ${row('Goal tolerance', `${s.tolerance} points over the dry standard`)}
        ${row('Site elevation', `${s.elevationFt} ft`)}
        <p class="tiny" style="margin-top:8px">Elevation corrects the barometric pressure used for grains per pound. It matters above about 2,000 feet.</p>
      `)}

      ${card(`${cardHead('Data on this device')}
        ${row('Jobs', String(jobs.length))}
        ${row('Storage used', `${(bytes / 1024).toFixed(0)} KB`)}
        <p class="muted" style="margin-top:10px">Everything is stored on this device — it works with no signal and nothing is uploaded. Back up before switching phones or clearing browser data.</p>
        <div class="row row--wrap" style="margin-top:12px">
          <button class="btn btn--sm btn--primary" data-backup>Export backup</button>
          <button class="btn btn--sm" data-restore>Import backup</button>
          <button class="btn btn--sm btn--danger-ghost" data-wipe style="margin:0">Erase everything</button>
        </div>
      `)}

      ${card(`${cardHead('About')}
        <p class="muted">DryPlan documents water losses in the field: floor plans with real dimensions, moisture mapping, drying calculations, monitoring, mileage, job costing and estimating.</p>
        <p class="muted" style="margin-top:8px">Classification and sizing follow the methods published in ANSI/IICRC S500. Every calculated value shows its arithmetic and can be overridden — conditions on site always win.</p>
        <p class="tiny" style="margin-top:8px">Install it from your browser's share menu ("Add to Home Screen") to run it full screen and offline.</p>
      `, 'card--flat')}
    `;
  },

  mount(root, ctx) {
    root.addEventListener('click', async (e) => {
      const editBtn = e.target.closest('[data-edit]');
      if (editBtn) {
        const s = store.settings;
        const which = editBtn.dataset.edit;
        const forms = {
          company: {
            title: 'Company & technician',
            fields: [
              { k: 'company', label: 'Company name', type: 'text', value: s.company },
              { k: 'companyPhone', label: 'Phone', type: 'tel', value: s.companyPhone, half: true },
              { k: 'companyEmail', label: 'Email', type: 'email', value: s.companyEmail, half: true },
              { k: 'companyAddress', label: 'Address', type: 'text', value: s.companyAddress },
              { k: 'license', label: 'License / certification number', type: 'text', value: s.license },
              { k: 'sec', label: 'Technician', type: 'section' },
              { k: 'techName', label: 'Your name', type: 'text', value: s.techName, half: true },
              { k: 'techPhone', label: 'Your phone', type: 'tel', value: s.techPhone, half: true },
              { k: 'techEmail', label: 'Your email', type: 'email', value: s.techEmail },
            ],
          },
          rates: {
            title: 'Rates',
            fields: [
              { k: 'mileageRate', label: 'Mileage billed per mile', type: 'number', value: s.mileageRate, half: true, hint: 'IRS business rate by default' },
              { k: 'vehicleCostPerMile', label: 'Vehicle cost per mile', type: 'number', value: s.vehicleCostPerMile ?? 0.32, half: true },
              { k: 'laborRate', label: 'Labor billed per hour', type: 'number', value: s.laborRate, half: true },
              { k: 'laborCost', label: 'Labor cost per hour', type: 'number', value: s.laborCost ?? 32, half: true },
              { k: 'taxRate', label: 'Tax rate %', type: 'number', value: s.taxRate, half: true },
              { k: 'applyOandP', label: 'Apply overhead and profit', type: 'checkbox', value: s.applyOandP },
              { k: 'overhead', label: 'Overhead %', type: 'number', value: s.overhead, half: true },
              { k: 'profit', label: 'Profit %', type: 'number', value: s.profit, half: true },
            ],
          },
          drying: {
            title: 'Drying defaults',
            fields: [
              { k: 'dehuKind', label: 'Dehumidification', type: 'segmented', value: s.dehuKind, options: [
                { value: 'lgr', label: 'LGR' }, { value: 'conventional', label: 'Conventional' }, { value: 'desiccant', label: 'Desiccant' }] },
              { k: 'tolerance', label: 'Goal tolerance (points over dry standard)', type: 'number', value: s.tolerance, half: true },
              { k: 'elevationFt', label: 'Site elevation (ft)', type: 'number', value: s.elevationFt, half: true },
            ],
          },
        };
        const res = await openForm(forms[which]);
        if (res) { store.saveSettings(res); ctx.refresh(); toast('Saved', 'good'); }
        return;
      }

      if (e.target.closest('[data-backup]')) {
        download(`dryplan-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', store.exportAll());
        toast('Backup exported', 'good');
        return;
      }

      if (e.target.closest('[data-restore]')) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          try {
            const n = store.importAll(await file.text(), { merge: true });
            toast(`Imported ${n} job${n === 1 ? '' : 's'}`, 'good');
            ctx.refresh();
          } catch (err) { toast(`Import failed: ${err.message}`, 'bad'); }
        };
        input.click();
        return;
      }

      if (e.target.closest('[data-wipe]')) {
        const ok = await confirmDialog({
          title: 'Erase everything?',
          message: 'Every job, sketch, reading and photo on this device is deleted. Export a backup first — this cannot be undone.',
          confirmLabel: 'Erase everything', destructive: true,
        });
        if (!ok) return;
        store.update((st) => { st.jobs = []; st.settings = { ...DEFAULT_SETTINGS }; });
        toast('Device cleared');
        ctx.navigate('#/jobs');
      }
    });
  },
};
