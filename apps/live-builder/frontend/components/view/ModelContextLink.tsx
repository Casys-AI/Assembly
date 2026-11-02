import { type ComponentChildren, createContext, type JSX } from "preact";
import { useContext } from "preact/hooks";
import { inheritModelViewContext } from "../../lib/workbench/model-context.ts";

/** The current Request is navigation context, never authority to read a ref. */
export const ModelLinkContext = createContext("");

/** Preserve context in the rendered href, including copy and open-in-new-tab. */
export function useModelContextHref(href: string): string {
  const search = useContext(ModelLinkContext);
  return search && href.startsWith("/") && !href.startsWith("//")
    ? inheritModelViewContext(href, search)
    : href;
}

export function ModelContextLink(
  props: JSX.IntrinsicElements["a"] & { children?: ComponentChildren },
) {
  const href = useModelContextHref(
    typeof props.href === "string" ? props.href : "",
  );
  return (
    <a {...props} href={typeof props.href === "string" ? href : props.href} />
  );
}
