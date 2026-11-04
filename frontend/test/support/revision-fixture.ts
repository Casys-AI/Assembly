import type { ModelProposalAuthorization } from "../../../src/domain/governance/model-access/model-edit-authorization.ts";
import { parseModelRevisionId } from "../../../src/domain/shared-kernel/revision-id.ts";
import type {
  ModelChangedFile,
  ModelFileLastChange,
} from "../../../src/domain/model/records/revision.ts";
import { parseModelAuthor } from "../../../src/domain/model/records/revision.ts";
import type {
  RevisionSnapshot,
  RuntimeOperator,
  SourceCommit,
  SourceDiff,
  SourceProposal,
  SourceRevisions,
} from "../../lib/model/revisions/api.ts";

/**
 * A model with three commits, four proposals and a host that serves them:
 * main is at HEAD, the operator runs PARENT, and the proposals are waiting,
 * accepted, declined and being prepared.
 */
export const ROOT = `commit:${"a".repeat(40)}`;
export const PARENT = `commit:${"b".repeat(40)}`;
export const HEAD = `commit:${"c".repeat(40)}`;
export const PROPOSED = `commit:${"d".repeat(40)}`;
export const DIGEST = "e".repeat(64);
/** The executable contract of the commit before HEAD. */
export const OLD_DIGEST = "f".repeat(64);
// Native ids without a colon: the host reads `agent:<id>` as an operator only
// then (parseModelAuthor), and the pages name an operator through that reading.
export const DESIGNER = "designer";
export const REVIEWER = "reviewer";
/** The two operators of the roster: the designer is the primary one. */
export const designer: RuntimeOperator = {
  nativeId: DESIGNER,
  name: "Designer",
  primary: true,
};
export const reviewer: RuntimeOperator = {
  nativeId: REVIEWER,
  name: "Reviewer",
  primary: false,
};
export const operators: readonly RuntimeOperator[] = [designer, reviewer];

export const PATCH = [
  "diff --git a/configuration.sysml b/configuration.sysml",
  "index 1111111..2222222 100644",
  "--- a/configuration.sysml",
  "+++ b/configuration.sysml",
  "@@ -1,2 +1,4 @@",
  " part def Configuration {",
  "+  attribute editing;",
  "+  doc /* <img src=x onerror=attack()> */",
  " }",
  "",
].join("\n");

export const changed = (
  path: string,
  status: ModelChangedFile["status"],
  additions: number,
  deletions: number,
): ModelChangedFile => ({ path, status, additions, deletions });

/**
 * A commit as the host reads it: its author parsed by the host's own parser,
 * and the files Git counted against its first parent.
 */
export const commit = (
  version: string,
  parentVersion: string | undefined,
  author: string,
  message: string,
  createdAt: string,
  files: ModelChangedFile[] = [],
  extra: Partial<SourceCommit> = {},
): SourceCommit => ({
  version,
  parentVersion,
  parents: parentVersion ? [parentVersion] : [],
  author,
  message,
  createdAt,
  sourceDigest: DIGEST,
  parsedAuthor: parseModelAuthor(author),
  files,
  additions: files.reduce((sum, file) => sum + file.additions, 0),
  deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  ...extra,
});

/**
 * What the host pins on a proposal made for an operator, and the only proof of
 * who proposed it that a page reads: the raw author alone says nothing.
 */
export const operatorAuthorization = (
  nativeId: string,
): ModelProposalAuthorization => ({
  kind: "operator",
  systemQualifiedName: "System",
  operatorQualifiedName: `System::${nativeId}`,
  operatorNativeId: nativeId,
  mandateId: "mandate",
  mandateRevision: 1,
  policyId: "policy",
  policyRevision: 1,
  policyDigest: "a".repeat(64),
  operations: ["set-value"],
});

export const proposal = (
  id: string,
  status: SourceProposal["status"],
  reason: string,
  createdAt: string,
  extra: Partial<SourceProposal> = {},
): SourceProposal => ({
  id,
  author: `agent:${DESIGNER}`,
  authorization: operatorAuthorization(DESIGNER),
  reason,
  baseVersion: HEAD,
  createdAt,
  status,
  sourceDigest: `${id}-digest`,
  proposalVersion: PROPOSED,
  ...extra,
});

