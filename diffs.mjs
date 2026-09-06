// When venues publish: new future performances, by venue, by day.
//
// A Clusterflick release is a snapshot of what every venue was listing at one
// instant. Two consecutive releases therefore say what appeared between them,
// and a run of releases says when each venue put new screenings on sale — the
// weekly changeover a chain runs, the Friday a repertory house posts its next
// programme. Nothing else in the pipeline records that: history.mjs counts what
// *screened*, and health.mjs counts whether a venue's listing total moved, in
// whatever unit that venue happens to answer in.
//
//   node diffs.mjs days     diff consecutive releases -> data-diffs/days/
//   node diffs.mjs build    merge those                -> public/data/diffs.json
//   node diffs.mjs verify   check our numbers against clusterflick/data-diffed
//
// The comparison itself is not ours. clusterflick/data-diffed already publishes
// this diff for its own New Listings feed, and the code behind it lives in
// clusterflick/scripts — so `vendor/clusterflick-diff/` carries that code
// verbatim rather than a reimplementation that would have to re-derive, and
// re-argue, what counts as an addition. See that directory's README, and
// `verify` below, which holds the two to each other.
//
// Backfilling the year pulls ~10.5GB of release assets, so `days` takes
// --since/--to to work through it in chunks:
//
//   node diffs.mjs days --since 2026-01-01 --to 2026-02-01

import { createRequire } from "node:module";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { compareVenue } = require("./vendor/clusterflick-diff/compare-venue.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIFFS_DIR = join(__dirname, "data-diffs");
const DAYS_DIR = join(DIFFS_DIR, "days");
const NAMES_FILE = join(DIFFS_DIR, "venues.json");
const INDEX_FILE = join(__dirname, "data-history", "index.json");
const COMBINED = join(__dirname, "data-combined", "combined-data.json");
const OUT_FILE = join(__dirname, "public", "data", "diffs.json");

const DIFFED_REPO = "clusterflick/data-diffed";

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

function warn(message) {
  if (process.env.GITHUB_ACTIONS) console.log(`::warning::${message}`);
  else console.warn(`Warning: ${message}`);
}

// --- London days -----------------------------------------------------------

const londonDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const londonDay = (at) => londonDayFmt.format(new Date(at)).replaceAll("-", "");

const today = () => londonDay(Date.now());

const DAY_MS = 86400000;
const asDate = (day) =>
  `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
// Read at midday so a day step never lands on a DST boundary and repeats itself.
const shiftDay = (day, n) =>
  new Date(Date.parse(`${asDate(day)}T12:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
// 0 = Sunday, matching Date#getUTCDay; the site re-orders to Monday-first.
const weekdayOf = (day) => new Date(`${asDate(day)}T12:00:00Z`).getUTCDay();

const dayPath = (day) => join(DAYS_DIR, day.slice(0, 6), `${day}.json`);
const finalizedDays = () => {
  if (!existsSync(DAYS_DIR)) return [];
  return readdirSync(DAYS_DIR)
    .sort()
    .flatMap((month) =>
      readdirSync(join(DAYS_DIR, month))
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -5)),
    )
    .sort();
};
const readDay = (day) => JSON.parse(readFileSync(dayPath(day), "utf8"));

// --- which day a diff belongs to -------------------------------------------
//
// A diff covers the interval between two release publishes, and those do not
// respect midnight: releases land about twice a day, so the median interval is
// ~12 hours and the common pair is an evening release against the next
// morning's. More than half of everything added arrives inside an interval that
// spans a midnight, so which day it is credited to is a real decision rather
// than a rounding detail.
//
// It is credited to the day the interval STARTS. `asOf` names the far end, and
// crediting that day would be the obvious reading, but it is the wrong one: the
// venue-health log probes hourly and says when listing counts actually rise.
// 19:00-23:59 carries 39% of everything added and 00:00-05:59 carries 5%, with
// 03:00-08:00 essentially dead — so for the usual 19:00 -> 06:00 interval the
// additions happened on the evening side by roughly 88% to 12%. 23:00 alone is
// the single largest hour in the day at 22%, and it is exactly the hour that
// end-of-interval attribution would push into tomorrow.
//
// The alternative — splitting a straddling interval between the two days in
// proportion to that hourly profile, the way history.mjs splits a boundary hour
// between two windows — is deliberately not done. The profile comes from the
// health log's first fortnight and only from venues that report a countable
// volume, so applying it across the whole backfill assumes it is stationary,
// and it would turn integer performance counts into fractions. A stated rule
// that is right ~88% of the time beats a weighted one nobody can check.
const dayOfInterval = (from) => londonDay(from);

