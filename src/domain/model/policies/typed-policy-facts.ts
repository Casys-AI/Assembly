/** Converged native policy checks; callers retain their diagnostics and decoding. */
import type {
  ConnectorRecord,
  ElementRecord,
  ModelSnapshot,
} from "../records/snapshot.ts";
import type { NativeLiteral } from "../records/native-literal.ts";

/** Must throw when condition is false, preserving the caller's error type. */
type Check = (condition: unknown, message: string) => void;

const equal = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Bases must already have passed the caller's singleton scalar declaration check. */
export function typedPolicyLiterals(
  attribute: ElementRecord,
  base: ElementRecord,
  literal: NativeLiteral | undefined,
  scalar: string,
  uniqueLiteralId: boolean,
  literals: NativeLiteral[],
): boolean {
  return !!literal &&
    attribute.metaclass === "AttributeUsage" &&
    equal(attribute.redefinedIds, [base.id]) &&
    equal(attribute.typeIds, base.typeIds) &&
    literal.attributeId === attribute.id && !!literal.literalId &&
    (!uniqueLiteralId ||
      literals.filter((other) => other.literalId === literal.literalId)
          .length === 1) &&
    literal.kind === `Literal${scalar}` &&
    equal(literal.typeIds, base.typeIds) &&
    equal(literal.typeNames, [`ScalarValues::${scalar}`]);
}

/** Find the unique binding touching the exact occurrence feature path. */
export function findPolicyBinding(
  snapshot: ModelSnapshot,
  occurrenceId: string,
  featureId: string,
): ConnectorRecord | undefined {
  const touching = snapshot.connectors.filter((connector) =>
    connector.metaclass === "BindingConnectorAsUsage" &&
    connector.ends.some((end) =>
      equal(end.chain.map((part) => part.id), [occurrenceId, featureId])
    )
  );
  return touching.length === 1 ? touching[0] : undefined;
}

export function bindPolicyReferences(
  snapshot: ModelSnapshot,
  occurrenceId: string,
  featureId: string,
  ownerId: string,
  targetId: string,
  fail: Check,
  messages: { ambiguous: string; invalid: string },
): ConnectorRecord {
  const connector = findPolicyBinding(snapshot, occurrenceId, featureId);
  fail(connector, messages.ambiguous);
  fail(
    connector!.ownerId === ownerId && connector!.ends.length === 2 &&
      connector!.ends.some((end) =>
        equal(end.chain.map((part) => part.id), [targetId])
      ),
    messages.invalid,
  );
  return connector!;
}
