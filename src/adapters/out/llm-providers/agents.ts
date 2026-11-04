import { untrustedObservation } from "./provider-context.ts";
import { isPlainRecord as isRecord } from "../../../domain/primitives/is-plain-record.ts";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import {
  StructuredAgents,
  type StructuredPromptParts,
} from "./structured-agents.ts";
import { ajvDetail } from "./provider-tools.ts";
import { compileOutputSchema, relevantErrors } from "./output-validation.ts";

export { decisionSchema, reviewSchema } from "./output-validation.ts";
export type { StructuredPromptParts } from "./structured-agents.ts";
// Existing integrations keep their public import while all Claude execution is
// implemented by the actual LangChain SDK provider. No manual transport remains.
export { LangChainAgents as ClaudeAgents } from "./langchain-agents.ts";
export type { LangChainAgentsOptions as ClaudeAgentsOptions } from "./langchain-agents.ts";
export {
  buildProviderTools as buildClaudeTools,
  REVIEW_TOOL as CLAUDE_REVIEW_TOOL,
} from "./provider-tools.ts";
export type { ProviderToolDefinition as ClaudeToolDefinition } from "./provider-tools.ts";

export interface MuseRunRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  prompt: string;
  schema: object;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}
export interface MuseRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failureReason?: "timeout" | "stdout-limit" | "stderr-limit";
}
export type MuseRunner = (request: MuseRunRequest) => Promise<MuseRunResult>;
export interface MuseAgentsOptions {
  command?: string;
  timeoutMs?: number;
  model?: string;
  runner?: MuseRunner;
}
export const MAX_MUSE_STDOUT_BYTES = 1_000_000;
export const MAX_MUSE_STDERR_BYTES = 32_000;
const TERMINATION_GRACE_MS = 250;

/** Muse returns its decision as JSON; the format belongs to this transport. */
const MUSE_OUTPUT_DIRECTIVE =
  "Transport : retourne uniquement le JSON du schéma de sortie.";

function withMuseOutputDirective(prompt: string): string {
  const parsed: unknown = JSON.parse(prompt);
  if (!isRecord(parsed) || typeof parsed.instruction !== "string") {
    return prompt;
  }
  return JSON.stringify({
    ...parsed,
    instruction: `${parsed.instruction}\n${MUSE_OUTPUT_DIRECTIVE}`,
  });
}

