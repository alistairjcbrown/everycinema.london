// Venue-health charts.
//
// One data source: public/data/health.json (~140 KB), built by health.mjs from
// clusterflick/data-analysed's hourly probe log. See that file's header for how
// a day's raw log becomes the per-venue aggregate this reads.
//
// Everything on the page answers to one control — the scope select — which
// resolves to a set of venue ids. Nothing about the venue list is written down
// here: the chains, their venues and their display names all come out of the
// blob, so a venue added to the upstream probe appears here on its own.

import {
  AgCharts,
  ModuleRegistry as ChartModuleRegistry,
  AllCommunityModule as AllChartModules,
} from "ag-charts-community";
// Heatmap is an AG Charts Enterprise series. Day × hour is a grid of magnitudes,
// which is what a heatmap is for — seven overlaid lines would be at the
// palette's ceiling and much harder to read the shape out of.
import {
  HeatmapSeriesModule,
  GradientLegendModule,
} from "ag-charts-enterprise";
import {
  createGrid,
  ModuleRegistry,
  themeQuartz,
  colorSchemeDark,
  ClientSideRowModelModule,
  TextFilterModule,
  NumberFilterModule,
  CellStyleModule, // colours the Answered column when it is not 100%
  TooltipModule, // headerTooltip, where a column header needs a caveat
  enableDevValidations,
} from "ag-grid-community";

if (import.meta.env.DEV) enableDevValidations();

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  TextFilterModule,
  NumberFilterModule,
  CellStyleModule,
  TooltipModule,
]);
ChartModuleRegistry.registerModules([
  ...AllChartModules,
  HeatmapSeriesModule,
  GradientLegendModule,
]);

// Same validated palette as the history page — see src/history.js for what the
// order is protecting. Only the slots this page uses are named.
const ACCENT = "#3b82f6";
const OK_INK = "#199e70"; // aqua — the venue answered
const SOURCE_INK = "#c98500"; // yellow — the source pushed back
const FAIL_INK = "#e66767"; // red — we could not see the venue at all
// Grey rather than a palette slot, and deliberately so: a declared closure is
// the one outcome that is not a result. It should read as stood down next to
// the three inks above, not as a fourth kind of problem competing with them.
const EXPECTED_INK = "#71717a";
const SURFACE = "#1c1c20"; // the .card background these charts sit on
const AXIS_INK = "#a1a1aa";
const GRID_INK = "#2e2e34";
// An hour with no check at all is painted as the card itself, so the cell is
// simply absent — which is what it is. "We did not look" and "we looked and
// nothing moved" are different kinds of fact and a single heat scale cannot say
// both, so the ramp's own floor sits a shade above the surface instead: a zero
// hour is a faint tile you can see, an unsampled one is a hole.
const NO_DATA_INK = SURFACE;

// Sequential ramp for magnitude, one hue from the accent's family, running from
// the card surface up so a quiet hour simply is not there and activity reads as
// light. Stops are fractions of the busiest cell, so the ramp re-fits itself as
// the data grows.
const RAMP = [
  [0, "#242a35"],
  [0.05, "#0d366b"],
  [0.35, "#2a78d6"],
  [0.7, "#9ec5f4"],
  [1, "#cde2fb"],
];

const chartBase = {
  background: { fill: SURFACE },
  padding: { top: 16, right: 16, bottom: 0, left: 4 },
  theme: {
    baseTheme: "ag-default-dark",
    overrides: {
      common: {
        axes: {
          number: {
            label: { color: AXIS_INK },
            gridLine: { style: [{ stroke: GRID_INK }] },
            line: { enabled: false },
          },
          category: {
            label: { color: AXIS_INK },
            gridLine: { enabled: false },
            line: { stroke: GRID_INK },
          },
        },
      },
    },
  },
};

const legendBase = {
  position: "bottom",
  spacing: 32,
  item: {
    padding: { left: 8, right: 44, top: 6, bottom: 6 },
    marker: { size: 10, padding: 10 },
    label: { color: "#e4e4e7", fontSize: 12 },
  },
};

const fmtInt = new Intl.NumberFormat("en-GB");
const fmtDay = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const el = (id) => document.getElementById(id);
const hh = (hour) => `${String(hour).padStart(2, "0")}:00`;
const pct = (n, d, digits = 0) => (d > 0 ? `${((100 * n) / d).toFixed(digits)}%` : "—");

