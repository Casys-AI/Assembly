import { useEffect, useState } from "preact/hooks";
import {
  diagramFileName,
  downloadText,
} from "../../../lib/model/diagrams/location.ts";
import {
  type ViewsApi,
  viewsCanRetry,
  type ViewsProblem,
  viewsProblem,
} from "../../../lib/model/diagrams/api.ts";
import { ReadFailure } from "../../view/ReadFailure.tsx";

/** Mounted only by the explicit PlantUML button; ordinary diagram reads never generate an export. */
export function PlantumlPanel({ api, version, view, title, close }: {
  api: ViewsApi;
  version: string;
  view: string;
  title: string;
  close(): void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [problem, setProblem] = useState<ViewsProblem | null>(null);
  const [retry, setRetry] = useState(0);
  const [copyMessage, setCopyMessage] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setProblem(null);
    setSource(null);
    api.plantuml(version, view, abort.signal).then((text) => {
      if (!abort.signal.aborted) setSource(text);
    }).catch((error) => {
      if (!abort.signal.aborted) setProblem(viewsProblem(error, true));
    });
    return () => abort.abort();
  }, [api, version, view, retry]);
  return (
    <section
      class="sysml-plantuml"
      aria-label="PlantUML source"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <header>
        <h2>PlantUML</h2>
        <button type="button" onClick={close} aria-label="Close PlantUML">
          ×
        </button>
      </header>
      <div class="sysml-plantuml-body">
        {source === null && !problem && (
          <p role="status">Generating PlantUML…</p>
        )}
        {problem && (
          <ReadFailure
            problem={problem}
            again={viewsCanRetry(problem)
              ? { run: () => setRetry((n) => n + 1), wait: problem.retryAfter }
              : undefined}
          />
        )}
        {source !== null && (
          <textarea
            aria-label="Generated PlantUML"
            readOnly
            value={source}
            spellcheck={false}
            wrap="off"
            rows={Math.max(4, Math.min(32, source.split("\n").length))}
          />
        )}
      </div>
      {source !== null && (
        <div class="sysml-export-actions">
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(source);
                setCopyMessage("Copied");
              } catch {
                setCopyMessage("Select the source above to copy it.");
              }
            }}
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() =>
              downloadText(
                `${diagramFileName(title)}.puml`,
                "text/plain;charset=utf-8",
                source,
              )}
          >
            Download .puml
          </button>
          <span role="status">{copyMessage}</span>
        </div>
      )}
    </section>
  );
}
