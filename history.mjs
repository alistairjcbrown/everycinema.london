// Historical performance counts, sliced into windows bounded by consecutive
// Clusterflick release dates.
//
// Each Clusterflick release is a snapshot of *future* performances at the moment
// it was generated. Performances get added, rescheduled and cancelled between
// releases, so no single release is a reliable record of what actually ran once a
// later release has superseded it. We therefore partition history into windows,
// each populated from exactly one release:
//
//   release A (published at A) -> performances with showtime in [A, B)
//   release B (published at B) -> performances with showtime in [B, C)
//   ...
//   latest release            -> showtime >= its publish date, PROVISIONAL
//
// A window is a pure function of one release's data and two publish dates, so
// there is no cross-release identity matching, no deduplication and no mutable
// state. Cancelled performances fall out for free: if a performance was dropped
// before its window's release was cut, it is simply absent and never counted.
//
// The stages are kept separate so each is independently resumable, and so that
// window building is pure local computation with no network involved:
//
//   node history.mjs index      refresh the cached release index
//   node history.mjs fetch      download release assets that still need a window
//   node history.mjs windows    turn cached assets into finalized window files
//   node history.mjs update     fetch + windows for the tail (runs in CI)
//   node history.mjs build      emit public/data/history.json for the site
//
// Backfilling this year pulls ~8.8GB of assets, so `fetch` takes --since/--to to
// work through it in chunks and `windows` prunes each asset once its window is
// written. Chunk with, for example:
//
//   node history.mjs fetch --since 2026-01-01 --to 2026-02-01 && node history.mjs windows

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  createWriteStream,
} from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_DIR = join(__dirname, "data-history");
const INDEX_FILE = join(HISTORY_DIR, "index.json");
const WINDOWS_DIR = join(HISTORY_DIR, "windows");
const RELEASES_DIR = join(__dirname, "data-releases");
const COMBINED = join(__dirname, "data-combined", "combined-data.json");
const OUT_FILE = join(__dirname, "public", "data", "history.json");

const REPO = "clusterflick/data-combined";
const ASSET_NAME = "combined-data.json";
// history starts at the beginning of the current year
const DEFAULT_FROM = `${new Date().getUTCFullYear()}-01-01T00:00:00Z`;

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

// --- release index ---------------------------------------------------------
// Releases are only ever appended at the newest end, so a refresh pages back
// from the newest until it overlaps what we already have.

const ghHeaders = () => {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "everycinema.london",
  };
  if (process.env.GITHUB_TOKEN)
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
};

