// Screening-history charts.
//
// Two data sources, loaded in that order so the headline charts paint first:
//   public/data/history-summary.json  (~9 KB)  daily totals + hour x weekday
//   public/data/history.json          (~2.3 MB) per-movie hour buckets
// Both are produced by history.mjs. See its header for how windows are sliced.

import {
  AgCharts,
  ModuleRegistry as ChartModuleRegistry,
  AllCommunityModule as AllChartModules,
} from "ag-charts-community";
// Heatmap is an AG Charts Enterprise series. Hour x weekday is a grid of
// magnitudes, which is what a heatmap is for — seven overlaid lines would be at
// the palette's ceiling and far harder to read the structure out of.
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
  RowSelectionModule, // select films to compare their runs
  enableDevValidations,
} from "ag-grid-community";

if (import.meta.env.DEV) enableDevValidations();

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  TextFilterModule, // agTextColumnFilter + its floating filter
  NumberFilterModule, // agNumberColumnFilter + its floating filter
  RowSelectionModule,
]);
ChartModuleRegistry.registerModules([
  ...AllChartModules,
  HeatmapSeriesModule,
  GradientLegendModule,
]);

// Validated against this page's actual surface (#18181b), not the palette
// default: all eight slots pass every check for line charts (worst adjacent CVD
// ΔE 8.4, normal-vision 19.3, all >= 3:1 contrast). Slot 1 is the site accent,
// so one blue serves the daily chart and the first compared film.
// Order is the CVD-safety mechanism — do not reorder without re-validating.
const SERIES = [
  "#3b82f6", // blue (site accent)
  "#d95926", // orange
  "#199e70", // aqua
  "#c98500", // yellow
  "#d55181", // magenta
  "#008300", // green
  "#9085e9", // violet
  "#e66767", // red
];
const SURFACE = "#1c1c20"; // the .card background these charts sit on

// Sequential ramp for magnitude — one hue, from the same blue family as slot 1,
// running from the card surface up to the lightest blue so an hour with nothing
// on simply is not there, and heat reads as light.
//
// Stops are fractions of the busiest cell rather than fixed values, so the ramp
// re-fits itself as the data grows. The second stop sits low deliberately: cell
// values are bimodal (55 of 168 are under 100, 100 are over 1,000), so without it
// every genuinely-quiet-but-not-empty hour would be indistinguishable from empty.
const RAMP = [
  [0, SURFACE],
  [0.025, "#0d366b"],
  [0.3, "#2a78d6"],
  [0.65, "#9ec5f4"],
  [1, "#cde2fb"],
];
// not a design cap on comparisons — just the point past which the run chart is
// unreadable and slow enough to freeze the page
const MAX_SERIES = 100;
const AXIS_INK = "#a1a1aa";
const GRID_INK = "#2e2e34";

const chartBase = {
  background: { fill: SURFACE },
  // top room so the highest y-axis tick label is not clipped by the plot edge
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
          time: {
            label: { color: AXIS_INK },
            gridLine: { enabled: false },
            line: { stroke: GRID_INK },
          },
        },
      },
    },
  },
};

// Set at the top level of each chart rather than through theme.overrides, so the
// spacing definitely lands: the default packs adjacent keys almost against each
// other, and `item.padding` is the gap between whole legend items while
// `marker.padding` separates each swatch from its own label.
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
  year: "numeric",
});
const asDate = (iso) => new Date(`${iso}T12:00:00Z`); // midday avoids DST edges
const DAY_MS = 86400000;
const addDays = (iso, n) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
const dayGap = (a, b) =>
  Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS,
  );
const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Daily totals
// ---------------------------------------------------------------------------

// The provisional window is "what is currently listed", not a forecast: cinemas
// publish detailed schedules only ~4-5 days out, so its daily totals fall off a
// cliff (2,800 -> 700 overnight in the data as of writing). Drawing the full
// tail would render that listing horizon as a collapse in cinema-going, so the
// series is clipped where it stops being comparable to recent finalized days.
//
// The floor has to sit just under a normal day, NOT halfway down. The fall-off is
// not only a cliff: a chain publishing next week's schedule in bulk leaves a
// multi-day shelf at ~70% of normal until it lands (observed 11 Aug 2026: the
// 14th-20th listed ~1,980-2,170 in the morning and ~2,820-2,970 by that evening).
// A 50% floor drew that shelf, and ~850 screenings a day missing across a week
// reads as a collapse rather than as listings not being out yet.
const LISTED_FLOOR = 0.9;

