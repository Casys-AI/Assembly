import { act } from "preact/test-utils";
import {
  ProposalAdjustment,
  type ProposalDecision,
  type ProposalDecisionProps,
  useProposalDecision,
} from "../../components/conversations/ChatProposalCard.tsx";
import { probeRoot } from "./hook-probe.ts";
import { press } from "./press.ts";

/**
 * The adjustment flow of a proposal with its real hook and nothing to draw:
 * `flow()` is the latest render's, `form()` the markup of its field, and the
 * owner of the decision is whatever `props` hand the hook.
 */
export async function withAdjustment(
  props: ProposalDecisionProps,
  exercise: (adjustment: {
    flow(): ProposalDecision;
    form(): ReturnType<typeof press>;
    start(): Promise<void>;
    type(text: string): Promise<void>;
    send(): Promise<void>;
  }) => Promise<void>,
) {
  const probe = probeRoot();
  const frameBefore = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 0,
  });
  let flow!: ProposalDecision;
  function Probe() {
    flow = useProposalDecision(props);
    return null;
  }
  try {
    await probe.show(Probe, {});
    await exercise({
      flow: () => flow,
      form: () => press(<ProposalAdjustment id="p1" flow={flow} />),
      start: () => act(() => flow.startAdjusting()),
      type: (text) => act(() => flow.setAdjustment(text)),
      send: () => act(() => flow.requestAdjustment()),
    });
  } finally {
    await probe.restore();
    if (frameBefore) {
      Object.defineProperty(globalThis, "requestAnimationFrame", frameBefore);
    } else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  }
}
