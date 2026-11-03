import { useEffect, useState } from "preact/hooks";
import {
  type ArtifactSourceBindingReference,
  validateSourceBindingReference,
} from "../../../src/domain/work/artifacts/source-reference.ts";
import type { ArtifactSourceInspection } from "../../../src/domain/work/records/artifact-source-inspection.ts";
import {
  comparableSource,
  comparisonSource,
  type KnownArtifactSource,
  readArtifactSources,
  sourceText,
} from "../../lib/system/tools/artifact-sources.ts";
import { ProposalCodeDiff } from "../model/changes/ProposalCodeDiff.tsx";

function Identity({ source }: { source: KnownArtifactSource }) {
  const { binding } = source;
  return (
    <details class="detail-more">
      <summary>
        {source.label} · {binding.reference.commitOid.slice(0, 12)}
      </summary>
      <dl class="detail-facts">
        <dt>Owner</dt>
        <dd>
          <code>{binding.ownerId}</code>
        </dd>
        <dt>Artifact</dt>
        <dd>
          <code>{binding.localArtifactId}</code>
        </dd>
        <dt>Commit</dt>
        <dd>
          <code>{binding.reference.commitOid}</code>
        </dd>
        <dt>Content digest</dt>
        <dd>
          <code>{binding.reference.contentDigest}</code>
        </dd>
        <dt>Manifest digest</dt>
        <dd>
          <code>{binding.reference.manifestDigest}</code>
        </dd>
        <dt>Binding</dt>
        <dd>
          <code>{binding.bindingId}</code> · revision {binding.revision}
        </dd>
      </dl>
    </details>
  );
}

function SourceActions({ current, pin, disabled, open }: {
  current: KnownArtifactSource;
  pin: KnownArtifactSource | null;
  disabled: boolean;
  open(sources: KnownArtifactSource[]): void;
}) {
  return (
    <div class="detail-actions">
      <button
        type="button"
        class="chip is-action"
        disabled={disabled}
        onClick={() => open([current])}
      >
        Open exact source
      </button>
      <button
        type="button"
        class="chip is-action"
        disabled={disabled}
        onClick={() => {
          comparisonSource.value = structuredClone(current);
        }}
      >
        Keep for comparison
      </button>
      {comparableSource(pin, current) && (
        <button
          type="button"
          class="chip is-action"
          disabled={disabled}
          onClick={() => open([pin, current])}
        >
          Compare with {pin.label}{" "}
          ({pin.binding.reference.commitOid.slice(0, 8)})
        </button>
      )}
      {pin && pin.agentId === current.agentId && (
        <button
          type="button"
          class="chip"
          onClick={() => comparisonSource.value = null}
        >
          Clear comparison
        </button>
      )}
    </div>
  );
}

/** Inspecting and comparing retained bytes never updates a runtime/catalog pin. */
export function ArtifactSourceInspector(
  {
    agentId,
    label,
    binding,
    disabled = false,
  }: {
    agentId: string;
    label: string;
    binding?: ArtifactSourceBindingReference;
    disabled?: boolean;
  },
) {
  const [selection, setSelection] = useState<KnownArtifactSource[] | null>(
    null,
  );
  const [result, setResult] = useState<ArtifactSourceInspection | null>(null);
  const [error, setError] = useState("");
  const current: KnownArtifactSource | null = (() => {
    try {
      validateSourceBindingReference(binding);
      return { agentId, label, binding };
    } catch {
      return null;
    }
  })();
  const pin = comparisonSource.value;
  useEffect(() => {
    setResult(null);
    setError("");
    if (!selection || selection[0]!.agentId !== agentId) return;
    const controller = new AbortController();
    void readArtifactSources(
      selection[0]!.agentId,
      selection.map((source) => source.binding),
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setResult(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(
            "The exact retained source is unavailable. Read again or choose another known version.",
          );
        }
      });
    return () => controller.abort();
  }, [selection, agentId]);
  useEffect(() => {
    setSelection(null);
    setResult(null);
    setError("");
  }, [agentId]);
  if (!current) {
    return <p class="faint">Retained source unavailable for this record.</p>;
  }
  const open = (sources: KnownArtifactSource[]) => {
    setResult(null);
    setError("");
    setSelection(structuredClone(sources));
  };
  return (
    <div class="artifact-source-inspector">
      <SourceActions
        current={current}
        pin={pin}
        disabled={disabled}
        open={open}
      />
      {selection && selection[0]!.agentId === agentId && (
        <section aria-label="Exact retained source" data-artifact-source>
          <p>
            Retained source · read only{" "}
            <button
              type="button"
              class="chip"
              onClick={() =>
                setSelection(null)}
            >
              Close source
            </button>
          </p>
          {selection.map((source) => (
            <Identity key={source.binding.bindingId} source={source} />
          ))}
          {error
            ? <p role="status">{error}</p>
            : !result
            ? <p role="status">Reading exact retained bytes…</p>
            : result.sources.length === 2
            ? result.patch
              ? <ProposalCodeDiff patch={result.patch} />
              : <p>No content differences.</p>
            : (
              <pre class="is-code"><code>{sourceText(result.sources[0]!)}</code></pre>
            )}
        </section>
      )}
    </div>
  );
}
