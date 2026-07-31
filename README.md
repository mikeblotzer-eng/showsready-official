# showsready-official

Two apps share this repo and this Netlify deploy.

| Path | App |
|---|---|
| `/` | **ShowsReady** — real estate video studio. Static marketing pages plus `server.js` (Express + Stripe + Supabase) deployed separately on Render. |
| `/restore` | **RestoreMap** — offline-first field app for water damage restoration technicians. Static only, no backend. See [`restore/README.md`](restore/README.md). |

## Tests

```bash
npm run test:restore    # RestoreMap domain math: psychrometrics, IICRC S500, geometry
```
