import {
  createGrid,
  ModuleRegistry,
  themeQuartz,
  colorSchemeDark,
  // community feature modules this app uses
  ClientSideRowModelModule, // the row model
  TextFilterModule, // agTextColumnFilter + default filters
  NumberFilterModule, // agNumberColumnFilter (runtime, year)
  CellStyleModule, // cellClass (right-aligned count)
  DragAndDropModule, // drag columns into the group / pivot panels
  enableDevValidations, // dev-only validation (replaces registering ValidationModule)
} from "ag-grid-community";
import {
  LicenseManager,
  // enterprise feature modules this app uses
  RowGroupingModule, // rowGroup / enableRowGroup
  RowGroupingPanelModule, // the "drag here to set row groups" panel
  AggregationModule, // aggFunc: "count" (group totals + pivot values)
  PivotModule, // pivotMode + pivot columns
  SetFilterModule, // agSetColumnFilter
  SideBarModule, // the side bar shell
  ColumnsToolPanelModule, // side bar "Columns" tab
  FiltersToolPanelModule, // side bar "Filters" tab
  ColumnMenuModule, // column header menu
  CellSelectionModule, // cellSelection
} from "ag-grid-enterprise";

// Dev-only: full-text validation messages if a used feature needs a module we
// forgot (in production these shrink to error codes + doc links). This replaces
// registering ValidationModule; it's tree-shaken out of the prod build.
if (import.meta.env.DEV) enableDevValidations();

// Register only the modules this app actually uses (instead of AllEnterpriseModule)
// so the bundle can tree-shake away the ~90 Enterprise features we don't touch.
// Unlicensed Enterprise is fully functional for evaluation with a small watermark;
// add a key to remove it: LicenseManager.setLicenseKey("...");
ModuleRegistry.registerModules([
  // community
  ClientSideRowModelModule,
  TextFilterModule,
  NumberFilterModule,
  CellStyleModule,
  DragAndDropModule,
  // enterprise
  RowGroupingModule,
  RowGroupingPanelModule,
  AggregationModule,
  PivotModule,
  SetFilterModule,
  SideBarModule,
  ColumnsToolPanelModule,
  FiltersToolPanelModule,
  ColumnMenuModule,
  CellSelectionModule,
]);

const theme = themeQuartz
  .withPart(colorSchemeDark)
  .withParams({ rowHeight: 42, headerHeight: 40, accentColor: "#3b82f6" });

// ---------------------------------------------------------------------------
// Denormalize the compact wire blob -> flat rows AG Grid consumes.
// Date/weekday/time are computed here as VALUES (not via a cell renderer)
// because grouping, set filters and the pivot column all operate on the row's
// *value*, not on rendered markup — a renderer only changes what you see.
// ---------------------------------------------------------------------------
const fmtDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
});
const fmtTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false,
});
function dateParts(ms) {
  const p = Object.fromEntries(fmtDate.formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, time: fmtTime.format(ms) };
}

function expand(blob) {
  const { venues, genres, movies, access } = blob;
  const has = (arr, key) => Array.isArray(arr) && arr.includes(access[key]);
  const rows = [];
  for (const m of movies) {
    const genreNames = m.genres.map((id) => genres[id]).filter(Boolean);
    const primaryGenre = genreNames[0] || "—";
    for (const p of m.perf) {
      const v = venues[p.v] || {};
      const { date, weekday, time } = dateParts(p.t);
      rows.push({
        performanceId: `${p.v}@${p.t}`,
        movieId: m.id, title: m.title, year: m.year, classification: m.cert,
        durationMins: m.dur, poster: m.poster, director: m.dir,
        genre: primaryGenre, genres: genreNames,
        category: p.cat || "movie",
        venueId: p.v, venue: v.n, venueType: v.t,
        date, weekday, time, timestamp: p.t,
        screen: p.sc || null, notes: p.no || null, bookingUrl: p.b || null,
        soldOut: !!p.so,
        dimension: p.dim || null, presentation: p.pr || null, source: p.src || null,
        audioDescription: has(p.a, "audioDescription"),
        subtitled: has(p.a, "subtitled"),
        hardOfHearing: has(p.a, "hardOfHearing"),
        babyFriendly: has(p.a, "babyFriendly"),
        relaxed: has(p.a, "relaxed"),
      });
    }
  }
  return rows;
}

const posterRenderer = (p) =>
  p.value ? `<img class="poster" src="https://image.tmdb.org/t/p/w92${p.value}" alt="" loading="lazy">` : "";
const bookRenderer = (p) =>
  p.value ? `<a class="book" href="${p.value}" target="_blank" rel="noopener">Book ↗</a>` : "";
const yesNo = (p) => (p.value ? "✓" : "");

