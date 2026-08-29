// Venue health: uptime, and when venues publish.
//
// clusterflick/data-analysed probes every tracked venue's listing endpoint once
// an hour and publishes the rows as one release per London day, tagged YYYYMMDD
// with a `health-log.jsonl` asset (see its .github/workflows/venue-health.yml).
// Each row is one venue in one cycle:
//
//   { cycle, venue, at, granularity, counts, byDate, requests, durationMs,
//     reason? }
//
// `reason.kind` is absent when the venue answered; otherwise it says what was
// seen instead, and it falls into three groups. `bot-challenge`,
// `source-maintenance`, `source-queue` and `no-listings-found` are observations
// about the source; `unknown-venue-id` and `probe-error` mean something is wrong
// on our side; and `expected-closure` is a closure declared upstream, which is
// neither — see FAILURE_KINDS and EXPECTED_KINDS below.
//
// Two questions come out of that log, and this builds the data for both:
//
//   uptime    what share of an hour's checks a venue actually answered
//   publish   when a venue's listings MOVED between one check and the next
//
// The stages mirror history.mjs, for the same reason: a day's log is immutable
// once the day is over, so it is aggregated once and the aggregate is committed.
// A raw day is ~1.8MB and a year of them is not something to re-download on
// every build; the aggregate is ~20KB.
//
//   node health.mjs days     aggregate finalized days into data-health/days/
//   node health.mjs build    merge those + today -> public/data/health.json
//
// `days` is both the backfill and the incremental step: it aggregates every day
// between the earliest one already held and yesterday that has no file yet, so a
// run that failed, or a day the upstream workflow missed, is picked up by the
// next run without anything having to remember that it was skipped.
//
// No GitHub API is involved. A health release's tag is the London date and its
// asset name is fixed, so the download URL is a pure function of the day — which
// means no token, no rate limit, and a missing day is just a 404.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEALTH_DIR = join(__dirname, "data-health");
const DAYS_DIR = join(HEALTH_DIR, "days");
const COMBINED = join(__dirname, "data-combined", "combined-data.json");
const OUT_FILE = join(__dirname, "public", "data", "health.json");

const REPO = "clusterflick/data-analysed";
const ASSET = "health-log.jsonl";
const assetUrl = (day) =>
  `https://github.com/${REPO}/releases/download/${day}/${ASSET}`;

// How far back to look for the first health release when no day has been
// aggregated yet. Bounded so a cold start cannot walk back to 2008; only ever
// paid once, because from then on the earliest day file is the start.
const DISCOVER_MAX_DAYS = 60;
// ...and how many consecutive missing days end that walk. The log is published
// daily; a run of empties that long is the start of the series, not a gap.
const DISCOVER_MISS_RUN = 7;

// Which kinds mean the probe failed rather than observed something. Same split
// the upstream log uses to decide its own exit code — kept here so the site can
// say "we could not see this venue" separately from "the venue said no".
const FAILURE_KINDS = new Set(["unknown-venue-id", "probe-error"]);

// Which kinds mean the venue was never in a position to answer. Upstream
// re-labels a venue that has gone from its chain's own site list, or that lists
// nothing, as `expected-closure` when a declared closure covers the date — a
// refurbishment it has cited and windowed in `common/expected-closures.js`. The
// check did not fail and the source did not push back; the doors were shut, so
// there was no listing to answer with. The site scores these as neither uptime
// nor downtime — see `renderUptime` in src/health.js.
const EXPECTED_KINDS = new Set(["expected-closure"]);

// The one number per venue that says how much is listed. Chains answer at
// different granularities — some report individual performances, some a film ×
// date matrix — so this is never summed across chains, only differenced against
// the same venue's previous check.
//
// A granularity absent from here is one whose answer carries no volume at all:
// `film-and-date-totals` says how many films and how many dates, and a venue can
// add a screening of a film it already lists on a date it already lists and move
// neither number. There is no honest scalar to difference, so `up` and `add`
// stay at zero for those venues.
//
// Their `cmp` and `chg` are still real — "did anything move" is answerable
// without a volume — so the counters stay, and it is the *rate* that has to know
// the difference: a venue that can never reach the numerator must not sit in the
// denominator, or it reads as a venue that never publishes. The site therefore
// reads this list off the blob (`volumeGranularities`) and drops those venues
// from the publish denominator alone. `build` warns when the log carries a
// granularity that is not in here, because upstream adds venues on its own
// schedule and a silent 0% is exactly what this is meant to prevent.
const METRIC = { performance: "performances", "film-date": "filmDatePairs" };

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