async function withRetry(label, work, attempts = 5) {
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

const fetchJson = (url) =>
  withRetry(url, async () => {
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  });

function readIndex() {
  if (!existsSync(INDEX_FILE))
    throw new Error(`No ${INDEX_FILE}; run "node history.mjs index" first.`);
  return JSON.parse(readFileSync(INDEX_FILE, "utf8"));
}

// Note: every release carries the same `created_at` (an artefact of how the tags
// are cut), so `published_at` is the only usable ordering key.
function toEntry(release) {
  const asset = (release.assets || []).find((a) => a.name === ASSET_NAME);
  if (!asset) return null;
  return {
    id: release.id,
    tag: release.tag_name,
    publishedAt: release.published_at,
    url: asset.browser_download_url,
    size: asset.size,
  };
}

async function refreshIndex() {
  const from = flag("from", DEFAULT_FROM);
  const existing = existsSync(INDEX_FILE) ? readIndex().releases : [];
  const known = new Map(existing.map((r) => [r.id, r]));
  const newestKnown = existing.at(-1)?.publishedAt ?? null;

  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`;
    const batch = await fetchJson(url);
    if (!batch.length) break;

    for (const release of batch) {
      if (release.draft || release.prerelease) continue;
      if (release.published_at < from) continue;
      const entry = toEntry(release);
      if (entry) known.set(entry.id, entry);
    }

    const oldestOnPage = batch.at(-1).published_at;
    // stop once we have paged past what we already knew, or past the start date
    if (newestKnown && oldestOnPage <= newestKnown) break;
    if (oldestOnPage < from) break;
  }

  const releases = [...known.values()]
    .filter((r) => r.publishedAt >= from)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

  mkdirSync(HISTORY_DIR, { recursive: true });
  // no generated-at timestamp: the index is committed, and a field that changes
  // on every run would produce a commit even when no releases were added
  writeFileSync(INDEX_FILE, `${JSON.stringify({ from, releases }, null, 2)}\n`);
  const added = releases.length - existing.length;
  console.log(
    `Index: ${releases.length} releases from ${releases[0]?.publishedAt} to ${releases.at(-1)?.publishedAt}` +
      (added > 0 ? ` (+${added} new)` : "")
  );
  return releases;
}

// --- pending windows -------------------------------------------------------

const windowPath = (release) =>
  join(WINDOWS_DIR, release.publishedAt.slice(0, 7), `${release.tag}.json`);
const assetPath = (release) => join(RELEASES_DIR, `${release.tag}.json`);

// Every release except the newest closes a window, bounded by the release that
// follows it. The newest is left open and served provisionally from the site
// build's own copy of the latest data.
function pendingWindows(releases) {
  const since = flag("since", null);
  const until = flag("to", null);
  const pending = [];
  for (let i = 0; i < releases.length - 1; i++) {
    const release = releases[i];
    if (since && release.publishedAt < since) continue;
    if (until && release.publishedAt >= until) break;
    if (existsSync(windowPath(release))) continue;
    pending.push([release, releases[i + 1]]);
  }
  return pending;
}

// --- fetch -----------------------------------------------------------------

async function runPool(items, limit, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) await worker(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

// Streamed with Range-request resume: on a slow link a 19MB asset takes minutes,
// and restarting from zero after a dropped connection is painful. The index
// already knows each asset's exact size, so we can also verify what we got.
async function downloadAsset(release, onProgress = () => {}) {
  const path = assetPath(release);
  if (existsSync(path)) return false;
  const tmp = `${path}.part`;

  await withRetry(`download ${release.tag}`, async () => {
    let have = existsSync(tmp) ? statSync(tmp).size : 0;
    if (have >= release.size) {
      rmSync(tmp, { force: true });
      have = 0;
    }
    const headers = ghHeaders();
    if (have) headers.Range = `bytes=${have}-`;

    const res = await fetch(release.url, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    // a server that ignores Range answers 200 with the whole body: start over
    const resuming = have > 0 && res.status === 206;
    if (have && !resuming) {
      onProgress(-have);
      have = 0;
    }

    const out = createWriteStream(tmp, { flags: resuming ? "a" : "w" });
    try {
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await once(out, "drain");
        have += chunk.length;
        onProgress(chunk.length);
      }
    } finally {
      out.close();
      await once(out, "close");
    }

    const size = statSync(tmp).size;
    if (size !== release.size)
      throw new Error(`expected ${release.size} bytes, got ${size}`);
  });

  renameSync(tmp, path);
  return true;
}

const formatBytes = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  const units = [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ];
  const parts = [];
  for (const [label, size] of units) {
    if (seconds >= size) {
      parts.push(`${Math.floor(seconds / size)}${label}`);
      seconds %= size;
    }
  }
  if (parts.length < 2) parts.push(`${Math.round(seconds)}s`);
  return parts.slice(0, 2).join(" ");
}

// A slow link needs to see movement within a single file, not just per file, so
// progress is reported on bytes. Interactive runs rewrite one line; non-TTY runs
// (CI, piped logs) print occasionally so as not to produce thousands of lines.
function startProgress(total) {
  const startedAt = Date.now();
  let bytes = 0;
  let files = 0;
  const tty = process.stdout.isTTY;
  const render = () => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = bytes / Math.max(elapsed, 0.001);
    const eta = rate > 0 ? (total - bytes) / rate : Infinity;
    const line =
      `  ${((bytes / total) * 100).toFixed(1)}% · ${formatBytes(bytes)}/${formatBytes(total)} · ` +
      `${(rate / 1000).toFixed(0)} KB/s · ${files} files · ETA ${formatDuration(eta)}`;
    if (tty) process.stdout.write(`\r${line.padEnd(90)}`);
    else console.log(line);
  };
  const timer = setInterval(render, tty ? 1000 : 30000);
  timer.unref();
  if (!tty) render(); // confirm liveness immediately rather than after 30s
  return {
    add: (n) => {
      bytes += n;
    },
    file: () => {
      files++;
    },
    done: () => {
      clearInterval(timer);
      render();
      if (tty) process.stdout.write("\n");
    },
  };
}

async function fetchAssets({ refresh = !has("no-index"), only = null } = {}) {
  const releases = refresh ? await refreshIndex() : readIndex().releases;
  const wanted = only ?? pendingWindows(releases).map(([release]) => release);
  const missing = wanted.filter((release) => !existsSync(assetPath(release)));

  if (!missing.length) {
    console.log("Every pending window already has its release asset.");
    return releases;
  }

  mkdirSync(RELEASES_DIR, { recursive: true });
  // bytes already sitting in a .part file are never re-downloaded, so they must
  // come off the total or the ETA is computed against an unreachable target
  let total = 0;
  for (const release of missing) {
    const tmp = `${assetPath(release)}.part`;
    const have = existsSync(tmp) ? statSync(tmp).size : 0;
    if (have) console.log(`  resuming ${release.tag} at ${formatBytes(have)}`);
    total += Math.max(release.size - have, 0);
  }
  console.log(
    `Fetching ${missing.length} release assets (${formatBytes(total)} to download) ` +
      `covering ${missing[0].publishedAt} to ${missing.at(-1).publishedAt}.`
  );

  const progress = startProgress(total);
  let done = 0;
  await runPool(missing, Number(flag("concurrency", 4)), async (release) => {
    await downloadAsset(release, progress.add);
    progress.file();
    done++;
    if (process.stdout.isTTY) process.stdout.write("\r".padEnd(91) + "\r");
    console.log(
      `  [${done}/${missing.length}] ${release.tag} (${formatBytes(release.size)})`
    );
  });
  progress.done();
  console.log(`Fetched ${done} assets — run "npm run history:windows" next.`);
  return releases;
}

// --- aggregation -----------------------------------------------------------

// Buckets are whole London-local hours. Window boundaries are arbitrary publish
// instants, so a boundary usually falls mid-bucket (only 7 of 454 releases this
// year landed on :00) — the bucket is then split, with each side counted from
// its own window's release. Slicing on raw performance times rather than on
// bucket keys is what makes that split exact.
const hourFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

const bucketCache = new Map();
function hourBucket(ms) {
  // London is always a whole-hour offset, so flooring in UTC is safe
  const hour = Math.floor(ms / 3600000);
  const cached = bucketCache.get(hour);
  if (cached) return cached;
  const parts = Object.fromEntries(
    hourFormat.formatToParts(new Date(hour * 3600000)).map((p) => [p.type, p.value])
  );
  const bucket = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
  bucketCache.set(hour, bucket);
  return bucket;
}

const sortKeys = (obj) =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

const maxDate = (a, b) => (b !== null && b > a ? b : a);

// Slice one release's performances to [start, end) and count them per movie per
// hour. `end` of null leaves the window open (the provisional case).
function aggregate(data, start, end) {
  const from = Date.parse(start);
  const to = end === null ? Infinity : Date.parse(end);
  const movies = {};
  let performances = 0;
  let skippedNoVenue = 0;

  for (const movie of Object.values(data.movies)) {
    let hours = null;
    for (const perf of movie.performances || []) {
      if (perf.time < from || perf.time >= to) continue;
      // same venue-resolution rule as transform.mjs: a performance we cannot tie
      // to a known venue is not a screening we can account for
      const venueId = movie.showings?.[perf.showingId]?.venueId;
      if (!venueId || !data.venues[venueId]) {
        skippedNoVenue++;
        continue;
      }
      if (hours === null) hours = {};
      const bucket = hourBucket(perf.time);
      hours[bucket] = (hours[bucket] || 0) + 1;
      performances++;
    }
    if (hours === null) continue;
    // each window carries its own titles so it stays self-contained: films drop
    // out of later releases, and we never want to rewrite a finalized window
    movies[movie.id] = {
      t: movie.title,
      y: Number(movie.year) || Number((movie.releaseDate || "").slice(0, 4)) || null,
      h: sortKeys(hours),
    };
  }

  return { movies: sortKeys(movies), performances, skippedNoVenue };
}

// --- windows ---------------------------------------------------------------

function buildWindows({ only = null } = {}) {
  const pending = only ?? pendingWindows(readIndex().releases);
  if (!pending.length) {
    console.log("No pending windows; every closed window is already written.");
    return;
  }

  mkdirSync(WINDOWS_DIR, { recursive: true });
  let written = 0;
  let missing = 0;
  let performances = 0;
  let skipped = 0;

  for (const [release, next] of pending) {
    const path = assetPath(release);
    if (!existsSync(path)) {
      missing++;
      continue;
    }
    const data = JSON.parse(readFileSync(path, "utf8"));
    const result = aggregate(data, release.publishedAt, next.publishedAt);
    const out = windowPath(release);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      `${JSON.stringify({
        releaseId: release.id,
        releaseTag: release.tag,
        start: release.publishedAt,
        end: next.publishedAt,
        generatedAt: data.generatedAt,
        performances: result.performances,
        movies: result.movies,
      })}\n`
    );
    written++;
    performances += result.performances;
    skipped += result.skippedNoVenue;
    // the window is the durable artefact; the 19MB asset it came from is not
    if (!has("keep")) rmSync(path, { force: true });
  }

  console.log(
    `Wrote ${written} windows (${performances.toLocaleString()} performances).`
  );
  if (skipped)
    console.log(`Skipped ${skipped.toLocaleString()} performances with no resolvable venue.`);
  if (missing)
    console.log(`${missing} pending windows still need their release asset — run "npm run history:fetch".`);
}

// --- update ----------------------------------------------------------------

async function update() {
  const releases = await refreshIndex();
  const pending = pendingWindows(releases);
  if (!pending.length) {
    console.log("No newly-closed windows; provisional window only.");
    return;
  }
  // An incremental run should only see the handful of releases published since
  // the last one. If history has not been backfilled there may be hundreds, and
  // pulling 8.8GB is not this command's job — take the most recent few and leave
  // the rest for a backfill. Windows are independent, so a gap is not corrupting.
  const limit = Number(flag("limit", 10));
  const take = pending.slice(-limit);
  if (pending.length > take.length)
    console.warn(
      `${pending.length} windows are unwritten; updating the most recent ${take.length}. ` +
        `Backfill the rest with "npm run history:fetch" + "npm run history:windows".`
    );
  await fetchAssets({ refresh: false, only: take.map(([r]) => r) });
  buildWindows({ only: take });
}

// --- build -----------------------------------------------------------------

// Merge every finalized window plus a provisional window derived from the latest
// release, which the site build has already downloaded to data-combined/.
function build() {
  const index = readIndex();
  const counts = {};
  const titles = {};
  let windows = 0;
  let start = null;
  let end = null;

  const months = existsSync(WINDOWS_DIR) ? readdirSync(WINDOWS_DIR).sort() : [];
  for (const month of months) {
    for (const file of readdirSync(join(WINDOWS_DIR, month)).sort()) {
      const win = JSON.parse(readFileSync(join(WINDOWS_DIR, month, file), "utf8"));
      windows++;
      start = start === null || win.start < start ? win.start : start;
      end = end === null || win.end > end ? win.end : end;
      for (const [id, movie] of Object.entries(win.movies)) {
        titles[id] = { t: movie.t, y: movie.y };
        const into = (counts[id] ||= {});
        for (const [hour, n] of Object.entries(movie.h))
          into[hour] = (into[hour] || 0) + n;
      }
    }
  }

  let provisional = null;
  if (existsSync(COMBINED)) {
    const data = JSON.parse(readFileSync(COMBINED, "utf8"));
    // A release is always published after its data was generated, so the release
    // this blob came from is the earliest one published at or after generatedAt.
    // Deriving it from the data rather than assuming the newest release keeps the
    // provisional window honest when the local copy is stale.
    const owner = index.releases.find((r) => r.publishedAt >= data.generatedAt);
    const latest = index.releases.at(-1);
    if (!owner)
      console.warn(
        `Warning: ${COMBINED} is newer than every indexed release; ` +
          `re-run "node history.mjs index".`
      );
    else if (owner !== latest)
      console.warn(
        `Warning: ${COMBINED} is release ${owner.tag}, not the latest (${latest.tag}); ` +
          `re-run scripts/get-latest-combined-data.sh for an up-to-date provisional window.`
      );
    // The provisional window opens at that release's publish date and is
    // unbounded: everything currently scheduled from that point on. Clamping to
    // the last finalized end makes overlap impossible — a no-op in steady state,
    // where the latest release is precisely the one with no window yet.
    const from = maxDate(owner?.publishedAt ?? data.generatedAt, end);
    const { movies, performances } = aggregate(data, from, null);
    for (const [id, movie] of Object.entries(movies))
      titles[id] ||= { t: movie.t, y: movie.y };
    provisional = {
      start: from,
      releaseTag: owner?.tag ?? null,
      generatedAt: data.generatedAt,
      performances,
      counts: Object.fromEntries(
        Object.entries(movies).map(([id, movie]) => [id, movie.h])
      ),
    };
  } else {
    console.warn(
      `No ${COMBINED}; emitting finalized history only (run scripts/get-latest-combined-data.sh).`
    );
  }

  const blob = {
    generatedAt: new Date().toISOString(),
    timezone: "Europe/London",
    finalized: { start, end, windows, counts },
    provisional,
    movies: sortKeys(titles),
  };

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(blob));

  const rows = Object.values(counts).reduce((n, h) => n + Object.keys(h).length, 0);
  const bytes = readFileSync(OUT_FILE).length;
  console.log(
    `Wrote ${windows} finalized windows (${rows.toLocaleString()} movie-hour rows, ` +
      `${Object.keys(titles).length.toLocaleString()} movies) -> ${OUT_FILE} ` +
      `(${(bytes / 1e6).toFixed(1)} MB)`
  );
  if (provisional)
    console.log(
      `Provisional window from ${provisional.start}: ${provisional.performances.toLocaleString()} performances.`
    );
}

// --- cli -------------------------------------------------------------------

const commands = {
  index: refreshIndex,
  fetch: fetchAssets,
  windows: buildWindows,
  update,
  build,
};
if (!commands[command]) {
  console.error(
    "Usage: node history.mjs <index|fetch|windows|update|build>\n" +
      "  --from ISO        history start date (default: 1 Jan this year)\n" +
      "  --since/--to ISO  limit which windows this run covers\n" +
      "  --concurrency N   parallel downloads (default 4)\n" +
      "  --keep            keep release assets after building their windows"
  );
  process.exit(1);
}
await commands[command]();