function columnDefs(view) {
  const grouped = view === "grouped";
  const pivot = view === "pivot";
  return [
    { field: "poster", headerName: "", width: 60, cellRenderer: posterRenderer,
      sortable: false, filter: false, hide: pivot },
    { field: "title", headerName: "Movie", minWidth: 240,
      rowGroup: grouped, hide: grouped || pivot, filter: "agTextColumnFilter" },
    { field: "venue", minWidth: 200, rowGroup: grouped || pivot,
      hide: grouped || pivot, filter: "agSetColumnFilter" },
    { field: "date", headerName: "Date", width: 130, pivot: pivot, hide: pivot,
      filter: "agSetColumnFilter", sort: grouped ? null : "asc" },
    { field: "weekday", headerName: "Day", width: 90, filter: "agSetColumnFilter", hide: pivot },
    { field: "time", width: 90, filter: "agSetColumnFilter", hide: pivot },
    { field: "performanceId", headerName: "Showings", aggFunc: "count",
      hide: !grouped && !pivot, filter: false, cellClass: "ag-right-aligned-cell", width: 110 },
    { field: "genre", headerName: "Genre", filter: "agSetColumnFilter", hide: pivot,
      enableRowGroup: true, enablePivot: true },
    { field: "genres", headerName: "All genres", hide: true,
      valueFormatter: (p) => (p.value || []).join(", ") },
    { field: "category", filter: "agSetColumnFilter", width: 110, hide: pivot,
      enableRowGroup: true, enablePivot: true },
    { field: "classification", headerName: "Cert", width: 90, filter: "agSetColumnFilter", hide: pivot },
    { field: "venueType", headerName: "Venue type", filter: "agSetColumnFilter",
      hide: true, enableRowGroup: true, enablePivot: true },
    { field: "dimension", headerName: "2D/3D", width: 90, filter: "agSetColumnFilter",
      hide: pivot, enablePivot: true },
    { field: "presentation", headerName: "Presentation", filter: "agSetColumnFilter",
      hide: pivot, enablePivot: true },
    { field: "source", headerName: "Film source", filter: "agSetColumnFilter", hide: pivot },
    { field: "audioDescription", headerName: "Audio desc.", width: 110,
      cellRenderer: yesNo, filter: "agSetColumnFilter", hide: pivot },
    { field: "subtitled", width: 100, cellRenderer: yesNo, filter: "agSetColumnFilter", hide: pivot },
    { field: "hardOfHearing", headerName: "HoH", width: 90, cellRenderer: yesNo,
      filter: "agSetColumnFilter", hide: pivot },
    { field: "babyFriendly", headerName: "Baby-friendly", width: 120, cellRenderer: yesNo,
      filter: "agSetColumnFilter", hide: pivot },
    { field: "relaxed", width: 100, cellRenderer: yesNo, filter: "agSetColumnFilter", hide: pivot },
    { field: "durationMins", headerName: "Runtime", width: 110, filter: "agNumberColumnFilter",
      hide: pivot, valueFormatter: (p) => (p.value ? `${p.value} min` : "") },
    { field: "year", width: 90, filter: "agNumberColumnFilter", hide: pivot },
    { field: "director", filter: "agSetColumnFilter", hide: true },
    { field: "screen", hide: true },
    { field: "notes", minWidth: 220, hide: true },
    { field: "bookingUrl", headerName: "Book", cellRenderer: bookRenderer,
      sortable: false, filter: false, width: 90, hide: pivot },
  ];
}

const gridOptions = {
  theme,
  rowData: [],
  columnDefs: columnDefs("grouped"),
  defaultColDef: { sortable: true, resizable: true, filter: true, floatingFilter: true },
  autoGroupColumnDef: { headerName: "Movie ▸ Venue", minWidth: 320, pinned: "left" },
  groupDefaultExpanded: 0,
  rowGroupPanelShow: "always",
  pivotPanelShow: "always",
  sideBar: { toolPanels: ["columns", "filters"] },
  pivotMode: false,
  cellSelection: true,
};

const api = createGrid(document.querySelector("#grid"), gridOptions);

function applyView(view) {
  api.setGridOption("pivotMode", view === "pivot");
  api.setGridOption("columnDefs", columnDefs(view));
  document.querySelectorAll(".views button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view)
  );
}
document.querySelectorAll(".views button").forEach((btn) =>
  btn.addEventListener("click", () => applyView(btn.dataset.view))
);

const initialView = new URLSearchParams(location.search).get("view");
if (initialView) applyView(initialView);

fetch("/data/cinemadata.json")
  .then((r) => r.json())
  .then((blob) => {
    const t0 = performance.now();
    const rows = expand(blob);
    api.setGridOption("rowData", rows);
    const venues = new Set(rows.map((r) => r.venue));
    const movies = new Set(rows.map((r) => r.movieId));
    document.getElementById("meta").textContent =
      `${rows.length.toLocaleString()} performances · ${movies.size.toLocaleString()} movies · ${venues.size} venues · expanded in ${Math.round(performance.now() - t0)}ms`;
  });
