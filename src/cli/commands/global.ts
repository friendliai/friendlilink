import * as clack from "@clack/prompts";
import {
  FRIENDLI_BASE_URL,
  normalizeFriendliBaseUrl,
} from "../../friendli/base-url.js";
import { verifyFriendliApiKey } from "../../friendli/client.js";
import {
  fetchFriendliModelCatalog,
  type FriendliModel,
} from "../../friendli/model-catalog.js";
import { listHarnesses } from "../../harness/registry.js";
import type { HarnessContext } from "../../harness/types.js";
import {
  clearApiKey,
  isLikelyFriendliKey,
  persistApiKey,
  resolveApiKey,
} from "../../keys/api-key.js";

function resolvedBaseUrl(ctx: HarnessContext): string {
  return ctx.baseUrlFromFlag && ctx.baseUrl
    ? normalizeFriendliBaseUrl(ctx.baseUrl)
    : FRIENDLI_BASE_URL;
}

export async function runLogin(ctx: HarnessContext): Promise<void> {
  const baseUrl = resolvedBaseUrl(ctx);

  let apiKey = ctx.apiKeyFromFlag ? ctx.apiKey : "";
  // The welcome frame belongs to the prompt: with --api-key there is nothing
  // to greet, and the run stays a single parseable line.
  const welcomed = !apiKey;
  if (welcomed) {
    clack.intro("FRIENDLIAI · FriendliLink");
    clack.log.message(
      "FriendliAI models in your coding agents.\n" +
        "Get an API key at https://friendli.ai/suite",
    );
    const answer = await clack.password({
      message: "FriendliAI API key:",
    });
    if (clack.isCancel(answer)) {
      clack.cancel("Cancelled — no API key was saved.");
      return;
    }
    apiKey = answer;
  }

  if (!isLikelyFriendliKey(apiKey)) {
    throw new Error("That doesn't look like a FriendliAI API key.");
  }

  const verified = await verifyFriendliApiKey(apiKey, baseUrl);
  if (!verified.ok) {
    throw new Error(verified.message ?? "FriendliAI rejected this API key.");
  }

  await persistApiKey(ctx.home, apiKey);
  if (welcomed) {
    clack.outro("API key saved. Next: `frlink claude on`");
    return;
  }
  console.log("frlink: API key saved.");
}

export async function runLogout(ctx: HarnessContext): Promise<void> {
  await clearApiKey(ctx.home);
  console.log("frlink: API key removed.");
}

export async function runGlobalStatus(ctx: HarnessContext): Promise<void> {
  const resolved = await resolveApiKey({ home: ctx.home });
  const rows = await Promise.all(
    listHarnesses().map(async (harness) => ({
      id: harness.id,
      label: harness.label,
      status: await harness.providerStatus(ctx),
    })),
  );

  if (ctx.json) {
    console.log(
      JSON.stringify(
        { apiKeyConfigured: Boolean(resolved.key), harnesses: rows },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`FriendliAI API key: ${resolved.key ? "saved" : "not saved"}`);
  for (const row of rows) {
    const routed =
      row.status === "friendli" ? "routed through FriendliAI" : "not routed";
    console.log(`  ${row.id} (${row.label}): ${routed}`);
  }
}

export async function runModelList(ctx: HarnessContext): Promise<void> {
  const resolved = await resolveApiKey({
    apiKeyFlag: ctx.apiKeyFromFlag ? ctx.apiKey : undefined,
    home: ctx.home,
  });
  if (!resolved.key) {
    throw new Error("No FriendliAI API key found. Run `frlink login` first.");
  }

  const models = await fetchFriendliModelCatalog(
    resolved.key,
    resolvedBaseUrl(ctx),
  );

  if (ctx.json) {
    console.log(JSON.stringify(models, null, 2));
    return;
  }
  if (models.length === 0) {
    console.log("frlink: FriendliAI's model catalog returned no models.");
    return;
  }
  for (const line of formatModelTable(models)) {
    console.log(line);
  }
}

/** One row per model: the id, then the three prices the catalog already
 * normalized to dollars per million tokens (`pricePerMillion`). Friendli's
 * `name` is the id for every model it serves today, so printing the label as a
 * second column just repeated each id — it is dropped. Columns are padded
 * rather than tab-separated: a tab lands wherever the next tab stop happens to
 * be, which is what made the old output ragged. */
export function formatModelTable(models: FriendliModel[]): string[] {
  // Two decimals is the usual $/M shape, but cache-read prices run finer
  // (0.234), and a price finer still must not be rounded down to "0.00" —
  // the catalog normalizes to six decimals, so go that far when it takes it.
  // Trailing zeros are then trimmed back to the usual two decimals.
  const price = (value: number | undefined): string => {
    if (value === undefined) return "-";
    const decimals = value > 0 && value < 0.001 ? 6 : 3;
    return value.toFixed(decimals).replace(/(\.\d{2}\d*?)0+$/, "$1");
  };
  const rows = models.map((model) => [
    model.id,
    price(model.pricing?.input),
    price(model.pricing?.output),
    price(model.pricing?.cacheRead),
  ]);
  const header = ["MODEL ID", "INPUT", "OUTPUT", "CACHE READ"];
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] as string).length)),
  );
  const render = (row: string[]): string =>
    [
      row[0]!.padEnd(widths[0]!),
      row[1]!.padStart(widths[1]!),
      row[2]!.padStart(widths[2]!),
      row[3]!.padStart(widths[3]!),
    ]
      .join("  ")
      .trimEnd();
  return [`${render(header)}   (USD per 1M tokens)`, ...rows.map(render)];
}
