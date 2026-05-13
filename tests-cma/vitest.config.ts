import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ["verbose"],
    sequence: { concurrent: false },
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
