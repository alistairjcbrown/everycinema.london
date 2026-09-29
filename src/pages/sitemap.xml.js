// The sitemap, generated from the same venue index the venue pages are built
// from, so a venue added upstream is listed the day its page appears.
import { venueIndex } from "../lib/data.js";

export function GET({ site }) {
  const paths = ["/", "/london/", "/venues/", "/about/", ...venueIndex().venues.map((v) => `/venues/${v.id}/`)];
  const urls = paths.map((path) => `  <url><loc>${new URL(path, site)}</loc></url>`).join("\n");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    { headers: { "Content-Type": "application/xml" } },
  );
}
