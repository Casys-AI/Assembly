import { modelHref } from "../../workbench/desk.ts";

/** Source revisions stay separate from the old numeric execution revisions. */
export function sysmlLocation(search: string) {
  const params = new URLSearchParams(search);
  return {
    version: params.get("version") || params.get("modelVersion") || undefined,
    view: params.get("view") || undefined,
    selected: params.get("select") || null,
  };
}
export function sysmlHref(
  params: { version?: string; view?: string; selected?: string | null } = {},
) {
  return modelHref("sysml", {
    version: params.version,
    view: params.view,
    select: params.selected,
  });
}

export function sourceExport(sources: Record<string, string>): string {
  return Object.keys(sources).sort().map((path) =>
    `// ${path}\n${sources[path].trimEnd()}\n`
  ).join("\n");
}
export function downloadText(name: string, type: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function diagramFileName(title: string): string {
  return title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(
    /[^a-zA-Z0-9._-]+/g,
    "-",
  ) || "model";
}
