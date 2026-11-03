/** A local request preparation refusal: no provider dispatch has started. */
export class AgentPreparationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, string | number | boolean>,
    readonly recovery: string,
  ) {
    super(message);
    this.name = "AgentPreparationError";
  }
}
