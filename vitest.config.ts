import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The root suite owns test/ only. Each package under packages/ is
    // self-contained with its own toolchain (dsh runs vitest with its own
    // package-local config). Scoping by include — rather than excluding
    // packages — keeps the root run from collecting the dsh package's tests
    // against the root node_modules, where its pnpm-only devDeps don't
    // resolve.
    include: ["test/**/*.test.ts"],
  },
});
