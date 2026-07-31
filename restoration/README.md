# DryLine Field

A field app for water restoration technicians. Sketch the affected area on a
phone or tablet, lay a moisture map and airflow plan over it, size and track
equipment, run the daily monitoring round, log the drive and the costs, and
walk away with a report and a line item sheet.

It is a **static, offline-first PWA**. No build step, no server, no framework.
Everything lives in IndexedDB on the device, because the work happens in
basements and crawlspaces where there is no signal.

---

## What it does

**Floor plan.** Trace a room corner by corner with square snapping, or type
`12'6" × 20'` and get a rectangle. Tap any wall to retype its measured length —
the outline follows and the other walls stay square. Area, perimeter, inside
corners and volume are computed from the sketch and feed everything downstream.
Multiple levels per job.

**Moisture map.** Drop monitoring points where you take readings. Each carries
a material and a dry standard (your own unaffected reading, or the table
default). The plan renders an inverse-distance-weighted moisture surface
clipped to the rooms, so a wet corner is visible rather than buried in a table.

**Equipment plan.** Place air movers with a throw direction, dehumidifiers,
scrubbers and specialty systems on the plan, plus airflow arrows showing how
the chamber is set.

**Classification.** Category and class are derived from the source, the elapsed
time and temperature, and the wetted fraction of the sketched surfaces —
including the Cat 1 → Cat 2 → Cat 3 degradation that catches people out. Both
are overridable, and the app always shows its reasoning, which carries through
to the report.

**Equipment sizing.** Air movers from wet floor area, wet wall runs and inside
corners; dehumidification from chamber volume over the class factor; air
filtration from category. Then a placement audit compares what is actually on
the floor against the recommendation and flags the gap in both directions —
short, or heavy enough that a reviewer will ask.

**Monitoring round.** One input per point and a single save, because that is
how the round actually goes. Psychrometrics (grains per pound, dew point,
enthalpy, elevation-corrected), grain depression against an unaffected
reference, dehumidifier performance checks, and per-point trends that call out
a stalled or re-wetting material.

**Field day.** Daily logs with on-site times, work performed and client
signature capture. GPS drive tracking that survives a screen lock or a reload.
Contacts by role with call/text/email and a communication log. Photos, stored
compressed on the device.

**Money.** The scope builds itself from the sketch, the equipment log, the
dailies and the drives — extraction by flooring type, antimicrobial and
containment by category, demolition from what you marked removed, equipment
days, monitoring visits, mileage. Plus job costs, markup, payments and margin.
Exports a line item CSV and an invoice sheet.

**Report.** One self-contained HTML file with the dimensioned plan, the
moisture map, every reading, the equipment log, the dailies with signatures and
the photos inlined. Opens anywhere and prints to PDF.

---

## Running it

It is static files. Any web server will do:

```sh
cd restoration
python3 -m http.server 8080     # then open http://localhost:8080
```

A service worker and HTTPS (or `localhost`) are needed for install-to-home-screen
and offline use. On the Netlify deployment in this repo it is served at `/restore`.

**Install it on the device.** iOS: Share → Add to Home Screen. Android: the
install prompt, or the browser menu → Install app. Installed, it launches
standalone and runs with no network.

---

## Tests

```sh
cd restoration
npm test                        # domain math — psychrometrics, S500 logic, geometry, estimating
npm run test:browser            # end-to-end smoke test (needs `npm i -D playwright`)
```

`tests/run.js` covers the numbers a technician relies on: vapour pressure
against ASHRAE reference values, GPP/dew point inversions, category
degradation, class thresholds, equipment counts, dry-standard evaluation,
wall-length editing geometry, GPS jitter rejection and estimate quantities.

`tests/browser.mjs` drives a real job through a mobile viewport and asserts the
app survives a reload with its data intact.

---

## Layout

```
index.html            app shell
sw.js                 service worker (cache-first, precached shell)
manifest.webmanifest  PWA manifest
css/app.css           one stylesheet, light and dark
js/
  app.js              hash router and shell
  store.js            IndexedDB, photos, settings, sync outbox, backup/restore
  ui.js               sheets, forms, toasts, signature pad
  util.js             feet-inch parsing, geometry, GPS, formatting
  psychro.js          psychrometrics
  iicrc.js            category, class, equipment sizing, dry standards
  sketch.js           floor plan canvas engine
  estimate.js         line item catalog, scope builder, ledger
  jobcalc.js          derived job state used across screens
  drive.js            GPS trip tracking
  views/              one module per screen
tools/make-icons.js   regenerates the PWA icons from code
```

`psychro.js`, `iicrc.js`, `estimate.js`, `util.js` and the geometry half of
`sketch.js` are pure and browser-agnostic, which is what makes them testable
under Node — the numbers can be checked without a browser in the loop.

---

## Configure before you bill anything

Two things ship with defaults that are **starting points, not your numbers**:

- **The price list** (Settings → Price list). Codes are shaped like the
  selectors estimating platforms use, and unit prices are placeholders. Set
  them to the price list you actually bill against.
- **Sizing coefficients** (Settings → Sizing coefficients). These are the
  widely taught field factors. Align them with your firm's SOP and the edition
  of the standard you work to.

Xactimate's `.esx` is a proprietary container this app cannot write. The
practical path is the CSV: the quantities are already walked off from the
sketch and the equipment log, so they import or key in quickly and they are
defensible on review.

---

## Data and sync

Everything stays on the device by default — nothing is uploaded and no account
is required. Jobs and photos can be exported as a JSON file (per job, or a full
backup) and restored on another device.

If you point Settings → Sync at an endpoint that accepts
`PUT /jobs/:id` with a bearer token, changes queue in an outbox and drain
whenever there is signal. Failures stay queued; a job is never dropped because
the server was unreachable when the tech hit save.

Device storage is finite. Settings shows the headroom and warns before it
becomes a problem — export and remove finished jobs.

---

## On the guidance in this app

The classification and equipment logic follows the IICRC S500 approach to water
damage restoration. It is a calculator that shows its working, not a
substitute for the standard or for the technician's judgement on site. Every
computed result explains how it got there and can be overridden with a reason
that carries through to the report. Verify against the current standard and
your own training before relying on it for a job.
