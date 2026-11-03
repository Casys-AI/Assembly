import {
  modelWriteCommandDigest,
  modelWriteDossierDigest,
} from "../../../domain/model/editing/write-command.ts";
import {
  isScopedSoftwareWriteDossier,
  modelWriteCommandDigestV2,
  modelWriteDossierDigestV2,
  type VersionedModelWriteCommand,
  type VersionedModelWriteDossier,
} from "./write-command-v2.ts";
import {
  scopedSoftwareWriteCommandDigest,
  scopedSoftwareWriteDossierDigest,
} from "./scoped-software-write.ts";

/** V1 encoding is deliberately untouched; only explicit v2 opts into v2 hash. */
export function versionedWriteCommandDigest(
  command: VersionedModelWriteCommand,
): Promise<string> {
  return command.v === 1
    ? modelWriteCommandDigest(command)
    : command.kind === "publish-software-evolution"
    ? scopedSoftwareWriteCommandDigest(command)
    : modelWriteCommandDigestV2(command);
}
export function versionedWriteDossierDigest(
  dossier: VersionedModelWriteDossier,
): Promise<string> {
  return dossier.v === 1
    ? modelWriteDossierDigest(dossier)
    : isScopedSoftwareWriteDossier(dossier)
    ? scopedSoftwareWriteDossierDigest(dossier)
    : modelWriteDossierDigestV2(dossier);
}
