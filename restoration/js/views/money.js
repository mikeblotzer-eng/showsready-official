/**
 * Estimate and job costing.
 *
 * The scope is generated from what the job already recorded — the sketch, the
 * equipment log, the dailies, the drives — so the quantities are defensible.
 * Everything remains editable, and the CSV is shaped for a line item import
 * into an estimating platform.
 */

import {
  esc, onAct, formSheet, toast, sheet, statCard, sectionHeader, emptyState,
  confirmDialog, shareOrDownload,
} from '../ui.js';
import { money, num, round, fmtDate, dayKey, uid, nowIso, sum, toCsv } from '../util.js';
import {
  buildEstimate, buildLedger, LINE_ITEM_CATALOG, EXPENSE_KINDS, LABOR_ROLES, catalogById,
} from '../estimate.js';

export async function render(ctx) {
  const job = ctx.job;
  const estimate = buildEstimate(job, { priceList: ctx.settings.priceList || {} });
  const ledger = buildLedger(job, estimate);

  const html = `
    <div class="stat-grid">
      ${statCard('Estimate', money(estimate.totals.grand), 'billable', 'brand')}
      ${statCard('Costs', money(estimate.totals.costOut), 'paid out')}
      ${statCard('Margin', `${estimate.totals.marginPct}%`, money(estimate.totals.grossMargin),
        estimate.totals.marginPct >= 40 ? 'dry' : estimate.totals.marginPct >= 20 ? 'near' : 'wet')}
      ${statCard('Open', money(ledger.outstanding), 'receivable')}
    </div>

    ${sectionHeader('Scope', `<button class="btn btn-sm" data-act="add-line">+ Line</button>`)}
    ${estimate.byGroup.length ? estimate.byGroup.map((g) => `
      <div class="card">
        <div class="card-head"><h3>${esc(g.group)}</h3><span class="chip chip-brand">${money(g.total)}</span></div>
        ${g.lines.map((l) => `
          <div class="card-row" ${l.source === 'manual' ? `data-act="edit-line" data-id="${esc(l.lineId)}" style="cursor:pointer"` : ''}>
            <span class="label">
              <span class="mono tiny">${esc(l.code)}</span><br>${esc(l.description)}
              ${l.source === 'auto' ? '' : ' <span class="chip">manual</span>'}
            </span>
            <span class="value">${round(l.quantity, 2)} ${esc(l.unit)} × ${money(l.unitPrice)}<br>
              <span class="tiny muted">${money(l.total)}</span></span>
          </div>`).join('')}
      </div>`).join('') : emptyState(
        'Nothing to bill yet',
        'Sketch the affected rooms and log your equipment — the scope builds itself from there.',
        `<button class="btn btn-primary" data-act="go-plan">Open floor plan</button>`,
      )}

    ${estimate.lines.length ? `
      <div class="card">
        <div class="card-row"><span class="label">Line items</span><span class="value">${money(estimate.totals.lineItems)}</span></div>
        <div class="card-row"><span class="label">Labour</span><span class="value">${money(estimate.totals.labor)}</span></div>
        <div class="card-row"><span class="label">Billable expenses</span><span class="value">${money(estimate.totals.billableExpenses)}</span></div>
        <div class="card-row"><span class="label"><strong>Total</strong></span><span class="value"><strong>${money(estimate.totals.grand)}</strong></span></div>
      </div>

      <div class="btn-row">
        <button class="btn btn-primary" data-act="export-csv">Export line items CSV</button>
        <button class="btn" data-act="export-invoice">Invoice sheet</button>
      </div>
      <div class="note-block">
        Xactimate's <code>.esx</code> is a proprietary container this app cannot write. The CSV is laid out for a line
        item import — map it to your own price list, or paste the quantities straight in. Codes and unit prices are
        editable in Settings so they match the price list you actually bill against.
      </div>` : ''}

    ${sectionHeader('Costs paid out', `<button class="btn btn-sm btn-primary" data-act="add-expense">+ Expense</button>`)}
    ${ledger.payable.length ? `
      <div class="card">
        ${ledger.payable.map((p) => `
          <div class="card-row" data-act="edit-expense" data-id="${esc(p.id)}" style="cursor:pointer">
            <span class="label">${esc(p.label)}${p.vendor ? ` · ${esc(p.vendor)}` : ''}
              <br><span class="tiny">${p.at ? esc(fmtDate(p.at)) : ''}${p.billable ? ` · rebilled ${money(p.rebilled)}${p.markupPct ? ` (+${p.markupPct}%)` : ''}` : ' · not billable'}</span></span>
            <span class="value">${money(p.amount)}</span>
          </div>`).join('')}
        <div class="card-row"><span class="label"><strong>Total out</strong></span>
          <span class="value"><strong>${money(ledger.payableTotal)}</strong></span></div>
        <div class="card-row"><span class="label">Reimbursable</span><span class="value">${money(ledger.reimbursable)}</span></div>
      </div>` : `<div class="card"><p class="muted small">No expenses logged. Fuel, supplies and dump fees belong on the job, not on your own card.</p></div>`}

    ${sectionHeader('Receivable', `<button class="btn btn-sm" data-act="add-payment">+ Payment</button>`)}
    <div class="card">
      ${ledger.receivable.map((r) => `
        <div class="card-row">
          <span class="label">${esc(r.label)}${r.party ? `<br><span class="tiny">${esc(r.party)}</span>` : ''}</span>
          <span class="value" style="color:${r.amount < 0 ? 'var(--dry)' : 'inherit'}">${money(r.amount)}</span>
        </div>`).join('')}
      <div class="card-row"><span class="label"><strong>Outstanding</strong></span>
        <span class="value"><strong>${money(ledger.outstanding)}</strong></span></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Profitability</h3></div>
      <div class="card-row"><span class="label">Billable</span><span class="value">${money(estimate.totals.grand)}</span></div>
      <div class="card-row"><span class="label">Direct costs</span><span class="value">${money(estimate.totals.costOut)}</span></div>
      <div class="card-row"><span class="label">Estimated payroll</span><span class="value">${money(estimate.totals.payrollCost)}</span></div>
      <div class="card-row"><span class="label"><strong>Gross margin</strong></span>
        <span class="value"><strong>${money(estimate.totals.grossMargin)} · ${estimate.totals.marginPct}%</strong></span></div>
      <p class="tiny muted mt">Payroll is estimated at 55% of the billing rate unless a cost rate is set on the entry.</p>
    </div>`;

  return {
    title: 'Money',
    subtitle: job.client?.name,
    back: `#/job/${job.id}`,
    html,
    mount: (root) => {
      onAct(root, {
        'go-plan': () => ctx.navigate(`#/job/${job.id}/plan`),
        'add-line': () => lineSheet(ctx),
        'edit-line': (el) => lineSheet(ctx, el.dataset.id),
        'add-expense': () => expenseSheet(ctx),
        'edit-expense': (el) => expenseSheet(ctx, el.dataset.id),
        'add-payment': () => paymentSheet(ctx),
        'export-csv': () => exportCsv(ctx, estimate),
        'export-invoice': () => exportInvoice(ctx, estimate, ledger),
      });
    },
  };
}

