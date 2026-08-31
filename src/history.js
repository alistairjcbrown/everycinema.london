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
  DateFilterModule, // agDateColumnFilter, for the Opening column
  RowSelectionModule, // select films to compare their runs
  TooltipModule, // headerTooltip on the Week 2 column
  enableDevValidations,
} from "ag-grid-community";

if (import.meta.env.DEV) enableDevValidations();

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  TextFilterModule, // agTextColumnFilter + its floating filter
  NumberFilterModule, // agNumberColumnFilter + its floating filter
  DateFilterModule, // agDateColumnFilter + its floating filter
  RowSelectionModule,
  TooltipModule, // agColumnHeader's tooltip, for the one column that needs a gloss
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
// Annotation, not data: school-holiday bands on the daily chart. Warm, so it
// reads as a different KIND of thing from the blue series, and only ever used at
// low opacity across a wide area. Fill and edge share one opacity so the band
// cannot grow a visible outline — see holidayCrossLines.
const HOLIDAY_WASH = "#c98500";
const HOLIDAY_WASH_OPACITY = 0.08;
// Weekend bands on the same chart. Neutral rather than warm — a second hue would
// read as a second KIND of event competing with the holidays, and these are only
// ever a backdrop. Fainter than the holiday wash too: there are ~30 of them
// across the axis where there are five holidays, so at equal weight the chart
// becomes a stripe pattern with a series somewhere behind it. Where a weekend
// falls inside a holiday the two washes stack, which is correct — it is both.
const WEEKEND_WASH = "#9aa4b2";
const WEEKEND_WASH_OPACITY = 0.06;
// Release markers on the concentration chart. Deliberately NOT the holiday warm:
// these mark a different kind of event, and a shared colour would imply otherwise.
// A neutral hairline, a couple of shades up from the gridlines so it reads as
// deliberate without competing with the series.
const OPENING_INK = "#52525b";

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
// No weekday: a grid column, not a chart tooltip, so it stays narrow.
const fmtDate = new Intl.DateTimeFormat("en-GB", {
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
// School holidays
// ---------------------------------------------------------------------------

// Term dates are what the daily series is mostly made of. Measured against the
// term-time weekdays within a fortnight either side, holiday weekdays run 13-23%
// busier (Feb half term +20%, Easter +23%, May half term +14%), and essentially
// the whole lift is in the morning: 09:00-13:00 roughly doubles (+63% to +98%)
// while evenings do not move at all. That is the signature of a school holiday
// rather than of a big release, which would lift evenings too. Without the bands
// the spikes look like unexplained noise.
//
// London state-school dates, taken from the Royal Borough of Greenwich, which
// follows the standard London pattern — academies and voluntary-aided schools set
// their own, so these are representative rather than universal. Spans are the
// published holiday dates, end-INCLUSIVE.
//
// EXTEND THIS when the data rolls past the last entry: the calendar starts on
// 1 January of the current year, so a new academic year needs its dates adding
// from royalgreenwich.gov.uk/schools-and-education/school-term-dates
const SCHOOL_HOLIDAYS = [
  ["Christmas", "2026-01-01", "2026-01-04"],
  ["Feb half term", "2026-02-16", "2026-02-20"],
  ["Easter", "2026-03-30", "2026-04-10"],
  ["May half term", "2026-05-25", "2026-05-29"],
  ["Summer", "2026-07-21", "2026-09-01"],
  ["Oct half term", "2026-10-26", "2026-10-30"],
  ["Christmas", "2026-12-21", "2027-01-01"],
];

const holidayOn = (iso) =>
  SCHOOL_HOLIDAYS.find(([, start, end]) => iso >= start && iso <= end)?.[0] ??
  null;

// Bands span whole days: the series plots each day at midday, so a band running
// midday-to-midday would visibly cut its own first and last day in half. Ranges
// therefore run from 00:00 on the first day to 00:00 on the day AFTER the last.
const startOfDay = (iso) => new Date(`${iso}T00:00:00Z`);
const startOfNextDay = (iso) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + DAY_MS);

// Clamped to the plotted range, and dropped entirely when they fall outside it:
// an unclamped band would stretch the axis domain into empty space (the summer
// holiday runs weeks past the last day there is data for) and leave the series
// squashed into part of the plot.
function holidayCrossLines(from, to) {
  return SCHOOL_HOLIDAYS.filter(
    ([, start, end]) => end >= from && start <= to,
  ).map(([name, start, end]) => ({
    type: "range",
    range: [
      startOfDay(start < from ? from : start),
      startOfNextDay(end > to ? to : end),
    ],
    // A wide wash rather than a saturated block, and a warm hue so it cannot be
    // mistaken for the blue the data is drawn in. The label wears axis ink, not
    // the band colour — it is chrome, not a series.
    fill: HOLIDAY_WASH,
    fillOpacity: HOLIDAY_WASH_OPACITY,
    // A range cross line strokes its own two edges in a bright contrasting
    // colour by default, which puts a pair of vertical rules on the plot per
    // holiday — louder than the data itself. Matching the edges to the fill, at
    // the same opacity, makes the boundary read as where the wash stops rather
    // than as a rule drawn over the chart.
    stroke: HOLIDAY_WASH,
    strokeOpacity: HOLIDAY_WASH_OPACITY,
    strokeWidth: 1,
    label: {
      text: name,
      // Above the plot, not inside: the half-term bands are only ~1% of a
      // seven-month axis, far too narrow to hold their own text, and the nearest
      // neighbouring band is six weeks away so centred labels do not collide.
      position: "top",
      color: AXIS_INK,
      fontSize: 11,
    },
  }));
}

// ---------------------------------------------------------------------------
// Weekends
// ---------------------------------------------------------------------------

// Saturday-and-Sunday as one band rather than two, so the pair reads as a single
// weekend and no hairline appears down the middle of it where two adjacent
// ranges meet. Same whole-day convention as the holiday bands: 00:00 on the
// Saturday to 00:00 on the Monday.
//
// A Sunday only opens a band of its own when it is the first day plotted — every
// other Sunday is already covered by the Saturday before it. Both ends are
// clamped to the plotted range for the same reason the holidays are: an
// overhanging band would stretch the axis into empty space.
function weekendCrossLines(from, to) {
  const first = Date.parse(`${from}T00:00:00Z`);
  const last = Date.parse(`${to}T00:00:00Z`);
  const bands = [];
  for (let t = first; t <= last; t += DAY_MS) {
    const weekday = new Date(t).getUTCDay(); // 0 Sun, 6 Sat
    if (weekday !== 6 && (weekday !== 0 || t !== first)) continue;
    const end = Math.min(t + (weekday === 6 ? 2 : 1) * DAY_MS, last + DAY_MS);
    bands.push({
      type: "range",
      range: [new Date(t), new Date(end)],
      fill: WEEKEND_WASH,
      fillOpacity: WEEKEND_WASH_OPACITY,
      // edges matched to the fill for the same reason as the holiday bands, and
      // more so here: 30-odd default-stroked ranges would be 60 vertical rules
      stroke: WEEKEND_WASH,
      strokeOpacity: WEEKEND_WASH_OPACITY,
      strokeWidth: 1,
    });
  }
  return bands;
}

// Weekends first so the holiday bands and their labels draw over the top, and so
// a holiday reads as the louder of the two where they overlap.
function dailyCrossLines(from, to) {
  return [
    ...(el("dailyWeekends").checked ? weekendCrossLines(from, to) : []),
    ...(el("dailyHolidays").checked ? holidayCrossLines(from, to) : []),
  ];
}

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
      renderer: ({ datum }) => {
        const rows = datum.rows ?? [
          { label: unit, value: fmtInt.format(datum.value) },
        ];
        // Naming the holiday per day is what the bands cannot do: they are only
        // wide enough to carry one label each, and on the narrow ones that label
        // sits over the band rather than in it.
        const holiday = holidayOn(datum.date.toISOString().slice(0, 10));
        return {
          title: fmtDay.format(datum.date),
          data: holiday
            ? [...rows, { label: "School holiday", value: holiday }]
            : rows,
        };
      },
    },
    ...extra,
  });

  // the plotted span: the finalized days plus however many listed days survived
  // clipping, which is what the holiday and weekend bands are clamped to
  const plottedTo = (listedData.at(-1)?.date ?? asDate(dates.at(-1)))
    .toISOString()
    .slice(0, 10);

  // Kept on the module so the band toggles can swap the cross lines and hand the
  // same options back to update(), rather than re-running this whole render
  dailySpan = [dates[0], plottedTo];
  dailyOptions = {
    ...chartBase,
    // more top room than the other charts: the holiday band labels sit above the
    // plot, and the default 16px is only enough for the y-axis tick label
    padding: { ...chartBase.padding, top: 30 },
    container: el("dailyChart"),
    series: [
      line(ranData, "Screenings that ran", "Screenings"),
      line(listedData, "Listed, not yet run", "Screenings listed", {
        lineDash: [5, 4],
      }),
    ],
    axes: {
      x: {
        type: "time",
        position: "bottom",
        crossLines: dailyCrossLines(...dailySpan),
      },
      y: {
        type: "number",
        position: "left",
        min: 0,
        title: { enabled: false },
        label: { formatter: ({ value }) => fmtInt.format(value) },
      },
    },
    legend: legendBase,
  };
  dailyChart?.destroy();
  dailyChart = AgCharts.create(dailyOptions);

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
  el("dailyNote").textContent = dailyNote();
  el("meta").textContent =
    `${fmtInt.format(finalized.performances)} screenings · ${
      finalized.windows
    } windows`;
}

