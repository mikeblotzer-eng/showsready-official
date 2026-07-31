/**
 * Drive tracking.
 *
 * Mileage is real money on a restoration job and it is the first thing that
 * gets forgotten. This keeps a GPS trip running across screen changes and app
 * restarts — the tech starts it in the truck and stops it in the driveway.
 *
 * The live track is persisted to localStorage on every fix so a phone that
 * kills the tab on a cold morning does not lose the drive.
 */

import { trackDistanceMiles, haversineMiles, uid, nowIso, num } from './util.js';

const KEY = 'dryline.activeTrip';
let watchId = null;
const subscribers = new Set();

export function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
function emit() { const t = activeTrip(); for (const fn of subscribers) fn(t); }

export function activeTrip() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); }
  catch { return null; }
}

function write(trip) {
  if (trip) localStorage.setItem(KEY, JSON.stringify(trip));
  else localStorage.removeItem(KEY);
  emit();
}

export function isTracking() { return !!activeTrip(); }

/** Begin a tracked drive. Resolves once the first fix lands. */
export function startTrip({ jobId, purpose = 'To jobsite', billable = true }) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This device has no location services.'));
    if (activeTrip()) return reject(new Error('A drive is already being tracked.'));

    const trip = {
      id: uid('trip'), jobId, purpose, billable,
      startedAt: nowIso(), endedAt: null, points: [], miles: 0,
    };
    write(trip);

    let settled = false;
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const current = activeTrip();
        if (!current) return;
        current.points.push({
          lat: pos.coords.latitude, lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy, at: new Date(pos.timestamp).toISOString(),
        });
        current.miles = trackDistanceMiles(current.points);
        write(current);
        if (!settled) { settled = true; resolve(current); }
      },
      (err) => {
        if (!settled) {
          settled = true;
          stopWatch();
          write(null);
          reject(new Error(locationError(err)));
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    );
  });
}

/** Finish the drive and return the trip record to be saved on the job. */
export function endTrip() {
  const trip = activeTrip();
  stopWatch();
  if (!trip) return null;
  trip.endedAt = nowIso();
  trip.miles = trackDistanceMiles(trip.points);
  // Keep the endpoints for the report; the full breadcrumb is not worth the space.
  trip.startPoint = trip.points[0] || null;
  trip.endPoint = trip.points[trip.points.length - 1] || null;
  trip.fixCount = trip.points.length;
  delete trip.points;
  write(null);
  return trip;
}

export function cancelTrip() {
  stopWatch();
  write(null);
}

function stopWatch() {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

/**
 * Re-attach the watcher after a reload. Without this a tracked drive would
 * freeze at whatever mileage it had when the tab was evicted.
 */
export function resumeIfTracking() {
  const trip = activeTrip();
  if (!trip || watchId != null || !navigator.geolocation) return false;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const current = activeTrip();
      if (!current) return;
      current.points.push({
        lat: pos.coords.latitude, lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy, at: new Date(pos.timestamp).toISOString(),
      });
      current.miles = trackDistanceMiles(current.points);
      write(current);
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
  return true;
}

function locationError(err) {
  switch (err?.code) {
    case 1: return 'Location permission denied. Allow location access to track drives, or enter miles by hand.';
    case 2: return 'No location fix available right now.';
    case 3: return 'Timed out waiting for a location fix.';
    default: return 'Could not get a location fix.';
  }
}

/** Current position as a one-shot, for stamping a jobsite address. */
export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This device has no location services.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => reject(new Error(locationError(err))),
      { enableHighAccuracy: true, timeout: 20000 },
    );
  });
}

/** Deep link that opens the platform's maps app with directions. */
export function directionsUrl(job) {
  const c = job.client || {};
  const address = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
  if (address) return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
  if (c.lat != null && c.lng != null) return `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`;
  return null;
}

/** Straight-line distance to the jobsite, when the job has coordinates. */
export function distanceToJob(from, job) {
  const c = job.client || {};
  if (c.lat == null || c.lng == null || !from) return null;
  return haversineMiles(from, { lat: c.lat, lng: c.lng });
}

export function tripCost(trip, rate) {
  return num(trip.miles) * num(rate, 0.7);
}
