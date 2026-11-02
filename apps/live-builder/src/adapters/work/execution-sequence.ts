/** Project persisted observations, without turning host events into messages. */
import type { SequenceData } from "../../domain/model/records/graph-sequence.ts";
import type {
  Event,
  Message,
  SystemRuntimeState,
} from "../../domain/work/dialogue.ts";
import type { SourceGraph } from "../model/projections/graph/source.ts";

interface ObservedSequence extends SequenceData {
  origin: "observed";
  revision: number;
  busy: boolean;
  phase: string;
  lastActivityAt?: string;
  total: number;
  omitted: number;
  limit: 150;
  diagnostics: string[];
  lifelines: Array<
    SequenceData["lifelines"][number] & {
      origin: "native" | "host" | "external";
      nativeId?: string;
    }
  >;
  messages: Array<
    SequenceData["messages"][number] & {
      kind: "message" | "event";
      caseId?: string;
      at: string;
      recordId: string;
      sourceEventId?: string;
      eventKind?: string;
      actionId?: string;
      modelDigest?: string;
      repositoryVersion?: string;
      evidence: {
        messageId?: string;
        eventId?: string;
        nativeSourceIds: string[];
        sourceContextCount: number;
      };
    }
  >;
}

const LIMIT = 150;
const observedFlowKinds = new Set([
  "flow-action",
  "flow-suspended",
  "flow-completed",
]);

