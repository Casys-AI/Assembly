import { VIEW_MODES, type ViewMode } from "../../lib/system/view-prefs.ts";

const LABEL: Readonly<Record<ViewMode, string>> = {
  readable: "Readable",
  sysml: "SysML",
};

/**
 * "Readable | SysML": the words the pages tell the model in, the model's made
 * readable or SysML's own (keywords and types). A choice of the person looking,
 * not an address: it changes the page in place.
 */
export function ModeSwitch(
  { mode, onChange }: { mode: ViewMode; onChange(mode: ViewMode): void },
) {
  return (
    <div class="seg" role="group" aria-label="Words used">
      {VIEW_MODES.map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={mode === id ? "true" : "false"}
          onClick={() => onChange(id)}
        >
          {LABEL[id]}
        </button>
      ))}
    </div>
  );
}
