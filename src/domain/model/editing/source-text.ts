/** Trim only exterior indentation; preserve the member's relative layout. */
export function normalizeMember(text: string): string {
  return text.trim().split("\n").map((line) => line.trim()).join("\n");
}
