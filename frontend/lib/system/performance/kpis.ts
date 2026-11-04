import type {
  ObservedResourceAmount,
  ProviderResourceReadout,
  ProviderTokenSummary,
} from "../../../../src/application/telemetry/provider-resource-readout.ts";
import { type CaseRecord, timeLabel } from "../../cases/cases.ts";
import { compact } from "../board/words.ts";
import type { PerformanceState } from "./store.ts";

/**
 * The KPIs of one scope as the person reads them. A KPI that cannot be
 * computed for the scope is absent; one that is defined but lacks data says
 * N/A, with the reason in its hint. N/A is never zero.
 */
export interface KpiFigure {
  readonly state: "value" | "na";
  readonly text: string;
  /** The rail's form of a large number. */
  readonly short?: string;
  readonly sub?: string;
  readonly hint: string;
}
export interface FactFigure extends KpiFigure {
  readonly label: string;
}
export interface AgentRow {
  readonly key: string;
  readonly name: string;
  /** The Team agent, when the board names the operator. */
  readonly agentId?: string;
  /** Why the operator has no name. */
  readonly hint?: string;
  readonly calls: number;
  readonly tokens: KpiFigure;
  readonly perCall: KpiFigure;
  readonly cache: KpiFigure;
}
export interface PerformanceView {
  readonly duration?: KpiFigure;
  readonly tokens?: KpiFigure;
  /** Present instead of the measurements while they are read or refused. */
  readonly unavailable?: { readonly text: string; readonly hint?: string };
  readonly facts: readonly FactFigure[];
  readonly agents?: readonly AgentRow[];
  readonly details?: {
    readonly note: string;
    readonly rows: readonly {
      readonly label: string;
      readonly text: string;
      readonly title?: string;
    }[];
  };
}
/** A Request is judged and timed; Main only consumes. */
export type PerformanceScope =
  | { readonly kind: "main" }
  | { readonly kind: "request"; readonly record: CaseRecord | null };
export type AgentOf = (
  operatorId: string,
) => { readonly id: string; readonly name: string } | undefined;

