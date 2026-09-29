// London-wide publishing: what the estate put on sale, day by day, and against
// it what actually screened.
//
// The data is not fetched. Everything these charts need is a few hundred rows
// summed over every venue, so the page embeds them at build time (see
// src/pages/london.astro) rather than downloading the 500 KB per-venue diffs
// blob to add it up in the browser. Per-venue publishing lives on the venue
// pages, drawn at build time too.
//
// The chart code itself is the old "When venues publish" page's, with its scope
// picker and venue table removed: the reasoning in the comments below is still
// the reasoning. Its element ids are prefixed "pub" where they would otherwise
// collide with the screening-history module sharing the page.
//
// The one thing worth knowing before reading any chart here: a day is the day
// an interval between two releases STARTED. Releases land about twice a day, so
// a diff usually spans an evening and the following morning, and the hourly
// listing checks say that is when the publishing happened — 39% of everything
// added arrives between 19:00 and midnight against 5% between midnight and
// 06:00. See dayOfInterval in diffs.mjs.

import {
  AgCharts,
  ModuleRegistry as ChartModuleRegistry,
  AllCommunityModule as AllChartModules,
} from "ag-charts-community";
// Heatmap is an AG Charts Enterprise series. Week × weekday is a grid of
// magnitudes, which is what a heatmap is for: the question it answers — does
// this venue move on the same day every week, and has that day drifted — is a
// shape, and thirty-five overlaid lines is not a shape.
import {
  HeatmapSeriesModule,
  GradientLegendModule,
} from "ag-charts-enterprise";
ChartModuleRegistry.registerModules([
  ...AllChartModules,
  HeatmapSeriesModule,
  GradientLegendModule,
]);

// Two series, taken from the site palette validated against this surface in
// src/history.js. Slot 0 (the site accent) and slot 2 are far enough apart to
// stack: worst-case CVD ΔE 22.8, normal-vision 24.0, both over 3:1 on #1c1c20.
// Order is the safety mechanism — do not swap these for other slots without
// re-validating the pair.
const EXTENDED_INK = "#3b82f6"; // blue — more of something already listed
const NEW_INK = "#199e70"; // aqua — something that was not listed at all
// The screened line is neutral rather than a third hue: it is the reference the
// columns are read against, not another part of the stack.
const SCREENED_INK = "#e4e4e7";
const SURFACE = "#1c1c20"; // the .card background these charts sit on
const AXIS_INK = "#a1a1aa";
const GRID_INK = "#2e2e34";

// Sequential ramp for the calendar, running up from the card surface so a day
// with nothing added simply is not there and a changeover reads as light. Same
// construction as the venue-health heatmap, and the same reason: stops are
// fractions of the busiest cell, so the ramp re-fits itself to the selection.
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

// Axis options have to go through the theme, not the axis.
//
// `chartBase` sets label colours in `theme.overrides.common.axes.<type>.label`,
// and that object REPLACES an inline `axes[].label` rather than merging under
// it — so an axis written as `{ type: "category", label: { formatter } }` keeps
// the theme's colour and silently loses the formatter, with no warning and no
// error. It cost an hour here; the venue-health page never noticed because none
// of its axes format anything.
//
// So axis options are merged into a copy of the theme instead. `common.axes`
// applies to every axis of that type in the chart, which is fine while each
// chart has one axis of each type it wants to format — the calendar, whose x
// and y are both category axes, therefore formats neither.
const withAxisOptions = (byType) => ({
  ...chartBase,
  theme: {
    ...chartBase.theme,
    overrides: {
      common: {
        axes: Object.fromEntries(
          Object.entries(chartBase.theme.overrides.common.axes).map(
            ([type, options]) => {
              const extra = byType[type];
              if (!extra) return [type, options];
              const { label, ...rest } = extra;
              return [
                type,
                { ...options, ...rest, label: { ...options.label, ...label } },
              ];
            },
          ),
        ),
      },
    },
  },
});

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
const fmtDate = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const fmtShort = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
});
const fmtMonth = new Intl.DateTimeFormat("en-GB", { month: "short" });