export function projectExecutionSequence(
  state: SystemRuntimeState,
  _graph: SourceGraph,
): ObservedSequence {
  const diagnostics = new Set<string>();
  const lifelines = new Map<string, ObservedSequence["lifelines"][number]>();
  const hostId = `observed:${state.id}:host`;
  const userId = `observed:${state.id}:user`;
  const model = state.executionModel;
  const digest = model?.version.digest;
  const builderId = model?.identity.builderId;
  const nodes = model
    ? [...model.flows.conversation.nodes, ...model.flows.promotion.nodes]
    : [];
  const technicalLine = (
    id: string,
    name: string,
    origin: "host" | "external",
  ): string => {
    lifelines.set(id, { id, name, typeId: "", typeName: "", origin });
    return id;
  };
  const host = () => technicalLine(hostId, "Hôte Assembly", "host");
  const user = () => technicalLine(userId, "Utilisateur", "external");
  // Labels come from the admitted contract, not the currently accepted graph:
  // design may have advanced while execution remains on an older contract.
  const admittedRoles = new Map<string, string>();
  if (model) {
    admittedRoles.set(model.identity.builderId, "Constructeur");
    admittedRoles.set(model.identity.catalogId, "Catalogue");
    if (model.identity.reviewerId && model.configuration.reviewer) {
      admittedRoles.set(
        model.identity.reviewerId,
        model.configuration.reviewer.name,
      );
    }
    for (const node of nodes) {
      if (node.performerId && !admittedRoles.has(node.performerId)) {
        admittedRoles.set(node.performerId, `Opérateur · ${node.name}`);
      }
    }
  }
  const nativeLine = (nativeId: string): string => {
    lifelines.set(nativeId, {
      id: nativeId,
      nativeId,
      name: admittedRoles.get(nativeId) || nativeId,
      typeId: "",
      typeName: "",
      origin: "native",
    });
    return nativeId;
  };
  const builder = (recordDigest?: string): string => {
    if (builderId && digest && recordDigest === digest) {
      return nativeLine(builderId);
    }
    diagnostics.add(
      "Certains messages n’ont pas de contrat courant identifiable ; leur constructeur est présenté comme un rôle de conversation, sans nom SysML courant.",
    );
    return technicalLine(
      `observed:${state.id}:builder:${recordDigest ?? "unversioned"}`,
      "Constructeur · référence historique",
      "host",
    );
  };

  type RecordEntry =
    | { kind: "message"; value: Message; index: number }
    | { kind: "event"; value: Event; index: number };
  const records: RecordEntry[] = [
    ...state.messages.map((value, index): RecordEntry => ({
      kind: "message",
      value,
      index,
    })),
    ...state.events.filter((event) =>
      !event.kind.startsWith("flow-") || observedFlowKinds.has(event.kind)
    ).map((value, index): RecordEntry => ({
      kind: "event",
      value,
      index: state.messages.length + index,
    })),
  ];
  const timestamp = (record: RecordEntry): number => {
    const at = Date.parse(record.value.at);
    if (!Number.isFinite(at)) {
      diagnostics.add(
        `L’horodatage du reçu ${record.value.id} est invalide ; il est conservé après les reçus datés.`,
      );
      return Number.POSITIVE_INFINITY;
    }
    return at;
  };
  records.sort((a, b) => timestamp(a) - timestamp(b) || a.index - b.index);
  const selected = records.slice(-LIMIT);
  const messages = selected.map(
    (record): ObservedSequence["messages"][number] => {
      const value = record.value;
      const modelDigest = value.execution?.digest;
      const common = {
        id: `${record.kind}:${value.id}`,
        ...(value.caseId ? { caseId: value.caseId } : {}),
        at: value.at,
        recordId: value.id,
        modelDigest,
        actionId: value.execution?.actionId,
        repositoryVersion: value.execution?.repositoryVersion,
        payloadId: "",
        payloadName: "",
      };
      if (record.kind === "message") {
        const message = record.value;
        const operator = builder(modelDigest);
        return {
          ...common,
          kind: "message",
          name: message.text,
          from: message.role === "user"
            ? user()
            : message.role === "tool"
            ? host()
            : operator,
          to: message.role === "assistant" ? user() : operator,
          evidence: {
            messageId: message.id,
            nativeSourceIds: [
              ...new Set([
                ...(message.execution?.actionId
                  ? [message.execution.actionId]
                  : []),
                ...(modelDigest && modelDigest === digest && builderId
                  ? [builderId]
                  : []),
              ]),
            ],
            sourceContextCount: message.execution?.sourceIds?.length ?? 0,
          },
        };
      }
      const event = record.value;
      const actionId = event.execution?.actionId;
      let participant = host();
      let actionName = "";
      const nativeSourceIds = [
        ...(actionId ? [actionId] : []),
        ...(event.elementId ? [event.elementId] : []),
      ];
      if (actionId) {
        if (!digest || modelDigest !== digest) {
          diagnostics.add(
            `L’action du reçu ${event.id} appartient à un autre contrat ; son acteur courant n’est pas déduit.`,
          );
        } else {
          const matches = nodes.filter((node) => node.nativeId === actionId);
          if (matches.length === 1) {
            const action = matches[0];
            actionName = action.name;
            nativeSourceIds.push(action.nativeId);
            if (action.allocationId) nativeSourceIds.push(action.allocationId);
            if (action.performerId) {
              participant = nativeLine(action.performerId);
              nativeSourceIds.push(action.performerId);
            }
          } else {
            diagnostics.add(
              `L’action native ${actionId} du reçu ${event.id} n’est pas résolue de façon unique.`,
            );
          }
        }
      }
      return {
        ...common,
        kind: "event",
        eventKind: event.kind,
        sourceEventId: event.id,
        name: event.label + (actionName ? ` · ${actionName}` : ""),
        from: participant,
        to: participant,
        evidence: {
          eventId: event.id,
          nativeSourceIds: [...new Set(nativeSourceIds)],
          sourceContextCount: event.execution?.sourceIds?.length ?? 0,
        },
      };
    },
  );
  const lastActivityAt = [...records].reverse().find((record) =>
    Number.isFinite(Date.parse(record.value.at))
  )?.value.at;
  return {
    id: `observed:${state.id}`,
    origin: "observed",
    name: "Activité réelle du système",
    qualifiedName: `session:${state.id}`,
    doc:
      "Messages et événements du journal enregistré. Les flèches représentent les messages conservés ; les notes représentent des événements observés, sans inventer d’échanges entre composants.",
    revision: state.revision,
    busy: state.busy,
    phase: state.phase,
    lastActivityAt,
    total: records.length,
    omitted: Math.max(0, records.length - LIMIT),
    limit: LIMIT,
    diagnostics: [...diagnostics],
    lifelines: [...lifelines.values()],
    messages,
  };
}
