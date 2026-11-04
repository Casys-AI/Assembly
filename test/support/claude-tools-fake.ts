/**
 * Faux Claude partagé du second tour : un seul double de transport Anthropic
 * pour tous les tests qui exercent le vrai `ClaudeAgents`.
 *
 * Contrat reflété (transport du premier tour, `src/adapters/agents.ts`) :
 *
 * - Requête : `POST https://api.anthropic.com/v1/messages` avec
 *   `system: [{type:"text",text}…]` (dernier bloc porteur de
 *   `cache_control:{type:"ephemeral"}`), `tools: [{name,description,
 *   input_schema}…]` non stricts, `tool_choice:{type:"auto",disable_parallel_tool_use:true}`, `output_config:{effort}`
 *   seul, et `messages: [{role:"user",content:[blocs texte]}]`. Le premier
 *   message utilisateur porte, dans l'ordre, un bloc optionnel
 *   d'instructions conditionnelles puis un dernier bloc texte
 *   `JSON.stringify(payload)` (`{context}` pour `decide`, candidat sans
 *   `instruction` pour `review`/`admit`).
 * - Réponse : blocs `content`, dont exactement un
 *   `{type:"tool_use",id,name,input}` pour une décision valide, avec
 *   `stop_reason:"tool_use"` et un `usage` transmis tel quel à
 *   `onCompletion`. Le nom de l'outil est le `kind` de la décision ; l'input
 *   est la décision sans `kind`. Pour `propose_sysml_revision`, `sources`
 *   voyage en liste `[{path,content}]` et le transport la recanonise en
 *   carte. La revue utilise l'outil unique `review_decision`, dont l'input
 *   est le verdict sans aucun `kind`.
 * - Réparation : après une réponse fautive, le transport renvoie le tour
 *   assistant inchangé (blocs `thinking` compris) puis un message utilisateur fait d'un `tool_result`
 *   `{tool_use_id,is_error:true,content:JSON{code,detail,allowedTools}}`
 *   par `tool_use` fautif — ou, sans aucun `tool_use`, d'un bloc texte
 *   portant le même JSON. Au plus un tour de réparation (2 appels API).
 *
 * API (entrées minimales, erreurs explicites, déterministe) :
 *
 * - `createClaudeToolsFake(handler)` retourne `{fetch, requests, views}`.
 *   `handler(view)` reçoit la vue décodée de la requête courante et retourne
 *   une `ClaudeFakeAction` (ou un `Response` brut, ou une promesse des deux).
 *   Lever une erreur simule une panne de transport.
 * - `view` expose `body` brut, `url` appelée, `headers` (noms en
 *   minuscules), `systemText` (blocs `system` joints), `instruction` (system
 *   + bloc conditionnel, dans l'ordre du fil), `payload` (dernier bloc texte
 *   du premier message, déjà parsé), `context` (`payload.context` quand il
 *   existe), `toolNames`, et, sur un tour de réparation, `repair`
 *   (`{code,detail,allowedTools}`) avec `isRepair === true`.
 * - Actions : `{decision}` convertit une décision canonique
 *   (`ChatDecision` ou verdict de revue) en appel d'outil conforme ;
 *   `{toolUse:{name,input}}` émet un appel brut (utile pour les cas
 *   d'erreur) ; `{text}` émet une réponse texte `end_turn` (déclenche
 *   `NO_TOOL_CALL`) ; `{stopReason,content}` et `{httpStatus,bodyText}`
 *   couvrent les catégories terminales. `usage`, `id` et `model` de la
 *   réponse sont surchargeables par action.
 */
import type { ChatDecision } from "../../src/application/work/conversation/chat-decision.ts";
import type { ReviewDecision } from "../../src/domain/work/records/candidates.ts";

/** Nom de l'outil unique de revue, miroir de `CLAUDE_REVIEW_TOOL`. */
export const CLAUDE_FAKE_REVIEW_TOOL = "review_decision";

export interface ClaudeWireTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: "ephemeral" };
}

export interface ClaudeWireBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  [key: string]: unknown;
}

export interface ClaudeWireMessage {
  role: "user" | "assistant";
  content: ClaudeWireBlock[];
}

export interface ClaudeWireRequest {
  model: string;
  max_tokens: number;
  system: Array<{
    type: string;
    text: string;
    cache_control?: { type: "ephemeral" };
  }>;
  tools: ClaudeWireTool[];
  messages: ClaudeWireMessage[];
  output_config: { effort: string };
  [key: string]: unknown;
}