const el = (id) => document.getElementById(id);
// Monday-first. `weekday` in the blob is 0 = Sunday, matching Date#getUTCDay.
const WEEK = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
];

// Charts are created once; nothing on this page changes scope, but upsert keeps
// the same shape as the other chart modules.
const charts = {};
const upsert = (id, options) => {
  if (charts[id]) charts[id].update(options);
  else charts[id] = AgCharts.create(options);
};

const scope = { label: "London's venues" };

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

// Columns, not a line. The series is spiky by nature — a chain does nothing for
// six days and then adds four thousand performances in one evening — and a line
// would draw a slope between two days that says a rise happened across them.
// Stacked, because the two parts are parts of one total rather than two
// measures: performances added to a run the venue was already listing, and
// performances belonging to a title it was not listing at all.
function renderDaily(rows) {
  const covered = rows.filter((r) => r.covered);
  const total = covered.reduce((sum, r) => sum + r.total, 0);
  const fresh = covered.reduce((sum, r) => sum + r.fresh, 0);
  const busiest = covered.reduce((best, r) => (r.total > best.total ? r : best), covered[0]);
  const active = covered.filter((r) => r.total > 0).length;

  el("pubStats").replaceChildren(
    ...[
      [fmtInt.format(total), "performances added"],
      [fmtInt.format(busiest.total), `busiest day — ${fmtDate.format(busiest.date)}`],
      [`${active}`, `days of ${covered.length} with anything added`],
      [
        total ? `${Math.round((100 * fresh) / total)}%` : "—",
        "of them on titles that were not listed",
      ],
    ].map(([value, label]) => {
      const stat = document.createElement("div");
      stat.className = "stat";
      const v = document.createElement("span");
      v.className = "value";
      v.textContent = value;
      const l = document.createElement("span");
      l.className = "label";
      l.textContent = label;
      stat.append(v, l);
      return stat;
    }),
  );

  const monthStarts = rows
    .map((row) => row.day)
    .filter((day) => day.endsWith("-01"));

  el("pubDailySub").textContent =
    `Future performances ${scope.label} put on sale each day, ${fmtShort.format(rows[0].date)} to ${fmtShort.format(rows.at(-1).date)}, ` +
    `against the screenings that actually ran that day.`;

  upsert("daily", {
    ...withAxisOptions({
      // One label per month, on its first day, rather than letting collision
      // avoidance thin 248 dates down to a handful landing on no particular
      // date. Returning "" still reserves the slot, which is what keeps the
      // remaining labels on their own bars.
      category: {
        // Ticks named rather than left to the axis. A category axis chooses its
        // subset of the 248 slots BEFORE the formatter runs, so a formatter that
        // returns "" for everything but the first of a month does not thin the
        // axis to twelve labels — it silences whichever arbitrary handful the
        // axis had already chosen, and only those that happen to land on a 1st
        // survive. Naming them is the only way to say which days get labelled,
        // and it has to come through the theme for the same reason the formatter
        // does.
        interval: { values: monthStarts },
        label: {
          formatter: ({ value }) =>
            fmtMonth.format(new Date(`${value}T12:00:00Z`)),
        },
      },
      number: { label: { formatter: ({ value }) => fmtInt.format(value) } },
    }),
    container: el("pubDailyChart"),
    data: rows,
    series: [
      {
        type: "bar",
        xKey: "day",
        yKey: "extended",
        yName: "Added to a run already listed",
        stacked: true,
        fill: EXTENDED_INK,
        strokeWidth: 0,
        cornerRadius: 0,
        tooltip: { renderer: dailyTooltipLower },
      },
      {
        type: "bar",
        xKey: "day",
        yKey: "fresh",
        yName: "On a title that was not listed",
        stacked: true,
        fill: NEW_INK,
        strokeWidth: 0,
        cornerRadius: 4,
        tooltip: { renderer: dailyTooltipUpper },
      },
      // What ran that day, on the same axis. Both series count performances, so
      // they share a scale honestly: one axis, no second y to line up by eye.
      // The line is the steady thing — London screens about the same number
      // every day — and the columns are what the chains are doing to keep it
      // fed, in bursts.
      {
        type: "line",
        xKey: "day",
        yKey: "screened",
        yName: "Screened that day",
        stroke: SCREENED_INK,
        strokeWidth: 1.5,
        marker: { enabled: false },
        tooltip: {
          renderer: ({ datum }) => ({
            heading: fmtDate.format(datum.date),
            title: "Screened that day",
            data: [{ label: "Screenings", value: fmtInt.format(datum.screened) }],
          }),
        },
      },
    ],
    axes: [
      // A category axis, one slot per day, rather than a time axis. The series
      // is a complete run of calendar days — every day between the first and the
      // last is present, the six with no release included as nulls — so there is
      // no interval for a time scale to space proportionally, and a time axis
      // rounds its domain outward to tidy ticks instead: it reached the turn of
      // the year and hung eight blank weeks off the right, which reads as a
      // stretch where the estate published nothing rather than as axis padding.
      // Neither `nice: false` nor an explicit min/max moved it.
      { type: "category", position: "bottom" },
      {
        type: "number",
        position: "left",
        title: { text: "performances added", color: AXIS_INK },
      },
    ],
    legend: { ...legendBase, enabled: true },
  });

  el("pubDailyNote").innerHTML =
    `The <strong>line</strong> is screenings that ran that day, from the screening history above. The columns are what went ` +
    `on sale that day for any date ahead — so a tall column is the estate stocking up weeks of line at once, usually ` +
    `on a Monday or Tuesday changeover. ` +
    `A day is the day a release interval <strong>started</strong>. Releases land about twice a day, so most ` +
    `intervals span an evening and the next morning; Clusterflick's hourly listing checks put 39% of ` +
    `everything added between 19:00 and midnight against 5% between midnight and 06:00, so the evening is ` +
    `the side to credit. Removals are charted nowhere here — at midnight every venue drops the day that ` +
    `just ended, which would swamp anything a venue actually cancelled.`;
}

