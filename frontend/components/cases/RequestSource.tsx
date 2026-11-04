import {
  releaseOpeningKind,
  type SavedSystemView,
} from "../../lib/system/saved-systems.ts";
import { useEffect } from "preact/hooks";
import type { WorkbenchState } from "../../lib/workbench/state.ts";

const MAIN_DETAIL = "Current Main · admitted version at opening";
const LOCAL_CHECK =
  "Checked automatically at start: the host verifies exact bundled skills and current authority. Selecting a Release grants no execution rights.";

/** Where a Release comes from, exactly: for the tooltip, not the option. */
function releaseDetail(release: SavedSystemView): string {
  return [
    [
      "Release",
      release.metadata.name,
      release.source?.branch.kind === "case"
        ? `Request ${release.source.branch.caseId}`
        : "Main",
      release.source?.sourceVersion.replace(/^commit:/, "").slice(0, 8),
    ].filter(Boolean).join(" · "),
    releaseOpeningKind(release) === "local-validation" && LOCAL_CHECK,
  ].filter(Boolean).join(". ");
}

/** Source selection and local credential handoff reuse the existing composer. */
export function RequestSource(
  {
    state,
    active,
    authOnly = false,
  }: {
    state: WorkbenchState;
    active: boolean;
    authOnly?: boolean;
  },
) {
  const requests = state.requests;
  const sessionReady = requests.sessionReady.value;
  const environment = requests.environment.value;
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    void requests.prepareConnection().then((ready) => {
      if (!mounted || !ready) return;
      requests.restore();
      void requests.cases.refresh();
    });
    return () => {
      mounted = false;
    };
  }, [active, authOnly, sessionReady]);
  const context = requests.context.value;
  const sessionGeneration = requests.sessionGeneration.value;
  useEffect(() => {
    if (!active || authOnly || !context) return;
    let mounted = true, loading = false;
    const refresh = () => {
      if (!mounted || loading || document.visibilityState === "hidden") return;
      loading = true;
      void requests.loadReleases().finally(() => {
        loading = false;
      });
    };
    refresh();
    globalThis.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted = false;
      globalThis.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [
    active,
    authOnly,
    context?.projectId,
    context?.systemId,
    sessionReady,
    sessionGeneration,
  ]);
  const selected = requests.source.value;
  const selectedRelease = selected.kind === "release"
    ? requests.releases.value.find((entry) =>
      entry.id === selected.releaseId && entry.digest === selected.digest
    )
    : undefined;
  const locked = !requests.context.value || requests.pending.value ||
    requests.selectingRelease.value ||
    requests.intent.value !== null;
  const detail = selected.kind === "current-main"
    ? MAIN_DETAIL
    : selectedRelease
    ? releaseDetail(selectedRelease)
    : `Release · saved intention · ${selected.releaseId}`;
  return (
    <div class="request-source">
      {environment === "production" && !requests.sessionReady.value && (
        <label class="input-note">
          Local control file
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Import local control file"
            disabled={requests.pending.value}
            onChange={(event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              // Clear the native file control before any asynchronous exchange.
              input.value = "";
              if (file) void requests.connect(file);
            }}
          />
        </label>
      )}
      {authOnly && requests.error.value && (
        <p class="proposal-error" role="alert">{requests.error.value}</p>
      )}
      {!authOnly && (
        <>
          {requests.selectingRelease.value && (
            <p class="input-note" role="status">
              Checking the selected Release. Sending waits for this check.
            </p>
          )}
          <label class="request-source-pick">
            Start from
            <select
              title={detail}
              value={selected.kind === "current-main"
                ? "main"
                : selected.releaseId}
              disabled={locked}
              onFocus={() => void requests.loadReleases()}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === "main") {
                  requests.source.value = { kind: "current-main" };
                } else void requests.selectRelease(value);
              }}
            >
              <option value="main" title={MAIN_DETAIL}>Current Main</option>
              {selected.kind === "release" &&
                !requests.releases.value.some((release) =>
                  release.id === selected.releaseId
                ) && (
                <option value={selected.releaseId} title={detail}>
                  Saved Release
                </option>
              )}
              {requests.releases.value.length > 0 && (
                <optgroup label="Releases">
                  {requests.releases.value.map((release) => (
                    <option
                      key={release.id}
                      value={release.id}
                      title={releaseDetail(release)}
                    >
                      {release.metadata.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          {requests.intent.value && (
            <p class="input-note" role="status">
              Saved opening · retry keeps the same message and system.
            </p>
          )}
          {requests.opening.value?.issues.map((issue, index) => (
            <p class="input-note" role="status" key={index}>{issue}</p>
          ))}
        </>
      )}
    </div>
  );
}
