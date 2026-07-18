// Build a COMPACT mapping blob for the wire, NOT a denormalized fact table.
//
// The old approach shipped one fat row per performance (~25 MB) with the movie
// title, genres, poster, venue name etc. repeated on every one of the ~31k rows.
// Instead we ship:
//   - lookups (venues, genres) once
//   - movie-level fields once per movie
//   - performances as minimal records that reference venue/genre by id and omit
//     empty fields
// The browser (src/main.js) expands this back into the flat rows AG Grid needs.
// That keeps the wire payload small and the data DRY; the denormalization cost
// is a few ms on load. We also drop everything the grid doesn't use (people map,
// themoviedb, actors, overview prose, ...).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE =
  process.env.SOURCE || join(__dirname, "data-combined", "combined-data.json");
const OUT_DIR = join(__dirname, "public", "data");
const OUT_FILE = join(OUT_DIR, "cinemadata.json");

// accessibility keys -> short codes carried in each performance's `a` array
const ACCESS = {
  audioDescription: "ad",
  subtitled: "st",
  hardOfHearing: "hoh",
  babyFriendly: "bf",
  relaxed: "rx",
};

console.log(`Reading ${SOURCE} ...`);
const data = JSON.parse(readFileSync(SOURCE, "utf8"));

// only keep venues that actually have showings
const usedVenues = new Set();
const genresOut = {};
for (const [id, g] of Object.entries(data.genres)) genresOut[id] = g.name;

const movies = [];
let skippedNoVenue = 0;

for (const movie of Object.values(data.movies)) {
  const perf = [];
  for (const p of movie.performances || []) {
    const showing = movie.showings?.[p.showingId];
    const venueId = showing?.venueId;
    if (!venueId || !data.venues[venueId]) {
      skippedNoVenue++;
      continue;
    }
    usedVenues.add(venueId);

    const rec = { t: p.time, v: venueId };
    if (showing.category && showing.category !== "movie") rec.cat = showing.category;
    if (p.screen) rec.sc = p.screen;
    if (p.notes) rec.no = p.notes;
    if (p.bookingUrl) rec.b = p.bookingUrl;
    if (p.status?.soldOut) rec.so = 1;
    const fmt = p.format || {};
    if (fmt.dimension) rec.dim = fmt.dimension;
    if (fmt.presentation) rec.pr = fmt.presentation;
    if (fmt.source) rec.src = fmt.source;
    const acc = p.accessibility || {};
    const flags = Object.entries(ACCESS)
      .filter(([k]) => acc[k])
      .map(([, code]) => code);
    if (flags.length) rec.a = flags;
    perf.push(rec);
  }
  if (!perf.length) continue;

  const director = (movie.directors || [])
    .map((id) => data.people[id]?.name)
    .find(Boolean);

  movies.push({
    id: movie.id,
    title: movie.title,
    year: movie.year || (movie.releaseDate || "").slice(0, 4) || null,
    cert: movie.classification || null,
    dur: movie.duration ? Math.round(movie.duration / 60000) : null,
    poster: movie.posterPath || null,
    dir: director || null,
    genres: (movie.genres || []).filter((id) => genresOut[id]),
    perf,
  });
}

const venuesOut = {};
for (const id of usedVenues) {
  const v = data.venues[id];
  venuesOut[id] = { n: v.name, t: v.type || null };
}

const blob = {
  generatedAt: data.generatedAt,
  access: ACCESS, // so the browser knows the code->meaning mapping
  genres: genresOut,
  venues: venuesOut,
  movies,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(blob));

const perfCount = movies.reduce((n, m) => n + m.perf.length, 0);
const bytes = readFileSync(OUT_FILE).length;
console.log(
  `Wrote ${movies.length.toLocaleString()} movies / ${perfCount.toLocaleString()} performances / ${
    Object.keys(venuesOut).length
  } venues -> ${OUT_FILE} (${(bytes / 1e6).toFixed(1)} MB)`
);
if (skippedNoVenue) console.log(`Skipped ${skippedNoVenue} performances with no resolvable venue.`);
