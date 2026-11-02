import type { BoardDiagnostic } from "../../../../src/domain/model/records/board.ts";

/**
 * What the host noted while it read the model, each with the code it gave and
 * what it says to do about it. The words are the host's: nothing is added.
 */
export function BoardNotes({ notes }: { notes: readonly BoardDiagnostic[] }) {
  if (notes.length === 0) return null;
  return (
    <ul class="board-notes" aria-label="Notes on reading the model">
      {notes.map((note, index) => (
        <li
          key={`${note.code}-${index}`}
          data-code={note.code}
          data-severity={note.severity}
        >
          <code class="rev-host-code">{note.code}</code>
          {note.recovery}
        </li>
      ))}
    </ul>
  );
}
