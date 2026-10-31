import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  // Svelte's browser build, so components mount in jsdom.
  resolve: { conditions: ["browser"] },
  test: {
    environment: "jsdom",
    include: ["src/routes/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
