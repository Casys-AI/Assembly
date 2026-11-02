import { isPlainRecord as isRecord } from "../../../domain/primitives/is-plain-record.ts";
import {
  ChatAnthropic,
  type ChatAnthropicCallOptions,
} from "@langchain/anthropic";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  type CompletionObservationControl,
  CompletionObserver,
  type CompletionSink,
} from "./completion-observer.ts";
import type { ChatDecision } from "../../../domain/work/dialogue.ts";
import { currentProviderCallCorrelation } from "./provider-call-context.ts";
import {
  decisionBatchError,
  decisionSchema,
  MAX_DECISION_CALLS,
  relevantErrors,
  reviewSchema,
  validateDecision,
  validateReview,
} from "./output-validation.ts";
import {
  ajvDetail,
  BATCH_DIRECTIVE,
  batchMemberSchema,
  boundedDetail,
  buildProviderTools,
  canonicalProviderResult,
  ProviderCallError,
  TOOL_DIRECTIVE,
} from "./provider-tools.ts";
import {
  StructuredAgents,
  type StructuredPromptParts,
} from "./structured-agents.ts";

export interface LangChainAgentsOptions {
  apiKey: string;
  model: string;
  /** Owned request deadline. This adapter does not propagate caller/job aborts. */
  timeoutMs?: number;
  /** Technical provider budget, never execution or modeling authority. */
  decisionMaxTokens?: number;
  effort?: string;
  fetch?: typeof fetch;
  onCompletion?: CompletionSink;
  /** Bounded collection stall threshold; defaults to one second. */
  completionStallMs?: number;
}

type ProviderEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;

/** A result must correlate to the exact assistant call, without inventing IDs. */
function resultMessage(result: {
  id: string;
  result: string;
  isError?: boolean;
}): BaseMessage {
  // ChatAnthropic 1.5.12 does not forward ToolMessage.status as is_error.
  // Its documented native content-block support preserves this exact flag.
  return result.isError
    ? new HumanMessage({
      content: [{
        type: "tool_result",
        tool_use_id: result.id,
        is_error: true,
        content: result.result,
      }],
    })
    : new ToolMessage({ tool_call_id: result.id, content: result.result });
}

function contentBlocks(message: Pick<AIMessage, "content">): unknown[] {
  return typeof message.content === "string"
    ? message.content ? [{ type: "text", text: message.content }] : []
    : message.content;
}

/** SDK transport only: the host's native choose step requests one bounded decision.
 * No LangChain agent loop, tool execution, authority or durable state lives here.
 * Credentials are supplied explicitly by the composition root and never returned.
 */
export class LangChainAgents extends StructuredAgents {
  readonly label = "Claude API";
  private readonly options: LangChainAgentsOptions;
  private readonly timeoutMs: number;
  private readonly observer: CompletionObserver;
  readonly completionObservation: CompletionObservationControl;
  constructor(options: LangChainAgentsOptions) {
    super();
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (
      !options.apiKey.trim() || !options.model.trim() ||
      !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 ||
      !["low", "medium", "high", "xhigh", "max"].includes(
        options.effort ?? "high",
      ) ||
      (options.decisionMaxTokens !== undefined &&
        (!Number.isSafeInteger(options.decisionMaxTokens) ||
          options.decisionMaxTokens < 1 || options.decisionMaxTokens > 65536))
    ) throw new Error("Invalid Claude configuration");
    this.options = { ...options };
    this.observer = new CompletionObserver(options.onCompletion, {
      stallMs: options.completionStallMs,
    });
    this.completionObservation = this.observer;
  }

