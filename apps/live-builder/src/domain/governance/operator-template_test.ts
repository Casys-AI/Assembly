import assert from "node:assert/strict";
import {
  TEAM_OPERATOR_TEMPLATE,
  teamOperatorTemplate,
} from "./operator-template.ts";

Deno.test("generated team template states the explicit network proposal capability without granting hosts", () => {
  assert(
    TEAM_OPERATOR_TEMPLATE.includes(
      "mayAddNetworkHosts = __MAY_ADD_NETWORK_HOSTS__;",
    ),
  );
  for (const mayAddNetworkHosts of [true, false]) {
    const source = teamOperatorTemplate(mayAddNetworkHosts);
    assert(source.includes(`mayAddNetworkHosts = ${mayAddNetworkHosts};`));
    assert(!source.includes("__MAY_ADD_NETWORK_HOSTS__"));
    assert(source.includes("networkHosts : String = __HOSTS__;"));
    assert(source.includes("mayChangeOwnMandate = false;"));
    assert(
      source.includes(
        "mayProposeSysmlRevision = __MAY_PROPOSE_SYSML_REVISION__;",
      ),
    );
  }
});
