# RestoreMap

A field app for water damage restoration technicians. Sketch the affected area
on a phone or tablet, layer a moisture map and airflow plan on top of it, size
equipment against IICRC S500, log daily monitoring, track the drive, keep the
whole job's money straight, and export it all to whatever your office estimates
in.

Built to work with **no signal**. Everything lives on the device; nothing is
required from a server.

Live at `/restore` on the deployed site.

---

## What it does

### Floor plan
Trace a room by tapping its corners — walls snap square automatically and every
wall is labelled with its length as you draw. Or type width × length for the
rectangles that make up most residential work. Corners snap to existing rooms so
adjoining spaces share walls. Pinch to zoom, drag to pan, drag any corner to
reshape.

Doors and windows go on the walls and get subtracted from wet wall linear feet,
so the air mover count doesn't get inflated by openings.

**Not LiDAR.** This is a fast, accurate sketch tool with real dimensions, not a
scanner. It runs on any phone rather than needing a specific one.

### Moisture map
Drop a monitoring point wherever you take a reading. Each point carries its
material, its location note, and — importantly — the **unaffected dry standard**
you measured for that same material elsewhere in the structure. Points render on
the plan as a colour wash from wet to dry, so the whole floor reads as a moisture
map at a glance. Points that have stopped moving get ringed in red.

### Airflow and equipment
Place air movers, dehus, scrubbers, heaters and panel systems on the plan and
drag them where they actually sit. Air movers render as directional wedges you
can rotate. Draw airflow arrows to show which way you're pushing the air.

**Auto-place** spaces air movers evenly around a room's perimeter, angled
down-wall so the airflow wraps the room in one direction.

### Classification
Category and Class are detected, not guessed at:

- **Category** comes from the water source, then escalates on its own as time
  passes — the window tightens when the space is warm, and visible growth or
  contact with contaminated materials forces the jump immediately.
- **Class** comes from the share of combined floor, wall and ceiling surface area
  that is wet *porous* material, computed from the rooms you sketched. Low
  evaporation materials (hardwood, plaster, concrete, masonry) push it to Class 4.

Both can be overridden from a dropdown; overriding is flagged so the file shows
you made a call rather than an error. Every determination shows its reasoning.

### Equipment sizing
- **Dehumidification** — chamber cubic feet ÷ the S500 initial dehumidification
  factor for the class, converted to a unit count using *your* AHAM rating.
  Desiccants are sized by air changes per hour instead.
- **Air movers** — one per affected room, plus wet floor area coverage, plus wet
  wall coverage for Class 2 and up, plus one per inside corner, offset and
  obstruction. Inside corners are counted from the geometry you drew.
- **Air filtration** — air changes per hour driven by the **category**, with
  negative air called out for Category 3.

Every number shows its basis in plain language, so it can be defended to an
adjuster.

### Monitoring
One row per point, one number to type, laid out for a single pass through the
house. Sparklines show the trend. The psychrometric log takes temp and RH for
affected, unaffected, exterior, dehu inlet and dehu outlet, then computes GPP,
dew point, vapour pressure and **grain depression** across the dehu — and tells
you when a unit has stopped pulling water.

A built-in calculator answers the everyday question: *if I heat this space, what
happens to my RH?*

### Dailies and communication
Daily entries with arrival/departure, techs on site, work performed, photos
(auto-compressed) and a typed client acknowledgement.

Contacts for the client, adjuster, carrier, office PM and fellow techs, each one
tap from a call, a text or an email — with a **job status message pre-filled from
live job state**: category, class, equipment on site, how many points have hit
their goal. Every conversation gets logged.