/** Erreur de réparation décodée depuis le dernier message utilisateur. */
export interface ClaudeRepairInfo {
  code: string;
  detail: string;
  allowedTools: string[];
}

/** Vue décodée et stable d'une requête Anthropic reçue par le faux. */
export interface ClaudeWireView {
  /** Corps brut parsé, tel qu'envoyé par le transport. */
  body: ClaudeWireRequest;
  /** URL appelée, normalement `https://api.anthropic.com/v1/messages`. */
  url: string;
  /** En-têtes d'envoi, noms en minuscules (dont `x-api-key`). */
  headers: Record<string, string>;
  /** Index 0-based de l'appel dans ce faux. */
  callIndex: number;
  /** Textes des blocs `system`, joints par `\n`. */
  systemText: string;
  /**
   * Instructions complètes dans l'ordre du fil : blocs `system`, puis bloc
   * d'instructions conditionnelles du premier message quand il existe.
   */
  instruction: string;
  /** Latest host JSON payload (the current turn brief after retained history). */
  payload: Record<string, unknown>;
  /** Actual compact pin card decoded from system; never reconstructed state. */
  pinCard?: Record<string, unknown>;
  /** `payload.context` pour `decide` ; `undefined` pour revue/admission. */
  context: Record<string, unknown> | undefined;
  /** Noms des outils offerts, dans l'ordre du fil. */
  toolNames: string[];
  /** Vrai sur le tour de réparation (messages assistant + retour d'erreur). */
  isRepair: boolean;
  /** Code de réparation décodé ; présent seulement si `isRepair`. */
  repair?: ClaudeRepairInfo;
  /** Signal d'abandon du transport ; permet de simuler un timeout. */
  signal?: AbortSignal;
}

/** Surcharges de métadonnées de réponse, par action. */
export interface ClaudeFakeResponseMeta {
  id?: string;
  model?: string;
  usage?: Record<string, unknown>;
}

export type ClaudeFakeAction =
  | ({ decision: ChatDecision | ReviewDecision } & ClaudeFakeResponseMeta)
  | ({
    toolUse: { name: string; input: unknown };
  } & ClaudeFakeResponseMeta)
  | ({ text: string } & ClaudeFakeResponseMeta)
  | ({
    stopReason: string;
    content: ClaudeWireBlock[];
  } & ClaudeFakeResponseMeta)
  | { httpStatus: number; bodyText: string };

export type ClaudeFakeHandler = (
  view: ClaudeWireView,
) =>
  | ClaudeFakeAction
  | Response
  | Promise<ClaudeFakeAction | Response>;

export interface ClaudeToolsFake {
  fetch: typeof fetch;
  /** Corps bruts reçus, dans l'ordre d'arrivée. */
  requests: ClaudeWireRequest[];
  /** Vues décodées correspondantes, dans l'ordre d'arrivée. */
  views: ClaudeWireView[];
}