// Surfaced on the Actions run summary rather than buried in the log — same
// reasoning as history.mjs: these are all "the data is quietly thin until
// someone runs something".
function warn(message) {
  if (process.env.GITHUB_ACTIONS) console.log(`::warning::${message}`);
  else console.warn(`Warning: ${message}`);
}

// --- London days -----------------------------------------------------------
// The release tag is a London date and `at` is UTC, so through BST a day's first
// cycle carries the previous UTC date. The tag is the grouping key throughout;
// `at` is only ever used for the hour within a day, and that too is read in
// London — the whole point of the publish chart is when a human at the chain was
// at their desk.

const londonParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function londonHour(at) {
  const parts = Object.fromEntries(
    londonParts.formatToParts(new Date(at)).map((p) => [p.type, p.value]),
  );
  return Number(parts.hour);
}

const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" })
    .format(new Date())
    .replaceAll("-", "");

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

// --- download --------------------------------------------------------------

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

// A day with no release is not an error — the workflow may not have run, or the
// day may predate the series — so 404 answers null and every other failure
// throws. Silently treating a 500 as "no data that day" would quietly punch a
// hole in the log that nothing ever notices.
async function fetchDay(day) {
  return withRetry(`download ${day}`, async () => {
    const res = await fetch(assetUrl(day), {
      headers: { "User-Agent": "everycinema.london" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
  });
}

const parseLog = (body) =>
  body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

// --- aggregation -----------------------------------------------------------

// One entry per cycle, in the order the cycles ran. A cycle is eight probe jobs
// stamping their own `at` minutes apart, so the cycle's hour is taken from its
// earliest row rather than per row — otherwise one sample would smear across two
// hour buckets.
function toCycles(rows) {
  const byCycle = new Map();
  for (const row of rows) {
    if (!byCycle.has(row.cycle)) byCycle.set(row.cycle, []);
    byCycle.get(row.cycle).push(row);
  }
  return [...byCycle.entries()]
    .map(([cycle, cycleRows]) => {
      const at = cycleRows.reduce((a, r) => (r.at < a ? r.at : a), cycleRows[0].at);
      return { cycle, at, hour: londonHour(at), rows: cycleRows };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

const zeros = () => new Array(24).fill(0);

// What a venue was listing at the end of a cycle, as the thing the next cycle is
// differenced against. `counts` alone, not `byDate`: the per-date breakdown is
// ~50 entries per venue per cycle and carrying it forward would make the day
// files an order of magnitude larger to answer a question nothing asks.
const signature = (row) =>
  row.counts ? { g: row.granularity, c: row.counts } : null;

// Key order in the upstream rows is stable, but a comparison that would report a
// publish if it ever stopped being is not worth the two lines it saves.
const canonical = (counts) =>
  Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
const sameCounts = (a, b) => canonical(a.c) === canonical(b.c);

// Roll one day's rows into the per-venue shape that gets committed.
//
// `previous` is the last cycle of the day before, so the first cycle of this day
// is compared against something rather than being dropped. Without it every
// day's opening hour would contribute no publish observation, which would put a
// permanent hole in exactly the hour the chart is asked about.
function aggregateDay(day, rows, previous = {}) {
  const cycles = toCycles(rows);
  const venues = {};
  const hours = zeros();
  let last = { ...previous };

  for (const cycle of cycles) {
    hours[cycle.hour] += 1;
    const seen = {};

    for (const row of cycle.rows) {
      const venue = (venues[row.venue] ??= {
        g: row.granularity ?? null,
        k: {},
        cmp: zeros(),
        chg: zeros(),
        up: zeros(),
        add: zeros(),
      });
      if (row.granularity) venue.g = row.granularity;

      const kind = row.reason?.kind ?? "ok";
      venue.k[kind] = (venue.k[kind] ?? 0) + 1;

      const now = signature(row);
      if (now) seen[row.venue] = now;
      const before = last[row.venue];
      // Only compare consecutive checks where the venue answered BOTH times. A
      // venue coming back from three challenged hours has certainly changed, but
      // attributing three hours of change to the hour it came back would read as
      // a publish — so the pair is left out of the denominator as well as the
      // numerator, and the chart says nothing rather than something wrong.
      if (!now || !before) continue;
      venue.cmp[cycle.hour] += 1;
      if (!sameCounts(before, now)) venue.chg[cycle.hour] += 1;

      // Net new listings, in whatever the venue's own granularity counts, and
      // whether the check saw any at all.
      //
      // `up` is the metric the publish chart is built on rather than `chg`,
      // because `chg` cannot tell publishing from the midnight rollover: at
      // 00:00 the day that just ended falls out of every venue's listing at
      // once, so `dates` drops estate-wide and a third of venues read as
      // "changed" with nobody having published anything. An increase can only
      // be new listings. It is also unit-free, so unlike `add` it can be summed
      // over chains that count different things.
      const metric = METRIC[now.g];
      if (metric && before.g === now.g) {
        const delta = (now.c[metric] ?? 0) - (before.c[metric] ?? 0);
        if (delta > 0) {
          venue.up[cycle.hour] += 1;
          venue.add[cycle.hour] += delta;
        }
      }
    }

    // Replaced, not merged: a venue that answered in neither this cycle nor the
    // one before has no state to carry, and a probe job that died leaves its
    // venues out of the cycle entirely — the same fact as a challenge, and it
    // gets the same treatment. "Answered in both of two consecutive cycles" is
    // then the whole rule, with no second path through it.
    last = seen;
  }

  // An hour array that is all zeros carries nothing, and most venues have at
  // least one — a chain that never publishes overnight, a venue whose listing
  // count never moved all day. Dropping them takes about a third off a day file,
  // which matters when every one of them is committed forever.
  for (const venue of Object.values(venues)) {
    for (const key of ["cmp", "chg", "up", "add"]) {
      if (venue[key].every((n) => n === 0)) delete venue[key];
    }
  }

  return {
    day,
    weekday: weekdayOf(day),
    cycles: cycles.length,
    hours,
    venues,
    // What the next day differences its first cycle against: the last cycle's
    // answers, by the same rule as every comparison within the day.
    tail: last,
  };
}

// --- days ------------------------------------------------------------------

// Where to start looking when nothing has been aggregated yet: walk back from
// yesterday until the releases run out. Only ever runs on a cold checkout.
async function discoverStart(end) {
  console.log(`No aggregated days yet; looking for the start of the log...`);
  let start = null;
  let misses = 0;
  for (let i = 0; i < DISCOVER_MAX_DAYS; i++) {
    const day = shiftDay(end, -i);
    const body = await fetchDay(day);
    if (body === null) {
      if (++misses >= DISCOVER_MISS_RUN) break;
      continue;
    }
    misses = 0;
    start = day;
  }
  if (start) console.log(`  earliest release is ${start}`);
  return start;
}

async function buildDays() {
  const end = shiftDay(today(), -1); // today's log is still being appended to
  const known = finalizedDays();
  const since =
    flag("since", null) ??
    (known.length ? known[0] : await discoverStart(end));

  if (!since) {
    console.log(`No ${ASSET} releases found in ${REPO}.`);
    return;
  }

  // Every day in range that has no file yet, oldest first — a day's aggregate
  // needs the previous day's tail, so they cannot be built out of order.
  const wanted = [];
  for (let day = since; day <= end; day = shiftDay(day, 1)) {
    if (!existsSync(dayPath(day))) wanted.push(day);
  }
  // An incremental run should see the handful of days since the last one. A cold
  // checkout backfilling a year should not pull it all in one go without asking.
  const limit = Number(flag("limit", 400));
  const take = wanted.slice(-limit);
  if (wanted.length > take.length)
    warn(
      `${wanted.length} days are unaggregated; taking the most recent ${take.length}. ` +
        `Re-run "npm run health:days" to continue.`,
    );

  if (!take.length) {
    console.log(`Every day from ${since} to ${end} is already aggregated.`);
    return;
  }

  console.log(`Aggregating ${take.length} day(s), ${take[0]} to ${take.at(-1)}...`);
  let written = 0;
  let empty = 0;
  for (const day of take) {
    const body = await fetchDay(day);
    if (body === null) {
      empty++;
      console.log(`  ${day}  no release`);
      continue;
    }
    // The previous day's tail, when we have it. A gap in the series just means
    // the day after it opens with no comparison, which is correct: we genuinely
    // do not know what moved across the hole.
    const rows = parseLog(body);
    if (!rows.length) {
      // An asset with no rows is a broken cycle upstream, not a quiet day.
      // Writing a file for it would freeze that hole in place forever; leaving
      // it means the next run tries again.
      empty++;
      warn(`${day} has a ${ASSET} asset with no rows; skipping.`);
      continue;
    }
    const before = shiftDay(day, -1);
    const previous = existsSync(dayPath(before)) ? readDay(before).tail : {};
    const aggregate = aggregateDay(day, rows, previous);
    const out = dayPath(day);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(aggregate)}\n`);
    written++;
    console.log(
      `  ${day}  ${String(aggregate.cycles).padStart(2)} cycles  ` +
        `${Object.keys(aggregate.venues).length} venues`,
    );
  }

  console.log(
    `Wrote ${written} day(s)` + (empty ? `; ${empty} had no release.` : "."),
  );
}

// --- build -----------------------------------------------------------------

// Venue and chain names come from the Clusterflick data the site build has
// already downloaded, keyed by the same cinema id the health log uses. Nothing
// about the venue list is written down here: whatever the log carries is what
// the page offers, and a venue added upstream appears on its own.
function nameLookup() {
  if (!existsSync(COMBINED)) {
    warn(
      `No ${COMBINED}; venues will be labelled by id ` +
        `(run scripts/get-latest-combined-data.sh).`,
    );
    return {};
  }
  const { venues } = JSON.parse(readFileSync(COMBINED, "utf8"));
  return venues ?? {};
}

// The chain a venue belongs to is the id prefix its venues share — which is how
// the upstream probes are grouped in the first place (`id.startsWith(group + "-")`),
// and is a domain, so the first hyphen is the split. A venue probed on its own
// has no suffix and is its own chain.
const chainOf = (venue) =>
  venue.includes("-") ? venue.slice(0, venue.indexOf("-")) : venue;

const addInto = (target, source) => {
  for (let i = 0; i < source.length; i++) target[i] += source[i];
};

async function build() {
  const days = finalizedDays();
  const cap = Number(flag("days", 120));
  const window = days.slice(-cap);
  if (days.length > window.length)
    console.log(
      `${days.length} days aggregated; the page carries the most recent ${window.length}.`,
    );

  // Today's log, aggregated but not committed — it is still being appended to,
  // and re-aggregating it is cheap. Fetched here rather than in `days` because
  // the CI job that writes day files and the one that builds the site are
  // deliberately different checkouts.
  let provisional = null;
  if (!has("no-provisional")) {
    const day = today();
    const body = await fetchDay(day).catch((err) => {
      warn(`Could not fetch today's health log: ${err.message}`);
      return null;
    });
    if (body) {
      const before = window.at(-1);
      const previous =
        before === shiftDay(day, -1) ? readDay(before).tail : {};
      if (before && before !== shiftDay(day, -1))
        warn(
          `The last aggregated day is ${before}, not yesterday; ` +
            `today opens with no comparison. Run "npm run health:days".`,
        );
      provisional = aggregateDay(day, parseLog(body), previous);
    }
  }

  const all = [...window.map(readDay), provisional].filter(Boolean);
  if (!all.length)
    throw new Error(
      `No health data. Run "npm run health:days" (and check ${REPO} has releases).`,
    );

  const names = nameLookup();
  const venues = {};
  const groupNames = {};
  const dayList = [];

  for (const day of all) {
    dayList.push({
      day: asDate(day.day),
      weekday: day.weekday,
      cycles: day.cycles,
      hours: day.hours,
      provisional: day === provisional || undefined,
    });

    for (const [id, entry] of Object.entries(day.venues)) {
      const chain = chainOf(id);
      const venue = (venues[id] ??= {
        name: names[id]?.name ?? id,
        chain,
        granularity: entry.g,
        kinds: {},
        daily: {},
        // 7 × 24, Sunday-first to match `weekday`. The site re-orders it.
        cmp: Array.from({ length: 7 }, zeros),
        chg: Array.from({ length: 7 }, zeros),
        up: Array.from({ length: 7 }, zeros),
        add: Array.from({ length: 7 }, zeros),
      });
      if (entry.g) venue.granularity = entry.g;
      // Collected, not resolved: what a groupName is worth as a chain label
      // depends on how many other chains claim it, which is not known until
      // every venue is in. `??=` so a chain whose first venue carries no
      // groupName can still take one from a later venue.
      groupNames[chain] ??= names[id]?.groupName;

      venue.daily[asDate(day.day)] = entry.k;
      for (const [kind, n] of Object.entries(entry.k))
        venue.kinds[kind] = (venue.kinds[kind] ?? 0) + n;
      // Absent means all-zero (see aggregateDay), so there is nothing to add.
      if (entry.cmp) addInto(venue.cmp[day.weekday], entry.cmp);
      if (entry.chg) addInto(venue.chg[day.weekday], entry.chg);
      if (entry.up) addInto(venue.up[day.weekday], entry.up);
      if (entry.add) addInto(venue.add[day.weekday], entry.add);
    }
  }

  // Chain labels, resolved now that every venue is in. `groupName` is the label
  // a reader recognises — "Odeon", not "odeon.co.uk" — but it only names a chain
  // while exactly one chain claims it, and that is no longer a given: upstream
  // probes three Olympic Studios sites and two Castle Cinemas under ids that
  // share no prefix, so each is a chain of one here and all three would answer
  // to "Olympic Studios". Indistinguishable in the picker, and worse in the
  // venue table, whose chain filter matches on the label (see `syncGrid`) and
  // would pull in all three while the charts above showed one.
  //
  // So a groupName more than one chain claims gives way to what does tell them
  // apart: the venue's own name for a chain of one, and the id for a chain with
  // no single venue to name it — a case the combined data does not currently
  // produce, but the fallback is a line and a silent collision is not.
  const members = {};
  for (const [id, venue] of Object.entries(venues))
    (members[venue.chain] ??= []).push(id);
  const claims = {};
  for (const group of Object.values(groupNames))
    if (group) claims[group] = (claims[group] ?? 0) + 1;

  const chains = {};
  for (const [chain, ids] of Object.entries(members)) {
    const group = groupNames[chain];
    chains[chain] =
      group && claims[group] === 1
        ? group
        : ids.length === 1
          ? venues[ids[0]].name
          : chain;
  }
  // The disambiguation above is only worth having if it actually disambiguates.
  const labelCounts = {};
  for (const label of Object.values(chains))
    labelCounts[label] = (labelCounts[label] ?? 0) + 1;
  const collisions = Object.keys(labelCounts).filter((l) => labelCounts[l] > 1);
  if (collisions.length)
    warn(
      `Chains still sharing a display name: ${collisions.join(", ")}. ` +
        `The venue table's chain filter matches on the label, so it will show ` +
        `more venues than the selection above it.`,
    );

  // A granularity with no volume metric cannot answer "new listings" at all (see
  // METRIC). The page handles it, but upstream adding one is worth saying out
  // loud: it means a venue is on the page that the publish charts leave out.
  const unmeasured = [
    ...new Set(
      Object.values(venues)
        .map((venue) => venue.granularity)
        .filter((g) => g && !METRIC[g]),
    ),
  ];
  if (unmeasured.length)
    warn(
      `No listing-volume metric for granularity: ${unmeasured.join(", ")}. ` +
        `Venues reporting it are excluded from the publish charts. ` +
        `Add it to METRIC in health.mjs if the log gained a countable field.`,
    );

  const blob = {
    generatedAt: new Date().toISOString(),
    timezone: "Europe/London",
    source: `https://github.com/${REPO}/releases`,
    failureKinds: [...FAILURE_KINDS],
    expectedKinds: [...EXPECTED_KINDS],
    // Which granularities carry a listing volume, and therefore which venues the
    // publish charts can say anything about. Shipped rather than hard-coded on
    // the page so the rule lives in one place: the same list decides here that a
    // check scores no `up` and there that the venue leaves the publish rate's
    // denominator rather than scoring zero in it.
    volumeGranularities: Object.keys(METRIC),
    from: dayList[0].day,
    to: dayList.at(-1).day,
    days: dayList,
    chains,
    venues,
  };

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(blob));

  const observations = Object.values(venues).reduce(
    (sum, v) => sum + Object.values(v.kinds).reduce((a, b) => a + b, 0),
    0,
  );
  const bytes = readFileSync(OUT_FILE).length;
  console.log(
    `Wrote ${dayList.length} days (${observations.toLocaleString()} observations, ` +
      `${Object.keys(venues).length} venues, ${Object.keys(chains).length} chains) ` +
      `-> ${OUT_FILE} (${(bytes / 1000).toFixed(1)} KB)`,
  );
  if (provisional)
    console.log(
      `Today (${asDate(provisional.day)}) is provisional: ${provisional.cycles} cycles so far.`,
    );
  else warn("No provisional day: the page stops at the last finalized day.");
}

// --- cli -------------------------------------------------------------------

const commands = {
  days: buildDays,
  build,
};
if (!commands[command]) {
  console.error(
    "Usage: node health.mjs <days|build>\n" +
      "  --since YYYYMMDD   earliest day to aggregate (default: the earliest already held)\n" +
      "  --limit N          cap how many days one run aggregates (default 400)\n" +
      "  --days N           days of history the site blob carries (default 120)\n" +
      "  --no-provisional   skip today's still-open log",
  );
  process.exit(1);
}
await commands[command]();
