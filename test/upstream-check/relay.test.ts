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
    const child = spawn(process.execPath, [
      relay,
      "--port",
      "0",
      "--target",
      target,
      "--log",
      join(dir, "capture.jsonl"),
      "--quiet",
      ...flags,
    ]);
    try {
      // The banner carries the port the OS picked; exiting first is a failure.
      const port = await new Promise<string>((resolve, reject) => {
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          const bound = /localhost:(\d+)/.exec(stderr);
          if (bound) resolve(bound[1]);
        });
        child.once("exit", () => reject(new Error(stderr)));
      });
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
