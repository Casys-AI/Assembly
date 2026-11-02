import type { Mark, MarkKind } from "../../../lib/system/rights/projection.ts";
import { Icon } from "../../view/Icon.tsx";

/** The dot (view.css) each kind of mark is drawn with: the look the matrix gives its states. */
const DOT: Readonly<Record<Exclude<MarkKind, "lock">, string>> = {
  full: "allowed",
  half: "propose",
  empty: "denied",
};

/**
 * What an actor may do, as a mark: a full disc (alone), a half disc (proposes,
 * a decision follows), a ring (not given; a warm ring when the model grants it
 * to no use), a lock (never). The page that draws it says what it stands for
 * in its tooltip, so the mark carries no text of its own.
 */
export function RightsMark({ mark }: { mark: Mark }) {
  return mark.kind === "lock" ? <Icon name="lock" class="faint" /> : (
    <span
      class={`dot ${DOT[mark.kind]}${mark.unusable ? " is-unusable" : ""}`}
    />
  );
}