/* ------------------------------------------------------------------ */

async function lineSheet(ctx, lineId) {
  const existing = (ctx.job.manualLines || []).find((l) => l.lineId === lineId) || {};
  const values = await formSheet({
    title: lineId ? 'Edit line item' : 'Add line item',
    intro: 'Auto-generated lines come from the sketch and equipment log. Add anything the app cannot see.',
    fields: [
      { name: 'catalogId', label: 'Item', type: 'select', full: true, value: existing.catalogId || LINE_ITEM_CATALOG[0].id,
        options: LINE_ITEM_CATALOG.map((c) => ({ value: c.id, label: `${c.code} — ${c.description}` })) },
      { name: 'quantity', label: 'Quantity', type: 'number', required: true, value: existing.quantity },
      { name: 'unitPrice', label: 'Unit price', type: 'number', value: existing.unitPrice },
      { name: 'description', label: 'Override description', type: 'text', full: true, value: existing.description },
      { name: 'note', label: 'Note', type: 'text', full: true, value: existing.note },
    ],
    extraActions: lineId ? [{
      label: 'Delete',
      onClick: async ({ close }) => {
        await ctx.save((j) => { j.manualLines = j.manualLines.filter((l) => l.lineId !== lineId); });
        close(null);
        ctx.refresh();
        return false;
      },
    }] : [],
  });
  if (!values?.quantity) return;

  const base = catalogById(values.catalogId);
  await ctx.save((j) => {
    j.manualLines = j.manualLines || [];
    const line = {
      lineId: lineId || uid('ln'),
      catalogId: values.catalogId,
      code: base?.code,
      unit: base?.unit,
      group: base?.group,
      description: values.description || base?.description,
      quantity: num(values.quantity),
      unitPrice: values.unitPrice ?? ctx.settings.priceList?.[values.catalogId]?.unitPrice ?? base?.unitPrice ?? 0,
      note: values.note,
    };
    if (lineId) Object.assign(j.manualLines.find((l) => l.lineId === lineId), line);
    else j.manualLines.push(line);
  });
  ctx.refresh();
}

