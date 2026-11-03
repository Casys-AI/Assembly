import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  createRevisionApi,
  type DiffMode,
  type GraphDiff,
  renderSourceDiff,
  retainInspectedCommit,
  revisionComparisonAction,
  type RevisionDiffKind,
  type RevisionInspection,
  revisionInspectionHref,
  type RevisionLocation,
  type RevisionSelection,
  type RevisionSnapshot,
  type RuntimeAdoption,
  runtimeAdoption,
  type RuntimeOperator,
  type RuntimeRevisionSnapshot,
  sameSourceVersion,
  selectedRevision,
  selectedRuntimeOperator,
  selectionBase,
  selectionTarget,
  shortSourceVersion,
  type SourceCommit,
  type SourceDiff,
  type SourceProposal,
  synchronizeRevisionLocation,
} from "../../../lib/model/revisions/api.ts";
import { canActOnRead } from "../../../lib/conversations/proposals.ts";
import { useRevisionLocationRefresh } from "../../../lib/model/revisions/location.ts";
import { commitTitle } from "../../../lib/model/revisions/rows.ts";
import {
  localSources,
  runSourceCommand,
  type SharedSources,
} from "../../../lib/model/sources/command.ts";

import GraphRevisionDiff from "../../graph/GraphRevisionDiff.tsx";

export interface RevisionsViewProps {
  onChanged(): void | Promise<void>;
  /**
   * The source state shared with the conversations: a read from an older
   * generation, or any change in flight anywhere, makes actions unavailable.
   */
  sources?: SharedSources;
  revisionKey?: string | number;
  location: RevisionLocation;
  runtimeOperators?: readonly RuntimeOperator[];
}

const statusNames = {
  preparing: "En préparation",
  proposed: "À examiner",
  accepting: "Acceptation en cours",
  accepted: "Acceptée",
  rejected: "Refusée",
};
const openStatuses = new Set(["preparing", "proposed", "accepting"]);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function date(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? "Date non disponible"
    : new Intl.DateTimeFormat(
      "fr-FR",
      { dateStyle: "medium", timeStyle: "short" },
    ).format(parsed);
}
function Hash({ version }: { version?: string | null }) {
  return (
    <code class="revision-hash" title={version ?? ""}>
      {shortSourceVersion(version)}
    </code>
  );
}
function Badge({ text, tone = "" }: { text: string; tone?: string }) {
  return (
    <span class={`revision-badge ${tone ? `revision-${tone}` : ""}`}>
      {text}
    </span>
  );
}

/** Fresh handles navigation. Its action URL must include fields before the
 * submit bubbles to Fresh's document listener, so address and fetched view agree. */