  protected async call(
    prompt: string,
    schema: object,
    parts?: StructuredPromptParts,
  ): Promise<unknown> {
    const controller = new AbortController();
    let transportFailure: string | undefined;
    let transportTimedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ProviderCallError("request timed out"));
      }, this.timeoutMs);
    });
    // The SDK owns HTTP, tool encoding and response conversion. This wrapper
    // caps bytes before its JSON parser and preserves only host-authored errors.
    const boundedFetch: typeof fetch = async (input, init) => {
      try {
        const response = await (this.options.fetch ?? fetch)(input, init);
        if (!response.ok) {
          transportFailure = `HTTP ${response.status}`;
          await response.body?.cancel();
          throw new ProviderCallError(transportFailure);
        }
        if (!response.body) {
          transportFailure = "missing response body";
          throw new ProviderCallError(transportFailure);
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_PROVIDER_RESPONSE_BYTES) {
              transportFailure = "response-size limit exceeded";
              await reader.cancel();
              throw new ProviderCallError(transportFailure);
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        // ChatAnthropic accepts a string `content` envelope as ordinary text.
        // Refuse malformed protocol envelopes before that coercion: they are
        // terminal failures, never a reason to spend the one domain repair.
        // The SDK still owns message/tool decoding and usage normalization.
        let envelope: unknown;
        try {
          envelope = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          transportFailure = "invalid response JSON";
          throw new ProviderCallError(transportFailure);
        }
        if (!isRecord(envelope) || !Array.isArray(envelope.content)) {
          transportFailure = "invalid response shape";
          throw new ProviderCallError(transportFailure);
        }
        return new Response(bytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch {
        // SDK 0.122.0 passes its own timed-fetch signal here. Capture its
        // actual deadline abort before sanitization removes the original error.
        // A bare AbortError without this evidence is not caller cancellation.
        transportTimedOut ||= init?.signal?.aborted === true;
        transportFailure ??= "transport failure";
        throw new ProviderCallError(transportFailure);
      }
    };
    try {
      const isReview = schema === reviewSchema;
      const batch = batchMemberSchema(schema) !== undefined;
      const tools = buildProviderTools(schema);
      if (tools.length) {
        tools[tools.length - 1] = {
          ...tools[tools.length - 1]!,
          cache_control: { type: "ephemeral" },
        };
      }
      const allowed = new Set(tools.map((tool) => tool.name));
      let resolved = parts;
      if (!resolved) {
        let value: unknown;
        try {
          value = JSON.parse(prompt);
        } catch {
          throw new ProviderCallError("invalid prompt JSON");
        }
        if (isRecord(value)) {
          const { instruction, ...payload } = value;
          resolved = {
            system: typeof instruction === "string" ? instruction : "",
            payload,
          };
        } else resolved = { system: "", payload: value };
      }
      const context =
        isRecord(resolved.payload) && isRecord(resolved.payload.context)
          ? resolved.payload.context
          : undefined;
      const sources = isRecord(context?.modelSources)
        ? context.modelSources.sources
        : undefined;
      const hasSources = isRecord(sources) && Object.keys(sources).length > 0;
      const model = new ChatAnthropic({
        apiKey: this.options.apiKey,
        model: this.options.model,
        // Pin the endpoint as before; ambient SDK URL variables are not policy.
        anthropicApiUrl: "https://api.anthropic.com",
        maxTokens: isReview
          ? 2048
          : this.options.decisionMaxTokens ?? (hasSources ? 16384 : 4096),
        maxRetries: 0,
        streaming: false,
        outputConfig: {
          effort: (this.options.effort ?? "high") as ProviderEffort,
        },
        clientOptions: {
          fetch: boundedFetch,
          // This API-key provider has no webhook or ambient bearer authority.
          webhookKey: null,
          authToken: null,
          timeout: this.timeoutMs,
          maxRetries: 0,
          logLevel: "off",
        },
      }).bindTools(tools, {
        // The 1.5.12 declaration omits Anthropic's auto object, although its
        // handleToolChoice explicitly forwards object choices unchanged.
        tool_choice: {
          type: "auto",
          disable_parallel_tool_use: !batch,
        } as unknown as ChatAnthropicCallOptions["tool_choice"],
      });
      // A host-correlated scalar response has no authentic assistant tool_use
      // block. Preserve its exact results as observed JSON data, without
      // inventing assistant turns, provider IDs, tool results or signatures.
      const scalarResults = (resolved.replay ?? []).filter((previous) =>
        !previous.assistantBlocks.some((block) =>
          isRecord(block) && block.type === "tool_use"
        )
      ).flatMap((previous) => previous.results);
      const userBlocks = [
        ...(resolved.conditionalInstruction?.trim()
          ? [{
            type: "text" as const,
            text: resolved.conditionalInstruction.trimStart(),
          }]
          : []),
        ...(scalarResults.length
          ? [{
            type: "text" as const,
            text: JSON.stringify({
              trust: "untrusted-observation",
              completedToolCalls: scalarResults,
            }),
          }]
          : []),
        { type: "text" as const, text: JSON.stringify(resolved.payload) },
      ];
      let messages: BaseMessage[] = [
        new SystemMessage({
          content: [
            { type: "text", text: resolved.system },
            {
              type: "text",
              text: batch ? BATCH_DIRECTIVE : TOOL_DIRECTIVE,
              cache_control: { type: "ephemeral" },
            },
          ],
        }),
        new HumanMessage({ content: userBlocks }),
      ];
      for (const previous of resolved.replay ?? []) {
        if (
          !previous.assistantBlocks.some((block) =>
            isRecord(block) && block.type === "tool_use"
          )
        ) continue;
        messages.push(
          new AIMessage({
            content: previous.assistantBlocks as AIMessage["content"],
          }),
          ...previous.results.map(resultMessage),
        );
      }
      // Exactly one bounded decision invocation, with at most one schema repair.
      for (let attempt = 0; attempt < 2; attempt++) {
        // Allocate before each SDK invocation, including schema repair. Capture
        // identities now: the async sink must never consult a later ambient run.
        const observationId = crypto.randomUUID();
        const correlation = currentProviderCallCorrelation();
        const startedAt = new Date().toISOString();
        const started = performance.now();
        const physicalCall = () => ({
          schemaVersion: 1 as const,
          observationId,
          provider: "anthropic" as const,
          configuredModel: this.options.model,
          startedAt,
          endedAt: new Date().toISOString(),
          elapsedMs: Math.max(0, performance.now() - started),
          correlation,
        });
        let response: AIMessage;
        try {
          response = await Promise.race([
            model.invoke(messages, {
              signal: controller.signal,
              maxRetries: 0,
            }),
            expired,
          ]);
        } catch (error) {
          // There is no external cancellation input on this adapter. The pinned
          // SDK preserves APIConnectionTimeoutError through LangChain; all
          // other unestablished aborts remain failed, never guessed cancelled.
          const timedOut = controller.signal.aborted || transportTimedOut ||
            error instanceof Error &&
              error.constructor.name === "APIConnectionTimeoutError";
          this.observer.publish({
            ...physicalCall(),
            outcome: timedOut ? "timed-out" : "failed",
          });
          throw error;
        }
        const metadata = response.response_metadata;
        this.observer.publish({
          ...physicalCall(),
          outcome: "returned",
          ...(typeof metadata.id === "string" ? { id: metadata.id } : {}),
          ...(typeof metadata.model === "string"
            ? { model: metadata.model }
            : {}),
          stopReason: metadata.stop_reason,
          ...(isRecord(metadata.usage) ? { usage: metadata.usage } : {}),
        });
        if (metadata.stop_reason === "max_tokens") {
          throw new ProviderCallError(
            "output token limit reached (max_tokens)",
          );
        }
        if (
          metadata.stop_reason !== "tool_use" &&
          metadata.stop_reason !== "end_turn"
        ) {
          const reason = ["refusal", "stop_sequence", "pause_turn"].includes(
              String(metadata.stop_reason),
            )
            ? ` (${metadata.stop_reason})`
            : "";
          throw new ProviderCallError(`incomplete completion${reason}`);
        }
        const content = contentBlocks(response);
        const toolUses = content.filter((
          part,
        ): part is Record<string, unknown> =>
          isRecord(part) && part.type === "tool_use"
        );
        let code = "NO_TOOL_CALL";
        let detail =
          "at least one tool call is required; free text is never a decision";
        const ids = new Set<string>();
        const validIds = toolUses.every((use) => {
          if (
            typeof use.id !== "string" || !/^\S{1,256}$/.test(use.id) ||
            ids.has(use.id)
          ) return false;
          ids.add(use.id);
          return true;
        });
        const candidates: Array<{ id: string; decision: ChatDecision }> = [];
        if (!validIds) {
          code = "INVALID_TOOL_CALL_ID";
          detail =
            "tool call IDs must be nonempty, distinct strings without whitespace";
        } else if (toolUses.length > (batch ? MAX_DECISION_CALLS : 1)) {
          code = batch ? "TOO_MANY_TOOL_CALLS" : "MULTIPLE_TOOL_CALLS";
          detail = batch
            ? `at most ${MAX_DECISION_CALLS} tool calls are allowed`
            : "exactly one tool call is required per decision";
        } else if (toolUses.length) {
          code = "";
          for (const use of toolUses) {
            const name = typeof use.name === "string" ? use.name : "";
            if (!allowed.has(name)) {
              code = "UNKNOWN_TOOL";
              detail = `tool not authorized in this context; allowed: ${
                [...allowed].join(",")
              }`;
              break;
            }
            if (!isRecord(use.input)) {
              code = "INVALID_TOOL_INPUT";
              detail = "tool input must be a JSON object";
              break;
            }
            let candidate: unknown;
            try {
              candidate = canonicalProviderResult(
                isReview ? { ...use.input } : { kind: name, ...use.input },
              );
            } catch (error) {
              code = "INVALID_TOOL_INPUT";
              detail = error instanceof ProviderCallError
                ? error.message
                : "invalid canonical form";
              break;
            }
            if (
              !isReview && (!isRecord(candidate) || candidate.kind !== name)
            ) {
              code = "INVALID_TOOL_INPUT";
              detail = "input kind must not override the called tool";
              break;
            }
            if (
              isReview ? validateReview(candidate) : validateDecision(candidate)
            ) {
              if (isReview) return candidate;
              candidates.push({
                id: use.id as string,
                decision: candidate as ChatDecision,
              });
            } else {
              code = "INVALID_TOOL_INPUT";
              detail = ajvDetail(
                isReview ? validateReview.errors : relevantErrors(
                  decisionSchema,
                  candidate,
                  validateDecision.errors,
                ),
              );
              break;
            }
          }
          if (!code) {
            const group = { calls: candidates, assistantBlocks: content };
            const error = decisionBatchError(group);
            if (error) {
              code = "INVALID_TOOL_CALL_ORDER";
              detail = error;
            } else return batch ? group : candidates[0]!.decision;
          }
        }
        if (attempt === 1) {
          throw new ProviderCallError(
            `invalid tool decision schema after repair (${code})`,
          );
        }
        const repair = JSON.stringify({
          code,
          detail: boundedDetail(detail),
          allowedTools: [...allowed],
        });
        if (code === "INVALID_TOOL_CALL_ID") {
          messages = [
            ...messages,
            new HumanMessage({ content: [{ type: "text", text: repair }] }),
          ];
        } else {
          messages = [
            ...messages,
            new AIMessage({
              content: content.length
                ? content as AIMessage["content"]
                : [{ type: "text", text: "(no tool call)" }],
            }),
            ...(toolUses.length
              ? toolUses.map((use) =>
                resultMessage({
                  id: use.id as string,
                  result: repair,
                  isError: true,
                })
              )
              : [
                new HumanMessage({ content: [{ type: "text", text: repair }] }),
              ]),
          ];
        }
      }
      throw new ProviderCallError("invalid tool decision schema after repair");
    } catch (error) {
      const category = controller.signal.aborted
        ? "request timed out"
        : transportFailure ?? (error instanceof ProviderCallError
          ? error.message
          : error instanceof SyntaxError
          ? "invalid response JSON"
          : "provider failure");
      // SDK errors can embed credentials, response bodies and request headers.
      // Never attach them as causes or emit them through the adapter boundary.
      throw new Error(`Claude request failed: ${category}`);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