// The blob indexes weekdays 0 = Sunday (Date#getUTCDay), which is the only
// ordering a date can be turned into without a lookup. Monday first here, so the
// weekend sits together at the bottom of the grid and the working week reads as
// a block.
const WEEK = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
];
const WORKING_HOURS = [9, 18]; // [from, until) — "office hours", London

// What each metric means, and how a cell's value is derived from the three
// counters. `share` metrics are a percentage of the checks that could be
// compared; `mean` is a magnitude per check, and is the only one whose units
// depend on which venues are selected.
const METRICS = {
  up: {
    key: "up",
    kind: "share",
    label: "Checks with new listings",
    axis: "% of checks",
    cell: "New listings seen",
    blurb:
      "Share of hourly checks where a venue was listing more than it had been an hour earlier.",
  },
  chg: {
    key: "chg",
    kind: "share",
    label: "Checks where anything moved",
    axis: "% of checks",
    cell: "Listing moved",
    blurb:
      "Share of hourly checks where a venue's counts differed from an hour earlier, in either direction.",
  },
  add: {
    key: "add",
    kind: "mean",
    label: "Listings added",
    axis: "added per check",
    cell: "Added per check",
    blurb:
      "How much was added, averaged over the checks in that hour — in whatever the selected venues count.",
  },
};

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

let blob;
let scope; // { label, venues: [id], granularities: Set }
let metric = "up";
let grid;

// AG Charts instances, created on first paint and updated in place after that.
// Re-creating a chart on every scope change would leak the old one's canvas and
// throw away its enter animation, so each chart is made once and handed new
// options — which is also what makes switching venues feel instant.
const charts = {};
const upsert = (id, options) => {
  if (charts[id]) charts[id].update(options);
  else charts[id] = AgCharts.create(options);
};

const venuesOfChain = (chain) =>
  Object.keys(blob.venues).filter((id) => blob.venues[id].chain === chain);

function setScope(value) {
  const [kind, id] = value.split(":");
  const venues =
    kind === "venue"
      ? [id]
      : kind === "chain"
        ? venuesOfChain(id)
        : Object.keys(blob.venues);
  const label =
    kind === "venue"
      ? blob.venues[id].name
      : kind === "chain"
        ? blob.chains[id]
        : "every venue";
  scope = {
    value,
    kind,
    label,
    venues,
    granularities: new Set(venues.map((v) => blob.venues[v].granularity)),
  };
  el("scope").value = value;
  syncGrid();
  render();
}

// The table is the way back out of a selection, so it narrows to the scope's
// chain rather than to the scope itself: picking one Odeon still leaves the
// other eighteen a click away, and picking "all" puts every venue back.
//
// Written into the chain column's own filter — not the whole grid's filter model
// — so the floating filter shows what is applied, and any filter the reader set
// on another column survives being handed a new scope.
async function syncGrid() {
  if (!grid) return;
  const chain = scope.kind === "all" ? null : blob.chains[chainOfScope()];
  const model = chain
    ? { filterType: "text", type: "equals", filter: chain }
    : null;
  if (
    JSON.stringify(grid.getColumnFilterModel("chain") ?? null) ===
    JSON.stringify(model)
  )
    return;
  await grid.setColumnFilterModel("chain", model);
  grid.onFilterChanged();
}

const chainOfScope = () =>
  scope.kind === "chain" ? scope.value.slice(6) : blob.venues[scope.venues[0]].chain;

// Chains first, then their venues nested under them, both in the order the
// display names sort. A solo venue is a chain of one upstream, and stays one
// here rather than being special-cased into a flat list.
function buildScopeSelect() {
  const select = el("scope");
  select.replaceChildren();

  const all = document.createElement("option");
  all.value = "all:";
  all.textContent = `All venues (${Object.keys(blob.venues).length})`;
  select.append(all);

  const chains = Object.entries(blob.chains).sort(([, a], [, b]) =>
    a.localeCompare(b),
  );
  for (const [chain, name] of chains) {
    const venues = venuesOfChain(chain).sort((a, b) =>
      blob.venues[a].name.localeCompare(blob.venues[b].name),
    );
    const group = document.createElement("optgroup");
    group.label = name;
    const whole = document.createElement("option");
    whole.value = `chain:${chain}`;
    whole.textContent =
      venues.length > 1 ? `All ${name} (${venues.length})` : name;
    group.append(whole);
    // A chain of one would offer the same set twice under two labels
    if (venues.length > 1) {
      for (const id of venues) {
        const option = document.createElement("option");
        option.value = `venue:${id}`;
        option.textContent = blob.venues[id].name;
        group.append(option);
      }
    }
    select.append(group);
  }

  select.addEventListener("change", () => setScope(select.value));
}