// --- venue ids -------------------------------------------------------------
//
// Venue ids changed shape mid-January. Until release 20260127.205759 a venue
// was keyed by the first 8 hex characters of sha256 of its display name; from
// that release on it is keyed by domain, and three new fields (socials,
// structure, type) appear in the same release — a schema change, not a data
// one. The venue list was identical either side, 219 venues, and no id
// disappeared during the hash era at all, so the map is exact rather than a
// name-match: hash the domain era's names and every hash-era id is accounted
// for.
//
// Showing ids were already domain-based before the change and are byte
// identical across it, so the comparison itself is unaffected — only the
// question of which venue to credit.
const HASH_ERA_PIN = "20260127.205759";
const hash8 = (name) =>
  createHash("sha256").update(name).digest("hex").slice(0, 8);
const isHashId = (id) => /^[0-9a-f]{8}$/.test(id);

let hashToDomain = null;
async function venueIdMap(releases) {
  if (hashToDomain) return hashToDomain;
  const pin = releases.find((r) => r.tag === HASH_ERA_PIN);
  if (!pin)
    throw new Error(
      `Release ${HASH_ERA_PIN} is not in ${INDEX_FILE}; it is the first ` +
        `domain-id release and hash-era venue ids are resolved through it. ` +
        `Run "npm run history:index".`,
    );
  console.log(`  resolving hash-era venue ids via ${pin.tag}...`);
  const blob = await fetchRelease(pin);
  hashToDomain = new Map(
    Object.values(blob.venues).map((v) => [hash8(v.name), v.id]),
  );
  return hashToDomain;
}

// --- release access --------------------------------------------------------

function readIndex() {
  if (!existsSync(INDEX_FILE))
    throw new Error(`No ${INDEX_FILE}; run "npm run history:index" first.`);
  const { releases } = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
  return [...releases].sort((a, b) =>
    a.publishedAt.localeCompare(b.publishedAt),
  );
}