// A stacked bar's tooltip is ONE box with a section per series, so each series
// contributes its own part and no more. Giving both the whole breakdown — the
// obvious thing to write, since either section alone looks incomplete — renders
// the entire block twice, date and all.
//
// `heading` rather than `title`, and only on the lower series. A section's
// `title` sits inside it, beside that series' colour swatch, so a date written
// there is a property of the blue half rather than of the day; `heading` is the
// box's own. Left unset, the heading falls back to the x value run through the
// axis label formatter, which on the daily chart means every tooltip is
// captioned with the month the day is in — a bare "Jan" above "Mon 19 Jan".
// The section `title` also carries that section's colour swatch, so leaving it
// off strands the swatch on a line of its own above unlabelled rows. Each
// section is therefore titled with its series, worded as the legend words it.
const dailyTooltipLower = ({ datum }) => ({
  heading: fmtDate.format(datum.date),
  title: "Added to a run already listed",
  data: [{ label: "Performances", value: fmtInt.format(datum.extended) }],
});

const dailyTooltipUpper = ({ datum }) => ({
  // The same heading, not a missing one: a section without its own falls back
  // to the x value through the axis formatter, which would drop a stray "Jan"
  // into the middle of the box. Matching the section below it collapses the two
  // into one heading.
  heading: fmtDate.format(datum.date),
  title: "On a title that was not listed",
  data: [
    { label: "Performances", value: fmtInt.format(datum.fresh) },
    { label: "Total added", value: fmtInt.format(datum.total) },
    { label: "Removed", value: fmtInt.format(datum.removed) },
  ],
});

