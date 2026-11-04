import type { Message } from "../../../src/application/work/runtime/state.ts";

/** "1 step", "N steps": how many host and tool records a fold holds. */
function stepCount(count: number): string {
  return count === 1 ? "1 step" : `${count} steps`;
}

/**
 * Host and tool records in a row, folded into one quiet line. Opening it shows
 * each record's exact text, as recorded, never interpreted.
 */
export function ToolSteps({ messages }: { messages: readonly Message[] }) {
  return (
    <details class="tool-steps" data-key={`message:${messages[0].id}`}>
      <summary>
        <span aria-hidden="true">···</span> {stepCount(messages.length)}
      </summary>
      <ol class="tool-steps-list">
        {messages.map((message) => (
          <li key={message.id}>
            <pre>{message.text}</pre>
          </li>
        ))}
      </ol>
    </details>
  );
}
