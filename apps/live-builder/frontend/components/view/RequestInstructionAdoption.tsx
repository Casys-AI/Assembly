import { useEffect, useRef, useState } from "preact/hooks";
import type { CaseModelScope } from "../../lib/case-model-scope.ts";

type Pin = { version: string; digest: string };
type Intent = {
  v: 1;
  caseId: string;
  branchId: string;
  executionSpaceId: string;
  adoptionKey: string;
  before: Pin;
  target: Pin;
};
type Status = {
  caseId: string;
  adoptionKey: string;
  status: "prepared" | "armed" | "adopted" | "refused" | "cancelled";
  before: Pin;
  target: Pin;
  blockers: { code: string; detail: string }[];
  receipt?: {
    commandId: string;
    receiptDigest: string;
    committedRuntimeRevision: number;
    journalRevision: number;
    journalDigest: string;
    recordedAt: string;
  };
};
type Eligibility = {
  caseId: string;
  eligible: boolean;
  executing: Pin;
  admitted: Pin;
  blockers: { code: string; detail: string }[];
};
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const version = (v: unknown): v is string =>
  typeof v === "string" && /^commit:[a-f0-9]{40}$/.test(v);
const digest = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const identity = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/.test(v);
const pin = (v: unknown): v is Pin =>
  object(v) && version(v.version) && digest(v.digest);
const blockers = (v: unknown): v is { code: string; detail: string }[] =>
  Array.isArray(v) && v.length <= 256 &&
  v.every((b) => object(b) && boundedText(b.code) && boundedText(b.detail));
const boundedText = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 2048 &&
  v.trim() === v && v !== "*" &&
  // deno-lint-ignore no-control-regex -- Same closed text bound as the server parser.
  !/[\u0000-\u001f\u007f]/.test(v);
const samePin = (a: Pin, b: Pin) =>
  a.version === b.version && a.digest === b.digest;
const storageKey = (scope: CaseModelScope) =>
  `assembly.request-adoption.v1:${
    JSON.stringify([scope.caseId, scope.branchId, scope.executionSpaceId])
  }`;
