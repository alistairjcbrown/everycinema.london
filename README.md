# Every Cinema London

Every London cinema showtime in one place — browse, group, pivot and filter across
every venue. A showcase built with [AG Grid](https://www.ag-grid.com) on cinema data
from [Clusterflick](https://clusterflick.com).

**Live:** [everycinema.london](https://everycinema.london) · **Powered by Clusterflick**

## What it is

A single-page [AG Grid](https://www.ag-grid.com) Enterprise showcase over ~31k London
cinema performances, with three views over one dataset:

- **Grouped** — movie ▸ venue, with per-movie showing counts
- **Pivot** — venues × dates, reconfigurable live from the tool panel
- **Flat** — every performance, filterable by genre, format and accessibility

It's not a replacement for Clusterflick — it's a demonstration of what AG Grid's row
grouping, pivoting and set-filtering can do with real, messy, real-world data.

## Stack

- [Vite](https://vitejs.dev) + vanilla JS (no framework)
- [AG Grid Enterprise](https://www.ag-grid.com) v36 — only the modules the app uses are
  registered (see `src/main.js`)
- Data from Clusterflick's public
  [data-combined](https://github.com/clusterflick/data-combined) release

## Data pipeline

The site ships a **compact mapping blob** and denormalizes it in the browser, rather
than shipping a fat one-row-per-performance table (~4× smaller over the wire):

1. **`scripts/get-latest-combined-data.sh`** — downloads Clusterflick's latest combined
   release into `data-combined/` (~18 MB).
2. **`npm run transform`** (`transform.mjs`) — trims and compacts it into
   `public/data/cinemadata.json` (~6 MB): lookups once, movie fields once per movie,
   performances as minimal id-referencing records.
3. **`src/main.js`** — fetches the blob and expands it into flat rows in the browser
   (~0 ms), resolving ids and computing dates in Europe/London.

`data-combined/` and `public/data/` are generated and git-ignored — regenerate them with
steps 1–2.

## Getting started

```bash
npm install
./scripts/get-latest-combined-data.sh   # fetch Clusterflick data  -> data-combined/
npm run transform                        # build the compact blob   -> public/data/
npm run dev                              # http://localhost:5173
```

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run transform` | Rebuild the compact data blob from `data-combined/` |
| `npm run build` | Production build (app + attributions page) |
| `npm run preview` | Preview the production build |
| `./scripts/get-latest-combined-data.sh` | Download the latest Clusterflick combined data |

## Attributions

- **Performance data** — [Clusterflick](https://clusterflick.com)
- **Film metadata** — [TMDB](https://www.themoviedb.org) · *this product uses the TMDB
  API but is not endorsed or certified by TMDB*
- **Grid** — [AG Grid](https://www.ag-grid.com)

See the in-app attributions page (`attributions.html`) for full details and logos.

## Notes

- AG Grid Enterprise runs unlicensed here (evaluation watermark). Add a key via
  `LicenseManager.setLicenseKey(...)` in `src/main.js` to remove it.
- **Deployment:** the build needs data present, so a deploy step should run the fetch
  script + `npm run transform` before `npm run build`.
- License: [MIT](LICENSE) — covers this project's own code. It does **not** cover
  third-party data or trademarks: cinema data belongs to Clusterflick, film metadata to
  TMDB, and the Clusterflick / TMDB / AG Grid names and logos to their respective owners.
