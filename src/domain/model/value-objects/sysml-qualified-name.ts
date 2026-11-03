function containsControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
}

/** Compare provider qualified-name spellings without flattening name segments.
 * Bare Unicode/non-basic segments are accepted because provider display names
 * may omit their source quotes. Unknown escapes and malformed names fail closed.
 */
export function parseSysmlQualifiedName(value: string): string[] | undefined {
  if (typeof value !== "string" || !value || containsControl(value)) {
    return undefined;
  }
  const names: string[] = [];
  let offset = value.startsWith("::") ? 2 : 0;
  while (offset < value.length) {
    let name = "";
    if (value[offset] === "'") {
      offset++;
      let closed = false;
      while (offset < value.length) {
        const character = value[offset++]!;
        if (character === "'") {
          closed = true;
          break;
        }
        if (character === "\\") {
          const escaped = value[offset++];
          if (escaped !== "'" && escaped !== "\\") return undefined;
          name += escaped;
        } else name += character;
      }
      if (!closed) return undefined;
    } else {
      const start = offset;
      while (
        offset < value.length && value.slice(offset, offset + 2) !== "::"
      ) {
        if (["'", "\\", ":"].includes(value[offset]!)) return undefined;
        offset++;
      }
      name = value.slice(start, offset);
      if (name.trim() !== name) return undefined;
    }
    if (!name) return undefined;
    names.push(name);
    if (offset === value.length) return names;
    if (value.slice(offset, offset + 2) !== "::") return undefined;
    offset += 2;
  }
  return undefined;
}

export function sameSysmlQualifiedName(left: string, right: string): boolean {
  const a = parseSysmlQualifiedName(left);
  const b = parseSysmlQualifiedName(right);
  return !!a && !!b && a.length === b.length &&
    a.every((segment, index) => segment === b[index]);
}

/** Quote every segment, including reserved words, to produce reference text. */
export function spellSysmlQualifiedName(segments: readonly string[]): string {
  if (
    !Array.isArray(segments) || segments.length === 0 ||
    segments.some((segment) =>
      typeof segment !== "string" || !segment ||
      containsControl(segment)
    )
  ) throw new Error("Expected nonempty qualified-name segments");
  return segments.map((segment) =>
    "'" + segment.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'"
  ).join("::");
}
