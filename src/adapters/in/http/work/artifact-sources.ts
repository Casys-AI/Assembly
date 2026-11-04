import { formatPatch, structuredPatch } from "diff";
import type { ArtifactSourceServicePort } from "../../../../application/work/artifacts/publication.ts";
import { canonical } from "../../../../domain/primitives/canonical-json.ts";
import {
  type ArtifactSourceBindingReference,
  ArtifactSourceError,
  sourceIdentity,
  validateSourceBindingReference,
} from "../../../../domain/work/artifacts/source-reference.ts";
import type {
  AgentConversation,
  ConversationsSnapshot,
} from "../../../../application/work/operators/conversation-types.ts";
import type {
  ArtifactSourceInspection,
  InspectedArtifactSource,
} from "../../../../domain/work/records/artifact-source-inspection.ts";
import {
  LocalHttpFailure,
  requireLocalJsonCommand,
} from "../../../../infrastructure/http/local-security.ts";

export interface ArtifactSourcesReadApplication {
  /** The same current host read scope as the conversation collection. */
  conversations(): ConversationsSnapshot | Promise<ConversationsSnapshot>;
  /** Trusted composition selects owner and scoped SQL/Git service. */
  sourceContext(conversation: AgentConversation): Promise<
    {
      ownerId: string;
      sources: Pick<ArtifactSourceServicePort, "resolveTool" | "resolveSkill">;
    } | null
  >;
}
const unavailable = () =>
  Response.json({
    code: "ARTIFACT_SOURCE_UNAVAILABLE",
    error:
      "The exact retained source is unavailable. Read its catalog record again or choose another known version.",
  }, {
    status: 404,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

async function bindingsBody(
  request: Request,
): Promise<ArtifactSourceBindingReference[]> {
  const reader = request.body?.getReader();
  if (!reader) throw new ArtifactSourceError("invalid");
  let text = "", length = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 16_384) {
        await reader.cancel();
        throw new ArtifactSourceError("limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const value = JSON.parse(text);
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 1 || !Array.isArray(value.bindings) ||
    value.bindings.length < 1 || value.bindings.length > 2
  ) throw new ArtifactSourceError("invalid");
  for (const binding of value.bindings) validateSourceBindingReference(binding);
  return structuredClone(value.bindings);
}

export function inspectedSourceText(source: InspectedArtifactSource): string {
  return typeof source.content === "string"
    ? source.content
    : JSON.stringify(source.content, null, 2) + "\n";
}

function comparison(
  before: InspectedArtifactSource,
  after: InspectedArtifactSource,
): string {
  if (inspectedSourceText(before) === inspectedSourceText(after)) return "";
  const path = before.binding.reference.kind === "tool-draft"
    ? "source.json"
    : "SKILL.md";
  const patch = structuredPatch(
    `a/${path}`,
    `b/${path}`,
    inspectedSourceText(before),
    inspectedSourceText(after),
    undefined,
    undefined,
    { context: 3, timeout: 1000, maxEditLength: 20_000 },
  );
  if (!patch) throw new ArtifactSourceError("limit");
  patch.isGit = true;
  const result = formatPatch(patch);
  if (new TextEncoder().encode(result).byteLength > 2_097_152) {
    throw new ArtifactSourceError("limit");
  }
  return result;
}

/** Human host read only. No source publication, admission, activation or skill load port. */
export function createArtifactSourcesHandler(
  application: ArtifactSourcesReadApplication,
  servedOrigin:
    import("../../../../infrastructure/http/local-security.ts").LocalHttpOrigin,
) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const match = url.pathname.match(
      /^\/api\/conversations\/([^/]+)\/artifact-sources\/read$/,
    );
    if (!match) return null;
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "POST", "cache-control": "no-store" },
      });
    }
    try {
      requireLocalJsonCommand(request, servedOrigin);
      if (url.search) return unavailable();
      const agentId = decodeURIComponent(match[1]!);
      if (
        !sourceIdentity(agentId) || agentId.length > 256 ||
        agentId.includes("/") || agentId === "." || agentId === ".."
      ) return unavailable();
      const snapshot = await application.conversations();
      const conversation = snapshot.conversations.find((entry) =>
        entry.agentId === agentId
      );
      if (!conversation) return unavailable();
      const bindings = await bindingsBody(request);
      const context = await application.sourceContext(conversation);
      if (
        !context || bindings.some((binding) =>
          binding.ownerId !== context.ownerId
        ) ||
        bindings.some((binding) =>
          binding.reference.kind !== bindings[0]!.reference.kind
        )
      ) return unavailable();
      const sources: InspectedArtifactSource[] = [];
      for (const binding of bindings) {
        const selection = {
          expectedBinding: binding,
          bindingId: binding.bindingId,
          ownerId: context.ownerId,
          localArtifactId: binding.localArtifactId,
          expectedDigest: binding.reference.contentDigest,
          reference: binding.reference,
        };
        const content = binding.reference.kind === "tool-draft"
          ? await context.sources.resolveTool(selection)
          : await context.sources.resolveSkill(selection);
        sources.push({ binding, content });
      }
      // Revocation/removal during asynchronous SQL/Git reads also refuses the result.
      const currentSnapshot = await application.conversations();
      if (currentSnapshot.systemId !== snapshot.systemId) return unavailable();
      const current = currentSnapshot.conversations.find((entry) =>
        entry.agentId === agentId
      );
      if (
        !current || current.nativeId !== conversation.nativeId
      ) return unavailable();
      const currentContext = await application.sourceContext(current);
      if (
        !currentContext || currentContext.ownerId !== context.ownerId
      ) return unavailable();
      const result: ArtifactSourceInspection = {
        sources,
        ...(sources.length === 2
          ? { patch: comparison(sources[0]!, sources[1]!) }
          : {}),
      };
      // Construct the envelope only after both reads and all current-scope checks succeed.
      return new Response(canonical(result), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      if (error instanceof LocalHttpFailure) {
        return Response.json({ code: error.code, error: error.message }, {
          status: error.status,
          headers: { "cache-control": "no-store" },
        });
      }
      return unavailable();
    }
  };
}
