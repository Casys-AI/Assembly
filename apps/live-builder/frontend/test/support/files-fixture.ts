import { HEAD, PARENT, PROPOSED, ROOT } from "./revision-fixture.ts";

/**
 * The text of the files of the revision fixture's model, version by version:
 * the sources a host serves beside its history (`modelHost({ files })`), which
 * says which commit last changed each file. They follow that history, which
 * lists no other file: ROOT admitted the configuration and `lib/units.sysml`,
 * PARENT changed the configuration and added the reader, HEAD changed the
 * configuration again, and the open proposal's own version changes it once more.
 */
export { HEAD, PARENT, PROPOSED, ROOT };

export const CONFIGURATION = [
  "package Configuration {",
  "  part def Editor;",
  "  doc /* <img src=x onerror=attack()> */",
  "}",
  "",
].join("\n");

const READER = "package Reader;\n";
const UNITS = "package Units {\n  attribute metre;\n}\n";

/** A fresh copy each time: a test may change what a version holds. */
export function sourceTexts(): Record<string, Record<string, string>> {
  return {
    [HEAD]: {
      "configuration.sysml": CONFIGURATION,
      "reader.sysml": READER,
      "lib/units.sysml": UNITS,
    },
    [PARENT]: {
      "configuration.sysml": "package Configuration;\n",
      "reader.sysml": READER,
      "lib/units.sysml": UNITS,
    },
    [ROOT]: {
      "configuration.sysml": "package Configuration;\n",
      "lib/units.sysml": UNITS,
    },
    [PROPOSED]: {
      "configuration.sysml": CONFIGURATION.replace(
        "part def Editor;",
        "part def Editor;\n  part def Ranker;",
      ),
      "reader.sysml": READER,
      "lib/units.sysml": UNITS,
    },
  };
}
