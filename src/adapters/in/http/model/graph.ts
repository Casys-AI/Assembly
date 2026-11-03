/** Read-only presentation API; graph identities and authority come from the model. */
export interface ModelGraphSnapshot {
  graph: unknown;
  version: string;
  projectionDigest: string;
  activityDigest?: string;
  projectionDigestScope?: "native" | "legacy-with-activity";
  readAt?: string;
  error: string | null;
  history: null | { revision: number; recordedAt: string } | {
    modelVersion: string;
  };
}

export interface ModelGraphReader {
  current(): ModelGraphSnapshot;
  source(version: string): Promise<ModelGraphSnapshot>;
  recorded(revision: number): Promise<ModelGraphSnapshot | null>;
}

export function createModelGraphHandler(reader: ModelGraphReader) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/model-graph") return null;
    const json = (value: unknown, status = 200) =>
      Response.json(value, {
        status,
        headers: { "cache-control": "no-store" },
      });
    if (request.method !== "GET") {
      return new Response(null, { status: 405, headers: { allow: "GET" } });
    }
    const entries = [...url.searchParams];
    if (
      entries.length > 1 ||
      entries.some(([key]) => !["revision", "modelVersion"].includes(key))
    ) return json({ error: "Choisir une seule version à consulter." }, 400);

    const version = url.searchParams.get("modelVersion");
    if (version !== null) {
      if (!/^(branch|commit):[A-Za-z0-9_-]+$/.test(version)) {
        return json({ error: "Version de modèle invalide." }, 400);
      }
      return json(await reader.source(version));
    }
    const raw = url.searchParams.get("revision");
    if (raw !== null) {
      const revision = Number(raw);
      if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(revision)) {
        return json({ error: "Révision invalide." }, 400);
      }
      const snapshot = await reader.recorded(revision);
      return snapshot ? json(snapshot) : json(
        { error: "Aucune projection enregistrée pour cette révision." },
        404,
      );
    }
    return json(reader.current());
  };
}
