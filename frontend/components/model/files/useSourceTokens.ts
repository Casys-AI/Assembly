import { useEffect, useState } from "preact/hooks";
import type { SourceTokensDocument } from "../../../../src/domain/model/consultation/source-tokens.ts";
import { fetchSourceTokens } from "../../../lib/model/sources/tokens.ts";

/** A late answer never colors another path, version, or source body. */
export function useSourceTokens(
  version: string | undefined,
  path: string,
  text: string | null,
  read: typeof fetchSourceTokens = fetchSourceTokens,
) {
  const [loaded, setLoaded] = useState<
    {
      version: string;
      path: string;
      text: string;
      document: SourceTokensDocument;
    } | null
  >(null);
  useEffect(() => {
    if (!version || text === null) return;
    const abort = new AbortController();
    read(version, path, abort.signal).then((document) => {
      if (!abort.signal.aborted) setLoaded({ version, path, text, document });
    }).catch(() => {
      if (!abort.signal.aborted) setLoaded(null);
    });
    return () => abort.abort();
  }, [version, path, text, read]);
  return loaded && loaded.version === version && loaded.path === path &&
      loaded.text === text
    ? loaded.document
    : null;
}
