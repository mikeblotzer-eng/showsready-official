# showsready-official

Static site plus a small Express/Stripe backend.

- `index.html`, `pricing.html`, `app.html`, … — ShowsReady marketing site and app
- `server.js` — API (Stripe checkout, Supabase, media)
- `restore/` — **DryPlan**, a mobile/tablet field app for restoration
  technicians: floor plan sketching, moisture mapping, drying calculations,
  monitoring, mileage, job costing, estimating and a printable documentation
  package. Offline-first, no build step. See [`restore/README.md`](restore/README.md).
  Served at `/restore`.
