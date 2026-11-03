import type { ModelPort } from "../../../runtime/ports.ts";

/** Conversation view of the model contract: source reads and
 * revision/edit/delegation proposals. The conversation family consumes the
 * model only through this out port and never reaches past it. */
export type ConversationModelPort = Pick<
  ModelPort,
  | "requestChangeScope"
  | "readSourceRevision"
  | "readSourceProposals"
  | "proposeRevision"
  | "proposeEdit"
  | "proposeDelegation"
>;
