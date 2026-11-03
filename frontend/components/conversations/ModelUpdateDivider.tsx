import type { EffectiveModelUpdate } from "../../../src/domain/work/records/effective-model-update.ts";
import {
  revisionInspectionHref,
  shortSourceVersion,
} from "../../lib/model/revisions/api.ts";

/** A recorded activation, with a comparison only when both revisions are known. */
export function ModelUpdateDivider(
  { update, affectedOperator, requestScoped = false }: {
    update: EffectiveModelUpdate;
    /** A Request cannot use the Main-only revision link. */
    requestScoped?: boolean;
    /** Name (or exact identifier) of an operator other than this thread's owner. */
    affectedOperator?: string;
  },
) {
  const version = update.to.repositoryVersion;
  const href = version && !requestScoped
    ? revisionInspectionHref({
      selection: { kind: "commit", id: version },
      base: update.from.repositoryVersion,
    })
    : undefined;
  const label = update.kind === "action-flow"
    ? "Action flow updated"
    : "Model updated";
  const exact = version || update.to.digest;
  return (
    <div class="model-update-divider" data-update={update.id}>
      <span class="model-update-label">
        {label}
        {affectedOperator && <span>{` · ${affectedOperator}`}</span>}
      </span>
      {href
        ? (
          <a
            href={href}
            title={exact}
            aria-label={`${label}${
              affectedOperator ? ` for ${affectedOperator}` : ""
            }: inspect version ${exact}`}
          >
            View version
          </a>
        )
        : (
          <span class="model-update-version" title={exact}>
            Version {shortSourceVersion(exact)}
          </span>
        )}
    </div>
  );
}