async function expenseSheet(ctx, id) {
  const existing = (ctx.job.expenses || []).find((e) => e.id === id) || {};
  const values = await formSheet({
    title: id ? 'Edit expense' : 'Add expense',
    fields: [
      { name: 'kind', label: 'Type', type: 'select', full: true, value: existing.kind || 'supplies',
        options: Object.entries(EXPENSE_KINDS).map(([value, k]) => ({ value, label: k.label })) },
      { name: 'amount', label: 'Amount', type: 'number', required: true, value: existing.amount, inputmode: 'decimal' },
      { name: 'vendor', label: 'Vendor', type: 'text', value: existing.vendor },
      { name: 'at', label: 'Date', type: 'date', value: existing.at ? existing.at.slice(0, 10) : dayKey() },
      { name: 'billable', label: 'Bill to the job', type: 'checkbox', full: true,
        value: existing.id ? !!existing.billable : true },
      { name: 'markupPct', label: 'Markup %', type: 'number', value: existing.markupPct },
      { name: 'note', label: 'Note', type: 'text', full: true, value: existing.note },
    ],
    extraActions: [
      ...(id ? [{
        label: 'Delete',
        onClick: async ({ close }) => {
          await ctx.save((j) => { j.expenses = j.expenses.filter((e) => e.id !== id); });
          close(null);
          ctx.refresh();
          return false;
        },
      }] : []),
    ],
  });
  if (values?.amount == null) return;

  await ctx.save((j) => {
    const record = {
      id: id || uid('exp'),
      kind: values.kind,
      amount: num(values.amount),
      vendor: values.vendor,
      at: values.at ? new Date(values.at).toISOString() : nowIso(),
      billable: values.billable,
      markupPct: values.markupPct ?? EXPENSE_KINDS[values.kind]?.defaultMarkup ?? 0,
      note: values.note,
    };
    if (id) Object.assign(j.expenses.find((e) => e.id === id), record);
    else j.expenses.push(record);
  });
  toast('Expense saved.', 'success');
  ctx.refresh();
}

async function paymentSheet(ctx) {
  const values = await formSheet({
    title: 'Record a payment',
    fields: [
      { name: 'amount', label: 'Amount', type: 'number', required: true, inputmode: 'decimal' },
      { name: 'from', label: 'From', type: 'text', value: ctx.job.claim?.carrier || ctx.job.client?.name },
      { name: 'label', label: 'Reference', type: 'text', full: true, placeholder: 'Cheque #, deductible, ACH' },
      { name: 'at', label: 'Date', type: 'date', full: true, value: dayKey() },
    ],
  });
  if (!values?.amount) return;
  await ctx.save((j) => {
    j.payments = j.payments || [];
    j.payments.push({ id: uid('pay'), amount: num(values.amount), from: values.from, label: values.label || 'Payment received', at: values.at });
  });
  toast('Payment recorded.', 'success');
  ctx.refresh();
}

/* -------------------------------- export -------------------------------- */

async function exportCsv(ctx, estimate) {
  const job = ctx.job;
  const name = `${(job.client?.name || 'job').replace(/[^\w-]+/g, '_')}_lineitems.csv`;
  await shareOrDownload({ filename: name, text: estimate.csv, title: 'Estimate line items', mime: 'text/csv' });
  toast('Line items exported.', 'success');
}

async function exportInvoice(ctx, estimate, ledger) {
  const job = ctx.job;
  const rows = [
    ['Invoice for', job.client?.name || ''],
    ['Job number', job.jobNumber || ''],
    ['Claim number', job.claim?.claimNumber || ''],
    ['Carrier', job.claim?.carrier || ''],
    ['Loss address', [job.client?.address, job.client?.city, job.client?.state, job.client?.zip].filter(Boolean).join(', ')],
    [],
    ['Code', 'Description', 'Unit', 'Quantity', 'Unit price', 'Total'],
    ...estimate.lines.map((l) => [l.code, l.description, l.unit, l.quantity, l.unitPrice.toFixed(2), l.total.toFixed(2)]),
    [],
    ['', '', '', '', 'Line items', estimate.totals.lineItems.toFixed(2)],
    ['', '', '', '', 'Labour', estimate.totals.labor.toFixed(2)],
    ['', '', '', '', 'Billable expenses', estimate.totals.billableExpenses.toFixed(2)],
    ['', '', '', '', 'Total', estimate.totals.grand.toFixed(2)],
    ['', '', '', '', 'Payments received', (estimate.totals.grand - ledger.outstanding).toFixed(2)],
    ['', '', '', '', 'Balance due', ledger.outstanding.toFixed(2)],
  ];
  const name = `${(job.client?.name || 'job').replace(/[^\w-]+/g, '_')}_invoice.csv`;
  await shareOrDownload({ filename: name, text: toCsv(rows), title: 'Invoice', mime: 'text/csv' });
}
