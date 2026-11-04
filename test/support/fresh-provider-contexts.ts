/** Provider discovery from the same default sources as `system create`.
 * Native authority writes below simulate an admitted BO grant and teammate;
 * runtime-only services are read-only doubles, never a substitute model. */
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { bundledSkillReader } from "../../src/adapters/out/filesystem/skill-bundles.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { operatorAuthorityRequests } from "../../src/composition/source-model-services.ts";
import { applyEdits } from "../../src/application/model/editing/host-writer.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { ModelContextReader } from "../../src/application/model/consultation/source-reader.ts";
import { buildDecisionContext } from "../../src/application/work/conversation/decision-context.ts";
import type {
  ConversationDecisionHost,
  ConversationTurnState,
} from "../../src/application/work/conversation/turn-context.ts";
import {
  ensureRequestCase,
  selectCaseInvocation,
  selectDesignerInvocation,
} from "../../src/application/work/cases/runtime.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import type { ModelRevision } from "../../src/domain/model/records/revision.ts";
import type { ChatContext } from "../../src/application/work/conversation/chat-context.ts";
import type { SystemRuntimeState } from "../../src/application/work/runtime/state.ts";
import { modelContextTools } from "../../src/application/work/context/model-tools.ts";
import { DEFAULT_NETWORK_IMPACT_LIMITS } from "../../src/domain/model/consultation/network-impact.ts";
import { skillDisplay } from "../../src/domain/skills/context-skills.ts";

const projectId = "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf";
const at = "2026-11-03T00:00:00.000Z";

async function decisionContext(
  model: ExecutableModel,
  revision: ModelRevision,
  invocation: "designer" | "request",
  memberIds: string[],
  originatingRequest?: ChatContext["case"],
): Promise<ChatContext> {
  const state: SystemRuntimeState = {
    id: "fresh-system",
    revision: 0,
    catalogRevision: 0,
    executionModel: model,
    model: model.identity,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "ready",
    provider: "test",
  };
  if (originatingRequest) {
    state.cases = [structuredClone(originatingRequest)];
    selectCaseInvocation(state, {
      kind: "local",
      caseId: originatingRequest.id,
    });
  } else if (invocation === "designer") {
    selectDesignerInvocation(state);
  } else {
    ensureRequestCase(state, { objective: "Contribute to this Request." }, {
      now: () => at,
    }, 1);
  }
  const reader = new ModelContextReader({
    current: () => Promise.resolve(revision),
    at: () => Promise.resolve(revision),
  });
  const catalog = await Promise.all(
    (model.initialSkills ?? []).map(async (seed) => {
      const content = await bundledSkillReader()(
        seed.source,
        model.skillPolicy!.maxSkillBytes,
      );
      return {
        id: seed.id,
        ...skillDisplay(content, seed.id),
        digest: seed.digest,
        byteLength: new TextEncoder().encode(content).length,
        installedAt: at,
        loaded: seed.loaded,
        source: {
          kind: "bundled" as const,
          location: seed.source,
          acquiredAt: at,
          modelVersion: {
            digest: model.version.digest,
            repositoryVersion: revision.version,
          },
        },
      };
    }),
  );
  const host = {
    state,
    ports: {
      model: {
        proposeRevision: () => Promise.resolve(),
        proposeDelegation: () => Promise.resolve(),
        ...(invocation === "request"
          ? {
            requestChangeScope: {
              caseId: state.cases![0]!.id,
              operatorId: model.identity.builderId,
              executionSpaceId: "request-branch",
              branchTeamSize: memberIds.length,
              memberIds,
            },
          }
          : {}),
      },
      information: {
        modelTools: () =>
          modelContextTools({
            networkImpact: {
              scope: "own-history",
              limits: DEFAULT_NETWORK_IMPACT_LIMITS,
              maxPageSize: 20,
              maxResponseCharacters: 16_000,
            },
          }),
        read: async () => ({
          memoryGuidance: [],
          modelContext: await reader.overview(revision.version),
          modelSources: {
            version: revision.version,
            sources: revision.sources,
          },
          ...(model.skillPolicy
            ? { skills: { policy: model.skillPolicy, catalog, loaded: [] } }
            : {}),
        }),
        consultModel: () => Promise.resolve({}),
      },
      behaviors: { supports: () => Promise.resolve(true) },
    },
    currentModel: () => Promise.resolve(model),
    budgetView: () => Promise.resolve(undefined),
    operatorAuthorityContext: () => Promise.resolve(undefined),
    operatorToolAdmissionContext: () => undefined,
    // This fixture implements only the ports used to capture fresh decision context.
  } as unknown as ConversationDecisionHost;
  const turn: ConversationTurnState = {
    resumedContribution: false,
    proposals: 0,
    decisions: 0,
    sourceDecision: {},
    failures: new Map(),
  };
  return (await buildDecisionContext.call(host, turn, model, state))
    .decisionContext;
}

