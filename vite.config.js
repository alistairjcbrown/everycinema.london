import { defineConfig } from "vite";

// Stamp each page with the time it was built, so the footer can show how fresh
// the deployed data is. Captured once per Vite process rather than per page, so
// every page in a build reports the same instant. Shown in London time (the
// site is a London listings site) with the zone abbreviation spelled out, since
// a bare time is ambiguous across BST/GMT.
const builtAt = new Date();
const buildStamp = () => ({
  name: "build-stamp",
  transformIndexHtml(html) {
    return html
      .replaceAll("%BUILD_TIME_ISO%", builtAt.toISOString())
      .replaceAll(
        "%BUILD_TIME%",
        // spelled out as components rather than dateStyle/timeStyle, which
        // Intl refuses to combine with timeZoneName
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/London",
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZoneName: "short",
        }).format(builtAt),
      );
  },
});

// Multi-page build: the app (index.html), the performance-history charts
// (history.html) and the standalone attributions page. Separate entries keep
// AG Charts out of the main grid bundle.
export default defineConfig({
  plugins: [buildStamp()],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        history: "history.html",
        attributions: "attributions.html",
      },
    },
  },
});
