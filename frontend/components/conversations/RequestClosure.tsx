import { type CaseRecord, isOpenCase } from "../../lib/cases/cases.ts";

/**
 * Where the owner's reply field was, once a Request is closed: one line that
 * says how it ended. A verdict is only ever recorded with the person's own
 * closure, so it is theirs. An open Request shows nothing here.
 */
export function RequestClosure(
  { record }: { record: Pick<CaseRecord, "status" | "verdict"> },
) {
  if (isOpenCase(record)) return null;
  const outcome = record.verdict
    ? `${record.verdict} by you`
    : record.status === "closed-abandoned"
    ? "abandoned"
    : "done";
  return <p class="request-closed" role="status">{`Closed · ${outcome}`}</p>;
}
