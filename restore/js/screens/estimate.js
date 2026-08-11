// Estimate: line items, suggested items pulled from job data, and invoicing.

import { store } from '../store.js';
import { openForm, card, cardHead, emptyState, pill, stat, actionSheet, confirmDialog } from '../ui.js';
import { buildAutoLines, lineTotal, estimateExportRows } from '../derive.js';
import { esc, money, uid, toast, csv, download, round, todayISO, fmtDate, nowISO } from '../util.js';

const UNITS = ['ea', 'sf', 'lf', 'sy', 'hr', 'day', 'unit-day', 'mi', 'cf', 'item'];

const PRICE_BOOK = [
  { code: 'WTR-EXT', description: 'Water extraction from carpeted floor', unit: 'sf', unitPrice: 0.55 },
  { code: 'WTR-EXTH', description: 'Heavy water extraction — saturated', unit: 'sf', unitPrice: 0.85 },
  { code: 'WTR-RMCP', description: 'Remove and dispose of carpet', unit: 'sf', unitPrice: 0.35 },
  { code: 'WTR-RMPD', description: 'Remove and dispose of carpet cushion', unit: 'sf', unitPrice: 0.28 },
  { code: 'WTR-BASE', description: 'Detach and reset baseboard', unit: 'lf', unitPrice: 1.10 },
  { code: 'WTR-FC2', description: 'Drywall flood cut — 2 ft', unit: 'lf', unitPrice: 3.20 },
  { code: 'WTR-FC4', description: 'Drywall flood cut — 4 ft', unit: 'lf', unitPrice: 4.10 },
  { code: 'WTR-RMIN', description: 'Remove wet insulation', unit: 'sf', unitPrice: 0.62 },
  { code: 'WTR-ANTI', description: 'Apply antimicrobial agent', unit: 'sf', unitPrice: 0.32 },
  { code: 'WTR-HEPA', description: 'HEPA vacuuming of affected surfaces', unit: 'sf', unitPrice: 0.45 },
  { code: 'WTR-CONT', description: 'Containment barrier — poly and framing', unit: 'sf', unitPrice: 1.45 },
  { code: 'WTR-ZIP', description: 'Zipper door for containment', unit: 'ea', unitPrice: 32.00 },
  { code: 'WTR-AM', description: 'Air mover — per day', unit: 'unit-day', unitPrice: 26.50 },
  { code: 'WTR-DHM', description: 'LGR dehumidifier (70 AHAM) — per day', unit: 'unit-day', unitPrice: 78.00 },
  { code: 'WTR-DHL', description: 'LGR dehumidifier (110 AHAM) — per day', unit: 'unit-day', unitPrice: 95.00 },
  { code: 'WTR-AFD', description: 'HEPA air scrubber — per day', unit: 'unit-day', unitPrice: 78.00 },
  { code: 'WTR-MON', description: 'Daily monitoring visit', unit: 'ea', unitPrice: 65.00 },
  { code: 'WTR-LAB', description: 'Restoration technician — per hour', unit: 'hr', unitPrice: 62.00 },
  { code: 'WTR-LABA', description: 'Technician after hours — per hour', unit: 'hr', unitPrice: 93.00 },
  { code: 'WTR-EMER', description: 'Emergency service call', unit: 'ea', unitPrice: 185.00 },
  { code: 'WTR-PPE', description: 'PPE — per technician per day', unit: 'ea', unitPrice: 24.00 },
  { code: 'WTR-DUMP', description: 'Debris disposal / dumpster', unit: 'ea', unitPrice: 165.00 },
  { code: 'WTR-MILE', description: 'Mileage', unit: 'mi', unitPrice: 0.70 },
];

function lineFields(line = {}, rooms = []) {
  return [
    { k: 'code', label: 'Code', type: 'text', value: line.code || '', half: true },
    { k: 'unit', label: 'Unit', type: 'select', value: line.unit || 'ea', options: UNITS, half: true },
    { k: 'description', label: 'Description', type: 'text', value: line.description || '', required: true },
    { k: 'qty', label: 'Quantity', type: 'number', value: line.qty ?? 1, half: true, required: true },
    { k: 'unitPrice', label: 'Unit price', type: 'number', value: line.unitPrice ?? 0, half: true, required: true },
    { k: 'room', label: 'Room / area', type: 'select', value: line.room || '', options: [{ value: '', label: 'Whole job' }, ...rooms.map((r) => ({ value: r.name, label: r.name }))], half: true },
    { k: 'taxable', label: 'Taxable', type: 'checkbox', value: !!line.taxable },
    { k: 'note', label: 'Note', type: 'text', value: line.note || '' },
  ];
}

