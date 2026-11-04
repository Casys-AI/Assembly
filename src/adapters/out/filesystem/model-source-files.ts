import type { ModelSourceFilesPort } from "../../../application/model/source-files.ts";
import { loadInitialSources } from "./initial-model-sources.ts";

export const modelSourceFiles: ModelSourceFilesPort = {
  initialSources(options) {
    return loadInitialSources(undefined, options);
  },
  template(name) {
    return Deno.readTextFile(
      new URL(name, new URL("../../../../models/", import.meta.url)),
    );
  },
};
