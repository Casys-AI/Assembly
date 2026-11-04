/** Real native compiler contract; no provider, server or repository database. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { compileWorkBudgetPolicy } from "../../src/adapters/out/sysml-toolkit/compilation-policies/work/budget-policy.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import {
  sourceLiterals,
  sourceSnapshot,
} from "../../src/domain/model/projections/source-facts.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  sourceModelIdentity,
} from "../../src/domain/model/records/source-identity.ts";
const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const part = `part budget : APEWorkBudget::InvocationBudgetPolicy {
 attribute :>> id = "budget";
 attribute :>> revision = 1;
 attribute :>> unit = "agent-invocation";
 attribute :>> limit = 12;
 attribute :>> onExhausted = "wait";
 attribute :>> exhaustionRecipient = "local-control";
}`;
async function compile(extra: string, sibling?: string, selected?: string) {
  const source = await loadInitialSources(undefined, { information: false });
  source["work-budget.sysml"] = await Deno.readTextFile(
    new URL("../../models/work-budget.sysml", import.meta.url),
  );
  source["configuration.sysml"] = source["configuration.sysml"].replace(
    "part liveBuilder : ConversationSystem {",
    `part liveBuilder : ConversationSystem { ${extra}`,
  );
  if (sibling !== undefined) {
    source["configuration.sysml"] += `
package BudgetPeers { part peer : AssemblyLiveBuilder::ConversationSystem { part builder : AssemblyLiveBuilder::ConversationBuilder; part catalog : AssemblyLiveBuilder::ToolCatalog; ${sibling} } }`;
  }
  const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
    .compile(
      source,
    );
  const identity = sourceModelIdentity(
    { ...compiled, version: "budget-test" },
    "git:e6c3378a-8e84-5260-8e79-57425d4ffbeb",
    selected,
  );
  return compileWorkBudgetPolicy(
    sourceSnapshot(compiled.elements, identity.rootId),
    sourceLiterals(compiled.elements),
    identity,
  );
}
Deno.test({
  name:
    "real work budget definitions are inert and explicit native policy compiles",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    assert.equal(await compile(""), undefined);
    const policy = await compile(part);
    assert.equal(policy!.unit, "agent-invocation");
    assert.equal(policy!.limit, 12);
    assert.equal(policy!.revision, 1);
    assert.equal(policy!.exhaustionRecipient, "local-control");
    assert(policy!.sourceIds.includes(policy!.elementId));
  },
});
Deno.test({
  name:
    "real native budget rejects missing fields, duplicate policies and unsupported units",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    for (
      const source of [
        part.replace("attribute :>> limit = 12;", ""),
        part + part.replace("part budget", "part anotherBudget"),
        part.replace("agent-invocation", "tokens"),
      ]
    ) {
      await assert.rejects(() => compile(source), /Invalid native work budget/);
    }
  },
});

Deno.test({
  name: "real native budget isolates multiple operators in one source",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sibling = part.replace("limit = 12", "limit = 34");
    assert.equal((await compile(part, sibling))!.limit, 12);
    assert.equal(
      (await compile(part, sibling, "BudgetPeers::peer"))!.limit,
      34,
    );
    assert.equal(await compile("", sibling), undefined);
  },
});
