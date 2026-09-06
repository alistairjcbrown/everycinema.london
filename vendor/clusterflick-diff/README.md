# clusterflick-diff (vendored)

The performance-comparison core from
[clusterflick/scripts](https://github.com/clusterflick/scripts), copied
verbatim from `scripts/diff/` so `diffs.mjs` produces the same numbers as
[clusterflick/data-diffed](https://github.com/clusterflick/data-diffed) rather
than a second opinion about what "added" means.

| file                     | sha256 (at time of vendoring)                                      |
| ------------------------ | ------------------------------------------------------------------ |
| `match-performances.js`  | `49db00300f3af871e735c7400e17039bdbbb7556ca4076650b755f8409cc9948` |
| `compare-venue.js`       | `dcd43c023fab50d100c37cd09c4db37462fafe8db938c034ae181ad053afc365` |
| `compare-tmdb-match.js`  | `ac3799fd5ec38e4953bc9250974f338109a17b10ff9d139db222e6d6813961f9` |

Taken from `scripts/diff` at commit
[`189d749`](https://github.com/clusterflick/scripts/commit/189d749ec1d0e4ee7d14fea7800035beafc15835)
(4 August 2026). MIT licensed — see the upstream
[LICENSE](https://github.com/clusterflick/scripts/blob/main/LICENSE).

## Why vendored rather than depended on

`clusterflick/scripts` is installable (`github:clusterflick/scripts`, which is
how data-diffed consumes it) but its dependency tree carries `playwright`,
`camoufox-js`, `puppeteer-extra-plugin-stealth`, `openai`,
`@google/generative-ai` and `cheerio` — hundreds of megabytes of browser
automation and LLM SDKs, none of which a static site build has any use for.

Its `exports` map only publishes `./scripts/diff`, whose entry point reads a
`data-transformed` release as one file per venue and resolves venue names
through `../../cinemas`. Neither applies here: this repo diffs `data-combined`,
which arrives as a single blob and carries its own names. The three files below
that entry point require nothing outside each other, so they lift cleanly and
the rest does not.

## Why these three

`compare-venue.js` is the comparison — it splits a venue's showings into added,
removed and modified, and reports future-performance counts. It requires
`match-performances.js`, which pairs performances by nearest start time within
an hour so a moved showtime reads as a reschedule rather than a removal plus an
addition, and `compare-tmdb-match.js`, which it calls unconditionally.

`build-diff.js` and `scripts/diff/index.js` are deliberately not here. They
shape the published `diffed-data.json` and read the transformed layout, and
`diffs.mjs` does its own aggregation into daily files.

## What the adapter has to do

`compareVenue` wants one array of showings per venue, each carrying its own
`performances`. In `combined-data.json` the performances live on the movie
(`movie.performances`, keyed by `showingId`) and the showing calls its id `id`
rather than `showingId`, so `toVenueShowings` in `diffs.mjs` regroups them.
`compare-tmdb-match.js` then finds no `themoviedb` on the showing — combined
data matches at the movie level — and reports no TMDB changes. That is fine:
nothing here reads them.

## Keeping it honest

`diffs.mjs` has a `verify` command that re-runs a published data-diffed release
against the `data-combined` releases from the same pipeline run and compares
per-venue counts, so a drift between this copy and upstream shows up as a
failing check rather than as a quietly different chart.