// The headline question — "is it every Monday?" — as a bar per weekday. Totals
// rather than means: the days in range are not evenly spread across weekdays
// once the window is short, and a mean over an unequal denominator invites
// exactly the reading it cannot support.
function renderWeekday(rows) {
  const byWeekday = new Map(WEEK.map(([index, name]) => [index, { name, extended: 0, fresh: 0, days: 0 }]));
  for (const row of rows) {
    if (!row.covered) continue;
    const bucket = byWeekday.get(row.weekday);
    bucket.extended += row.extended;
    bucket.fresh += row.fresh;
    bucket.days += 1;
  }
  const data = WEEK.map(([index]) => {
    const b = byWeekday.get(index);
    return { ...b, total: b.extended + b.fresh };
  });
  const top = data.reduce((best, d) => (d.total > best.total ? d : best), data[0]);
  const total = data.reduce((sum, d) => sum + d.total, 0);

  el("weekdaySub").textContent = total
    ? `${top.name} carries ${Math.round((100 * top.total) / total)}% of what ${scope.label} added.`
    : "Nothing added in this window.";

  upsert("weekday", {
    ...withAxisOptions({
      number: { label: { formatter: ({ value }) => fmtInt.format(value) } },
    }),
    container: el("weekdayChart"),
    data,
    series: [
      {
        type: "bar",
        xKey: "name",
        yKey: "extended",
        yName: "Added to a run already listed",
        stacked: true,
        fill: EXTENDED_INK,
        strokeWidth: 0,
        cornerRadius: 0,
        // Split across the two series for the same reason as the daily chart:
        // one box, one section per series. Leaving this one to the default
        // renderer does not avoid the problem — the default still contributes a
        // section, so its value appeared once from AG Charts and again from the
        // other series' breakdown. The weekday name is the box's heading, so it
        // is not repeated as a section title either.
        tooltip: {
          renderer: ({ datum }) => ({
            heading: datum.name,
            title: "Added to a run already listed",
            data: [{ label: "Performances", value: fmtInt.format(datum.extended) }],
          }),
        },
      },
      {
        type: "bar",
        xKey: "name",
        yKey: "fresh",
        yName: "On a title that was not listed",
        stacked: true,
        fill: NEW_INK,
        strokeWidth: 0,
        cornerRadius: 4,
        tooltip: {
          renderer: ({ datum }) => ({
            heading: datum.name,
            title: "On a title that was not listed",
            data: [
              { label: "Performances", value: fmtInt.format(datum.fresh) },
              { label: "Total added", value: fmtInt.format(datum.total) },
              { label: `${datum.name}s in range`, value: fmtInt.format(datum.days) },
            ],
          }),
        },
      },
    ],
    axes: [
      { type: "category", position: "bottom" },
      {
        type: "number",
        position: "left",
        title: { text: "performances added", color: AXIS_INK },
      },
    ],
    legend: { ...legendBase, enabled: false },
  });

  el("weekdayNote").innerHTML =
    `Totals, not averages — the window does not hold the same number of each weekday, and a mean over ` +
    `an unequal denominator reads as a rate when it is not one. The bar is split the same way as the ` +
    `daily chart above, so a weekday that is mostly <strong>aqua</strong> is a day for announcements ` +
    `rather than for extending runs already on sale.`;
}