async function withRetry(label, work, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (attempt >= attempts) throw new Error(`${label}: ${err.message}`);
      const wait = 2 ** attempt * 500;
      console.warn(`  ${label} failed (${err.message}); retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const fetchRelease = (release) =>
  withRetry(`download ${release.tag}`, async () => {
    const res = await fetch(release.url, {
      headers: { "User-Agent": "everycinema.london" },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  });

// --- venue names -----------------------------------------------------------
//
// A venue's display name comes from the combined data the site build already
// downloads, but that is only ever the CURRENT release, and this page reaches
// back to January. A venue tracked in February and dropped in June is not in
// today's venue list at all, so there is no name to look up and it would be
// labelled by its id — `perivalehive.co.uk` sitting in a table of Vues and
// Odeons. Thirteen venues were in that position.
//
// The releases being diffed carry the names, so `days` writes down what it
// sees. Unlike the history windows, which carry their own movie titles so that
// a window is a pure function of one release, this is a single registry rather
// than a copy in each day file: a venue's name is a property of the venue, not
// of the day, and 300 names repeated across 242 days would be most of the bytes
// in `data-diffs/`.
//
// Last seen wins, so a rename tracks rather than sticking at whatever the venue
// was first called, and `seen` records when that name was current.
const readNames = () =>
  existsSync(NAMES_FILE) ? JSON.parse(readFileSync(NAMES_FILE, "utf8")) : {};

// `idMap` for the same reason the adapter takes one: before 27 January a
// release keys its venues by a hash of the name, so harvesting straight from
// the blob would file 219 names under ids nothing ever looks up, and would
// answer for none of the domain ids that actually need naming.
function harvestNames(registry, blob, day, idMap) {
  let added = 0;
  for (const [key, venue] of Object.entries(blob.venues ?? {})) {
    if (!venue?.name) continue;
    const id = idMap && isHashId(key) ? (idMap.get(key) ?? key) : key;
    const held = registry[id];
    if (held && held.seen >= day) continue;
    if (!held || held.name !== venue.name) added++;
    // `groupName` too, for the same reason as the name: it is what a chain
    // label is built from, and a chain whose every venue has left the estate
    // would otherwise be labelled by its id prefix — a bare
    // `walthamforest.gov.uk` in a column of Odeons and Picturehouses. Absent
    // before the January schema change, so it stays optional.
    registry[id] = venue.groupName
      ? { name: venue.name, groupName: venue.groupName, seen: day }
      : { name: venue.name, seen: day };
  }
  return added;
}

function writeNames(registry) {
  mkdirSync(dirname(NAMES_FILE), { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(registry).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(NAMES_FILE, `${JSON.stringify(sorted, null, 1)}\n`);
}

// --- adapter ---------------------------------------------------------------
//
// compareVenue wants what a data-transformed release holds: one array of
// showings per venue, each carrying its own performances. combined-data hangs
// performances off the movie instead, keyed by showingId, and calls the
// showing's id `id`. Regrouping is most of the difference — verified against
// data-diffed's own output by `verify`.
//
// The rest of it is that a venue listing nothing has no showings to regroup, so
// rebuilding the map from showings alone would lose it entirely — and a venue
// that is absent means something quite different from a venue that is present
// and empty. About 114 of the 380 tracked venues are listing nothing at any
// moment, and the difference decides whether a venue emptying out reads as a
// removal or as silence, and whether one that starts listing again reads as a
// venue publishing or as a venue we only just started watching. data-transformed
// has no such ambiguity — every tracked venue is a file, empty array and all —
// so the estate is seeded from `blob.venues`, which is exactly that list:
// nothing in `movies` ever references a venue outside it.
function toVenueShowings(blob, idMap) {
  const byVenue = new Map();
  for (const key of Object.keys(blob.venues)) {
    // The key, not the record's own `id` — they agree in every release seen so
    // far, but the key is what `showing.venueId` is written against.
    const id = idMap && isHashId(key) ? (idMap.get(key) ?? key) : key;
    byVenue.set(id, []);
  }
  for (const movie of Object.values(blob.movies)) {
    const showings = Array.isArray(movie.showings)
      ? movie.showings
      : Object.values(movie.showings ?? {});
    const performances = Array.isArray(movie.performances)
      ? movie.performances
      : Object.values(movie.performances ?? {});

    const byShowing = new Map();
    for (const performance of performances) {
      if (!byShowing.has(performance.showingId))
        byShowing.set(performance.showingId, []);
      byShowing.get(performance.showingId).push(performance);
    }

    for (const showing of showings) {
      let venueId = showing.venueId;
      if (idMap && isHashId(venueId)) venueId = idMap.get(venueId) ?? venueId;
      if (!byVenue.has(venueId)) byVenue.set(venueId, []);
      byVenue.get(venueId).push({
        showingId: showing.id,
        title: showing.title,
        url: showing.url,
        category: showing.category,
        seen: showing.seen,
        performances: byShowing.get(showing.id) ?? [],
      });
    }
  }
  return byVenue;
}

// --- the diff --------------------------------------------------------------
//
// Per venue, four numbers.
//
//   a  performances added to showings the venue was already listing
//   n  performances belonging to showings that are new since the last release
//   r  performances that went away, whether or not their showing went with them
//   s  performances whose time moved by under an hour
//
// `a` and `n` are split because compareVenue does not add them together and we
// must. Its `futurePerformances.added` counts only the first: a brand new
// showing is reported as a showing, with its performance count on the entry,
// because the feed it was built for renders that showing as one item and would
// double-count it otherwise. Removals are not symmetric — a removed showing's
// future performances *are* in `removed` — so summing `a + n` against `r` is
// what makes the two sides comparable.
//
// Keeping them apart rather than summing once here is not just faithfulness to
// the source: the split is a signal. On the estate-wide changeover days new
// showings are 7-22% of what arrives, because the chains are extending the
// booking window on films they already list; on quiet days it is 40-85%,
// because what moves is a venue announcing something new.
function diffPair(previous, current, asOf) {
  const venues = {};
  for (const venueId of new Set([...current.keys(), ...previous.keys()])) {
    const latest = current.get(venueId);
    const before = previous.get(venueId);
    // A venue that joins or leaves the tracked estate between two releases has
    // no comparison to make: everything it lists would read as added, or as
    // removed, on the day we started or stopped watching it. The same rule
    // health.mjs applies to a venue that answered in only one of two
    // consecutive checks. This is about the estate, not about listings — a
    // venue that is tracked and listing nothing is an empty array, and its
    // emptying out is a real removal.
    if (!latest || !before) continue;

    const { showings, futurePerformances } = compareVenue(latest, before, asOf);
    const entry = {
      a: futurePerformances.added,
      n: showings.added.reduce(
        (sum, showing) => sum + (showing.futurePerformanceCount ?? 0),
        0,
      ),
      r: futurePerformances.removed,
      s: futurePerformances.rescheduled,
    };
    if (entry.a || entry.n || entry.r || entry.s) venues[venueId] = entry;
  }
  return venues;
}

const addInto = (target, source) => {
  for (const [venueId, entry] of Object.entries(source)) {
    const into = (target[venueId] ??= { a: 0, n: 0, r: 0, s: 0 });
    for (const key of ["a", "n", "r", "s"]) into[key] += entry[key];
  }
};

// --- days ------------------------------------------------------------------

// The pairs a day is made of: every consecutive release pair whose interval
// starts in that day. A day is only finalized once the release that closes its
// last interval exists, which is why `days` never builds past yesterday — the
// first release of today closes yesterday's last interval, and there is always
// one by ~06:00.
function pairsByDay(releases) {
  const byDay = new Map();
  for (let i = 1; i < releases.length; i++) {
    const day = dayOfInterval(releases[i - 1].publishedAt);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(i);
  }
  return byDay;
}

async function buildDays() {
  const releases = readIndex();
  if (releases.length < 2)
    throw new Error(`${INDEX_FILE} has fewer than two releases to compare.`);

  const byDay = pairsByDay(releases);
  const end = shiftDay(today(), -1);
  const known = finalizedDays();
  const since =
    (flag("since", null)?.replaceAll("-", "") ?? null) ??
    (known.length ? known[0] : [...byDay.keys()].sort()[0]);
  const to = flag("to", null)?.replaceAll("-", "") ?? end;

  const wanted = [...byDay.keys()]
    .sort()
    .filter((day) => day >= since && day <= to && day <= end)
    .filter((day) => !existsSync(dayPath(day)));

  // A cold checkout backfilling the year should not pull 10GB without being
  // asked twice; an incremental run sees a day or two and never notices.
  const limit = Number(flag("limit", 40));
  const take = wanted.slice(0, limit);
  if (wanted.length > take.length)
    warn(
      `${wanted.length} days are unaggregated; taking the first ${take.length}. ` +
        `Re-run "npm run diffs:days" to continue.`,
    );

  if (!take.length) {
    console.log(`Every day from ${since} to ${to} is already aggregated.`);
    return;
  }

  const idMap = releases.some(
    (r) => r.tag < HASH_ERA_PIN && dayOfInterval(r.publishedAt) >= take[0],
  )
    ? await venueIdMap(releases)
    : null;

  console.log(
    `Aggregating ${take.length} day(s), ${take[0]} to ${take.at(-1)}...`,
  );

  // Each release is downloaded once: the pairs run in order, so the current
  // release of one pair is the previous release of the next.
  const names = readNames();
  let cache = { index: -1, data: null };
  const load = async (index) => {
    if (cache.index === index) return cache.data;
    const blob = await fetchRelease(releases[index]);
    // Harvested here rather than in the diff, because the diff only ever sees
    // venues that moved and every tracked venue has a name worth keeping.
    harvestNames(names, blob, dayOfInterval(releases[index].publishedAt), idMap);
    const data = toVenueShowings(blob, idMap);
    cache = { index, data };
    return data;
  };

  let written = 0;
  for (const day of take) {
    const indices = byDay.get(day);
    const venues = {};
    const intervals = [];

    for (const i of indices) {
      const previous = await load(i - 1);
      const current = await load(i);
      // The instant the comparison is anchored to, and the only thing that
      // decides which performances are still to come. It is the current
      // release's publish time, never the wall clock, so re-running a pair
      // months later reproduces it exactly — the same reasoning data-diffed
      // gives for not using `Date.now()`.
      const asOf = Date.parse(releases[i].publishedAt);
      addInto(venues, diffPair(previous, current, asOf));
      intervals.push({
        from: releases[i - 1].tag,
        to: releases[i].tag,
        at: releases[i].publishedAt,
      });
    }

    const aggregate = {
      day,
      weekday: weekdayOf(day),
      intervals,
      venues,
    };
    const out = dayPath(day);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(aggregate)}\n`);
    written++;

    const added = Object.values(venues).reduce((s, v) => s + v.a + v.n, 0);
    console.log(
      `  ${day}  ${String(intervals.length).padStart(2)} interval(s)  ` +
        `${String(Object.keys(venues).length).padStart(3)} venues  ` +
        `+${added} performances`,
    );
  }

  writeNames(names);
  console.log(
    `Wrote ${written} day(s); venue names registry now holds ` +
      `${Object.keys(names).length}.`,
  );
}

