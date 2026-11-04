/** Lot 12 HTTP edge: the Hono application serving the atelier. Route
 * registration moved out of the composition root; this module owns the route
 * table and the precedence, and adapts the Hono context to the plain Request
 * the inbound handlers expect. Handler signatures are unchanged.
 *
 * Precedence (first match wins, as in the former hand-rolled dispatch):
 *  1. frontend views (/, /chat, /tools, /cases, /system, /model, /revisions,
 *     /decide) and /assets/*, any method, served by the Fresh build;
 *  2. GET /api/model-graph (live source-graph projection);
 *  3. model diagnostics (GET /api/model/diagnostics,
 *     POST /api/model/diagnostics/masks), with the mask follow-up warming
 *     model attention and republishing the model version;
 *  4. GET /api/model/attention; 5. GET /api/model/board;
 *  6. authority matrix projection; 7. GET /api/model/sources/tokens;
 *  8. model views (GET /api/model/views/diagram and .../plantuml);
 *  9. POST /api/conversations/:agentId/artifact-sources/read;
 * 10. conversations (GET /api/conversations, GET /api/operator-tools,
 *     POST /api/messages, POST /api/conversations/:agentId/messages,
 *     POST .../decisions, POST .../changes/:changeId/decision);
 * 11. cases (GET /api/cases, GET|POST /api/cases/:id[/close|run|pause|resume|stop]);
 * 12. model revisions (GET /api/model-revisions, /api/model-sources,
 *     /api/model-files, /api/model-history, /api/model-diff,
 *     /api/model-graph-diff, POST /api/model-version/adopt,
 *     /api/model-revisions/:id[/decision|/preview]);
 * 13. control (POST /api/messages when conversations declines it,
 *     POST /api/decisions, and 404 for every other POST);
 * 14. tail routes below: GET /api/state, GET /api/history,
 *     GET /api/history/:revision, GET /api/events, GET /api/model-events,
 *     GET /health, GET /favicon.ico; any other method is 405, anything else 404.
 *
 * Session exchange and authenticated Request opening run before conversations
 * and the control catch-all. They do not replace legacy message routing.
 *
 * Conversations therefore still shadows control on POST /api/messages, and
 * the control catch-all POST 404 stays last before the tail. */
import { Hono } from "@hono/hono";
import type { AssemblyEnvironment } from "../../../infrastructure/environment.ts";
import {
  isDevelopmentOriginAllowed,
  requireDevelopmentHost,
} from "../../../infrastructure/http/local-security.ts";
import { ChangePublicationError } from "../../../domain/model/publication/change.ts";
import { ChangeApprovabilityError } from "../../../domain/governance/policies/change-approvability.ts";
import { AuthorityInvariantError } from "../../../domain/governance/authority.ts";
import { CaseError } from "../../../domain/work/errors/case.ts";
import { publicPostgresFailure } from "../../out/postgres/errors.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { StateRevision } from "../../../domain/work/history.ts";
import type { LocalModelProject } from "../../out/filesystem/model-project.ts";
import type { SpaceController } from "../../../domain/work/request-spaces.ts";
import type {
  SseAudience,
  SseClient,
} from "../../../infrastructure/http/sse.ts";
import {
  errorLogProperties,
  technicalLogger,
} from "../../../infrastructure/logging.ts";

const log = technicalLogger("http");

/** An edge handler owns its pathname matching; null means "not my route". */
export type HttpEdgeHandler = (
  request: Request,
) => Promise<Response | null>;

/** Hono bindings: the serve info only the Fresh frontend consumes. */
export interface HttpAppBindings {
  serveInfo?: Deno.ServeHandlerInfo;
}