// Only describe the bands that are actually drawn, and name them by colour once
// both can be on at the same time — "shaded" stops being enough to tell the
// reader which sentence is about which band.
function dailyNote() {
  const both = el("dailyHolidays").checked && el("dailyWeekends").checked;
  return [
    "Solid line: screenings that actually ran, taken from the release that was " +
      "current at the time. Dashed: what is currently listed for the days ahead — " +
      "cinemas publish schedules only a few days out, so it is shown only while it " +
      "stays comparable, and is not a forecast.",
    el("dailyHolidays").checked &&
      `${both ? "Amber bands" : "Shaded"}: London school holidays, which ` +
        "account for every spike in the series — half-term and Easter weekdays " +
        "run 14-23% busier than the term weeks either side, and almost all of " +
        "the extra screenings are morning ones.",
    el("dailyWeekends").checked &&
      `${both ? "Grey bands" : "Shaded"}: weekends, Saturday and Sunday.`,
  ]
    .filter(Boolean)
    .join(" ");
}

// Only the bands change, so the chart is updated rather than rebuilt. update()
// replaces the chart's options wholesale, so it is handed the stored options with
// the cross lines swapped — a partial object would drop the series with them.
function redrawDailyBands() {
  if (!dailyChart) return;
  dailyOptions.axes.x.crossLines = dailyCrossLines(...dailySpan);
  dailyChart.update(dailyOptions);
  el("dailyNote").textContent = dailyNote();
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
// how much taller the daily chart sits than the heatmap it is sized against
const DAILY_EXTRA_HEIGHT = 90;

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
    // Charts that only need to match the height, not the aspect ratio — they get
    // no max-width, so they still span the full card. Each entry may carry extra
    // pixels on top, for a chart that should track the grid as the window resizes
    // while sitting taller than it.
    for (const [other, extra = 0] of matchHeight) {
      const own = `${Math.round(cell * rows + HOURS_CHROME_Y + extra)}px`;
      if (other.style.height !== own) other.style.height = own;
    }
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
  // Size before creating the chart so the first paint is square too. The other two
  // charts are matched to this height so the cards scale together, but the daily
  // chart gets extra: it is the headline series and the one carrying the most in a
  // single plot — 223 days, two series and the holiday bands — so it earns the room.
  fitSquareCells(el("hoursChart"), 24, WEEK.length, [
    [el("dailyChart"), DAILY_EXTRA_HEIGHT],
    [el("shareChart")],
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
    axes: {
      x: { type: "category", position: "bottom", label: { color: AXIS_INK } },
      y: { type: "category", position: "left", label: { color: AXIS_INK } },
    },
    gradientLegend: {
      enabled: true,
      position: "bottom",
      // The bar defaults to a length that six ticks do not fit along: the top two
      // labels collided ("8k10k"). The card is ~1,100px wide, so there is room to
      // lengthen it rather than thin the ticks out — a longer ramp also reads more
      // like a scale, which is the job it is doing.
      gradient: { preferredLength: 260 },
      scale: {
        interval: { step },
        label: {
          color: AXIS_INK,
          fontSize: 12,
          minSpacing: 12,
          // "2k" rather than "2,000" — abbreviated so the ticks stay clear of each
          // other even on a narrow card, where the bar shrinks to fit
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

// What counts as going wide: the share of one day's screenings a film has to take
// for that day to be its opening. This threshold is the only thing selecting which
// films get marked — every film that clears it is drawn (13 of them so far this
// year), so it is also the dial for how busy the chart gets.
const OPENING_SHARE = 20;

// A wide release re-cuts the whole city's schedule overnight — on its first day a
// tentpole can take a third of every screening in London — and that is exactly
// what the steps in this series are. Marking them turns unexplained jumps into the
// story of the year's releases.
//
// Derived from the data rather than a hardcoded list of titles, so it stays true as
// the year goes on. A film's own opening is the first day it clears the threshold,
// which is NOT the same as the day it peaks: Spider-Man: Brand New Day opened at
// 24% and only reached 43% a day later. Results come back ordered by that peak, so
// the caller can name the year's most dominant film without re-deriving it.
function wideOpenings(byDay, movies) {
  const dates = Object.keys(byDay).sort();
  const films = new Map();

  for (const date of dates) {
    const counts = Object.values(byDay[date]);
    const total = counts.reduce((a, b) => a + b, 0);
    for (const [id, n] of Object.entries(byDay[date])) {
      const share = (100 * n) / total;
      const film = films.get(id) ?? { peak: 0, opened: null };
      if (share > film.peak) film.peak = share;
      // dates are walked in order, so the first one to clear the bar is the open
      if (film.opened === null && share >= OPENING_SHARE) film.opened = date;
      films.set(id, film);
    }
  }

  return [...films]
    .filter(([, film]) => film.opened !== null)
    .sort((a, b) => b[1].peak - a[1].peak)
    .map(([id, film]) => ({
      title: movies[id]?.t ?? id,
      date: film.opened,
      peak: film.peak,
    }));
}

// A stacked area of the top films' market share does not work on this data: the
// eight biggest films of the whole period account for only 26% of screenings, so
// the chart would be three-quarters "Other". Films turn over too fast. What is
// actually concentrated is any single DAY — its own top eight take a median 73% —
// so the honest measure is that share plotted over time: one series, no
// categorical palette, and it answers the same question.
// Per day, per film: how many screenings. Both the concentration chart and the
// changeover card are about how one day's screenings were divided up, so they
// share the roll-up rather than each walking the hour buckets themselves.
//
// The finalized/provisional boundary falls mid-day, so the last finalized day
// holds only the hours before it — a handful of late-night screenings when the
// boundary lands in the early morning. A part-day is not a day either question
// can be asked of: eight films out of five is trivially 100% concentration, and
// every film on it looks like it collapsed overnight. So complete the day from
// the provisional window (the same split renderDaily makes, and safe from double
// counting because the provisional window opens exactly where the finalized one
// closes), or drop the day when there is nothing to complete it with.
function dailyByFilm(blob, boundary) {
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
  if (blob.provisional) add(blob.provisional.counts, boundary);
  else delete byDay[boundary];
  return byDay;
}

function renderShare(byDay, movies) {
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

  const openings = wideOpenings(byDay, movies);
  // more than one film can go wide on the same day, so a date maps to a list
  const openedOn = new Map();
  for (const { date, title } of openings)
    openedOn.set(date, [...(openedOn.get(date) ?? []), title]);

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
          renderer: ({ datum }) => {
            const opened = openedOn.get(
              datum.date.toISOString().slice(0, 10),
            );
            return {
              title: fmtDay.format(datum.date),
              data: [
                {
                  label: `Top ${TOP_N} films`,
                  value: `${datum.share.toFixed(0)}%`,
                },
                { label: "Films screening", value: fmtInt.format(datum.films) },
                { label: "Screenings", value: fmtInt.format(datum.total) },
                ...(opened
                  ? [{ label: "Opened wide", value: opened.join(", ") }]
                  : []),
              ],
            };
          },
        },
      },
    ],
    axes: {
      x: {
        type: "time",
        position: "bottom",
        crossLines: openings.map(({ title, date }) => ({
          type: "line",
          value: asDate(date), // midday, where the day's own point sits
          stroke: OPENING_INK,
          strokeWidth: 1,
          label: {
            text: title,
            // Rotated and anchored to the bottom of the plot: the series never
            // goes below 49%, so the lower half is empty and a vertical label has
            // room to run its full title there without being truncated or
            // crossing the line it belongs to.
            position: "inside-bottom",
            rotation: -90,
            color: AXIS_INK,
            fontSize: 11,
          },
        })),
      },
      y: {
        type: "number",
        position: "left",
        min: 0,
        max: 100,
        title: { enabled: false },
        label: { formatter: ({ value }) => `${value}%` },
      },
    },
    legend: { enabled: false },
  });

  const shares = data.map((d) => d.share).sort((a, b) => a - b);
  const films = data.map((d) => d.films).sort((a, b) => a - b);
  // named from the data, not written in, so the example cannot go stale
  const biggest = openings[0];
  el("shareNote").textContent =
    `On a typical day the eight biggest films take ${shares[
      Math.floor(shares.length / 2)
    ].toFixed(
      0,
    )}% of all screenings, ranging from ${shares[0].toFixed(0)}% to ` +
    `${shares.at(-1).toFixed(0)}%. A median of ${films[Math.floor(films.length / 2)]} ` +
    `films screen somewhere in London on any given day, so the long tail is wide ` +
    `but thin. Vertical lines mark the year's widest openings, and each one steps ` +
    `the whole city up overnight` +
    (biggest
      ? `: ${biggest.title} reached ${biggest.peak.toFixed(0)}% of every ` +
        `screening in London.`
      : `.`);
}

// ---------------------------------------------------------------------------
// The changeover
// ---------------------------------------------------------------------------
//
// London's schedule holds a near-constant number of screenings a day — the daily
// chart's whole point — so a film that picks up screens is very largely being
// handed them by films that lost them. This card shows that handover on the day
// it happens.
//
// It is accounting, not a model. For any two consecutive days, the screenings
// gained by rising films minus those given up by falling ones IS the change in
// the day's total, exactly, on all 241 day pairs in this data. So "gains minus
// growth came off the existing slate" is arithmetic, and needs no assumption
// about why anybody was dropped.
//
// What the data cannot say is which film took which screen: two films opening
// the same Friday are indistinguishable claimants on the same freed slots. So
// the chart names both sides and their sizes and stops there, rather than
// drawing arrows it cannot support.

// Gain and loss are a polarity, so they take the documented diverging pair
// (blue <-> red) rather than two categorical slots. The sign of the bar and its
// label carry the distinction too — the colour is never doing it alone.
const GAIN_INK = SERIES[0];
const LOSS_INK = SERIES[7];
// Films shown each way. Enough to see that a big opening is funded by the whole
// slate rather than one victim, few enough that every title still gets a
// readable row.
const FLOW_ROWS = 8;
// Saturdays and Sundays are excluded from the trend below. The estate runs at its
// floor on a weekday and opens up at the weekend, so a weekend's risers are
// served by screenings that did not exist on Friday rather than by anyone else's:
// across 70 weekend day pairs the correlation between what risers gained and what
// the incumbents did is 0.01 — not a weak relationship, no relationship. Pooling
// them in would dilute a real weekday effect with days the effect cannot apply to.
const WEEKEND = new Set([0, 6]);

// One day against the day before it, film by film. Sorted so the biggest gain is
// first and the biggest loss last, which is also the order the chart draws.
function flowOn(byDay, previous, date) {
  const before = byDay[previous] ?? {};
  const after = byDay[date] ?? {};
  const rows = [];
  let gains = 0;
  let losses = 0;
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[id] || 0;
    const now = after[id] || 0;
    if (was === now) continue;
    if (now > was) gains += now - was;
    else losses += was - now;
    rows.push({ id, was, now, delta: now - was });
  }
  return { rows: rows.sort((a, b) => b.delta - a.delta), gains, losses };
}

