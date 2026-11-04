import type { NativeModelEditPolicy } from "../../../../src/domain/model/execution/native-contracts.ts";
import type { ModelAdministrationAuthority } from "../../../../src/domain/governance/policies/model-delegation.ts";
import type { OperatorAuthorityPolicy } from "../../../../src/domain/governance/policies/operator-authority-policy.ts";
import type { ToolAdmissionPolicy } from "../../../../src/domain/governance/policies/tool-admission-policy.ts";
import type { ModelProposalAuthorization } from "../../../../src/domain/governance/records/model-edit-authorization.ts";
import type {
  ModelChangedFile,
  ModelCommitAuthor,
  ModelFileLastChange,
} from "../../../../src/domain/model/records/revision.ts";
import { html } from "diff2html";
import { modelHref } from "../../workbench/desk.ts";
import { isRecord } from "../../transport/is-record.ts";
import { PLACE_PATH, placeOfPath } from "../../workbench/view-location.ts";

/** These are source repository identities, not application revision numbers. */
export interface SourceCommit {
  version: string;
  parentVersion?: string;
  parents: string[];
  author: string;
  message: string;
  createdAt: string;
  sourceDigest: string;
  /** The host's reading of `author` (kind and reference): never parsed again. */
  parsedAuthor: ModelCommitAuthor;
  /** What the commit changed against its first parent, as Git counted it. */
  files: ModelChangedFile[];
  additions: number;
  deletions: number;
  /** The proposal this commit is the acceptance of, when the journal says so. */
  proposalId?: string;
}
export interface SourceProposal {
  id: string;
  author: string;
  /** Proposal workspace branch when supplied by the source repository. */
  branch?: string;
  authorization?: ModelProposalAuthorization;
  reason: string;
  baseVersion: string;
  createdAt: string;
  status: "preparing" | "proposed" | "accepting" | "accepted" | "rejected";
  sourceDigest: string;
  proposalVersion?: string;
  acceptedVersion?: string;
  rejectionReason?: string;
}
export interface ExecutionVersion {
  digest: string;
  repositoryVersion?: string;
}
export interface SourceRevisions {
  agentId?: string;
  version: string;
  sourceDigest: string;
  proposals: SourceProposal[];
  runtime: {
    available: ExecutionVersion | null;
    active: ExecutionVersion | null;
    executable: boolean;
    error?: string;
    /** Rights compiled from current admitted sources, independent of the runtime pin. */
    sourceRights?: {
      modelEditPolicy: NativeModelEditPolicy | null;
      modelAdministration: ModelAdministrationAuthority | null;
      operatorAuthorityPolicies?: OperatorAuthorityPolicy[];
      toolAdmissionPolicies?: ToolAdmissionPolicy[];
    };
  };
}
export interface RuntimeOperator {
  nativeId: string;
  name: string;
  primary: boolean;
  /** Running now: the host refuses to put a model in service meanwhile. */
  busy?: boolean;
}
export type RuntimeRevisionSnapshot =
  & Pick<
    SourceRevisions,
    "version" | "runtime"
  >
  & { agentId: string };
