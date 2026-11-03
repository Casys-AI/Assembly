import {
  activeTools,
  type RetainedToolsPort,
} from "../work/tools/active-tools.ts";
import type { RetainedToolInvocationTarget } from "../../domain/work/retained-tool-dependencies.ts";
import {
  normalizeTaskSourceUrl,
  type TaskSourceInput,
  validTaskSourceInputs,
} from "../../domain/work/task-source-input.ts";
import { caseExecutionContext } from "../work/cases/runtime.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type { Candidate, Stage } from "../../domain/work/candidates.ts";
import type {
  ChatDecision,
  SystemRuntimeState,
  ToolFailure,
} from "../../domain/work/dialogue.ts";
import { ToolInvocationError } from "../../domain/work/errors/tool-invocation.ts";
import type { MessageObservation } from "../../domain/work/policies/context-separation.ts";
import { draftDigest, makeEvent } from "../work/runtime/values.ts";
import { caseMessages, currentCase } from "../work/cases/runtime.ts";

export interface ToolInvocationAdmissionHost {
  readonly state: SystemRuntimeState;
  readonly ports?: { retainedTools?: RetainedToolsPort };
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  feedback(text: string, observation?: MessageObservation): Promise<void>;
  nativeCandidate(
    model: ExecutableModel,
    candidate: Candidate,
    status: Stage,
  ): boolean;
  userSuppliedUrl(url: string): boolean | Promise<boolean>;
  verifyTaskSourceInputs?(): Promise<boolean>;
}

export function userSuppliedUrl(
  this: Pick<ToolInvocationAdmissionHost, "state" | "verifyTaskSourceInputs">,
  url: string,
): boolean | Promise<boolean> {
  const normalize = normalizeTaskSourceUrl;
  const wanted = normalize(url);
  if (!wanted) return false;
  const context = caseExecutionContext(this.state);
  const sources: TaskSourceInput[] | undefined = context?.record
    ?.taskSourceInputs;
  if (sources !== undefined) {
    // A supplied record is task data until the composition root proves its
    // durable root owner and original human journal. Fail closed on forgery.
    if (
      !context || !validTaskSourceInputs(sources, context.caseId) ||
      !sources.some((source) => source.urls.includes(wanted)) ||
      !this.verifyTaskSourceInputs
    ) return false;
    return this.verifyTaskSourceInputs().catch(() => false);
  }
  let supplied: string | undefined;
  if (this.state.scheduledExecution) {
    const record = currentCase(this.state);
    const declaration = this.state.executionModel?.caseTypes?.find((type) =>
      type.id === record?.caseTypeId && type.type === record?.type &&
      type.type !== "request" && type.ownerId === record?.owner &&
      type.behaviorId === record?.scheduling?.behaviorId
    );
    if (record?.id === this.state.scheduledExecution.caseId) {
      supplied = declaration?.name;
    }
  } else {
    supplied = caseMessages(this.state).findLast((message) =>
      message.role === "user"
    )?.text;
  }
  return !!supplied &&
    supplied.split(/\s+/).some((raw) => normalize(raw) === wanted);
}

export async function observeToolFailure(
  this: Pick<ToolInvocationAdmissionHost, "update" | "feedback">,
  failure: ToolFailure,
): Promise<void> {
  const safe = new ToolInvocationError(failure).failure;
  await this.update((s) => {
    s.lastToolFailure = safe;
    s.phase = "L’agent examine le retour de l’outil";
    s.events.push(
      makeEvent("tool-call-refused", `${safe.code} : ${safe.message}`),
    );
  });
  await this.feedback(
    `Retour d’appel de l’hôte. La demande n’a pas abouti. Lis ce retour avec ton mandat courant pour décider de la suite ; il ne modifie aucun droit.\n${
      JSON.stringify(safe)
    }`,
    { kind: "tool-failure", value: safe },
  );
}

export async function invocationAdmission(
  this: ToolInvocationAdmissionHost,
  decision: Extract<ChatDecision, { kind: "invoke_tool" }>,
  model: ExecutableModel,
): Promise<
  {
    admitted: boolean;
    toolId: string;
    url?: string;
    failure?: ToolFailure;
    retainedTool?: RetainedToolInvocationTarget;
  }
> {
  const selected =
    (await activeTools(this.state, model, this.ports?.retainedTools)).find(
      (entry) => entry.tool.id === decision.toolId,
    );
  const tool = selected?.tool;
  let url: string | undefined;
  try {
    const parsed = new URL(decision.input.url);
    if (
      parsed.protocol === "https:" && !parsed.username && !parsed.password &&
      (!parsed.port || parsed.port === "443")
    ) {
      parsed.hash = "";
      url = parsed.href;
    }
  } catch { /* A structured refusal lets the agent correct its arguments. */ }
  let failure: ToolFailure | undefined;
  if (
    !tool || await draftDigest(tool) !== tool.digest ||
    selected?.kind === "local-candidate" &&
      !this.nativeCandidate(model, selected.tool, "active") ||
    model.mandate.mayInvoke !== "active-catalog-only"
  ) {
    failure = {
      code: "TOOL_UNAVAILABLE",
      message:
        "Cet outil n’est pas admis dans le catalogue natif actif sous le mandat courant.",
      retryable: false,
      toolId: decision.toolId,
      url,
    };
  } else if (!url) {
    failure = {
      code: "URL_INVALID",
      message:
        "L’argument url doit être une URL HTTPS sans identifiants ni port particulier.",
      retryable: true,
      toolId: tool.id,
    };
  } else if (
    !["user-provided", "authorized-host"].includes(
      model.policy.urlSelectionMode,
    )
  ) {
    throw new Error("Politique native de sélection d’URL inconnue.");
  } else if (
    model.policy.urlSelectionMode === "user-provided" &&
    !await this.userSuppliedUrl(url)
  ) {
    failure = {
      code: "URL_NOT_USER_SUPPLIED",
      message: this.state.scheduledExecution
        ? "La cible doit figurer dans le nom ou l’objectif du CaseType admis de cette exécution planifiée, avec le même chemin et les mêmes paramètres. Proposez une révision et faites-la admettre avant de réessayer."
        : "La cible doit correspondre à l’adresse ou au domaine explicitement fourni par un message humain du Case courant, avec le même chemin et les mêmes paramètres.",
      retryable: false,
      toolId: tool.id,
      url,
    };
  }
  // Network admission is enforced again by the controlled runner before fetch.
  return {
    admitted: !failure,
    toolId: decision.toolId,
    url,
    ...(!failure && selected?.kind === "retained-dependency"
      ? { retainedTool: selected.retainedTool }
      : {}),
    ...(failure ? { failure } : {}),
  };
}