// --- build -----------------------------------------------------------------

// Venue and chain names come from the Clusterflick data the site build has
// already downloaded, the same way health.mjs gets them. Nothing about the
// venue list is written down here: whatever the releases carried is what the
// page offers.
function nameLookup() {
  if (!existsSync(COMBINED))
    warn(
      `No ${COMBINED}; venues not in the name registry will be labelled by id ` +
        `(run scripts/get-latest-combined-data.sh).`,
    );
  const live = existsSync(COMBINED)
    ? (JSON.parse(readFileSync(COMBINED, "utf8")).venues ?? {})
    : {};
  // The live release first — it is current — with the registry behind it for
  // venues that have since left the estate.
  const registry = readNames();
  return {
    name: (id) => live[id]?.name ?? registry[id]?.name ?? id,
    groupName: (id) => live[id]?.groupName ?? registry[id]?.groupName,
  };
}

// A chain is the id prefix its venues share — how the pipeline groups them —
// and its label is the venues' groupName, but only while one chain claims it.
// Several sites sharing a group are probed under ids that share no prefix, so
// each is a chain of one and all of them would otherwise answer to the same
// name. Kept in step with the same rule in health.mjs.
const chainOf = (venue) =>
  venue.includes("-") ? venue.slice(0, venue.indexOf("-")) : venue;