function clipProvisional(days, finalizedDays, boundary) {
  const recent = Object.values(finalizedDays)
    .slice(-28)
    .sort((a, b) => a - b);
  if (!recent.length) return [];
  const floor = recent[Math.floor(recent.length / 2)] * LISTED_FLOOR;
  const out = [];
  for (const date of Object.keys(days).sort()) {
    // the boundary day is only a part-day of listings and is charted separately;
    // testing it here would trip the cutoff before the full days are reached
    if (date <= boundary) continue;
    if (days[date] < floor) break;
    out.push(date);
  }
  return out;
}

function renderDaily(summary) {
  const { finalized, provisional } = summary;
  const finalizedDays = { ...finalized.days };

  // The finalized/provisional boundary falls mid-day, so the last finalized day
  // is only partly measured. Its true total is the measured part plus what is
  // still listed for the rest of that day — so combine, and hand the day to the
  // provisional series rather than letting it read as a real fall.
  const boundary = finalized.partialDay;
  const boundaryTotal =
    (finalizedDays[boundary] || 0) + ((provisional?.days || {})[boundary] || 0);
  delete finalizedDays[boundary];

  const dates = Object.keys(finalizedDays).sort();
  const ranData = dates.map((date) => ({
    date: asDate(date),
    value: finalizedDays[date],
  }));

  // Each series carries its OWN data. With one shared dataset every datum would
  // hold both keys — one of them empty — and the shared tooltip would render the
  // empty one as "NaN" on every historical day.
  // The listed series repeats the last measured day so the dashed line continues
  // the solid one instead of floating free. That point is nudged a few hours later
  // so the two series never share an x: the tooltip gathers every series with a
  // datum at the hovered position, and on a 214-day axis a few hours is sub-pixel,
  // so the join still looks continuous while only one series can report it.
  // Each point carries its own tooltip rows, so a day that has already happened is
  // never described as "listed".
  const listedData = [];
  if (provisional) {
    const last = dates.at(-1);
    if (last) {
      const value = finalizedDays[last];
      listedData.push({
        date: new Date(asDate(last).getTime() + 6 * 3600 * 1000),
        value,
        rows: [{ label: "Screenings", value: fmtInt.format(value) }],
      });
    }
    // the boundary day is genuinely both — show the split rather than filing a
    // mostly-elapsed day under "listed"
    listedData.push({
      date: asDate(boundary),
      value: boundaryTotal,
      rows: [
        {
          label: "Already ran",
          value: fmtInt.format(finalized.days[boundary] || 0),
        },
        {
          label: "Still listed",
          value: fmtInt.format(provisional.days[boundary] || 0),
        },
      ],
    });
    for (const date of clipProvisional(
      provisional.days,
      finalizedDays,
      boundary,
    ))
      listedData.push({ date: asDate(date), value: provisional.days[date] });
  }

  const line = (data, yName, unit, extra) => ({
    type: "line",
    data,
    xKey: "date",
    yKey: "value",
    yName,
    stroke: SERIES[0],
    strokeWidth: 2,
    marker: { enabled: false, size: 8 },
    tooltip: {
      // renderer params carry `title`/`datum` but not the series key, so read the
      // value from the closure rather than a yKey that isn't there
      renderer: ({ datum }) => ({
        title: fmtDay.format(datum.date),
        data: datum.rows ?? [
          { label: unit, value: fmtInt.format(datum.value) },
        ],
      }),
    },
    ...extra,
  });

  dailyChart?.destroy();
  dailyChart = AgCharts.create({
    ...chartBase,
    container: el("dailyChart"),
    series: [
      line(ranData, "Screenings that ran", "Screenings"),
      line(listedData, "Listed, not yet run", "Screenings listed", {
        lineDash: [5, 4],
      }),
    ],
    axes: [
      { type: "time", position: "bottom" },
      {
        type: "number",
        position: "left",
        min: 0,
        title: { enabled: false },
        label: { formatter: ({ value }) => fmtInt.format(value) },
      },
    ],
    legend: legendBase,
  });

  const totals = Object.values(finalized.days);
  const busiest = Object.entries(finalized.days).sort((a, b) => b[1] - a[1])[0];
  el("stats").innerHTML = [
    ["Screenings recorded", fmtInt.format(finalized.performances)],
    ["Films", fmtInt.format(finalized.movies)],
    ["Days covered", fmtInt.format(totals.length)],
    [
      "Busiest day",
      `${fmtInt.format(busiest[1])}`,
      fmtDay.format(asDate(busiest[0])),
    ],
  ]
    .map(
      ([k, v, sub]) =>
        `<div class="stat"><span class="v">${v}</span><span class="k">${k}${
          sub ? ` · ${sub}` : ""
        }</span></div>`,
    )
    .join("");

  el("dailySub").textContent =
    `Every recorded screening across London's cinemas, ${fmtDay.format(
      asDate(Object.keys(finalized.days)[0]),
    )} to ${fmtDay.format(asDate(boundary))}.`;
  el("dailyNote").textContent =
    "Solid line: screenings that actually ran, taken from the release that was " +
    "current at the time. Dashed: what is currently listed for the days ahead — " +
    "cinemas publish schedules only a few days out, so it is shown only while it " +
    "stays comparable, and is not a forecast.";
  el("meta").textContent =
    `${fmtInt.format(finalized.performances)} screenings · ${
      finalized.windows
    } windows`;
}