// ---------------------------------------------------------------------------
// Aggregation over the current scope
// ---------------------------------------------------------------------------

const zeros = () => new Array(24).fill(0);

// Sum the 7 × 24 counters over a set of venues. Every counter is a count of
// checks (or, for `add`, of listings), so they add — the reason `up` rather than
// `add` is the default metric is that only the former is unit-free and therefore
// safe to sum across chains that count different things.
function weekTotals(venues) {
  const out = {
    cmp: Array.from({ length: 7 }, zeros),
    chg: Array.from({ length: 7 }, zeros),
    up: Array.from({ length: 7 }, zeros),
    add: Array.from({ length: 7 }, zeros),
  };
  for (const id of venues) {
    const venue = blob.venues[id];
    for (const key of ["cmp", "chg", "up", "add"]) {
      for (let day = 0; day < 7; day++) {
        for (let hour = 0; hour < 24; hour++)
          out[key][day][hour] += venue[key][day][hour];
      }
    }
  }
  return out;
}

function kindTotals(venues) {
  const kinds = {};
  for (const id of venues) {
    for (const [kind, n] of Object.entries(blob.venues[id].kinds))
      kinds[kind] = (kinds[kind] ?? 0) + n;
  }
  return kinds;
}

const isFailure = (kind) => blob.failureKinds.includes(kind);
// A closure we declared upstream, and therefore neither an answer nor a fault.
// Defaulted rather than read straight off the blob so a checkout holding a
// health.json built before this existed still renders, one kind short.
const isExpected = (kind) => (blob.expectedKinds ?? []).includes(kind);
const expectedTotal = (kinds) =>
  Object.entries(kinds).reduce(
    (sum, [kind, n]) => (isExpected(kind) ? sum + n : sum),
    0,
  );
const outcomeInk = (kind) =>
  kind === "ok"
    ? OK_INK
    : isExpected(kind)
      ? EXPECTED_INK
      : isFailure(kind)
        ? FAIL_INK
        : SOURCE_INK;
// `no-listings-found` is a source saying there is nothing on; `probe-error` is
// us failing to look; `source-queue` is a virtual waiting room in front of an
// on-sale. None of them reads well as a raw slug in a legend.
const outcomeLabel = (kind) =>
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

// A cell is the metric over one weekday-hour, or null where no check in that
// slot could be compared with the one before it. Null is not zero: it means we
// never looked, and the heatmap has to be able to say so.
function cellValue(totals, day, hour) {
  const compared = totals.cmp[day][hour];
  if (!compared) return null;
  const spec = METRICS[metric];
  const value = totals[spec.key][day][hour];
  return spec.kind === "share" ? (100 * value) / compared : value / compared;
}

// ---------------------------------------------------------------------------
// Uptime
// ---------------------------------------------------------------------------

