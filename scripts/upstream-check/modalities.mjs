import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [command, ...args] = process.argv.slice(2);

if (command === "plan") {
  const [catalogPath] = args;
  const models = JSON.parse(readFileSync(catalogPath, "utf8"))
    .data.filter((model) => !model.deprecation_date)
    .sort(
      (a, b) =>
        Number(a.pricing.input) +
        Number(a.pricing.output) -
        Number(b.pricing.input) -
        Number(b.pricing.output),
    );
  const modalities = [
    ...new Set(models.flatMap((model) => model.input_modalities ?? [])),
  ];
  for (const modality of [
    "text",
    "image",
    ...modalities.filter((value) => !["text", "image"].includes(value)).sort(),
  ]) {
    const model = models.find((entry) =>
      entry.input_modalities?.includes(modality),
    );
    if (!model) continue;
    const level = model.reasoning_options?.some(
      (option) => option.type === "toggle",
    )
      ? "off"
      : (model.reasoning_options?.find((option) => option.type === "effort")
          ?.values?.[0] ?? "default");
    console.log(modality, model.id, level);
  }
} else if (command === "fixture") {
  const [modality] = args;
  if (modality === "image") {
    // A locally generated 32x32 PNG; no network assets or checked-in binaries.
    const result = spawnSync(
      process.env.FFMPEG_BINARY || "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=32x32",
        "-frames:v",
        "1",
        "-y",
        "input.png",
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    writeFileSync(
      "image.jsonl",
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: readFileSync("input.png").toString("base64"),
              },
            },
            { type: "text", text: "Reply briefly. Do not use tools." },
          ],
        },
      }) + "\n",
    );
  } else if (modality === "video") {
    const result = spawnSync(
      process.env.FFMPEG_BINARY || "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=32x32:r=1",
        "-t",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-y",
        "input.mp4",
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  } else if (modality !== "text")
    throw new Error(`No local fixture for ${modality}`);
} else if (command === "verify") {
  const [modality, model, level] = args;
  // The relay appends after completing the response. Await that append, not a new inference.
  let rows = [];
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      rows = readFileSync("capture.jsonl", "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
        .filter(
          (row) =>
            row.request.method === "POST" &&
            /\/(chat\/completions|responses|messages)(\?|$)/.test(
              row.request.path,
            ),
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (rows.length) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!rows.length)
    throw new Error(`${modality}: no inference request reached Friendli`);
  for (const row of rows) {
    if (row.request.body?.model !== model)
      throw new Error(
        `${modality}: unexpected model ${row.request.body?.model}`,
      );
    if (row.response.status !== 200)
      throw new Error(
        `${modality}: ${row.request.path} answered ${row.response.status}`,
      );
    const response = row.response.body;
    if (
      response?.error ||
      response?.frames?.some(
        (frame) =>
          frame.error || ["error", "response.failed"].includes(frame.type),
      )
    )
      throw new Error(`${modality}: inference stream returned an error`);
    if (
      level === "off" &&
      /reasoning_content"|"reasoning":"[^"]|"thinking_delta"|"type":"(thinking|reasoning)"|reasoning[a-z_.]*\.delta/.test(
        JSON.stringify(response),
      )
    )
      throw new Error(
        `${modality}: reasoning came back although it was turned off`,
      );
  }
  const types = new Set();
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.type === "string") types.add(value.type);
    for (const child of Object.values(value)) visit(child);
  }
  for (const row of rows) visit(row.request.body);
  if (
    modality === "image" &&
    !["image", "image_url", "input_image"].some((type) => types.has(type))
  )
    throw new Error("image: harness dropped the attachment before inference");
  if (
    modality === "video" &&
    !["video", "video_url", "input_video"].some((type) => types.has(type))
  )
    throw new Error("video: harness dropped the attachment before inference");
  console.log(
    `e2e: ${modality} ${model}: ${rows.length} inference response(s), all 200`,
  );
} else throw new Error(`Unknown modality helper command: ${command}`);