export interface RuntimeAdoption {
  expectedDigest: string;
  expectedVersion: string;
  agentId: string;
}
/** A removed explicit selection must not silently address the primary operator. */
export function selectedRuntimeOperator(
  operators: readonly RuntimeOperator[],
  nativeId?: string,
): RuntimeOperator | undefined {
  return nativeId === undefined
    ? operators.find((operator) => operator.primary)
    : operators.find((operator) => operator.nativeId === nativeId);
}
export function runtimeAdoption(
  agentId: string,
  runtime: SourceRevisions["runtime"],
): RuntimeAdoption | undefined {
  return runtime.executable && runtime.available?.repositoryVersion &&
      runtime.active?.digest !== runtime.available.digest
    ? {
      agentId,
      expectedDigest: runtime.available.digest,
      expectedVersion: runtime.available.repositoryVersion,
    }
    : undefined;
}
export interface SourceHistory {
  headVersion: string;
  commits: SourceCommit[];
  truncated: boolean;
}
export interface RevisionSnapshot {
  revisions: SourceRevisions;
  history: SourceHistory;
}
export interface SourceDiff {
  fromVersion: string | null;
  toVersion: string;
  fromSourceDigest: string | null;
  toSourceDigest: string;
  patch: string;
  files: {
    path: string;
    kind: "added" | "changed" | "deleted";
    additions: number;
    deletions: number;
  }[];
  additions: number;
  deletions: number;
}
/** The files of one version of the model, each with the commit that last changed it. */
export interface ModelFileList {
  /** The immutable commit the list describes: the head when none was asked for. */
  version: string;
  files: ModelFileLastChange[];
}
/** The sources of one immutable version, by logical path (`a.sysml`, never `sources/a.sysml`). */
export interface ModelSourceTree {
  version: string;
  sourceDigest: string;
  sources: Record<string, string>;
}
export interface GraphDiffChange {
  id: string;
  nativeId: string;
  kind: "added" | "removed" | "changed";
  category: "element" | "relationship" | "endpoint";
  metaclass: string;
  label?: string;
  qualifiedName?: string;
  fields: { field: string; before?: unknown; after?: unknown }[];
}
export interface GraphDiff {
  fromVersion: string | null;
  toVersion: string;
  engine: "Git";
  changes: GraphDiffChange[];
  counts: { added: number; removed: number; changed: number };
  truncated: boolean;
}
export type RevisionDiffKind = "graph" | "source";
export type RevisionSelection = { kind: "commit" | "proposal"; id: string };
export type DiffMode = "line-by-line" | "side-by-side";
export interface RevisionInspection {
  selection?: RevisionSelection;
  base?: string;
}
export interface RevisionLocation {
  pathname: string;
  search: string;
}

/** The address of a revision: the one builder of `?commit=` and `?proposal=`. */
export function revisionInspectionHref(inspection: RevisionInspection): string {
  return modelHref("revisions", {
    ...(inspection.selection && {
      [inspection.selection.kind]: inspection.selection.id,
    }),
    from: inspection.base || undefined,
  });
}

/** Fresh 2.3.3 appends GET fields to the partial fetch URL, but records the
 * form's action URL in browser history. Keep that native action complete too. */
export function revisionComparisonAction(fields: FormData): string {
  const params = new URLSearchParams();
  for (const [name, value] of fields) {
    if (typeof value === "string") params.append(name, value);
  }
  return `${PLACE_PATH.model}?${params}`;
}

/** Explicit history URLs restore their exact inspection. Returning through the
 * rail's bare Model URL restores the mounted view's previous inspection.
 * Changes in another view must neither clear this state nor rewrite its URL. */
export function synchronizeRevisionLocation(
  current: RevisionInspection,
  location: RevisionLocation,
  snapshot?: RevisionSnapshot,
): { inspection: RevisionInspection } {
  if (placeOfPath(location.pathname) !== "model") {
    return { inspection: current };
  }
  const params = new URLSearchParams(location.search);
  const proposal = params.get("proposal"), commit = params.get("commit");
  if (proposal || commit) {
    return {
      inspection: {
        selection: proposal
          ? { kind: "proposal", id: proposal }
          : { kind: "commit", id: commit! },
        base: params.get("from") || undefined,
      },
    };
  }
  const selection = current.selection ??
    (snapshot
      ? { kind: "commit" as const, id: snapshot.revisions.version }
      : undefined);
  const item = snapshot && selectedRevision(snapshot, selection);
  const inspection = {
    selection,
    base: params.get("from") || current.base ||
      (selection && item ? selectionBase(selection, item) : undefined),
  };
  return { inspection };
}

/** What the host says of a failure when it answers in its envelope `{code, context, recovery}`. */
export interface HostFacts {
  /** The host's own code, as it gave it. */
  code?: string;
  /** What the host says to do about it. */
  recovery?: string;
  /** Seconds the host asks to wait before the request is made again. */
  retryAfter?: number;
}

/**
 * The host answered with a failure: its status, its own text as said, and,
 * when it spoke in its envelope, its code, its recovery and how long to wait.
 */