/** The narrow edge contract the composition assembly satisfies. */
export interface HttpAppDependencies {
  environment?: AssemblyEnvironment;
  handleFrontend: (
    request: Request,
    info?: Deno.ServeHandlerInfo,
  ) => Promise<Response | null>;
  handleModelDiagnostics: HttpEdgeHandler;
  service: { readonly snapshot: SystemRuntimeState };
  store: {
    listRevisions(): Promise<StateRevision[]>;
    loadRevision(revision: number): Promise<unknown>;
    loadProjection(revision: number): Promise<unknown>;
  };
  operatorWorkspace: {
    conversations: { conversations(): Promise<unknown> };
    cases: { readonly cases: unknown };
  };
  modelVersionEvents: {
    initial(): Promise<unknown>;
    publish(): Promise<unknown>;
  };
  clients: Set<ReadableStreamDefaultController<Uint8Array>>;
  /** Who an event stream is opened for, when its request carries a Request
   * session: Case events reach only their owner's streams (see root.ts). */
  eventAudience?: {
    identify(request: Request): Promise<SpaceController | undefined>;
    audience: SseAudience<SpaceController>;
  };
  handleModelRevisions: HttpEdgeHandler;
  handleControl: HttpEdgeHandler;
  handleConversations: HttpEdgeHandler;
  handleCaseModel?: HttpEdgeHandler;
  handleProviderResources?: HttpEdgeHandler;
  handleRequestSupervision?: HttpEdgeHandler;
  handleRequestOperatorDetails?: HttpEdgeHandler;
  handleArtifactSources: HttpEdgeHandler;
  handleSavedSystems?: HttpEdgeHandler;
  handleModelTags?: HttpEdgeHandler;
  handleRequestSourceRevisions?: HttpEdgeHandler;
  handleRequestRuntimeAdoption?: HttpEdgeHandler;
  handleSpaceSession: HttpEdgeHandler;
  handleRequestSpaceOpenings: HttpEdgeHandler;
  handleCases: HttpEdgeHandler;
  project: LocalModelProject | null;
  agents: { readonly label: string };
  projections: {
    handleModelAttention: HttpEdgeHandler;
    handleModelBoard: HttpEdgeHandler;
    handleAuthorityMatrix: HttpEdgeHandler;
    handleSourceTokens: HttpEdgeHandler;
    handleModelViews: HttpEdgeHandler;
    modelAttention: { warm(version: string): Promise<void> };
    readModelBoardHead(): Promise<string>;
  };
  liveGraph: {
    handleModelGraph: HttpEdgeHandler;
    graphClients: Set<ReadableStreamDefaultController<Uint8Array>>;
    status(): {
      version: string;
      activityDigest: string;
      error: string | null;
    };
  };
}

const encoder = new TextEncoder();

function events(
  set: Set<ReadableStreamDefaultController<Uint8Array>>,
  name: string,
  initial: unknown,
  request: Request,
  additional: Array<{ name: string; value: unknown }> = [],
  lifecycle?: {
    open(client: SseClient, disconnect: () => void): void;
    close(client: SseClient): void;
  },
): Response {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let timer: ReturnType<typeof setInterval>;
  const cleanup = () => {
    clearInterval(timer);
    request.signal.removeEventListener("abort", cleanup);
    set.delete(controller);
    lifecycle?.close(controller);
  };
  const disconnect = () => {
    cleanup();
    controller.close();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      set.add(c);
      c.enqueue(
        encoder.encode(`event: ${name}\ndata: ${JSON.stringify(initial)}\n\n`),
      );
      for (const event of additional) {
        c.enqueue(
          encoder.encode(
            `event: ${event.name}\ndata: ${JSON.stringify(event.value)}\n\n`,
          ),
        );
      }
      timer = setInterval(() => {
        try {
          c.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, 15000);
      request.signal.addEventListener("abort", cleanup, { once: true });
      lifecycle?.open(c, disconnect);
    },
    cancel: cleanup,
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    },
  });
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
const revisionFromPath = (pathname: string) => {
  const match = pathname.match(/^\/api\/history\/(0|[1-9][0-9]*)$/);
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : null;
};

