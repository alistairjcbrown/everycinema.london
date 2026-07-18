import { defineConfig } from "vite";

// Multi-page build: the app (index.html) plus the standalone attributions page.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        attributions: "attributions.html",
      },
    },
  },
});