// ---------------------------------------------------------------------------
// When London goes to the cinema
// ---------------------------------------------------------------------------

// Monday first so the weekend sits together at the bottom of the grid
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Square cells mean the plot area has to hold cols:rows exactly. AG Charts has no
// aspect-ratio option for cartesian charts and `seriesArea` only controls padding,
// so the container is sized here instead. These constants are the room the axis
// labels and gradient legend take up around the plot — tune them if that chrome
// changes, since they are what the squareness rides on.
const HOURS_CHROME_X = 56;
const HOURS_CHROME_Y = 88;
const HOURS_MAX_CELL = 64; // past this the grid just becomes a wall of colour

function fitSquareCells(container, cols, rows, matchHeight = []) {
  // Measure the PARENT, not the container. Setting max-width on the container
  // caps its own measurement, so once it had been narrowed it could never report
  // a wider box again and the grid could only ever shrink.
  const host = container.parentElement;
  const apply = () => {
    const style = getComputedStyle(host);
    const width =
      host.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    if (!width || width < 0) return;
    // Cap the cell rather than the height: capping height on a wide screen would
    // stretch cells into rectangles, so instead the grid stops growing and centres.
    const cell = Math.min((width - HOURS_CHROME_X) / cols, HOURS_MAX_CELL);
    const height = `${Math.round(cell * rows + HOURS_CHROME_Y)}px`;
    const maxWidth = `${Math.round(cell * cols + HOURS_CHROME_X)}px`;
    // only write when it actually changes, so the observer cannot retrigger
    // itself on its own mutation
    if (container.style.height !== height) container.style.height = height;
    if (container.style.maxWidth !== maxWidth)
      container.style.maxWidth = maxWidth;
    // charts that only need to match the height, not the aspect ratio — they get
    // no max-width, so they still span the full card
    for (const other of matchHeight)
      if (other.style.height !== height) other.style.height = height;
  };
  apply();
  new ResizeObserver(apply).observe(host);
}

