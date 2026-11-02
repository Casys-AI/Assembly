import { useEffect, useState } from "preact/hooks";
import type { ModelView } from "../../src/domain/model-views.ts";
import {
  fetchModelView,
  fetchModelViews,
  groupViews,
  type ModelViewList,
} from "../lib/model-views.ts";
import { ModelDiagram } from "./ModelDiagram.tsx";

/** The Model space: the system's views on the left, one native diagram on the right. */
export function ModelViews({ refreshKey }: { refreshKey?: unknown }) {
  const [list, setList] = useState<ModelViewList | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<ModelView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    fetchModelViews().then((next) => {
      if (!current) return;
      setList(next);
      setError(null);
      setSelected((id) =>
        id && next.views.some((v) => v.id === id) ? id : next.views[0]?.id ??
          null
      );
    }).catch((reason: Error) => current && setError(reason.message));
    return () => {
      current = false;
    };
  }, [refreshKey]);

  useEffect(() => {
    if (!selected || !list) return;
    let current = true;
    fetchModelView(selected, list.version).then((document) => {
      if (current) setView(document.view);
    }).catch((reason: Error) => current && setError(reason.message));
    return () => {
      current = false;
    };
  }, [selected, list?.version]);

  return (
    <div class="model-views">
      {error && !list
        ? <p class="mv-empty" role="alert">{error}</p>
        : list
        ? (
          <ViewList
            list={list}
            selected={selected}
            onSelect={setSelected}
            view={view}
          />
        )
        : <p class="mv-empty">Reading the model…</p>}
    </div>
  );
}

function ViewList(
  { list, selected, onSelect: setSelected, view }: {
    list: ModelViewList;
    selected: string | null;
    onSelect: (id: string) => void;
    view: ModelView | null;
  },
) {
  return (
    <div class="mv">
      <nav class="mv-list" aria-label="Model views">
        {groupViews(list.views).map((group) => (
          <section key={group.group}>
            <h3>{group.title}</h3>
            <ul>
              {group.views.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    aria-current={v.id === selected ? "true" : undefined}
                    title={v.element}
                    onClick={() => setSelected(v.id)}
                  >
                    {v.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {list.problems.length > 0 && (
          <details class="mv-problems">
            <summary>{list.problems.length} not shown</summary>
            <ul>{list.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </details>
        )}
        <p class="mv-version" title={list.version}>
          {list.version.replace(/^commit:/, "").slice(0, 10)} · SysML Toolkit
          {" "}
          {list.toolkit}
        </p>
      </nav>
      <section class="mv-stage">
        {view
          ? (
            <>
              <header class="mv-head">
                <h2>{view.title}</h2>
                <span>{view.element}</span>
              </header>
              <ModelDiagram view={view} />
            </>
          )
          : <p class="mv-empty">Opening the view…</p>}
      </section>
    </div>
  );
}
