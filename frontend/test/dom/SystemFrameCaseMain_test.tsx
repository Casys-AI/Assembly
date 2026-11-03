import { equal, ok } from "node:assert/strict";
import { render } from "preact";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { SystemFrame } from "../../components/system/SystemFrame.tsx";
import { ModelLinkContext } from "../../components/view/ModelContextLink.tsx";
import type { CaseModelScope } from "../../lib/case-model-scope.ts";
import { createBoardApi } from "../../lib/system/board/api.ts";
import { createBoardStore } from "../../lib/system/board/store.ts";
import { createMatrixApi } from "../../lib/system/rights/api.ts";
import { createMatrixStore } from "../../lib/system/rights/store.ts";
import { createViewPrefs } from "../../lib/system/view-prefs.ts";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { boardHost, BUILDER, HEAD, OLDER } from "../support/board-fixture.ts";
import { caseRecord } from "../support/case-fixture.ts";
import { matrixHost, ownerModeledBody } from "../support/matrix-fixture.ts";
import { withMountedDom } from "../support/mounted-dom.ts";
import { snapshot } from "../support/workbench-fixture.ts";

Deno.test("a mounted Case's Rights reads the global Main's own rights from the main system, at the version the Main runs", async () => {
  await withMountedDom(async (document) => {
    // The Case reads its branch at HEAD, with its own matrix.
    const board = createBoardStore({
      api: createBoardApi({ fetch: boardHost().fetch }),
    });
    await board.open(HEAD);
    const matrix = createMatrixStore({
      api: createMatrixApi({ fetch: matrixHost().fetch }),
    });
    await matrix.open(HEAD);
    // The Main runs OLDER, where its operator holds nothing: a line of its
    // own, empty, while the Case's operator holds rights at HEAD.
    const older = ownerModeledBody(OLDER);
    const mainHost = matrixHost({
      head: OLDER,
      bodies: {
        [OLDER]: {
          ...older,
          cells: older.cells.filter((cell) => cell.row !== BUILDER),
        },
      },
    });
    const mainMatrix = createMatrixStore({
      api: createMatrixApi({ fetch: mainHost.fetch }),
    });
    const current = snapshot();
    current.executionModel = {
      identity: { systemQualifiedName: "ASELiveBuilder::liveBuilder" },
      version: { repositoryVersion: OLDER, digest: "digest" },
    } as NonNullable<typeof current.executionModel>;
    const state = createWorkbenchState({ initialState: current });
    const systemId = state.current.value!.id;
    state.requests.context.value = { projectId: "project", systemId };
    state.requests.sessionReady.value = true;
    state.requests.cases.accept({
      systemId,
      cases: [caseRecord(1, { id: "A", owner: BUILDER })],
    });
    const scope: CaseModelScope = {
      caseId: "A",
      branchId: "branch:A",
      executionSpaceId: "space:A",
      branchVersion: HEAD,
      executionVersion: HEAD,
      version: HEAD,
      release: null,
      readOnly: true,
    };
    const search = `?caseBranch=A&version=${encodeURIComponent(HEAD)}`;
    const prefs = createViewPrefs(() => ({
      getItem: () => null,
      setItem: () => {},
    }));
    // The scoped frame the Case boundary renders once the scope is resolved.
    function Case() {
      const boundary = SystemFrame({
        state,
        page: "rights",
        location: { search },
        board,
        matrix,
        mainMatrix,
        prefs,
      }) as unknown as {
        props: {
          render(
            scope: CaseModelScope,
            request: typeof fetch,
            search: string,
          ): ComponentChildren;
        };
      };
      return (
        <ModelLinkContext.Provider value={search}>
          {boundary.props.render(scope, globalThis.fetch, search)}
        </ModelLinkContext.Provider>
      );
    }
    const root = document.createElement("div");
    document.body.append(root);
    equal(mainHost.requests.length, 0);
    try {
      await act(() => {
        render(<Case />, root);
      });
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      ok(
        mainHost.requests.some(({ path }) =>
          path.includes(encodeURIComponent(OLDER))
        ),
      );
      const main = root.querySelector('tr[data-actor="main-operator"]');
      ok(main, "the Main's line is drawn");
      ok(
        main.querySelector("a")!.getAttribute("href")!.includes(
          encodeURIComponent(OLDER),
        ),
      );
      const branch = root.querySelector(`tr[data-actor="${BUILDER}"]`)!;
      ok(branch.querySelectorAll(".mark-link").length > 0);
      equal(main.querySelectorAll("td *").length, 0);
    } finally {
      await act(() => {
        render(null, root);
      });
    }
  });
});
