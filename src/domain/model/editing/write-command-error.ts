export class ModelWriteCommandError extends Error {
  readonly recovery: "refuse";
  constructor(
    readonly code:
      | "WRITE_COMMAND_INVALID"
      | "WRITE_JOURNAL_INVALID"
      | "WRITE_DOSSIER_MISMATCH",
    readonly context: { readonly reason: string; readonly path?: string },
    message: string,
  ) {
    super(message);
    this.name = "ModelWriteCommandError";
    this.recovery = "refuse";
  }
}

export function invalid(
  code: ModelWriteCommandError["code"],
  reason: string,
  path?: string,
): never {
  throw new ModelWriteCommandError(
    code,
    path ? { reason, path } : { reason },
    path ? `${reason}: ${path}` : reason,
  );
}