function build() {
  const days = finalizedDays();
  if (!days.length)
    throw new Error(`No aggregated days. Run "npm run diffs:days".`);

  const cap = Number(flag("days", 400));
  const window = days.slice(-cap);
  if (days.length > window.length)
    console.log(
      `${days.length} days aggregated; the page carries the most recent ${window.length}.`,
    );

  const lookup = nameLookup();
  const venues = {};
  const groupNames = {};
  const dayList = [];

  // The calendar range, not just the days that have files. Releases land about
  // twice a day, but not every day: six days in the first half of 2026 saw no
  // release at all, so no interval STARTED in them and they have no file. The
  // interval covering such a day began the day before and is credited there,
  // which is correct — but a day missing from the series would be drawn as a day
  // the estate added nothing, and those are different facts. They are emitted
  // with `intervals: 0` so the page can say which one it is looking at, the same
  // distinction the health page draws between an hour with no check and an hour
  // where nothing moved.
  const held = new Map(window.map(readDay).map((day) => [day.day, day]));
  const calendar = [];
  for (let day = window[0]; day <= window.at(-1); day = shiftDay(day, 1))
    calendar.push(held.get(day) ?? { day, weekday: weekdayOf(day), intervals: [], venues: {} });

  const uncovered = calendar.filter((day) => !day.intervals.length).length;
  if (uncovered)
    console.log(
      `${uncovered} day(s) in range had no release, so no interval starts in them; ` +
        `they are carried as gaps rather than as zeros.`,
    );

  for (const day of calendar) {
    dayList.push({
      day: asDate(day.day),
      weekday: day.weekday,
      intervals: day.intervals.length,
    });

    for (const [id, entry] of Object.entries(day.venues)) {
      const chain = chainOf(id);
      const venue = (venues[id] ??= {
        id,
        name: lookup.name(id),
        chain,
        daily: {},
      });
      groupNames[chain] ??= lookup.groupName(id);
      // Added-to-existing, added-as-new-showing, removed, rescheduled. An array
      // rather than an object because this is the bulk of the blob: ~28% of the
      // venue x day grid is non-empty, and the keys would be most of the bytes.
      venue.daily[asDate(day.day)] = [entry.a, entry.n, entry.r, entry.s];
    }
  }

  const members = {};
  for (const [id, venue] of Object.entries(venues))
    (members[venue.chain] ??= []).push(id);
  // A chain of one is named after its venue, whatever its groupName says, and
  // that is settled BEFORE the remaining claims on a groupName are counted.
  //
  // The order matters. Several sites sharing a group are probed under ids that
  // share no prefix — three Olympic Studios, two Castle Cinemas, Curzon Sea
  // Containers apart from the other ten Curzons — so each is a chain of one
  // here. Counting their claims alongside the real chain's makes every shared
  // groupName look contested: "Curzon" is claimed twice, so neither side may
  // have it, and the ten-venue chain falls through to its id and appears in the
  // picker as `curzon.com` beside a "Curzon Sea Containers" that has no such
  // problem. But the singleton was never going to use the name — it is
  // identified by its own, which is what makes it distinguishable in the first
  // place — so its claim is not a claim. Settle those first and "Curzon" has
  // one claimant left, which is the truth.
  //
  // Two chains of MANY sharing a groupName is still a genuine collision with no
  // better answer than their ids, and still warned about below.
  const chains = {};
  const claims = {};
  for (const [chain, ids] of Object.entries(members)) {
    if (ids.length === 1) chains[chain] = venues[ids[0]].name;
    else if (groupNames[chain])
      claims[groupNames[chain]] = (claims[groupNames[chain]] ?? 0) + 1;
  }
  for (const [chain, ids] of Object.entries(members)) {
    if (ids.length === 1) continue;
    const group = groupNames[chain];
    chains[chain] = group && claims[group] === 1 ? group : chain;
  }
  const labelCounts = {};
  for (const label of Object.values(chains))
    labelCounts[label] = (labelCounts[label] ?? 0) + 1;
  const collisions = Object.keys(labelCounts).filter((l) => labelCounts[l] > 1);
  if (collisions.length)
    warn(`Chains still sharing a display name: ${collisions.join(", ")}.`);

  // Compared against the key, not a field on the record — an earlier version
  // read `v.id`, which the record did not carry, so the check was always false
  // and thirteen venues shipped labelled by domain without a word about it.
  const unnamed = Object.entries(venues)
    .filter(([id, venue]) => venue.name === id)
    .map(([id]) => id);
  if (unnamed.length)
    warn(
      `${unnamed.length} venue(s) have no name in the combined data or the ` +
        `registry and are labelled by id: ${unnamed.join(", ")}. ` +
        `Run "npm run diffs:names" to look them up in the releases they appear in.`,
    );

  const blob = {
    generatedAt: new Date().toISOString(),
    timezone: "Europe/London",
    source: `https://github.com/clusterflick/data-combined/releases`,
    // What the four numbers in `daily` are, in order, so the page does not have
    // to hard-code the meaning of an array.
    metrics: ["addedToExisting", "addedAsNewShowing", "removed", "rescheduled"],
    from: dayList[0].day,
    to: dayList.at(-1).day,
    days: dayList,
    chains,
    venues,
  };

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(blob));

  const added = Object.values(venues).reduce(
    (sum, v) =>
      sum + Object.values(v.daily).reduce((a, [x, y]) => a + x + y, 0),
    0,
  );
  const bytes = readFileSync(OUT_FILE).length;
  console.log(
    `Wrote ${dayList.length} days (${added.toLocaleString()} performances added, ` +
      `${Object.keys(venues).length} venues, ${Object.keys(chains).length} chains) ` +
      `-> ${OUT_FILE} (${(bytes / 1000).toFixed(1)} KB)`,
  );
}

