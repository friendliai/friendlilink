/**
 * Decode a Friendli SSE byte stream into event `data` payloads. Framing is
 * delegated to `eventsource-parser`; this module keeps the OpenAI/Friendli
 * protocol detail: the literal `[DONE]` is yielded so the caller owns final
 * flushing, and EOF before it is a truncated response.
 *
 * @module @friendliai/dsh-llm-friendli/sse
 */

import { EventSourceParserStream } from "eventsource-parser/stream";
import { LlmError } from "@deepseek-ai/dsh-llm";

/** The terminal payload Friendli (and OpenAI) send after the last chunk. */
export const DONE = "[DONE]";

/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` last and
 * returns; throws `LlmError('STREAM_CLOSED')` when the stream ends without it
 * (a truncated response cannot be trusted).
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8.
 * @returns each event's data payload in arrival order, `[DONE]` last.
 */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream());
  const reader = events.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value.data;
      if (value.data === DONE) return;
    }
  } finally {
    reader.cancel().catch(() => {
      // Best-effort teardown; the read outcome is already decided.
    });
  }
  throw new LlmError(
    "Friendli SSE stream ended without [DONE]",
    "STREAM_CLOSED",
  );
}
