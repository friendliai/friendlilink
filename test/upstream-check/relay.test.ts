import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const relay = fileURLToPath(
  new URL("../../scripts/friendli-relay.mjs", import.meta.url),
);

it.each([
  // [relay flags, upstream 429s before a 200, status the harness sees, upstream hits]
  [["--retry-429", "0"], 2, 200, 3],
  [["--retry-429", "0"], 9, 429, 4],
  [[], 2, 429, 1],
])(
  "relay %j over %i upstream 429s → %i after %i hits",
  async (flags, n429, want, wantHits) => {
    let hits = 0;
    const upstream = createServer((_, res) => {
      res.writeHead(++hits <= n429 ? 429 : 200).end("{}");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), "relay-"));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [
      relay,
      "--port",
      String(port),
      "--target",
      target,
      "--log",
      join(dir, "capture.jsonl"),
      "--quiet",
      ...flags,
    ]);
    try {
      await new Promise((r) => child.stderr.once("data", r));
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        body: "{}",
      });
      expect(res.status).toBe(want);
      expect(hits).toBe(wantHits);
    } finally {
      child.kill();
      upstream.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
