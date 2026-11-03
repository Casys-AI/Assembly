import type {
  GraphDiff,
  GraphDiffChange,
} from "../../lib/model/revisions/api.ts";

const kinds = { added: "Added", removed: "Removed", changed: "Changed" };
const categories = {
  element: "Element",
  relationship: "Relationship",
  endpoint: "Endpoint",
};
const maxValueLength = 1200;
const maxFields = 30;
function FieldValue({ value }: { value: unknown }) {
  const text = value === undefined
    ? "Missing"
    : typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2);
  return (
    <>
      <pre><code>{text.slice(0, maxValueLength)}</code></pre>
      {text.length > maxValueLength && (
        <span class="revision-meta">
          Value shortened after 1,200 characters.
        </span>
      )}
    </>
  );
}
function Change({ change }: { change: GraphDiffChange }) {
  return (
    <details class={`revision-graph-change revision-graph-${change.kind}`}>
      <summary>
        <span class="revision-graph-kind">{kinds[change.kind]}</span>
        <span class="revision-graph-heading">
          <strong>{change.label || change.qualifiedName || change.id}</strong>
          <span class="revision-meta">
            {categories[change.category]} · {change.metaclass}
          </span>
        </span>
        <span class="revision-meta">{change.fields.length} fields</span>
      </summary>
      <div class="revision-graph-details">
        {change.qualifiedName && (
          <p class="revision-meta">
            Qualified name: <code>{change.qualifiedName}</code>
          </p>
        )}
        <p class="revision-meta">
          {change.category === "endpoint"
            ? "SysML identity of the relationship"
            : "SysML identity"}: <code>{change.nativeId}</code>
        </p>
        <p class="revision-meta">
          Model document: <code>{change.id}</code>
        </p>
        {!change.fields.length && (
          <p class="revision-meta">No fields to show.</p>
        )}
        {change.fields.slice(0, maxFields).map((field) => (
          <div class="revision-graph-field" key={field.field}>
            <h3>
              <code>{field.field}</code>
            </h3>
            <div class="revision-graph-values">
              <div>
                <span class="revision-meta">Before</span>
                <FieldValue value={field.before} />
              </div>
              <div>
                <span class="revision-meta">After</span>
                <FieldValue value={field.after} />
              </div>
            </div>
          </div>
        ))}
        {change.fields.length > maxFields && (
          <p class="revision-meta">
            {change.fields.length - maxFields} more fields not shown.
          </p>
        )}
      </div>
    </details>
  );
}

/** Values from model documents remain escaped JSX, including nested JSON. */
export default function GraphRevisionDiff(
  { diff, error }: { diff?: GraphDiff; error?: string },
) {
  if (error) return <p class="revision-error" role="alert">{error}</p>;
  if (!diff) {
    return (
      <p class="revision-diff-placeholder" role="status">
        Reading model changes…
      </p>
    );
  }
  return (
    <section
      class="revision-graph-diff"
      aria-label="Diff of elements and relationships"
    >
      <div class="revision-diff-stats" role="status">
        <span class="revision-added">+{diff.counts.added} added</span>
        <span class="revision-deleted">−{diff.counts.removed} removed</span>
        <span>{diff.counts.changed} changed</span>
        <span>{diff.engine}</span>
      </div>
      {diff.truncated && (
        <p class="revision-notice">
          Partial list: some changes are not shown. The counts cover the whole
          comparison.
        </p>
      )}
      {!diff.changes.length
        ? (
          <p class="revision-diff-placeholder">
            {diff.truncated
              ? "No changes in the list received."
              : "No element or relationship changes between these two versions."}
          </p>
        )
        : (
          <div class="revision-graph-list">
            {diff.changes.map((change) => (
              <Change key={`${change.category}:${change.id}`} change={change} />
            ))}
          </div>
        )}
    </section>
  );
}
