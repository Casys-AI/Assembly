import { useContext } from "preact/hooks";
import { ModelLinkContext } from "../../view/ModelContextLink.tsx";
import { inheritModelViewContext } from "../../../lib/workbench/model-context.ts";
import type { ModelViewSummary } from "../../../../src/domain/model/records/diagram-views.ts";
import { VIEW_GROUPS } from "../../../lib/model/diagrams/api.ts";
import { sysmlHref } from "../../../lib/model/diagrams/location.ts";

/** Fresh's GET navigation keeps the chosen view bookmarkable and supports back/forward. */
export function ViewPicker(
  { views, selected, version }: {
    views: ModelViewSummary[];
    selected?: string;
    version?: string;
  },
) {
  const context = useContext(ModelLinkContext);
  const params = new URLSearchParams(context);
  const action = (view?: string) =>
    inheritModelViewContext(sysmlHref({ version, view }), context);
  return (
    <form
      class="sysml-picker"
      action={action(selected)}
      method="GET"
      f-partial="/model"
      onSubmit={(event) => {
        const form = event.currentTarget;
        const value = new FormData(form).get("view");
        form.action = action(typeof value === "string" ? value : undefined);
      }}
    >
      <input type="hidden" name="page" value="sysml" />
      {version && <input type="hidden" name="version" value={version} />}
      {(["caseBranch", "agent", "branch"] as const).map((name) => {
        const value = params.get(name);
        return value
          ? <input key={name} type="hidden" name={name} value={value} />
          : null;
      })}
      <select
        name="view"
        aria-label="SysML view"
        value={selected ?? ""}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        {!views.some((v) => v.id === selected) && (
          <option value="" disabled>Select a view</option>
        )}
        {Object.entries(VIEW_GROUPS).map(([group, title]) => {
          const entries = views.filter((v) => v.group === group);
          return entries.length > 0 && (
            <optgroup key={group} label={title}>
              {entries.map((v) => (
                <option key={v.id} value={v.id}>{v.title}</option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </form>
  );
}