export class RevisionRequestError extends Error implements HostFacts {
  readonly code?: string;
  readonly recovery?: string;
  readonly retryAfter?: number;
  constructor(
    message: string,
    readonly status: number,
    facts: HostFacts = {},
  ) {
    super(message);
    this.name = "RevisionRequestError";
    if (facts.code !== undefined) this.code = facts.code;
    if (facts.recovery !== undefined) this.recovery = facts.recovery;
    if (facts.retryAfter !== undefined) this.retryAfter = facts.retryAfter;
  }
}

const said = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/**
 * The one reading of a failed response: the older routes say `error`, the
 * versioned ones `{code, context: {message}, recovery}`, and a host that
 * asks to wait says so in `Retry-After`. What the body does not say is absent.
 */
export function requestFailure(
  response: Pick<Response, "status" | "headers">,
  body: unknown,
): RevisionRequestError {
  const envelope = isRecord(body) ? body : {};
  const context = isRecord(envelope.context) ? envelope.context : {};
  const wait = Number(response.headers.get("retry-after"));
  const code = said(envelope.code), recovery = said(envelope.recovery);
  return new RevisionRequestError(
    said(envelope.error) ?? said(context.message) ?? "The request failed.",
    response.status,
    {
      ...(code ? { code } : {}),
      ...(recovery ? { recovery } : {}),
      ...(Number.isFinite(wait) && wait > 0 ? { retryAfter: wait } : {}),
    },
  );
}

/**
 * What went wrong, for a program to act on (`code`, one of the page's own
 * closed set) and for the person (`message`). `status` and `detail` are what
 * the host answered, when it did.
 */
export interface CodedProblem<Code extends string = string> {
  code: Code;
  /** The HTTP status, when the host answered. */
  status?: number;
  message: string;
  /** What the host said, as it said it. */
  detail?: string;
}

/** The one way a page turns a failed request into a coded problem. */
export function problemOf<Code extends string>(
  code: Code,
  message: string,
  failure?: unknown,
): CodedProblem<Code> {
  return {
    code,
    message,
    ...(failure instanceof RevisionRequestError
      ? { status: failure.status, detail: failure.message }
      : failure instanceof Error
      ? { detail: failure.message }
      : {}),
  };
}

/** The two ways a versioned route refuses the version it was asked for. */
export type VersionProblemCode = "version-invalid" | "version-absent";

export const versionMessages: Record<VersionProblemCode, string> = {
  "version-invalid": "This is not the identity of a version of the model.",
  "version-absent": "This version is not in the model's history.",
};

/**
 * Which of them a failed read is, if it is one: the host answers 400 to
 * something that is not the identity of a commit, and 404 to a commit it does
 * not have. What a version looks like is the host's rule alone; no page has a
 * copy of it.
 */
export function versionProblemOf(
  failure: unknown,
): VersionProblemCode | undefined {
  if (!(failure instanceof RevisionRequestError)) return undefined;
  return failure.status === 400
    ? "version-invalid"
    : failure.status === 404
    ? "version-absent"
    : undefined;
}
export type RevisionClientCode =
  | "command-in-flight"
  | "history-moved"
  | "contract-mismatch"
  | "comparison-mismatch"
  | "version-mismatch"
  | "unexpected-response";
/** The client itself found the failure: a code to act on, a sentence to show. */
export class RevisionClientError extends Error {
  constructor(readonly code: RevisionClientCode, message: string) {
    super(message);
    this.name = "RevisionClientError";
  }
}
export function sameSourceVersion(
  a?: string | null,
  b?: string | null,
): boolean {
  return Boolean(a && b && sourceVersionKey(a) === sourceVersionKey(b));
}
export function sourceVersionKey(version: string): string {
  return version.replace(/^(branch|commit):/, "");
}
export function shortSourceVersion(version?: string | null): string {
  return version ? sourceVersionKey(version).slice(0, 8) : "—";
}
export function selectionBase(
  selection: RevisionSelection,
  item: SourceCommit | SourceProposal,
): string {
  return selection.kind === "proposal"
    ? (item as SourceProposal).baseVersion
    : (item as SourceCommit).parentVersion ?? "empty";
}
export function selectionTarget(
  selection: RevisionSelection,
  item: SourceCommit | SourceProposal,
): string | undefined {
  return selection.kind === "proposal"
    ? (item as SourceProposal).proposalVersion
    : (item as SourceCommit).version;
}
export function selectedRevision(
  snapshot: RevisionSnapshot,
  selection: RevisionSelection | undefined,
): SourceCommit | SourceProposal | undefined {
  return selection?.kind === "proposal"
    ? snapshot.revisions.proposals.find((item) => item.id === selection.id)
    : snapshot.history.commits.find((item) =>
      sameSourceVersion(item.version, selection?.id)
    );
}

