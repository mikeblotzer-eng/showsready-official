# DryPlan — restoration field app

A mobile/tablet web app for water damage restoration technicians. Sketch the
affected area, map moisture, size the drying system, log monitoring, track the
drive and the money — all from the phone in your pocket, with no signal.

Live at `/restore` (e.g. `https://showsready.com/restore`). Install it from the
browser share menu ("Add to Home Screen") to get a full-screen, offline app.

## What it does

**Floor plan.** Tap corners to draw a room, or type exact measurements off a
laser meter and press a direction — `12'6"` → →. Walls snap orthogonal and to
neighbouring corners, vertices drag, and any wall length can be retyped
afterwards. Rectangular rooms drop in from a width × depth form. Areas,
perimeters, wall areas and volumes are computed as you draw and feed everything
downstream.

**Moisture map.** Drop monitoring points on the plan. Each one carries its
material, surface, dry standard and its own reading history. Goals come from a
measured unaffected reading plus your tolerance, and points colour green or red
against that goal. "Log today's round" walks every point in one form.

**Airflow and equipment.** Draw airflow arrows and containment lines over the
plan, and place air movers, dehumidifiers and air scrubbers where they actually
sit. Placement drives the equipment-day charges on the estimate.

**Class and category, calculated.** Category starts from the source of water and
escalates for elapsed time (72 hours, or 48 above 75°F) and contact with
contaminated materials. Class comes from wet, low-evaporation material as a
share of combined floor, wall and ceiling area — under 5% is Class 1, 5–40% is
Class 2, over 40% is Class 3 — with a Class 4 override when wet bound-water
materials are present. Every call shows its arithmetic and can be overridden
with a written reason that lands in the report.

**Drying system sizing.** Air movers from wet wall length (one per 14 lf) or wet
floor area (one per 50–70 sf by class), whichever is greater, plus one per
offset, closet and stairwell. Dehumidification from affected volume divided by
the class factor for the technology in use, converted to AHAM pints and then to
specific units off the fleet list. Air filtration at 4 ACH for Category 2 and 3
work. Estimated amp load and circuit count come with it.

**Psychrometrics.** Log temperature and RH at the standard locations and get
dew point, grains per pound and vapour pressure. Dehumidifier inlet/outlet pairs
are scored on grain depression, and inside-versus-outside grain load tells you
whether open drying is worth it.

**Daily logs, photos, signatures.** Visits with techs, hours and work performed;
camera photos compressed and stored on the device; signature capture for
authorisation and completion.

**Contacts and communication.** Client, adjuster, office and crew with one-tap
call, text and email. Message drafts are pre-filled from the job — day count,
classification, equipment and drying progress — and everything sent is logged.

**Mileage.** GPS-tracked trips or typed odometer miles, billable at the
configured rate, with one-tap navigation to the loss site.

**Money.** An estimate with a starting price list, plus suggested line items
built from the job itself (equipment days, monitoring visits, labour hours,
affected area, category-driven work, mileage, billable purchases). Job costing
with receipt photos, markup and payables. Invoices with payments and AR ageing.

**The report.** One HTML file with the loss information, the classification and
its justification, the floor plan rendered light for print, every reading, the
psychrometric log, the equipment log with days on site, daily logs, photos,
signatures and the estimate. Print to PDF, share, or email the adjuster.

## Data

Everything lives on the device — `localStorage` for job records, IndexedDB for
photos. Nothing is uploaded and there is no account. Back up from Settings
before switching phones; the backup is a single JSON file that imports and
merges by job, newest wins.

Exports: moisture CSV, psychrometrics CSV, mileage CSV, expenses CSV, estimate
CSV (built for import mapping into an estimating platform), the plan as a PNG,
and the whole job as JSON.

## Code layout

```
restore/
  index.html            shell
  sw.js                 offline cache
  css/app.css
  js/
    app.js              router + shell, screen registry
    store.js            job model, persistence, backup/restore
    derive.js           everything computed from a job
    standards.js        S500 category/class logic, materials, work practices
    equipment.js        fleet catalog + drying-system sizing
    psychro.js          psychrometrics
    sketch.js           floor plan canvas engine
    ui.js               sheets, forms, small render helpers
    idb.js              photo blob storage
    util.js             formatting, geometry, feet/inch parsing
    screens/*.js        one module per screen: render() / mount() / unmount()
```

Screens are plain modules — `render(ctx)` returns HTML, `mount(root, ctx)` wires
delegated event listeners, `unmount()` cleans up. Adding a screen means writing
one file and registering it in `app.js`.

## Calculation sources

Classification, drying-system sizing and the drying-goal method follow the
approaches published in ANSI/IICRC S500 for professional water damage
restoration. The numbers in this app are starting points that show their work;
conditions on site govern, and every value is editable. Default prices in the
price list are placeholders — set them to your own market before quoting.

## Development

Static files, no build step. Serve the repo root and open `/restore/`:

```sh
python3 -m http.server 8899
# http://127.0.0.1:8899/restore/
```

The service worker only registers over http/https, and caches the app shell
first — bump `CACHE` in `sw.js` when shipping changes.
