/**
 * APE 5.1 Context Separation: bounded representation policy and evidence references;
 * this policy grants no authority.
 */
export interface DecisionContextPolicy {
  kind: "separated-context";
  pattern: "5.1";
  recentMessages: number;
  maxMessageCharacters: number;
  maxCollectionItems: number;
  /** JSON characters, never a claim about provider tokens or monetary cost. */
  maxContextCharacters: number;
}

/** Reject malformed policies rather than silently changing their meaning. */
export function validateContextPolicy(value: unknown): DecisionContextPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The native context policy must be an object.");
  }
  const policy = value as Record<string, unknown>;
  const keys = [
    "kind",
    "pattern",
    "recentMessages",
    "maxMessageCharacters",
    "maxCollectionItems",
    "maxContextCharacters",
  ];
  if (
    Object.keys(policy).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(policy, key)) ||
    policy.kind !== "separated-context" || policy.pattern !== "5.1"
  ) throw new Error("Unsupported native context policy.");
  for (
    const [key, minimum, maximum] of [
      ["recentMessages", 1, 100],
      ["maxMessageCharacters", 256, 100000],
      ["maxCollectionItems", 1, 128],
      ["maxContextCharacters", 4096, 2000000],
    ] as const
  ) {
    const setting = policy[key];
    if (
      typeof setting !== "number" || !Number.isSafeInteger(setting) ||
      setting < minimum || setting > maximum
    ) throw new Error(`Invalid native context policy value: ${key}.`);
  }
  return structuredClone(policy) as unknown as DecisionContextPolicy;
}
