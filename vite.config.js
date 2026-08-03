import { defineConfig } from "vite";

// Multi-page build: the app (index.html), the performance-history charts
// (history.html) and the standalone attributions page. Separate entries keep
// AG Charts out of the main grid bundle.
export default defineConfig({
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
