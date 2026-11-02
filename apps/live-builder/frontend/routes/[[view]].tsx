import { createDefine, HttpError } from "fresh";
import { Partial } from "fresh/runtime";
import Workbench from "../islands/Workbench.tsx";

const define = createDefine();
const views = new Set([
  "",
  "chat",
  "tools",
  "cases",
  "system",
  "model",
  // The Model place's earlier address: old links keep opening it.
  "revisions",
  "decide",
]);

export const handler = define.handlers({
  GET(ctx) {
    if (!views.has(ctx.params.view ?? "")) throw new HttpError(404);
    const initialUrl = new URL(ctx.req.url);
    // Fresh adds this transport flag while the address bar keeps the clean URL.
    initialUrl.searchParams.delete("fresh-partial");
    return { data: { initialUrl: initialUrl.href } };
  },
});

export default define.page<typeof handler>(({ data }) => (
  <Partial name="workbench">
    <Workbench key="workbench" initialUrl={data.initialUrl} />
  </Partial>
));
