# Every Cinema London

Every London cinema showtime in one place — browse, group, pivot and filter
across every venue. A showcase built with [AG Grid](https://www.ag-grid.com) on
cinema data from [Clusterflick](https://clusterflick.com).

**Live:** [everycinema.london](https://everycinema.london) · **Powered by
Clusterflick**

## What it is

A single-page [AG Grid](https://www.ag-grid.com) Enterprise showcase over ~31k
London cinema performances, with three views over one dataset:

- **Grouped** — movie ▸ venue, with per-movie showing counts
- **Pivot** — venues × dates, reconfigurable live from the tool panel
- **Flat** — every performance, filterable by genre, format and accessibility

Plus two charting pages over the same data's history: **Screening history**
(what actually screened, day by day and film by film, and what a wide opening
takes off everything already playing) and **Venue health** (which venues answer
when we ask, and when they publish new showtimes).

It's not a replacement for Clusterflick — it's a demonstration of what AG Grid's
row grouping, pivoting and set-filtering can do with real, messy, real-world
data.

## Stack

- [Vite](https://vitejs.dev) + vanilla JS (no framework)
- [AG Grid Enterprise](https://www.ag-grid.com) v36 — only the modules the app
  uses are registered (see `src/main.js`)
- Data from Clusterflick's public
  [data-combined](https://github.com/clusterflick/data-combined) release

## Data pipeline

The site ships a **compact mapping blob** and denormalizes it in the browser,
rather than shipping a fat one-row-per-performance table (~4× smaller over the
wire):

1. **`scripts/get-latest-combined-data.sh`** — downloads Clusterflick's latest
   combined release into `data-combined/` (~18 MB).
2. **`npm run transform`** (`transform.mjs`) — trims and compacts it into
   `public/data/cinemadata.json` (~6 MB): lookups once, movie fields once per
   movie, performances as minimal id-referencing records.
3. **`src/main.js`** — fetches the blob and expands it into flat rows in the
   browser (~0 ms), resolving ids and computing dates in Europe/London.

`data-combined/` and `public/data/` are generated and git-ignored — regenerate
them with steps 1–2.

## Performance history

`history.mjs` builds per-movie, hour-bucketed counts of what actually screened
over time, for charting. A Clusterflick release is only a snapshot of _future_
performances, so history is partitioned into windows bounded by consecutive
release publish dates, each populated from exactly one release:

```
release A (published A) -> showtimes in [A, B)   finalized, written once
release B (published B) -> showtimes in [B, C)   finalized, written once
latest release          -> showtimes >= its date PROVISIONAL, rebuilt every run
```

A window is a pure function of one release's data and two publish dates, so
there is no cross-release identity matching and no deduplication. Cancellations
handle themselves: a performance dropped before its window's release was cut is
simply absent and never counted. Buckets are whole **Europe/London** hours;
because publish instants are arbitrary, a boundary usually falls mid-bucket, so
that hour is split between the two windows and each side is counted from its own
release.

One thing the history page is careful about, since it is the only claim there
that is about cause rather than count: **what an opening costs**. For any two
consecutive days, screenings gained by rising films minus screenings given up by
falling ones is exactly the change in the day's total — it holds on all 241 day
pairs in the data so far — so "the schedule only grew by X, the rest came off
films already playing" is arithmetic and needs no assumption about why anyone was
dropped. What the data cannot say is which film took which screen: two films
opening the same Friday are indistinguishable claimants on the same freed slots,
so the card names both sides and their sizes and stops there. The trend beside it
is stated for Monday to Friday only, because at the weekend the estate opens up
rather than reallocating and the relationship is simply absent (r = 0.01 over 70
weekend day pairs) — pooling those in would dilute a real weekday effect with
days it cannot apply to.

Finalized windows live in `data-history/windows/YYYY-MM/<tag>.json` and **are
committed** — they cannot be regenerated cheaply. Each is self-contained (it
carries its own movie titles), so a film dropping out of later releases never
invalidates it.

```bash
npm run history:index              # refresh data-history/index.json from the GitHub API
npm run history:fetch              # download release assets that still need a window
npm run history:windows            # turn those assets into finalized windows
npm run history:build              # merge windows + provisional -> public/data/history.json
```

Backfilling a year pulls **~8.8 GB** of release assets (~454 releases × ~19 MB),
so `fetch` takes `--since`/`--to` to work through it in chunks, and `windows`
deletes each asset once its window is written (pass `--keep` to retain them):

```bash
npm run history:fetch -- --since 2026-01-01 --to 2026-02-01 && npm run history:windows
```

Both stages are idempotent and skip any release whose window already exists, so
an interrupted backfill just resumes. In CI, `npm run history:update` does the
incremental step — typically two new releases per day — and commits the closed
windows.

## Venue health

`health.mjs` builds the data behind the venue-health page: how often each cinema
answers when we ask it for its listings, and what time of day new showtimes
actually appear.

[clusterflick/data-analysed](https://github.com/clusterflick/data-analysed)
probes every tracked venue once an hour and publishes the rows as **one release
per London day**, tagged `YYYYMMDD` with a `health-log.jsonl` asset — one JSON
row per venue per cycle, carrying what the venue was listing and, when it did not
answer, why not. No GitHub API is involved anywhere here: a release's tag is the
London date and the asset name is fixed, so a day's download URL is a pure
function of the day, which means no token and no rate limit.

A day's log is immutable once the day is over, so it is aggregated once and the
aggregate committed — the same reasoning as the history windows above, and for
the same reason: a raw day is ~1.8 MB, the aggregate ~25 KB.

```bash
npm run health:days     # aggregate finished days -> data-health/days/YYYYMM/
npm run health:build    # merge those + today     -> public/data/health.json
```

`days` is both the backfill and the incremental step: it takes every day between
the earliest one already held and yesterday that has no file yet, so a failed run
— or a day the upstream workflow never published — is picked up next time rather
than being lost. Today's log is still being appended to, so it is never
committed; `build` fetches it itself and folds it in as a provisional day.

Three things the page is careful about:

- **The day boundary.** Whether a venue published is a comparison against the
  previous hourly check, and for the first check of a day that lives in the
  previous day's file. Each day therefore carries a `tail` — what every venue was
  listing at its last check — so the next day can open against something. Without
  it, midnight would be a permanent hole in exactly the chart this page exists
  for.
- **What counts as publishing.** The headline metric is checks where a venue's
  own listing count went *up*, not checks where anything changed. At 00:00 the
  day that just ended drops out of every venue's listings at once, so a third of
  the estate reads as "changed" with nobody having published anything; an
  increase can only be new listings. It is also unit-free, which matters because
  some chains report individual performances and some a film × date matrix — a
  total over both would mean nothing, so the raw "listings added" figure is only
  offered where the selection speaks one unit.
- **What cannot be asked at all.** A third granularity, `film-and-date-totals`,
  reports only how many films and how many dates a venue lists — so a venue can
  add a screening of a film it already lists on a date it already lists and move
  neither figure. There is no volume to difference, so those venues leave the
  publish rate's *denominator* rather than scoring zero in it, and the table
  shows them a dash: 0% would sort a venue we cannot ask in among the venues that
  genuinely never publish. "Did anything move" needs no volume, so that metric
  still counts them. `health.mjs` warns when the log carries a granularity it has
  no volume metric for, since upstream adds venues on its own schedule.
- **What counts as downtime.** Upstream declares venues it knows are shut — a
  cited, windowed refurbishment — and labels their checks `expected-closure`
  rather than treating a delisted venue or an empty listing as a breakage. Those
  checks leave the uptime denominator rather than scoring against it: a venue
  closed for a week we wrote down ourselves is not a venue that failed to answer.
  They stay visible everywhere else, in their own ink on the daily chart and
  counted in the venue table beside the rate they are excluded from.

Venue and chain display names come from the Clusterflick combined data the site
build already downloads, keyed by the same cinema id the health log uses. Nothing
about the venue list is written down in this repo: whatever the log carries is
what the page offers, so a venue added upstream appears on its own.

A chain is the id prefix its venues share, which is how upstream groups its
probes. Its label is the venues' `groupName` — but only while one chain claims
it: several sites that share a group are probed under ids that share no prefix
(three Olympic Studios, two Castle Cinemas), so each is a chain of one here and
all three would otherwise read as "Olympic Studios" — indistinguishable in the
picker, and wrong in the venue table, whose chain filter matches on the label. A
shared `groupName` therefore gives way to the venue's own name, and `build` warns
if two chains still end up sharing one.

## Getting started

```bash
npm install
./scripts/get-latest-combined-data.sh   # fetch Clusterflick data  -> data-combined/
npm run transform                        # build the compact blob   -> public/data/
npm run history:build                    # merge history           -> public/data/
npm run health:days && npm run health:build   # venue health       -> public/data/
npm run dev                              # http://localhost:5173
```

## Scripts

| Command                                 | Does                                                      |
| --------------------------------------- | --------------------------------------------------------- |
| `npm run dev`                           | Start the Vite dev server                                 |
| `npm run transform`                     | Rebuild the compact data blob from `data-combined/`       |
| `npm run history:index`                 | Refresh the cached Clusterflick release index             |
| `npm run history:fetch`                 | Download release assets that still need a window          |
| `npm run history:windows`               | Build finalized history windows from those assets         |
| `npm run history:update`                | Incremental history update (fetch + windows for the tail) |
| `npm run history:build`                 | Merge history into `public/data/history.json`             |
| `npm run health:days`                   | Aggregate finished venue-health days into `data-health/`  |
| `npm run health:build`                  | Merge venue health into `public/data/health.json`         |
| `npm run build`                         | Production build (app + attributions page)                |
| `npm run preview`                       | Preview the production build                              |
| `npm run history:latest-tag`             | Print the release the site build pins its data to         |
| `./scripts/get-latest-combined-data.sh` | Download the latest Clusterflick combined data (or `<tag>`) |

## Deployment

Deployed to [GitHub Pages](https://pages.github.com) via GitHub Actions
(`.github/workflows/deploy.yml`), modelled on `clusterflick.com`'s pipeline. On
every push to `main`, daily on a schedule (to pick up fresh data), or on manual
dispatch, CI:

1. runs `npm run history:update` and `npm run health:days` to close any history
   windows the newest releases superseded and aggregate any venue-health day
   that has finished, and commits both (the only job with write access; pushes
   made with `github.token` do not re-trigger the workflow, so it cannot loop)
2. installs deps, then runs the fetch script + `npm run transform` to produce
   the data
3. runs `npm run history:build` and `npm run health:build`, then `npm run build`
4. publishes `dist/` to GitHub Pages

Step 2 pins its download to the release step 1 indexed
(`get-latest-combined-data.sh "$(node history.mjs latest-tag)"`) rather than
asking for whatever is newest. Releases land a few times a day, and one arriving
between the two steps would leave the hours between the last closed window and
the newer release covered by no window — and missing from the newer release too,
since a release lists only *future* performances — so those screenings would drop
out of the daily totals until the window was written. Pinning makes the site data
and the history windows the same snapshot by construction. `history.mjs build`
warns if they ever diverge anyway.

## Attributions

- **Performance data** — [Clusterflick](https://clusterflick.com)
- **Film metadata** — [TMDB](https://www.themoviedb.org) · _this product uses
  the TMDB API but is not endorsed or certified by TMDB_
- **Grid** — [AG Grid](https://www.ag-grid.com)

See the in-app attributions page (`attributions.html`) for full details and
logos.

## Notes

- AG Grid Enterprise runs unlicensed here (evaluation watermark). Add a key via
  `LicenseManager.setLicenseKey(...)` in `src/main.js` to remove it.
- License: [MIT](LICENSE) — covers this project's own code. It does **not**
  cover third-party data or trademarks: cinema data belongs to Clusterflick,
  film metadata to TMDB, and the Clusterflick / TMDB / AG Grid names and logos
  to their respective owners.
