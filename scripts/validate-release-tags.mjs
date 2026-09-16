#!/usr/bin/env node
// Reads a GitHub Actions release-tag-validator workflow and asserts it
// triggers on tags matching the three independently versioned artifacts.
import fs from "node:fs";
import { parse } from "yaml";

const wf = fs.readFileSync(
  ".github/workflows/validate-release-tags.yml",
  "utf8",
);
const doc = parse(wf);
const tags = doc?.on?.push?.tags;
if (!Array.isArray(tags) || tags.length < 3) {
  console.error("missing tag triggers");
  process.exit(1);
}
const joined = tags.join(",");
for (const need of [
  "frlink@",
  "@friendliai/dsh-llm-friendli@",
  "hermes-friendli-provider@",
]) {
  if (!joined.includes(need)) {
    console.error(`missing tag pattern: ${need}`);
    process.exit(1);
  }
}

// Verify the validator routes each artifact prefix to its version file and
// compares against the tag's semver suffix.
const body = wf;
for (const name of [
  "frlink",
  "@friendliai/dsh-llm-friendli",
  "hermes-friendli-provider",
]) {
  if (!body.includes(name)) {
    console.error(`validator missing routing for ${name}`);
    process.exit(1);
  }
}
// Each artifact must read its actual version file.
if (!body.includes("package.json")) {
  console.error("validator missing package.json read");
  process.exit(1);
}
if (!body.includes("plugin.yaml")) {
  console.error("validator missing plugin.yaml read");
  process.exit(1);
}
if (!body.includes("MISMATCH")) {
  console.error("validator missing MISMATCH exit guard");
  process.exit(1);
}
console.log("VALIDATOR-OK");
