import { compareCodeUnits } from "../../../domain/primitives/canonical-json.ts";
import { dirname, resolve } from "node:path";
import {
  type ModelDiagnosticMask,
  type ModelDiagnosticMaskChange,
} from "../../../application/model/diagnostics/commands/inputs.ts";
import type { ModelDiagnosticMaskStore } from "../../../application/model/diagnostics/ports/out/diagnostic-mask-store.port.ts";
import { modelDiagnosticMaskKey } from "../../../application/model/diagnostics/service.ts";

const writes = new Map<string, Promise<void>>();
const schemaVersion = "model-diagnostic-masks/v1";

function validMask(value: unknown): value is ModelDiagnosticMask {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,119}$/.test(record.code) &&
    (record.elementId == null ||
      typeof record.elementId === "string" && record.elementId.trim() !== "" &&
        record.elementId.length <= 2048) &&
    Object.keys(record).every((key) => ["code", "elementId"].includes(key));
}

/** One JSON preference file in the instance data directory. An atomic rename
 * prevents a partially written preference file; mutations serialize by path. */
export class JsonModelDiagnosticMaskStore implements ModelDiagnosticMaskStore {
  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<JsonModelDiagnosticMaskStore> {
    const absolute = resolve(path);
    await Deno.mkdir(dirname(absolute), { recursive: true });
    return new JsonModelDiagnosticMaskStore(absolute);
  }

  async list(): Promise<ModelDiagnosticMask[]> {
    let text: string;
    try {
      text = await Deno.readTextFile(this.path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
    let stored: unknown;
    try {
      stored = JSON.parse(text);
    } catch {
      throw new Error("Invalid diagnostic mask file.");
    }
    const record = stored as Record<string, unknown> | null;
    if (
      !record || Array.isArray(record) ||
      record.schemaVersion !== schemaVersion || !Array.isArray(record.masks) ||
      !record.masks.every(validMask) ||
      Object.keys(record).some((key) =>
        !["schemaVersion", "masks"].includes(key)
      )
    ) throw new Error("Invalid diagnostic mask file.");
    const masks = record.masks as ModelDiagnosticMask[];
    if (new Set(masks.map(modelDiagnosticMaskKey)).size !== masks.length) {
      throw new Error("Duplicate diagnostic masks.");
    }
    return masks;
  }

  async set(change: ModelDiagnosticMaskChange): Promise<void> {
    const operation = (writes.get(this.path) ?? Promise.resolve()).then(
      async () => {
        const masks = (await this.list()).filter((entry) =>
          modelDiagnosticMaskKey(entry) !== modelDiagnosticMaskKey(change)
        );
        if (change.masked) {
          masks.push({
            code: change.code,
            ...(change.elementId == null
              ? {}
              : { elementId: change.elementId }),
          });
        }
        masks.sort((a, b) => {
          const left = modelDiagnosticMaskKey(a),
            right = modelDiagnosticMaskKey(b);
          return compareCodeUnits(left, right);
        });
        const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
        try {
          await Deno.writeTextFile(
            temporary,
            JSON.stringify({ schemaVersion, masks }, null, 2) + "\n",
            { createNew: true },
          );
          await Deno.rename(temporary, this.path);
        } finally {
          await Deno.remove(temporary).catch((error) => {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          });
        }
      },
    );
    const settled = operation.catch(() => {});
    writes.set(this.path, settled);
    try {
      await operation;
    } finally {
      if (writes.get(this.path) === settled) writes.delete(this.path);
    }
  }
}
