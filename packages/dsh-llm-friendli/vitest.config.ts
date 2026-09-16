import { defineConfig } from "vitest/config";

// The repo root's vitest.config.ts is NOT loadable from inside this package
// (its `vitest/config` import resolves against this package's own
// node_modules, where the root vitest isn't installed). This package-local
// config keeps `pnpm run lint:all` self-contained when run from inside the
// package regardless of what exists above it.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
  },
});
