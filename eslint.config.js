// @ts-check
import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  // packages/ own their toolchains — root eslint never lints them. This
  // also guards generated output (dsh's lib/) that js.configs.recommended
  // would otherwise reach, having no `files` restriction of its own.
  { ignores: ["dist/**", "node_modules/**", "packages/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
      },
      globals: globals.node,
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      // tsc already catches genuine undefined-variable errors; no-undef false-positives
      // on ambient TS-only globals like `NodeJS.ErrnoException`.
      "no-undef": "off",
    },
  },
  {
    // Developer tooling, not shipped: run with `npx tsx`/`node`, so it is
    // outside tsconfig's `src` include and gets no type checking, same as
    // `test/`. Lint it for the mistakes syntax alone can catch.
    files: ["scripts/**/*.{ts,mjs}"],
    languageOptions: {
      parser: tsParser,
      globals: { ...globals.node, ...globals.es2021 },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["test/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      globals: { ...globals.node, ...globals.es2021 },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
];
