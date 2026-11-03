import { equal, match, throws } from "node:assert/strict";
import {
  consultingTemplateRevision,
  requestValueTeamOperator,
} from "../fixtures/request-value-profile.ts";

Deno.test("Request value team templates explicitly allow host proposals without granting hosts", () => {
  for (const name of ["permissionsOperator", "constraintsOperator"]) {
    const source = requestValueTeamOperator(name, name, "1");
    match(source, /mayAddNetworkHosts = true;/);
    match(source, /urlSelectionMode = "authorized-host";/);
    match(source, /networkHosts : String = "\[\]";/);
    equal(/__[A-Z_]+__/.test(source), false);
  }
});

Deno.test("Request value fixture reads only the selected source template revision", () => {
  const source = `package Sample {
    action def ConsultingConversationV1 {
        attribute templateRevision : Integer = 7;
    }
    action def ImmutableGroupConversationV1 {
        attribute templateRevision : Integer = 12;
    }
}`;
  equal(consultingTemplateRevision(source), "7");
  equal(
    consultingTemplateRevision(`package Sample {
    action def ConsultingConversationV1 {
        attribute templateRevision : Integer = 9;
        action nested { doc /* } */ }
    }
}`),
    "9",
  );
  throws(() =>
    consultingTemplateRevision(source.replace("Integer = 7", "Integer = 0"))
  );
  throws(() =>
    consultingTemplateRevision(
      source.replace("templateRevision : Integer = 7;", "other : Integer = 7;"),
    )
  );
  throws(() => consultingTemplateRevision(source + source));
});
