import {
  ModelContextError,
  type ModelSourceRange,
} from "../consultation/context.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function requireModelContext(
  value: unknown,
  code: ModelContextError["code"],
  message: string,
): asserts value {
  if (!value) throw new ModelContextError(code, message);
}

/** Native source positions use one-based UTF-8 byte columns. Never apply these
 * columns directly to JavaScript string offsets. No sourceText fallback. */
export function utf8SourceSpan(
  source: string,
  location: ModelSourceRange,
): string {
  requireModelContext(
    location.coordinateSystem === "utf8-bytes" &&
      [
        location.startLine,
        location.startColumn,
        location.endLine,
        location.endColumn,
      ].every((value) => Number.isSafeInteger(value) && value > 0),
    "INVALID_SOURCE_RANGE",
    "Source range must contain positive UTF-8 byte coordinates",
  );
  const bytes = encoder.encode(source);
  const starts = [0];
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 10) starts.push(index + 1);
  }
  const at = (line: number, column: number): number => {
    const start = starts[line - 1];
    const end = line < starts.length ? starts[line]! - 1 : bytes.length;
    requireModelContext(
      start !== undefined && column - 1 <= end - start,
      "INVALID_SOURCE_RANGE",
      "Source position is outside its exact snapshot",
    );
    return start + column - 1;
  };
  const start = at(location.startLine, location.startColumn);
  const end = at(location.endLine, location.endColumn);
  requireModelContext(
    end > start,
    "INVALID_SOURCE_RANGE",
    "Empty or reversed range",
  );
  try {
    // Check both boundaries, including cases where the selected bytes alone
    // happen to decode but a boundary would split a preceding character.
    decoder.decode(bytes.subarray(0, start));
    return decoder.decode(bytes.subarray(start, end));
  } catch {
    throw new ModelContextError(
      "INVALID_SOURCE_RANGE",
      "Source position splits a UTF-8 character",
    );
  }
}