function renderHours(summary) {
  const matrix = summary.hourWeekday;
  const data = [];
  for (const day of WEEK)
    for (let hour = 0; hour < 24; hour++)
      data.push({
        day,
        hour: String(hour).padStart(2, "0"),
        screenings: matrix[day][hour],
      });
  const busiest = Math.max(...data.map((d) => d.screenings));
  // Round the top of the scale up to a whole step so the gradient legend can tick
  // evenly and label its own maximum. Left at the raw 9,998 the ticks fall on the
  // colour stops instead — which are deliberately uneven, so they bunch up.
  const step = 2000;
  const ceiling = Math.ceil(busiest / step) * step;
  // Size before creating the chart so the first paint is square too. The daily
  // chart is matched to the same height so the two full-width cards read as a
  // pair and scale together.
  fitSquareCells(el("hoursChart"), 24, WEEK.length, [
    el("dailyChart"),
    el("shareChart"),
  ]);

  AgCharts.create({
    ...chartBase,
    container: el("hoursChart"),
    data,
    series: [
      {
        type: "heatmap",
        xKey: "hour",
        yKey: "day",
        colorKey: "screenings",
        colorName: "Screenings",
        itemPadding: 1,
        colorScale: {
          // pin the domain to 0 so an empty hour lands exactly on the surface
          // colour, rather than on whatever the lowest cell happens to be
          domain: [0, ceiling],
          fills: RAMP.map(([at, color]) => ({ color, stop: at * ceiling })),
        },
        tooltip: {
          renderer: ({ datum }) => ({
            title: `${datum.day} ${datum.hour}:00`,
            data: [
              { label: "Screenings", value: fmtInt.format(datum.screenings) },
            ],
          }),
        },
      },
    ],
    axes: [
      { type: "category", position: "bottom", label: { color: AXIS_INK } },
      { type: "category", position: "left", label: { color: AXIS_INK } },
    ],
    gradientLegend: {
      enabled: true,
      position: "bottom",
      scale: {
        interval: { step },
        label: {
          color: AXIS_INK,
          fontSize: 12,
          minSpacing: 12,
          // "2k" rather than "2,000" — the gradient bar is short and the full
          // numbers run into each other
          formatter: ({ value }) =>
            value >= 1000
              ? `${+(value / 1000).toFixed(1)}k`
              : fmtInt.format(value),
        },
      },
    },
  });

  // the finding worth stating: every day peaks at 20:00, so the weekend is not a
  // different evening — it is a different morning
  const share = (day) => {
    const arr = matrix[day];
    const total = arr.reduce((a, b) => a + b, 0);
    return (100 * arr.slice(9, 12).reduce((a, b) => a + b, 0)) / total;
  };
  const weekend = (share("Sat") + share("Sun")) / 2;
  const week =
    ["Mon", "Tue", "Wed", "Thu"].reduce((a, d) => a + share(d), 0) / 4;
  el("hoursNote").textContent =
    `Every day of the week peaks at 20:00. The weekend difference is the morning: ` +
    `${weekend.toFixed(0)}% of weekend screenings start between 09:00 and 12:00, ` +
    `against ${week.toFixed(0)}% Monday to Thursday.`;
}

// ---------------------------------------------------------------------------
// Concentration
// ---------------------------------------------------------------------------

const TOP_N = 8;

