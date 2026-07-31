/* Money: job costs (payables), the scope/estimate build-up, and invoicing
 * (receivables).
 *
 * The estimate side is deliberately code-agnostic. Every line carries a `code`
 * field you map once to whatever your office estimates in — Xactimate,
 * Symbility, Encircle, a spreadsheet. We do not ship guessed proprietary
 * selector codes, because a wrong code gets the line rejected. */

import {
  el, sheet, field, toast, confirmDialog, uid, num, round, money, todayISO, fmtDate,
  download, toCsv, compressImage,
} from '../util.js';
import * as store from '../store.js';
import * as db from '../db.js';
import { slug } from './jobs.js';

let tab = 'costs';

export default function renderMoney(view, { go }) {
  const job = store.state.job;
  if (!job) return go('jobs');
  const rerender = () => { view.innerHTML = ''; renderMoney(view, { go }); };
  const fin = store.financials(job);

  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: 'Money' }), el('p', { class: 'mute', text: 'Job costs, scope and invoicing' })),
  ));

  view.append(el('div', { class: 'card' },
    el('div', { class: 'stats' },
      st(money(fin.receivable), 'Billable', 'green'),
      st(money(fin.payable), 'Job cost', 'amber'),
      st(money(fin.margin), 'Margin', fin.margin >= 0 ? 'green' : 'red'),
      st(`${Math.round(fin.marginPct)}%`, 'Margin %'),
    ),
    fin.invoiced.total > 0
      ? el('div', { class: 'stats' },
          st(money(fin.invoiced.total), 'Invoiced'),
          st(money(fin.invoiced.paid), 'Paid', 'green'),
          st(money(fin.invoiced.outstanding), 'Outstanding', fin.invoiced.outstanding > 0 ? 'amber' : ''),
        )
      : null,
  ), el('div', { class: 'spacer' }));

  const tabs = el('div', { class: 'room-tabs', style: 'padding:0 0 12px' });
  for (const [id, label] of [['costs', 'Job costs'], ['scope', 'Scope & estimate'], ['invoices', 'Invoices']]) {
    tabs.append(el('button', { class: `room-tab${tab === id ? ' on' : ''}`, onClick: () => { tab = id; rerender(); } }, label));
  }
  view.append(tabs);

  if (tab === 'costs') renderCosts(view, fin, rerender);
  if (tab === 'scope') renderScope(view, fin, rerender);
  if (tab === 'invoices') renderInvoices(view, fin, rerender);
}

function st(value, label, tone) {
  return el('div', { class: 'stat' }, el('div', { class: `stat-val ${tone || ''}`, text: value }), el('div', { class: 'stat-lbl', text: label }));
}

/* ── Job costs / accounts payable ─────────────────────────────────────────── */

function renderCosts(view, fin, rerender) {
  const job = store.state.job;
  const costs = [...(job.costs || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  view.append(el('button', { class: 'btn btn-primary btn-block', onClick: () => costSheet(null, rerender) }, '+ Add job cost'), el('div', { class: 'spacer' }));

  if (fin.mileage.billableMiles > 0) {
    view.append(el('div', { class: 'note', style: 'margin-bottom:12px', html: `Mileage from the Drive tab adds <strong>${money(fin.mileage.amount)}</strong> (${round(fin.mileage.billableMiles, 1)} billable miles) on top of the costs listed here.` }));
  }

  if (!costs.length) {
    view.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
      el('div', { class: 'empty-ico', text: '$' }),
      el('h2', { text: 'No costs logged' }),
      el('p', { text: 'Fuel, supplies, PPE, dumpsters, subs — anything you spend on this job. Snap the receipt while you are standing at the counter.' }),
    )));
    return;
  }

  const list = el('div', { class: 'list' });
  for (const c of costs) {
    const type = store.COST_TYPES.find((t) => t.id === c.type);
    const amount = num(c.amount) * (c.qty ? num(c.qty, 1) : 1);
    list.append(el('button', { class: 'list-item', onClick: () => costSheet(c, rerender) },
      el('div', { class: 'li-main' },
        el('div', { class: 'li-title', text: c.description || type?.label || 'Cost' }),
        el('div', { class: 'li-sub', text: [fmtDate(c.date), c.vendor, type?.label, c.poNumber && `PO ${c.poNumber}`].filter(Boolean).join(' · ') }),
      ),
      el('div', { style: 'text-align:right;flex:none' },
        el('div', { class: 'mono', style: 'font-weight:700', text: money(amount) }),
        el('div', { class: 'tiny mute', text: c.billable ? (num(c.markupPct) ? `+${c.markupPct}% → ${money(amount * (1 + num(c.markupPct) / 100))}` : 'Billable') : 'Overhead' }),
      ),
      c.receiptId ? el('span', { class: 'chip chip-green', text: '📎' }) : null,
    ));
  }

  const byType = el('div', { class: 'table-scroll' }, el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Category'), el('th', { class: 'num' }, 'Cost'))),
    el('tbody', {}, ...Object.entries(fin.costs.byType).sort((a, b) => b[1] - a[1]).map(([t, v]) => el('tr', {},
      el('td', {}, store.COST_TYPES.find((x) => x.id === t)?.label || t),
      el('td', { class: 'num mono' }, money(v)),
    ))),
    el('tfoot', {}, el('tr', {}, el('td', {}, 'Total spent'), el('td', { class: 'num mono' }, money(fin.costs.total)))),
  ));

  view.append(
    el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: 'Costs' })), list),
    el('div', { class: 'spacer' }),
    el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: 'By category' })), byType),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn-ghost btn-block btn-sm', onClick: () => exportCosts(job, fin) }, '⤓ Export job costs'),
  );
}

