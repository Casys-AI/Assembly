import { equal, throws } from "node:assert/strict";
import { requestControlModel } from "../../../../test/support/request-space-fixture.ts";
import { selectValidatedSourceExecutable } from "./source-executables.ts";

Deno.test("validated source selection retains explicit, primary and single-unit rules", () => {
  const first = requestControlModel();
  const second = structuredClone(first);
  first.operator = { ...first.operator!, primary: false };
  second.operator = { ...second.operator!, primary: true };
  const compiled = [
    {
      unit: { systemQualifiedName: "First", identity: first.identity },
      model: first,
    },
    {
      unit: { systemQualifiedName: "Second", identity: second.identity },
      model: second,
    },
  ];
  equal(selectValidatedSourceExecutable(compiled, "First"), first);
  equal(selectValidatedSourceExecutable(compiled), second);
  equal(selectValidatedSourceExecutable([compiled[0]!]), first);
  throws(
    () => selectValidatedSourceExecutable(compiled, "Missing"),
    /Select an exact native conversation system/,
  );
  throws(
    () => selectValidatedSourceExecutable([...compiled, compiled[0]!], "First"),
    /Select an exact native conversation system/,
  );
});