// --- verify ----------------------------------------------------------------
//
// clusterflick/data-diffed publishes this same comparison over data-transformed
// releases. We run the vendored code over data-combined instead, which is a
// different input shape and a different repository, so "the numbers agree" is
// worth being able to demonstrate rather than assert — both when the adapter
// changes and when the vendored copy is refreshed against upstream.
//
// Release tags across the pipeline are London wall time, and a run publishes
// its transformed release a few minutes before its combined one, so a
// data-diffed release names transformed tags that have to be matched to the
// combined releases from the same run: the first combined release published at
// or after the tag's instant.

const londonOffset = (instant) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  return (
    Date.UTC(
      +parts.year,
      +parts.month - 1,
      +parts.day,
      +parts.hour,
      +parts.minute,
      +parts.second,
    ) - instant
  );
};

function tagInstant(tag) {
  const wall = Date.UTC(
    +tag.slice(0, 4),
    +tag.slice(4, 6) - 1,
    +tag.slice(6, 8),
    +tag.slice(9, 11),
    +tag.slice(11, 13),
    +tag.slice(13, 15),
  );
  // Fixed point: the offset depends on the instant, which depends on the offset.
  let instant = wall;
  for (let i = 0; i < 3; i++) instant = wall - londonOffset(instant);
  return instant;
}