// A stacked area of the top films' market share does not work on this data: the
// eight biggest films of the whole period account for only 26% of screenings, so
// the chart would be three-quarters "Other". Films turn over too fast. What is
// actually concentrated is any single DAY — its own top eight take a median 73% —
// so the honest measure is that share plotted over time: one series, no
// categorical palette, and it answers the same question.
function renderShare(blob, boundary) {
  // per day, per film: how many screenings
  const byDay = {};
  const add = (counts, onlyDay = null) => {
    for (const [id, hours] of Object.entries(counts))
      for (const [bucket, n] of Object.entries(hours)) {
        const day = bucket.slice(0, 10);
        if (onlyDay !== null && day !== onlyDay) continue;
        const into = (byDay[day] ||= {});
        into[id] = (into[id] || 0) + n;
      }
  };
  add(blob.finalized.counts);

  // The finalized/provisional boundary falls mid-day, so the last finalized day
  // holds only the hours before it — a handful of late-night screenings when the
  // boundary lands in the early morning, and eight films out of five is trivially
  // 100%. A share over a part-day is not a measure of concentration, so complete
  // the day from the provisional window (the same split renderDaily makes, and
  // safe from double counting because the provisional window opens exactly where
  // the finalized one closes), or drop the day when there is nothing to complete
  // it with.
  if (blob.provisional) add(blob.provisional.counts, boundary);
  else delete byDay[boundary];

  const data = Object.keys(byDay)
    .sort()
    .map((date) => {
      const counts = Object.values(byDay[date]).sort((a, b) => b - a);
      const total = counts.reduce((a, b) => a + b, 0);
      const top = counts.slice(0, TOP_N).reduce((a, b) => a + b, 0);
      return {
        date: asDate(date),
        share: (100 * top) / total,
        films: counts.length,
        total,
      };
    });

  shareChart?.destroy();
  shareChart = AgCharts.create({
    ...chartBase,
    container: el("shareChart"),
    series: [
      {
        type: "line",
        data,
        xKey: "date",
        yKey: "share",
        yName: `Top ${TOP_N} share`,
        stroke: SERIES[0],
        strokeWidth: 2,
        marker: { enabled: false, size: 8 },
        tooltip: {
          renderer: ({ datum }) => ({
            title: fmtDay.format(datum.date),
            data: [
              {
                label: `Top ${TOP_N} films`,
                value: `${datum.share.toFixed(0)}%`,
              },
              { label: "Films screening", value: fmtInt.format(datum.films) },
              { label: "Screenings", value: fmtInt.format(datum.total) },
            ],
          }),
        },
      },
    ],
    axes: [
      { type: "time", position: "bottom" },
      {
        type: "number",
        position: "left",
        min: 0,
        max: 100,
        title: { enabled: false },
        label: { formatter: ({ value }) => `${value}%` },
      },
    ],
    legend: { enabled: false },
  });

  const shares = data.map((d) => d.share).sort((a, b) => a - b);
  const films = data.map((d) => d.films).sort((a, b) => a - b);
  el("shareNote").textContent =
    `On a typical day the eight biggest films take ${shares[
      Math.floor(shares.length / 2)
    ].toFixed(
      0,
    )}% of all screenings, ranging from ${shares[0].toFixed(0)}% to ` +
    `${shares.at(-1).toFixed(0)}%. A median of ${films[Math.floor(films.length / 2)]} ` +
    `films screen somewhere in London on any given day, so the long tail is wide ` +
    `but thin.`;
}

// ---------------------------------------------------------------------------
// Per-film runs
// ---------------------------------------------------------------------------

function dailyForFilm(hours) {
  const days = {};
  for (const [bucket, n] of Object.entries(hours)) {
    const date = bucket.slice(0, 10);
    days[date] = (days[date] || 0) + n;
  }
  return days;
}

let runChart = null;
let runAligned = null;
let dailyChart = null;
let shareChart = null;

// Show the panel instead of the plot. The chart is destroyed rather than hidden:
// a hidden container measures zero, and a chart built or updated against it comes
// back sized wrong.
function showRunPanel(title, body) {
  el("runChart").hidden = true;
  el("runEmpty").hidden = false;
  el("runEmptyTitle").textContent = title;
  el("runEmptyBody").textContent = body;
  el("runSub").innerHTML = "&nbsp;";
  runChart?.destroy();
  runChart = null;
}

