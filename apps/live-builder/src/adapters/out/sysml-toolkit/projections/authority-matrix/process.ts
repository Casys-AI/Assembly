/** One bounded OS process per artifact projection; no Toolkit runtime. */
import { getHeapStatistics } from "node:v8";
import { resourceUsage } from "node:process";
import { projectAuthorityMatrix } from "./projection.ts";
import { validateSourceExecutables } from "../../../../model/sources/source-model.ts";
import { TOOLKIT_COMPILER_DESCRIPTOR } from "../../compilation/compiler.ts";
import { modelSourceDigest } from "../../../../../domain/model/value-objects/sources.ts";
import type { AuthorityMatrixProcessInput } from "./worker-client.ts";

// The projector reads one artifact format. The descriptor is the compiler's own,
// already in this process's import closure through source-model, so the matrix
// adds no second copy of the provider name or format.
const MATRIX_PROVIDER = TOOLKIT_COMPILER_DESCRIPTOR;
/** Oldest compiler engine whose stored artifacts the projector was qualified
 * against (the Toolkit this repository pinned when B5 was written). The engine
 * is deliberately NOT required to equal the running build: the repository serves
 * historical artifacts as stored, without recompiling, so strict equality would
 * make every existing version, the head included, unreadable here after any
 * Toolkit bump until it was republished. What the projector depends on is the
 * normalized format, which is checked exactly; the engine that produced the
 * artifact is reported unchanged in `model.toolkit`. Raise this floor, as a
 * deliberate decision, only when a later engine changes what the projector reads
 * without changing the format identifier. */
export const MATRIX_MIN_ENGINE_VERSION = "0.10.10";

function engineVersionParts(version: unknown): number[] | undefined {
  if (typeof version !== "string") return undefined;
  // Build metadata identifies a reviewed local bundle without changing the
  // engine's precedence. Prereleases remain outside this qualified floor.
  const parts =
    /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/
      .exec(version);
  return parts ? parts.slice(1, 4).map(Number) : undefined;
}

/** Why an artifact's engine/provider cannot be projected, or undefined. */
export function matrixProviderRefusal(
  revision: Pick<
    AuthorityMatrixProcessInput["revision"],
    "engineVersion" | "provider"
  >,
): string | undefined {
  const { provider, engineVersion } = revision;
  if (
    !provider || typeof provider !== "object" ||
    Object.keys(provider).length !== 3
  ) return "provider descriptor must be exactly {name, version, format}";
  if (provider.name !== MATRIX_PROVIDER.name) {
    return `provider ${String(provider.name)} is not ${MATRIX_PROVIDER.name}`;
  }
  if (provider.format !== MATRIX_PROVIDER.format) {
    return `artifact format ${
      String(provider.format)
    } is not ${MATRIX_PROVIDER.format}`;
  }
  if (provider.version !== engineVersion) {
    return "provider.version and engineVersion disagree";
  }
  const parts = engineVersionParts(engineVersion);
  const floor = engineVersionParts(MATRIX_MIN_ENGINE_VERSION)!;
  if (!parts) return `engine version ${String(engineVersion)} is malformed`;
  for (let i = 0; i < 3; i++) {
    if (parts[i]! !== floor[i]!) {
      return parts[i]! > floor[i]!
        ? undefined
        : `engine ${engineVersion} is older than ${MATRIX_MIN_ENGINE_VERSION}`;
    }
  }
  return undefined;
}

function refuse(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

// The single stdout line is the parent protocol (worker-client JSON.parses
// it), not a log line: it bypasses the technical logger on purpose.
const stdoutEncoder = new TextEncoder();
async function writeOutputLine(value: unknown): Promise<void> {
  await Deno.stdout.write(
    stdoutEncoder.encode(`${JSON.stringify(value)}\n`),
  );
}

/** Also exported for the no-compilation bootstrap test. */
export async function runAuthorityMatrixProcess(): Promise<void> {
  const samples: { phase: string; rss: number; heapUsed: number }[] = [];
  const sample = (phase: string) => {
    const { rss, heapUsed } = Deno.memoryUsage();
    samples.push({ phase, rss, heapUsed });
  };
  sample("startup");
  try {
    const reader = Deno.stdin.readable.getReader();
    const decoder = new TextDecoder();
    let input = "", bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 32 * 1024 * 1024) {
          refuse(
            "INVALID_PROJECTION_INPUT",
            "Artifact exceeds 32 MiB transfer limit",
          );
        }
        input += decoder.decode(value, { stream: true });
      }
      input += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    const request: AuthorityMatrixProcessInput = JSON.parse(input);
    input = "";
    const { revision, pin } = request;
    if (
      pin.version !== revision.version ||
      !/^[0-9a-f]{64}$/.test(pin.sourceDigest) ||
      revision.sourceDigest !== pin.sourceDigest ||
      await modelSourceDigest(revision.sources) !== pin.sourceDigest
    ) {
      refuse(
        "MODEL_VERSION_MISMATCH",
        "Artifact source bytes differ from the independently pinned Git sources",
      );
    }
    const providerRefusal = matrixProviderRefusal(revision);
    if (providerRefusal) {
      refuse(
        "INVALID_PROJECTION_PROVIDER",
        `Unsupported compiled artifact engine/provider: ${providerRefusal}`,
      );
    }
    if (
      !Array.isArray(revision.elements) || revision.elements.length > 20_000
    ) {
      refuse("INVALID_PROJECTION_INPUT", "Artifact exceeds 20000 elements");
    }
    sample("decoded");
    const units = request.units ??
      await validateSourceExecutables(revision, request.projectId);
    for (const { model } of units) {
      if (
        model.version.repositoryVersion !== pin.version ||
        model.identity.projectId !== request.projectId
      ) {
        refuse(
          "MODEL_VERSION_MISMATCH",
          "Executable units do not belong to the pinned version/project",
        );
      }
    }
    sample("validated");
    const matrix = await projectAuthorityMatrix({
      revision,
      units,
      name: request.name,
    });
    if (matrix.summary.coordinates.mismatches) {
      refuse(
        "SOURCE_COORDINATE_MISMATCH",
        "Compiled coordinates disagree with the pinned source bytes",
      );
    }
    sample("projected");
    await writeOutputLine({
      ok: true,
      matrix,
      usage: {
        pid: Deno.pid,
        heapSizeLimit: getHeapStatistics().heap_size_limit,
        maxRssBytes: resourceUsage().maxRSS * 1024,
        samples,
      },
    });
  } catch (error) {
    await writeOutputLine({
      ok: false,
      error: {
        code: error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "AUTHORITY_MATRIX_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
      usage: {
        pid: Deno.pid,
        heapSizeLimit: getHeapStatistics().heap_size_limit,
        maxRssBytes: resourceUsage().maxRSS * 1024,
        samples,
      },
    });
  }
}

if (import.meta.main) await runAuthorityMatrixProcess();
