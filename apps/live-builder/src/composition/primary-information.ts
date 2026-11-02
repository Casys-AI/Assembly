import type { DecisionInformationPort } from "../application/work/context/information-ports.ts";

/** Main is created before its workspace. Resolve the same authorized workspace
 * at call time; missing readers remain unavailable, never another read mode. */
export function primaryInformationPort(
  resolve: () => DecisionInformationPort | undefined,
): DecisionInformationPort {
  return {
    modelTools: (model) => resolve()?.modelTools?.(model) ?? [],
    async read(model, messages) {
      const reader = resolve();
      if (!reader) throw new Error("Operator information is not ready");
      return await reader.read(model, messages);
    },
    async consultModel(model, input, messages, budget) {
      const reader = resolve();
      if (!reader?.consultModel) {
        throw new Error("Model consultation is not ready");
      }
      return await reader.consultModel(model, input, messages, budget);
    },
    async consultAdmittedModelSource(model, input, messages, budget) {
      const reader = resolve();
      if (!reader?.consultAdmittedModelSource) {
        throw new Error("Admitted model consultation is not ready");
      }
      return await reader.consultAdmittedModelSource(
        model,
        input,
        messages,
        budget,
      );
    },
  };
}