function costSheet(existing, rerender) {
  const job = store.state.job;
  const { body, close } = sheet(existing ? 'Edit cost' : 'Add job cost');

  const dateF = field('Date', { type: 'date', value: existing?.date || todayISO() });
  const typeF = field('Category', { type: 'select', value: existing?.type || 'supplies', options: store.COST_TYPES.map((t) => ({ value: t.id, label: t.label })) });
  const descF = field('Description', { value: existing?.description || '', placeholder: 'Poly sheeting, 2 rolls' });
  const vendorF = field('Vendor', { value: existing?.vendor || '' });
  const qtyF = field('Qty', { type: 'number', inputmode: 'decimal', value: existing?.qty ?? 1 });
  const amountF = field('Unit cost', { type: 'number', inputmode: 'decimal', step: '0.01', value: existing?.amount ?? '' });
  const markupF = field('Markup %', { type: 'number', inputmode: 'decimal', value: existing?.markupPct ?? 0, hint: 'What you add on top when billing this through.' });
  const poF = field('PO number', { value: existing?.poNumber || '' });
  const billableF = field('Billable to this job', { type: 'checkbox', value: existing ? existing.billable !== false : true });

  let receiptId = existing?.receiptId || null;
  const receiptWrap = el('div', { style: 'margin-bottom:12px' });
  const renderReceipt = () => {
    receiptWrap.innerHTML = '';
    if (!receiptId) return;
    const img = el('img', { style: 'max-width:100%;border-radius:8px;border:1px solid var(--border)', alt: 'Receipt' });
    db.blobs.get(receiptId).then((rec) => { if (rec?.blob) img.src = URL.createObjectURL(rec.blob); });
    receiptWrap.append(img, el('button', {
      class: 'btn btn-ghost btn-sm btn-block', style: 'margin-top:6px',
      onClick: async () => { await db.blobs.remove(receiptId); receiptId = null; renderReceipt(); },
    }, 'Remove receipt'));
  };
  renderReceipt();

  const fileInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const blob = await compressImage(file, { maxDim: 1800, quality: 0.7 });
      const id = uid('receipt');
      await db.blobs.put({ id, jobId: job.id, blob, at: new Date().toISOString(), kind: 'receipt' });
      receiptId = id;
      renderReceipt();
    } catch (err) {
      toast(err.message || 'Could not attach that receipt.', 'error');
    }
    fileInput.value = '';
  });

  body.append(
    el('div', { class: 'grid-2' }, dateF.wrap, typeF.wrap),
    descF.wrap, vendorF.wrap,
    el('div', { class: 'grid-3' }, qtyF.wrap, amountF.wrap, markupF.wrap),
    el('div', { class: 'grid-2' }, poF.wrap, billableF.wrap),
    receiptWrap,
    el('button', { class: 'btn btn-block', style: 'margin-bottom:14px', onClick: () => fileInput.click() }, '📷 Attach receipt'),
    fileInput,
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: () => {
        if (amountF.input.value === '') { toast('Enter an amount.', 'error'); return; }
        const c = {
          id: existing?.id || uid('cost'),
          date: dateF.input.value || todayISO(),
          type: typeF.input.value,
          description: descF.input.value.trim(),
          vendor: vendorF.input.value.trim(),
          qty: num(qtyF.input.value, 1),
          amount: num(amountF.input.value),
          markupPct: num(markupF.input.value, 0),
          poNumber: poF.input.value.trim(),
          billable: billableF.input.checked,
          receiptId,
        };
        store.update((j) => {
          j.costs = j.costs || [];
          const i = j.costs.findIndex((x) => x.id === c.id);
          if (i >= 0) j.costs[i] = c; else j.costs.push(c);
        });
        close();
        rerender();
      },
    }, 'Save cost'),
    existing ? el('div', { class: 'spacer' }) : null,
    existing ? el('button', {
      class: 'btn btn-ghost btn-block',
      onClick: async () => {
        if (await confirmDialog('Delete this cost entry?')) {
          store.update((j) => { j.costs = j.costs.filter((x) => x.id !== existing.id); });
          close();
          rerender();
        }
      },
    }, 'Delete cost') : null,
  );
}

