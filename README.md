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

Plus three charting pages over the same data's history: **Screening history**
(what actually screened, day by day and film by film, and what a wide opening
takes off everything already playing), **When venues publish** (how many new
future performances each venue put on sale, day by day, and whether it is on a
weekly cycle) and **Venue health** (which venues answer when we ask, and when
they publish new showtimes).

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
falling ones is exactly the change in the day's total — it holds on every day
pair in the data — so "the schedule only grew by X, the rest came off films
already playing" is arithmetic and needs no assumption about why anyone was
dropped. Run across every night a film picked up more than 10% of London's
screenings, that share lands in a narrow band (a median of 83% so far), which is
how the card generalises without inferring anything.

The picker's events come from that overnight **change**, not from the
concentration chart's share threshold, and an earlier version reusing the latter
was a bug worth recording. A share test asks whether a film is now dominant,
which is the right question for marking the share chart; a film can cross it on a
night it barely moved. Supergirl opened on Thursday 25 June with 547 screenings,
19.8% of the day, and drifted over 20% the following afternoon — so the share test
put its "opening" on the Friday, a night it gained 61 screenings, and the
changeover that actually cost the slate 547 was never offered. Two films can also
move on one night, so an event is a film *and* a night: both panels lead with the
film the picker names rather than whoever rose most.

Two things the card will not claim. It does not say which film took which screen:
two films opening the same Friday are indistinguishable claimants on the same
freed slots, so it names both sides and their sizes and stops there. And it does
not score the night — it puts the fortnight either side on screen and leaves the
reading there. An earlier version did score it, comparing the fallers' drop on
the night against their own prior week, and that was unsound: it compared
magnitudes without signs, and the films it traces are *selected* for having
fallen hardest that night, so a large drop is true by construction. Control for
it — ask what those same films did on their worst other night in the fortnight —
and the opening night stops being remarkable: on 19 June they lost 36% to Toy
Story 5 and 42% a week later to something else. A test that cannot fail is not a
test.

The general case is likewise made with arithmetic rather than a correlation. An
earlier version used a scatter of every day pair, which was a mistake: the change
for films already playing carries a large day-of-week term (a Friday sheds about
16% whatever opens, a Saturday gains), so a pooled correlation over all days is
mostly measuring the calendar, and controlling for it properly asks a reader of a
cinema listings site to follow a fixed-effects argument to reach a weaker version
of the same point.

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

## When venues publish

`diffs.mjs` builds the data behind the publishing page: how many new future
performances each venue added, and on which day.

A release is a snapshot of what every venue was listing at one instant, so two
consecutive releases say what appeared between them, and a run of releases says
when each venue put new screenings on sale. Nothing else in the pipeline records
that — `history.mjs` counts what *screened*, and `health.mjs` counts whether a
venue's listing total moved, in whatever unit that venue answers in.

```bash
npm run diffs:days      # diff consecutive releases -> data-diffs/days/YYYYMM/
npm run diffs:build     # merge those                -> public/data/diffs.json
npm run diffs:names     # backfill venue names        -> data-diffs/venues.json
npm run diffs:verify -- --tag <data-diffed release>  # check against upstream
```

Like the history windows and the health days, a finished day is write-once and
committed. `days` reads the release index `history.mjs` already maintains, so
the two stages are looking at one list rather than each fetching their own.

A day costs the two ~19 MB releases either side of it, but consecutive days
share a release — the current snapshot of one pair is the previous snapshot of
the next — so a run downloads each release once and the year is ~10.5 GB rather
than twice that. It still takes about half an hour, so `--limit` (default 40)
stops an incremental run from quietly attempting a backfill, and `--since` /
`--to` chunk one deliberately:

```bash
npm run diffs:days -- --since 2026-01-01 --to 2026-02-01
```

Unlike `history:fetch`, nothing is written to disk but the aggregates: a release
is parsed into per-venue showings, diffed against the one before it, and
dropped.

### The comparison is not ours

