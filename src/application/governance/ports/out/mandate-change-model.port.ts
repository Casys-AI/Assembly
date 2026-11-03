import type { ModelPort } from "../../../work/runtime/ports.ts";

/** Model surface consumed by the mandate-change decisions family.
 *
 * Split of `ModelPort` per consuming handler: publication recovery,
 * preview, application and executable readback. Full `ModelPort`
 * implementations stay assignable to this narrow contract.
 */
export type MandateChangeModelPort = Pick<
  ModelPort,
  | "requestChangeScope"
  | "applyApprovedChange"
  | "readExecutableModel"
  | "findApprovedChange"
  | "previewApprovedChange"
>;
