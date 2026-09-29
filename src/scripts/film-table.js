// The film picker behind "Screenings per day, by film": a plain table in place
// of the AG Grid Enterprise grid it replaces, which was 243 KB of JavaScript
// for one list.
//
// It keeps what the grid was used for. Search by title; sort by any column;
// tick films to chart their runs. Selections survive searching, so you can
// search, tick, search again and compare films that never appear in the same
// result — the grid allowed that and the run chart's whole use depends on it.
//
// Thousands of films is too many rows to put in the DOM at once and nobody
// scrolls that far, so only the first LIMIT matches are rendered and the
// footer says how many more there are.

const LIMIT = 300;

const escape = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// `numeric` columns sort biggest-first on the first click; a null is "no value"
// and goes to the bottom in either direction, as the grid's comparator did for
// the Week 2 column.
const COLUMNS = [
  { key: "title", label: "Film", numeric: false },
  { key: "year", label: "Year", numeric: true },
  { key: "screenings", label: "Screenings", numeric: true },
  { key: "days", label: "Days", numeric: true },
  { key: "opening", label: "Opening", numeric: true },
  {
    key: "retained",
    label: "Week 2",
    numeric: true,
    title:
      "The film's second week as a share of its first. Over 100% means it widened after opening rather than starting to fade.",
  },
];

export function createFilmTable(container, films, { onSelectionChange, formatInt, formatDate }) {
  const selected = new Map(); // id -> film, in the order they were ticked
  let query = "";
  let sort = { key: "screenings", dir: -1 };

  container.innerHTML = `
    <div class="film-toolbar">
      <input class="search" type="search" placeholder="Find a film" aria-label="Find a film" autocomplete="off" />
      <button class="button clear" type="button" disabled>Clear selection</button>
      <span class="film-count"></span>
    </div>
    <div class="table-wrap film-scroll">
      <table class="data">
        <thead><tr>
          <th scope="col"><span class="visually-hidden">Compare</span></th>
          ${COLUMNS.map(
            (c) =>
              `<th scope="col" data-key="${c.key}"${c.numeric ? ' class="num"' : ""}${c.title ? ` title="${escape(c.title)}"` : ""}><button class="sort" type="button">${c.label}</button></th>`,
          ).join("")}
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <p class="film-more hint"></p>`;

  const search = container.querySelector(".search");
  const clear = container.querySelector(".clear");
  const count = container.querySelector(".film-count");
  const more = container.querySelector(".film-more");
  const head = container.querySelector("thead tr");
  const body = container.querySelector("tbody");
  const byId = new Map(films.map((f) => [f.id, f]));

  const value = (film, key) => (key === "opening" ? film.opening?.getTime() ?? null : film[key]);

  function render() {
    const needle = query.trim().toLowerCase();
    const matches = needle ? films.filter((f) => f.title.toLowerCase().includes(needle)) : films.slice();
    const { key, dir } = sort;
    matches.sort((a, b) => {
      const va = value(a, key);
      const vb = value(b, key);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return dir * (typeof va === "string" ? va.localeCompare(vb, "en-GB") : va - vb);
    });
    const shown = matches.slice(0, LIMIT);
    body.innerHTML = shown
      .map(
        (f) => `<tr data-id="${escape(f.id)}">
          <td><input type="checkbox" aria-label="Compare ${escape(f.title)}"${selected.has(f.id) ? " checked" : ""} /></td>
          <td class="wrap">${escape(f.title)}</td>
          <td class="num dim">${f.year ?? "—"}</td>
          <td class="num">${formatInt(f.screenings)}</td>
          <td class="num">${formatInt(f.days)}</td>
          <td class="num">${f.opening ? formatDate(f.opening) : "—"}</td>
          <td class="num">${f.retained === null ? '<span class="dim">—</span>' : `${f.retained.toFixed(0)}%`}</td>
        </tr>`,
      )
      .join("");
    for (const th of head.cells) {
      if (!th.dataset.key) continue;
      if (th.dataset.key === key) th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    }
    count.textContent = needle
      ? `${formatInt(matches.length)} of ${formatInt(films.length)} films`
      : `${formatInt(films.length)} films`;
    more.textContent =
      matches.length > LIMIT
        ? `Showing the first ${formatInt(LIMIT)} of ${formatInt(matches.length)} — search to narrow.`
        : "";
    updateClear();
  }

  function updateClear() {
    clear.disabled = selected.size === 0;
    clear.textContent = selected.size ? `Clear selection (${selected.size})` : "Clear selection";
  }

  let timer;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      query = search.value;
      render();
    }, 120);
  });

  head.addEventListener("click", (event) => {
    const th = event.target.closest("th[data-key]");
    if (!th) return;
    const column = COLUMNS.find((c) => c.key === th.dataset.key);
    sort =
      sort.key === column.key
        ? { key: column.key, dir: -sort.dir }
        : { key: column.key, dir: column.numeric ? -1 : 1 };
    render();
  });

  body.addEventListener("change", (event) => {
    const box = event.target;
    if (box.type !== "checkbox") return;
    const id = box.closest("tr").dataset.id;
    if (box.checked) selected.set(id, byId.get(id));
    else selected.delete(id);
    // not a re-render: that would take focus off the box just ticked
    updateClear();
    onSelectionChange([...selected.values()]);
  });

  clear.addEventListener("click", () => {
    selected.clear();
    render();
    onSelectionChange([]);
  });

  render();
}