/* ── Scope / estimate ─────────────────────────────────────────────────────── */

/**
 * Build the scope from what the job already knows. These are descriptions and
 * quantities — the `code` column is yours to fill in for your estimating
 * platform, and it is remembered per description once you set it.
 */
function generatedScope(job) {
  const fin = store.financials(job);
  const cls = store.classification(job);
  const m = cls.metrics;
  const lines = [];

  const add = (key, description, qty, unit, unitPrice = null, note = '') => {
    if (!qty || qty <= 0) return;
    lines.push({ key, description, qty: round(qty, 2), unit, unitPrice, note, generated: true });
  };

  for (const { room, metrics } of m.rooms) {
    if (!metrics.drawn) continue;
    const a = room.affected;
    if (a.floorPct > 0 && ['carpet'].includes(a.floorMaterial)) {
      add(`detach_carpet_${room.id}`, `Detach and reset carpet — ${room.name}`, metrics.wetFloorArea, 'SF');
      if (cls.category >= 2) add(`remove_pad_${room.id}`, `Remove and dispose carpet pad — ${room.name}`, metrics.wetFloorArea, 'SF');
    }
    if (cls.category === 3 && metrics.wetWallArea > 0) {
      add(`flood_cut_${room.id}`, `Remove drywall to ${Math.max(2, metrics.affectedHeight)} ft (flood cut) — ${room.name}`, metrics.wetWallLf, 'LF');
      add(`remove_insul_${room.id}`, `Remove wet insulation — ${room.name}`, metrics.wetWallLf * Math.max(2, metrics.affectedHeight), 'SF');
    }
    if (cls.category >= 2) {
      add(`antimicrobial_${room.id}`, `Apply antimicrobial to affected surfaces — ${room.name}`, metrics.wetFloorArea + metrics.wetWallArea, 'SF');
    }
    add(`extract_${room.id}`, `Water extraction from ${a.floorMaterial === 'carpet' ? 'carpet' : 'hard surface'} — ${room.name}`, metrics.wetFloorArea, 'SF');
    if (metrics.wetFloorArea > 0) {
      add(`clean_${room.id}`, `Clean and detail affected area — ${room.name}`, metrics.floor, 'SF');
    }
  }

  for (const row of fin.equipment) {
    add(`equip_${row.type}`, `${row.label} (per 24-hour period)`, row.days, 'DA', row.rate);
  }

  if (cls.category === 3 || job.loss.containment) {
    const perimeter = m.rooms.reduce((s, r) => s + r.metrics.perimeter, 0);
    add('containment', 'Containment barrier — 6 mil poly, framed', perimeter * 8, 'SF');
  }

  const dailies = (job.dailies || []).length;
  if (dailies) add('monitoring', 'Daily monitoring visit — moisture readings and equipment check', dailies, 'EA');

  if (fin.mileage.billableMiles > 0) {
    add('mileage', 'Mileage', fin.mileage.billableMiles, 'MI', num(store.state.settings.mileageRate, 0.7));
  }
  for (const c of (job.costs || []).filter((x) => x.billable)) {
    const type = store.COST_TYPES.find((t) => t.id === c.type);
    add(`cost_${c.id}`, c.description || type?.label || 'Job cost', num(c.qty, 1), 'EA', num(c.amount) * (1 + num(c.markupPct, 0) / 100));
  }
  return lines;
}