function renderUptime(totals) {
  const kinds = kindTotals(scope.venues);
  const checks = Object.values(kinds).reduce((a, b) => a + b, 0);
  // Checks a declared closure accounts for are not downtime — and not uptime
  // either. Scoring them would put a venue at 0% for a refurbishment we knew
  // about, cited and wrote a window for, which is the one outcome on this page
  // meaning nothing is wrong at all. So they leave the denominator rather than
  // the numerator: the same rule the publish comparison already applies to a
  // pair it cannot compare — say nothing rather than something wrong. They stay
  // fully visible in the daily chart below, in their own ink.
  const closed = expectedTotal(kinds);
  const open = checks - closed;
  const answered = kinds.ok ?? 0;

  // The hour that most often had something new in it, across the whole window.
  // Always read off `up`, whichever metric the charts are showing: this is the
  // page's one-line answer, and it should not move because a toggle did.
  let best = { hour: null, rate: 0 };
  for (let hour = 0; hour < 24; hour++) {
    let up = 0;
    let compared = 0;
    for (let day = 0; day < 7; day++) {
      up += totals.up[day][hour];
      compared += totals.cmp[day][hour];
    }
    if (compared > 0 && up / compared > best.rate)
      best = { hour, rate: up / compared };
  }

  const stats = [
    ["Venues", fmtInt.format(scope.venues.length)],
    ["Hourly checks", fmtInt.format(checks)],
    ["Answered", pct(answered, open, 1)],
    ["Days observed", fmtInt.format(blob.days.length)],
    ["Peak publish hour", best.hour === null ? "—" : hh(best.hour)],
  ];
  el("stats").replaceChildren(
    ...stats.map(([k, v]) => {
      const wrap = document.createElement("div");
      wrap.className = "stat";
      const value = document.createElement("span");
      value.className = "v";
      value.textContent = v;
      const key = document.createElement("span");
      key.className = "k";
      key.textContent = k;
      wrap.append(value, key);
      return wrap;
    }),
  );

  // Per day, per outcome. Only the outcomes actually seen get a series — a
  // legend full of zero-height categories says nothing.
  const seen = new Set();
  const data = blob.days.map((day) => {
    const row = {
      day: day.day,
      label: fmtDay.format(asDate(day.day)),
      cycles: day.cycles,
      provisional: !!day.provisional,
    };
    for (const id of scope.venues) {
      const daily = blob.venues[id].daily[day.day];
      if (!daily) continue;
      for (const [kind, n] of Object.entries(daily)) {
        row[kind] = (row[kind] ?? 0) + n;
        seen.add(kind);
      }
    }
    return row;
  });
  // `ok` first so the stack reads from the good news up
  const stacked = [...seen].sort((a, b) =>
    a === "ok" ? -1 : b === "ok" ? 1 : a.localeCompare(b),
  );

  upsert("days", {
    ...chartBase,
    container: el("daysChart"),
    data,
    series: stacked.map((kind) => ({
      type: "bar",
      xKey: "label",
      yKey: kind,
      yName: outcomeLabel(kind),
      stacked: true,
      fill: outcomeInk(kind),
      // Today's log is still being appended to, so its bar is short for a reason
      // that has nothing to do with the venues. Dimming it says "not a full day"
      // without dropping a day of real observations off the chart.
      itemStyler: ({ datum }) => (datum.provisional ? { fillOpacity: 0.45 } : {}),
      tooltip: {
        renderer: ({ datum, yKey }) => ({
          title: `${datum.label}${datum.provisional ? " (so far today)" : ""}`,
          data: [
            { label: outcomeLabel(yKey), value: fmtInt.format(datum[yKey] ?? 0) },
            { label: "Cycles", value: fmtInt.format(datum.cycles) },
          ],
        }),
      },
    })),
    axes: {
      x: { type: "category", position: "bottom", label: { color: AXIS_INK } },
      y: {
        type: "number",
        position: "left",
        title: { text: "Checks", color: AXIS_INK },
      },
    },
    legend: { ...legendBase, enabled: stacked.length > 1 },
  });

  el("uptimeSub").textContent =
    `Every tracked venue is asked for its listings once an hour. ` +
    `Showing ${scope.label}, ${blob.from} to ${blob.to}.`;

  // Sampling first — every rate on this page is a rate over these checks, and a
  // cycle that never ran is a hole in all of them.
  const finalized = blob.days.filter((d) => !d.provisional);
  const gaps = finalized.flatMap((day) => {
    const hours = day.hours;
    const from = hours.findIndex((n) => n > 0);
    const to = hours.findLastIndex((n) => n > 0);
    if (from === -1) return [];
    const missing = [];
    for (let hour = from; hour <= to; hour++)
      if (!hours[hour]) missing.push(hh(hour));
    return missing.length ? [`${day.day} (${missing.join(", ")})`] : [];
  });

  const issues = Object.entries(kinds)
    .filter(([kind]) => kind !== "ok" && !isExpected(kind))
    .sort(([, a], [, b]) => b - a);
  // Said rather than silently dropped: closures are why this percentage is over
  // fewer checks than the tile above it counts, and a reader who cannot see
  // that has been handed a number they cannot reconcile.
  const closedNote = closed
    ? ` A further ${fmtInt.format(closed)} ${closed === 1 ? "check fell" : "checks fell"} ` +
      `inside a declared closure and ${closed === 1 ? "is" : "are"} left out.`
    : "";
  // The all-clear no longer names the things that did not happen. That list was
  // a copy of the kind vocabulary, and it went stale the moment upstream added
  // one; there is nothing to keep in step with here.
  const headline = !open
    ? `<strong>Nothing to score</strong> — every venue in scope was closed for the whole window.`
    : issues.length
      ? `<strong>${pct(answered, open, 1)}</strong> of checks got an answer. ` +
        `The rest: ${issues
          .map(([kind, n]) => `${fmtInt.format(n)} ${outcomeLabel(kind).toLowerCase()}`)
          .join(", ")}.`
      : `<strong>Every one of the ${fmtInt.format(open)} checks got an answer</strong> — ` +
        `nothing pushed back and nothing went missing.`;
  el("uptimeNote").innerHTML =
    headline +
    closedNote +
    ` Sampling: ${gaps.length ? `cycles missing at ${gaps.join("; ")}` : "no missing cycles on a completed day"}.`;
}

