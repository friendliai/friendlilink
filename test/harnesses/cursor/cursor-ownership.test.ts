import { describe, expect, it } from "vitest";
import {
  clearOwnership,
  cursorIsManaged,
  emptyOwnership,
  insertInto,
  readOwnership,
  removeFrom,
  revertAll,
  revertField,
  revertList,
  storeOwnership,
  writeField,
  type FieldRecord,
  type ListRecord,
} from "../../../src/harnesses/cursor/ownership.js";

describe("writeField / revertField", () => {
  it("restores a prior value", () => {
    const box: Record<string, unknown> = { url: "https://theirs" };
    const rec: Record<string, FieldRecord> = {};
    writeField(box, "url", "https://ours", rec);
    expect(box.url).toBe("https://ours");
    revertField(box, "url", rec.url!);
    expect(box.url).toBe("https://theirs");
  });

  /** Absent is not the same as null. Writing `null` back where there was no
   * key at all leaves a field the user never had. */
  it("deletes a key that did not exist before", () => {
    const box: Record<string, unknown> = {};
    const rec: Record<string, FieldRecord> = {};
    writeField(box, "useOpenAIKey", true, rec);
    revertField(box, "useOpenAIKey", rec.useOpenAIKey!);
    expect(Object.hasOwn(box, "useOpenAIKey")).toBe(false);
  });

  it("leaves a value someone changed after us", () => {
    const box: Record<string, unknown> = { model: "theirs" };
    const rec: Record<string, FieldRecord> = {};
    writeField(box, "model", "ours", rec);
    box.model = "changed-by-hand";
    revertField(box, "model", rec.model!);
    expect(box.model).toBe("changed-by-hand");
  });

  it("compares deeply, so an identical object still reverts", () => {
    const box: Record<string, unknown> = { sel: [{ modelId: "old" }] };
    const rec: Record<string, FieldRecord> = {};
    writeField(box, "sel", [{ modelId: "new" }], rec);
    box.sel = [{ modelId: "new" }]; // same content, different identity
    revertField(box, "sel", rec.sel!);
    expect(box.sel).toEqual([{ modelId: "old" }]);
  });

  /** A second `on` writes the same fields again. If the second write recorded
   * the prior, it would record OUR value as the user's and `off` would leave
   * our routing in place forever. */
  it("keeps the first prior when the same field is written twice", () => {
    const box: Record<string, unknown> = { url: "https://theirs" };
    const rec: Record<string, FieldRecord> = {};
    writeField(box, "url", "https://ours-1", rec);
    writeField(box, "url", "https://ours-2", rec);
    revertField(box, "url", rec.url!);
    expect(box.url).toBe("https://theirs");
  });
});

describe("insertInto / removeFrom / revertList", () => {
  it("records only genuine insertions", () => {
    const list = ["custom/UserModel"];
    const rec: Record<string, ListRecord> = {};
    insertInto(list, "custom/UserModel", rec, "userAddedModels");
    insertInto(list, "zai-org/GLM-5.2", rec, "userAddedModels");
    expect(rec.userAddedModels).toEqual({
      inserted: ["zai-org/GLM-5.2"],
      removed: [],
    });
  });

  /** The user's own entry must survive `off`; claiming an id that was already
   * there is how a previous attempt deleted it. */
  it("leaves an id the user already had", () => {
    const rec: Record<string, ListRecord> = {};
    let list = ["custom/UserModel"];
    insertInto(list, "custom/UserModel", rec, "userAddedModels");
    list = revertList(
      list,
      rec.userAddedModels ?? { inserted: [], removed: [] },
    );
    expect(list).toEqual(["custom/UserModel"]);
  });

  it("puts back what we removed, and drops what we added", () => {
    const rec: Record<string, ListRecord> = {};
    let list = ["gpt-5.6-sol", "claude-opus-5"];
    list = removeFrom(list, "gpt-5.6-sol", rec, "modelOverrideEnabled");
    insertInto(list, "zai-org/GLM-5.2", rec, "modelOverrideEnabled");
    expect(list).toEqual(["claude-opus-5", "zai-org/GLM-5.2"]);
    expect(revertList(list, rec.modelOverrideEnabled!).sort()).toEqual(
      ["claude-opus-5", "gpt-5.6-sol"].sort(),
    );
  });

  it("does not redo a change reality already undid", () => {
    const rec: Record<string, ListRecord> = {};
    let list = ["a"];
    list = removeFrom(list, "a", rec, "l");
    list.push("a"); // Cursor put it back itself
    expect(revertList(list, rec.l!)).toEqual(["a"]);
  });
});