function renderScope(view, fin, rerender) {
  const job = store.state.job;
  const generated = generatedScope(job);
  const overrides = job.scope || [];
  // Manual edits and manual lines win over the generated set.
  const merged = generated.map((g) => ({ ...g, ...(overrides.find((o) => o.key === g.key) || {}) }))
    .concat(overrides.filter((o) => !o.key || !generated.some((g) => g.key === o.key)));
  const visible = merged.filter((l) => !l.removed);
  const total = visible.reduce((s, l) => s + num(l.qty) * num(l.unitPrice), 0);

  view.append(el('div', { class: 'note', style: 'margin-bottom:12px', html: 'Lines are built from the rooms, category, class, equipment days and costs already in this job. Tap any line to set your <strong>own platform code</strong> and unit price, or add lines of your own. Export as CSV to bring into Xactimate, Symbility or your office spreadsheet.' }));

  view.append(el('div', { class: 'btn-row', style: 'margin-bottom:12px' },
    el('button', { class: 'btn btn-primary btn-sm', onClick: () => scopeLineSheet(null, rerender) }, '+ Add line'),
    el('button', { class: 'btn btn-sm', onClick: () => exportEstimate(job, visible) }, '⤓ Export CSV'),
  ));

  if (!visible.length) {
    view.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
      el('p', { text: 'Nothing to scope yet — sketch rooms and place equipment and the scope builds itself.' }),
    )));
    return;
  }

  const rows = visible.map((l) => el('tr', {
    style: 'cursor:pointer',
    onClick: () => scopeLineSheet(l, rerender),
  },
    el('td', { class: 'mono tiny' }, l.code || el('span', { class: 'mute', text: '— set —' })),
    el('td', { style: 'white-space:normal;min-width:180px' }, l.description),
    el('td', { class: 'num mono' }, String(round(l.qty, 2))),
    el('td', {}, l.unit),
    el('td', { class: 'num mono' }, l.unitPrice != null && l.unitPrice !== '' ? money(l.unitPrice) : '—'),
    el('td', { class: 'num mono' }, l.unitPrice != null && l.unitPrice !== '' ? money(num(l.qty) * num(l.unitPrice)) : '—'),
  ));

  view.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', { text: 'Scope' }),
      el('span', { class: 'chip chip-green', text: money(total) }),
    ),
    el('div', { class: 'table-scroll' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Code'), el('th', {}, 'Description'), el('th', { class: 'num' }, 'Qty'),
        el('th', {}, 'Unit'), el('th', { class: 'num' }, 'Price'), el('th', { class: 'num' }, 'Total'),
      )),
      el('tbody', {}, ...rows),
      el('tfoot', {}, el('tr', {},
        el('td', { colspan: 5 }, 'Priced lines total'),
        el('td', { class: 'num mono' }, money(total)),
      )),
    )),
  ), el('div', { class: 'spacer' }));

  const unpriced = visible.filter((l) => l.unitPrice == null || l.unitPrice === '').length;
  if (unpriced) {
    view.append(el('div', { class: 'note note-warn', html: `<strong>${unpriced} line${unpriced === 1 ? ' has' : 's have'} no unit price.</strong> Quantities are still exported — price them in your estimating platform, or set prices here to get a job total.` }));
  }
}

