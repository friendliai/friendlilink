#!/usr/bin/env node
/**
 * A logging reverse proxy in front of Friendli's Model APIs.
 *
 * Point a harness at this instead of `https://api.friendli.ai/serverless` and
 * every request and response is printed and appended to a JSONL file, then
 * forwarded upstream unchanged. Nothing is rewritten: the same bytes reach
 * Friendli, so what you read is what the harness actually sent.
 *
 * It exists for Cursor above all. Cursor does not call the OpenAI-compatible
 * endpoint from your machine — it sends `api_key` and `openai_api_base_url` to
 * its own backend inside `aiserver.v1.ModelDetails`, and that backend makes the
 * call. A proxy on localhost therefore never sees a chat request, and neither
 * does an HTTPS interceptor on your machine. Expose this relay with a tunnel
 * (see CONTRIBUTING.md) and Cursor's backend will call it.
 *
 *   node scripts/friendli-relay.mjs [--port 8787] [--log capture.jsonl]
 *                                  [--target https://api.friendli.ai/serverless]
 *                                  [--quiet] [--bodies <bytes>]
 *
 * The Authorization header is never printed or written to the log; the key's
 * SHA-256 prefix is, which is enough to tell two keys apart.
 */

import { createServer } from "node:http";
import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const DEFAULTS = {
  port: 8787,
  target: "https://api.friendli.ai/serverless",
  log: "friendli-capture.jsonl",
  bodies: 64 * 1024,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--port") options.port = Number(value());
    else if (flag === "--target") options.target = value().replace(/\/+$/, "");
    else if (flag === "--log") options.log = value();
    else if (flag === "--bodies") options.bodies = Number(value());
    else if (flag === "--quiet") options.quiet = true;
    else throw new Error(`unknown flag: ${flag}`);
  }
  return options;
}

/** Identify a key across requests without ever holding it. */
function keyFingerprint(authorization) {
  const token = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1];
  if (!token) return null;
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Hop-by-hop headers a proxy must not forward (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function forwardableHeaders(incoming) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value])
      headers.append(name, one);
  }
  return headers;
}

/** Headers as a plain object, with the credential replaced by its fingerprint. */
function loggableHeaders(incoming) {
  const out = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key") {
      out[lower] =
        `<redacted sha256:${keyFingerprint(String(value)) ?? "unparsed"}>`;
      continue;
    }
    out[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** JSON when it parses, the raw text when it does not, `null` when empty. */
function decodeBody(buffer, limit) {
  if (buffer.length === 0) return null;
  const text = buffer.subarray(0, limit).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return buffer.length > limit
      ? `${text}…<truncated ${buffer.length} bytes>`
      : text;
  }
}

/**
 * Collapse an SSE stream into something readable: every `data:` frame, plus
 * the text and reasoning they concatenate to. Both wire shapes are covered —
 * chat-completions `choices[].delta` and Responses `*.delta` events.
 */
function summarizeEventStream(text) {
  const frames = [];
  let content = "";
  let reasoning = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      frames.push(payload);
      continue;
    }
    frames.push(frame);
    const delta = frame.choices?.[0]?.delta;
    if (typeof delta?.content === "string") content += delta.content;
    if (typeof delta?.reasoning_content === "string")
      reasoning += delta.reasoning_content;
    if (
      frame.type === "response.output_text.delta" &&
      typeof frame.delta === "string"
    ) {
      content += frame.delta;
    }
    if (
      frame.type === "response.reasoning_text.delta" &&
      typeof frame.delta === "string"
    ) {
      reasoning += frame.delta;
    }
  }
  return {
    frameCount: frames.length,
    frames,
    ...(content ? { text: content } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

function decodeResponseBody(buffer, contentType, limit) {
  if (buffer.length === 0) return null;
  if ((contentType ?? "").includes("text/event-stream")) {
    return summarizeEventStream(buffer.toString("utf8"));
  }
  return decodeBody(buffer, limit);
}

/** One line per exchange, so a capture stays readable while it scrolls. */
function headline(entry) {
  const { request, response, durationMs } = entry;
  const model =
    typeof request.body?.model === "string" ? request.body.model : "-";
  const stream = request.body?.stream === true ? " stream" : "";
  return `${request.method} ${request.path} → ${response.status} ${durationMs}ms  model=${model}${stream}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let counter = 0;

  const server = createServer((request, response) => {
    void (async () => {
      const startedAt = Date.now();
      const id = ++counter;
      const requestBody = await readBody(request);
      let upstream;
      try {
        upstream = await fetch(`${options.target}${request.url}`, {
          method: request.method,
          headers: forwardableHeaders(request.headers),
          ...(requestBody.length > 0 ? { body: requestBody } : {}),
          redirect: "manual",
        });
      } catch (error) {
        // A relay that dies on an upstream hiccup loses the capture with it.
        response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: `relay could not reach ${options.target}: ${error}`,
          }),
        );
        console.error(
          `#${id} ${request.method} ${request.url} → upstream error: ${error}`,
        );
        return;
      }

      // Forward bytes as they arrive and keep a bounded copy for the log.
      // Buffering the whole body first would hold an SSE stream until
      // generation finished — the opposite of "forwards unchanged", and
      // long enough to trip an idle timeout on the very streaming requests
      // this relay exists to capture.
      const outgoing = {};
      for (const [name, value] of upstream.headers) {
        if (
          HOP_BY_HOP.has(name) ||
          name === "content-length" ||
          name === "content-encoding"
        ) {
          continue;
        }
        outgoing[name] = value;
      }
      response.writeHead(upstream.status, outgoing);

      const captured = [];
      let capturedBytes = 0;
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          const buf = Buffer.from(chunk);
          response.write(buf);
          if (capturedBytes < options.bodies) {
            captured.push(buf.subarray(0, options.bodies - capturedBytes));
            capturedBytes += buf.length;
          }
        }
      }
      response.end();
      const responseBody = Buffer.concat(captured);

      const entry = {
        id,
        at: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        request: {
          method: request.method,
          path: request.url,
          headers: loggableHeaders(request.headers),
          body: decodeBody(requestBody, options.bodies),
        },
        response: {
          status: upstream.status,
          headers: Object.fromEntries(upstream.headers),
          body: decodeResponseBody(
            responseBody,
            upstream.headers.get("content-type"),
            options.bodies,
          ),
        },
      };

      await appendFile(options.log, `${JSON.stringify(entry)}\n`);
      console.error(`#${id} ${headline(entry)}`);
      if (!options.quiet) {
        console.error(
          JSON.stringify(
            { request: entry.request, response: entry.response },
            null,
            2,
          ),
        );
      }
    })();
  });

  server.listen(options.port, () => {
    console.error(
      `friendli-relay: http://localhost:${options.port} → ${options.target}`,
    );
    console.error(`friendli-relay: capture → ${options.log}`);
  });
}

await main();