function validIntent(value: unknown, scope: CaseModelScope): value is Intent {
  return object(value) && value.v === 1 && value.caseId === scope.caseId &&
    value.branchId === scope.branchId &&
    value.executionSpaceId === scope.executionSpaceId &&
    identity(value.adoptionKey) && pin(value.before) && pin(value.target);
}
/** Promote the old tab-local slot once; only the durable slot remains active. */
function storedIdentity(
  scope: CaseModelScope,
  promote = false,
  storage = globalThis.localStorage,
  legacyStorage = globalThis.sessionStorage,
): string | null {
  const key = storageKey(scope);
  let raw = storage.getItem(key);
  const legacy = legacyStorage.getItem(key);
  for (const encoded of [raw, legacy]) {
    if (encoded !== null && !validIntent(JSON.parse(encoded), scope)) {
      throw new Error(
        "The saved adoption identity is invalid. No new adoption can be started here.",
      );
    }
  }
  if (legacy !== null) {
    if (raw !== null && raw !== legacy) {
      throw new Error(
        "Conflicting saved adoption identities require recovery. No action was sent.",
      );
    }
    if (!promote) return raw ?? legacy;
    if (raw === null) {
      storage.setItem(key, legacy);
      if (storage.getItem(key) !== legacy) {
        throw new Error(
          "The adoption identity could not be retained; no action was sent.",
        );
      }
      raw = legacy;
    }
    legacyStorage.removeItem(key);
    if (legacyStorage.getItem(key) !== null) {
      throw new Error(
        "The previous adoption slot could not be retired. No action was sent.",
      );
    }
  }
  return raw;
}
function withIdentityLock<T>(
  scope: CaseModelScope,
  work: (storage: Storage, legacy: Storage) => T,
): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) {
    return Promise.reject(
      new Error(
        "Safe browser locking is unavailable. Status can be read, but adoption changes are disabled.",
      ),
    );
  }
  const storage = globalThis.localStorage, legacy = globalThis.sessionStorage;
  return locks.request(
    storageKey(scope),
    { mode: "exclusive" },
    () => work(storage, legacy),
  );
}
function validStatus(value: unknown, intent: Intent): value is Status {
  if (
    !object(value) || value.caseId !== intent.caseId ||
    value.adoptionKey !== intent.adoptionKey ||
    !["prepared", "armed", "adopted", "refused", "cancelled"].includes(
      String(value.status),
    ) || !pin(value.before) || !pin(value.target) ||
    !samePin(value.before, intent.before) ||
    !samePin(value.target, intent.target) || !blockers(value.blockers)
  ) return false;
  if (value.status !== "adopted") return value.receipt === undefined;
  const receipt = value.receipt;
  return object(receipt) && typeof receipt.commandId === "string" &&
    /^request-adoption:[a-f0-9]{64}$/.test(receipt.commandId) &&
    digest(receipt.receiptDigest) &&
    Number.isSafeInteger(receipt.committedRuntimeRevision) &&
    Number(receipt.committedRuntimeRevision) >= 2 &&
    Number.isSafeInteger(receipt.journalRevision) &&
    Number(receipt.journalRevision) >= 3 && digest(receipt.journalDigest) &&
    typeof receipt.recordedAt === "string" &&
    Number.isFinite(Date.parse(receipt.recordedAt)) &&
    new Date(receipt.recordedAt).toISOString() === receipt.recordedAt;
}
async function post(action: string, body: unknown): Promise<unknown> {
  const response = await fetch(`/api/request-runtime-adoption/${action}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const code = object(body) && typeof body.code === "string"
      ? body.code
      : "UNAVAILABLE";
    if (action === "eligibility") {
      const messages: Record<string, string> = {
        INVALID:
          "The eligibility selection is invalid. Return to the current Request.",
        FORBIDDEN: "Current control or execution permission is unavailable.",
        CONFLICT:
          "The source or execution changed. Refresh this Request before checking eligibility.",
        BLOCKED:
          "The Request is not ready for activation. Eligibility can be checked again.",
        UNAVAILABLE:
          "Current adoption eligibility is unavailable. Retry the check.",
      };
      if (code === "ADMISSION_REFUSED") throw new Error(messages.FORBIDDEN);
      if (code === "OPENING_CONFLICT") throw new Error(messages.CONFLICT);
      if (code === "INVALID_COMMAND") throw new Error(messages.INVALID);
      throw new Error(messages[code] ?? messages.UNAVAILABLE);
    }
    if (action === "status") {
      throw new Error(
        response.status === 404
          ? "No result is known for this key. Its outcome remains unknown."
          : "The original adoption status could not be read. Retry the status check.",
      );
    }
    throw new Error(
      response.status === 404
        ? "No result is known for this key. Its outcome remains unknown."
        : "The Request adoption could not be confirmed. Its outcome may be unknown.",
    );
  }
  return await response.json();
}

/** The browser stores identity before an effect; it never supplies proof or grants authority. */
export interface RequestInstructionAdoptionProps {
  scope: CaseModelScope;
  sessionReady: boolean;
  onAdopted?(caseId: string): void;
}
/** Real interaction controller shared by the rendered control and focused hook tests. */
export function useRequestInstructionAdoption(
  { scope, sessionReady, onAdopted }: RequestInstructionAdoptionProps,
) {
  const [eligible, setEligible] = useState<Eligibility | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0), actionEpoch = useRef(0);
  const activeIntent = useRef<Intent | null>(null);
  const activeRaw = useRef<string | null>(null);
  const verifiedStatus = useRef<Status | null>(null);
  const working = useRef(false);
  const notifiedSelection = useRef<string | null>(null);
  const signature = JSON.stringify([
    scope.caseId,
    scope.branchId,
    scope.executionSpaceId,
    scope.version,
    scope.executionVersion,
    scope.branchVersion,
    sessionReady,
  ]);
  const selection = useRef(signature),
    loadedSelection = useRef<string | null>(null);
  selection.current = signature;
  const terminal = (value: Status | null) =>
    Boolean(
      value && ["adopted", "cancelled", "refused"].includes(value.status),
    );
  const current = (
    generation: number,
    actionNumber: number,
    selectedScope: string,
  ) =>
    epoch.current === generation && actionEpoch.current === actionNumber &&
    selection.current === selectedScope;
  function retainStatus(value: Status) {
    verifiedStatus.current = value;
    setStatus(value);
    if (
      value.status === "adopted" && value.receipt && onAdopted &&
      scope.executionVersion === value.before.version &&
      scope.executionVersion !== value.target.version
    ) {
      const key = JSON.stringify([signature, value.receipt.receiptDigest]);
      if (notifiedSelection.current !== key) {
        // Only a still-stale before pin needs invalidation. A corrected or
        // newer scope cannot be sent backward by replaying an old receipt.
        notifiedSelection.current = key;
        onAdopted(value.caseId);
      }
    }
  }
  function original(selected: Intent) {
    return loadedSelection.current === signature &&
      selection.current === signature &&
      validIntent(selected, scope) &&
      JSON.stringify(activeIntent.current) === JSON.stringify(selected);
  }
  function matchingStatus(value: unknown, selected: Intent): value is Status {
    const known = verifiedStatus.current;
    return validStatus(value, selected) &&
      (!known?.receipt ||
        JSON.stringify(known.receipt) === JSON.stringify(value.receipt)) &&
      (!terminal(known) || known!.status === value.status);
  }
  async function readEligibility(
    generation: number,
    actionNumber: number,
    selectedScope: string,
  ) {
    // Exact commit identities already agree: there is no new target to adopt.
    // Saved intents still resolve through status independently of this shortcut.
    if (scope.branchVersion === scope.executionVersion) return;
    try {
      const value = await post("eligibility", { caseId: scope.caseId });
      if (
        !current(generation, actionNumber, selectedScope) ||
        activeIntent.current
      ) return;
      if (
        !object(value) || value.caseId !== scope.caseId ||
        typeof value.eligible !== "boolean" ||
        !pin(value.executing) || !pin(value.admitted) ||
        !blockers(value.blockers) ||
        value.executing.version !== scope.executionVersion ||
        value.admitted.version !== scope.branchVersion
      ) {
        throw new Error(
          "Eligibility no longer matches this Request selection. Refresh the Request.",
        );
      }
      setEligible(value as Eligibility);
    } catch (error) {
      if (current(generation, actionNumber, selectedScope)) {
        setMessage(
          error instanceof Error
            ? error.message
            : "Current adoption eligibility is unavailable.",
        );
      }
    }
  }
  useEffect(() => {
    const generation = ++epoch.current, actionNumber = ++actionEpoch.current;
    activeIntent.current = null;
    activeRaw.current = null;
    verifiedStatus.current = null;
    loadedSelection.current = null;
    working.current = false;
    setIntent(null);
    setStatus(null);
    setEligible(null);
    setMessage(null);
    setBusy(false);
    void (async () => {
      let restored: Intent | null = null;
      try {
        const legacy = globalThis.sessionStorage.getItem(storageKey(scope));
        const raw = legacy !== null &&
            typeof globalThis.navigator?.locks?.request === "function"
          ? await withIdentityLock(
            scope,
            (storage, previous) =>
              current(generation, actionNumber, signature)
                ? storedIdentity(scope, true, storage, previous)
                : null,
          )
          : storedIdentity(scope);
        if (!current(generation, actionNumber, signature)) return;
        if (raw !== null) {
          const parsed: unknown = JSON.parse(raw);
          if (!validIntent(parsed, scope)) {
            throw new Error(
              "The saved adoption identity is invalid. No new adoption can be started here.",
            );
          }
          restored = parsed;
          activeIntent.current = parsed;
          activeRaw.current = raw;
          setIntent(parsed);
          setMessage(
            "An earlier adoption is recorded locally. Check or resume the same key; this is not a receipt.",
          );
        }
        loadedSelection.current = signature;
      } catch (error) {
        if (current(generation, actionNumber, signature)) {
          setMessage(
            error instanceof Error
              ? error.message
              : "Local adoption identity is unavailable.",
          );
        }
        return;
      }
      if (sessionReady && restored) {
        const selected = restored;
        try {
          const value = await post("status", {
            caseId: selected.caseId,
            adoptionKey: selected.adoptionKey,
          });
          if (!current(generation, actionNumber, signature)) return;
          if (!matchingStatus(value, selected)) {
            setMessage(
              "The result does not match the original adoption. Its outcome remains unknown.",
            );
            return;
          }
          retainStatus(value);
          setMessage(null);
        } catch {
          if (current(generation, actionNumber, signature)) {
            setMessage(
              "No verified result is available for this original key. Inspect or explicitly resume it.",
            );
          }
        }
      } else if (sessionReady) {
        await readEligibility(generation, actionNumber, signature);
      }
    })();
    return () => {
      epoch.current++;
      actionEpoch.current++;
    };
  }, [signature]);
  async function apply(
    action: "prepare" | "resume" | "status",
    selected: Intent,
  ) {
    if (
      !sessionReady || working.current || !original(selected) ||
      action !== "status" &&
        (terminal(verifiedStatus.current) ||
          scope.version !== scope.executionVersion)
    ) return;
    const generation = epoch.current, actionNumber = ++actionEpoch.current;
    working.current = true;
    setBusy(true);
    setMessage(null);
    try {
      if (action !== "status") {
        await withIdentityLock(scope, (storage, previous) => {
          if (!current(generation, actionNumber, signature)) return;
          if (
            storedIdentity(scope, true, storage, previous) !== activeRaw.current
          ) {
            throw new Error(
              "The saved adoption identity changed. Reload to recover the exact active key.",
            );
          }
        });
        if (!current(generation, actionNumber, signature)) return;
      }
      const result = await post(
        action,
        action === "prepare"
          ? {
            caseId: selected.caseId,
            adoptionKey: selected.adoptionKey,
            expectedAdmittedVersion: selected.target.version,
            expectedExecutingDigest: selected.before.digest,
          }
          : { caseId: selected.caseId, adoptionKey: selected.adoptionKey },
      );
      if (!current(generation, actionNumber, signature)) return;
      if (!matchingStatus(result, selected)) {
        throw new Error(
          "The result does not match the original adoption. Its outcome remains unknown.",
        );
      }
      retainStatus(result);
    } catch (error) {
      if (current(generation, actionNumber, signature)) {
        setMessage(
          error instanceof Error
            ? error.message
            : "The adoption outcome is unknown.",
        );
      }
    } finally {
      if (current(generation, actionNumber, signature)) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  async function acknowledge() {
    const selected = activeIntent.current, encoded = activeRaw.current;
    if (
      !selected || !encoded || !terminal(verifiedStatus.current) ||
      !sessionReady || working.current || !original(selected)
    ) return;
    const generation = epoch.current, actionNumber = ++actionEpoch.current;
    working.current = true;
    setBusy(true);
    setMessage(null);
    try {
      // Local terminal display is not sufficient: verify this exact key again.
      const result = await post("status", {
        caseId: selected.caseId,
        adoptionKey: selected.adoptionKey,
      });
      if (!current(generation, actionNumber, signature)) return;
      if (!matchingStatus(result, selected) || !terminal(result)) {
        throw new Error(
          "No matching terminal result was verified. The original identity is preserved.",
        );
      }
      retainStatus(result);
      await withIdentityLock(scope, (storage, previous) => {
        if (!current(generation, actionNumber, signature)) return;
        const key = storageKey(scope);
        if (storedIdentity(scope, true, storage, previous) !== encoded) {
          throw new Error(
            "The saved adoption identity changed. Reload to recover the exact active key.",
          );
        }
        storage.removeItem(key);
        if (storage.getItem(key) !== null) {
          throw new Error(
            "The acknowledged identity could not be cleared. No next adoption was started.",
          );
        }
      });
      if (!current(generation, actionNumber, signature)) return;
      // No client history/grant is created; immutable server receipts remain.
      activeIntent.current = null;
      activeRaw.current = null;
      verifiedStatus.current = null;
      setIntent(null);
      setStatus(null);
      setEligible(null);
      // Terminal history does not identify today's running model. Refresh the
      // adopted target and validate new eligibility against the current view.
      if (!current(generation, actionNumber, signature)) return;
      if (scope.version !== scope.executionVersion) {
        setMessage(
          "Result acknowledged. Return to the current running instruction before checking the next activation.",
        );
      } else {
        await readEligibility(generation, actionNumber, signature);
      }
    } catch (error) {
      if (current(generation, actionNumber, signature)) {
        setMessage(
          error instanceof Error
            ? error.message
            : "The original adoption identity could not be acknowledged.",
        );
      }
    } finally {
      if (current(generation, actionNumber, signature)) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  async function start() {
    if (
      !eligible || !eligible.eligible || activeIntent.current ||
      working.current || !sessionReady || message ||
      loadedSelection.current !== signature ||
      selection.current !== signature ||
      scope.version !== scope.executionVersion
    ) return;
    const generation = epoch.current, actionNumber = ++actionEpoch.current;
    working.current = true;
    setBusy(true);
    try {
      const selected = await withIdentityLock(scope, (storage, previous) => {
        if (!current(generation, actionNumber, signature)) return null;
        const key = storageKey(scope);
        if (storedIdentity(scope, true, storage, previous) !== null) {
          throw new Error(
            "An adoption identity already exists. Reload to recover it.",
          );
        }
        const selected: Intent = {
          v: 1,
          caseId: scope.caseId,
          branchId: scope.branchId,
          executionSpaceId: scope.executionSpaceId,
          adoptionKey: `adoption-${crypto.randomUUID()}`,
          before: eligible.executing,
          target: eligible.admitted,
        };
        const encoded = JSON.stringify(selected);
        storage.setItem(key, encoded);
        if (storage.getItem(key) !== encoded) {
          throw new Error(
            "The adoption identity could not be retained; no action was sent.",
          );
        }
        activeRaw.current = encoded;
        return selected;
      });
      if (!selected || !current(generation, actionNumber, signature)) return;
      activeIntent.current = selected;
      setIntent(selected);
      working.current = false;
      await apply("prepare", selected);
    } catch (error) {
      if (!current(generation, actionNumber, signature)) return;
      setMessage(
        error instanceof Error
          ? error.message
          : "The adoption identity could not be retained; no action was sent.",
      );
    } finally {
      if (current(generation, actionNumber, signature)) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  async function retryEligibility() {
    if (
      !sessionReady || working.current || activeIntent.current ||
      loadedSelection.current !== signature || selection.current !== signature
    ) return;
    const generation = epoch.current, actionNumber = ++actionEpoch.current;
    working.current = true;
    setBusy(true);
    setMessage(null);
    setEligible(null);
    try {
      await readEligibility(generation, actionNumber, signature);
    } finally {
      if (current(generation, actionNumber, signature)) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  return {
    eligible,
    intent,
    status,
    message,
    busy,
    start,
    apply,
    acknowledge,
    retryEligibility,
    canRetryEligibility: loadedSelection.current === signature &&
      !activeIntent.current && scope.branchVersion !== scope.executionVersion,
  };
}
/** Shared initial action keeps the established proposal button context. */
export function RequestInstructionActivationAction(
  { disabled, onActivate }: { disabled: boolean; onActivate(): void },
) {
  return (
    <div class="proposal-actions">
      <button
        type="button"
        class="proposal-accept"
        disabled={disabled}
        onClick={onActivate}
      >
        Activate current instruction
      </button>
    </div>
  );
}
export function RequestInstructionAdoption(
  props: RequestInstructionAdoptionProps,
) {
  const { scope, sessionReady } = props;
  const {
    eligible,
    intent,
    status,
    message,
    busy,
    start,
    apply,
    acknowledge,
    retryEligibility,
    canRetryEligibility,
  } = useRequestInstructionAdoption(props);
  const historical = scope.version !== scope.executionVersion;
  if (!eligible && !intent && !message) return null;
  return (
    <section
      class="proposal-adjustment"
      aria-label="Request instruction activation"
    >
      {!intent && message && canRetryEligibility && (
        <button
          type="button"
          disabled={busy || !sessionReady}
          onClick={() => void retryEligibility()}
        >
          Retry eligibility check
        </button>
      )}
      {eligible && !eligible.eligible && !intent && (
        <p>
          Activation is unavailable:{" "}
          {eligible.blockers.map((b) => b.detail).join(" ") ||
            "The current instruction is not eligible."}
        </p>
      )}
      {eligible?.eligible && !intent &&
        scope.version === scope.executionVersion && (
        <>
          <p>
            Activating this instruction changes the next eligible decision in
            this Request.
          </p>
          <RequestInstructionActivationAction
            disabled={busy || !sessionReady || Boolean(message)}
            onActivate={start}
          />
        </>
      )}
      {intent && (
        <>
          <p>
            Original running version <code>{intent.before.version}</code>{" "}
            → intended source <code>{intent.target.version}</code> · key{" "}
            <code>{intent.adoptionKey}</code>
          </p>
          {status && (
            <p role="status">
              {status.status === "prepared"
                ? "Prepared; the previous execution instruction is preserved."
                : status.status === "armed"
                ? "Completing at the safe boundary; new input may be refused."
                : status.status === "adopted"
                ? "The instruction is durably active in this Request."
                : `Adoption ${status.status}.`}{" "}
              {status.blockers.map((b) => b.detail).join(" ")}
            </p>
          )}
          {!status && (
            <p>
              Outcome is pending or unknown; the saved identity is not proof of
              activation.
            </p>
          )}
          {status?.receipt && (
            <RequestInstructionAdoptionReceipt receipt={status.receipt} />
          )}
          <div class="proposal-actions">
            <button
              type="button"
              class="proposal-adjust"
              disabled={busy || !sessionReady}
              onClick={() => void apply("status", intent)}
            >
              Check status
            </button>
            {!["adopted", "cancelled", "refused"].includes(
              status?.status ?? "",
            ) && (
              <>
                {!status && (
                  <button
                    type="button"
                    disabled={busy || !sessionReady || historical}
                    onClick={() => void apply("prepare", intent)}
                  >
                    Retry original preparation
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy || !sessionReady || historical}
                  class="proposal-accept"
                  onClick={() => void apply("resume", intent)}
                >
                  Resume same adoption
                </button>
              </>
            )}
            {status &&
              ["adopted", "cancelled", "refused"].includes(status.status) && (
              <button
                type="button"
                class="proposal-adjust"
                disabled={busy || !sessionReady}
                onClick={() => void acknowledge()}
              >
                Acknowledge result and check next instruction
              </button>
            )}
          </div>
        </>
      )}
      {message && <p class="proposal-notice" role="status">{message}</p>}
    </section>
  );
}
/** Rendered only after exact status/receipt validation by the controller. */
export function RequestInstructionAdoptionReceipt(
  { receipt }: { receipt: NonNullable<Status["receipt"]> },
) {
  return (
    <details>
      <summary>Committed activation receipt</summary>
      <dl class="detail-facts">
        <dt>Command</dt>
        <dd>
          <code>{receipt.commandId}</code>
        </dd>
        <dt>Receipt digest</dt>
        <dd>
          <code>{receipt.receiptDigest}</code>
        </dd>
        <dt>Runtime revision</dt>
        <dd>{receipt.committedRuntimeRevision}</dd>
        <dt>Journal revision</dt>
        <dd>{receipt.journalRevision}</dd>
        <dt>Journal digest</dt>
        <dd>
          <code>{receipt.journalDigest}</code>
        </dd>
        <dt>Recorded</dt>
        <dd>
          <time dateTime={receipt.recordedAt}>{receipt.recordedAt}</time>
        </dd>
      </dl>
    </details>
  );
}
