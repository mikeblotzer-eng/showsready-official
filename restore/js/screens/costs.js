// Job costing — what this job spent, and what gets billed back.

import { store } from '../store.js';
import { openForm, card, cardHead, emptyState, pill, stat, openSheet, confirmDialog } from '../ui.js';
import { putPhoto, photoUrl, compressImage, deletePhoto } from '../idb.js';
import { esc, fmtDate, todayISO, uid, toast, money, round, csv, download, nowISO } from '../util.js';

const CATEGORIES = [
  { value: 'fuel', label: 'Fuel', code: 'FUEL' },
  { value: 'supplies', label: 'Supplies & consumables', code: 'MAT-SUP' },
  { value: 'ppe', label: 'PPE', code: 'MAT-PPE' },
  { value: 'equipment_rental', label: 'Equipment rental', code: 'EQ-RENT' },
  { value: 'disposal', label: 'Disposal / dumpster', code: 'DISP' },
  { value: 'subcontractor', label: 'Subcontractor', code: 'SUB' },
  { value: 'lodging', label: 'Lodging & per diem', code: 'TRAVEL' },
  { value: 'permits', label: 'Permits & fees', code: 'PERMIT' },
  { value: 'other', label: 'Other', code: 'MISC' },
];
const catLabel = (v) => CATEGORIES.find((c) => c.value === v)?.label || v;

async function paintReceipts(root) {
  for (const el of root.querySelectorAll('[data-receipt]')) {
    if (el.dataset.painted) continue;
    const url = await photoUrl(el.dataset.receipt);
    if (url) { el.querySelector('img').src = url; el.dataset.painted = '1'; }
  }
}