// Week × weekday. The weekday chart says which day it is; this says whether it
// has always been that day. A chain moving its changeover from Monday to
// Tuesday is a diagonal step here and is invisible in a total.
function renderCalendar(rows) {
  // Both axes are category axes, and AG Charts takes a category axis's order
  // from the order its values first appear in the data. Sorting the days is not
  // enough on its own: the range opens on whatever weekday 1 January happened
  // to be, so the rows would come out Thu-first, and a week only partly inside
  // the range would first appear in whichever weekday block it does have and
  // land out of sequence among the columns.
  //
  // So the grid is completed rather than sorted — every week × every weekday,
  // emitted weekday-major in Monday-first order — and the cells with no day
  // behind them carry a null the styler paints as the card itself. A cell that
  // is absent because the range starts mid-week then reads as absent, which is
  // what it is, and not as a Monday nobody published on.
  const cells = new Map();
  const weeks = new Map();
  let peak = 0;
  for (const row of rows) {
    const monday = new Date(row.date);
    monday.setUTCDate(monday.getUTCDate() - ((row.weekday + 6) % 7));
    const week = fmtShort.format(monday);
    if (!weeks.has(week)) weeks.set(week, monday.getTime());
    cells.set(`${week}|${row.weekday}`, row);
    if (row.covered) peak = Math.max(peak, row.total);
  }
  const weekOrder = [...weeks.entries()]
    .sort(([, a], [, b]) => a - b)
    .map(([week]) => week);

  const data = [];
  for (const [index, name] of WEEK) {
    for (const week of weekOrder) {
      const row = cells.get(`${week}|${index}`);
      data.push({
        week,
        day: name,
        date: row?.date ?? null,
        value: row?.covered ? row.total : null,
        // Why the cell is empty: outside the range entirely, or a day inside it
        // that saw no release. The colour is the same — there is nothing to
        // shade either way — but the tooltip should not say the same thing.
        absence: row ? "no release that day" : "outside the range",
      });
    }
  }
  // A ceiling of zero would collapse the colour scale onto a single stop.
  const ceiling = peak > 0 ? peak : 1;

  el("calendarSub").textContent =
    `Each column is a week, each row a weekday. Brightest cell: ${fmtInt.format(peak)} added.`;

  upsert("calendar", {
    ...chartBase,
    container: el("calendarChart"),
    data,
    series: [
      {
        type: "heatmap",
        xKey: "week",
        yKey: "day",
        colorKey: "value",
        colorName: "Performances added",
        itemPadding: 1,
        colorScale: {
          // Pinned to 0 so a day with nothing added lands exactly on the card
          // surface rather than on whatever the quietest day happens to be.
          domain: [0, ceiling],
          fills: RAMP.map(([at, color]) => ({ color, stop: at * ceiling })),
        },
        itemStyler: ({ datum }) =>
          datum.value === null ? { fill: SURFACE } : {},
        tooltip: {
          renderer: ({ datum }) =>
            datum.value === null
              ? { title: `${datum.day}, week of ${datum.week}`, data: [{ label: "No data", value: datum.absence }] }
              : {
                  title: fmtDate.format(datum.date),
                  data: [{ label: "Performances added", value: fmtInt.format(datum.value) }],
                },
        },
      },
    ],
    axes: [
      // Both axes here are category axes, so a theme-level formatter would hit
      // the weekday names as well as the week dates. Collision avoidance thins
      // the weeks on its own and the cells carry the reading anyway.
      { type: "category", position: "bottom" },
      // Monday at the top, to read down the week the way a calendar does — which
      // the weekday-major emission above is what actually delivers.
      { type: "category", position: "left" },
    ],
    gradientLegend: {
      enabled: true,
      position: "bottom",
      spacing: 20,
      scale: { label: { color: AXIS_INK, formatter: ({ value }) => fmtInt.format(value) } },
    },
  });

  el("calendarNote").innerHTML =
    `Weeks run left to right, Monday at the top. A venue on a weekly cycle is a horizontal stripe; ` +
    `one whose changeover has moved is a stripe with a step in it. A dark cell is a day the selection ` +
    `added nothing; an <strong>empty</strong> one is a day no release was published at all, so no diff ` +
    `starts in it — hover to tell them apart. Every interval between two releases is covered exactly ` +
    `once, so there is no third case.`;
}

// ---------------------------------------------------------------------------

function main() {
  const data = JSON.parse(el("londonData").textContent);
  const rows = data.rows.map((row) => ({
    ...row,
    date: new Date(`${row.day}T12:00:00Z`),
    screened: data.screenings[row.day] ?? null,
  }));
  renderDaily(rows);
  renderWeekday(rows);
  renderCalendar(rows);
}

main();
