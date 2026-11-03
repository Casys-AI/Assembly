import { MAX_USER_MESSAGE_CHARS } from "../../../src/domain/work/records/conversations.ts";

/** The counter stays out of the way until the text is this close to the bound. */
const SHOWN_FROM = Math.floor(MAX_USER_MESSAGE_CHARS * 0.9);

/** What the host counts: the text as it is sent (trimmed), in `String.length`. */
const sentLength = (text: string) => text.trim().length;

const characters = (count: number) => count.toLocaleString("en-US");

/**
 * Whether the host would refuse this free text for its length. Nothing is cut:
 * the field keeps what was typed or pasted and sending waits for the person.
 */
export const exceedsBound = (text: string) =>
  sentLength(text) > MAX_USER_MESSAGE_CHARS;

/**
 * The length of free human text against the host's single bound, drawn only
 * when it is near or past it. The person shortens the text; it is never cut.
 */
export function FreeTextCount({ text, id }: { text: string; id?: string }) {
  const length = sentLength(text);
  if (length < SHOWN_FROM) return null;
  const over = length > MAX_USER_MESSAGE_CHARS;
  const bound = characters(MAX_USER_MESSAGE_CHARS);
  return (
    <p
      class={`free-text-count${over ? " is-over" : ""}`}
      id={id}
      role={over ? "status" : undefined}
    >
      {over
        ? `Message too long: ${characters(length)} / ${bound} characters`
        : `${characters(length)} / ${bound}`}
    </p>
  );
}