// Every consecutive day pair: what the day's risers took, and what happened to
// everything that was already playing. Days either side of a gap in the data are
// skipped — a two-day step is not a changeover, and there is no way to tell one
// from the other after the fact.
function changeovers(byDay) {
  const dates = Object.keys(byDay).sort();
  const out = [];
  for (let i = 1; i < dates.length; i++) {
    const previous = dates[i - 1];
    const date = dates[i];
    if (dayGap(previous, date) !== 1) continue;
    const before = byDay[previous];
    const after = byDay[date];
    let held = 0;
    let kept = 0;
    for (const [id, was] of Object.entries(before)) {
      held += was;
      kept += after[id] || 0;
    }
    if (!held) continue;
    const { gains, losses } = flowOn(byDay, previous, date);
    out.push({
      date,
      previous,
      gains,
      losses,
      change: (100 * (kept - held)) / held,
      weekend: WEEKEND.has(asDate(date).getUTCDay()),
    });
  }
  return out;
}

// Least squares through the weekday points. Reported in the note under the
// chart rather than drawn on it — see the series comment below for why.
function weekdayTrend(rows) {
  const pts = rows.filter((r) => !r.weekend);
  const mean = (pick) => pts.reduce((a, r) => a + pick(r), 0) / pts.length;
  const mx = mean((r) => r.gains);
  const my = mean((r) => r.change);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (const r of pts) {
    cov += (r.gains - mx) * (r.change - my);
    vx += (r.gains - mx) ** 2;
    vy += (r.change - my) ** 2;
  }
  const slope = cov / vx;
  return {
    n: pts.length,
    slope,
    intercept: my - slope * mx,
    r: cov / Math.sqrt(vx * vy),
  };
}

let flowChart = null;
let changeChart = null;

