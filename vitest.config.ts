import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Kept separate from vite.config.ts so tests do not load the React Router dev plugin.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["test/**/*.test.ts", "app/**/*.test.ts"],
    environment: "node",
  },
});