const asDate = (iso) => new Date(`${iso}T12:00:00Z`); // midday avoids DST edges

// ---------------------------------------------------------------------------
// Publish activity — day × hour
// ---------------------------------------------------------------------------

// Square cells mean the plot area has to hold 24:7 exactly. AG Charts has no
// aspect-ratio option for cartesian charts, so the container is sized here. These
// constants are the room the axis labels and gradient legend take around the
// plot — tune them if that chrome changes, since squareness rides on them.
const CHROME_X = 56;
const CHROME_Y = 88;
const MAX_CELL = 56;

function fitSquareCells(container, cols, rows, matchHeight = []) {
  // Measure the PARENT: setting max-width on the container caps its own
  // measurement, so once narrowed it could never report a wider box again.
  const host = container.parentElement;
  const apply = () => {
    const style = getComputedStyle(host);
    const width =
      host.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    if (!width || width < 0) return;
    const cell = Math.min((width - CHROME_X) / cols, MAX_CELL);
    const height = `${Math.round(cell * rows + CHROME_Y)}px`;
    const maxWidth = `${Math.round(cell * cols + CHROME_X)}px`;
    // only write when it changes, so the observer cannot retrigger on its own
    // mutation
    if (container.style.height !== height) container.style.height = height;
    if (container.style.maxWidth !== maxWidth)
      container.style.maxWidth = maxWidth;
    for (const other of matchHeight) {
      if (other.style.height !== height) other.style.height = height;
    }
  };
  apply();
  new ResizeObserver(apply).observe(host);
}

let sized = false;

