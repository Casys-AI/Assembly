import { isPlainRecord as record } from "../../../../domain/primitives/is-plain-record.ts";
import { hasOnlyKeys as keys } from "../../../../domain/primitives/closed-record.ts";
import { isSha256Hex } from "../../../../domain/primitives/execution-digest.ts";
import { ModelRevisionsService } from "../../../../application/model/revisions/service.ts";
import {
  noStoreJson,
  versionedError,
  versionedJson,
} from "../versioning/responses.ts";
import { parseModelRevisionId } from "../../../../domain/shared-kernel/revision-id.ts";
/** Local revision controls. Agents propose source changes; admission and runtime
 * adoption are distinct explicit controls, with no graphical source editor. */
import type { ModelPort } from "../../../../application/work/runtime/ports.ts";
import type { SystemRuntimeState } from "../../../../domain/work/dialogue.ts";
import type { ExecutableModel } from "../../../../domain/model/execution/executable-model.ts";
import type { ModelRepositoryPort } from "../../../../application/model/repository.ts";
import { compareModelSources } from "../../../../application/model/revisions/source-diff.ts";
import { modelProposalPreview } from "../../../../application/model/revisions/proposal-preview.ts";
import { exerciseOwnerAuthority } from "../../../../domain/governance/authority.ts";
import {
  isDevelopmentOriginAllowed,
  type LocalHttpPolicy,
  requireDevelopmentHost,
} from "../../../../infrastructure/http/local-security.ts";

type RevisionRepository = Pick<
  ModelRepositoryPort,
  | "propose"
  | "current"
  | "at"
  | "header"
  | "listProposals"
  | "readProposalJournal"
  | "proposal"
  | "accept"
  | "reject"
  | "lastChangeByPath"
  | "history"
  | "graphDiff"
>;
export interface ModelRevisionRuntime {
  readonly snapshot: Pick<
    SystemRuntimeState,
    "model" | "busy" | "executionModel"
  >;
  inspectModelVersion(): Promise<ExecutableModel>;
  adoptModelVersion(input: {
    expectedDigest: string;
    expectedVersion?: string;
    recoveryReason?: string;
  }): Promise<void>;
}
export interface ModelVersionAdoption {
  agentId?: string;
  expectedDigest: string;
  expectedVersion: string;
  recoveryReason?: string;
}
export interface ModelRevisionHandlerOptions {
  security?: LocalHttpPolicy;
  repository: RevisionRepository;
  model?: Pick<ModelPort, "proposeRevision">;
  runtime: ModelRevisionRuntime;
  resolveRuntime?: (
    agentId: string,
  ) =>
    | ModelRevisionRuntime
    | undefined
    | Promise<ModelRevisionRuntime | undefined>;
  /** Reserve and preflight before invoking adopt; release the reservation in
   * finally. A primary digest never admits another operator's contract. */
  onAdopt?: (
    input: ModelVersionAdoption,
    runtime: ModelRevisionRuntime,
    adopt: () => Promise<void>,
  ) => Promise<void>;
  onChange?: () => void | Promise<void>;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
function requireValue(
  value: unknown,
  status: number,
  message: string,
): asserts value {
  if (!value) throw new HttpFailure(status, message);
}
const json = noStoreJson;
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maximum;
}
function version(value: unknown): value is string {
  return typeof value === "string" &&
    /^(?:branch|commit):[A-Za-z0-9_-]+$/.test(value);
}
function comparisonVersions(params: URLSearchParams) {
  const from = params.get("from"), to = params.get("to");
  requireValue(
    (from === "empty" || version(from)) && version(to) &&
      params.getAll("from").length === 1 &&
      params.getAll("to").length === 1 &&
      [...params.keys()].every((key) => ["from", "to"].includes(key)),
    400,
    "Choisissez deux versions immuables à comparer.",
  );
  return { from: from!, to: to! };
}
function digest(value: unknown): value is string {
  return isSha256Hex(value);
}
async function body(request: Request): Promise<Record<string, unknown>> {
  requireValue(
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() ===
      "application/json",
    415,
    "JSON requis.",
  );
  const reader = request.body?.getReader();
  requireValue(reader, 400, "Requête vide.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 8_500_000) {
        await reader.cancel();
        throw new HttpFailure(413, "Révision trop volumineuse.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpFailure(400, "JSON invalide.");
  }
  requireValue(record(input), 400, "Objet JSON requis.");
  return input;
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpFailure) {
    return json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    }, error.status);
  }
  const failure = error as {
    code?: string;
    message?: string;
    status?: number;
    invariant?: number;
    reason?: string;
  } | undefined;
  const applicationStatus = failure?.status;
  const status = typeof applicationStatus === "number" &&
      Number.isInteger(applicationStatus) &&
      applicationStatus >= 400 && applicationStatus <= 599
    ? applicationStatus
    : failure?.code === "NOT_FOUND"
    ? 404
    : ["STALE_REVISION", "SOURCE_CONFLICT"].includes(failure?.code ?? "")
    ? 409
    : failure?.code === "UPSTREAM_FAILURE"
    ? 502
    : 400;
  return json({
    ...(failure?.code ? { code: failure.code } : {}),
    ...(failure?.invariant ? { invariant: failure.invariant } : {}),
    ...(failure?.code === "AUTHORITY_INVARIANT" && failure.reason
      ? { reason: failure.reason }
      : {}),
    error: typeof failure?.message === "string"
      ? failure.message.slice(0, 2000)
      : "Opération de révision échouée.",
  }, status);
}