/**
 * The revision an address names, as this snapshot holds it. A commit that main
 * does not have, but that is the version a proposal made, is that proposal: the
 * last change to a file read at a proposal's version is that very commit, which
 * is never in main's history. Anything else is returned as it was named.
 */
export function resolveRevision(
  snapshot: RevisionSnapshot,
  selection: RevisionSelection,
): RevisionSelection {
  if (selection.kind !== "commit" || selectedRevision(snapshot, selection)) {
    return selection;
  }
  const proposal = snapshot.revisions.proposals.find((entry) =>
    sameSourceVersion(entry.proposalVersion, selection.id)
  );
  return proposal ? { kind: "proposal", id: proposal.id } : selection;
}

/** Pin an inspected commit when it falls outside the newly loaded recent list.
 * A refresh must not silently replace a historical inspection with main. */
export function retainInspectedCommit(
  next: RevisionSnapshot,
  previous: RevisionSnapshot | undefined,
  selection: RevisionSelection | undefined,
): RevisionSnapshot {
  if (
    !previous || selection?.kind !== "commit" ||
    selectedRevision(next, selection)
  ) {
    return next;
  }
  const inspected = selectedRevision(previous, selection) as
    | SourceCommit
    | undefined;
  return inspected
    ? {
      ...next,
      history: {
        ...next.history,
        commits: [...next.history.commits, inspected],
      },
    }
    : next;
}

/** The pinned diff2html 3.4.56 renderer escapes source lines and file names.
 * No proposal field, source text, or server-supplied HTML is inserted as HTML. */
export function renderSourceDiff(patch: string, mode: DiffMode): string {
  return html(patch, {
    drawFileList: true,
    matching: "none",
    outputFormat: mode,
    diffMaxChanges: 20_000,
  });
}

const isText = (value: unknown): value is string => typeof value === "string";

/** Whether the host answered the shape the page reads; it never draws a guess. */
function isFileList(value: unknown): value is ModelFileList {
  return isRecord(value) && isText(value.version) &&
    Array.isArray(value.files) &&
    value.files.every((file) =>
      isRecord(file) && isText(file.path) && isRecord(file.lastChange) &&
      isText(file.lastChange.version) && isText(file.lastChange.createdAt) &&
      isText(file.lastChange.message)
    );
}
function isSourceTree(value: unknown): value is ModelSourceTree {
  return isRecord(value) && isText(value.version) &&
    isRecord(value.sources) && Object.values(value.sources).every(isText);
}
const unexpected = (what: string) =>
  new RevisionClientError(
    "unexpected-response",
    `The ${what} received are not in a form this page can read.`,
  );
const mismatch = (what: string) =>
  new RevisionClientError(
    "version-mismatch",
    `The ${what} received are not the ones of the version asked for. Read again to retry.`,
  );

