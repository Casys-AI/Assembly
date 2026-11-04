import type { VersionInfo } from "../../../lib/workbench/version-label.ts";
import { useEffect, useMemo, useState } from "preact/hooks";
import type {
  ModelView,
  ModelViewList,
} from "../../../../src/domain/model/records/diagram-views.ts";
import {
  createViewsApi,
  type ViewsApi,
  type ViewsProblem,
  viewsProblem,
} from "../../../lib/model/diagrams/api.ts";
import { sysmlLocation } from "../../../lib/model/diagrams/location.ts";
import { useModelLive } from "../../view/useModelLive.ts";
import type { ModelLive } from "../../../lib/model/live.ts";

export interface SysmlPageProps {
  versionInfo: VersionInfo;
  location: { search: string };
  generation?: number;
  api?: ViewsApi;
  sourceFetch?: typeof fetch;
  requestExecutionVersion?: string;
  live?: ModelLive;
}
type Listing = { key: string; version: string; list: ModelViewList };
type Diagram = { key: string; view: ModelView };
export function useSysmlPage(props: SysmlPageProps) {
  const address = sysmlLocation(props.location.search);
  const api = useMemo(() => props.api ?? createViewsApi(), [props.api]);
  const [refresh, setRefresh] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const [listError, setListError] = useState<
    { key: string; problem: ViewsProblem } | null
  >(null);
  const [diagram, setDiagram] = useState<Diagram | null>(null);
  const [diagramError, setDiagramError] = useState<
    { key: string; problem: ViewsProblem } | null
  >(null);
  const listKey = `${address.version ?? "head"}\n${
    address.version ? 0 : props.generation ?? 0
  }\n${refresh}`;
  const shown = listing?.key === listKey ? listing : null;
  useEffect(() => {
    const abort = new AbortController();
    api.list(address.version, abort.signal).then((result) => {
      if (!abort.signal.aborted) {
        setListing({ key: listKey, ...result });
        setListError(null);
      }
    }).catch((error) => {
      if (!abort.signal.aborted) {
        setListError({
          key: listKey,
          problem: viewsProblem(error, Boolean(address.version)),
        });
      }
    });
    return () => abort.abort();
  }, [api, listKey]);
  useModelLive((head) => {
    if (!address.version && head.version !== listing?.version) {
      setRefresh((value) => value + 1);
    }
  }, props.live);
  const viewId = address.view ?? shown?.list.views[0]?.id;
  const summary = shown?.list.views.find((v) => v.id === viewId);
  const diagramKey = shown && summary
    ? `${shown.version}\n${summary.id}\n${refresh}`
    : "";
  useEffect(() => {
    if (!shown || !summary) return;
    const abort = new AbortController();
    api.diagram(shown.version, summary.id, abort.signal).then((view) => {
      if (!abort.signal.aborted) {
        setDiagram({ key: diagramKey, view });
        setDiagramError(null);
      }
    }).catch((error) => {
      if (!abort.signal.aborted) {
        setDiagramError({
          key: diagramKey,
          problem: viewsProblem(error, Boolean(address.version)),
        });
      }
    });
    return () => abort.abort();
  }, [api, diagramKey]);
  return {
    address,
    api,
    listing: shown,
    summary,
    view: diagram?.key === diagramKey ? diagram.view : null,
    listProblem: listError?.key === listKey ? listError.problem : null,
    diagramProblem: diagramError?.key === diagramKey
      ? diagramError.problem
      : null,
    retry: () => setRefresh((value) => value + 1),
  };
}