describe("readOwnership", () => {
  it("returns nothing for a blob we never touched", () => {
    expect(
      readOwnership({ aiSettings: { userAddedModels: ["x"] } }),
    ).toBeUndefined();
    expect(cursorIsManaged({ aiSettings: {} })).toBe(false);
  });

  it("round-trips a stored record", () => {
    const blob: Record<string, unknown> = { aiSettings: {} };
    storeOwnership(blob, emptyOwnership({ model: "zai-org/GLM-5.2" }));
    expect(readOwnership(blob)?.model).toBe("zai-org/GLM-5.2");
    expect(cursorIsManaged(blob)).toBe(true);
  });
});

describe("revertAll", () => {
  const managedBlob = () => {
    const blob: Record<string, unknown> = {
      openAIBaseUrl: "https://theirs",
      mcpServers: { keep: "me" },
      availableDefaultModels2: [{ name: "gpt-5.6-sol" }],
      aiSettings: {
        userAddedModels: ["custom/UserModel"],
        modelOverrideEnabled: ["custom/UserModel", "gpt-5.6-sol"],
        modelOverrideDisabled: [],
        modelConfig: { composer: { modelName: "gpt-5.6-sol", maxMode: true } },
      },
    };
    const record = emptyOwnership({ model: "zai-org/GLM-5.2" });
    const ai = blob.aiSettings as Record<string, unknown>;
    writeField(blob, "openAIBaseUrl", "https://friendli", record.scalars);
    writeField(blob, "useOpenAIKey", true, record.scalars);
    insertInto(
      ai.userAddedModels as string[],
      "zai-org/GLM-5.2",
      record.lists,
      "userAddedModels",
    );
    insertInto(
      ai.modelOverrideEnabled as string[],
      "zai-org/GLM-5.2",
      record.lists,
      "modelOverrideEnabled",
    );
    ai.modelOverrideEnabled = removeFrom(
      ai.modelOverrideEnabled as string[],
      "gpt-5.6-sol",
      record.lists,
      "modelOverrideEnabled",
    );
    insertInto(
      ai.modelOverrideDisabled as string[],
      "gpt-5.6-sol",
      record.lists,
      "modelOverrideDisabled",
    );
    record.modes.composer = {};
    writeField(
      (ai.modelConfig as Record<string, Record<string, unknown>>).composer!,
      "modelName",
      "zai-org/GLM-5.2",
      record.modes.composer,
    );
    storeOwnership(blob, record);
    return { blob, record };
  };

  it("puts everything back and leaves Cursor's own keys alone", () => {
    const { blob, record } = managedBlob();
    revertAll(blob, record);
    const ai = blob.aiSettings as Record<string, unknown>;
    expect(blob.openAIBaseUrl).toBe("https://theirs");
    expect(Object.hasOwn(blob, "useOpenAIKey")).toBe(false);
    expect(ai.userAddedModels).toEqual(["custom/UserModel"]);
    expect((ai.modelOverrideEnabled as string[]).sort()).toEqual([
      "custom/UserModel",
      "gpt-5.6-sol",
    ]);
    expect(ai.modelOverrideDisabled).toEqual([]);
    expect(
      (ai.modelConfig as Record<string, Record<string, unknown>>).composer!
        .modelName,
    ).toBe("gpt-5.6-sol");
    // The mode's other fields, and Cursor's unrelated keys, are untouched.
    expect(
      (ai.modelConfig as Record<string, Record<string, unknown>>).composer!
        .maxMode,
    ).toBe(true);
    expect(blob.mcpServers).toEqual({ keep: "me" });
  });

  it("removes the record", () => {
    const { blob, record } = managedBlob();
    revertAll(blob, record);
    expect(cursorIsManaged(blob)).toBe(false);
  });

  it("skips a catalog entry Cursor's refresh already removed", () => {
    const blob: Record<string, unknown> = {
      availableDefaultModels2: [],
      aiSettings: {},
    };
    const record = emptyOwnership();
    record.catalogEntries["zai-org/GLM-5.2"] = {
      createdByUs: false,
      fields: {
        parameterDefinitions: { had: true, prior: [], wrote: [{ id: "x" }] },
      },
    };
    expect(() => revertAll(blob, record)).not.toThrow();
  });
});

describe("clearOwnership", () => {
  it("is safe on a blob with no aiSettings", () => {
    const blob: Record<string, unknown> = {};
    expect(() => clearOwnership(blob)).not.toThrow();
  });
});