export default {
  id: 'estimate',
  title: 'Estimate',

  render(ctx) {
    const { job, d, settings } = ctx;
    const lines = job.estimate.lines || [];
    const auto = buildAutoLines(job, settings, d).filter((a) =>
      !lines.some((l) => l.code === a.code && Math.abs((l.qty || 0) - a.qty) < 0.01));
    const m = d.money;

    const byRoom = new Map();
    for (const l of lines) {
      const key = l.room || 'General';
      if (!byRoom.has(key)) byRoom.set(key, []);
      byRoom.get(key).push(l);
    }

    return `
      ${card(`${cardHead('Estimate', pill(money(m.total), 'good'))}
        <div class="grid-3">
          ${stat('Line items', String(lines.length))}
          ${stat('Subtotal', money(m.subtotal, { cents: false }))}
          ${stat('Margin', `${m.margin}%`, `${money(m.expenseTotal, { cents: false })} cost`)}
        </div>
        <div style="margin-top:12px">
          <div class="kv"><span>Subtotal</span><span>${money(m.subtotal)}</span></div>
          ${settings.applyOandP ? `<div class="kv"><span>Overhead ${settings.overhead}%</span><span>${money(m.oh)}</span></div>
          <div class="kv"><span>Profit ${settings.profit}%</span><span>${money(m.profit)}</span></div>` : ''}
          ${settings.taxRate ? `<div class="kv"><span>Tax ${settings.taxRate}%</span><span>${money(m.tax)}</span></div>` : ''}
          <div class="kv"><span class="strong">Total</span><span class="strong">${money(m.total)}</span></div>
        </div>
        <div class="row row--wrap" style="margin-top:12px">
          <button class="btn btn--sm btn--primary" data-add>+ Line item</button>
          <button class="btn btn--sm" data-book>Price list</button>
          <button class="btn btn--sm" data-export>Export</button>
          <button class="btn btn--sm" data-invoice>Create invoice</button>
        </div>
      `)}

      ${auto.length ? card(`${cardHead('Suggested from job data', pill(`${auto.length}`, 'info'))}
        <p class="muted">Built from the equipment on the plan, the daily logs, the affected area and the category of water. Review before adding — nothing is billed without you.</p>
        <div class="list" style="margin-top:10px">
          ${auto.map((a, i) => `
            <button class="list-item" data-auto="${i}">
              <div class="list-item__icon">+</div>
              <div class="list-item__main">
                <strong>${esc(a.description)}</strong>
                <small>${esc(a.code)} · ${a.qty} ${esc(a.unit)} @ ${money(a.unitPrice)} · from ${esc(a.source)}</small>
              </div>
              <div class="list-item__right">${money(a.qty * a.unitPrice, { cents: false })}</div>
            </button>`).join('')}
        </div>
        <button class="btn btn--sm btn--primary btn--block" data-add-all style="margin-top:10px">Add all ${auto.length} to the estimate</button>
      `) : ''}

      ${lines.length ? [...byRoom.entries()].map(([roomName, items]) => card(`
        ${cardHead(roomName, `<span class="tiny">${money(items.reduce((t, l) => t + lineTotal(l), 0))}</span>`)}
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Code</th><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
          <tbody>${items.map((l) => `<tr data-edit data-line="${l.id}">
            <td class="mono tiny">${esc(l.code || '')}</td>
            <td>${esc(l.description)}${l.note ? `<br><span class="tiny">${esc(l.note)}</span>` : ''}</td>
            <td class="num">${l.qty} ${esc(l.unit || '')}</td>
            <td class="num">${money(l.unitPrice)}</td>
            <td class="num strong">${money(lineTotal(l))}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      `)).join('') : card(emptyState('🧾', 'No line items yet',
        'Add the suggested items above, pull from the price list, or write your own. Quantities come from the sketch, so the estimate matches the documentation.'))}

      ${card(`${cardHead('Invoices & receivables', pill(money(m.receivable, { cents: false }), m.receivable > 0 ? 'warn' : 'good'))}
        ${(job.invoices || []).length ? `<div class="list">${job.invoices.map((inv) => {
          const paid = (inv.payments || []).reduce((t, p) => t + (Number(p.amount) || 0), 0);
          const bal = round((Number(inv.amount) || 0) - paid, 2);
          return `<button class="list-item" data-invoice-id="${inv.id}">
            <div class="list-item__icon">${bal <= 0.01 ? '✅' : '🧾'}</div>
            <div class="list-item__main">
              <strong>Invoice ${esc(inv.number)}</strong>
              <small>${esc(fmtDate(inv.dateISO))} · ${esc(inv.billTo || 'client')}${inv.terms ? ` · ${esc(inv.terms)}` : ''}</small>
            </div>
            <div class="list-item__right">${money(inv.amount, { cents: false })}<div class="tiny">${bal <= 0.01 ? 'paid' : `${money(bal, { cents: false })} due`}</div></div>
          </button>`;
        }).join('')}</div>
        ${m.aging.length ? `<div class="callout callout--warn" style="margin-top:10px">Outstanding: ${m.aging.map((a) => `${money(a.balance, { cents: false })} at ${a.days} days (${a.bucket})`).join(', ')}</div>` : ''}`
        : '<p class="muted">No invoices yet. Create one from the estimate total once the work is approved.</p>'}
      `)}
    `;
  },

  mount(root, ctx) {
    const { job, settings, d } = ctx;

    const addLine = (line) => store.updateJob(job.id, (j) => {
      j.estimate.lines.push({ id: uid('line'), ...line });
    });

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-add]')) {
        const res = await openForm({ title: 'Line item', fields: lineFields({}, job.plan.rooms) });
        if (res) { addLine(res); ctx.refresh(); }
        return;
      }

      if (e.target.closest('[data-book]')) {
        const choice = await actionSheet({
          title: 'Price list',
          actions: PRICE_BOOK.map((p) => ({
            id: p.code, label: p.description, icon: '＋',
            hint: `${p.code} · ${money(p.unitPrice)} / ${p.unit}`,
          })),
        });
        if (!choice) return;
        const item = PRICE_BOOK.find((p) => p.code === choice);
        const res = await openForm({ title: item.description, fields: lineFields(item, job.plan.rooms) });
        if (res) { addLine(res); ctx.refresh(); }
        return;
      }

      const autoBtn = e.target.closest('[data-auto]');
      if (autoBtn) {
        const auto = buildAutoLines(job, settings, d);
        const a = auto[Number(autoBtn.dataset.auto)];
        if (!a) return;
        const res = await openForm({ title: 'Add suggested item', subtitle: `From ${a.source}`, fields: lineFields(a, job.plan.rooms) });
        if (res) { addLine(res); toast('Added'); ctx.refresh(); }
        return;
      }

      if (e.target.closest('[data-add-all]')) {
        const auto = buildAutoLines(job, settings, d);
        const existing = job.estimate.lines || [];
        const toAdd = auto.filter((a) => !existing.some((l) => l.code === a.code && Math.abs((l.qty || 0) - a.qty) < 0.01));
        store.updateJob(job.id, (j) => {
          for (const a of toAdd) j.estimate.lines.push({ id: uid('line'), ...a });
        });
        toast(`${toAdd.length} item${toAdd.length === 1 ? '' : 's'} added`, 'good');
        ctx.refresh();
        return;
      }

      const lineEl = e.target.closest('[data-line]');
      if (lineEl) {
        const line = job.estimate.lines.find((l) => l.id === lineEl.dataset.line);
        if (!line) return;
        const res = await openForm({
          title: 'Edit line item',
          deleteLabel: 'Delete line',
          fields: lineFields(line, job.plan.rooms),
        });
        if (!res) return;
        store.updateJob(job.id, (j) => {
          if (res.__delete) { j.estimate.lines = j.estimate.lines.filter((l) => l.id !== line.id); return; }
          Object.assign(j.estimate.lines.find((l) => l.id === line.id), res);
        });
        ctx.refresh();
        return;
      }

      if (e.target.closest('[data-export]')) {
        const choice = await actionSheet({
          title: 'Export estimate',
          actions: [
            { id: 'csv', label: 'CSV for the estimating platform', icon: '📄', hint: 'Codes, quantities and prices, one row per line item' },
            { id: 'json', label: 'JSON — full job data', icon: '{ }', hint: 'Sketch, readings, logs and money' },
            { id: 'text', label: 'Plain text summary', icon: '✉️', hint: 'Paste into an email' },
          ],
        });
        if (choice === 'csv') {
          download(`${job.jobNumber}-estimate.csv`, 'text/csv', csv(estimateExportRows(job, settings)));
          toast('Exported');
        } else if (choice === 'json') {
          download(`${job.jobNumber}.json`, 'application/json', JSON.stringify(job, null, 2));
          toast('Exported');
        } else if (choice === 'text') {
          const text = [
            `${job.site.name || job.site.address} — job ${job.jobNumber}`,
            `Claim ${job.carrier.claimNumber || '—'} · Category ${d.category} · Class ${d.cls}`,
            '',
            ...(job.estimate.lines || []).map((l) =>
              `${(l.code || '').padEnd(10)} ${l.description} — ${l.qty} ${l.unit} @ ${money(l.unitPrice)} = ${money(lineTotal(l))}`),
            '',
            `Subtotal ${money(d.money.subtotal)}`,
            settings.applyOandP ? `Overhead & profit ${money(d.money.oh + d.money.profit)}` : '',
            settings.taxRate ? `Tax ${money(d.money.tax)}` : '',
            `Total ${money(d.money.total)}`,
          ].filter(Boolean).join('\n');
          try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'good'); }
          catch { download(`${job.jobNumber}-estimate.txt`, 'text/plain', text); }
        }
        return;
      }

      if (e.target.closest('[data-invoice]')) {
        const num = `${job.jobNumber}-${String((job.invoices || []).length + 1).padStart(2, '0')}`;
        const res = await openForm({
          title: 'Create invoice',
          fields: [
            { k: 'number', label: 'Invoice number', type: 'text', value: num, half: true },
            { k: 'dateISO', label: 'Date', type: 'date', value: todayISO(), half: true },
            { k: 'amount', label: 'Amount', type: 'number', value: d.money.total, half: true, required: true },
            { k: 'terms', label: 'Terms', type: 'select', value: 'Net 30', half: true, options: ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60'] },
            { k: 'billTo', label: 'Bill to', type: 'select', value: job.carrier.name ? 'Carrier' : 'Client', options: ['Client', 'Carrier', 'Property manager', 'Other'] },
            { k: 'notes', label: 'Notes', type: 'textarea', rows: 2 },
          ],
        });
        if (!res) return;
        store.updateJob(job.id, (j) => {
          j.invoices.push({ id: uid('inv'), ...res, amount: Number(res.amount), payments: [], createdAt: nowISO() });
        });
        toast('Invoice created', 'good');
        ctx.refresh();
        return;
      }

      const invEl = e.target.closest('[data-invoice-id]');
      if (invEl) {
        const inv = job.invoices.find((x) => x.id === invEl.dataset.invoiceId);
        if (!inv) return;
        const paid = (inv.payments || []).reduce((t, p) => t + (Number(p.amount) || 0), 0);
        const bal = round((Number(inv.amount) || 0) - paid, 2);
        const res = await openForm({
          title: `Invoice ${inv.number}`,
          subtitle: `${money(inv.amount)} invoiced · ${money(paid)} paid · ${money(bal)} outstanding`,
          submitLabel: 'Record payment',
          deleteLabel: 'Delete invoice',
          fields: [
            { k: 'amount', label: 'Invoice amount', type: 'number', value: inv.amount, half: true },
            { k: 'terms', label: 'Terms', type: 'select', value: inv.terms, half: true, options: ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60'] },
            { k: 'sec', label: 'Record a payment', type: 'section' },
            { k: 'payment', label: 'Payment amount', type: 'number', half: true, value: bal > 0 ? bal : '' },
            { k: 'method', label: 'Method', type: 'select', half: true, options: ['Check', 'ACH', 'Card', 'Cash', 'Carrier draft'] },
            { k: 'ref', label: 'Reference / check #', type: 'text' },
          ],
        });
        if (!res) return;
        store.updateJob(job.id, (j) => {
          if (res.__delete) { j.invoices = j.invoices.filter((x) => x.id !== inv.id); return; }
          const target = j.invoices.find((x) => x.id === inv.id);
          target.amount = Number(res.amount);
          target.terms = res.terms;
          if (res.payment) {
            target.payments = target.payments || [];
            target.payments.push({ id: uid('pay'), amount: Number(res.payment), method: res.method, ref: res.ref, dateISO: todayISO() });
          }
        });
        toast(res.payment ? 'Payment recorded' : 'Invoice updated', 'good');
        ctx.refresh();
      }
    });
  },
};