/** Intended for the loopback composition root, with the same explicit local
 * controls as the existing atelier. It does not authenticate a human identity. */
export function createModelRevisionHandler(
  options: ModelRevisionHandlerOptions,
) {
  const { repository, runtime } = options;
  const currentHeader = async () =>
    await repository.header(
      (await repository.history({ limit: 1 })).headVersion,
    );
  const revisions = new ModelRevisionsService(repository);
  let writes = Promise.resolve<unknown>(undefined);
  const exclusive = async (operation: () => Promise<Response>) => {
    const next = writes.then(operation);
    writes = next.catch(() => {});
    return await next;
  };
  const targetRuntime = async (agentId?: string) => {
    if (!agentId || runtime.snapshot.model?.builderId === agentId) {
      return runtime;
    }
    const selected = await options.resolveRuntime?.(agentId);
    requireValue(selected, 404, "Opérateur introuvable.");
    requireValue(
      selected.snapshot.model?.builderId === agentId,
      409,
      "L’identité du runtime ne correspond pas à l’opérateur demandé.",
    );
    return selected;
  };
  const inspect = async (selected = runtime) => {
    try {
      const available = await selected.inspectModelVersion();
      return {
        available: available.version,
        active: selected.snapshot.executionModel?.version ?? null,
        executable: true,
        sourceRights: {
          modelEditPolicy: available.modelEditPolicy ?? null,
          modelAdministration: available.modelAdministration ?? null,
          operatorAuthorityPolicies: (available.operatorAuthorityPolicies ?? [])
            .filter((policy) =>
              policy.holderNativeId === available.identity.builderId
            ),
          toolAdmissionPolicies: (available.toolAdmissionPolicies ?? [])
            .filter((policy) =>
              policy.holderNativeId === available.identity.builderId
            ),
        },
      };
    } catch (error) {
      return {
        available: null,
        active: selected.snapshot.executionModel?.version ?? null,
        executable: false,
        error: error instanceof Error
          ? error.message.slice(0, 2000)
          : "Modèle non exécutable.",
      };
    }
  };
  return async function handleModelRevision(
    request: Request,
  ): Promise<Response | null> {
    const url = new URL(request.url);
    const match = url.pathname.match(
      /^\/api\/model-revisions\/([a-zA-Z0-9_-]{1,120})(\/decision|\/preview)?$/,
    );
    const known = [
      "/api/model-revisions",
      "/api/model-sources",
      "/api/model-files",
      "/api/model-history",
      "/api/model-diff",
      "/api/model-graph-diff",
      "/api/model-version/adopt",
    ].includes(url.pathname) || Boolean(match);
    if (!known) return null;
    try {
      if (url.pathname === "/api/model-files" && request.method !== "GET") {
        return versionedError(
          "METHOD_NOT_ALLOWED",
          { method: request.method },
          "Read files with GET.",
          405,
          { allow: "GET" },
        );
      }
      if (request.method === "GET") {
        if (url.pathname === "/api/model-revisions") {
          const agentId = url.searchParams.get("agentId");
          requireValue(
            [...url.searchParams.keys()].every((key) => key === "agentId") &&
              (agentId === null || text(agentId, 200)) &&
              url.searchParams.getAll("agentId").length <= 1,
            400,
            "Sélection d’opérateur invalide.",
          );
          const selected = await targetRuntime(agentId ?? undefined);
          const current = await currentHeader();
          return json({
            version: current.version,
            sourceDigest: current.sourceDigest,
            proposals: await repository.listProposals(),
            runtime: await inspect(selected),
            agentId: selected.snapshot.model?.builderId ?? null,
          });
        }
        if (url.pathname === "/api/model-history") {
          requireValue(
            [...url.searchParams.keys()].every((key) => key === "limit"),
            400,
            "Paramètre d’historique inconnu.",
          );
          const limit = url.searchParams.get("limit");
          requireValue(
            url.searchParams.getAll("limit").length <= 1 &&
              (limit === null ||
                (/^[0-9]+$/.test(limit) && Number(limit) >= 1 &&
                  Number(limit) <= 200)),
            400,
            "Limite d’historique invalide.",
          );
          return versionedJson(
            request,
            await revisions.history(
              limit === null ? {} : { limit: Number(limit) },
            ),
            { digest: "head" },
          );
        }
        if (url.pathname === "/api/model-files") {
          const version = url.searchParams.get("version");
          if (
            [...url.searchParams.keys()].some((key) => key !== "version") ||
            url.searchParams.getAll("version").length > 1
          ) {
            return versionedError(
              "INVALID_REQUEST",
              { parameters: [...url.searchParams.keys()] },
              "Pass only an optional version parameter.",
              400,
            );
          }
          if (version !== null) {
            try {
              parseModelRevisionId(version);
            } catch {
              return versionedError(
                "INVALID_VERSION",
                { version },
                "Pass an immutable model commit identity.",
                400,
              );
            }
          }
          const result = await revisions.files(version ?? undefined);
          return versionedJson(request, result, {
            ...(version ? { version } : {}),
            digest: `files-${result.version}`,
          });
        }
        if (url.pathname === "/api/model-diff") {
          const { from, to } = comparisonVersions(url.searchParams);
          const [before, after] = await Promise.all([
            from === "empty"
              ? Promise.resolve(undefined)
              : repository.header(from!),
            repository.header(to!),
          ]);
          return json({
            fromVersion: before?.version ?? null,
            toVersion: after.version,
            fromSourceDigest: before?.sourceDigest ?? null,
            toSourceDigest: after.sourceDigest,
            ...compareModelSources(before?.sources ?? {}, after.sources),
          });
        }
        if (url.pathname === "/api/model-graph-diff") {
          const { from, to } = comparisonVersions(url.searchParams);
          return json(
            await repository.graphDiff(from === "empty" ? null : from, to),
          );
        }
        if (url.pathname === "/api/model-sources") {
          const requested = url.searchParams.get("version");
          requireValue(
            requested === null || version(requested),
            400,
            "Version de sources invalide.",
          );
          const revision = requested
            ? await repository.header(requested)
            : await currentHeader();
          return json({
            version: revision.version,
            sourceDigest: revision.sourceDigest,
            sources: revision.sources,
          });
        }
        if (match?.[2] === "/preview") {
          const agentId = url.searchParams.get("agentId");
          requireValue(
            text(agentId, 200) &&
              url.searchParams.getAll("agentId").length === 1 &&
              [...url.searchParams.keys()].every((key) => key === "agentId"),
            400,
            "Identité d’opérateur requise pour cette prévisualisation.",
          );
          const proposal = await repository.proposal(match[1]!);
          requireValue(
            (proposal.authorization?.kind === "operator" ||
              proposal.authorization?.kind === "operator-administration") &&
              proposal.authorization.operatorNativeId === agentId &&
              proposal.author === `agent:${agentId}`,
            404,
            "Proposition introuvable pour cet opérateur.",
          );
          requireValue(
            version(proposal.baseVersion) &&
              version(proposal.proposalVersion) &&
              digest(proposal.sourceDigest),
            409,
            "La version proposée n’est pas vérifiable.",
          );
          const [base, proposed, current] = await Promise.all([
            repository.at(proposal.baseVersion),
            repository.at(proposal.proposalVersion),
            repository.current(),
          ]);
          requireValue(
            base.version === proposal.baseVersion &&
              proposed.version === proposal.proposalVersion &&
              proposed.sourceDigest === proposal.sourceDigest,
            409,
            "Le contenu proposé a changé ; rechargez la proposition.",
          );
          return json(modelProposalPreview({
            proposal,
            agentId,
            base,
            proposed,
            current,
          }));
        }
        if (match && !match[2]) {
          return json(await repository.proposal(match[1]!));
        }
        return json({ error: "Méthode non autorisée." }, 405);
      }
      if (
        request.method !== "POST" ||
        [
          "/api/model-files",
          "/api/model-sources",
          "/api/model-history",
          "/api/model-diff",
          "/api/model-graph-diff",
        ]
          .includes(url.pathname) ||
        match && match[2] !== "/decision"
      ) return json({ error: "Méthode non autorisée." }, 405);
      requireValue(
        url.searchParams.size === 0,
        400,
        "Les commandes de révision utilisent uniquement leur corps JSON.",
      );
      const origin = request.headers.get("origin");
      if (options.security?.environment === "development") {
        try {
          requireDevelopmentHost(request);
        } catch {
          throw new HttpFailure(403, "Hôte local refusé.");
        }
      }
      requireValue(
        options.security?.environment === "development"
          ? isDevelopmentOriginAllowed(request)
          : (!origin || origin === url.origin) &&
            request.headers.get("sec-fetch-site") !== "cross-site",
        403,
        "Origine refusée.",
      );
      const input = await body(request);
      return await exclusive(async () => {
        if (url.pathname !== "/api/model-version/adopt") {
          requireValue(
            !runtime.snapshot.busy,
            409,
            "Une exécution est en cours ; réessayez après sa fin.",
          );
        }
        if (url.pathname === "/api/model-revisions") {
          requireValue(
            keys(input, ["baseVersion", "sources", "reason"], [
              "recoveryReason",
            ]) &&
              version(input.baseVersion) && text(input.reason, 4000) &&
              (input.recoveryReason === undefined ||
                text(input.recoveryReason, 4000)) &&
              record(input.sources),
            400,
            "Proposition SysML invalide.",
          );
          const sources = input.sources as Record<string, unknown>;
          requireValue(
            Object.keys(sources).length > 0 &&
              Object.keys(sources).length <= 64 &&
              Object.values(sources).every((source) =>
                typeof source === "string"
              ),
            400,
            "Sources SysML invalides.",
          );
          const identity = runtime.snapshot.model;
          requireValue(
            identity,
            409,
            "Le modèle ne fournit pas de propositions de sources.",
          );
          const recoveryReason = input.recoveryReason as string | undefined;
          const native = recoveryReason === undefined
            ? await runtime.inspectModelVersion()
            : runtime.snapshot.executionModel;
          requireValue(
            native,
            409,
            "Aucun contrat antérieur ne permet de tracer cette décision.",
          );
          if (recoveryReason === undefined) {
            requireValue(
              native.version.digest ===
                runtime.snapshot.executionModel?.version.digest,
              409,
              "Une version de modèle attend son admission pour exécution.",
            );
            requireValue(
              native.version.repositoryVersion === input.baseVersion,
              409,
              "La proposition doit utiliser la version source qui autorise la décision.",
            );
          }
          const authorityExercise = exerciseOwnerAuthority(
            native,
            "model-revision",
            recoveryReason === undefined
              ? {}
              : { outOfMandate: true, reason: recoveryReason.trim() },
          );
          const base = await repository.header(input.baseVersion as string);
          const proposal = await repository.propose({
            baseVersion: base.version,
            sources: { ...base.sources, ...sources as Record<string, string> },
            reason: input.reason as string,
            author: "local-owner",
            authorization: { kind: "local-owner", authorityExercise },
          });
          await options.onChange?.();
          return json({
            id: proposal.id,
            baseVersion: proposal.baseVersion,
            status: "pending",
            authorityExercise,
          }, 201);
        }
        if (url.pathname === "/api/model-version/adopt") {
          requireValue(
            keys(input, ["expectedDigest"], [
              "expectedVersion",
              "agentId",
              "recoveryReason",
            ]) &&
              digest(input.expectedDigest) &&
              (input.recoveryReason === undefined ||
                text(input.recoveryReason, 4000)) &&
              (input.expectedVersion === undefined ||
                version(input.expectedVersion)) &&
              (input.agentId === undefined || text(input.agentId, 200)),
            400,
            "Version d’exécution ou opérateur invalide.",
          );
          const agentId = input.agentId as string | undefined;
          const selected = await targetRuntime(agentId);
          requireValue(
            !selected.snapshot.busy,
            409,
            "Une exécution est en cours pour cet opérateur.",
          );
          const available = await selected.inspectModelVersion();
          requireValue(
            available.version.digest === input.expectedDigest &&
              available.identity.builderId ===
                selected.snapshot.model?.builderId &&
              version(available.version.repositoryVersion) &&
              (input.expectedVersion === undefined ||
                available.version.repositoryVersion === input.expectedVersion),
            409,
            "Le contrat ou sa version source a changé ; rechargez avant d’adopter.",
          );
          const adoption: ModelVersionAdoption = {
            ...(agentId ? { agentId } : {}),
            expectedDigest: input.expectedDigest,
            expectedVersion: available.version.repositoryVersion,
            ...(input.recoveryReason === undefined
              ? {}
              : { recoveryReason: String(input.recoveryReason).trim() }),
          };
          let started = false, adopted = false;
          const adopt = async () => {
            requireValue(!started, 409, "Cette adoption a déjà été exécutée.");
            started = true;
            await selected.adoptModelVersion({
              expectedDigest: adoption.expectedDigest,
              expectedVersion: adoption.expectedVersion,
              ...(adoption.recoveryReason === undefined
                ? {}
                : { recoveryReason: adoption.recoveryReason }),
            });
            adopted = true;
          };
          if (options.onAdopt) await options.onAdopt(adoption, selected, adopt);
          else await adopt();
          requireValue(adopted, 409, "Le contrat n’a pas été adopté.");
          await options.onChange?.();
          return json({
            adopted: true,
            agentId: selected.snapshot.model?.builderId ?? null,
            runtime: await inspect(selected),
          });
        }
        requireValue(
          match?.[2] === "/decision",
          404,
          "Commande de révision inconnue.",
        );
        requireValue(
          keys(input, ["verdict", "expectedVersion", "sourceDigest"], [
            "reason",
            "recoveryReason",
          ]) && ["approve", "refuse"].includes(String(input.verdict)) &&
            version(input.expectedVersion) && digest(input.sourceDigest) &&
            (input.recoveryReason === undefined ||
              text(input.recoveryReason, 4000)) &&
            (input.reason === undefined || text(input.reason, 4000)),
          400,
          "Décision de révision invalide.",
        );
        const proposal = await repository.proposal(match[1]!);
        // These staged sources belong to the dossier lifecycle. A generic
        // decision must neither poison its queue command nor reject its branch.
        if (proposal.authorization?.kind === "operator-evolution") {
          throw new HttpFailure(
            409,
            "This revision is managed by an evolution dossier. Request its authorized operator through the conversation.",
            "EVOLUTION_DOSSIER_REQUIRED",
          );
        }
        requireValue(
          proposal.sourceDigest === input.sourceDigest,
          409,
          "Le contenu proposé a changé ; rechargez la proposition.",
        );
        const current = await repository.current();
        requireValue(
          current.version === input.expectedVersion,
          409,
          "Le modèle courant a changé ; rechargez avant de décider.",
        );
        requireValue(
          proposal.status === "proposed",
          409,
          "Cette proposition n'attend plus de décision.",
        );
        const recoveryReason = input.recoveryReason as string | undefined;
        // Source acceptance uses HEAD before the proposed edit. The available
        // model may differ from the runtime pin, but the proposal never supplies
        // the authority that admits itself.
        const authorityModel = recoveryReason === undefined
          ? await runtime.inspectModelVersion()
          : runtime.snapshot.executionModel;
        requireValue(
          authorityModel,
          409,
          "Aucun contrat antérieur ne permet de tracer cette décision.",
        );
        if (recoveryReason === undefined) {
          requireValue(
            authorityModel.version.repositoryVersion === current.version,
            409,
            "La version source autorisant la décision a changé.",
          );
        }
        const decisionAuthorityExercise = exerciseOwnerAuthority(
          authorityModel,
          "model-revision",
          recoveryReason === undefined
            ? {}
            : { outOfMandate: true, reason: recoveryReason.trim() },
        );
        if (input.verdict === "refuse") {
          const rejected = await repository.reject({
            id: proposal.id,
            author: "local-control",
            decisionAuthorityExercise,
            ...(input.reason ? { reason: String(input.reason) } : {}),
          });
          await options.onChange?.();
          return json(rejected);
        }
        const accepted = await repository.accept({
          id: proposal.id,
          expectedVersion: input.expectedVersion,
          author: "local-control",
          decisionAuthorityExercise,
        });
        await options.onChange?.();
        return json({
          accepted: true,
          version: accepted.version,
          sourceDigest: accepted.sourceDigest,
          runtime: await inspect(),
          executionAdopted: false,
          authorityExercise: decisionAuthorityExercise,
        });
      });
    } catch (error) {
      if (url.pathname === "/api/model-files") {
        const failure = error as { code?: string };
        const code = [
            "NOT_FOUND",
            "INVALID_REQUEST",
            "INVALID_REPOSITORY",
            "UPSTREAM_FAILURE",
          ].includes(failure?.code ?? "")
          ? failure.code!
          : "MODEL_FILES_FAILED";
        return versionedError(
          code,
          {
            message: error instanceof Error
              ? error.message
              : "File metadata unavailable",
          },
          "Reload file metadata from a valid model version.",
          code === "NOT_FOUND" ? 404 : code === "INVALID_REQUEST" ? 400 : 500,
        );
      }
      return errorResponse(error);
    }
  };
}
