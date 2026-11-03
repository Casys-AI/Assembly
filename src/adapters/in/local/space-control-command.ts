import type { SpaceControls } from "../../../application/work/request-spaces/control.ts";
import type {
  LocalCapabilityFile,
  LocalControlProfile,
  reserveLocalCapabilityFile,
} from "./space-control-files.ts";

type LocalControlHandle = {
  controls: Pick<
    SpaceControls,
    "issueCapability" | "exchange" | "authenticateSession" | "revokeCapability"
  >;
  currentOwnerId(): Promise<string>;
  close(): Promise<void>;
};
type PrivateOutput = Awaited<ReturnType<typeof reserveLocalCapabilityFile>>;
type Command =
  & (
    | { action: "issue"; profile: LocalControlProfile; output: PrivateOutput }
    | { action: "revoke"; stored: LocalCapabilityFile }
  )
  & { open(): Promise<LocalControlHandle> };
type BusinessOutcome =
  | {
    kind: "issued";
    credentialId: string;
    capabilityFile: string;
    expiresAt: string;
  }
  | { kind: "revoked"; credentialId: string }
  | { kind: "issuance-unconfirmed"; reservedOutput: string }
  | { kind: "revocation-unconfirmed"; credentialId: string }
  | {
    kind: "delivery-failed";
    credentialId: string;
    revocation: "confirmed" | "unconfirmed";
  }
  | { kind: "failed-before-mutation" };
export interface LocalControlCommandResult {
  outcome: BusinessOutcome;
  cleanupIssues: Array<
    "OUTPUT_REMOVE_FAILED" | "OUTPUT_CLOSE_FAILED" | "CONTROL_DISCONNECT_FAILED"
  >;
}

/** Explicit CLI lifecycle only. The canonical services own all authority and
 * mutations. No error text, secret or controller appears in a public result. */
export async function runLocalControlCommand(
  command: Command,
): Promise<LocalControlCommandResult> {
  const result: LocalControlCommandResult = {
    outcome: { kind: "failed-before-mutation" },
    cleanupIssues: [],
  };
  const output = command.action === "issue" ? command.output : undefined;
  let local: LocalControlHandle | undefined;
  let issuanceAttempted = false;
  let revocationAttempted = false;
  const cleanup = async (
    operation: (() => Promise<void>) | undefined,
    code: LocalControlCommandResult["cleanupIssues"][number],
  ) => {
    try {
      await operation?.();
    } catch {
      result.cleanupIssues.push(code);
    }
  };
  const revoke = async (file: LocalCapabilityFile) => {
    const session = await local!.controls.exchange(file.capabilitySecret);
    const controller = await local!.controls.authenticateSession(
      session.secret,
    );
    if (controller.capabilityId !== file.credentialId) {
      throw new Error("Credential identity differs.");
    }
    revocationAttempted = true;
    await local!.controls.revokeCapability(controller);
  };
  try {
    local = await command.open();
    if (command.action === "revoke") {
      await revoke(command.stored);
      result.outcome = {
        kind: "revoked",
        credentialId: command.stored.credentialId,
      };
    } else {
      const ownerId = await local.currentOwnerId();
      // The service may commit its insert and lose the acknowledgement before
      // returning a receipt. A rejection cannot establish that nothing changed.
      issuanceAttempted = true;
      const issued = await local.controls.issueCapability(ownerId);
      const file: LocalCapabilityFile = {
        format: 1,
        ...command.profile.scope,
        origin: command.profile.origin,
        credentialId: issued.credentialId,
        expiresAt: issued.expiresAt,
        capabilitySecret: issued.secret,
      };
      try {
        await command.output.save(file);
        result.outcome = {
          kind: "issued",
          credentialId: file.credentialId,
          capabilityFile: command.output.path,
          expiresAt: file.expiresAt,
        };
      } catch {
        // Delivery and SQL issuance are separate. Compensation is reported only
        // after the existing revoke method actually confirms it.
        let revocation: "confirmed" | "unconfirmed" = "unconfirmed";
        try {
          await revoke(file);
          revocation = "confirmed";
          await cleanup(
            () => command.output.removeOwned(),
            "OUTPUT_REMOVE_FAILED",
          );
        } catch { /* No claim that compensation committed. */ }
        result.outcome = {
          kind: "delivery-failed",
          credentialId: file.credentialId,
          revocation,
        };
      }
    }
  } catch {
    if (command.action === "issue" && issuanceAttempted) {
      // Retain the reserved file as evidence. No receipt/secret was returned,
      // so neither an identity-based rollback nor safe automatic retry is known.
      result.outcome = {
        kind: "issuance-unconfirmed",
        reservedOutput: command.output.path,
      };
    } else if (command.action === "revoke" && revocationAttempted) {
      result.outcome = {
        kind: "revocation-unconfirmed",
        credentialId: command.stored.credentialId,
      };
    } else {
      result.outcome = { kind: "failed-before-mutation" };
      await cleanup(
        output ? () => output.removeOwned() : undefined,
        "OUTPUT_REMOVE_FAILED",
      );
    }
  } finally {
    // Always attempt both cleanups. They cannot rewrite a confirmed business
    // result, or turn an uncertain mutation into an assertion of no mutation.
    await cleanup(
      output ? () => output.close() : undefined,
      "OUTPUT_CLOSE_FAILED",
    );
    await cleanup(
      local ? () => local!.close() : undefined,
      "CONTROL_DISCONNECT_FAILED",
    );
  }
  return result;
}

/** Safe CLI presentation, shared with failure witnesses. Confirmed mutations
 * remain exit-success even when resource cleanup needs attention. */
export function reportLocalControlCommand(
  result: LocalControlCommandResult,
  log: { info(message: string): void; error(message: string): void },
): number {
  const outcome = result.outcome;
  if (outcome.kind === "issued") {
    log.info(`Local capability file: ${outcome.capabilityFile}`);
    log.info(`Expires: ${outcome.expiresAt}`);
  } else if (outcome.kind === "revoked") {
    log.info(`Local capability revoked: ${outcome.credentialId}`);
  } else if (outcome.kind === "issuance-unconfirmed") {
    log.error(
      "Capability issuance is unconfirmed; the store may have committed it. Do not automatically retry. No credential receipt was returned.",
    );
    log.error(`Reserved output retained: ${outcome.reservedOutput}`);
  } else if (outcome.kind === "revocation-unconfirmed") {
    log.error(
      `Capability revocation is unconfirmed; do not automatically retry: ${outcome.credentialId}`,
    );
  } else if (outcome.kind === "delivery-failed") {
    log.error(
      `Capability delivery failed; revocation ${outcome.revocation}: ${outcome.credentialId}`,
    );
  } else {
    log.error(
      "Local control command failed before the requested capability mutation was attempted.",
    );
  }
  for (const issue of result.cleanupIssues) {
    log.error(
      `Local control cleanup incomplete (${issue}); the reported business outcome is unchanged.`,
    );
  }
  return outcome.kind === "issued" || outcome.kind === "revoked" ? 0 : 1;
}