export function createHttpApp(
  dependencies: HttpAppDependencies,
): Hono<{ Bindings: HttpAppBindings }> {
  const {
    handleFrontend,
    handleModelDiagnostics,
    service,
    store,
    operatorWorkspace,
    modelVersionEvents,
    clients,
    handleModelRevisions,
    handleControl,
    handleConversations,
    handleArtifactSources,
    handleSpaceSession,
    handleRequestSpaceOpenings,
    handleCases,
    project,
    agents,
  } = dependencies;
  const {
    handleModelAttention,
    handleModelBoard,
    handleAuthorityMatrix,
    handleSourceTokens,
    handleModelViews,
    modelAttention,
    readModelBoardHead,
  } = dependencies.projections;
  const {
    handleModelGraph,
    graphClients,
    status: graphStatus,
  } = dependencies.liveGraph;
  // After a successful mask change, the head has not moved but its attention
  // count has: recompute it for the head, then republish model-version.
  const handleModelDiagnosticsWithAttention = async (
    request: Request,
  ): Promise<Response | null> => {
    const response = await handleModelDiagnostics(request);
    if (
      response && request.method === "POST" &&
      new URL(request.url).pathname === "/api/model/diagnostics/masks" &&
      response.status === 200
    ) {
      // In the background: the mask response never waits for a cold matrix.
      void (async () => {
        await modelAttention.warm(await readModelBoardHead());
        await modelVersionEvents.publish();
      })().catch((error) =>
        log.warn(
          "Model attention mask follow-up failed",
          errorLogProperties(error),
        )
      );
    }
    return response;
  };

  const app = new Hono<{ Bindings: HttpAppBindings }>();
  app.onError((caught) => {
    const error = publicPostgresFailure(caught) ?? caught;
    return json(
      {
        ...(error instanceof ChangePublicationError ||
            error instanceof CaseError
          ? {
            code: error.code,
            context: error.context,
            recovery: error.recovery,
          }
          : {}),
        ...(error instanceof AuthorityInvariantError
          ? {
            code: error.code,
            invariant: error.invariant,
            reason: error.reason,
            ...(error instanceof ChangeApprovabilityError
              ? { context: error.context, recovery: error.recovery }
              : {}),
          }
          : {}),
        error: error instanceof Error
          ? error.message.slice(0, 450)
          : "Opération échouée",
      },
      error instanceof ChangePublicationError || error instanceof CaseError ||
        service.snapshot.busy
        ? 409
        : 400,
    );
  });
  // Ordered edge delegation, first match wins: each inbound adapter owns its
  // pathname matching and returns null when the request is not its route.
  app.use(async (c, next) => {
    const request = c.req.raw;
    const environment = dependencies.environment ?? "production";
    if (environment === "development") {
      try {
        requireDevelopmentHost(request);
      } catch {
        return Response.json({
          code: "HOST_REFUSED",
          error: "Local host required.",
        }, { status: 403, headers: { "cache-control": "no-store" } });
      }
      const origin = request.headers.get("origin");
      if (
        (origin === null &&
          request.headers.get("sec-fetch-site") === "cross-site") ||
        ((origin !== null ||
          !["GET", "HEAD", "OPTIONS"].includes(request.method)) &&
          !isDevelopmentOriginAllowed(request))
      ) {
        return Response.json({
          code: "ORIGIN_REFUSED",
          error: "Local origin required.",
        }, { status: 403, headers: { "cache-control": "no-store" } });
      }
    }
    if (
      request.method === "GET" &&
      new URL(request.url).pathname === "/api/environment"
    ) {
      return Response.json({ environment }, {
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    // Direct app.fetch/app.request callers may omit the bindings; the serve
    // handler below always provides them.
    const frontendResponse = await handleFrontend(request, c.env?.serveInfo);
    if (frontendResponse) return frontendResponse;
    const resourceResponse = await dependencies.handleProviderResources?.(
      request,
    );
    if (resourceResponse) return resourceResponse;
    const supervisionResponse = await dependencies.handleRequestSupervision?.(
      request,
    );
    if (supervisionResponse) return supervisionResponse;
    const operatorDetailsResponse = await dependencies
      .handleRequestOperatorDetails?.(
        request,
      );
    if (operatorDetailsResponse) return operatorDetailsResponse;
    const caseModelResponse = await dependencies.handleCaseModel?.(request);
    if (caseModelResponse) return caseModelResponse;
    const graphResponse = await handleModelGraph(request);
    if (graphResponse) return graphResponse;
    const diagnosticsResponse = await handleModelDiagnosticsWithAttention(
      request,
    );
    if (diagnosticsResponse) return diagnosticsResponse;
    const attentionResponse = await handleModelAttention(request);
    if (attentionResponse) return attentionResponse;
    const boardResponse = await handleModelBoard(request);
    if (boardResponse) return boardResponse;
    const matrixResponse = await handleAuthorityMatrix(request);
    if (matrixResponse) return matrixResponse;
    // Both /api/messages (central agent) and operator-addressed messages share
    // the explicit Request selection and structured errors in this adapter.
    const tokensResponse = await handleSourceTokens(request);
    if (tokensResponse) return tokensResponse;
    const viewsResponse = await handleModelViews(request);
    if (viewsResponse) return viewsResponse;
    const artifactSourcesResponse = await handleArtifactSources(request);
    if (artifactSourcesResponse) return artifactSourcesResponse;
    const modelTagsResponse = await dependencies.handleModelTags?.(request);
    if (modelTagsResponse) return modelTagsResponse;
    const savedSystemsResponse = await dependencies.handleSavedSystems?.(
      request,
    );
    if (savedSystemsResponse) return savedSystemsResponse;
    const adoptionResponse = await dependencies.handleRequestRuntimeAdoption?.(
      request,
    );
    if (adoptionResponse) return adoptionResponse;
    const sourceRevisionResponse = await dependencies
      .handleRequestSourceRevisions?.(request);
    if (sourceRevisionResponse) return sourceRevisionResponse;
    const sessionResponse = await handleSpaceSession(request);
    if (sessionResponse) return sessionResponse;
    const openingResponse = await handleRequestSpaceOpenings(request);
    if (openingResponse) return openingResponse;
    const conversationResponse = await handleConversations(request);
    if (conversationResponse) return conversationResponse;
    const casesResponse = await handleCases(request);
    if (casesResponse) return casesResponse;
    const modelResponse = await handleModelRevisions(request);
    if (modelResponse) return modelResponse;
    const controlResponse = await handleControl(request);
    if (controlResponse) return controlResponse;
    await next();
  });
  // Control 404s every POST reaching it, so past the delegation only GET and
  // other methods remain: anything but GET is 405, as in the former dispatch.
  app.use(async (c, next) => {
    if (c.req.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }
    await next();
  });
  app.get("/api/state", () => json(service.snapshot));
  app.get("/api/history", async () => {
    const revisions = (await store.listRevisions()).map((entry) => ({
      revision: entry.revision,
      recordedAt: entry.recordedAt,
      origin: entry.origin,
      label: entry.label,
      agentCount: entry.agentCount,
      activeToolCount: entry.activeToolCount,
      catalogRevision: entry.catalogRevision,
      hasProjection: entry.hasProjection,
    }));
    return json({ currentRevision: service.snapshot.revision, revisions });
  });
  app.get("/api/history/:revision", async (c) => {
    const historicalRevision = revisionFromPath(new URL(c.req.url).pathname);
    if (historicalRevision === null) return c.notFound();
    const [state, projection] = await Promise.all([
      store.loadRevision(historicalRevision),
      store.loadProjection(historicalRevision),
    ]);
    if (!state) return json({ error: "Révision introuvable" }, 404);
    return json({ state, projection });
  });
  app.get("/api/events", async (c) => {
    const request = c.req.raw;
    // A design notification is advisory; its failure must not close the live stream.
    const modelVersionInitial: Array<{ name: string; value: unknown }> = [];
    try {
      modelVersionInitial.push({
        name: "model-version",
        value: await modelVersionEvents.initial(),
      });
    } catch (error) {
      log.warn(
        "Initial model version notification failed",
        errorLogProperties(error),
      );
    }
    // A stream opened with a Request session hears its owner's Case events;
    // one without (or with an expired one) hears none of them.
    const audience = dependencies.eventAudience;
    let member: SpaceController | undefined;
    try {
      member = await audience?.identify(request);
    } catch {
      member = undefined;
    }
    return events(
      clients,
      "state",
      service.snapshot,
      request,
      [{
        name: "conversations",
        value: await operatorWorkspace.conversations.conversations(),
      }, {
        name: "cases",
        value: operatorWorkspace.cases.cases,
      }, ...modelVersionInitial],
      audience && member
        ? {
          open: (client, disconnect) =>
            audience.audience.join(client, member, disconnect),
          close: (client) => audience.audience.leave(client),
        }
        : undefined,
    );
  });
  app.get("/api/model-events", (c) => {
    const request = c.req.raw;
    const graph = graphStatus();
    return events(
      graphClients,
      "model",
      {
        version: graph.version,
        activityDigest: graph.activityDigest,
        error: graph.error,
      },
      request,
    );
  });
  app.get("/health", () =>
    json({
      ready: true,
      modelReady: graphStatus().error === null,
      provider: agents.label,
      modelBackend: "SysML Toolkit + Git",
      modelProject: project
        ? {
          id: project.id,
          name: project.name,
          directory: project.projectDir,
        }
        : null,
    }));
  app.get("/favicon.ico", () => new Response(null, { status: 204 }));
  app.notFound(() => new Response("Not found", { status: 404 }));
  return app;
}

/** The Deno serve handler: Hono fetch with the serve info in its bindings. */
export function createHttpServeHandler(
  dependencies: HttpAppDependencies,
): Deno.ServeHandler {
  const app = createHttpApp(dependencies);
  return (request, info) => app.fetch(request, { serveInfo: info });
}
