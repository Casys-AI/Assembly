/** Only the new exact-source Diagnostics destination is interpreted. All other
 * chat text (including code, line breaks and HTML) stays escaped plain text. */
function diagnosticsHref(href: string): boolean {
  if (!href.startsWith("/system?")) return false;
  let url: URL;
  try {
    url = new URL(href, "http://diagnostics.invalid");
  } catch {
    return false;
  }
  if (url.pathname !== "/system" || url.hash) return false;
  const names = [...url.searchParams.keys()];
  if (
    names.length !== new Set(names).size ||
    names.some((name) => !["page", "version", "caseBranch"].includes(name)) ||
    url.searchParams.get("page") !== "diagnostics" ||
    !/^commit:[a-f0-9]{40}$/.test(url.searchParams.get("version") ?? "")
  ) return false;
  const caseId = url.searchParams.get("caseBranch");
  return caseId === null || /^[A-Za-z0-9_:-]{1,128}$/.test(caseId);
}

export function DiagnosticsMessageText({ text }: { text: string }) {
  const parts = [];
  const tokens = /(`+|~{3,})|\[([^\]\r\n]+)\]\(([^()\s]+)\)/g;
  let codeDelimiter: string | undefined;
  let position = 0;
  for (const match of text.matchAll(tokens)) {
    if (match[1]) {
      if (codeDelimiter === undefined) codeDelimiter = match[1];
      else if (codeDelimiter === match[1]) codeDelimiter = undefined;
      continue;
    }
    const index = match.index!;
    if (
      codeDelimiter !== undefined || text[index - 1] === "\\" ||
      !diagnosticsHref(match[3])
    ) continue;
    parts.push(
      <span key={`text-${position}`}>{text.slice(position, index)}</span>,
    );
    parts.push(<a key={index} href={match[3]}>{match[2]}</a>);
    position = index + match[0].length;
  }
  if (parts.length === 0) return <>{text}</>;
  parts.push(<span key={`text-${position}`}>{text.slice(position)}</span>);
  return <>{parts}</>;
}