function renderWeek(totals) {
  const spec = METRICS[metric];
  const data = [];
  for (const [index, name] of WEEK) {
    for (let hour = 0; hour < 24; hour++) {
      data.push({
        day: name,
        hour: hh(hour).slice(0, 2),
        value: cellValue(totals, index, hour),
        checks: totals.cmp[index][hour],
        up: totals.up[index][hour],
        chg: totals.chg[index][hour],
        add: totals.add[index][hour],
      });
    }
  }
  const values = data.map((d) => d.value).filter((v) => v !== null);
  const peak = values.length ? Math.max(...values) : 0;
  // A ceiling of zero would collapse the colour scale onto a single stop; give
  // it a nominal top so the grid still paints as "nothing anywhere".
  const ceiling = peak > 0 ? peak : 1;

  // Size before creating the chart so the very first paint is square too.
  if (!sized) {
    fitSquareCells(el("weekChart"), 24, WEEK.length, [el("hourChart")]);
    sized = true;
  }

  const format = (value) =>
    spec.kind === "share" ? `${value.toFixed(0)}%` : value.toFixed(1);

  upsert("week", {
    ...chartBase,
    container: el("weekChart"),
    data,
    series: [
      {
        type: "heatmap",
        xKey: "hour",
        yKey: "day",
        colorKey: "value",
        colorName: spec.cell,
        itemPadding: 1,
        colorScale: {
          // pinned to 0 so an hour where nothing happened lands exactly on the
          // card surface rather than on whatever the quietest cell happens to be
          domain: [0, ceiling],
          fills: RAMP.map(([at, color]) => ({ color, stop: at * ceiling })),
        },
        itemStyler: ({ datum }) =>
          datum.value === null ? { fill: NO_DATA_INK } : {},
        tooltip: {
          renderer: ({ datum }) => ({
            title: `${datum.day} ${hh(Number(datum.hour))}`,
            data:
              datum.value === null
                ? [{ label: "Checks", value: "none in this hour" }]
                : [
                    { label: spec.cell, value: format(datum.value) },
                    { label: "Checks compared", value: fmtInt.format(datum.checks) },
                    {
                      label: "Listings added",
                      value: fmtInt.format(datum.add),
                    },
                  ],
          }),
        },
      },
    ],
    axes: {
      x: { type: "category", position: "bottom", label: { color: AXIS_INK } },
      y: { type: "category", position: "left", label: { color: AXIS_INK } },
    },
    gradientLegend: {
      enabled: true,
      position: "bottom",
      gradient: { preferredLength: 260 },
      scale: {
        label: {
          color: AXIS_INK,
          fontSize: 12,
          minSpacing: 12,
          formatter: ({ value }) => format(value),
        },
      },
    },
  });

  el("weekSub").textContent = spec.blurb;

  // The finding worth stating, and the hypothesis the page exists to test:
  // are new listings a working-hours, weekday thing?
  const [from, until] = WORKING_HOURS;
  const bucket = (test) => {
    let value = 0;
    let compared = 0;
    for (const [index] of WEEK) {
      for (let hour = 0; hour < 24; hour++) {
        if (!test(index, hour)) continue;
        value += totals[spec.key][index][hour];
        compared += totals.cmp[index][hour];
      }
    }
    return { value, compared };
  };
  const isWeekday = (day) => day >= 1 && day <= 5;
  const office = bucket((day, hour) => isWeekday(day) && hour >= from && hour < until);
  const rest = bucket((day, hour) => !(isWeekday(day) && hour >= from && hour < until));

  if (!office.compared || !rest.compared) {
    el("weekNote").innerHTML =
      `Not enough of the week has been sampled yet to compare office hours with the rest of it — ` +
      `the log starts on ${blob.from}.`;
    return;
  }
  const officeRate = spec.kind === "share"
    ? (100 * office.value) / office.compared
    : office.value / office.compared;
  const restRate = spec.kind === "share"
    ? (100 * rest.value) / rest.compared
    : rest.value / rest.compared;
  const times = restRate > 0 ? officeRate / restRate : Infinity;
  el("weekNote").innerHTML =
    `Weekdays ${hh(from)}–${hh(until)}: <strong>${format(officeRate)}</strong>, ` +
    `against ${format(restRate)} across the rest of the week — ` +
    (Number.isFinite(times)
      ? `${times >= 1 ? `${times.toFixed(1)}× as much` : `${(1 / times).toFixed(1)}× less`}.`
      : `nothing at all outside them.`);
}

// ---------------------------------------------------------------------------
// Publish activity — hour of day
// ---------------------------------------------------------------------------

// Weekdays and the weekend as separate series, but only where the window
// actually holds both: a log two days old has no Saturday in it, and an empty
// series in the legend reads as "the weekend is flat" rather than "we have not
// seen one yet".
const HOUR_GROUPS = [
  { key: "weekday", name: "Mon–Fri", days: [1, 2, 3, 4, 5], ink: ACCENT },
  { key: "weekend", name: "Sat–Sun", days: [6, 0], ink: SOURCE_INK },
];

function renderHours(totals) {
  const spec = METRICS[metric];
  const present = HOUR_GROUPS.filter(({ days }) =>
    days.some((day) => totals.cmp[day].some((n) => n > 0)),
  );
  // With only one group sampled, splitting says nothing — show the whole window
  // as one series and name it for what it is.
  const groups =
    present.length > 1
      ? present
      : [
          {
            key: "all",
            name: present.length ? present[0].name : "All days",
            days: WEEK.map(([index]) => index),
            ink: ACCENT,
          },
        ];

  const data = [];
  for (let hour = 0; hour < 24; hour++) {
    const row = { hour: hh(hour).slice(0, 2) };
    for (const group of groups) {
      let value = 0;
      let compared = 0;
      for (const day of group.days) {
        value += totals[spec.key][day][hour];
        compared += totals.cmp[day][hour];
      }
      row[group.key] = compared
        ? spec.kind === "share"
          ? (100 * value) / compared
          : value / compared
        : null;
      row[`${group.key}Checks`] = compared;
    }
    data.push(row);
  }

  const format = (value) =>
    spec.kind === "share" ? `${value.toFixed(0)}%` : value.toFixed(1);

  upsert("hour", {
    ...chartBase,
    container: el("hourChart"),
    data,
    series: groups.map((group) => ({
      type: "bar",
      xKey: "hour",
      yKey: group.key,
      yName: group.name,
      fill: group.ink,
      tooltip: {
        renderer: ({ datum }) => ({
          title: `${group.name}, ${hh(Number(datum.hour))}`,
          data: [
            {
              label: spec.cell,
              value:
                datum[group.key] === null ? "no checks" : format(datum[group.key]),
            },
            {
              label: "Checks compared",
              value: fmtInt.format(datum[`${group.key}Checks`]),
            },
          ],
        }),
      },
    })),
    axes: {
      x: { type: "category", position: "bottom", label: { color: AXIS_INK } },
      y: {
        type: "number",
        position: "left",
        title: { text: spec.axis, color: AXIS_INK },
      },
    },
    legend: { ...legendBase, enabled: groups.length > 1 },
  });

  el("hourSub").textContent =
    groups.length > 1
      ? "The weekday-hour grid collapsed onto one axis, weekdays against the weekend."
      : "The grid collapsed onto one axis. Split into weekdays and weekend once both have been sampled.";

  const sampled = data.filter((row) =>
    groups.some((group) => row[group.key] !== null),
  );
  const quiet = sampled.filter((row) =>
    groups.every((group) => !row[group.key]),
  );
  const where = scope.kind === "venue" ? "at this venue" : "anywhere in scope";
  el("hourNote").innerHTML = quiet.length
    ? `<strong>${quiet.length} of the ${sampled.length} sampled hours</strong> saw nothing ${where}: ` +
      `${quiet.map((row) => hh(Number(row.hour))).join(", ")}.`
    : `Every sampled hour saw something.`;
}