export function RevisionComparisonForm(
  { selection, base, target, bases, busy }: {
    selection: RevisionSelection;
    base?: string;
    target: string;
    bases: ReadonlyMap<string, string>;
    busy: boolean;
  },
) {
  return (
    <form
      class="revision-comparison"
      method="GET"
      action={revisionInspectionHref({ selection, base })}
      f-partial="/revisions"
      onSubmit={(event) => {
        const form = event.currentTarget;
        form.action = revisionComparisonAction(new FormData(form));
      }}
    >
      <input type="hidden" name={selection.kind} value={selection.id} />
      <label for="revision-compare-base">Comparer depuis</label>
      <select
        id="revision-compare-base"
        name="from"
        aria-label="Version de référence"
        disabled={busy}
        value={base}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        {[...bases].map(([value, label]) => (
          <option key={value} value={value} selected={value === base}>
            {label}
          </option>
        ))}
      </select>
      <button class="revision-button" type="submit" disabled={busy}>
        Comparer
      </button>
      <span>→</span>
      <Hash version={target} />
    </form>
  );
}
export function RevisionDiffControls(
  { kind, mode, busy, onKindChange, onModeChange }: {
    kind: RevisionDiffKind;
    mode: DiffMode;
    busy: boolean;
    onKindChange(kind: RevisionDiffKind): void;
    onModeChange(mode: DiffMode): void;
  },
) {
  return (
    <>
      <div
        class="revision-modes"
        role="group"
        aria-label="Contenu de la comparaison"
      >
        {([["source", "Texte SysML"], [
          "graph",
          "Éléments et relations",
        ]] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            disabled={busy}
            aria-pressed={kind === value ? "true" : "false"}
            onClick={() => onKindChange(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {kind === "source" && (
        <div
          class="revision-modes"
          role="group"
          aria-label="Présentation du diff"
        >
          {([["line-by-line", "Unifié"], [
            "side-by-side",
            "Côte à côte",
          ]] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              disabled={busy}
              aria-pressed={mode === value ? "true" : "false"}
              onClick={() => onModeChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
/** Runtime inspection is independent of global source/proposal inspection. */
export function RuntimeRevisionCard(
  { operators, selectedId, data, error, busy, onSelect, onAdopt }: {
    operators: readonly RuntimeOperator[];
    selectedId?: string;
    data?: RuntimeRevisionSnapshot;
    error?: string;
    busy: boolean;
    onSelect(nativeId: string): void;
    onAdopt(adoption: RuntimeAdoption): void;
  },
) {
  const selected = selectedRuntimeOperator(operators, selectedId);
  const runtime = data?.agentId === selected?.nativeId
    ? data?.runtime
    : undefined;
  const active = runtime?.active;
  const available = runtime?.available;
  const adoption = selected && runtime
    ? runtimeAdoption(selected.nativeId, runtime)
    : undefined;
  return (
    <article class="revision-overview-card">
      <div class="revision-card-title">Version utilisée pour l’exécution</div>
      <label class="revision-comparison">
        Opérateur
        <select
          aria-label="Opérateur pour l’exécution"
          value={selected?.nativeId ?? selectedId ?? ""}
          disabled={busy || !operators.length}
          onChange={(event) => onSelect(event.currentTarget.value)}
        >
          {!selected && (
            <option value={selectedId ?? ""} selected>
              {selectedId
                ? "Opérateur indisponible"
                : "Chargement des opérateurs…"}
            </option>
          )}
          {operators.map((operator) => (
            <option
              key={operator.nativeId}
              value={operator.nativeId}
              selected={selected?.nativeId === operator.nativeId}
            >
              {operator.name}
              {operator.primary ? " · principal" : ""}
            </option>
          ))}
        </select>
      </label>
      {error
        ? <p class="revision-error" role="alert">{error}</p>
        : !selected
        ? (
          <p class="revision-meta">
            {selectedId
              ? "Cet opérateur n’est plus disponible."
              : "Chargement des opérateurs…"}
          </p>
        )
        : !runtime
        ? (
          <p class="revision-meta" role="status">
            Lecture du contrat de {selected.name}…
          </p>
        )
        : (
          <>
            <div class="revision-card-main">
              {active
                ? (
                  <>
                    <Hash version={active.repositoryVersion} />
                    <Badge
                      text={sameSourceVersion(
                          active.repositoryVersion,
                          data?.version,
                        )
                        ? "À jour"
                        : active.digest === available?.digest
                        ? "Même contrat exécutable"
                        : "Version antérieure"}
                      tone={active.digest === available?.digest
                        ? "green"
                        : "gold"}
                    />
                  </>
                )
                : "Aucune version admise"}
            </div>
            {!runtime.executable && (
              <p class="revision-error">
                {runtime.error ||
                  "Cet opérateur ne fournit pas de contrat exécutable."}
              </p>
            )}
            {available && (
              <p class="revision-meta">
                Contrat disponible :{" "}
                <Hash version={available.repositoryVersion} />
              </p>
            )}
            {runtime.executable && available && !available.repositoryVersion &&
              (
                <p class="revision-error">
                  La version du contrat disponible manque. Actualisez avant de
                  l’adopter.
                </p>
              )}
            {runtime.sourceRights && (
              <section aria-label="Droits dans la version source admise">
                <h3 class="revision-card-title">
                  Droits dans la version source admise
                </h3>
                <p class="revision-meta">
                  Édition :{" "}
                  {runtime.sourceRights.modelEditPolicy
                    ? "autorisée"
                    : "aucune"}
                </p>
                {runtime.sourceRights.modelEditPolicy && (
                  <>
                    <p class="revision-meta">
                      Opérations :{" "}
                      {runtime.sourceRights.modelEditPolicy.operations.join(
                        ", ",
                      )}
                    </p>
                    {runtime.sourceRights.modelEditPolicy.grants.map((
                      grant,
                    ) => (
                      <p class="revision-meta" key={grant.file}>
                        <code>{grant.file}</code> :{" "}
                        {grant.qualifiedRoots.join(", ")}
                      </p>
                    ))}
                    {runtime.sourceRights.modelEditPolicy.delegationDigest && (
                      <p class="revision-meta">
                        Délégation d’édition :{" "}
                        <code>{runtime.sourceRights.modelEditPolicy.id}</code>
                      </p>
                    )}
                  </>
                )}
                <p class="revision-meta">
                  Administration : {runtime.sourceRights.modelAdministration
                    ? "autorisée"
                    : "aucune"}
                </p>
                {runtime.sourceRights.modelAdministration && (
                  <>
                    <p class="revision-meta">
                      {runtime.sourceRights.modelAdministration.kind ===
                          "delegation"
                        ? "Délégation d’administration"
                        : "Autorité racine"} :{" "}
                      <code>{runtime.sourceRights.modelAdministration.id}</code>
                    </p>
                    <p class="revision-meta">
                      Opérations :{" "}
                      {runtime.sourceRights.modelAdministration.operations.join(
                        ", ",
                      )}
                    </p>
                    {runtime.sourceRights.modelAdministration.grants.map((
                      grant,
                    ) => (
                      <p class="revision-meta" key={grant.file}>
                        <code>{grant.file}</code> :{" "}
                        {grant.qualifiedRoots.join(", ")}
                      </p>
                    ))}
                    <p class="revision-meta">
                      Destinataires :{" "}
                      {runtime.sourceRights.modelAdministration.recipients.join(
                        ", ",
                      ) || "aucun"}
                    </p>
                    <p class="revision-meta">
                      Profondeur de redélégation restante :{" "}
                      {runtime.sourceRights.modelAdministration
                        .maxRedelegationDepth}
                    </p>
                  </>
                )}
                <p class="revision-meta">
                  Une nouvelle attribution demande l’adoption du contrat. Une
                  révocation dans les sources admises bloque les anciennes
                  attributions, même avec un ancien contrat adopté.
                </p>
              </section>
            )}
            {adoption && (
              <>
                <p class="revision-meta">
                  Le contrat de {selected.name} attend son adoption.
                </p>
                <button
                  class="revision-button revision-primary"
                  type="button"
                  disabled={busy}
                  onClick={() => onAdopt(adoption)}
                >
                  Adopter pour {selected.name}
                </button>
              </>
            )}
          </>
        )}
    </article>
  );
}
/** Kept mounted by the SPA shell, so inspecting another view preserves this
 * selection, comparison base, proposal filter and diff presentation. */
export default function RevisionsView(props: RevisionsViewProps) {
  const api = useMemo(() => createRevisionApi(), []);
  const [runtimeOperatorId, setRuntimeOperatorId] = useState<string>();
  const operators = props.runtimeOperators ?? [];
  const runtimeOperator = selectedRuntimeOperator(operators, runtimeOperatorId);
  const runtimeAgentId = runtimeOperator?.nativeId;
  const [loadedRuntime, setLoadedRuntime] = useState<
    { agentId: string; readNumber: number; data: RuntimeRevisionSnapshot }
  >();
  const [runtimeError, setRuntimeError] = useState<
    { agentId: string; readNumber: number; message: string }
  >();
  const [snapshot, setSnapshot] = useState<RevisionSnapshot>();
  const [inspection, setInspection] = useState<RevisionInspection>(() =>
    props.location
      ? synchronizeRevisionLocation({}, props.location).inspection
      : {}
  );
  const [tab, setTab] = useState<"commit" | "proposal">(() =>
    inspection.selection?.kind ?? "commit"
  );
  const [allProposals, setAllProposals] = useState(false);
  const [diffKind, setDiffKind] = useState<RevisionDiffKind>("source");
  const [loadedGraphDiff, setLoadedGraphDiff] = useState<
    { from: string; to: string; data: GraphDiff }
  >();
  const [mode, setMode] = useState<DiffMode>("side-by-side");
  const [loadedDiff, setLoadedDiff] = useState<
    { from: string; to: string; data: SourceDiff }
  >();
  const [diffError, setDiffError] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastRead, setLastRead] = useState("");
  const [readGeneration, setReadGeneration] = useState<number | null>(null);
  const [standalone] = useState(localSources);
  const sources = props.sources ?? standalone;
  const generation = sources.generation.value;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const [readNumber, setReadNumber] = useState(0);
  const latest = useRef({ snapshot, inspection, props });
  latest.current = { snapshot, inspection, props };
  const mounted = useRef(false);
  const reading = useRef(false);
  const writing = useRef(false);
  const queued = useRef(false);
  const refreshController = useRef<AbortController>();
  const refreshAgain = useRef<() => void>(() => {});

  const refresh = useCallback(async (afterCommand = false) => {
    if (latest.current.props.location.pathname !== "/revisions") return;
    if (reading.current || writing.current && !afterCommand) {
      queued.current = true;
      return;
    }
    reading.current = true;
    queued.current = false;
    setRefreshing(true);
    const controller = new AbortController();
    refreshController.current = controller;
    // Tagged with the generation it starts in; an overtaken answer is ignored
    // entirely (no snapshot, no selection) and the view reads again.
    const tagged = sourcesRef.current.generation.peek();
    try {
      const response = await api.snapshot(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      if (tagged !== sourcesRef.current.generation.peek()) {
        queued.current = true;
        return;
      }
      setReadGeneration(tagged);
      const { snapshot: previous, inspection: inspected } = latest.current;
      const next = retainInspectedCommit(
        response,
        previous,
        inspected.selection,
      );
      setSnapshot(next);
      setInspection((current) =>
        current.selection ? current : {
          ...current,
          selection: { kind: "commit", id: next.revisions.version },
        }
      );
      setLastRead(
        new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" }).format(
          new Date(),
        ),
      );
      setReadNumber((value) => value + 1);
      setError("");
    } catch (failure) {
      if (
        mounted.current && !controller.signal.aborted &&
        !(failure instanceof Error && failure.name === "AbortError")
      ) {
        setError(message(failure));
      }
    } finally {
      reading.current = false;
      if (mounted.current) {
        setRefreshing(false);
        if (queued.current && !writing.current) refreshAgain.current();
      }
    }
  }, [api]);
  refreshAgain.current = () => {
    void refresh();
  };
  const cancelRefresh = useCallback(() => {
    queued.current = false;
    refreshController.current?.abort();
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (globalThis.matchMedia?.("(max-width:720px)").matches) {
      setMode("line-by-line");
    }
    return () => {
      mounted.current = false;
      refreshController.current?.abort();
    };
  }, []);
  useRevisionLocationRefresh(
    props.location,
    props.revisionKey,
    refresh,
    cancelRefresh,
    generation,
  );
  useEffect(() => {
    if (!props.location || props.location.pathname !== "/revisions") return;
    const navigation = synchronizeRevisionLocation(
      latest.current.inspection,
      props.location,
      snapshot,
    );
    const next = navigation.inspection;
    const selectionChanged =
      latest.current.inspection.selection?.kind !== next.selection?.kind ||
      latest.current.inspection.selection?.id !== next.selection?.id;
    setInspection((current) =>
      current.selection?.kind === next.selection?.kind &&
        current.selection?.id === next.selection?.id &&
        current.base === next.base
        ? current
        : next
    );
    if (next.selection && selectionChanged) setTab(next.selection.kind);
    if (next.selection?.kind === "proposal" && snapshot) {
      const proposal = selectedRevision(snapshot, next.selection) as
        | SourceProposal
        | undefined;
      if (proposal && !openStatuses.has(proposal.status)) setAllProposals(true);
    }
  }, [props.location?.pathname, props.location?.search, snapshot]);

  const selection = inspection.selection;
  const item = snapshot && selectedRevision(snapshot, selection);
  const proposal = selection?.kind === "proposal"
    ? item as SourceProposal | undefined
    : undefined;
  const commit = selection?.kind === "commit"
    ? item as SourceCommit | undefined
    : undefined;
  const target = selection && item
    ? selectionTarget(selection, item)
    : undefined;
  const preferredBase = selection && item
    ? selectionBase(selection, item)
    : undefined;
  const base = inspection.base ?? preferredBase;
  const unavailable = busy || refreshing;
  // Decisions and adoption follow the conversations' rule (shared predicate).
  const actionable = canActOnRead({
    canWrite: true,
    pending: busy || sources.inFlight.value,
    generation,
    readGeneration,
    loading: refreshing,
    error,
  });
  const diff =
    loadedDiff && loadedDiff.from === base && loadedDiff.to === target
      ? loadedDiff.data
      : undefined;

  const graphDiff = loadedGraphDiff && loadedGraphDiff.from === base &&
      loadedGraphDiff.to === target
    ? loadedGraphDiff.data
    : undefined;
  const visible = props.location.pathname === "/revisions";
  const runtimeRequest = useRef({
    agentId: runtimeAgentId,
    visible,
    readNumber,
  });
  runtimeRequest.current = { agentId: runtimeAgentId, visible, readNumber };
  useEffect(() => {
    const abort = new AbortController();
    setLoadedRuntime(undefined);
    setRuntimeError(undefined);
    const current = () =>
      !abort.signal.aborted &&
      runtimeRequest.current.agentId === runtimeAgentId &&
      runtimeRequest.current.visible &&
      runtimeRequest.current.readNumber === readNumber;
    if (visible && runtimeAgentId && readNumber > 0) {
      api.runtime(runtimeAgentId, abort.signal).then((data) => {
        if (current()) {
          setLoadedRuntime({ agentId: runtimeAgentId, readNumber, data });
        }
      }).catch((failure) => {
        if (current()) {
          setRuntimeError({
            agentId: runtimeAgentId,
            readNumber,
            message: message(failure),
          });
        }
      });
    }
    return () => abort.abort();
  }, [api, runtimeAgentId, visible, readNumber]);
  const runtimeData = loadedRuntime?.agentId === runtimeAgentId &&
      loadedRuntime?.readNumber === readNumber
    ? loadedRuntime?.data
    : undefined;

  useEffect(() => {
    const abort = new AbortController();
    setLoadedDiff(undefined);
    setLoadedGraphDiff(undefined);
    setDiffError("");
    if (visible && target && base) {
      const load = diffKind === "graph"
        ? api.graphDiff(base, target, abort.signal).then((next) => {
          if (!abort.signal.aborted) {
            setLoadedGraphDiff({ from: base, to: target, data: next });
          }
        })
        : api.diff(base, target, abort.signal).then((next) => {
          if (!abort.signal.aborted) {
            setLoadedDiff({ from: base, to: target, data: next });
          }
        });
      load.catch((failure) => {
        if (!abort.signal.aborted) setDiffError(message(failure));
      });
    }
    return () => abort.abort();
  }, [api, target, base, readNumber, diffKind, visible]);
  const diffHtml = useMemo(
    () =>
      diffKind === "source" && diff?.files.length
        ? renderSourceDiff(diff.patch, mode)
        : "",
    [diff, mode, diffKind],
  );

  function selectionHref(next: RevisionSelection): string {
    const item = snapshot && selectedRevision(snapshot, next);
    return revisionInspectionHref({
      selection: next,
      base: item ? selectionBase(next, item) : undefined,
    });
  }
  async function command(operation: () => Promise<unknown>) {
    if (writing.current || reading.current) return;
    writing.current = true;
    setBusy(true);
    setError("");
    try {
      await runSourceCommand(sourcesRef.current, {
        operation,
        reread: () => refresh(true),
        changed: () => latest.current.props.onChanged(),
      });
    } catch (failure) {
      if (mounted.current) setError(message(failure));
    } finally {
      writing.current = false;
      if (mounted.current) {
        setBusy(false);
        if (queued.current) void refresh();
      }
    }
  }
  function decide(verdict: "approve" | "refuse") {
    if (!proposal || !snapshot || proposal.status !== "proposed") return;
    const examined = {
      id: proposal.id,
      verdict,
      expectedVersion: snapshot.revisions.version,
      sourceDigest: proposal.sourceDigest,
    };
    void command(() => api.decide(examined));
  }

  const revisions = snapshot?.revisions;
  const history = snapshot?.history;
  const active = revisions?.runtime.active;
  const head = history?.commits.find((entry) =>
    sameSourceVersion(entry.version, revisions?.version)
  );
  const pending =
    revisions?.proposals.filter((entry) => entry.status === "proposed")
      .length ?? 0;
  const shownProposals =
    revisions?.proposals.filter((entry) =>
      allProposals || openStatuses.has(entry.status)
    ) ?? [];
  const bases = new Map<string, string>();
  if (preferredBase) {
    bases.set(
      preferredBase,
      preferredBase === "empty"
        ? "État vide · création du modèle"
        : `${proposal ? "Base de la proposition" : "Parent"} · ${
          shortSourceVersion(preferredBase)
        }`,
    );
  }
  for (const entry of history?.commits ?? []) {
    if (!bases.has(entry.version)) {
      bases.set(
        entry.version,
        `${
          sameSourceVersion(entry.version, revisions?.version)
            ? "main"
            : "Commit"
        } · ${shortSourceVersion(entry.version)}`,
      );
    }
  }
  bases.set("empty", bases.get("empty") ?? "État vide");
  if (base && !bases.has(base)) {
    bases.set(base, `Référence choisie · ${shortSourceVersion(base)}`);
  }

  return (
    <div class="revision-view">
      <header class="revision-intro">
        <h1>Historique du système</h1>
        <p>
          Retrouver la version courante, parcourir les commits et comprendre
          chaque changement.
        </p>
      </header>
      {error && <p class="revision-error" role="alert">{error}</p>}
      <section class="revision-overview" aria-label="Versions du système">
        <article class="revision-overview-card revision-current">
          <div class="revision-card-title">Dernière version acceptée</div>
          <div class="revision-card-main">
            <Badge text="main" />
            <Hash version={revisions?.version} />
            <Badge text="Version courante" />
          </div>
          <p class="revision-card-message">
            {head && snapshot
              ? commitTitle(head, snapshot)
              : "Version courante du modèle"}
          </p>
        </article>
        <RuntimeRevisionCard
          operators={operators}
          selectedId={runtimeOperatorId}
          data={runtimeData}
          error={runtimeError?.agentId === runtimeAgentId &&
              runtimeError?.readNumber === readNumber
            ? runtimeError?.message
            : undefined}
          busy={!actionable}
          onSelect={(nativeId) => {
            if (nativeId === runtimeAgentId) return;
            setLoadedRuntime(undefined);
            setRuntimeError(undefined);
            setRuntimeOperatorId(nativeId);
          }}
          onAdopt={({ expectedDigest, expectedVersion, agentId }) => {
            if (agentId !== runtimeAgentId || !runtimeData) return;
            void command(() =>
              api.adopt(expectedDigest, { expectedVersion, agentId })
            );
          }}
        />
        <article class="revision-overview-card">
          <div class="revision-card-title">Propositions de l’agent</div>
          <Badge
            text={`${pending} à examiner`}
            tone={pending ? "gold" : "green"}
          />
          <p class="revision-meta">
            L’acceptation crée un commit ; l’adoption autorise son exécution.
          </p>
        </article>
      </section>
      <div class="revision-toolbar">
        <div>
          <h2>Révisions SysML</h2>
          <p class="revision-meta" role="status">
            {refreshing
              ? "Lecture en cours…"
              : lastRead
              ? `Dernière lecture : ${lastRead} · ${
                shortSourceVersion(revisions?.version)
              } sur main`
              : "Chargement…"}
            {busy ? " · Commande en cours…" : ""}
          </p>
        </div>
        <div class="revision-toolbar-actions">
          <a
            class="revision-button"
            href={revisions
              ? selectionHref({ kind: "commit", id: revisions.version })
              : "/revisions"}
          >
            Revenir à la version courante
          </a>
          <button
            class="revision-button"
            type="button"
            disabled={unavailable}
            onClick={() => void refresh()}
          >
            Actualiser
          </button>
        </div>
      </div>
      <div class="revision-workspace">
        <aside class="revision-sidebar" aria-label="Navigation des révisions">
          <div
            class="revision-tabs"
            role="tablist"
            aria-label="Type de révision"
          >
            <button
              id="revision-commits-tab"
              class="revision-tab"
              type="button"
              role="tab"
              aria-selected={tab === "commit"}
              aria-controls="revision-commits-panel"
              disabled={busy}
              onClick={() => setTab("commit")}
            >
              Commits
            </button>
            <button
              id="revision-proposals-tab"
              class="revision-tab"
              type="button"
              role="tab"
              aria-selected={tab === "proposal"}
              aria-controls="revision-proposals-panel"
              disabled={busy}
              onClick={() => setTab("proposal")}
            >
              Propositions{pending ? ` · ${pending}` : ""}
            </button>
          </div>
          <section
            id="revision-commits-panel"
            role="tabpanel"
            aria-labelledby="revision-commits-tab"
            hidden={tab !== "commit"}
          >
            <p class="revision-sidebar-note">
              {history?.truncated
                ? "Historique récent · ascendance incomplète"
                : `main · ${
                  history?.commits.length ?? 0
                } commits, du plus récent au plus ancien`}
            </p>
            <ol class="revision-commit-list">
              {snapshot &&
                history?.commits.map((entry) => (
                  <li
                    class={`revision-commit-row ${
                      sameSourceVersion(entry.version, revisions?.version)
                        ? "revision-is-current"
                        : ""
                    }`}
                    key={entry.version}
                  >
                    <a
                      class="revision-entry"
                      aria-current={selection?.kind === "commit" &&
                          sameSourceVersion(selection.id, entry.version)
                        ? "true"
                        : undefined}
                      href={selectionHref({
                        kind: "commit",
                        id: entry.version,
                      })}
                    >
                      <span class="revision-entry-badges">
                        {sameSourceVersion(entry.version, revisions?.version) &&
                          <Badge text="main" />}
                        {sameSourceVersion(
                          entry.version,
                          active?.repositoryVersion,
                        ) && <Badge text="exécution" />}
                      </span>
                      <span class="revision-entry-title">
                        {commitTitle(entry, snapshot)}
                      </span>
                      <span class="revision-entry-meta">
                        <Hash version={entry.version} />
                        {date(entry.createdAt)}
                      </span>
                    </a>
                  </li>
                ))}
            </ol>
          </section>
          <section
            id="revision-proposals-panel"
            role="tabpanel"
            aria-labelledby="revision-proposals-tab"
            hidden={tab !== "proposal"}
          >
            <label class="revision-filter">
              Afficher{" "}
              <select
                disabled={busy}
                value={allProposals ? "all" : "open"}
                onChange={(event) =>
                  setAllProposals(event.currentTarget.value === "all")}
              >
                <option value="open">En attente</option>
                <option value="all">Toutes les propositions</option>
              </select>
            </label>
            <div class="revision-proposal-list">
              {!shownProposals.length && (
                <p class="revision-empty">
                  Aucune proposition en
                  attente.{Boolean(revisions?.proposals.length) && (
                    <button
                      class="revision-button revision-link"
                      type="button"
                      onClick={() => setAllProposals(true)}
                    >
                      Voir les propositions closes
                    </button>
                  )}
                </p>
              )}
              {shownProposals.map((entry) => (
                <a
                  key={entry.id}
                  class="revision-entry"
                  aria-current={selection?.kind === "proposal" &&
                      selection.id === entry.id
                    ? "true"
                    : undefined}
                  href={selectionHref({ kind: "proposal", id: entry.id })}
                >
                  <Badge
                    text={statusNames[entry.status]}
                    tone={entry.status === "proposed"
                      ? "gold"
                      : entry.status === "accepted"
                      ? "green"
                      : ""}
                  />
                  <span class="revision-entry-title">{entry.reason}</span>
                  <span class="revision-entry-meta">
                    {date(entry.createdAt)}
                  </span>
                </a>
              ))}
            </div>
          </section>
        </aside>
        <section class="revision-content" aria-label="Détail de la révision">
          {!item || !snapshot
            ? (
              <p class="revision-empty">
                {snapshot
                  ? "Cette révision n’est plus disponible dans la liste chargée."
                  : "Chargement de l’historique…"}
              </p>
            )
            : (
              <>
                <div class="revision-detail-header">
                  <div class="revision-selection-kind">
                    <Badge
                      text={proposal
                        ? "Proposition de l’agent"
                        : sameSourceVersion(target, revisions?.version)
                        ? "Version courante de main"
                        : "Commit historique · lecture seule"}
                      tone={proposal
                        ? "gold"
                        : sameSourceVersion(target, revisions?.version)
                        ? "green"
                        : ""}
                    />
                    {target && <Hash version={target} />}
                    {sameSourceVersion(target, active?.repositoryVersion) && (
                      <Badge text="en exécution" />
                    )}
                  </div>
                  <h2 class="revision-detail-title">
                    {proposal
                      ? proposal.reason
                      : commitTitle(commit!, snapshot)}
                  </h2>
                  <div class="revision-detail-meta">
                    <span>{item.author || "Auteur non renseigné"}</span>
                    <span>{date(item.createdAt)}</span>
                    {proposal && <span>{statusNames[proposal.status]}</span>}
                  </div>
                  <div class="revision-detail-controls">
                    {target && (
                      <a
                        class="revision-button"
                        href={`/model?modelVersion=${
                          encodeURIComponent(target)
                        }`}
                      >
                        Voir ce modèle
                      </a>
                    )}
                    {proposal?.status === "proposed" && (
                      <>
                        <button
                          class="revision-button revision-primary"
                          type="button"
                          disabled={!actionable}
                          onClick={() => decide("approve")}
                        >
                          Accepter la conception
                        </button>
                        <button
                          class="revision-button revision-danger"
                          type="button"
                          disabled={!actionable}
                          onClick={() => decide("refuse")}
                        >
                          Refuser
                        </button>
                      </>
                    )}
                    {proposal?.acceptedVersion && (
                      <a
                        class="revision-button revision-link"
                        href={selectionHref({
                          kind: "commit",
                          id: proposal.acceptedVersion!,
                        })}
                      >
                        Voir le commit accepté
                      </a>
                    )}
                  </div>
                  {proposal && (
                    <p class="revision-notice">
                      {proposal.status === "proposed"
                        ? "Cette proposition est comparée à sa base. L’accepter crée une nouvelle version sur main ; son exécution demande une adoption distincte."
                        : proposal.status === "rejected"
                        ? "Proposition refusée · elle ne fait pas partie de la version courante."
                        : proposal.status === "accepted"
                        ? "Cette proposition a été acceptée ; son commit figure dans l’historique de main."
                        : proposal.status === "accepting"
                        ? "L’acceptation de cette proposition est en cours."
                        : "L’agent prépare cette proposition ; elle ne fait pas encore partie de main."}
                    </p>
                  )}
                  {proposal?.rejectionReason && (
                    <p class="revision-meta">{proposal.rejectionReason}</p>
                  )}
                  <details class="revision-technical">
                    <summary>Références complètes</summary>
                    {Object.entries({
                      Commit: target,
                      Parent: preferredBase === "empty"
                        ? undefined
                        : preferredBase,
                      Sources: item.sourceDigest,
                      Proposition: proposal?.id,
                      "Message du commit": commit?.message,
                    }).filter(([, value]) => value).map(([label, value]) => (
                      <p key={label}>
                        {label} : <code>{value}</code>
                      </p>
                    ))}
                  </details>
                </div>
                {!target
                  ? (
                    <p class="revision-empty">
                      Le commit de cette proposition est encore en préparation.
                    </p>
                  )
                  : (
                    <>
                      <div class="revision-compare-toolbar">
                        <RevisionComparisonForm
                          selection={selection!}
                          base={base}
                          target={target}
                          bases={bases}
                          busy={busy}
                        />
                        <RevisionDiffControls
                          kind={diffKind}
                          mode={mode}
                          busy={busy}
                          onKindChange={setDiffKind}
                          onModeChange={setMode}
                        />
                      </div>
                      {diffKind === "graph"
                        ? (
                          <GraphRevisionDiff
                            diff={graphDiff}
                            error={diffError}
                          />
                        )
                        : (
                          <>
                            <div class="revision-diff-stats" role="status">
                              {diff
                                ? (
                                  <>
                                    <span>
                                      {diff.files.length}{" "}
                                      fichier{diff.files.length > 1 ? "s" : ""}
                                      {" "}
                                      modifié{diff.files.length > 1 ? "s" : ""}
                                    </span>
                                    <span class="revision-added">
                                      +{diff.additions} lignes
                                    </span>
                                    <span class="revision-deleted">
                                      −{diff.deletions} lignes
                                    </span>
                                  </>
                                )
                                : `Comparaison ${
                                  base === "empty"
                                    ? "état vide"
                                    : shortSourceVersion(base)
                                } → ${shortSourceVersion(target)}`}
                            </div>
                            {diffError
                              ? (
                                <p class="revision-error" role="alert">
                                  {diffError}
                                </p>
                              )
                              : !diff
                              ? (
                                <p class="revision-diff-placeholder">
                                  Calcul des changements…
                                </p>
                              )
                              : !diff.files.length
                              ? (
                                <p class="revision-diff-placeholder">
                                  Aucun changement de source entre ces deux
                                  versions.
                                </p>
                              )
                              : (
                                <div
                                  class="revision-diff-host"
                                  aria-label="Diff des sources SysML"
                                  dangerouslySetInnerHTML={{ __html: diffHtml }}
                                />
                              )}
                          </>
                        )}
                    </>
                  )}
              </>
            )}
        </section>
      </div>
      <footer class="revision-footer">
        <span>
          Sources versionnées dans le dépôt du modèle · les anciennes versions
          restent en lecture seule.
        </span>
        <span>
          {diffKind === "source"
            ? "Diff rendu par Diff2Html 3.4.56"
            : "Comparaison des documents du modèle"}
        </span>
      </footer>
    </div>
  );
}
