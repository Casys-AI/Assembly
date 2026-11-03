import {
  modelCommitHash,
  parseModelRevisionId,
} from "../../shared-kernel/revision-id.ts";
import { ModelWriteCommandError } from "./write-command.ts";

/** Exact existing Git anchor names. A well-formed reference proves neither
 * publication nor current authority; consumers must verify the anchored bytes. */
export function requestSourceCommandRef(commandId: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(commandId) ||
    commandId.includes("..") || commandId.endsWith(".") ||
    commandId.endsWith(".lock")
  ) {
    throw new ModelWriteCommandError("WRITE_COMMAND_INVALID", {
      reason: "Invalid write command anchor",
      path: "commandId",
    }, "Invalid write command anchor");
  }
  return `refs/ase/write-commands/${commandId}`;
}
export function requestSourceAdmissionRef(
  proposalId: string,
  version: string,
): string {
  if (!/^[0-9a-f-]{36}$/.test(proposalId)) {
    throw new ModelWriteCommandError("WRITE_COMMAND_INVALID", {
      reason: "Invalid proposal admission anchor",
      path: "proposalId",
    }, "Invalid proposal admission anchor");
  }
  return `refs/ase/admissions/${proposalId}/${
    modelCommitHash(parseModelRevisionId(version))
  }`;
}

/** Software evolution uses its own namespace; a human admission anchor must
 * never be accepted as evidence for this family. */
export function scopedSoftwareSourceCommandRef(commandId: string): string {
  const humanRef = requestSourceCommandRef(commandId);
  return humanRef.replace(
    "refs/ase/write-commands/",
    "refs/ase/software-evolution/write-commands/",
  );
}
export function scopedSoftwareSourceAdmissionRef(
  commandId: string,
  version: string,
): string {
  // Reuse the established exact proposal and Git-version validation only.
  const humanRef = requestSourceAdmissionRef(commandId, version);
  return humanRef.replace(
    "refs/ase/admissions/",
    "refs/ase/software-evolution/admissions/",
  );
}
