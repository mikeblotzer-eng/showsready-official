// Shell + router. Screens are plain modules with render()/mount()/unmount().

import { store } from './store.js';
import { derive } from './derive.js';
import { $, esc, toast } from './util.js';

import jobsScreen from './screens/jobs.js';
import overviewScreen from './screens/overview.js';
import planScreen from './screens/plan.js';
import moistureScreen from './screens/moisture.js';
import atmoScreen from './screens/atmo.js';
import equipmentScreen from './screens/equipment.js';
import dailyScreen from './screens/daily.js';
import contactsScreen from './screens/contacts.js';
import driveScreen from './screens/drive.js';
import estimateScreen from './screens/estimate.js';
import costsScreen from './screens/costs.js';
import reportScreen from './screens/report.js';
import settingsScreen from './screens/settings.js';

const SCREENS = Object.fromEntries([
  jobsScreen, overviewScreen, planScreen, moistureScreen, atmoScreen,
  equipmentScreen, dailyScreen, contactsScreen, driveScreen,
  estimateScreen, costsScreen, reportScreen, settingsScreen,
].map((s) => [s.id, s]));

const GROUPS = [
  { id: 'job', label: 'Job', icon: '🏚️', screens: ['overview'] },
  { id: 'plan', label: 'Plan', icon: '📐', screens: ['plan'] },
  { id: 'dry', label: 'Dry', icon: '💧', screens: ['moisture', 'atmo', 'equipment'] },
  { id: 'log', label: 'Log', icon: '📋', screens: ['daily', 'contacts', 'drive'] },
  { id: 'money', label: 'Money', icon: '💵', screens: ['estimate', 'costs', 'report'] },
];

const groupForScreen = (id) => GROUPS.find((g) => g.screens.includes(id)) || GROUPS[0];

let current = null; // { screen, job }

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (!parts.length) return { name: 'jobs' };
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'job' && parts[1]) {
    return { name: parts[2] || 'overview', jobId: parts[1] };
  }
  return { name: 'jobs' };
}

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

export function refresh() { render(); }

function ctxFor(job) {
  const settings = store.settings;
  return {
    job,
    settings,
    store,
    d: job ? derive(job, settings) : null,
    navigate,
    refresh,
    toast,
  };
}

function header(route, job, screen) {
  if (!job) {
    const onSettings = route.name === 'settings';
    return `<header class="appbar">
      ${onSettings ? '<a class="icon-btn" href="#/jobs" aria-label="All jobs">‹</a>' : ''}
      <div class="appbar__title">
        <h1>${onSettings ? 'Settings' : 'DryPlan'}</h1>
        <p>${onSettings ? 'Company, rates and device data' : 'Restoration field documentation'}</p>
      </div>
      ${onSettings ? '' : '<a class="icon-btn" href="#/settings" aria-label="Settings">⚙︎</a>'}
    </header>`;
  }
  const d = derive(job, store.settings);
  return `<header class="appbar">
    <a class="icon-btn" href="#/jobs" aria-label="All jobs">‹</a>
    <div class="appbar__title">
      <h1>${esc(job.site.name || job.site.address || job.jobNumber)}</h1>
      <p>${esc(job.jobNumber)} · Cat ${d.category} · Class ${d.cls} · ${esc(screen.title)}</p>
    </div>
    <a class="icon-btn" href="#/settings" aria-label="Settings">⚙︎</a>
  </header>`;
}

function subtabs(route, job) {
  if (!job) return '';
  const group = groupForScreen(route.name);
  if (group.screens.length < 2) return '';
  return `<nav class="subtabs">${group.screens.map((id) => {
    const s = SCREENS[id];
    return `<a href="#/job/${job.id}/${id}" class="${id === route.name ? 'is-on' : ''}">${esc(s.title)}</a>`;
  }).join('')}</nav>`;
}

function bottomNav(route, job) {
  if (!job) return '';
  const activeGroup = groupForScreen(route.name);
  return `<nav class="tabbar">${GROUPS.map((g) => `
    <a href="#/job/${job.id}/${g.screens[0]}" class="${g.id === activeGroup.id ? 'is-on' : ''}">
      <span class="tabbar__icon">${g.icon}</span><span>${esc(g.label)}</span>
    </a>`).join('')}</nav>`;
}

function render() {
  const route = parseHash();
  const job = route.jobId ? store.job(route.jobId) : null;

  if (route.jobId && !job) {
    location.hash = '#/jobs';
    return;
  }

  let screen = SCREENS[route.name] || SCREENS.jobs;
  if (job && screen.id === 'jobs') screen = SCREENS.overview;

  if (current?.screen && (current.screen.id !== screen.id || current.jobId !== job?.id)) {
    current.screen.unmount?.();
  }

  const ctx = ctxFor(job);
  const app = $('#app');
  const isPlan = screen.id === 'plan';

  app.innerHTML = `
    ${header(route, job, screen)}
    ${subtabs(route, job)}
    <main class="screen${isPlan ? ' screen--flush' : ''}" id="screen"></main>
    ${bottomNav(route, job)}
  `;

  const root = $('#screen');
  root.innerHTML = screen.render(ctx);
  current = { screen, jobId: job?.id };
  screen.mount?.(root, ctx);

  document.title = job ? `${job.jobNumber} · ${screen.title} · DryPlan` : 'DryPlan';
}

window.addEventListener('hashchange', render);

function boot() {
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
