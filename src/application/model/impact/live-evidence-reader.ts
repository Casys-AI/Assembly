import type { NetworkImpactEvidenceReader } from "./ports/out/network-impact-evidence-reader.port.ts";
import type {
  BoundedNetworkImpactEvidenceInput,
  BoundedNetworkImpactEvidenceRead,
} from "./evidence-sources.ts";
import type {
  NetworkImpactEvidenceRead,
  NetworkImpactLimits,
} from "../../../domain/model/consultation/network-impact.ts";
import { createNetworkImpactEvidenceAccumulator } from "./evidence-extraction.ts";

/** Supplied by trusted composition from an already authorized owner handle.
 * Neither a request nor stored content can select paths or SQL. */
export interface LiveNetworkImpactEvidenceSource {
  id: string;
  kind: "state" | "skills";
  read(
    input: BoundedNetworkImpactEvidenceInput,
  ): Promise<BoundedNetworkImpactEvidenceRead>;
}

/** Reads serialized live owners without opening, copying or initializing a
 * database. Each source captures its own bounds; there is no global snapshot. */
export class LiveNetworkImpactEvidenceReader
  implements NetworkImpactEvidenceReader {
  constructor(
    private readonly options: {
      resolveSources(
        operatorId: string,
      ): Promise<readonly LiveNetworkImpactEvidenceSource[]>;
    },
  ) {}

  async read(input: {
    operatorId: string;
    host: string;
    limits: NetworkImpactLimits;
    signal?: AbortSignal;
  }): Promise<NetworkImpactEvidenceRead> {
    const accumulator = createNetworkImpactEvidenceAccumulator(input);
    const { result, issue } = accumulator;
    if (!accumulator.valid) return result;
    try {
      if (!accumulator.checkpoint()) return accumulator.finish();
      const sources = await this.options.resolveSources(input.operatorId);
      if (!accumulator.checkpoint()) return accumulator.finish();
      if (!sources.some((source) => source.kind === "state")) {
        issue(
          "STATE_EVIDENCE_NOT_CONFIGURED",
          "No authorized live state owner is available.",
        );
      }
      if (!sources.some((source) => source.kind === "skills")) {
        issue(
          "SKILL_EVIDENCE_NOT_CONFIGURED",
          "No authorized live skills owner is available.",
        );
      }
      const seen = new Set<string>();
      const configured: Array<{
        source: LiveNetworkImpactEvidenceSource;
        reference: NonNullable<NetworkImpactEvidenceRead["sources"]>[number];
      }> = [];
      for (const [inputIndex, source] of sources.entries()) {
        if (
          !source.id || source.id.length > 1024 ||
          Array.from(source.id).some((character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
          )
        ) {
          issue(
            "EVIDENCE_SOURCE_INVALID",
            "The live evidence source has no valid opaque identity.",
          );
          continue;
        }
        if (seen.has(source.id)) continue;
        seen.add(source.id);
        const reference = {
          id: source.id,
          kind: source.kind,
          inputIndex,
          complete: false,
        };
        result.sources!.push(reference);
        configured.push({ source, reference });
      }
      for (const [sourceIndex, { source, reference }] of configured.entries()) {
        accumulator.source(source.id);
        if (!accumulator.checkpoint()) continue;
        const remainingSnapshots = input.limits.maxSnapshots -
          result.snapshotsRead;
        const remainingBytes = input.limits.maxTotalBytes - result.bytesRead;
        if (remainingSnapshots < 1 || remainingBytes < 1) {
          issue(
            remainingSnapshots < 1
              ? "EVIDENCE_SNAPSHOT_LIMIT"
              : "EVIDENCE_BYTE_LIMIT",
            "The global live evidence read budget has been reached.",
          );
          continue;
        }
        // Leave one snapshot slot for each pending source when the global budget
        // permits it. A long state journal must not consume a skills owner's slot.
        const maxSnapshots = Math.max(
          1,
          remainingSnapshots - (configured.length - sourceIndex - 1),
        );
        try {
          const captured = await source.read({
            maxSnapshots,
            maxPayloadBytes: input.limits.maxPayloadBytes,
            maxTotalBytes: remainingBytes,
            signal: accumulator.signal,
          });
          reference.revisionBounds = structuredClone(captured.revisionBounds);
          reference.complete = captured.complete;
          result.snapshotsRead += captured.snapshotsRead;
          result.bytesRead += captured.bytesRead;
          if (!captured.complete) result.complete = false;
          for (const entry of captured.issues) {
            issue(
              entry.code,
              entry.message,
              !captured.complete,
              entry.recordId,
              source.id,
            );
          }
          if (!accumulator.checkpoint()) continue;
          for (const snapshot of captured.snapshots) {
            if (!accumulator.checkpoint()) break;
            let parsed: Record<string, unknown>;
            try {
              const value: unknown = JSON.parse(snapshot.payload);
              if (!value || typeof value !== "object" || Array.isArray(value)) {
                throw new Error("Invalid payload");
              }
              parsed = value as Record<string, unknown>;
            } catch {
              issue(
                "EVIDENCE_PAYLOAD_INVALID",
                "A live evidence payload is not a readable JSON object.",
              );
              continue;
            }
            if (parsed.revision !== snapshot.revision) {
              issue(
                source.kind === "state"
                  ? "EVIDENCE_REVISION_INVALID"
                  : "EVIDENCE_SKILL_REVISION_INVALID",
                "A live evidence payload does not match its persisted revision.",
              );
              continue;
            }
            if (source.kind === "state") {
              await accumulator.state(parsed, snapshot.revision);
            } else await accumulator.skills(parsed);
          }
        } catch {
          if (accumulator.checkpoint()) {
            issue(
              "EVIDENCE_SOURCE_UNAVAILABLE",
              "An authorized live evidence owner is unavailable.",
            );
          }
        }
      }
      return accumulator.finish();
    } catch {
      issue(
        "EVIDENCE_SCOPE_UNAVAILABLE",
        "The host could not resolve authorized live evidence sources.",
      );
      return accumulator.finish();
    } finally {
      accumulator.close();
    }
  }
}