### Drive
GPS-tracked drives (with jitter filtering so the mileage isn't inflated) or plain
odometer entry. Mileage flows straight into job costs as a billable line, and
there's a one-tap navigate link to the loss address.

### Money
- **Payables** — fuel, supplies, PPE, disposal, subs, with receipt photos, PO
  numbers, markup and a billable flag.
- **Equipment days** — accrued automatically from placement until each unit is
  marked picked up.
- **Scope** — line items built from the job itself: extraction and detach/reset
  by room, flood cuts and insulation removal when the category calls for it,
  antimicrobial, containment, equipment days, monitoring visits, mileage and
  billable costs.
- **Receivables** — invoices pre-filled from the current billable total, tracked
  through draft → sent → paid, with overdue flagging.

---

## Estimating platform interop

The scope exports as CSV with a **`Code` column you fill in yourself**, remembered
per line once you set it.

This is deliberate. Xactimate and Symbility selector codes are proprietary, they
differ by price list and region, and a wrong code gets a line rejected or — worse
— silently mispriced. Rather than ship guessed codes, RestoreMap gives you
correct descriptions and correct quantities (the parts that take time to get
right in the field) and lets you map them once to whatever your office actually
estimates in.

Exports available:

| Export | Contents |
|---|---|
| Estimate CSV | Claim header, code, description, quantity, unit, price, total |
| Moisture log CSV | Every point across every date, plus the psychrometric log |
| Equipment CSV | Recommended vs placed, serial numbers, equipment days |
| Job costs CSV | Every cost with markup, plus the payable/receivable summary |
| Mileage CSV | Every trip with miles and reimbursement |
| Dailies CSV | Every daily entry with hours and signatures |
| Floor plan PNG | The plan as drawn, with whichever layers are switched on |
| Job JSON | The complete job, for handoff to another tech or backup |

`Print report` produces a clean printable file (no chrome, no buttons) for the
adjuster package.

---

## Working offline

Job data lives in **IndexedDB** on the device, and the app requests persistent
storage so a week of drying logs doesn't get evicted when the OS wants disk back.
A service worker precaches the whole shell, so the app opens in a basement with
no bars.

Two consequences worth knowing:

- **Clearing browser data deletes jobs.** Export finished jobs; the app warns
  when storage passes 85%.
- **There is no sync.** Handoff between techs is via job export/import. That's a
  deliberate v1 scope choice — see below.

Install it to the home screen (Add to Home Screen on iOS, Install on Android) and
it runs full-screen like a native app.

---

## Development

No build step, no bundler, no framework. Plain ES modules served as static files.

```
restore/
  index.html              app shell
  css/app.css             mobile-first UI
  js/
    app.js                boot + routing
    store.js              job model, persistence, all derived state
    db.js                 IndexedDB wrapper
    util.js               DOM + formatting helpers
    psychro.js            psychrometrics          (pure, tested)
    iicrc.js              S500 classification and sizing  (pure, tested)
    geom.js               floor plan geometry     (pure, tested)
    sketch.js             canvas engine
    views/                one module per screen
  tests/                  node --test suites
  sw.js                   offline cache
```

The three domain modules are pure functions with no DOM access, imported
directly by the tests.

```bash
cd restore && npm test          # 80 assertions across psychro, S500 and geometry
npx http-server -p 8080 ..      # then open http://localhost:8080/restore/
```

`restore/package.json` exists only to mark this directory as ES modules for
Node's test runner — the root project is CommonJS.

---

## Scope notes

Deliberately **not** in this version:

- **No LiDAR / photogrammetry room capture.** Browser APIs can't reach the depth
  sensor. The tap-to-trace tool with ortho snapping is fast and works on every
  device.
- **No multi-device sync or office dashboard.** That needs a backend, accounts and
  a permission model. The data model and JSON export were designed with it in
  mind — `schemaVersion` is stamped on every job, and imports always land as new
  records so a sync can never silently clobber field data.
- **No direct Xactimate/Symbility API write.** Those are licensed integrations.
  CSV export is the honest path in the meantime.

## A word on the numbers

Classification thresholds and sizing factors follow IICRC S500 guidance, and each
result states its basis. They are a trained technician's starting point, not a
replacement for judgement, jobsite conditions or local requirements. The app is
built to *document* your decisions defensibly — it does not make them for you.