// ---------------------------------------------------------------------------
// Venue table
// ---------------------------------------------------------------------------

function venueRows() {
  return Object.entries(blob.venues).map(([id, venue]) => {
    const totals = weekTotals([id]);
    let compared = 0;
    let up = 0;
    let added = 0;
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        compared += totals.cmp[day][hour];
        up += totals.up[day][hour];
        added += totals.add[day][hour];
      }
    }
    const checks = Object.values(venue.kinds).reduce((a, b) => a + b, 0);
    // Closures come out of the rate but stay in the cell beside it. A row that
    // dropped them entirely would show a venue with a full count of checks, a
    // clean answered figure and nothing accounting for the gap between them.
    const closed = expectedTotal(venue.kinds);
    const open = checks - closed;
    const issues = Object.entries(venue.kinds)
      .filter(([kind]) => kind !== "ok" && !isExpected(kind))
      .sort(([, a], [, b]) => b - a)
      .map(([kind, n]) => `${n} ${outcomeLabel(kind).toLowerCase()}`);
    if (closed) issues.push(`${closed} closed (not counted)`);
    return {
      id,
      name: venue.name,
      chain: blob.chains[venue.chain] ?? venue.chain,
      checks,
      // null, not 0: a venue shut for the whole window was never asked a
      // question it could answer, and 0% would sort it to the top of this
      // column as the worst venue on the estate rather than a closed one.
      answered: open ? (100 * (venue.kinds.ok ?? 0)) / open : null,
      issues: issues.length ? issues.join(", ") : "—",
      publishRate: compared ? (100 * up) / compared : 0,
      added,
      // Named so the column header can say what "added" is counting, since a
      // film × date chain and a per-performance chain are not counting the same
      // thing and the total over both would be meaningless.
      granularity:
        venue.granularity === "film-date" ? "film × date" : "performances",
    };
  });
}

