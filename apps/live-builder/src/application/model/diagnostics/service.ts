import {
  lintModelDiagnostics,
  type ModelDiagnostic,
} from "../../../domain/model/policies/diagnostics.ts";
import type {
  ModelDiagnosticMask,
  ModelDiagnosticMaskChange,
} from "./commands/inputs.ts";
import type { ModelDiagnosticMaskStore } from "./ports/out/diagnostic-mask-store.port.ts";
import type { ModelDiagnosticsReader } from "./ports/out/diagnostics-reader.port.ts";

interface ListedModelDiagnostic extends ModelDiagnostic {
  masked: boolean;
}
export interface ModelDiagnosticsResult {
  version: string;
  sourceDigest: string;
  diagnostics: ListedModelDiagnostic[];
}
export class ModelDiagnosticsError extends Error {
  constructor(
    readonly code: "DIAGNOSTIC_NOT_FOUND" | "DIAGNOSTIC_NOT_MASKABLE",
    message: string,
  ) {
    super(message);
    this.name = "ModelDiagnosticsError";
  }
}

export function modelDiagnosticMaskKey(mask: ModelDiagnosticMask): string {
  return JSON.stringify([mask.code, mask.elementId ?? null]);
}

/** Revalidation never changes execution authority. Only lint results are cached;
 * instance preferences are read again for every response. */
export class ModelDiagnosticsService {
  #cache = new Map<string, Promise<readonly ModelDiagnostic[]>>();

  constructor(
    private readonly reader: ModelDiagnosticsReader,
    private readonly masks: ModelDiagnosticMaskStore,
    private readonly lint = lintModelDiagnostics,
  ) {}

  async list(version?: string): Promise<ModelDiagnosticsResult> {
    const snapshot = await this.reader.read(version);
    let pending = this.#cache.get(snapshot.digest);
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        const input = typeof snapshot.input === "function"
          ? await snapshot.input()
          : snapshot.input;
        return this.lint(input);
      });
      this.#cache.set(snapshot.digest, pending);
      if (this.#cache.size > 32) {
        this.#cache.delete(this.#cache.keys().next().value!);
      }
      const cached = pending;
      pending.catch(() => {
        if (this.#cache.get(snapshot.digest) === cached) {
          this.#cache.delete(snapshot.digest);
        }
      });
    }
    const [diagnostics, masks] = await Promise.all([
      pending,
      this.masks.list(),
    ]);
    const masked = new Set(masks.map(modelDiagnosticMaskKey));
    return {
      version: snapshot.version,
      sourceDigest: snapshot.digest,
      diagnostics: structuredClone(diagnostics).map((diagnostic) => ({
        ...diagnostic,
        masked: diagnostic.severity !== "error" &&
          (masked.has(modelDiagnosticMaskKey(diagnostic)) ||
            masked.has(modelDiagnosticMaskKey({ code: diagnostic.code }))),
      })),
    };
  }

  async setMask(change: ModelDiagnosticMaskChange) {
    if (change.masked) {
      const current = await this.list();
      const diagnostics = current.diagnostics.filter((entry) =>
        entry.code === change.code &&
        (change.elementId == null || entry.elementId === change.elementId)
      );
      if (!diagnostics.length) {
        throw new ModelDiagnosticsError(
          "DIAGNOSTIC_NOT_FOUND",
          "No current diagnostic matches this mask.",
        );
      }
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        throw new ModelDiagnosticsError(
          "DIAGNOSTIC_NOT_MASKABLE",
          "Error diagnostics cannot be masked.",
        );
      }
    }
    await this.masks.set(change);
    return { ...change };
  }

  async forAgent(version?: string): Promise<ListedModelDiagnostic[]> {
    const { diagnostics } = await this.list(version);
    return diagnostics.filter((diagnostic) =>
      !diagnostic.masked &&
      (diagnostic.severity === "warning" || diagnostic.severity === "error")
    ).slice(0, 20);
  }
}