export function createRevisionApi(
  request: typeof fetch = globalThis.fetch.bind(globalThis),
) {
  let writing = false;
  async function read<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await request(path, { cache: "no-store", ...options });
    const data = await response.json();
    if (!response.ok) throw requestFailure(response, data);
    return data as T;
  }
  async function write(path: string, input: unknown): Promise<unknown> {
    if (writing) {
      throw new RevisionClientError(
        "command-in-flight",
        "A revision command is already in progress.",
      );
    }
    writing = true;
    try {
      // In particular, never retry a stale CAS decision or adoption automatically.
      return await read(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    } finally {
      writing = false;
    }
  }
  function history(
    signal?: AbortSignal,
    options: { limit?: number } = {},
  ): Promise<SourceHistory> {
    const query = options.limit === undefined
      ? ""
      : `?${new URLSearchParams({ limit: String(options.limit) })}`;
    return read<SourceHistory>(`/api/model-history${query}`, { signal });
  }
  return {
    /** Commit metadata only, without loading proposals or runtime rights. */
    history,
    /**
     * The proposals and the history of main read together. The history is the
     * host's default length unless `limit` (1 to 200) asks for another.
     */
    async snapshot(
      signal?: AbortSignal,
      options: { limit?: number } = {},
    ): Promise<RevisionSnapshot> {
      let [revisions, sourceHistory] = await Promise.all([
        read<SourceRevisions>("/api/model-revisions", { signal }),
        history(signal, options),
      ]);
      if (!sameSourceVersion(revisions.version, sourceHistory.headVersion)) {
        revisions = await read<SourceRevisions>("/api/model-revisions", {
          signal,
        });
      }
      if (!sameSourceVersion(revisions.version, sourceHistory.headVersion)) {
        throw new RevisionClientError(
          "history-moved",
          "The model changed while it was being read. Read again for a consistent history.",
        );
      }
      return { revisions, history: sourceHistory };
    },
    async runtime(
      agentId: string,
      signal?: AbortSignal,
    ): Promise<RuntimeRevisionSnapshot> {
      const params = new URLSearchParams({ agentId });
      const revisions = await read<SourceRevisions>(
        `/api/model-revisions?${params}`,
        { signal },
      );
      if (revisions.agentId !== agentId) {
        throw new RevisionClientError(
          "contract-mismatch",
          "The contract received is not the one of the operator asked for. Read again to retry.",
        );
      }
      return {
        agentId,
        version: revisions.version,
        runtime: revisions.runtime,
      };
    },
    diff(from: string, to: string, signal?: AbortSignal): Promise<SourceDiff> {
      const params = new URLSearchParams({ from, to });
      return read(`/api/model-diff?${params}`, { signal });
    },
    async graphDiff(
      from: string,
      to: string,
      signal?: AbortSignal,
    ): Promise<GraphDiff> {
      const params = new URLSearchParams({ from, to });
      const diff = await read<GraphDiff>(`/api/model-graph-diff?${params}`, {
        signal,
      });
      if (
        !["Git"].includes(String(diff.engine)) ||
        !sameSourceVersion(diff.toVersion, to) ||
        (from === "empty"
          ? diff.fromVersion !== null
          : !sameSourceVersion(diff.fromVersion, from))
      ) {
        throw new RevisionClientError(
          "comparison-mismatch",
          "The comparison received is not the one of the versions asked for. Read again to retry.",
        );
      }
      return diff;
    },
    /**
     * The files of a version and the commit that last changed each. An explicit
     * version is immutable, so the browser may keep the answer; the head moves.
     */
    async files(
      version?: string,
      signal?: AbortSignal,
    ): Promise<ModelFileList> {
      const query = version ? `?${new URLSearchParams({ version })}` : "";
      const list = await read<ModelFileList>(`/api/model-files${query}`, {
        signal,
        ...(version ? { cache: "default" as const } : {}),
      });
      if (!isFileList(list)) throw unexpected("files");
      if (version && !sameSourceVersion(list.version, version)) {
        throw mismatch("files");
      }
      return list;
    },
    /** Every source of one immutable version: the host has no route for one file. */
    async sources(
      version: string,
      signal?: AbortSignal,
    ): Promise<ModelSourceTree> {
      const tree = await read<ModelSourceTree>(
        `/api/model-sources?${new URLSearchParams({ version })}`,
        { signal },
      );
      if (!isSourceTree(tree)) throw unexpected("sources");
      if (!sameSourceVersion(tree.version, version)) throw mismatch("sources");
      return tree;
    },
    decide(input: {
      id: string;
      verdict: "approve" | "refuse";
      expectedVersion: string;
      sourceDigest: string;
      reason?: string;
    }): Promise<unknown> {
      const { id, ...decision } = input;
      return write(
        `/api/model-revisions/${encodeURIComponent(id)}/decision`,
        decision,
      );
    },
    adopt(
      expectedDigest: string,
      target?: { expectedVersion: string; agentId: string },
    ): Promise<unknown> {
      return write("/api/model-version/adopt", { expectedDigest, ...target });
    },
  };
}
