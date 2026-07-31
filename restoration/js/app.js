/**
 * Router and shell.
 *
 * Hash routing keeps the whole app a single static file set — no server, no
 * build step, and the back button behaves the way a phone user expects.
 */

import * as store from './store.js';
import { toast } from './ui.js';

import * as jobsView from './views/jobs.js';
import * as jobView from './views/job.js';
import * as planView from './views/plan.js';
import * as readingsView from './views/readings.js';
import * as equipmentView from './views/equipment.js';
import * as fieldView from './views/field.js';
import * as moneyView from './views/money.js';
import * as reportView from './views/report.js';
import * as settingsView from './views/settings.js';

const ROUTES = [
  { pattern: /^\/?$/, view: jobsView },
  { pattern: /^\/jobs$/, view: jobsView },
  { pattern: /^\/settings$/, view: settingsView },
  { pattern: /^\/job\/([^/]+)$/, view: jobView, keys: ['jobId'] },
  { pattern: /^\/job\/([^/]+)\/plan$/, view: planView, keys: ['jobId'] },
  { pattern: /^\/job\/([^/]+)\/readings$/, view: readingsView, keys: ['jobId'] },
  { pattern: /^\/job\/([^/]+)\/equipment$/, view: equipmentView, keys: ['jobId'] },
  { pattern: /^\/job\/([^/]+)\/field$/, view: fieldView, keys: ['jobId'] },
  { pattern: /^\/job\/([^/]+)\/money$/, view: moneyView, keys: ['jobId'] },
  { pattern: /^\/job\/([^/]+)\/report$/, view: reportView, keys: ['jobId'] },
];

const JOB_TABS = [
  { path: '', label: 'Job', icon: '📋' },
  { path: '/plan', label: 'Plan', icon: '📐' },
  { path: '/readings', label: 'Readings', icon: '💧' },
  { path: '/equipment', label: 'Equip', icon: '🌀' },
  { path: '/field', label: 'Field', icon: '🚚' },
  { path: '/money', label: 'Money', icon: '💵' },
];

const TOP_TABS = [
  { href: '#/jobs', label: 'Jobs', icon: '🗂' },
  { href: '#/settings', label: 'Settings', icon: '⚙️' },
];

let current = null;
// Renders await IndexedDB, so a fast double-tap on the nav can resolve out of
// order and leave the wrong screen mounted. Only the newest render commits.
let renderToken = 0;

/* ------------------------------------------------------------------ */

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function parseRoute() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
  for (const route of ROUTES) {
    const m = raw.match(route.pattern);
    if (m) {
      const params = {};
      (route.keys || []).forEach((k, i) => { params[k] = m[i + 1]; });
      return { ...route, params, raw };
    }
  }
  return { view: jobsView, params: {}, raw };
}

async function render() {
  const token = ++renderToken;
  const route = parseRoute();
  const settings = await store.getSettings();

  let job = null;
  if (route.params.jobId) {
    job = await store.getJob(route.params.jobId);
    if (!job) {
      toast('That job is no longer on this device.', 'error');
      location.hash = '#/jobs';
      return;
    }
  }
  if (token !== renderToken) return; // a newer navigation overtook this one

  current?.cleanup?.();
  current = null;

  const ctx = {
    params: route.params,
    job,
    jobId: route.params.jobId || null,
    settings,
    navigate,
    refresh: () => render(),
    save: async (mutator) => {
      if (!job) return;
      mutator(job);
      await store.saveJob(job);
    },
  };

  const main = document.getElementById('main');
  const topbar = document.getElementById('topbar');

  let result;
  try {
    result = await route.view.render(ctx);
  } catch (err) {
    console.error(err);
    result = { title: 'Something went wrong', html: `<div class="card"><p class="muted">${err.message}</p></div>` };
  }
  if (token !== renderToken) return;

  // Marks the mounted view so navigation is observable rather than inferred
  // from whichever shared element happens to be on screen.
  main.dataset.view = route.raw;
  topbar.innerHTML = topbarHtml(result, route);
  main.className = result.fullBleed ? 'no-pad' : '';
  main.innerHTML = result.html || '';
  main.scrollTop = 0;
  window.scrollTo(0, 0);

  document.getElementById('nav').innerHTML = navHtml(route, ctx);
  document.title = `${result.title || 'DryLine'} · DryLine Field`;

  topbar.querySelector('[data-nav-back]')?.addEventListener('click', () => {
    if (result.back) navigate(result.back);
    else history.back();
  });

  current = { cleanup: await result.mount?.(main) };
}

function topbarHtml(result, route) {
  const showBack = !!result.back || /^\/job\//.test(route.raw);
  return `
    ${showBack ? `<button class="back-btn" data-nav-back aria-label="Back">‹</button>` : ''}
    <h1>${escapeHtml(result.title || 'DryLine Field')}
      ${result.subtitle ? `<span class="sub">${escapeHtml(result.subtitle)}</span>` : ''}
    </h1>
    <div class="topbar-actions">${result.actions || ''}</div>`;
}

function navHtml(route, ctx) {
  if (ctx.jobId) {
    const base = `#/job/${ctx.jobId}`;
    return JOB_TABS.map((t) => {
      const href = `${base}${t.path}`;
      const on = route.raw === `/job/${ctx.jobId}${t.path}`;
      return `<a href="${href}" class="${on ? 'on' : ''}"><span class="ico">${t.icon}</span>${t.label}</a>`;
    }).join('');
  }
  return TOP_TABS.map((t) => {
    const on = location.hash === t.href || (t.href === '#/jobs' && (!location.hash || location.hash === '#/'));
    return `<a href="${t.href}" class="${on ? 'on' : ''}"><span class="ico">${t.icon}</span>${t.label}</a>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function watchConnectivity() {
  const banner = document.getElementById('offline');
  const update = () => {
    banner.hidden = navigator.onLine;
    if (navigator.onLine) store.syncNow().catch(() => {});
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    console.warn('Service worker registration failed — the app will still run online.', err);
  }
}

window.addEventListener('hashchange', render);

(async function boot() {
  watchConnectivity();
  await render();
  registerServiceWorker();

  // A tech will close the app mid-job constantly; make sure nothing is lost.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') store.syncNow().catch(() => {});
  });
})();