/** The history as the host reads it, newest first. */
export function history(): RevisionSnapshot {
  return {
    revisions: {
      version: HEAD,
      sourceDigest: DIGEST,
      proposals: [
        proposal(
          "p-prepare",
          "preparing",
          "Draft the reviewer",
          "2026-10-24T12:00:00Z",
          {
            proposalVersion: undefined,
          },
        ),
        proposal(
          "p-declined",
          "rejected",
          "Rename everything",
          "2026-10-24T11:00:00Z",
          {
            rejectionReason: "Too broad",
          },
        ),
        proposal(
          "p-open",
          "proposed",
          "Add a ranking step",
          "2026-10-24T10:00:00Z",
        ),
        proposal(
          "p-taken",
          "accepted",
          "Add the reader",
          "2026-10-23T10:00:00Z",
          {
            acceptedVersion: PARENT,
            baseVersion: ROOT,
          },
        ),
      ],
      runtime: {
        available: { digest: DIGEST, repositoryVersion: HEAD },
        active: { digest: DIGEST, repositoryVersion: PARENT },
        executable: true,
      },
    },
    history: {
      headVersion: HEAD,
      commits: [
        commit(
          HEAD,
          PARENT,
          "local-control",
          "Accept a proposal",
          "2026-10-24T09:00:00Z",
          [changed("configuration.sysml", "modified", 2, 0)],
        ),
        commit(
          PARENT,
          ROOT,
          "local-control",
          "Add the reader",
          "2026-10-23T10:30:00Z",
          [
            changed("configuration.sysml", "modified", 3, 1),
            changed("reader.sysml", "added", 8, 0),
          ],
          { proposalId: "p-taken" },
        ),
        commit(
          ROOT,
          undefined,
          "ase",
          "Admit the initial model",
          "2026-10-22T08:00:00Z",
          [
            changed("configuration.sysml", "added", 10, 0),
            changed("lib/units.sysml", "added", 4, 0),
          ],
        ),
      ],
      truncated: false,
    },
  };
}

type Runtime = SourceRevisions["runtime"];

/**
 * What the operators' runtimes hold: the designer still runs the contract of
 * PARENT while HEAD's is available to it; the reviewer already runs HEAD.
 */
export function runtimes(): Record<string, Runtime> {
  const head = { digest: DIGEST, repositoryVersion: HEAD };
  return {
    [DESIGNER]: {
      available: head,
      active: { digest: OLD_DIGEST, repositoryVersion: PARENT },
      executable: true,
    },
    [REVIEWER]: { available: head, active: head, executable: true },
  };
}

/** The change from `from` to `to`, as the host computes it. */
export function diffBetween(from: string, to: string): SourceDiff {
  return {
    fromVersion: from === "empty" ? null : from,
    toVersion: to,
    fromSourceDigest: from === "empty" ? null : DIGEST,
    toSourceDigest: DIGEST,
    patch: PATCH,
    files: [{
      path: "configuration.sysml",
      kind: "changed",
      additions: 2,
      deletions: 0,
    }],
    additions: 2,
    deletions: 0,
  };
}

/** The files and sources a host serves: the text of each file of each version. */
export interface HostFiles {
  /** By version, then by logical path (`a.sysml`, never `sources/a.sysml`). */
  sources: Record<string, Record<string, string>>;
  /** The version a list asked for without one answers for; the history's head. */
  head?: string;
  /** Answers a route instead of the host; `undefined` lets the host answer. */
  refuse?: (route: "files" | "sources") => Response | undefined;
}

/** What reads wait for: one thing, or a thing for each path (none for some). */
export type HostGate =
  | Promise<unknown>
  | ((path: string) => Promise<unknown> | undefined);

/** What the real routes answer for a version that is not a commit, or unknown. */
const versionError = (
  code: "INVALID_VERSION" | "NOT_FOUND",
  message: string,
  status: number,
) =>
  Response.json({
    code,
    context: { message },
    recovery: "Reload file metadata from a valid model version.",
  }, { status });

/**
 * A fake host for the revision API: it answers the three reads, records every
 * request and answers a decision as told. `gate` makes the reads wait for it (a
 * function says, for each path, what that read waits for). With `runtimes` it
 * answers for each operator too, and an adoption moves the runtime it names to
 * what is available, unless the contract or version sent is not the one
 * available (409), as the real host does. With `files` it also serves the
 * files of each version and their sources, as the real routes do: the commit
 * that last changed a file is the first, from the version back, whose changes
 * in `history` list it (a proposal's version is the proposal's own commit, as
 * the host's first-parent log has it), so one history tells every page.
 */