function renderRun(selected) {
  const sub = el("runSub");
  if (!selected.length) {
    showRunPanel(
      "No films selected",
      "Select a film in the list to chart its run.",
    );
    return;
  }
  // The header checkbox can select every filtered row in one click. There is no
  // useful reading of hundreds of overlapping lines, and building them would lock
  // the page up for seconds, so say so rather than trying.
  if (selected.length > MAX_SERIES) {
    showRunPanel(
      `${fmtInt.format(selected.length)} films selected`,
      `Too many to chart legibly. Filter the list or select fewer than ${MAX_SERIES}.`,
    );
    return;
  }
  el("runChart").hidden = false;
  el("runEmpty").hidden = true;

  // A continuous day-by-day axis, NOT just the days films happened to screen on.
  // Source data only records days with screenings, so a film that premiered on the
  // 6th and opened wide on the 16th has no points in between — and the line would
  // be drawn straight from 1 to 214, reading as ten days of steady growth that
  // never happened. Every day in range gets a point so quiet days plot as zero.
  //
  // Each film is still plotted only between its own first and last screening: a
  // gap inside a run really is a zero-screening day, but outside the run the film
  // was not in cinemas at all, and filling those with zero invents data.
  const runs = selected.map((film) => {
    const own = Object.keys(film.days).sort();
    return { first: own[0], last: own.at(-1) };
  });
  const from = runs.reduce(
    (a, r) => (r.first < a ? r.first : a),
    runs[0].first,
  );
  const to = runs.reduce((a, r) => (r.last > a ? r.last : a), runs[0].last);

  // Aligned mode slides every film to a shared day 0 = its own first screening,
  // so runs that never overlapped in the calendar can be compared shape to shape.
  // The x-axis stops being a date and becomes a count of days into the run.
  const aligned = el("runNormalise").checked;
  const data = [];
  if (aligned) {
    const longest = Math.max(...runs.map((r) => dayGap(r.first, r.last)));
    for (let offset = 0; offset <= longest; offset++) {
      const row = { offset };
      selected.forEach((film, i) => {
        const date = addDays(runs[i].first, offset);
        if (date <= runs[i].last) row[`f${i}`] = film.days[date] || 0;
      });
      data.push(row);
    }
  } else {
    const cursor = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    while (cursor <= end) {
      const date = cursor.toISOString().slice(0, 10);
      const row = { date: asDate(date) };
      selected.forEach((film, i) => {
        const { first, last } = runs[i];
        if (date >= first && date <= last) row[`f${i}`] = film.days[date] || 0;
      });
      data.push(row);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  const series = selected.map((film, i) => ({
    type: "line",
    xKey: aligned ? "offset" : "date",
    yKey: `f${i}`,
    yName: film.title,
    // beyond eight the hues repeat; identity then rests on the legend and the
    // tooltip, which name the film, rather than on colour alone
    stroke: SERIES[i % SERIES.length],
    strokeWidth: 2,
    marker: { enabled: false, size: 8 },
    connectMissingData: false, // leave the pre-release / post-run stretches empty
    tooltip: {
      // Films with no overlap still appear in each other's tooltips, and outside
      // its own run a film has no value at all. That is genuinely zero screenings,
      // so report it as 0 — the point stays absent from the data so the line is
      // still not drawn there.
      // one row per series — the shared tooltip concatenates them, so returning
      // every film here would repeat the whole list once per line on the chart
      renderer: ({ datum }) => ({
        // in aligned mode the shared x is an offset, so name the film's own date
        title: aligned
          ? `Day ${datum.offset} · ${fmtDay.format(
              asDate(addDays(runs[i].first, datum.offset)),
            )}`
          : fmtDay.format(datum.date),
        data: [
          {
            label: film.title,
            value: `${fmtInt.format(datum[`f${i}`] ?? 0)} screenings`,
          },
        ],
      }),
    },
  }));

  const options = {
    ...chartBase,
    container: el("runChart"),
    data,
    series,
    axes: runAxes(aligned),
    // one series is self-evident from the heading; two or more need a legend
    legend: {
      ...legendBase,
      enabled: selected.length > 1,
      // Film titles run long, so cap the item width and truncate the label. The
      // item tooltip defaults to 'auto', meaning it appears only when a label has
      // been truncated — so the full title is still one hover away.
      maxHeight: 76,
      item: {
        ...legendBase.item,
        maxWidth: 240,
        label: { ...legendBase.item.label, maxLength: 26 },
      },
    },
  };
  // switching alignment swaps the x-axis between time and number — rebuild rather
  // than update, since that is a change of axis type, not just of data
  if (runChart && runAligned !== aligned) {
    runChart.destroy();
    runChart = null;
  }
  runAligned = aligned;
  runChart = runChart
    ? (runChart.update(options), runChart)
    : AgCharts.create(options);
  const names = selected.map((f) => f.title);
  sub.textContent =
    names.length > 4
      ? `${names.slice(0, 4).join(" · ")} and ${names.length - 4} more`
      : names.join(" · ");
}

const runAxes = (aligned = false) => [
  aligned
    ? {
        type: "number",
        position: "bottom",
        min: 0,
        title: {
          enabled: true,
          text: "Days since first screening",
          color: AXIS_INK,
        },
        label: { formatter: ({ value }) => fmtInt.format(value) },
      }
    : { type: "time", position: "bottom" },
  {
    type: "number",
    position: "left",
    min: 0,
    title: { enabled: false },
    label: { formatter: ({ value }) => fmtInt.format(value) },
  },
];

function renderFilms(blob) {
  let films = Object.entries(blob.finalized.counts).map(([id, hours]) => {
    const days = dailyForFilm(hours);
    const dates = Object.keys(days).sort();
    const meta = blob.movies[id] || {};
    return {
      id,
      title: meta.t || id,
      year: meta.y || null,
      screenings: Object.values(days).reduce((a, b) => a + b, 0),
      days: dates.length,
      first: dates[0],
      last: dates.at(-1),
      series: days,
    };
  });
  // A film with a single recorded screening is one point on the run chart — there
  // is no run to see. Most are one-off events, previews and hires rather than
  // releases, so they are noise in a list meant for picking something to chart.
  const oneOff = films.filter((f) => f.screenings === 1).length;
  films = films.filter((f) => f.screenings > 1);
  films.sort((a, b) => b.screenings - a.screenings);

  const theme = themeQuartz
    .withPart(colorSchemeDark)
    .withParams({
      rowHeight: 34,
      headerHeight: 36,
      accentColor: SERIES[0],
      backgroundColor: SURFACE,
    });

  const grid = createGrid(el("filmGrid"), {
    theme,
    rowData: films,
    getRowId: ({ data }) => data.id,
    // headerCheckbox gives a one-click clear (and select-all) at the top of the
    // checkbox column; 'filtered' scopes select-all to what the filters have left
    // showing, which is both more useful and far less of a foot-gun than all 2,519
    rowSelection: {
      mode: "multiRow",
      checkboxes: true,
      headerCheckbox: true,
      selectAll: "filtered",
    },
    // floating filters put AG Grid's own filter components inline under each
    // header — searching a 5,660-row list is the grid's job, not a bespoke input
    defaultColDef: { sortable: true, resizable: true, floatingFilter: true },
    columnDefs: [
      {
        field: "title",
        headerName: "Film",
        flex: 2,
        minWidth: 160,
        filter: "agTextColumnFilter",
        filterParams: {
          filterOptions: ["contains"],
          maxNumConditions: 1,
          debounceMs: 150,
        },
      },
      {
        field: "year",
        headerName: "Year",
        width: 110,
        filter: "agNumberColumnFilter",
      },
      {
        field: "screenings",
        headerName: "Screenings",
        width: 140,
        sort: "desc",
        filter: "agNumberColumnFilter",
        // "at least N" is the question worth asking of a count; an exact match on
        // a screening total is almost never what anyone wants
        filterParams: { defaultOption: "greaterThanOrEqual" },
        valueFormatter: ({ value }) => fmtInt.format(value),
      },
      {
        field: "days",
        headerName: "Days",
        width: 110,
        filter: "agNumberColumnFilter",
        filterParams: { defaultOption: "greaterThanOrEqual" },
      },
    ],
    onSelectionChanged: () =>
      renderRun(
        grid.getSelectedRows().map((r) => ({ title: r.title, days: r.series })),
      ),
  });

  el("filmGridSub").innerHTML =
    `${fmtInt.format(films.length)} films with more than one recorded screening ` +
    `(${fmtInt.format(oneOff)} one-off screenings excluded).<br>` +
    `Filter in any column, then tick films to compare their runs.`;

  // Re-chart the current selection when the alignment toggle flips
  el("runNormalise").addEventListener("change", () =>
    renderRun(
      grid.getSelectedRows().map((r) => ({ title: r.title, days: r.series })),
    ),
  );

  // Nothing is selected on arrival, so put the run chart into its empty state
  // explicitly rather than relying on the markup's initial attribute — this is
  // the only thing that keeps the two in step once selections start changing.
  // (Selections survive filtering, so you can filter, tick, filter again and
  // compare films that never appear in the same filtered list.)
  renderRun([]);
}

// ---------------------------------------------------------------------------

const load = (path) =>
  fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  });

// The per-movie blob does not name the part-measured last day (only the summary
// does, and it is the summary's own boundary), so it is threaded through rather
// than re-derived — a second derivation is a second thing to keep in step.
load("/data/history-summary.json")
  .then(async (summary) => {
    renderDaily(summary);
    renderHours(summary);
    const blob = await load("/data/history.json");
    renderShare(blob, summary.finalized.partialDay);
    renderFilms(blob);
  })
  .catch((err) => {
    console.error(err);
    el("meta").textContent = "failed to load history data";
  });