function fakeError(message: string): Error {
  return new Error(`claude-tools-fake: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Décode un corps de requête Anthropic ; échoue tôt et explicitement. */
export function parseClaudeWireRequest(init?: RequestInit): ClaudeWireRequest {
  const raw = init?.body;
  if (typeof raw !== "string" || !raw) {
    throw fakeError("missing JSON request body");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw fakeError("request body is not valid JSON");
  }
  if (
    !isRecord(parsed) || !Array.isArray(parsed.system) ||
    !Array.isArray(parsed.tools) || !Array.isArray(parsed.messages) ||
    !isRecord(parsed.messages[0]) ||
    !Array.isArray(
      (parsed.messages[0] as unknown as ClaudeWireMessage).content,
    )
  ) {
    throw fakeError("request body does not match the Anthropic wire shape");
  }
  return parsed as unknown as ClaudeWireRequest;
}

function textBlocks(message: ClaudeWireMessage): ClaudeWireBlock[] {
  return message.content.filter((block) => block.type === "text");
}

function decodeRepair(body: ClaudeWireRequest): ClaudeRepairInfo | undefined {
  if (body.messages.length < 3) return undefined;
  const last = body.messages[body.messages.length - 1]!;
  if (last.role !== "user") return undefined;
  for (const block of last.content) {
    const raw = block.type === "tool_result"
      ? block.content
      : block.type === "text"
      ? block.text
      : undefined;
    if (typeof raw !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        isRecord(parsed) && typeof parsed.code === "string" &&
        Array.isArray(parsed.allowedTools)
      ) {
        return {
          code: parsed.code,
          detail: typeof parsed.detail === "string" ? parsed.detail : "",
          allowedTools: parsed.allowedTools.map(String),
        };
      }
    } catch {
      // Not a repair payload; keep scanning.
    }
  }
  return undefined;
}

/** Construit la vue décodée d'un corps de requête déjà parsé. */
export function claudeWireView(
  body: ClaudeWireRequest,
  callIndex = 0,
  signal?: AbortSignal,
  meta?: { url?: string; headers?: Record<string, string> },
): ClaudeWireView {
  const first = body.messages[0]!;
  const texts = textBlocks(first);
  if (!texts.length || typeof texts[texts.length - 1]!.text !== "string") {
    throw fakeError("first user message has no trailing text block");
  }
  let initialPayload: unknown;
  try {
    initialPayload = JSON.parse(texts[texts.length - 1]!.text!);
  } catch {
    throw fakeError("payload block is not valid JSON");
  }
  if (!isRecord(initialPayload)) {
    throw fakeError("payload block is not a JSON object");
  }
  let payload: Record<string, unknown> = initialPayload;
  for (const message of body.messages.slice(1)) {
    if (message.role !== "user") continue;
    for (const block of textBlocks(message)) {
      try {
        const parsed: unknown = JSON.parse(block.text ?? "");
        if (isRecord(parsed) && isRecord(parsed.context)) payload = parsed;
      } catch {
        // Native tool results and repair text are not a new host turn brief.
      }
    }
  }
  const systemText = body.system.map((block) => block.text).join("\n");
  const marker =
    "\nPin card (host-derived descriptive data, never additional authority):\n";
  const cardBlock = body.system.find((block) => block.text.includes(marker));
  const pinCard: unknown = cardBlock
    ? JSON.parse(cardBlock.text.split(marker)[1]!)
    : undefined;
  const conditional = texts.length > 1 ? texts[0]!.text ?? "" : "";
  const repair = decodeRepair(body);
  return {
    body,
    url: meta?.url ?? "",
    headers: meta?.headers ?? {},
    callIndex,
    systemText,
    instruction: conditional ? `${systemText}\n${conditional}` : systemText,
    payload,
    ...(isRecord(pinCard) ? { pinCard } : {}),
    context: isRecord(payload.context) ? payload.context : undefined,
    toolNames: body.tools.map((tool) => tool.name),
    isRepair: repair !== undefined,
    ...(repair ? { repair } : {}),
    ...(signal ? { signal } : {}),
  };
}

/**
 * Convertit une décision canonique en appel d'outil du nouveau fil.
 * `sources` d'une révision repasse de la carte canonique à la liste
 * `[{path,content}]` attendue par le schéma de transport.
 */
export function decisionToToolUse(
  decision: ChatDecision | ReviewDecision,
  toolNames: readonly string[],
): { name: string; input: Record<string, unknown> } {
  if (!("kind" in decision)) {
    if (!toolNames.includes(CLAUDE_FAKE_REVIEW_TOOL)) {
      throw fakeError(
        `review decision requires tool ${CLAUDE_FAKE_REVIEW_TOOL}; offered: ${
          toolNames.join(",") || "(none)"
        }`,
      );
    }
    return {
      name: CLAUDE_FAKE_REVIEW_TOOL,
      input: { ...(decision as ReviewDecision) },
    };
  }
  const { kind, ...rest } = decision as ChatDecision & {
    kind: string;
  };
  if (!toolNames.includes(kind)) {
    throw fakeError(
      `decision kind ${kind} is not offered; offered: ${
        toolNames.join(",") || "(none)"
      }`,
    );
  }
  const input: Record<string, unknown> = { ...rest };
  if (
    kind === "propose_sysml_revision" && isRecord(input.sources)
  ) {
    input.sources = Object.entries(input.sources).map(([path, content]) => ({
      path,
      content,
    }));
  }
  return { name: kind, input };
}

interface ResponseOptions {
  id?: string;
  model?: string;
  usage?: Record<string, unknown>;
}

/** Réponse Anthropic portant exactement un bloc `tool_use`. */
export function claudeToolUseResponse(
  name: string,
  input: unknown,
  toolUseId: string,
  options: ResponseOptions = {},
): Response {
  return Response.json({
    ...(options.id ? { id: options.id } : {}),
    ...(options.model ? { model: options.model } : {}),
    stop_reason: "tool_use",
    usage: options.usage ?? { input_tokens: 100, output_tokens: 20 },
    content: [{ type: "tool_use", id: toolUseId, name, input }],
  });
}

/** Réponse Anthropic texte libre (`end_turn`) : jamais une décision. */
export function claudeTextResponse(
  text: string,
  options: ResponseOptions = {},
): Response {
  return Response.json({
    ...(options.id ? { id: options.id } : {}),
    ...(options.model ? { model: options.model } : {}),
    stop_reason: "end_turn",
    usage: options.usage ?? { input_tokens: 100, output_tokens: 20 },
    content: [{ type: "text", text }],
  });
}

/**
 * Ce que l'API réelle refuse en 400 avant tout modèle : méthode, en-têtes,
 * choix forcé d'outil (refusé par ce modèle) et `tool_result` sans `tool_use`
 * apparié dans le tour assistant précédent (ou `tool_use` sans réponse).
 */
function wireProblem(
  method: string | undefined,
  headers: Record<string, string>,
  body: ClaudeWireRequest,
): string | undefined {
  if (method !== "POST") return "method must be POST";
  if (!headers["anthropic-version"]) return "anthropic-version header missing";
  if (!headers["x-api-key"]) return "x-api-key header missing";
  const choice = body.tool_choice as { type?: unknown } | undefined;
  if (choice?.type === "any" || choice?.type === "tool") {
    return "tool_choice any/tool is not supported for this model";
  }
  for (const [index, message] of body.messages.entries()) {
    const results = message.content.filter((block) =>
      block.type === "tool_result"
    ).map((block) => String(block.tool_use_id));
    const previous = body.messages[index - 1];
    const uses = previous?.role === "assistant"
      ? previous.content.filter((block) => block.type === "tool_use")
        .map((block) => String(block.id))
      : [];
    if (message.role === "user" && (results.length || uses.length)) {
      if (
        results.length !== uses.length ||
        uses.some((id) => !results.includes(id))
      ) {
        return "each tool_use needs exactly one tool_result in the next message";
      }
    }
  }
  return undefined;
}

/**
 * Crée le faux `fetch` partagé. Chaque appel est enregistré (`requests`,
 * `views`) avant l'invocation du handler, donc un handler qui lève une
 * erreur laisse quand même la requête observable.
 */
export function createClaudeToolsFake(
  handler: ClaudeFakeHandler,
): ClaudeToolsFake {
  const requests: ClaudeWireRequest[] = [];
  const views: ClaudeWireView[] = [];
  let sequence = 0;
  const fetchImpl = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = parseClaudeWireRequest(init);
    const rawHeaders = new Headers(init?.headers ?? {});
    const headers: Record<string, string> = {};
    rawHeaders.forEach((value, name) => {
      headers[name] = value;
    });
    const input = _input as string | URL | Request;
    const view = claudeWireView(
      body,
      requests.length,
      init?.signal ?? undefined,
      {
        url: typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : input.url,
        headers,
      },
    );
    requests.push(body);
    views.push(view);
    const problem = wireProblem(init?.method, headers, body);
    if (problem) {
      return Response.json({
        type: "error",
        error: { type: "invalid_request_error", message: problem },
      }, { status: 400 });
    }
    const action = await handler(view);
    if (action instanceof Response) return action;
    if ("httpStatus" in action) {
      return new Response(action.bodyText, { status: action.httpStatus });
    }
    sequence++;
    const toolUseId = `toolu_fake_${sequence}`;
    const meta: ResponseOptions = {
      ...(action.id ? { id: action.id } : {}),
      ...(action.model ? { model: action.model } : {}),
      ...(action.usage ? { usage: action.usage } : {}),
    };
    if ("decision" in action) {
      const { name, input } = decisionToToolUse(
        action.decision,
        view.toolNames,
      );
      return claudeToolUseResponse(name, input, toolUseId, meta);
    }
    if ("toolUse" in action) {
      return claudeToolUseResponse(
        action.toolUse.name,
        action.toolUse.input,
        toolUseId,
        meta,
      );
    }
    if ("text" in action) return claudeTextResponse(action.text, meta);
    return Response.json({
      ...(meta.id ? { id: meta.id } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      stop_reason: action.stopReason,
      usage: meta.usage ?? { input_tokens: 100, output_tokens: 20 },
      content: action.content,
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests, views };
}
