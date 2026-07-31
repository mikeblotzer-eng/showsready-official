/* Boot, routing and chrome. */

import { $, el, toast } from './util.js';
import * as store from './store.js';
import { requestPersistence, storageEstimate } from './db.js';

import renderJobs, { openJobList, renderJobSetup } from './views/jobs.js';
import renderPlan from './views/plan.js';
import renderReadings from './views/readings.js';
import renderEquipment from './views/equipment.js';
import renderDaily from './views/daily.js';
import renderMoney from './views/money.js';
import { openSettings } from './views/settings.js';

const ROUTES = {
  jobs: renderJobs,
  setup: renderJobSetup,
  plan: renderPlan,
  readings: renderReadings,
  equipment: renderEquipment,
  daily: renderDaily,
  money: renderMoney,
};

let current = 'jobs';
let cleanup = null;

export function go(route, opts = {}) {
  if (!ROUTES[route]) route = 'jobs';
  if (route !== 'jobs' && route !== 'setup' && !store.state.job) {
    toast('Open a job first.');
    route = 'jobs';
  }
  current = route;
  location.hash = route;
  render(opts);
}

function render(opts = {}) {
  const view = $('#view');
  cleanup?.();
  cleanup = null;
  view.innerHTML = '';
  view.classList.toggle('full', current === 'plan');
  view.scrollTop = 0;
  window.scrollTo(0, 0);

  const result = ROUTES[current](view, { go, ...opts });
  if (typeof result === 'function') cleanup = result;

  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('on', tab.dataset.route === current);
  }
  renderHeader();
}

function renderHeader() {
  const job = store.state.job;
  const title = $('#head-title');
  const sub = $('#head-sub');
  if (!job) {
    title.textContent = 'RestoreMap';
    sub.textContent = 'No job open';
    return;
  }
  title.textContent = job.claim?.insured || job.jobNumber || 'Untitled job';
  const cls = store.classification(job);
  const bits = [];
  if (job.claim?.address) bits.push(job.claim.address);
  if (cls) bits.push(`Cat ${cls.category} · Class ${cls.class}`);
  sub.textContent = bits.join(' · ');
}

function bindChrome() {
  $('#btn-jobs').addEventListener('click', () => openJobList({ go }));
  $('#btn-settings').addEventListener('click', () => openSettings({ go }));
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => go(tab.dataset.route));
  }
  window.addEventListener('hashchange', () => {
    const route = location.hash.slice(1);
    if (route && route !== current) go(route);
  });
  window.addEventListener('online', updateNetChip);
  window.addEventListener('offline', updateNetChip);
  updateNetChip();
}

function updateNetChip() {
  const chip = $('#net-chip');
  const offline = !navigator.onLine;
  chip.hidden = !offline;
  chip.textContent = 'Offline';
}

async function boot() {
  try {
    await store.init();
  } catch (err) {
    $('#boot').innerHTML = `<div class="boot-mark">!</div><p style="max-width:300px;text-align:center">${err.message}</p>`;
    return;
  }

  // Drying logs are legal documentation — ask the browser not to evict them.
  requestPersistence().catch(() => {});
  storageEstimate().then((s) => {
    if (s && s.pct > 85) toast('Device storage is nearly full — export finished jobs.', 'error');
  }).catch(() => {});

  bindChrome();
  store.subscribe((reason) => {
    renderHeader();
    // Re-render on structural changes only; views handle their own local updates.
    if (reason === 'job' || reason === 'init') render();
  });

  $('#boot').classList.add('gone');
  for (const node of [$('.app-head'), $('#view'), $('#tabbar')]) node.hidden = false;

  const hashRoute = location.hash.slice(1);
  go(store.state.job ? (ROUTES[hashRoute] ? hashRoute : 'plan') : 'jobs');

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();

export { store };