export function modelHost(
  options: {
    data?: RevisionSnapshot;
    decision?: () => Response | Promise<Response>;
    /** What each operator's runtime holds, by native id; served and moved. */
    runtimes?: Record<string, Runtime>;
    /** The operator a read without an operator answers for. */
    primary?: string;
    /** Answers an adoption instead of the host's own rule. */
    adoption?: () => Response;
    /** Reads of the history and the diffs wait for this before answering. */
    gate?: HostGate;
    /** The files and sources to serve; the routes answer 404 without them. */
    files?: HostFiles;
  } = {},
) {
  const data = options.data ?? history();
  const held = options.runtimes ?? {};
  const requests: {
    path: string;
    method: string;
    cache?: RequestCache;
    body?: unknown;
  }[] = [];
  const adopt = (
    body: { agentId: string; expectedDigest: string; expectedVersion: string },
  ) => {
    const runtime = held[body.agentId];
    if (
      !runtime?.available || runtime.available.digest !== body.expectedDigest ||
      runtime.available.repositoryVersion !== body.expectedVersion
    ) {
      return Response.json({ error: "The contract moved." }, { status: 409 });
    }
    runtime.active = runtime.available;
    return Response.json({ adopted: true, agentId: body.agentId, runtime });
  };
  /** The commits a file can have been last changed by, from a version back. */
  const lastChange = (
    version: string,
    path: string,
  ): ModelFileLastChange["lastChange"] => {
    const known = new Map<string, {
      message: string;
      createdAt: string;
      paths: string[];
      parent?: string;
    }>();
    for (const entry of data.history.commits) {
      known.set(entry.version, {
        message: entry.message,
        createdAt: entry.createdAt,
        paths: entry.files.map((file) => file.path),
        parent: entry.parentVersion,
      });
    }
    for (const entry of data.revisions.proposals) {
      if (!entry.proposalVersion || known.has(entry.proposalVersion)) continue;
      known.set(entry.proposalVersion, {
        message: entry.reason,
        createdAt: entry.createdAt,
        paths: diffBetween(entry.baseVersion, entry.proposalVersion).files.map(
          (file) => file.path,
        ),
        parent: entry.baseVersion,
      });
    }
    for (let at: string | undefined = version; at;) {
      const node = known.get(at);
      if (!node) break;
      if (node.paths.includes(path)) {
        return {
          version: at,
          message: node.message,
          createdAt: node.createdAt,
        };
      }
      at = node.parent;
    }
    throw new Error(
      `No commit up to ${version} changed ${path}: list it in the fixture's history.`,
    );
  };
  const served = (url: URL) => {
    const files = options.files!;
    const asked = url.searchParams.get("version");
    if (url.pathname === "/api/model-files") {
      const refused = files.refuse?.("files");
      if (refused) return refused;
      if (asked !== null) {
        try {
          parseModelRevisionId(asked);
        } catch {
          return versionError(
            "INVALID_VERSION",
            "Pass an immutable model commit identity.",
            400,
          );
        }
      }
      const version = asked ?? files.head ?? data.history.headVersion;
      const texts = files.sources[version];
      return texts
        ? Response.json({
          version,
          files: Object.keys(texts).map((path) => ({
            path,
            lastChange: lastChange(version, path),
          })),
        })
        : versionError("NOT_FOUND", "Unknown model version", 404);
    }
    const refused = files.refuse?.("sources");
    if (refused) return refused;
    const texts = asked ? files.sources[asked] : undefined;
    return texts
      ? Response.json({
        version: asked,
        sourceDigest: "d".repeat(64),
        sources: texts,
      })
      : Response.json({ error: "Version introuvable." }, { status: 404 });
  };
  const request =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({
        path,
        method,
        ...(method === "GET" ? { cache: init?.cache } : {}),
        ...(body ? { body } : {}),
      });
      if (method === "POST") {
        return path === "/api/model-version/adopt"
          ? options.adoption?.() ?? adopt(body)
          : options.decision?.() ?? Response.json({ accepted: true });
      }
      await (typeof options.gate === "function"
        ? options.gate(path)
        : options.gate);
      const url = new URL(path, "http://host.test");
      if (url.pathname === "/api/model-revisions") {
        const agentId = url.searchParams.get("agentId") ?? options.primary;
        if (agentId === undefined) return Response.json(data.revisions);
        return held[agentId]
          ? Response.json({
            ...data.revisions,
            agentId,
            runtime: held[agentId],
          })
          : Response.json({ error: "Unknown operator." }, { status: 404 });
      }
      if (url.pathname === "/api/model-history") {
        // As the host does: the newest commits up to the limit asked for.
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return Response.json({
          ...data.history,
          commits: data.history.commits.slice(0, limit),
          truncated: data.history.truncated ||
            data.history.commits.length > limit,
        });
      }
      if (url.pathname === "/api/model-diff") {
        return Response.json(
          diffBetween(
            url.searchParams.get("from")!,
            url.searchParams.get("to")!,
          ),
        );
      }
      if (
        options.files &&
        (url.pathname === "/api/model-files" ||
          url.pathname === "/api/model-sources")
      ) {
        return served(url);
      }
      return Response.json({ error: "Unknown." }, { status: 404 });
    }) as typeof fetch;
  return {
    request,
    requests,
    data,
    /** What each operator's runtime holds now. */
    runtimes: held,
    /** The requests that wrote. */
    writes: () => requests.filter((entry) => entry.method === "POST"),
  };
}
