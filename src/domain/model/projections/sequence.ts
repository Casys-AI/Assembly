import { persistedOrder } from "../../primitives/persisted-order.ts";
/** Read-only interaction projection from resolved native model references.
 * Action-flow successions are never turned into interaction messages. */
import type { SequenceData } from "../records/graph-sequence.ts";

type Native = Record<string, unknown>;
type Endpoint = {
  eventId: string;
  eventKey: string;
  lifelineId: string;
  sourceIds: string[];
};
type Message = NativeSequence["messages"][number];

export interface NativeSequence extends SequenceData {
  nativeId: string;
  /** A deterministic linearization of native constraints, never an execution trace. */
  ordering:
    | "native-partial-order"
    | "declaration"
    | "cyclic"
    | "non-linearizable";
  diagnostics: string[];
  sourceIds: string[];
  messages: Array<
    SequenceData["messages"][number] & {
      sourceEventId: string;
      targetEventId: string;
      sourceIds: string[];
    }
  >;
}

const str = (value: unknown): string => typeof value === "string" ? value : "";
const refs = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    entry && typeof entry === "object" &&
      typeof (entry as Native)["@id"] === "string"
      ? [(entry as Native)["@id"] as string]
      : []
  );
const id = (element: Native) => str(element["@id"]);
const meta = (element: Native) => str(element["@type"]);
const ownerId = (element: Native) => refs(element.owner)[0] ?? "";
const name = (element: Native) => str(element.declaredName);
const unique = (values: string[]) => [...new Set(values)];
const behavior = (element: Native) =>
  /(?:Action|State)(?:Definition|Usage)$/.test(meta(element));
const participant = (element: Native) =>
  ["PartUsage", "OccurrenceUsage", "ItemUsage"].includes(meta(element));
const container = (element: Native) =>
  ["OccurrenceDefinition", "OccurrenceUsage", "PartDefinition", "PartUsage"]
    .includes(meta(element));

/** Declaration coordinates only break ties where native successions are silent.
 * IDs provide a stable final tie-breaker; array iteration order is never authority. */
function declaredBefore(a: Native, b: Native): number {
  const source = persistedOrder(
    str(a["sysx:sourceDocument"]),
    str(b["sysx:sourceDocument"]),
  );
  if (source) return source;
  for (
    const field of ["sysx:sourceLine", "sysx:sourceColumn", "sysx:memberIndex"]
  ) {
    const left = typeof a[field] === "number" ? a[field] as number : 0;
    const right = typeof b[field] === "number" ? b[field] as number : 0;
    if (left !== right) return left - right;
  }
  return persistedOrder(id(a), id(b));
}

