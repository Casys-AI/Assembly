import type {
  ModelViewDiagramDocument,
  ModelViewList,
  ModelViewPlantumlDocument,
} from "../../../../../domain/model/records/diagram-views.ts";

export interface ModelViewsReader {
  list(version: string): Promise<ModelViewList>;
  diagram(version: string, viewId: string): Promise<ModelViewDiagramDocument>;
  plantuml(version: string, viewId: string): Promise<ModelViewPlantumlDocument>;
}