export default {
  id: 'costs',
  title: 'Job costs',

  render(ctx) {
    const { job, d, settings } = ctx;
    const expenses = [...(job.expenses || [])].sort((a, b) => String(b.dateISO).localeCompare(String(a.dateISO)));
    const m = d.money;

    const byCat = new Map();
    for (const x of expenses) {
      const key = x.category;
      byCat.set(key, round((byCat.get(key) || 0) + (Number(x.amount) || 0), 2));
    }

    const labor = round((job.dailies || []).reduce((t, x) => t + (Number(x.hours) || 0) * (Number(x.techs) || 1), 0) * (settings.laborCost || 32), 2);
    const totalCost = round(m.expenseTotal + labor + m.miles * (settings.vehicleCostPerMile || 0.32), 2);
    const grossProfit = round(m.total - totalCost, 2);

    return `
      ${card(`${cardHead('Profitability', pill(`${m.total > 0 ? round((grossProfit / m.total) * 100, 1) : 0}% GP`, grossProfit > 0 ? 'good' : 'bad'))}
        <div class="grid-3">
          ${stat('Billed', money(m.total, { cents: false }), 'estimate total')}
          ${stat('Cost', money(totalCost, { cents: false }), 'materials, labor, vehicle')}
          ${stat('Gross profit', money(grossProfit, { cents: false }))}
        </div>
        <div style="margin-top:12px">
          <div class="kv"><span>Purchases &amp; subs</span><span>${money(m.expenseTotal)}</span></div>
          <div class="kv"><span>Field labor at cost</span><span>${money(labor)}</span></div>
          <div class="kv"><span>Vehicle — ${m.miles} mi</span><span>${money(m.miles * (settings.vehicleCostPerMile || 0.32))}</span></div>
          <div class="kv"><span class="strong">Total job cost</span><span class="strong">${money(totalCost)}</span></div>
        </div>
        <p class="tiny" style="margin-top:8px">Labor and vehicle cost rates are set in Settings. Billable purchases carry their markup onto the estimate.</p>
      `)}

      ${card(`${cardHead('Purchases', `<button class="btn btn--sm btn--primary" data-add>+ Expense</button>`)}
        ${expenses.length ? `<div class="list">${expenses.map((x) => `
          <button class="list-item" data-expense="${x.id}">
            ${x.receiptBlobId
              ? `<div class="list-item__icon" data-receipt="${esc(x.receiptBlobId)}" style="padding:0;overflow:hidden"><img alt="receipt" style="width:100%;height:100%;object-fit:cover"></div>`
              : `<div class="list-item__icon">🧾</div>`}
            <div class="list-item__main">
              <strong>${esc(x.description || catLabel(x.category))}</strong>
              <small>${esc(fmtDate(x.dateISO))} · ${esc(x.vendor || 'vendor')} · ${esc(catLabel(x.category))}${x.billable ? ` · billable${x.markup ? ` +${x.markup}%` : ''}` : ' · absorbed'}</small>
            </div>
            <div class="list-item__right">${money(x.amount)}</div>
          </button>`).join('')}</div>`
          : emptyState('🧾', 'No purchases logged', 'Snap the receipt at the counter. Fuel, poly, tape, PPE, dumpsters — if it was bought for this job it belongs here.')}
        ${expenses.length ? `<div class="row row--wrap" style="margin-top:12px">
          <button class="btn btn--sm" data-export>Export CSV</button>
        </div>` : ''}
        <input type="file" accept="image/*" capture="environment" id="receiptInput" hidden>
      `)}

      ${byCat.size ? card(`${cardHead('By category')}
        ${[...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `
          <div class="kv"><span>${esc(catLabel(k))}</span><span>${money(v)}</span></div>`).join('')}
      `) : ''}

      ${card(`${cardHead('Payables owed on this job')}
        ${(job.expenses || []).filter((x) => !x.paid).length
          ? `<div class="list">${job.expenses.filter((x) => !x.paid).map((x) => `
            <div class="list-item">
              <div class="list-item__icon">⏳</div>
              <div class="list-item__main"><strong>${esc(x.vendor || 'Vendor')}</strong><small>${esc(x.description || catLabel(x.category))} · ${esc(fmtDate(x.dateISO))}</small></div>
              <div class="list-item__right">${money(x.amount)}</div>
            </div>`).join('')}</div>`
          : '<p class="muted">Everything logged has been marked paid.</p>'}
      `)}
    `;
  },

  mount(root, ctx) {
    const { job } = ctx;
    paintReceipts(root);
    let pendingReceipt = null;

    const receiptInput = root.querySelector('#receiptInput');

    async function captureReceipt() {
      return new Promise((resolve) => {
        receiptInput.value = '';
        receiptInput.onchange = async () => {
          const file = receiptInput.files?.[0];
          if (!file) return resolve(null);
          try {
            const blob = await compressImage(file, 1400, 0.7);
            const blobId = uid('rcpt');
            await putPhoto(blobId, blob);
            resolve(blobId);
          } catch (err) {
            toast(`Receipt not saved: ${err.message}`, 'bad');
            resolve(null);
          }
        };
        receiptInput.click();
      });
    }

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-add]')) {
        const res = await openForm({
          title: 'Log an expense',
          fields: [
            { k: 'dateISO', label: 'Date', type: 'date', value: todayISO(), half: true },
            { k: 'amount', label: 'Amount', type: 'number', required: true, half: true },
            { k: 'category', label: 'Category', type: 'select', options: CATEGORIES, value: 'supplies' },
            { k: 'vendor', label: 'Vendor', type: 'text', half: true, placeholder: 'Home Depot' },
            { k: 'description', label: 'What was bought', type: 'text', half: true },
            { k: 'billable', label: 'Bill back to the job', type: 'checkbox', value: true },
            { k: 'markup', label: 'Markup %', type: 'number', value: 0, half: true },
            { k: 'paid', label: 'Already paid', type: 'checkbox', value: true },
            { k: 'method', label: 'Paid with', type: 'select', half: true, options: ['Company card', 'Personal — reimburse', 'Check', 'Account / terms', 'Cash'] },
          ],
        });
        if (!res) return;
        const wantsReceipt = await confirmDialog({
          title: 'Attach the receipt?',
          message: 'A photo of the receipt makes this reimbursable and keeps the file clean for an audit.',
          confirmLabel: 'Take photo',
        });
        let receiptBlobId = null;
        if (wantsReceipt) receiptBlobId = await captureReceipt();
        const cat = CATEGORIES.find((c) => c.value === res.category);
        store.updateJob(job.id, (j) => {
          j.expenses.push({
            id: uid('exp'), ts: nowISO(), ...res,
            amount: Number(res.amount), markup: Number(res.markup) || 0,
            code: cat?.code || 'MISC', receiptBlobId,
          });
        });
        toast('Expense logged', 'good');
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-export]')) {
        const rows = [['Date', 'Vendor', 'Category', 'Description', 'Amount', 'Billable', 'Markup %', 'Billed amount', 'Paid', 'Method', 'Receipt']];
        for (const x of job.expenses) {
          rows.push([x.dateISO, x.vendor || '', catLabel(x.category), x.description || '',
            x.amount, x.billable ? 'Y' : 'N', x.markup || 0,
            round((Number(x.amount) || 0) * (x.billable ? 1 + (Number(x.markup) || 0) / 100 : 0), 2),
            x.paid ? 'Y' : 'N', x.method || '', x.receiptBlobId ? 'attached' : '']);
        }
        download(`${job.jobNumber}-expenses.csv`, 'text/csv', csv(rows));
        toast('Exported');
        return;
      }

      const expEl = e.target.closest('[data-expense]');
      if (expEl) {
        const x = job.expenses.find((y) => y.id === expEl.dataset.expense);
        if (!x) return;
        const url = x.receiptBlobId ? await photoUrl(x.receiptBlobId) : null;
        const res = await openForm({
          title: x.description || catLabel(x.category),
          deleteLabel: 'Delete expense',
          fields: [
            ...(url ? [{ k: 'receipt', label: 'Receipt', type: 'static', html: `<img src="${url}" style="max-width:100%;border-radius:10px">` }] : []),
            { k: 'dateISO', label: 'Date', type: 'date', value: x.dateISO, half: true },
            { k: 'amount', label: 'Amount', type: 'number', value: x.amount, half: true },
            { k: 'category', label: 'Category', type: 'select', options: CATEGORIES, value: x.category },
            { k: 'vendor', label: 'Vendor', type: 'text', value: x.vendor, half: true },
            { k: 'description', label: 'Description', type: 'text', value: x.description, half: true },
            { k: 'billable', label: 'Bill back to the job', type: 'checkbox', value: x.billable },
            { k: 'markup', label: 'Markup %', type: 'number', value: x.markup, half: true },
            { k: 'paid', label: 'Paid', type: 'checkbox', value: x.paid },
          ],
        });
        if (!res) return;
        store.updateJob(job.id, (j) => {
          if (res.__delete) {
            if (x.receiptBlobId) deletePhoto(x.receiptBlobId).catch(() => {});
            j.expenses = j.expenses.filter((y) => y.id !== x.id);
            return;
          }
          Object.assign(j.expenses.find((y) => y.id === x.id), {
            ...res, amount: Number(res.amount), markup: Number(res.markup) || 0,
          });
        });
        ctx.refresh();
      }
    });
  },
};
