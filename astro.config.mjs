import { defineConfig } from "astro/config";

// Static output to dist/, which is what the deploy workflow uploads to GitHub
// Pages. Every route is a directory with an index.html (/london/, /venues/<id>/),
// so links are written with a trailing slash and the dev server is told to
// expect one — otherwise dev and the deployed site disagree about which URLs
// exist.
//
// The pages read public/data/*.json at build time, so the data steps in the
// workflow (transform, history:build, health:build, diffs:build) have to run
// before `astro build`, exactly as they had to run before `vite build`.
export default defineConfig({
  site: "https://everycinema.london",
  trailingSlash: "always",
  build: { format: "directory" },
  // Astro's own dev toolbar sits over the bottom of every page, which is where
  // the footer and the notes under each chart live.
  devToolbar: { enabled: false },
});