export async function freshProviderContexts(
  packageDir: string,
): Promise<Record<string, ChatContext>> {
  const compiler = new ToolkitCompiler({ packageDir });
  const tooling = new SysmlToolkitAdapter({ packageDir });
  let sequence = 0;
  const compile = async (
    sources: Record<string, string>,
  ): Promise<ModelRevision> => ({
    ...await compiler.compile(sources),
    version: `commit:${String(++sequence).padStart(40, "0")}`,
  });
  const initial = await compile(await loadInitialSources());
  const main = await validateSourceExecutable(initial, projectId);
  const contexts: Record<string, ChatContext> = {
    main: await decisionContext(main, initial, "designer", []),
    boCreationGrantRequest: await decisionContext(main, initial, "request", []),
  };
  const systemName = main.identity.systemQualifiedName!;
  const grant = await operatorAuthorityRequests(initial, {
    op: "publishOperatorCreationPolicy",
    systemName,
    changeId: "fresh-bo-grant",
    policy: { networkHosts: [], maxChildren: 3, mode: "per-creation" },
  });
  const grantedSources = await applyEdits(tooling, initial, grant.requests, {
    compile,
  });
  const granted = await compile(grantedSources.sources);
  const bo = await validateSourceExecutable(granted, projectId);
  contexts.bo = await decisionContext(bo, granted, "request", []);
  const policy = bo.operatorCreationPolicies![0]!;
  const child = await operatorAuthorityRequests(granted, {
    op: "createRequestOperator",
    systemName,
    changeId: "fresh-bo-teammate",
    name: "Request teammate",
    operator: {
      kind: "request-team-member",
      instruction: "Contribute one exact result to the originating Request.",
      provision: {
        budget: {
          maxAgentDecisions: bo.policy.maxAgentDecisions,
          maxToolProposals: bo.policy.maxToolProposals,
          maxFlowSteps: bo.policy.maxFlowSteps,
        },
        networkHosts: [],
        mayPropose: [...bo.mandate.mayPropose],
        mayInvokeActiveCatalog: true,
        mayAddNetworkHosts: bo.policy.mayAddNetworkHosts,
        mayConsultModel: true,
        mayProposeSysmlRevision: true,
      },
    },
    teamOrigin: {
      operatorId: bo.identity.builderId,
      requestId: contexts.bo.case!.id,
    },
    parentOperatorId: bo.identity.builderId,
    creatorMayAddNetworkHosts: bo.policy.mayAddNetworkHosts,
    creationPolicy: {
      id: policy.id,
      revision: policy.revision,
      elementId: policy.elementId,
    },
  });
  const childSources = await applyEdits(tooling, granted, child.requests, {
    compile,
  });
  const childRevision = await compile(childSources.sources);
  const member = await validateSourceExecutable(
    childRevision,
    projectId,
    child.systemQualifiedName,
  );
  contexts.teammate = await decisionContext(
    member,
    childRevision,
    "request",
    [member.identity.builderId],
    contexts.bo.case,
  );
  return contexts;
}