function scopeLineSheet(existing, rerender) {
  const { body, close } = sheet(existing ? 'Edit line' : 'Add scope line');
  const codeF = field('Your platform code', { value: existing?.code || '', hint: 'The selector/code your office uses in Xactimate, Symbility, etc. Left blank it exports empty.' });
  const descF = field('Description', { value: existing?.description || '' });
  const qtyF = field('Quantity', { type: 'number', inputmode: 'decimal', step: '0.01', value: existing?.qty ?? '' });
  const unitF = field('Unit', { type: 'select', value: existing?.unit || 'SF', options: ['SF', 'LF', 'SY', 'EA', 'DA', 'HR', 'MI', 'CF'].map((v) => ({ value: v, label: v })) });
  const priceF = field('Unit price', { type: 'number', inputmode: 'decimal', step: '0.01', value: existing?.unitPrice ?? '' });
  const noteF = field('Note', { value: existing?.note || '' });

  body.append(
    codeF.wrap, descF.wrap,
    el('div', { class: 'grid-3' }, qtyF.wrap, unitF.wrap, priceF.wrap),
    noteF.wrap,
    existing?.generated ? el('div', { class: 'note', style: 'margin-bottom:12px', text: 'This line is generated from job data. Quantity updates automatically unless you override it here.' }) : null,
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: () => {
        const line = {
          key: existing?.key || uid('line'),
          code: codeF.input.value.trim(),
          description: descF.input.value.trim(),
          qty: qtyF.input.value === '' ? null : num(qtyF.input.value),
          unit: unitF.input.value,
          unitPrice: priceF.input.value === '' ? null : num(priceF.input.value),
          note: noteF.input.value.trim(),
        };
        // Only persist the fields the user actually set, so generated
        // quantities keep tracking the job unless overridden.
        store.update((j) => {
          j.scope = j.scope || [];
          const i = j.scope.findIndex((x) => x.key === line.key);
          if (i >= 0) j.scope[i] = { ...j.scope[i], ...line }; else j.scope.push(line);
        });
        close();
        rerender();
      },
    }, 'Save line'),
    existing ? el('div', { class: 'spacer' }) : null,
    existing ? el('button', {
      class: 'btn btn-ghost btn-block',
      onClick: async () => {
        if (await confirmDialog('Remove this line from the scope?')) {
          store.update((j) => {
            j.scope = j.scope || [];
            const i = j.scope.findIndex((x) => x.key === existing.key);
            if (i >= 0) j.scope[i].removed = true;
            else j.scope.push({ key: existing.key, removed: true });
          });
          close();
          rerender();
        }
      },
    }, 'Remove line') : null,
  );
}

/* ── Invoices / accounts receivable ───────────────────────────────────────── */

function renderInvoices(view, fin, rerender) {
  const job = store.state.job;
  const invoices = [...(job.invoices || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  view.append(el('button', { class: 'btn btn-primary btn-block', onClick: () => invoiceSheet(null, fin, rerender) }, '+ New invoice'), el('div', { class: 'spacer' }));

  if (!invoices.length) {
    view.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
      el('div', { class: 'empty-ico', text: '▤' }),
      el('p', { text: 'No invoices yet. Draft one from the current billable total and track it through sent and paid.' }),
    )));
    return;
  }

  const list = el('div', { class: 'list' });
  for (const inv of invoices) {
    const overdue = inv.status === 'sent' && inv.dueDate && inv.dueDate < todayISO();
    list.append(el('button', { class: 'list-item', onClick: () => invoiceSheet(inv, fin, rerender) },
      el('div', { class: 'li-main' },
        el('div', { class: 'li-title', text: `Invoice ${inv.number || inv.id.slice(-5)}` }),
        el('div', { class: 'li-sub', text: [fmtDate(inv.date), inv.dueDate && `due ${fmtDate(inv.dueDate)}`, inv.billTo].filter(Boolean).join(' · ') }),
      ),
      el('div', { style: 'text-align:right;flex:none' },
        el('div', { class: 'mono', style: 'font-weight:700', text: money(inv.total) }),
      ),
      el('span', { class: `chip ${inv.status === 'paid' ? 'chip-green' : overdue ? 'chip-red' : inv.status === 'sent' ? 'chip-amber' : ''}`, text: overdue ? 'Overdue' : inv.status }),
    ));
  }
  view.append(el('div', { class: 'card' }, list));
}

