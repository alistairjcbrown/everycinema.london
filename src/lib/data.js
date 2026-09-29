// Build-time access to the data blobs in public/data/, and everything derived
// from them for the pages that are rendered rather than scripted: the venue
// pages, the venue index and the home page.
//
// Nothing here runs in the browser. The blobs are the same ones the pipeline
// scripts write (transform.mjs, history.mjs, health.mjs, diffs.mjs), read once
// per build and cached, so ~350 venue pages cost one parse of each.
//
// Where a figure here also appeared on the old venue-health or publishing pages,
// it is computed the same way, and the comments say which rule it is mirroring
// — the reasoning for each lives with the original in git history and in the
// README, and is not repeated here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { builtAt } from "./build.js";

// process.cwd() rather than import.meta.url: Astro bundles page frontmatter into
// chunks under dist/, so a module-relative path stops pointing at public/ once
// built. The build always runs from the repository root.
const DATA_DIR = join(process.cwd(), "public", "data");

const cache = new Map();
export function blob(name) {
  if (!cache.has(name)) {
    cache.set(name, JSON.parse(readFileSync(join(DATA_DIR, `${name}.json`), "utf8")));
  }
  return cache.get(name);
}

// ---------------------------------------------------------------------------
// Dates, all in London
// ---------------------------------------------------------------------------

const dayParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function londonDay(ms) {
  const p = Object.fromEntries(dayParts.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export const londonTime = (ms) => timeFormat.format(ms);

// A calendar day as a Date at midday UTC, which is never on the wrong side of a
// DST change in London — the same convention the chart modules use.
export const asDate = (day) => new Date(`${day}T12:00:00Z`);
export const addDays = (day, n) => {
  const d = asDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const weekdayOf = (day) => asDate(day).getUTCDay(); // 0 = Sunday
export const mondayOf = (day) => addDays(day, -((weekdayOf(day) + 6) % 7));

export const today = londonDay(builtAt.getTime());

// Dates without a year read as this year, so a listing next May says so.
export const longDay = (day) => (day.slice(0, 4) === today.slice(0, 4) ? fmtLong : fmtLongYear).format(asDate(day));
export const shortDay = (day) => (day.slice(0, 4) === today.slice(0, 4) ? fmtShort : fmtShortYear).format(asDate(day));

export const fmtInt = new Intl.NumberFormat("en-GB");
export const fmtDay = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
export const fmtShort = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const fmtLong = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
export const fmtMonth = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });
const fmtLongYear = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const fmtShortYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// Monday-first, keyed by Date#getUTCDay, matching the chart modules.
export const WEEK = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---------------------------------------------------------------------------
// Showtimes, grouped by venue once
// ---------------------------------------------------------------------------

const ACCESS_LABELS = {
  audioDescription: "AD",
  subtitled: "Subtitled",
  hardOfHearing: "HoH",
  babyFriendly: "Baby",
  relaxed: "Relaxed",
};

let byVenue = null;
// Every performance in the current release that has not started by the time the
// build ran, grouped by venue and sorted by start. A release is published a few
// hours before the deploy that renders it, so a handful of its earliest
// performances are already over; listing them as "on" would be wrong.
function performancesByVenue() {
  if (byVenue) return byVenue;
  const { movies, genres, access } = blob("cinemadata");
  const codeToLabel = Object.fromEntries(
    Object.entries(access).map(([key, code]) => [code, ACCESS_LABELS[key] ?? key]),
  );
  const now = builtAt.getTime();
  byVenue = new Map();
  for (const movie of movies) {
    const film = {
      id: movie.id,
      title: movie.title,
      year: movie.year || null,
      cert: movie.cert || null,
      duration: movie.dur || null,
      poster: movie.poster || null,
      genres: (movie.genres || []).map((g) => genres[g]).filter(Boolean),
    };
    for (const p of movie.perf) {
      if (p.t < now) continue;
      const list = byVenue.get(p.v) ?? [];
      list.push({
        t: p.t,
        day: londonDay(p.t),
        time: londonTime(p.t),
        film,
        screen: p.sc || null,
        notes: p.no || null,
        booking: p.b || null,
        soldOut: !!p.so,
        tags: [p.dim, p.pr, ...(p.a || []).map((c) => codeToLabel[c] ?? c)].filter(Boolean),
      });
      byVenue.set(p.v, list);
    }
  }
  for (const list of byVenue.values()) list.sort((a, b) => a.t - b.t);
  return byVenue;
}

// ---------------------------------------------------------------------------
// The venue index
// ---------------------------------------------------------------------------

let index = null;

// Every venue any of the three sources knows, keyed by the id they share.
//
// The sources overlap without nesting: the current release lists 261 venues
// with something on, the publishing diffs have 320 (including venues listing
// nothing right now, and some no longer tracked), and the health log probes 96,
// all of which the diffs also know. A venue gets a page if any of them has
// anything to say about it.
//
// Names prefer the current release, then the diffs' registry (which remembers
// venues that have since left), then the health log. A chain is the id prefix
// its venues share, as upstream groups its probes; its label comes from the
// diffs or the health log, which both settle shared group names the same way.
export function venueIndex() {
  if (index) return index;
  const cinema = blob("cinemadata");
  const diffs = blob("diffs");
  const health = blob("health");
  const perfs = performancesByVenue();

  const ids = new Set([
    ...Object.keys(cinema.venues),
    ...Object.keys(diffs.venues),
    ...Object.keys(health.venues),
  ]);

  const venues = [];
  for (const id of ids) {
    const c = cinema.venues[id];
    const d = diffs.venues[id];
    const h = health.venues[id];
    const chain = d?.chain ?? h?.chain ?? id.split("-")[0];
    const upcoming = perfs.get(id) ?? [];
    let added = 0;
    if (d) for (const entry of Object.values(d.daily)) added += entry[0] + entry[1];
    venues.push({
      id,
      name: c?.n ?? d?.name ?? h?.name ?? id,
      type: c?.t ?? null,
      chain,
      chainLabel: diffs.chains[chain] ?? health.chains[chain] ?? null,
      listed: upcoming.length,
      films: new Set(upcoming.map((p) => p.film.id)).size,
      added: d ? added : null,
      answered: h ? answeredShare(h) : null,
      hasHealth: !!h,
      hasPublishing: !!d,
    });
  }

  // A chain is only worth naming where it has more than one venue here; a solo
  // venue's chain label is its own name, and repeating it says nothing.
  const sizes = new Map();
  for (const v of venues) sizes.set(v.chain, (sizes.get(v.chain) ?? 0) + 1);
  for (const v of venues) {
    v.chainSize = sizes.get(v.chain);
    if (v.chainSize < 2) v.chainLabel = null;
    else v.chainLabel ??= v.chain;
  }

  venues.sort((a, b) => a.name.localeCompare(b.name, "en-GB"));
  index = { venues, byId: new Map(venues.map((v) => [v.id, v])) };
  return index;
}

// ---------------------------------------------------------------------------
// Health — the same rules as the retired venue-health page
// ---------------------------------------------------------------------------

const isExpected = (kind) => (blob("health").expectedKinds ?? []).includes(kind);
const isFailure = (kind) => blob("health").failureKinds.includes(kind);
const hasVolume = (venue) =>
  (blob("health").volumeGranularities ?? ["performance", "film-date"]).includes(venue.granularity);

export const outcomeLabel = (kind) =>
  ({
    ok: "Answered",
    "bot-challenge": "Bot challenge",
    "source-maintenance": "Source in maintenance",
    "source-queue": "Held in a queue",
    "no-listings-found": "Nothing listed",
    "expected-closure": "Closed (expected)",
    "unknown-venue-id": "Venue id not found",
    "probe-error": "Check failed",
  })[kind] ?? kind;

// Checks inside a declared closure leave the denominator rather than scoring
// against it; a venue shut for the whole window has no rate at all (null, not
// 0%, so it cannot read as the worst venue on the estate).
function answeredShare(venue) {
  const checks = Object.values(venue.kinds).reduce((a, b) => a + b, 0);
  const closed = Object.entries(venue.kinds).reduce((s, [k, n]) => (isExpected(k) ? s + n : s), 0);
  const open = checks - closed;
  return open ? (100 * (venue.kinds.ok ?? 0)) / open : null;
}

const UNITS = { performance: "performances", "film-date": "film × date pairs" };

function healthFor(id) {
  const health = blob("health");
  const venue = health.venues[id];
  if (!venue) return null;
  const checks = Object.values(venue.kinds).reduce((a, b) => a + b, 0);
  const closed = Object.entries(venue.kinds).reduce((s, [k, n]) => (isExpected(k) ? s + n : s), 0);
  const issues = Object.entries(venue.kinds)
    .filter(([kind]) => kind !== "ok" && !isExpected(kind))
    .sort(([, a], [, b]) => b - a)
    .map(([kind, n]) => ({ kind, n, label: outcomeLabel(kind), failure: isFailure(kind) }));

  // One cell per day of the log, coloured by how the day went. A day's outcome
  // is the share of its open checks that were answered, and the worst thing
  // that happened otherwise, so a day with one failed check still shows it.
  const days = health.days.map(({ day, provisional }) => {
    const kinds = venue.daily[day] ?? {};
    let total = 0;
    let ok = 0;
    let fail = 0;
    let source = 0;
    let shut = 0;
    for (const [kind, n] of Object.entries(kinds)) {
      total += n;
      if (kind === "ok") ok += n;
      else if (isExpected(kind)) shut += n;
      else if (isFailure(kind)) fail += n;
      else source += n;
    }
    const state =
      total === 0 ? "none" : shut === total ? "closed" : ok === total - shut ? "ok" : fail > 0 ? "fail" : "source";
    return { day, total, ok, fail, source, shut, state, provisional: !!provisional };
  });

  // When new listings appear, by hour of day: the share of hourly checks that
  // found more listed than an hour before, summed over the week. Only asked of
  // venues that report a listing volume — the rest cannot answer it, and 0%
  // would say they never publish.
  let byHour = null;
  let publishRate = null;
  if (hasVolume(venue)) {
    byHour = Array.from({ length: 24 }, (_, hour) => {
      let up = 0;
      let compared = 0;
      for (let d = 0; d < 7; d++) {
        up += venue.up[d][hour];
        compared += venue.cmp[d][hour];
      }
      return { hour, up, compared, share: compared ? (100 * up) / compared : null };
    });
    const up = byHour.reduce((s, h) => s + h.up, 0);
    const compared = byHour.reduce((s, h) => s + h.compared, 0);
    publishRate = compared ? (100 * up) / compared : null;
  }

  return {
    from: health.from,
    to: health.to,
    checks,
    closed,
    answered: answeredShare(venue),
    issues,
    days,
    byHour,
    publishRate,
    unit: UNITS[venue.granularity] ?? null,
    granularity: venue.granularity,
  };
}

// ---------------------------------------------------------------------------
// Publishing — the same rules as the retired publishing page
// ---------------------------------------------------------------------------

// A day with no release at all has nothing to say (null, not zero); every
// other day is a real zero if the venue added nothing. Performances added to a
// run already listed and performances on a title that was not listed are kept
// apart, because the split is the signal. See diffs.mjs.
export function publishingRows(ids) {
  const diffs = blob("diffs");
  return diffs.days.map(({ day, weekday, intervals }) => {
    const covered = intervals > 0;
    let extended = 0;
    let fresh = 0;
    let removed = 0;
    for (const id of ids) {
      const entry = diffs.venues[id]?.daily[day];
      if (!entry) continue;
      extended += entry[0];
      fresh += entry[1];
      removed += entry[2];
    }
    return {
      day,
      weekday,
      covered,
      extended: covered ? extended : null,
      fresh: covered ? fresh : null,
      removed: covered ? removed : null,
      total: covered ? extended + fresh : null,
    };
  });
}

function publishingFor(id) {
  const diffs = blob("diffs");
  if (!diffs.venues[id]) return null;
  const rows = publishingRows([id]);
  const covered = rows.filter((r) => r.covered);
  const total = covered.reduce((s, r) => s + r.total, 0);
  const fresh = covered.reduce((s, r) => s + r.fresh, 0);
  const active = covered.filter((r) => r.total > 0);
  const busiest = covered.reduce((best, r) => (r.total > (best?.total ?? 0) ? r : best), null);

  // Weekly rather than daily on a venue page: one venue's series is mostly
  // zeros with the odd spike, and 270 hairline bars read as noise. A week is
  // the cycle most venues publish on anyway.
  const weeks = new Map();
  for (const r of rows) {
    const monday = mondayOf(r.day);
    const w = weeks.get(monday) ?? { week: monday, extended: 0, fresh: 0, covered: 0 };
    if (r.covered) {
      w.extended += r.extended;
      w.fresh += r.fresh;
      w.covered += 1;
    }
    weeks.set(monday, w);
  }

  // Totals, not averages, as the publishing page did — the window does not hold
  // the same number of each weekday.
  const byWeekday = WEEK.map(([index, name]) => {
    const on = covered.filter((r) => r.weekday === index);
    return {
      name,
      extended: on.reduce((s, r) => s + r.extended, 0),
      fresh: on.reduce((s, r) => s + r.fresh, 0),
    };
  });
  const top = byWeekday.reduce((b, d) => (d.extended + d.fresh > b.extended + b.fresh ? d : b), byWeekday[0]);
  const topIndex = WEEK.find(([, n]) => n === top.name)[0];

  return {
    from: diffs.from,
    to: diffs.to,
    total,
    fresh,
    activeDays: active.length,
    coveredDays: covered.length,
    lastAdded: active.at(-1)?.day ?? null,
    busiest: busiest && busiest.total > 0 ? busiest : null,
    // a venue that added nothing has no usual day, and naming Sunday because
    // zero is not less than zero would be an invented fact
    usualDay: total ? WEEKDAY_NAMES[topIndex] : null,
    usualShare: total ? (100 * (top.extended + top.fresh)) / total : null,
    weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    byWeekday,
  };
}

// ---------------------------------------------------------------------------
// One venue, everything
// ---------------------------------------------------------------------------

const UPCOMING_DAYS = 42;

export function venueDetail(id) {
  const { byId, venues } = venueIndex();
  const venue = byId.get(id);
  const upcoming = performancesByVenue().get(id) ?? [];

  // Day -> film -> times, the shape a listings page reads in: a film once per
  // day with its times beside it, not the same title on a row per showing.
  const days = [];
  for (const p of upcoming) {
    let day = days.at(-1);
    if (!day || day.day !== p.day) {
      day = { day: p.day, films: new Map(), count: 0 };
      days.push(day);
    }
    const entry = day.films.get(p.film.id) ?? { film: p.film, showings: [] };
    entry.showings.push(p);
    day.films.set(p.film.id, entry);
    day.count += 1;
  }

  // Every calendar day in the next six weeks, zeros included, so a gap in the
  // listings reads as a gap rather than being closed up.
  const counts = new Map(days.map((d) => [d.day, d.count]));
  const ahead = Array.from({ length: UPCOMING_DAYS }, (_, i) => {
    const day = addDays(today, i);
    return { day, count: counts.get(day) ?? 0 };
  });
  const beyond = upcoming.filter((p) => p.day > ahead.at(-1).day).length;

  // The films with the most showings coming up, for the page's opening line.
  const filmTotals = new Map();
  for (const p of upcoming) {
    const f = filmTotals.get(p.film.id) ?? { film: p.film, count: 0, next: p };
    f.count += 1;
    filmTotals.set(p.film.id, f);
  }
  const topFilms = [...filmTotals.values()].sort((a, b) => b.count - a.count || a.next.t - b.next.t);

  const siblings = venue.chainSize > 1 ? venues.filter((v) => v.chain === venue.chain && v.id !== id) : [];

  return {
    ...venue,
    upcoming: {
      total: upcoming.length,
      days: days.map((d) => ({ day: d.day, count: d.count, films: [...d.films.values()] })),
      ahead,
      beyond,
      last: upcoming.at(-1)?.day ?? null,
      topFilms,
    },
    publishing: publishingFor(id),
    health: healthFor(id),
    siblings,
  };
}

// ---------------------------------------------------------------------------
// London-wide, for the home page and /london/
// ---------------------------------------------------------------------------

// Screenings per completed day, from the finalized history — the part-measured
// boundary day is left off, since only the hours before the last window closed
// are in it.
export function screeningsByDay() {
  const summary = blob("history-summary");
  const { days, partialDay } = summary.finalized;
  return Object.entries(days)
    .filter(([day]) => day < partialDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => ({ day, count }));
}

// What's on across London over the next seven days, by film.
export function comingWeek() {
  const end = addDays(today, 7);
  const films = new Map();
  let total = 0;
  const venues = new Set();
  for (const [venue, list] of performancesByVenue()) {
    for (const p of list) {
      if (p.day >= end) break;
      total += 1;
      venues.add(venue);
      const f = films.get(p.film.id) ?? { film: p.film, count: 0, venues: new Set() };
      f.count += 1;
      f.venues.add(venue);
      films.set(p.film.id, f);
    }
  }
  return {
    total,
    venues: venues.size,
    films: [...films.values()].sort((a, b) => b.count - a.count),
  };
}

export function listedNow() {
  let total = 0;
  const films = new Set();
  const venues = new Set();
  let last = null;
  for (const [venue, list] of performancesByVenue()) {
    total += list.length;
    venues.add(venue);
    for (const p of list) films.add(p.film.id);
    const end = list.at(-1)?.day;
    if (end && (!last || end > last)) last = end;
  }
  return { total, films: films.size, venues: venues.size, last };
}

export const posterUrl = (path, size = "w92") => (path ? `https://image.tmdb.org/t/p/${size}${path}` : null);
