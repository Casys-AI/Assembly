import { type ComponentChildren, Fragment } from "preact";
import { useRef } from "preact/hooks";
import {
  VERSION_STATUS_LABELS,
  versionFacts,
  type VersionInfo,
  versionLabel,
  versionStatus,
} from "../../lib/workbench/version-label.ts";
import { useDismiss } from "./useDismiss.ts";

/** A readable version everywhere; exact identities stay in its inspection. */
export function VersionPill(
  { inspect = false, onInspect, ...info }: VersionInfo & {
    /** False inside another interactive element, such as a Request list link. */
    inspect?: boolean;
    onInspect?: () => void;
  },
) {
  const label = versionLabel(info);
  const status = versionStatus(info);
  const accessibleLabel = `${label} · ${VERSION_STATUS_LABELS[status]}${
    info.readOnly ? " · Read-only" : ""
  }`;
  const facts = versionFacts(info);
  const title = facts.map(([key, value]) => `${key}: ${value}`).join("\n");
  const content = (
    <span
      class="chip"
      role="img"
      aria-label={accessibleLabel}
      title={title}
    >
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
        <circle
          cx="4"
          cy="4"
          r="3"
          stroke="currentColor"
          fill={status === "in-service" ? "currentColor" : "none"}
        />
      </svg>
      {label}
      {info.readOnly && (
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <rect x="4" y="7" width="8" height="6" rx="1" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
      )}
    </span>
  );
  return inspect
    ? (
      <VersionInspection
        label={accessibleLabel}
        facts={facts}
        onInspect={onInspect}
      >
        {content}
      </VersionInspection>
    )
    : content;
}

function VersionInspection({ label, facts, children, onInspect }: {
  label: string;
  facts: [string, string][];
  children: ComponentChildren;
  onInspect?: () => void;
}) {
  const area = useRef<HTMLDetailsElement>(null);
  useDismiss(area);
  return (
    <details
      class="version-pill"
      ref={area}
      onToggle={(event) => {
        if (event.currentTarget.open) onInspect?.();
      }}
    >
      <summary aria-label={`Inspect ${label}`}>{children}</summary>
      <dl class="detail-facts" aria-label="Version details">
        {facts.map(([key, value]) => (
          <Fragment key={key}>
            <dt>{key}</dt>
            <dd
              class={[
                  "Version",
                  "In service",
                  "Admitted source",
                  "Base version",
                  "Model digest",
                ].includes(key)
                ? "is-code"
                : undefined}
            >
              {value}
            </dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}