function invoiceSheet(existing, fin, rerender) {
  const job = store.state.job;
  const { body, close } = sheet(existing ? `Invoice ${existing.number || ''}` : 'New invoice');
  const numberF = field('Invoice number', { value: existing?.number || `${job.jobNumber || 'INV'}-${(job.invoices || []).length + 1}` });
  const dateF = field('Date', { type: 'date', value: existing?.date || todayISO() });
  const dueF = field('Due date', { type: 'date', value: existing?.dueDate || plusDays(30) });
  const billToF = field('Bill to', { value: existing?.billTo || job.claim?.carrier || job.claim?.insured || '' });
  const totalF = field('Amount', { type: 'number', inputmode: 'decimal', step: '0.01', value: existing?.total ?? round(fin.receivable, 2) });
  const statusF = field('Status', { type: 'select', value: existing?.status || 'draft', options: ['draft', 'sent', 'paid'].map((v) => ({ value: v, label: v })) });
  const notesF = field('Notes', { type: 'textarea', value: existing?.notes || '' });

  body.append(
    !existing ? el('div', { class: 'note', style: 'margin-bottom:12px', html: `Pre-filled from the current billable total: equipment ${money(fin.equipmentTotal)} + costs ${money(fin.costs.billed)} + mileage ${money(fin.mileage.amount)}.` }) : null,
    numberF.wrap,
    el('div', { class: 'grid-2' }, dateF.wrap, dueF.wrap),
    billToF.wrap,
    el('div', { class: 'grid-2' }, totalF.wrap, statusF.wrap),
    notesF.wrap,
    el('button', {
      class: 'btn btn-primary btn-block',
      onClick: () => {
        const inv = {
          id: existing?.id || uid('inv'),
          number: numberF.input.value.trim(),
          date: dateF.input.value || todayISO(),
          dueDate: dueF.input.value,
          billTo: billToF.input.value.trim(),
          total: num(totalF.input.value),
          status: statusF.input.value,
          notes: notesF.input.value.trim(),
        };
        store.update((j) => {
          j.invoices = j.invoices || [];
          const i = j.invoices.findIndex((x) => x.id === inv.id);
          if (i >= 0) j.invoices[i] = inv; else j.invoices.push(inv);
        });
        close();
        rerender();
      },
    }, 'Save invoice'),
    existing ? el('div', { class: 'spacer' }) : null,
    existing ? el('button', {
      class: 'btn btn-ghost btn-block',
      onClick: async () => {
        if (await confirmDialog('Delete this invoice?')) {
          store.update((j) => { j.invoices = j.invoices.filter((x) => x.id !== existing.id); });
          close();
          rerender();
        }
      },
    }, 'Delete invoice') : null,
  );
}

function plusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ── Exports ──────────────────────────────────────────────────────────────── */

function exportCosts(job, fin) {
  const rows = [
    [`Job costs — ${job.claim?.insured || ''}`, `Claim ${job.claim?.claimNumber || ''}`],
    [],
    ['Date', 'Category', 'Description', 'Vendor', 'PO', 'Qty', 'Unit cost', 'Extended', 'Billable', 'Markup %', 'Billed'],
  ];
  for (const c of [...(job.costs || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    const ext = num(c.amount) * num(c.qty, 1);
    rows.push([
      c.date, store.COST_TYPES.find((t) => t.id === c.type)?.label || c.type,
      c.description, c.vendor, c.poNumber, c.qty ?? 1, num(c.amount).toFixed(2), ext.toFixed(2),
      c.billable ? 'Yes' : 'No', c.markupPct ?? 0,
      c.billable ? (ext * (1 + num(c.markupPct, 0) / 100)).toFixed(2) : '',
    ]);
  }
  rows.push([], ['Summary']);
  rows.push(['Total spent (payable)', fin.payable.toFixed(2)]);
  rows.push(['Equipment', fin.equipmentTotal.toFixed(2)]);
  rows.push(['Billable costs (with markup)', fin.costs.billed.toFixed(2)]);
  rows.push(['Mileage', fin.mileage.amount.toFixed(2)]);
  rows.push(['Total billable (receivable)', fin.receivable.toFixed(2)]);
  rows.push(['Margin', fin.margin.toFixed(2)]);
  download(`${slug(job)}-job-costs.csv`, toCsv(rows), 'text/csv');
  toast('Job costs exported.', 'success');
}

function exportEstimate(job, lines) {
  const cls = store.classification(job);
  const rows = [
    ['Insured', job.claim?.insured || ''],
    ['Loss address', [job.claim?.address, job.claim?.city, job.claim?.state, job.claim?.zip].filter(Boolean).join(', ')],
    ['Claim number', job.claim?.claimNumber || ''],
    ['Policy number', job.claim?.policyNumber || ''],
    ['Carrier', job.claim?.carrier || ''],
    ['Date of loss', job.claim?.dateOfLoss || ''],
    ['Category / Class', `Category ${cls.category} / Class ${cls.class}`],
    [],
    ['Code', 'Description', 'Quantity', 'Unit', 'Unit price', 'Total', 'Note'],
  ];
  let total = 0;
  for (const l of lines) {
    const ext = l.unitPrice != null && l.unitPrice !== '' ? num(l.qty) * num(l.unitPrice) : null;
    if (ext != null) total += ext;
    rows.push([l.code || '', l.description, round(l.qty, 2), l.unit, l.unitPrice ?? '', ext != null ? ext.toFixed(2) : '', l.note || '']);
  }
  rows.push([], ['', '', '', '', 'Total', total.toFixed(2)]);
  download(`${slug(job)}-estimate.csv`, toCsv(rows), 'text/csv');
  toast('Estimate exported.', 'success');
}