function renderFlow(byDay, movies, previous, date) {
  const { rows, gains, losses } = flowOn(byDay, previous, date);
  const name = (id) => movies[id]?.t ?? id;
  const up = rows.filter((r) => r.delta > 0).slice(0, FLOW_ROWS);
  const down = rows.filter((r) => r.delta < 0).slice(-FLOW_ROWS);
  // Truncated here rather than in the axis label formatter: the category axis
  // clips to the room it has and does it from the LEFT, which loses exactly the
  // start of the title you need to recognise the film.
  const data = [...up, ...down].map((r) => ({
    ...r,
    title: name(r.id),
    label: name(r.id).length > 30 ? `${name(r.id).slice(0, 29)}…` : name(r.id),
  }));
  const grew = gains - losses;

  el("changeStats").innerHTML = [
    [
      "Screenings picked up",
      fmtInt.format(gains),
      `by ${fmtInt.format(rows.filter((r) => r.delta > 0).length)} films`,
    ],
    [
      "The schedule grew by",
      grew >= 0 ? `+${fmtInt.format(grew)}` : fmtInt.format(grew),
    ],
    [
      "Came off films already playing",
      fmtInt.format(Math.min(gains, losses)),
      `${((100 * Math.min(gains, losses)) / (gains || 1)).toFixed(0)}% of the gains`,
    ],
  ]
    .map(
      ([k, v, sub]) =>
        `<div class="stat"><span class="v">${v}</span><span class="k">${k}${
          sub ? ` · ${sub}` : ""
        }</span></div>`,
    )
    .join("");

  flowChart?.destroy();
  flowChart = AgCharts.create({
    ...chartBase,
    container: el("flowChart"),
    data,
    series: [
      {
        type: "bar",
        direction: "horizontal",
        xKey: "label",
        yKey: "delta",
        yName: "Change",
        cornerRadius: 3,
        itemStyler: ({ datum }) => ({
          fill: datum.delta > 0 ? GAIN_INK : LOSS_INK,
        }),
        tooltip: {
          renderer: ({ datum }) => ({
            title: datum.title,
            data: [
              {
                label: fmtDate.format(asDate(previous)),
                value: fmtInt.format(datum.was),
              },
              {
                label: fmtDate.format(asDate(date)),
                value: fmtInt.format(datum.now),
              },
              {
                label: datum.delta > 0 ? "Picked up" : "Gave up",
                value: fmtInt.format(Math.abs(datum.delta)),
              },
            ],
          }),
        },
      },
    ],
    axes: [
      {
        type: "category",
        position: "left",
        label: { color: AXIS_INK, fontSize: 11 },
        line: { stroke: GRID_INK },
        gridLine: { enabled: false },
      },
      {
        type: "number",
        position: "bottom",
        title: { enabled: false },
        label: {
          color: AXIS_INK,
          formatter: ({ value }) => fmtInt.format(value),
        },
        gridLine: { style: [{ stroke: GRID_INK }] },
      },
    ],
    legend: { enabled: false },
  });

  const biggest = up[0];
  const hit = down.at(-1); // rows run high to low, so the biggest loss is last
  el("flowNote").textContent = biggest
    ? `${name(biggest.id)} picked up ${fmtInt.format(biggest.delta)} screenings ` +
      `overnight${biggest.was ? ` (${fmtInt.format(biggest.was)} to ${fmtInt.format(biggest.now)})` : ""}. ` +
      `The schedule ${grew >= 0 ? `only grew by ${fmtInt.format(grew)}` : `shrank by ${fmtInt.format(-grew)}`}, so ` +
      `${fmtInt.format(Math.min(gains, losses))} of the day's gains came off films that were already playing` +
      (hit
        ? ` — ${name(hit.id)} hardest, down ${fmtInt.format(-hit.delta)} from ${fmtInt.format(hit.was)}.`
        : ".")
    : "Nothing gained screenings on this day.";
}