export function projectSourceSequences(elements: Native[]): {
  sequences: NativeSequence[];
  diagnostics: string[];
} {
  const byId = new Map(elements.map((element) => [id(element), element]));
  if (byId.size !== elements.length || byId.has("")) {
    throw new Error(
      "Sequence snapshot has missing or duplicate native identities",
    );
  }
  const children = new Map<string, Native[]>();
  for (const element of elements) {
    const owner = ownerId(element);
    children.set(owner, [...(children.get(owner) ?? []), element]);
  }
  for (const list of children.values()) list.sort(declaredBefore);
  const diagnostics: string[] = [];
  const sequences: NativeSequence[] = [];

  // Native feature chains retain their occurrence context; a display name is
  // never used to resolve either participant or event.
  function chain(
    elementId: string,
    sourceIds: Set<string>,
    seen = new Set<string>(),
  ): string[] {
    if (seen.has(elementId)) return [];
    seen.add(elementId);
    const element = byId.get(elementId);
    if (!element) return [];
    sourceIds.add(elementId);
    const chained = refs(element.chainingFeature);
    if (chained.length) {
      if (chained.some((part) => !byId.has(part))) return [];
      for (const part of chained) sourceIds.add(part);
      return chained;
    }
    const subsettings = refs(element.ownedReferenceSubsetting);
    if (subsettings.length === 1) {
      const relationship = byId.get(subsettings[0]);
      if (!relationship) return [];
      sourceIds.add(subsettings[0]);
      const target = unique([
        ...refs(relationship.referencedFeature),
        ...refs(relationship.target),
      ]);
      return target.length === 1 ? chain(target[0], sourceIds, seen) : [];
    }
    const redefinitions = refs(element.ownedRedefinition);
    if (redefinitions.length) {
      const targets: string[] = [];
      for (const relationshipId of redefinitions) {
        const relationship = byId.get(relationshipId);
        if (!relationship || meta(relationship) !== "Redefinition") return [];
        sourceIds.add(relationshipId);
        targets.push(...refs(relationship.redefinedFeature));
      }
      const targetsUnique = unique(targets);
      return targetsUnique.length === 1
        ? chain(targetsUnique[0], sourceIds, seen)
        : [];
    }
    const target = refs(element.eventOccurrence);
    if (target.length === 1 && target[0] !== elementId) {
      return chain(target[0], sourceIds, seen);
    }
    if (
      [
        "EventOccurrenceUsage",
        "OccurrenceUsage",
        "PartUsage",
        "PortUsage",
        "ItemUsage",
      ].includes(meta(element))
    ) {
      return [elementId];
    }
    return [];
  }

  for (const scope of elements.filter(container).sort(declaredBefore)) {
    const direct = children.get(id(scope)) ?? [];
    const lifelines = direct.filter(participant);
    if (!lifelines.length) continue;
    const lifelineIds = new Set(lifelines.map(id));
    const members: Native[] = [];
    const collect = (element: Native, visited = new Set<string>()): void => {
      if (visited.has(id(element))) return;
      visited.add(id(element));
      for (const child of children.get(id(element)) ?? []) {
        // A nested occurrence with its own messages has its own sequence. A
        // performed action's data flows belong to its action diagram.
        if (behavior(child)) continue;
        members.push(child);
        if (
          participant(child) &&
          (children.get(id(child)) ?? []).some(participant)
        ) continue;
        if (
          meta(child) !== "FlowUsage" && meta(child) !== "FlowConnectionUsage"
        ) collect(child, visited);
      }
    };
    collect(scope);
    const flows = members.filter((element) =>
      ["FlowUsage", "FlowConnectionUsage"].includes(meta(element))
    ).sort(declaredBefore);
    if (!flows.length) continue;
    const notices: string[] = [];
    const sourceIds = new Set([id(scope), ...lifelineIds]);

    const eventFacts = new Map<string, Native>();
    const endpoint = (featureId: string): Endpoint | undefined => {
      const evidence = new Set<string>();
      const path = chain(featureId, evidence);
      if (!path.length) return;
      const explicitLifelines = path.filter((part) => lifelineIds.has(part));
      let lifelineId = explicitLifelines.length === 1
        ? explicitLifelines[0]
        : "";
      if (explicitLifelines.length > 1) return;
      if (!lifelineId) {
        let current = byId.get(path[path.length - 1]);
        const visited = new Set<string>();
        while (current && !visited.has(id(current))) {
          visited.add(id(current));
          evidence.add(id(current));
          if (lifelineIds.has(id(current))) {
            lifelineId = id(current);
            break;
          }
          current = byId.get(ownerId(current));
        }
      }
      if (!lifelineId) return;
      // Keep a contextual event identity when two participants share a type.
      eventFacts.set(
        `${lifelineId}/${path[path.length - 1]}`,
        byId.get(path[path.length - 1])!,
      );
      return {
        eventId: path[path.length - 1],
        eventKey: `${lifelineId}/${path[path.length - 1]}`,
        lifelineId,
        sourceIds: [...evidence],
      };
    };

    const messages: Message[] = [];
    const messageEvents = new Map<string, [string, string]>();
    for (const flow of flows) {
      const sourceFeatures = refs(flow.sourceOutputFeature);
      const targetFeatures = refs(flow.targetInputFeature);
      const hasDirectedFeatures = sourceFeatures.length > 0 ||
        targetFeatures.length > 0;
      // Toolkit exposes directional FlowEnd payload features. Their explicit
      // redefinitions resolve the event identity; display labels never do.
      const directed =
        sourceFeatures.length === 1 && targetFeatures.length === 1
          ? [sourceFeatures[0], targetFeatures[0]]
          : [];
      const events = (hasDirectedFeatures ? directed : refs(flow.ownedFeature))
        .map((featureId) => byId.get(featureId))
        .filter((feature): feature is Native =>
          !!feature && (meta(feature) === "EventOccurrenceUsage" ||
            hasDirectedFeatures && meta(feature) === "ReferenceUsage")
        );
      if (
        hasDirectedFeatures && events.length === 2 &&
        (events[0].direction !== "out" || events[1].direction !== "in")
      ) {
        notices.push(
          `Native message ${
            id(flow)
          } has invalid directed event features; it is not drawn.`,
        );
        continue;
      }
      if (events.length !== 2) {
        notices.push(
          `Native message ${
            id(flow)
          } has no unique directed pair of event ends; it is not drawn.`,
        );
        continue;
      }
      const from = endpoint(id(events[0])), to = endpoint(id(events[1]));
      if (!from || !to) {
        notices.push(
          `Native message ${
            id(flow)
          } has an unresolved or off-scope participant; it is not drawn.`,
        );
        continue;
      }
      const payloads = refs(flow.ownedFeature).map((featureId) =>
        byId.get(featureId)
      )
        .filter((feature): feature is Native =>
          !!feature && meta(feature) === "PayloadFeature"
        );
      const payloadTypes = unique(
        payloads.flatMap((payload) => refs(payload.type)),
      );
      const payloadId = payloadTypes.length === 1 ? payloadTypes[0] : "";
      const payloadName = name(byId.get(payloadId) ?? {});
      const evidence = unique([
        id(flow),
        ...from.sourceIds,
        ...to.sourceIds,
        ...payloads.map(id),
        ...payloadTypes,
      ]);
      evidence.forEach((entry) => sourceIds.add(entry));
      messageEvents.set(id(flow), [from.eventKey, to.eventKey]);
      messages.push({
        id: id(flow),
        name: name(flow) || payloadName || meta(flow),
        from: from.lifelineId,
        to: to.lifelineId,
        payloadId,
        payloadName,
        sourceEventId: from.eventId,
        targetEventId: to.eventId,
        sourceIds: evidence,
      });
    }

    const eventOrder: Array<[string, string]> = [...messageEvents.values()];
    let declaredOrders = 0;
    let selfOrder = false;
    for (
      const succession of members.filter((element) =>
        meta(element) === "SuccessionAsUsage"
      )
    ) {
      let fromIds = refs(succession.sourceFeature),
        toIds = refs(succession.targetFeature);
      const connectorEnds = refs(succession.connectorEnd);
      if (!fromIds.length && !toIds.length && connectorEnds.length === 2) {
        fromIds = [connectorEnds[0]];
        toIds = [connectorEnds[1]];
      }
      if (fromIds.length !== 1 || toIds.length !== 1) {
        notices.push(
          `Native succession ${
            id(succession)
          } has no unique event order; it is not applied.`,
        );
        continue;
      }
      const from = endpoint(fromIds[0]), to = endpoint(toIds[0]);
      if (!from || !to) {
        notices.push(
          `Native succession ${
            id(succession)
          } has an unresolved or off-scope event; it is not applied.`,
        );
        continue;
      }
      if (from.eventKey === to.eventKey) selfOrder = true;
      eventOrder.push([from.eventKey, to.eventKey]);
      sourceIds.add(id(succession));
      [...from.sourceIds, ...to.sourceIds].forEach((entry) =>
        sourceIds.add(entry)
      );
      declaredOrders++;
    }
    const eventIds = unique(eventOrder.flat()).sort((a, b) =>
      declaredBefore(eventFacts.get(a)!, eventFacts.get(b)!) ||
      persistedOrder(a, b)
    );
    const later = new Map(
      eventIds.map((eventId) => [eventId, new Set<string>()]),
    );
    const indegree = new Map(eventIds.map((eventId) => [eventId, 0]));
    for (const [from, to] of eventOrder) {
      if (from === to || later.get(from)!.has(to)) continue;
      later.get(from)!.add(to);
      indegree.set(to, indegree.get(to)! + 1);
    }
    const rank = new Map<string, number>();
    while (rank.size < eventIds.length) {
      const next = eventIds.find((eventId) =>
        !rank.has(eventId) && indegree.get(eventId) === 0
      );
      if (!next) break;
      rank.set(next, rank.size);
      for (const after of later.get(next)!) {
        indegree.set(after, indegree.get(after)! - 1);
      }
    }
    const cyclic = selfOrder || rank.size !== eventIds.length;
    // A one-row message renderer collapses send and receive into one item.
    // Its order must respect BOTH ends; sorting solely by reception can reverse
    // an explicitly declared emission order for asynchronous messages.
    const eventMessages = new Map<string, Set<string>>();
    for (const [messageId, events] of messageEvents) {
      for (const eventId of events) {
        const owners = eventMessages.get(eventId) ?? new Set<string>();
        owners.add(messageId);
        eventMessages.set(eventId, owners);
      }
    }
    const messageLater = new Map(
      messages.map((message) => [message.id, new Set<string>()]),
    );
    const messageIndegree = new Map(messages.map((message) => [message.id, 0]));
    if (!cyclic) {
      for (const message of messages) {
        const visited = new Set<string>();
        const pending = [...messageEvents.get(message.id)!].flatMap((
          eventId,
        ) => [...later.get(eventId)!]);
        while (pending.length) {
          const eventId = pending.pop()!;
          if (visited.has(eventId)) continue;
          visited.add(eventId);
          const otherMessages = [...(eventMessages.get(eventId) ?? [])].filter((
            other,
          ) => other !== message.id);
          if (otherMessages.length) {
            for (const other of otherMessages) {
              if (!messageLater.get(message.id)!.has(other)) {
                messageLater.get(message.id)!.add(other);
                messageIndegree.set(other, messageIndegree.get(other)! + 1);
              }
            }
          } else pending.push(...later.get(eventId)!);
        }
      }
    }
    const orderedMessages: Message[] = [];
    const consumed = new Set<string>();
    if (!cyclic) {
      while (orderedMessages.length < messages.length) {
        const next = messages.find((message) =>
          !consumed.has(message.id) && messageIndegree.get(message.id) === 0
        );
        if (!next) break;
        consumed.add(next.id);
        orderedMessages.push(next);
        for (const after of messageLater.get(next.id)!) {
          messageIndegree.set(after, messageIndegree.get(after)! - 1);
        }
      }
    }
    const nonLinearizable = !cyclic &&
      orderedMessages.length !== messages.length;
    if (cyclic) {
      notices.push(
        `Native sequence ${
          id(scope)
        } has a succession cycle; declaration order is retained as records, not a valid chronology.`,
      );
    } else if (nonLinearizable) {
      notices.push(
        `Native sequence ${
          id(scope)
        } has asynchronous send/receive orders that cannot be linearized into one row per message. Records are retained in declaration order, without asserting a chronology.`,
      );
    } else messages.splice(0, messages.length, ...orderedMessages);
    const documentation = direct.filter((entry) =>
      meta(entry) === "Documentation"
    )
      .map((entry) => str(entry.body)).join("\n");
    sequences.push({
      id: id(scope),
      nativeId: id(scope),
      name: name(scope) || str(scope.qualifiedName) || meta(scope),
      qualifiedName: str(scope.qualifiedName),
      doc: documentation,
      ordering: cyclic
        ? "cyclic"
        : nonLinearizable
        ? "non-linearizable"
        : declaredOrders
        ? "native-partial-order"
        : "declaration",
      diagnostics: notices,
      sourceIds: [...sourceIds],
      lifelines: lifelines.map((line) => {
        const types = refs(line.type),
          typeId = types.length === 1 ? types[0] : "";
        return {
          id: id(line),
          name: name(line) || meta(line),
          typeId,
          typeName: name(byId.get(typeId) ?? {}),
        };
      }),
      messages,
    });
    diagnostics.push(...notices);
  }
  if (!sequences.length) {
    diagnostics.push(
      "Aucune interaction native avec des messages dirigés n’est déclarée. Les flux d’actions ne sont pas des séquences d’échanges.",
    );
  }
  return { sequences, diagnostics };
}