function renderGrid() {
  const theme = themeQuartz.withPart(colorSchemeDark).withParams({
    rowHeight: 34,
    headerHeight: 36,
    accentColor: ACCENT,
    backgroundColor: SURFACE,
  });

  grid = createGrid(el("venueGrid"), {
    theme,
    rowData: venueRows(),
    getRowId: ({ data }) => data.id,
    defaultColDef: { sortable: true, resizable: true, floatingFilter: true },
    columnDefs: [
      {
        field: "name",
        headerName: "Venue",
        flex: 2,
        minWidth: 180,
        filter: "agTextColumnFilter",
        filterParams: {
          filterOptions: ["contains"],
          maxNumConditions: 1,
          debounceMs: 150,
        },
      },
      {
        field: "chain",
        headerName: "Chain",
        width: 150,
        filter: "agTextColumnFilter",
        // `equals` is here because syncGrid writes an equals model into this
        // column when the scope narrows — an option the filter does not offer is
        // one it silently refuses, and the table would then quietly disagree
        // with the selector above it.
        filterParams: {
          filterOptions: ["equals", "contains"],
          maxNumConditions: 1,
        },
      },
      {
        field: "checks",
        headerName: "Checks",
        width: 110,
        filter: "agNumberColumnFilter",
        filterParams: { defaultOption: "greaterThanOrEqual" },
        valueFormatter: ({ value }) => fmtInt.format(value),
      },
      {
        field: "answered",
        headerName: "Answered",
        headerTooltip:
          "Share of checks that got an answer, over the hours the venue was open — checks inside a declared closure are excluded",
        width: 130,
        sort: "asc", // anything that is not 100% is what this column is for
        filter: "agNumberColumnFilter",
        filterParams: { defaultOption: "lessThanOrEqual" },
        // A venue with no open checks has no rate to sort on. The default
        // comparator puts null first, which in a column sorted worst-first is
        // exactly where a closed venue should not be, so it is pinned to the
        // bottom in both directions using the direction AG Grid passes in.
        comparator: (a, b, _nodeA, _nodeB, isDescending) => {
          if (a === null && b === null) return 0;
          if (a === null) return isDescending ? -1 : 1;
          if (b === null) return isDescending ? 1 : -1;
          return a - b;
        },
        valueFormatter: ({ value }) =>
          value === null ? "—" : `${value.toFixed(1)}%`,
        cellStyle: ({ value }) =>
          value !== null && value < 100 ? { color: SOURCE_INK } : null,
      },
      { field: "issues", headerName: "Not answered", flex: 1, minWidth: 150 },
      {
        field: "publishRate",
        headerName: "New listings",
        headerTooltip:
          "Share of hourly checks that found more listed than an hour before",
        width: 140,
        filter: "agNumberColumnFilter",
        filterParams: { defaultOption: "greaterThanOrEqual" },
        valueFormatter: ({ value }) => `${value.toFixed(1)}%`,
      },
      {
        field: "added",
        headerName: "Listings added",
        headerTooltip:
          "Total added over the window, in this venue's own unit — not comparable between chains",
        width: 160,
        filter: "agNumberColumnFilter",
        filterParams: { defaultOption: "greaterThanOrEqual" },
        valueFormatter: ({ value, data }) =>
          `${fmtInt.format(value)} ${data.granularity}`,
      },
    ],
    onRowClicked: ({ data }) => setScope(`venue:${data.id}`),
  });
}

// ---------------------------------------------------------------------------

function render() {
  // `add` counts whatever each chain's API answers with — performances for five
  // of them, film × date pairs for three — so a total over a mixed selection is a
  // number with no meaning. Offer it only where the selection speaks one unit.
  const mixed = scope.granularities.size > 1;
  for (const input of document.querySelectorAll('input[name="metric"]')) {
    const disabled = input.value === "add" && mixed;
    input.disabled = disabled;
    input.parentElement.classList.toggle("disabled", disabled);
    input.parentElement.title = disabled
      ? "Chains count different things — pick one chain to see listings added"
      : "";
  }
  if (mixed && metric === "add") {
    metric = "up";
    document.querySelector('input[name="metric"][value="up"]').checked = true;
  }

  const totals = weekTotals(scope.venues);
  renderUptime(totals);
  renderWeek(totals);
  renderHours(totals);

  el("venueSub").textContent =
    (scope.kind === "all"
      ? `All ${Object.keys(blob.venues).length} venues the hourly check covers`
      : `Narrowed to ${blob.chains[chainOfScope()]}`) +
    `, over ${blob.days.length} day(s). Sort or filter in any column; ` +
    `click a row to scope the charts above to that venue.`;

  el("scopeNote").textContent =
    scope.kind === "venue"
      ? `1 venue · ${scope.granularities.has("film-date") ? "film × date" : "per-performance"} listings`
      : `${scope.venues.length} venues · ${
          mixed ? "mixed listing units" : scope.granularities.has("film-date") ? "film × date listings" : "per-performance listings"
        }`;
}

const load = (path) =>
  fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  });

load("/data/health.json")
  .then((data) => {
    blob = data;
    buildScopeSelect();
    renderGrid();
    for (const input of document.querySelectorAll('input[name="metric"]')) {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        metric = input.value;
        render();
      });
    }
    setScope("all:");
    el("meta").textContent =
      `${fmtInt.format(Object.keys(blob.venues).length)} venues · ` +
      `${blob.from} to ${blob.to}`;
  })
  .catch((err) => {
    console.error(err);
    el("meta").textContent = "failed to load health data";
  });