function renderChangeover(byDay, movies) {
  const dates = Object.keys(byDay).sort();
  const rows = changeovers(byDay);
  const trend = weekdayTrend(rows);

  // The same events the concentration chart marks, so the two cards are talking
  // about one list of openings rather than each having its own idea of them.
  // Ordered by date here: this is a picker, not a ranking.
  const openings = wideOpenings(byDay, movies);
  const byDate = new Map();
  for (const { date, title } of openings)
    byDate.set(date, [...(byDate.get(date) ?? []), title]);
  const choices = [...byDate.entries()]
    .filter(([date]) => dates.indexOf(date) > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const picker = el("changeDay");
  picker.innerHTML = choices
    .map(
      ([date, titles]) =>
        `<option value="${date}">${fmtDate.format(asDate(date))} · ${titles.join(", ")}</option>`,
    )
    .join("");

  const draw = () => {
    const date = picker.value;
    renderFlow(byDay, movies, dates[dates.indexOf(date) - 1], date);
  };
  picker.addEventListener("change", draw);
  // Land on the changeover that cost the existing slate the most, which is this
  // card's own subject — rather than the biggest opening, which is the
  // concentration chart's. They are usually but not always the same day.
  const costliest = choices
    .map(([date]) => {
      const { gains, losses } = flowOn(
        byDay,
        dates[dates.indexOf(date) - 1],
        date,
      );
      return { date, cost: Math.min(gains, losses) };
    })
    .sort((a, b) => b.cost - a.cost)[0];
  if (costliest) picker.value = costliest.date;
  draw();

  const point = (r) => ({
    date: asDate(r.date),
    gains: r.gains,
    change: r.change,
    label: fmtDay.format(asDate(r.date)),
  });
  changeChart?.destroy();
  changeChart = AgCharts.create({
    ...chartBase,
    // chartBase leaves no bottom padding — every other chart here ends in tick
    // labels. This axis carries a title under them, which that would clip.
    padding: { ...chartBase.padding, bottom: 8, left: 8 },
    // No fitted line: a line series binds itself to a CATEGORY x-axis whatever
    // the axis declares or claims by key, which turns the scatter's numeric x
    // into 241 unordered categories and makes the whole chart a lie. The fit is
    // reported in the note underneath instead, where it cannot break the scale.
    series: [
      ["Monday–Friday", false, SERIES[0]],
      ["Saturday & Sunday", true, SERIES[1]],
    ].map(([yName, weekend, fill]) => ({
      type: "scatter",
      data: rows.filter((r) => r.weekend === weekend).map(point),
      xKey: "gains",
      yKey: "change",
      yName,
      fill,
      fillOpacity: 0.85,
      stroke: SURFACE,
      strokeWidth: 1,
      size: 9,
      tooltip: {
        renderer: ({ datum }) => ({
          title: datum.label,
          data: [
            { label: "Rising films gained", value: fmtInt.format(datum.gains) },
            {
              label: "Films already playing",
              value: `${datum.change.toFixed(1)}%`,
            },
          ],
        }),
      },
    })),
    axes: [
      {
        type: "number",
        position: "bottom",
        title: {
          enabled: true,
          text: "Screenings gained by rising films",
          color: AXIS_INK,
          fontSize: 11,
        },
        label: {
          color: AXIS_INK,
          formatter: ({ value }) => fmtInt.format(value),
        },
        gridLine: { style: [{ stroke: GRID_INK }] },
      },
      {
        type: "number",
        position: "left",
        title: {
          enabled: true,
          text: "Change for films already playing",
          color: AXIS_INK,
          fontSize: 11,
        },
        label: { color: AXIS_INK, formatter: ({ value }) => `${value}%` },
        gridLine: { style: [{ stroke: GRID_INK }] },
      },
    ],
    legend: { ...legendBase },
    container: el("changeChart"),
  });

  el("changeNote").textContent =
    `One point per pair of consecutive days. Monday to Friday the two move ` +
    `together (r = ${trend.r.toFixed(2)} over ${trend.n} day pairs): every 100 ` +
    `screenings the day's risers pick up costs the films already playing about ` +
    `${Math.abs(100 * trend.slope).toFixed(1)} points of their schedule. At the ` +
    `weekend there is no relationship at all — the estate opens up rather than ` +
    `reallocating, so a Saturday's risers are not served at anybody's expense.`;
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
let runProjected = null;
// Last day the history covers, so a week cut short by the boundary can be told
// apart from a week a film genuinely gave up on. Set once the films are built.
let dataEnd = null;
let dailyChart = null;
// The daily chart's own options and the range they were built for, kept so the
// band toggles can swap the cross lines without re-deriving the series.
let dailyOptions = null;
let dailySpan = null;
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
  el("runNote").textContent = "";
  runChart?.destroy();
  runChart = null;
}

// ---------------------------------------------------------------------------
// Decline projection
// ---------------------------------------------------------------------------
//
// Films leave cinemas by exponential decay. Across the completed wide releases
// in this data the median week-on-week retention is 0.55 — a film roughly halves
// every week — so fitting log(weekly screenings) against week number from the
// peak, then reading off where that line crosses a "run over" threshold, dates
// the end of a run.
//
// Backtested by refitting each finished film on only its first four, five and
// six weeks and comparing against where its run actually ended: median error
// 1.1, 0.9 and 0.7 weeks respectively; within one week for 46%, 58% and 64% of
// films, and within two for 67%, 74% and 78%.
//
// The fit is per-film and deliberately unshrunk toward that population median.
// Films do not only fade, they get evicted: on Friday 13 February 2026 Wuthering
// Heights opened into Valentine's weekend alongside two expansions, some 9,200
// screenings of new demand into a market that grew by 2,600, and every incumbent
// lost screens at once — Hamnet down 921 in a week, Send Help 841, Marty Supreme
// 720. Nothing in a film's own curve anticipates that. Pulling each slope toward
// the median would hide the honest reading — that this projects a decline and
// nothing else — behind a number biased to be right on average. The band, taken
// from the film's own residuals, is where that uncertainty belongs — and where
// it shows up: the band is a 95% interval on the fitted slope, but on the same
// backtest it contains the real end date only about three times in four. That
// shortfall is not sampling noise the interval got wrong, it is films losing
// screens rather than fading, and no interval drawn from a film's own curve can
// account for it. Said plainly on the chart rather than papered over.

const PROJECTION_END_SHARE = 0.05; // "run over" = a week below 5% of the peak week
const PROJECTION_MIN_PEAK = 50; // below this a weekly total is noise, not a curve
const PROJECTION_MIN_WEEKS = 3; // fewer points than this fits nothing worth drawing
const PROJECTION_MAX_WEEKS = 26; // draw at most six months on; slow fades run away
// Past this much spread between the early and late end of the fit, a single
// projected date is not worth stating — leading with a midpoint would claim a
// precision the range beside it takes straight back. With the retention ceiling
// below holding the late edge in, spread runs from about 4 to 15 weeks, and
// everything above 13 is a fit on the bare minimum three weeks. So this is the
// line between "we have a date" and "we have a quarter".
const PROJECTION_VAGUE_WEEKS = 13;
// The shallowest weekly decline a theatrical run actually shows. Two jobs, both
// resting on the same fact — that no real release in this data holds more than
// about 85% of its screenings week to week.
//
// It excludes what is not a declining run at all. Zog and the Flying Doctors
// goes 145, 129, 88, 83, 97, 83, 85, 79: a kids title on a standing weekend
// matinee, flat rather than falling, and a line through it fits 93% retention
// and projects into 2028. That is not a slow decline, it is a different thing
// being measured, and the honest answer is to say nothing about it.
//
// And it bounds the slow end of the interval. The crossing point goes to
// infinity as the slope goes to zero, so a fit on four weeks puts a late edge
// months out on the strength of a slope that is merely uncertain — The Odyssey
// reached June 2027. Only the slow side is clamped: the fast side is where
// eviction risk lives, and that tail is real. Backtested, the clamp cuts the
// median interval from 11.0 to 7.6 weeks at four weeks of data while coverage
// goes UP, 72% to 74% — the width it removes is width that was never right.
const PROJECTION_MAX_RETENTION = 0.85;
// ...but only as grounds for exclusion once the fit has this many weeks behind
// it. The ceiling was calibrated on completed runs, and a film part-way through
// one has not shown its hand yet: The Housemaid looked like a 95% holder at
// three weeks and finished at 73%, and 28 of 57 confirmed runs decline faster
// than their first four weeks suggested. Applied ungated it rejects a real
// release about one time in fifteen at three weeks — including Spider-Man:
// Brand New Day, holding 88% in week three of a perfectly ordinary blockbuster
// run. Flatness only tells you anything once there has been time for a decline
// to show up, and by six weeks that misfire is down to 1 in 57.
//
// Size is not a substitute here: excluding these titles by peak week instead
// would need a floor of 200, which drops 105 of 243 films, among them plainly
// real declines like Five Nights at Freddy's 2. What sets Zog apart is that it
// is flat, not that it is small.
const PROJECTION_FLAT_WEEKS = 6;
// A film's first recorded screening is very often a preview: Wuthering Heights
// has one show on 13 June and then nothing for the eight weeks to the end of the
// data. Anchoring week 0 there would slide every weekly bucket off the Friday
// the film actually opened on, mixing an opening Friday into the tail of a dying
// week. Anchor on the first day that reaches a fifth of the film's best day
// instead, which is the opening in every ordinary case — and in the two cases
// where it is not, on the previews the two constants below pick out.
const PROJECTION_OPENING_SHARE = 0.2;
// A part-day preview clears a fifth of the peak on its own. Toy Story 5 ran 394
// screenings on 18 June — evening previews only — then 1,102, 1,290 and 1,238
// once it opened on the 19th. Anchored on the 18th, the run opens on a day that
// reads as a collapse the film immediately recovered from, and the trim the
// anchor exists to drive leaves the previews on the chart. What separates a
// preview from an opening is not its size against the peak but its size against
// the days either side of it: a preview evening is a fraction of the level the
// release settles at within a day, where an opening day is already at that
// level — even an opening Friday is rarely half again smaller than its own
// Saturday. Across films with more than 500 screenings, day-on-day growth
// inside an established run passes 1.57x once in a hundred days.
const PREVIEW_DAY_SHARE = 0.6;
// ...measured against the busiest of the next few days rather than tomorrow
// alone, so one quiet day cannot end the walk early.
const PREVIEW_LOOKAHEAD = 3;
// The other shape is a preview weekend, and nothing about its level gives it
// away: Hoppers ran 455 and 425 on 28 February and 1 March, went dark for four
// days, and opened on the 6th at 416 before peaking at 610 the next day. The
// previews are the same size as the run. The dark days are the tell — cinemas
// do not drop a film for half a week in the middle of a release — so a gap this
// long before the peak marks previews off from the run that follows.
const PREVIEW_GAP_DAYS = 3;
// The gap is counted in quiet days rather than empty ones, because a single
// booking is enough to bridge it otherwise: Project Hail Mary previewed on 14
// and 15 March, was dark on the 16th, ran ONE screening on the 17th, was dark
// again on the 18th and opened on the 19th at 466 on its way to 675. Three days
// of nothing, with one show in the middle of them, and that one show is enough
// to leave the previews looking continuous with the release. A day at a
// twentieth of the film's best is a one-off booking, not a film in release —
// the same yardstick closingDay and projectRun use at the other end of a run.
const PREVIEW_QUIET_SHARE = 0.05;
// Two-sided 95% t quantiles by degrees of freedom, for the slope interval. A fit
// on four weekly points has 2 degrees of freedom, where t is 4.30 against the
// normal's 1.96 — using the normal here would draw a band less than half the
// width it should be, on exactly the films with the least data behind them.
const T95 = [
  12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18,
  2.16, 2.14, 2.13,
];
const t95 = (df) => (df < 1 ? T95[0] : (T95[df - 1] ?? 1.96));

// Second week against the first, which is the shape of a release in one number.
// The projection below leans on the same quantity: across the completed wide
// releases here the median is 0.55, a film roughly halves every week. What the
// column adds is the spread around it — under a quarter is a title being pulled
// rather than fading, and over 100% is a platform release still widening, which
// is a different animal from a hit.
//
// A share of the WHOLE run would be the more natural way to say "front-loaded",
// and is the wrong measure here: two thirds of the films in this list are still
// playing, so their run is not over to take a share of, and every one of them
// would read as more front-loaded than it turns out to be. Week two against week
// one is settled the moment both weeks are in.
//
// Below this many screenings in the opening week the ratio is arithmetic on
// noise — a title with two bookings then one reads as a perfectly ordinary 50%
// decline — so it is left blank rather than sorted in among the releases it
// means something for.
const RETENTION_MIN_WEEK = 25;

// Weekly totals from the film's opening. A trailing week the data boundary cuts
// short is dropped rather than plotted: a four-day week reads as a collapse, and
// for a film still showing that is always the most recent week — exactly the one
// the fit would lean on hardest.
function weeklyTotals(days, opening, dataEnd) {
  const weeks = [];
  for (let w = 0; addDays(opening, w * 7 + 6) <= dataEnd; w++) {
    let total = 0;
    for (let d = 0; d < 7; d++) total += days[addDays(opening, w * 7 + d)] || 0;
    weeks.push(total);
  }
  while (weeks.length && weeks.at(-1) === 0) weeks.pop(); // after the run, not in it
  return weeks;
}

// The level a film is playing at once a given day is behind it: the busiest of
// the few days that follow. Both preview tests below are really the same
// question asked twice — is this day part of the run, or in front of it — and
// the run is what comes next, not what this one day happens to hold.
function levelAfter(days, date) {
  let level = 0;
  for (let d = 1; d <= PREVIEW_LOOKAHEAD; d++)
    level = Math.max(level, days[addDays(date, d)] || 0);
  return level;
}

// The day the film opened, as against the day it was first shown anywhere.
function openingDay(days) {
  const dates = Object.keys(days).sort();
  const best = Math.max(...Object.values(days));
  const peak = dates.find((date) => days[date] === best);
  let opening = dates.find(
    (date) => days[date] >= best * PROJECTION_OPENING_SHARE,
  );

  // A preview weekend cut off from the run by quiet days. The peak day is in
  // scope: for a film that platforms, the opening IS the peak — The Stranger
  // trickled 1 to 11 screenings a day from 16 March, then went quiet for a week
  // and opened on 10 April at 45, holding 45, 45, 43, 42 from there. What keeps
  // that from dragging every sparse title forward to its busiest afternoon is
  // the second half of the test: a gap only marks an opening when a run
  // follows it, not a single booking. Eternity's busiest day is an isolated
  // spike in April with nothing either side, so its opening stays in January.
  let quiet = 0;
  for (let date = dates[0]; date <= peak; date = addDays(date, 1)) {
    const screenings = days[date] || 0;
    if (screenings < best * PREVIEW_QUIET_SHARE) {
      quiet++;
      continue;
    }
    if (
      quiet >= PREVIEW_GAP_DAYS &&
      screenings >= best * PROJECTION_OPENING_SHARE &&
      levelAfter(days, date) >= best * PROJECTION_OPENING_SHARE &&
      date > opening
    )
      opening = date;
    quiet = 0;
  }

  // Then walk off part-day previews a day at a time, bounded by the peak day,
  // which is by definition not one.
  // `|| 0` is load-bearing: the walk steps over dark days, and `undefined < x`
  // is false, which would stop it on one and open the run on a day the film
  // did not screen.
  while (
    opening < peak &&
    (days[opening] || 0) < levelAfter(days, opening) * PREVIEW_DAY_SHARE
  )
    opening = addDays(opening, 1);
  return opening;
}

// The day the film's wide release effectively ended, as against the day it was
// last shown anywhere — long-tail one-off and repertory bookings can trail a
// film for years after it has otherwise left cinemas. Unlike openingDay, a
// single day's count is the wrong yardstick here: a hit's peak day can run to
// several hundred screenings, and 20% of that is still deep in the decline,
// not the flatline the trim is meant to remove — chomping the chart off while
// it is still clearly headed down. Mirrors the "run over" point projectRun
// uses instead: the last week that still reaches a twentieth of the film's
// peak WEEK, past which it is one-off bookings, not the run.
function closingDay(days) {
  const dates = Object.keys(days).sort();
  const first = dates[0];
  const last = dates.at(-1);
  const weeks = weeklyTotals(days, first, last);
  if (!weeks.length) return last;
  const peak = Math.max(...weeks);
  const threshold = peak * PROJECTION_END_SHARE;
  let endWeek = weeks.indexOf(peak);
  for (let w = endWeek; w < weeks.length && weeks[w] >= threshold; w++)
    endWeek = w;
  const weekEnd = addDays(first, endWeek * 7 + 6);
  return weekEnd < last ? weekEnd : last;
}

// Fit a film's decline and say where it runs out. Returns null when the film has
// not given the fit enough to work with, which is a normal answer, not a failure.
function projectRun(days, dataEnd) {
  const first = openingDay(days); // the opening, not the first preview
  const weeks = weeklyTotals(days, first, dataEnd);
  if (!weeks.length) return null;

  const peak = Math.max(...weeks);
  if (peak < PROJECTION_MIN_PEAK) return null;
  const peakWeek = weeks.indexOf(peak);
  const threshold = peak * PROJECTION_END_SHARE;

  // Fit from the peak to the first week already under the threshold. Past that
  // point a film is on one-off and repertory bookings — Super Mario Galaxy fell
  // to 8 screenings a week and then came back to 183 — and that is a different
  // process from the theatrical decline being modelled here.
  const xs = [];
  const ys = [];
  for (let w = peakWeek; w < weeks.length && weeks[w] >= threshold; w++) {
    xs.push(w);
    ys.push(Math.log(weeks[w]));
  }
  if (xs.length < PROJECTION_MIN_WEEKS) return null;

  // Least squares anchored at the centroid, so slope and intercept are
  // uncorrelated and the band below can be drawn by varying the slope alone.
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  const slope = sxy / sxx;
  if (!(slope < 0)) return null; // still climbing, or flat — nothing to project
  // not a run in decline — but only once there is enough of it to tell
  if (n >= PROJECTION_FLAT_WEEKS && Math.exp(slope) > PROJECTION_MAX_RETENTION)
    return null;

  // Residual spread gives the standard error of the slope, and with it a band
  // that is narrow for a film declining smoothly and wide for one that is not.
  let ss = 0;
  for (let i = 0; i < n; i++)
    ss += (ys[i] - (meanY + slope * (xs[i] - meanX))) ** 2;
  // n is at least PROJECTION_MIN_WEEKS, so there is always at least 1 degree of
  // freedom here and no need to guard the division.
  const slopeErr = t95(n - 2) * Math.sqrt(ss / (n - 2) / sxx);

  // Week, possibly fractional, where a line of the given slope hits the threshold
  const crossing = (s) => meanX + (Math.log(threshold) - meanY) / s;
  const endWeek = crossing(slope);
  // The last week the fit is built on, NOT the last week the film screened at
  // all. Those diverge by months for a film that finished its run and then came
  // back for repertory dates, and using the latter would stretch the drawn line
  // flat along the axis for half a year after the run it describes had ended.
  const lastWeek = xs.at(-1);
  // A pure safety rail. Every route to drawTo is bounded already — a fit under
  // the ceiling reaches the threshold within log(0.05)/log(0.85) = 18.4 weeks,
  // and one above it draws only to the ceiling's own crossing — so this should
  // never bind. It stays because if that ever stopped holding, the cost is the
  // chart building a row per day for years and locking the page up drawing them.
  const cap = lastWeek + PROJECTION_MAX_WEEKS;
  const onWeek = (w) => addDays(first, Math.round(w * 7));

  // A steeper slope ends the run sooner. The shallow end is held to the slowest
  // decline the data has ever shown, which is what stops a merely uncertain
  // slope putting the late edge a year and a half out.
  //
  // A fit shorter than PROJECTION_FLAT_WEEKS is allowed to sit above that
  // ceiling, and then the clamp has nothing to say: it would hand the late end a
  // slope STEEPER than the fit itself, and the only way to keep the two ends in
  // order would be to pin the late end onto the point estimate — an interval
  // that looks two-sided and is not. Spider-Man: Brand New Day fits 87.6% on
  // three weeks and did exactly that, reporting "between 4 Sept and 5 Jan" where
  // 5 Jan was just the estimate wearing an upper bound's label. A film declining
  // more slowly than anything that has finished is a film whose far end this
  // cannot bound, and saying so is the only honest answer.
  const ceilingSlope = Math.log(PROJECTION_MAX_RETENTION);
  const unbounded = slope > ceilingSlope;
  const earliestWeek = crossing(slope - slopeErr);
  const latestWeek = unbounded
    ? null
    : crossing(Math.min(slope + slopeErr, ceilingSlope));

  return {
    first,
    peakWeek,
    fitWeeks: n,
    // the readable form of the slope: the share of a week's screenings that the
    // next week keeps
    retention: Math.exp(slope),
    observedTo: addDays(first, lastWeek * 7 + 6),
    endDate: onWeek(endWeek),
    // declining more slowly than any finished run here: no end date to give
    unbounded,
    earliest: onWeek(earliestWeek),
    latest: unbounded ? null : onWeek(latestWeek),
    // how many weeks wide the interval is, so a fit too vague to name a date can
    // say so instead of naming one anyway
    spread: unbounded ? Infinity : latestWeek - earliestWeek,
    // The fit loop above stops at the first week under the threshold, so if it
    // stopped before running out of weeks then the run has already got there and
    // the date is known rather than projected. Reported as the week it began:
    // the threshold is a weekly total, so no single day inside it is the crossing.
    crossedOn: lastWeek + 1 < weeks.length ? onWeek(lastWeek + 1) : null,
    drawFrom: addDays(first, peakWeek * 7),
    drawTo: onWeek(
      Math.min(
        Math.max(unbounded ? crossing(ceilingSlope) : endWeek, lastWeek + 1),
        cap,
      ),
    ),
    // what the fit puts on a day, as a daily rate so it can be drawn against the
    // daily series the chart already plots
    rateOn: (date) =>
      Math.exp(meanY + slope * (dayGap(first, date) / 7 - meanX)) / 7,
  };
}

// The note carries the method; per-film numbers live in the dashed line's own
// tooltip, which has room for them however many films are selected.
function projectionNote(selected, projections) {
  const found = projections.filter(Boolean);
  if (!found.length)
    return (
      `No trend to project here. A film needs a peak week of at least ` +
      `${PROJECTION_MIN_PEAK} screenings and ${PROJECTION_MIN_WEEKS} complete ` +
      `weeks after it — and once ${PROJECTION_FLAT_WEEKS} weeks are in, it has ` +
      `to still be losing more than ` +
      `${(100 - PROJECTION_MAX_RETENTION * 100).toFixed(0)}% a week: a title on ` +
      `a standing weekend matinee is holding steady, not winding down.`
    );

  const only = found.length === 1 && selected.length === 1 ? found[0] : null;
  if (!only)
    return (
      `Dashed lines fit each film's own weekly decline and continue it to 5% of ` +
      `its peak week. Hover one for its projected end date.`
    );

  const on = (date) => fmtDay.format(asDate(date));
  const holding = `Holding ${(only.retention * 100).toFixed(0)}% of its screenings week to week`;

  // Already there. The date is measured, not projected, so it leads — and the
  // estimate stays alongside it as a read on how well the fit did.
  if (only.crossedOn)
    return (
      `${holding}, estimated to reach 5% of its peak around ${on(only.endDate)} ` +
      `(actually the week of ${on(only.crossedOn)}).`
    );

  // Holding on better than anything that has finished. There is a floor but no
  // ceiling on when this ends, so give the floor and say the rest is open.
  if (only.unbounded)
    return (
      `${holding} — slower than any run in this data that has finished. On ` +
      `${only.fitWeeks} weeks that is not enough to call an end: no earlier ` +
      `than ${on(only.earliest)}, with no far end the fit can put a date on.`
    );

  // Too vague to name a date. Saying "23 October" and then "between September
  // and next June" in the same breath just makes the first half noise.
  if (only.spread > PROJECTION_VAGUE_WEEKS)
    return (
      `${holding}, but the fit is still too loose to call: it puts the end of ` +
      `the run anywhere between ${on(only.earliest)} and ${on(only.latest)}.`
    );

  return (
    `${holding}, the run reaches 5% of its peak around ${on(only.endDate)} — ` +
    `between ${on(only.earliest)} and ${on(only.latest)} on the spread of the fit.`
  );
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
  // Opt-in, and off by default: the dashed lines are a model, not measurement,
  // and they should not be the first thing the chart says about a film.
  const projected = el("runProject").checked;
  const projections = selected.map((film) =>
    projected ? projectRun(film.days, dataEnd) : null,
  );
  el("runNote").textContent = projected
    ? projectionNote(selected, projections)
    : "";

  // A film's first recorded screening is very often a preview, or a handful of
  // sparse lead-in dates well ahead of general release — The Invite ran 1
  // screening on 3 June, 12 on the 23rd and 16 on the 30th before opening wide
  // at 301 on 3 July. Left in, that lead-in is most of a run's early length on
  // the chart and throws off both the aligned day-0 and any calendar overlap
  // with other films. Trimming to the same "opening" the decline fit anchors
  // on — openingDay, which reads past a sparse lead-in, a preview evening and a
  // preview weekend alike — drops it.
  // The same trailing tail Super Mario Galaxy showed in the projection comment
  // above — falling to a handful of screenings a week, then still turning up
  // occasionally for years on repertory and one-off bookings — stretches a run
  // on the chart long after the wide release that makes it comparable to
  // others has finished. Trimming to the last day a film reaches a fifth of
  // its own best day drops that tail, symmetric with trimming the lead-in.
  const trimLeadIn = el("runTrimLeadIn").checked;
  const trimTail = el("runTrimTail").checked;
  const runs = selected.map((film) => {
    const own = Object.keys(film.days).sort();
    const first = trimLeadIn ? openingDay(film.days) : own[0];
    const last = trimTail ? closingDay(film.days) : own.at(-1);
    // Neither trim can find a release in a film that never had one. A repertory
    // title playing one-off bookings across the year has no opening and no
    // closing, only its own busiest day, and the two ends can cross: Eternity's
    // opening falls 83 days after its closing, 300's 107 days after. Crossed,
    // the film silently leaves the chart — every row below is gated on
    // `date >= first && date <= last` — while keeping its legend entry and its
    // colour, and a film ticked on its own takes the whole chart blank with it.
    // Where the trims leave a single day or less of a run that plainly lasted
    // longer, they have nothing to say about that film, so let them say nothing
    // and plot it whole. 42 films, one of which anyone would notice.
    return dayGap(first, last) < 1 && dayGap(own[0], own.at(-1)) > 1
      ? { first: own[0], last: own.at(-1) }
      : { first, last };
  });
  const from = runs.reduce(
    (a, r) => (r.first < a ? r.first : a),
    runs[0].first,
  );
  // A projection runs past the last day anything was actually screened, so the
  // axis has to reach it — otherwise the line is drawn only as far as the
  // measured data and stops short of the date it exists to give.
  const to = projections.reduce(
    (a, p) => (p && p.drawTo > a ? p.drawTo : a),
    runs.reduce((a, r) => (r.last > a ? r.last : a), runs[0].last),
  );

  // Aligned mode slides every film to a shared day 0 = its own first screening,
  // so runs that never overlapped in the calendar can be compared shape to shape.
  // The x-axis stops being a date and becomes a count of days into the run.
  const aligned = el("runNormalise").checked;

  const data = [];
  if (aligned) {
    const longest = Math.max(
      ...runs.map((r) => dayGap(r.first, r.last)),
      ...projections.map((p) => (p ? dayGap(p.first, p.drawTo) : 0)),
    );
    for (let offset = 0; offset <= longest; offset++) {
      const row = { offset };
      selected.forEach((film, i) => {
        const date = addDays(runs[i].first, offset);
        if (date <= runs[i].last) row[`f${i}`] = film.days[date] || 0;
        const p = projections[i];
        if (p && date >= p.drawFrom && date <= p.drawTo)
          row[`p${i}`] = p.rateOn(date);
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
        const p = projections[i];
        if (p && date >= p.drawFrom && date <= p.drawTo)
          row[`p${i}`] = p.rateOn(date);
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

  // Listed before the measured series so they draw underneath: the model should
  // never be the line sitting on top of the thing it is modelling.
  const projectionSeries = [];
  projections.forEach((p, i) => {
    if (!p) return;
    projectionSeries.push({
      type: "line",
      xKey: aligned ? "offset" : "date",
      yKey: `p${i}`,
      yName: `${selected[i].title} (projected)`,
      // the film's own colour, dashed and dimmed — same subject, weaker claim
      stroke: SERIES[i % SERIES.length],
      strokeWidth: 2,
      strokeOpacity: 0.5,
      lineDash: [6, 5],
      marker: { enabled: false },
      connectMissingData: false,
      // the legend already names the film; a second entry per film would double
      // its length to say nothing the dashing does not
      showInLegend: false,
      tooltip: {
        renderer: ({ datum }) => ({
          title: `${selected[i].title} · projected`,
          data: [
            {
              label: aligned
                ? `Day ${datum.offset}`
                : fmtDay.format(datum.date),
              value: `${datum[`p${i}`].toFixed(1)} screenings/day`,
            },
            {
              label: "Holding week to week",
              value: `${(p.retention * 100).toFixed(0)}%`,
            },
            {
              label: "Fitted on",
              value: `${p.fitWeeks} weeks to ${fmtDay.format(asDate(p.observedTo))}`,
            },
            {
              label: "Run over by",
              value: p.unbounded
                ? "too slow to call"
                : fmtDay.format(asDate(p.endDate)),
            },
            {
              // ~73% of the time in backtest, not the nominal 95% — the gap is
              // films losing screens, which the fit cannot see coming
              label: "Range (holds ~3 in 4)",
              value: p.latest
                ? `${fmtDay.format(asDate(p.earliest))} – ${fmtDay.format(asDate(p.latest))}`
                : `${fmtDay.format(asDate(p.earliest))} at the earliest`,
            },
            // only once it has actually happened; measured, so it goes last as
            // the thing the rows above were estimating
            ...(p.crossedOn
              ? [
                  {
                    label: "Actually reached it",
                    value: `week of ${fmtDay.format(asDate(p.crossedOn))}`,
                  },
                ]
              : []),
          ],
        }),
      },
    });
  });

  const options = {
    ...chartBase,
    container: el("runChart"),
    data,
    series: [...projectionSeries, ...series],
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
  // than update, since that is a change of axis type, not just of data. The
  // projection toggle adds and removes whole series, so it gets the same
  // treatment rather than trusting update() to reconcile the difference.
  if (runChart && (runAligned !== aligned || runProjected !== projected)) {
    runChart.destroy();
    runChart = null;
  }
  runAligned = aligned;
  runProjected = projected;
  runChart = runChart
    ? (runChart.update(options), runChart)
    : AgCharts.create(options);
  const names = selected.map((f) => f.title);
  sub.textContent =
    names.length > 4
      ? `${names.slice(0, 4).join(" · ")} and ${names.length - 4} more`
      : names.join(" · ");
}

// Axes are a dictionary keyed by axis name, NOT an array — an array is rejected
// wholesale ("expecting an object, ignoring") and every option in it silently
// lost, leaving the chart on inferred default axes.
const runAxes = (aligned = false) => ({
  x: aligned
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
  y: {
    type: "number",
    position: "left",
    min: 0,
    title: { enabled: false },
    label: { formatter: ({ value }) => fmtInt.format(value) },
  },
});

function renderFilms(blob, boundary) {
  const byFilm = {};
  for (const [id, hours] of Object.entries(blob.finalized.counts))
    byFilm[id] = dailyForFilm(hours);

  // The finalized/provisional boundary falls mid-day, so a film's last finalized
  // day holds only the hours before it — a run then ends on a cliff that records
  // when the build ran rather than anything the film did. Complete that day from
  // the provisional window (the same split renderDaily makes, and safe from
  // double counting because the provisional window opens exactly where the
  // finalized one closes), or drop it when there is nothing to complete it with.
  if (blob.provisional) {
    for (const [id, hours] of Object.entries(blob.provisional.counts)) {
      const listed = dailyForFilm(hours)[boundary];
      if (!listed) continue;
      const days = (byFilm[id] ||= {});
      days[boundary] = (days[boundary] || 0) + listed;
    }
  } else if (boundary) {
    for (const days of Object.values(byFilm)) delete days[boundary];
  }
  // Whichever branch ran above decides where the measured data stops, and the
  // projection needs that to know whether a film's last week is a real week or
  // just the part of one the build happened to catch.
  dataEnd = blob.provisional ? boundary : addDays(boundary, -1);

  let films = Object.entries(byFilm)
    // Dropping the part-measured boundary day above can empty a film out entirely:
    // one whose only listed screening was on it now has no days, so no opening and
    // no run. It would be filtered out below for having under two screenings
    // anyway, but every date derived from it between here and there is built on a
    // first day that does not exist.
    .filter(([, days]) => Object.keys(days).length > 0)
    .map(([id, days]) => {
      const dates = Object.keys(days).sort();
      const meta = blob.movies[id] || {};
      const opening = openingDay(days);
      const [week1, week2] = weeklyTotals(days, opening, dataEnd);
      const screenings = Object.values(days).reduce((a, b) => a + b, 0);
      return {
        id,
        title: meta.t || id,
        year: meta.y || null,
        screenings,
        days: dates.length,
        first: dates[0],
        last: dates.at(-1),
        opening: asDate(opening),
        // null, not 0, for a film the data does not yet hold two whole weeks of:
        // weeklyTotals drops a week the boundary cuts short, and a part week reads
        // as a collapse the film never had
        retained:
          week2 !== undefined && week1 >= RETENTION_MIN_WEEK
            ? (100 * week2) / week1
            : null,
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

  // Declared before the grid so the selection handler cannot reach it in its
  // temporal dead zone; `grid` inside is only read once something is selected.
  const rechart = () =>
    renderRun(
      grid.getSelectedRows().map((r) => ({ title: r.title, days: r.series })),
    );

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
      {
        field: "opening",
        headerName: "Opening",
        width: 130,
        // the day the wide release started — the same "opening" the run
        // chart's lead-in trim and decline projection anchor on, not the day
        // it was first (often sparsely, or in previews) shown anywhere
        filter: "agDateColumnFilter",
        filterParams: { defaultOption: "greaterThanOrEqual" },
        valueFormatter: ({ value }) => fmtDate.format(value),
      },
      {
        field: "retained",
        headerName: "Week 2",
        width: 120,
        headerTooltip:
          "The film's second week as a share of its first. Over 100% means it " +
          "widened after opening rather than starting to fade.",
        filter: "agNumberColumnFilter",
        // the question here is "which films held on", so the default reads as a
        // threshold rather than an exact match on a percentage
        filterParams: { defaultOption: "greaterThanOrEqual" },
        valueFormatter: ({ value }) =>
          value === null ? "—" : `${value.toFixed(0)}%`,
      },
    ],
    onSelectionChanged: () => rechart(),
  });

  el("filmGridSub").innerHTML =
    `${fmtInt.format(films.length)} films with more than one recorded screening ` +
    `(${fmtInt.format(oneOff)} one-off screenings excluded).<br>` +
    `Filter in any column, then tick films to compare their runs.`;

  // Re-chart the current selection when any toggle flips
  el("runNormalise").addEventListener("change", rechart);
  el("runProject").addEventListener("change", rechart);
  el("runTrimLeadIn").addEventListener("change", rechart);
  el("runTrimTail").addEventListener("change", rechart);

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
    // Wired here rather than at module scope so they cannot fire before there is
    // a chart to redraw
    el("dailyHolidays").addEventListener("change", redrawDailyBands);
    el("dailyWeekends").addEventListener("change", redrawDailyBands);
    renderHours(summary);
    const blob = await load("/data/history.json");
    const byDay = dailyByFilm(blob, summary.finalized.partialDay);
    renderShare(byDay, blob.movies);
    renderChangeover(byDay, blob.movies);
    renderFilms(blob, summary.finalized.partialDay);
  })
  .catch((err) => {
    console.error(err);
    el("meta").textContent = "failed to load history data";
  });