[clusterflick/data-diffed](https://github.com/clusterflick/data-diffed) already
publishes this diff — it backs Clusterflick's own New Listings and RSS feeds —
and the code behind it lives in
[clusterflick/scripts](https://github.com/clusterflick/scripts). Three files
from `scripts/diff` are therefore vendored verbatim into
`vendor/clusterflick-diff/` rather than reimplemented, because the interesting
decisions in a diff are definitional rather than algorithmic and a second
opinion about them would be worth nothing. Chief among them: performances are
paired by nearest start time within an hour, so a showtime that moves reads as a
**reschedule** rather than a removal plus an addition.

We cannot consume data-diffed's releases directly. They start on 25 July 2026,
they diff `data-transformed` (~400 assets per release, so a backfill would be
200k requests against 538 for `data-combined`), and upstream is explicit that
they are an internal build artifact, unlicensed, with no schema guarantees. So
`diffs.mjs` runs their code over `data-combined` instead — the same data the
site build already downloads, under the licence the rest of the site relies on.

`npm run diffs:verify` holds the two to each other: it re-runs a published
data-diffed release against the `data-combined` releases from the same pipeline
run and compares per-venue counts. It reproduces upstream exactly across the
overlap. Two things it knows about:

- Some pipeline runs publish a transformed release and no combined one, so
  there is no snapshot to compare against and `verify` says so rather than
  reporting six hours of unrelated change as a disagreement.
- A venue whose only movement was a sub-hour reschedule is legitimately absent
  from data-diffed's published blob — `hasChanges` there publishes a venue only
  when a *showing* changed — while it is present in ours.

### What "added" has to mean here

`compareVenue` reports `futurePerformances.added` for performances added to
showings the venue was **already listing**, and reports a brand new showing
separately, with its performance count on the showing entry. That is right for a
feed, which renders a new title as one item and would double-count it otherwise,
but it is not what a chart with "performances added" up the side can use: over
six weeks the field alone misses 25% of what arrived. Removals are not symmetric
— a removed showing's future performances *are* in `removed` — so `diffs.mjs`
adds the two together.

It also keeps them apart, because the split turns out to be the signal. On the
estate-wide changeover days new titles are 7–22% of what arrives — the chains
extending the booking window on films already on sale. On the quiet days it is
40–85%, because what moves then is a venue announcing something new.

### Which day a diff belongs to

A diff covers the interval between two release publishes, and those do not
respect midnight: releases land about twice a day, the median interval is ~12
hours, and more than half of everything added arrives inside an interval that
spans a midnight. So it is credited to the day the interval **started**.

`asOf` names the far end and crediting that day is the obvious reading, but the
venue-health log settles it the other way: its hourly probes put 39% of
everything added between 19:00 and midnight against 5% between midnight and
06:00, with 03:00–08:00 essentially dead. For the usual 19:00 → 06:00 interval
the additions happened on the evening side by roughly 88% to 12%, and 23:00
alone — the single largest hour at 22% — is exactly what end-of-interval
attribution would push into tomorrow.

Splitting a straddling interval between the two days in proportion to that
hourly profile, the way `history.mjs` splits a boundary hour between two
windows, is deliberately not done: the profile comes from the health log's first
fortnight and only from venues reporting a countable volume, so it assumes a
stationarity nobody has checked, and it would turn integer performance counts
into fractions. A stated rule that is right ~88% of the time beats a weighted
one that cannot be falsified.

### Naming a venue that has left

Display names come from the combined data the site build already downloads, but
that is only ever the *current* release and this page reaches back to January. A
venue tracked in February and dropped in June is not in today's venue list, so
there is nothing to look up and it shows as its own id — `perivalehive.co.uk`
sitting in a table of Vues and Odeons. Thirteen venues were in that position.

The releases being diffed carry the names, so `days` writes down what it sees
into `data-diffs/venues.json`, and `build` falls back to it. Unlike the history
windows, which carry their own movie titles so a window stays a pure function of
one release, this is one registry rather than a copy per day: a venue's name is
a property of the venue, not of the day, and 300 names repeated across 242 days
would be most of the bytes in `data-diffs/`. Last seen wins, so a rename tracks.

`npm run diffs:names` backfills it for days aggregated before that existed. It
looks for the fewest releases that answer for the most venues — thirteen names
came out of three releases — and is only needed once.

`groupName` rides along for the same reason, because it is what a chain label is
built from and a chain whose every venue has left would otherwise be labelled by
its id prefix.

### Naming a chain

A chain's label is its venues' `groupName`, but only while one chain claims it,
and **a chain of one is settled first, before the remaining claims are counted**.

The order is the whole of it. Several sites sharing a group are probed under ids
that share no prefix — three Olympic Studios, two Castle Cinemas, Curzon Sea
Containers apart from the other ten Curzons — so each is a chain of one here.
Counting their claims alongside the real chain's makes every shared `groupName`
look contested, and the ten-venue chain falls through to its id: `curzon.com` in
the picker, beside a "Curzon Sea Containers" that has no such problem. But a
singleton was never going to use the shared name — being identified by its own
is what tells it apart — so its claim is not a claim.

`health.mjs` carries the same rule, and settling singletons first improves it
there too: `omniplex.co.uk` was labelled "Omniplex" though only Omniplex Sutton
is probed. Two chains of *many* sharing a name is still a real collision with no
better answer than their ids, and both files still warn about it.

### Two things the page is careful about

- **Venue ids changed shape on 27 January.** Until release `20260127.205759` a
  venue was keyed by `sha256(name)` truncated to 8 hex characters; from that
  release on, by domain — a schema change, with `socials`, `structure` and
  `type` appearing in the same release. The venue list was identical either side
  and no id disappeared during the hash era, so the map is exact rather than a
  name match. Showing ids were already domain-based and are byte-identical
  across the change, so the comparison itself is unaffected — only which venue
  to credit.
- **A venue listing nothing is not a venue we are not watching.** About 114 of
  the 380 tracked venues are listing nothing at any moment. `data-transformed`
  has no ambiguity here — every tracked venue is a file, empty array and all —
  but rebuilding the map from `combined-data.json`'s showings alone would lose
  those venues entirely, and a venue emptying out would read as silence rather
  than as a removal. The estate is therefore seeded from `blob.venues`, which is
  that list.


## Getting started

```bash
npm install
./scripts/get-latest-combined-data.sh   # fetch Clusterflick data  -> data-combined/
npm run transform                        # build the compact blob   -> public/data/
npm run history:build                    # merge history           -> public/data/
npm run health:days && npm run health:build   # venue health       -> public/data/
npm run diffs:days && npm run diffs:build     # publishing cadence -> public/data/
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

1. runs `npm run history:update`, `npm run health:days` and `npm run diffs:days`
   to close any history windows the newest releases superseded, aggregate any
   venue-health day that has finished, and diff the release pairs whose interval
   started on a day not yet held — and commits all three (the only job with
   write access; pushes made with `github.token` do not re-trigger the workflow,
   so it cannot loop)
2. installs deps, then runs the fetch script + `npm run transform` to produce
   the data
3. runs `npm run history:build`, `npm run health:build` and
   `npm run diffs:build`, then `npm run build`
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