const number = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 0 });
// A share that rounds to zero without being zero is not shown as zero.
const percent = (share: number) =>
  share > 0 && share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`;
const calls = (count: number) =>
  `${number(count)} ${count === 1 ? "call" : "calls"}`;
const na = (hint: string): KpiFigure => ({ state: "na", text: "N/A", hint });

/**
 * 559000 as "9 min 19 s"; 42000 as "42 s"; 3900000 as "1 h 5 min". A span of
 * work reads in whole units, unlike a model figure's `duration` ("9.32 min").
 */
export function elapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

const TOKEN_UNITS = [
  ["input_tokens", "Input"],
  ["output_tokens", "Output"],
  ["cache_creation_input_tokens", "Cache write"],
  ["cache_read_input_tokens", "Cache read"],
] as const;

function amount(value: ObservedResourceAmount): string {
  if (value.observedSubtotal === null) {
    return value.state === "overflow" ? "N/A (too large)" : "N/A";
  }
  const text = number(value.observedSubtotal);
  return value.state === "partial"
    ? `${text} (${value.missingCalls} missing)`
    : text;
}

/** Why a token summary is null although calls exist. */
function missingUsage(
  units: ProviderResourceReadout["units"],
  count: number,
): string {
  const missing = Math.max(
    ...TOKEN_UNITS.map(([unit]) => units[unit].missingCalls),
  );
  return missing === 0
    ? "Too large to add up."
    : `Usage missing for ${missing} of ${calls(count)}.`;
}

interface Consumption {
  readonly calls: number;
  readonly units: ProviderResourceReadout["units"];
  readonly tokenSummary: ProviderTokenSummary;
}

function cacheOf(part: Consumption): KpiFigure {
  const share = part.tokenSummary.cacheReadShare;
  if (share !== null) {
    return {
      state: "value",
      text: percent(share),
      hint: "Input tokens read from the cache.",
    };
  }
  return na(
    part.calls === 0
      ? "No calls."
      : part.tokenSummary.total === null
      ? missingUsage(part.units, part.calls)
      : "No input tokens.",
  );
}

function tokensOf(part: Consumption, subject: string): KpiFigure {
  const { total, meanPerCall, cacheReadShare } = part.tokenSummary;
  if (part.calls === 0) {
    return {
      state: "value",
      text: "0",
      short: "0",
      sub: "no calls",
      hint: `No calls recorded for ${subject}.`,
    };
  }
  if (total === null) return na(missingUsage(part.units, part.calls));
  return {
    state: "value",
    text: number(total),
    short: compact(total),
    sub: `${calls(part.calls)} · ${number(meanPerCall!)} per call`,
    hint: `${number(total)} tokens over ${calls(part.calls)}${
      cacheReadShare === null ? "" : `, ${percent(cacheReadShare)} from cache`
    }. Calls not linked to ${subject} are not counted.`,
  };
}

function durationOf(ms: number | null, record: CaseRecord | null): KpiFigure {
  if (ms === null) return na("Measured at closing.");
  return {
    state: "value",
    text: elapsed(ms),
    hint: record?.closedAt
      ? `Opened ${timeLabel(record.createdAt)} → closed ${
        timeLabel(record.closedAt)
      }.`
      : "From opening to closing.",
  };
}

const UNAVAILABLE: Record<
  Exclude<PerformanceState["status"], "ready">,
  { text: string; hint?: string }
> = {
  loading: { text: "Reading measurements…" },
  "connection-required": {
    text: "Measurements unavailable",
    hint:
      "A current authorized local session is required. Import a local control file in Requests.",
  },
  "version-unavailable": {
    text: "Measurements unavailable",
    hint: "Measurements for this inspected version are unavailable.",
  },
  unavailable: {
    text: "Measurements unavailable",
    hint: "Measurements could not be read.",
  },
};

function agentRows(
  groups: NonNullable<ProviderResourceReadout["operatorGroups"]>,
  agentOf: AgentOf,
): AgentRow[] {
  return groups.map((group): AgentRow => {
    const id = group.operatorId;
    const agent = id === null ? undefined : agentOf(id);
    const { total, meanPerCall } = group.tokenSummary;
    // A group always has calls: a missing total is missing usage.
    const tokens: KpiFigure = total === null
      ? na(missingUsage(group.units, group.calls))
      : {
        state: "value",
        text: number(total),
        hint: TOKEN_UNITS.map(([unit, label]) =>
          `${label} ${amount(group.units[unit])}`
        ).join(" · "),
      };
    return {
      key: id === null ? "n:" : `s:${id}`,
      name: agent?.name ?? (id === null ? "Unattributed" : "Former member"),
      ...(agent ? { agentId: agent.id } : {
        hint: id === null
          ? "Calls without an agent link."
          : `Not in the team at this version · ${id}`,
      }),
      calls: group.calls,
      tokens,
      perCall: meanPerCall === null ? na(tokens.hint) : {
        state: "value",
        text: number(meanPerCall),
        hint: "Tokens per call.",
      },
      cache: cacheOf(group),
    };
  }).sort((a, b) => b.calls - a.calls);
}

/** The view of one scope's KPIs: the Request's lifecycle and its readout. */
export function performanceView(
  { read, scope, agentOf = () => undefined }: {
    read: PerformanceState;
    scope: PerformanceScope;
    agentOf?: AgentOf;
  },
): PerformanceView {
  const record = scope.kind === "request" ? scope.record : null;
  if (read.status !== "ready") {
    return { unavailable: UNAVAILABLE[read.status], facts: [] };
  }
  // The store sets a readout with every ready state.
  const readout = read.readout!;
  const subject = scope.kind === "request" ? "this Request" : "the Main";
  const resources = readout.resources;
  const consumption: Consumption = {
    calls: resources.calls,
    units: resources.units,
    // The browser reader always supplies the summary it checked.
    tokenSummary: resources.tokenSummary!,
  };
  const request = readout.request;
  const failed = resources.outcomes.failed + resources.outcomes["timed-out"];
  const facts: FactFigure[] = [
    { ...cacheOf(consumption), label: "from cache" },
    {
      state: "value",
      text: number(failed),
      label: failed === 1 ? "failed call" : "failed calls",
      hint: `Failed or timed out · cancelled: ${
        number(resources.outcomes.cancelled)
      }.`,
    },
  ];
  if (request) {
    const { messages, decisions } = request.humanInterventions;
    facts.push({
      state: "value",
      text: number(messages),
      label: messages === 1 ? "your message" : "your messages",
      hint: "Messages you sent after the opening one.",
    }, {
      state: "value",
      text: number(decisions),
      label: decisions === 1 ? "your decision" : "your decisions",
      hint: "Cards you accepted or refused.",
    });
  }
  const version = readout.execution.modelVersion.repositoryVersion;
  const elapsedMs = resources.providerElapsedMs.observedSubtotal;
  return {
    ...(request ? { duration: durationOf(request.durationMs, record) } : {}),
    tokens: tokensOf(consumption, subject),
    facts,
    ...(resources.operatorGroups
      ? { agents: agentRows(resources.operatorGroups, agentOf) }
      : {}),
    details: {
      note:
        `Totals are a minimum: calls not linked to ${subject} are not counted.`,
      rows: [
        {
          label: "Tokens",
          text: TOKEN_UNITS.map(([unit, label]) =>
            `${label} ${amount(resources.units[unit])}`
          ).join(" · "),
        },
        {
          label: "Provider time",
          text: elapsedMs === null
            ? "N/A"
            : `${
              (elapsedMs / 1000).toLocaleString("en-US", {
                maximumFractionDigits: 1,
              })
            } s summed; calls can overlap`,
        },
        {
          label: "Model",
          text: `${version.slice(7, 14)} · read ${timeLabel(resources.readAt)}`,
          title: version,
        },
      ],
    },
  };
}