/** Fresh restricted process per decision; conversation is owned by the application. */
export class MuseAgents extends StructuredAgents {
  readonly label = "Muse";
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly model?: string;
  private readonly runner: MuseRunner;
  constructor(options: MuseAgentsOptions = {}) {
    super();
    this.command = options.command ?? "muse";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.model = options.model;
    this.runner = options.runner ?? runMuseExec;
    if (!this.command.trim() || this.command.includes("\0")) {
      throw new Error("Invalid Muse executable");
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Invalid Muse timeout");
    }
    if (
      this.model !== undefined &&
      (!this.model.trim() || this.model.includes("\0"))
    ) throw new Error("Invalid Muse model");
  }
  protected async call(
    shared: string,
    schema: object,
    parts?: StructuredPromptParts,
  ): Promise<unknown> {
    const validate = compileOutputSchema(schema);
    let prompt = shared;
    for (let attempt = 0;; attempt++) {
      const value = await this.invoke(prompt, schema, parts);
      if (validate(value)) return value;
      if (attempt === 1) {
        throw new Error(
          "Invalid agent decision schema after repair (INVALID_OUTPUT_SCHEMA)",
        );
      }
      prompt = JSON.stringify({
        ...JSON.parse(shared),
        invalidOutput: untrustedObservation({ value }),
        repair: {
          code: "INVALID_OUTPUT_SCHEMA",
          detail: ajvDetail(relevantErrors(schema, value, validate.errors)),
          recovery: "Return a corrected decision matching the output schema.",
        },
      });
    }
  }
  private async invoke(
    shared: string,
    schema: object,
    parts?: StructuredPromptParts,
  ): Promise<unknown> {
    // Keep prior inputs and their ordered results without replaying another
    // provider's opaque blocks or repeating a turn brief after every call.
    let inputMessageId: string | undefined;
    const history = parts?.replay?.map(({ turn, results }) => {
      const startsTurn = turn && turn.inputMessageId !== inputMessageId;
      if (turn) inputMessageId = turn.inputMessageId;
      return {
        ...(startsTurn ? { turn } : {}),
        ...(!startsTurn && turn?.requestOutcomes?.length
          ? {
            observations: untrustedObservation({
              hostObservations: turn.requestOutcomes,
            }),
          }
          : {}),
        completedToolCalls: results,
      };
    });
    const prompt = withMuseOutputDirective(
      history?.length
        ? JSON.stringify({ ...JSON.parse(shared), history })
        : shared,
    );
    const root = await mkdtemp(join(tmpdir(), "assembly-live-agent-"));
    try {
      const workspace = join(root, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      const schemaPath = join(root, "schema.json");
      const promptPath = join(root, "prompt.txt");
      await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
      await writeFile(promptPath, prompt, { mode: 0o600 });
      const args = [
        "exec",
        "--json",
        "--provider",
        "meta",
        "--preset",
        "empty",
        "--output-schema",
        schemaPath,
        "--prompt-file",
        promptPath,
        "--workspace",
        workspace,
        "--worktree",
        "off",
        "--disable-web-tools",
        "--disable-shell",
        "--disable-write",
        "--disable-reminders",
        "--disable-request-user-input",
        "--no-foreign-personal-context",
        "--no-session-log",
        "--contributor-mode",
        "off",
        "--reasoning-effort",
        "medium",
        "--max-model-steps",
        "3",
        ...(this.model ? ["--model", this.model] : []),
      ];
      let result: MuseRunResult;
      try {
        result = await this.runner({
          command: this.command,
          args,
          cwd: workspace,
          prompt,
          schema,
          timeoutMs: this.timeoutMs,
          maxStdoutBytes: MAX_MUSE_STDOUT_BYTES,
          maxStderrBytes: MAX_MUSE_STDERR_BYTES,
        });
      } catch {
        throw new Error("Muse runner failed");
      }
      if (result.failureReason) {
        throw new Error("Muse invocation exceeded its execution bounds");
      }
      if (
        Buffer.byteLength(result.stdout) > MAX_MUSE_STDOUT_BYTES ||
        Buffer.byteLength(result.stderr) > MAX_MUSE_STDERR_BYTES
      ) throw new Error("Muse output exceeded its limit");
      if (result.exitCode !== 0) {
        throw new Error("Muse did not exit successfully");
      }
      const terminal = parseMuseTerminal(result.stdout);
      return terminal;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
/** Accept one completed terminal only, never intermediate model text. */
export function parseMuseTerminal(stdout: string): unknown {
  let text: string | undefined;
  const invalid = () => new Error("Invalid Muse terminal output");
  for (const line of stdout.split(/\r?\n/).filter((s) => s.trim())) {
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      throw invalid();
    }
    if (!isRecord(e) || typeof e.payload_type !== "string") throw invalid();
    if (!e.payload_type.startsWith("run.terminal.")) continue;
    if (
      e.payload_type !== "run.terminal.completed" || text !== undefined ||
      e.schema_version !== 1 ||
      e.payload_schema_version !== 1 || !isRecord(e.stream) ||
      e.stream.kind !== "session" ||
      typeof e.stream.id !== "string" || !e.stream.id.trim() ||
      !isRecord(e.payload) ||
      e.payload.kind !== "run_terminal" ||
      typeof e.payload.command_id !== "string" ||
      !e.payload.command_id.trim() ||
      !isRecord(e.payload.run_stream) || e.payload.run_stream.kind !== "run" ||
      e.payload.run_stream.id !== e.payload.command_id ||
      e.payload.terminal !== "completed" || typeof e.payload.text !== "string"
    ) throw invalid();
    text = e.payload.text;
  }
  if (text === undefined) throw invalid();
  try {
    return JSON.parse(text);
  } catch {
    throw invalid();
  }
}

/** Own one child group, bound both streams, and enforce a wall-clock deadline. */
export function runMuseExec(request: MuseRunRequest): Promise<MuseRunResult> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failureReason: MuseRunResult["failureReason"];
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let forceFinishTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const signalGroup = (signal: NodeJS.Signals): boolean => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch {
          // An early exit can race with group signalling.
        }
      }
      return false;
    };
    const signalChild = (signal: NodeJS.Signals) => {
      if (!signalGroup(signal)) child.kill(signal);
    };
    const finish = (exitCode: number | null, failed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(forceFinishTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.pid !== undefined) child.unref();
      if (failed) {
        reject(new Error("Muse process could not start"));
      } else {
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          ...(failureReason ? { failureReason } : {}),
        });
      }
    };
    const terminate = (reason: NonNullable<MuseRunResult["failureReason"]>) => {
      if (failureReason || settled) return;
      failureReason = reason;
      signalChild("SIGTERM");
      forceKillTimer = setTimeout(() => {
        signalChild("SIGKILL");
        forceFinishTimer = setTimeout(() => finish(null), TERMINATION_GRACE_MS);
      }, TERMINATION_GRACE_MS);
    };
    const timeoutTimer = setTimeout(
      () => terminate("timeout"),
      request.timeoutMs,
    );
    child.once("error", () => finish(null, true));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > request.maxStdoutBytes) terminate("stdout-limit");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > request.maxStderrBytes) terminate("stderr-limit");
      else stderr.push(chunk);
    });
    child.once("close", (code) => {
      // Normal exit can leave descendants that closed their inherited pipes.
      // This is only the invocation's own POSIX group, never other sessions or
      // services that deliberately detached into another group.
      signalGroup("SIGKILL");
      finish(code);
    });
  });
}