async function verify() {
  const tag = flag("tag", null);
  if (!tag)
    throw new Error(
      `Pass --tag <data-diffed release tag>, e.g. ` +
        `"node diffs.mjs verify --tag 20260902.055521". Tags are listed at ` +
        `https://github.com/${DIFFED_REPO}/releases`,
    );

  const url = `https://github.com/${DIFFED_REPO}/releases/download/${tag}/diffed-data.json`;
  console.log(`Fetching ${DIFFED_REPO} ${tag}...`);
  const theirs = await withRetry(`download ${tag}`, async () => {
    const res = await fetch(url, {
      headers: { "User-Agent": "everycinema.london" },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  });

  // The two repositories are not one-to-one: a pipeline run publishes its
  // transformed release a few minutes before its combined one, but some runs
  // produce a transformed release and no combined one at all. On 25 August
  // data-transformed published at 18:00 and data-combined went from 12:51
  // straight to 23:49, so the naive "first combined release at or after the
  // tag" is six hours late and every removal in those six hours reads as a
  // disagreement about the diff. The skew when a run does publish both is 4-34
  // minutes across the whole overlap, so anything beyond an hour is a run with
  // no combined counterpart, and there is simply nothing to check it against.
  //
  // None of this touches `days`, which diffs consecutive combined releases and
  // covers every interval exactly once whatever data-transformed did.
  const releases = readIndex();
  const tolerance = Number(flag("tolerance", 60)) * 60000;
  const pick = (transformedTag) => {
    const at = tagInstant(transformedTag);
    const match = releases.find((r) => Date.parse(r.publishedAt) >= at);
    if (!match)
      throw new Error(
        `No data-combined release at or after ${transformedTag}; ` +
          `run "npm run history:index".`,
      );
    const skew = Date.parse(match.publishedAt) - at;
    if (skew > tolerance) return { release: match, skew };
    return { release: match };
  };

  const previous = pick(theirs.metadata.previousRelease);
  const current = pick(theirs.metadata.currentRelease);
  for (const [label, picked] of [
    [theirs.metadata.previousRelease, previous],
    [theirs.metadata.currentRelease, current],
  ]) {
    if (!picked.skew) continue;
    console.log(
      `\nNothing to verify: the pipeline run tagged ${label} published no ` +
        `data-combined release. The nearest is ${picked.release.tag}, ` +
        `${(picked.skew / 60000).toFixed(0)} minutes later, which is a ` +
        `different snapshot rather than a late one. Pick another release.`,
    );
    return;
  }
  console.log(
    `  ${theirs.metadata.previousRelease} -> combined ${previous.release.tag}\n` +
      `  ${theirs.metadata.currentRelease} -> combined ${current.release.tag}\n` +
      `  asOf ${theirs.metadata.asOf}`,
  );

  const idMap =
    current.release.tag < HASH_ERA_PIN ? await venueIdMap(releases) : null;
  const asOf = Date.parse(theirs.metadata.asOf);
  const ours = diffPair(
    toVenueShowings(await fetchRelease(previous.release), idMap),
    toVenueShowings(await fetchRelease(current.release), idMap),
    asOf,
  );

  let checked = 0;
  const mismatches = [];
  for (const [id, venue] of Object.entries(theirs.venues)) {
    const { added, removed, rescheduled } = venue.futurePerformances;
    // Venues data-diffed lists only because they were added, removed or emptied
    // carry no comparison, and diffPair skips them for the same reason.
    if (venue.venueAdded || venue.venueRemoved) continue;
    const mine = ours[id] ?? { a: 0, n: 0, r: 0, s: 0 };
    checked++;
    if (mine.a !== added || mine.r !== removed || mine.s !== rescheduled)
      mismatches.push(
        `  ${id.padEnd(38)} theirs +${added}/-${removed} r${rescheduled}  ` +
          `ours +${mine.a}/-${mine.r} r${mine.s}`,
      );
  }
  // The other direction: movement we report that they do not, which a shape bug
  // in the adapter would produce and a comparison of their list alone would miss.
  //
  // Reschedule-only venues are the one expected absence. `hasChanges` in
  // data-diffed's build-diff.js publishes a venue only when a showing was added,
  // removed or modified, and a showing counts as modified for a reschedule only
  // when the move is at least the hour that made it a reschedule in the first
  // place — so a venue whose entire movement was a showtime shifting by twenty
  // minutes is legitimately not in their blob while it is in ours. That is a
  // difference in what gets published, not in what was counted.
  const extra = Object.keys(ours).filter(
    (id) => !theirs.venues[id] && (ours[id].a || ours[id].n || ours[id].r),
  );

  console.log(
    `\nCompared ${checked} venue(s); ${mismatches.length} mismatch(es), ` +
      `${extra.length} venue(s) we report and they do not.`,
  );
  if (mismatches.length) console.log(mismatches.slice(0, 20).join("\n"));
  if (extra.length)
    console.log(
      extra
        .slice(0, 20)
        .map((id) => `  ${id.padEnd(38)} ours ${JSON.stringify(ours[id])}`)
        .join("\n"),
    );

  if (mismatches.length || extra.length) {
    console.error(
      `\nThe vendored comparison no longer reproduces ${DIFFED_REPO}. ` +
        `Check vendor/clusterflick-diff/ against upstream before trusting ` +
        `data-diffs/.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`Exact match against ${DIFFED_REPO} ${tag}.`);
  }
}

// --- names -----------------------------------------------------------------

// Backfill the registry for venues already held in day files. Only needed once,
// for days aggregated before `days` started writing names down; from then on
// the registry keeps itself.
//
// The releases are 19MB each, so this looks for the fewest that answer for the
// most: a venue appears in every release either side of a day it moved on, so
// any of that day's interval tags will name it, and one release usually names
// several of the missing at once.
async function backfillNames() {
  const registry = readNames();
  const live = existsSync(COMBINED)
    ? (JSON.parse(readFileSync(COMBINED, "utf8")).venues ?? {})
    : {};

  // Every release tag that would answer for a venue we cannot name.
  const candidates = new Map(); // tag -> Set(venueId)
  for (const day of finalizedDays().map(readDay)) {
    for (const id of Object.keys(day.venues)) {
      if (live[id]?.name || registry[id]?.name) continue;
      for (const interval of day.intervals) {
        for (const tag of [interval.from, interval.to]) {
          if (!candidates.has(tag)) candidates.set(tag, new Set());
          candidates.get(tag).add(id);
        }
      }
    }
  }

  const missing = new Set([...candidates.values()].flatMap((set) => [...set]));
  if (!missing.size) {
    console.log("Every venue in data-diffs/ already has a name.");
    return;
  }
  console.log(`${missing.size} venue(s) need a name; searching releases...`);

  const releases = readIndex();
  const byTag = new Map(releases.map((release) => [release.tag, release]));
  // Only built if a hash-era release is actually reached, since it costs a
  // release download of its own.
  let idMap = null;
  let fetched = 0;
  while (missing.size) {
    // The release that would name the most of what is still missing.
    let best = null;
    for (const [tag, ids] of candidates) {
      if (!byTag.has(tag)) continue;
      const hits = [...ids].filter((id) => missing.has(id)).length;
      if (hits && (!best || hits > best.hits)) best = { tag, hits };
    }
    if (!best) break;

    const release = byTag.get(best.tag);
    if (release.tag < HASH_ERA_PIN) idMap ??= await venueIdMap(releases);
    const blob = await fetchRelease(release);
    harvestNames(registry, blob, dayOfInterval(release.publishedAt), idMap);
    fetched++;
    const resolved = [...missing].filter((id) => registry[id]);
    for (const id of resolved) missing.delete(id);
    console.log(
      `  ${release.tag}  named ${resolved.length}, ${missing.size} still missing`,
    );
    candidates.delete(best.tag);
  }

  writeNames(registry);
  console.log(
    `Fetched ${fetched} release(s); registry holds ${Object.keys(registry).length} name(s).`,
  );
  if (missing.size)
    warn(
      `Still unnamed: ${[...missing].join(", ")}. These appear in a day file ` +
        `but carry no name in any release that day, which should not happen — ` +
        `check the day files that mention them.`,
    );
}

// --- cli -------------------------------------------------------------------

const commands = { days: buildDays, build, verify, names: backfillNames };
if (!commands[command]) {
  console.error(
    "Usage: node diffs.mjs <days|build|verify|names>\n" +
      "  --since YYYY-MM-DD   earliest day to aggregate (default: the earliest already held)\n" +
      "  --to YYYY-MM-DD      latest day to aggregate (default: yesterday)\n" +
      "  --limit N            cap how many days one run aggregates (default 40)\n" +
      "  --days N             days of history the site blob carries (default 400)\n" +
      "  --tag TAG            (verify) the data-diffed release to check against\n" +
      "  --tolerance N        (verify) minutes a combined release may lag its transformed tag (default 60)",
  );
  process.exit(1);
}
await commands[command]();
